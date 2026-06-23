using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using FluentAssertions;

namespace Ccusage.Api.Tests.Integration;

/// <summary>
/// "✨ What should I eat?" — POST /api/ai/what-to-eat. The macro-aware suggester is a READ endpoint that
/// aggregates the CALLER's own context server-side (today's macros + goal, recent foods, on-hand groceries,
/// planned meals) and asks Gemini for options that fit the REMAINING budget. Unlike the rest of /api/ai it
/// NEVER 503s: when Gemini is unconfigured (the test host always is) it returns 200 with a friendly NON-AI
/// fallback list (<c>aiUsed:false</c>) built from the caller's planned meals / groceries.
///
/// These tests verify: the tracker.ai gate (401 anon / 403 tracker.self-only / allowed with tracker.ai), the
/// always-200 floor + its shape, the caller-scoping invariant (the fallback reflects ONLY the caller's own
/// household — never another user's planned meals — and never an email), and the reused action writes
/// (POST /tracker/food with an option's macros bumps the day; the missing→grocery path appends + de-dupes).
/// </summary>
[Collection(IntegrationCollection.Name)]
public class WhatToEatTests(WebAppFactory factory)
{
    /// <summary>Server "today" in the test host: no DisplayTimeZone is seeded, so TodayAsync resolves to UTC.</summary>
    private static readonly string Today = DateOnly.FromDateTime(DateTime.UtcNow).ToString("yyyy-MM-dd");

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

    private async Task<(string email, HttpClient client)> ProvisionUser(params string[] permissions)
    {
        var email = $"eat-{Guid.NewGuid():N}@test.local";
        var res = await Admin().PostAsJsonAsync("/api/users", new { email, isEnabled = true, permissions });
        res.StatusCode.Should().Be(HttpStatusCode.Created);
        return (email, Client(email));
    }

    private static async Task<JsonElement> Json(HttpResponseMessage resp) =>
        JsonDocument.Parse(await resp.Content.ReadAsStringAsync()).RootElement.Clone();

    /// <summary>Auto-provision the caller's household (GET /household does this on first hit for a family.use user).</summary>
    private static async Task EnsureHousehold(HttpClient c) => await c.GetAsync("/api/family/household");

    // =====================================================================================
    // Gating: anonymous → 401; tracker.self alone → 403; tracker.ai → allowed.
    // =====================================================================================

