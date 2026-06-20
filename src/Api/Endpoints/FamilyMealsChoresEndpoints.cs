using Ccusage.Api.Auth;
using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Ccusage.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Ccusage.Api.Endpoints;

/// <summary>
/// Family Hub F4 — the weekly MEAL PLANNER and the CHORES board (/api/family/meals, /api/family/chores).
/// Everything is gated by <see cref="Permissions.FamilyUse"/> on top of <c>.RequireAuthorization()</c> and
/// obeys the Family Hub privacy rules:
///
/// <list type="bullet">
///   <item>Items are private to the owning HOUSEHOLD; every member can see and manage them. A caller only
///   ever addresses their OWN household — a cross-household id is a 404 (existence is never leaked).</item>
///   <item>People are exposed by AppUser id + display name ONLY — an email is NEVER put on the wire.</item>
/// </list>
///
/// MEALS hang a dish on a (local date, slot). The "auto grocery list" tie-in
/// (POST /meals/to-grocery) collects the chosen meals' ingredient lines and appends them as items to a
/// shopping <see cref="FamilyList"/> — reusing the F1 list model (find-or-create the household's
/// "Groceries" shopping list) and returning the F1 ListDto.
///
/// CHORES are a shared board with an optional assignee, a points value, and an optional recurrence. Marking
/// a chore done stamps who/when and appends ONE <see cref="FamilyChoreCompletion"/> to the points ledger
/// (re-marking an already-done chore does not double-log); un-doing clears the stamps but keeps the ledger
/// intact. The per-member points tally sums the ledger. The recurring RESET (a done daily/weekly chore
/// reappearing when its period rolls over) lives in the background <see cref="FamilyReminderService"/> tick.
/// </summary>
public static class FamilyMealsChoresEndpoints
{
    // ---- DTOs (people by userId + name; never email) ----

    public sealed record MealDto(
        long Id, string LocalDate, string Slot, string Title, string Ingredients,
        int CreatedByUserId, string CreatedByName);

    /// <summary>One day of the weekly plan: its local date + the meals planned on it.</summary>
    public sealed record MealDayDto(string LocalDate, IReadOnlyList<MealDto> Meals);

    public sealed record MealUpsertRequest(string? LocalDate, string? Slot, string? Title, string? Ingredients);
    public sealed record ToGroceryRequest(string? WeekStart, IReadOnlyList<long>? MealIds, long? ListId);

    public sealed record ChoreDto(
        long Id, string Title,
        int? AssignedToUserId, string? AssignedToName,
        bool Done, int? DoneByUserId, string? DoneByName, DateTime? DoneUtc,
        int Points, string Recurrence);

    /// <summary>A member's all-time points tally (sum of their completion ledger).</summary>
    public sealed record TallyEntryDto(int UserId, string Name, int Points);

    public sealed record ChoresDto(IReadOnlyList<ChoreDto> Chores, IReadOnlyList<TallyEntryDto> Tally);

    public sealed record ChoreCreateRequest(string? Title, int? AssignedToUserId, int? Points, string? Recurrence);
    public sealed record ChorePatchRequest(
        string? Title, int? AssignedToUserId, int? Points, string? Recurrence, bool? Done);

    private static readonly string[] Slots = { "breakfast", "lunch", "dinner", "snack" };
    private static readonly string[] Recurrences = { "none", "daily", "weekly" };

    public static void MapFamilyMealsChoresEndpoints(this WebApplication app)
    {
        var g = app.MapGroup("/api/family")
            .RequireAuthorization()
            .RequirePermission(Permissions.FamilyUse);

        MapMeals(g);
        MapChores(g);
    }

    // =====================================================================================
    // MEALS — the weekly plan
    // =====================================================================================

