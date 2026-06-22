using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Ccusage.Api.Tests.Integration;

/// <summary>
/// Family Hub — Cycle calendar (/api/family/cycle). PRIVACY-FIRST + NON-MEDICAL. Covers:
///
/// <list type="bullet">
///   <item>GATING: every /cycle endpoint requires cycle.track (403 without) and auth (401 unauthenticated).</item>
///   <item>OWNER-SCOPE: a caller only sees/edits their OWN periods — a different user can't read or delete
///   another's, and the GET only returns the caller's own rows.</item>
///   <item>PREDICTIONS: 3 starts 28d apart → nextPredictedStart = last + 28 with a fertile window.</item>
///   <item>SETTINGS clamps (cycle 15..60, period 1..14) and the overlay opt-in toggle.</item>
///   <item>OVERLAY: requires family.use (NOT cycle.track), returns ONLY opted-in members' PREDICTED spans
///   (a non-opted member is excluded), and NEVER an email.</item>
///   <item>AI NOTE: gated by cycle.track AND family.ai; falls back to the deterministic plain floor (200,
///   fellBackToPlain=true) when Gemini is unconfigured.</item>
/// </list>
/// Each test provisions fresh users so they're order-independent.
/// </summary>
[Collection(IntegrationCollection.Name)]
public class CycleTests(WebAppFactory factory)
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
        var email = $"cycle-{Guid.NewGuid():N}@test.local";
        var res = await Admin().PostAsJsonAsync("/api/users", new { email, isEnabled = true, permissions });
        res.StatusCode.Should().Be(HttpStatusCode.Created);
        var id = (await Json(res)).GetProperty("id").GetInt32();
        return (email, Client(email), id);
    }

    private static async Task<JsonElement> Json(HttpResponseMessage resp) =>
        await resp.Content.ReadFromJsonAsync<JsonElement>();

    /// <summary>Seed a logged period directly for a user (bypassing the endpoint) — used to set up an
    /// owner-scope / overlay scenario for another user.</summary>
    private async Task SeedPeriod(int userId, string email, string startIso, string? endIso = null)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        db.CyclePeriods.Add(new CyclePeriod
        {
            UserEmail = email.ToLowerInvariant(),
            UserId = userId,
            StartDate = DateOnly.Parse(startIso),
            EndDate = endIso is null ? null : DateOnly.Parse(endIso),
            LoggedUtc = DateTime.UtcNow,
        });
        await db.SaveChangesAsync();
    }

    /// <summary>Flip a user's CycleProfile.OverlayToFamily opt-in directly (upserting the profile).</summary>
    private async Task SetOverlay(int userId, string email, bool overlay)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        var lower = email.ToLowerInvariant();
        var profile = await db.CycleProfiles.FirstOrDefaultAsync(p => p.UserEmail == lower);
        if (profile is null)
        {
            profile = new CycleProfile { UserEmail = lower, UserId = userId };
            db.CycleProfiles.Add(profile);
        }
        profile.OverlayToFamily = overlay;
        await db.SaveChangesAsync();
    }

    private async Task<int> PeriodCountFor(string email)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        var lower = email.ToLowerInvariant();
        return await db.CyclePeriods.AsNoTracking().CountAsync(p => p.UserEmail == lower);
    }

    // =====================================================================================
    // GATING — cycle.track required (403), auth required (401)
    // =====================================================================================

    [Fact]
    public async Task Cycle_endpoints_require_cycle_track()
    {
        var (_, plain, _) = await ProvisionUser("family.use"); // family.use is NOT enough

        (await plain.GetAsync("/api/family/cycle/")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await plain.PostAsJsonAsync("/api/family/cycle/period", new { startDate = "2026-06-01" }))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await plain.PatchAsJsonAsync("/api/family/cycle/settings", new { avgCycleLengthDays = 28 }))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await plain.DeleteAsync("/api/family/cycle/period/1")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await plain.GetAsync("/api/family/cycle/note")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Cycle_endpoints_require_authentication()
    {
        var anon = factory.CreateClient();
        (await anon.GetAsync("/api/family/cycle/")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await anon.PostAsJsonAsync("/api/family/cycle/period", new { startDate = "2026-06-01" }))
            .StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await anon.GetAsync("/api/family/cycle/note")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await anon.GetAsync("/api/family/cycle/overlay")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    // =====================================================================================
    // LOG + GET — log a period, read it back with predictions + settings
    // =====================================================================================

    [Fact]
    public async Task Log_period_then_get_returns_it_with_settings_defaults()
    {
        var (_, owner, _) = await ProvisionUser("cycle.track");

        var log = await owner.PostAsJsonAsync("/api/family/cycle/period",
            new { startDate = "2026-06-01", endDate = "2026-06-05" });
        log.StatusCode.Should().Be(HttpStatusCode.OK);

        var body = await Json(await owner.GetAsync("/api/family/cycle/"));
        body.GetProperty("periods").GetArrayLength().Should().Be(1);
        body.GetProperty("settings").GetProperty("avgCycleLengthDays").GetInt32().Should().Be(28);
        body.GetProperty("settings").GetProperty("avgPeriodLengthDays").GetInt32().Should().Be(5);
        body.GetProperty("settings").GetProperty("overlayToFamily").GetBoolean().Should().BeFalse();
    }

    [Fact]
    public async Task Log_period_rejects_bad_dates_with_400()
    {
        var (_, owner, _) = await ProvisionUser("cycle.track");

        // End before start.
        (await owner.PostAsJsonAsync("/api/family/cycle/period",
            new { startDate = "2026-06-05", endDate = "2026-06-01" }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
        // Absurd year (out of range).
        (await owner.PostAsJsonAsync("/api/family/cycle/period", new { startDate = "1990-01-01" }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    // =====================================================================================
    // PREDICTIONS — 3 starts 28d apart → next = last + 28 with a fertile window
    // =====================================================================================

    [Fact]
    public async Task Predictions_project_next_start_and_fertile_window_from_logged_starts()
    {
        var (email, owner, id) = await ProvisionUser("cycle.track");
        await SeedPeriod(id, email, "2026-01-01");
        await SeedPeriod(id, email, "2026-01-29");
        await SeedPeriod(id, email, "2026-02-26");

        var pred = (await Json(await owner.GetAsync("/api/family/cycle/"))).GetProperty("prediction");
        pred.GetProperty("avgCycleLengthDays").GetInt32().Should().Be(28);
        pred.GetProperty("nextPredictedStart").GetString().Should().StartWith("2026-03-26");
        var fw = pred.GetProperty("fertileWindow");
        fw.GetProperty("start").GetString().Should().StartWith("2026-03-09");
        fw.GetProperty("end").GetString().Should().StartWith("2026-03-15");
    }

    // =====================================================================================
    // SETTINGS — clamps + the overlay opt-in toggle
    // =====================================================================================

    [Fact]
    public async Task Settings_patch_clamps_out_of_range_values_and_toggles_overlay()
    {
        var (_, owner, _) = await ProvisionUser("cycle.track");

        var res = await owner.PatchAsJsonAsync("/api/family/cycle/settings",
            new { avgCycleLengthDays = 999, avgPeriodLengthDays = 0, overlayToFamily = true });
        res.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await Json(res);
        body.GetProperty("avgCycleLengthDays").GetInt32().Should().Be(60); // clamped 15..60
        body.GetProperty("avgPeriodLengthDays").GetInt32().Should().Be(1); // clamped 1..14
        body.GetProperty("overlayToFamily").GetBoolean().Should().BeTrue();

        // Clamp the other direction too.
        var low = await Json(await owner.PatchAsJsonAsync("/api/family/cycle/settings",
            new { avgCycleLengthDays = 1, avgPeriodLengthDays = 99 }));
        low.GetProperty("avgCycleLengthDays").GetInt32().Should().Be(15);
        low.GetProperty("avgPeriodLengthDays").GetInt32().Should().Be(14);
    }

    // =====================================================================================
    // OWNER-SCOPE — a caller can't read or delete another user's periods
    // =====================================================================================

    [Fact]
    public async Task A_caller_only_sees_their_own_periods()
    {
        var (aEmail, alice, aId) = await ProvisionUser("cycle.track");
        var (bEmail, bob, bId) = await ProvisionUser("cycle.track");
        await SeedPeriod(aId, aEmail, "2026-05-01");
        await SeedPeriod(bId, bEmail, "2026-05-10");

        var aBody = await Json(await alice.GetAsync("/api/family/cycle/"));
        aBody.GetProperty("periods").GetArrayLength().Should().Be(1);
        // Alice's payload never contains Bob's date/email.
        var aRaw = await (await alice.GetAsync("/api/family/cycle/")).Content.ReadAsStringAsync();
        aRaw.Should().NotContain("2026-05-10");
        aRaw.Should().NotContain(bEmail);

        var bBody = await Json(await bob.GetAsync("/api/family/cycle/"));
        bBody.GetProperty("periods").GetArrayLength().Should().Be(1);
    }

    [Fact]
    public async Task A_caller_cannot_delete_another_users_period()
    {
        var (aEmail, _, aId) = await ProvisionUser("cycle.track");
        var (_, bob, _) = await ProvisionUser("cycle.track");
        await SeedPeriod(aId, aEmail, "2026-05-01");

        // Find Alice's period id directly.
        int aliceRowId;
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
            aliceRowId = await db.CyclePeriods.AsNoTracking()
                .Where(p => p.UserEmail == aEmail.ToLowerInvariant()).Select(p => p.Id).FirstAsync();
        }

        // Bob tries to delete Alice's period → 404 (owner-scoped WHERE never matches), and it stays.
        (await bob.DeleteAsync($"/api/family/cycle/period/{aliceRowId}"))
            .StatusCode.Should().Be(HttpStatusCode.NotFound);
        (await PeriodCountFor(aEmail)).Should().Be(1);
    }

    [Fact]
    public async Task Owner_can_delete_their_own_period()
    {
        var (email, owner, _) = await ProvisionUser("cycle.track");
        var logged = await Json(await owner.PostAsJsonAsync("/api/family/cycle/period",
            new { startDate = "2026-06-01" }));
        var id = logged.GetProperty("id").GetInt32();

        (await owner.DeleteAsync($"/api/family/cycle/period/{id}")).StatusCode.Should().Be(HttpStatusCode.NoContent);
        (await PeriodCountFor(email)).Should().Be(0);
        // Deleting again is a 404 (already gone).
        (await owner.DeleteAsync($"/api/family/cycle/period/{id}")).StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    // =====================================================================================
    // AI NOTE — gated by cycle.track AND family.ai; plain floor (200) when Gemini unconfigured
    // =====================================================================================

    [Fact]
    public async Task Note_requires_family_ai_on_top_of_cycle_track()
    {
        var (_, owner, _) = await ProvisionUser("cycle.track"); // no family.ai
        (await owner.GetAsync("/api/family/cycle/note")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Note_falls_back_to_plain_when_gemini_unconfigured_and_never_500s()
    {
        var (email, owner, id) = await ProvisionUser("cycle.track", "family.ai");
        await SeedPeriod(id, email, "2026-01-01");
        await SeedPeriod(id, email, "2026-01-29");

        // No Gemini API key in the test host → ALWAYS 200 with the deterministic floor (fellBackToPlain=true).
        var res = await owner.GetAsync("/api/family/cycle/note");
        res.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await Json(res);
        body.GetProperty("fellBackToPlain").GetBoolean().Should().BeTrue();
        body.GetProperty("note").GetString().Should().NotBeNullOrWhiteSpace();
    }

    // =====================================================================================
    // OVERLAY — requires family.use (NOT cycle.track); only opted-in members' PREDICTED spans; no email
    // =====================================================================================

    [Fact]
    public async Task Overlay_requires_family_use()
    {
        var (_, plain, _) = await ProvisionUser("cycle.track"); // cycle.track alone is NOT the overlay gate
        (await plain.GetAsync("/api/family/cycle/overlay")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Overlay_returns_only_opted_in_members_predicted_spans_and_no_email()
    {
        // Household: a family.use viewer (the caller) + two OTHER members — one opted in, one not.
        var (_, viewer, _) = await ProvisionUser("family.use");
        var (sharerEmail, _, sharerId) = await ProvisionUser("family.use", "cycle.track");      // opts in + logs
        var (nonSharerEmail, _, nonSharerId) = await ProvisionUser("family.use", "cycle.track"); // logs, NOT opted in

        await viewer.GetAsync("/api/family/household"); // provision the household (caller = owner)
        await viewer.PostAsJsonAsync("/api/family/household/members", new { userId = sharerId });
        await viewer.PostAsJsonAsync("/api/family/household/members", new { userId = nonSharerId });

        // Both log periods; only the sharer opts in.
        await SeedPeriod(sharerId, sharerEmail, "2026-01-01");
        await SeedPeriod(sharerId, sharerEmail, "2026-01-29");
        await SeedPeriod(nonSharerId, nonSharerEmail, "2026-01-03");
        await SeedPeriod(nonSharerId, nonSharerEmail, "2026-01-31");
        await SetOverlay(sharerId, sharerEmail, true);
        await SetOverlay(nonSharerId, nonSharerEmail, false);

        var res = await viewer.GetAsync(
            "/api/family/cycle/overlay?fromUtc=2026-02-01T00:00:00Z&toUtc=2026-03-01T00:00:00Z");
        res.StatusCode.Should().Be(HttpStatusCode.OK);

        // NO email anywhere.
        var raw = await res.Content.ReadAsStringAsync();
        raw.Should().NotContain("@");
        raw.Should().NotContain(sharerEmail);
        raw.Should().NotContain(nonSharerEmail);

        var arr = await Json(res);
        arr.ValueKind.Should().Be(JsonValueKind.Array);
        var ids = arr.EnumerateArray().Select(x => x.GetProperty("userId").GetInt32()).ToList();
        ids.Should().Contain(sharerId);        // opted-in member appears
        ids.Should().NotContain(nonSharerId);  // non-opted member excluded

        // Every surfaced span is flagged predicted=true and is one of the two kinds.
        foreach (var member in arr.EnumerateArray())
        foreach (var phase in member.GetProperty("phases").EnumerateArray())
        {
            phase.GetProperty("predicted").GetBoolean().Should().BeTrue();
            phase.GetProperty("kind").GetString().Should().BeOneOf("period", "fertile");
        }
    }

    [Fact]
    public async Task Overlay_includes_the_caller_when_they_cycle_track()
    {
        // A caller who holds BOTH family.use AND cycle.track sees their OWN predictions even with no household.
        var (email, owner, id) = await ProvisionUser("family.use", "cycle.track");
        await SeedPeriod(id, email, "2026-01-01");
        await SeedPeriod(id, email, "2026-01-29");

        var res = await owner.GetAsync(
            "/api/family/cycle/overlay?fromUtc=2026-02-01T00:00:00Z&toUtc=2026-03-01T00:00:00Z");
        res.StatusCode.Should().Be(HttpStatusCode.OK);
        var ids = (await Json(res)).EnumerateArray().Select(x => x.GetProperty("userId").GetInt32()).ToList();
        ids.Should().Contain(id);
    }
}
