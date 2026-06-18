using Ccusage.Api.Auth;
using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Ccusage.Api.Dtos;
using Ccusage.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Ccusage.Api.Endpoints;

/// <summary>
/// Food &amp; fitness tracker: a USDA FoodData Central lookup proxy plus a per-user food/exercise log
/// with a daily calorie/macro roll-up against a goal. Identity comes from the JWT
/// (<c>.RequireAuthorization()</c>); capability from the <c>tracker.*</c> permissions (DB-checked).
///
/// VISIBILITY (the privacy core, enforced server-side):
/// <list type="bullet">
///   <item>A caller may always read AND write their OWN tracker.</item>
///   <item>A caller may READ someone else's day iff they hold <see cref="Permissions.TrackerViewAll"/>,
///   OR that user has <c>ShareWithContacts=true</c> AND the caller is in that user's mutual chat circle
///   (a <see cref="ChatContact"/> row OwnerEmail=target, ContactEmail=caller). Otherwise 404 — never
///   leak that the user/tracker exists.</item>
///   <item>WRITES (add/delete food or exercise) are OWNER-ONLY regardless of viewall: a coach/admin can
///   look but not edit. Deleting an entry the caller doesn't own is a 404.</item>
/// </list>
/// All emails are compared/stored lower-cased. Nutrition is SNAPSHOTTED at log time and never re-fetched.
/// </summary>
public static class TrackerEndpoints
{
    public static void MapTrackerEndpoints(this WebApplication app)
    {
        MapFoodsProxy(app);
        MapTracker(app);
    }

    // ===================================================================================
    // Food lookup proxy (/api/foods) — search + details. USDA is the PRIMARY provider; FatSecret is a
    // fallback used only when USDA is unconfigured or returns nothing. 503 only when BOTH are off.
    // ===================================================================================
    private static void MapFoodsProxy(WebApplication app)
    {
        var g = app.MapGroup("/api/foods").RequireAuthorization();

        // ---- Search by free-text query OR barcode (UPC/GTIN) ----
        // USDA first; if it returns hits, use them. If USDA is empty OR unconfigured, fall back to
        // FatSecret (search or barcode) when it is configured. Both unconfigured → 503; both
        // configured-but-empty → [] (200). USDA hits are tagged source="usda" + sourceId=fdcId.
        g.MapGet("/search", async (
            string? q, string? barcode, UsdaFoodService usda, FatSecretFoodService fatsecret, CancellationToken ct) =>
        {
            if (!usda.IsConfigured && !fatsecret.IsConfigured) return UsdaUnconfigured();

            IReadOnlyList<FoodSearchItemDto>? usdaItems = null;
            if (usda.IsConfigured)
                usdaItems = TagUsda(await usda.SearchAsync(q, barcode, ct));

            // Only call FatSecret when it could actually win (USDA off or empty) — never waste a request.
            IReadOnlyList<FoodSearchItemDto>? fsItems = null;
            if (fatsecret.IsConfigured && (usdaItems is null || usdaItems.Count == 0))
                fsItems = !string.IsNullOrWhiteSpace(barcode)
                    ? await fatsecret.BarcodeAsync(barcode, ct)
                    : await fatsecret.SearchAsync(q, ct);

            return Results.Ok(ChooseSearchResult(usda.IsConfigured, usdaItems, fatsecret.IsConfigured, fsItems));
        }).RequirePermission(Permissions.TrackerSelf);

        // ---- Single food by FDC id (USDA-only) ----
        g.MapGet("/{fdcId:int}", async (int fdcId, UsdaFoodService usda, CancellationToken ct) =>
        {
            if (!usda.IsConfigured) return UsdaUnconfigured();
            var item = await usda.GetDetailsAsync(fdcId, ct);
            return item is null ? Results.NotFound() : Results.Ok(TagUsdaOne(item));
        }).RequirePermission(Permissions.TrackerSelf);
    }

    /// <summary>
    /// The food-search fallback decision, isolated for unit testing. USDA wins when it is configured and
    /// returned at least one hit; otherwise FatSecret's results are used when it is configured; otherwise
    /// an empty list (the both-unconfigured case is handled earlier as a 503). Null result lists are
    /// treated as "that provider wasn't consulted / returned nothing".
    /// </summary>
    public static IReadOnlyList<FoodSearchItemDto> ChooseSearchResult(
        bool usdaConfigured, IReadOnlyList<FoodSearchItemDto>? usdaItems,
        bool fatsecretConfigured, IReadOnlyList<FoodSearchItemDto>? fatsecretItems)
    {
        if (usdaConfigured && usdaItems is { Count: > 0 }) return usdaItems;
        if (fatsecretConfigured && fatsecretItems is not null) return fatsecretItems;
        return Array.Empty<FoodSearchItemDto>();
    }

    /// <summary>Stamp source="usda" + sourceId=fdcId on USDA hits (FdcId stays set).</summary>
    private static IReadOnlyList<FoodSearchItemDto> TagUsda(IReadOnlyList<FoodSearchItemDto> items)
    {
        foreach (var i in items) TagUsdaOne(i);
        return items;
    }

    private static FoodSearchItemDto TagUsdaOne(FoodSearchItemDto item)
    {
        item.Source = "usda";
        item.SourceId = item.FdcId.ToString(System.Globalization.CultureInfo.InvariantCulture);
        return item;
    }

