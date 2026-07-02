using Ccusage.Api.Auth;
using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Ccusage.Api.Dtos;
using Ccusage.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;

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
///   look but not edit. Deleting an entry the caller doesn't own is a 404. The ONE deliberate exception is
///   <c>POST /food/from-meal</c>: a household member may log a planned <see cref="FamilyMeal"/> onto a
///   co-member's day. That cross-member write is intentional (shared meal planning) and bounded — the target
///   must be a member of the SAME household as the meal (never a stranger, never leaks) and the endpoint is
///   still <c>tracker.self</c>-gated. See the notes on that endpoint for the trust boundary.</item>
/// </list>
/// All emails are compared/stored lower-cased. Nutrition is SNAPSHOTTED at log time and never re-fetched.
/// </summary>
public static class TrackerEndpoints
{
    /// <summary>Per-email limiter for the provider-backed food/exercise SEARCH proxies (USDA/FatSecret/
    /// WorkoutX). These are plain lookups, NOT Gemini calls, so they get their own generous bucket rather
    /// than sharing the (tight, token-costed) AI policy — type-ahead search must not starve AI-assist.</summary>
    public const string SearchRateLimitPolicy = "tracker-search";

    /// <summary>Per-email limiter for the WorkoutX GIF byte-proxy. A 2-pane exercise picker renders a grid of
    /// demo GIFs at once, so this is more generous than the search bucket but still bounded.</summary>
    public const string GifRateLimitPolicy = "tracker-gif";

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
        }).RequirePermission(Permissions.TrackerSelf).RequireRateLimiting(SearchRateLimitPolicy);

        // ---- Single food by FDC id (USDA-only) ----
        g.MapGet("/{fdcId:int}", async (int fdcId, UsdaFoodService usda, CancellationToken ct) =>
        {
            if (!usda.IsConfigured) return UsdaUnconfigured();
            var item = await usda.GetDetailsAsync(fdcId, ct);
            return item is null ? Results.NotFound() : Results.Ok(TagUsdaOne(item));
        }).RequirePermission(Permissions.TrackerSelf).RequireRateLimiting(SearchRateLimitPolicy);
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
            string? date, int? user, CurrentUserAccessor me, UsageDbContext db, TrackerService tracker, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!; // tracker.self filter guarantees non-null

            // The client holds no other-user emails (email-privacy): it sends ?user={userId}. Resolve the
            // id -> email server-side (shared TrackerService). No param => self. A non-positive id is a bad
            // request; an id that resolves to nobody is a 404 (same as a forbidden target — never leak existence).
            var (target, isSelf, resolveError) = await tracker.ResolveTargetAsync(user, caller, ct);
            if (resolveError is { } err) return err;

            var localDate = await ResolveDateAsync(db, date, ct);

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

            var entry = BuildFoodEntry(caller.Email, localDate, meal, req);
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

        // ---- Log a family meal's PER-SERVING macros onto a household member's day (tracker ⇄ Family Hub) ----
        // Cross-feature tie-in (Slice 2): take N servings of a planned FamilyMeal and log it as a FoodEntry on the
        // CALLER's — or a household co-member's — tracker. Strict isolation: the caller must be a MEMBER of the
        // meal's household (else 404 — a foreign meal's existence is never leaked, no email anywhere). The meal must
        // already have macros (MacroSource != "none"), else 400 ("estimate macros first"). The logged values are the
        // DERIVED per-serving macros (dish total / max(Servings, 1), rounded) × the requested servings (default 1).
        //
        // Cross-user write: when req.TargetUserId names another user, that user MUST be a member of the SAME
        // household as the meal (the SAME membership predicate the caller is validated by) — else 404 (never 403,
        // never leak, never write to a stranger). The entry is then OWNED by the target (FoodEntry is keyed by
        // UserEmail, so we resolve the target's email by AppUser id and lower-case it). The trust boundary is
        // household co-membership + the tracker.self gate on this endpoint — no extra permission, no migration.
        g.MapPost("/food/from-meal", async (
            AddFoodFromMealRequest req, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;

            if (req.MealId <= 0)
                return Results.BadRequest(new { message = "A valid mealId is required." });

            var meal = await db.FamilyMeals.AsNoTracking().FirstOrDefaultAsync(m => m.Id == req.MealId, ct);
            // 404 when the meal doesn't exist OR the caller isn't a member of its household — never leak it.
            if (meal is null) return Results.NotFound();
            var isMember = await HouseholdMembership.IsMemberAsync(db, meal.HouseholdId, caller.Id, ct);
            if (!isMember) return Results.NotFound();

            // Macros must be set (an AI/DB/manual estimate confirmed onto the meal) before it can be logged.
            if (string.Equals(meal.MacroSource, "none", StringComparison.OrdinalIgnoreCase))
                return Results.BadRequest(new { message = "Estimate this meal's macros first, then add it to your tracker." });

            // Owner = the caller by default. When TargetUserId names ANOTHER user, that user must be a member of
            // the meal's household (SAME predicate as the caller's check above) — else 404 (never leak, never write
            // to a stranger). FoodEntry is keyed by UserEmail, so resolve the target's email by AppUser id.
            var ownerEmail = caller.Email;
            if (req.TargetUserId is int targetUserId && targetUserId != caller.Id)
            {
                var targetIsMember = await HouseholdMembership.IsMemberAsync(db, meal.HouseholdId, targetUserId, ct);
                if (!targetIsMember) return Results.NotFound();

                var targetEmail = await db.Users.AsNoTracking()
                    .Where(u => u.Id == targetUserId && u.IsEnabled).Select(u => u.Email).FirstOrDefaultAsync(ct);
                if (string.IsNullOrEmpty(targetEmail)) return Results.NotFound();  // disabled/unknown target ⇒ 404
                ownerEmail = targetEmail.ToLowerInvariant();
            }

            // Servings to log: null ⇒ 1 (the historical "log ONE serving"); else clamp 0.1..99 (non-finite ⇒ 1).
            var s = req.Servings is { } reqS && double.IsFinite(reqS) ? Math.Clamp(reqS, 0.1, 99) : 1.0;

            // PER-SERVING = dish total / max(Servings, 1), rounded (calories whole, macros 1 dp). One portion.
            var servings = Math.Max(meal.Servings, 1);
            var perServingCal = (double)meal.Calories / servings;
            var perServingProtein = meal.ProteinG / servings;
            var perServingCarb = meal.CarbG / servings;
            var perServingFat = meal.FatG / servings;

            // Logged macros = per-serving × s, rounded like the server already rounds per-serving, floored >= 0.
            var calories = Math.Max(0, (int)Math.Round(perServingCal * s, MidpointRounding.AwayFromZero));
            var proteinG = Math.Max(0, Math.Round(perServingProtein * s, 1));
            var carbG = Math.Max(0, Math.Round(perServingCarb * s, 1));
            var fatG = Math.Max(0, Math.Round(perServingFat * s, 1));

            // LocalDate = provided localDate (if valid) else the meal's own planned date.
            var localDate = TryParseDate(req.LocalDate, out var parsed) ? parsed : meal.LocalDate;

            var description = meal.Title.Trim();
            if (description.Length == 0) description = "Meal";
            if (description.Length > 256) description = description[..256];

            var entry = new FoodEntry
            {
                UserEmail = ownerEmail,
                LocalDate = localDate,
                Meal = MealType.Dinner, // a planned dish defaults onto dinner; the user can recategorise later
                Description = description,
                Quantity = s,
                ServingDesc = Trunc($"{s:0.##} serving(s)", 128),
                Calories = calories,
                ProteinG = proteinG,
                CarbG = carbG,
                FatG = fatG,
                CreatedUtc = DateTime.UtcNow,
            };
            db.FoodEntries.Add(entry);
            await db.SaveChangesAsync(ct);

            return Results.Ok(ToFoodDto(entry));
        }).RequirePermission(Permissions.TrackerSelf);

        // ---- The caller's saved "My foods" library (auto-built from manual logs), newest-used first ----
        // When ?recent=true, ALSO surface recently-logged foods (most-recent first) deduped against the
        // saved list by name+brand, each flagged IsRecent — so re-adding a recent food is one tap. Recent
        // rows are owner-scoped + read-only (Id = 0, no delete).
        g.MapGet("/foods/saved", async (
            string? q, bool? recent, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
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
            var saved = rows.Select(ToCustomFoodDto).ToList();

            if (recent == true)
            {
                // Dedup key = normalized description + brand (matches how a saved food is keyed). Any food
                // already in the saved list is excluded so it never appears twice.
                var seen = saved
                    .Select(s => RecentKey(s.Description, s.Brand))
                    .ToHashSet(StringComparer.OrdinalIgnoreCase);

                var recentQuery = db.FoodEntries.AsNoTracking().Where(f => f.UserEmail == caller.Email);
                if (term.Length > 0)
                {
                    var like = $"%{term}%";
                    recentQuery = recentQuery.Where(f =>
                        EF.Functions.ILike(f.Description, like)
                        || (f.Brand != null && EF.Functions.ILike(f.Brand, like)));
                }

                // Pull a recent window (newest first) and dedupe in memory keeping the most-recent of each.
                var recentRows = await recentQuery
                    .OrderByDescending(f => f.CreatedUtc).ThenByDescending(f => f.Id)
                    .Take(200)
                    .ToListAsync(ct);

                foreach (var f in recentRows)
                {
                    if (saved.Count >= 100) break;
                    var key = RecentKey(f.Description, f.Brand);
                    if (!seen.Add(key)) continue; // already saved, or a more-recent log of the same food.
                    saved.Add(ToRecentFoodDto(f));
                }
            }

            return Results.Ok(saved.ToArray());
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

        // ---- Edit a logged food (owner only; priced rows recompute macros server-side) ----
        // Owner-scoped exactly like DELETE: the row MUST belong to the caller; a missing/foreign id is a
        // 404 (never 403 / existence leak). The priced-vs-manual split is keyed by the STORED row's FdcId
        // (the only persisted signal — Source isn't stored), and is server-authoritative:
        //   - PRICED row (FdcId != null): only quantity (+ optional meal/date) are honoured. Calories &
        //     macros are RECOMPUTED from the per-unit basis derived off the stored row
        //     (perUnit = storedTotal / storedQuantity, exact since the stored total was perUnit*oldQty),
        //     then scaled to the new quantity. Client-sent macros are IGNORED for a priced row.
        //   - MANUAL row (FdcId == null): description + the four macro TOTALS are stored directly (clamped
        //     like the add path), plus optional meal/date. An omitted field leaves that column unchanged.
        g.MapPut("/food/{id:long}", async (
            long id, UpdateFoodRequest req, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;

            // Owner-scoped fetch: a missing OR foreign row is a 404 (never reveal someone else's entry).
            var entry = await db.FoodEntries
                .FirstOrDefaultAsync(f => f.Id == id && f.UserEmail == caller.Email, ct);
            if (entry is null) return Results.NotFound();

            // Optional meal/date move (validated; blank/absent leaves the slot/day unchanged).
            if (!string.IsNullOrWhiteSpace(req.Meal))
            {
                if (!TryParseMeal(req.Meal, out var meal))
                    return Results.BadRequest(new { message = "Meal must be breakfast, lunch, dinner, or snack." });
                entry.Meal = meal;
            }
            if (!string.IsNullOrWhiteSpace(req.Date))
            {
                if (!TryParseDate(req.Date, out var localDate))
                    return Results.BadRequest(new { message = "A valid date (yyyy-MM-dd) is required." });
                entry.LocalDate = localDate;
            }

            if (entry.FdcId is not null)
            {
                // PRICED (USDA-derived) row: recompute totals from the per-unit basis. Quantity is the only
                // nutritional input; client macros are ignored entirely.
                if (req.Quantity is { } rawQty)
                {
                    var newQty = !double.IsFinite(rawQty) || rawQty <= 0 ? 1 : Math.Min(rawQty, 9999);
                    var oldQty = entry.Quantity;
                    if (oldQty > 0)
                    {
                        // perUnit = storedTotal / oldQty (exact: stored total was perUnit * oldQty); rescale.
                        entry.Calories = Math.Max(0, (int)Math.Round(entry.Calories / oldQty * newQty,
                            MidpointRounding.AwayFromZero));
                        entry.ProteinG = NonNeg(Math.Round(entry.ProteinG / oldQty * newQty, 1));
                        entry.CarbG = NonNeg(Math.Round(entry.CarbG / oldQty * newQty, 1));
                        entry.FatG = NonNeg(Math.Round(entry.FatG / oldQty * newQty, 1));
                    }
                    entry.Quantity = newQty;
                }
            }
            else
            {
                // MANUAL row: edit raw totals + description directly (each field optional; clamp like add).
                if (req.Description is not null)
                {
                    var description = req.Description.Trim();
                    if (description.Length == 0)
                        return Results.BadRequest(new { message = "A food description is required." });
                    if (description.Length > 256) description = description[..256];
                    entry.Description = description;
                }
                if (req.Calories is { } cal) entry.Calories = Math.Max(0, cal);
                if (req.ProteinG is { } p) entry.ProteinG = NonNeg(p);
                if (req.CarbG is { } c) entry.CarbG = NonNeg(c);
                if (req.FatG is { } fat) entry.FatG = NonNeg(fat);
                // A manual row's quantity is informational (totals are stored directly); honour an edit but
                // never rescale macros off it.
                if (req.Quantity is { } q)
                    entry.Quantity = !double.IsFinite(q) || q <= 0 ? 1 : Math.Min(q, 9999);
            }

            await db.SaveChangesAsync(ct);
            return Results.Ok(ToFoodDto(entry));
        }).RequirePermission(Permissions.TrackerSelf);

        // ---- Copy logged foods onto another day (OWN only; nutrition snapshotted; source untouched) ----
        // Bulk COPY (not move): take N of the CALLER's OWN FoodEntry ids and re-create each as a brand-new
        // row on targetDate, snapshotting the SAME nutrition (description, brand, fdcId, quantity,
        // servingDesc, calories, macros) — no provider re-lookup, no migration, the source rows are left
        // exactly as-is.
        //
        // IDOR GUARD: the source set is filtered by UserEmail == caller, so an id that belongs to ANOTHER
        // user is silently dropped — it is never read into the copy and never produces a row. Writes always
        // land on the CALLER's own day (UserEmail = caller.Email), so a caller can never copy a stranger's
        // entry nor write onto a stranger's day. No new permission; gated by tracker.self like every other
        // write on this group.
        g.MapPost("/food/copy", async (
            CopyFoodRequest req, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;

            if (!TryParseDate(req.TargetDate, out var targetDate))
                return Results.BadRequest(new { message = "A valid targetDate (yyyy-MM-dd) is required." });

            // Optional meal override: when present it must be valid; when absent each copy keeps its source meal.
            MealType? targetMeal = null;
            if (!string.IsNullOrWhiteSpace(req.TargetMeal))
            {
                if (!TryParseMeal(req.TargetMeal, out var parsedMeal))
                    return Results.BadRequest(new { message = "Meal must be breakfast, lunch, dinner, or snack." });
                targetMeal = parsedMeal;
            }

            var ids = (req.EntryIds ?? Array.Empty<long>()).Where(id => id > 0).Distinct().ToArray();
            if (ids.Length == 0)
                return Results.BadRequest(new { message = "At least one entryId is required." });

            // OWNER-ONLY load: filter by UserEmail == caller so a foreign id is never even fetched (the IDOR
            // guard). AsNoTracking — we re-create new rows, we don't mutate the sources.
            var sources = await db.FoodEntries.AsNoTracking()
                .Where(f => f.UserEmail == caller.Email && ids.Contains(f.Id))
                .ToListAsync(ct);

            // Re-create each owned source as a NEW row on targetDate, snapshotting its stored nutrition
            // verbatim (mirrors BuildFoodEntry's field copying). meal = override ?? the source's own meal.
            var copies = sources.Select(src => new FoodEntry
            {
                UserEmail = caller.Email,
                LocalDate = targetDate,
                Meal = targetMeal ?? src.Meal,
                FdcId = src.FdcId,
                Description = src.Description,
                Brand = src.Brand,
                Quantity = src.Quantity,
                ServingDesc = src.ServingDesc,
                Calories = src.Calories,
                ProteinG = src.ProteinG,
                CarbG = src.CarbG,
                FatG = src.FatG,
                CreatedUtc = DateTime.UtcNow,
            }).ToList();

            if (copies.Count > 0)
            {
                db.FoodEntries.AddRange(copies);
                await db.SaveChangesAsync(ct);
            }

            return Results.Ok(new CopyFoodResponse
            {
                CopiedCount = copies.Count,
                Entries = copies.Select(ToFoodDto).ToArray(),
            });
        }).RequirePermission(Permissions.TrackerSelf);

        // ---- Log an exercise (OWN only; MET-estimate calories when omitted) ----
        g.MapPost("/exercise", async (
            AddExerciseRequest req, CurrentUserAccessor me, UsageDbContext db, ActivityEmitter activity, CancellationToken ct) =>
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

            var entry = BuildExerciseEntry(caller.Email, localDate, name, duration, calories.Value, lib?.Id);
            db.ExerciseEntries.Add(entry);
            await db.SaveChangesAsync(ct);

            // Saved "My exercises" upkeep. A MANUAL log (no library ExerciseId AND no source) is auto-saved
            // / bumped; an explicit "custom" re-log bumps the matching saved row; library/workoutx logs are
            // never saved (library is goal-tagged + searchable, workoutx is searchable upstream).
            var source = (req.Source ?? "").Trim().ToLowerInvariant();
            var isManual = source.Length == 0 && req.ExerciseId is null;
            if (isManual || source == "custom")
                await UpsertCustomExerciseAsync(db, caller.Email, entry, bumpOnly: source == "custom", ct);

            // Activity feed (fire-and-forget; no-op unless the caller opted to share): a logged workout.
            // Non-sensitive payload only — the snapshotted exercise NAME + optional duration; NO calories.
            _ = activity.EmitAsync(caller.Email, ActivityEmitter.Kinds.WorkoutLogged, entry.DurationMin, entry.Name);

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

        // ---- The caller's GOAL-PLAN HISTORY (dated list of past plans + their targets, OWNER-ONLY) ----
        // A goal-history timeline is private body data — no ?user= param, no CanViewAsync — exactly like
        // GET /weight and /weight/stats. Newest-first; the 0001-01-01 backfill row is the "initial" plan.
        g.MapGet("/goal-plans", async (CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var plans = await db.GoalPlans.AsNoTracking()
                .Where(p => p.UserEmail == caller.Email)
                .OrderByDescending(p => p.EffectiveFrom)
                .ToListAsync(ct);
            return Results.Ok(plans.Select(ToGoalPlanDto).ToArray());
        }).RequirePermission(Permissions.TrackerSelf);

        // ---- Update the caller's profile ----
        g.MapPut("/profile", async (
            TrackerProfileDto req, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var profile = await GetOrCreateProfileAsync(db, caller.Email, ct);

            // The request → profile mapping, as a local function so the same-day race-recovery path can
            // re-apply it to a freshly-reloaded profile (a failed SaveChanges rolls back the in-place edit).
            void ApplyProfileEdits(TrackerProfile p)
            {
                p.Goal = Enum.TryParse<TrackerGoal>(req.Goal, ignoreCase: true, out var g) ? g : TrackerGoal.Maintain;
                p.WeightKg = Positive(req.WeightKg);
                p.DailyCalorieGoal = Positive(req.DailyCalorieGoal);
                p.ProteinGoalG = Positive(req.ProteinGoalG);
                p.CarbGoalG = Positive(req.CarbGoalG);
                p.FatGoalG = Positive(req.FatGoalG);
                p.ShareWithContacts = req.ShareWithContacts;
                p.DateOfBirth = TryParseDate(req.DateOfBirth, out var dob) ? dob : null;
                p.HeightCm = Positive(req.HeightCm);
                p.Sex = Enum.TryParse<BiologicalSex>(req.Sex, ignoreCase: true, out var sex) ? sex : BiologicalSex.Unspecified;
                p.ActivityLevel = Enum.TryParse<ActivityLevel>(req.ActivityLevel, ignoreCase: true, out var act) ? act : ActivityLevel.Sedentary;
                p.GoalWeightKg = Positive(req.GoalWeightKg);
                p.UnitSystem = Enum.TryParse<UnitSystem>(req.UnitSystem, ignoreCase: true, out var unit) ? unit : UnitSystem.Metric;
                p.HydrationGoalMl = Positive(req.HydrationGoalMl);
                p.CoffeeGoalCups = Positive(req.CoffeeGoalCups);
                p.StepGoal = Positive(req.StepGoal);

                // --- optional goal-builder refinements (all nullable / neutral-default; never required) ---
                p.WeeklyRateKg = req.WeeklyRateKg is { } wr && double.IsFinite(wr) ? Math.Clamp(wr, -2, 2) : null;
                p.BodyFatPct = req.BodyFatPct is { } bf && double.IsFinite(bf) && bf >= 0 && bf <= 75 ? bf : null;
                p.NeckCm = Positive(req.NeckCm);
                p.WaistCm = Positive(req.WaistCm);
                p.HipCm = Positive(req.HipCm);
                p.DietPattern = Enum.TryParse<DietPattern>(req.DietPattern, ignoreCase: true, out var diet) ? diet : DietPattern.Balanced;
                p.Restrictions = Trunc(string.IsNullOrWhiteSpace(req.Restrictions) ? null : req.Restrictions.Trim(), 500);
                p.TrainingType = Enum.TryParse<TrainingType>(req.TrainingType, ignoreCase: true, out var tt) ? tt : TrainingType.None;
                p.ProteinBasis = Enum.TryParse<ProteinBasis>(req.ProteinBasis, ignoreCase: true, out var pb) ? pb : ProteinBasis.PerBodyweight;
                p.LifeStage = Enum.TryParse<LifeStage>(req.LifeStage, ignoreCase: true, out var ls) ? ls : LifeStage.None;
                p.Trimester = req.Trimester is { } tr && tr >= 1 && tr <= 3 ? tr : null;
                p.MealsPerDay = req.MealsPerDay is { } mpd && mpd >= 1 && mpd <= 12 ? mpd : null;
                p.EatingWindow = Enum.TryParse<EatingWindow>(req.EatingWindow, ignoreCase: true, out var ew) ? ew : EatingWindow.None;
                p.GoalBasisWeightKg = Positive(req.GoalBasisWeightKg);
                p.BaselineReviewedUtc = TryParseUtc(req.BaselineReviewedUtc, out var reviewed) ? reviewed : null;
                p.UpdatedUtc = DateTime.UtcNow;
            }

            ApplyProfileEdits(profile);

            // SAVE = VERSION: stamp a GoalPlan effective TODAY when a target changed (upsert per (user,
            // today); unchanged saves write nothing). Added to the context here, persisted by the save below
            // in the SAME transaction so the profile and its today-plan never diverge.
            var today = DateOnly.FromDateTime(
                TimeZoneInfo.ConvertTimeFromUtc(DateTime.UtcNow, await DisplayTzAsync(db, ct)));
            await UpsertTodayPlanAsync(db, profile, today, ct);

            try
            {
                await db.SaveChangesAsync(ct);
            }
            catch (DbUpdateException ex) when (IsUniqueViolation(ex))
            {
                // A concurrent same-day save inserted the (user, today) plan first; the unique
                // (UserEmail, EffectiveFrom) index rejected our insert AND rolled back the profile edit.
                // Reload, re-apply the profile edits, overwrite the winning plan with our targets, re-save.
                db.ChangeTracker.Clear();
                profile = await GetOrCreateProfileAsync(db, caller.Email, ct);
                ApplyProfileEdits(profile);
                var winner = await db.GoalPlans
                    .FirstAsync(p => p.UserEmail == caller.Email && p.EffectiveFrom == today, ct);
                ApplyPlanSnapshot(winner, profile);
                await db.SaveChangesAsync(ct);
            }
            return Results.Ok(ToProfileDto(profile));
        }).RequirePermission(Permissions.TrackerSelf);

        // ---- Log (upsert) the caller's body weight on a day + slot (OWN only) ----
        // Upserts the WeightEntry for that local date AND slot (so morning + evening can coexist on one
        // day) AND sets profile.WeightKg to the MOST RECENT reading (latest date, then latest slot/insert)
        // so "current weight" tracks the freshest reading. Returns the refreshed profile so the client can
        // update its current weight + stats.
        g.MapPost("/weight", async (
            LogWeightRequest req, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;

            if (!TryParseDate(req.Date, out var localDate))
                return Results.BadRequest(new { message = "A valid date (yyyy-MM-dd) is required." });
            if (!(req.WeightKg >= 1 && req.WeightKg <= 1000))
                return Results.BadRequest(new { message = "Weight must be between 1 and 1000 kg." });

            var slot = Enum.TryParse<WeightSlot>(req.Slot, ignoreCase: true, out var s) ? s : WeightSlot.Unspecified;
            var weightKg = Math.Round(req.WeightKg, 2);

            var entry = await db.WeightEntries
                .FirstOrDefaultAsync(w => w.UserEmail == caller.Email && w.LocalDate == localDate && w.Slot == slot, ct);
            if (entry is null)
            {
                entry = new WeightEntry
                {
                    UserEmail = caller.Email,
                    LocalDate = localDate,
                    Slot = slot,
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
                // A concurrent insert for the same (user, date, slot) won the race; reload + overwrite it.
                db.ChangeTracker.Clear();
                profile = await GetOrCreateProfileAsync(db, caller.Email, ct);
                entry = await db.WeightEntries
                    .FirstAsync(w => w.UserEmail == caller.Email && w.LocalDate == localDate && w.Slot == slot, ct);
                entry.WeightKg = weightKg;
                await db.SaveChangesAsync(ct);
            }

            // Current weight = the most recent reading (latest date, then latest slot, then newest insert).
            var latest = await db.WeightEntries.AsNoTracking()
                .Where(w => w.UserEmail == caller.Email)
                .OrderByDescending(w => w.LocalDate).ThenByDescending(w => w.Slot).ThenByDescending(w => w.Id)
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

        // ---- The caller's own weight statistics (OWN only — private, never for others) ----
        // Per-slot average/latest/count, the typical morning→evening delta (avg evening − avg morning,
        // null if either is missing), and recent readings for charting.
        g.MapGet("/weight/stats", async (
            int? days, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var window = days is { } d ? Math.Clamp(d, 1, 365) : 90;
            var today = DateOnly.FromDateTime(
                TimeZoneInfo.ConvertTimeFromUtc(DateTime.UtcNow, await DisplayTzAsync(db, ct)));
            var from = today.AddDays(-(window - 1));

            var rows = await db.WeightEntries.AsNoTracking()
                .Where(w => w.UserEmail == caller.Email && w.LocalDate >= from && w.LocalDate <= today)
                .OrderBy(w => w.LocalDate).ThenBy(w => w.Slot).ThenBy(w => w.Id)
                .Select(w => new { w.LocalDate, w.Slot, w.WeightKg })
                .ToListAsync(ct);

            // Per-slot stats: average + latest (newest by date, then slot order, then insert) + count.
            var bySlot = rows
                .GroupBy(w => w.Slot)
                .OrderBy(grp => grp.Key)
                .Select(grp => new WeightSlotStatDto
                {
                    Slot = grp.Key.ToString(),
                    AvgKg = Math.Round(grp.Average(w => w.WeightKg), 2),
                    LatestKg = grp.Last().WeightKg, // rows are date/slot/id-ascending, so Last() is newest
                    Count = grp.Count(),
                })
                .ToList();

            double? AvgFor(WeightSlot slot)
            {
                var vals = rows.Where(w => w.Slot == slot).Select(w => w.WeightKg).ToList();
                return vals.Count == 0 ? null : vals.Average();
            }
            var morningAvg = AvgFor(WeightSlot.Morning);
            var eveningAvg = AvgFor(WeightSlot.Evening);
            var delta = morningAvg is { } m && eveningAvg is { } ev ? Math.Round(ev - m, 2) : (double?)null;

            var entries = rows
                .Select(w => new WeightStatEntryDto
                {
                    Date = w.LocalDate.ToString("yyyy-MM-dd"),
                    Slot = w.Slot.ToString(),
                    WeightKg = w.WeightKg,
                })
                .ToList();

            return Results.Ok(new WeightStatsDto
            {
                BySlot = bySlot,
                MorningEveningDeltaKg = delta,
                Entries = entries,
            });
        }).RequirePermission(Permissions.TrackerSelf);

        // ---- Log a drink onto a day (OWN only; many drinks per day, no upsert) ----
        g.MapPost("/hydration", async (
            AddHydrationRequest req, CurrentUserAccessor me, UsageDbContext db, ActivityEmitter activity, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;

            if (!TryParseDate(req.Date, out var localDate))
                return Results.BadRequest(new { message = "A valid date (yyyy-MM-dd) is required." });
            if (!(req.AmountMl >= 1 && req.AmountMl <= 5000))
                return Results.BadRequest(new { message = "Amount must be between 1 and 5000 ml." });

            // Day total BEFORE this drink, to detect the goal CROSSING (emit only on the first drink that
            // reaches the goal — never on every drink once over).
            var priorMl = await db.HydrationEntries.AsNoTracking()
                .Where(h => h.UserEmail == caller.Email && h.LocalDate == localDate)
                .SumAsync(h => h.AmountMl, ct);

            var entry = BuildHydrationEntry(caller.Email, localDate, req.AmountMl, req.Label);
            db.HydrationEntries.Add(entry);
            await db.SaveChangesAsync(ct);

            // Activity feed (fire-and-forget; no-op unless sharing): emit ONLY on the crossing into the goal.
            // Non-sensitive: just the boolean fact — no amounts on the wire.
            var goalMl = await db.TrackerProfiles.AsNoTracking()
                .Where(p => p.UserEmail == caller.Email)
                .Select(p => p.HydrationGoalMl)
                .FirstOrDefaultAsync(ct) ?? DefaultHydrationGoalMl;
            if (goalMl > 0 && priorMl < goalMl && priorMl + req.AmountMl >= goalMl)
                _ = activity.EmitAsync(caller.Email, ActivityEmitter.Kinds.HydrationGoalHit);

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

        // ---- Log a coffee onto a day (OWN only; many coffees per day, no upsert) ----
        g.MapPost("/coffee", async (
            AddCoffeeRequest req, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;

            if (!TryParseDate(req.Date, out var localDate))
                return Results.BadRequest(new { message = "A valid date (yyyy-MM-dd) is required." });

            var entry = BuildCoffeeEntry(caller.Email, localDate, req.Cups, req.CaffeineMg, req.Label);
            db.CoffeeEntries.Add(entry);
            await db.SaveChangesAsync(ct);
            return Results.Ok(ToCoffeeDto(entry));
        }).RequirePermission(Permissions.TrackerSelf);

        // ---- Delete a logged coffee (owner only) ----
        g.MapDelete("/coffee/{id:long}", async (
            long id, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            // 404 when the entry doesn't exist OR isn't the caller's (never reveal someone else's row).
            var deleted = await db.CoffeeEntries
                .Where(c => c.Id == id && c.UserEmail == caller.Email)
                .ExecuteDeleteAsync(ct);
            return deleted == 0 ? Results.NotFound() : Results.NoContent();
        }).RequirePermission(Permissions.TrackerSelf);

        // ---- Log a supplement onto a day (OWN only; many per day, no upsert) ----
        // Macros default to 0 when omitted (most supplements/vitamins/meds carry none); protein powders
        // carry real macros, which then SUM into the day's calorie/macro roll-up (see BuildDayAsync).
        g.MapPost("/supplement", async (
            AddSupplementRequest req, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;

            if (!TryParseDate(req.Date, out var localDate))
                return Results.BadRequest(new { message = "A valid date (yyyy-MM-dd) is required." });
            var name = req.Name?.Trim();
            if (string.IsNullOrEmpty(name))
                return Results.BadRequest(new { message = "A supplement name is required." });

            var entry = BuildSupplementEntry(caller.Email, localDate, req);
            db.SupplementEntries.Add(entry);
            await db.SaveChangesAsync(ct);
            return Results.Ok(ToSupplementDto(entry));
        }).RequirePermission(Permissions.TrackerSelf);

        // ---- Delete a logged supplement (owner only) ----
        g.MapDelete("/supplement/{id:long}", async (
            long id, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            // 404 when the entry doesn't exist OR isn't the caller's (never reveal someone else's row).
            var deleted = await db.SupplementEntries
                .Where(s => s.Id == id && s.UserEmail == caller.Email)
                .ExecuteDeleteAsync(ct);
            return deleted == 0 ? Results.NotFound() : Results.NoContent();
        }).RequirePermission(Permissions.TrackerSelf);

        // ---- Log a night of sleep onto a day (OWN only; mapped to the WAKE date) ----
        // Sleep is mildly personal: OWNER-ONLY end to end — it is never surfaced to a viewer (the day DTO
        // nulls it for non-self), never in the family overlay, and emits NO activity-feed event.
        g.MapPost("/sleep", async (
            AddSleepRequest req, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;

            if (!TryParseDate(req.Date, out var localDate))
                return Results.BadRequest(new { message = "A valid date (yyyy-MM-dd) is required." });
            if (!(req.Hours >= 0 && req.Hours <= 24))
                return Results.BadRequest(new { message = "Hours must be between 0 and 24." });

            var entry = BuildSleepEntry(caller.Email, localDate, req);
            db.SleepEntries.Add(entry);
            await db.SaveChangesAsync(ct);
            return Results.Ok(ToSleepDto(entry));
        }).RequirePermission(Permissions.TrackerSelf);

        // ---- Delete a logged sleep (owner only) ----
        g.MapDelete("/sleep/{id:long}", async (
            long id, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            // 404 when the entry doesn't exist OR isn't the caller's (never reveal someone else's row).
            var deleted = await db.SleepEntries
                .Where(s => s.Id == id && s.UserEmail == caller.Email)
                .ExecuteDeleteAsync(ct);
            return deleted == 0 ? Results.NotFound() : Results.NoContent();
        }).RequirePermission(Permissions.TrackerSelf);

        // ---- Upsert the caller's watch activity stats for a day (OWN only; one row per day) ----
        // Records steps/distance/active calories + the calorie mode (add|override) that controls how the
        // active calories factor into the day's calories out. Upserts the single (caller, date) row.
        g.MapPut("/activity", async (
            UpsertActivityRequest req, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;

            if (!TryParseDate(req.Date, out var localDate))
                return Results.BadRequest(new { message = "A valid date (yyyy-MM-dd) is required." });
            if (!InRange(req.Steps, 0, 200000))
                return Results.BadRequest(new { message = "Steps must be between 0 and 200000." });
            if (!InRange(req.DistanceMeters, 0, 1000000))
                return Results.BadRequest(new { message = "Distance must be between 0 and 1000000 metres." });
            if (!InRange(req.ActiveCalories, 0, 20000))
                return Results.BadRequest(new { message = "Active calories must be between 0 and 20000." });
            if (!TryParseCalorieMode(req.CalorieMode, out var mode))
                return Results.BadRequest(new { message = "Calorie mode must be 'add' or 'override'." });

            var now = DateTime.UtcNow;
            var entry = await db.DailyActivities
                .FirstOrDefaultAsync(a => a.UserEmail == caller.Email && a.LocalDate == localDate, ct);
            if (entry is null)
            {
                entry = new DailyActivity
                {
                    UserEmail = caller.Email,
                    LocalDate = localDate,
                    Steps = req.Steps,
                    DistanceMeters = req.DistanceMeters,
                    ActiveCalories = req.ActiveCalories,
                    CalorieMode = mode,
                    CreatedUtc = now,
                    UpdatedUtc = now,
                };
                db.DailyActivities.Add(entry);
            }
            else
            {
                entry.Steps = req.Steps;
                entry.DistanceMeters = req.DistanceMeters;
                entry.ActiveCalories = req.ActiveCalories;
                entry.CalorieMode = mode;
                entry.UpdatedUtc = now;
            }

            try
            {
                await db.SaveChangesAsync(ct);
            }
            catch (DbUpdateException ex) when (IsUniqueViolation(ex))
            {
                // A concurrent insert for the same (user, date) won the race; reload + overwrite it.
                db.ChangeTracker.Clear();
                entry = await db.DailyActivities
                    .FirstAsync(a => a.UserEmail == caller.Email && a.LocalDate == localDate, ct);
                entry.Steps = req.Steps;
                entry.DistanceMeters = req.DistanceMeters;
                entry.ActiveCalories = req.ActiveCalories;
                entry.CalorieMode = mode;
                entry.UpdatedUtc = now;
                await db.SaveChangesAsync(ct);
            }

            return Results.Ok(ToActivityDto(entry));
        }).RequirePermission(Permissions.TrackerSelf);

        // ---- Clear the caller's watch activity stats for a day (owner only) ----
        g.MapDelete("/activity", async (
            string? date, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            if (!TryParseDate(date, out var localDate))
                return Results.BadRequest(new { message = "A valid date (yyyy-MM-dd) is required." });

            // No-op delete (no row for that day) is still a 204 — the caller's day ends up with no stats
            // either way; there's nothing to leak (writes only ever target the caller).
            await db.DailyActivities
                .Where(a => a.UserEmail == caller.Email && a.LocalDate == localDate)
                .ExecuteDeleteAsync(ct);
            return Results.NoContent();
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
        }).RequirePermission(Permissions.TrackerSelf).RequireRateLimiting(SearchRateLimitPolicy);

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
            // Never trust the upstream-chosen media type verbatim: clamp it to a small image allowlist
            // (else default to image/gif) so a compromised/MITM'd WorkoutX host can't get us to serve
            // text/html or script content from our own JWT-authorized origin. Pair it with nosniff so the
            // browser won't content-sniff around the declared type either (no global header middleware exists).
            var contentType = g.ContentType switch
            {
                "image/gif" or "image/png" or "image/webp" or "image/jpeg" => g.ContentType,
                _ => "image/gif",
            };
            http.Response.Headers["X-Content-Type-Options"] = "nosniff";
            // The catalog gifs are immutable per id; let the browser cache them for a day.
            http.Response.Headers.CacheControl = "private, max-age=86400";
            return Results.Bytes(g.Bytes, contentType);
        }).RequirePermission(Permissions.TrackerSelf).RequireRateLimiting(GifRateLimitPolicy);

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
                // Mutual contacts (the contact's circle includes the caller) who have sharing on.
                usersQ = ContactGraph.SharingUsers(db, caller.Email);
            }

            var people = (await usersQ
                    .OrderBy(u => u.Name == "" ? u.Email : u.Name)
                    .Select(u => new { u.Id, u.Name, u.DisplayNameMode, u.Nickname, u.Picture })
                    .ToListAsync(ct))
                .Select(u => new SharedUserDto
                {
                    UserId = u.Id,
                    Name = DisplayName.Format(u.Name, u.DisplayNameMode, u.Nickname),
                    Picture = u.Picture,
                })
                .ToList();
            return Results.Ok(people);
        }).RequirePermission(Permissions.TrackerSelf);

        // ---- AI Day Builder: commit a whole reviewed draft in ONE atomic, idempotent pass (OWN only) ----
        // No Gemini call — the draft is the user-edited, fully-untrusted result of the builder dialog. Every
        // field is re-validated + re-clamped exactly like the single-entry endpoints; excess is dropped (never
        // a 400). Idempotency: the build-day GUID, held in IMemoryCache for 30 min, makes a double-submit a
        // no-op. All writes are in ONE transaction (all-or-nothing) so the day is never half-logged.
        g.MapPost("/day/commit", async (
            CommitDayRequest req, CurrentUserAccessor me, UsageDbContext db,
            IMemoryCache cache, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;

            if (string.IsNullOrWhiteSpace(req?.BuildId))
                return Results.BadRequest(new { message = "A buildId is required." });
            if (!TryParseDate(req.Date, out var localDate))
                return Results.BadRequest(new { message = "A valid date (yyyy-MM-dd) is required." });

            var key = $"daycommit:{caller.Email}:{req.BuildId.Trim()}:{localDate:yyyy-MM-dd}";
            if (cache.TryGetValue(key, out CommitCounts? cachedCounts) && cachedCounts is not null)
            {
                var alreadyDay = await BuildDayAsync(db, caller.Email, localDate, readOnly: false, ct);
                return Results.Ok(new CommitDayResponse
                {
                    AlreadyCommitted = true,
                    Logged = cachedCounts,
                    Day = alreadyDay,
                });
            }

            var draft = req.Draft ?? new DayDraft();
            var counts = new CommitCounts();

            // ---- Validate-all-before-insert (re-run the single-endpoint validation/clamping) ----
            var foodEntries = new List<FoodEntry>();
            var totalFoods = 0;
            var mealCount = 0;
            foreach (var meal in draft.Meals ?? new List<MealDraft>())
            {
                if (mealCount++ >= 5) break;
                // Unknown meal -> Snack (never a 400 at commit).
                if (!TryParseMeal(meal.Meal, out var mealType)) mealType = MealType.Snack;
                foreach (var item in meal.Items ?? new List<DraftFood>())
                {
                    if (totalFoods >= 50) break;
                    var description = (item.Description ?? "").Trim();
                    if (description.Length == 0) continue;
                    if (description.Length > 256) description = description[..256];

                    foodEntries.Add(new FoodEntry
                    {
                        UserEmail = caller.Email,
                        LocalDate = localDate,
                        Meal = mealType,
                        FdcId = null,
                        Description = description,
                        Brand = null,
                        // The free-text portion is descriptive only; the macros are already absolute totals.
                        Quantity = 1,
                        ServingDesc = Trunc((item.Quantity ?? "").Trim(), 128) is { Length: > 0 } q ? q : null,
                        Calories = ClampCalories(item.Calories),
                        ProteinG = ClampMacro(item.ProteinG),
                        CarbG = ClampMacro(item.CarbG),
                        FatG = ClampMacro(item.FatG),
                        CreatedUtc = DateTime.UtcNow,
                    });
                    totalFoods++;
                }
            }

            var exerciseEntries = new List<ExerciseEntry>();
            foreach (var ex in draft.Exercises ?? new List<DraftExercise>())
            {
                if (exerciseEntries.Count >= 20) break;
                var name = (ex.Name ?? "").Trim();
                if (name.Length == 0) continue;
                if (name.Length > 128) name = name[..128];
                var duration = ex.DurationMin is { } d && d > 0 ? Math.Min(d, 1440) : (int?)null;
                exerciseEntries.Add(BuildExerciseEntry(
                    caller.Email, localDate, name, duration, ClampCalories(ex.CaloriesBurned), null));
            }

            var hydrationEntries = new List<HydrationEntry>();
            foreach (var drink in draft.Hydration ?? new List<DraftDrink>())
            {
                if (hydrationEntries.Count >= 30) break;
                if (!(drink.Ml >= 1 && drink.Ml <= 5000)) continue;
                hydrationEntries.Add(BuildHydrationEntry(caller.Email, localDate, drink.Ml, drink.Label));
            }

            // Weight (at most one): skip unless 1..1000; slot enum-guard.
            double? weightValue = null;
            WeightSlot weightSlot = WeightSlot.Unspecified;
            if (draft.Weight is { } wd && wd.WeightKg is >= 1 and <= 1000)
            {
                weightValue = Math.Round(wd.WeightKg, 2);
                weightSlot = Enum.TryParse<WeightSlot>((wd.Slot ?? "").Trim(), ignoreCase: true, out var ws)
                    && Enum.IsDefined(ws) ? ws : WeightSlot.Unspecified;
            }

            // Activity (at most one): clamp all stats; calorie mode -> default add.
            DailyActivity? activityValues = null;
            if (draft.Activity is { } ad)
            {
                var mode = TryParseCalorieMode(ad.CalorieMode, out var m) ? m : ActivityCalorieMode.Add;
                activityValues = new DailyActivity
                {
                    Steps = ad.Steps is { } s ? Math.Clamp(s, 0, 200000) : null,
                    DistanceMeters = ad.DistanceMeters is { } dm ? Math.Clamp(dm, 0, 1000000) : null,
                    ActiveCalories = ad.ActiveCalories is { } ac ? Math.Clamp(ac, 0, 20000) : null,
                    CalorieMode = mode,
                };
            }

            // ---- ONE transaction: all-or-nothing. The DbContext uses the Npgsql RETRYING execution
            // strategy, which forbids a bare user transaction — the whole unit MUST run inside the strategy
            // so a transient failure retries the entire batch (not a half-applied one). ----
            var strategy = db.Database.CreateExecutionStrategy();
            await strategy.ExecuteAsync(async () =>
            {
                await using var tx = await db.Database.BeginTransactionAsync(ct);

                db.FoodEntries.AddRange(foodEntries);
                db.ExerciseEntries.AddRange(exerciseEntries);
                db.HydrationEntries.AddRange(hydrationEntries);

                if (weightValue is { } wkg)
                {
                    var existing = await db.WeightEntries.FirstOrDefaultAsync(
                        w => w.UserEmail == caller.Email && w.LocalDate == localDate && w.Slot == weightSlot, ct);
                    if (existing is null)
                        db.WeightEntries.Add(new WeightEntry
                        {
                            UserEmail = caller.Email,
                            LocalDate = localDate,
                            Slot = weightSlot,
                            WeightKg = wkg,
                            CreatedUtc = DateTime.UtcNow,
                        });
                    else
                        existing.WeightKg = wkg;
                }

                if (activityValues is not null)
                {
                    var existing = await db.DailyActivities.FirstOrDefaultAsync(
                        a => a.UserEmail == caller.Email && a.LocalDate == localDate, ct);
                    var now = DateTime.UtcNow;
                    if (existing is null)
                        db.DailyActivities.Add(new DailyActivity
                        {
                            UserEmail = caller.Email,
                            LocalDate = localDate,
                            Steps = activityValues.Steps,
                            DistanceMeters = activityValues.DistanceMeters,
                            ActiveCalories = activityValues.ActiveCalories,
                            CalorieMode = activityValues.CalorieMode,
                            CreatedUtc = now,
                            UpdatedUtc = now,
                        });
                    else
                    {
                        existing.Steps = activityValues.Steps;
                        existing.DistanceMeters = activityValues.DistanceMeters;
                        existing.ActiveCalories = activityValues.ActiveCalories;
                        existing.CalorieMode = activityValues.CalorieMode;
                        existing.UpdatedUtc = now;
                    }
                }

                await db.SaveChangesAsync(ct);
                await tx.CommitAsync(ct);
            });

            counts.Foods = foodEntries.Count;
            counts.Exercises = exerciseEntries.Count;
            counts.Drinks = hydrationEntries.Count;
            counts.Weight = weightValue is not null;
            counts.Activity = activityValues is not null;

            // After-commit, best-effort library upkeep (treat AI foods/exercises as manual — the user reviewed
            // + edited them). Failures are swallowed so a library hiccup never fails the committed day.
            try
            {
                foreach (var f in foodEntries)
                    await UpsertCustomFoodAsync(db, caller.Email, f, bumpOnly: false, ct);
                foreach (var x in exerciseEntries)
                    await UpsertCustomExerciseAsync(db, caller.Email, x, bumpOnly: false, ct);
            }
            catch
            {
                // best-effort only
            }

            cache.Set(key, counts, TimeSpan.FromMinutes(30));

            var day = await BuildDayAsync(db, caller.Email, localDate, readOnly: false, ct);
            return Results.Ok(new CommitDayResponse
            {
                AlreadyCommitted = false,
                Logged = counts,
                Day = day,
            });
        }).RequirePermission(Permissions.TrackerSelf);

        // ---- Move a day's entries from one date to another, by category (OWN only) ----
        // The fix for "the AI Day Builder / manual logging put my day on the WRONG date." Re-dates the
        // CALLER's own rows from fromDate -> toDate for each selected category (null/empty = all). Day
        // totals are computed on read (BuildDayAsync), so a re-date is enough — no recompute. For the
        // one-per-day domains a moved entry WINS over a conflicting target (delete the target row first):
        //   - weight is UNIQUE per (user, date, slot): per source slot that also exists on toDate, delete
        //     the target's same-slot row, then re-date the source.
        //   - activity is UNIQUE per (user, date): if toDate already has a row, delete it, then re-date.
        // The food/exercise/hydration moves have no uniqueness — a plain ExecuteUpdate re-dates every row.
        g.MapPost("/day/move", async (
            MoveDayRequest req, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;

            if (!TryParseDate(req?.FromDate, out var fromDate))
                return Results.BadRequest(new { message = "A valid fromDate (yyyy-MM-dd) is required." });
            if (!TryParseDate(req!.ToDate, out var toDate))
                return Results.BadRequest(new { message = "A valid toDate (yyyy-MM-dd) is required." });
            if (fromDate == toDate)
                return Results.BadRequest(new { message = "fromDate and toDate must be different." });

            // Normalize the requested categories; null/empty/whitespace-only => ALL. Unknown names are
            // simply ignored (a no-op move for that category).
            var requested = (req.Categories ?? Array.Empty<string>())
                .Where(c => !string.IsNullOrWhiteSpace(c))
                .Select(c => c.Trim().ToLowerInvariant())
                .ToHashSet();
            bool Wants(string cat) => requested.Count == 0 || requested.Contains(cat);

            var email = caller.Email;
            var moved = new MoveDayCounts();
            var replaced = new MoveDayReplaced();

            // food / exercise / hydration: no uniqueness — re-date every matching row in one statement.
            if (Wants("food"))
                moved.Food = await db.FoodEntries
                    .Where(f => f.UserEmail == email && f.LocalDate == fromDate)
                    .ExecuteUpdateAsync(s => s.SetProperty(f => f.LocalDate, toDate), ct);

            if (Wants("exercise"))
                moved.Exercise = await db.ExerciseEntries
                    .Where(x => x.UserEmail == email && x.LocalDate == fromDate)
                    .ExecuteUpdateAsync(s => s.SetProperty(x => x.LocalDate, toDate), ct);

            if (Wants("hydration"))
                moved.Hydration = await db.HydrationEntries
                    .Where(h => h.UserEmail == email && h.LocalDate == fromDate)
                    .ExecuteUpdateAsync(s => s.SetProperty(h => h.LocalDate, toDate), ct);

            if (Wants("coffee"))
                moved.Coffee = await db.CoffeeEntries
                    .Where(c => c.UserEmail == email && c.LocalDate == fromDate)
                    .ExecuteUpdateAsync(s => s.SetProperty(c => c.LocalDate, toDate), ct);

            // sleep (OWNER-ONLY; no uniqueness — naps/split sleep allowed): re-date every matching row, like
            // food/coffee. Without this branch a moved day strands its SleepEntry on the old date.
            if (Wants("sleep"))
                moved.Sleep = await db.SleepEntries
                    .Where(s => s.UserEmail == email && s.LocalDate == fromDate)
                    .ExecuteUpdateAsync(u => u.SetProperty(s => s.LocalDate, toDate), ct);

            // weight (UNIQUE per user+date+slot): the moved value wins per slot. Delete any target rows
            // whose slot also exists on the source, THEN re-date the source rows. Wrapped in the retrying
            // execution strategy's transaction so the delete+re-date is atomic (a naive BeginTransaction
            // throws under EnableRetryOnFailure).
            if (Wants("weight"))
            {
                var sourceSlots = await db.WeightEntries.AsNoTracking()
                    .Where(w => w.UserEmail == email && w.LocalDate == fromDate)
                    .Select(w => w.Slot)
                    .ToListAsync(ct);

                if (sourceSlots.Count > 0)
                {
                    var strategy = db.Database.CreateExecutionStrategy();
                    await strategy.ExecuteAsync(async () =>
                    {
                        await using var tx = await db.Database.BeginTransactionAsync(ct);

                        replaced.Weight = await db.WeightEntries
                            .Where(w => w.UserEmail == email && w.LocalDate == toDate
                                && sourceSlots.Contains(w.Slot))
                            .ExecuteDeleteAsync(ct);

                        moved.Weight = await db.WeightEntries
                            .Where(w => w.UserEmail == email && w.LocalDate == fromDate)
                            .ExecuteUpdateAsync(s => s.SetProperty(w => w.LocalDate, toDate), ct);

                        await tx.CommitAsync(ct);
                    });
                }
            }

            // Moving weight rows can change which reading is the MOST RECENT, so refresh the profile's
            // cached current weight (mirrors POST /weight) when something actually moved.
            if (moved.Weight > 0)
            {
                var profile = await db.TrackerProfiles.FirstOrDefaultAsync(p => p.UserEmail == email, ct);
                if (profile is not null)
                {
                    var latest = await db.WeightEntries.AsNoTracking()
                        .Where(w => w.UserEmail == email)
                        .OrderByDescending(w => w.LocalDate).ThenByDescending(w => w.Slot).ThenByDescending(w => w.Id)
                        .Select(w => (double?)w.WeightKg)
                        .FirstOrDefaultAsync(ct);
                    if (latest is { } lw && profile.WeightKg != lw)
                    {
                        profile.WeightKg = lw;
                        profile.UpdatedUtc = DateTime.UtcNow;
                        await db.SaveChangesAsync(ct);
                    }
                }
            }

            // activity (UNIQUE per user+date): if the source has a row and the target already has one, the
            // moved one wins — delete the target's, then re-date the source's. Atomic via the strategy.
            if (Wants("activity"))
            {
                var hasSource = await db.DailyActivities.AsNoTracking()
                    .AnyAsync(a => a.UserEmail == email && a.LocalDate == fromDate, ct);

                if (hasSource)
                {
                    var strategy = db.Database.CreateExecutionStrategy();
                    await strategy.ExecuteAsync(async () =>
                    {
                        await using var tx = await db.Database.BeginTransactionAsync(ct);

                        var targetDeleted = await db.DailyActivities
                            .Where(a => a.UserEmail == email && a.LocalDate == toDate)
                            .ExecuteDeleteAsync(ct);
                        replaced.Activity = targetDeleted > 0;

                        var sourceMoved = await db.DailyActivities
                            .Where(a => a.UserEmail == email && a.LocalDate == fromDate)
                            .ExecuteUpdateAsync(s => s.SetProperty(a => a.LocalDate, toDate), ct);
                        moved.Activity = sourceMoved > 0;

                        await tx.CommitAsync(ct);
                    });
                }
            }

            return Results.Ok(new MoveDayResponse
            {
                Moved = moved,
                Replaced = replaced,
                ToDate = toDate.ToString("yyyy-MM-dd"),
            });
        }).RequirePermission(Permissions.TrackerSelf);
    }

    // ===================================================================================
    // Per-entry builders (shared by the single endpoints AND the day-builder commit)
    // ===================================================================================

    /// <summary>A finite, non-negative double — coerces NaN/Infinity/negatives to 0 (macro flooring).</summary>
    private static double NonNeg(double n) => double.IsFinite(n) && n > 0 ? n : 0;

    /// <summary>Build a <see cref="FoodEntry"/> from an add-food request with the same clamping the single
    /// endpoint applies (description trim+cap done by the caller; macros floored at 0).</summary>
    private static FoodEntry BuildFoodEntry(string email, DateOnly localDate, MealType meal, AddFoodRequest req)
    {
        var description = (req.Description ?? "").Trim();
        if (description.Length > 256) description = description[..256];
        var brand = Trunc(req.Brand?.Trim(), 256);
        // Clamp to a sane range: a non-positive/NaN quantity defaults to 1; an absurd typo is capped so
        // a 99999-serving entry can't be persisted (mirrors the dialog's max="9999").
        var quantity = !double.IsFinite(req.Quantity) || req.Quantity <= 0 ? 1
            : Math.Min(req.Quantity, 9999);
        return new FoodEntry
        {
            UserEmail = email,
            LocalDate = localDate,
            Meal = meal,
            FdcId = req.FdcId,
            Description = description,
            Brand = string.IsNullOrEmpty(brand) ? null : brand,
            Quantity = quantity,
            ServingDesc = Trunc(req.ServingDesc?.Trim(), 128),
            // Floor at 0 AND coerce any non-finite (NaN/Infinity, e.g. from a deserialized client value)
            // to 0 so a bad macro never reaches the double columns.
            Calories = Math.Max(0, req.Calories),
            ProteinG = NonNeg(req.ProteinG),
            CarbG = NonNeg(req.CarbG),
            FatG = NonNeg(req.FatG),
            CreatedUtc = DateTime.UtcNow,
        };
    }

    /// <summary>Build an <see cref="ExerciseEntry"/> from already-resolved fields (name trimmed+capped by
    /// the caller; calories floored at 0).</summary>
    private static ExerciseEntry BuildExerciseEntry(
        string email, DateOnly localDate, string name, int? durationMin, int caloriesBurned, int? exerciseId)
    {
        if (name.Length > 128) name = name[..128];
        return new ExerciseEntry
        {
            UserEmail = email,
            LocalDate = localDate,
            ExerciseId = exerciseId,
            Name = name,
            DurationMin = durationMin is { } d && d > 0 ? d : null,
            CaloriesBurned = Math.Max(0, caloriesBurned),
            CreatedUtc = DateTime.UtcNow,
        };
    }

    /// <summary>Build a <see cref="HydrationEntry"/> (label trimmed + 64-capped; amount caller-validated).</summary>
    private static HydrationEntry BuildHydrationEntry(string email, DateOnly localDate, int amountMl, string? label)
    {
        var trimmed = Trunc(label?.Trim(), 64);
        return new HydrationEntry
        {
            UserEmail = email,
            LocalDate = localDate,
            AmountMl = amountMl,
            Label = string.IsNullOrEmpty(trimmed) ? null : trimmed,
            CreatedUtc = DateTime.UtcNow,
        };
    }

    /// <summary>Build a <see cref="CoffeeEntry"/> (cups clamped to 1..20; caffeine clamped to [0,2000] when
    /// set; label trimmed + 64-capped).</summary>
    private static CoffeeEntry BuildCoffeeEntry(string email, DateOnly localDate, int cups, int? caffeineMg, string? label)
    {
        var trimmed = Trunc(label?.Trim(), 64);
        return new CoffeeEntry
        {
            UserEmail = email,
            LocalDate = localDate,
            Cups = Math.Clamp(cups, 1, 20),
            CaffeineMg = caffeineMg is { } mg ? Math.Clamp(mg, 0, 2000) : null,
            Label = string.IsNullOrEmpty(trimmed) ? null : trimmed,
            CreatedUtc = DateTime.UtcNow,
        };
    }

    /// <summary>Build a <see cref="SupplementEntry"/> from the request (name trimmed + 120-capped; dose
    /// trimmed + 60-capped; kind parsed with a Supplement default; calories clamped to [0,5000] and each
    /// macro to [0,500] g — macros default to 0 when the request omits them).</summary>
    private static SupplementEntry BuildSupplementEntry(string email, DateOnly localDate, AddSupplementRequest req)
    {
        var name = Trunc(req.Name?.Trim(), 120) ?? "";
        var dose = Trunc(req.Dose?.Trim(), 60);
        return new SupplementEntry
        {
            UserEmail = email,
            LocalDate = localDate,
            Name = name,
            Dose = string.IsNullOrEmpty(dose) ? null : dose,
            Kind = ParseSupplementKind(req.Kind),
            Calories = ClampCalories(req.Calories ?? 0),
            ProteinG = (decimal)ClampMacro(req.Protein ?? 0),
            CarbG = (decimal)ClampMacro(req.Carb ?? 0),
            FatG = (decimal)ClampMacro(req.Fat ?? 0),
            CreatedUtc = DateTime.UtcNow,
        };
    }

    /// <summary>Build a <see cref="SleepEntry"/> from the request (hours caller-validated to [0,24], rounded
    /// to 1dp; quality clamped to [1,5] with a 3 default; bed/wake times parsed as "HH:mm" local-of-day and
    /// dropped when unparseable; note trimmed + 200-capped).</summary>
    private static SleepEntry BuildSleepEntry(string email, DateOnly localDate, AddSleepRequest req)
    {
        var note = Trunc(req.Note?.Trim(), 200);
        var quality = req.Quality is { } q ? Math.Clamp(q, 1, 5) : 3;
        return new SleepEntry
        {
            UserEmail = email,
            LocalDate = localDate,
            Hours = Math.Round((decimal)req.Hours, 1),
            Quality = quality,
            BedTime = TryParseTime(req.BedTime, out var bed) ? bed : null,
            WakeTime = TryParseTime(req.WakeTime, out var wake) ? wake : null,
            Note = string.IsNullOrEmpty(note) ? null : note,
            CreatedUtc = DateTime.UtcNow,
        };
    }

    /// <summary>Parse a local time-of-day in 24-hour "HH:mm" (e.g. "23:30", "06:15"); false on null/blank/bad.</summary>
    private static bool TryParseTime(string? value, out TimeOnly time) =>
        TimeOnly.TryParseExact(
            (value ?? "").Trim(), "HH:mm",
            System.Globalization.CultureInfo.InvariantCulture,
            System.Globalization.DateTimeStyles.None, out time);

    /// <summary>Parse the supplement kind (lower-cased enum name, case-insensitive); Supplement on anything
    /// absent/unknown.</summary>
    private static SupplementKind ParseSupplementKind(string? value) =>
        Enum.TryParse<SupplementKind>((value ?? "").Trim(), ignoreCase: true, out var k) && Enum.IsDefined(k)
            ? k
            : SupplementKind.Supplement;

    /// <summary>Clamp a calorie value to [0, 5000] (mirrors the GeminiService clamp for commit-time safety).</summary>
    private static int ClampCalories(int v) => Math.Clamp(v, 0, 5000);

    /// <summary>Clamp a macro value to [0, 500] g, rounded to 1dp.</summary>
    private static double ClampMacro(double v)
    {
        if (double.IsNaN(v) || double.IsInfinity(v) || v < 0) return 0;
        return Math.Round(Math.Min(v, 500), 1);
    }

    // ===================================================================================
    // Visibility
    // ===================================================================================

    /// <summary>
    /// Whether <paramref name="caller"/> may READ <paramref name="target"/>'s tracker (target != self):
    /// true when the caller holds <see cref="Permissions.TrackerViewAll"/>, OR the target has
    /// <c>ShareWithContacts=true</c> and the caller is in the target's mutual chat circle.
    /// </summary>
    private static Task<bool> CanViewAsync(
        UsageDbContext db, CurrentUserAccessor.CurrentUser caller, string target, CancellationToken ct)
        // Single source of truth — shared with the 75 Hard feature (HardChallengeEndpoints).
        => Services.TrackerVisibility.CanViewAsync(db, caller, target, ct);

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

        // History-correct targets: score THIS day against the plan active on it (the latest plan with
        // EffectiveFrom <= date), falling back to the live profile targets when no plan exists. The day DTO's
        // embedded goal/macro targets are overlaid from the resolved plan so a viewer of a PAST day sees that
        // day's goals, not the live ones. (The live GET /tracker/profile DTO stays current-profile-based.)
        var targets = await ResolveTargetsAsync(db, email, date, profile, ct);
        profileDto.Goal = targets.Goal.ToString();
        profileDto.DailyCalorieGoal = targets.DailyCalorieGoal;
        profileDto.ProteinGoalG = targets.ProteinGoalG;
        profileDto.CarbGoalG = targets.CarbGoalG;
        profileDto.FatGoalG = targets.FatGoalG;
        // Body metrics are the owner's PRIVATE data — never expose them to a viewer (shared contact or
        // coach with tracker.viewall). A viewer legitimately needs the goal direction, the daily targets
        // and the sharing/display flags, but NEVER the raw body metrics. Null every metric that reveals
        // body data (weight, goal weight, height, age/DOB, sex). The body-metric estimates (BMI/BMR/TDEE)
        // in `stats` are already only computed for the owner (see below), so they stay null for viewers.
        if (readOnly)
        {
            profileDto.WeightKg = null;
            profileDto.GoalWeightKg = null;
            profileDto.HeightCm = null;
            profileDto.DateOfBirth = null;
            profileDto.Sex = "Unspecified";
        }

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
        // Coffee is part of the day (like hydration): a permitted viewer sees the totals + entries read-only
        // too. Many coffees per day, so this is a plain list (no upsert), oldest-first by id.
        var coffee = await db.CoffeeEntries.AsNoTracking()
            .Where(c => c.UserEmail == email && c.LocalDate == date)
            .OrderBy(c => c.Id)
            .ToListAsync(ct);
        // Supplements are part of the day (like food): their macros SUM into the day's calorie/macro
        // roll-up (so whey counts toward intake) AND surface as a labelled subtotal + list. A permitted
        // viewer sees them read-only too. Many per day, so a plain list (no upsert), oldest-first by id.
        var supplements = await db.SupplementEntries.AsNoTracking()
            .Where(s => s.UserEmail == email && s.LocalDate == date)
            .OrderBy(s => s.Id)
            .ToListAsync(ct);
        // Sleep is OWNER-ONLY (mildly personal): read it (the day's entries + the rolling 7-day average)
        // ONLY for the owner; a viewer gets an empty list + null averages so it never leaks. The 7-day
        // window is this day + the prior 6, averaged over the nights that HAVE an entry (a gap is skipped,
        // not counted as zero), so an occasional missed log doesn't sink the average.
        List<SleepEntry> sleep = new();
        double? sleepAvgHours = null;
        double? sleepAvgQuality = null;
        if (!readOnly)
        {
            sleep = await db.SleepEntries.AsNoTracking()
                .Where(s => s.UserEmail == email && s.LocalDate == date)
                .OrderBy(s => s.Id)
                .ToListAsync(ct);

            var windowFrom = date.AddDays(-6);
            var window = await db.SleepEntries.AsNoTracking()
                .Where(s => s.UserEmail == email && s.LocalDate >= windowFrom && s.LocalDate <= date)
                .Select(s => new { s.Hours, s.Quality })
                .ToListAsync(ct);
            if (window.Count > 0)
            {
                sleepAvgHours = Math.Round(window.Average(s => (double)s.Hours), 1);
                sleepAvgQuality = Math.Round(window.Average(s => (double)s.Quality), 1);
            }
        }

        // The day's recorded watch stats (at most one per day), part of the day like hydration/exercise:
        // a permitted viewer sees them (and the resolved burn) read-only too — we do NOT null it.
        var activity = await db.DailyActivities.AsNoTracking()
            .FirstOrDefaultAsync(a => a.UserEmail == email && a.LocalDate == date, ct);

        // The supplement contribution to the day, surfaced separately so it is not a mystery delta.
        var supplementCalories = supplements.Sum(s => s.Calories);
        var supplementProtein = Math.Round(supplements.Sum(s => (double)s.ProteinG), 1);
        var supplementCarbs = Math.Round(supplements.Sum(s => (double)s.CarbG), 1);
        var supplementFat = Math.Round(supplements.Sum(s => (double)s.FatG), 1);

        // Calories in / macros = food + supplements (whey etc. count toward intake).
        var caloriesIn = foods.Sum(f => f.Calories) + supplementCalories;
        // The raw logged-exercise sum, BEFORE the watch add/override.
        var exerciseCalories = exercises.Sum(x => x.CaloriesBurned);
        // Resolve calories out: with a watch active-calories value, ADD on top of exercises or OVERRIDE
        // (replace) the exercise sum; with no watch entry / no active calories, it's the exercise sum.
        var caloriesOut = ResolveCaloriesOut(exerciseCalories, activity);
        var protein = Math.Round(foods.Sum(f => f.ProteinG) + supplementProtein, 1);
        var carbs = Math.Round(foods.Sum(f => f.CarbG) + supplementCarbs, 1);
        var fat = Math.Round(foods.Sum(f => f.FatG) + supplementFat, 1);

        // The calorie goal for THIS day comes from the resolved (date-active) plan targets, not the live
        // profile — so editing the goal today never re-scores yesterday. Remaining math is unchanged.
        var goal = targets.DailyCalorieGoal;
        int? remaining = goal is { } g ? g - caloriesIn + caloriesOut : null;

        var hydrationMl = hydration.Sum(h => h.AmountMl);
        // The resolved goal: the profile's goal when set, else the 2000 ml default.
        var hydrationGoalMl = profile?.HydrationGoalMl ?? DefaultHydrationGoalMl;

        var coffeeCups = coffee.Sum(c => c.Cups);
        var caffeineMg = coffee.Sum(c => c.CaffeineMg ?? 0);
        // The resolved coffee CAP: the profile's goal when set, else the 3-cup default.
        var coffeeGoalCups = profile?.CoffeeGoalCups ?? DefaultCoffeeGoalCups;

        // ---- RECOVERY (Sleep & Recovery vertical) — deterministic, owner-only, computed only when a sleep
        // entry exists for the day (recovery derives from sleep, which is owner-only). null/absent otherwise. ----
        int? recoveryScore = null, recoverySleep = null, recoveryCaffeine = null, recoveryTraining = null, recoveryFuel = null;
        string? recoveryLabel = null;
        if (!readOnly && sleep.Count > 0)
        {
            // Last night = the scored day's sleep: total hours (sum over rows, naps allowed) + the best-rated
            // quality recorded (the primary night's rating; 0 when none rated).
            var nightHours = sleep.Sum(s => (double)s.Hours);
            var nightQuality = sleep.Max(s => s.Quality);

            // CAFFEINE SOURCE (precise + stable): the day's coffee mg — each CoffeeEntry's CaffeineMg, or a
            // cups * 95 mg fallback when null — PLUS 95 mg per "Coffee"-labelled hydration drink (case-insensitive).
            var coffeeCaffeine = coffee.Sum(c => c.CaffeineMg ?? c.Cups * DefaultCaffeineMgPerCup);
            var hydrationCoffeeCaffeine = hydration
                .Count(h => string.Equals(h.Label, "Coffee", StringComparison.OrdinalIgnoreCase))
                * DefaultCaffeineMgPerCup;
            var recoveryCaffeineMg = coffeeCaffeine + hydrationCoffeeCaffeine;

            var rec = TrackerStats.ComputeRecovery(new TrackerStats.RecoveryInputs(
                SleepHours: nightHours,
                SleepQuality: nightQuality,
                CaffeineMg: recoveryCaffeineMg,
                ExerciseCalories: exerciseCalories,
                ActiveCalories: activity?.ActiveCalories ?? 0,
                CaloriesIn: caloriesIn,
                CalorieGoal: goal));
            recoveryScore = rec.Score;
            recoverySleep = rec.SleepScore;
            recoveryCaffeine = rec.CaffeineScore;
            recoveryTraining = rec.TrainingScore;
            recoveryFuel = rec.FuelScore;
            recoveryLabel = rec.Label;
        }

        // Resolve the day owner's email -> {AppUser.Id, Name}; the raw owner email is NEVER put on the wire
        // (email-privacy). db.Users.Email is stored lower-cased.
        var owner = await db.Users.AsNoTracking()
            .Where(u => u.Email == email)
            .Select(u => new { u.Id, u.Name, u.DisplayNameMode, u.Nickname })
            .FirstOrDefaultAsync(ct);

        return new TrackerDayDto
        {
            Date = date.ToString("yyyy-MM-dd"),
            UserId = owner?.Id ?? 0,
            UserName = owner is null ? "Unknown user" : DisplayName.Format(owner.Name, owner.DisplayNameMode, owner.Nickname),
            ReadOnly = readOnly,
            Profile = profileDto,
            Stats = stats,
            Foods = foods.Select(ToFoodDto).ToArray(),
            Exercises = exercises.Select(ToExerciseDto).ToArray(),
            CaloriesIn = caloriesIn,
            CaloriesOut = caloriesOut,
            ExerciseCalories = exerciseCalories,
            NetCalories = caloriesIn - caloriesOut,
            ProteinG = protein,
            CarbG = carbs,
            FatG = fat,
            CalorieGoal = goal,
            Remaining = remaining,
            HydrationMl = hydrationMl,
            HydrationGoalMl = hydrationGoalMl,
            Hydration = hydration.Select(ToHydrationDto).ToArray(),
            CoffeeCups = coffeeCups,
            CaffeineMg = caffeineMg,
            CoffeeGoalCups = coffeeGoalCups,
            Coffee = coffee.Select(ToCoffeeDto).ToArray(),
            SupplementCalories = supplementCalories,
            SupplementProteinG = supplementProtein,
            SupplementCarbG = supplementCarbs,
            SupplementFatG = supplementFat,
            Supplements = supplements.Select(ToSupplementDto).ToArray(),
            Sleep = sleep.Select(ToSleepDto).ToArray(),
            SleepHours = Math.Round(sleep.Sum(s => (double)s.Hours), 1),
            SleepAvgHours7d = sleepAvgHours,
            SleepAvgQuality7d = sleepAvgQuality,
            RecoveryScore = recoveryScore,
            RecoverySleepScore = recoverySleep,
            RecoveryCaffeineScore = recoveryCaffeine,
            RecoveryTrainingScore = recoveryTraining,
            RecoveryFuelScore = recoveryFuel,
            RecoveryLabel = recoveryLabel,
            Activity = activity is null ? null : ToActivityDto(activity),
            StepGoal = profile?.StepGoal,
        };
    }

    /// <summary>
    /// The day's RESOLVED calories out: the logged-exercise sum, with the watch ACTIVE CALORIES applied
    /// per the activity's mode — ADD adds them on top (exercises + active), OVERRIDE replaces the exercise
    /// sum with the watch total (a watch active-calories figure usually already includes the day's
    /// workouts). With no activity row OR no active-calories value, it is just the exercise sum.
    /// </summary>
    private static int ResolveCaloriesOut(int exerciseCalories, DailyActivity? activity)
    {
        if (activity?.ActiveCalories is not { } active) return exerciseCalories;
        return activity.CalorieMode == ActivityCalorieMode.Override
            ? active
            : exerciseCalories + active;
    }

    /// <summary>The fallback daily hydration goal (ml) when a user's profile has none set.</summary>
    private const int DefaultHydrationGoalMl = 2000;

    /// <summary>The fallback daily coffee CAP (cups) when a user's profile has none set. A limit, not a target.</summary>
    private const int DefaultCoffeeGoalCups = 3;

    /// <summary>Default caffeine estimate (mg) for one cup of coffee — used by the RECOVERY caffeine load when a
    /// <see cref="CoffeeEntry.CaffeineMg"/> is null (cups * this) and per "Coffee"-labelled hydration drink. A
    /// typical 8 oz brewed coffee is ≈ 95 mg.</summary>
    private const int DefaultCaffeineMgPerCup = 95;

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
    // Goal-plan resolution (history-correct day/stats targets)
    // ===================================================================================

    /// <summary>The GoalPlan active on a local date = the row with the greatest EffectiveFrom &lt;= date for
    /// the user. Null when the user has no plan on/before that date (caller then falls back to the live
    /// profile targets via TrackerStats.TargetsFromProfile).</summary>
    // Single source of truth — shared with the AI endpoints via TrackerService.
    private static Task<GoalPlan?> ActivePlanForDateAsync(
        UsageDbContext db, string email, DateOnly date, CancellationToken ct) =>
        Services.TrackerService.ActivePlanForDateAsync(db, email, date, ct);

    /// <summary>Resolve the targets to score a date against: the active plan's, else the profile fallback.
    /// After the backfill every existing user has a 0001-01-01 plan, so the plan branch covers all historical
    /// dates; the profile fallback is the safety net for the transient gap before the first goal is saved.</summary>
    // internal so the AI snapshot (BuildSleepSummaryAsync) resolves the SAME date-active goal the day view does.
    // Single source of truth — delegates to TrackerService so the day view + AI recap can never diverge.
    internal static Task<TrackerStats.GoalTargets> ResolveTargetsAsync(
        UsageDbContext db, string email, DateOnly date, TrackerProfile? profile, CancellationToken ct) =>
        Services.TrackerService.ResolveTargetsCoreAsync(db, email, date, profile, ct);

    /// <summary>
    /// SAVE = VERSION. After a profile/goal save, upsert a GoalPlan effective TODAY (display-tz) — but ONLY
    /// when a target changed. "Changed" = the incoming resolved targets (Goal, WeeklyRateKg, the four numeric
    /// goals) differ from the plan ACTIVE FOR TODAY (or there is none). Comparing to the active plan (not the
    /// pre-edit profile) is what makes two same-day edits REPLACE one row and the first-ever save create one.
    /// The new/edited GoalPlan is ADDED to the context but NOT saved here — the caller's existing
    /// SaveChangesAsync persists the profile mutation and this plan in the SAME transaction (so they can't
    /// diverge). Snapshots WeightKg/BodyFatPct/ActivityLevel/DietPattern from the now-updated profile.
    /// </summary>
    private static async Task UpsertTodayPlanAsync(
        UsageDbContext db, TrackerProfile profile, DateOnly today, CancellationToken ct)
    {
        var active = await ActivePlanForDateAsync(db, profile.UserEmail, today, ct);

        // Did any SCORING target change vs the currently-active plan? (No active plan ⇒ always a change.)
        bool changed = active is null
            || active.Goal != profile.Goal
            || !NullableDoubleEquals(active.WeeklyRateKg, profile.WeeklyRateKg)
            || active.DailyCalorieGoal != profile.DailyCalorieGoal
            || active.ProteinGoalG != profile.ProteinGoalG
            || active.CarbGoalG != profile.CarbGoalG
            || active.FatGoalG != profile.FatGoalG;
        if (!changed) return; // unchanged-target save ⇒ no plan written (rule 4)

        // Upsert the (user, today) row: overwrite an existing same-day plan, else insert a new one. We read
        // it TRACKED (not via the AsNoTracking resolver) so an overwrite is persisted by the caller's save.
        var todayPlan = await db.GoalPlans
            .FirstOrDefaultAsync(p => p.UserEmail == profile.UserEmail && p.EffectiveFrom == today, ct);
        if (todayPlan is null)
        {
            db.GoalPlans.Add(new GoalPlan
            {
                UserEmail = profile.UserEmail,
                EffectiveFrom = today,
                Goal = profile.Goal,
                WeeklyRateKg = profile.WeeklyRateKg,
                DailyCalorieGoal = profile.DailyCalorieGoal,
                ProteinGoalG = profile.ProteinGoalG,
                CarbGoalG = profile.CarbGoalG,
                FatGoalG = profile.FatGoalG,
                WeightKg = profile.WeightKg,
                BodyFatPct = profile.BodyFatPct,
                ActivityLevel = profile.ActivityLevel,
                DietPattern = profile.DietPattern,
                CreatedUtc = DateTime.UtcNow,
            });
        }
        else
        {
            ApplyPlanSnapshot(todayPlan, profile);
        }
    }

    /// <summary>Copy the now-updated profile's targets + display snapshots onto a same-day plan row (used by
    /// the in-place overwrite and the unique-violation race recovery so both stay identical).</summary>
    private static void ApplyPlanSnapshot(GoalPlan plan, TrackerProfile profile)
    {
        plan.Goal = profile.Goal;
        plan.WeeklyRateKg = profile.WeeklyRateKg;
        plan.DailyCalorieGoal = profile.DailyCalorieGoal;
        plan.ProteinGoalG = profile.ProteinGoalG;
        plan.CarbGoalG = profile.CarbGoalG;
        plan.FatGoalG = profile.FatGoalG;
        plan.WeightKg = profile.WeightKg;
        plan.BodyFatPct = profile.BodyFatPct;
        plan.ActivityLevel = profile.ActivityLevel;
        plan.DietPattern = profile.DietPattern;
        plan.CreatedUtc = DateTime.UtcNow;
    }

    /// <summary>Nullable-double equality with a tiny tolerance (pace is stored as a finite double; an exact
    /// == round-trips fine, but the epsilon guards against a re-clamp producing a 1e-15 drift).</summary>
    private static bool NullableDoubleEquals(double? a, double? b) =>
        (a is null && b is null) || (a is { } x && b is { } y && Math.Abs(x - y) < 1e-9);

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
    // Single source of truth — shared with the AI endpoints via TrackerService.
    private static Task<DateOnly> ResolveDateAsync(UsageDbContext db, string? date, CancellationToken ct)
        => Services.TrackerService.ResolveDateCoreAsync(db, date, ct);

    private static bool TryParseDate(string? date, out DateOnly result) =>
        Services.TrackerService.TryParseDate(date, out result);

    /// <summary>Parse an ISO-8601 UTC timestamp into a Kind=Utc DateTime (required by Npgsql's timestamptz).
    /// AssumeUniversal+AdjustToUniversal is the VALID combo that always yields Utc (RoundtripKind must NOT be
    /// combined with AdjustToUniversal — that throws ArgumentException, which 500'd every profile save).</summary>
    private static bool TryParseUtc(string? value, out DateTime result)
    {
        if (DateTime.TryParse((value ?? "").Trim(),
                System.Globalization.CultureInfo.InvariantCulture,
                System.Globalization.DateTimeStyles.AssumeUniversal | System.Globalization.DateTimeStyles.AdjustToUniversal,
                out result))
        {
            result = DateTime.SpecifyKind(result, DateTimeKind.Utc);  // belt-and-suspenders for Npgsql timestamptz
            return true;
        }
        return false;
    }

    /// <summary>The app's display timezone, mirroring UsageQueries (UTC fallback on a bad/blank id).</summary>
    private static Task<TimeZoneInfo> DisplayTzAsync(UsageDbContext db, CancellationToken ct)
        // Single source of truth — shared with the 75 Hard feature (HardChallengeEndpoints).
        => Services.TrackerVisibility.DisplayTzAsync(db, ct);

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
        IsRecent = false,
    };

    /// <summary>Dedup key for the recent-foods merge: normalized description + brand (case-insensitive).</summary>
    private static string RecentKey(string? description, string? brand) =>
        $"{(description ?? "").Trim()}{(brand ?? "").Trim()}";

    /// <summary>
    /// Project a logged <see cref="FoodEntry"/> into a read-only "recent" CustomFoodDto for the My-foods
    /// list. Macros are de-scaled to PER-UNIT (entry total ÷ quantity) so re-picking it scales cleanly the
    /// same way a saved food does; Id = 0 marks it as not-a-saved-row (no delete).
    /// </summary>
    private static CustomFoodDto ToRecentFoodDto(FoodEntry f)
    {
        var qty = f.Quantity > 0 ? f.Quantity : 1;
        return new CustomFoodDto
        {
            Id = 0,
            Description = f.Description,
            Brand = string.IsNullOrEmpty(f.Brand) ? null : f.Brand,
            ServingDesc = PerUnitServingDesc(f.ServingDesc, qty) is { Length: > 0 } s ? s : null,
            Calories = (int)Math.Round(f.Calories / qty, MidpointRounding.AwayFromZero),
            ProteinG = Math.Round(f.ProteinG / qty, 1),
            CarbG = Math.Round(f.CarbG / qty, 1),
            FatG = Math.Round(f.FatG / qty, 1),
            UseCount = 0,
            IsRecent = true,
        };
    }

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
        CoffeeGoalCups = p.CoffeeGoalCups,
        StepGoal = p.StepGoal,
        WeeklyRateKg = p.WeeklyRateKg,
        BodyFatPct = p.BodyFatPct,
        NeckCm = p.NeckCm,
        WaistCm = p.WaistCm,
        HipCm = p.HipCm,
        DietPattern = p.DietPattern.ToString(),
        Restrictions = p.Restrictions,
        TrainingType = p.TrainingType.ToString(),
        ProteinBasis = p.ProteinBasis.ToString(),
        LifeStage = p.LifeStage.ToString(),
        Trimester = p.Trimester,
        MealsPerDay = p.MealsPerDay,
        EatingWindow = p.EatingWindow.ToString(),
        GoalBasisWeightKg = p.GoalBasisWeightKg,
        BaselineReviewedUtc = p.BaselineReviewedUtc?.ToString("o", System.Globalization.CultureInfo.InvariantCulture),
    };

    private static TrackerGoalPlanDto ToGoalPlanDto(GoalPlan p) => new()
    {
        EffectiveFrom = p.EffectiveFrom.ToString("yyyy-MM-dd"),
        Goal = p.Goal.ToString(),
        WeeklyRateKg = p.WeeklyRateKg,
        DailyCalorieGoal = p.DailyCalorieGoal,
        ProteinGoalG = p.ProteinGoalG,
        CarbGoalG = p.CarbGoalG,
        FatGoalG = p.FatGoalG,
        WeightKg = p.WeightKg,
        BodyFatPct = p.BodyFatPct,
        ActivityLevel = p.ActivityLevel.ToString(),
        DietPattern = p.DietPattern.ToString(),
        CreatedUtc = p.CreatedUtc.ToString("o", System.Globalization.CultureInfo.InvariantCulture),
    };

    private static HydrationEntryDto ToHydrationDto(HydrationEntry h) => new()
    {
        Id = h.Id,
        AmountMl = h.AmountMl,
        Label = h.Label,
        CreatedUtc = h.CreatedUtc.ToString("o", System.Globalization.CultureInfo.InvariantCulture),
    };

    private static CoffeeEntryDto ToCoffeeDto(CoffeeEntry c) => new()
    {
        Id = c.Id,
        Cups = c.Cups,
        CaffeineMg = c.CaffeineMg,
        Label = c.Label,
        CreatedUtc = c.CreatedUtc.ToString("o", System.Globalization.CultureInfo.InvariantCulture),
    };

    private static SupplementEntryDto ToSupplementDto(SupplementEntry s) => new()
    {
        Id = s.Id,
        Name = s.Name,
        Dose = s.Dose,
        Kind = s.Kind.ToString().ToLowerInvariant(),
        Calories = s.Calories,
        ProteinG = (double)s.ProteinG,
        CarbG = (double)s.CarbG,
        FatG = (double)s.FatG,
        CreatedUtc = s.CreatedUtc.ToString("o", System.Globalization.CultureInfo.InvariantCulture),
    };

    private static SleepEntryDto ToSleepDto(SleepEntry s) => new()
    {
        Id = s.Id,
        Hours = (double)s.Hours,
        Quality = s.Quality,
        BedTime = s.BedTime?.ToString("HH:mm", System.Globalization.CultureInfo.InvariantCulture),
        WakeTime = s.WakeTime?.ToString("HH:mm", System.Globalization.CultureInfo.InvariantCulture),
        Note = s.Note,
        CreatedUtc = s.CreatedUtc.ToString("o", System.Globalization.CultureInfo.InvariantCulture),
    };

    private static WatchActivityDto ToActivityDto(DailyActivity a) => new()
    {
        Steps = a.Steps,
        DistanceMeters = a.DistanceMeters,
        ActiveCalories = a.ActiveCalories,
        CalorieMode = a.CalorieMode.ToString().ToLowerInvariant(),
    };

    /// <summary>Parse the watch calorie mode ("add" | "override", case-insensitive).</summary>
    private static bool TryParseCalorieMode(string? value, out ActivityCalorieMode mode) =>
        Enum.TryParse((value ?? "").Trim(), ignoreCase: true, out mode) && Enum.IsDefined(mode);

    /// <summary>True when a nullable int is null (not supplied) or within [min, max] inclusive.</summary>
    private static bool InRange(int? value, int min, int max) => value is not { } v || (v >= min && v <= max);

    private static bool TryParseMeal(string? value, out MealType meal) =>
        Enum.TryParse((value ?? "").Trim(), ignoreCase: true, out meal)
        && Enum.IsDefined(meal);

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
        // Single source of truth — shared with the 75 Hard feature (HardChallengeEndpoints).
        Services.TrackerVisibility.IsUniqueViolation(ex);
}
