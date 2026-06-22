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
/// 75 Hard v2 backend (/api/challenge): auth (401) + tracker.self (403) gating; the one-active invariant; the
/// ?user visibility gate (sharer visible read-only, non-sharer 404, confession nulled, no email); the
/// CONFIGURABLE task set (default seed, custom-target edits, custom manual tasks, add/disable/delete); per-day
/// manual progress incl. reading pages with PARTIAL points; AUTO scoring against custom targets; the
/// contacts-only leaderboard (sharer in, non-sharer/non-contact out, NO email); the AI coach plain floor; and
/// that PhotoTaken is gone. Every test provisions fresh users so they're order-independent.
/// </summary>
[Collection(IntegrationCollection.Name)]
public class HardChallengeTests(WebAppFactory factory)
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
        var email = $"hard-{Guid.NewGuid():N}@test.local";
        var res = await Admin().PostAsJsonAsync("/api/users", new { email, isEnabled = true, permissions });
        res.StatusCode.Should().Be(HttpStatusCode.Created);
        return (email, Client(email));
    }

    private static async Task<JsonElement> Json(HttpResponseMessage resp) =>
        await resp.Content.ReadFromJsonAsync<JsonElement>();

    private static bool HasProperty(JsonElement e, string name) => e.TryGetProperty(name, out _);

    /// <summary>The day's task entry by stable key (the new per-task day breakdown).</summary>
    private static JsonElement Task(JsonElement day, string key) =>
        day.GetProperty("tasks").EnumerateArray().First(t => t.GetProperty("key").GetString() == key);

    private async Task MakeContacts(string aEmail, string bEmail)
    {
        var aId = await UserIdFor(aEmail);
        var bId = await UserIdFor(bEmail);
        var res = await Admin().PostAsJsonAsync($"/api/chat/contacts/user/{aId}", new { contactUserId = bId });
        res.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    private async Task<int> UserIdFor(string email)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        return await db.Users.AsNoTracking().Where(u => u.Email == email).Select(u => u.Id).FirstAsync();
    }

    // The test container has no configured display timezone → "today" is UTC today.
    private static readonly string Today = DateTime.UtcNow.ToString("yyyy-MM-dd");

    // ---- Gating ----

    [Fact]
    public async Task Challenge_endpoints_require_authentication()
    {
        var anon = factory.CreateClient();
        (await anon.GetAsync("/api/challenge")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await anon.GetAsync($"/api/challenge/day?date={Today}")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await anon.GetAsync("/api/challenge/shared")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await anon.GetAsync("/api/challenge/leaderboard")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await anon.GetAsync("/api/challenge/coach")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await anon.PostAsJsonAsync("/api/challenge", new { })).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Challenge_endpoints_require_tracker_self()
    {
        var (_, noTracker) = await ProvisionUser("dashboard.view");
        (await noTracker.GetAsync("/api/challenge")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await noTracker.GetAsync($"/api/challenge/day?date={Today}")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await noTracker.GetAsync("/api/challenge/shared")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await noTracker.GetAsync("/api/challenge/leaderboard")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await noTracker.GetAsync("/api/challenge/coach")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await noTracker.PostAsJsonAsync("/api/challenge", new { })).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await noTracker.PutAsJsonAsync("/api/challenge/day", new { date = Today })).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await noTracker.PostAsJsonAsync("/api/challenge/cheat-days", new { })).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await noTracker.PostAsJsonAsync("/api/challenge/tasks", new { label = "x" })).StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    // ---- Start + default task set ----

    [Fact]
    public async Task Start_seeds_the_default_task_set_minus_the_photo()
    {
        var (_, user) = await ProvisionUser("tracker.self");
        var before = await user.GetAsync("/api/challenge");
        (await Json(before)).ValueKind.Should().Be(JsonValueKind.Null);

        var start = await user.PostAsJsonAsync("/api/challenge", new { startDate = Today });
        start.StatusCode.Should().Be(HttpStatusCode.OK);
        var dto = await Json(start);
        dto.GetProperty("status").GetString().Should().Be("Active");
        dto.GetProperty("currentDay").GetInt32().Should().Be(1);
        dto.GetProperty("totalDays").GetInt32().Should().Be(75);
        dto.GetProperty("days").EnumerateArray().Should().HaveCount(75);

        var keys = dto.GetProperty("tasks").EnumerateArray().Select(t => t.GetProperty("key").GetString()).ToList();
        keys.Should().BeEquivalentTo(new[] { "diet", "water", "workout", "reading", "no-alcohol" });
        keys.Should().NotContain("photo");

        // The water task carries the gallon default; workout the count-of-2 default.
        var water = dto.GetProperty("tasks").EnumerateArray().First(t => t.GetProperty("key").GetString() == "water");
        water.GetProperty("targetValue").GetDecimal().Should().Be(3785);
        var workout = dto.GetProperty("tasks").EnumerateArray().First(t => t.GetProperty("key").GetString() == "workout");
        workout.GetProperty("targetValue").GetDecimal().Should().Be(2);
        workout.GetProperty("minMinutes").GetInt32().Should().Be(45);
    }

    [Fact]
    public async Task A_second_start_while_one_is_active_is_409()
    {
        var (_, user) = await ProvisionUser("tracker.self");
        (await user.PostAsJsonAsync("/api/challenge", new { startDate = Today })).StatusCode.Should().Be(HttpStatusCode.OK);
        (await user.PostAsJsonAsync("/api/challenge", new { startDate = Today })).StatusCode.Should().Be(HttpStatusCode.Conflict);
    }

    [Fact]
    public async Task PhotoTaken_is_gone_from_the_day_contract()
    {
        var (_, user) = await ProvisionUser("tracker.self");
        await user.PostAsJsonAsync("/api/challenge", new { startDate = Today });
        var day = await Json(await user.GetAsync($"/api/challenge/day?date={Today}"));
        HasProperty(day, "photoTaken").Should().BeFalse();
        day.GetProperty("tasks").EnumerateArray()
            .Should().NotContain(t => t.GetProperty("key").GetString() == "photo");
    }

    // ---- ?user visibility ----

    [Fact]
    public async Task A_sharing_users_challenge_is_visible_read_only_with_confession_nulled()
    {
        var (aliceEmail, alice) = await ProvisionUser("tracker.self");
        var (bobEmail, bob) = await ProvisionUser("tracker.self");
        await MakeContacts(aliceEmail, bobEmail);

        await alice.PutAsJsonAsync("/api/tracker/profile", new { goal = "Maintain", shareWithContacts = true });
        await alice.PostAsJsonAsync("/api/challenge", new { startDate = Today });
        await alice.PutAsJsonAsync("/api/challenge/day", new
        {
            date = Today, confession = "Slipped on the diet today.",
            tasks = new[] { new { key = "reading", value = 10 } },
        });

        var aliceId = await UserIdFor(aliceEmail);
        var viewed = await bob.GetAsync($"/api/challenge?user={aliceId}");
        viewed.StatusCode.Should().Be(HttpStatusCode.OK);
        var dto = await Json(viewed);
        dto.GetProperty("readOnly").GetBoolean().Should().BeTrue();
        dto.GetProperty("userId").GetInt32().Should().Be(aliceId);
        HasProperty(dto, "userEmail").Should().BeFalse();

        var day = dto.GetProperty("days").EnumerateArray().First(d => d.GetProperty("date").GetString() == Today);
        day.GetProperty("confession").ValueKind.Should().Be(JsonValueKind.Null);

        var own = await Json(await alice.GetAsync("/api/challenge"));
        var ownDay = own.GetProperty("days").EnumerateArray().First(d => d.GetProperty("date").GetString() == Today);
        ownDay.GetProperty("confession").GetString().Should().Be("Slipped on the diet today.");
    }

    [Fact]
    public async Task A_non_sharing_users_challenge_is_404_to_a_contact_and_to_a_stranger()
    {
        var (aliceEmail, alice) = await ProvisionUser("tracker.self");
        var (bobEmail, bob) = await ProvisionUser("tracker.self");
        await MakeContacts(aliceEmail, bobEmail);

        await alice.PutAsJsonAsync("/api/tracker/profile", new { goal = "Maintain", shareWithContacts = false });
        await alice.PostAsJsonAsync("/api/challenge", new { startDate = Today });

        var aliceId = await UserIdFor(aliceEmail);
        (await bob.GetAsync($"/api/challenge?user={aliceId}")).StatusCode.Should().Be(HttpStatusCode.NotFound);
        (await bob.GetAsync($"/api/challenge/day?date={Today}&user={aliceId}")).StatusCode.Should().Be(HttpStatusCode.NotFound);

        (await alice.GetAsync("/api/challenge?user=999999999")).StatusCode.Should().Be(HttpStatusCode.NotFound);
        (await alice.GetAsync("/api/challenge?user=0")).StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Tracker_viewall_can_read_anyones_challenge_read_only()
    {
        var (aliceEmail, alice) = await ProvisionUser("tracker.self");
        var (_, coach) = await ProvisionUser("tracker.self", "tracker.viewall");

        await alice.PutAsJsonAsync("/api/tracker/profile", new { goal = "Maintain", shareWithContacts = false });
        await alice.PostAsJsonAsync("/api/challenge", new { startDate = Today });

        var aliceId = await UserIdFor(aliceEmail);
        var viewed = await coach.GetAsync($"/api/challenge?user={aliceId}");
        viewed.StatusCode.Should().Be(HttpStatusCode.OK);
        (await Json(viewed)).GetProperty("readOnly").GetBoolean().Should().BeTrue();
    }

    // ---- Shared + leaderboard (contacts-only, NEVER an email) ----

    [Fact]
    public async Task Shared_list_includes_sharing_contacts_and_never_an_email()
    {
        var (aliceEmail, alice) = await ProvisionUser("tracker.self");
        var (bobEmail, bob) = await ProvisionUser("tracker.self");
        await MakeContacts(aliceEmail, bobEmail);

        await alice.PutAsJsonAsync("/api/tracker/profile", new { goal = "Maintain", shareWithContacts = true });

        var aliceId = await UserIdFor(aliceEmail);
        var bobShared = (await Json(await bob.GetAsync("/api/challenge/shared"))).EnumerateArray().ToList();
        bobShared.Select(u => u.GetProperty("userId").GetInt32()).Should().Contain(aliceId);
        bobShared.Should().NotContain(u => HasProperty(u, "email"));
    }

    [Fact]
    public async Task Leaderboard_returns_self_plus_sharing_contacts_only_and_never_an_email()
    {
        // sharer (contact + shares + has an active challenge) → appears;
        // nonSharerContact (contact but does NOT share) → omitted;
        // stranger (not a contact, shares) → omitted.
        var (meEmail, me) = await ProvisionUser("tracker.self");
        var (sharerEmail, sharer) = await ProvisionUser("tracker.self");
        var (nonSharerEmail, nonSharer) = await ProvisionUser("tracker.self");
        var (strangerEmail, stranger) = await ProvisionUser("tracker.self");

        await MakeContacts(meEmail, sharerEmail);
        await MakeContacts(meEmail, nonSharerEmail);

        await me.PostAsJsonAsync("/api/challenge", new { startDate = Today });
        await sharer.PutAsJsonAsync("/api/tracker/profile", new { goal = "Maintain", shareWithContacts = true });
        await sharer.PostAsJsonAsync("/api/challenge", new { startDate = Today });
        await nonSharer.PutAsJsonAsync("/api/tracker/profile", new { goal = "Maintain", shareWithContacts = false });
        await nonSharer.PostAsJsonAsync("/api/challenge", new { startDate = Today });
        await stranger.PutAsJsonAsync("/api/tracker/profile", new { goal = "Maintain", shareWithContacts = true });
        await stranger.PostAsJsonAsync("/api/challenge", new { startDate = Today });

        var meId = await UserIdFor(meEmail);
        var sharerId = await UserIdFor(sharerEmail);
        var nonSharerId = await UserIdFor(nonSharerEmail);
        var strangerId = await UserIdFor(strangerEmail);

        var board = (await Json(await me.GetAsync("/api/challenge/leaderboard"))).EnumerateArray().ToList();
        var ids = board.Select(r => r.GetProperty("userId").GetInt32()).ToList();

        ids.Should().Contain(meId);          // self is always on the board
        ids.Should().Contain(sharerId);      // a sharing contact appears
        ids.Should().NotContain(nonSharerId);// a non-sharing contact does not
        ids.Should().NotContain(strangerId); // a non-contact does not

        board.Should().OnlyContain(r => HasProperty(r, "currentDay") && HasProperty(r, "totalPoints"));
        board.Should().NotContain(r => HasProperty(r, "email") || HasProperty(r, "userEmail"));
        board.First(r => r.GetProperty("userId").GetInt32() == meId).GetProperty("isSelf").GetBoolean().Should().BeTrue();
    }

    [Fact]
    public async Task Leaderboard_omits_a_sharer_with_no_active_challenge()
    {
        var (meEmail, me) = await ProvisionUser("tracker.self");
        var (sharerEmail, sharer) = await ProvisionUser("tracker.self");
        await MakeContacts(meEmail, sharerEmail);
        await me.PostAsJsonAsync("/api/challenge", new { startDate = Today });
        // sharer shares but never starts a challenge → omitted.
        await sharer.PutAsJsonAsync("/api/tracker/profile", new { goal = "Maintain", shareWithContacts = true });

        var sharerId = await UserIdFor(sharerEmail);
        var board = (await Json(await me.GetAsync("/api/challenge/leaderboard"))).EnumerateArray().ToList();
        board.Select(r => r.GetProperty("userId").GetInt32()).Should().NotContain(sharerId);
    }

    // ---- Task config CRUD ----

    [Fact]
    public async Task A_custom_water_target_changes_the_water_progress()
    {
        var (_, user) = await ProvisionUser("tracker.self");
        await user.PostAsJsonAsync("/api/challenge", new { startDate = Today });

        // 2000 ml logged.
        await user.PostAsJsonAsync("/api/tracker/hydration", new { date = Today, amountMl = 2000 });

        // Against the gallon default, water is ~53% (incomplete).
        var beforeDay = await Json(await user.GetAsync($"/api/challenge/day?date={Today}"));
        Task(beforeDay, "water").GetProperty("progress").GetDouble().Should().BeLessThan(1.0);

        // Lower the water target to 2000 ml → now complete at 100%.
        var waterTaskId = (await Json(await user.GetAsync("/api/challenge/tasks")))
            .EnumerateArray().First(t => t.GetProperty("key").GetString() == "water").GetProperty("id").GetInt32();
        var edit = await user.PutAsJsonAsync($"/api/challenge/tasks/{waterTaskId}", new { targetValue = 2000 });
        edit.StatusCode.Should().Be(HttpStatusCode.OK);

        var afterDay = await Json(await user.GetAsync($"/api/challenge/day?date={Today}"));
        Task(afterDay, "water").GetProperty("progress").GetDouble().Should().Be(1.0);
        Task(afterDay, "water").GetProperty("complete").GetBoolean().Should().BeTrue();
    }

    [Fact]
    public async Task A_custom_manual_task_can_be_added_progressed_and_deleted()
    {
        var (_, user) = await ProvisionUser("tracker.self");
        await user.PostAsJsonAsync("/api/challenge", new { startDate = Today });

        // Add a measurable custom task (meditate 20 minutes, partial credit, 10 points).
        var created = await user.PostAsJsonAsync("/api/challenge/tasks", new
        {
            label = "Meditate", targetValue = 20, unit = "min", pointValue = 10, partialCredit = true,
        });
        created.StatusCode.Should().Be(HttpStatusCode.OK);
        var task = await Json(created);
        var key = task.GetProperty("key").GetString();
        key.Should().Be("custom-1");
        var id = task.GetProperty("id").GetInt32();
        task.GetProperty("autoSource").GetString().Should().Be("None");

        // Log 10 of 20 minutes → 50% → 5 partial points on that task.
        await user.PutAsJsonAsync("/api/challenge/day", new
        {
            date = Today, tasks = new[] { new { key, value = 10 } },
        });
        var day = await Json(await user.GetAsync($"/api/challenge/day?date={Today}"));
        var custom = Task(day, key!);
        custom.GetProperty("progress").GetDouble().Should().BeApproximately(0.5, 1e-9);
        custom.GetProperty("points").GetDecimal().Should().Be(5m);

        // A built-in auto task cannot be deleted (only disabled).
        var dietId = (await Json(await user.GetAsync("/api/challenge/tasks")))
            .EnumerateArray().First(t => t.GetProperty("key").GetString() == "diet").GetProperty("id").GetInt32();
        (await user.DeleteAsync($"/api/challenge/tasks/{dietId}")).StatusCode.Should().Be(HttpStatusCode.BadRequest);

        // The custom task can be deleted.
        (await user.DeleteAsync($"/api/challenge/tasks/{id}")).StatusCode.Should().Be(HttpStatusCode.NoContent);
        (await Json(await user.GetAsync("/api/challenge/tasks")))
            .EnumerateArray().Should().NotContain(t => t.GetProperty("key").GetString() == key);
    }

    [Fact]
    public async Task A_disabled_task_earns_no_points_and_is_not_required_for_completeness()
    {
        var (_, user) = await ProvisionUser("tracker.self");
        await user.PostAsJsonAsync("/api/challenge", new { startDate = Today });

        // Disable everything except no-alcohol, which holds by default → the day is complete with just it.
        var tasks = (await Json(await user.GetAsync("/api/challenge/tasks"))).EnumerateArray().ToList();
        foreach (var t in tasks)
        {
            if (t.GetProperty("key").GetString() == "no-alcohol") continue;
            var id = t.GetProperty("id").GetInt32();
            (await user.PutAsJsonAsync($"/api/challenge/tasks/{id}", new { enabled = false }))
                .StatusCode.Should().Be(HttpStatusCode.OK);
        }

        var day = await Json(await user.GetAsync($"/api/challenge/day?date={Today}"));
        day.GetProperty("tasks").EnumerateArray().Should().HaveCount(1); // only the enabled no-alcohol task
        day.GetProperty("complete").GetBoolean().Should().BeTrue();
        day.GetProperty("dayPoints").GetDecimal().Should().Be(10m);
    }

    // ---- Per-day manual progress: reading pages with PARTIAL points ----

    [Fact]
    public async Task Reading_pages_earn_partial_points()
    {
        var (_, user) = await ProvisionUser("tracker.self");
        await user.PostAsJsonAsync("/api/challenge", new { startDate = Today });

        // 7 of 10 pages, default partial-credit reading task @ 10 points → 7 points (7.0).
        await user.PutAsJsonAsync("/api/challenge/day", new
        {
            date = Today, tasks = new[] { new { key = "reading", value = 7 } },
        });
        var day = await Json(await user.GetAsync($"/api/challenge/day?date={Today}"));
        var reading = Task(day, "reading");
        reading.GetProperty("value").GetDecimal().Should().Be(7);
        reading.GetProperty("progress").GetDouble().Should().BeApproximately(0.7, 1e-9);
        reading.GetProperty("points").GetDecimal().Should().Be(7m);
        reading.GetProperty("complete").GetBoolean().Should().BeFalse();
    }

    // ---- AUTO scoring against custom targets + diet override ----

    [Fact]
    public async Task Auto_scoring_matches_a_hand_built_tracker_day_and_completes_it()
    {
        var (_, user) = await ProvisionUser("tracker.self");

        await user.PutAsJsonAsync("/api/tracker/profile", new
        {
            goal = "Maintain", weightKg = 80.0, shareWithContacts = false,
            dailyCalorieGoal = 2000, proteinGoalG = 150, carbGoalG = 200, fatGoalG = 60,
        });
        await user.PostAsJsonAsync("/api/challenge", new { startDate = Today });

        await user.PostAsJsonAsync("/api/tracker/food", new
        {
            date = Today, meal = "breakfast", description = "Day total", quantity = 1.0,
            calories = 1800, proteinG = 140.0, carbG = 180.0, fatG = 55.0,
        });
        for (var i = 0; i < 4; i++)
            await user.PostAsJsonAsync("/api/tracker/hydration", new { date = Today, amountMl = 1000 });
        await user.PostAsJsonAsync("/api/tracker/exercise", new { date = Today, name = "AM lift", durationMin = 50, caloriesBurned = 300 });
        await user.PostAsJsonAsync("/api/tracker/exercise", new { date = Today, name = "PM run", durationMin = 45, caloriesBurned = 400 });
        await user.PostAsJsonAsync("/api/tracker/exercise", new { date = Today, name = "Stretch", durationMin = 10, caloriesBurned = 20 });

        // Manual: read 10 pages (no-alcohol holds by default).
        await user.PutAsJsonAsync("/api/challenge/day", new
        {
            date = Today, tasks = new[] { new { key = "reading", value = 10 } },
        });

        var day = await Json(await user.GetAsync($"/api/challenge/day?date={Today}"));
        Task(day, "diet").GetProperty("complete").GetBoolean().Should().BeTrue();
        Task(day, "water").GetProperty("complete").GetBoolean().Should().BeTrue();
        Task(day, "workout").GetProperty("complete").GetBoolean().Should().BeTrue();
        Task(day, "reading").GetProperty("complete").GetBoolean().Should().BeTrue();
        Task(day, "no-alcohol").GetProperty("complete").GetBoolean().Should().BeTrue();
        day.GetProperty("complete").GetBoolean().Should().BeTrue();
        day.GetProperty("dayPoints").GetDecimal().Should().Be(50m);

        var ch = await Json(await user.GetAsync("/api/challenge"));
        ch.GetProperty("completedDays").GetInt32().Should().Be(1);
        ch.GetProperty("currentStreak").GetInt32().Should().Be(1);
        ch.GetProperty("longestStreak").GetInt32().Should().Be(1);
        ch.GetProperty("todayPoints").GetDecimal().Should().Be(50m);
    }

    [Fact]
    public async Task One_of_two_workouts_earns_half_the_workout_points()
    {
        var (_, user) = await ProvisionUser("tracker.self");
        await user.PostAsJsonAsync("/api/challenge", new { startDate = Today });

        // A single 50-minute workout: 1 of 2 required → 50% → 5 of the workout's 10 points.
        await user.PostAsJsonAsync("/api/tracker/exercise", new { date = Today, name = "AM lift", durationMin = 50, caloriesBurned = 300 });

        var day = await Json(await user.GetAsync($"/api/challenge/day?date={Today}"));
        var workout = Task(day, "workout");
        workout.GetProperty("progress").GetDouble().Should().BeApproximately(0.5, 1e-9);
        workout.GetProperty("points").GetDecimal().Should().Be(5m);
        workout.GetProperty("complete").GetBoolean().Should().BeFalse();
    }

    [Fact]
    public async Task Diet_override_flips_the_diet_task_true()
    {
        var (_, user) = await ProvisionUser("tracker.self");
        await user.PutAsJsonAsync("/api/tracker/profile", new
        {
            goal = "Maintain", shareWithContacts = false, dailyCalorieGoal = 2000, proteinGoalG = 100,
        });
        await user.PostAsJsonAsync("/api/challenge", new { startDate = Today });

        await user.PostAsJsonAsync("/api/tracker/food", new
        {
            date = Today, meal = "lunch", description = "Protein bomb", quantity = 1.0,
            calories = 1500, proteinG = 180.0, carbG = 50.0, fatG = 30.0,
        });

        var day = await Json(await user.GetAsync($"/api/challenge/day?date={Today}"));
        Task(day, "diet").GetProperty("complete").GetBoolean().Should().BeFalse();

        await user.PutAsJsonAsync("/api/challenge/day", new { date = Today, dietOverride = true });
        var overridden = await Json(await user.GetAsync($"/api/challenge/day?date={Today}"));
        Task(overridden, "diet").GetProperty("complete").GetBoolean().Should().BeTrue();
    }

    [Fact]
    public async Task Put_day_without_an_active_challenge_is_404()
    {
        var (_, user) = await ProvisionUser("tracker.self");
        (await user.PutAsJsonAsync("/api/challenge/day", new { date = Today, noAlcohol = false }))
            .StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    // ---- AI coach: ALWAYS 200, plain floor without tracker.ai ----

    [Fact]
    public async Task Coach_falls_back_to_plain_without_tracker_ai()
    {
        var (_, user) = await ProvisionUser("tracker.self"); // no tracker.ai
        await user.PostAsJsonAsync("/api/challenge", new { startDate = Today });

        var resp = await user.GetAsync("/api/challenge/coach");
        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var dto = await Json(resp);
        dto.GetProperty("fellBackToPlain").GetBoolean().Should().BeTrue();
        dto.GetProperty("narrative").GetString().Should().NotBeNullOrWhiteSpace();
        dto.GetProperty("insights").EnumerateArray().Should().BeEmpty();
    }

    [Fact]
    public async Task Coach_without_a_challenge_is_a_200_plain_nudge()
    {
        var (_, user) = await ProvisionUser("tracker.self");
        var resp = await user.GetAsync("/api/challenge/coach");
        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        (await Json(resp)).GetProperty("fellBackToPlain").GetBoolean().Should().BeTrue();
    }

    // ---- Migration backfill: an existing (tasks-less) challenge gets the default set seeded ----

    [Fact]
    public async Task Backfill_seeds_the_default_task_set_for_a_pre_existing_challenge()
    {
        // Simulate a pre-v2 challenge row that has NO task config rows yet (as it would exist before the
        // HardChallengeV2 migration ran). Insert it directly, then run the SAME idempotent seed SQL the
        // migration's BACKFILL uses, and confirm the default set lands (and is not duplicated on a re-run).
        var email = $"backfill-{Guid.NewGuid():N}@test.local";
        await Admin().PostAsJsonAsync("/api/users", new { email, isEnabled = true, permissions = new[] { "tracker.self" } });

        int challengeId;
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
            var now = DateTime.UtcNow;
            var ch = new Ccusage.Api.Data.Entities.HardChallenge
            {
                UserEmail = email,
                StartDate = DateOnly.FromDateTime(DateTime.UtcNow),
                Status = Ccusage.Api.Data.Entities.HardChallengeStatus.Active,
                CreatedUtc = now,
                UpdatedUtc = now,
            };
            db.HardChallenges.Add(ch);
            await db.SaveChangesAsync();
            challengeId = ch.Id;

            db.HardChallengeTasks.Any(t => t.ChallengeId == challengeId).Should().BeFalse();

            const string seed = @"
INSERT INTO ""HardChallengeTasks""
    (""ChallengeId"", ""Key"", ""Label"", ""AutoSource"", ""TargetValue"", ""MinMinutes"", ""Unit"",
     ""PointValue"", ""PartialCredit"", ""Enabled"", ""SortOrder"", ""CreatedUtc"", ""UpdatedUtc"")
SELECT c.""Id"", v.key, v.label, v.src, v.target, v.minmin, v.unit, 10, v.partial, TRUE, v.sort, now(), now()
FROM ""HardChallenges"" c
CROSS JOIN (VALUES
    ('diet','Follow a diet',1,NULL,NULL,'',FALSE,0),
    ('water','Drink a gallon of water',2,3785,NULL,'ml',TRUE,1),
    ('workout','Two 45-minute workouts',3,2,45,'workouts',TRUE,2),
    ('reading','Read 10 pages',0,10,NULL,'pages',TRUE,3),
    ('no-alcohol','No alcohol',4,NULL,NULL,'',FALSE,4)
) AS v(key,label,src,target,minmin,unit,partial,sort)
WHERE NOT EXISTS (SELECT 1 FROM ""HardChallengeTasks"" t WHERE t.""ChallengeId"" = c.""Id"" AND t.""Key"" = v.key);";

            await db.Database.ExecuteSqlRawAsync(seed);
            await db.Database.ExecuteSqlRawAsync(seed); // idempotent: a second run must not duplicate
        }

        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
            var keys = await db.HardChallengeTasks.Where(t => t.ChallengeId == challengeId)
                .Select(t => t.Key).ToListAsync();
            keys.Should().BeEquivalentTo(new[] { "diet", "water", "workout", "reading", "no-alcohol" });
        }
    }

    // ---- Cheat days: future-only, within window, capped (unchanged) ----

    [Fact]
    public async Task Cheat_days_must_be_future_dates_within_the_window()
    {
        var (_, user) = await ProvisionUser("tracker.self");
        await user.PostAsJsonAsync("/api/challenge", new { startDate = Today });

        (await user.PostAsJsonAsync("/api/challenge/cheat-days", new { add = new[] { Today } }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);

        var future = DateTime.UtcNow.AddDays(5).ToString("yyyy-MM-dd");
        var ok = await user.PostAsJsonAsync("/api/challenge/cheat-days", new { add = new[] { future } });
        ok.StatusCode.Should().Be(HttpStatusCode.OK);
        var dto = await Json(ok);
        var cheat = dto.GetProperty("days").EnumerateArray().First(d => d.GetProperty("date").GetString() == future);
        cheat.GetProperty("isCheatDay").GetBoolean().Should().BeTrue();

        var beyond = DateTime.UtcNow.AddDays(200).ToString("yyyy-MM-dd");
        (await user.PostAsJsonAsync("/api/challenge/cheat-days", new { add = new[] { beyond } }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }
}