    [Fact]
    public async Task Anonymous_is_401()
    {
        var anon = factory.CreateClient();
        (await anon.PostAsJsonAsync("/api/ai/what-to-eat", new { }))
            .StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Tracker_self_only_is_403()
    {
        var (_, selfOnly) = await ProvisionUser("tracker.self");
        (await selfOnly.PostAsJsonAsync("/api/ai/what-to-eat", new { }))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Tracker_ai_is_allowed_and_returns_200_even_with_ai_off()
    {
        var (_, user) = await ProvisionUser("tracker.ai");
        var res = await user.PostAsJsonAsync("/api/ai/what-to-eat", new { });
        // The defining property of this endpoint: NEVER 503/500 — it floors to the friendly fallback.
        res.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await Json(res);
        body.GetProperty("aiUsed").GetBoolean().Should().BeFalse(); // test host has no Gemini key
        body.TryGetProperty("options", out var opts).Should().BeTrue();
        opts.ValueKind.Should().Be(JsonValueKind.Array);
    }

    // =====================================================================================
    // Floor path (AI off): the fallback is sourced from the caller's planned meals + groceries.
    // =====================================================================================

    [Fact]
    public async Task Fallback_lists_options_from_the_callers_planned_meals_and_matches_the_frontend_shape()
    {
        var (_, user) = await ProvisionUser("tracker.ai", "tracker.self", "family.use");
        await EnsureHousehold(user);

        // Seed a planned meal in the next-7-days window the fallback reads.
        (await user.PostAsJsonAsync("/api/family/meals",
            new { localDate = Today, slot = "dinner", title = "Sheet-pan chicken" }))
            .StatusCode.Should().Be(HttpStatusCode.OK);

        var body = await Json(await user.PostAsJsonAsync("/api/ai/what-to-eat", new { craving = "high protein" }));
        body.GetProperty("aiUsed").GetBoolean().Should().BeFalse();

        var options = body.GetProperty("options").EnumerateArray().ToList();
        options.Should().NotBeEmpty();
        var first = options[0];

        // Field-for-field shape the frontend EatOption consumes (camelCase, non-null arrays, MacroSet keys).
        first.GetProperty("title").GetString().Should().Be("Sheet-pan chicken");
        first.GetProperty("why").GetString().Should().NotBeNullOrEmpty();
        var macros = first.GetProperty("macros");
        macros.GetProperty("calories").ValueKind.Should().Be(JsonValueKind.Number);
        macros.TryGetProperty("proteinG", out _).Should().BeTrue();
        macros.TryGetProperty("carbsG", out _).Should().BeTrue();
        macros.TryGetProperty("fatG", out _).Should().BeTrue();
        first.GetProperty("have").ValueKind.Should().Be(JsonValueKind.Array);
        first.GetProperty("missing").ValueKind.Should().Be(JsonValueKind.Array);
        first.GetProperty("steps").ValueKind.Should().Be(JsonValueKind.Array);
    }

    // =====================================================================================
    // SCOPING (security): the response reflects ONLY the caller's own household — never user B's
    // planned meals, and never an email anywhere on the wire.
    // =====================================================================================

    [Fact]
    public async Task Aggregator_is_caller_scoped_no_cross_user_meals_or_email()
    {
        // User A: own household + a uniquely-titled planned meal + logged + recent food.
        var (_, alice) = await ProvisionUser("tracker.ai", "tracker.self", "family.use");
        await EnsureHousehold(alice);
        var aliceMeal = $"Alice-{Guid.NewGuid():N}";
        await alice.PostAsJsonAsync("/api/family/meals", new { localDate = Today, slot = "dinner", title = aliceMeal });
        await alice.PostAsJsonAsync("/api/tracker/food", new
        {
            date = Today, meal = "breakfast", description = "AliceOnlyOatmeal", quantity = 1.0,
            calories = 300, proteinG = 10.0, carbG = 54.0, fatG = 5.0,
        });

        // User B: a SEPARATE household with a uniquely-titled meal that must NEVER surface for A.
        var (_, bob) = await ProvisionUser("tracker.ai", "tracker.self", "family.use");
        await EnsureHousehold(bob);
        var bobMeal = $"Bob-{Guid.NewGuid():N}";
        await bob.PostAsJsonAsync("/api/family/meals", new { localDate = Today, slot = "dinner", title = bobMeal });
        await bob.PostAsJsonAsync("/api/tracker/food", new
        {
            date = Today, meal = "lunch", description = "BobOnlySalad", quantity = 1.0,
            calories = 150, proteinG = 5.0, carbG = 10.0, fatG = 8.0,
        });

        var raw = await (await alice.PostAsJsonAsync("/api/ai/what-to-eat", new { })).Content.ReadAsStringAsync();

        raw.Should().Contain(aliceMeal);           // A sees her own planned meal in the fallback
        raw.Should().NotContain(bobMeal);           // ...but NEVER B's
        raw.Should().NotContain("BobOnlySalad");    // ...nor B's foods
        raw.Should().NotContain("@");               // emails never on the wire
    }

    // =====================================================================================
    // Action writes (reused endpoints): an option's macros add to the tracker; missing → grocery.
    // =====================================================================================

    [Fact]
    public async Task Adding_an_option_to_the_tracker_bumps_the_day_by_its_macros()
    {
        var (_, user) = await ProvisionUser("tracker.ai", "tracker.self");

        var before = await Json(await user.GetAsync($"/api/tracker/day?date={Today}"));
        var beforeCal = before.GetProperty("caloriesIn").GetInt32();

        // Simulate the dialog's addToTracker action with an option's own macros (no second AI round-trip).
        var add = await user.PostAsJsonAsync("/api/tracker/food", new
        {
            date = Today, meal = "dinner", description = "Greek yogurt bowl", quantity = 1,
            calories = 220, proteinG = 20, carbG = 18, fatG = 6,
        });
        add.StatusCode.Should().Be(HttpStatusCode.OK);

        var after = await Json(await user.GetAsync($"/api/tracker/day?date={Today}"));
        after.GetProperty("caloriesIn").GetInt32().Should().Be(beforeCal + 220);
        after.GetProperty("proteinG").GetDouble().Should().BeGreaterThanOrEqualTo(20);
    }

    [Fact]
    public async Task Adding_missing_items_to_grocery_appends_and_dedupes()
    {
        var (_, user) = await ProvisionUser("tracker.ai", "family.use");
        await EnsureHousehold(user);

        // The dialog's addMissingToGrocery action reuses the recipe-breakdown/to-grocery endpoint.
        var first = await Json(await user.PostAsJsonAsync("/api/family/meals/recipe-breakdown/to-grocery",
            new { items = new[] { "feta", "cucumber", "feta" } })); // dup feta within batch
        var texts = first.GetProperty("items").EnumerateArray()
            .Select(i => i.GetProperty("text").GetString()).ToList();
        texts.Should().Contain(new[] { "feta", "cucumber" });
        texts.Count(t => t == "feta").Should().Be(1);

        // Re-adding an already-open item doesn't duplicate it.
        var again = await Json(await user.PostAsJsonAsync("/api/family/meals/recipe-breakdown/to-grocery",
            new { items = new[] { "feta" } }));
        again.GetProperty("items").EnumerateArray().Count(i => i.GetProperty("text").GetString() == "feta")
            .Should().Be(1);
    }
}
