using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Ccusage.Api.Data;
using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Ccusage.Api.Tests.Integration;

[Collection(IntegrationCollection.Name)]
public class AuthIntegrationTests(WebAppFactory factory)
{
    private const string Summary = "/api/usage/summary?groupBy=day";

    private HttpClient Client(string? email = null)
    {
        var c = factory.CreateClient();
        if (email is not null)
            c.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", TestJwt.For(email));
        return c;
    }

    [Fact]
    public async Task Health_is_public()
        => (await Client().GetAsync("/api/health")).StatusCode.Should().Be(HttpStatusCode.OK);

    [Fact]
    public async Task Data_endpoints_require_authentication()
        => (await Client().GetAsync(Summary)).StatusCode.Should().Be(HttpStatusCode.Unauthorized);

    [Fact]
    public async Task Tampered_token_is_unauthorized()
    {
        var c = factory.CreateClient();
        c.DefaultRequestHeaders.Authorization =
            new AuthenticationHeaderValue("Bearer", TestJwt.For(WebAppFactory.AdminEmail, "a-totally-different-wrong-key-32-bytes-minimum!"));
        (await c.GetAsync(Summary)).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Valid_token_for_unknown_user_is_forbidden()
        => (await Client("ghost@test.local").GetAsync(Summary)).StatusCode.Should().Be(HttpStatusCode.Forbidden);

    [Fact]
    public async Task Seeded_admin_can_read_and_manage()
    {
        var c = Client(WebAppFactory.AdminEmail);
        (await c.GetAsync(Summary)).StatusCode.Should().Be(HttpStatusCode.OK);
        (await c.GetAsync("/api/users")).StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Viewer_is_denied_users_and_sync()
    {
        var email = $"viewer-{Guid.NewGuid():N}@test.local";
        await Client(WebAppFactory.AdminEmail).PostAsJsonAsync("/api/users",
            new { email, isEnabled = true, permissions = new[] { "dashboard.view" } });

        var viewer = Client(email);
        (await viewer.GetAsync(Summary)).StatusCode.Should().Be(HttpStatusCode.OK);
        (await viewer.GetAsync("/api/users")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await viewer.PostAsync("/api/sync", null)).StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Disabling_a_user_revokes_access_on_the_next_request()
    {
        var admin = Client(WebAppFactory.AdminEmail);
        var email = $"revoke-{Guid.NewGuid():N}@test.local";
        var created = await admin.PostAsJsonAsync("/api/users",
            new { email, isEnabled = true, permissions = new[] { "dashboard.view" } });
        var id = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetInt32();

        var viewer = Client(email);
        (await viewer.GetAsync(Summary)).StatusCode.Should().Be(HttpStatusCode.OK);

        await admin.PutAsJsonAsync($"/api/users/{id}",
            new { isEnabled = false, permissions = new[] { "dashboard.view" } });

        // Same (still-valid) token, but the DB now says disabled -> denied immediately.
        (await viewer.GetAsync(Summary)).StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Cannot_remove_the_last_administrator()
    {
        var admin = Client(WebAppFactory.AdminEmail);
        var users = await (await admin.GetAsync("/api/users")).Content.ReadFromJsonAsync<JsonElement>();
        var adminId = users.EnumerateArray()
            .First(u => u.GetProperty("email").GetString() == WebAppFactory.AdminEmail)
            .GetProperty("id").GetInt32();

        var res = await admin.PutAsJsonAsync($"/api/users/{adminId}",
            new { isEnabled = true, permissions = new[] { "dashboard.view" } }); // drops users.manage
        res.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Csv_export_requires_authentication()
        => (await Client().GetAsync("/api/usage/records.csv")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);

    [Fact]
    public async Task Admin_can_export_records_as_csv_with_header()
    {
        var res = await Client(WebAppFactory.AdminEmail).GetAsync("/api/usage/records.csv");

        res.StatusCode.Should().Be(HttpStatusCode.OK);
        res.Content.Headers.ContentType!.MediaType.Should().Be("text/csv");
        var body = await res.Content.ReadAsStringAsync();
        body.Should().StartWith("date,source,model,project,type,input,output,cache_read,cache_5m,cache_1h,total,cost_usd");
    }

    [Fact]
    public async Task User_management_actions_are_written_to_the_audit_log()
    {
        var admin = Client(WebAppFactory.AdminEmail);
        var email = $"audited-{Guid.NewGuid():N}@test.local";
        await admin.PostAsJsonAsync("/api/users",
            new { email, isEnabled = true, permissions = new[] { "dashboard.view" } });

        var audit = await (await admin.GetAsync("/api/audit")).Content.ReadFromJsonAsync<JsonElement>();
        audit.EnumerateArray().ToList().Should().Contain(e =>
            e.GetProperty("action").GetString() == "user.created" &&
            e.GetProperty("targetEmail").GetString() == email &&
            e.GetProperty("actorEmail").GetString() == WebAppFactory.AdminEmail);
    }

    [Fact]
    public async Task Audit_log_is_gated_by_users_manage()
    {
        var email = $"viewer-audit-{Guid.NewGuid():N}@test.local";
        await Client(WebAppFactory.AdminEmail).PostAsJsonAsync("/api/users",
            new { email, isEnabled = true, permissions = new[] { "dashboard.view" } });

        (await Client(email).GetAsync("/api/audit")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    // ---- Google sign-in: identity verification + subject pinning ----
    // (FakeGoogleTokenValidator reads the posted idToken as "email|subject".)

    private Task<HttpResponseMessage> GoogleLogin(string idToken)
        => factory.CreateClient().PostAsJsonAsync("/api/auth/google", new { idToken });

    [Fact]
    public async Task Google_login_with_an_invalid_token_is_unauthorized()
        => (await GoogleLogin("invalid")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);

    [Fact]
    public async Task Google_login_for_an_unprovisioned_email_is_forbidden()
        => (await GoogleLogin($"ghost-{Guid.NewGuid():N}@test.local|sub-x"))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);

    [Fact]
    public async Task Google_login_pins_the_account_to_its_google_subject()
    {
        var email = $"glogin-{Guid.NewGuid():N}@test.local";
        await Client(WebAppFactory.AdminEmail).PostAsJsonAsync("/api/users",
            new { email, isEnabled = true, permissions = new[] { "dashboard.view" } });

        // First login binds the Google subject and returns an app token.
        var first = await GoogleLogin($"{email}|sub-A");
        first.StatusCode.Should().Be(HttpStatusCode.OK);
        (await first.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("token").GetString().Should().NotBeNullOrEmpty();

        // The same Google account logs in again fine.
        (await GoogleLogin($"{email}|sub-A")).StatusCode.Should().Be(HttpStatusCode.OK);

        // A different Google account presenting the same (now-bound) email is rejected.
        (await GoogleLogin($"{email}|sub-B")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    // ---- Request/response action log (middleware) ----

    /// <summary>Polls /api/logs (logging is async) until an entry matches, or fails after a timeout.</summary>
    private async Task<JsonElement> WaitForLog(HttpClient admin, Func<JsonElement, bool> match)
    {
        for (var i = 0; i < 50; i++) // ~7.5s
        {
            var logs = await (await admin.GetAsync("/api/logs?take=500")).Content.ReadFromJsonAsync<JsonElement>();
            foreach (var e in logs.EnumerateArray())
                if (match(e)) return e;
            await Task.Delay(150);
        }
        throw new Xunit.Sdk.XunitException("Expected log entry did not appear in time.");
    }

    [Fact]
    public async Task Requests_are_captured_in_the_action_log()
    {
        var admin = Client(WebAppFactory.AdminEmail);
        await admin.GetAsync("/api/usage/summary?groupBy=day&marker=logcap");

        var entry = await WaitForLog(admin, e =>
            e.GetProperty("path").GetString() == "/api/usage/summary" &&
            (e.GetProperty("queryString").GetString() ?? "").Contains("logcap"));

        entry.GetProperty("method").GetString().Should().Be("GET");
        entry.GetProperty("statusCode").GetInt32().Should().Be(200);
        entry.GetProperty("userEmail").GetString().Should().Be(WebAppFactory.AdminEmail);
        entry.GetProperty("durationMs").GetInt32().Should().BeGreaterThanOrEqualTo(0);
    }

    [Fact]
    public async Task Action_log_is_gated_by_users_manage()
    {
        var email = $"viewer-logs-{Guid.NewGuid():N}@test.local";
        await Client(WebAppFactory.AdminEmail).PostAsJsonAsync("/api/users",
            new { email, isEnabled = true, permissions = new[] { "dashboard.view" } });

        (await Client(email).GetAsync("/api/logs")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await Client().GetAsync("/api/logs")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Auth_route_bodies_are_redacted_in_the_log()
    {
        var admin = Client(WebAppFactory.AdminEmail);
        await Client().PostAsJsonAsync("/api/auth/google", new { idToken = "should-not-be-stored" });

        var entry = await WaitForLog(admin, e => e.GetProperty("path").GetString() == "/api/auth/google");
        entry.GetProperty("requestBody").GetString().Should().Be("[redacted]");
        // and the raw token must never appear anywhere in the entry
        entry.GetRawText().Should().NotContain("should-not-be-stored");
    }

    [Fact]
    public async Task Health_and_polling_routes_are_not_logged()
    {
        var admin = Client(WebAppFactory.AdminEmail);
        await admin.GetAsync("/api/auth/me");
        await admin.GetAsync("/api/sync/status");
        await admin.GetAsync("/api/health");
        await admin.GetAsync("/api/usage/summary?groupBy=day&marker=exclsync");

        await WaitForLog(admin, e => (e.GetProperty("queryString").GetString() ?? "").Contains("exclsync"));

        var logs = await (await admin.GetAsync("/api/logs?take=1000")).Content.ReadFromJsonAsync<JsonElement>();
        var paths = logs.EnumerateArray().Select(e => e.GetProperty("path").GetString()).ToList();
        paths.Should().NotContain("/api/auth/me");
        paths.Should().NotContain("/api/sync/status");
        paths.Should().NotContain("/api/health");
        paths.Should().NotContain("/api/logs");
    }

    [Fact]
    public async Task Response_bodies_are_captured()
    {
        var admin = Client(WebAppFactory.AdminEmail);
        await admin.GetAsync("/api/permissions"); // returns the permission catalog JSON

        var entry = await WaitForLog(admin, e => e.GetProperty("path").GetString() == "/api/permissions");
        var body = entry.GetProperty("responseBody").GetString();
        body.Should().NotBeNullOrEmpty();
        body.Should().Contain("dashboard.view");
    }

    [Fact]
    public async Task Query_string_secrets_are_redacted_in_the_log()
    {
        var admin = Client(WebAppFactory.AdminEmail);
        await admin.GetAsync("/api/usage/summary?groupBy=day&access_token=QSECRET123&marker=qredact");

        var entry = await WaitForLog(admin, e => (e.GetProperty("queryString").GetString() ?? "").Contains("qredact"));
        var qs = entry.GetProperty("queryString").GetString()!;
        qs.Should().NotContain("QSECRET123");
        qs.Should().Contain("access_token=[redacted]");
    }

    // ---- Discord notifications ----

    private static object NotifBody(string? url, bool enabled = false) => new
    {
        discordWebhookUrl = url, enabled, digestHourLocal = 9, dailyDigest = false,
        weeklyDigest = false, weeklyDay = 1, thresholdEnabled = false, thresholdUsd = 0,
    };

    [Fact]
    public async Task Notifications_require_settings_manage()
    {
        var email = $"viewer-notif-{Guid.NewGuid():N}@test.local";
        await Client(WebAppFactory.AdminEmail).PostAsJsonAsync("/api/users",
            new { email, isEnabled = true, permissions = new[] { "dashboard.view" } });

        (await Client(email).GetAsync("/api/notifications")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await Client().GetAsync("/api/notifications")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Saving_a_discord_webhook_masks_it_on_read()
    {
        var admin = Client(WebAppFactory.AdminEmail);
        var res = await admin.PutAsJsonAsync("/api/notifications",
            NotifBody("https://discord.com/api/webhooks/123456/abcdefSECRETtoken", enabled: true));

        res.StatusCode.Should().Be(HttpStatusCode.OK);
        var dto = await res.Content.ReadFromJsonAsync<JsonElement>();
        dto.GetProperty("webhookConfigured").GetBoolean().Should().BeTrue();
        dto.GetRawText().Should().NotContain("abcdefSECRETtoken"); // raw URL never returned
        dto.GetProperty("webhookMasked").GetString().Should().Contain("…");
    }

    [Fact]
    public async Task Invalid_webhook_url_is_rejected()
        => (await Client(WebAppFactory.AdminEmail).PutAsJsonAsync("/api/notifications",
                NotifBody("https://evil.example.com/api/webhooks/1/2")))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);

    [Fact]
    public async Task Discord_webhook_url_is_redacted_in_the_action_log()
    {
        var admin = Client(WebAppFactory.AdminEmail);
        await admin.PutAsJsonAsync("/api/notifications",
            NotifBody("https://discord.com/api/webhooks/999/REDACTME_TOKEN"));

        var entry = await WaitForLog(admin, e =>
            e.GetProperty("path").GetString() == "/api/notifications" && e.GetProperty("method").GetString() == "PUT");
        entry.GetProperty("requestBody").GetString().Should().Be("[redacted]");
        entry.GetRawText().Should().NotContain("REDACTME_TOKEN");
    }

    [Fact]
    public async Task Test_requires_a_configured_webhook()
    {
        var admin = Client(WebAppFactory.AdminEmail);
        await admin.PutAsJsonAsync("/api/notifications", NotifBody("")); // clear
        (await admin.PostAsync("/api/notifications/test", null)).StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Snapshot_requires_a_configured_webhook()
    {
        var admin = Client(WebAppFactory.AdminEmail);
        await admin.PutAsJsonAsync("/api/notifications", NotifBody("")); // clear
        (await admin.PostAsync("/api/notifications/snapshot", null)).StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Snapshot_requires_settings_manage()
    {
        var email = $"viewer-snap-{Guid.NewGuid():N}@test.local";
        await Client(WebAppFactory.AdminEmail).PostAsJsonAsync("/api/users",
            new { email, isEnabled = true, permissions = new[] { "dashboard.view" } });

        (await Client(email).PostAsync("/api/notifications/snapshot", null)).StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Security_alerts_and_mention_round_trip()
    {
        var admin = Client(WebAppFactory.AdminEmail);
        await admin.PutAsJsonAsync("/api/notifications", new
        {
            discordWebhookUrl = "https://discord.com/api/webhooks/55/sometoken",
            enabled = true, digestHourLocal = 9, dailyDigest = false, weeklyDigest = false,
            weeklyDay = 1, thresholdEnabled = false, thresholdUsd = 0,
            securityAlerts = true, mentionOnAlert = "@here",
        });

        var dto = await (await admin.GetAsync("/api/notifications")).Content.ReadFromJsonAsync<JsonElement>();
        dto.GetProperty("securityAlerts").GetBoolean().Should().BeTrue();
        dto.GetProperty("mentionOnAlert").GetString().Should().Be("@here");
    }

    [Fact]
    public async Task Unprovisioned_google_login_is_not_audited()
    {
        // Reachable by any Google account (open self-signup), so it must NOT create audit rows.
        var admin = Client(WebAppFactory.AdminEmail);
        var email = $"ghost-audit-{Guid.NewGuid():N}@test.local";
        (await GoogleLogin($"{email}|sub-x")).StatusCode.Should().Be(HttpStatusCode.Forbidden);

        var audit = await (await admin.GetAsync("/api/audit")).Content.ReadFromJsonAsync<JsonElement>();
        audit.EnumerateArray().ToList().Should().NotContain(e =>
            e.GetProperty("action").GetString() == "auth.denied" &&
            e.GetProperty("targetEmail").GetString() == email);
    }

    [Fact]
    public async Task Disabled_user_google_login_is_audited()
    {
        var admin = Client(WebAppFactory.AdminEmail);
        var email = $"disabled-audit-{Guid.NewGuid():N}@test.local";
        var created = await admin.PostAsJsonAsync("/api/users",
            new { email, isEnabled = true, permissions = new[] { "dashboard.view" } });
        var id = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetInt32();
        await admin.PutAsJsonAsync($"/api/users/{id}",
            new { isEnabled = false, permissions = new[] { "dashboard.view" } });

        (await GoogleLogin($"{email}|sub-d")).StatusCode.Should().Be(HttpStatusCode.Forbidden);

        var audit = await (await admin.GetAsync("/api/audit")).Content.ReadFromJsonAsync<JsonElement>();
        audit.EnumerateArray().ToList().Should().Contain(e =>
            e.GetProperty("action").GetString() == "auth.denied" &&
            e.GetProperty("targetEmail").GetString() == email);
    }

    [Fact]
    public async Task Overlong_mention_is_clamped_not_500()
    {
        var res = await Client(WebAppFactory.AdminEmail).PutAsJsonAsync("/api/notifications", new
        {
            discordWebhookUrl = (string?)null, enabled = false, digestHourLocal = 9, dailyDigest = false,
            weeklyDigest = false, weeklyDay = 1, thresholdEnabled = false, thresholdUsd = 0,
            securityAlerts = false, mentionOnAlert = new string('x', 200),
        });

        res.StatusCode.Should().Be(HttpStatusCode.OK);
        var dto = await res.Content.ReadFromJsonAsync<JsonElement>();
        dto.GetProperty("mentionOnAlert").GetString()!.Length.Should().BeLessThanOrEqualTo(64);
    }

    // ---- Analytics (heatmap / stats / session) ----

    [Fact]
    public async Task Analytics_endpoints_require_authentication()
    {
        (await Client().GetAsync("/api/usage/heatmap")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await Client().GetAsync("/api/usage/stats")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Heatmap_and_stats_return_ok()
    {
        var admin = Client(WebAppFactory.AdminEmail);
        (await admin.GetAsync("/api/usage/heatmap")).StatusCode.Should().Be(HttpStatusCode.OK);

        var res = await admin.GetAsync("/api/usage/stats");
        res.StatusCode.Should().Be(HttpStatusCode.OK);
        (await res.Content.ReadFromJsonAsync<JsonElement>()).TryGetProperty("totalActiveHours", out _).Should().BeTrue();
    }

    [Fact]
    public async Task Unknown_session_is_404()
        => (await Client(WebAppFactory.AdminEmail).GetAsync("/api/usage/session/not-a-real-session"))
            .StatusCode.Should().Be(HttpStatusCode.NotFound);

    // ---- Public share links ----

    private static object ShareReq(string? label = null, int hours = 24, string groupBy = "day", string[]? source = null) => new
    {
        label, expiresInHours = hours, from = (string?)null, to = (string?)null,
        projectId = Array.Empty<int>(), model = Array.Empty<string>(), source = source ?? Array.Empty<string>(),
        includeSidechain = true, groupBy,
    };

    [Fact]
    public async Task Share_management_requires_authentication()
    {
        (await Client().GetAsync("/api/shares")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await Client().PostAsJsonAsync("/api/shares", ShareReq())).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Public_share_serves_aggregates_anonymously()
    {
        var admin = Client(WebAppFactory.AdminEmail);
        var created = await (await admin.PostAsJsonAsync("/api/shares", ShareReq(label: "Finance", source: new[] { "codex" })))
            .Content.ReadFromJsonAsync<JsonElement>();
        var token = created.GetProperty("token").GetString()!;
        created.GetProperty("path").GetString().Should().Be($"/share/{token}");

        // Anonymous read works and reflects the baked scope.
        var pub = await (await Client().GetAsync($"/api/share/{token}")).Content.ReadFromJsonAsync<JsonElement>();
        pub.GetProperty("scope").GetString().Should().Contain("codex");
        pub.TryGetProperty("summary", out _).Should().BeTrue();
        // (The token deliberately appears in the auth-only /api/shares list for re-copy; the action log
        // redacts those bodies — see Share_token_is_redacted_in_the_action_log.)
    }

    [Fact]
    public async Task Invalid_share_token_is_404()
        => (await Client().GetAsync("/api/share/this-token-does-not-exist")).StatusCode.Should().Be(HttpStatusCode.NotFound);

    [Fact]
    public async Task Revoked_share_stops_working()
    {
        var admin = Client(WebAppFactory.AdminEmail);
        var created = await (await admin.PostAsJsonAsync("/api/shares", ShareReq())).Content.ReadFromJsonAsync<JsonElement>();
        var token = created.GetProperty("token").GetString()!;
        var id = created.GetProperty("id").GetInt32();

        (await Client().GetAsync($"/api/share/{token}")).StatusCode.Should().Be(HttpStatusCode.OK);
        (await admin.DeleteAsync($"/api/shares/{id}")).StatusCode.Should().Be(HttpStatusCode.NoContent);
        (await Client().GetAsync($"/api/share/{token}")).StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task Public_read_increments_access_count()
    {
        var admin = Client(WebAppFactory.AdminEmail);
        var created = await (await admin.PostAsJsonAsync("/api/shares", ShareReq())).Content.ReadFromJsonAsync<JsonElement>();
        var token = created.GetProperty("token").GetString()!;
        var id = created.GetProperty("id").GetInt32();

        await Client().GetAsync($"/api/share/{token}");
        await Client().GetAsync($"/api/share/{token}");

        var list = await (await admin.GetAsync("/api/shares")).Content.ReadFromJsonAsync<JsonElement>();
        var item = list.EnumerateArray().First(e => e.GetProperty("id").GetInt32() == id);
        item.GetProperty("accessCount").GetInt32().Should().BeGreaterThanOrEqualTo(2);
    }

    [Fact]
    public async Task Share_can_be_recopied_from_the_list()
    {
        var admin = Client(WebAppFactory.AdminEmail);
        var created = await (await admin.PostAsJsonAsync("/api/shares", ShareReq())).Content.ReadFromJsonAsync<JsonElement>();
        var id = created.GetProperty("id").GetInt32();

        var list = await (await admin.GetAsync("/api/shares")).Content.ReadFromJsonAsync<JsonElement>();
        var item = list.EnumerateArray().First(e => e.GetProperty("id").GetInt32() == id);
        var path = item.GetProperty("path").GetString()!;
        path.Should().StartWith("/share/");

        // The re-derived token still resolves the public link.
        var token = path["/share/".Length..];
        (await Client().GetAsync($"/api/share/{token}")).StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Share_expiry_and_label_can_be_updated()
    {
        var admin = Client(WebAppFactory.AdminEmail);
        var created = await (await admin.PostAsJsonAsync("/api/shares", ShareReq(hours: 1))).Content.ReadFromJsonAsync<JsonElement>();
        var id = created.GetProperty("id").GetInt32();
        var origExpires = created.GetProperty("expiresUtc").GetDateTime();

        var put = await admin.PutAsJsonAsync($"/api/shares/{id}", new { expiresInHours = 720, label = "Renewed" });
        put.StatusCode.Should().Be(HttpStatusCode.OK);
        var dto = await put.Content.ReadFromJsonAsync<JsonElement>();
        dto.GetProperty("label").GetString().Should().Be("Renewed");
        dto.GetProperty("expiresUtc").GetDateTime().Should().BeAfter(origExpires);
    }

    [Fact]
    public async Task Share_token_is_redacted_in_the_action_log()
    {
        var admin = Client(WebAppFactory.AdminEmail);
        var created = await (await admin.PostAsJsonAsync("/api/shares", ShareReq(label: "LogTest"))).Content.ReadFromJsonAsync<JsonElement>();
        var token = created.GetProperty("token").GetString()!;

        var entry = await WaitForLog(admin, e =>
            e.GetProperty("path").GetString() == "/api/shares" && e.GetProperty("method").GetString() == "POST");
        entry.GetProperty("responseBody").GetString().Should().Be("[redacted]");
        entry.GetRawText().Should().NotContain(token);
    }

    [Fact]
    public async Task Share_views_are_recorded_with_timestamp()
    {
        var admin = Client(WebAppFactory.AdminEmail);
        var created = await (await admin.PostAsJsonAsync("/api/shares", ShareReq())).Content.ReadFromJsonAsync<JsonElement>();
        var token = created.GetProperty("token").GetString()!;
        var id = created.GetProperty("id").GetInt32();

        await Client().GetAsync($"/api/share/{token}"); // anonymous view → recorded

        var accesses = await (await admin.GetAsync($"/api/shares/{id}/accesses")).Content.ReadFromJsonAsync<JsonElement>();
        accesses.GetArrayLength().Should().BeGreaterThanOrEqualTo(1);
        accesses[0].TryGetProperty("whenUtc", out _).Should().BeTrue();
    }

    [Fact]
    public async Task Expired_share_is_404()
    {
        var admin = Client(WebAppFactory.AdminEmail);
        var created = await (await admin.PostAsJsonAsync("/api/shares", ShareReq())).Content.ReadFromJsonAsync<JsonElement>();
        var token = created.GetProperty("token").GetString()!;
        var id = created.GetProperty("id").GetInt32();

        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
            var share = await db.ShareLinks.FirstAsync(s => s.Id == id);
            share.ExpiresUtc = DateTime.UtcNow.AddMinutes(-1);
            await db.SaveChangesAsync();
        }

        (await Client().GetAsync($"/api/share/{token}")).StatusCode.Should().Be(HttpStatusCode.NotFound);
    }
}
