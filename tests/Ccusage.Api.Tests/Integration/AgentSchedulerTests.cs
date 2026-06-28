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
using Microsoft.Extensions.Logging;

namespace Ccusage.Api.Tests.Integration;

/// <summary>
/// Proactive scheduled agents — the per-user <see cref="AgentScheduler"/> background tick + the
/// <c>/api/agents</c> endpoints. Covers: agents.use gating; the GET upserts a disabled default row per kind;
/// a single deterministic tick with an injected clock fires a DUE, enabled agent (writing an AgentNudge
/// notification) and is IDEMPOTENT (no double-nudge on a re-tick the same local day); a disabled agent never
/// fires; quiet-hours suppress a morning/budget agent; and the preview endpoint renders the deterministic floor.
/// The LowStaples kind is used for the firing test because it is fully deterministic (no AI / token spend) and
/// easy to seed. Each test provisions fresh users so they're order-independent.
/// </summary>
[Collection(IntegrationCollection.Name)]
public class AgentSchedulerTests(WebAppFactory factory)
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
        var email = $"agent-{Guid.NewGuid():N}@test.local";
        var res = await Admin().PostAsJsonAsync("/api/users", new { email, isEnabled = true, permissions });
        res.StatusCode.Should().Be(HttpStatusCode.Created);
        var id = (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetInt32();
        return (email, Client(email), id);
    }

    /// <summary>Run one deterministic tick of the scheduler as of <paramref name="nowUtc"/> with the resolved services.</summary>
    private async Task<int> RunTick(DateTime nowUtc)
    {
        using var scope = factory.Services.CreateScope();
        var sp = scope.ServiceProvider;
        var svc = new AgentScheduler(
            factory.Services.GetRequiredService<IServiceScopeFactory>(),
            factory.Services.GetRequiredService<ILogger<AgentScheduler>>());
        return await svc.TickAsync(
            sp.GetRequiredService<UsageDbContext>(),
            sp.GetRequiredService<ChatNotificationService>(),
            sp.GetRequiredService<AgentComposer>(),
            nowUtc);
    }

    private async Task<int> NudgeCountFor(string email) =>
        await WithDb(db => db.Notifications.CountAsync(
            n => n.RecipientEmail == email.ToLowerInvariant() && n.Type == NotificationType.AgentNudge));

    private async Task<T> WithDb<T>(Func<UsageDbContext, Task<T>> work)
    {
        using var scope = factory.Services.CreateScope();
        return await work(scope.ServiceProvider.GetRequiredService<UsageDbContext>());
    }

    /// <summary>Give a household-owning user one ACTIVE shopping list with an open item, so LowStaples has something to say.</summary>
    private async Task SeedOpenShoppingItem(int householdId, int userId, string text)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        var now = DateTime.UtcNow;
        var list = new FamilyList
        {
            HouseholdId = householdId, CreatedByUserId = userId, Name = "Groceries", Kind = "shopping",
            CreatedUtc = now, UpdatedUtc = now,
            Items = { new FamilyListItem { Text = text, Done = false, CreatedUtc = now } },
        };
        db.FamilyLists.Add(list);
        await db.SaveChangesAsync();
    }

    /// <summary>Force the agent's idempotency anchor + a deliver hour of 0 so the tick always finds it DUE.</summary>
    private async Task SetAgent(
        string email, ScheduledAgentKind kind, bool enabled,
        int deliverHour = 0, int? quietStart = null, int? quietEnd = null, string tz = "UTC")
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        var row = await db.ScheduledAgents.FirstOrDefaultAsync(a => a.UserEmail == email && a.Kind == kind);
        if (row is null)
        {
            row = new ScheduledAgent { UserEmail = email, Kind = kind, CreatedUtc = DateTime.UtcNow };
            db.ScheduledAgents.Add(row);
        }
        row.Enabled = enabled;
        row.DeliverHourLocal = deliverHour;
        row.QuietStartLocalHour = quietStart;
        row.QuietEndLocalHour = quietEnd;
        row.TimeZone = tz;
        row.LastFiredLocalDate = null;
        row.UpdatedUtc = DateTime.UtcNow;
        await db.SaveChangesAsync();
    }

    // =====================================================================================
    // GATING + GET defaults
    // =====================================================================================

    [Fact]
    public async Task Agents_endpoints_require_agents_use()
    {
        var (_, plain, _) = await ProvisionUser("dashboard.view");
        (await plain.GetAsync("/api/agents")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await plain.PostAsync("/api/agents/lowStaples/preview", null)).StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Get_upserts_a_disabled_default_row_per_kind()
    {
        var (_, user, _) = await ProvisionUser("agents.use");
        var list = await (await user.GetAsync("/api/agents")).Content.ReadFromJsonAsync<JsonElement>();
        var kinds = list.EnumerateArray().Select(a => a.GetProperty("kind").GetString()).ToList();
        kinds.Should().Contain(new[] { "morningBriefing", "streakRescue", "budgetAlert", "lowStaples" });
        list.EnumerateArray().Should().OnlyContain(a => a.GetProperty("enabled").GetBoolean() == false);
    }

    // =====================================================================================
    // TICK — a due, enabled LowStaples agent fires once and is idempotent
    // =====================================================================================

    [Fact]
    public async Task Tick_fires_a_due_enabled_agent_once_then_is_idempotent()
    {
        var (email, user, userId) = await ProvisionUser("agents.use", "family.use");
        var hid = (await (await user.GetAsync("/api/family/household"))
            .Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetInt32();
        await SeedOpenShoppingItem(hid, userId, "Milk");
        await SetAgent(email, ScheduledAgentKind.LowStaples, enabled: true, deliverHour: 0, tz: "UTC");

        var before = await NudgeCountFor(email);
        var now = new DateTime(2026, 6, 27, 12, 0, 0, DateTimeKind.Utc);

        // First tick fires exactly one nudge and stamps the local-date anchor.
        await RunTick(now);
        (await NudgeCountFor(email)).Should().Be(before + 1);
        var stamped = await WithDb(db => db.ScheduledAgents.AsNoTracking()
            .FirstAsync(a => a.UserEmail == email && a.Kind == ScheduledAgentKind.LowStaples));
        stamped.LastFiredLocalDate.Should().Be(new DateOnly(2026, 6, 27));
        stamped.LastFiredKey.Should().Be("lowstaples:2026-06-27");

        // A second tick the SAME local day fires nothing more (idempotency: stamp-first, no double-nudge).
        await RunTick(now.AddMinutes(1));
        (await NudgeCountFor(email)).Should().Be(before + 1);
    }

    [Fact]
    public async Task Tick_fires_a_due_agent_in_a_timezone_far_ahead_of_utc()
    {
        // Regression: the coarse SQL candidate floor must not exclude an agent that already fired YESTERDAY-local
        // in a zone far ahead of UTC. At 2026-06-27 23:30 UTC a Pacific/Kiritimati (UTC+14) user is on 06-28
        // local; an agent that last fired 06-27 (yesterday-local) is genuinely DUE + unfired today and must still
        // fire. The old utcDate-1 floor wrongly excluded it (06-27 < 06-26 is false), so it never nudged east of UTC.
        var (email, user, userId) = await ProvisionUser("agents.use", "family.use");
        var hid = (await (await user.GetAsync("/api/family/household"))
            .Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetInt32();
        await SeedOpenShoppingItem(hid, userId, "Milk");
        await SetAgent(email, ScheduledAgentKind.LowStaples, enabled: true, deliverHour: 0, tz: "Pacific/Kiritimati");
        await WithDb(async db =>
        {
            var row = await db.ScheduledAgents.FirstAsync(a => a.UserEmail == email && a.Kind == ScheduledAgentKind.LowStaples);
            row.LastFiredLocalDate = new DateOnly(2026, 6, 27); // fired yesterday-local
            await db.SaveChangesAsync();
            return 0;
        });

        var before = await NudgeCountFor(email);
        await RunTick(new DateTime(2026, 6, 27, 23, 30, 0, DateTimeKind.Utc));
        (await NudgeCountFor(email)).Should().Be(before + 1);

        var stamped = await WithDb(db => db.ScheduledAgents.AsNoTracking()
            .FirstAsync(a => a.UserEmail == email && a.Kind == ScheduledAgentKind.LowStaples));
        stamped.LastFiredLocalDate.Should().Be(new DateOnly(2026, 6, 28)); // re-stamped to today-local
    }

    [Fact]
    public async Task A_disabled_agent_never_fires()
    {
        var (email, user, userId) = await ProvisionUser("agents.use", "family.use");
        var hid = (await (await user.GetAsync("/api/family/household"))
            .Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetInt32();
        await SeedOpenShoppingItem(hid, userId, "Eggs");
        await SetAgent(email, ScheduledAgentKind.LowStaples, enabled: false, deliverHour: 0, tz: "UTC");

        var before = await NudgeCountFor(email);
        await RunTick(new DateTime(2026, 6, 27, 12, 0, 0, DateTimeKind.Utc));
        (await NudgeCountFor(email)).Should().Be(before);
    }

    [Fact]
    public async Task Quiet_hours_drop_a_briefing_agent_for_the_day()
    {
        // MorningBriefing at deliver-hour 0, but with a quiet window covering noon → it is dropped (stamped,
        // never nudged) for the day. (We don't need a household briefing payload; quiet-hours suppress before compose.)
        var (email, _, _) = await ProvisionUser("agents.use", "family.use");
        await SetAgent(email, ScheduledAgentKind.MorningBriefing, enabled: true, deliverHour: 0,
            quietStart: 9, quietEnd: 17, tz: "UTC");

        var before = await NudgeCountFor(email);
        await RunTick(new DateTime(2026, 6, 27, 12, 0, 0, DateTimeKind.Utc)); // noon = inside 9..17 quiet window
        (await NudgeCountFor(email)).Should().Be(before);

        // It was stamped for the day (dropped, not deferred) so it won't be reconsidered this local date.
        var row = await WithDb(db => db.ScheduledAgents.AsNoTracking()
            .FirstAsync(a => a.UserEmail == email && a.Kind == ScheduledAgentKind.MorningBriefing));
        row.LastFiredLocalDate.Should().Be(new DateOnly(2026, 6, 27));
    }

    [Fact]
    public async Task Preview_renders_the_deterministic_floor_without_delivering()
    {
        var (email, user, userId) = await ProvisionUser("agents.use", "family.use");
        var hid = (await (await user.GetAsync("/api/family/household"))
            .Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetInt32();
        await SeedOpenShoppingItem(hid, userId, "Bread");

        var before = await NudgeCountFor(email);
        var resp = await user.PostAsync("/api/agents/lowStaples/preview", null);
        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var dto = await resp.Content.ReadFromJsonAsync<JsonElement>();
        dto.GetProperty("text").GetString().Should().Contain("Bread");
        dto.GetProperty("fellBackToPlain").GetBoolean().Should().BeTrue(); // LowStaples is deterministic-only
        // A preview delivers nothing.
        (await NudgeCountFor(email)).Should().Be(before);
    }

    [Fact]
    public void InQuietHours_handles_windows_crossing_midnight()
    {
        // A 22→7 window: 22,23,0..6 are quiet; 7..21 are not.
        AgentScheduler.InQuietHours(23, 22, 7).Should().BeTrue();
        AgentScheduler.InQuietHours(3, 22, 7).Should().BeTrue();
        AgentScheduler.InQuietHours(7, 22, 7).Should().BeFalse();  // exclusive end
        AgentScheduler.InQuietHours(12, 22, 7).Should().BeFalse();
        // A same-day window 9→17.
        AgentScheduler.InQuietHours(12, 9, 17).Should().BeTrue();
        AgentScheduler.InQuietHours(17, 9, 17).Should().BeFalse(); // exclusive end
        AgentScheduler.InQuietHours(8, 9, 17).Should().BeFalse();
        // No window.
        AgentScheduler.InQuietHours(3, null, null).Should().BeFalse();
    }
}