    private static void MapMeals(RouteGroupBuilder g)
    {
        // ---- GET /meals?weekStart=YYYY-MM-DD : 7 local days from weekStart, each with its meals ----
        g.MapGet("/meals", async (
            string? weekStart, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;

            var start = ParseDate(weekStart) ?? WeekStartLocal(household);
            var end = start.AddDays(7); // exclusive

            var meals = await db.FamilyMeals.AsNoTracking()
                .Where(m => m.HouseholdId == household.Id && m.LocalDate >= start && m.LocalDate < end)
                .ToListAsync(ct);

            var names = await NamesAsync(db, meals.Select(m => m.CreatedByUserId), ct);
            var byDate = meals.GroupBy(m => m.LocalDate).ToDictionary(grp => grp.Key, grp => grp.ToList());

            var days = new List<MealDayDto>(7);
            for (var i = 0; i < 7; i++)
            {
                var date = start.AddDays(i);
                var dayMeals = (byDate.GetValueOrDefault(date) ?? new())
                    .OrderBy(m => SlotOrder(m.Slot)).ThenBy(m => m.Id)
                    .Select(m => ToMealDto(m, names))
                    .ToList();
                days.Add(new MealDayDto(date.ToString("o"), dayMeals));
            }
            return Results.Ok(days);
        });

        // ---- POST /meals ----
        g.MapPost("/meals", async (
            MealUpsertRequest req, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;

            var title = (req.Title ?? "").Trim();
            if (string.IsNullOrEmpty(title)) return Results.BadRequest(new { message = "A meal title is required." });
            if (ParseDate(req.LocalDate) is not DateOnly date)
                return Results.BadRequest(new { message = "A valid localDate (YYYY-MM-DD) is required." });

            var meal = new FamilyMeal
            {
                HouseholdId = household.Id,
                LocalDate = date,
                Slot = NormalizeSlot(req.Slot),
                Title = Clamp(title, 200),
                Ingredients = ClampIngredients(req.Ingredients),
                CreatedByUserId = caller.Id,
                CreatedUtc = DateTime.UtcNow,
            };
            db.FamilyMeals.Add(meal);
            await db.SaveChangesAsync(ct);

            var names = await NamesAsync(db, new[] { meal.CreatedByUserId }, ct);
            return Results.Ok(ToMealDto(meal, names));
        });

        // ---- PUT /meals/{id} ----
        g.MapPut("/meals/{id:long}", async (
            long id, MealUpsertRequest req, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;

            var meal = await db.FamilyMeals.FirstOrDefaultAsync(m => m.Id == id, ct);
            if (meal is null || meal.HouseholdId != household.Id) return NotFound();

            if (req.Title is not null)
            {
                var title = req.Title.Trim();
                if (string.IsNullOrEmpty(title)) return Results.BadRequest(new { message = "A meal title is required." });
                meal.Title = Clamp(title, 200);
            }
            if (req.LocalDate is not null)
            {
                if (ParseDate(req.LocalDate) is not DateOnly date)
                    return Results.BadRequest(new { message = "A valid localDate (YYYY-MM-DD) is required." });
                meal.LocalDate = date;
            }
            if (req.Slot is not null) meal.Slot = NormalizeSlot(req.Slot);
            if (req.Ingredients is not null) meal.Ingredients = ClampIngredients(req.Ingredients);

            await db.SaveChangesAsync(ct);

            var names = await NamesAsync(db, new[] { meal.CreatedByUserId }, ct);
            return Results.Ok(ToMealDto(meal, names));
        });

        // ---- DELETE /meals/{id} ----
        g.MapDelete("/meals/{id:long}", async (
            long id, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;

            var meal = await db.FamilyMeals.FirstOrDefaultAsync(m => m.Id == id, ct);
            if (meal is null || meal.HouseholdId != household.Id) return NotFound();

            db.FamilyMeals.Remove(meal);
            await db.SaveChangesAsync(ct);
            return Results.NoContent();
        });

        // ---- POST /meals/to-grocery : append the chosen meals' ingredients to a shopping list ----
        g.MapPost("/meals/to-grocery", async (
            ToGroceryRequest req, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;

            // Choose the source meals: an explicit set of mealIds (household-scoped), else a whole week.
            List<FamilyMeal> meals;
            if (req.MealIds is { Count: > 0 })
            {
                var ids = req.MealIds.Distinct().ToList();
                meals = await db.FamilyMeals.AsNoTracking()
                    .Where(m => m.HouseholdId == household.Id && ids.Contains(m.Id))
                    .ToListAsync(ct);
            }
            else
            {
                var start = ParseDate(req.WeekStart) ?? WeekStartLocal(household);
                var end = start.AddDays(7);
                meals = await db.FamilyMeals.AsNoTracking()
                    .Where(m => m.HouseholdId == household.Id && m.LocalDate >= start && m.LocalDate < end)
                    .ToListAsync(ct);
            }

            // Resolve the destination shopping list: a given (editable) list, else find-or-create "Groceries".
            FamilyList list;
            if (req.ListId is long listId)
            {
                var target = await db.FamilyLists.FirstOrDefaultAsync(l => l.Id == listId, ct);
                // Editable-by-caller = a list in the caller's household (members manage their lists). A
                // missing or cross-household list is a 404 (existence is never leaked).
                if (target is null || target.HouseholdId != household.Id) return NotFound();
                list = target;
            }
            else
            {
                list = await FindOrCreateGroceriesAsync(db, household.Id, caller.Id, ct);
            }

            // Collect ingredient lines from the chosen meals, in meal order; skip blanks.
            var lines = meals
                .OrderBy(m => m.LocalDate).ThenBy(m => SlotOrder(m.Slot)).ThenBy(m => m.Id)
                .SelectMany(m => SplitIngredients(m.Ingredients))
                .ToList();

            // Avoid obvious duplicates: skip a line that case-insensitively matches an OPEN item already on
            // the list, and de-dup within this batch too.
            var existingOpen = await db.FamilyListItems.AsNoTracking()
                .Where(i => i.ListId == list.Id && !i.Done)
                .Select(i => i.Text)
                .ToListAsync(ct);
            var seen = new HashSet<string>(existingOpen.Select(Normalize), StringComparer.Ordinal);

            var maxSort = await db.FamilyListItems.Where(i => i.ListId == list.Id)
                .Select(i => (int?)i.SortOrder).MaxAsync(ct) ?? -1;

            var now = DateTime.UtcNow;
            var added = 0;
            foreach (var raw in lines)
            {
                var text = Clamp(raw, 500);
                if (text.Length == 0) continue;
                if (!seen.Add(Normalize(text))) continue; // already on the list (or earlier in this batch)
                db.FamilyListItems.Add(new FamilyListItem
                {
                    ListId = list.Id,
                    Text = text,
                    SortOrder = ++maxSort,
                    CreatedUtc = now,
                });
                added++;
            }

            if (added > 0)
            {
                await db.FamilyLists.Where(l => l.Id == list.Id)
                    .ExecuteUpdateAsync(s => s.SetProperty(l => l.UpdatedUtc, now), ct);
                await db.SaveChangesAsync(ct);
            }

            // Return the updated list in the F1 ListDto shape (members manage their lists, so canEdit/isMine
            // reflect a household member).
            return Results.Ok(await FamilyNotesListsEndpoints.LoadListDtoAsync(db, list.Id, caller.Id, household.Id, ct));
        });
    }

