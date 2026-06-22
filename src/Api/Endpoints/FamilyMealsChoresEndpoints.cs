using Ccusage.Api.Auth;
using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Ccusage.Api.Dtos;
using Ccusage.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;

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
    /// <summary>Upper bound on caller-supplied mealIds for /meals/to-grocery (mirrors GeminiService's
    /// MaxPlanWeekMeals/MaxChoresForAi caps): keeps a hostile payload from fanning out to an unbounded query.</summary>
    private const int MaxMealIds = 200;

    // ---- DTOs (people by userId + name; never email) ----

    public sealed record MealDto(
        long Id, string LocalDate, string Slot, string Title, string Ingredients,
        int CreatedByUserId, string CreatedByName,
        // Macros (Slice 2): the dish TOTALS + servings + their source, plus a DERIVED per-serving block
        // (total / max(Servings, 1)) the frontend can use directly for rollups + "add to my tracker".
        int Servings, int Calories, double ProteinG, double CarbG, double FatG, string MacroSource,
        MacroPerServingDto PerServing);

    /// <summary>The DERIVED per-serving macros for a meal: the dish total divided by max(Servings, 1), rounded
    /// (calories to a whole number, macros to 1 dp). One person's portion — what the planner rollups show and
    /// what "add to my tracker" logs. Never stored; always computed from the totals.</summary>
    public sealed record MacroPerServingDto(int Calories, double ProteinG, double CarbG, double FatG);

    /// <summary>One day of the weekly plan: its local date + the meals planned on it.</summary>
    public sealed record MealDayDto(string LocalDate, IReadOnlyList<MealDto> Meals);

    /// <summary>Create/update a meal. The four macro TOTALS + <see cref="Servings"/> + <see cref="MacroSource"/>
    /// are optional (Slice 2): a manual macro edit, or confirming an AI/DB proposal. On create they default to a
    /// macro-less meal (MacroSource "none"). All are clamped + household-scoped.</summary>
    public sealed record MealUpsertRequest(
        string? LocalDate, string? Slot, string? Title, string? Ingredients,
        int? Servings, int? Calories, double? ProteinG, double? CarbG, double? FatG, string? MacroSource);

    /// <summary>An AI/DB macro PROPOSAL for a meal (Slice 2): the dish TOTALS + a suggested/kept servings count +
    /// a derived per-serving block + an optional note. NOT saved — the frontend confirms then PATCHes the meal.
    /// The DB-refine variant adds <see cref="Matched"/>/<see cref="Unmatched"/> ingredient lines.</summary>
    public sealed record MealMacroProposalDto(
        int Calories, double ProteinG, double CarbG, double FatG, int Servings,
        MacroPerServingDto PerServing, string? Note,
        IReadOnlyList<string>? Matched, IReadOnlyList<string>? Unmatched);
    public sealed record ToGroceryRequest(string? WeekStart, IReadOnlyList<long>? MealIds, long? ListId);

    // ---- AI-assist DTOs (plan our week / from a recipe) ----

    /// <summary>"Plan our week" request: the week to plan (<see cref="WeekStart"/> = its Monday, YYYY-MM-DD;
    /// defaults to the current household week), optional free-text <see cref="Constraints"/> (kid-friendly /
    /// budget / allergies), and <see cref="FillSlots"/> ("emptyDinners" = only empty dinner slots, the default;
    /// "allDinners" = all 7). The SERVER computes the target dinner dates + reads the household's recent meal
    /// titles; neither is trusted from the client. Nothing is created — the frontend reviews then POSTs each
    /// proposed meal to /meals.</summary>
    public sealed record PlanWeekAiRequest(string? WeekStart, string? Constraints, string? FillSlots);

    /// <summary>One proposed meal from "Plan our week", in the same shape the frontend POSTs to /meals.</summary>
    public sealed record PlanWeekMealDto(string LocalDate, string Slot, string Title, string Ingredients);

    /// <summary>"Plan our week" response: 0+ proposed meals (each on a requested slot date) + an optional note.</summary>
    public sealed record PlanWeekAiDto(IReadOnlyList<PlanWeekMealDto> Meals, string? Notes);

    /// <summary>"From a recipe" request: the already-extracted recipe <see cref="Text"/> (the server NEVER
    /// fetches a URL — the client passes recipe TEXT only, so there's no SSRF surface).</summary>
    public sealed record RecipeAiRequest(string? Text);

    /// <summary>"From a recipe" response: a parsed meal (title + newline-joined ingredients) + an optional note,
    /// for the editor to PREFILL. Saves nothing.</summary>
    public sealed record RecipeAiDto(string Title, string Ingredients, string? Notes);

    /// <summary>"What can I make" request: the on-hand <see cref="Ingredients"/> (free text) + optional free-text
    /// <see cref="Constraints"/> (kid-friendly / vegetarian / quick). Nothing is created — creating a meal still
    /// goes through the existing POST /meals on confirm (the editor is prefilled from a chosen idea).</summary>
    public sealed record WhatCanIMakeAiRequest(string? Ingredients, string? Constraints);

    /// <summary>One dinner idea from "What can I make": a title, the ingredient lines it uses, and the few small
    /// items still missing.</summary>
    public sealed record MealIdeaDto(string Title, string Ingredients, IReadOnlyList<string> Missing);

    /// <summary>"What can I make" response: 0+ dinner ideas to review.</summary>
    public sealed record WhatCanIMakeAiDto(IReadOnlyList<MealIdeaDto> Ideas);

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

    // ---- CHORES AI-assist DTOs (suggest / balance / values / "good job" summary) ----

    /// <summary>"Suggest chores" request: optional children's <see cref="Ages"/> (e.g. [8, 5]) so suggestions
    /// are age-appropriate. The SERVER reads the household's existing chore titles as a "don't duplicate" hint
    /// (never trusted from the client). Creates NOTHING — the frontend reviews then POSTs each to /chores.</summary>
    public sealed record ChoreSuggestAiRequest(IReadOnlyList<int>? Ages);

    /// <summary>One proposed chore from "Suggest chores", in the shape the frontend POSTs to /chores (plus a
    /// short age hint for the review UI).</summary>
    public sealed record ChoreSuggestionDto(string Title, int Points, string Recurrence, string? AgeHint);

    /// <summary>"Suggest chores" response: 0+ proposed age-appropriate chores.</summary>
    public sealed record ChoreSuggestAiDto(IReadOnlyList<ChoreSuggestionDto> Suggestions);

    /// <summary>One proposed assignment from "Balance chores", in the shape the frontend PATCHes to
    /// /chores/{id}. Both ids are already validated server-side (chore belongs to the household; assignee is a
    /// member).</summary>
    public sealed record ChoreAssignmentDto(long ChoreId, int AssignedToUserId, string AssignedToName);

    /// <summary>"Balance chores" response: 0+ validated proposed assignments. Applies nothing.</summary>
    public sealed record ChoreBalanceAiDto(IReadOnlyList<ChoreAssignmentDto> Assignments);

    /// <summary>One proposed point value from "Suggest points", in the shape the frontend PATCHes to
    /// /chores/{id}. The choreId is already validated to belong to the household.</summary>
    public sealed record ChoreValueDto(long ChoreId, int Points);

    /// <summary>"Suggest points" response: 0+ validated proposed point values. Applies nothing.</summary>
    public sealed record ChoreValuesAiDto(IReadOnlyList<ChoreValueDto> Values);

    /// <summary>The "Good job" weekly chore summary: a short warm narrative of the week's chore completions.
    /// <see cref="FellBackToPlain"/> is true when Gemini was unconfigured/errored and the deterministic plain
    /// summary was used instead. NEVER a 503 — the plain text is the guaranteed floor.</summary>
    public sealed record ChoreSummaryAiDto(string Summary, bool FellBackToPlain);

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
            // Optional macros on create (manual entry or a confirmed proposal). Clamped + source-normalised.
            ApplyMacroFields(meal, req);
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
            ApplyMacroFields(meal, req); // macros: a manual edit OR confirming an AI/DB proposal

            await db.SaveChangesAsync(ct);

            var names = await NamesAsync(db, new[] { meal.CreatedByUserId }, ct);
            return Results.Ok(ToMealDto(meal, names));
        });

        // ---- PATCH /meals/{id} : partial update (the macro-save path; same shape as PUT) ----
        // The frontend SAVES macros here: a manual edit OR confirming an AI/DB proposal (Servings + the four
        // dish TOTALS + MacroSource). Also accepts the plain fields (title/date/slot/ingredients) so it is a
        // full partial-update. Everything is clamped + household-scoped (a foreign meal is a 404).
        g.MapPatch("/meals/{id:long}", async (
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
            ApplyMacroFields(meal, req);

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
                // Clamp the caller-supplied set so a hostile payload can't fan out to an unbounded IN (...) query.
                var ids = req.MealIds.Distinct().Take(MaxMealIds).ToList();
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

        // ---- POST /meals/ai/plan-week : Gemini proposes varied dinners for the week's empty (or all) slots ----
        // The SERVER computes the target dinner dates (the empty ones, or all 7 with fillSlots="allDinners") and
        // reads the household's last ~14 days of meal titles as a "don't repeat these" hint — NEVER trusted from
        // the client. Creates NOTHING — the frontend reviews then POSTs each proposed meal to /meals (and can run
        // /meals/to-grocery). Rate-limited (the shared "ai" policy); graceful 503 when Gemini is unavailable.
        g.MapPost("/meals/ai/plan-week", async (
            PlanWeekAiRequest req, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            GeminiService gemini, UsageDbContext db, CancellationToken ct) =>
        {
            if (!gemini.IsConfigured) return AiUnavailable();

            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;

            var start = ParseDate(req?.WeekStart) ?? WeekStartLocal(household);
            var end = start.AddDays(7); // exclusive

            // The week's existing dinners (to find the empty slots) + the recent titles ("don't repeat").
            var existingDinnerDates = (await db.FamilyMeals.AsNoTracking()
                    .Where(m => m.HouseholdId == household.Id && m.Slot == "dinner"
                        && m.LocalDate >= start && m.LocalDate < end)
                    .Select(m => m.LocalDate)
                    .ToListAsync(ct))
                .ToHashSet();

            var allDinners = string.Equals(req?.FillSlots, "allDinners", StringComparison.OrdinalIgnoreCase);
            var slotDates = new List<DateOnly>(7);
            for (var i = 0; i < 7; i++)
            {
                var date = start.AddDays(i);
                if (allDinners || !existingDinnerDates.Contains(date)) slotDates.Add(date);
            }

            // Every dinner is already planned (and they asked only to fill the empties) → nothing to do.
            if (slotDates.Count == 0) return Results.Ok(new PlanWeekAiDto(Array.Empty<PlanWeekMealDto>(), null));

            // The "don't repeat these" hint: the household's last ~14 days of meal titles, server-read.
            var since = start.AddDays(-14);
            var recentTitles = await db.FamilyMeals.AsNoTracking()
                .Where(m => m.HouseholdId == household.Id && m.LocalDate >= since && m.LocalDate < end)
                .OrderByDescending(m => m.LocalDate)
                .Select(m => m.Title)
                .ToListAsync(ct);

            var result = await gemini.PlanWeekAsync(req?.Constraints, slotDates, recentTitles, ct);
            if (result is null) return AiUnavailable();

            var meals = result.Meals
                .Select(m => new PlanWeekMealDto(m.LocalDate.ToString("yyyy-MM-dd"), m.Slot, m.Title, m.Ingredients))
                .ToList();
            return Results.Ok(new PlanWeekAiDto(meals, result.Notes));
        }).RequireRateLimiting(AiEndpoints.RateLimitPolicy);

        // ---- POST /meals/ai/from-recipe : Gemini parses pasted recipe TEXT into a meal for the editor ----
        // The server NEVER fetches a URL — the client passes already-extracted recipe TEXT only (no SSRF).
        // Returns the parsed meal (title + ingredients) for the editor to PREFILL; saves nothing. Rate-limited;
        // 400 on empty text; graceful 503 when Gemini is unavailable.
        g.MapPost("/meals/ai/from-recipe", async (
            RecipeAiRequest req, GeminiService gemini, CancellationToken ct) =>
        {
            if (string.IsNullOrWhiteSpace(req?.Text))
                return Results.BadRequest(new { message = "Paste the recipe text you'd like to turn into a meal." });
            if (!gemini.IsConfigured) return AiUnavailable();

            var result = await gemini.RecipeToMealAsync(req.Text, ct);
            if (result is null) return AiUnavailable();

            return Results.Ok(new RecipeAiDto(result.Title, result.Ingredients, result.Notes));
        }).RequireRateLimiting(AiEndpoints.RateLimitPolicy);

        // ---- POST /meals/ai/what-can-i-make : Gemini proposes dinners from on-hand ingredients (round 2) ----
        // Returns dinner ideas to review (title + ingredients + small missing items); creating a meal still goes
        // through the existing POST /meals on confirm (the editor is prefilled). Saves NOTHING. Rate-limited;
        // 400 on empty ingredients; graceful 503 when Gemini is unavailable.
        g.MapPost("/meals/ai/what-can-i-make", async (
            WhatCanIMakeAiRequest req, GeminiService gemini, CancellationToken ct) =>
        {
            if (string.IsNullOrWhiteSpace(req?.Ingredients))
                return Results.BadRequest(new { message = "List a few ingredients you have on hand." });
            if (!gemini.IsConfigured) return AiUnavailable();

            var result = await gemini.WhatCanIMakeAsync(req.Ingredients, req.Constraints, ct);
            if (result is null) return AiUnavailable();

            var ideas = result.Ideas
                .Select(i => new MealIdeaDto(i.Title, i.Ingredients, i.Missing))
                .ToList();
            return Results.Ok(new WhatCanIMakeAiDto(ideas));
        }).RequireRateLimiting(AiEndpoints.RateLimitPolicy);

        MapMealMacros(g);
    }

    // =====================================================================================
    // MEAL MACROS (Slice 2) — AI estimate + DB refine, both household-scoped PROPOSALS
    // =====================================================================================
    // Family-AI pattern: gated by family.use (the group filter) + rate-limited (the shared "ai" policy),
    // household-scoped (a foreign meal is a 404 — existence never leaked), graceful 503 (never 500) when the
    // provider is unconfigured/errors, and they APPLY NOTHING — each returns a PROPOSAL (dish TOTALS + a
    // derived per-serving block) the frontend reviews then SAVES via the meal PATCH. No email anywhere.

    /// <summary>Loose ingredient line parse: an optional leading quantity (e.g. "2", "1.5", "1/2") then the
    /// rest as the food NAME to look up. The quantity scales the looked-up food's macros; a unit token is
    /// ignored (USDA's first hit already carries a per-serving/per-100g basis we can't reconcile precisely).</summary>
    private static readonly System.Text.RegularExpressions.Regex QtyPrefix =
        new(@"^\s*(?<qty>\d+(?:\.\d+)?|\d+\s*/\s*\d+)?\s*(?<rest>.*)$",
            System.Text.RegularExpressions.RegexOptions.Compiled);

    private static void MapMealMacros(RouteGroupBuilder g)
    {
        // ---- POST /meals/{id}/ai/macros : Gemini estimates the dish TOTAL macros + suggested servings ----
        // Household-scoped (foreign meal → 404). Returns a PROPOSAL (does NOT save) — the frontend confirms then
        // PATCHes the meal. Rate-limited; graceful 503 when Gemini is unavailable.
        g.MapPost("/meals/{id:long}/ai/macros", async (
            long id, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            GeminiService gemini, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;

            // Resolve the meal FIRST (household-scoped) so a foreign/missing meal is a 404 even when AI is off —
            // existence is never leaked through a 503.
            var meal = await db.FamilyMeals.AsNoTracking().FirstOrDefaultAsync(m => m.Id == id, ct);
            if (meal is null || meal.HouseholdId != household.Id) return NotFound();

            if (!gemini.IsConfigured) return AiUnavailable();

            var result = await gemini.EstimateMealMacrosAsync(meal.Title, meal.Ingredients, ct);
            if (result is null) return AiUnavailable();

            return Results.Ok(new MealMacroProposalDto(
                Calories: result.Calories,
                ProteinG: result.ProteinG,
                CarbG: result.CarbG,
                FatG: result.FatG,
                Servings: result.Servings,
                PerServing: PerServing(result.Calories, result.ProteinG, result.CarbG, result.FatG, result.Servings),
                Note: result.Note,
                Matched: null,
                Unmatched: null));
        }).RequireRateLimiting(AiEndpoints.RateLimitPolicy);

        // ---- POST /meals/{id}/macros/refine : sum per-ingredient USDA lookups into dish TOTALS ----
        // Household-scoped (foreign meal → 404). Parses the meal's ingredient lines (loose "qty unit name"),
        // looks each NAME up via USDA (first hit), and SUMS into dish totals; returns matched + unmatched lines.
        // A PROPOSAL (does NOT save). Graceful 503 when USDA is unavailable/unconfigured.
        g.MapPost("/meals/{id:long}/macros/refine", async (
            long id, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            UsdaFoodService usda, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;

            var meal = await db.FamilyMeals.AsNoTracking().FirstOrDefaultAsync(m => m.Id == id, ct);
            if (meal is null || meal.HouseholdId != household.Id) return NotFound();

            if (!usda.IsConfigured) return AiUnavailable();

            var lines = SplitIngredients(meal.Ingredients).Take(MaxMealIds).ToList();
            double cal = 0, protein = 0, carb = 0, fat = 0;
            var matched = new List<string>();
            var unmatched = new List<string>();

            foreach (var line in lines)
            {
                var (qty, name) = ParseIngredientLine(line);
                if (name.Length == 0) { unmatched.Add(Clamp(line, 200)); continue; }

                IReadOnlyList<FoodSearchItemDto> hits;
                try
                {
                    hits = await usda.SearchAsync(name, null, ct);
                }
                catch (UsdaNotConfiguredException)
                {
                    return AiUnavailable(); // provider went away mid-loop — degrade gracefully (never 500)
                }

                var hit = hits.Count > 0 ? hits[0] : null;
                if (hit is null) { unmatched.Add(Clamp(line, 200)); continue; }

                cal += hit.Calories * qty;
                protein += hit.ProteinG * qty;
                carb += hit.CarbG * qty;
                fat += hit.FatG * qty;
                matched.Add(Clamp(line, 200));
            }

            var calT = ClampMealCalories((int)Math.Round(cal, MidpointRounding.AwayFromZero));
            var proteinT = ClampMealMacro(protein);
            var carbT = ClampMealMacro(carb);
            var fatT = ClampMealMacro(fat);
            var servings = ClampServings(meal.Servings); // keep the meal's existing servings (>=1)

            return Results.Ok(new MealMacroProposalDto(
                Calories: calT,
                ProteinG: proteinT,
                CarbG: carbT,
                FatG: fatT,
                Servings: servings,
                PerServing: PerServing(calT, proteinT, carbT, fatT, servings),
                Note: null,
                Matched: matched,
                Unmatched: unmatched));
        }).RequireRateLimiting(AiEndpoints.RateLimitPolicy);
    }

    /// <summary>Loosely parse an ingredient line into a (quantity multiplier, food name). A leading whole/decimal/
    /// fraction quantity scales the looked-up macros (default 1.0 when absent); the remaining text is the name to
    /// search. A bare leading unit token (cup/tbsp/g/oz…) is dropped so the name lookup is cleaner.</summary>
    private static (double Qty, string Name) ParseIngredientLine(string line)
    {
        var m = QtyPrefix.Match(line.Trim());
        var qty = 1.0;
        if (m.Groups["qty"].Success && m.Groups["qty"].Value.Length > 0)
        {
            var raw = m.Groups["qty"].Value;
            if (raw.Contains('/'))
            {
                var parts = raw.Split('/');
                if (parts.Length == 2
                    && double.TryParse(parts[0].Trim(), System.Globalization.NumberStyles.Float,
                        System.Globalization.CultureInfo.InvariantCulture, out var num)
                    && double.TryParse(parts[1].Trim(), System.Globalization.NumberStyles.Float,
                        System.Globalization.CultureInfo.InvariantCulture, out var den)
                    && den != 0)
                    qty = num / den;
            }
            else if (double.TryParse(raw, System.Globalization.NumberStyles.Float,
                System.Globalization.CultureInfo.InvariantCulture, out var n))
                qty = n;
        }
        if (qty <= 0 || double.IsNaN(qty) || double.IsInfinity(qty)) qty = 1.0;

        var rest = m.Groups["rest"].Value.Trim();
        // Drop a single leading unit token so the search term is the food, not the measure.
        var firstSpace = rest.IndexOf(' ');
        if (firstSpace > 0)
        {
            var token = rest[..firstSpace].ToLowerInvariant();
            if (Units.Contains(token)) rest = rest[(firstSpace + 1)..].Trim();
        }
        return (qty, Clamp(rest, 120));
    }

    private static readonly HashSet<string> Units = new(StringComparer.OrdinalIgnoreCase)
    {
        "cup", "cups", "tbsp", "tablespoon", "tablespoons", "tsp", "teaspoon", "teaspoons",
        "g", "gram", "grams", "kg", "oz", "ounce", "ounces", "lb", "lbs", "pound", "pounds",
        "ml", "l", "liter", "litre", "liters", "litres", "pinch", "dash", "clove", "cloves",
        "can", "cans", "slice", "slices", "stick", "sticks", "pkg", "package", "packages",
    };

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

        MapChoresAi(g);
    }

    // =====================================================================================
    // CHORES AI-assist — suggest / balance / values / "good job" summary
    // =====================================================================================
    // Family-AI pattern: gated by family.use (the group filter) + rate-limited (the shared "ai" policy),
    // graceful 503 (never 500) when Gemini is unconfigured/errors, and they APPLY NOTHING — each returns
    // proposals the frontend reviews then writes via the existing POST/PATCH /chores. The "good job" summary
    // is the one exception that ALWAYS returns 200 (a deterministic plain summary is the floor when AI is off).

    private static void MapChoresAi(RouteGroupBuilder g)
    {
        // ---- POST /chores/ai/suggest : Gemini proposes age-appropriate chores (creates nothing) ----
        // The SERVER reads the household's existing chore titles as a "don't duplicate" hint — NEVER trusted
        // from the client. Optional ages in the body tailor difficulty. Rate-limited; graceful 503 when Gemini
        // is unavailable. The frontend reviews then POSTs each proposed chore to /chores.
        g.MapPost("/chores/ai/suggest", async (
            ChoreSuggestAiRequest? req, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            GeminiService gemini, UsageDbContext db, CancellationToken ct) =>
        {
            if (!gemini.IsConfigured) return AiUnavailable();

            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;

            // The "don't duplicate these" hint: the household's existing chore titles, server-read.
            var existingTitles = await db.FamilyChores.AsNoTracking()
                .Where(c => c.HouseholdId == household.Id)
                .Select(c => c.Title)
                .ToListAsync(ct);

            var ages = (req?.Ages ?? Array.Empty<int>()).Where(a => a is >= 0 and <= 120).ToList();

            var result = await gemini.SuggestChoresAsync(ages, existingTitles, ct);
            if (result is null) return AiUnavailable();

            var suggestions = result.Suggestions
                .Select(s => new ChoreSuggestionDto(s.Title, s.Points, s.Recurrence, s.AgeHint))
                .ToList();
            return Results.Ok(new ChoreSuggestAiDto(suggestions));
        }).RequireRateLimiting(AiEndpoints.RateLimitPolicy);

        // ---- POST /chores/ai/balance : Gemini fairly auto-assigns the household's chores (applies nothing) ----
        // Passes the household's current chores + members + the per-member points tally so it balances FAIRLY.
        // VALIDATES every returned id server-side: a foreign choreId or a non-member assignee is dropped (a
        // hostile/hallucinated id can never assign a chore to an outsider). Rate-limited; graceful 503. The
        // frontend reviews then PATCHes each /chores/{id}.
        g.MapPost("/chores/ai/balance", async (
            CurrentUserAccessor me, CurrentHouseholdAccessor households,
            GeminiService gemini, UsageDbContext db, CancellationToken ct) =>
        {
            if (!gemini.IsConfigured) return AiUnavailable();

            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;

            var chores = await db.FamilyChores.AsNoTracking()
                .Where(c => c.HouseholdId == household.Id)
                .Select(c => new { c.Id, c.Title })
                .ToListAsync(ct);
            if (chores.Count == 0) return Results.Ok(new ChoreBalanceAiDto(Array.Empty<ChoreAssignmentDto>()));

            var members = await HouseholdMembersAsync(db, household.Id, ct);
            if (members.Count == 0) return Results.Ok(new ChoreBalanceAiDto(Array.Empty<ChoreAssignmentDto>()));

            var tally = await ChoreTallyAsync(db, household.Id, ct);

            var result = await gemini.BalanceChoresAsync(
                chores.Select(c => (c.Id, c.Title)).ToList(),
                members.Select(m => (m.UserId, m.Name)).ToList(),
                tally, ct);
            if (result is null) return AiUnavailable();

            // VALIDATE: keep only assignments whose chore is in THIS household and whose assignee is a member.
            var householdChoreIds = chores.Select(c => c.Id).ToHashSet();
            var memberById = members.ToDictionary(m => m.UserId, m => m.Name);

            var assignments = new List<ChoreAssignmentDto>();
            var seenChores = new HashSet<long>();
            foreach (var a in result.Assignments)
            {
                if (!householdChoreIds.Contains(a.ChoreId)) continue;       // foreign/hallucinated chore — drop
                if (!memberById.TryGetValue(a.AssignedToUserId, out var name)) continue; // non-member — drop
                if (!seenChores.Add(a.ChoreId)) continue;                   // one assignment per chore
                assignments.Add(new ChoreAssignmentDto(a.ChoreId, a.AssignedToUserId, name));
            }

            return Results.Ok(new ChoreBalanceAiDto(assignments));
        }).RequireRateLimiting(AiEndpoints.RateLimitPolicy);

        // ---- POST /chores/ai/values : Gemini proposes fair point values for the household's chores ----
        // DROPS any returned choreId that isn't in the household; applies nothing (historical ledger snapshots
        // are never touched — a PATCH only changes the chore's CURRENT points). Rate-limited; graceful 503.
        g.MapPost("/chores/ai/values", async (
            CurrentUserAccessor me, CurrentHouseholdAccessor households,
            GeminiService gemini, UsageDbContext db, CancellationToken ct) =>
        {
            if (!gemini.IsConfigured) return AiUnavailable();

            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;

            var chores = await db.FamilyChores.AsNoTracking()
                .Where(c => c.HouseholdId == household.Id)
                .Select(c => new { c.Id, c.Title })
                .ToListAsync(ct);
            if (chores.Count == 0) return Results.Ok(new ChoreValuesAiDto(Array.Empty<ChoreValueDto>()));

            var result = await gemini.SuggestPointsAsync(chores.Select(c => (c.Id, c.Title)).ToList(), ct);
            if (result is null) return AiUnavailable();

            // DROP any value whose choreId isn't in THIS household (foreign/hallucinated), one per chore.
            var householdChoreIds = chores.Select(c => c.Id).ToHashSet();
            var values = new List<ChoreValueDto>();
            var seen = new HashSet<long>();
            foreach (var v in result.Values)
            {
                if (!householdChoreIds.Contains(v.ChoreId)) continue;
                if (!seen.Add(v.ChoreId)) continue;
                values.Add(new ChoreValueDto(v.ChoreId, v.Points));
            }

            return Results.Ok(new ChoreValuesAiDto(values));
        }).RequireRateLimiting(AiEndpoints.RateLimitPolicy);

        // ---- GET /chores/ai/summary : a warm "good job" weekly read-only narrative (NEVER 503/500) ----
        // Built off the server FamilyChoreCompletion ledger (names + counts + points — the model invents
        // nothing). ALWAYS 200: when Gemini is unconfigured/errors, the GUARANTEED deterministic plain summary
        // is returned with fellBackToPlain=true. CACHED per (household, ISO week). No email. Rate-limited.
        g.MapGet("/chores/ai/summary", async (
            CurrentUserAccessor me, CurrentHouseholdAccessor households,
            GeminiService gemini, IMemoryCache cache, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;

            // The week window in the household's local timezone (Mon..Sun), in UTC for the ledger query.
            var tz = FamilyTodayService.ResolveTimeZone(household.TimeZone);
            var weekStartLocal = WeekStartLocal(household);
            var isoWeekKey = weekStartLocal.ToString("yyyy-MM-dd");
            var startUtc = TimeZoneInfo.ConvertTimeToUtc(
                weekStartLocal.ToDateTime(TimeOnly.MinValue, DateTimeKind.Unspecified), tz);
            var endUtc = TimeZoneInfo.ConvertTimeToUtc(
                weekStartLocal.AddDays(7).ToDateTime(TimeOnly.MinValue, DateTimeKind.Unspecified), tz);

            // Build the deterministic ledger facts (names + per-member counts/points) for THIS household's week.
            var (facts, plain, hasAny) = await BuildChoreWeekFactsAsync(db, household.Id, startUtc, endUtc, ct);

            // Plain summary is the floor. Prefer the warm AI narrative when configured (cached per ISO week).
            if (!gemini.IsConfigured || !hasAny)
                return Results.Ok(new ChoreSummaryAiDto(plain, true));

            var cacheKey = $"family:chore-summary:{household.Id}:{isoWeekKey}";
            if (cache.TryGetValue(cacheKey, out string? cached) && !string.IsNullOrWhiteSpace(cached))
                return Results.Ok(new ChoreSummaryAiDto(cached!, false));

            string narrative;
            try
            {
                narrative = await gemini.ChoreSummaryAsync(facts, ct) ?? "";
            }
            catch
            {
                narrative = "";
            }
            if (string.IsNullOrWhiteSpace(narrative))
                return Results.Ok(new ChoreSummaryAiDto(plain, true)); // AI hiccup → guaranteed plain floor

            cache.Set(cacheKey, narrative, TimeSpan.FromHours(6));
            return Results.Ok(new ChoreSummaryAiDto(narrative, false));
        }).RequireRateLimiting(AiEndpoints.RateLimitPolicy);
    }

    /// <summary>The household's members (AppUser id + display name; never email), capped for AI calls.</summary>
    private static async Task<List<(int UserId, string Name)>> HouseholdMembersAsync(
        UsageDbContext db, int householdId, CancellationToken ct)
    {
        var ids = await db.HouseholdMembers.AsNoTracking()
            .Where(m => m.HouseholdId == householdId)
            .Select(m => m.UserId)
            .ToListAsync(ct);
        var names = await NamesAsync(db, ids, ct);
        return ids.Select(id => (id, Name(names, id))).ToList();
    }

    /// <summary>The per-member all-time points tally for a household (sum of the completion ledger).</summary>
    private static async Task<List<(int UserId, int Points)>> ChoreTallyAsync(
        UsageDbContext db, int householdId, CancellationToken ct)
    {
        var choreIds = await db.FamilyChores.AsNoTracking()
            .Where(c => c.HouseholdId == householdId)
            .Select(c => c.Id)
            .ToListAsync(ct);
        if (choreIds.Count == 0) return new List<(int, int)>();
        return (await db.FamilyChoreCompletions.AsNoTracking()
                .Where(c => choreIds.Contains(c.ChoreId))
                .GroupBy(c => c.ByUserId)
                .Select(grp => new { grp.Key, Points = grp.Sum(x => x.Points) })
                .ToListAsync(ct))
            .Select(x => (x.Key, x.Points)).ToList();
    }

    /// <summary>
    /// Build the deterministic "good job" facts for a household's week from the FamilyChoreCompletion ledger
    /// (names + per-member completion counts + points earned THIS WEEK). Returns the compact facts string the
    /// model narrates, a guaranteed plain-text summary (the floor when AI is off), and whether there was any
    /// completion at all this week. Names only — no email is ever read or surfaced.
    /// </summary>
    private static async Task<(string Facts, string Plain, bool HasAny)> BuildChoreWeekFactsAsync(
        UsageDbContext db, int householdId, DateTime startUtc, DateTime endUtc, CancellationToken ct)
    {
        var choreIds = await db.FamilyChores.AsNoTracking()
            .Where(c => c.HouseholdId == householdId)
            .Select(c => c.Id)
            .ToListAsync(ct);

        var rows = choreIds.Count == 0
            ? new List<(int ByUserId, int Count, int Points)>()
            : (await db.FamilyChoreCompletions.AsNoTracking()
                .Where(c => choreIds.Contains(c.ChoreId) && c.AtUtc >= startUtc && c.AtUtc < endUtc)
                .GroupBy(c => c.ByUserId)
                .Select(grp => new { grp.Key, Count = grp.Count(), Points = grp.Sum(x => x.Points) })
                .ToListAsync(ct))
                .Select(x => (ByUserId: x.Key, x.Count, x.Points)).ToList();

        if (rows.Count == 0)
            return ("", "No chores were checked off this week yet — a fresh week to earn some stars!", false);

        var names = await NamesAsync(db, rows.Select(r => r.ByUserId), ct);
        var ordered = rows
            .OrderByDescending(r => r.Points).ThenByDescending(r => r.Count)
            .ThenBy(r => Name(names, r.ByUserId), StringComparer.OrdinalIgnoreCase)
            .ToList();

        var totalChores = ordered.Sum(r => r.Count);
        var totalPoints = ordered.Sum(r => r.Points);

        var sb = new System.Text.StringBuilder();
        sb.Append("WEEK_TOTALS: ").Append(totalChores).Append(" chores, ")
          .Append(totalPoints).Append(" stars\n");
        sb.Append("PER_MEMBER:\n");
        foreach (var r in ordered)
            sb.Append("- ").Append(Name(names, r.ByUserId)).Append(": ")
              .Append(r.Count).Append(' ').Append(r.Count == 1 ? "chore" : "chores").Append(", ")
              .Append(r.Points).Append(' ').Append(r.Points == 1 ? "star" : "stars").Append('\n');

        // Deterministic plain floor: "This week: 7 chores done (15 stars). Leo did 4 (8), Mia did 3 (7)."
        var parts = ordered
            .Select(r => $"{Name(names, r.ByUserId)} did {r.Count} ({r.Points})")
            .ToList();
        var plain =
            $"This week: {totalChores} {(totalChores == 1 ? "chore" : "chores")} done " +
            $"({totalPoints} {(totalPoints == 1 ? "star" : "stars")}). " +
            string.Join(", ", parts) + ". Great job!";
        if (plain.Length > 512) plain = plain[..512];

        return (sb.ToString(), plain, true);
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
            m.CreatedByUserId, Name(names, m.CreatedByUserId),
            m.Servings, m.Calories, m.ProteinG, m.CarbG, m.FatG, m.MacroSource,
            PerServing(m.Calories, m.ProteinG, m.CarbG, m.FatG, m.Servings));

    // ---- Macros (Slice 2): clamp bounds + per-serving derivation ----
    // Mirror GeminiService's dish-TOTAL ceilings so a manual edit or a confirmed proposal lands in the same
    // sane range (a whole family dish legitimately totals more than a single logged food).
    private const int MaxMealTotalCalories = 20000;
    private const double MaxMealTotalMacroG = 2000;
    private const int MaxMealServings = 50;
    private static readonly string[] MacroSources = { "none", "ai", "database", "manual" };

    /// <summary>The DERIVED per-serving block: the dish total over max(servings, 1), calories rounded to a whole
    /// number and macros to 1 dp. One person's portion — shown by the rollups + logged by "add to my tracker".</summary>
    private static MacroPerServingDto PerServing(int calories, double proteinG, double carbG, double fatG, int servings)
    {
        var s = Math.Max(servings, 1);
        return new MacroPerServingDto(
            (int)Math.Round((double)calories / s, MidpointRounding.AwayFromZero),
            Math.Round(proteinG / s, 1),
            Math.Round(carbG / s, 1),
            Math.Round(fatG / s, 1));
    }

    private static int ClampMealCalories(int v) => Math.Clamp(v, 0, MaxMealTotalCalories);
    private static double ClampMealMacro(double v) =>
        double.IsNaN(v) || double.IsInfinity(v) || v < 0 ? 0 : Math.Round(Math.Min(v, MaxMealTotalMacroG), 1);
    private static int ClampServings(int v) => Math.Clamp(v, 1, MaxMealServings);

    /// <summary>Normalise a macro source to the vocabulary none|ai|database|manual; unknown/blank -> "none".</summary>
    private static string NormalizeMacroSource(string? s)
    {
        var v = (s ?? "").Trim().ToLowerInvariant();
        return MacroSources.Contains(v) ? v : "none";
    }

    /// <summary>Apply the OPTIONAL macro fields of an upsert onto a meal: each absent field is left as-is, and
    /// each present field is clamped (totals 0..20000 cal / 0..2000 g, servings 1..50, source normalised). The
    /// per-serving block is always derived from the totals on read — never stored.</summary>
    private static void ApplyMacroFields(FamilyMeal meal, MealUpsertRequest req)
    {
        if (req.Servings is int servings) meal.Servings = ClampServings(servings);
        if (req.Calories is int calories) meal.Calories = ClampMealCalories(calories);
        if (req.ProteinG is double proteinG) meal.ProteinG = ClampMealMacro(proteinG);
        if (req.CarbG is double carbG) meal.CarbG = ClampMealMacro(carbG);
        if (req.FatG is double fatG) meal.FatG = ClampMealMacro(fatG);
        if (req.MacroSource is not null) meal.MacroSource = NormalizeMacroSource(req.MacroSource);
    }

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

    /// <summary>503 (never 500) when an AI-assist call can't run — Gemini unconfigured or the call failed. One
    /// consistent degraded path the frontend shows as "AI isn't available right now; do it manually".</summary>
    private static IResult AiUnavailable() => Results.Problem(
        title: "AI assistance is not available.",
        detail: "AI assistance is not available right now. You can do this manually.",
        statusCode: StatusCodes.Status503ServiceUnavailable);
}
