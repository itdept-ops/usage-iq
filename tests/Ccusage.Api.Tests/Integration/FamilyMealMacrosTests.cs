using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using FluentAssertions;

namespace Ccusage.Api.Tests.Integration;

/// <summary>
/// Family Hub Slice 2 — meal MACROS + the tracker ⇄ meal-plan tie-in. Covers:
/// the macro TOTALS + Servings + MacroSource persist via PATCH /meals/{id} and are CLAMPED (cal 0..20000,
/// macros 0..2000, servings 1..50); the derived PER-SERVING block on GET /meals equals total / max(Servings, 1);
/// POST /meals/{id}/ai/macros + POST /meals/{id}/macros/refine require family.use (403), are household-scoped
/// (404 on a foreign meal — existence never leaked), are PROPOSALS (the meal is unchanged until a PATCH), and
/// degrade to 503 (never 500) when the provider is unconfigured (the test host sets no Gemini/USDA key);
/// POST /api/tracker/food/from-meal requires tracker.self (403), enforces household MEMBERSHIP (404 on a foreign
/// meal), returns 400 when the meal's macros are unset, and otherwise logs a FoodEntry with the PER-SERVING
/// macros (total / servings) on the right date for the CALLER. No other-user email anywhere. Each test
/// provisions fresh users so they're order-independent.
/// </summary>
[Collection(IntegrationCollection.Name)]
public class FamilyMealMacrosTests(WebAppFactory factory)
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
        var email = $"fammm-{Guid.NewGuid():N}@test.local";
        var res = await Admin().PostAsJsonAsync("/api/users", new { email, isEnabled = true, permissions });
        res.StatusCode.Should().Be(HttpStatusCode.Created);
        var id = (await Json(res)).GetProperty("id").GetInt32();
        return (email, Client(email), id);
    }

    private static async Task<JsonElement> Json(HttpResponseMessage resp) =>
        await resp.Content.ReadFromJsonAsync<JsonElement>();

    private static string ThisMonday()
    {
        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        var offset = ((int)today.DayOfWeek + 6) % 7;
        return today.AddDays(-offset).ToString("yyyy-MM-dd");
    }

    /// <summary>Create a meal in the caller's household, returning its id.</summary>
    private static async Task<long> CreateMeal(
        HttpClient owner, string localDate, string title, string ingredients = "")
    {
        var res = await owner.PostAsJsonAsync("/api/family/meals",
            new { localDate, slot = "dinner", title, ingredients });
        res.StatusCode.Should().Be(HttpStatusCode.OK);
        return (await Json(res)).GetProperty("id").GetInt64();
    }

    private static async Task<JsonElement> MealById(HttpClient owner, string weekStart, long mealId)
    {
        var week = await Json(await owner.GetAsync($"/api/family/meals?weekStart={weekStart}"));
        return week.EnumerateArray()
            .SelectMany(d => d.GetProperty("meals").EnumerateArray())
            .Single(m => m.GetProperty("id").GetInt64() == mealId);
    }

    // =====================================================================================
    // PATCH macros persist + clamp; per-serving derivation on GET
    // =====================================================================================

    [Fact]
    public async Task Patch_persists_macro_totals_servings_and_source_with_derived_per_serving()
    {
        var (_, owner, _) = await ProvisionUser("family.use");
        await owner.GetAsync("/api/family/household");

        var monday = ThisMonday();
        var mealId = await CreateMeal(owner, monday, "Chili", "beans\ntomatoes\nbeef");

        // A fresh meal has no macros yet.
        var fresh = await MealById(owner, monday, mealId);
        fresh.GetProperty("macroSource").GetString().Should().Be("none");
        fresh.GetProperty("calories").GetInt32().Should().Be(0);
        fresh.GetProperty("servings").GetInt32().Should().Be(1);

        // PATCH the dish TOTALS + servings + source (e.g. confirming a manual edit).
        var patched = await owner.PatchAsJsonAsync($"/api/family/meals/{mealId}", new
        {
            servings = 4, calories = 2000, proteinG = 100.0, carbG = 160.0, fatG = 80.0, macroSource = "manual",
        });
        patched.StatusCode.Should().Be(HttpStatusCode.OK);
        var dto = await Json(patched);
        dto.GetProperty("servings").GetInt32().Should().Be(4);
        dto.GetProperty("calories").GetInt32().Should().Be(2000);
        dto.GetProperty("proteinG").GetDouble().Should().Be(100.0);
        dto.GetProperty("macroSource").GetString().Should().Be("manual");

        // The derived per-serving block = total / servings.
        var per = dto.GetProperty("perServing");
        per.GetProperty("calories").GetInt32().Should().Be(500);   // 2000 / 4
        per.GetProperty("proteinG").GetDouble().Should().Be(25.0); // 100 / 4
        per.GetProperty("carbG").GetDouble().Should().Be(40.0);    // 160 / 4
        per.GetProperty("fatG").GetDouble().Should().Be(20.0);     // 80 / 4

        // It round-trips on GET too.
        var got = await MealById(owner, monday, mealId);
        got.GetProperty("perServing").GetProperty("calories").GetInt32().Should().Be(500);
        got.GetProperty("macroSource").GetString().Should().Be("manual");
    }

    [Fact]
    public async Task Patch_clamps_out_of_range_macro_values()
    {
        var (_, owner, _) = await ProvisionUser("family.use");
        await owner.GetAsync("/api/family/household");

        var monday = ThisMonday();
        var mealId = await CreateMeal(owner, monday, "Garbage", "x");

        var dto = await Json(await owner.PatchAsJsonAsync($"/api/family/meals/{mealId}", new
        {
            servings = 9999,      // > 50 → 50
            calories = 9_999_999, // > 20000 → 20000
            proteinG = -10.0,     // negative → 0
            carbG = 50_000.0,     // > 2000 → 2000
            fatG = 30.0,
            macroSource = "bogus", // unknown → "none"
        }));

        dto.GetProperty("servings").GetInt32().Should().Be(50);
        dto.GetProperty("calories").GetInt32().Should().Be(20000);
        dto.GetProperty("proteinG").GetDouble().Should().Be(0);
        dto.GetProperty("carbG").GetDouble().Should().Be(2000);
        dto.GetProperty("fatG").GetDouble().Should().Be(30);
        dto.GetProperty("macroSource").GetString().Should().Be("none");
    }

    // =====================================================================================
    // AI macros + DB refine — gating, household scope, proposal-not-saved, graceful 503
    // =====================================================================================

    [Fact]
    public async Task MealMacrosAi_and_refine_require_family_use()
    {
        var (_, plain, _) = await ProvisionUser("dashboard.view");

        (await plain.PostAsJsonAsync("/api/family/meals/1/ai/macros", new { }))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await plain.PostAsJsonAsync("/api/family/meals/1/macros/refine", new { }))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task MealMacrosAi_and_refine_require_authentication()
    {
        var anon = factory.CreateClient();
        (await anon.PostAsJsonAsync("/api/family/meals/1/ai/macros", new { }))
            .StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await anon.PostAsJsonAsync("/api/family/meals/1/macros/refine", new { }))
            .StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task MealMacrosAi_and_refine_are_404_for_a_foreign_meal_existence_never_leaked()
    {
        var (_, alice, _) = await ProvisionUser("family.use");
        var (_, bob, _) = await ProvisionUser("family.use");
        await alice.GetAsync("/api/family/household");
        await bob.GetAsync("/api/family/household");

        var monday = ThisMonday();
        var aliceMeal = await CreateMeal(alice, monday, "Alice dinner", "rice");

        // Bob (another household) gets 404, NOT 503 — the meal is resolved (and rejected) before AI runs.
        (await bob.PostAsJsonAsync($"/api/family/meals/{aliceMeal}/ai/macros", new { }))
            .StatusCode.Should().Be(HttpStatusCode.NotFound);
        (await bob.PostAsJsonAsync($"/api/family/meals/{aliceMeal}/macros/refine", new { }))
            .StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task MealMacrosAi_is_503_for_own_meal_when_gemini_unconfigured_and_writes_nothing()
    {
        var (_, owner, _) = await ProvisionUser("family.use");
        await owner.GetAsync("/api/family/household");

        var monday = ThisMonday();
        var mealId = await CreateMeal(owner, monday, "Curry", "chicken\nrice\nspices");

        // The test host configures no Gemini key → graceful 503 (never 500) on the caller's OWN meal.
        (await owner.PostAsJsonAsync($"/api/family/meals/{mealId}/ai/macros", new { }))
            .StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);

        // The meal is untouched — the AI endpoint proposes only; it saves nothing.
        var meal = await MealById(owner, monday, mealId);
        meal.GetProperty("macroSource").GetString().Should().Be("none");
        meal.GetProperty("calories").GetInt32().Should().Be(0);
    }

    [Fact]
    public async Task Refine_is_503_for_own_meal_when_usda_unconfigured_and_writes_nothing()
    {
        var (_, owner, _) = await ProvisionUser("family.use");
        await owner.GetAsync("/api/family/household");

        var monday = ThisMonday();
        var mealId = await CreateMeal(owner, monday, "Salad", "2 cup lettuce\n1 tomato");

        // The test host configures no USDA key → graceful 503 (never 500).
        (await owner.PostAsJsonAsync($"/api/family/meals/{mealId}/macros/refine", new { }))
            .StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);

        var meal = await MealById(owner, monday, mealId);
        meal.GetProperty("macroSource").GetString().Should().Be("none");
    }

    // =====================================================================================
    // ADD TO TRACKER — POST /api/tracker/food/from-meal
    // =====================================================================================

    [Fact]
    public async Task FromMeal_requires_tracker_self()
    {
        var (_, plain, _) = await ProvisionUser("family.use"); // family but NOT tracker.self
        (await plain.PostAsJsonAsync("/api/tracker/food/from-meal", new { mealId = 1 }))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task FromMeal_requires_authentication()
    {
        var anon = factory.CreateClient();
        (await anon.PostAsJsonAsync("/api/tracker/food/from-meal", new { mealId = 1 }))
            .StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task FromMeal_is_404_for_a_foreign_household_meal_existence_never_leaked()
    {
        // Alice owns a meal in her household; Bob has tracker.self but is NOT a member of Alice's household.
        var (_, alice, _) = await ProvisionUser("family.use");
        var (_, bob, _) = await ProvisionUser("family.use", "tracker.self");
        await alice.GetAsync("/api/family/household");

        var monday = ThisMonday();
        var aliceMeal = await CreateMeal(alice, monday, "Alice stew", "beef\ncarrots");
        // Give it macros so the ONLY reason for a 404 is the membership check, not the macro guard.
        await alice.PatchAsJsonAsync($"/api/family/meals/{aliceMeal}",
            new { servings = 2, calories = 1000, proteinG = 50.0, carbG = 80.0, fatG = 40.0, macroSource = "manual" });

        (await bob.PostAsJsonAsync("/api/tracker/food/from-meal", new { mealId = aliceMeal }))
            .StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task FromMeal_is_400_when_macros_are_unset()
    {
        var (_, owner, _) = await ProvisionUser("family.use", "tracker.self");
        await owner.GetAsync("/api/family/household");

        var monday = ThisMonday();
        var mealId = await CreateMeal(owner, monday, "No macros", "stuff"); // MacroSource stays "none"

        (await owner.PostAsJsonAsync("/api/tracker/food/from-meal", new { mealId }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task FromMeal_logs_per_serving_macros_for_the_caller_on_the_meal_date()
    {
        var (email, owner, _) = await ProvisionUser("family.use", "tracker.self");
        await owner.GetAsync("/api/family/household");

        var monday = ThisMonday();
        var mealId = await CreateMeal(owner, monday, "Family Lasagne", "beef\npasta\ncheese");
        // Dish TOTAL: 3200 cal across 8 servings → per-serving 400 cal, 22.5 P, 30 C, 14 F.
        await owner.PatchAsJsonAsync($"/api/family/meals/{mealId}", new
        {
            servings = 8, calories = 3200, proteinG = 180.0, carbG = 240.0, fatG = 112.0, macroSource = "ai",
        });

        var res = await owner.PostAsJsonAsync("/api/tracker/food/from-meal", new { mealId });
        res.StatusCode.Should().Be(HttpStatusCode.OK);
        var entry = await Json(res);
        entry.GetProperty("description").GetString().Should().Be("Family Lasagne");
        entry.GetProperty("quantity").GetDouble().Should().Be(1);
        entry.GetProperty("calories").GetInt32().Should().Be(400);    // 3200 / 8
        entry.GetProperty("proteinG").GetDouble().Should().Be(22.5);  // 180 / 8
        entry.GetProperty("carbG").GetDouble().Should().Be(30.0);     // 240 / 8
        entry.GetProperty("fatG").GetDouble().Should().Be(14.0);      // 112 / 8
        entry.GetRawText().Should().NotContain("@");

        // It lands on the meal's own date (no localDate override) in the caller's day, contributing its calories.
        var day = await Json(await owner.GetAsync($"/api/tracker/day?date={monday}"));
        var foods = day.GetProperty("foods").EnumerateArray().ToList();
        foods.Select(f => f.GetProperty("description").GetString()).Should().Contain("Family Lasagne");
        var logged = foods.Single(f => f.GetProperty("id").GetInt64() == entry.GetProperty("id").GetInt64());
        logged.GetProperty("calories").GetInt32().Should().Be(400);
    }

    [Fact]
    public async Task FromMeal_honours_an_explicit_localDate_override()
    {
        var (_, owner, _) = await ProvisionUser("family.use", "tracker.self");
        await owner.GetAsync("/api/family/household");

        var monday = ThisMonday();
        var tuesday = DateOnly.Parse(monday).AddDays(1).ToString("yyyy-MM-dd");
        var mealId = await CreateMeal(owner, monday, "Soup", "broth");
        await owner.PatchAsJsonAsync($"/api/family/meals/{mealId}", new
        {
            servings = 2, calories = 400, proteinG = 20.0, carbG = 40.0, fatG = 10.0, macroSource = "database",
        });

        var res = await owner.PostAsJsonAsync("/api/tracker/food/from-meal", new { mealId, localDate = tuesday });
        res.StatusCode.Should().Be(HttpStatusCode.OK);
        var loggedId = (await Json(res)).GetProperty("id").GetInt64();

        // Logged on TUESDAY (the override), not the meal's Monday date.
        var tueDay = await Json(await owner.GetAsync($"/api/tracker/day?date={tuesday}"));
        tueDay.GetProperty("foods").EnumerateArray().Select(f => f.GetProperty("id").GetInt64())
            .Should().Contain(loggedId);
        var monDay = await Json(await owner.GetAsync($"/api/tracker/day?date={monday}"));
        monDay.GetProperty("foods").EnumerateArray().Select(f => f.GetProperty("id").GetInt64())
            .Should().NotContain(loggedId);
    }
}