    // =====================================================================================
    // CHORES — the shared board + the points ledger/tally
    // =====================================================================================

    private static void MapChores(RouteGroupBuilder g)
    {
        // ---- GET /chores : the household's chores (open first) + the all-time points tally ----
        g.MapGet("/chores", async (
            CurrentUserAccessor me, CurrentHouseholdAccessor households, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;

            var chores = await db.FamilyChores.AsNoTracking()
                .Where(c => c.HouseholdId == household.Id)
                .ToListAsync(ct);

            return Results.Ok(await BuildChoresDtoAsync(db, household.Id, chores, ct));
        });

        // ---- POST /chores ----
        g.MapPost("/chores", async (
            ChoreCreateRequest req, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;

            var title = (req.Title ?? "").Trim();
            if (string.IsNullOrEmpty(title)) return Results.BadRequest(new { message = "A chore title is required." });
            if (!TryNormalizeRecurrence(req.Recurrence, out var recurrence))
                return Results.BadRequest(new { message = "Recurrence must be none, daily, or weekly." });

            int? assignee = null;
            if (req.AssignedToUserId is int aId)
            {
                if (!await IsHouseholdMemberAsync(db, household.Id, aId, ct))
                    return Results.BadRequest(new { message = "The chore assignee must be a member of your family." });
                assignee = aId;
            }

            var chore = new FamilyChore
            {
                HouseholdId = household.Id,
                Title = Clamp(title, 200),
                AssignedToUserId = assignee,
                Done = false,
                Points = NormalizePoints(req.Points),
                Recurrence = recurrence,
                CreatedByUserId = caller.Id,
                CreatedUtc = DateTime.UtcNow,
            };
            db.FamilyChores.Add(chore);
            await db.SaveChangesAsync(ct);

            return Results.Ok(await BuildChoresDtoAsync(db, household.Id, null, ct));
        });

        // ---- PATCH /chores/{id} ----
        g.MapPatch("/chores/{id:long}", async (
            long id, ChorePatchRequest req, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;

            var chore = await db.FamilyChores.FirstOrDefaultAsync(c => c.Id == id, ct);
            if (chore is null || chore.HouseholdId != household.Id) return NotFound();

            if (req.Title is not null)
            {
                var title = req.Title.Trim();
                if (string.IsNullOrEmpty(title)) return Results.BadRequest(new { message = "A chore title is required." });
                chore.Title = Clamp(title, 200);
            }
            if (req.AssignedToUserId is int aId)
            {
                if (!await IsHouseholdMemberAsync(db, household.Id, aId, ct))
                    return Results.BadRequest(new { message = "The chore assignee must be a member of your family." });
                chore.AssignedToUserId = aId;
            }
            if (req.Points is not null) chore.Points = NormalizePoints(req.Points);
            if (req.Recurrence is not null)
            {
                if (!TryNormalizeRecurrence(req.Recurrence, out var recurrence))
                    return Results.BadRequest(new { message = "Recurrence must be none, daily, or weekly." });
                chore.Recurrence = recurrence;
            }
            if (req.Done is bool done)
            {
                if (done && !chore.Done)
                {
                    // Transition not-done → done: stamp the caller + append ONE completion to the ledger.
                    chore.Done = true;
                    chore.DoneByUserId = caller.Id;
                    chore.DoneUtc = DateTime.UtcNow;
                    db.FamilyChoreCompletions.Add(new FamilyChoreCompletion
                    {
                        ChoreId = chore.Id,
                        ByUserId = caller.Id,
                        AtUtc = chore.DoneUtc.Value,
                        Points = chore.Points,
                    });
                }
                else if (!done && chore.Done)
                {
                    // Transition done → not-done: clear the stamps, but LEAVE the ledger intact.
                    chore.Done = false;
                    chore.DoneByUserId = null;
                    chore.DoneUtc = null;
                }
                // done:true on an already-done chore (or done:false on a not-done one) is a no-op — never
                // double-logs and never clears a fresh stamp.
            }

            await db.SaveChangesAsync(ct);
            return Results.Ok(await BuildChoresDtoAsync(db, household.Id, null, ct));
        });

        // ---- DELETE /chores/{id} ----
        g.MapDelete("/chores/{id:long}", async (
            long id, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;

            var chore = await db.FamilyChores.FirstOrDefaultAsync(c => c.Id == id, ct);
            if (chore is null || chore.HouseholdId != household.Id) return NotFound();

            db.FamilyChores.Remove(chore); // completions cascade
            await db.SaveChangesAsync(ct);
            return Results.NoContent();
        });
    }

