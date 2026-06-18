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

    /// <summary>Provisions a user with an exact permission set and returns a client for them.</summary>
    private async Task<HttpClient> ProvisionUser(params string[] permissions)
    {
        var email = $"u-{Guid.NewGuid():N}@test.local";
        var res = await Client(WebAppFactory.AdminEmail).PostAsJsonAsync("/api/users",
            new { email, isEnabled = true, permissions });
        res.StatusCode.Should().Be(HttpStatusCode.Created);
        return Client(email);
    }

    [Fact]
    public async Task Dashboard_view_does_not_grant_calendar_or_export()
    {
        // The dashboard split: dashboard.view no longer covers calendar or CSV export.
        var c = await ProvisionUser("dashboard.view");
        (await c.GetAsync(Summary)).StatusCode.Should().Be(HttpStatusCode.OK);
        (await c.GetAsync("/api/usage/calendar")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await c.GetAsync("/api/usage/heatmap")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await c.GetAsync("/api/usage/records.csv")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Export_permission_unlocks_csv_only()
    {
        var c = await ProvisionUser("dashboard.export");
        (await c.GetAsync("/api/usage/records.csv")).StatusCode.Should().Be(HttpStatusCode.OK);
        // export alone does not grant the summary (gated by dashboard.view).
        (await c.GetAsync(Summary)).StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Calendar_view_unlocks_the_calendar_endpoints()
    {
        var c = await ProvisionUser("calendar.view");
        (await c.GetAsync("/api/usage/calendar")).StatusCode.Should().Be(HttpStatusCode.OK);
        (await c.GetAsync("/api/usage/stats")).StatusCode.Should().Be(HttpStatusCode.OK);
        (await c.GetAsync(Summary)).StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Any_of_lets_either_dashboard_or_calendar_view_reach_projects()
    {
        // GET /api/projects accepts ANY(dashboard.view, calendar.view).
        var dash = await ProvisionUser("dashboard.view");
        (await dash.GetAsync("/api/projects")).StatusCode.Should().Be(HttpStatusCode.OK);
        (await dash.GetAsync("/api/models")).StatusCode.Should().Be(HttpStatusCode.OK);

        var cal = await ProvisionUser("calendar.view");
        (await cal.GetAsync("/api/projects")).StatusCode.Should().Be(HttpStatusCode.OK);
        (await cal.GetAsync("/api/models")).StatusCode.Should().Be(HttpStatusCode.OK);

        // Someone with neither view is denied.
        var neither = await ProvisionUser("sync.run");
        (await neither.GetAsync("/api/projects")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Sync_status_and_settings_are_reachable_by_any_page_viewer()
    {
        // GET /api/sync/status and GET /api/settings accept ANY(Permissions.Views).
        // An activity-only viewer holds a *.view key but none of the data perms.
        var c = await ProvisionUser("activity.view");
        (await c.GetAsync("/api/sync/status")).StatusCode.Should().Be(HttpStatusCode.OK);
        (await c.GetAsync("/api/settings")).StatusCode.Should().Be(HttpStatusCode.OK);
        // ...but cannot read the dashboard summary.
        (await c.GetAsync(Summary)).StatusCode.Should().Be(HttpStatusCode.Forbidden);

        // A user with NO view permission at all is denied even sync/status.
        var noView = await ProvisionUser("sync.run");
        (await noView.GetAsync("/api/sync/status")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Notifications_view_reads_but_cannot_manage()
    {
        var c = await ProvisionUser("notifications.view");
        (await c.GetAsync("/api/notifications")).StatusCode.Should().Be(HttpStatusCode.OK);
        var put = await c.PutAsJsonAsync("/api/notifications", NotifBody(null));
        put.StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Pricing_view_reads_but_cannot_manage()
    {
        var c = await ProvisionUser("pricing.view");
        (await c.GetAsync("/api/pricing")).StatusCode.Should().Be(HttpStatusCode.OK);
        (await c.PostAsync("/api/pricing/recompute", null)).StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Sources_view_reads_but_cannot_manage_and_reporter_split_holds()
    {
        // settings.view can read /api/sources (any-of) but not edit them (sources.manage).
        var settingsViewer = await ProvisionUser("settings.view");
        (await settingsViewer.GetAsync("/api/sources")).StatusCode.Should().Be(HttpStatusCode.OK);

        // reporter.view reads ingest keys but cannot create/revoke them.
        var reporterViewer = await ProvisionUser("reporter.view");
        (await reporterViewer.GetAsync("/api/ingest-keys")).StatusCode.Should().Be(HttpStatusCode.OK);
        (await reporterViewer.PostAsJsonAsync("/api/ingest-keys", new { name = "x" }))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Shares_view_lists_but_cannot_create_and_activity_gates_logs()
    {
        var sharesViewer = await ProvisionUser("shares.view");
        (await sharesViewer.GetAsync("/api/shares")).StatusCode.Should().Be(HttpStatusCode.OK);
        (await sharesViewer.PostAsJsonAsync("/api/shares", ShareReq())).StatusCode.Should().Be(HttpStatusCode.Forbidden);

        // /api/logs is now gated by activity.view (not users.manage).
        var activityViewer = await ProvisionUser("activity.view");
        (await activityViewer.GetAsync("/api/logs")).StatusCode.Should().Be(HttpStatusCode.OK);
        var noActivity = await ProvisionUser("users.view");
        (await noActivity.GetAsync("/api/logs")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Users_view_reads_list_and_audit_but_cannot_mutate()
    {
        var c = await ProvisionUser("users.view");
        (await c.GetAsync("/api/users")).StatusCode.Should().Be(HttpStatusCode.OK);
        (await c.GetAsync("/api/audit")).StatusCode.Should().Be(HttpStatusCode.OK);
        (await c.GetAsync("/api/permissions")).StatusCode.Should().Be(HttpStatusCode.OK);
        // ...but cannot create users.
        (await c.PostAsJsonAsync("/api/users",
            new { email = "blocked@test.local", isEnabled = true, permissions = new[] { "dashboard.view" } }))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);
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

    // ---- Force-logout (session invalidation via SessionVersion / "sv" claim) ----

    /// <summary>Creates a user and returns (id, email).</summary>
    private async Task<(int Id, string Email)> CreateUser(params string[] permissions)
    {
        var email = $"fl-{Guid.NewGuid():N}@test.local";
        var created = await Client(WebAppFactory.AdminEmail).PostAsJsonAsync("/api/users",
            new { email, isEnabled = true, permissions = permissions.Length == 0 ? new[] { "dashboard.view" } : permissions });
        created.StatusCode.Should().Be(HttpStatusCode.Created);
        var id = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetInt32();
        return (id, email);
    }

    private HttpClient ClientWithSv(string email, int? sv)
    {
        var c = factory.CreateClient();
        c.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", TestJwt.For(email, sv: sv));
        return c;
    }

    /// <summary>
    /// Reads /api/audit as the admin WITH the email-reveal key, so the audit log returns real actor/target
    /// emails (the email-visibility gate masks OTHER users' emails to null without the X-Email-Reveal-Key
    /// header). The default key is "Starbucks" (appsettings.json); the test host runs with SkipLocalSettings
    /// and no override. Used by the audit assertions that match on a non-caller user's targetEmail.
    /// </summary>
    private async Task<JsonElement> ReadAuditRevealed(HttpClient admin)
    {
        var req = new HttpRequestMessage(HttpMethod.Get, "/api/audit");
        req.Headers.Add("X-Email-Reveal-Key", "Starbucks");
        return await (await admin.SendAsync(req)).Content.ReadFromJsonAsync<JsonElement>();
    }

    [Fact]
    public async Task Force_logout_bumps_session_version_and_writes_an_audit_entry()
    {
        var admin = Client(WebAppFactory.AdminEmail);
        var (id, email) = await CreateUser();

        var res = await admin.PostAsync($"/api/users/{id}/logout", null);
        res.StatusCode.Should().Be(HttpStatusCode.OK);
        (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("ok").GetBoolean().Should().BeTrue();

        // SessionVersion incremented in the DB.
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
            (await db.Users.FirstAsync(u => u.Id == id)).SessionVersion.Should().Be(1);
        }

        // Audit entry written with actor + target. Read WITH the reveal key so the target email is unmasked.
        var audit = await ReadAuditRevealed(admin);
        audit.EnumerateArray().ToList().Should().Contain(e =>
            e.GetProperty("action").GetString() == "user.forcedlogout" &&
            e.GetProperty("targetEmail").GetString() == email &&
            e.GetProperty("actorEmail").GetString() == WebAppFactory.AdminEmail);
    }

    [Fact]
    public async Task Stale_session_token_is_rejected_while_a_freshly_stamped_one_is_accepted()
    {
        var admin = Client(WebAppFactory.AdminEmail);
        var (id, email) = await CreateUser();

        // A token stamped sv=0 works while SessionVersion is still 0.
        (await ClientWithSv(email, 0).GetAsync(Summary)).StatusCode.Should().Be(HttpStatusCode.OK);

        // Admin force-logs the user out (SessionVersion -> 1).
        (await admin.PostAsync($"/api/users/{id}/logout", null)).StatusCode.Should().Be(HttpStatusCode.OK);

        // The old sv=0 token is now stale -> 401 (not 403; the auth pipeline fails the token).
        (await ClientWithSv(email, 0).GetAsync(Summary)).StatusCode.Should().Be(HttpStatusCode.Unauthorized);

        // A freshly minted token carrying the new stamp (sv=1), as a re-login would, is accepted again.
        (await ClientWithSv(email, 1).GetAsync(Summary)).StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Token_with_no_sv_claim_is_accepted_while_session_version_is_zero()
    {
        // Pre-existing tokens minted before the "sv" claim existed (sv omitted) must keep working as
        // long as the user's SessionVersion is still its default 0 — no mass-logout on deploy.
        var (_, email) = await CreateUser();
        (await ClientWithSv(email, null).GetAsync(Summary)).StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Token_with_no_sv_claim_is_rejected_after_a_force_logout()
    {
        // ...but once SessionVersion has been bumped, a missing-sv (==0) token is stale too.
        var admin = Client(WebAppFactory.AdminEmail);
        var (id, email) = await CreateUser();
        (await ClientWithSv(email, null).GetAsync(Summary)).StatusCode.Should().Be(HttpStatusCode.OK);

        (await admin.PostAsync($"/api/users/{id}/logout", null)).StatusCode.Should().Be(HttpStatusCode.OK);

        (await ClientWithSv(email, null).GetAsync(Summary)).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Force_logout_requires_users_manage()
    {
        var (id, _) = await CreateUser();

        var viewer = $"viewer-fl-{Guid.NewGuid():N}@test.local";
        await Client(WebAppFactory.AdminEmail).PostAsJsonAsync("/api/users",
            new { email = viewer, isEnabled = true, permissions = new[] { "users.view" } });

        (await Client(viewer).PostAsync($"/api/users/{id}/logout", null)).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await Client().PostAsync($"/api/users/{id}/logout", null)).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Force_logout_on_an_unknown_user_is_404()
        => (await Client(WebAppFactory.AdminEmail).PostAsync("/api/users/999999/logout", null))
            .StatusCode.Should().Be(HttpStatusCode.NotFound);

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

        var audit = await ReadAuditRevealed(admin);
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

    /// <summary>Sets the global access policy (open sign-up + default permissions) as the admin.</summary>
    private async Task SetAccessPolicy(bool openSignup, params string[] defaults)
    {
        var res = await Client(WebAppFactory.AdminEmail).PutAsJsonAsync("/api/access-policy",
            new { openSignupEnabled = openSignup, defaultPermissions = defaults });
        res.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Google_login_for_an_unprovisioned_email_is_forbidden_when_open_signup_is_off()
    {
        await SetAccessPolicy(openSignup: false, "dashboard.view");
        try
        {
            (await GoogleLogin($"ghost-{Guid.NewGuid():N}@test.local|sub-x"))
                .StatusCode.Should().Be(HttpStatusCode.Forbidden);
        }
        finally
        {
            await SetAccessPolicy(openSignup: true, "dashboard.view"); // restore default
        }
    }

    [Fact]
    public async Task Open_signup_auto_provisions_an_unknown_account_with_default_permissions()
    {
        await SetAccessPolicy(openSignup: true, "dashboard.view", "calendar.view");
        try
        {
            var sub = $"sub-{Guid.NewGuid():N}";
            var email = $"newbie-{Guid.NewGuid():N}@test.local";

            // First Google login creates the account and issues a token with the default perms.
            var res = await GoogleLogin($"{email}|{sub}");
            res.StatusCode.Should().Be(HttpStatusCode.OK);
            var auth = await res.Content.ReadFromJsonAsync<JsonElement>();
            var perms = auth.GetProperty("permissions").EnumerateArray().Select(e => e.GetString()).ToList();
            perms.Should().BeEquivalentTo(new[] { "dashboard.view", "calendar.view" });

            // The new user can now reach an endpoint they were granted, and is denied one they weren't.
            var newbie = Client(email);
            (await newbie.GetAsync("/api/usage/calendar")).StatusCode.Should().Be(HttpStatusCode.OK);
            (await newbie.GetAsync("/api/users")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        }
        finally
        {
            await SetAccessPolicy(openSignup: true, "dashboard.view"); // restore default
        }
    }

    [Fact]
    public async Task Empty_default_permissions_provisions_a_zero_permission_user()
    {
        await SetAccessPolicy(openSignup: true); // no defaults -> approval-queue mode
        try
        {
            var email = $"approval-{Guid.NewGuid():N}@test.local";
            var res = await GoogleLogin($"{email}|sub-{Guid.NewGuid():N}");
            res.StatusCode.Should().Be(HttpStatusCode.OK);
            var auth = await res.Content.ReadFromJsonAsync<JsonElement>();
            auth.GetProperty("permissions").GetArrayLength().Should().Be(0);

            // Authenticated but has no access to any gated endpoint.
            (await Client(email).GetAsync(Summary)).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        }
        finally
        {
            await SetAccessPolicy(openSignup: true, "dashboard.view");
        }
    }

    [Fact]
    public async Task Auto_provisioned_account_is_pinned_to_its_google_subject()
    {
        await SetAccessPolicy(openSignup: true, "dashboard.view");
        try
        {
            var email = $"pin-{Guid.NewGuid():N}@test.local";
            var subA = $"sub-{Guid.NewGuid():N}";
            var subB = $"sub-{Guid.NewGuid():N}";

            // First login auto-provisions and binds subA.
            (await GoogleLogin($"{email}|{subA}")).StatusCode.Should().Be(HttpStatusCode.OK);
            // Same subject logs in fine.
            (await GoogleLogin($"{email}|{subA}")).StatusCode.Should().Be(HttpStatusCode.OK);
            // A different Google account for the same (now-bound) email is rejected.
            (await GoogleLogin($"{email}|{subB}")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        }
        finally
        {
            await SetAccessPolicy(openSignup: true, "dashboard.view");
        }
    }

    [Fact]
    public async Task Auto_provisioned_account_is_audited()
    {
        await SetAccessPolicy(openSignup: true, "dashboard.view");
        try
        {
            var admin = Client(WebAppFactory.AdminEmail);
            var email = $"autoaudit-{Guid.NewGuid():N}@test.local";
            (await GoogleLogin($"{email}|sub-{Guid.NewGuid():N}")).StatusCode.Should().Be(HttpStatusCode.OK);

            var audit = await ReadAuditRevealed(admin);
            audit.EnumerateArray().ToList().Should().Contain(e =>
                e.GetProperty("action").GetString() == "user.autoprovisioned" &&
                e.GetProperty("targetEmail").GetString() == email);
        }
        finally
        {
            await SetAccessPolicy(openSignup: true, "dashboard.view");
        }
    }

    [Fact]
    public async Task Access_policy_get_is_gated_and_put_requires_users_manage()
    {
        var admin = Client(WebAppFactory.AdminEmail);
        (await admin.GetAsync("/api/access-policy")).StatusCode.Should().Be(HttpStatusCode.OK);

        var viewer = $"viewer-policy-{Guid.NewGuid():N}@test.local";
        await admin.PostAsJsonAsync("/api/users",
            new { email = viewer, isEnabled = true, permissions = new[] { "dashboard.view" } });

        // A non-admin viewer cannot read or change the policy.
        (await Client(viewer).GetAsync("/api/access-policy")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await Client(viewer).PutAsJsonAsync("/api/access-policy",
            new { openSignupEnabled = true, defaultPermissions = new[] { "dashboard.view" } }))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await Client().GetAsync("/api/access-policy")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Access_policy_put_filters_out_invalid_permission_keys()
    {
        var admin = Client(WebAppFactory.AdminEmail);
        try
        {
            var res = await admin.PutAsJsonAsync("/api/access-policy",
                new { openSignupEnabled = true, defaultPermissions = new[] { "dashboard.view", "not.a.real.perm", "DASHBOARD.VIEW" } });
            res.StatusCode.Should().Be(HttpStatusCode.OK);
            var dto = await res.Content.ReadFromJsonAsync<JsonElement>();
            dto.GetProperty("defaultPermissions").EnumerateArray().Select(e => e.GetString())
                .Should().BeEquivalentTo(new[] { "dashboard.view" });
        }
        finally
        {
            await SetAccessPolicy(openSignup: true, "dashboard.view");
        }
    }

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
    public async Task Unprovisioned_google_login_is_not_audited_when_open_signup_is_off()
    {
        // With open sign-up off, an unprovisioned attempt is denied — but reachable by ANY Google
        // account, so it must NOT create an auth.denied row (which would let outsiders flood the log).
        var admin = Client(WebAppFactory.AdminEmail);
        await SetAccessPolicy(openSignup: false, "dashboard.view");
        try
        {
            var email = $"ghost-audit-{Guid.NewGuid():N}@test.local";
            (await GoogleLogin($"{email}|sub-x")).StatusCode.Should().Be(HttpStatusCode.Forbidden);

            var audit = await (await admin.GetAsync("/api/audit")).Content.ReadFromJsonAsync<JsonElement>();
            audit.EnumerateArray().ToList().Should().NotContain(e =>
                e.GetProperty("action").GetString() == "auth.denied" &&
                e.GetProperty("targetEmail").GetString() == email);
        }
        finally
        {
            await SetAccessPolicy(openSignup: true, "dashboard.view");
        }
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

        var audit = await ReadAuditRevealed(admin);
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
