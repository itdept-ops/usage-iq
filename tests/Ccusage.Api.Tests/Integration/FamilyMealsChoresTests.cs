using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Ccusage.Api.Data;
using Ccusage.Api.Services;
using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Ccusage.Api.Tests.Integration;

/// <summary>
/// Family Hub F4 — the weekly MEAL PLANNER and the CHORES board (/api/family/meals, /api/family/chores)
/// plus the recurring chore RESET on the background tick (<see cref="FamilyReminderService"/>). Covers:
/// family.use gating (no permission → 403); meals CRUD within a week, household-scoped, no email;
/// POST /meals/to-grocery appends the chosen meals' ingredients to the Groceries shopping list (creating
/// it if needed) and is reflected by GET /lists; chores CRUD; marking a chore done stamps doneBy + logs
/// exactly one completion + bumps that member's tally; un-doing clears the stamps but keeps the ledger;
/// a daily recurring chore done "yesterday" resets to not-done on the tick (points preserved); every
/// person field carries userId+name with NO email anywhere; and cross-household isolation holds. Each
/// test provisions fresh users so they're order-independent.
/// </summary>
[Collection(IntegrationCollection.Name)]
public class FamilyMealsChoresTests(WebAppFactory factory)
{
    private HttpClient Admin()
    {
        var c = factory.CreateClient();
        c.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", TestJwt.For(WebAppFactory.AdminEmail));
        return c;
    }

    private HttpClient Client(string email)
    {
        var c = factory.CreateClient();
        c.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", TestJwt.For(email));
        return c;
    }

    private async Task<(string email, HttpClient client, int id)> ProvisionUser(params string[] permissions)
    {
        var email = $"fammc-{Guid.NewGuid():N}@test.local";
        var res = await Admin().PostAsJsonAsync("/api/users", new { email, isEnabled = true, permissions });
        res.StatusCode.Should().Be(HttpStatusCode.Created);
        var id = (await Json(res)).GetProperty("id").GetInt32();
        return (email, Client(email), id);
    }

    private static async Task<JsonElement> Json(HttpResponseMessage resp) =>
        await resp.Content.ReadFromJsonAsync<JsonElement>();

    private static bool HasProperty(JsonElement el, string name) =>
        el.ValueKind == JsonValueKind.Object && el.TryGetProperty(name, out _);

    /// <summary>This Monday (UTC) as a plain YYYY-MM-DD — a stable weekStart for the meal-plan window.</summary>
    private static string ThisMonday()
    {
        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        var offset = ((int)today.DayOfWeek + 6) % 7; // Mon=0..Sun=6
        return today.AddDays(-offset).ToString("yyyy-MM-dd");
    }

