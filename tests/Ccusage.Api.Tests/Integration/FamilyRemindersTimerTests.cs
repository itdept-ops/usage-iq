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
/// Family Hub F2 — shared REMINDERS and TIMERS (/api/family/reminders, /api/family/timers) plus the
/// background tick (<see cref="FamilyReminderService"/>). Covers: family.use gating (no permission →
/// 403); creating a reminder targeting a household member; a single deterministic tick fires a past-due
/// reminder, writes a Notification row for the TARGET (not the creator), and advances (recurring) or
/// deactivates (one-shot) with no double-fire; a past-end timer completes and notifies EVERY member;
/// every person field carries userId+name with NO email anywhere; and cross-household isolation holds
/// (a caller can't see or modify another household's reminders/timers). Each test provisions fresh
/// users so they're order-independent.
/// </summary>
[Collection(IntegrationCollection.Name)]
public class FamilyRemindersTimerTests(WebAppFactory factory)
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
        var email = $"famrt-{Guid.NewGuid():N}@test.local";
        var res = await Admin().PostAsJsonAsync("/api/users", new { email, isEnabled = true, permissions });
        res.StatusCode.Should().Be(HttpStatusCode.Created);
        var id = (await Json(res)).GetProperty("id").GetInt32();
        return (email, Client(email), id);
    }

    private static async Task<JsonElement> Json(HttpResponseMessage resp) =>
        await resp.Content.ReadFromJsonAsync<JsonElement>();

    private static bool HasProperty(JsonElement el, string name) =>
        el.ValueKind == JsonValueKind.Object && el.TryGetProperty(name, out _);

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

    private async Task<int> NotificationCountFor(string email, NotificationType type)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        return await db.Notifications.CountAsync(n => n.RecipientEmail == email.ToLowerInvariant() && n.Type == type);
    }

    private async Task<FamilyReminder> ReloadReminder(long id)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        return await db.FamilyReminders.AsNoTracking().FirstAsync(r => r.Id == id);
    }

    // =====================================================================================
    // GATING
    // =====================================================================================

    [Fact]
    public async Task Reminders_and_timers_require_family_use()
    {
        var (_, plain, _) = await ProvisionUser("dashboard.view");

        (await plain.GetAsync("/api/family/reminders")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await plain.PostAsJsonAsync("/api/family/reminders",
            new { text = "X", dueUtc = DateTime.UtcNow, recurrence = "none" }))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await plain.GetAsync("/api/family/timers")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await plain.PostAsJsonAsync("/api/family/timers", new { label = "X", durationSeconds = 60 }))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Reminders_require_authentication()
    {
        var anon = factory.CreateClient();
        (await anon.GetAsync("/api/family/reminders")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await anon.GetAsync("/api/family/timers")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    // =====================================================================================
    // REMINDERS — create targeting a member; DTO shape (id+name, no email)
    // =====================================================================================

    [Fact]
    public async Task Create_a_reminder_targeting_a_member_carries_userId_and_name_no_email()
    {
        var (_, owner, ownerId) = await ProvisionUser("family.use");
        var (_, _, bobId) = await ProvisionUser("family.use");
        await owner.GetAsync("/api/family/household"); // provision
        await owner.PostAsJsonAsync("/api/family/household/members", new { userId = bobId });

        var created = await owner.PostAsJsonAsync("/api/family/reminders", new
        {
            text = "Take out the trash",
            dueUtc = DateTime.UtcNow.AddHours(2),
            recurrence = "weekly",
            targetUserId = bobId,
        });
        created.StatusCode.Should().Be(HttpStatusCode.OK);
        var r = await Json(created);
        r.GetProperty("text").GetString().Should().Be("Take out the trash");
        r.GetProperty("recurrence").GetString().Should().Be("weekly");
        r.GetProperty("active").GetBoolean().Should().BeTrue();
        r.GetProperty("targetUserId").GetInt32().Should().Be(bobId);
        r.GetProperty("targetName").GetString().Should().NotBeNullOrWhiteSpace();
        r.GetProperty("createdByUserId").GetInt32().Should().Be(ownerId);
        r.GetProperty("createdByName").GetString().Should().NotBeNullOrWhiteSpace();
        HasProperty(r, "email").Should().BeFalse();
        r.GetRawText().Should().NotContain("@");

        // It shows up in the household's reminders list.
        var list = await Json(await owner.GetAsync("/api/family/reminders"));
        list.EnumerateArray().Select(x => x.GetProperty("id").GetInt64())
            .Should().Contain(r.GetProperty("id").GetInt64());
        list.GetRawText().Should().NotContain("@");
    }

    [Fact]
    public async Task Reminder_target_must_be_a_household_member()
    {
        var (_, owner, _) = await ProvisionUser("family.use");
        var (_, _, outsiderId) = await ProvisionUser("family.use"); // their OWN household
        await owner.GetAsync("/api/family/household");

        (await owner.PostAsJsonAsync("/api/family/reminders", new
        {
            text = "Nope", dueUtc = DateTime.UtcNow, recurrence = "none", targetUserId = outsiderId,
        })).StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Reminder_target_defaults_to_the_caller()
    {
        var (_, owner, ownerId) = await ProvisionUser("family.use");
        await owner.GetAsync("/api/family/household");

        var r = await Json(await owner.PostAsJsonAsync("/api/family/reminders", new
        {
            text = "Self ping", dueUtc = DateTime.UtcNow.AddMinutes(5), recurrence = "none",
        }));
        r.GetProperty("targetUserId").GetInt32().Should().Be(ownerId);
    }

    // =====================================================================================
    // TICK — one-shot reminder fires the TARGET, deactivates, and does not double-fire
    // =====================================================================================

    [Fact]
    public async Task Tick_fires_a_one_shot_reminder_for_the_target_then_deactivates_no_double_fire()
    {
        var (ownerEmail, owner, _) = await ProvisionUser("family.use");
        var (bobEmail, _, bobId) = await ProvisionUser("family.use");
        await owner.GetAsync("/api/family/household");
        await owner.PostAsJsonAsync("/api/family/household/members", new { userId = bobId });

        // A reminder for BOB, already due in the past.
        var reminderId = (await Json(await owner.PostAsJsonAsync("/api/family/reminders", new
        {
            text = "Call grandma",
            dueUtc = DateTime.UtcNow.AddMinutes(-5),
            recurrence = "none",
            targetUserId = bobId,
        }))).GetProperty("id").GetInt64();

        var bobBefore = await NotificationCountFor(bobEmail, NotificationType.FamilyReminder);
        var ownerBefore = await NotificationCountFor(ownerEmail, NotificationType.FamilyReminder);

        var result = await RunTick(DateTime.UtcNow);
        result.RemindersFired.Should().BeGreaterThanOrEqualTo(1);

        // The TARGET (Bob) got exactly one new notification; the creator (owner) got none.
        (await NotificationCountFor(bobEmail, NotificationType.FamilyReminder)).Should().Be(bobBefore + 1);
        (await NotificationCountFor(ownerEmail, NotificationType.FamilyReminder)).Should().Be(ownerBefore);

        // The one-shot is now inactive and stamped.
        var afterFire = await ReloadReminder(reminderId);
        afterFire.Active.Should().BeFalse();
        afterFire.LastFiredUtc.Should().NotBeNull();

        // A second tick at the same instant fires nothing more for this reminder (no double-fire).
        await RunTick(DateTime.UtcNow);
        (await NotificationCountFor(bobEmail, NotificationType.FamilyReminder)).Should().Be(bobBefore + 1);
    }

    // =====================================================================================
    // TICK — recurring reminder advances and stays active
    // =====================================================================================

    [Fact]
    public async Task Tick_fires_a_daily_reminder_then_advances_one_day_and_stays_active()
    {
        var (selfEmail, owner, selfId) = await ProvisionUser("family.use");
        await owner.GetAsync("/api/family/household");

        var due = DateTime.UtcNow.AddMinutes(-1);
        var reminderId = (await Json(await owner.PostAsJsonAsync("/api/family/reminders", new
        {
            text = "Vitamins", dueUtc = due, recurrence = "daily",
        }))).GetProperty("id").GetInt64();

        var before = await NotificationCountFor(selfEmail, NotificationType.FamilyReminder);
        await RunTick(DateTime.UtcNow);

        (await NotificationCountFor(selfEmail, NotificationType.FamilyReminder)).Should().Be(before + 1);

        var after = await ReloadReminder(reminderId);
        after.Active.Should().BeTrue(); // recurring stays active
        after.DueUtc.Should().BeAfter(DateTime.UtcNow); // advanced into the future
        after.DueUtc.Should().BeCloseTo(due.AddDays(1), TimeSpan.FromSeconds(2));

        // Re-ticking now fires nothing more (next occurrence is a day out).
        await RunTick(DateTime.UtcNow);
        (await NotificationCountFor(selfEmail, NotificationType.FamilyReminder)).Should().Be(before + 1);
    }

    [Fact]
    public void NextOccurrence_weekdays_skips_the_weekend()
    {
        // A Friday 9am reminder advances to the following MONDAY (not Saturday).
        var friday = new DateTime(2026, 6, 19, 9, 0, 0, DateTimeKind.Utc);
        friday.DayOfWeek.Should().Be(DayOfWeek.Friday);
        var next = FamilyReminderService.NextOccurrence(friday, "weekdays", friday);
        next.DayOfWeek.Should().Be(DayOfWeek.Monday);
        next.Should().Be(new DateTime(2026, 6, 22, 9, 0, 0, DateTimeKind.Utc));
    }

    [Fact]
    public void NextOccurrence_advances_past_a_long_overdue_time()
    {
        // A daily reminder due a week ago should jump forward to the first occurrence after now (not +1d only).
        var weekAgo = DateTime.UtcNow.AddDays(-7);
        var next = FamilyReminderService.NextOccurrence(weekAgo, "daily", DateTime.UtcNow);
        next.Should().BeAfter(DateTime.UtcNow);
    }

    // =====================================================================================
    // SNOOZE
    // =====================================================================================

    [Fact]
    public async Task Snooze_pushes_the_due_time_out_and_reactivates()
    {
        var (selfEmail, owner, _) = await ProvisionUser("family.use");
        await owner.GetAsync("/api/family/household");

        var reminderId = (await Json(await owner.PostAsJsonAsync("/api/family/reminders", new
        {
            text = "Laundry", dueUtc = DateTime.UtcNow.AddMinutes(-2), recurrence = "none",
        }))).GetProperty("id").GetInt64();

        // Fire + deactivate it.
        await RunTick(DateTime.UtcNow);
        (await ReloadReminder(reminderId)).Active.Should().BeFalse();

        // Snooze 15 minutes → due in the future and active again.
        var snoozed = await owner.PostAsJsonAsync($"/api/family/reminders/{reminderId}/snooze", new { minutes = 15 });
        snoozed.StatusCode.Should().Be(HttpStatusCode.OK);
        var dto = await Json(snoozed);
        dto.GetProperty("active").GetBoolean().Should().BeTrue();
        dto.GetProperty("dueUtc").GetDateTime().Should().BeAfter(DateTime.UtcNow);
    }

    // =====================================================================================
    // TIMERS — a finished timer completes and notifies EVERY household member
    // =====================================================================================

    [Fact]
    public async Task Tick_completes_a_past_timer_and_notifies_all_household_members()
    {
        var (ownerEmail, owner, _) = await ProvisionUser("family.use");
        var (bobEmail, _, bobId) = await ProvisionUser("family.use");
        await owner.GetAsync("/api/family/household");
        await owner.PostAsJsonAsync("/api/family/household/members", new { userId = bobId });

        // Start a 1-second timer, then advance the clock past it via the tick's "now".
        var created = await owner.PostAsJsonAsync("/api/family/timers", new { label = "Pasta", durationSeconds = 1 });
        created.StatusCode.Should().Be(HttpStatusCode.OK);
        var timer = await Json(created);
        var timerId = timer.GetProperty("id").GetInt64();
        timer.GetProperty("done").GetBoolean().Should().BeFalse();
        timer.GetProperty("label").GetString().Should().Be("Pasta");
        timer.GetRawText().Should().NotContain("@");

        var ownerBefore = await NotificationCountFor(ownerEmail, NotificationType.FamilyTimer);
        var bobBefore = await NotificationCountFor(bobEmail, NotificationType.FamilyTimer);

        // Tick "in the future" so EndsUtc <= now.
        var result = await RunTick(DateTime.UtcNow.AddMinutes(1));
        result.TimersCompleted.Should().BeGreaterThanOrEqualTo(1);

        // BOTH members got a timer notification.
        (await NotificationCountFor(ownerEmail, NotificationType.FamilyTimer)).Should().Be(ownerBefore + 1);
        (await NotificationCountFor(bobEmail, NotificationType.FamilyTimer)).Should().Be(bobBefore + 1);

        // The timer reads back as done, and a second tick doesn't re-notify.
        var listed = (await Json(await owner.GetAsync("/api/family/timers")))
            .EnumerateArray().Single(t => t.GetProperty("id").GetInt64() == timerId);
        listed.GetProperty("done").GetBoolean().Should().BeTrue();

        await RunTick(DateTime.UtcNow.AddMinutes(2));
        (await NotificationCountFor(ownerEmail, NotificationType.FamilyTimer)).Should().Be(ownerBefore + 1);
    }

    [Fact]
    public async Task Timer_requires_a_positive_duration()
    {
        var (_, owner, _) = await ProvisionUser("family.use");
        await owner.GetAsync("/api/family/household");
        (await owner.PostAsJsonAsync("/api/family/timers", new { label = "Bad", durationSeconds = 0 }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    // =====================================================================================
    // CROSS-HOUSEHOLD ISOLATION
    // =====================================================================================

    [Fact]
    public async Task Cross_household_isolation_each_family_sees_and_touches_only_its_own()
    {
        var (_, alice, _) = await ProvisionUser("family.use");
        var (_, bob, _) = await ProvisionUser("family.use");
        await alice.GetAsync("/api/family/household");
        await bob.GetAsync("/api/family/household");

        var aliceReminder = (await Json(await alice.PostAsJsonAsync("/api/family/reminders", new
        {
            text = "Alice only", dueUtc = DateTime.UtcNow.AddHours(1), recurrence = "none",
        }))).GetProperty("id").GetInt64();
        var aliceTimer = (await Json(await alice.PostAsJsonAsync("/api/family/timers",
            new { label = "Alice timer", durationSeconds = 3600 }))).GetProperty("id").GetInt64();

        // Bob can't see Alice's reminder/timer.
        (await Json(await bob.GetAsync("/api/family/reminders"))).EnumerateArray()
            .Select(x => x.GetProperty("id").GetInt64()).Should().NotContain(aliceReminder);
        (await Json(await bob.GetAsync("/api/family/timers"))).EnumerateArray()
            .Select(x => x.GetProperty("id").GetInt64()).Should().NotContain(aliceTimer);

        // ...and can't reach into them (404, existence never leaked).
        (await bob.PutAsJsonAsync($"/api/family/reminders/{aliceReminder}",
            new { text = "hijack" })).StatusCode.Should().Be(HttpStatusCode.NotFound);
        (await bob.PostAsJsonAsync($"/api/family/reminders/{aliceReminder}/snooze", new { minutes = 5 }))
            .StatusCode.Should().Be(HttpStatusCode.NotFound);
        (await bob.DeleteAsync($"/api/family/reminders/{aliceReminder}")).StatusCode.Should().Be(HttpStatusCode.NotFound);
        (await bob.DeleteAsync($"/api/family/timers/{aliceTimer}")).StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task Delete_removes_a_reminder()
    {
        var (_, owner, _) = await ProvisionUser("family.use");
        await owner.GetAsync("/api/family/household");
        var id = (await Json(await owner.PostAsJsonAsync("/api/family/reminders", new
        {
            text = "Temp", dueUtc = DateTime.UtcNow.AddHours(1), recurrence = "none",
        }))).GetProperty("id").GetInt64();

        (await owner.DeleteAsync($"/api/family/reminders/{id}")).StatusCode.Should().Be(HttpStatusCode.NoContent);
        (await Json(await owner.GetAsync("/api/family/reminders"))).EnumerateArray()
            .Select(x => x.GetProperty("id").GetInt64()).Should().NotContain(id);
    }

    // =====================================================================================
    // AI PARSE (/reminders/ai/parse) — gated by family.use + auth; 400 on empty text;
    // graceful 503 (never 500) when Gemini is unconfigured. The test host configures NO
    // Gemini key, so the unconfigured branch returns before any real Gemini/HTTP call.
    // =====================================================================================

    [Fact]
    public async Task ReminderAiParse_requires_family_use()
    {
        var (_, plain, _) = await ProvisionUser("dashboard.view");
        var res = await plain.PostAsJsonAsync("/api/family/reminders/ai/parse",
            new { text = "call the dentist tomorrow at 9am" });
        res.StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task ReminderAiParse_requires_authentication()
    {
        var anon = factory.CreateClient();
        var res = await anon.PostAsJsonAsync("/api/family/reminders/ai/parse",
            new { text = "call the dentist tomorrow at 9am" });
        res.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task ReminderAiParse_returns_400_for_empty_text()
    {
        var (_, owner, _) = await ProvisionUser("family.use");
        await owner.GetAsync("/api/family/household");

        var res = await owner.PostAsJsonAsync("/api/family/reminders/ai/parse", new { text = "   " });
        res.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task ReminderAiParse_is_unavailable_503_when_gemini_is_unconfigured_never_500()
    {
        var (_, owner, _) = await ProvisionUser("family.use");
        await owner.GetAsync("/api/family/household");

        // No Gemini API key is configured in tests, so AI reminders are gracefully unavailable (503), never
        // a 500 and never a real Gemini call (the unconfigured branch returns before any HTTP).
        var res = await owner.PostAsJsonAsync("/api/family/reminders/ai/parse",
            new { text = "take out the trash every Tuesday night" });
        res.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
    }
}
