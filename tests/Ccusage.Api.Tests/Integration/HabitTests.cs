using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Ccusage.Api.Services;
using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Ccusage.Api.Tests.Integration;

/// <summary>
/// Habits engine (/api/habits) — the generalised successor to 75-Hard, built net-new. Covers:
/// <list type="bullet">
///   <item>GATING: tracker.self required (403), auth required (401).</item>
///   <item>OWNER-SCOPE: a caller only sees/edits their OWN habits + days; another user's never appear.</item>
///   <item>CREATE / day-upsert / streak: a daily habit completed today reports a streak of 1.</item>
///   <item>habit.dayComplete: crossing a day into complete emits the event carrying the STREAK only — NEVER
///   the private habit title.</item>
///   <item>LEADERBOARD: id + display name only, NEVER an email or a habit title.</item>
/// </list>
/// Each test provisions fresh users so they're order-independent.
/// </summary>
[Collection(IntegrationCollection.Name)]
public class HabitTests(WebAppFactory factory)
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
        var email = $"habit-{Guid.NewGuid():N}@test.local";
        var res = await Admin().PostAsJsonAsync("/api/users", new { email, isEnabled = true, permissions });
        res.StatusCode.Should().Be(HttpStatusCode.Created);
        return (email, Client(email));
    }

    private async Task<int> UserIdFor(string email)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        return await db.Users.AsNoTracking().Where(u => u.Email == email).Select(u => u.Id).FirstAsync();
    }

    private async Task MakeContacts(string aEmail, string bEmail)
    {
        var aId = await UserIdFor(aEmail);
        var bId = await UserIdFor(bEmail);
        (await Admin().PostAsJsonAsync($"/api/chat/contacts/user/{aId}", new { contactUserId = bId }))
            .StatusCode.Should().Be(HttpStatusCode.OK);
    }

    private async Task SetShareActivity(string email, bool share)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        var u = await db.Users.FirstAsync(x => x.Email == email);
        u.ShareActivity = share;
        await db.SaveChangesAsync();
    }

    private static async Task<JsonElement> Json(HttpResponseMessage resp) =>
        await resp.Content.ReadFromJsonAsync<JsonElement>();

    // The API buckets habit days in the configured DISPLAY timezone (America/New_York in tests), NOT raw UTC.
    // Late-evening New York is already the next UTC day, so a UTC "today" reads as a FUTURE date to the API and
    // the freshly-completed day falls outside the streak window (streak 0). Mirror the other suites' helper.
    private static readonly string Today = DisplayTzToday().ToString("yyyy-MM-dd");

    private static DateOnly DisplayTzToday()
    {
        TimeZoneInfo tz;
        try { tz = TimeZoneInfo.FindSystemTimeZoneById("America/New_York"); } catch { tz = TimeZoneInfo.Utc; }
        return DateOnly.FromDateTime(TimeZoneInfo.ConvertTimeFromUtc(DateTime.UtcNow, tz));
    }

    // ---- Gating ----

    [Fact]
    public async Task Habits_require_tracker_self_and_auth()
    {
        var anon = factory.CreateClient();
        (await anon.GetAsync("/api/habits/")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);

        var (_, plain) = await ProvisionUser("dashboard.view");
        (await plain.GetAsync("/api/habits/")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await plain.PostAsJsonAsync("/api/habits/", new { title = "X" })).StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    // ---- Create + day-upsert + streak ----

    [Fact]
    public async Task Create_a_daily_habit_then_complete_today_reports_streak_one()
    {
        var (_, owner) = await ProvisionUser("tracker.self");

        var created = await Json(await owner.PostAsJsonAsync("/api/habits/", new
        {
            title = "Meditate",
            cadence = (int)HabitCadence.Daily,
            startDate = Today,
            // binary habit (no target) — done flips it complete
        }));
        var id = created.GetProperty("id").GetInt32();
        created.GetProperty("currentStreak").GetInt32().Should().Be(0);

        var day = await Json(await owner.PutAsJsonAsync($"/api/habits/{id}/day", new { date = Today, done = true }));
        day.GetProperty("complete").GetBoolean().Should().BeTrue();

        var list = await Json(await owner.GetAsync("/api/habits/"));
        var card = list.EnumerateArray().First(h => h.GetProperty("id").GetInt32() == id);
        card.GetProperty("currentStreak").GetInt32().Should().Be(1);
        card.GetProperty("today").GetProperty("complete").GetBoolean().Should().BeTrue();
    }

    [Fact]
    public async Task A_measurable_habit_partial_credit_is_not_complete_until_target()
    {
        var (_, owner) = await ProvisionUser("tracker.self");
        var created = await Json(await owner.PostAsJsonAsync("/api/habits/", new
        {
            title = "Read pages",
            cadence = (int)HabitCadence.Daily,
            targetValue = 10,
            unit = "pages",
            partialCredit = true,
            startDate = Today,
        }));
        var id = created.GetProperty("id").GetInt32();

        var partial = await Json(await owner.PutAsJsonAsync($"/api/habits/{id}/day", new { date = Today, value = 5 }));
        partial.GetProperty("complete").GetBoolean().Should().BeFalse();
        partial.GetProperty("progress").GetDouble().Should().BeApproximately(0.5, 1e-6);

        var full = await Json(await owner.PutAsJsonAsync($"/api/habits/{id}/day", new { date = Today, value = 10 }));
        full.GetProperty("complete").GetBoolean().Should().BeTrue();
    }

    // ---- Owner-scope ----

    [Fact]
    public async Task A_caller_only_sees_their_own_habits_and_cannot_edit_anothers()
    {
        var (_, alice) = await ProvisionUser("tracker.self");
        var (_, bob) = await ProvisionUser("tracker.self");

        var aliceHabit = await Json(await alice.PostAsJsonAsync("/api/habits/",
            new { title = "alice-secret-habit", cadence = (int)HabitCadence.Daily, startDate = Today }));
        var aliceId = aliceHabit.GetProperty("id").GetInt32();

        // Bob's list never contains Alice's habit/title.
        var bobList = await Json(await bob.GetAsync("/api/habits/"));
        bobList.EnumerateArray().Should().NotContain(h => h.GetProperty("id").GetInt32() == aliceId);
        var bobRaw = await (await bob.GetAsync("/api/habits/")).Content.ReadAsStringAsync();
        bobRaw.Should().NotContain("alice-secret-habit");

        // Bob cannot read/edit/delete Alice's habit (owner-scoped WHERE → 404).
        (await bob.GetAsync($"/api/habits/{aliceId}/day?date={Today}")).StatusCode.Should().Be(HttpStatusCode.NotFound);
        (await bob.PutAsJsonAsync($"/api/habits/{aliceId}/day", new { date = Today, done = true }))
            .StatusCode.Should().Be(HttpStatusCode.NotFound);
        (await bob.PutAsJsonAsync($"/api/habits/{aliceId}", new { title = "hacked" }))
            .StatusCode.Should().Be(HttpStatusCode.NotFound);
        (await bob.DeleteAsync($"/api/habits/{aliceId}")).StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    // ---- habit.dayComplete emits the streak only, NEVER the habit title ----

    [Fact]
    public async Task Completing_a_habit_day_emits_dayComplete_with_streak_and_no_title()
    {
        var (email, owner) = await ProvisionUser("tracker.self");
        await SetShareActivity(email, true); // opt in so the emit is not a no-op

        var created = await Json(await owner.PostAsJsonAsync("/api/habits/", new
        {
            title = "Top-Secret-Habit-Name",
            cadence = (int)HabitCadence.Daily,
            startDate = Today,
        }));
        var id = created.GetProperty("id").GetInt32();

        // Cross into complete.
        await owner.PutAsJsonAsync($"/api/habits/{id}/day", new { date = Today, done = true });

        // Give the fire-and-forget emit a moment (it shares its own scope; poll the DB).
        ActivityEvent? evt = null;
        for (var i = 0; i < 20 && evt is null; i++)
        {
            using var scope = factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
            evt = await db.ActivityEvents.AsNoTracking()
                .FirstOrDefaultAsync(e => e.ActorEmail == email.ToLowerInvariant()
                                          && e.Kind == ActivityEmitter.Kinds.HabitDayComplete);
            if (evt is null) await Task.Delay(50);
        }

        evt.Should().NotBeNull("a sharing actor crossing a habit into complete should emit habit.dayComplete");
        evt!.IntValue.Should().Be(1, "the event carries the current streak");
        // HABIT-TITLE PRIVACY: the private title must NEVER appear in the event.
        evt.Label.Should().BeNull();
        (evt.Label ?? "").Should().NotContain("Top-Secret-Habit-Name");
    }

    [Fact]
    public async Task A_non_sharing_actor_emits_no_dayComplete_event()
    {
        var (email, owner) = await ProvisionUser("tracker.self"); // ShareActivity defaults OFF
        var created = await Json(await owner.PostAsJsonAsync("/api/habits/",
            new { title = "Quiet habit", cadence = (int)HabitCadence.Daily, startDate = Today }));
        var id = created.GetProperty("id").GetInt32();
        await owner.PutAsJsonAsync($"/api/habits/{id}/day", new { date = Today, done = true });

        // A bare sleep can't distinguish 'never emits' from 'emits slowly' under CI load — a late erroneous
        // emit would pass green. Anchor on a SHARING sibling that reliably DOES emit: once that observable
        // event lands, the fire-and-forget path has drained, so the non-sharing actor's absence is real proof.
        var (sharerEmail, sharer) = await ProvisionUser("tracker.self");
        await SetShareActivity(sharerEmail, true);
        var sharerHabit = await Json(await sharer.PostAsJsonAsync("/api/habits/",
            new { title = "Loud habit", cadence = (int)HabitCadence.Daily, startDate = Today }));
        await sharer.PutAsJsonAsync($"/api/habits/{sharerHabit.GetProperty("id").GetInt32()}/day",
            new { date = Today, done = true });

        var sharerEmitted = false;
        for (var i = 0; i < 20 && !sharerEmitted; i++)
        {
            using var pollScope = factory.Services.CreateScope();
            var pollDb = pollScope.ServiceProvider.GetRequiredService<UsageDbContext>();
            sharerEmitted = await pollDb.ActivityEvents.AsNoTracking()
                .AnyAsync(e => e.ActorEmail == sharerEmail.ToLowerInvariant()
                               && e.Kind == ActivityEmitter.Kinds.HabitDayComplete);
            if (!sharerEmitted) await Task.Delay(50);
        }
        sharerEmitted.Should().BeTrue("the sharing sibling's emit anchors that the fire-and-forget path has drained");

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        (await db.ActivityEvents.AsNoTracking()
            .AnyAsync(e => e.ActorEmail == email.ToLowerInvariant() && e.Kind == ActivityEmitter.Kinds.HabitDayComplete))
            .Should().BeFalse();
    }

    // ---- Leaderboard: id + name only, never email or habit title ----

    [Fact]
    public async Task Leaderboard_ranks_sharing_contacts_with_no_email_or_title()
    {
        var (aEmail, alice) = await ProvisionUser("tracker.self");
        var (bEmail, bob) = await ProvisionUser("tracker.self");
        await MakeContacts(aEmail, bEmail);
        // Bob must opt into contacts-sharing to appear on Alice's leaderboard (the SAME gate 75-Hard uses).
        await bob.PutAsJsonAsync("/api/tracker/profile", new { goal = "Maintain", shareWithContacts = true });

        // Both create + complete a habit today (streak 1).
        foreach (var (client, title) in new[] { (alice, "alice-habit-title"), (bob, "bob-habit-title") })
        {
            var h = await Json(await client.PostAsJsonAsync("/api/habits/",
                new { title, cadence = (int)HabitCadence.Daily, startDate = Today }));
            await client.PutAsJsonAsync($"/api/habits/{h.GetProperty("id").GetInt32()}/day", new { date = Today, done = true });
        }

        var res = await alice.GetAsync("/api/habits/leaderboard");
        res.StatusCode.Should().Be(HttpStatusCode.OK);
        var raw = await res.Content.ReadAsStringAsync();
        raw.Should().NotContain("@");                 // no email anywhere
        raw.Should().NotContain(bEmail);
        raw.Should().NotContain("alice-habit-title");  // no habit title leaks
        raw.Should().NotContain("bob-habit-title");

        var board = await Json(res);
        board.ValueKind.Should().Be(JsonValueKind.Array);
        board.GetArrayLength().Should().BeGreaterThanOrEqualTo(2);
        board.EnumerateArray().Should().Contain(r => r.GetProperty("isSelf").GetBoolean());
        foreach (var row in board.EnumerateArray())
            row.GetProperty("bestStreak").GetInt32().Should().BeGreaterThanOrEqualTo(1);
    }
}
