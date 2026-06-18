using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using FluentAssertions;

namespace Ccusage.Api.Tests.Integration;

/// <summary>
/// Food &amp; fitness tracker: profile default-create + update round-trip; add/delete food + exercise
/// (own only); the day-summary roll-up (caloriesIn/out/net + macros + remaining vs goal); the MET-based
/// calorie estimate (computed when a library exercise + duration + profile weight are present); the
/// seeded exercise library + goal filter; the VISIBILITY rules (a non-sharing user's day is 404 to a
/// contact, a shared user's day is visible to a mutual contact, tracker.viewall sees anyone, and writes
/// to a non-self user are rejected); and the USDA endpoints returning 503 when unconfigured (no API key
/// is set in the test environment). Every test provisions fresh users so they're order-independent.
/// </summary>
[Collection(IntegrationCollection.Name)]
public class TrackerIntegrationTests(WebAppFactory factory)
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

    private async Task<(string email, HttpClient client)> ProvisionUser(params string[] permissions)
    {
        var email = $"trk-{Guid.NewGuid():N}@test.local";
        var res = await Admin().PostAsJsonAsync("/api/users", new { email, isEnabled = true, permissions });
        res.StatusCode.Should().Be(HttpStatusCode.Created);
        return (email, Client(email));
    }

    private static async Task<JsonElement> Json(HttpResponseMessage resp) =>
        await resp.Content.ReadFromJsonAsync<JsonElement>();

    /// <summary>Make A and B mutual chat contacts (admin-managed, writes both directions).</summary>
    private async Task MakeContacts(string aEmail, string bEmail)
    {
        var res = await Admin().PostAsJsonAsync($"/api/chat/contacts/user/{aEmail}", new { contactEmail = bEmail });
        res.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    private const string Today = "2026-06-17";

    // ---- Permission gating ----

    [Fact]
    public async Task Tracker_endpoints_require_authentication()
    {
        var anon = factory.CreateClient();
        (await anon.GetAsync("/api/tracker/profile")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await anon.GetAsync($"/api/tracker/day?date={Today}")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await anon.GetAsync("/api/foods/search?q=apple")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Tracker_endpoints_require_tracker_self()
    {
        var (_, noTracker) = await ProvisionUser("dashboard.view");
        (await noTracker.GetAsync("/api/tracker/profile")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await noTracker.GetAsync($"/api/tracker/day?date={Today}")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await noTracker.GetAsync("/api/tracker/exercises")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await noTracker.GetAsync("/api/foods/search?q=apple")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    // ---- Profile: default create + update round-trip ----

    [Fact]
    public async Task Profile_is_created_with_defaults_then_round_trips_an_update()
    {
        var (_, user) = await ProvisionUser("tracker.self");

        // First GET lazily creates a default row: Maintain, no sharing, no goals.
        var first = await user.GetAsync("/api/tracker/profile");
        first.StatusCode.Should().Be(HttpStatusCode.OK);
        var p = await Json(first);
        p.GetProperty("goal").GetString().Should().Be("Maintain");
        p.GetProperty("shareWithContacts").GetBoolean().Should().BeFalse();
        p.GetProperty("dailyCalorieGoal").ValueKind.Should().Be(JsonValueKind.Null);

        // Update and read it back.
        var put = await user.PutAsJsonAsync("/api/tracker/profile", new
        {
            goal = "LoseWeight",
            weightKg = 80.0,
            dailyCalorieGoal = 2000,
            proteinGoalG = 150,
            carbGoalG = 200,
            fatGoalG = 60,
            shareWithContacts = true,
        });
        put.StatusCode.Should().Be(HttpStatusCode.OK);

        var saved = await Json(await user.GetAsync("/api/tracker/profile"));
        saved.GetProperty("goal").GetString().Should().Be("LoseWeight");
        saved.GetProperty("weightKg").GetDouble().Should().Be(80.0);
        saved.GetProperty("dailyCalorieGoal").GetInt32().Should().Be(2000);
        saved.GetProperty("proteinGoalG").GetInt32().Should().Be(150);
        saved.GetProperty("shareWithContacts").GetBoolean().Should().BeTrue();
    }

    // ---- Food: add + delete own ----

    [Fact]
    public async Task Adding_then_deleting_a_food_works_and_shows_on_the_day()
    {
        var (_, user) = await ProvisionUser("tracker.self");

        var add = await user.PostAsJsonAsync("/api/tracker/food", new
        {
            date = Today, meal = "breakfast", description = "Oatmeal", quantity = 1.0,
            calories = 300, proteinG = 10.0, carbG = 54.0, fatG = 5.0,
        });
        add.StatusCode.Should().Be(HttpStatusCode.OK);
        var food = await Json(add);
        var foodId = food.GetProperty("id").GetInt64();
        food.GetProperty("meal").GetString().Should().Be("breakfast");

        // It appears on the day.
        var day = await Json(await user.GetAsync($"/api/tracker/day?date={Today}"));
        day.GetProperty("foods").EnumerateArray().Should().ContainSingle();
        day.GetProperty("caloriesIn").GetInt32().Should().Be(300);

        // Delete it.
        (await user.DeleteAsync($"/api/tracker/food/{foodId}")).StatusCode.Should().Be(HttpStatusCode.NoContent);
        var after = await Json(await user.GetAsync($"/api/tracker/day?date={Today}"));
        after.GetProperty("foods").EnumerateArray().Should().BeEmpty();
        after.GetProperty("caloriesIn").GetInt32().Should().Be(0);
    }

    [Fact]
    public async Task Deleting_a_food_you_dont_own_is_404()
    {
        var (_, owner) = await ProvisionUser("tracker.self");
        var (_, other) = await ProvisionUser("tracker.self");

        var add = await owner.PostAsJsonAsync("/api/tracker/food", new
        {
            date = Today, meal = "lunch", description = "Salad", quantity = 1.0,
            calories = 150, proteinG = 5.0, carbG = 10.0, fatG = 8.0,
        });
        var foodId = (await Json(add)).GetProperty("id").GetInt64();

        // Another tracker.self user can't delete it (404, not 403 — never reveal the row).
        (await other.DeleteAsync($"/api/tracker/food/{foodId}")).StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    // ---- Day summary roll-up: in/out/net + macros + remaining vs goal ----

    [Fact]
    public async Task Day_summary_rolls_up_calories_macros_and_remaining_vs_goal()
    {
        var (_, user) = await ProvisionUser("tracker.self");
        await user.PutAsJsonAsync("/api/tracker/profile", new
        {
            goal = "Maintain", weightKg = 70.0, dailyCalorieGoal = 2000, shareWithContacts = false,
        });

        await user.PostAsJsonAsync("/api/tracker/food", new
        {
            date = Today, meal = "breakfast", description = "Eggs", quantity = 1.0,
            calories = 200, proteinG = 12.0, carbG = 2.0, fatG = 14.0,
        });
        await user.PostAsJsonAsync("/api/tracker/food", new
        {
            date = Today, meal = "lunch", description = "Chicken & rice", quantity = 1.0,
            calories = 600, proteinG = 45.0, carbG = 60.0, fatG = 12.0,
        });
        // A manual exercise (explicit calories burned).
        await user.PostAsJsonAsync("/api/tracker/exercise", new
        {
            date = Today, name = "Evening walk", durationMin = 30, caloriesBurned = 150,
        });

        var day = await Json(await user.GetAsync($"/api/tracker/day?date={Today}"));
        day.GetProperty("caloriesIn").GetInt32().Should().Be(800);
        day.GetProperty("caloriesOut").GetInt32().Should().Be(150);
        day.GetProperty("netCalories").GetInt32().Should().Be(650);
        day.GetProperty("proteinG").GetDouble().Should().Be(57.0);
        day.GetProperty("carbG").GetDouble().Should().Be(62.0);
        day.GetProperty("fatG").GetDouble().Should().Be(26.0);
        day.GetProperty("calorieGoal").GetInt32().Should().Be(2000);
        // remaining = goal - in + out = 2000 - 800 + 150 = 1350.
        day.GetProperty("remaining").GetInt32().Should().Be(1350);
        day.GetProperty("readOnly").GetBoolean().Should().BeFalse();
    }

    // ---- MET estimate: computed when library exercise + duration + weight present ----

    [Fact]
    public async Task Exercise_calories_are_estimated_from_met_when_omitted()
    {
        var (_, user) = await ProvisionUser("tracker.self");
        await user.PutAsJsonAsync("/api/tracker/profile", new
        {
            goal = "LoseWeight", weightKg = 70.0, shareWithContacts = false,
        });

        // Pick a library exercise to get a real id + MET.
        var lib = (await Json(await user.GetAsync("/api/tracker/exercises?goal=LoseWeight"))).EnumerateArray().ToList();
        lib.Should().NotBeEmpty();
        var first = lib[0];
        var exId = first.GetProperty("id").GetInt32();
        var met = first.GetProperty("met").GetDouble();

        // Log it with a duration but NO caloriesBurned → server estimates round(MET * 70 * 30/60).
        var add = await user.PostAsJsonAsync("/api/tracker/exercise", new
        {
            date = Today, exerciseId = exId, durationMin = 30,
        });
        add.StatusCode.Should().Be(HttpStatusCode.OK);
        var expected = (int)Math.Round(met * 70.0 * (30 / 60.0));
        (await Json(add)).GetProperty("caloriesBurned").GetInt32().Should().Be(expected);
    }

    [Fact]
    public async Task Exercise_without_calories_or_weight_is_rejected()
    {
        var (_, user) = await ProvisionUser("tracker.self");
        // Profile has no weight, so a library exercise + duration cannot be estimated.
        await user.PutAsJsonAsync("/api/tracker/profile", new { goal = "Maintain", shareWithContacts = false });

        var lib = (await Json(await user.GetAsync("/api/tracker/exercises"))).EnumerateArray().First();
        var exId = lib.GetProperty("id").GetInt32();

        var add = await user.PostAsJsonAsync("/api/tracker/exercise", new
        {
            date = Today, exerciseId = exId, durationMin = 30,
        });
        add.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Deleting_an_exercise_you_dont_own_is_404()
    {
        var (_, owner) = await ProvisionUser("tracker.self");
        var (_, other) = await ProvisionUser("tracker.self");

        var add = await owner.PostAsJsonAsync("/api/tracker/exercise", new
        {
            date = Today, name = "Pushups", caloriesBurned = 50,
        });
        var exId = (await Json(add)).GetProperty("id").GetInt64();
        (await other.DeleteAsync($"/api/tracker/exercise/{exId}")).StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    // ---- Exercise library: seeded + goal filter ----

    [Fact]
    public async Task Exercise_library_is_seeded_and_filterable_by_goal()
    {
        var (_, user) = await ProvisionUser("tracker.self");

        var all = (await Json(await user.GetAsync("/api/tracker/exercises?goal="))).EnumerateArray().ToList();
        all.Should().NotBeEmpty(); // seeded set

        var lose = (await Json(await user.GetAsync("/api/tracker/exercises?goal=LoseWeight"))).EnumerateArray().ToList();
        lose.Should().NotBeEmpty();
        // Every returned activity must actually carry the requested goal tag.
        lose.Should().OnlyContain(e =>
            e.GetProperty("goals").EnumerateArray().Any(g => g.GetString() == "LoseWeight"));

        var gain = (await Json(await user.GetAsync("/api/tracker/exercises?goal=GainMuscle"))).EnumerateArray().ToList();
        gain.Should().OnlyContain(e =>
            e.GetProperty("goals").EnumerateArray().Any(g => g.GetString() == "GainMuscle"));
    }

    // ---- Visibility: own day always readable + writable ----

    [Fact]
    public async Task Own_day_is_always_readable_and_writable()
    {
        var (email, user) = await ProvisionUser("tracker.self");
        var day = await Json(await user.GetAsync($"/api/tracker/day?date={Today}&user={email}"));
        day.GetProperty("readOnly").GetBoolean().Should().BeFalse();
        day.GetProperty("userEmail").GetString().Should().Be(email);
    }

    // ---- Visibility: a non-sharing user's day is 404 to a contact ----

    [Fact]
    public async Task A_non_sharing_users_day_is_404_to_a_mutual_contact()
    {
        var (aliceEmail, alice) = await ProvisionUser("tracker.self");
        var (bobEmail, bob) = await ProvisionUser("tracker.self");
        await MakeContacts(aliceEmail, bobEmail);

        // Alice keeps sharing OFF (the default).
        await alice.PutAsJsonAsync("/api/tracker/profile", new { goal = "Maintain", shareWithContacts = false });

        // Bob (a mutual contact) cannot see Alice's day → 404 (don't leak existence).
        (await bob.GetAsync($"/api/tracker/day?date={Today}&user={aliceEmail}"))
            .StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    // ---- Visibility: a sharing user's day is visible to a mutual contact (read-only) ----

    [Fact]
    public async Task A_sharing_users_day_is_visible_read_only_to_a_mutual_contact()
    {
        var (aliceEmail, alice) = await ProvisionUser("tracker.self");
        var (bobEmail, bob) = await ProvisionUser("tracker.self");
        await MakeContacts(aliceEmail, bobEmail);

        await alice.PutAsJsonAsync("/api/tracker/profile", new { goal = "Maintain", shareWithContacts = true });
        await alice.PostAsJsonAsync("/api/tracker/food", new
        {
            date = Today, meal = "dinner", description = "Pasta", quantity = 1.0,
            calories = 500, proteinG = 18.0, carbG = 80.0, fatG = 10.0,
        });

        var day = await Json(await bob.GetAsync($"/api/tracker/day?date={Today}&user={aliceEmail}"));
        day.GetProperty("readOnly").GetBoolean().Should().BeTrue();
        day.GetProperty("userEmail").GetString().Should().Be(aliceEmail);
        day.GetProperty("caloriesIn").GetInt32().Should().Be(500);

        // A non-contact (sharing on, but no mutual circle) still gets 404.
        var (_, stranger) = await ProvisionUser("tracker.self");
        (await stranger.GetAsync($"/api/tracker/day?date={Today}&user={aliceEmail}"))
            .StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    // ---- Visibility: tracker.viewall sees anyone ----

    [Fact]
    public async Task Tracker_viewall_can_read_anyones_day_even_without_sharing()
    {
        var (aliceEmail, alice) = await ProvisionUser("tracker.self");
        var (_, coach) = await ProvisionUser("tracker.self", "tracker.viewall");

        // Alice does NOT share and is NOT a contact of the coach.
        await alice.PutAsJsonAsync("/api/tracker/profile", new { goal = "Maintain", shareWithContacts = false });
        await alice.PostAsJsonAsync("/api/tracker/food", new
        {
            date = Today, meal = "snack", description = "Apple", quantity = 1.0,
            calories = 95, proteinG = 0.5, carbG = 25.0, fatG = 0.3,
        });

        var day = await Json(await coach.GetAsync($"/api/tracker/day?date={Today}&user={aliceEmail}"));
        day.GetProperty("readOnly").GetBoolean().Should().BeTrue();
        day.GetProperty("caloriesIn").GetInt32().Should().Be(95);
    }

    // ---- Visibility: writes are owner-only (viewall does not grant write) ----

    [Fact]
    public async Task Writes_always_target_the_caller_never_another_user()
    {
        var (aliceEmail, alice) = await ProvisionUser("tracker.self");
        var (coachEmail, coach) = await ProvisionUser("tracker.self", "tracker.viewall");

        // The coach logs a food "on date Today" — there is no user param on writes, so it lands on the
        // COACH's own log, never Alice's. Verify Alice's day stays empty and the coach's has the entry.
        await coach.PostAsJsonAsync("/api/tracker/food", new
        {
            date = Today, meal = "breakfast", description = "Coach's coffee", quantity = 1.0,
            calories = 5, proteinG = 0.0, carbG = 1.0, fatG = 0.0,
        });

        var aliceDay = await Json(await alice.GetAsync($"/api/tracker/day?date={Today}"));
        aliceDay.GetProperty("foods").EnumerateArray().Should().BeEmpty();

        var coachDay = await Json(await coach.GetAsync($"/api/tracker/day?date={Today}&user={coachEmail}"));
        coachDay.GetProperty("foods").EnumerateArray().Should().ContainSingle();
    }

    // ---- Shared list: mutual sharing contacts + viewall sees everyone ----

    [Fact]
    public async Task Shared_list_includes_sharing_contacts_and_viewall_sees_everyone()
    {
        var (aliceEmail, alice) = await ProvisionUser("tracker.self");
        var (bobEmail, bob) = await ProvisionUser("tracker.self");
        await MakeContacts(aliceEmail, bobEmail);

        // Alice shares → Bob's shared list includes Alice.
        await alice.PutAsJsonAsync("/api/tracker/profile", new { goal = "Maintain", shareWithContacts = true });
        var bobShared = (await Json(await bob.GetAsync("/api/tracker/shared")))
            .EnumerateArray().Select(u => u.GetProperty("email").GetString()).ToList();
        bobShared.Should().Contain(aliceEmail);

        // Alice does NOT see Bob (Bob isn't sharing).
        var aliceShared = (await Json(await alice.GetAsync("/api/tracker/shared")))
            .EnumerateArray().Select(u => u.GetProperty("email").GetString()).ToList();
        aliceShared.Should().NotContain(bobEmail);

        // A viewall coach sees everyone (including non-sharing, non-contact users).
        var (_, coach) = await ProvisionUser("tracker.self", "tracker.viewall");
        var coachShared = (await Json(await coach.GetAsync("/api/tracker/shared")))
            .EnumerateArray().Select(u => u.GetProperty("email").GetString()).ToList();
        coachShared.Should().Contain(aliceEmail).And.Contain(bobEmail);
    }

    // ---- USDA: 503 when unconfigured (no API key in the test environment) ----

    [Fact]
    public async Task Usda_food_endpoints_return_503_when_unconfigured()
    {
        var (_, user) = await ProvisionUser("tracker.self");

        var search = await user.GetAsync("/api/foods/search?q=apple");
        search.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);

        var details = await user.GetAsync("/api/foods/12345");
        details.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);

        // The rest of the tracker still works even with USDA off.
        (await user.GetAsync("/api/tracker/profile")).StatusCode.Should().Be(HttpStatusCode.OK);
    }
}
