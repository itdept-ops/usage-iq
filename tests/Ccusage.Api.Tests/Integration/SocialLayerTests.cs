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
/// The social / "alive" layer backend (feature #7) + the public Built-With badge (feature #6):
/// <list type="bullet">
///   <item>BADGE: <c>GET /api/public/built-with</c> is anonymous, returns aggregate NUMBERS ONLY (no email,
///   name, project, or model), and is cache-friendly (Cache-Control public).</item>
///   <item>COMMENTS: a comment on a NON-VISIBLE event 404s (existence never leaked); free-text is validated
///   (empty rejected, control-chars stripped, length capped); a fresh comment on someone else's event fires
///   exactly one Comment notification using DisplayName (never an email).</item>
///   <item>PACTS: a pact CANNOT invite a non-mutual-contact (rejected); a mutual contact CAN be invited and
///   gets a PactInvite notification; member identity crosses the wire as id + DisplayName, never an email.</item>
///   <item>LEADERBOARD: household-scoped (only the caller's household members), ranks on shareable
///   ActivityEvent counts, and leaks no email.</item>
/// </list>
/// Every test provisions fresh users so they're order-independent.
/// </summary>
[Collection(IntegrationCollection.Name)]
public class SocialLayerTests(WebAppFactory factory)
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

    private HttpClient Anonymous() => factory.CreateClient();

    private async Task<(string email, HttpClient client)> ProvisionUser(params string[] permissions)
    {
        var email = $"social-{Guid.NewGuid():N}@test.local";
        var res = await Admin().PostAsJsonAsync("/api/users", new { email, isEnabled = true, permissions });
        res.StatusCode.Should().Be(HttpStatusCode.Created);
        return (email, Client(email));
    }

    private async Task<int> UserIdFor(string email)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        return await db.Users.AsNoTracking().Where(u => u.Email == email).Select(u => u.Id).FirstAsync();
    }

    /// <summary>Make a MUTUAL contact edge (both directions) between two users via the admin contacts API.</summary>
    private async Task MakeContacts(string aEmail, string bEmail)
    {
        var aId = await UserIdFor(aEmail);
        var bId = await UserIdFor(bEmail);
        (await Admin().PostAsJsonAsync($"/api/chat/contacts/user/{aId}", new { contactUserId = bId }))
            .StatusCode.Should().Be(HttpStatusCode.OK);
    }

    private async Task SetActivityPrefs(string email, bool share, bool view)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        var u = await db.Users.FirstAsync(x => x.Email == email);
        u.ShareActivity = share;
        u.ViewActivityFeed = view;
        await db.SaveChangesAsync();
    }

    private async Task SetDisplayName(string email, string name, DisplayNameMode mode)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        var u = await db.Users.FirstAsync(x => x.Email == email);
        u.Name = name;
        u.DisplayNameMode = mode;
        await db.SaveChangesAsync();
    }

    private async Task<long> SeedEvent(string actorEmail, string kind = "workout.logged", int? intValue = 30, string? label = "Run")
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        var ev = new ActivityEvent
        {
            ActorEmail = actorEmail.ToLowerInvariant(), Kind = kind, IntValue = intValue, Label = label,
            CreatedUtc = DateTime.UtcNow,
        };
        db.ActivityEvents.Add(ev);
        await db.SaveChangesAsync();
        return ev.Id;
    }

    private async Task<List<Notification>> NotificationsFor(string email)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        return await db.Notifications.AsNoTracking().Where(n => n.RecipientEmail == email).ToListAsync();
    }

    private static async Task<JsonElement> Json(HttpResponseMessage resp) =>
        await resp.Content.ReadFromJsonAsync<JsonElement>();

    // ======================= FEATURE #6 — BUILT-WITH BADGE =======================

    [Fact]
    public async Task BuiltWith_is_anonymous_and_returns_numbers_only_no_pii()
    {
        var res = await Anonymous().GetAsync("/api/public/built-with");
        res.StatusCode.Should().Be(HttpStatusCode.OK, "the badge is AllowAnonymous");

        // Cache-safe: a public Cache-Control header is present so a CDN/browser can hold it.
        res.Headers.CacheControl.Should().NotBeNull();
        res.Headers.CacheControl!.Public.Should().BeTrue();
        res.Headers.CacheControl.MaxAge.Should().NotBeNull();

        var raw = await res.Content.ReadAsStringAsync();

        // PII-safe: the payload is aggregate numbers only — no email, no name, no project/model list.
        raw.Should().NotContain("@", "the badge must never carry an email");
        raw.Should().NotContain(WebAppFactory.AdminEmail);

        var json = JsonDocument.Parse(raw).RootElement;
        // The contract: aggregate counts only.
        json.GetProperty("totalTokens").GetInt64().Should().BeGreaterThanOrEqualTo(0);
        json.GetProperty("agentCount").GetInt32().Should().BeGreaterThanOrEqualTo(0);
        json.GetProperty("sessionCount").GetInt32().Should().BeGreaterThanOrEqualTo(0);
        json.GetProperty("activeDays").GetInt32().Should().BeGreaterThanOrEqualTo(0);
        json.TryGetProperty("totalCostUsd", out _).Should().BeTrue();
        json.TryGetProperty("asOf", out _).Should().BeTrue();

        // And NO identity-bearing fields ever appear.
        foreach (var forbidden in new[] { "email", "name", "project", "projects", "model", "models", "ownerEmail" })
            json.TryGetProperty(forbidden, out _).Should().BeFalse($"the badge must not expose '{forbidden}'");
    }

    // ======================= FEATURE #7 — COMMENTS =======================

    [Fact]
    public async Task Comment_on_a_non_visible_event_404s()
    {
        var (_, caller) = await ProvisionUser("tracker.self");
        var (strangerEmail, _) = await ProvisionUser("tracker.self");
        // No contact edge; even with the stranger sharing, the caller can't see it.
        await SetActivityPrefs(strangerEmail, share: true, view: false);
        var eventId = await SeedEvent(strangerEmail);

        var post = await caller.PostAsJsonAsync($"/api/feed/{eventId}/comments", new { body = "nice!" });
        post.StatusCode.Should().Be(HttpStatusCode.NotFound, "a non-contact's event is invisible — never reveal it exists");

        // The thread read is gated identically.
        (await caller.GetAsync($"/api/feed/{eventId}/comments")).StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task Comment_free_text_is_validated()
    {
        var (email, client) = await ProvisionUser("tracker.self"); // own event is always visible
        var eventId = await SeedEvent(email);

        // Empty / whitespace-only is rejected.
        (await client.PostAsJsonAsync($"/api/feed/{eventId}/comments", new { body = "   " }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await client.PostAsJsonAsync($"/api/feed/{eventId}/comments", new { body = (string?)null }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);

                // Control chars are stripped (newline/tab -> space, runs collapsed); over-long is capped to 500.
        var dirty = "Great job" + (char)10 + "team" + (char)9 + "!" + new string('x', 800);
        var ok = await client.PostAsJsonAsync($"/api/feed/{eventId}/comments", new { body = dirty });
        ok.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = (await Json(ok)).GetProperty("body").GetString()!;
        body.Should().NotContain(((char)10).ToString(), "newlines are stripped");
        body.Should().NotContain(((char)9).ToString(), "tabs are stripped");
        body.Should().StartWith("Great job team !", "control chars collapse to single spaces");
        body.Length.Should().BeLessThanOrEqualTo(500, "the body is capped at 500 chars");
    }

    [Fact]
    public async Task Fresh_comment_on_anothers_event_creates_one_Comment_notification_using_DisplayName()
    {
        var (commenterEmail, commenter) = await ProvisionUser("tracker.self");
        var (actorEmail, _) = await ProvisionUser("tracker.self");
        await MakeContacts(commenterEmail, actorEmail);
        await SetActivityPrefs(actorEmail, share: true, view: false);
        await SetActivityPrefs(commenterEmail, share: false, view: true);
        await SetDisplayName(commenterEmail, "Sam Rivers", DisplayNameMode.FirstName);

        var eventId = await SeedEvent(actorEmail);
        (await commenter.PostAsJsonAsync($"/api/feed/{eventId}/comments", new { body = "let's go!" }))
            .StatusCode.Should().Be(HttpStatusCode.OK);

        var comments = (await NotificationsFor(actorEmail)).Where(n => n.Type == NotificationType.Comment).ToList();
        comments.Should().ContainSingle("exactly one comment notification on a fresh comment");
        var note = comments[0];
        note.Text.Should().Be("Sam commented on your workout");   // DisplayName, fixed framing
        note.Text.Should().NotContain("@");                        // never an email
        note.Text.Should().NotContain("let's go");                // the BODY is never in the notification
        note.Link.Should().Be("/feed");
    }

    [Fact]
    public async Task Comment_thread_exposes_author_id_and_DisplayName_never_email()
    {
        var (email, client) = await ProvisionUser("tracker.self");
        await SetDisplayName(email, "Dana Lee", DisplayNameMode.FirstName);
        var eventId = await SeedEvent(email);

        await client.PostAsJsonAsync($"/api/feed/{eventId}/comments", new { body = "first" });
        var thread = await Json(await client.GetAsync($"/api/feed/{eventId}/comments"));
        var raw = thread.GetRawText();
        raw.Should().NotContain("@", "a comment thread must never carry an author email");
        raw.Should().NotContain(email);

        var item = thread.EnumerateArray().Single();
        item.GetProperty("authorName").GetString().Should().Be("Dana");
        item.GetProperty("authorUserId").GetInt32().Should().Be(await UserIdFor(email));
        item.GetProperty("mine").GetBoolean().Should().BeTrue();
    }

    [Fact]
    public async Task Comment_soft_delete_by_author_removes_it_from_thread()
    {
        var (email, client) = await ProvisionUser("tracker.self");
        var eventId = await SeedEvent(email);
        var created = await Json(await client.PostAsJsonAsync($"/api/feed/{eventId}/comments", new { body = "oops" }));
        var cid = created.GetProperty("id").GetInt64();

        (await client.DeleteAsync($"/api/feed/comments/{cid}")).StatusCode.Should().Be(HttpStatusCode.NoContent);

        var thread = await Json(await client.GetAsync($"/api/feed/{eventId}/comments"));
        thread.EnumerateArray().Should().BeEmpty("a soft-deleted comment is excluded from the thread");
    }

    [Fact]
    public async Task Comment_delete_by_a_non_author_404s_and_is_not_an_existence_oracle()
    {
        var (authorEmail, author) = await ProvisionUser("tracker.self");
        var (_, stranger) = await ProvisionUser("tracker.self"); // not the author, no chat.moderate
        var eventId = await SeedEvent(authorEmail);
        var created = await Json(await author.PostAsJsonAsync($"/api/feed/{eventId}/comments", new { body = "mine" }));
        var cid = created.GetProperty("id").GetInt64();

        // A non-author/non-moderator gets 404 — IDENTICAL to a missing comment — so the status code can't be
        // iterated as an existence oracle (existing-but-not-yours is indistinguishable from doesn't-exist).
        (await stranger.DeleteAsync($"/api/feed/comments/{cid}")).StatusCode
            .Should().Be(HttpStatusCode.NotFound, "a non-author must not learn whether the comment exists");
        (await stranger.DeleteAsync($"/api/feed/comments/{cid + 9_999_999}")).StatusCode
            .Should().Be(HttpStatusCode.NotFound, "a genuinely missing comment returns the same 404");

        // The unauthorized delete was a no-op — the author still sees their comment.
        var thread = await Json(await author.GetAsync($"/api/feed/{eventId}/comments"));
        thread.EnumerateArray().Should().ContainSingle("a non-author delete must not remove the comment");
    }

    // ======================= FEATURE #7 — HABIT PACTS =======================

    [Fact]
    public async Task Pact_cannot_invite_a_non_mutual_contact()
    {
        var (ownerEmail, owner) = await ProvisionUser("tracker.self");
        var (strangerEmail, _) = await ProvisionUser("tracker.self");
        var strangerId = await UserIdFor(strangerEmail);
        // NO contact edge between the owner and the stranger.

        // Create the pact (no invites yet), then attempt to invite the non-contact.
        var pact = await Json(await owner.PostAsJsonAsync("/api/pacts",
            new { title = "Run club", kind = "workout.logged", targetIntValue = 5, periodDays = 7 }));
        var pactId = pact.GetProperty("id").GetInt64();

        var invite = await owner.PostAsJsonAsync($"/api/pacts/{pactId}/members",
            new { memberUserIds = new[] { strangerId } });
        invite.StatusCode.Should().Be(HttpStatusCode.BadRequest, "a pact can only invite mutual contacts (no spam invites)");

        // The stranger must NOT have been added as a member, and got NO invite notification.
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
            var rows = await db.HabitPactMembers.AsNoTracking()
                .CountAsync(m => m.HabitPactId == pactId && m.MemberEmail == strangerEmail);
            rows.Should().Be(0, "a non-contact must never be added to a pact");
        }
        (await NotificationsFor(strangerEmail)).Any(n => n.Type == NotificationType.PactInvite)
            .Should().BeFalse("a non-contact must never receive a pact invite");
    }

    [Fact]
    public async Task Pact_can_invite_a_mutual_contact_who_gets_a_PactInvite_notification()
    {
        var (ownerEmail, owner) = await ProvisionUser("tracker.self");
        var (friendEmail, _) = await ProvisionUser("tracker.self");
        await MakeContacts(ownerEmail, friendEmail);
        await SetDisplayName(ownerEmail, "Pat Owner", DisplayNameMode.FirstName);
        var friendId = await UserIdFor(friendEmail);

        var pact = await Json(await owner.PostAsJsonAsync("/api/pacts",
            new { title = "Hydrate", kind = "hydration.goalHit", targetIntValue = 3, periodDays = 5,
                  memberUserIds = new[] { friendId } }));
        var pactId = pact.GetProperty("id").GetInt64();

        // Members on the wire are id + DisplayName — never an email.
        var raw = pact.GetRawText();
        raw.Should().NotContain("@");
        raw.Should().NotContain(friendEmail);
        raw.Should().NotContain(ownerEmail);

        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
            (await db.HabitPactMembers.AsNoTracking()
                .AnyAsync(m => m.HabitPactId == pactId && m.MemberEmail == friendEmail
                               && m.Status == HabitPactMemberStatus.Invited))
                .Should().BeTrue("the mutual contact is invited");
        }

        var invites = (await NotificationsFor(friendEmail)).Where(n => n.Type == NotificationType.PactInvite).ToList();
        invites.Should().ContainSingle();
        invites[0].Text.Should().Contain("Hydrate");
        invites[0].Text.Should().NotContain("@");
        invites[0].Link.Should().Be("/pacts");
    }

    [Fact]
    public async Task Pact_progress_counts_matching_events_in_period_no_email()
    {
        var (ownerEmail, owner) = await ProvisionUser("tracker.self");

        var pact = await Json(await owner.PostAsJsonAsync("/api/pacts",
            new { title = "Lift", kind = "workout.logged", targetIntValue = 2, periodDays = 7 }));
        var pactId = pact.GetProperty("id").GetInt64();

        await SeedEvent(ownerEmail, "workout.logged");
        await SeedEvent(ownerEmail, "workout.logged");
        await SeedEvent(ownerEmail, "hydration.goalHit"); // different kind — must NOT count

        var ownerUserId = await UserIdFor(ownerEmail);
        var progress = await Json(await owner.GetAsync($"/api/pacts/{pactId}/progress"));
        progress.GetRawText().Should().NotContain("@");
        var ownerRow = progress.EnumerateArray().Single(r => r.GetProperty("userId").GetInt32() == ownerUserId);
        ownerRow.GetProperty("count").GetInt32().Should().Be(2, "only matching-kind events in the period count");
        ownerRow.GetProperty("metTarget").GetBoolean().Should().BeTrue();
    }

    [Fact]
    public async Task A_pact_accepts_the_new_habit_dayComplete_kind()
    {
        var (ownerEmail, owner) = await ProvisionUser("tracker.self");

        // The pact can now track a habit streak — habit.dayComplete is a valid kind (the only pact-side change).
        var create = await owner.PostAsJsonAsync("/api/pacts",
            new { title = "Habit streak", kind = "habit.dayComplete", targetIntValue = 3, periodDays = 7 });
        create.StatusCode.Should().Be(HttpStatusCode.OK);
        var pact = await Json(create);
        pact.GetProperty("kind").GetString().Should().Be("habit.dayComplete");
        var pactId = pact.GetProperty("id").GetInt64();

        // And matching habit.dayComplete events are counted in the period.
        await SeedEvent(ownerEmail, "habit.dayComplete", intValue: 1, label: null);
        await SeedEvent(ownerEmail, "habit.dayComplete", intValue: 2, label: null);
        await SeedEvent(ownerEmail, "challenge.dayComplete"); // different kind — must NOT count

        var ownerUserId = await UserIdFor(ownerEmail);
        var progress = await Json(await owner.GetAsync($"/api/pacts/{pactId}/progress"));
        var ownerRow = progress.EnumerateArray().Single(r => r.GetProperty("userId").GetInt32() == ownerUserId);
        ownerRow.GetProperty("count").GetInt32().Should().Be(2);
    }

    [Fact]
    public async Task Pact_join_activates_an_invite_but_a_member_who_left_cannot_silently_rejoin()
    {
        var (ownerEmail, owner) = await ProvisionUser("tracker.self");
        var (friendEmail, friend) = await ProvisionUser("tracker.self");
        await MakeContacts(ownerEmail, friendEmail);
        var friendId = await UserIdFor(friendEmail);

        var pact = await Json(await owner.PostAsJsonAsync("/api/pacts",
            new { title = "Run club", kind = "workout.logged", targetIntValue = 5, periodDays = 7,
                  memberUserIds = new[] { friendId } }));
        var pactId = pact.GetProperty("id").GetInt64();

        // Invited → Active on join, and joining again while Active is idempotent (not an error).
        (await friend.PostAsync($"/api/pacts/{pactId}/join", null)).StatusCode.Should().Be(HttpStatusCode.NoContent);
        (await friend.PostAsync($"/api/pacts/{pactId}/join", null)).StatusCode
            .Should().Be(HttpStatusCode.NoContent, "re-joining while already Active is a no-op success");

        // Leave → Left.
        (await friend.PostAsync($"/api/pacts/{pactId}/leave", null)).StatusCode.Should().Be(HttpStatusCode.NoContent);

        // A member who LEFT must NOT be able to silently re-activate — that needs a fresh owner invite. This keeps
        // Left meaning "not a participant" airtight (so a future owner-remove feature can safely reuse Left).
        (await friend.PostAsync($"/api/pacts/{pactId}/join", null)).StatusCode
            .Should().Be(HttpStatusCode.Conflict, "leaving is sticky — re-joining requires a fresh invite");

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        var status = await db.HabitPactMembers.AsNoTracking()
            .Where(m => m.HabitPactId == pactId && m.MemberEmail == friendEmail).Select(m => m.Status).FirstAsync();
        status.Should().Be(HabitPactMemberStatus.Left, "the rejected re-join must not have re-activated the member");
    }

    [Fact]
    public async Task Pacts_requires_tracker_self_permission()
    {
        var (_, noTracker) = await ProvisionUser("dashboard.view");
        (await noTracker.GetAsync("/api/pacts")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    // ======================= FEATURE #7 — FAMILY LEADERBOARD =======================

    [Fact]
    public async Task Leaderboard_is_household_scoped_ranks_events_and_leaks_no_email()
    {
        // Owner + one household member; an OUTSIDER with more events must NOT appear.
        var (ownerEmail, owner) = await ProvisionUser("family.use", "tracker.self");
        var (memberEmail, _) = await ProvisionUser("family.use", "tracker.self");
        var (outsiderEmail, _) = await ProvisionUser("family.use", "tracker.self");
        await SetDisplayName(ownerEmail, "Owner One", DisplayNameMode.FirstName);
        await SetDisplayName(memberEmail, "Member Two", DisplayNameMode.FirstName);

        // Provision the owner's household, then add the member.
        (await owner.GetAsync("/api/family/household")).StatusCode.Should().Be(HttpStatusCode.OK);
        var memberId = await UserIdFor(memberEmail);
        (await owner.PostAsJsonAsync("/api/family/household/members", new { userId = memberId, role = "adult" }))
            .StatusCode.Should().Be(HttpStatusCode.OK);

        // Events: member has 3 workouts, owner 1, outsider 5 (outsider is NOT in the household).
        await SeedEvent(ownerEmail, "workout.logged");
        for (var i = 0; i < 3; i++) await SeedEvent(memberEmail, "workout.logged");
        for (var i = 0; i < 5; i++) await SeedEvent(outsiderEmail, "workout.logged");

        var board = await Json(await owner.GetAsync("/api/family/leaderboard?metric=workout"));
        var raw = board.GetRawText();
        raw.Should().NotContain("@", "the leaderboard must never carry an email");
        raw.Should().NotContain(ownerEmail);
        raw.Should().NotContain(memberEmail);

        var rows = board.EnumerateArray().ToList();
        // Household-scoped: exactly the 2 household members, never the outsider (despite their higher count).
        rows.Should().HaveCount(2);
        rows.Select(r => r.GetProperty("userId").GetInt32()).Should().NotContain(await UserIdFor(outsiderEmail));

        // Ranked by event count: the member (3) outranks the owner (1).
        var first = rows[0];
        first.GetProperty("userId").GetInt32().Should().Be(memberId);
        first.GetProperty("intValue").GetInt32().Should().Be(3);
        first.GetProperty("rank").GetInt32().Should().Be(1);
        first.GetProperty("name").GetString().Should().Be("Member");
    }

    [Fact]
    public async Task Leaderboard_requires_family_use_permission()
    {
        var (_, noFamily) = await ProvisionUser("tracker.self");
        (await noFamily.GetAsync("/api/family/leaderboard")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }
}
