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
/// Family Hub F3 — the "Today" snapshot (/api/family/today), household settings (/api/family/settings),
/// and the daily briefing (<see cref="FamilyBriefingService"/>). Covers: family.use gating (no permission
/// → 403); /today aggregates today's reminders + active timers + list open/done counts + pinned notes,
/// household-scoped with NO email anywhere; weather is null when unconfigured and /today still 200s;
/// settings GET/PUT round-trip + validation (TZ + hour) + owner-only edit; invoking the briefing creates
/// exactly one familyBriefing Notification per member AND one ChatMessage in the ensured "Family" channel,
/// once per local day (a second same-day run is a no-op); and cross-household isolation. Each test
/// provisions fresh users so they're order-independent.
/// </summary>
[Collection(IntegrationCollection.Name)]
public class FamilyTodayBriefingTests(WebAppFactory factory)
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
        var email = $"famtb-{Guid.NewGuid():N}@test.local";
        var res = await Admin().PostAsJsonAsync("/api/users", new { email, isEnabled = true, permissions });
        res.StatusCode.Should().Be(HttpStatusCode.Created);
        var id = (await Json(res)).GetProperty("id").GetInt32();
        return (email, Client(email), id);
    }

    private static async Task<JsonElement> Json(HttpResponseMessage resp) =>
        await resp.Content.ReadFromJsonAsync<JsonElement>();

    private static bool HasProperty(JsonElement el, string name) =>
        el.ValueKind == JsonValueKind.Object && el.TryGetProperty(name, out _);

    private async Task<int> NotificationCountFor(string email, NotificationType type)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        return await db.Notifications.CountAsync(n => n.RecipientEmail == email.ToLowerInvariant() && n.Type == type);
    }

    /// <summary>The household id the given caller belongs to.</summary>
    private async Task<int> HouseholdIdFor(int userId)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        return await db.HouseholdMembers.AsNoTracking().Where(m => m.UserId == userId)
            .Select(m => m.HouseholdId).FirstAsync();
    }

    /// <summary>Set a household's timezone + briefing hour directly (bypassing the owner-only PUT for setup).</summary>
    private async Task ConfigureHousehold(int householdId, string timeZone, int briefingHour, bool enabled = true)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        await db.Households.Where(h => h.Id == householdId)
            .ExecuteUpdateAsync(s => s
                .SetProperty(h => h.TimeZone, timeZone)
                .SetProperty(h => h.BriefingHourLocal, briefingHour)
                .SetProperty(h => h.BriefingEnabled, enabled), default);
    }

    /// <summary>Invoke the briefing's "run if due" for a household as of <paramref name="nowUtc"/>.</summary>
    private async Task<bool> RunBriefing(int householdId, DateTime nowUtc)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        var briefing = scope.ServiceProvider.GetRequiredService<FamilyBriefingService>();
        var household = await db.Households.FirstAsync(h => h.Id == householdId);
        return await briefing.RunIfDueAsync(household, nowUtc, default);
    }

    private async Task<Household> ReloadHousehold(int householdId)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        return await db.Households.AsNoTracking().FirstAsync(h => h.Id == householdId);
    }

    /// <summary>Count messages in the household's ensured "Family" channel whose body contains a marker.</summary>
    private async Task<int> FamilyChannelMessageCount(int householdId)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        var channelId = await db.Households.AsNoTracking().Where(h => h.Id == householdId)
            .Select(h => h.FamilyChannelId).FirstAsync();
        if (channelId is null) return 0;
        return await db.ChatMessages.CountAsync(m => m.ChannelId == channelId.Value);
    }

    /// <summary>A UTC instant that is exactly <paramref name="localHour"/> local-time in the given IANA zone, today-local.</summary>
    private static DateTime UtcForLocalHour(string ianaTz, int localHour)
    {
        var tz = TimeZoneInfo.FindSystemTimeZoneById(ianaTz);
        var localNow = TimeZoneInfo.ConvertTimeFromUtc(DateTime.UtcNow, tz);
        var localAtHour = new DateTime(localNow.Year, localNow.Month, localNow.Day, localHour, 0, 0, DateTimeKind.Unspecified);
        return TimeZoneInfo.ConvertTimeToUtc(localAtHour, tz);
    }

    // =====================================================================================
    // GATING
    // =====================================================================================

    [Fact]
    public async Task Today_and_settings_require_family_use()
    {
        var (_, plain, _) = await ProvisionUser("dashboard.view");

        (await plain.GetAsync("/api/family/today")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await plain.GetAsync("/api/family/settings")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await plain.PutAsJsonAsync("/api/family/settings", new { briefingEnabled = false }))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Today_requires_authentication()
    {
        var anon = factory.CreateClient();
        (await anon.GetAsync("/api/family/today")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await anon.GetAsync("/api/family/settings")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    // =====================================================================================
    // /today AGGREGATION (household-scoped; no email)
    // =====================================================================================

    [Fact]
    public async Task Today_aggregates_reminders_timers_lists_and_pinned_notes_no_email()
    {
        var (_, owner, ownerId) = await ProvisionUser("family.use");
        var (_, _, bobId) = await ProvisionUser("family.use");
        await owner.GetAsync("/api/family/household"); // provision
        await owner.PostAsJsonAsync("/api/family/household/members", new { userId = bobId });

        // A reminder due LATER TODAY (UTC works fine for the default America/New_York within a day window).
        await owner.PostAsJsonAsync("/api/family/reminders", new
        {
            text = "Pick up kids", dueUtc = DateTime.UtcNow.AddHours(3), recurrence = "none", targetUserId = bobId,
        });
        // An active timer.
        await owner.PostAsJsonAsync("/api/family/timers", new { label = "Roast", durationSeconds = 3600 });
        // A list with open + done items.
        var listId = (await Json(await owner.PostAsJsonAsync("/api/family/lists",
            new { name = "Groceries", kind = "shopping" }))).GetProperty("id").GetInt64();
        await owner.PostAsJsonAsync($"/api/family/lists/{listId}/items", new { text = "Milk" });
        await owner.PostAsJsonAsync($"/api/family/lists/{listId}/items", new { text = "Eggs" });
        // The items POST returns the full list DTO; pull the new item's id out of its items array by text.
        var afterBread = await Json(await owner.PostAsJsonAsync($"/api/family/lists/{listId}/items", new { text = "Bread" }));
        var doneItemId = afterBread.GetProperty("items").EnumerateArray()
            .Single(i => i.GetProperty("text").GetString() == "Bread").GetProperty("id").GetInt64();
        await owner.PatchAsJsonAsync($"/api/family/lists/{listId}/items/{doneItemId}", new { done = true });
        // A pinned note.
        await owner.PostAsJsonAsync("/api/family/notes", new { title = "Wifi password", body = "hunter2", pinned = true });

        var res = await owner.GetAsync("/api/family/today");
        res.StatusCode.Should().Be(HttpStatusCode.OK);
        var today = await Json(res);

        today.GetProperty("greeting").GetString().Should().NotBeNullOrWhiteSpace();
        today.GetProperty("dateLocal").GetString().Should().NotBeNullOrWhiteSpace();

        // Reminders: the one due today is present, carries target userId + name, no email.
        var reminders = today.GetProperty("reminders").EnumerateArray().ToList();
        reminders.Should().ContainSingle();
        reminders[0].GetProperty("text").GetString().Should().Be("Pick up kids");
        reminders[0].GetProperty("targetUserId").GetInt32().Should().Be(bobId);
        reminders[0].GetProperty("targetName").GetString().Should().NotBeNullOrWhiteSpace();
        HasProperty(reminders[0], "email").Should().BeFalse();

        // Timers: the active one is present.
        var timers = today.GetProperty("timers").EnumerateArray().ToList();
        timers.Should().ContainSingle();
        timers[0].GetProperty("label").GetString().Should().Be("Roast");

        // Lists: open=2 (Milk, Eggs), done=1 (Bread), with a preview of the open items.
        var list = today.GetProperty("lists").EnumerateArray()
            .Single(l => l.GetProperty("id").GetInt64() == listId);
        list.GetProperty("openCount").GetInt32().Should().Be(2);
        list.GetProperty("doneCount").GetInt32().Should().Be(1);
        list.GetProperty("firstFewOpenItems").EnumerateArray().Select(x => x.GetString())
            .Should().Contain(new[] { "Milk", "Eggs" });

        // Pinned notes: title only.
        var notes = today.GetProperty("pinnedNotes").EnumerateArray().ToList();
        notes.Should().ContainSingle();
        notes[0].GetProperty("title").GetString().Should().Be("Wifi password");

        // No email anywhere in the whole payload.
        today.GetRawText().Should().NotContain("@");
        _ = ownerId;
    }

    [Fact]
    public async Task Today_weather_is_null_when_unconfigured_and_still_200s()
    {
        var (_, owner, _) = await ProvisionUser("family.use");
        await owner.GetAsync("/api/family/household");
        // Even with a location set, no OpenWeather key is configured in tests → the card stays null.
        await owner.PutAsJsonAsync("/api/family/settings", new { weatherLocation = "Tampa,FL,US" });

        var res = await owner.GetAsync("/api/family/today");
        res.StatusCode.Should().Be(HttpStatusCode.OK);
        var today = await Json(res);
        today.GetProperty("weather").ValueKind.Should().Be(JsonValueKind.Null);
    }

    // =====================================================================================
    // SETTINGS GET/PUT round-trip + validation + owner-only
    // =====================================================================================

    [Fact]
    public async Task Settings_round_trip_and_validate()
    {
        var (_, owner, _) = await ProvisionUser("family.use");
        await owner.GetAsync("/api/family/household");

        // Defaults on first read.
        var initial = await Json(await owner.GetAsync("/api/family/settings"));
        initial.GetProperty("briefingEnabled").GetBoolean().Should().BeTrue();
        initial.GetProperty("briefingHourLocal").GetInt32().Should().Be(7);
        initial.GetProperty("canEdit").GetBoolean().Should().BeTrue();
        initial.GetProperty("weatherConfigured").GetBoolean().Should().BeFalse(); // no key in tests

        // A valid PUT round-trips.
        var put = await owner.PutAsJsonAsync("/api/family/settings", new
        {
            timeZone = "America/Chicago", briefingEnabled = false, briefingHourLocal = 9, weatherLocation = "Austin,TX,US",
        });
        put.StatusCode.Should().Be(HttpStatusCode.OK);
        var saved = await Json(put);
        saved.GetProperty("timeZone").GetString().Should().Be("America/Chicago");
        saved.GetProperty("briefingEnabled").GetBoolean().Should().BeFalse();
        saved.GetProperty("briefingHourLocal").GetInt32().Should().Be(9);
        saved.GetProperty("weatherLocation").GetString().Should().Be("Austin,TX,US");

        // Persisted.
        var reread = await Json(await owner.GetAsync("/api/family/settings"));
        reread.GetProperty("timeZone").GetString().Should().Be("America/Chicago");

        // Validation: bad timezone + out-of-range hour are rejected.
        (await owner.PutAsJsonAsync("/api/family/settings", new { timeZone = "Mars/Olympus" }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await owner.PutAsJsonAsync("/api/family/settings", new { briefingHourLocal = 24 }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await owner.PutAsJsonAsync("/api/family/settings", new { briefingHourLocal = -1 }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Settings_edit_is_owner_only()
    {
        var (_, owner, _) = await ProvisionUser("family.use");
        var (_, bob, bobId) = await ProvisionUser("family.use");
        await owner.GetAsync("/api/family/household");
        await owner.PostAsJsonAsync("/api/family/household/members", new { userId = bobId });

        // Bob (a non-owner member) may READ settings but not EDIT them.
        (await bob.GetAsync("/api/family/settings")).StatusCode.Should().Be(HttpStatusCode.OK);
        (await Json(await bob.GetAsync("/api/family/settings"))).GetProperty("canEdit").GetBoolean().Should().BeFalse();
        (await bob.PutAsJsonAsync("/api/family/settings", new { briefingHourLocal = 6 }))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    // =====================================================================================
    // BRIEFING — delivers once per local day to every member's bell + the Family channel
    // =====================================================================================

    [Fact]
    public async Task Briefing_delivers_a_bell_notification_to_every_member_and_a_chat_message_once_per_day()
    {
        const string tz = "America/New_York";
        var (ownerEmail, owner, ownerId) = await ProvisionUser("family.use");
        var (bobEmail, _, bobId) = await ProvisionUser("family.use");
        await owner.GetAsync("/api/family/household");
        await owner.PostAsJsonAsync("/api/family/household/members", new { userId = bobId });

        var householdId = await HouseholdIdFor(ownerId);
        await ConfigureHousehold(householdId, tz, briefingHour: 7);

        // Give the family something to say in the briefing.
        await owner.PostAsJsonAsync("/api/family/reminders",
            new { text = "Dentist", dueUtc = DateTime.UtcNow.AddHours(2), recurrence = "none" });

        var ownerBefore = await NotificationCountFor(ownerEmail, NotificationType.FamilyBriefing);
        var bobBefore = await NotificationCountFor(bobEmail, NotificationType.FamilyBriefing);

        // Run at exactly 7am local → due.
        var now = UtcForLocalHour(tz, 7);
        (await RunBriefing(householdId, now)).Should().BeTrue();

        // EVERY member got exactly one familyBriefing bell notification.
        (await NotificationCountFor(ownerEmail, NotificationType.FamilyBriefing)).Should().Be(ownerBefore + 1);
        (await NotificationCountFor(bobEmail, NotificationType.FamilyBriefing)).Should().Be(bobBefore + 1);

        // The "Family" channel was ensured and got exactly one message.
        var hh = await ReloadHousehold(householdId);
        hh.FamilyChannelId.Should().NotBeNull();
        hh.LastBriefingLocalDate.Should().NotBeNull();
        (await FamilyChannelMessageCount(householdId)).Should().Be(1);

        // A SECOND run the same local day is a no-op (idempotent): no new bells, no new chat message.
        (await RunBriefing(householdId, UtcForLocalHour(tz, 8))).Should().BeFalse();
        (await NotificationCountFor(ownerEmail, NotificationType.FamilyBriefing)).Should().Be(ownerBefore + 1);
        (await NotificationCountFor(bobEmail, NotificationType.FamilyBriefing)).Should().Be(bobBefore + 1);
        (await FamilyChannelMessageCount(householdId)).Should().Be(1);
    }

    [Fact]
    public async Task Briefing_does_not_fire_before_the_briefing_hour()
    {
        const string tz = "America/New_York";
        var (selfEmail, owner, selfId) = await ProvisionUser("family.use");
        await owner.GetAsync("/api/family/household");
        var householdId = await HouseholdIdFor(selfId);
        await ConfigureHousehold(householdId, tz, briefingHour: 7);

        var before = await NotificationCountFor(selfEmail, NotificationType.FamilyBriefing);
        // 6am local is before the 7am briefing hour → not due.
        (await RunBriefing(householdId, UtcForLocalHour(tz, 6))).Should().BeFalse();
        (await NotificationCountFor(selfEmail, NotificationType.FamilyBriefing)).Should().Be(before);
    }

    [Fact]
    public async Task Briefing_respects_the_enabled_flag()
    {
        const string tz = "America/New_York";
        var (selfEmail, owner, selfId) = await ProvisionUser("family.use");
        await owner.GetAsync("/api/family/household");
        var householdId = await HouseholdIdFor(selfId);
        await ConfigureHousehold(householdId, tz, briefingHour: 7, enabled: false);

        var before = await NotificationCountFor(selfEmail, NotificationType.FamilyBriefing);
        (await RunBriefing(householdId, UtcForLocalHour(tz, 9))).Should().BeFalse();
        (await NotificationCountFor(selfEmail, NotificationType.FamilyBriefing)).Should().Be(before);
    }

    // =====================================================================================
    // CROSS-HOUSEHOLD ISOLATION
    // =====================================================================================

    [Fact]
    public async Task Today_and_briefing_are_isolated_across_households()
    {
        const string tz = "America/New_York";
        var (_, alice, aliceId) = await ProvisionUser("family.use");
        var (bobEmail, bob, bobId) = await ProvisionUser("family.use");
        await alice.GetAsync("/api/family/household");
        await bob.GetAsync("/api/family/household");

        // Alice adds a reminder + a list; Bob must not see them in HIS Today.
        await alice.PostAsJsonAsync("/api/family/reminders",
            new { text = "Alice only", dueUtc = DateTime.UtcNow.AddHours(2), recurrence = "none" });
        await alice.PostAsJsonAsync("/api/family/lists", new { name = "Alice list", kind = "todo" });

        var bobToday = await Json(await bob.GetAsync("/api/family/today"));
        bobToday.GetProperty("reminders").EnumerateArray()
            .Select(r => r.GetProperty("text").GetString()).Should().NotContain("Alice only");
        bobToday.GetProperty("lists").EnumerateArray()
            .Select(l => l.GetProperty("name").GetString()).Should().NotContain("Alice list");

        // Briefing for Alice's household must only notify Alice's members (not Bob).
        var aliceHh = await HouseholdIdFor(aliceId);
        await ConfigureHousehold(aliceHh, tz, briefingHour: 7);
        var bobBefore = await NotificationCountFor(bobEmail, NotificationType.FamilyBriefing);

        (await RunBriefing(aliceHh, UtcForLocalHour(tz, 7))).Should().BeTrue();
        (await NotificationCountFor(bobEmail, NotificationType.FamilyBriefing)).Should().Be(bobBefore);
        _ = bobId;
    }
}
