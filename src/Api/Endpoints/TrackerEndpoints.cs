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
    // USDA FoodData Central proxy (/api/foods) — search + details, 503 when unconfigured.
    // ===================================================================================
    private static void MapFoodsProxy(WebApplication app)
    {
        var g = app.MapGroup("/api/foods").RequireAuthorization();

        // ---- Search by free-text query OR barcode (UPC/GTIN) ----
        g.MapGet("/search", async (string? q, string? barcode, UsdaFoodService usda, CancellationToken ct) =>
        {
            if (!usda.IsConfigured) return UsdaUnconfigured();
            var items = await usda.SearchAsync(q, barcode, ct);
            return Results.Ok(items);
        }).RequirePermission(Permissions.TrackerSelf);

        // ---- Single food by FDC id ----
        g.MapGet("/{fdcId:int}", async (int fdcId, UsdaFoodService usda, CancellationToken ct) =>
        {
            if (!usda.IsConfigured) return UsdaUnconfigured();
            var item = await usda.GetDetailsAsync(fdcId, ct);
            return item is null ? Results.NotFound() : Results.Ok(item);
        }).RequirePermission(Permissions.TrackerSelf);
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
            return Results.Ok(ToFoodDto(entry));
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
            return Results.Ok(ToExerciseDto(entry));
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
            profile.UpdatedUtc = DateTime.UtcNow;
            await db.SaveChangesAsync(ct);
            return Results.Ok(ToProfileDto(profile));
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

        var foods = await db.FoodEntries.AsNoTracking()
            .Where(f => f.UserEmail == email && f.LocalDate == date)
            .OrderBy(f => f.Meal).ThenBy(f => f.Id)
            .ToListAsync(ct);
        var exercises = await db.ExerciseEntries.AsNoTracking()
            .Where(x => x.UserEmail == email && x.LocalDate == date)
            .OrderBy(x => x.Id)
            .ToListAsync(ct);

        var caloriesIn = foods.Sum(f => f.Calories);
        var caloriesOut = exercises.Sum(x => x.CaloriesBurned);
        var protein = Math.Round(foods.Sum(f => f.ProteinG), 1);
        var carbs = Math.Round(foods.Sum(f => f.CarbG), 1);
        var fat = Math.Round(foods.Sum(f => f.FatG), 1);

        var goal = profile?.DailyCalorieGoal;
        int? remaining = goal is { } g ? g - caloriesIn + caloriesOut : null;

        return new TrackerDayDto
        {
            Date = date.ToString("yyyy-MM-dd"),
            UserEmail = email,
            ReadOnly = readOnly,
            Profile = profileDto,
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
        };
    }

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

    private static string? Trunc(string? s, int max) =>
        s is null ? null : (s.Length > max ? s[..max] : s);

    private static double? Positive(double? v) => v is { } d && d > 0 ? d : null;
    private static int? Positive(int? v) => v is { } i && i > 0 ? i : null;

    private static bool IsUniqueViolation(DbUpdateException ex) =>
        ex.InnerException is Npgsql.PostgresException pg && pg.SqlState == Npgsql.PostgresErrorCodes.UniqueViolation;
}