    // ===================================================================================
    // Tracker (/api/tracker) — day summary, food/exercise logging, profile, library, sharing.
    // ===================================================================================
    private static void MapTracker(WebApplication app)
    {
        var g = app.MapGroup("/api/tracker").RequireAuthorization();

        // ---- A whole day's tracker (own, or someone else's read-only when permitted) ----
        g.MapGet("/day", async (
            string? date, string? user, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!; // tracker.self filter guarantees non-null
            var target = NormalizeEmail(user) ?? caller.Email;
            var localDate = await ResolveDateAsync(db, date, ct);

            var isSelf = target == caller.Email;
            if (!isSelf && !await CanViewAsync(db, caller, target, ct))
                return Results.NotFound(); // never leak that the user / their tracker exists

            var dto = await BuildDayAsync(db, target, localDate, readOnly: !isSelf, ct);
            return Results.Ok(dto);
        }).RequirePermission(Permissions.TrackerSelf);

        // ---- Log a food onto a day/meal (OWN only; nutrition snapshotted) ----
        g.MapPost("/food", async (
            AddFoodRequest req, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;

            if (!TryParseDate(req.Date, out var localDate))
                return Results.BadRequest(new { message = "A valid date (yyyy-MM-dd) is required." });
            if (!TryParseMeal(req.Meal, out var meal))
                return Results.BadRequest(new { message = "Meal must be breakfast, lunch, dinner, or snack." });
            var description = (req.Description ?? "").Trim();
            if (description.Length == 0)
                return Results.BadRequest(new { message = "A food description is required." });
            if (description.Length > 256) description = description[..256];
            var brand = Trunc(req.Brand?.Trim(), 256);
            var quantity = req.Quantity <= 0 ? 1 : req.Quantity;

            var entry = new FoodEntry
            {
                UserEmail = caller.Email,
                LocalDate = localDate,
                Meal = meal,
                FdcId = req.FdcId,
                Description = description,
                Brand = string.IsNullOrEmpty(brand) ? null : brand,
                Quantity = quantity,
                ServingDesc = Trunc(req.ServingDesc?.Trim(), 128),
                Calories = Math.Max(0, req.Calories),
                ProteinG = Math.Max(0, req.ProteinG),
                CarbG = Math.Max(0, req.CarbG),
                FatG = Math.Max(0, req.FatG),
                CreatedUtc = DateTime.UtcNow,
            };
            db.FoodEntries.Add(entry);
            await db.SaveChangesAsync(ct);

            // Saved "My foods" upkeep. A MANUAL log (no provider source AND no FdcId) is auto-saved /
            // bumped; an explicit "custom" re-log bumps the matching saved row; usda/fatsecret logs are
            // never saved (they're searchable upstream already).
            // The saved row stores PER-UNIT (unscaled) values so re-picking it at any quantity scales
            // correctly with no compounding — divide the (scaled) entry by its quantity.
            var source = (req.Source ?? "").Trim().ToLowerInvariant();
            var isManual = source.Length == 0 && req.FdcId is null;
            if (isManual || source == "custom")
                await UpsertCustomFoodAsync(db, caller.Email, entry, bumpOnly: source == "custom", ct);

            return Results.Ok(ToFoodDto(entry));
        }).RequirePermission(Permissions.TrackerSelf);

        // ---- The caller's saved "My foods" library (auto-built from manual logs), newest-used first ----
        g.MapGet("/foods/saved", async (
            string? q, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var query = db.CustomFoods.AsNoTracking().Where(f => f.UserEmail == caller.Email);

            var term = (q ?? "").Trim();
            if (term.Length > 0)
            {
                var like = $"%{term}%";
                query = query.Where(f =>
                    EF.Functions.ILike(f.Description, like) || EF.Functions.ILike(f.Brand, like));
            }

            var rows = await query
                .OrderByDescending(f => f.LastUsedUtc).ThenByDescending(f => f.Id)
                .Take(100)
                .ToListAsync(ct);
            return Results.Ok(rows.Select(ToCustomFoodDto).ToArray());
        }).RequirePermission(Permissions.TrackerSelf);

        // ---- Delete one of the caller's saved foods (owner only) ----
        g.MapDelete("/foods/saved/{id:long}", async (
            long id, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            // 404 when it doesn't exist OR isn't the caller's (never reveal someone else's saved food).
            var deleted = await db.CustomFoods
                .Where(f => f.Id == id && f.UserEmail == caller.Email)
                .ExecuteDeleteAsync(ct);
            return deleted == 0 ? Results.NotFound() : Results.NoContent();
        }).RequirePermission(Permissions.TrackerSelf);

        // ---- Delete a logged food (owner only) ----
        g.MapDelete("/food/{id:long}", async (
            long id, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            // 404 when the entry doesn't exist OR isn't the caller's (never reveal someone else's row).
            var deleted = await db.FoodEntries
                .Where(f => f.Id == id && f.UserEmail == caller.Email)
                .ExecuteDeleteAsync(ct);
            return deleted == 0 ? Results.NotFound() : Results.NoContent();
        }).RequirePermission(Permissions.TrackerSelf);

        // ---- Log an exercise (OWN only; MET-estimate calories when omitted) ----
        g.MapPost("/exercise", async (
            AddExerciseRequest req, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;

            if (!TryParseDate(req.Date, out var localDate))
                return Results.BadRequest(new { message = "A valid date (yyyy-MM-dd) is required." });

            var duration = req.DurationMin is { } d && d > 0 ? d : (int?)null;

            // Resolve the activity name + MET from the library when an ExerciseId is given; the name is
            // snapshotted onto the row so deleting a library item never blanks the log.
            ExerciseLibrary? lib = null;
            if (req.ExerciseId is { } exId)
            {
                lib = await db.ExerciseLibrary.AsNoTracking().FirstOrDefaultAsync(x => x.Id == exId, ct);
                if (lib is null)
                    return Results.BadRequest(new { message = "That exercise isn't in the library." });
            }

            var name = (req.Name ?? lib?.Name ?? "").Trim();
            if (name.Length == 0)
                return Results.BadRequest(new { message = "An exercise name is required." });
            if (name.Length > 128) name = name[..128];

            // Calories: use the supplied value when present; otherwise estimate from MET * weight *
            // hours when we have a library MET, a duration, and the profile carries a weight.
            int? calories = req.CaloriesBurned is { } c && c >= 0 ? c : null;
            if (calories is null && lib is not null && duration is { } mins)
            {
                var weight = await db.TrackerProfiles.AsNoTracking()
                    .Where(p => p.UserEmail == caller.Email)
                    .Select(p => p.WeightKg)
                    .FirstOrDefaultAsync(ct);
                if (weight is { } kg && kg > 0)
                    calories = EstimateCalories(lib.Met, kg, mins);
            }
            if (calories is null)
                return Results.BadRequest(new
                {
                    message = "Calories burned is required (or log a library exercise with a duration and set your weight).",
                });

            var entry = new ExerciseEntry
            {
                UserEmail = caller.Email,
                LocalDate = localDate,
                ExerciseId = lib?.Id,
                Name = name,
                DurationMin = duration,
                CaloriesBurned = calories.Value,
                CreatedUtc = DateTime.UtcNow,
            };
            db.ExerciseEntries.Add(entry);
            await db.SaveChangesAsync(ct);

            // Saved "My exercises" upkeep. A MANUAL log (no library ExerciseId AND no source) is auto-saved
            // / bumped; an explicit "custom" re-log bumps the matching saved row; library/workoutx logs are
            // never saved (library is goal-tagged + searchable, workoutx is searchable upstream).
            var source = (req.Source ?? "").Trim().ToLowerInvariant();
            var isManual = source.Length == 0 && req.ExerciseId is null;
            if (isManual || source == "custom")
                await UpsertCustomExerciseAsync(db, caller.Email, entry, bumpOnly: source == "custom", ct);

            return Results.Ok(ToExerciseDto(entry));
        }).RequirePermission(Permissions.TrackerSelf);

        // ---- The caller's saved "My exercises" library (auto-built from manual logs), newest-used first ----
        g.MapGet("/exercises/saved", async (
            string? q, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var query = db.CustomExercises.AsNoTracking().Where(x => x.UserEmail == caller.Email);

            var term = (q ?? "").Trim();
            if (term.Length > 0)
            {
                var like = $"%{term}%";
                query = query.Where(x => EF.Functions.ILike(x.Name, like));
            }

            var rows = await query
                .OrderByDescending(x => x.LastUsedUtc).ThenByDescending(x => x.Id)
                .Take(100)
                .ToListAsync(ct);
            return Results.Ok(rows.Select(ToCustomExerciseDto).ToArray());
        }).RequirePermission(Permissions.TrackerSelf);

        // ---- Delete one of the caller's saved exercises (owner only) ----
        g.MapDelete("/exercises/saved/{id:long}", async (
            long id, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            // 404 when it doesn't exist OR isn't the caller's (never reveal someone else's saved exercise).
            var deleted = await db.CustomExercises
                .Where(x => x.Id == id && x.UserEmail == caller.Email)
                .ExecuteDeleteAsync(ct);
            return deleted == 0 ? Results.NotFound() : Results.NoContent();
        }).RequirePermission(Permissions.TrackerSelf);

        // ---- Delete a logged exercise (owner only) ----
        g.MapDelete("/exercise/{id:long}", async (
            long id, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var deleted = await db.ExerciseEntries
                .Where(x => x.Id == id && x.UserEmail == caller.Email)
                .ExecuteDeleteAsync(ct);
            return deleted == 0 ? Results.NotFound() : Results.NoContent();
        }).RequirePermission(Permissions.TrackerSelf);

        // ---- The exercise library, optionally filtered to a goal (default: the caller's goal) ----
        g.MapGet("/exercises", async (
            string? goal, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;

            // An explicit ?goal= wins; otherwise fall back to the caller's profile goal. A blank/unknown
            // goal means "no filter" (return everything).
            TrackerGoal? filter = null;
            if (!string.IsNullOrWhiteSpace(goal))
            {
                if (Enum.TryParse<TrackerGoal>(goal, ignoreCase: true, out var parsed)) filter = parsed;
            }
            else
            {
                filter = await db.TrackerProfiles.AsNoTracking()
                    .Where(p => p.UserEmail == caller.Email)
                    .Select(p => (TrackerGoal?)p.Goal)
                    .FirstOrDefaultAsync(ct);
            }

            var rows = await db.ExerciseLibrary.AsNoTracking()
                .OrderBy(x => x.Category).ThenBy(x => x.Name)
                .ToListAsync(ct);

            var dtos = rows
                .Select(ToLibraryDto)
                .Where(d => filter is null || d.Goals.Contains(filter.Value.ToString(), StringComparer.OrdinalIgnoreCase))
                .ToArray();
            return Results.Ok(dtos);
        }).RequirePermission(Permissions.TrackerSelf);

        // ---- The caller's profile (creates a default row if none) ----
        g.MapGet("/profile", async (CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var profile = await GetOrCreateProfileAsync(db, caller.Email, ct);
            return Results.Ok(ToProfileDto(profile));
        }).RequirePermission(Permissions.TrackerSelf);

        // ---- Update the caller's profile ----
        g.MapPut("/profile", async (
            TrackerProfileDto req, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var profile = await GetOrCreateProfileAsync(db, caller.Email, ct);

            profile.Goal = Enum.TryParse<TrackerGoal>(req.Goal, ignoreCase: true, out var g) ? g : TrackerGoal.Maintain;
            profile.WeightKg = Positive(req.WeightKg);
            profile.DailyCalorieGoal = Positive(req.DailyCalorieGoal);
            profile.ProteinGoalG = Positive(req.ProteinGoalG);
            profile.CarbGoalG = Positive(req.CarbGoalG);
            profile.FatGoalG = Positive(req.FatGoalG);
            profile.ShareWithContacts = req.ShareWithContacts;
            profile.DateOfBirth = TryParseDate(req.DateOfBirth, out var dob) ? dob : null;
            profile.HeightCm = Positive(req.HeightCm);
            profile.Sex = Enum.TryParse<BiologicalSex>(req.Sex, ignoreCase: true, out var sex) ? sex : BiologicalSex.Unspecified;
            profile.ActivityLevel = Enum.TryParse<ActivityLevel>(req.ActivityLevel, ignoreCase: true, out var act) ? act : ActivityLevel.Sedentary;
            profile.GoalWeightKg = Positive(req.GoalWeightKg);
            profile.UnitSystem = Enum.TryParse<UnitSystem>(req.UnitSystem, ignoreCase: true, out var unit) ? unit : UnitSystem.Metric;
            profile.HydrationGoalMl = Positive(req.HydrationGoalMl);
            profile.UpdatedUtc = DateTime.UtcNow;
            await db.SaveChangesAsync(ct);
            return Results.Ok(ToProfileDto(profile));
        }).RequirePermission(Permissions.TrackerSelf);

        // ---- Log (upsert) the caller's body weight on a day (OWN only) ----
        // Upserts the WeightEntry for that local date AND sets profile.WeightKg to the entry on the
        // MOST RECENT date present (so "current weight" + stats track the latest reading). Returns the
        // refreshed profile so the client can update its current weight + stats.
        g.MapPost("/weight", async (
            LogWeightRequest req, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;

            if (!TryParseDate(req.Date, out var localDate))
                return Results.BadRequest(new { message = "A valid date (yyyy-MM-dd) is required." });
            if (!(req.WeightKg >= 1 && req.WeightKg <= 1000))
                return Results.BadRequest(new { message = "Weight must be between 1 and 1000 kg." });

            var weightKg = Math.Round(req.WeightKg, 2);

            var entry = await db.WeightEntries
                .FirstOrDefaultAsync(w => w.UserEmail == caller.Email && w.LocalDate == localDate, ct);
            if (entry is null)
            {
                entry = new WeightEntry
                {
                    UserEmail = caller.Email,
                    LocalDate = localDate,
                    WeightKg = weightKg,
                    CreatedUtc = DateTime.UtcNow,
                };
                db.WeightEntries.Add(entry);
            }
            else
            {
                entry.WeightKg = weightKg;
            }

            var profile = await GetOrCreateProfileAsync(db, caller.Email, ct);
            try
            {
                await db.SaveChangesAsync(ct);
            }
            catch (DbUpdateException ex) when (IsUniqueViolation(ex))
            {
                // A concurrent insert for the same (user, date) won the race; reload + overwrite it.
                db.ChangeTracker.Clear();
                profile = await GetOrCreateProfileAsync(db, caller.Email, ct);
                entry = await db.WeightEntries
                    .FirstAsync(w => w.UserEmail == caller.Email && w.LocalDate == localDate, ct);
                entry.WeightKg = weightKg;
                await db.SaveChangesAsync(ct);
            }

            // Current weight = the reading on the most recent dated entry (ties broken by newest insert).
            var latest = await db.WeightEntries.AsNoTracking()
                .Where(w => w.UserEmail == caller.Email)
                .OrderByDescending(w => w.LocalDate).ThenByDescending(w => w.Id)
                .Select(w => (double?)w.WeightKg)
                .FirstOrDefaultAsync(ct);
            if (latest is { } lw && profile.WeightKg != lw)
            {
                profile.WeightKg = lw;
                profile.UpdatedUtc = DateTime.UtcNow;
                await db.SaveChangesAsync(ct);
            }

            return Results.Ok(ToProfileDto(profile));
        }).RequirePermission(Permissions.TrackerSelf);

        // ---- The caller's own weight history for the trend (OWN only — private, never for others) ----
        g.MapGet("/weight", async (
            int? days, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var window = days is { } d ? Math.Clamp(d, 1, 365) : 90;
            var today = DateOnly.FromDateTime(
                TimeZoneInfo.ConvertTimeFromUtc(DateTime.UtcNow, await DisplayTzAsync(db, ct)));
            var from = today.AddDays(-(window - 1));

            var points = await db.WeightEntries.AsNoTracking()
                .Where(w => w.UserEmail == caller.Email && w.LocalDate >= from && w.LocalDate <= today)
                .OrderBy(w => w.LocalDate)
                .Select(w => new WeightPointDto { Date = w.LocalDate.ToString("yyyy-MM-dd"), WeightKg = w.WeightKg })
                .ToListAsync(ct);
            return Results.Ok(points);
        }).RequirePermission(Permissions.TrackerSelf);

        // ---- Log a drink onto a day (OWN only; many drinks per day, no upsert) ----
        g.MapPost("/hydration", async (
            AddHydrationRequest req, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;

            if (!TryParseDate(req.Date, out var localDate))
                return Results.BadRequest(new { message = "A valid date (yyyy-MM-dd) is required." });
            if (!(req.AmountMl >= 1 && req.AmountMl <= 5000))
                return Results.BadRequest(new { message = "Amount must be between 1 and 5000 ml." });

            var label = Trunc(req.Label?.Trim(), 64);

            var entry = new HydrationEntry
            {
                UserEmail = caller.Email,
                LocalDate = localDate,
                AmountMl = req.AmountMl,
                Label = string.IsNullOrEmpty(label) ? null : label,
                CreatedUtc = DateTime.UtcNow,
            };
            db.HydrationEntries.Add(entry);
            await db.SaveChangesAsync(ct);
            return Results.Ok(ToHydrationDto(entry));
        }).RequirePermission(Permissions.TrackerSelf);

        // ---- Delete a logged drink (owner only) ----
        g.MapDelete("/hydration/{id:long}", async (
            long id, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            // 404 when the entry doesn't exist OR isn't the caller's (never reveal someone else's row).
            var deleted = await db.HydrationEntries
                .Where(h => h.Id == id && h.UserEmail == caller.Email)
                .ExecuteDeleteAsync(ct);
            return deleted == 0 ? Results.NotFound() : Results.NoContent();
        }).RequirePermission(Permissions.TrackerSelf);

        // ---- WorkoutX: browse/search the exercise catalog (503 when unconfigured) ----
        // Hit by the add-exercise dialog's "WorkoutX" tab. Logging a picked exercise reuses POST
        // /api/tracker/exercise (name + durationMin + caloriesBurned) — no dedicated log path here.
        g.MapGet("/workoutx/exercises", async (
            string? q, string? bodyPart, string? target, string? equipment, int? limit, int? offset,
            WorkoutXService workoutx, CancellationToken ct) =>
        {
            if (!workoutx.IsConfigured) return WorkoutXUnconfigured();
            var result = await workoutx.SearchAsync(
                q, bodyPart, target, equipment, limit ?? 24, offset ?? 0, ct);
            return Results.Ok(result);
        }).RequirePermission(Permissions.TrackerSelf);

        // ---- WorkoutX: proxy a single exercise's GIF demo (the provider needs the key the client lacks) ----
        // {id} is constrained to digits at the route AND re-validated in the service before it's used in
        // the upstream path. The Angular client loads this via HttpClient (responseType:"blob") so the JWT
        // interceptor authorizes it — the WorkoutX key never reaches the browser.
        g.MapGet("/workoutx/gif/{id:int:min(0)}", async (
            string id, WorkoutXService workoutx, HttpContext http, CancellationToken ct) =>
        {
            if (!workoutx.IsConfigured) return WorkoutXUnconfigured();
            var gif = await workoutx.GetGifAsync(id, ct);
            if (gif is not { } g) return Results.NotFound();
            // The catalog gifs are immutable per id; let the browser cache them for a day.
            http.Response.Headers.CacheControl = "private, max-age=86400";
            return Results.Bytes(g.Bytes, g.ContentType);
        }).RequirePermission(Permissions.TrackerSelf);

        // ---- People whose tracker the caller may view ----
        g.MapGet("/shared", async (CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;

            IQueryable<AppUser> usersQ;
            if (caller.Permissions.Contains(Permissions.TrackerViewAll))
            {
                // viewall: every other enabled user.
                usersQ = db.Users.AsNoTracking().Where(u => u.IsEnabled && u.Email != caller.Email);
            }
            else
            {
                // Mutual contacts (the contact's circle includes the caller) who have sharing on. The
                // caller being in X's circle is the row OwnerEmail=X, ContactEmail=caller.
                var sharingEmails = db.ChatContacts.AsNoTracking()
                    .Where(c => c.ContactEmail == caller.Email)
                    .Join(db.TrackerProfiles.AsNoTracking().Where(p => p.ShareWithContacts),
                        c => c.OwnerEmail, p => p.UserEmail, (c, p) => p.UserEmail);
                usersQ = db.Users.AsNoTracking()
                    .Where(u => u.IsEnabled && u.Email != caller.Email && sharingEmails.Contains(u.Email));
            }

            var people = await usersQ
                .OrderBy(u => u.Name == "" ? u.Email : u.Name)
                .Select(u => new SharedUserDto
                {
                    Email = u.Email,
                    Name = string.IsNullOrEmpty(u.Name) ? u.Email : u.Name,
                    Picture = u.Picture,
                })
                .ToListAsync(ct);
            return Results.Ok(people);
        }).RequirePermission(Permissions.TrackerSelf);
    }

