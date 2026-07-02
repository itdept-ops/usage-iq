using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using FluentAssertions;

namespace Ccusage.Api.Tests.Integration;

/// <summary>
/// The server-side email-visibility gate: GET /api/users and GET /api/audit mask OTHER users' emails
/// to null unless the acting user holds the "users.email.reveal" permission. The caller's OWN email
/// always comes back real (so they can see themselves). The seeded admin is granted every permission
/// (Permissions.All), so admin-provisioning clients reveal automatically.
/// </summary>
[Collection(IntegrationCollection.Name)]
public class EmailVisibilityIntegrationTests(WebAppFactory factory)
{
    private const string EmailReveal = "users.email.reveal";

    private HttpClient Client(string email)
    {
        var c = factory.CreateClient();
        c.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", TestJwt.For(email));
        return c;
    }

    private HttpClient Admin() => Client(WebAppFactory.AdminEmail);

    /// <summary>Provisions an enabled user with the given permissions and returns their email.</summary>
    private async Task<string> CreateUser(params string[] permissions)
    {
        var email = $"evis-{Guid.NewGuid():N}@test.local";
        var res = await Admin().PostAsJsonAsync("/api/users",
            new { email, isEnabled = true, permissions = permissions.Length == 0 ? new[] { "dashboard.view" } : permissions });
        res.StatusCode.Should().Be(HttpStatusCode.Created);
        return email;
    }

    private static List<JsonElement> Rows(JsonElement arr) => arr.EnumerateArray().ToList();

    private static string? EmailOf(JsonElement row)
    {
        var p = row.GetProperty("email");
        return p.ValueKind == JsonValueKind.Null ? null : p.GetString();
    }

    // ---- GET /api/users ----

    [Fact]
    public async Task Users_without_reveal_permission_masks_other_emails_but_keeps_callers_own_real()
    {
        // A users.view caller who is NOT an admin and lacks users.email.reveal; plus another user that must be masked.
        var me = await CreateUser("users.view");
        await CreateUser("dashboard.view");

        var res = await Client(me).GetAsync("/api/users");
        res.StatusCode.Should().Be(HttpStatusCode.OK);
        var rows = Rows(await res.Content.ReadFromJsonAsync<JsonElement>());

        // Exactly one row has a non-null email — the caller's own — and it's their real address.
        var unmasked = rows.Where(r => EmailOf(r) != null).ToList();
        unmasked.Should().ContainSingle();
        EmailOf(unmasked[0]).Should().Be(me);

        // There ARE other rows, and they're all masked to null.
        rows.Where(r => EmailOf(r) == null).Should().NotBeEmpty();
    }

    [Fact]
    public async Task Users_with_reveal_permission_returns_all_real_emails()
    {
        var me = await CreateUser("users.view", EmailReveal);
        var other = await CreateUser();

        var res = await Client(me).GetAsync("/api/users");
        res.StatusCode.Should().Be(HttpStatusCode.OK);
        var rows = Rows(await res.Content.ReadFromJsonAsync<JsonElement>());

        // No row is masked, and the two known emails are present and real.
        rows.Should().OnlyContain(r => EmailOf(r) != null);
        var emails = rows.Select(EmailOf).ToList();
        emails.Should().Contain(me);
        emails.Should().Contain(other);
    }

    // ---- GET /api/audit ----

    [Fact]
    public async Task Audit_without_reveal_permission_masks_other_actor_and_target_emails()
    {
        // The admin creates a target user — that writes a "user.created" audit row with the admin as actor
        // and the target user as target. A reader WITHOUT users.email.reveal reads the audit log. Neither the
        // admin (actor) nor the created target should leak. The ONLY email the reader may see is their OWN
        // (e.g. they are the target on their own user.created row), per the caller-sees-self rule.
        var target = await CreateUser();
        var reader = await CreateUser("users.manage");

        var res = await Client(reader).GetAsync("/api/audit");
        res.StatusCode.Should().Be(HttpStatusCode.OK);
        var rows = Rows(await res.Content.ReadFromJsonAsync<JsonElement>());

        // The admin and the target user must NEVER appear (they are not the reader).
        rows.Should().NotContain(r => string.Equals(ActorEmail(r), WebAppFactory.AdminEmail, StringComparison.OrdinalIgnoreCase));
        rows.Should().NotContain(r => string.Equals(TargetEmail(r), target, StringComparison.OrdinalIgnoreCase));

        // Any unmasked actor/target email is the reader's own (caller always sees themselves).
        foreach (var r in rows)
        {
            var a = ActorEmail(r);
            if (a is not null) a.Should().BeEquivalentTo(reader);
            var t = TargetEmail(r);
            if (t is not null) t.Should().BeEquivalentTo(reader);
        }
    }

    [Fact]
    public async Task Audit_keeps_readers_own_actor_email_real_without_reveal_permission()
    {
        // This user performs an action so they are the ACTOR on a fresh row, then reads the log without the
        // reveal permission: their own actor email stays real.
        var reader = await CreateUser("users.manage");
        // The reader acts: create a user via the reader's client, stamping reader as actor.
        var victim = $"evis-act-{Guid.NewGuid():N}@test.local";
        (await Client(reader).PostAsJsonAsync("/api/users",
            new { email = victim, isEnabled = true, permissions = new[] { "dashboard.view" } }))
            .StatusCode.Should().Be(HttpStatusCode.Created);

        var res = await Client(reader).GetAsync("/api/audit");
        var rows = Rows(await res.Content.ReadFromJsonAsync<JsonElement>());

        rows.Should().Contain(r => string.Equals(ActorEmail(r), reader, StringComparison.OrdinalIgnoreCase),
            "the reader's own actor email is never masked");
    }

    [Fact]
    public async Task Audit_with_reveal_permission_returns_all_real_actor_and_target_emails()
    {
        var target = await CreateUser();
        var reader = await CreateUser("users.manage", EmailReveal);

        var res = await Client(reader).GetAsync("/api/audit");
        res.StatusCode.Should().Be(HttpStatusCode.OK);
        var rows = Rows(await res.Content.ReadFromJsonAsync<JsonElement>());

        // Every actor email is real (non-null) with the reveal permission.
        rows.Should().OnlyContain(r => ActorEmail(r) != null);
        // The target user we just created shows up with its real email on its user.created row.
        rows.Should().Contain(r => string.Equals(TargetEmail(r), target, StringComparison.OrdinalIgnoreCase));
    }

    private static string? ActorEmail(JsonElement row)
    {
        var p = row.GetProperty("actorEmail");
        return p.ValueKind == JsonValueKind.Null ? null : p.GetString();
    }

    private static string? TargetEmail(JsonElement row)
    {
        if (!row.TryGetProperty("targetEmail", out var p) || p.ValueKind == JsonValueKind.Null) return null;
        return p.GetString();
    }
}