    // =====================================================================================
    // CHORES — DTO assembly (chores ordered open-first; per-member tally from the ledger)
    // =====================================================================================

    /// <summary>
    /// Build the chores response for a household: chores (open first, by assignee/title, then done) + the
    /// per-member all-time points tally (sum of <see cref="FamilyChoreCompletion.Points"/> per member; note:
    /// all-time for now, could be windowed later). Pass <paramref name="preloaded"/> chores to avoid a
    /// re-read, or null to load them here.
    /// </summary>
    private static async Task<ChoresDto> BuildChoresDtoAsync(
        UsageDbContext db, int householdId, List<FamilyChore>? preloaded, CancellationToken ct)
    {
        var chores = preloaded ?? await db.FamilyChores.AsNoTracking()
            .Where(c => c.HouseholdId == householdId)
            .ToListAsync(ct);

        // The tally sums the ledger per member, but only for THIS household's chores.
        var choreIds = await db.FamilyChores.AsNoTracking()
            .Where(c => c.HouseholdId == householdId)
            .Select(c => c.Id)
            .ToListAsync(ct);
        var tallyRows = choreIds.Count == 0
            ? new List<(int ByUserId, int Points)>()
            : (await db.FamilyChoreCompletions.AsNoTracking()
                .Where(c => choreIds.Contains(c.ChoreId))
                .GroupBy(c => c.ByUserId)
                .Select(grp => new { ByUserId = grp.Key, Points = grp.Sum(x => x.Points) })
                .ToListAsync(ct))
                .Select(x => (x.ByUserId, x.Points)).ToList();

        var personIds = chores.Where(c => c.AssignedToUserId is not null).Select(c => c.AssignedToUserId!.Value)
            .Concat(chores.Where(c => c.DoneByUserId is not null).Select(c => c.DoneByUserId!.Value))
            .Concat(tallyRows.Select(t => t.ByUserId));
        var names = await NamesAsync(db, personIds, ct);

        var ordered = chores
            // Open first, then done; within a group, by assignee (unassigned last), then title.
            .OrderBy(c => c.Done ? 1 : 0)
            .ThenBy(c => c.AssignedToUserId is null ? 1 : 0)
            .ThenBy(c => c.AssignedToUserId ?? 0)
            .ThenBy(c => c.Title, StringComparer.OrdinalIgnoreCase)
            .ThenBy(c => c.Id)
            .Select(c => ToChoreDto(c, names))
            .ToList();

        var tally = tallyRows
            .OrderByDescending(t => t.Points).ThenBy(t => Name(names, t.ByUserId), StringComparer.OrdinalIgnoreCase)
            .Select(t => new TallyEntryDto(t.ByUserId, Name(names, t.ByUserId), t.Points))
            .ToList();

        return new ChoresDto(ordered, tally);
    }

