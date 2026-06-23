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
/// Peer nudges (<c>POST /api/nudge</c>): a circle-gated, cooldowned, opt-out-respecting canned ping that
/// lands as ONE in-app notification. Covers the strict abuse/privacy model:
/// <list type="bullet">
///   <item>Nudging a CONTACT succeeds and creates EXACTLY ONE notification, named by DisplayName (no email).</item>
///   <item>Nudging a fellow HOUSEHOLD member succeeds (the other circle source).</item>
///   <item>Nudging a STRANGER or YOURSELF is 404 (existence never leaked) — and creates no notification.</item>
///   <item>The per-(sender, target) COOLDOWN turns a rapid second nudge into a no-op — NO duplicate notification.</item>
///   <item>An opted-OUT target receives nothing (a friendly 200 no-op) and no audit/cooldown row is written.</item>
///   <item>The kind is validated server-side: an unknown / free-text / injection-shaped kind is 400.</item>
///   <item>chat.send is required.</item>
/// </list>
/// Every test provisions fresh users so they're order-independent.
/// </summary>
[Collection(IntegrationCollection.Name)]
public class NudgeIntegrationTests(WebAppFactory factory)
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

    private async Task<(string email, HttpClient client, int id)> ProvisionUser(string name, params string[] permissions)
    {
        var email = $"nudge-{Guid.NewGuid():N}@test.local";
        var res = await Admin().PostAsJsonAsync("/api/users", new { email, name, isEnabled = true, permissions });
        res.StatusCode.Should().Be(HttpStatusCode.Created);
        var id = (await Json(res)).GetProperty("id").GetInt32();
        return (email, Client(email), id);
    }

    private static async Task<JsonElement> Json(HttpResponseMessage resp) =>
        await resp.Content.ReadFromJsonAsync<JsonElement>();

    private async Task MakeContacts(int aId, int bId) =>
        (await Admin().PostAsJsonAsync($"/api/chat/contacts/user/{aId}", new { contactUserId = bId }))
            .StatusCode.Should().Be(HttpStatusCode.OK);

    private async Task<List<Notification>> NudgeNotificationsFor(string email)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        return await db.Notifications.AsNoTracking()
            .Where(n => n.RecipientEmail == email && n.Type == NotificationType.SystemNudge)
            .ToListAsync();
    }

    private async Task<int> NudgeEventCount(string senderEmail, string targetEmail)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        return await db.NudgeEvents.AsNoTracking()
            .CountAsync(n => n.SenderEmail == senderEmail.ToLowerInvariant()
                          && n.TargetEmail == targetEmail.ToLowerInvariant());
    }

    private async Task SetName(string email, string name, DisplayNameMode mode)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        var u = await db.Users.FirstAsync(x => x.Email == email);
        u.Name = name;
        u.DisplayNameMode = mode;
        await db.SaveChangesAsync();
    }

    // ---- Happy paths ----

    [Fact]
    public async Task Nudging_a_contact_succeeds_and_creates_exactly_one_notification_using_DisplayName()
    {
        var (senderEmail, sender, senderId) = await ProvisionUser("Sam Rivers", "chat.send");
        var (targetEmail, _, targetId) = await ProvisionUser("Tara Target", "chat.read");
        await MakeContacts(senderId, targetId);
        await SetName(senderEmail, "Sam Rivers", DisplayNameMode.FirstName);

        var res = await sender.PostAsJsonAsync("/api/nudge", new { targetUserId = targetId, kind = "logYourDay" });
        res.StatusCode.Should().Be(HttpStatusCode.OK);
        (await Json(res)).GetProperty("delivered").GetBoolean().Should().BeTrue();

        var notes = await NudgeNotificationsFor(targetEmail);
        notes.Should().ContainSingle("exactly one nudge notification");
        var note = notes[0];
        note.Text.Should().Be("Sam nudged you to log your day");   // DisplayName (FirstName) + fixed template
        note.Text.Should().NotContain("@");                          // never an email
        note.Text.Should().NotContain(senderEmail);
        note.ActorName.Should().Be("Sam");
        note.ActorEmail.Should().Be(senderEmail);                    // server-side key only; never serialized
        note.Link.Should().Be("/challenge");

        // An audit/cooldown row was written.
        (await NudgeEventCount(senderEmail, targetEmail)).Should().Be(1);
    }

    [Fact]
    public async Task Nudging_a_household_member_succeeds()
    {
        // Owner + a second adult in the same household. (Adding an adult auto-bridges a contact edge too,
        // but the household membership alone is sufficient for the circle gate.)
        var (_, owner, ownerId) = await ProvisionUser("Olive Owner", "chat.send", "family.use", "chat.contacts.manage");
        var (targetEmail, _, memberId) = await ProvisionUser("Mona Member", "family.use", "chat.read");

        (await owner.GetAsync("/api/family/household")).EnsureSuccessStatusCode();
        (await owner.PostAsJsonAsync("/api/family/household/members", new { userId = memberId, role = "adult" }))
            .StatusCode.Should().Be(HttpStatusCode.OK);

        var res = await owner.PostAsJsonAsync("/api/nudge", new { targetUserId = memberId, kind = "checkIn" });
        res.StatusCode.Should().Be(HttpStatusCode.OK);
        (await Json(res)).GetProperty("delivered").GetBoolean().Should().BeTrue();

        (await NudgeNotificationsFor(targetEmail)).Should().ContainSingle();
    }

    // ---- Rejections: stranger / self ----

    [Fact]
    public async Task Nudging_a_stranger_is_404_and_creates_no_notification()
    {
        var (_, sender, _) = await ProvisionUser("Stan Sender", "chat.send");
        var (strangerEmail, _, strangerId) = await ProvisionUser("Stranger Danger", "chat.read");
        // No contact edge, no shared household.

        var res = await sender.PostAsJsonAsync("/api/nudge", new { targetUserId = strangerId, kind = "logYourDay" });
        res.StatusCode.Should().Be(HttpStatusCode.NotFound, "a non-circle target's existence is never leaked");

        (await NudgeNotificationsFor(strangerEmail)).Should().BeEmpty();
    }

    [Fact]
    public async Task Nudging_yourself_is_404_and_creates_no_notification()
    {
        var (selfEmail, me, myId) = await ProvisionUser("Solo Self", "chat.send");

        var res = await me.PostAsJsonAsync("/api/nudge", new { targetUserId = myId, kind = "logYourDay" });
        res.StatusCode.Should().Be(HttpStatusCode.NotFound);

        (await NudgeNotificationsFor(selfEmail)).Should().BeEmpty();
    }

    [Fact]
    public async Task Nudging_an_unknown_user_id_is_404()
    {
        var (_, sender, _) = await ProvisionUser("Una Sender", "chat.send");
        (await sender.PostAsJsonAsync("/api/nudge", new { targetUserId = 999999999, kind = "logYourDay" }))
            .StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    // ---- Cooldown ----

    [Fact]
    public async Task Cooldown_blocks_a_rapid_second_nudge_with_no_duplicate_notification()
    {
        var (_, sender, senderId) = await ProvisionUser("Carl Sender", "chat.send");
        var (targetEmail, _, targetId) = await ProvisionUser("Cleo Target", "chat.read");
        await MakeContacts(senderId, targetId);

        var first = await sender.PostAsJsonAsync("/api/nudge", new { targetUserId = targetId, kind = "closeYourRings" });
        (await Json(first)).GetProperty("delivered").GetBoolean().Should().BeTrue();

        // An immediate second nudge is inside the cooldown window → friendly no-op, NOT a second notification.
        var second = await sender.PostAsJsonAsync("/api/nudge", new { targetUserId = targetId, kind = "closeYourRings" });
        second.StatusCode.Should().Be(HttpStatusCode.OK);
        (await Json(second)).GetProperty("delivered").GetBoolean().Should().BeFalse();

        (await NudgeNotificationsFor(targetEmail)).Should().ContainSingle("the cooldown prevents a duplicate");
    }

    // ---- Opt-out ----

    [Fact]
    public async Task Opted_out_target_receives_nothing_and_no_audit_row_is_written()
    {
        var (senderEmail, sender, senderId) = await ProvisionUser("Otto Sender", "chat.send");
        var (targetEmail, target, targetId) = await ProvisionUser("Oona OptOut", "chat.read");
        await MakeContacts(senderId, targetId);

        // The target opts out via their own profile path.
        (await target.PatchAsJsonAsync("/api/auth/profile", new { nudgesOptOut = true }))
            .EnsureSuccessStatusCode();

        var res = await sender.PostAsJsonAsync("/api/nudge", new { targetUserId = targetId, kind = "logYourDay" });
        res.StatusCode.Should().Be(HttpStatusCode.OK, "opt-out is a friendly no-op, not a distinguishing error");
        (await Json(res)).GetProperty("delivered").GetBoolean().Should().BeFalse();

        (await NudgeNotificationsFor(targetEmail)).Should().BeEmpty();
        // No cooldown/audit row, so a later nudge (after they opt back in) is not blocked.
        (await NudgeEventCount(senderEmail, targetEmail)).Should().Be(0);
    }

    // ---- Kind validation (no free-text / injection) ----

    [Theory]
    [InlineData("")]
    [InlineData("not-a-kind")]
    [InlineData("logYourDay; DROP TABLE Users")]
    [InlineData("@everyone check this out")]
    [InlineData("LogYourDay")]     // wrong casing is not an accepted wire value
    public async Task An_unknown_or_freetext_kind_is_400(string kind)
    {
        var (_, sender, senderId) = await ProvisionUser("Kim Sender", "chat.send");
        var (_, _, targetId) = await ProvisionUser("Ken Target", "chat.read");
        await MakeContacts(senderId, targetId);

        (await sender.PostAsJsonAsync("/api/nudge", new { targetUserId = targetId, kind }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    // ---- Permission ----

    [Fact]
    public async Task Nudge_requires_chat_send_permission()
    {
        var (_, noSend, _) = await ProvisionUser("No Send", "chat.read");
        (await noSend.PostAsJsonAsync("/api/nudge", new { targetUserId = 1, kind = "logYourDay" }))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }
}