    /// <summary>Run one deterministic tick of the background service as of <paramref name="now"/>.</summary>
    private async Task<FamilyReminderService.TickResult> RunTick(DateTime now)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        var notifier = scope.ServiceProvider.GetRequiredService<ChatNotificationService>();
        var svc = new FamilyReminderService(
            factory.Services.GetRequiredService<IServiceScopeFactory>(),
            factory.Services.GetRequiredService<Microsoft.Extensions.Logging.ILogger<FamilyReminderService>>());
        return await svc.TickAsync(db, notifier, now);
    }

    /// <summary>Force a chore's DoneUtc into the past (e.g. "yesterday") to exercise the period-reset tick.</summary>
    private async Task BackdateChoreDoneUtc(long choreId, DateTime doneUtc)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        await db.FamilyChores.Where(c => c.Id == choreId)
            .ExecuteUpdateAsync(s => s.SetProperty(c => c.DoneUtc, doneUtc));
    }

    private static List<long> MealIdsInWeek(JsonElement days) =>
        days.EnumerateArray()
            .SelectMany(d => d.GetProperty("meals").EnumerateArray())
            .Select(m => m.GetProperty("id").GetInt64())
            .ToList();

    private static JsonElement ChoresArray(JsonElement dto) => dto.GetProperty("chores");
    private static JsonElement TallyArray(JsonElement dto) => dto.GetProperty("tally");

    private static JsonElement ChoreById(JsonElement dto, long id) =>
        ChoresArray(dto).EnumerateArray().Single(c => c.GetProperty("id").GetInt64() == id);

    // =====================================================================================
    // GATING
    // =====================================================================================

    [Fact]
    public async Task Meals_and_chores_require_family_use()
    {
        var (_, plain, _) = await ProvisionUser("dashboard.view");

        (await plain.GetAsync($"/api/family/meals?weekStart={ThisMonday()}"))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await plain.PostAsJsonAsync("/api/family/meals",
            new { localDate = ThisMonday(), slot = "dinner", title = "X", ingredients = "" }))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await plain.GetAsync("/api/family/chores")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await plain.PostAsJsonAsync("/api/family/chores", new { title = "X" }))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Meals_and_chores_require_authentication()
    {
        var anon = factory.CreateClient();
        (await anon.GetAsync($"/api/family/meals?weekStart={ThisMonday()}"))
            .StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await anon.GetAsync("/api/family/chores")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    // =====================================================================================
    // MEALS — CRUD within a week, household-scoped, no email
    // =====================================================================================

    [Fact]
    public async Task Meals_crud_within_a_week_carries_people_by_id_and_name_no_email()
    {
        var (_, owner, ownerId) = await ProvisionUser("family.use");
        await owner.GetAsync("/api/family/household"); // provision

        var monday = ThisMonday();
        var tuesday = DateOnly.Parse(monday).AddDays(1).ToString("yyyy-MM-dd");

        // Create two meals in this week.
        var created = await owner.PostAsJsonAsync("/api/family/meals", new
        {
            localDate = monday, slot = "dinner", title = "Spaghetti", ingredients = "pasta\ntomato sauce\nparmesan",
        });
        created.StatusCode.Should().Be(HttpStatusCode.OK);
        var meal = await Json(created);
        var mealId = meal.GetProperty("id").GetInt64();
        meal.GetProperty("slot").GetString().Should().Be("dinner");
        meal.GetProperty("title").GetString().Should().Be("Spaghetti");
        meal.GetProperty("localDate").GetString().Should().StartWith(monday);
        meal.GetProperty("createdByUserId").GetInt32().Should().Be(ownerId);
        meal.GetProperty("createdByName").GetString().Should().NotBeNullOrWhiteSpace();
        HasProperty(meal, "email").Should().BeFalse();
        meal.GetRawText().Should().NotContain("@");

        await owner.PostAsJsonAsync("/api/family/meals",
            new { localDate = tuesday, slot = "lunch", title = "Salad", ingredients = "lettuce" });

        // GET the week → 7 days, with the two meals on the right days.
        var week = await Json(await owner.GetAsync($"/api/family/meals?weekStart={monday}"));
        week.GetArrayLength().Should().Be(7);
        var mondayDay = week.EnumerateArray().Single(d => d.GetProperty("localDate").GetString()!.StartsWith(monday));
        mondayDay.GetProperty("meals").EnumerateArray().Select(m => m.GetProperty("id").GetInt64())
            .Should().Contain(mealId);
        week.GetRawText().Should().NotContain("@");

        // PUT edits the meal.
        var edited = await owner.PutAsJsonAsync($"/api/family/meals/{mealId}",
            new { title = "Spaghetti Bolognese", slot = "dinner" });
        edited.StatusCode.Should().Be(HttpStatusCode.OK);
        (await Json(edited)).GetProperty("title").GetString().Should().Be("Spaghetti Bolognese");

        // DELETE removes it.
        (await owner.DeleteAsync($"/api/family/meals/{mealId}")).StatusCode.Should().Be(HttpStatusCode.NoContent);
        var after = await Json(await owner.GetAsync($"/api/family/meals?weekStart={monday}"));
        MealIdsInWeek(after).Should().NotContain(mealId);
    }

    [Fact]
    public async Task A_meal_in_another_week_is_not_in_this_weeks_window()
    {
        var (_, owner, _) = await ProvisionUser("family.use");
        await owner.GetAsync("/api/family/household");

        var monday = ThisMonday();
        var nextWeek = DateOnly.Parse(monday).AddDays(9).ToString("yyyy-MM-dd"); // outside [monday, monday+7)
        var farId = (await Json(await owner.PostAsJsonAsync("/api/family/meals",
            new { localDate = nextWeek, slot = "dinner", title = "Future", ingredients = "" })))
            .GetProperty("id").GetInt64();

        var week = await Json(await owner.GetAsync($"/api/family/meals?weekStart={monday}"));
        MealIdsInWeek(week).Should().NotContain(farId);
    }

    [Fact]
    public async Task Meals_are_household_isolated()
    {
        var (_, alice, _) = await ProvisionUser("family.use");
        var (_, bob, _) = await ProvisionUser("family.use");
        await alice.GetAsync("/api/family/household");
        await bob.GetAsync("/api/family/household");

        var monday = ThisMonday();
        var aliceMeal = (await Json(await alice.PostAsJsonAsync("/api/family/meals",
            new { localDate = monday, slot = "dinner", title = "Alice dinner", ingredients = "x" })))
            .GetProperty("id").GetInt64();

        // Bob's week doesn't include Alice's meal...
        MealIdsInWeek(await Json(await bob.GetAsync($"/api/family/meals?weekStart={monday}")))
            .Should().NotContain(aliceMeal);
        // ...and Bob can't edit/delete it (404, existence never leaked).
        (await bob.PutAsJsonAsync($"/api/family/meals/{aliceMeal}", new { title = "hijack" }))
            .StatusCode.Should().Be(HttpStatusCode.NotFound);
        (await bob.DeleteAsync($"/api/family/meals/{aliceMeal}")).StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    // =====================================================================================
    // MEALS → GROCERY LIST (the auto-grocery tie-in)
    // =====================================================================================

    [Fact]
    public async Task To_grocery_creates_groceries_list_and_appends_meal_ingredients_reflected_by_get_lists()
    {
        var (_, owner, _) = await ProvisionUser("family.use");
        await owner.GetAsync("/api/family/household");

        var monday = ThisMonday();
        await owner.PostAsJsonAsync("/api/family/meals",
            new { localDate = monday, slot = "dinner", title = "Tacos", ingredients = "tortillas\nbeef\ncheese" });
        await owner.PostAsJsonAsync("/api/family/meals",
            new { localDate = monday, slot = "lunch", title = "Soup", ingredients = "broth\n\ncheese" }); // blank + dup "cheese"

        // No Groceries list exists yet → to-grocery creates it and appends the (de-duped, non-blank) lines.
        var res = await owner.PostAsJsonAsync("/api/family/meals/to-grocery", new { weekStart = monday });
        res.StatusCode.Should().Be(HttpStatusCode.OK);
        var list = await Json(res);
        list.GetProperty("kind").GetString().Should().Be("shopping");
        list.GetProperty("name").GetString().Should().Be("Groceries");
        var texts = list.GetProperty("items").EnumerateArray().Select(i => i.GetProperty("text").GetString()).ToList();
        texts.Should().Contain(new[] { "tortillas", "beef", "cheese", "broth" });
        texts.Count(t => t == "cheese").Should().Be(1); // de-duped within the batch
        texts.Should().NotContain(""); // blanks skipped
        list.GetRawText().Should().NotContain("@");
        var listId = list.GetProperty("id").GetInt64();

        // It's a real shopping list, visible via GET /lists.
        var lists = await Json(await owner.GetAsync("/api/family/lists"));
        lists.EnumerateArray().Select(l => l.GetProperty("id").GetInt64()).Should().Contain(listId);

        // Running it again doesn't duplicate the still-open items.
        var again = await Json(await owner.PostAsJsonAsync("/api/family/meals/to-grocery", new { weekStart = monday }));
        again.GetProperty("items").EnumerateArray().Count(i => i.GetProperty("text").GetString() == "beef")
            .Should().Be(1);
    }

    [Fact]
    public async Task To_grocery_with_explicit_meal_ids_and_target_list_appends_to_that_list()
    {
        var (_, owner, _) = await ProvisionUser("family.use");
        await owner.GetAsync("/api/family/household");

        var monday = ThisMonday();
        var m1 = (await Json(await owner.PostAsJsonAsync("/api/family/meals",
            new { localDate = monday, slot = "dinner", title = "Stir fry", ingredients = "rice\nveggies" })))
            .GetProperty("id").GetInt64();
        // A second meal we will NOT include.
        await owner.PostAsJsonAsync("/api/family/meals",
            new { localDate = monday, slot = "lunch", title = "Other", ingredients = "should-not-appear" });

        // Make a specific shopping list to target.
        var targetListId = (await Json(await owner.PostAsJsonAsync("/api/family/lists",
            new { name = "Weekend run", kind = "shopping" }))).GetProperty("id").GetInt64();

        var res = await owner.PostAsJsonAsync("/api/family/meals/to-grocery",
            new { mealIds = new[] { m1 }, listId = targetListId });
        res.StatusCode.Should().Be(HttpStatusCode.OK);
        var list = await Json(res);
        list.GetProperty("id").GetInt64().Should().Be(targetListId);
        var texts = list.GetProperty("items").EnumerateArray().Select(i => i.GetProperty("text").GetString()).ToList();
        texts.Should().Contain(new[] { "rice", "veggies" });
        texts.Should().NotContain("should-not-appear"); // the un-chosen meal contributed nothing
    }

    [Fact]
    public async Task To_grocery_against_a_cross_household_list_is_404()
    {
        var (_, alice, _) = await ProvisionUser("family.use");
        var (_, bob, _) = await ProvisionUser("family.use");
        await alice.GetAsync("/api/family/household");
        await bob.GetAsync("/api/family/household");

        var bobListId = (await Json(await bob.PostAsJsonAsync("/api/family/lists",
            new { name = "Bob shopping", kind = "shopping" }))).GetProperty("id").GetInt64();

        (await alice.PostAsJsonAsync("/api/family/meals/to-grocery",
            new { weekStart = ThisMonday(), listId = bobListId })).StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    // =====================================================================================
    // CHORES — CRUD, done stamps + ledger + tally, un-done keeps the ledger
    // =====================================================================================

    [Fact]
    public async Task Chores_crud_and_marking_done_stamps_logs_one_completion_and_bumps_the_tally()
    {
        var (_, owner, ownerId) = await ProvisionUser("family.use");
        var (_, bob, bobId) = await ProvisionUser("family.use");
        await owner.GetAsync("/api/family/household");
        await owner.PostAsJsonAsync("/api/family/household/members", new { userId = bobId });

        // Create a chore assigned to Bob, worth 3 points.
        var created = await owner.PostAsJsonAsync("/api/family/chores",
            new { title = "Dishes", assignedToUserId = bobId, points = 3, recurrence = "none" });
        created.StatusCode.Should().Be(HttpStatusCode.OK);
        var dto = await Json(created);
        var choreId = ChoresArray(dto).EnumerateArray().Single().GetProperty("id").GetInt64();
        var chore = ChoreById(dto, choreId);
        chore.GetProperty("title").GetString().Should().Be("Dishes");
        chore.GetProperty("assignedToUserId").GetInt32().Should().Be(bobId);
        chore.GetProperty("assignedToName").GetString().Should().NotBeNullOrWhiteSpace();
        chore.GetProperty("points").GetInt32().Should().Be(3);
        chore.GetProperty("done").GetBoolean().Should().BeFalse();
        dto.GetRawText().Should().NotContain("@");
        TallyArray(dto).EnumerateArray().Should().BeEmpty(); // nothing completed yet

        // Bob marks it done → done stamps Bob + tally shows Bob with 3.
        var done = await Json(await bob.PatchAsJsonAsync($"/api/family/chores/{choreId}", new { done = true }));
        var doneChore = ChoreById(done, choreId);
        doneChore.GetProperty("done").GetBoolean().Should().BeTrue();
        doneChore.GetProperty("doneByUserId").GetInt32().Should().Be(bobId);
        doneChore.GetProperty("doneByName").GetString().Should().NotBeNullOrWhiteSpace();
        doneChore.GetProperty("doneUtc").ValueKind.Should().NotBe(JsonValueKind.Null);
        var bobTally = TallyArray(done).EnumerateArray().Single(t => t.GetProperty("userId").GetInt32() == bobId);
        bobTally.GetProperty("points").GetInt32().Should().Be(3);
        bobTally.GetProperty("name").GetString().Should().NotBeNullOrWhiteSpace();
        done.GetRawText().Should().NotContain("@");

        // Re-marking an already-done chore done:true does NOT double-log (tally still 3).
        var reDone = await Json(await bob.PatchAsJsonAsync($"/api/family/chores/{choreId}", new { done = true }));
        TallyArray(reDone).EnumerateArray().Single(t => t.GetProperty("userId").GetInt32() == bobId)
            .GetProperty("points").GetInt32().Should().Be(3);

        // Un-done clears the stamps but the ledger (tally) stays intact.
        var undone = await Json(await owner.PatchAsJsonAsync($"/api/family/chores/{choreId}", new { done = false }));
        var undoneChore = ChoreById(undone, choreId);
        undoneChore.GetProperty("done").GetBoolean().Should().BeFalse();
        undoneChore.GetProperty("doneByUserId").ValueKind.Should().Be(JsonValueKind.Null);
        undoneChore.GetProperty("doneUtc").ValueKind.Should().Be(JsonValueKind.Null);
        TallyArray(undone).EnumerateArray().Single(t => t.GetProperty("userId").GetInt32() == bobId)
            .GetProperty("points").GetInt32().Should().Be(3); // ledger preserved

        // Edit (PATCH non-done fields) + delete.
        var renamed = await Json(await owner.PatchAsJsonAsync($"/api/family/chores/{choreId}",
            new { title = "Wash dishes", points = 5 }));
        ChoreById(renamed, choreId).GetProperty("title").GetString().Should().Be("Wash dishes");
        ChoreById(renamed, choreId).GetProperty("points").GetInt32().Should().Be(5);

        (await owner.DeleteAsync($"/api/family/chores/{choreId}")).StatusCode.Should().Be(HttpStatusCode.NoContent);
        ChoresArray(await Json(await owner.GetAsync("/api/family/chores")))
            .EnumerateArray().Select(c => c.GetProperty("id").GetInt64()).Should().NotContain(choreId);
    }

    [Fact]
    public async Task Open_chores_sort_before_done_chores()
    {
        var (_, owner, _) = await ProvisionUser("family.use");
        await owner.GetAsync("/api/family/household");

        var a = ChoresArray(await Json(await owner.PostAsJsonAsync("/api/family/chores", new { title = "Aaa" })))
            .EnumerateArray().Single(c => c.GetProperty("title").GetString() == "Aaa").GetProperty("id").GetInt64();
        await owner.PostAsJsonAsync("/api/family/chores", new { title = "Zzz" });

        // Mark "Aaa" done → it should fall to the bottom even though its title sorts first.
        await owner.PatchAsJsonAsync($"/api/family/chores/{a}", new { done = true });

        var ids = ChoresArray(await Json(await owner.GetAsync("/api/family/chores")))
            .EnumerateArray().Select(c => (id: c.GetProperty("id").GetInt64(), done: c.GetProperty("done").GetBoolean()))
            .ToList();
        // Every open chore appears before every done chore.
        var firstDoneIdx = ids.FindIndex(x => x.done);
        if (firstDoneIdx >= 0)
            ids.Skip(firstDoneIdx).Should().OnlyContain(x => x.done);
    }

    [Fact]
    public async Task Chore_assignee_must_be_a_household_member()
    {
        var (_, owner, _) = await ProvisionUser("family.use");
        var (_, _, outsiderId) = await ProvisionUser("family.use"); // their OWN household
        await owner.GetAsync("/api/family/household");

        (await owner.PostAsJsonAsync("/api/family/chores",
            new { title = "Nope", assignedToUserId = outsiderId })).StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Chores_are_household_isolated()
    {
        var (_, alice, _) = await ProvisionUser("family.use");
        var (_, bob, _) = await ProvisionUser("family.use");
        await alice.GetAsync("/api/family/household");
        await bob.GetAsync("/api/family/household");

        var aliceChore = ChoresArray(await Json(await alice.PostAsJsonAsync("/api/family/chores",
            new { title = "Alice only" }))).EnumerateArray().Single().GetProperty("id").GetInt64();

        ChoresArray(await Json(await bob.GetAsync("/api/family/chores")))
            .EnumerateArray().Select(c => c.GetProperty("id").GetInt64()).Should().NotContain(aliceChore);
        (await bob.PatchAsJsonAsync($"/api/family/chores/{aliceChore}", new { done = true }))
            .StatusCode.Should().Be(HttpStatusCode.NotFound);
        (await bob.DeleteAsync($"/api/family/chores/{aliceChore}")).StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    // =====================================================================================
    // RECURRING RESET (the background tick)
    // =====================================================================================

    [Fact]
    public async Task A_daily_recurring_chore_done_yesterday_resets_to_not_done_on_the_tick_points_preserved()
    {
        var (_, owner, ownerId) = await ProvisionUser("family.use");
        await owner.GetAsync("/api/family/household");

        var choreId = ChoresArray(await Json(await owner.PostAsJsonAsync("/api/family/chores",
            new { title = "Make bed", points = 2, recurrence = "daily" })))
            .EnumerateArray().Single().GetProperty("id").GetInt64();

        // Mark it done (logs a completion → tally 2), then backdate the done stamp to "yesterday".
        await owner.PatchAsJsonAsync($"/api/family/chores/{choreId}", new { done = true });
        await BackdateChoreDoneUtc(choreId, DateTime.UtcNow.AddDays(-1).AddHours(-1));

        var result = await RunTick(DateTime.UtcNow);
        result.ChoresReset.Should().BeGreaterThanOrEqualTo(1);

        // It reappears as not-done (stamps cleared)...
        var after = await Json(await owner.GetAsync("/api/family/chores"));
        var chore = ChoreById(after, choreId);
        chore.GetProperty("done").GetBoolean().Should().BeFalse();
        chore.GetProperty("doneByUserId").ValueKind.Should().Be(JsonValueKind.Null);
        chore.GetProperty("doneUtc").ValueKind.Should().Be(JsonValueKind.Null);

        // ...but the points ledger/tally is preserved across the reset.
        TallyArray(after).EnumerateArray().Single(t => t.GetProperty("userId").GetInt32() == ownerId)
            .GetProperty("points").GetInt32().Should().Be(2);

        // A second tick doesn't reset it again (it's no longer done).
        var second = await RunTick(DateTime.UtcNow);
        // (No assertion on exact count — other tests' chores may also exist — but this chore stays not-done.)
        ChoreById(await Json(await owner.GetAsync("/api/family/chores")), choreId)
            .GetProperty("done").GetBoolean().Should().BeFalse();
        second.ChoresReset.Should().BeGreaterThanOrEqualTo(0);
    }

    [Fact]
    public async Task A_recurring_chore_done_within_the_current_period_is_not_reset()
    {
        var (_, owner, _) = await ProvisionUser("family.use");
        await owner.GetAsync("/api/family/household");

        var choreId = ChoresArray(await Json(await owner.PostAsJsonAsync("/api/family/chores",
            new { title = "Walk dog", recurrence = "daily" })))
            .EnumerateArray().Single().GetProperty("id").GetInt64();

        // Done just now (this period) → the tick must NOT reset it.
        await owner.PatchAsJsonAsync($"/api/family/chores/{choreId}", new { done = true });
        await RunTick(DateTime.UtcNow);

        ChoreById(await Json(await owner.GetAsync("/api/family/chores")), choreId)
            .GetProperty("done").GetBoolean().Should().BeTrue();
    }

    [Fact]
    public async Task A_non_recurring_done_chore_is_never_reset()
    {
        var (_, owner, _) = await ProvisionUser("family.use");
        await owner.GetAsync("/api/family/household");

        var choreId = ChoresArray(await Json(await owner.PostAsJsonAsync("/api/family/chores",
            new { title = "One-off", recurrence = "none" })))
            .EnumerateArray().Single().GetProperty("id").GetInt64();

        await owner.PatchAsJsonAsync($"/api/family/chores/{choreId}", new { done = true });
        // Even backdated far into the past, a "none" chore is left done.
        await BackdateChoreDoneUtc(choreId, DateTime.UtcNow.AddDays(-30));
        await RunTick(DateTime.UtcNow);

        ChoreById(await Json(await owner.GetAsync("/api/family/chores")), choreId)
            .GetProperty("done").GetBoolean().Should().BeTrue();
    }

    // =====================================================================================
    // AI — "Plan our week" + "From a recipe": gated by family.use, 400 on empty (recipe),
    // graceful 503 when Gemini unconfigured (never 500), and neither writes anything.
    // =====================================================================================

    [Fact]
    public async Task MealsAi_requires_family_use()
    {
        var (_, plain, _) = await ProvisionUser("dashboard.view");

        (await plain.PostAsJsonAsync("/api/family/meals/ai/plan-week",
            new { weekStart = ThisMonday(), constraints = "kid-friendly" }))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await plain.PostAsJsonAsync("/api/family/meals/ai/from-recipe",
            new { text = "2 bananas, 1 cup flour" }))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task MealsAi_requires_authentication()
    {
        var anon = factory.CreateClient();

        (await anon.PostAsJsonAsync("/api/family/meals/ai/plan-week", new { weekStart = ThisMonday() }))
            .StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await anon.PostAsJsonAsync("/api/family/meals/ai/from-recipe", new { text = "x" }))
            .StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task FromRecipe_returns_400_for_empty_text()
    {
        var (_, owner, _) = await ProvisionUser("family.use");
        await owner.GetAsync("/api/family/household");

        var res = await owner.PostAsJsonAsync("/api/family/meals/ai/from-recipe", new { text = "   " });
        res.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task PlanWeek_is_unavailable_503_when_gemini_is_unconfigured_never_500()
    {
        var (_, owner, _) = await ProvisionUser("family.use");
        await owner.GetAsync("/api/family/household");

        // The test host configures no Gemini API key, so AI planning is gracefully unavailable (503), never a
        // 500 and never a real Gemini/Google call (the unconfigured branch returns before any HTTP).
        var res = await owner.PostAsJsonAsync("/api/family/meals/ai/plan-week",
            new { weekStart = ThisMonday(), constraints = "budget, no nuts", fillSlots = "allDinners" });
        res.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
    }

    [Fact]
    public async Task FromRecipe_is_unavailable_503_when_gemini_is_unconfigured_never_500()
    {
        var (_, owner, _) = await ProvisionUser("family.use");
        await owner.GetAsync("/api/family/household");

        var res = await owner.PostAsJsonAsync("/api/family/meals/ai/from-recipe",
            new { text = "Banana bread: 2 bananas, 1 cup flour, 1/2 cup sugar. Mix and bake." });
        res.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
    }

    [Fact]
    public async Task PlanWeek_writes_nothing_even_when_it_runs_the_unconfigured_path()
    {
        var (_, owner, _) = await ProvisionUser("family.use");
        await owner.GetAsync("/api/family/household");

        var monday = ThisMonday();
        await owner.PostAsJsonAsync("/api/family/meals/ai/plan-week",
            new { weekStart = monday, constraints = "anything", fillSlots = "allDinners" });

        // The week is untouched — the AI endpoint proposes only; it creates no meals.
        var week = await Json(await owner.GetAsync($"/api/family/meals?weekStart={monday}"));
        MealIdsInWeek(week).Should().BeEmpty();
    }
}