    // ===================================================================================
    // Visibility
    // ===================================================================================

    /// <summary>
    /// Whether <paramref name="caller"/> may READ <paramref name="target"/>'s tracker (target != self):
    /// true when the caller holds <see cref="Permissions.TrackerViewAll"/>, OR the target has
    /// <c>ShareWithContacts=true</c> and the caller is in the target's mutual chat circle.
    /// </summary>
    private static async Task<bool> CanViewAsync(
        UsageDbContext db, CurrentUserAccessor.CurrentUser caller, string target, CancellationToken ct)
    {
        // A viewall holder (coach/admin) may read anyone — but only a real user, so an arbitrary
        // address can't be probed via an empty 200 day; a non-user falls through to 404.
        if (caller.Permissions.Contains(Permissions.TrackerViewAll))
            return await db.Users.AnyAsync(u => u.Email == target, ct);

        var shares = await db.TrackerProfiles.AsNoTracking()
            .Where(p => p.UserEmail == target)
            .Select(p => (bool?)p.ShareWithContacts)
            .FirstOrDefaultAsync(ct);
        if (shares != true) return false;

        // The caller is in the target's circle iff a row OwnerEmail=target, ContactEmail=caller exists.
        return await db.ChatContacts.AsNoTracking()
            .AnyAsync(c => c.OwnerEmail == target && c.ContactEmail == caller.Email, ct);
    }

