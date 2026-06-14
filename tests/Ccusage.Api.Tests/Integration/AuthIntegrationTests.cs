using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using FluentAssertions;

namespace Ccusage.Api.Tests.Integration;

public class AuthIntegrationTests(WebAppFactory factory) : IClassFixture<WebAppFactory>
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
}