    // =====================================================================================
    // GROCERY-LIST TIE-IN (find-or-create the household's "Groceries" shopping list)
    // =====================================================================================

    private const string GroceriesName = "Groceries";

    /// <summary>
    /// Find the household's existing "Groceries" shopping list, or create one. Prefers an existing shopping
    /// list named "Groceries" (case-insensitive), else any shopping list, else creates "Groceries".
    /// </summary>
    private static async Task<FamilyList> FindOrCreateGroceriesAsync(
        UsageDbContext db, int householdId, int callerId, CancellationToken ct)
    {
        // Reuse the household's "Groceries" list if it exists; otherwise make one. Don't dump ingredients
        // into an arbitrary unrelated shopping list (e.g. "Costco run") just because it's the first one.
        var existing = await db.FamilyLists
            .Where(l => l.HouseholdId == householdId && l.Kind == "shopping"
                && l.Name.ToLower() == GroceriesName.ToLower())
            .FirstOrDefaultAsync(ct);
        if (existing is not null) return existing;

        var now = DateTime.UtcNow;
        var list = new FamilyList
        {
            HouseholdId = householdId,
            CreatedByUserId = callerId,
            Name = GroceriesName,
            Kind = "shopping",
            CreatedUtc = now,
            UpdatedUtc = now,
        };
        db.FamilyLists.Add(list);
        await db.SaveChangesAsync(ct);
        return list;
    }

    /// <summary>Split a meal's newline-separated ingredients into trimmed, non-blank lines.</summary>
    private static IEnumerable<string> SplitIngredients(string? ingredients) =>
        (ingredients ?? "")
            .Split('\n')
            .Select(s => s.Trim())
            .Where(s => s.Length > 0);

    // =====================================================================================
    // HELPERS
    // =====================================================================================