    // ===================================================================================
    // Day aggregation
    // ===================================================================================

    private static async Task<TrackerDayDto> BuildDayAsync(
        UsageDbContext db, string email, DateOnly date, bool readOnly, CancellationToken ct)
    {
        var profile = await db.TrackerProfiles.AsNoTracking()
            .FirstOrDefaultAsync(p => p.UserEmail == email, ct);
        var profileDto = profile is null
            ? new TrackerProfileDto() // an unconfigured user reads as Maintain / no goals
            : ToProfileDto(profile);
        // Body weight is the owner's private metric (used only for their own exercise estimates) —
        // never expose it to a viewer (shared contact or coach); they still see calories + macros.
        if (readOnly) profileDto.WeightKg = null;

        // Body-metric estimates (BMI/BMR/TDEE/suggestions). PRIVACY: only the owner ever sees these —
        // a viewer (shared contact or coach) gets NULL so body metrics don't leak. Age uses "today" in
        // the display timezone (not the viewed day) per the existing date handling.
        TrackerStatsDto? stats = null;
        if (!readOnly && profile is not null)
        {
            var today = DateOnly.FromDateTime(
                TimeZoneInfo.ConvertTimeFromUtc(DateTime.UtcNow, await DisplayTzAsync(db, ct)));
            stats = TrackerStats.Compute(profile, today);
        }

        var foods = await db.FoodEntries.AsNoTracking()
            .Where(f => f.UserEmail == email && f.LocalDate == date)
            .OrderBy(f => f.Meal).ThenBy(f => f.Id)
            .ToListAsync(ct);
        var exercises = await db.ExerciseEntries.AsNoTracking()
            .Where(x => x.UserEmail == email && x.LocalDate == date)
            .OrderBy(x => x.Id)
            .ToListAsync(ct);
        // Hydration is part of the day (like food/exercise): a permitted viewer sees the totals + entries
        // read-only too. Many drinks per day, so this is a plain list (no upsert), oldest-first by id.
        var hydration = await db.HydrationEntries.AsNoTracking()
            .Where(h => h.UserEmail == email && h.LocalDate == date)
            .OrderBy(h => h.Id)
            .ToListAsync(ct);

        var caloriesIn = foods.Sum(f => f.Calories);
        var caloriesOut = exercises.Sum(x => x.CaloriesBurned);
        var protein = Math.Round(foods.Sum(f => f.ProteinG), 1);
        var carbs = Math.Round(foods.Sum(f => f.CarbG), 1);
        var fat = Math.Round(foods.Sum(f => f.FatG), 1);

        var goal = profile?.DailyCalorieGoal;
        int? remaining = goal is { } g ? g - caloriesIn + caloriesOut : null;

        var hydrationMl = hydration.Sum(h => h.AmountMl);
        // The resolved goal: the profile's goal when set, else the 2000 ml default.
        var hydrationGoalMl = profile?.HydrationGoalMl ?? DefaultHydrationGoalMl;

        return new TrackerDayDto
        {
            Date = date.ToString("yyyy-MM-dd"),
            UserEmail = email,
            ReadOnly = readOnly,
            Profile = profileDto,
            Stats = stats,
            Foods = foods.Select(ToFoodDto).ToArray(),
            Exercises = exercises.Select(ToExerciseDto).ToArray(),
            CaloriesIn = caloriesIn,
            CaloriesOut = caloriesOut,
            NetCalories = caloriesIn - caloriesOut,
            ProteinG = protein,
            CarbG = carbs,
            FatG = fat,
            CalorieGoal = goal,
            Remaining = remaining,
            HydrationMl = hydrationMl,
            HydrationGoalMl = hydrationGoalMl,
            Hydration = hydration.Select(ToHydrationDto).ToArray(),
        };
    }

