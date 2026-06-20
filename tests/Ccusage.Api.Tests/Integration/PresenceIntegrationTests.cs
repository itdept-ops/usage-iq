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
public class PresenceIntegrationTests(WebAppFactory factory)
{
    private HttpClient Client(string? email = null)
    {
        var c = factory.CreateClient();
        if (email is not null)
            c.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", TestJwt.For(email));
        return c;
    }

    /// <summary>Creates a user (so its online email resolves to a real AppUser id) and returns (id, email).</summary>
    private async Task<(int Id, string Email)> CreateUser()
    {
        var email = $"pr-{Guid.NewGuid():N}@test.local";
        var created = await Client(WebAppFactory.AdminEmail).PostAsJsonAsync("/api/users",
            new { email, name = "Presence Tester", isEnabled = true, permissions = new[] { "dashboard.view" } });
        created.StatusCode.Should().Be(HttpStatusCode.Created);
        var id = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetInt32();
        return (id, email);
    }

    [Fact]
    public async Task Presence_requires_authentication()
        => (await Client().GetAsync("/api/presence")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);

    [Fact]
    public async Task Authenticated_caller_shows_up_as_online()
    {
        var c = Client(WebAppFactory.AdminEmail);

        // The presence middleware runs on this very (authenticated) request, so the caller is
        // recorded before the endpoint reads the tracker — they appear in their own presence list.
        var res = await c.GetAsync("/api/presence");
        res.StatusCode.Should().Be(HttpStatusCode.OK);

        var list = await res.Content.ReadFromJsonAsync<JsonElement>();
        // The caller's own row is flagged IsSelf — and identifies via name/userId, never an email.
        var me = list.EnumerateArray().FirstOrDefault(e =>
            e.TryGetProperty("isSelf", out var s) && s.GetBoolean());
        me.ValueKind.Should().NotBe(JsonValueKind.Undefined);
        me.TryGetProperty("lastSeenUtc", out _).Should().BeTrue();   // camelCase via Web JSON defaults
        me.TryGetProperty("name", out _).Should().BeTrue();
        me.TryGetProperty("userId", out _).Should().BeTrue();
    }

    [Fact]
    public async Task Presence_response_carries_no_email()
    {
        // Email-privacy: the presence payload must never leak any address — no "email" field, no "@".
        // Give the admin a real display Name so the resolved name isn't the email-shaped fallback (the
        // TestJwt "name" claim is the email). In production Name comes from Google, so this mirrors reality.
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
            var admin = await db.Users.FirstAsync(u => u.Email == WebAppFactory.AdminEmail);
            admin.Name = "Admin Person";
            await db.SaveChangesAsync();
        }

        var c = Client(WebAppFactory.AdminEmail);
        var res = await c.GetAsync("/api/presence");
        res.StatusCode.Should().Be(HttpStatusCode.OK);

        var raw = await res.Content.ReadAsStringAsync();
        raw.Should().NotContain("@");
        raw.Should().NotContain("email");

        var list = await JsonDocument.ParseAsync(await res.Content.ReadAsStreamAsync());
        foreach (var row in list.RootElement.EnumerateArray())
        {
            row.TryGetProperty("email", out _).Should().BeFalse();
            row.TryGetProperty("userId", out _).Should().BeTrue();
            row.TryGetProperty("name", out _).Should().BeTrue();
            row.TryGetProperty("isSelf", out _).Should().BeTrue();
        }
    }

    [Fact]
    public async Task Online_row_resolves_to_the_matching_user_id()
    {
        var (id, email) = await CreateUser();

        // The user makes a request (the presence middleware marks them online), then the admin reads presence.
        (await Client(email).GetAsync("/api/auth/me")).EnsureSuccessStatusCode();

        var list = await (await Client(WebAppFactory.AdminEmail).GetAsync("/api/presence"))
            .Content.ReadFromJsonAsync<JsonElement>();

        list.EnumerateArray().Should().Contain(e =>
            e.GetProperty("userId").ValueKind == JsonValueKind.Number && e.GetProperty("userId").GetInt32() == id);
    }

    [Fact]
    public async Task Offline_removes_the_caller_from_presence()
    {
        var (_, email) = await CreateUser();
        var c = Client(email);

        // Become online, confirm present.
        (await c.GetAsync("/api/auth/me")).EnsureSuccessStatusCode();
        (await PresenceHasUser(email)).Should().BeTrue();

        // Sign-out hook removes the caller.
        var offline = await c.PostAsync("/api/presence/offline", null);
        offline.StatusCode.Should().Be(HttpStatusCode.NoContent);

        // The admin's subsequent read no longer lists that user.
        (await PresenceHasUser(email)).Should().BeFalse();
    }

    [Fact]
    public async Task Force_logout_removes_the_target_from_presence()
    {
        var (id, email) = await CreateUser();

        // The target is online (made a request), then an admin force-logs them out.
        (await Client(email).GetAsync("/api/auth/me")).EnsureSuccessStatusCode();
        (await PresenceHasUser(email)).Should().BeTrue();

        (await Client(WebAppFactory.AdminEmail).PostAsync($"/api/users/{id}/logout", null))
            .StatusCode.Should().Be(HttpStatusCode.OK);

        (await PresenceHasUser(email)).Should().BeFalse();
    }

    /// <summary>Reads presence as the admin and resolves whether <paramref name="email"/> is online by
    /// matching its server-resolved AppUser id (the response carries no email).</summary>
    private async Task<bool> PresenceHasUser(string email)
    {
        int userId;
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
            userId = (await db.Users.AsNoTracking().FirstAsync(u => u.Email == email)).Id;
        }

        var list = await (await Client(WebAppFactory.AdminEmail).GetAsync("/api/presence"))
            .Content.ReadFromJsonAsync<JsonElement>();
        return list.EnumerateArray().Any(e =>
            e.GetProperty("userId").ValueKind == JsonValueKind.Number && e.GetProperty("userId").GetInt32() == userId);
    }
}
