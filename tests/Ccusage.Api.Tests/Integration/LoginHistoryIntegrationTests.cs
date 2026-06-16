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
/// Per-user login history: the structured LoginEvent rows written best-effort by GoogleAuthService,
/// and the GET /api/users/{id}/logins endpoint that surfaces them on the Users page.
/// </summary>
[Collection(IntegrationCollection.Name)]
public class LoginHistoryIntegrationTests(WebAppFactory factory)
{
    private HttpClient Client(string? email = null)
    {
        var c = factory.CreateClient();
        if (email is not null)
            c.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", TestJwt.For(email));
        return c;
    }

    private Task<HttpResponseMessage> GoogleLogin(string idToken)
        => factory.CreateClient().PostAsJsonAsync("/api/auth/google", new { idToken });

    private async Task<int> CreateUser(string email, bool enabled = true)
    {
        var res = await Client(WebAppFactory.AdminEmail).PostAsJsonAsync("/api/users",
            new { email, isEnabled = enabled, permissions = new[] { "dashboard.view" } });
        res.StatusCode.Should().Be(HttpStatusCode.Created);
        return (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetInt32();
    }

    private async Task<List<LoginEvent>> EventsFor(string email)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        return await db.LoginEvents.AsNoTracking().Where(e => e.Email == email)
            .OrderByDescending(e => e.WhenUtc).ThenByDescending(e => e.Id).ToListAsync();
    }

    [Fact]
    public async Task Successful_login_writes_an_ok_event_with_ip_and_userid()
    {
        var email = $"hist-ok-{Guid.NewGuid():N}@test.local";
        var id = await CreateUser(email);

        (await GoogleLogin($"{email}|sub-{Guid.NewGuid():N}")).StatusCode.Should().Be(HttpStatusCode.OK);

        var events = await EventsFor(email);
        events.Should().ContainSingle();
        var ev = events[0];
        ev.Success.Should().BeTrue();
        ev.Reason.Should().Be("ok");
        ev.UserId.Should().Be(id);
        ev.Ip.Should().Be(WebAppFactory.TestClientIp);
        ev.Name.Should().Be("Test User");
    }

    [Fact]
    public async Task Disabled_user_login_writes_a_failed_account_disabled_event()
    {
        var email = $"hist-disabled-{Guid.NewGuid():N}@test.local";
        var id = await CreateUser(email);
        await Client(WebAppFactory.AdminEmail).PutAsJsonAsync($"/api/users/{id}",
            new { isEnabled = false, permissions = new[] { "dashboard.view" } });

        (await GoogleLogin($"{email}|sub-{Guid.NewGuid():N}")).StatusCode.Should().Be(HttpStatusCode.Forbidden);

        var events = await EventsFor(email);
        events.Should().ContainSingle();
        events[0].Success.Should().BeFalse();
        events[0].Reason.Should().Be("account disabled");
        events[0].UserId.Should().Be(id);
    }

    [Fact]
    public async Task Endpoint_returns_a_users_events_newest_first()
    {
        var email = $"hist-list-{Guid.NewGuid():N}@test.local";
        var id = await CreateUser(email);

        // Three logins: ok, ok, then a subject mismatch (denied) — all reach the user row.
        var sub = $"sub-{Guid.NewGuid():N}";
        (await GoogleLogin($"{email}|{sub}")).StatusCode.Should().Be(HttpStatusCode.OK);
        (await GoogleLogin($"{email}|{sub}")).StatusCode.Should().Be(HttpStatusCode.OK);
        (await GoogleLogin($"{email}|other-{Guid.NewGuid():N}")).StatusCode.Should().Be(HttpStatusCode.Forbidden);

        var res = await Client(WebAppFactory.AdminEmail).GetAsync($"/api/users/{id}/logins");
        res.StatusCode.Should().Be(HttpStatusCode.OK);
        var arr = await res.Content.ReadFromJsonAsync<JsonElement>();
        arr.GetArrayLength().Should().Be(3);

        // Newest first: the most recent event is the denied mismatch.
        arr[0].GetProperty("success").GetBoolean().Should().BeFalse();
        arr[0].GetProperty("reason").GetString().Should().Be("google id mismatch");

        var times = arr.EnumerateArray().Select(e => e.GetProperty("whenUtc").GetDateTime()).ToList();
        times.Should().BeInDescendingOrder();

        // Each carries the server-observed IP.
        arr[0].GetProperty("ip").GetString().Should().Be(WebAppFactory.TestClientIp);
    }

    [Fact]
    public async Task Endpoint_returns_404_for_an_unknown_user()
        => (await Client(WebAppFactory.AdminEmail).GetAsync("/api/users/2147483600/logins"))
            .StatusCode.Should().Be(HttpStatusCode.NotFound);

    [Fact]
    public async Task Endpoint_is_gated_by_users_view_or_users_manage()
    {
        var email = $"hist-gate-{Guid.NewGuid():N}@test.local";
        var id = await CreateUser(email);

        // No auth at all.
        (await Client().GetAsync($"/api/users/{id}/logins")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);

        // A dashboard-only viewer (no users.view / users.manage) is forbidden.
        var viewerEmail = $"hist-viewer-{Guid.NewGuid():N}@test.local";
        await CreateUser(viewerEmail);
        (await Client(viewerEmail).GetAsync($"/api/users/{id}/logins")).StatusCode.Should().Be(HttpStatusCode.Forbidden);

        // users.view is sufficient.
        var roEmail = $"hist-ro-{Guid.NewGuid():N}@test.local";
        await Client(WebAppFactory.AdminEmail).PostAsJsonAsync("/api/users",
            new { email = roEmail, isEnabled = true, permissions = new[] { "users.view" } });
        (await Client(roEmail).GetAsync($"/api/users/{id}/logins")).StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task A_logging_failure_does_not_fail_the_sign_in()
    {
        var email = $"hist-bestfx-{Guid.NewGuid():N}@test.local";
        await CreateUser(email);

        // Force the LoginEvent insert to fail by hiding its table; the sign-in must still succeed
        // (RecordLoginAsync is best-effort). Restore the table afterward. The integration collection
        // runs serially, so renaming the table for the duration of this test is safe.
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
            await db.Database.ExecuteSqlRawAsync("ALTER TABLE \"LoginEvents\" RENAME TO \"LoginEvents_hidden\";");
        }
        try
        {
            (await GoogleLogin($"{email}|sub-{Guid.NewGuid():N}")).StatusCode.Should().Be(HttpStatusCode.OK);
        }
        finally
        {
            using var scope = factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
            await db.Database.ExecuteSqlRawAsync("ALTER TABLE \"LoginEvents_hidden\" RENAME TO \"LoginEvents\";");
        }
    }
}