    /// <summary>The fallback daily hydration goal (ml) when a user's profile has none set.</summary>
    private const int DefaultHydrationGoalMl = 2000;

    // ===================================================================================
    // Profile helpers
    // ===================================================================================

    /// <summary>Read the caller's profile, lazily creating a default (Maintain, no sharing) row.</summary>
    private static async Task<TrackerProfile> GetOrCreateProfileAsync(
        UsageDbContext db, string email, CancellationToken ct)
    {
        var profile = await db.TrackerProfiles.FirstOrDefaultAsync(p => p.UserEmail == email, ct);
        if (profile is not null) return profile;

        profile = new TrackerProfile
        {
            UserEmail = email,
            Goal = TrackerGoal.Maintain,
            ShareWithContacts = false,
            // New users default to Imperial (lb + ft/in); existing rows keep their stored preference.
            UnitSystem = UnitSystem.Imperial,
            UpdatedUtc = DateTime.UtcNow,
        };
        db.TrackerProfiles.Add(profile);
        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException ex) when (IsUniqueViolation(ex))
        {
            // A concurrent request created the row first; drop our rejected insert and read the winner.
            db.ChangeTracker.Clear();
            profile = await db.TrackerProfiles.FirstAsync(p => p.UserEmail == email, ct);
        }
        return profile;
    }

    // ===================================================================================
    // Saved "My foods" upkeep
    // ===================================================================================

    /// <summary>
    /// Upsert the caller's saved "My foods" row for a just-logged food, keyed by the normalized identity
    /// (UserEmail, Description, Brand="", ServingDesc=""): if it exists, bump UseCount + LastUsedUtc and
    /// (unless <paramref name="bumpOnly"/>) refresh the snapshot macros; otherwise insert with UseCount=1.
    /// <paramref name="bumpOnly"/> is for an explicit "custom" re-log (a pick of an existing saved food):
    /// it must never create a new row — if no match exists it is a no-op. The unique-index violation
    /// catch handles a concurrent insert racing the same identity.
    ///
    /// The stored macros are PER-UNIT (unscaled): the logged <paramref name="entry"/> carries the SCALED
    /// totals (per-serving × quantity), so we divide back out by the quantity. This keeps a re-pick at any
    /// quantity scaling correctly with no compounding. The dedupe key uses a quantity-INDEPENDENT serving
    /// description (an auto-generated "N servings" collapses to "1 serving") so logging the same food at
    /// different quantities still bumps one row rather than spawning duplicates.
    /// </summary>
    private static async Task UpsertCustomFoodAsync(
        UsageDbContext db, string email, FoodEntry entry, bool bumpOnly, CancellationToken ct)
    {
        var description = entry.Description; // already trimmed + capped at log time
        var brand = NormalizeKey(entry.Brand);
        var qty = entry.Quantity > 0 ? entry.Quantity : 1;
        var servingDesc = PerUnitServingDesc(entry.ServingDesc, qty);

        // Per-unit (unscaled) macros = the scaled snapshot ÷ quantity, with sane rounding.
        var calories = (int)Math.Round(entry.Calories / qty, MidpointRounding.AwayFromZero);
        var proteinG = Math.Round(entry.ProteinG / qty, 1);
        var carbG = Math.Round(entry.CarbG / qty, 1);
        var fatG = Math.Round(entry.FatG / qty, 1);

        var existing = await db.CustomFoods.FirstOrDefaultAsync(f =>
            f.UserEmail == email && f.Description == description
            && f.Brand == brand && f.ServingDesc == servingDesc, ct);

        if (existing is not null)
        {
            existing.UseCount += 1;
            existing.LastUsedUtc = DateTime.UtcNow;
            if (!bumpOnly)
            {
                existing.Calories = calories;
                existing.ProteinG = proteinG;
                existing.CarbG = carbG;
                existing.FatG = fatG;
            }
            await db.SaveChangesAsync(ct);
            return;
        }

        // A "custom" re-log of a food that's no longer saved (e.g. the user deleted it) is a no-op.
        if (bumpOnly) return;

        var now = DateTime.UtcNow;
        db.CustomFoods.Add(new CustomFood
        {
            UserEmail = email,
            Description = description,
            Brand = brand,
            ServingDesc = servingDesc,
            Calories = calories,
            ProteinG = proteinG,
            CarbG = carbG,
            FatG = fatG,
            UseCount = 1,
            CreatedUtc = now,
            LastUsedUtc = now,
        });
        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException ex) when (IsUniqueViolation(ex))
        {
            // A concurrent log for the same identity won the race; drop our insert and bump the winner.
            db.ChangeTracker.Clear();
            var winner = await db.CustomFoods.FirstOrDefaultAsync(f =>
                f.UserEmail == email && f.Description == description
                && f.Brand == brand && f.ServingDesc == servingDesc, ct);
            if (winner is null) return;
            winner.UseCount += 1;
            winner.LastUsedUtc = DateTime.UtcNow;
            winner.Calories = calories;
            winner.ProteinG = proteinG;
            winner.CarbG = carbG;
            winner.FatG = fatG;
            await db.SaveChangesAsync(ct);
        }
    }

    /// <summary>
    /// The quantity-independent (per-unit) serving description used for a saved food's key/snapshot. An
    /// auto-generated count like "2 servings" collapses to "1 serving" so the same food saved at different
    /// quantities dedupes onto one row; any other text (e.g. "1 bowl") describes a single unit already and
    /// is kept verbatim.
    /// </summary>
    private static string PerUnitServingDesc(string? servingDesc, double quantity)
    {
        var s = NormalizeKey(servingDesc);
        if (s.Length == 0) return s;
        // Match a leading numeric count followed by "serving"/"servings" (the dialog's manual default).
        var m = System.Text.RegularExpressions.Regex.Match(
            s, @"^\s*\d+(?:\.\d+)?\s+servings?\s*$",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        return m.Success ? "1 serving" : s;
    }

    /// <summary>Normalize a nullable key part to the empty string so null/empty collapse to one row.</summary>
    private static string NormalizeKey(string? s) => (s ?? "").Trim();

    // ===================================================================================
    // Saved "My exercises" upkeep
    // ===================================================================================

    /// <summary>
    /// Upsert the caller's saved "My exercises" row for a just-logged exercise, keyed by the normalized
    /// name (UserEmail, NameKey = trim+lower of the name): if it exists, bump UseCount + LastUsedUtc and
    /// (unless <paramref name="bumpOnly"/>) refresh the snapshot defaults (calories burned + duration);
    /// otherwise insert with UseCount=1. The display Name is stored exactly as logged.
    /// <paramref name="bumpOnly"/> is for an explicit "custom" re-log (a pick of an existing saved
    /// exercise): it must never create a new row — if no match exists it is a no-op. The unique-index
    /// violation catch handles a concurrent insert racing the same identity.
    /// </summary>
    private static async Task UpsertCustomExerciseAsync(
        UsageDbContext db, string email, ExerciseEntry entry, bool bumpOnly, CancellationToken ct)
    {
        var name = entry.Name; // already trimmed + capped at log time
        var nameKey = name.ToLowerInvariant();
        var calories = entry.CaloriesBurned;
        var duration = entry.DurationMin;

        var existing = await db.CustomExercises.FirstOrDefaultAsync(x =>
            x.UserEmail == email && x.NameKey == nameKey, ct);

        if (existing is not null)
        {
            existing.UseCount += 1;
            existing.LastUsedUtc = DateTime.UtcNow;
            if (!bumpOnly)
            {
                existing.Name = name; // keep the latest-entered casing
                existing.DefaultCaloriesBurned = calories;
                existing.DefaultDurationMin = duration;
            }
            await db.SaveChangesAsync(ct);
            return;
        }

        // A "custom" re-log of an exercise that's no longer saved (e.g. the user deleted it) is a no-op.
        if (bumpOnly) return;

        var now = DateTime.UtcNow;
        db.CustomExercises.Add(new CustomExercise
        {
            UserEmail = email,
            Name = name,
            NameKey = nameKey,
            DefaultCaloriesBurned = calories,
            DefaultDurationMin = duration,
            UseCount = 1,
            CreatedUtc = now,
            LastUsedUtc = now,
        });
        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException ex) when (IsUniqueViolation(ex))
        {
            // A concurrent log for the same identity won the race; drop our insert and bump the winner.
            db.ChangeTracker.Clear();
            var winner = await db.CustomExercises.FirstOrDefaultAsync(x =>
                x.UserEmail == email && x.NameKey == nameKey, ct);
            if (winner is null) return;
            winner.UseCount += 1;
            winner.LastUsedUtc = DateTime.UtcNow;
            winner.Name = name;
            winner.DefaultCaloriesBurned = calories;
            winner.DefaultDurationMin = duration;
            await db.SaveChangesAsync(ct);
        }
    }

    // ===================================================================================
    // Date handling
    // ===================================================================================

    /// <summary>Parse the client's yyyy-MM-dd date, or fall back to "today" in the display timezone.</summary>
    private static async Task<DateOnly> ResolveDateAsync(UsageDbContext db, string? date, CancellationToken ct)
    {
        if (TryParseDate(date, out var parsed)) return parsed;
        var tz = await DisplayTzAsync(db, ct);
        return DateOnly.FromDateTime(TimeZoneInfo.ConvertTimeFromUtc(DateTime.UtcNow, tz));
    }

    private static bool TryParseDate(string? date, out DateOnly result) =>
        DateOnly.TryParseExact((date ?? "").Trim(), "yyyy-MM-dd",
            System.Globalization.CultureInfo.InvariantCulture,
            System.Globalization.DateTimeStyles.None, out result);

    /// <summary>The app's display timezone, mirroring UsageQueries (UTC fallback on a bad/blank id).</summary>
    private static async Task<TimeZoneInfo> DisplayTzAsync(UsageDbContext db, CancellationToken ct)
    {
        var id = (await db.AppConfigs.AsNoTracking().FirstOrDefaultAsync(ct))?.DisplayTimeZone;
        if (string.IsNullOrWhiteSpace(id)) return TimeZoneInfo.Utc;
        try { return TimeZoneInfo.FindSystemTimeZoneById(id); } catch { return TimeZoneInfo.Utc; }
    }

    // ===================================================================================
    // Mapping + small helpers
    // ===================================================================================

    /// <summary>caloriesBurned = round(MET * weightKg * durationMin/60).</summary>
    private static int EstimateCalories(double met, double weightKg, int durationMin) =>
        (int)Math.Round(met * weightKg * (durationMin / 60.0));

    private static FoodEntryDto ToFoodDto(FoodEntry f) => new()
    {
        Id = f.Id,
        Meal = f.Meal.ToString().ToLowerInvariant(),
        FdcId = f.FdcId,
        Description = f.Description,
        Brand = f.Brand,
        Quantity = f.Quantity,
        ServingDesc = f.ServingDesc,
        Calories = f.Calories,
        ProteinG = f.ProteinG,
        CarbG = f.CarbG,
        FatG = f.FatG,
    };

    private static CustomFoodDto ToCustomFoodDto(CustomFood f) => new()
    {
        Id = f.Id,
        Description = f.Description,
        // Re-expose normalized-empty brand/serving as null so the client sees "no brand", not "".
        Brand = string.IsNullOrEmpty(f.Brand) ? null : f.Brand,
        ServingDesc = string.IsNullOrEmpty(f.ServingDesc) ? null : f.ServingDesc,
        Calories = f.Calories,
        ProteinG = f.ProteinG,
        CarbG = f.CarbG,
        FatG = f.FatG,
        UseCount = f.UseCount,
    };

    private static CustomExerciseDto ToCustomExerciseDto(CustomExercise x) => new()
    {
        Id = x.Id,
        Name = x.Name,
        DefaultCaloriesBurned = x.DefaultCaloriesBurned,
        DefaultDurationMin = x.DefaultDurationMin,
        UseCount = x.UseCount,
    };

    private static ExerciseEntryDto ToExerciseDto(ExerciseEntry x) => new()
    {
        Id = x.Id,
        ExerciseId = x.ExerciseId,
        Name = x.Name,
        DurationMin = x.DurationMin,
        CaloriesBurned = x.CaloriesBurned,
    };

    private static ExerciseLibraryDto ToLibraryDto(ExerciseLibrary x) => new()
    {
        Id = x.Id,
        Name = x.Name,
        Category = x.Category,
        Met = x.Met,
        Goals = (x.GoalTags ?? "")
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries),
    };

    private static TrackerProfileDto ToProfileDto(TrackerProfile p) => new()
    {
        Goal = p.Goal.ToString(),
        WeightKg = p.WeightKg,
        DailyCalorieGoal = p.DailyCalorieGoal,
        ProteinGoalG = p.ProteinGoalG,
        CarbGoalG = p.CarbGoalG,
        FatGoalG = p.FatGoalG,
        ShareWithContacts = p.ShareWithContacts,
        DateOfBirth = p.DateOfBirth?.ToString("yyyy-MM-dd"),
        HeightCm = p.HeightCm,
        Sex = p.Sex.ToString(),
        ActivityLevel = p.ActivityLevel.ToString(),
        GoalWeightKg = p.GoalWeightKg,
        UnitSystem = p.UnitSystem.ToString(),
        HydrationGoalMl = p.HydrationGoalMl,
    };

    private static HydrationEntryDto ToHydrationDto(HydrationEntry h) => new()
    {
        Id = h.Id,
        AmountMl = h.AmountMl,
        Label = h.Label,
        CreatedUtc = h.CreatedUtc.ToString("o", System.Globalization.CultureInfo.InvariantCulture),
    };

    private static bool TryParseMeal(string? value, out MealType meal) =>
        Enum.TryParse((value ?? "").Trim(), ignoreCase: true, out meal)
        && Enum.IsDefined(meal);

    private static string? NormalizeEmail(string? email)
    {
        var e = (email ?? "").Trim().ToLowerInvariant();
        return e.Length == 0 ? null : e;
    }

    private static IResult UsdaUnconfigured() => Results.Problem(
        title: "USDA FoodData Central is not configured.",
        detail: "USDA FoodData Central is not configured.",
        statusCode: StatusCodes.Status503ServiceUnavailable);

    private static IResult WorkoutXUnconfigured() => Results.Problem(
        title: "WorkoutX is not configured.",
        detail: "WorkoutX is not configured.",
        statusCode: StatusCodes.Status503ServiceUnavailable);

    private static string? Trunc(string? s, int max) =>
        s is null ? null : (s.Length > max ? s[..max] : s);

    private static double? Positive(double? v) => v is { } d && d > 0 ? d : null;
    private static int? Positive(int? v) => v is { } i && i > 0 ? i : null;

    private static bool IsUniqueViolation(DbUpdateException ex) =>
        ex.InnerException is Npgsql.PostgresException pg && pg.SqlState == Npgsql.PostgresErrorCodes.UniqueViolation;
}
