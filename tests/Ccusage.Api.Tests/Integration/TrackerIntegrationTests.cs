using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Ccusage.Api.Data;
using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

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

    private static bool HasProperty(JsonElement e, string name) => e.TryGetProperty(name, out _);

    /// <summary>Make A and B mutual chat contacts (admin-managed, writes both directions). The contacts
    /// admin endpoint is keyed by AppUser id (email-privacy), so resolve each email -> id first.</summary>
    private async Task MakeContacts(string aEmail, string bEmail)
    {
        var aId = await UserIdFor(aEmail);
        var bId = await UserIdFor(bEmail);
        var res = await Admin().PostAsJsonAsync($"/api/chat/contacts/user/{aId}", new { contactUserId = bId });
        res.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    /// <summary>Resolve a provisioned user's AppUser id by their email (the contacts/DM endpoints now
    /// address users by id, never email).</summary>
    private async Task<int> UserIdFor(string email)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        return await db.Users.AsNoTracking().Where(u => u.Email == email).Select(u => u.Id).FirstAsync();
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
        var userId = await UserIdFor(email);
        var day = await Json(await user.GetAsync($"/api/tracker/day?date={Today}&user={userId}"));
        day.GetProperty("readOnly").GetBoolean().Should().BeFalse();
        day.GetProperty("userId").GetInt32().Should().Be(userId);
        day.TryGetProperty("userEmail", out _).Should().BeFalse();
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
        var aliceId = await UserIdFor(aliceEmail);
        (await bob.GetAsync($"/api/tracker/day?date={Today}&user={aliceId}"))
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

        var aliceId = await UserIdFor(aliceEmail);
        var day = await Json(await bob.GetAsync($"/api/tracker/day?date={Today}&user={aliceId}"));
        day.GetProperty("readOnly").GetBoolean().Should().BeTrue();
        day.GetProperty("userId").GetInt32().Should().Be(aliceId);
        day.TryGetProperty("userEmail", out _).Should().BeFalse();
        day.GetProperty("caloriesIn").GetInt32().Should().Be(500);

        // A non-contact (sharing on, but no mutual circle) still gets 404.
        var (_, stranger) = await ProvisionUser("tracker.self");
        (await stranger.GetAsync($"/api/tracker/day?date={Today}&user={aliceId}"))
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

        var aliceId = await UserIdFor(aliceEmail);
        var day = await Json(await coach.GetAsync($"/api/tracker/day?date={Today}&user={aliceId}"));
        day.GetProperty("readOnly").GetBoolean().Should().BeTrue();
        day.GetProperty("caloriesIn").GetInt32().Should().Be(95);
    }

    // ---- Inbound ?user={userId} validation: bad id 400, non-user/forbidden 404 ----

    [Fact]
    public async Task Day_user_param_validates_the_user_id()
    {
        var (_, user) = await ProvisionUser("tracker.self");

        // A non-positive id is a bad request (the param is a user id, not an email).
        (await user.GetAsync($"/api/tracker/day?date={Today}&user=0"))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await user.GetAsync($"/api/tracker/day?date={Today}&user=-3"))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);

        // An id that resolves to no user is a 404 (never leak existence).
        (await user.GetAsync($"/api/tracker/day?date={Today}&user=999999999"))
            .StatusCode.Should().Be(HttpStatusCode.NotFound);

        // A real, existing user the caller may NOT view is also 404 (forbidden == non-existent).
        var (otherEmail, _) = await ProvisionUser("tracker.self");
        var otherId = await UserIdFor(otherEmail);
        (await user.GetAsync($"/api/tracker/day?date={Today}&user={otherId}"))
            .StatusCode.Should().Be(HttpStatusCode.NotFound);
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

        var coachId = await UserIdFor(coachEmail);
        var coachDay = await Json(await coach.GetAsync($"/api/tracker/day?date={Today}&user={coachId}"));
        coachDay.GetProperty("foods").EnumerateArray().Should().ContainSingle();
    }

    // ---- Shared list: mutual sharing contacts + viewall sees everyone ----

    [Fact]
    public async Task Shared_list_includes_sharing_contacts_and_viewall_sees_everyone()
    {
        var (aliceEmail, alice) = await ProvisionUser("tracker.self");
        var (bobEmail, bob) = await ProvisionUser("tracker.self");
        await MakeContacts(aliceEmail, bobEmail);

        var aliceId = await UserIdFor(aliceEmail);
        var bobId = await UserIdFor(bobEmail);

        // Alice shares → Bob's shared list includes Alice. The shared list identifies people by userId +
        // name + picture — never an email (email-privacy).
        await alice.PutAsJsonAsync("/api/tracker/profile", new { goal = "Maintain", shareWithContacts = true });
        var bobShared = (await Json(await bob.GetAsync("/api/tracker/shared"))).EnumerateArray().ToList();
        bobShared.Select(u => u.GetProperty("userId").GetInt32()).Should().Contain(aliceId);
        bobShared.Should().NotContain(u => HasProperty(u, "email"));

        // Alice does NOT see Bob (Bob isn't sharing).
        var aliceShared = (await Json(await alice.GetAsync("/api/tracker/shared")))
            .EnumerateArray().Select(u => u.GetProperty("userId").GetInt32()).ToList();
        aliceShared.Should().NotContain(bobId);

        // A viewall coach sees everyone (including non-sharing, non-contact users).
        var (_, coach) = await ProvisionUser("tracker.self", "tracker.viewall");
        var coachShared = (await Json(await coach.GetAsync("/api/tracker/shared")))
            .EnumerateArray().Select(u => u.GetProperty("userId").GetInt32()).ToList();
        coachShared.Should().Contain(aliceId).And.Contain(bobId);
    }

    // ---- Profile: the full-fitness body fields round-trip ----

    [Fact]
    public async Task Profile_round_trips_the_full_fitness_body_fields()
    {
        var (_, user) = await ProvisionUser("tracker.self");

        var put = await user.PutAsJsonAsync("/api/tracker/profile", new
        {
            goal = "LoseWeight",
            weightKg = 80.0,
            shareWithContacts = false,
            dateOfBirth = "1990-01-01",
            heightCm = 180.0,
            sex = "Male",
            activityLevel = "Moderate",
            goalWeightKg = 72.0,
            unitSystem = "Imperial",
        });
        put.StatusCode.Should().Be(HttpStatusCode.OK);

        var saved = await Json(await user.GetAsync("/api/tracker/profile"));
        saved.GetProperty("dateOfBirth").GetString().Should().Be("1990-01-01");
        saved.GetProperty("heightCm").GetDouble().Should().Be(180.0);
        saved.GetProperty("sex").GetString().Should().Be("Male");
        saved.GetProperty("activityLevel").GetString().Should().Be("Moderate");
        saved.GetProperty("goalWeightKg").GetDouble().Should().Be(72.0);
        saved.GetProperty("unitSystem").GetString().Should().Be("Imperial");
    }

    // ---- Stats: computed on the day from the profile (BMI/BMR/TDEE/suggestions) ----

    [Fact]
    public async Task Day_stats_are_computed_from_the_profile()
    {
        var (_, user) = await ProvisionUser("tracker.self");
        await user.PutAsJsonAsync("/api/tracker/profile", new
        {
            goal = "Maintain",
            weightKg = 80.0,
            heightCm = 180.0,
            dateOfBirth = "1990-01-01", // birthday in January → age stable regardless of "today"
            sex = "Male",
            activityLevel = "Sedentary",
            shareWithContacts = false,
        });

        var day = await Json(await user.GetAsync($"/api/tracker/day?date={Today}"));
        var stats = day.GetProperty("stats");
        stats.ValueKind.Should().Be(JsonValueKind.Object);
        // BMI = 80 / 1.8^2 = 24.7, Normal.
        stats.GetProperty("bmi").GetDouble().Should().Be(24.7);
        stats.GetProperty("bmiCategory").GetString().Should().Be("Normal");
        // Male BMR = 10*80 + 6.25*180 - 5*36 + 5 = 1750; Sedentary TDEE = 1750*1.2 = 2100.
        stats.GetProperty("bmr").GetInt32().Should().Be(1750);
        stats.GetProperty("tdee").GetInt32().Should().Be(2100);
        stats.GetProperty("suggestedCalorieGoal").GetInt32().Should().Be(2100); // Maintain
        stats.GetProperty("age").GetInt32().Should().Be(36);
    }

    [Fact]
    public async Task Day_stats_are_partial_when_sex_unspecified()
    {
        var (_, user) = await ProvisionUser("tracker.self");
        await user.PutAsJsonAsync("/api/tracker/profile", new
        {
            goal = "Maintain", weightKg = 80.0, heightCm = 180.0, sex = "Unspecified", shareWithContacts = false,
        });

        var stats = (await Json(await user.GetAsync($"/api/tracker/day?date={Today}"))).GetProperty("stats");
        stats.GetProperty("bmi").GetDouble().Should().Be(24.7);   // BMI present
        stats.GetProperty("bmr").ValueKind.Should().Be(JsonValueKind.Null);  // no BMR without sex
        stats.GetProperty("tdee").ValueKind.Should().Be(JsonValueKind.Null);
    }

    // ---- Stats PRIVACY: NULLED when a sharing contact (or coach) views you ----

    [Fact]
    public async Task Day_stats_are_null_in_the_read_only_branch_for_a_viewer()
    {
        var (aliceEmail, alice) = await ProvisionUser("tracker.self");
        var (bobEmail, bob) = await ProvisionUser("tracker.self");
        await MakeContacts(aliceEmail, bobEmail);

        await alice.PutAsJsonAsync("/api/tracker/profile", new
        {
            goal = "Maintain", weightKg = 80.0, heightCm = 180.0, dateOfBirth = "1990-01-01",
            sex = "Male", activityLevel = "Sedentary", shareWithContacts = true,
        });

        // Alice sees her own stats.
        var own = (await Json(await alice.GetAsync($"/api/tracker/day?date={Today}"))).GetProperty("stats");
        own.ValueKind.Should().Be(JsonValueKind.Object);

        // Bob (a sharing mutual contact) sees the day, but stats are NULL — body metrics don't leak.
        var aliceId = await UserIdFor(aliceEmail);
        var viewed = await Json(await bob.GetAsync($"/api/tracker/day?date={Today}&user={aliceId}"));
        viewed.GetProperty("readOnly").GetBoolean().Should().BeTrue();
        viewed.GetProperty("stats").ValueKind.Should().Be(JsonValueKind.Null);
        // The owner is identified by userId + name, never an email (email-privacy).
        viewed.GetProperty("userId").GetInt32().Should().Be(aliceId);
        viewed.TryGetProperty("userEmail", out _).Should().BeFalse();
        // Weight is nulled too (existing rule).
        viewed.GetProperty("profile").GetProperty("weightKg").ValueKind.Should().Be(JsonValueKind.Null);

        // A coach with viewall also gets NULL stats.
        var (_, coach) = await ProvisionUser("tracker.self", "tracker.viewall");
        var coachView = await Json(await coach.GetAsync($"/api/tracker/day?date={Today}&user={aliceId}"));
        coachView.GetProperty("stats").ValueKind.Should().Be(JsonValueKind.Null);
    }

    // ---- Weight: upsert one-per-day + current weight tracks the latest-dated entry ----

    [Fact]
    public async Task Logging_weight_upserts_one_per_day_and_tracks_the_latest_dated_entry()
    {
        var (_, user) = await ProvisionUser("tracker.self");

        // Log an older day first, then a newer day; current weight should follow the newest DATE.
        var older = await user.PostAsJsonAsync("/api/tracker/weight", new { date = "2026-06-10", weightKg = 82.0 });
        older.StatusCode.Should().Be(HttpStatusCode.OK);
        (await Json(older)).GetProperty("weightKg").GetDouble().Should().Be(82.0);

        var newer = await user.PostAsJsonAsync("/api/tracker/weight", new { date = "2026-06-17", weightKg = 80.5 });
        newer.StatusCode.Should().Be(HttpStatusCode.OK);
        // Returned profile's current weight = the latest-dated entry.
        (await Json(newer)).GetProperty("weightKg").GetDouble().Should().Be(80.5);

        // Re-logging the SAME (older) date upserts (no duplicate) and does NOT change current weight,
        // because the newer-dated entry still wins.
        var reolder = await user.PostAsJsonAsync("/api/tracker/weight", new { date = "2026-06-10", weightKg = 83.0 });
        (await Json(reolder)).GetProperty("weightKg").GetDouble().Should().Be(80.5);

        // History has exactly two points (one per day), oldest-first, with the upserted older value.
        var history = (await Json(await user.GetAsync("/api/tracker/weight?days=365"))).EnumerateArray().ToList();
        history.Should().HaveCount(2);
        history[0].GetProperty("date").GetString().Should().Be("2026-06-10");
        history[0].GetProperty("weightKg").GetDouble().Should().Be(83.0);
        history[1].GetProperty("date").GetString().Should().Be("2026-06-17");
        history[1].GetProperty("weightKg").GetDouble().Should().Be(80.5);
    }

    [Fact]
    public async Task Logging_weight_rejects_out_of_range_values()
    {
        var (_, user) = await ProvisionUser("tracker.self");
        (await user.PostAsJsonAsync("/api/tracker/weight", new { date = Today, weightKg = 0.0 }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await user.PostAsJsonAsync("/api/tracker/weight", new { date = Today, weightKg = 1500.0 }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await user.PostAsJsonAsync("/api/tracker/weight", new { date = "not-a-date", weightKg = 80.0 }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Weight_history_returns_only_your_own_readings()
    {
        var (aliceEmail, alice) = await ProvisionUser("tracker.self");
        var (_, coach) = await ProvisionUser("tracker.self", "tracker.viewall");

        await alice.PostAsJsonAsync("/api/tracker/weight", new { date = "2026-06-17", weightKg = 80.0 });

        // There is no ?user= on the weight GET — it's the caller's own history only. Even a viewall
        // coach reading the endpoint gets THEIR OWN (empty) history, never Alice's.
        var coachHistory = (await Json(await coach.GetAsync("/api/tracker/weight"))).EnumerateArray().ToList();
        coachHistory.Should().BeEmpty();

        var aliceHistory = (await Json(await alice.GetAsync("/api/tracker/weight"))).EnumerateArray().ToList();
        aliceHistory.Should().ContainSingle();
    }

    // ---- Weight slots: morning + evening coexist on one day; stats expose per-slot averages + delta ----

    [Fact]
    public async Task Logging_morning_and_evening_on_the_same_day_makes_two_rows()
    {
        var (_, user) = await ProvisionUser("tracker.self");

        // Two readings on the SAME day at different slots both persist (no upsert across slots).
        (await user.PostAsJsonAsync("/api/tracker/weight", new { date = "2026-06-17", weightKg = 81.0, slot = "Morning" }))
            .StatusCode.Should().Be(HttpStatusCode.OK);
        var evening = await user.PostAsJsonAsync("/api/tracker/weight", new { date = "2026-06-17", weightKg = 82.0, slot = "Evening" });
        evening.StatusCode.Should().Be(HttpStatusCode.OK);
        // Current weight tracks the most recent reading (same date, Evening slot > Morning slot).
        (await Json(evening)).GetProperty("weightKg").GetDouble().Should().Be(82.0);

        // Stats expose two per-slot rows for the one day.
        var stats = await Json(await user.GetAsync("/api/tracker/weight/stats?days=365"));
        var bySlot = stats.GetProperty("bySlot").EnumerateArray().ToList();
        bySlot.Should().HaveCount(2);
        bySlot.Should().Contain(s => s.GetProperty("slot").GetString() == "Morning");
        bySlot.Should().Contain(s => s.GetProperty("slot").GetString() == "Evening");

        // Re-logging the SAME day+slot upserts in place (still two rows total).
        (await user.PostAsJsonAsync("/api/tracker/weight", new { date = "2026-06-17", weightKg = 80.5, slot = "Morning" }))
            .StatusCode.Should().Be(HttpStatusCode.OK);
        var entries = stats.GetProperty("entries").EnumerateArray().ToList();
        entries.Should().HaveCount(2);
        var restats = await Json(await user.GetAsync("/api/tracker/weight/stats?days=365"));
        restats.GetProperty("entries").EnumerateArray().Should().HaveCount(2);
    }

    [Fact]
    public async Task Weight_stats_returns_per_slot_averages_and_the_morning_evening_delta()
    {
        var (_, user) = await ProvisionUser("tracker.self");

        // Morning readings: 80, 82 (avg 81). Evening readings: 83, 85 (avg 84). Delta = 84 - 81 = 3.
        await user.PostAsJsonAsync("/api/tracker/weight", new { date = "2026-06-16", weightKg = 80.0, slot = "Morning" });
        await user.PostAsJsonAsync("/api/tracker/weight", new { date = "2026-06-16", weightKg = 83.0, slot = "Evening" });
        await user.PostAsJsonAsync("/api/tracker/weight", new { date = "2026-06-17", weightKg = 82.0, slot = "Morning" });
        await user.PostAsJsonAsync("/api/tracker/weight", new { date = "2026-06-17", weightKg = 85.0, slot = "Evening" });

        var stats = await Json(await user.GetAsync("/api/tracker/weight/stats?days=365"));

        var morning = stats.GetProperty("bySlot").EnumerateArray()
            .Single(s => s.GetProperty("slot").GetString() == "Morning");
        morning.GetProperty("avgKg").GetDouble().Should().Be(81.0);
        morning.GetProperty("latestKg").GetDouble().Should().Be(82.0); // 2026-06-17 morning
        morning.GetProperty("count").GetInt32().Should().Be(2);

        var eveningStat = stats.GetProperty("bySlot").EnumerateArray()
            .Single(s => s.GetProperty("slot").GetString() == "Evening");
        eveningStat.GetProperty("avgKg").GetDouble().Should().Be(84.0);
        eveningStat.GetProperty("latestKg").GetDouble().Should().Be(85.0); // 2026-06-17 evening
        eveningStat.GetProperty("count").GetInt32().Should().Be(2);

        stats.GetProperty("morningEveningDeltaKg").GetDouble().Should().Be(3.0);
        stats.GetProperty("entries").EnumerateArray().Should().HaveCount(4);
    }

    [Fact]
    public async Task Weight_stats_delta_is_null_when_a_slot_is_missing()
    {
        var (_, user) = await ProvisionUser("tracker.self");

        // Only morning readings -> evening avg missing -> delta is null.
        await user.PostAsJsonAsync("/api/tracker/weight", new { date = "2026-06-17", weightKg = 80.0, slot = "Morning" });

        var stats = await Json(await user.GetAsync("/api/tracker/weight/stats"));
        stats.GetProperty("morningEveningDeltaKg").ValueKind.Should().Be(JsonValueKind.Null);
    }

    [Fact]
    public async Task Weight_without_a_slot_defaults_to_unspecified_and_upserts_one_per_day()
    {
        var (_, user) = await ProvisionUser("tracker.self");

        // Existing single-per-day callers (no slot) keep upserting one row per day (Unspecified slot).
        await user.PostAsJsonAsync("/api/tracker/weight", new { date = "2026-06-17", weightKg = 80.0 });
        await user.PostAsJsonAsync("/api/tracker/weight", new { date = "2026-06-17", weightKg = 81.0 });

        var history = (await Json(await user.GetAsync("/api/tracker/weight?days=365"))).EnumerateArray().ToList();
        history.Should().ContainSingle();
        history[0].GetProperty("weightKg").GetDouble().Should().Be(81.0);

        var stats = await Json(await user.GetAsync("/api/tracker/weight/stats?days=365"));
        var bySlot = stats.GetProperty("bySlot").EnumerateArray().ToList();
        bySlot.Should().ContainSingle();
        bySlot[0].GetProperty("slot").GetString().Should().Be("Unspecified");
        bySlot[0].GetProperty("count").GetInt32().Should().Be(1);
    }

    [Fact]
    public async Task Weight_stats_are_private_owner_only()
    {
        var (_, alice) = await ProvisionUser("tracker.self");
        var (_, coach) = await ProvisionUser("tracker.self", "tracker.viewall");

        await alice.PostAsJsonAsync("/api/tracker/weight", new { date = "2026-06-17", weightKg = 80.0, slot = "Morning" });

        // There is no ?user= on stats — even a viewall coach reading it gets THEIR OWN (empty) stats.
        var coachStats = await Json(await coach.GetAsync("/api/tracker/weight/stats"));
        coachStats.GetProperty("bySlot").EnumerateArray().Should().BeEmpty();
        coachStats.GetProperty("entries").EnumerateArray().Should().BeEmpty();
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

    // ---- WorkoutX: auth + permission gating, and 503 when unconfigured (no key in the test env) ----

    [Fact]
    public async Task WorkoutX_endpoints_require_authentication()
    {
        var anon = factory.CreateClient();
        (await anon.GetAsync("/api/tracker/workoutx/exercises?q=press"))
            .StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await anon.GetAsync("/api/tracker/workoutx/gif/1"))
            .StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task WorkoutX_endpoints_require_tracker_self()
    {
        var (_, noTracker) = await ProvisionUser("dashboard.view");
        (await noTracker.GetAsync("/api/tracker/workoutx/exercises?q=press"))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await noTracker.GetAsync("/api/tracker/workoutx/gif/1"))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task WorkoutX_endpoints_return_503_when_unconfigured()
    {
        var (_, user) = await ProvisionUser("tracker.self");

        var search = await user.GetAsync("/api/tracker/workoutx/exercises?q=press");
        search.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);

        var gif = await user.GetAsync("/api/tracker/workoutx/gif/1");
        gif.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);

        // The rest of the tracker still works even with WorkoutX off.
        (await user.GetAsync("/api/tracker/profile")).StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task WorkoutX_gif_route_rejects_a_non_numeric_id_as_404()
    {
        var (_, user) = await ProvisionUser("tracker.self");
        // The {id:int} route constraint never matches a non-numeric segment, so it's an unmatched 404
        // (the id never reaches the handler / the upstream path).
        (await user.GetAsync("/api/tracker/workoutx/gif/abc"))
            .StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    // ---- Saved "My foods": manual logs auto-save + dedupe; provider logs don't ----

    [Fact]
    public async Task Manual_food_log_auto_saves_and_a_second_identical_log_bumps_use_count_without_duplicating()
    {
        var (_, user) = await ProvisionUser("tracker.self");

        async Task LogManualAsync() =>
            (await user.PostAsJsonAsync("/api/tracker/food", new
            {
                date = Today, meal = "lunch", description = "Homemade chili", brand = "",
                quantity = 1.0, servingDesc = "1 bowl",
                calories = 420, proteinG = 30.0, carbG = 35.0, fatG = 15.0,
            })).StatusCode.Should().Be(HttpStatusCode.OK);

        // First manual log creates a saved food (UseCount = 1).
        await LogManualAsync();
        var saved1 = (await Json(await user.GetAsync("/api/tracker/foods/saved"))).EnumerateArray().ToList();
        saved1.Should().ContainSingle();
        saved1[0].GetProperty("description").GetString().Should().Be("Homemade chili");
        saved1[0].GetProperty("useCount").GetInt32().Should().Be(1);
        saved1[0].GetProperty("calories").GetInt32().Should().Be(420);

        // A second identical manual log bumps UseCount to 2 — no duplicate row.
        await LogManualAsync();
        var saved2 = (await Json(await user.GetAsync("/api/tracker/foods/saved"))).EnumerateArray().ToList();
        saved2.Should().ContainSingle();
        saved2[0].GetProperty("useCount").GetInt32().Should().Be(2);
    }

    [Fact]
    public async Task Manual_food_log_with_quantity_stores_per_unit_macros_and_logs_scaled_totals()
    {
        var (_, user) = await ProvisionUser("tracker.self");

        // Manual log of a food at quantity 3: the dialog sends the SCALED totals (per-serving × 3) plus
        // the quantity, so the logged entry is the full total but "My foods" stores the per-unit values.
        (await user.PostAsJsonAsync("/api/tracker/food", new
        {
            date = Today, meal = "dinner", description = "Protein shake", brand = "",
            quantity = 3.0, servingDesc = "3 servings",
            calories = 360, proteinG = 90.0, carbG = 30.0, fatG = 9.0,
        })).StatusCode.Should().Be(HttpStatusCode.OK);

        // The logged day entry carries the SCALED total.
        var day = await Json(await user.GetAsync($"/api/tracker/day?date={Today}"));
        var food = day.GetProperty("foods").EnumerateArray().Single();
        food.GetProperty("calories").GetInt32().Should().Be(360);
        food.GetProperty("quantity").GetDouble().Should().Be(3.0);
        day.GetProperty("caloriesIn").GetInt32().Should().Be(360);

        // The saved "My foods" row stores the PER-UNIT (unscaled) macros so re-picking scales cleanly.
        var saved = (await Json(await user.GetAsync("/api/tracker/foods/saved"))).EnumerateArray().ToList();
        saved.Should().ContainSingle();
        saved[0].GetProperty("calories").GetInt32().Should().Be(120);   // 360 / 3
        saved[0].GetProperty("proteinG").GetDouble().Should().Be(30.0); // 90 / 3
        saved[0].GetProperty("carbG").GetDouble().Should().Be(10.0);    // 30 / 3
        saved[0].GetProperty("fatG").GetDouble().Should().Be(3.0);      // 9 / 3
        saved[0].GetProperty("useCount").GetInt32().Should().Be(1);

        // Logging the SAME per-serving food at a DIFFERENT quantity dedupes onto the one row (the key is
        // quantity-independent) and bumps UseCount rather than spawning a duplicate.
        (await user.PostAsJsonAsync("/api/tracker/food", new
        {
            date = Today, meal = "lunch", description = "Protein shake", brand = "",
            quantity = 2.0, servingDesc = "2 servings",
            calories = 240, proteinG = 60.0, carbG = 20.0, fatG = 6.0,
        })).StatusCode.Should().Be(HttpStatusCode.OK);

        var saved2 = (await Json(await user.GetAsync("/api/tracker/foods/saved"))).EnumerateArray().ToList();
        saved2.Should().ContainSingle();
        saved2[0].GetProperty("useCount").GetInt32().Should().Be(2);
        saved2[0].GetProperty("calories").GetInt32().Should().Be(120); // still per-unit, no compounding
    }

    [Fact]
    public async Task A_usda_or_fatsecret_sourced_log_does_not_create_a_saved_food()
    {
        var (_, user) = await ProvisionUser("tracker.self");

        // A USDA-sourced log (carries fdcId).
        await user.PostAsJsonAsync("/api/tracker/food", new
        {
            date = Today, meal = "breakfast", fdcId = 173944, description = "Banana, raw",
            quantity = 1.0, calories = 105, proteinG = 1.3, carbG = 27.0, fatG = 0.4,
        });
        // A FatSecret-sourced log (source set, no fdcId).
        await user.PostAsJsonAsync("/api/tracker/food", new
        {
            date = Today, meal = "snack", source = "fatsecret", description = "Greek yogurt",
            quantity = 1.0, calories = 100, proteinG = 17.0, carbG = 6.0, fatG = 0.0,
        });

        var saved = (await Json(await user.GetAsync("/api/tracker/foods/saved"))).EnumerateArray().ToList();
        saved.Should().BeEmpty();
    }

    [Fact]
    public async Task Saved_foods_are_caller_own_only_and_filterable_by_query()
    {
        var (_, alice) = await ProvisionUser("tracker.self");
        var (_, bob) = await ProvisionUser("tracker.self");

        await alice.PostAsJsonAsync("/api/tracker/food", new
        {
            date = Today, meal = "lunch", description = "Avocado toast", brand = "Acme",
            quantity = 1.0, calories = 250, proteinG = 6.0, carbG = 20.0, fatG = 16.0,
        });
        await alice.PostAsJsonAsync("/api/tracker/food", new
        {
            date = Today, meal = "dinner", description = "Beef stew",
            quantity = 1.0, calories = 380, proteinG = 28.0, carbG = 22.0, fatG = 18.0,
        });

        // Bob sees none of Alice's saved foods.
        (await Json(await bob.GetAsync("/api/tracker/foods/saved"))).EnumerateArray().Should().BeEmpty();

        // Alice sees both; a query filters on description/brand, case-insensitively.
        var all = (await Json(await alice.GetAsync("/api/tracker/foods/saved"))).EnumerateArray().ToList();
        all.Should().HaveCount(2);

        var byDesc = (await Json(await alice.GetAsync("/api/tracker/foods/saved?q=toast"))).EnumerateArray().ToList();
        byDesc.Should().ContainSingle();
        byDesc[0].GetProperty("description").GetString().Should().Be("Avocado toast");

        var byBrand = (await Json(await alice.GetAsync("/api/tracker/foods/saved?q=acme"))).EnumerateArray().ToList();
        byBrand.Should().ContainSingle();
        byBrand[0].GetProperty("brand").GetString().Should().Be("Acme");
    }

    [Fact]
    public async Task Deleting_a_saved_food_is_owner_only_and_404_for_another_user()
    {
        var (_, alice) = await ProvisionUser("tracker.self");
        var (_, bob) = await ProvisionUser("tracker.self");

        await alice.PostAsJsonAsync("/api/tracker/food", new
        {
            date = Today, meal = "snack", description = "Trail mix",
            quantity = 1.0, calories = 200, proteinG = 5.0, carbG = 18.0, fatG = 12.0,
        });
        var savedId = (await Json(await alice.GetAsync("/api/tracker/foods/saved")))
            .EnumerateArray().First().GetProperty("id").GetInt64();

        // Bob can't delete Alice's saved food → 404 (never reveal the row).
        (await bob.DeleteAsync($"/api/tracker/foods/saved/{savedId}")).StatusCode.Should().Be(HttpStatusCode.NotFound);

        // Alice deletes her own → 204, and it's gone.
        (await alice.DeleteAsync($"/api/tracker/foods/saved/{savedId}")).StatusCode.Should().Be(HttpStatusCode.NoContent);
        (await Json(await alice.GetAsync("/api/tracker/foods/saved"))).EnumerateArray().Should().BeEmpty();
    }

    // ---- AI-committed foods (photo / describe-a-meal review rows) auto-save like manual logs ----

    [Fact]
    public async Task Ai_committed_foods_with_no_source_are_auto_saved_to_my_foods()
    {
        var (_, user) = await ProvisionUser("tracker.self");

        // The AI review batch (addReviewItems) commits each item via POST /tracker/food with NO source
        // and NO fdcId — exactly a manual log — so each becomes a saved "My food" (no image stored).
        foreach (var (desc, cal) in new[] { ("Grilled chicken", 220), ("Brown rice", 215) })
        {
            (await user.PostAsJsonAsync("/api/tracker/food", new
            {
                date = Today, meal = "dinner", description = desc,
                quantity = 1.0, servingDesc = "1 serving",
                calories = cal, proteinG = 10.0, carbG = 20.0, fatG = 5.0,
            })).StatusCode.Should().Be(HttpStatusCode.OK);
        }

        var saved = (await Json(await user.GetAsync("/api/tracker/foods/saved"))).EnumerateArray().ToList();
        saved.Should().HaveCount(2);
        saved.Select(s => s.GetProperty("description").GetString())
            .Should().BeEquivalentTo(new[] { "Grilled chicken", "Brown rice" });
        // All are genuine saved rows (Id > 0), not recent-only placeholders.
        saved.Should().OnlyContain(s => s.GetProperty("id").GetInt64() > 0);
    }

    // ---- "My foods" ?recent=true also surfaces recently-logged foods, deduped against saved ----

    [Fact]
    public async Task Saved_foods_with_recent_flag_includes_recently_logged_foods_deduped_against_saved()
    {
        var (_, user) = await ProvisionUser("tracker.self");

        // A provider-sourced (FatSecret) log is NOT auto-saved, but it IS a recent log → it should appear
        // only when recent=true, flagged isRecent with id 0 and PER-UNIT macros.
        (await user.PostAsJsonAsync("/api/tracker/food", new
        {
            date = Today, meal = "breakfast", source = "fatsecret", description = "Greek yogurt",
            quantity = 2.0, servingDesc = "2 servings",
            calories = 200, proteinG = 34.0, carbG = 12.0, fatG = 0.0,
        })).StatusCode.Should().Be(HttpStatusCode.OK);

        // A manual log auto-saves (a genuine saved row).
        (await user.PostAsJsonAsync("/api/tracker/food", new
        {
            date = Today, meal = "lunch", description = "Homemade soup",
            quantity = 1.0, servingDesc = "1 bowl",
            calories = 180, proteinG = 8.0, carbG = 22.0, fatG = 6.0,
        })).StatusCode.Should().Be(HttpStatusCode.OK);

        // Without recent: only the saved (manual) food shows.
        var savedOnly = (await Json(await user.GetAsync("/api/tracker/foods/saved"))).EnumerateArray().ToList();
        savedOnly.Should().ContainSingle();
        savedOnly[0].GetProperty("description").GetString().Should().Be("Homemade soup");

        // With recent: the FatSecret log surfaces as a read-only recent row (id 0, isRecent), and the
        // saved manual food is NOT duplicated as a recent row.
        var withRecent = (await Json(await user.GetAsync("/api/tracker/foods/saved?recent=true")))
            .EnumerateArray().ToList();
        withRecent.Should().HaveCount(2);

        var soup = withRecent.Single(f => f.GetProperty("description").GetString() == "Homemade soup");
        soup.GetProperty("isRecent").GetBoolean().Should().BeFalse();
        soup.GetProperty("id").GetInt64().Should().BeGreaterThan(0);

        var yogurt = withRecent.Single(f => f.GetProperty("description").GetString() == "Greek yogurt");
        yogurt.GetProperty("isRecent").GetBoolean().Should().BeTrue();
        yogurt.GetProperty("id").GetInt64().Should().Be(0);
        // Recent macros are de-scaled to per-unit (200 cal / qty 2 = 100).
        yogurt.GetProperty("calories").GetInt32().Should().Be(100);
        yogurt.GetProperty("proteinG").GetDouble().Should().Be(17.0);
    }

    [Fact]
    public async Task Recent_foods_are_caller_own_only()
    {
        var (_, alice) = await ProvisionUser("tracker.self");
        var (_, bob) = await ProvisionUser("tracker.self");

        await alice.PostAsJsonAsync("/api/tracker/food", new
        {
            date = Today, meal = "snack", source = "fatsecret", description = "Alice protein bar",
            quantity = 1.0, calories = 210, proteinG = 20.0, carbG = 22.0, fatG = 7.0,
        });

        // Bob's recent list never includes Alice's logged foods.
        var bobRecent = (await Json(await bob.GetAsync("/api/tracker/foods/saved?recent=true")))
            .EnumerateArray().ToList();
        bobRecent.Should().BeEmpty();
    }

    // ---- Saved "My exercises": manual logs auto-save + dedupe; library/workoutx logs don't ----

    [Fact]
    public async Task Manual_exercise_log_auto_saves_and_a_second_identical_log_bumps_use_count_without_duplicating()
    {
        var (_, user) = await ProvisionUser("tracker.self");

        async Task LogManualAsync() =>
            (await user.PostAsJsonAsync("/api/tracker/exercise", new
            {
                date = Today, name = "Garage barbell circuit", durationMin = 25, caloriesBurned = 180,
            })).StatusCode.Should().Be(HttpStatusCode.OK);

        // First manual log creates a saved exercise (UseCount = 1) with the logged defaults.
        await LogManualAsync();
        var saved1 = (await Json(await user.GetAsync("/api/tracker/exercises/saved"))).EnumerateArray().ToList();
        saved1.Should().ContainSingle();
        saved1[0].GetProperty("name").GetString().Should().Be("Garage barbell circuit");
        saved1[0].GetProperty("useCount").GetInt32().Should().Be(1);
        saved1[0].GetProperty("defaultCaloriesBurned").GetInt32().Should().Be(180);
        saved1[0].GetProperty("defaultDurationMin").GetInt32().Should().Be(25);

        // A second identical manual log bumps UseCount to 2 — no duplicate row.
        await LogManualAsync();
        var saved2 = (await Json(await user.GetAsync("/api/tracker/exercises/saved"))).EnumerateArray().ToList();
        saved2.Should().ContainSingle();
        saved2[0].GetProperty("useCount").GetInt32().Should().Be(2);
    }

    [Fact]
    public async Task A_workoutx_or_library_sourced_exercise_log_does_not_create_a_saved_exercise()
    {
        var (_, user) = await ProvisionUser("tracker.self");

        // A WorkoutX-sourced log (source set, no library ExerciseId).
        await user.PostAsJsonAsync("/api/tracker/exercise", new
        {
            date = Today, source = "workoutx", name = "Cable fly", durationMin = 15, caloriesBurned = 90,
        });

        // A library-sourced log (carries a real ExerciseId from the goal-tagged library).
        var lib = (await Json(await user.GetAsync("/api/tracker/exercises"))).EnumerateArray().First();
        var exId = lib.GetProperty("id").GetInt32();
        await user.PostAsJsonAsync("/api/tracker/exercise", new
        {
            date = Today, exerciseId = exId, durationMin = 30, caloriesBurned = 200,
        });

        var saved = (await Json(await user.GetAsync("/api/tracker/exercises/saved"))).EnumerateArray().ToList();
        saved.Should().BeEmpty();
    }

    [Fact]
    public async Task Saved_exercises_are_caller_own_only_and_filterable_by_query()
    {
        var (_, alice) = await ProvisionUser("tracker.self");
        var (_, bob) = await ProvisionUser("tracker.self");

        await alice.PostAsJsonAsync("/api/tracker/exercise", new
        {
            date = Today, name = "Morning jog", durationMin = 20, caloriesBurned = 160,
        });
        await alice.PostAsJsonAsync("/api/tracker/exercise", new
        {
            date = Today, name = "Kettlebell swings", durationMin = 10, caloriesBurned = 110,
        });

        // Bob sees none of Alice's saved exercises.
        (await Json(await bob.GetAsync("/api/tracker/exercises/saved"))).EnumerateArray().Should().BeEmpty();

        // Alice sees both; a query filters on name, case-insensitively.
        var all = (await Json(await alice.GetAsync("/api/tracker/exercises/saved"))).EnumerateArray().ToList();
        all.Should().HaveCount(2);

        var byName = (await Json(await alice.GetAsync("/api/tracker/exercises/saved?q=JOG"))).EnumerateArray().ToList();
        byName.Should().ContainSingle();
        byName[0].GetProperty("name").GetString().Should().Be("Morning jog");
    }

    [Fact]
    public async Task Deleting_a_saved_exercise_is_owner_only_and_404_for_another_user()
    {
        var (_, alice) = await ProvisionUser("tracker.self");
        var (_, bob) = await ProvisionUser("tracker.self");

        await alice.PostAsJsonAsync("/api/tracker/exercise", new
        {
            date = Today, name = "Stair climber", durationMin = 12, caloriesBurned = 120,
        });
        var savedId = (await Json(await alice.GetAsync("/api/tracker/exercises/saved")))
            .EnumerateArray().First().GetProperty("id").GetInt64();

        // Bob can't delete Alice's saved exercise → 404 (never reveal the row).
        (await bob.DeleteAsync($"/api/tracker/exercises/saved/{savedId}")).StatusCode.Should().Be(HttpStatusCode.NotFound);

        // Alice deletes her own → 204, and it's gone.
        (await alice.DeleteAsync($"/api/tracker/exercises/saved/{savedId}")).StatusCode.Should().Be(HttpStatusCode.NoContent);
        (await Json(await alice.GetAsync("/api/tracker/exercises/saved"))).EnumerateArray().Should().BeEmpty();
    }

    // ---- Hydration: add + appears on the day (sum + entries), delete own ----

    [Fact]
    public async Task Adding_hydration_appears_on_the_day_sum_and_entries_then_deletes()
    {
        var (_, user) = await ProvisionUser("tracker.self");

        var add1 = await user.PostAsJsonAsync("/api/tracker/hydration", new
        {
            date = Today, amountMl = 250, label = "Water",
        });
        add1.StatusCode.Should().Be(HttpStatusCode.OK);
        var drink = await Json(add1);
        var drinkId = drink.GetProperty("id").GetInt64();
        drink.GetProperty("amountMl").GetInt32().Should().Be(250);
        drink.GetProperty("label").GetString().Should().Be("Water");
        drink.GetProperty("createdUtc").GetString().Should().NotBeNullOrEmpty();

        // A second drink with no label.
        (await user.PostAsJsonAsync("/api/tracker/hydration", new { date = Today, amountMl = 500 }))
            .StatusCode.Should().Be(HttpStatusCode.OK);

        // Both appear on the day; hydrationMl is the sum.
        var day = await Json(await user.GetAsync($"/api/tracker/day?date={Today}"));
        day.GetProperty("hydrationMl").GetInt32().Should().Be(750);
        day.GetProperty("hydration").EnumerateArray().Should().HaveCount(2);

        // Delete the first → 204, and the day reflects only the remaining drink.
        (await user.DeleteAsync($"/api/tracker/hydration/{drinkId}")).StatusCode.Should().Be(HttpStatusCode.NoContent);
        var after = await Json(await user.GetAsync($"/api/tracker/day?date={Today}"));
        after.GetProperty("hydrationMl").GetInt32().Should().Be(500);
        after.GetProperty("hydration").EnumerateArray().Should().ContainSingle();
    }

    [Fact]
    public async Task Deleting_hydration_you_dont_own_is_404()
    {
        var (_, owner) = await ProvisionUser("tracker.self");
        var (_, other) = await ProvisionUser("tracker.self");

        var add = await owner.PostAsJsonAsync("/api/tracker/hydration", new { date = Today, amountMl = 300 });
        var drinkId = (await Json(add)).GetProperty("id").GetInt64();

        // Another tracker.self user can't delete it (404, not 403 — never reveal the row).
        (await other.DeleteAsync($"/api/tracker/hydration/{drinkId}")).StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task Hydration_amount_validation_rejects_out_of_range_values()
    {
        var (_, user) = await ProvisionUser("tracker.self");
        (await user.PostAsJsonAsync("/api/tracker/hydration", new { date = Today, amountMl = 0 }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await user.PostAsJsonAsync("/api/tracker/hydration", new { date = Today, amountMl = 5001 }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await user.PostAsJsonAsync("/api/tracker/hydration", new { date = "not-a-date", amountMl = 250 }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    // ---- Hydration goal: 2000 ml default when unset, reflects the profile when set ----

    [Fact]
    public async Task Hydration_goal_defaults_to_2000_and_reflects_the_profile_when_set()
    {
        var (_, user) = await ProvisionUser("tracker.self");

        // No profile goal yet → the day resolves a 2000 ml default.
        var day = await Json(await user.GetAsync($"/api/tracker/day?date={Today}"));
        day.GetProperty("hydrationGoalMl").GetInt32().Should().Be(2000);
        day.GetProperty("hydrationMl").GetInt32().Should().Be(0);

        // Set a profile goal → it round-trips on the profile AND drives the day's resolved goal.
        var put = await user.PutAsJsonAsync("/api/tracker/profile", new
        {
            goal = "Maintain", shareWithContacts = false, hydrationGoalMl = 3000,
        });
        put.StatusCode.Should().Be(HttpStatusCode.OK);
        (await Json(put)).GetProperty("hydrationGoalMl").GetInt32().Should().Be(3000);

        var saved = await Json(await user.GetAsync("/api/tracker/profile"));
        saved.GetProperty("hydrationGoalMl").GetInt32().Should().Be(3000);

        var day2 = await Json(await user.GetAsync($"/api/tracker/day?date={Today}"));
        day2.GetProperty("hydrationGoalMl").GetInt32().Should().Be(3000);
    }

    // ---- Hydration visibility: a viewer sees totals/entries; writes target only the caller ----

    [Fact]
    public async Task A_shared_users_hydration_is_visible_but_a_write_targets_only_the_caller()
    {
        var (aliceEmail, alice) = await ProvisionUser("tracker.self");
        var (bobEmail, bob) = await ProvisionUser("tracker.self");
        await MakeContacts(aliceEmail, bobEmail);

        await alice.PutAsJsonAsync("/api/tracker/profile", new
        {
            goal = "Maintain", shareWithContacts = true, hydrationGoalMl = 2500,
        });
        await alice.PostAsJsonAsync("/api/tracker/hydration", new { date = Today, amountMl = 750, label = "Tea" });

        // Bob (a sharing mutual contact) sees Alice's hydration total + entries + resolved goal.
        var aliceId = await UserIdFor(aliceEmail);
        var viewed = await Json(await bob.GetAsync($"/api/tracker/day?date={Today}&user={aliceId}"));
        viewed.GetProperty("readOnly").GetBoolean().Should().BeTrue();
        viewed.GetProperty("hydrationMl").GetInt32().Should().Be(750);
        viewed.GetProperty("hydrationGoalMl").GetInt32().Should().Be(2500);
        viewed.GetProperty("hydration").EnumerateArray().Should().ContainSingle();

        // There is no ?user= on the write — Bob logging a drink lands on BOB's own log, never Alice's.
        await bob.PostAsJsonAsync("/api/tracker/hydration", new { date = Today, amountMl = 200 });
        var aliceAfter = await Json(await alice.GetAsync($"/api/tracker/day?date={Today}"));
        aliceAfter.GetProperty("hydrationMl").GetInt32().Should().Be(750); // unchanged by Bob's write
    }

    // ---- Coffee: add + appears on the day (cups + caffeine + entries), delete own ----

    [Fact]
    public async Task Adding_coffee_appears_on_the_day_cups_caffeine_and_entries_then_deletes()
    {
        var (_, user) = await ProvisionUser("tracker.self");

        var add1 = await user.PostAsJsonAsync("/api/tracker/coffee", new
        {
            date = Today, cups = 1, caffeineMg = 95, label = "Mug",
        });
        add1.StatusCode.Should().Be(HttpStatusCode.OK);
        var drink = await Json(add1);
        var coffeeId = drink.GetProperty("id").GetInt64();
        drink.GetProperty("cups").GetInt32().Should().Be(1);
        drink.GetProperty("caffeineMg").GetInt32().Should().Be(95);
        drink.GetProperty("label").GetString().Should().Be("Mug");
        drink.GetProperty("createdUtc").GetString().Should().NotBeNullOrEmpty();

        // A second coffee with no label and no caffeine.
        (await user.PostAsJsonAsync("/api/tracker/coffee", new { date = Today, cups = 2 }))
            .StatusCode.Should().Be(HttpStatusCode.OK);

        // Both appear on the day; coffeeCups + caffeineMg are the sums.
        var day = await Json(await user.GetAsync($"/api/tracker/day?date={Today}"));
        day.GetProperty("coffeeCups").GetInt32().Should().Be(3);
        day.GetProperty("caffeineMg").GetInt32().Should().Be(95);
        day.GetProperty("coffee").EnumerateArray().Should().HaveCount(2);

        // Delete the first → 204, and the day reflects only the remaining coffee.
        (await user.DeleteAsync($"/api/tracker/coffee/{coffeeId}")).StatusCode.Should().Be(HttpStatusCode.NoContent);
        var after = await Json(await user.GetAsync($"/api/tracker/day?date={Today}"));
        after.GetProperty("coffeeCups").GetInt32().Should().Be(2);
        after.GetProperty("caffeineMg").GetInt32().Should().Be(0);
        after.GetProperty("coffee").EnumerateArray().Should().ContainSingle();
    }

    [Fact]
    public async Task Deleting_coffee_you_dont_own_is_404()
    {
        var (_, owner) = await ProvisionUser("tracker.self");
        var (_, other) = await ProvisionUser("tracker.self");

        var add = await owner.PostAsJsonAsync("/api/tracker/coffee", new { date = Today, cups = 1 });
        var coffeeId = (await Json(add)).GetProperty("id").GetInt64();

        // Another tracker.self user can't delete it (404, not 403 — never reveal the row).
        (await other.DeleteAsync($"/api/tracker/coffee/{coffeeId}")).StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task Coffee_cups_are_clamped_to_the_1_to_20_range()
    {
        var (_, user) = await ProvisionUser("tracker.self");

        // 0 cups clamps up to 1.
        var low = await user.PostAsJsonAsync("/api/tracker/coffee", new { date = Today, cups = 0 });
        (await Json(low)).GetProperty("cups").GetInt32().Should().Be(1);

        // 50 cups clamps down to 20.
        var high = await user.PostAsJsonAsync("/api/tracker/coffee", new { date = Today, cups = 50 });
        (await Json(high)).GetProperty("cups").GetInt32().Should().Be(20);

        // A bad date is still rejected.
        (await user.PostAsJsonAsync("/api/tracker/coffee", new { date = "not-a-date", cups = 1 }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    // ---- Coffee goal: 3-cup default when unset, reflects the profile when set ----

    [Fact]
    public async Task Coffee_goal_defaults_to_3_and_reflects_the_profile_when_set()
    {
        var (_, user) = await ProvisionUser("tracker.self");

        // No profile goal yet → the day resolves a 3-cup default.
        var day = await Json(await user.GetAsync($"/api/tracker/day?date={Today}"));
        day.GetProperty("coffeeGoalCups").GetInt32().Should().Be(3);
        day.GetProperty("coffeeCups").GetInt32().Should().Be(0);

        // Set a profile goal → it round-trips on the profile AND drives the day's resolved goal.
        var put = await user.PutAsJsonAsync("/api/tracker/profile", new
        {
            goal = "Maintain", shareWithContacts = false, coffeeGoalCups = 5,
        });
        put.StatusCode.Should().Be(HttpStatusCode.OK);
        (await Json(put)).GetProperty("coffeeGoalCups").GetInt32().Should().Be(5);

        var saved = await Json(await user.GetAsync("/api/tracker/profile"));
        saved.GetProperty("coffeeGoalCups").GetInt32().Should().Be(5);

        var day2 = await Json(await user.GetAsync($"/api/tracker/day?date={Today}"));
        day2.GetProperty("coffeeGoalCups").GetInt32().Should().Be(5);
    }

    // ---- Coffee visibility: a viewer sees totals/entries; writes target only the caller ----

    [Fact]
    public async Task A_shared_users_coffee_is_visible_but_a_write_targets_only_the_caller()
    {
        var (aliceEmail, alice) = await ProvisionUser("tracker.self");
        var (bobEmail, bob) = await ProvisionUser("tracker.self");
        await MakeContacts(aliceEmail, bobEmail);

        await alice.PutAsJsonAsync("/api/tracker/profile", new
        {
            goal = "Maintain", shareWithContacts = true, coffeeGoalCups = 4,
        });
        await alice.PostAsJsonAsync("/api/tracker/coffee", new { date = Today, cups = 2, caffeineMg = 126, label = "Espresso" });

        // Bob (a sharing mutual contact) sees Alice's coffee total + entries + resolved goal read-only.
        var aliceId = await UserIdFor(aliceEmail);
        var viewed = await Json(await bob.GetAsync($"/api/tracker/day?date={Today}&user={aliceId}"));
        viewed.GetProperty("readOnly").GetBoolean().Should().BeTrue();
        viewed.GetProperty("coffeeCups").GetInt32().Should().Be(2);
        viewed.GetProperty("caffeineMg").GetInt32().Should().Be(126);
        viewed.GetProperty("coffeeGoalCups").GetInt32().Should().Be(4);
        viewed.GetProperty("coffee").EnumerateArray().Should().ContainSingle();

        // There is no ?user= on the write — Bob logging a coffee lands on BOB's own log, never Alice's.
        await bob.PostAsJsonAsync("/api/tracker/coffee", new { date = Today, cups = 1 });
        var aliceAfter = await Json(await alice.GetAsync($"/api/tracker/day?date={Today}"));
        aliceAfter.GetProperty("coffeeCups").GetInt32().Should().Be(2); // unchanged by Bob's write
    }

    // ---- Supplements: add + appears on the day + macros add to the day totals, then delete ----

    [Fact]
    public async Task Adding_a_supplement_appears_on_the_day_and_its_macros_add_to_the_totals_then_deletes()
    {
        // tracker.self ONLY (no tracker.ai) — manual macro entry works without the AI permission.
        var (_, user) = await ProvisionUser("tracker.self");

        // A protein powder with real macros.
        var add = await user.PostAsJsonAsync("/api/tracker/supplement", new
        {
            date = Today, name = "Whey protein", dose = "1 scoop", kind = "protein",
            calories = 120, protein = 24.0, carb = 3.0, fat = 1.5,
        });
        add.StatusCode.Should().Be(HttpStatusCode.OK);
        var s = await Json(add);
        var suppId = s.GetProperty("id").GetInt64();
        s.GetProperty("name").GetString().Should().Be("Whey protein");
        s.GetProperty("dose").GetString().Should().Be("1 scoop");
        s.GetProperty("kind").GetString().Should().Be("protein");
        s.GetProperty("calories").GetInt32().Should().Be(120);
        s.GetProperty("proteinG").GetDouble().Should().Be(24.0);
        s.GetProperty("createdUtc").GetString().Should().NotBeNullOrEmpty();

        // A second supplement with NO macros (a vitamin) — kind defaults stay, macros default to 0.
        (await user.PostAsJsonAsync("/api/tracker/supplement", new
        {
            date = Today, name = "Vitamin D", kind = "vitamin",
        })).StatusCode.Should().Be(HttpStatusCode.OK);

        // Both appear on the day; the labelled supplement subtotal is the sum AND it rolls into the day net.
        var day = await Json(await user.GetAsync($"/api/tracker/day?date={Today}"));
        day.GetProperty("supplements").EnumerateArray().Should().HaveCount(2);
        day.GetProperty("supplementCalories").GetInt32().Should().Be(120);
        day.GetProperty("supplementProteinG").GetDouble().Should().Be(24.0);
        // The whey counts toward intake: caloriesIn + macros include the supplement contribution.
        day.GetProperty("caloriesIn").GetInt32().Should().Be(120);
        day.GetProperty("proteinG").GetDouble().Should().Be(24.0);
        day.GetProperty("netCalories").GetInt32().Should().Be(120);

        // Delete the protein → 204, and the day's supplement subtotal + totals drop the contribution.
        (await user.DeleteAsync($"/api/tracker/supplement/{suppId}")).StatusCode.Should().Be(HttpStatusCode.NoContent);
        var after = await Json(await user.GetAsync($"/api/tracker/day?date={Today}"));
        after.GetProperty("supplements").EnumerateArray().Should().ContainSingle();
        after.GetProperty("supplementCalories").GetInt32().Should().Be(0);
        after.GetProperty("caloriesIn").GetInt32().Should().Be(0);
        after.GetProperty("proteinG").GetDouble().Should().Be(0.0);
    }

    [Fact]
    public async Task Supplement_macros_combine_with_food_macros_in_the_day_total()
    {
        var (_, user) = await ProvisionUser("tracker.self");

        // A manual food (200 cal / 10 g protein).
        await user.PostAsJsonAsync("/api/tracker/food", new
        {
            date = Today, meal = "breakfast", description = "Oats", quantity = 1.0,
            calories = 200, proteinG = 10.0, carbG = 30.0, fatG = 4.0,
        });
        // A protein shake (120 cal / 24 g protein).
        await user.PostAsJsonAsync("/api/tracker/supplement", new
        {
            date = Today, name = "Whey", kind = "protein", calories = 120, protein = 24.0,
        });

        var day = await Json(await user.GetAsync($"/api/tracker/day?date={Today}"));
        day.GetProperty("caloriesIn").GetInt32().Should().Be(320);   // 200 food + 120 supplement
        day.GetProperty("proteinG").GetDouble().Should().Be(34.0);   // 10 food + 24 supplement
        day.GetProperty("supplementCalories").GetInt32().Should().Be(120);
        day.GetProperty("supplementProteinG").GetDouble().Should().Be(24.0);
    }

    [Fact]
    public async Task Supplement_requires_a_name_and_a_valid_date()
    {
        var (_, user) = await ProvisionUser("tracker.self");
        (await user.PostAsJsonAsync("/api/tracker/supplement", new { date = Today, name = "" }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await user.PostAsJsonAsync("/api/tracker/supplement", new { date = "not-a-date", name = "Creatine" }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Deleting_a_supplement_you_dont_own_is_404()
    {
        var (_, owner) = await ProvisionUser("tracker.self");
        var (_, other) = await ProvisionUser("tracker.self");

        var add = await owner.PostAsJsonAsync("/api/tracker/supplement", new { date = Today, name = "Creatine" });
        var suppId = (await Json(add)).GetProperty("id").GetInt64();

        // Another tracker.self user can't delete it (404, not 403 — never reveal the row).
        (await other.DeleteAsync($"/api/tracker/supplement/{suppId}")).StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    // ---- Supplement visibility: a permitted viewer sees the day's supplements read-only ----

    [Fact]
    public async Task A_shared_users_supplements_are_visible_read_only_but_a_write_targets_only_the_caller()
    {
        var (aliceEmail, alice) = await ProvisionUser("tracker.self");
        var (bobEmail, bob) = await ProvisionUser("tracker.self");
        await MakeContacts(aliceEmail, bobEmail);

        await alice.PutAsJsonAsync("/api/tracker/profile", new
        {
            goal = "Maintain", shareWithContacts = true,
        });
        // A prescription name is health-adjacent — visible only via the tracker-sharing Alice controls.
        await alice.PostAsJsonAsync("/api/tracker/supplement", new
        {
            date = Today, name = "Lisinopril", dose = "10 mg", kind = "medication",
        });
        await alice.PostAsJsonAsync("/api/tracker/supplement", new
        {
            date = Today, name = "Whey", kind = "protein", calories = 120, protein = 24.0,
        });

        // Bob (a sharing mutual contact) sees Alice's supplement list + subtotal read-only.
        var aliceId = await UserIdFor(aliceEmail);
        var viewed = await Json(await bob.GetAsync($"/api/tracker/day?date={Today}&user={aliceId}"));
        viewed.GetProperty("readOnly").GetBoolean().Should().BeTrue();
        viewed.GetProperty("supplements").EnumerateArray().Should().HaveCount(2);
        viewed.GetProperty("supplementCalories").GetInt32().Should().Be(120);

        // There is no ?user= on the write — Bob logging a supplement lands on BOB's own log, never Alice's.
        await bob.PostAsJsonAsync("/api/tracker/supplement", new { date = Today, name = "Magnesium" });
        var aliceAfter = await Json(await alice.GetAsync($"/api/tracker/day?date={Today}"));
        aliceAfter.GetProperty("supplements").EnumerateArray().Should().HaveCount(2); // unchanged by Bob's write
    }

    // ---- Watch activity: upsert appears on the day (steps/distance/active calories/mode) + clear ----

    [Fact]
    public async Task Upserting_watch_activity_appears_on_the_day_then_clears()
    {
        var (_, user) = await ProvisionUser("tracker.self");

        // First upsert records the day's stats (steps, distance in metres, active calories, mode).
        var up = await user.PutAsJsonAsync("/api/tracker/activity", new
        {
            date = Today, steps = 8200, distanceMeters = 6100, activeCalories = 480, calorieMode = "add",
        });
        up.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await Json(up);
        body.GetProperty("steps").GetInt32().Should().Be(8200);
        body.GetProperty("distanceMeters").GetInt32().Should().Be(6100);
        body.GetProperty("activeCalories").GetInt32().Should().Be(480);
        body.GetProperty("calorieMode").GetString().Should().Be("add");

        // It appears on the day.
        var day = await Json(await user.GetAsync($"/api/tracker/day?date={Today}"));
        var act = day.GetProperty("activity");
        act.ValueKind.Should().Be(JsonValueKind.Object);
        act.GetProperty("steps").GetInt32().Should().Be(8200);
        act.GetProperty("distanceMeters").GetInt32().Should().Be(6100);
        act.GetProperty("activeCalories").GetInt32().Should().Be(480);
        act.GetProperty("calorieMode").GetString().Should().Be("add");

        // A second upsert UPSERTS the single (user, date) row (no duplicate) and switches the mode.
        await user.PutAsJsonAsync("/api/tracker/activity", new
        {
            date = Today, steps = 9000, distanceMeters = 7000, activeCalories = 510, calorieMode = "override",
        });
        var day2 = await Json(await user.GetAsync($"/api/tracker/day?date={Today}"));
        day2.GetProperty("activity").GetProperty("steps").GetInt32().Should().Be(9000);
        day2.GetProperty("activity").GetProperty("calorieMode").GetString().Should().Be("override");

        // Clearing removes it for the day → 204, and the day's activity is null again.
        (await user.DeleteAsync($"/api/tracker/activity?date={Today}")).StatusCode.Should().Be(HttpStatusCode.NoContent);
        var after = await Json(await user.GetAsync($"/api/tracker/day?date={Today}"));
        after.GetProperty("activity").ValueKind.Should().Be(JsonValueKind.Null);
    }

    // ---- ADD mode: caloriesOut = exercises + active; exerciseCalories reported raw ----

    [Fact]
    public async Task Add_mode_adds_watch_active_calories_on_top_of_logged_exercises()
    {
        var (_, user) = await ProvisionUser("tracker.self");
        await user.PutAsJsonAsync("/api/tracker/profile", new
        {
            goal = "Maintain", dailyCalorieGoal = 2000, shareWithContacts = false,
        });

        // 700 in, 200 logged-exercise calories.
        await user.PostAsJsonAsync("/api/tracker/food", new
        {
            date = Today, meal = "lunch", description = "Burrito", quantity = 1.0,
            calories = 700, proteinG = 30.0, carbG = 80.0, fatG = 20.0,
        });
        await user.PostAsJsonAsync("/api/tracker/exercise", new
        {
            date = Today, name = "Run", durationMin = 20, caloriesBurned = 200,
        });
        // Watch: 350 active calories in ADD mode.
        await user.PutAsJsonAsync("/api/tracker/activity", new
        {
            date = Today, steps = 5000, activeCalories = 350, calorieMode = "add",
        });

        var day = await Json(await user.GetAsync($"/api/tracker/day?date={Today}"));
        day.GetProperty("exerciseCalories").GetInt32().Should().Be(200);  // raw logged sum, unchanged
        day.GetProperty("caloriesOut").GetInt32().Should().Be(550);       // 200 + 350
        day.GetProperty("caloriesIn").GetInt32().Should().Be(700);
        day.GetProperty("netCalories").GetInt32().Should().Be(150);       // 700 - 550
        // remaining = goal - in + out = 2000 - 700 + 550 = 1850.
        day.GetProperty("remaining").GetInt32().Should().Be(1850);
    }

    // ---- OVERRIDE mode: caloriesOut = active (ignores the exercise sum); exerciseCalories still reported ----

    [Fact]
    public async Task Override_mode_replaces_the_logged_exercise_sum_with_watch_active_calories()
    {
        var (_, user) = await ProvisionUser("tracker.self");
        await user.PutAsJsonAsync("/api/tracker/profile", new
        {
            goal = "Maintain", dailyCalorieGoal = 2000, shareWithContacts = false,
        });

        await user.PostAsJsonAsync("/api/tracker/food", new
        {
            date = Today, meal = "lunch", description = "Burrito", quantity = 1.0,
            calories = 700, proteinG = 30.0, carbG = 80.0, fatG = 20.0,
        });
        await user.PostAsJsonAsync("/api/tracker/exercise", new
        {
            date = Today, name = "Run", durationMin = 20, caloriesBurned = 200,
        });
        // Watch: 540 active calories in OVERRIDE mode → the watch total replaces the exercise sum.
        await user.PutAsJsonAsync("/api/tracker/activity", new
        {
            date = Today, activeCalories = 540, calorieMode = "override",
        });

        var day = await Json(await user.GetAsync($"/api/tracker/day?date={Today}"));
        day.GetProperty("exerciseCalories").GetInt32().Should().Be(200);  // still reported raw
        day.GetProperty("caloriesOut").GetInt32().Should().Be(540);       // watch total, exercises ignored
        day.GetProperty("netCalories").GetInt32().Should().Be(160);       // 700 - 540
        // remaining = 2000 - 700 + 540 = 1840.
        day.GetProperty("remaining").GetInt32().Should().Be(1840);
    }

    // ---- No watch entry (or no active calories): caloriesOut = exercises (unchanged) ----

    [Fact]
    public async Task No_watch_entry_leaves_calories_out_as_the_exercise_sum()
    {
        var (_, user) = await ProvisionUser("tracker.self");

        await user.PostAsJsonAsync("/api/tracker/exercise", new
        {
            date = Today, name = "Cycle", durationMin = 40, caloriesBurned = 300,
        });

        // No activity row at all → caloriesOut == exerciseCalories.
        var day = await Json(await user.GetAsync($"/api/tracker/day?date={Today}"));
        day.GetProperty("exerciseCalories").GetInt32().Should().Be(300);
        day.GetProperty("caloriesOut").GetInt32().Should().Be(300);
        day.GetProperty("activity").ValueKind.Should().Be(JsonValueKind.Null);

        // An activity row WITHOUT an active-calories value (steps only) also leaves caloriesOut untouched,
        // even in ADD mode — there is nothing to add.
        await user.PutAsJsonAsync("/api/tracker/activity", new
        {
            date = Today, steps = 12000, calorieMode = "add",
        });
        var day2 = await Json(await user.GetAsync($"/api/tracker/day?date={Today}"));
        day2.GetProperty("caloriesOut").GetInt32().Should().Be(300);   // still just the exercise sum
        day2.GetProperty("exerciseCalories").GetInt32().Should().Be(300);
        day2.GetProperty("activity").GetProperty("steps").GetInt32().Should().Be(12000);
        day2.GetProperty("activity").GetProperty("activeCalories").ValueKind.Should().Be(JsonValueKind.Null);
    }

    // ---- Activity validation: bounds + mode + date → 400 ----

    [Fact]
    public async Task Upserting_activity_rejects_out_of_range_values_and_bad_mode()
    {
        var (_, user) = await ProvisionUser("tracker.self");

        (await user.PutAsJsonAsync("/api/tracker/activity", new { date = Today, steps = 200001 }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await user.PutAsJsonAsync("/api/tracker/activity", new { date = Today, distanceMeters = 1000001 }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await user.PutAsJsonAsync("/api/tracker/activity", new { date = Today, activeCalories = 20001 }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await user.PutAsJsonAsync("/api/tracker/activity", new { date = Today, steps = -1 }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await user.PutAsJsonAsync("/api/tracker/activity", new { date = Today, calorieMode = "nonsense" }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await user.PutAsJsonAsync("/api/tracker/activity", new { date = "not-a-date", steps = 5000 }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    // ---- Step goal: defaults to null + round-trips via the profile ----

    [Fact]
    public async Task Step_goal_is_null_by_default_and_round_trips_via_the_profile()
    {
        var (_, user) = await ProvisionUser("tracker.self");

        // Unset by default (the UI supplies the ~10000 placeholder, not the backend).
        var p = await Json(await user.GetAsync("/api/tracker/profile"));
        p.GetProperty("stepGoal").ValueKind.Should().Be(JsonValueKind.Null);

        var put = await user.PutAsJsonAsync("/api/tracker/profile", new
        {
            goal = "Maintain", shareWithContacts = false, stepGoal = 12000,
        });
        put.StatusCode.Should().Be(HttpStatusCode.OK);
        (await Json(put)).GetProperty("stepGoal").GetInt32().Should().Be(12000);

        // It round-trips on the profile AND surfaces on the day's stepGoal.
        var saved = await Json(await user.GetAsync("/api/tracker/profile"));
        saved.GetProperty("stepGoal").GetInt32().Should().Be(12000);

        var day = await Json(await user.GetAsync($"/api/tracker/day?date={Today}"));
        day.GetProperty("stepGoal").GetInt32().Should().Be(12000);
    }

    // ---- Activity visibility: a viewer sees the stats + resolved burn; writes target only the caller ----

    [Fact]
    public async Task A_shared_users_activity_is_visible_read_only_but_a_write_targets_only_the_caller()
    {
        var (aliceEmail, alice) = await ProvisionUser("tracker.self");
        var (bobEmail, bob) = await ProvisionUser("tracker.self");
        await MakeContacts(aliceEmail, bobEmail);

        await alice.PutAsJsonAsync("/api/tracker/profile", new
        {
            goal = "Maintain", shareWithContacts = true, stepGoal = 11000,
        });
        await alice.PostAsJsonAsync("/api/tracker/exercise", new
        {
            date = Today, name = "Swim", durationMin = 30, caloriesBurned = 250,
        });
        await alice.PutAsJsonAsync("/api/tracker/activity", new
        {
            date = Today, steps = 9400, distanceMeters = 7200, activeCalories = 600, calorieMode = "override",
        });

        // Bob (a sharing mutual contact) sees Alice's activity stats + the RESOLVED burn (override → 600).
        var aliceId = await UserIdFor(aliceEmail);
        var viewed = await Json(await bob.GetAsync($"/api/tracker/day?date={Today}&user={aliceId}"));
        viewed.GetProperty("readOnly").GetBoolean().Should().BeTrue();
        var act = viewed.GetProperty("activity");
        act.GetProperty("steps").GetInt32().Should().Be(9400);
        act.GetProperty("distanceMeters").GetInt32().Should().Be(7200);
        act.GetProperty("activeCalories").GetInt32().Should().Be(600);
        act.GetProperty("calorieMode").GetString().Should().Be("override");
        viewed.GetProperty("exerciseCalories").GetInt32().Should().Be(250);
        viewed.GetProperty("caloriesOut").GetInt32().Should().Be(600);     // override → the watch total
        viewed.GetProperty("stepGoal").GetInt32().Should().Be(11000);

        // There is no ?user= on the write — Bob upserting activity lands on BOB's own day, never Alice's.
        await bob.PutAsJsonAsync("/api/tracker/activity", new { date = Today, steps = 1, activeCalories = 999 });
        var aliceAfter = await Json(await alice.GetAsync($"/api/tracker/day?date={Today}"));
        aliceAfter.GetProperty("activity").GetProperty("steps").GetInt32().Should().Be(9400); // unchanged
        aliceAfter.GetProperty("caloriesOut").GetInt32().Should().Be(600);                    // unchanged
    }

    // ===================================================================================
    // AI Day Builder commit (POST /api/tracker/day/commit) — atomic, idempotent, gated tracker.self
    // ===================================================================================

    /// <summary>A full draft with every domain, for the commit tests.</summary>
    private static object FullDraft() => new
    {
        meals = new[]
        {
            new
            {
                meal = "breakfast",
                items = new[]
                {
                    new { description = "Eggs", quantity = "2 eggs", calories = 200, proteinG = 12.0, carbG = 2.0, fatG = 14.0, confidence = 0.9, clamped = false },
                },
            },
            new
            {
                meal = "lunch",
                items = new[]
                {
                    new { description = "Chicken & rice", quantity = "1 plate", calories = 600, proteinG = 45.0, carbG = 60.0, fatG = 12.0, confidence = 0.7, clamped = false },
                },
            },
        },
        exercises = new[]
        {
            new { name = "Run", durationMin = 30, caloriesBurned = 300, confidence = 0.8, clamped = false },
        },
        hydration = new[]
        {
            new { label = "Water", ml = 500 },
            new { label = "Coffee", ml = 240 },
        },
        weight = new { weightKg = 80.5, slot = "morning" },
        activity = new { steps = 9000, distanceMeters = 6000, activeCalories = 400, calorieMode = "add" },
        assumptions = new[] { "Assumed 2 eggs" },
        summary = "A balanced day.",
    };

    [Fact]
    public async Task Commit_endpoint_requires_authentication_and_tracker_self()
    {
        var anon = factory.CreateClient();
        (await anon.PostAsJsonAsync("/api/tracker/day/commit", new { buildId = "x", date = Today, draft = new { } }))
            .StatusCode.Should().Be(HttpStatusCode.Unauthorized);

        var (_, noTracker) = await ProvisionUser("dashboard.view");
        (await noTracker.PostAsJsonAsync("/api/tracker/day/commit", new { buildId = "x", date = Today, draft = new { } }))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Commit_requires_a_buildId_and_a_valid_date()
    {
        var (_, user) = await ProvisionUser("tracker.self");
        (await user.PostAsJsonAsync("/api/tracker/day/commit", new { buildId = "", date = Today, draft = new { } }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await user.PostAsJsonAsync("/api/tracker/day/commit", new { buildId = "b1", date = "nope", draft = new { } }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Commit_logs_every_domain_in_one_pass_and_shows_on_the_day()
    {
        var (_, user) = await ProvisionUser("tracker.self");
        await user.PutAsJsonAsync("/api/tracker/profile", new
        {
            goal = "Maintain", weightKg = 70.0, dailyCalorieGoal = 2000, shareWithContacts = false,
        });

        var buildId = Guid.NewGuid().ToString("N");
        var res = await user.PostAsJsonAsync("/api/tracker/day/commit", new { buildId, date = Today, draft = FullDraft() });
        res.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await Json(res);
        body.GetProperty("alreadyCommitted").GetBoolean().Should().BeFalse();
        var logged = body.GetProperty("logged");
        logged.GetProperty("foods").GetInt32().Should().Be(2);
        logged.GetProperty("exercises").GetInt32().Should().Be(1);
        logged.GetProperty("drinks").GetInt32().Should().Be(2);
        logged.GetProperty("weight").GetBoolean().Should().BeTrue();
        logged.GetProperty("activity").GetBoolean().Should().BeTrue();

        // The returned day reflects the writes.
        var day = body.GetProperty("day");
        day.GetProperty("caloriesIn").GetInt32().Should().Be(800);
        day.GetProperty("caloriesOut").GetInt32().Should().Be(700); // 300 exercise + 400 active (add)
        day.GetProperty("hydrationMl").GetInt32().Should().Be(740);
        day.GetProperty("foods").EnumerateArray().Should().HaveCount(2);
        day.GetProperty("activity").GetProperty("steps").GetInt32().Should().Be(9000);

        // Re-reading the day independently shows the same data.
        var reread = await Json(await user.GetAsync($"/api/tracker/day?date={Today}"));
        reread.GetProperty("foods").EnumerateArray().Should().HaveCount(2);
        reread.GetProperty("hydration").EnumerateArray().Should().HaveCount(2);
    }

    [Fact]
    public async Task Commit_is_idempotent_on_the_same_buildId()
    {
        var (_, user) = await ProvisionUser("tracker.self");
        var buildId = Guid.NewGuid().ToString("N");

        var first = await user.PostAsJsonAsync("/api/tracker/day/commit", new { buildId, date = Today, draft = FullDraft() });
        first.StatusCode.Should().Be(HttpStatusCode.OK);
        (await Json(first)).GetProperty("alreadyCommitted").GetBoolean().Should().BeFalse();

        // A repeat with the SAME buildId writes nothing and reports alreadyCommitted.
        var second = await user.PostAsJsonAsync("/api/tracker/day/commit", new { buildId, date = Today, draft = FullDraft() });
        second.StatusCode.Should().Be(HttpStatusCode.OK);
        (await Json(second)).GetProperty("alreadyCommitted").GetBoolean().Should().BeTrue();

        // Still only ONE pass of foods on the day (no double-log).
        var day = await Json(await user.GetAsync($"/api/tracker/day?date={Today}"));
        day.GetProperty("foods").EnumerateArray().Should().HaveCount(2);
    }

    [Fact]
    public async Task Commit_clamps_absurd_numbers_and_drops_blank_descriptions()
    {
        var (_, user) = await ProvisionUser("tracker.self");
        var buildId = Guid.NewGuid().ToString("N");

        var draft = new
        {
            meals = new[]
            {
                new
                {
                    meal = "dinner",
                    items = new[]
                    {
                        // Absurd calories/macros: clamped to 5000 cal / 500 g.
                        new { description = "Monster plate", quantity = "huge", calories = 999999, proteinG = 9999.0, carbG = 9999.0, fatG = 9999.0, confidence = 1.0, clamped = true },
                        // Blank description: dropped entirely.
                        new { description = "   ", quantity = "x", calories = 100, proteinG = 1.0, carbG = 1.0, fatG = 1.0, confidence = 1.0, clamped = false },
                    },
                },
            },
            exercises = Array.Empty<object>(),
            hydration = new[] { new { label = "X", ml = 999999 } }, // out of 1..5000 -> dropped
            weight = new { weightKg = 5000.0, slot = "morning" },    // out of 1..1000 -> dropped
            activity = (object?)null,
            assumptions = Array.Empty<string>(),
            summary = "",
        };

        var res = await user.PostAsJsonAsync("/api/tracker/day/commit", new { buildId, date = Today, draft });
        res.StatusCode.Should().Be(HttpStatusCode.OK);
        var logged = (await Json(res)).GetProperty("logged");
        logged.GetProperty("foods").GetInt32().Should().Be(1);   // the blank one was dropped
        logged.GetProperty("drinks").GetInt32().Should().Be(0);  // the 999999 ml drink was dropped
        logged.GetProperty("weight").GetBoolean().Should().BeFalse(); // out-of-range weight dropped

        var day = await Json(await user.GetAsync($"/api/tracker/day?date={Today}"));
        day.GetProperty("caloriesIn").GetInt32().Should().Be(5000);            // calories clamped
        var food = day.GetProperty("foods").EnumerateArray().Single();
        food.GetProperty("proteinG").GetDouble().Should().Be(500.0);           // macros clamped
    }

    // ===================================================================================
    // Move day (POST /api/tracker/day/move) — re-date the caller's OWN entries, by category
    // ===================================================================================

    private const string MoveFrom = "2026-06-10";
    private const string MoveTo = "2026-06-11";

    [Fact]
    public async Task Move_endpoint_requires_authentication_and_tracker_self()
    {
        var anon = factory.CreateClient();
        (await anon.PostAsJsonAsync("/api/tracker/day/move", new { fromDate = MoveFrom, toDate = MoveTo }))
            .StatusCode.Should().Be(HttpStatusCode.Unauthorized);

        var (_, noTracker) = await ProvisionUser("dashboard.view");
        (await noTracker.PostAsJsonAsync("/api/tracker/day/move", new { fromDate = MoveFrom, toDate = MoveTo }))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Move_rejects_bad_dates_and_a_same_date_move()
    {
        var (_, user) = await ProvisionUser("tracker.self");

        (await user.PostAsJsonAsync("/api/tracker/day/move", new { fromDate = "nope", toDate = MoveTo }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await user.PostAsJsonAsync("/api/tracker/day/move", new { fromDate = MoveFrom, toDate = "nope" }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
        // fromDate == toDate is a 400 (nothing to move).
        (await user.PostAsJsonAsync("/api/tracker/day/move", new { fromDate = MoveFrom, toDate = MoveFrom }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Move_redates_food_exercise_hydration_for_only_the_caller_and_chosen_categories()
    {
        var (_, alice) = await ProvisionUser("tracker.self");
        var (_, bob) = await ProvisionUser("tracker.self");

        // Alice logs food + exercise + hydration on MoveFrom, plus an UNRELATED food on a third date.
        await alice.PostAsJsonAsync("/api/tracker/food", new
        {
            date = MoveFrom, meal = "breakfast", description = "Oatmeal", quantity = 1.0,
            calories = 300, proteinG = 10.0, carbG = 54.0, fatG = 5.0,
        });
        await alice.PostAsJsonAsync("/api/tracker/exercise", new
        {
            date = MoveFrom, name = "Walk", durationMin = 30, caloriesBurned = 150,
        });
        await alice.PostAsJsonAsync("/api/tracker/hydration", new { date = MoveFrom, amountMl = 500 });
        await alice.PostAsJsonAsync("/api/tracker/food", new
        {
            date = "2026-06-09", meal = "lunch", description = "Other day", quantity = 1.0,
            calories = 100, proteinG = 1.0, carbG = 1.0, fatG = 1.0,
        });

        // Bob has his OWN food on MoveFrom that must be untouched by Alice's move.
        await bob.PostAsJsonAsync("/api/tracker/food", new
        {
            date = MoveFrom, meal = "dinner", description = "Bob's steak", quantity = 1.0,
            calories = 700, proteinG = 50.0, carbG = 0.0, fatG = 40.0,
        });

        // Move ONLY food + hydration (NOT exercise) from MoveFrom -> MoveTo.
        var res = await alice.PostAsJsonAsync("/api/tracker/day/move", new
        {
            fromDate = MoveFrom, toDate = MoveTo, categories = new[] { "food", "hydration" },
        });
        res.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await Json(res);
        body.GetProperty("toDate").GetString().Should().Be(MoveTo);
        var movedCounts = body.GetProperty("moved");
        movedCounts.GetProperty("food").GetInt32().Should().Be(1);
        movedCounts.GetProperty("hydration").GetInt32().Should().Be(1);
        movedCounts.GetProperty("exercise").GetInt32().Should().Be(0); // not chosen

        // The source date now has only the exercise (food + hydration moved away).
        var from = await Json(await alice.GetAsync($"/api/tracker/day?date={MoveFrom}"));
        from.GetProperty("foods").EnumerateArray().Should().BeEmpty();
        from.GetProperty("hydration").EnumerateArray().Should().BeEmpty();
        from.GetProperty("exercises").EnumerateArray().Should().ContainSingle(); // exercise stayed

        // The target date has the moved food + hydration (and no exercise).
        var to = await Json(await alice.GetAsync($"/api/tracker/day?date={MoveTo}"));
        to.GetProperty("foods").EnumerateArray().Should().ContainSingle();
        to.GetProperty("caloriesIn").GetInt32().Should().Be(300);
        to.GetProperty("hydrationMl").GetInt32().Should().Be(500);
        to.GetProperty("exercises").EnumerateArray().Should().BeEmpty();

        // Alice's other-date food is untouched.
        var otherDay = await Json(await alice.GetAsync($"/api/tracker/day?date=2026-06-09"));
        otherDay.GetProperty("foods").EnumerateArray().Should().ContainSingle();

        // Bob's MoveFrom food is untouched (the move only ever acts on the caller's rows).
        var bobDay = await Json(await bob.GetAsync($"/api/tracker/day?date={MoveFrom}"));
        bobDay.GetProperty("foods").EnumerateArray().Should().ContainSingle();
        bobDay.GetProperty("caloriesIn").GetInt32().Should().Be(700);
    }

    [Fact]
    public async Task Move_with_empty_categories_moves_all_domains()
    {
        var (_, user) = await ProvisionUser("tracker.self");

        await user.PostAsJsonAsync("/api/tracker/food", new
        {
            date = MoveFrom, meal = "breakfast", description = "Eggs", quantity = 1.0,
            calories = 200, proteinG = 12.0, carbG = 2.0, fatG = 14.0,
        });
        await user.PostAsJsonAsync("/api/tracker/exercise", new
        {
            date = MoveFrom, name = "Run", durationMin = 20, caloriesBurned = 200,
        });
        await user.PostAsJsonAsync("/api/tracker/hydration", new { date = MoveFrom, amountMl = 250 });
        await user.PostAsJsonAsync("/api/tracker/coffee", new { date = MoveFrom, cups = 2, caffeineMg = 190 });
        await user.PostAsJsonAsync("/api/tracker/weight", new { date = MoveFrom, weightKg = 80.0, slot = "Morning" });
        await user.PutAsJsonAsync("/api/tracker/activity", new { date = MoveFrom, steps = 8000, activeCalories = 300, calorieMode = "add" });

        // No categories => ALL.
        var res = await user.PostAsJsonAsync("/api/tracker/day/move", new { fromDate = MoveFrom, toDate = MoveTo });
        res.StatusCode.Should().Be(HttpStatusCode.OK);
        var moved = (await Json(res)).GetProperty("moved");
        moved.GetProperty("food").GetInt32().Should().Be(1);
        moved.GetProperty("exercise").GetInt32().Should().Be(1);
        moved.GetProperty("hydration").GetInt32().Should().Be(1);
        moved.GetProperty("coffee").GetInt32().Should().Be(1);
        moved.GetProperty("weight").GetInt32().Should().Be(1);
        moved.GetProperty("activity").GetBoolean().Should().BeTrue();

        // Source is fully empty; target carries everything.
        var from = await Json(await user.GetAsync($"/api/tracker/day?date={MoveFrom}"));
        from.GetProperty("foods").EnumerateArray().Should().BeEmpty();
        from.GetProperty("exercises").EnumerateArray().Should().BeEmpty();
        from.GetProperty("hydration").EnumerateArray().Should().BeEmpty();
        from.GetProperty("coffee").EnumerateArray().Should().BeEmpty();
        from.GetProperty("activity").ValueKind.Should().Be(JsonValueKind.Null);

        var to = await Json(await user.GetAsync($"/api/tracker/day?date={MoveTo}"));
        to.GetProperty("caloriesIn").GetInt32().Should().Be(200);
        to.GetProperty("hydrationMl").GetInt32().Should().Be(250);
        to.GetProperty("coffeeCups").GetInt32().Should().Be(2);
        to.GetProperty("caffeineMg").GetInt32().Should().Be(190);
        to.GetProperty("activity").GetProperty("steps").GetInt32().Should().Be(8000);

        // Weight history reflects the moved date.
        var history = (await Json(await user.GetAsync("/api/tracker/weight?days=365"))).EnumerateArray().ToList();
        history.Should().ContainSingle();
        history[0].GetProperty("date").GetString().Should().Be(MoveTo);
    }

    [Fact]
    public async Task Move_weight_with_a_target_slot_conflict_replaces_the_target_and_reports_it()
    {
        var (_, user) = await ProvisionUser("tracker.self");

        // Source: morning 80 + evening 82. Target already has a MORNING 99 (conflict) and an
        // AFTERNOON 70 (no source slot -> must survive).
        await user.PostAsJsonAsync("/api/tracker/weight", new { date = MoveFrom, weightKg = 80.0, slot = "Morning" });
        await user.PostAsJsonAsync("/api/tracker/weight", new { date = MoveFrom, weightKg = 82.0, slot = "Evening" });
        await user.PostAsJsonAsync("/api/tracker/weight", new { date = MoveTo, weightKg = 99.0, slot = "Morning" });
        await user.PostAsJsonAsync("/api/tracker/weight", new { date = MoveTo, weightKg = 70.0, slot = "Afternoon" });

        var res = await user.PostAsJsonAsync("/api/tracker/day/move", new
        {
            fromDate = MoveFrom, toDate = MoveTo, categories = new[] { "weight" },
        });
        res.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await Json(res);
        body.GetProperty("moved").GetProperty("weight").GetInt32().Should().Be(2);
        body.GetProperty("replaced").GetProperty("weight").GetInt32().Should().Be(1); // the morning conflict

        // Source has no weights left.
        var fromStats = await Json(await user.GetAsync($"/api/tracker/weight/stats?days=365"));

        // Target: moved Morning(80) WINS over the old 99; Evening(82) added; Afternoon(70) preserved.
        var entries = fromStats.GetProperty("entries").EnumerateArray()
            .Where(e => e.GetProperty("date").GetString() == MoveTo).ToList();
        entries.Should().HaveCount(3);
        entries.Single(e => e.GetProperty("slot").GetString() == "Morning")
            .GetProperty("weightKg").GetDouble().Should().Be(80.0); // moved value wins, not 99
        entries.Single(e => e.GetProperty("slot").GetString() == "Evening")
            .GetProperty("weightKg").GetDouble().Should().Be(82.0);
        entries.Single(e => e.GetProperty("slot").GetString() == "Afternoon")
            .GetProperty("weightKg").GetDouble().Should().Be(70.0); // untouched
        entries.Should().OnlyContain(e => e.GetProperty("date").GetString() == MoveTo);
    }

    [Fact]
    public async Task Move_activity_with_a_target_conflict_replaces_and_reports()
    {
        var (_, user) = await ProvisionUser("tracker.self");

        // Source activity (moved) vs an existing target activity (replaced).
        await user.PutAsJsonAsync("/api/tracker/activity", new
        {
            date = MoveFrom, steps = 9000, distanceMeters = 6000, activeCalories = 400, calorieMode = "add",
        });
        await user.PutAsJsonAsync("/api/tracker/activity", new
        {
            date = MoveTo, steps = 100, distanceMeters = 50, activeCalories = 10, calorieMode = "override",
        });

        var res = await user.PostAsJsonAsync("/api/tracker/day/move", new
        {
            fromDate = MoveFrom, toDate = MoveTo, categories = new[] { "activity" },
        });
        res.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await Json(res);
        body.GetProperty("moved").GetProperty("activity").GetBoolean().Should().BeTrue();
        body.GetProperty("replaced").GetProperty("activity").GetBoolean().Should().BeTrue();

        // Source has no activity; target carries the MOVED stats (the old target was replaced).
        var from = await Json(await user.GetAsync($"/api/tracker/day?date={MoveFrom}"));
        from.GetProperty("activity").ValueKind.Should().Be(JsonValueKind.Null);

        var to = await Json(await user.GetAsync($"/api/tracker/day?date={MoveTo}"));
        var act = to.GetProperty("activity");
        act.GetProperty("steps").GetInt32().Should().Be(9000);
        act.GetProperty("calorieMode").GetString().Should().Be("add");
    }

    [Fact]
    public async Task Move_into_a_clean_target_does_not_report_replacements()
    {
        var (_, user) = await ProvisionUser("tracker.self");

        await user.PostAsJsonAsync("/api/tracker/weight", new { date = MoveFrom, weightKg = 80.0, slot = "Morning" });
        await user.PutAsJsonAsync("/api/tracker/activity", new { date = MoveFrom, steps = 5000, activeCalories = 200, calorieMode = "add" });

        var res = await user.PostAsJsonAsync("/api/tracker/day/move", new { fromDate = MoveFrom, toDate = MoveTo });
        res.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await Json(res);
        body.GetProperty("moved").GetProperty("weight").GetInt32().Should().Be(1);
        body.GetProperty("moved").GetProperty("activity").GetBoolean().Should().BeTrue();
        // Nothing on the target to replace.
        body.GetProperty("replaced").GetProperty("weight").GetInt32().Should().Be(0);
        body.GetProperty("replaced").GetProperty("activity").GetBoolean().Should().BeFalse();
    }
}