    private static MealDto ToMealDto(FamilyMeal m, Dictionary<int, string> names) =>
        new(m.Id, m.LocalDate.ToString("o"), m.Slot, m.Title, m.Ingredients,
            m.CreatedByUserId, Name(names, m.CreatedByUserId));

    private static ChoreDto ToChoreDto(FamilyChore c, Dictionary<int, string> names) =>
        new(c.Id, c.Title,
            c.AssignedToUserId, c.AssignedToUserId is int a ? Name(names, a) : null,
            c.Done, c.DoneByUserId, c.DoneByUserId is int d ? Name(names, d) : null, c.DoneUtc,
            c.Points, c.Recurrence);

    private static string NormalizeSlot(string? slot)
    {
        var s = (slot ?? "").Trim().ToLowerInvariant();
        return Slots.Contains(s) ? s : "dinner";
    }

    private static int SlotOrder(string slot) => slot switch
    {
        "breakfast" => 0,
        "lunch" => 1,
        "dinner" => 2,
        "snack" => 3,
        _ => 4,
    };

    private static bool TryNormalizeRecurrence(string? raw, out string recurrence)
    {
        recurrence = string.IsNullOrWhiteSpace(raw) ? "none" : raw.Trim().ToLowerInvariant();
        return Recurrences.Contains(recurrence);
    }

    private static int NormalizePoints(int? points)
    {
        var p = points ?? 1;
        if (p < 0) p = 0;
        if (p > 1000) p = 1000;
        return p;
    }

    /// <summary>Parse a plain "YYYY-MM-DD" date; null/blank/invalid → null.</summary>
    private static DateOnly? ParseDate(string? s) =>
        DateOnly.TryParse(s, System.Globalization.CultureInfo.InvariantCulture,
            System.Globalization.DateTimeStyles.None, out var d) ? d : null;

    /// <summary>The current week's start (Monday) in the household's local timezone.</summary>
    private static DateOnly WeekStartLocal(Household household)
    {
        var tz = FamilyTodayService.ResolveTimeZone(household.TimeZone);
        var localNow = TimeZoneInfo.ConvertTimeFromUtc(DateTime.UtcNow, tz);
        var today = DateOnly.FromDateTime(localNow);
        // ISO week start = Monday. DayOfWeek: Sunday=0..Saturday=6; map to Mon=0..Sun=6.
        var offset = ((int)today.DayOfWeek + 6) % 7;
        return today.AddDays(-offset);
    }

    private static async Task<bool> IsHouseholdMemberAsync(
        UsageDbContext db, int householdId, int userId, CancellationToken ct) =>
        await db.HouseholdMembers.AsNoTracking()
            .AnyAsync(m => m.HouseholdId == householdId && m.UserId == userId, ct);

    /// <summary>Resolve a set of userIds to display names (email is never read). Missing → "Unknown user".</summary>
    private static async Task<Dictionary<int, string>> NamesAsync(
        UsageDbContext db, IEnumerable<int> userIds, CancellationToken ct)
    {
        var ids = userIds.Distinct().ToList();
        if (ids.Count == 0) return new Dictionary<int, string>();
        return await db.Users.AsNoTracking()
            .Where(u => ids.Contains(u.Id))
            .ToDictionaryAsync(
                u => u.Id,
                u => string.IsNullOrEmpty(u.Name) ? "Unknown user" : u.Name, ct);
    }

    private static string Name(Dictionary<int, string> names, int userId) =>
        names.TryGetValue(userId, out var n) ? n : "Unknown user";

    private static string Clamp(string? s, int max)
    {
        s = (s ?? "").Trim();
        return s.Length > max ? s[..max] : s;
    }

    /// <summary>Trim + cap the ingredients blob (kept as raw newline-separated text).</summary>
    private static string ClampIngredients(string? s)
    {
        s = (s ?? "").Replace("\r\n", "\n").Replace('\r', '\n').Trim();
        return s.Length > 4000 ? s[..4000] : s;
    }

    /// <summary>Case/space-insensitive key for de-duping grocery lines.</summary>
    private static string Normalize(string s) => s.Trim().ToLowerInvariant();

    private static IResult NotFound() =>
        Results.NotFound(new { message = "That item doesn't exist." });
}
