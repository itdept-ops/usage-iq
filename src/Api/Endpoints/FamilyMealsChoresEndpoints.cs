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

    // ---- Recipe breakdown DTOs (recipe idea → structured breakdown; add-to-grocery) ----

    /// <summary>"Recipe breakdown" request: a recipe IDEA — a dish name (e.g. "chicken alfredo") OR a pasted
    /// recipe. The server NEVER fetches a URL (the client passes recipe TEXT only, so there's no SSRF surface).</summary>
    public sealed record RecipeBreakdownAiRequest(string? Text);

    /// <summary>One ingredient in a breakdown: the food <see cref="Name"/> + a free-text <see cref="Quantity"/>
    /// ("2", "1 cup", "" when none).</summary>
    public sealed record RecipeIngredientDto(string Name, string Quantity);

    /// <summary>The per-serving macros of a breakdown.</summary>
    public sealed record RecipeMacrosDto(int Calories, double Protein, double Carb, double Fat);

    /// <summary>"Recipe breakdown" response: the structured recipe — title, servings, ingredients ({name,
    /// quantity}), per-serving macros, and optional steps. A PROPOSAL only — the frontend then adds the
    /// ingredients to the grocery list (POST /meals/recipe-breakdown/to-grocery) and/or saves it as a planned
    /// meal (POST /meals). Saves nothing.</summary>
    public sealed record RecipeBreakdownAiDto(
        string Title, int Servings, IReadOnlyList<RecipeIngredientDto> Ingredients,
        RecipeMacrosDto MacrosPerServing, IReadOnlyList<string>? Steps);

    /// <summary>"Add breakdown ingredients to grocery list" request: the ingredient NAMEs to append (from a
    /// breakdown the frontend just showed), and an optional destination <see cref="ListId"/> (else the
    /// household's "Groceries" list is found-or-created). Lines are de-duped against the list's OPEN items.</summary>
    public sealed record RecipeIngredientsToGroceryRequest(IReadOnlyList<string>? Items, long? ListId);

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
        int Points, string Recurrence,
        // Marketplace + allowance fields.
        decimal CreditValue, string Source, string Status,
        int? ClaimedByUserId, string? ClaimedByName, DateTime? ClaimedUtc,
        int? ApprovedByUserId, DateTime? ApprovedUtc);

    /// <summary>A member's all-time points tally (sum of their completion ledger).</summary>
    public sealed record TallyEntryDto(int UserId, string Name, int Points);

    /// <summary>The caller's chore board. <see cref="Role"/> is the caller's household role
    /// ("owner"|"adult"|"child") so the frontend can render the parent vs kid view; <see cref="CanManage"/>
    /// is true for an owner/adult (the parent capabilities). For a CHILD caller the chores are rescoped to
    /// pool (open) + their own claimed/assigned chores, and the tally is omitted (kids see their balance,
    /// not the whole household points tally).</summary>
    public sealed record ChoresDto(
        IReadOnlyList<ChoreDto> Chores, IReadOnlyList<TallyEntryDto> Tally, string Role, bool CanManage);

    public sealed record ChoreCreateRequest(
        string? Title, int? AssignedToUserId, int? Points, string? Recurrence,
        string? Source, decimal? CreditValue);
    public sealed record ChorePatchRequest(
        string? Title, int? AssignedToUserId, int? Points, string? Recurrence, bool? Done,
        string? Source, decimal? CreditValue);

    /// <summary>Reject a submitted chore (parent): an optional note for the kid.</summary>
    public sealed record ChoreRejectRequest(string? Note);

    // ---- Allowance DTOs (the credit ledger / balance) ----

    /// <summary>One ledger row as seen on the wire (people by id; never email).</summary>
    public sealed record CreditEntryDto(
        long Id, string Kind, decimal Amount, string? Category, long? ChoreCompletionId, string? Note,
        int CreatedByUserId, DateTime CreatedUtc);

    /// <summary>A child's allowance: their derived balance + their own ledger rows (kid-safe — only theirs).</summary>
    public sealed record AllowanceMeDto(int ChildUserId, decimal Balance, IReadOnlyList<CreditEntryDto> Ledger);

    /// <summary>One child's balance card for the parent manager (id + display name only; never email).</summary>
    public sealed record ChildBalanceDto(int ChildUserId, string Name, decimal Balance);

    /// <summary>The parent allowance manager: every household child's balance + recent ledger across them.</summary>
    public sealed record AllowanceDto(
        IReadOnlyList<ChildBalanceDto> Children, IReadOnlyList<CreditEntryDto> Recent);

    /// <summary>Record a spend/payout/adjust against a child's balance (parent). Amount is the MAGNITUDE
    /// (always positive in the body); the server signs it (− for spend/payout, ± for adjust per
    /// <see cref="Sign"/>).</summary>
    public sealed record AllowanceMoveRequest(decimal? Amount, string? Category, string? Note, int? Sign);

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
    private static readonly string[] ChoreSources = { "assigned", "pool" };
    /// <summary>The allowed spend categories (a small fixed enum; free-text note alongside).</summary>
    private static readonly string[] SpendCategories =
        { "toys", "games", "books", "clothes", "treats", "savings", "other" };
    /// <summary>Max magnitude for one credit move (a sane upper bound for an allowance row).</summary>
    private const decimal MaxCreditAmount = 100000m;

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

            // Append the (de-duped, non-blank) lines to the resolved list — the shared add path.
            await AppendLinesToListAsync(db, list.Id, lines, ct);

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

            // Food-safety: a shared family dinner must ALWAYS honour every member's STANDING allergies/avoids,
            // not just the free-text box. Load the UNION of all household members' saved tracker restrictions
            // (TrackerProfile is keyed by lower-cased UserEmail; HouseholdMembers references the AppUser id).
            var memberEmails = await db.HouseholdMembers.AsNoTracking()
                .Where(hm => hm.HouseholdId == household.Id)
                .Join(db.Users.AsNoTracking(), hm => hm.UserId, u => u.Id, (hm, u) => u.Email)
                .ToListAsync(ct);
            var restrictionParts = await db.TrackerProfiles.AsNoTracking()
                .Where(p => memberEmails.Contains(p.UserEmail) && p.Restrictions != null && p.Restrictions != "")
                .Select(p => p.Restrictions!)
                .ToListAsync(ct);
            var householdRestrictions = MergeRestrictions(restrictionParts);

            var result = await gemini.PlanWeekAsync(req?.Constraints, slotDates, recentTitles, householdRestrictions, ct);
            if (result is null) return AiUnavailable();

            var meals = result.Meals
                .Select(m => new PlanWeekMealDto(m.LocalDate.ToString("yyyy-MM-dd"), m.Slot, m.Title, m.Ingredients))
                .ToList();
            return Results.Ok(new PlanWeekAiDto(meals, result.Notes));
        }).RequirePermission(Permissions.FamilyAi).RequireRateLimiting(AiEndpoints.RateLimitPolicy);

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
        }).RequirePermission(Permissions.FamilyAi).RequireRateLimiting(AiEndpoints.RateLimitPolicy);

        // ---- POST /meals/ai/what-can-i-make : Gemini proposes dinners from on-hand ingredients (round 2) ----
        // Returns dinner ideas to review (title + ingredients + small missing items); creating a meal still goes
        // through the existing POST /meals on confirm (the editor is prefilled). Saves NOTHING. Rate-limited;
        // 400 on empty ingredients; graceful 503 when Gemini is unavailable.
        g.MapPost("/meals/ai/what-can-i-make", async (
            WhatCanIMakeAiRequest req, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            GeminiService gemini, UsageDbContext db, CancellationToken ct) =>
        {
            if (string.IsNullOrWhiteSpace(req?.Ingredients))
                return Results.BadRequest(new { message = "List a few ingredients you have on hand." });
            if (!gemini.IsConfigured) return AiUnavailable();

            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;

            // Food-safety: the same shared-meal allergy union the week planner enforces — every household
            // member's STANDING tracker restrictions, not just the free-text constraints box.
            var memberEmails = await db.HouseholdMembers.AsNoTracking()
                .Where(hm => hm.HouseholdId == household.Id)
                .Join(db.Users.AsNoTracking(), hm => hm.UserId, u => u.Id, (hm, u) => u.Email)
                .ToListAsync(ct);
            var restrictionParts = await db.TrackerProfiles.AsNoTracking()
                .Where(p => memberEmails.Contains(p.UserEmail) && p.Restrictions != null && p.Restrictions != "")
                .Select(p => p.Restrictions!)
                .ToListAsync(ct);
            var householdRestrictions = MergeRestrictions(restrictionParts);

            var result = await gemini.WhatCanIMakeAsync(req.Ingredients, req.Constraints, householdRestrictions, ct);
            if (result is null) return AiUnavailable();

            var ideas = result.Ideas
                .Select(i => new MealIdeaDto(i.Title, i.Ingredients, i.Missing))
                .ToList();
            return Results.Ok(new WhatCanIMakeAiDto(ideas));
        }).RequirePermission(Permissions.FamilyAi).RequireRateLimiting(AiEndpoints.RateLimitPolicy);

        // ---- POST /meals/recipe-breakdown : Gemini turns a recipe IDEA into a structured breakdown ----
        // The input is a dish NAME ("chicken alfredo") OR a pasted recipe; the server NEVER fetches a URL (the
        // client passes TEXT only — no SSRF). Returns { title, servings, ingredients:[{name,quantity}],
        // macrosPerServing, steps? }. Creates NOTHING — the frontend then adds the ingredients to the grocery
        // list (POST /meals/recipe-breakdown/to-grocery) and/or saves it as a planned meal (POST /meals).
        // Generative → gated family.use (group) + family.ai. Rate-limited; 400 on empty text; graceful 503 when
        // Gemini is unavailable (the frontend steers to manual — never fabricate).
        g.MapPost("/meals/recipe-breakdown", async (
            RecipeBreakdownAiRequest req, GeminiService gemini, CancellationToken ct) =>
        {
            if (string.IsNullOrWhiteSpace(req?.Text))
                return Results.BadRequest(new { message = "Enter a recipe name or paste a recipe to break down." });
            if (!gemini.IsConfigured) return AiUnavailable();

            var result = await gemini.RecipeBreakdownAsync(req.Text, ct);
            if (result is null) return AiUnavailable();

            var ingredients = result.Ingredients
                .Select(i => new RecipeIngredientDto(i.Name, i.Quantity))
                .ToList();
            var macros = new RecipeMacrosDto(
                result.MacrosPerServing.Calories, result.MacrosPerServing.ProteinG,
                result.MacrosPerServing.CarbsG, result.MacrosPerServing.FatG);

            return Results.Ok(new RecipeBreakdownAiDto(
                result.Title, result.Servings, ingredients, macros, result.Steps));
        }).RequirePermission(Permissions.FamilyAi).RequireRateLimiting(AiEndpoints.RateLimitPolicy);

        // ---- POST /meals/recipe-breakdown/to-grocery : append breakdown ingredient NAMEs to a shopping list ----
        // Reuses the EXISTING grocery add path (find-or-create the household "Groceries" list, or an explicit
        // household-scoped list) + the SAME de-dupe-against-open-items helper as /meals/to-grocery. NOT generative
        // (the client passes the already-reviewed ingredient names) → gated only by family.use (group), not
        // family.ai. A foreign/missing destination list is a 404 (existence never leaked).
        g.MapPost("/meals/recipe-breakdown/to-grocery", async (
            RecipeIngredientsToGroceryRequest req, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;

            // Clamp the caller-supplied set so a hostile payload can't fan out unbounded.
            var lines = (req?.Items ?? Array.Empty<string>())
                .Select(s => (s ?? "").Trim())
                .Where(s => s.Length > 0)
                .Take(MaxMealIds)
                .ToList();

            // Resolve the destination shopping list: a given (household-scoped) list, else find-or-create "Groceries".
            FamilyList list;
            if (req?.ListId is long listId)
            {
                var target = await db.FamilyLists.FirstOrDefaultAsync(l => l.Id == listId, ct);
                if (target is null || target.HouseholdId != household.Id) return NotFound();
                list = target;
            }
            else
            {
                list = await FindOrCreateGroceriesAsync(db, household.Id, caller.Id, ct);
            }

            await AppendLinesToListAsync(db, list.Id, lines, ct);

            return Results.Ok(await FamilyNotesListsEndpoints.LoadListDtoAsync(db, list.Id, caller.Id, household.Id, ct));
        });

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
        }).RequirePermission(Permissions.FamilyAi).RequireRateLimiting(AiEndpoints.RateLimitPolicy);

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
        // ---- GET /chores : the household's chores + tally, RESCOPED by the caller's household role ----
        // A PARENT (owner/adult) sees the WHOLE board incl. the submitted-awaiting-approval queue + the
        // points tally. A CHILD caller is filtered SERVER-SIDE to pool (open) chores + their OWN
        // claimed/assigned chores (never another child's chore, never any email), and the tally is omitted.
        g.MapGet("/chores", async (
            CurrentUserAccessor me, CurrentHouseholdAccessor households, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;
            var role = await RoleInHouseholdAsync(db, household.Id, caller.Id, ct);

            var all = await db.FamilyChores.AsNoTracking()
                .Where(c => c.HouseholdId == household.Id)
                .ToListAsync(ct);

            if (IsChild(role))
            {
                // Child sees: open pool chores (claimable) + chores they claimed or are assigned to. Nothing
                // else — never another member's chore, and the tally is dropped (kids see their balance).
                var mine = all.Where(c =>
                        (c.Source == "pool" && c.Status == "open")
                        || c.ClaimedByUserId == caller.Id
                        || c.AssignedToUserId == caller.Id)
                    .ToList();
                var childChores = await BuildChoreListAsync(db, mine, ct);
                return Results.Ok(new ChoresDto(childChores, Array.Empty<TallyEntryDto>(), "child", CanManage: false));
            }

            return Results.Ok(await BuildChoresDtoAsync(db, household.Id, all, role, ct));
        });

        // ---- POST /chores : create (PARENT only — a child cannot create chores) ----
        g.MapPost("/chores", async (
            ChoreCreateRequest req, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;
            var role = await RoleInHouseholdAsync(db, household.Id, caller.Id, ct);
            if (IsChild(role)) return ChildForbidden("Only a parent can create chores.");

            var title = (req.Title ?? "").Trim();
            if (string.IsNullOrEmpty(title)) return Results.BadRequest(new { message = "A chore title is required." });
            if (!TryNormalizeRecurrence(req.Recurrence, out var recurrence))
                return Results.BadRequest(new { message = "Recurrence must be none, daily, or weekly." });
            if (!TryNormalizeSource(req.Source, out var source))
                return Results.BadRequest(new { message = "Source must be assigned or pool." });

            int? assignee = null;
            if (req.AssignedToUserId is int aId)
            {
                if (!await IsHouseholdMemberAsync(db, household.Id, aId, ct))
                    return Results.BadRequest(new { message = "The chore assignee must be a member of your family." });
                assignee = aId;
            }
            // A pool chore is anyone-claimable, so it carries no fixed assignee.
            if (source == "pool") assignee = null;

            var chore = new FamilyChore
            {
                HouseholdId = household.Id,
                Title = Clamp(title, 200),
                AssignedToUserId = assignee,
                Done = false,
                Points = NormalizePoints(req.Points),
                Recurrence = recurrence,
                Source = source,
                Status = "open",
                CreditValue = NormalizeCredit(req.CreditValue),
                CreatedByUserId = caller.Id,
                CreatedUtc = DateTime.UtcNow,
            };
            db.FamilyChores.Add(chore);
            await db.SaveChangesAsync(ct);

            return Results.Ok(await BuildChoresDtoAsync(db, household.Id, null, role, ct));
        });

        // ---- PATCH /chores/{id} : edit / mark done (PARENT only) ----
        // The legacy done flag is kept for backward-compat with the shared board. The marketplace lifecycle
        // (claim/submit/approve/reject) lives on the dedicated endpoints below.
        g.MapPatch("/chores/{id:long}", async (
            long id, ChorePatchRequest req, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;
            var role = await RoleInHouseholdAsync(db, household.Id, caller.Id, ct);
            if (IsChild(role)) return ChildForbidden("Only a parent can edit chores.");

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
            if (req.CreditValue is not null) chore.CreditValue = NormalizeCredit(req.CreditValue);
            if (req.Source is not null)
            {
                if (!TryNormalizeSource(req.Source, out var source))
                    return Results.BadRequest(new { message = "Source must be assigned or pool." });
                chore.Source = source;
            }
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
            return Results.Ok(await BuildChoresDtoAsync(db, household.Id, null, role, ct));
        });

        // ---- DELETE /chores/{id} : (PARENT only) ----
        g.MapDelete("/chores/{id:long}", async (
            long id, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;
            var role = await RoleInHouseholdAsync(db, household.Id, caller.Id, ct);
            if (IsChild(role)) return ChildForbidden("Only a parent can delete chores.");

            var chore = await db.FamilyChores.FirstOrDefaultAsync(c => c.Id == id, ct);
            if (chore is null || chore.HouseholdId != household.Id) return NotFound();

            db.FamilyChores.Remove(chore); // completions cascade; the earn ledger rows SET NULL (money kept)
            await db.SaveChangesAsync(ct);
            return Results.NoContent();
        });

        MapChoreMarketplace(g);
        MapAllowance(g);
        MapChoresAi(g);
    }

    // =====================================================================================
    // CHORE MARKETPLACE — the claim → submit → approve/reject state machine
    // =====================================================================================
    // Lifecycle: a CHILD claims a pool chore (open → claimed) or directly submits an assigned chore; the
    // child SUBMITS a claimed/assigned chore (→ submitted, awaiting a parent); a PARENT APPROVES (→ approved:
    // append ONE FamilyChoreCompletion snapshot + ONE FamilyCreditEntry earn row, awarding credits EXACTLY
    // once) or REJECTS (→ back to open for a pool chore, or claimed for an assigned one). Recurring chores
    // reset to open/unclaimed on approval for the next period. Every endpoint is household-scoped (a foreign
    // chore is a 404) with explicit child-vs-parent gating.

    private static void MapChoreMarketplace(RouteGroupBuilder g)
    {
        // ---- POST /chores/{id}/claim : a CHILD claims an OPEN pool chore ----
        g.MapPost("/chores/{id:long}/claim", async (
            long id, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;
            // A claim is a CHILD action — gated by chore.claim.
            if (!caller.Permissions.Contains(Permissions.ChoreClaim))
                return ChildForbidden("Only a child can claim chores.");
            if (!await IsHouseholdMemberAsync(db, household.Id, caller.Id, ct))
                return ChildForbidden("You aren't a member of this family.");

            var chore = await db.FamilyChores.FirstOrDefaultAsync(c => c.Id == id, ct);
            if (chore is null || chore.HouseholdId != household.Id) return NotFound();
            if (chore.Source != "pool")
                return Results.BadRequest(new { message = "Only marketplace (pool) chores can be claimed." });
            if (chore.Status != "open" || chore.ClaimedByUserId is not null)
                return Conflict("That chore has already been claimed.");

            chore.Status = "claimed";
            chore.ClaimedByUserId = caller.Id;
            chore.ClaimedUtc = DateTime.UtcNow;
            await db.SaveChangesAsync(ct);

            return Results.Ok(await BuildMyChoresDtoAsync(db, household.Id, caller.Id, ct));
        });

        // ---- POST /chores/{id}/submit : the CHILD marks their claimed/assigned chore done (→ submitted) ----
        g.MapPost("/chores/{id:long}/submit", async (
            long id, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;
            if (!caller.Permissions.Contains(Permissions.ChoreClaim))
                return ChildForbidden("Only a child submits a chore for approval.");

            var chore = await db.FamilyChores.FirstOrDefaultAsync(c => c.Id == id, ct);
            if (chore is null || chore.HouseholdId != household.Id) return NotFound();

            // The caller must own this chore (their claim or their assignment) — never someone else's.
            var ownsIt = chore.ClaimedByUserId == caller.Id || chore.AssignedToUserId == caller.Id;
            if (!ownsIt) return ChildForbidden("That isn't your chore.");
            if (chore.Status is not ("open" or "claimed" or "rejected"))
                return Conflict("That chore can't be submitted from its current state.");

            // An assigned chore the child hasn't formally claimed: stamp the claim now so the lifecycle/credit
            // award has a claimant to attribute (the assignee).
            if (chore.ClaimedByUserId is null)
            {
                chore.ClaimedByUserId = caller.Id;
                chore.ClaimedUtc ??= DateTime.UtcNow;
            }
            chore.Status = "submitted";
            await db.SaveChangesAsync(ct);

            return Results.Ok(await BuildMyChoresDtoAsync(db, household.Id, caller.Id, ct));
        });

        // ---- POST /chores/{id}/approve : a PARENT approves → award credits EXACTLY once ----
        g.MapPost("/chores/{id:long}/approve", async (
            long id, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            AuditLogger audit, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;
            var role = await RoleInHouseholdAsync(db, household.Id, caller.Id, ct);
            if (!IsParent(role)) return ChildForbidden("Only a parent can approve chores.");

            var chore = await db.FamilyChores.FirstOrDefaultAsync(c => c.Id == id, ct);
            if (chore is null || chore.HouseholdId != household.Id) return NotFound();
            // Idempotent: re-approving an already-approved chore is a no-op (never double-awards).
            if (chore.Status == "approved")
                return Results.Ok(await BuildChoresDtoAsync(db, household.Id, null, role, ct));
            if (chore.Status != "submitted")
                return Conflict("Only a submitted chore can be approved.");

            var now = DateTime.UtcNow;
            var claimant = chore.ClaimedByUserId ?? chore.AssignedToUserId;
            chore.Status = "approved";
            chore.ApprovedByUserId = caller.Id;
            chore.ApprovedUtc = now;
            // Mark the legacy done flag + stamp for the shared board / "good job" summary continuity.
            chore.Done = true;
            chore.DoneByUserId = claimant;
            chore.DoneUtc = now;

            // Build ONE completion snapshot (chore-history) AND, when a child claimant earns money, ONE earn
            // ledger row (the money-history the balance sums). Credits are awarded EXACTLY once per approval.
            FamilyChoreCompletion? completion = null;
            var awardCredit = false;
            if (claimant is int childId)
            {
                completion = new FamilyChoreCompletion
                {
                    ChoreId = chore.Id,
                    ByUserId = childId,
                    AtUtc = now,
                    Points = chore.Points,
                    Credits = chore.CreditValue,
                };
                db.FamilyChoreCompletions.Add(completion);
                // Only a CHILD member accrues an allowance balance (an adult claimant just gets the points).
                awardCredit = chore.CreditValue > 0 && await IsChildMemberAsync(db, household.Id, childId, ct);
            }

            // Recurring chore: reset the marketplace lifecycle for the next period (the earn ledger is kept).
            if (chore.Recurrence != "none")
            {
                chore.Status = "open";
                chore.ClaimedByUserId = null;
                chore.ClaimedUtc = null;
                chore.ApprovedByUserId = null;
                chore.ApprovedUtc = null;
                // Leave Done=true/DoneUtc=now so the existing background tick resets the done flag next period.
            }

            // Persist atomically: the status change, the completion, AND the earn row commit together or not at
            // all — so a failure can never leave an approved chore WITHOUT its credit award (which the idempotent
            // re-approve guard would then never retry → lost credits). Wrapped in the execution strategy because
            // Npgsql retry-on-failure forbids a bare BeginTransactionAsync.
            var strategy = db.Database.CreateExecutionStrategy();
            await strategy.ExecuteAsync(async () =>
            {
                await using var tx = await db.Database.BeginTransactionAsync(ct);
                await db.SaveChangesAsync(ct); // status + completion (the completion gets its Id here)
                if (awardCredit && completion is not null)
                {
                    db.FamilyCreditEntries.Add(new FamilyCreditEntry
                    {
                        HouseholdId = household.Id,
                        ChildUserId = completion.ByUserId,
                        Kind = "earn",
                        Amount = chore.CreditValue,
                        ChoreCompletionId = completion.Id,
                        Note = chore.Title,
                        CreatedByUserId = completion.ByUserId,
                        CreatedUtc = now,
                    });
                    await db.SaveChangesAsync(ct);
                }
                await tx.CommitAsync(ct);
            });
            await audit.LogAsync("family.chore.approve", targetEmail: null,
                detail: $"chore={chore.Id} credits={chore.CreditValue}", ct: ct);

            return Results.Ok(await BuildChoresDtoAsync(db, household.Id, null, role, ct));
        }).RequirePermission(Permissions.AllowanceManage);

        // ---- POST /chores/{id}/reject : a PARENT sends a submitted chore back (awards nothing) ----
        g.MapPost("/chores/{id:long}/reject", async (
            long id, ChoreRejectRequest? req, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;
            var role = await RoleInHouseholdAsync(db, household.Id, caller.Id, ct);
            if (!IsParent(role)) return ChildForbidden("Only a parent can reject chores.");

            var chore = await db.FamilyChores.FirstOrDefaultAsync(c => c.Id == id, ct);
            if (chore is null || chore.HouseholdId != household.Id) return NotFound();
            if (chore.Status != "submitted")
                return Conflict("Only a submitted chore can be rejected.");

            // Pool chore → back to OPEN + unclaimed (anyone can grab it again). Assigned chore → back to the
            // child to retry (status "rejected", keeping their assignment/claim). Awards nothing.
            if (chore.Source == "pool")
            {
                chore.Status = "open";
                chore.ClaimedByUserId = null;
                chore.ClaimedUtc = null;
            }
            else
            {
                chore.Status = "rejected";
            }
            await db.SaveChangesAsync(ct);

            return Results.Ok(await BuildChoresDtoAsync(db, household.Id, null, role, ct));
        }).RequirePermission(Permissions.AllowanceManage);
    }

    // =====================================================================================
    // ALLOWANCE — the credit ledger / per-child balance (derived = SUM of the child's rows)
    // =====================================================================================

    private static void MapAllowance(RouteGroupBuilder g)
    {
        // ---- GET /allowance/me : a CHILD's OWN balance + ledger (kid-safe; only theirs) ----
        g.MapGet("/allowance/me", async (
            CurrentUserAccessor me, CurrentHouseholdAccessor households, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;
            if (!caller.Permissions.Contains(Permissions.ChoreClaim))
                return ChildForbidden("Only a child has an allowance view.");

            var rows = await db.FamilyCreditEntries.AsNoTracking()
                .Where(e => e.HouseholdId == household.Id && e.ChildUserId == caller.Id)
                .OrderByDescending(e => e.CreatedUtc).ThenByDescending(e => e.Id)
                .ToListAsync(ct);
            var balance = rows.Sum(r => r.Amount);

            return Results.Ok(new AllowanceMeDto(caller.Id, balance, rows.Select(ToCreditDto).ToList()));
        }).RequirePermission(Permissions.ChoreClaim);

        // ---- GET /allowance : the PARENT manager — every household child's balance + recent ledger ----
        g.MapGet("/allowance", async (
            CurrentUserAccessor me, CurrentHouseholdAccessor households, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;

            var childIds = await ChildMemberIdsAsync(db, household.Id, ct);
            var names = await NamesAsync(db, childIds, ct);

            var entries = await db.FamilyCreditEntries.AsNoTracking()
                .Where(e => e.HouseholdId == household.Id)
                .ToListAsync(ct);
            var balanceById = entries.GroupBy(e => e.ChildUserId)
                .ToDictionary(grp => grp.Key, grp => grp.Sum(x => x.Amount));

            var children = childIds
                .Select(cid => new ChildBalanceDto(cid, Name(names, cid), balanceById.GetValueOrDefault(cid)))
                .OrderBy(c => c.Name, StringComparer.OrdinalIgnoreCase)
                .ToList();

            var recent = entries
                .OrderByDescending(e => e.CreatedUtc).ThenByDescending(e => e.Id)
                .Take(100)
                .Select(ToCreditDto)
                .ToList();

            return Results.Ok(new AllowanceDto(children, recent));
        }).RequirePermission(Permissions.AllowanceManage);

        // ---- POST /allowance/{childUserId}/payout : record cash handed over IRL (debits the balance) ----
        g.MapPost("/allowance/{childUserId:int}/payout", async (
            int childUserId, AllowanceMoveRequest req, CurrentUserAccessor me,
            CurrentHouseholdAccessor households, AuditLogger audit, UsageDbContext db, CancellationToken ct) =>
            await RecordMoveAsync(db, audit, me, households, childUserId, req, "payout", ct))
            .RequirePermission(Permissions.AllowanceManage);

        // ---- POST /allowance/{childUserId}/spend : record a purchase against the balance ----
        g.MapPost("/allowance/{childUserId:int}/spend", async (
            int childUserId, AllowanceMoveRequest req, CurrentUserAccessor me,
            CurrentHouseholdAccessor households, AuditLogger audit, UsageDbContext db, CancellationToken ct) =>
            await RecordMoveAsync(db, audit, me, households, childUserId, req, "spend", ct))
            .RequirePermission(Permissions.AllowanceManage);

        // ---- POST /allowance/{childUserId}/adjust : a manual correction (bonus/penalty) ----
        g.MapPost("/allowance/{childUserId:int}/adjust", async (
            int childUserId, AllowanceMoveRequest req, CurrentUserAccessor me,
            CurrentHouseholdAccessor households, AuditLogger audit, UsageDbContext db, CancellationToken ct) =>
            await RecordMoveAsync(db, audit, me, households, childUserId, req, "adjust", ct))
            .RequirePermission(Permissions.AllowanceManage);
    }

    /// <summary>The shared spend/payout/adjust write path (parent, gated allowance.manage). Validates the
    /// target is a CHILD member of the caller's household (a foreign/non-child id is a 404 — existence never
    /// leaked), signs the amount (− for spend/payout; ± for adjust per the request's sign), and appends ONE
    /// ledger row. Returns the parent allowance view. Overdraw is allowed (parents may advance cash) — the
    /// balance can go negative; the frontend surfaces a warning. No email anywhere.</summary>
    private static async Task<IResult> RecordMoveAsync(
        UsageDbContext db, AuditLogger audit, CurrentUserAccessor me, CurrentHouseholdAccessor households,
        int childUserId, AllowanceMoveRequest req, string kind, CancellationToken ct)
    {
        var caller = (await me.GetUserAsync(ct))!;
        var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;

        // The target must be a CHILD member of THIS household — else 404 (never act on another's data).
        if (!await IsChildMemberAsync(db, household.Id, childUserId, ct)) return NotFound();

        var magnitude = req.Amount ?? 0m;
        if (magnitude <= 0m || magnitude > MaxCreditAmount)
            return Results.BadRequest(new { message = "Enter an amount greater than zero." });
        magnitude = Math.Round(magnitude, 2, MidpointRounding.AwayFromZero);

        decimal amount;
        string? category = null;
        switch (kind)
        {
            case "payout":
                amount = -magnitude;
                break;
            case "spend":
                amount = -magnitude;
                category = NormalizeCategory(req.Category);
                break;
            default: // adjust: sign per the request (default +), so a parent can dock or bonus.
                amount = (req.Sign is < 0) ? -magnitude : magnitude;
                break;
        }

        db.FamilyCreditEntries.Add(new FamilyCreditEntry
        {
            HouseholdId = household.Id,
            ChildUserId = childUserId,
            Kind = kind,
            Amount = amount,
            Category = category,
            Note = string.IsNullOrWhiteSpace(req.Note) ? null : Clamp(req.Note, 256),
            CreatedByUserId = caller.Id,
            CreatedUtc = DateTime.UtcNow,
        });
        await db.SaveChangesAsync(ct);
        await audit.LogAsync($"family.allowance.{kind}", targetEmail: null,
            detail: $"child={childUserId} amount={amount}", ct: ct);

        // Return the refreshed parent manager view.
        var childIds = await ChildMemberIdsAsync(db, household.Id, ct);
        var names = await NamesAsync(db, childIds, ct);
        var entries = await db.FamilyCreditEntries.AsNoTracking()
            .Where(e => e.HouseholdId == household.Id)
            .ToListAsync(ct);
        var balanceById = entries.GroupBy(e => e.ChildUserId)
            .ToDictionary(grp => grp.Key, grp => grp.Sum(x => x.Amount));
        var children = childIds
            .Select(cid => new ChildBalanceDto(cid, Name(names, cid), balanceById.GetValueOrDefault(cid)))
            .OrderBy(c => c.Name, StringComparer.OrdinalIgnoreCase)
            .ToList();
        var recent = entries
            .OrderByDescending(e => e.CreatedUtc).ThenByDescending(e => e.Id).Take(100)
            .Select(ToCreditDto).ToList();
        return Results.Ok(new AllowanceDto(children, recent));
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
        }).RequirePermission(Permissions.FamilyAi).RequireRateLimiting(AiEndpoints.RateLimitPolicy);

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
        }).RequirePermission(Permissions.FamilyAi).RequireRateLimiting(AiEndpoints.RateLimitPolicy);

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
        }).RequirePermission(Permissions.FamilyAi).RequireRateLimiting(AiEndpoints.RateLimitPolicy);

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

            // Plain summary is the floor. Prefer the warm AI narrative ONLY when the caller holds family.ai
            // (the gated, token-spending capability) AND Gemini is configured — a family.use caller without
            // family.ai always gets the deterministic plain summary (never spends tokens).
            if (!caller.Permissions.Contains(Permissions.FamilyAi) || !gemini.IsConfigured || !hasAny)
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
        UsageDbContext db, int householdId, List<FamilyChore>? preloaded, string? role, CancellationToken ct)
    {
        role ??= "adult"; // a parent caller with no explicit row is treated as a full member
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

        var orderedChores = await BuildChoreListAsync(db, chores, ct);

        var names = await NamesAsync(db, tallyRows.Select(t => t.ByUserId), ct);
        var tally = tallyRows
            .OrderByDescending(t => t.Points).ThenBy(t => Name(names, t.ByUserId), StringComparer.OrdinalIgnoreCase)
            .Select(t => new TallyEntryDto(t.ByUserId, Name(names, t.ByUserId), t.Points))
            .ToList();

        return new ChoresDto(orderedChores, tally, role, CanManage: IsParent(role));
    }

    /// <summary>Order a set of chores (open first, then done; by assignee then title) and resolve every person
    /// field (assignee/doneBy/claimedBy) to a display name — never email. Shared by the parent board + the
    /// child rescoped list so both render identically.</summary>
    private static async Task<List<ChoreDto>> BuildChoreListAsync(
        UsageDbContext db, List<FamilyChore> chores, CancellationToken ct)
    {
        var personIds = chores.Where(c => c.AssignedToUserId is not null).Select(c => c.AssignedToUserId!.Value)
            .Concat(chores.Where(c => c.DoneByUserId is not null).Select(c => c.DoneByUserId!.Value))
            .Concat(chores.Where(c => c.ClaimedByUserId is not null).Select(c => c.ClaimedByUserId!.Value));
        var names = await NamesAsync(db, personIds, ct);

        return chores
            // Open first, then done; within a group, by assignee (unassigned last), then title.
            .OrderBy(c => c.Done ? 1 : 0)
            .ThenBy(c => c.AssignedToUserId is null ? 1 : 0)
            .ThenBy(c => c.AssignedToUserId ?? 0)
            .ThenBy(c => c.Title, StringComparer.OrdinalIgnoreCase)
            .ThenBy(c => c.Id)
            .Select(c => ToChoreDto(c, names))
            .ToList();
    }

    /// <summary>Build the CHILD-rescoped chores response for a child caller: pool (open) chores + the child's
    /// own claimed/assigned chores only (never another member's), with no tally. Used by the marketplace
    /// state-machine endpoints so a child always gets back exactly their kid-safe board.</summary>
    private static async Task<ChoresDto> BuildMyChoresDtoAsync(
        UsageDbContext db, int householdId, int childUserId, CancellationToken ct)
    {
        var mine = await db.FamilyChores.AsNoTracking()
            .Where(c => c.HouseholdId == householdId
                && ((c.Source == "pool" && c.Status == "open")
                    || c.ClaimedByUserId == childUserId
                    || c.AssignedToUserId == childUserId))
            .ToListAsync(ct);
        var list = await BuildChoreListAsync(db, mine, ct);
        return new ChoresDto(list, Array.Empty<TallyEntryDto>(), "child", CanManage: false);
    }

    // =====================================================================================
    // GROCERY-LIST TIE-IN (find-or-create the household's "Groceries" shopping list)
    // =====================================================================================

    internal const string GroceriesName = "Groceries";

    /// <summary>
    /// Find the household's existing "Groceries" shopping list, or create one. Prefers an existing shopping
    /// list named "Groceries" (case-insensitive), else any shopping list, else creates "Groceries".
    /// </summary>
    internal static async Task<FamilyList> FindOrCreateGroceriesAsync(
        UsageDbContext db, int householdId, int callerId, CancellationToken ct)
    {
        // Reuse the household's ACTIVE "Groceries" list if it exists; otherwise make one. Don't dump
        // ingredients into an arbitrary unrelated shopping list (e.g. "Costco run") just because it's the
        // first one. The ArchivedUtc == null filter is required so that "Complete & archive" (which archives
        // the live Groceries list) cleanly starts a FRESH trip on the next open — the archived list becomes
        // history (it shows under "Past trips") instead of being re-found here with its old items + total.
        var existing = await db.FamilyLists
            .Where(l => l.HouseholdId == householdId && l.Kind == "shopping" && l.ArchivedUtc == null
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

    /// <summary>
    /// Append <paramref name="lines"/> as OPEN items to the shopping list <paramref name="listId"/>, de-duping
    /// case/space-insensitively against the list's existing OPEN items AND within this batch. Each line is
    /// trimmed + capped (500). Bumps the list's UpdatedUtc only when something was actually added. Returns the
    /// number of items added. The SHARED grocery-add path reused by /meals/to-grocery and the recipe-breakdown
    /// "add ingredients" action — never invents a new list.
    /// </summary>
    internal static async Task<int> AppendLinesToListAsync(
        UsageDbContext db, long listId, IEnumerable<string> lines, CancellationToken ct)
    {
        var existingOpen = await db.FamilyListItems.AsNoTracking()
            .Where(i => i.ListId == listId && !i.Done)
            .Select(i => i.Text)
            .ToListAsync(ct);
        var seen = new HashSet<string>(existingOpen.Select(Normalize), StringComparer.Ordinal);

        var maxSort = await db.FamilyListItems.Where(i => i.ListId == listId)
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
                ListId = listId,
                Text = text,
                SortOrder = ++maxSort,
                CreatedUtc = now,
            });
            added++;
        }

        if (added > 0)
        {
            await db.FamilyLists.Where(l => l.Id == listId)
                .ExecuteUpdateAsync(s => s.SetProperty(l => l.UpdatedUtc, now), ct);
            await db.SaveChangesAsync(ct);
        }
        return added;
    }

    /// <summary>
    /// One meal to write into a household's plan via <see cref="CreateMealsAsync"/>: the date + slot + title and
    /// the OPTIONAL ingredients/macros. The SHARED meal-create path (same clamps/normalisation as POST /meals),
    /// so the AI planner's "add to plan" never duplicates the meal model — it just feeds reviewed rows through.
    /// </summary>
    internal sealed record MealToCreate(
        string? LocalDate, string? Slot, string? Title, string? Ingredients,
        int? Servings, int? Calories, double? ProteinG, double? CarbG, double? FatG, string? MacroSource);

    /// <summary>
    /// Create the given <paramref name="meals"/> in <paramref name="householdId"/> using the SAME clamp +
    /// slot-normalisation + macro-application logic as POST /api/family/meals (single-sourced — no parallel meal
    /// model). Rows with a blank title or an invalid date are skipped; the set is clamped to <see cref="MaxMealIds"/>.
    /// Returns the number actually created. Caller is responsible for the household scoping (members write their
    /// own household's plan). Saves once at the end.
    /// </summary>
    internal static async Task<int> CreateMealsAsync(
        UsageDbContext db, int householdId, int callerId, IReadOnlyList<MealToCreate> meals, CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        var added = 0;
        foreach (var m in meals.Take(MaxMealIds))
        {
            var title = (m.Title ?? "").Trim();
            if (title.Length == 0) continue;
            if (ParseDate(m.LocalDate) is not DateOnly date) continue;

            var meal = new FamilyMeal
            {
                HouseholdId = householdId,
                LocalDate = date,
                Slot = NormalizeSlot(m.Slot),
                Title = Clamp(title, 200),
                Ingredients = ClampIngredients(m.Ingredients),
                CreatedByUserId = callerId,
                CreatedUtc = now,
            };
            // Reuse the exact optional-macro application (clamped + source-normalised) as the meal upsert.
            ApplyMacroFields(meal, new MealUpsertRequest(
                LocalDate: null, Slot: null, Title: null, Ingredients: null,
                Servings: m.Servings, Calories: m.Calories, ProteinG: m.ProteinG,
                CarbG: m.CarbG, FatG: m.FatG, MacroSource: m.MacroSource));
            db.FamilyMeals.Add(meal);
            added++;
        }
        if (added > 0) await db.SaveChangesAsync(ct);
        return added;
    }

    /// <summary>Split a meal's newline-separated ingredients into trimmed, non-blank lines.</summary>
    private static IEnumerable<string> SplitIngredients(string? ingredients) =>
        (ingredients ?? "")
            .Split('\n')
            .Select(s => s.Trim())
            .Where(s => s.Length > 0);

    /// <summary>Max distinct restriction TERMS the merged household allergy/avoid string may carry.</summary>
    private const int MaxMergedRestrictionTerms = 24;
    /// <summary>Max length of the merged household allergy/avoid string passed to the AI meal builders.</summary>
    private const int MaxMergedRestrictionLen = 300;

    /// <summary>
    /// Merge every household member's free-text/CSV <see cref="TrackerProfile.Restrictions"/> into a single
    /// allergy/avoid string for a SHARED family meal: split each on commas, trim, drop blanks, take the
    /// case-insensitive DISTINCT terms (first spelling wins), cap to <see cref="MaxMergedRestrictionTerms"/>
    /// terms and <see cref="MaxMergedRestrictionLen"/> chars, and re-join with ", ". Returns "" when no member
    /// has any restriction (so the AI prompt stays byte-for-byte unchanged).
    /// </summary>
    private static string MergeRestrictions(IEnumerable<string> parts)
    {
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var terms = new List<string>();
        var len = 0;
        foreach (var part in parts)
        {
            foreach (var raw in (part ?? "").Split(','))
            {
                var term = raw.Trim();
                if (term.Length == 0) continue;
                if (!seen.Add(term)) continue; // case-insensitive dedupe; first spelling wins
                var add = (terms.Count == 0 ? 0 : 2) + term.Length; // ", " separator + the term
                if (len + add > MaxMergedRestrictionLen) return string.Join(", ", terms);
                terms.Add(term);
                len += add;
                if (terms.Count >= MaxMergedRestrictionTerms) return string.Join(", ", terms);
            }
        }
        return string.Join(", ", terms);
    }

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
            c.Points, c.Recurrence,
            c.CreditValue, c.Source, c.Status,
            c.ClaimedByUserId, c.ClaimedByUserId is int cl ? Name(names, cl) : null, c.ClaimedUtc,
            c.ApprovedByUserId, c.ApprovedUtc);

    private static CreditEntryDto ToCreditDto(FamilyCreditEntry e) =>
        new(e.Id, e.Kind, e.Amount, e.Category, e.ChoreCompletionId, e.Note, e.CreatedByUserId, e.CreatedUtc);

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

    // ---- Marketplace role + normalization helpers ----

    /// <summary>The caller's role in the household ("owner"|"adult"|"child"), or null if not a member.</summary>
    private static async Task<string?> RoleInHouseholdAsync(
        UsageDbContext db, int householdId, int userId, CancellationToken ct) =>
        await db.HouseholdMembers.AsNoTracking()
            .Where(m => m.HouseholdId == householdId && m.UserId == userId)
            .Select(m => m.Role)
            .FirstOrDefaultAsync(ct);

    /// <summary>A child caller (the kid view): role is exactly "child".</summary>
    private static bool IsChild(string? role) => role == "child";

    /// <summary>A parent caller (full management): an owner or adult member. A non-member is NOT a parent.</summary>
    private static bool IsParent(string? role) => role is "owner" or "adult";

    /// <summary>Whether <paramref name="userId"/> is a CHILD member of the household.</summary>
    private static async Task<bool> IsChildMemberAsync(
        UsageDbContext db, int householdId, int userId, CancellationToken ct) =>
        await db.HouseholdMembers.AsNoTracking()
            .AnyAsync(m => m.HouseholdId == householdId && m.UserId == userId && m.Role == "child", ct);

    /// <summary>The AppUser ids of every CHILD member of the household.</summary>
    private static async Task<List<int>> ChildMemberIdsAsync(
        UsageDbContext db, int householdId, CancellationToken ct) =>
        await db.HouseholdMembers.AsNoTracking()
            .Where(m => m.HouseholdId == householdId && m.Role == "child")
            .Select(m => m.UserId)
            .ToListAsync(ct);

    private static bool TryNormalizeSource(string? raw, out string source)
    {
        source = string.IsNullOrWhiteSpace(raw) ? "assigned" : raw.Trim().ToLowerInvariant();
        return ChoreSources.Contains(source);
    }

    /// <summary>Clamp a chore's credit value to a sane non-negative range, rounded to cents.</summary>
    private static decimal NormalizeCredit(decimal? v)
    {
        var c = v ?? 0m;
        if (c < 0m) c = 0m;
        if (c > MaxCreditAmount) c = MaxCreditAmount;
        return Math.Round(c, 2, MidpointRounding.AwayFromZero);
    }

    /// <summary>Normalise a spend category to the fixed enum; unknown/blank → "other".</summary>
    private static string NormalizeCategory(string? s)
    {
        var v = (s ?? "").Trim().ToLowerInvariant();
        return SpendCategories.Contains(v) ? v : "other";
    }

    private static IResult ChildForbidden(string message) =>
        Results.Json(new { message }, statusCode: StatusCodes.Status403Forbidden);

    private static IResult Conflict(string message) =>
        Results.Json(new { message }, statusCode: StatusCodes.Status409Conflict);

    /// <summary>Resolve a set of userIds to display names (email is never read). Missing → "Unknown user".</summary>
    private static async Task<Dictionary<int, string>> NamesAsync(
        UsageDbContext db, IEnumerable<int> userIds, CancellationToken ct)
    {
        // Centralized: each TARGET user's wire name applies their own DisplayNameMode/Nickname
        // (presence/chat/family/leaderboard all show the same chosen form). Never an email.
        return await DisplayName.ResolveNamesByIdAsync(db, userIds, ct);
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
    internal static string Normalize(string s) => s.Trim().ToLowerInvariant();

    private static IResult NotFound() =>
        Results.NotFound(new { message = "That item doesn't exist." });

    /// <summary>503 (never 500) when an AI-assist call can't run — Gemini unconfigured or the call failed. One
    /// consistent degraded path the frontend shows as "AI isn't available right now; do it manually".</summary>
    private static IResult AiUnavailable() => Results.Problem(
        title: "AI assistance is not available.",
        detail: "AI assistance is not available right now. You can do this manually.",
        statusCode: StatusCodes.Status503ServiceUnavailable);
}
