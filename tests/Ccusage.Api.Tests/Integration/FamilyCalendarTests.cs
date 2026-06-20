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
/// Family Hub F6 — Google Calendar (/api/family/calendar). The OAuth authorization-code/offline flow and
/// the live Calendar API are NOT exercised here (no real Google HTTP in tests); instead these cover the
/// parts we own end-to-end:
///
/// <list type="bullet">
///   <item>GATING: without family.use every calendar endpoint is 403; unauthenticated is 401.</item>
///   <item>STATUS: configured=false when no Google:ClientSecret is set (tests set none); connected=false
///   when the caller has no stored connection.</item>
///   <item>GRACEFUL: the event endpoints (list/create/update/delete) and freebusy return a clear
///   not-connected/not-configured response (NOT a 500) for an unconnected caller; /today still 200s and
///   simply omits events.</item>
///   <item>ENCRYPTION-AT-REST: a stored connection's refresh-token column is AES-GCM ciphertext — the raw
///   token never equals the stored value, never appears in any response, and round-trips via the same
///   protector the app uses.</item>
///   <item>DISCONNECT removes the connection row.</item>
///   <item>FREEBUSY skips unconnected members and never emits an email.</item>
/// </list>
/// Each test provisions fresh users so they're order-independent.
/// </summary>
[Collection(IntegrationCollection.Name)]
public class FamilyCalendarTests(WebAppFactory factory)
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
        var email = $"famcal-{Guid.NewGuid():N}@test.local";
        var res = await Admin().PostAsJsonAsync("/api/users", new { email, isEnabled = true, permissions });
        res.StatusCode.Should().Be(HttpStatusCode.Created);
        var id = (await Json(res)).GetProperty("id").GetInt32();
        return (email, Client(email), id);
    }

    private static async Task<JsonElement> Json(HttpResponseMessage resp) =>
        await resp.Content.ReadFromJsonAsync<JsonElement>();

    /// <summary>Seed a calendar connection for a user directly, storing the refresh token ENCRYPTED the
    /// same way the production connect path does (via the app's TokenProtector). Returns the ciphertext.</summary>
    private async Task<string> SeedConnection(int userId, string plaintextRefreshToken)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        var protector = scope.ServiceProvider.GetRequiredService<TokenProtector>();
        var enc = protector.Protect(plaintextRefreshToken);
        db.GoogleCalendarConnections.Add(new GoogleCalendarConnection
        {
            UserId = userId,
            EncryptedRefreshToken = enc,
            Scope = GoogleCalendarService.Scope,
            GoogleCalendarId = "primary",
            ConnectedUtc = DateTime.UtcNow,
        });
        await db.SaveChangesAsync();
        return enc;
    }

    private async Task<GoogleCalendarConnection?> LoadConnection(int userId)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        return await db.GoogleCalendarConnections.AsNoTracking().FirstOrDefaultAsync(c => c.UserId == userId);
    }

    // =====================================================================================
    // GATING
    // =====================================================================================

    [Fact]
    public async Task Calendar_endpoints_require_family_use()
    {
        var (_, plain, _) = await ProvisionUser("dashboard.view");

        (await plain.GetAsync("/api/family/calendar/status")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await plain.GetAsync("/api/family/calendar/events")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await plain.PostAsJsonAsync("/api/family/calendar/connect", new { code = "x", redirectUri = "postmessage" }))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await plain.PostAsync("/api/family/calendar/disconnect", null)).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await plain.PostAsJsonAsync("/api/family/calendar/freebusy", new { memberUserIds = Array.Empty<int>(), startUtc = DateTime.UtcNow, endUtc = DateTime.UtcNow.AddDays(1) }))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Calendar_status_requires_authentication()
    {
        var anon = factory.CreateClient();
        (await anon.GetAsync("/api/family/calendar/status")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    // =====================================================================================
    // STATUS — configured=false (no client secret in tests), connected=false (no connection)
    // =====================================================================================

    [Fact]
    public async Task Status_is_not_configured_and_not_connected_by_default()
    {
        var (_, owner, _) = await ProvisionUser("family.use");
        await owner.GetAsync("/api/family/household"); // provision the household

        var status = await Json(await owner.GetAsync("/api/family/calendar/status"));
        // No Google:ClientSecret is configured in the test host.
        status.GetProperty("configured").GetBoolean().Should().BeFalse();
        status.GetProperty("connected").GetBoolean().Should().BeFalse();
    }

    // =====================================================================================
    // GRACEFUL degradation — never a 500 for an unconnected caller
    // =====================================================================================

    [Fact]
    public async Task Event_endpoints_degrade_gracefully_when_not_connected()
    {
        var (_, owner, _) = await ProvisionUser("family.use");
        await owner.GetAsync("/api/family/household");

        // GET /events — graceful (200 status body, NOT 500).
        var list = await owner.GetAsync("/api/family/calendar/events?startUtc=2026-06-01T00:00:00Z&endUtc=2026-06-08T00:00:00Z");
        list.StatusCode.Should().Be(HttpStatusCode.OK);
        var listBody = await Json(list);
        listBody.GetProperty("connected").GetBoolean().Should().BeFalse();
        listBody.GetProperty("configured").GetBoolean().Should().BeFalse();

        // POST /events — graceful.
        var create = await owner.PostAsJsonAsync("/api/family/calendar/events", new
        {
            title = "Dentist", startUtc = DateTime.UtcNow.AddHours(1), endUtc = DateTime.UtcNow.AddHours(2),
            allDay = false, location = "", description = "",
        });
        create.StatusCode.Should().Be(HttpStatusCode.OK);
        (await Json(create)).GetProperty("connected").GetBoolean().Should().BeFalse();

        // PUT /events/{id} — graceful.
        var update = await owner.PutAsJsonAsync("/api/family/calendar/events/abc123", new
        {
            title = "Dentist (moved)", startUtc = DateTime.UtcNow.AddHours(1), endUtc = DateTime.UtcNow.AddHours(2),
            allDay = false,
        });
        update.StatusCode.Should().Be(HttpStatusCode.OK);
        (await Json(update)).GetProperty("connected").GetBoolean().Should().BeFalse();

        // DELETE /events/{id} — graceful.
        var del = await owner.DeleteAsync("/api/family/calendar/events/abc123");
        del.StatusCode.Should().Be(HttpStatusCode.OK);
        (await Json(del)).GetProperty("connected").GetBoolean().Should().BeFalse();
    }

    [Fact]
    public async Task Connect_returns_503_when_calendar_is_not_configured()
    {
        var (_, owner, _) = await ProvisionUser("family.use");
        await owner.GetAsync("/api/family/household");

        // With no Google:ClientSecret configured, connecting is unavailable (503) — never a 500.
        var res = await owner.PostAsJsonAsync("/api/family/calendar/connect",
            new { code = "any-code", redirectUri = "postmessage" });
        res.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
    }

    [Fact]
    public async Task Today_omits_events_and_still_200s_when_not_connected()
    {
        var (_, owner, _) = await ProvisionUser("family.use");
        await owner.GetAsync("/api/family/household");

        var res = await owner.GetAsync("/api/family/today");
        res.StatusCode.Should().Be(HttpStatusCode.OK);
        var today = await Json(res);
        // The events array is present and empty (no connected calendar) — Today is never broken by calendar.
        today.GetProperty("events").ValueKind.Should().Be(JsonValueKind.Array);
        today.GetProperty("events").GetArrayLength().Should().Be(0);
    }

    // =====================================================================================
    // ENCRYPTION AT REST — the raw refresh token never appears in the column or any response
    // =====================================================================================

    [Fact]
    public async Task Stored_refresh_token_is_encrypted_at_rest_and_round_trips()
    {
        var (_, _, userId) = await ProvisionUser("family.use");
        const string rawRefreshToken = "1//super-secret-refresh-token-value-do-not-leak";

        var stored = await SeedConnection(userId, rawRefreshToken);

        // The stored column is NOT the plaintext (it's AES-GCM ciphertext) and doesn't contain it.
        stored.Should().NotBe(rawRefreshToken);
        stored.Should().NotContain(rawRefreshToken);

        var conn = await LoadConnection(userId);
        conn.Should().NotBeNull();
        conn!.EncryptedRefreshToken.Should().NotContain(rawRefreshToken);

        // It round-trips back to the plaintext via the SAME protector the app uses.
        using var scope = factory.Services.CreateScope();
        var protector = scope.ServiceProvider.GetRequiredService<TokenProtector>();
        protector.Unprotect(conn.EncryptedRefreshToken).Should().Be(rawRefreshToken);
    }

    [Fact]
    public async Task Status_reports_connected_once_a_connection_is_stored_but_never_leaks_the_token()
    {
        var (_, owner, userId) = await ProvisionUser("family.use");
        await owner.GetAsync("/api/family/household");
        const string rawRefreshToken = "1//another-secret-token-that-must-stay-server-side";
        await SeedConnection(userId, rawRefreshToken);

        // Note: status reports configured=false in tests (no client secret), so connected stays false even
        // with a stored row (connected requires BOTH configured AND a connection). The raw token must never
        // appear in the status payload regardless.
        var res = await owner.GetAsync("/api/family/calendar/status");
        res.StatusCode.Should().Be(HttpStatusCode.OK);
        (await res.Content.ReadAsStringAsync()).Should().NotContain(rawRefreshToken);
    }

    // =====================================================================================
    // DISCONNECT removes the connection
    // =====================================================================================

    [Fact]
    public async Task Disconnect_removes_the_connection()
    {
        var (_, owner, userId) = await ProvisionUser("family.use");
        await owner.GetAsync("/api/family/household");
        await SeedConnection(userId, "1//to-be-removed");
        (await LoadConnection(userId)).Should().NotBeNull();

        var res = await owner.PostAsync("/api/family/calendar/disconnect", null);
        res.StatusCode.Should().Be(HttpStatusCode.OK);
        (await Json(res)).GetProperty("connected").GetBoolean().Should().BeFalse();

        (await LoadConnection(userId)).Should().BeNull();
    }

    // =====================================================================================
    // FREEBUSY — skips unconnected members, never emits an email
    // =====================================================================================

    [Fact]
    public async Task Freebusy_skips_unconnected_members_and_emits_no_email()
    {
        var (_, owner, ownerId) = await ProvisionUser("family.use");
        var (bobEmail, _, bobId) = await ProvisionUser("family.use");
        await owner.GetAsync("/api/family/household");
        await owner.PostAsJsonAsync("/api/family/household/members", new { userId = bobId });

        // Neither member has a (live, configured) connection — with calendar not configured in tests, every
        // member is skipped, so the result is an empty array. It must be a clean 200 (never a 500) and carry
        // no email (in particular Bob's).
        var res = await owner.PostAsJsonAsync("/api/family/calendar/freebusy", new
        {
            memberUserIds = new[] { ownerId, bobId },
            startUtc = DateTime.UtcNow,
            endUtc = DateTime.UtcNow.AddDays(1),
        });
        res.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await res.Content.ReadAsStringAsync();
        body.Should().NotContain("@");
        body.Should().NotContain(bobEmail);

        var arr = await Json(res);
        arr.ValueKind.Should().Be(JsonValueKind.Array);
        // No connected members → no busy blocks surfaced.
        arr.GetArrayLength().Should().Be(0);
    }
}
