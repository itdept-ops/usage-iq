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
/// Meds &amp; Vitals (/api/meds, /api/vitals) — the PRIVATE, OWNER-ONLY health vertical. The load-bearing
/// constraint is STRICT OWNER-ONLY: another user can NEVER read/write/see the caller's meds, logs, or vitals;
/// nothing is shared to a coach/family/contact or the activity feed; cross-user {id} → 404. Also covers the
/// deterministic adherence/trend math, the floored + AGGREGATE-only vitals insight, and the MedicationDue
/// agent's owner-scope. Each test provisions fresh users so they're order-independent.
/// </summary>
[Collection(IntegrationCollection.Name)]
public class MedsVitalsTests(WebAppFactory factory)
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
        var email = $"meds-{Guid.NewGuid():N}@test.local";
        var res = await Admin().PostAsJsonAsync("/api/users", new { email, isEnabled = true, permissions });
        res.StatusCode.Should().Be(HttpStatusCode.Created);
        var id = (await Json(res)).GetProperty("id").GetInt32();
        return (email, Client(email), id);
    }

    private static async Task<JsonElement> Json(HttpResponseMessage resp) =>
        await resp.Content.ReadFromJsonAsync<JsonElement>();

    private static object MedBody(
        string name = "Lisinopril", string dose = "10 mg", int timesPerDay = 1,
        bool remindersEnabled = false, string? startDate = null, string? endDate = null, bool active = true) => new
    {
        name,
        dose,
        schedule = new { timesPerDay, timesOfDay = (string[]?)null, daysOfWeek = (int[]?)null },
        notes = (string?)null,
        active,
        startDate = startDate ?? "2026-01-01",
        endDate,
        remindersEnabled,
    };

    // =====================================================================================
    // GATING — tracker.self required (403), auth required (401)
    // =====================================================================================

    [Fact]
    public async Task Endpoints_require_tracker_self()
    {
        var (_, plain, _) = await ProvisionUser("dashboard.view"); // not tracker.self
        (await plain.GetAsync("/api/meds")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await plain.PostAsJsonAsync("/api/meds", MedBody())).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await plain.GetAsync("/api/meds/adherence")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await plain.GetAsync("/api/vitals")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await plain.GetAsync("/api/vitals/insight")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Endpoints_require_authentication()
    {
        var anon = factory.CreateClient();
        (await anon.GetAsync("/api/meds")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await anon.GetAsync("/api/vitals")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await anon.GetAsync("/api/vitals/insight")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    // =====================================================================================
    // MEDS — add, list with today's slots, log a dose, soft-deactivate
    // =====================================================================================

    [Fact]
    public async Task Add_med_then_list_returns_it_with_todays_dose_slots()
    {
        var (_, owner, _) = await ProvisionUser("tracker.self");
        var today = DateOnly.FromDateTime(DateTime.UtcNow).ToString("yyyy-MM-dd");

        var added = await Json(await owner.PostAsJsonAsync("/api/meds",
            MedBody(name: "Metformin", timesPerDay: 2, startDate: today)));
        added.GetProperty("name").GetString().Should().Be("Metformin");
        added.GetProperty("todaySlots").GetArrayLength().Should().Be(2);

        var list = await Json(await owner.GetAsync("/api/meds"));
        list.GetProperty("medications").GetArrayLength().Should().Be(1);
        list.GetProperty("medications")[0].GetProperty("todaySlots").GetArrayLength().Should().Be(2);
    }

    [Fact]
    public async Task Log_a_dose_marks_the_slot_taken()
    {
        var (_, owner, _) = await ProvisionUser("tracker.self");
        var today = DateOnly.FromDateTime(DateTime.UtcNow).ToString("yyyy-MM-dd");
        var med = await Json(await owner.PostAsJsonAsync("/api/meds", MedBody(timesPerDay: 1, startDate: today)));
        var medId = med.GetProperty("id").GetInt64();

        var log = await owner.PostAsJsonAsync($"/api/meds/{medId}/log",
            new { date = today, slot = 0, status = 0 /* Taken */, takenAt = (string?)null, notes = (string?)null });
        log.StatusCode.Should().Be(HttpStatusCode.OK);

        var list = await Json(await owner.GetAsync("/api/meds"));
        var slot = list.GetProperty("medications")[0].GetProperty("todaySlots")[0];
        slot.GetProperty("status").GetInt32().Should().Be(0); // Taken
    }

    [Fact]
    public async Task Delete_med_soft_deactivates_it()
    {
        var (email, owner, _) = await ProvisionUser("tracker.self");
        var med = await Json(await owner.PostAsJsonAsync("/api/meds", MedBody()));
        var medId = med.GetProperty("id").GetInt64();

        (await owner.DeleteAsync($"/api/meds/{medId}")).StatusCode.Should().Be(HttpStatusCode.NoContent);

        // It's gone from the active list, but the row still exists (soft delete).
        var list = await Json(await owner.GetAsync("/api/meds"));
        list.GetProperty("medications").GetArrayLength().Should().Be(0);
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        (await db.Medications.CountAsync(m => m.UserEmail == email.ToLowerInvariant())).Should().Be(1);
    }

    [Fact]
    public async Task Add_med_rejects_bad_input_with_400()
    {
        var (_, owner, _) = await ProvisionUser("tracker.self");
        // Empty name.
        (await owner.PostAsJsonAsync("/api/meds", MedBody(name: " ")))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    // =====================================================================================
    // ADHERENCE — deterministic taken/scheduled %
    // =====================================================================================

    [Fact]
    public async Task Adherence_is_deterministic_taken_over_scheduled()
    {
        var (email, owner, id) = await ProvisionUser("tracker.self");
        var today = DateOnly.FromDateTime(DateTime.UtcNow);

        // A once-daily med starting 7 days ago → 7 scheduled doses over a 7-day window.
        var medId = await SeedMed(id, email, "Vitamin D", timesPerDay: 1, start: today.AddDays(-6));
        // Log 5 of the 7 days as Taken.
        for (var i = 0; i < 5; i++)
            await SeedLog(medId, email, today.AddDays(-i), 0, MedicationLogStatus.Taken);

        var body = await Json(await owner.GetAsync("/api/meds/adherence?window=7"));
        body.GetProperty("scheduled").GetInt32().Should().Be(7);
        body.GetProperty("taken").GetInt32().Should().Be(5);
        body.GetProperty("percent").GetDouble().Should().BeApproximately(71.4, 0.2);
    }

    // =====================================================================================
    // VITALS — log, list newest-first, trend math; BP keeps both values
    // =====================================================================================

    [Fact]
    public async Task Log_vitals_then_list_returns_trend_avg_min_max()
    {
        var (_, owner, _) = await ProvisionUser("tracker.self");
        var today = DateOnly.FromDateTime(DateTime.UtcNow);

        async Task Post(decimal v1, string date) => (await owner.PostAsJsonAsync("/api/vitals",
            new { kind = 1 /* HeartRate */, value1 = v1, value2 = (decimal?)null, unit = "bpm", localDate = date, measuredAt = (string?)null, notes = (string?)null }))
            .StatusCode.Should().Be(HttpStatusCode.OK);

        await Post(60, today.AddDays(-2).ToString("yyyy-MM-dd"));
        await Post(70, today.AddDays(-1).ToString("yyyy-MM-dd"));
        await Post(80, today.ToString("yyyy-MM-dd"));

        var body = await Json(await owner.GetAsync("/api/vitals?kind=1&window=30"));
        body.GetProperty("readings").GetArrayLength().Should().Be(3);
        var trend = body.GetProperty("trend");
        trend.GetProperty("count").GetInt32().Should().Be(3);
        trend.GetProperty("avg").GetDecimal().Should().Be(70m);
        trend.GetProperty("min").GetDecimal().Should().Be(60m);
        trend.GetProperty("max").GetDecimal().Should().Be(80m);
        trend.GetProperty("slopePerDay").GetDecimal().Should().Be(10m); // +10/day
    }

    [Fact]
    public async Task Blood_pressure_keeps_both_values()
    {
        var (_, owner, _) = await ProvisionUser("tracker.self");
        var today = DateOnly.FromDateTime(DateTime.UtcNow).ToString("yyyy-MM-dd");
        var v = await Json(await owner.PostAsJsonAsync("/api/vitals",
            new { kind = 0 /* BloodPressure */, value1 = 120m, value2 = 80m, unit = "mmHg", localDate = today, measuredAt = (string?)null, notes = (string?)null }));
        v.GetProperty("value1").GetDecimal().Should().Be(120m);
        v.GetProperty("value2").GetDecimal().Should().Be(80m);
    }

    // =====================================================================================
    // OWNER-ONLY (load-bearing) — another user can NEVER read/write/see the caller's data
    // =====================================================================================

    [Fact]
    public async Task A_caller_only_sees_their_own_meds_and_vitals()
    {
        var (aEmail, alice, aId) = await ProvisionUser("tracker.self");
        var (_, bob, bId) = await ProvisionUser("tracker.self");
        await SeedMed(aId, aEmail, "Alice-secret-med", 1, DateOnly.FromDateTime(DateTime.UtcNow));
        await SeedVital(aId, aEmail, VitalKind.HeartRate, 99, "alice-secret-vital");

        // Bob's lists never contain Alice's rows.
        var bobMeds = await Json(await bob.GetAsync("/api/meds"));
        bobMeds.GetProperty("medications").GetArrayLength().Should().Be(0);
        var bobVitals = await Json(await bob.GetAsync("/api/vitals"));
        bobVitals.GetProperty("readings").GetArrayLength().Should().Be(0);

        var bobMedsRaw = await (await bob.GetAsync("/api/meds")).Content.ReadAsStringAsync();
        bobMedsRaw.Should().NotContain("Alice-secret-med");
        var bobVitalsRaw = await (await bob.GetAsync("/api/vitals")).Content.ReadAsStringAsync();
        bobVitalsRaw.Should().NotContain("alice-secret-vital");
    }

    [Fact]
    public async Task A_caller_cannot_read_edit_log_or_delete_another_users_med()
    {
        var (aEmail, _, aId) = await ProvisionUser("tracker.self");
        var (_, bob, _) = await ProvisionUser("tracker.self");
        var aliceMedId = await SeedMed(aId, aEmail, "Alice-med", 1, DateOnly.FromDateTime(DateTime.UtcNow));
        var today = DateOnly.FromDateTime(DateTime.UtcNow).ToString("yyyy-MM-dd");

        // Cross-user {id} → 404 on PUT, DELETE, and POST /log (the owner-scoped WHERE never matches).
        (await bob.PutAsJsonAsync($"/api/meds/{aliceMedId}", MedBody(name: "Hacked")))
            .StatusCode.Should().Be(HttpStatusCode.NotFound);
        (await bob.DeleteAsync($"/api/meds/{aliceMedId}")).StatusCode.Should().Be(HttpStatusCode.NotFound);
        (await bob.PostAsJsonAsync($"/api/meds/{aliceMedId}/log",
            new { date = today, slot = 0, status = 0, takenAt = (string?)null, notes = (string?)null }))
            .StatusCode.Should().Be(HttpStatusCode.NotFound);

        // Alice's med is untouched + no log was written under it.
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        (await db.Medications.AsNoTracking().FirstAsync(m => m.Id == aliceMedId)).Name.Should().Be("Alice-med");
        (await db.MedicationLogs.CountAsync(l => l.MedicationId == aliceMedId)).Should().Be(0);
    }

    [Fact]
    public async Task A_caller_cannot_edit_or_delete_another_users_vital()
    {
        var (aEmail, _, aId) = await ProvisionUser("tracker.self");
        var (_, bob, _) = await ProvisionUser("tracker.self");
        var aliceVitalId = await SeedVital(aId, aEmail, VitalKind.BodyWeight, 150, "alice-weight");
        var today = DateOnly.FromDateTime(DateTime.UtcNow).ToString("yyyy-MM-dd");

        (await bob.PutAsJsonAsync($"/api/vitals/{aliceVitalId}",
            new { kind = 5, value1 = 999m, value2 = (decimal?)null, unit = "lb", localDate = today, measuredAt = (string?)null, notes = "hacked" }))
            .StatusCode.Should().Be(HttpStatusCode.NotFound);
        (await bob.DeleteAsync($"/api/vitals/{aliceVitalId}")).StatusCode.Should().Be(HttpStatusCode.NotFound);

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        var row = await db.VitalReadings.AsNoTracking().FirstAsync(v => v.Id == aliceVitalId);
        row.Value1.Should().Be(150m); // unchanged
        row.Notes.Should().Be("alice-weight");
    }

    [Fact]
    public async Task Meds_and_vitals_are_not_exposed_to_any_family_or_feed_overlay()
    {
        // A household member with full family + feed access never sees another member's private meds/vitals
        // anywhere — there is no sharing path, and no activity-feed event is emitted for a med/vital write.
        var (sharerEmail, sharer, sharerId) = await ProvisionUser("tracker.self", "family.use");
        var (_, viewer, viewerId) = await ProvisionUser("tracker.self", "family.use");

        // Build a household containing both.
        await viewer.GetAsync("/api/family/household");
        await viewer.PostAsJsonAsync("/api/family/household/members", new { userId = sharerId });

        // The sharer logs private health data.
        await sharer.PostAsJsonAsync("/api/meds", MedBody(name: "Private-med"));
        var today = DateOnly.FromDateTime(DateTime.UtcNow).ToString("yyyy-MM-dd");
        await sharer.PostAsJsonAsync("/api/vitals",
            new { kind = 0, value1 = 130m, value2 = 85m, unit = "mmHg", localDate = today, measuredAt = (string?)null, notes = "private-bp" });

        // The viewer's feed never carries a med/vital event.
        var feedRaw = await (await viewer.GetAsync("/api/feed")).Content.ReadAsStringAsync();
        feedRaw.Should().NotContain("Private-med");
        feedRaw.Should().NotContain("private-bp");

        // And there is genuinely no ActivityEvent row emitted for the private med/vital write — the sharer's
        // feed has no med/vital event kind at all (meds/vitals never publish to the activity feed).
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        var sharerEventKinds = await db.ActivityEvents.AsNoTracking()
            .Where(e => e.ActorEmail == sharerEmail.ToLowerInvariant())
            .Select(e => e.Kind)
            .ToListAsync();
        sharerEventKinds.Should().NotContain(k => k.Contains("med") || k.Contains("vital") || k.Contains("medication"));
    }

    // =====================================================================================
    // INSIGHT — floored (200) + AGGREGATE-only; tracker.ai-gated narration
    // =====================================================================================

    [Fact]
    public async Task Insight_falls_back_to_plain_and_sends_only_aggregates_never_raw_rows()
    {
        var (email, owner, id) = await ProvisionUser("tracker.self", "tracker.ai");
        var today = DateOnly.FromDateTime(DateTime.UtcNow);

        // A med with adherence + a vital reading carrying a SECRET note that must NEVER leave the server.
        var medId = await SeedMed(id, email, "Insight-med", 1, today.AddDays(-2));
        await SeedLog(medId, email, today, 0, MedicationLogStatus.Taken);
        await SeedVital(id, email, VitalKind.Glucose, 95, "secret-glucose-note");

        // No Gemini key in the test host → ALWAYS 200 with the deterministic floor (fellBackToPlain=true).
        var res = await owner.GetAsync("/api/vitals/insight?window=30");
        res.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await Json(res);
        body.GetProperty("fellBackToPlain").GetBoolean().Should().BeTrue();
        body.GetProperty("note").GetString().Should().NotBeNullOrWhiteSpace();
        // The deterministic floor never leaks a raw note/value.
        var raw = await res.Content.ReadAsStringAsync();
        raw.Should().NotContain("secret-glucose-note");
    }

    [Fact]
    public async Task Insight_floors_without_tracker_ai_and_never_500s()
    {
        var (_, owner, _) = await ProvisionUser("tracker.self"); // no tracker.ai
        var res = await owner.GetAsync("/api/vitals/insight");
        res.StatusCode.Should().Be(HttpStatusCode.OK);
        (await Json(res)).GetProperty("fellBackToPlain").GetBoolean().Should().BeTrue();
    }

    [Fact]
    public void Insight_stats_summary_carries_only_aggregates_no_notes()
    {
        // Prove the AGGREGATE-only invariant on the math: the trend stats expose avg/min/max/slope only — never
        // a raw note or a per-reading row.
        var readings = new List<VitalReading>
        {
            new() { Id = 1, Kind = VitalKind.Glucose, Value1 = 90, LocalDate = new DateOnly(2026, 6, 1), Notes = "secret-a" },
            new() { Id = 2, Kind = VitalKind.Glucose, Value1 = 110, LocalDate = new DateOnly(2026, 6, 3), Notes = "secret-b" },
        };
        var trend = MedsVitalsMath.Trend(readings)!;
        trend.Avg.Should().Be(100m);
        trend.Min.Should().Be(90m);
        trend.Max.Should().Be(110m);
        trend.SlopePerDay.Should().Be(10m); // (110-90)/2 days
        trend.Count.Should().Be(2);
        // The trend record has no Notes/Value field surface for raw rows.
        trend.GetType().GetProperties().Select(p => p.Name).Should().NotContain("Notes");
    }

    // =====================================================================================
    // MedicationDue AGENT — owner-scoped + idempotent (only nudges the caller's own unlogged due meds)
    // =====================================================================================

    [Fact]
    public async Task MedicationDue_agent_nudges_only_the_owners_unlogged_due_meds()
    {
        var (aliceEmail, _, aliceId) = await ProvisionUser("tracker.self", "agents.use");
        var (bobEmail, _, bobId) = await ProvisionUser("tracker.self", "agents.use");
        var today = new DateOnly(2026, 6, 28);

        // Alice has a reminders-on med due today, unlogged → she should be nudged.
        await SeedMed(aliceId, aliceEmail, "Alice-due", 1, today, remindersEnabled: true);
        // Bob also has a reminders-on med due today (proves owner-scope: Alice's tick never touches Bob).
        await SeedMed(bobId, bobEmail, "Bob-due", 1, today, remindersEnabled: true);

        await SetAgent(aliceEmail, ScheduledAgentKind.MedicationDue);
        await SetAgent(bobEmail, ScheduledAgentKind.MedicationDue);

        var aliceBefore = await NudgeCount(aliceEmail);
        var bobBefore = await NudgeCount(bobEmail);

        // One tick at noon UTC on 2026-06-28.
        await RunTick(new DateTime(2026, 6, 28, 12, 0, 0, DateTimeKind.Utc));

        (await NudgeCount(aliceEmail)).Should().Be(aliceBefore + 1);
        (await NudgeCount(bobEmail)).Should().Be(bobBefore + 1);

        // Each nudge names ONLY the owner's own med (no cross-user leakage).
        var aliceNudge = await LatestNudgeBody(aliceEmail);
        aliceNudge.Should().Contain("Alice-due");
        aliceNudge.Should().NotContain("Bob-due");

        // A second tick the same local day is idempotent (stamp-first, no double-nudge).
        await RunTick(new DateTime(2026, 6, 28, 12, 1, 0, DateTimeKind.Utc));
        (await NudgeCount(aliceEmail)).Should().Be(aliceBefore + 1);
    }

    [Fact]
    public async Task MedicationDue_agent_says_nothing_when_the_due_dose_is_already_logged()
    {
        var (email, _, id) = await ProvisionUser("tracker.self", "agents.use");
        var today = new DateOnly(2026, 6, 28);
        var medId = await SeedMed(id, email, "Logged-med", 1, today, remindersEnabled: true);
        await SeedLog(medId, email, today, 0, MedicationLogStatus.Taken); // already taken
        await SetAgent(email, ScheduledAgentKind.MedicationDue);

        var before = await NudgeCount(email);
        await RunTick(new DateTime(2026, 6, 28, 12, 0, 0, DateTimeKind.Utc));
        // Nothing to nudge (the due dose is logged) — but the agent stamps so it isn't reconsidered today.
        (await NudgeCount(email)).Should().Be(before);
    }

    // =====================================================================================
    // Seed + tick helpers
    // =====================================================================================

    private async Task<long> SeedMed(
        int userId, string email, string name, int timesPerDay, DateOnly start, bool remindersEnabled = false)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        var now = DateTime.UtcNow;
        var med = new Medication
        {
            UserEmail = email.ToLowerInvariant(), UserId = userId, Name = name, Dose = "1x",
            Schedule = new MedicationSchedule { TimesPerDay = timesPerDay },
            Active = true, StartDate = start, RemindersEnabled = remindersEnabled,
            CreatedUtc = now, UpdatedUtc = now,
        };
        db.Medications.Add(med);
        await db.SaveChangesAsync();
        return med.Id;
    }

    private async Task SeedLog(long medId, string email, DateOnly date, int slot, MedicationLogStatus status)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        db.MedicationLogs.Add(new MedicationLog
        {
            MedicationId = medId, UserEmail = email.ToLowerInvariant(), LocalDate = date, ScheduledSlot = slot,
            Status = status, TakenAtUtc = status == MedicationLogStatus.Taken ? DateTime.UtcNow : null,
            CreatedUtc = DateTime.UtcNow,
        });
        await db.SaveChangesAsync();
    }

    private async Task<long> SeedVital(int userId, string email, VitalKind kind, decimal value1, string note)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        var row = new VitalReading
        {
            UserEmail = email.ToLowerInvariant(), UserId = userId, Kind = kind, Value1 = value1,
            Unit = "x", LocalDate = DateOnly.FromDateTime(DateTime.UtcNow), Notes = note, CreatedUtc = DateTime.UtcNow,
        };
        db.VitalReadings.Add(row);
        await db.SaveChangesAsync();
        return row.Id;
    }

    private async Task SetAgent(string email, ScheduledAgentKind kind)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        var lower = email.ToLowerInvariant();
        var row = await db.ScheduledAgents.FirstOrDefaultAsync(a => a.UserEmail == lower && a.Kind == kind);
        if (row is null)
        {
            row = new ScheduledAgent { UserEmail = lower, Kind = kind, CreatedUtc = DateTime.UtcNow };
            db.ScheduledAgents.Add(row);
        }
        row.Enabled = true;
        row.DeliverHourLocal = 0;
        row.TimeZone = "UTC";
        row.LastFiredLocalDate = null;
        row.UpdatedUtc = DateTime.UtcNow;
        await db.SaveChangesAsync();
    }

    private async Task RunTick(DateTime nowUtc)
    {
        using var scope = factory.Services.CreateScope();
        var sp = scope.ServiceProvider;
        var svc = new AgentScheduler(
            factory.Services.GetRequiredService<IServiceScopeFactory>(),
            factory.Services.GetRequiredService<ILogger<AgentScheduler>>());
        await svc.TickAsync(
            sp.GetRequiredService<UsageDbContext>(),
            sp.GetRequiredService<ChatNotificationService>(),
            sp.GetRequiredService<AgentComposer>(),
            nowUtc);
    }

    private async Task<int> NudgeCount(string email)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        var lower = email.ToLowerInvariant();
        return await db.Notifications.CountAsync(
            n => n.RecipientEmail == lower && n.Type == NotificationType.AgentNudge);
    }

    private async Task<string> LatestNudgeBody(string email)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        var lower = email.ToLowerInvariant();
        return await db.Notifications.AsNoTracking()
            .Where(n => n.RecipientEmail == lower && n.Type == NotificationType.AgentNudge)
            .OrderByDescending(n => n.Id)
            .Select(n => n.Text)
            .FirstAsync();
    }
}
