using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Ccusage.Api.Data;
using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Ccusage.Api.Tests.Integration;

/// <summary>
/// The People hub (/api/people): the caller's contacts ∪ household members, de-duplicated over the single
/// AppUser spine, decorated with presence. Covers: auth + any-of(chat.read|family.use) gating; the source
/// each permission unlocks (contacts ⟸ chat.read, household ⟸ family.use); DEDUP (a person who is BOTH a
/// contact and a household member appears once with both flags); the presence join (online flag + lastSeen);
/// appear-offline is honored (an other user hiding presence reads offline); DisplayName is applied (the
/// last-name-dropped form, never the raw name); NO email anywhere on the wire; and the capability flags
/// (canDm mirrors the contact gate). Every test provisions fresh users so they're order-independent.
/// </summary>
[Collection(IntegrationCollection.Name)]
public class PeopleIntegrationTests(WebAppFactory factory)
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
        var email = $"people-{Guid.NewGuid():N}@test.local";
        var res = await Admin().PostAsJsonAsync("/api/users", new { email, name, isEnabled = true, permissions });
        res.StatusCode.Should().Be(HttpStatusCode.Created);
        var id = (await Json(res)).GetProperty("id").GetInt32();
        return (email, Client(email), id);
    }

    private static async Task<JsonElement> Json(HttpResponseMessage resp) =>
        await resp.Content.ReadFromJsonAsync<JsonElement>();

    private static List<int> Ids(JsonElement arr) =>
        arr.EnumerateArray().Select(p => p.GetProperty("userId").GetInt32()).ToList();

    private static JsonElement Person(JsonElement arr, int userId) =>
        arr.EnumerateArray().Single(p => p.GetProperty("userId").GetInt32() == userId);

    /// <summary>Make a mutual contact pair via the admin manage endpoint (both directions).</summary>
    private async Task MakeContacts(int aId, int bId) =>
        (await Admin().PostAsJsonAsync($"/api/chat/contacts/user/{aId}", new { contactUserId = bId }))
            .StatusCode.Should().Be(HttpStatusCode.OK);

    // ---- Auth + permission gating ----

    [Fact]
    public async Task People_requires_authentication()
        => (await factory.CreateClient().GetAsync("/api/people")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);

    [Fact]
    public async Task People_requires_chat_read_or_family_use()
    {
        // Neither chat.read nor family.use → 403 (the any-of guard).
        var (_, plain, _) = await ProvisionUser("No Access", "dashboard.view");
        (await plain.GetAsync("/api/people")).StatusCode.Should().Be(HttpStatusCode.Forbidden);

        // Either permission alone is enough to reach the page (200).
        var (_, chatOnly, _) = await ProvisionUser("Chat Only", "chat.read");
        (await chatOnly.GetAsync("/api/people")).StatusCode.Should().Be(HttpStatusCode.OK);

        var (_, famOnly, _) = await ProvisionUser("Family Only", "family.use");
        (await famOnly.GetAsync("/api/people")).StatusCode.Should().Be(HttpStatusCode.OK);
    }

    // ---- Contacts source (chat.read) ----

    [Fact]
    public async Task Contacts_appear_for_a_chat_read_caller_with_is_contact_flag()
    {
        var (aliceEmail, alice, aliceId) = await ProvisionUser("Alice Anderson", "chat.read");
        var (_, _, bobId) = await ProvisionUser("Bob Brown", "chat.read");
        await MakeContacts(aliceId, bobId);

        var people = await Json(await alice.GetAsync("/api/people"));
        Ids(people).Should().Contain(bobId);

        var bob = Person(people, bobId);
        bob.GetProperty("isContact").GetBoolean().Should().BeTrue();
        bob.GetProperty("isHousehold").GetBoolean().Should().BeFalse();
        bob.GetProperty("role").ValueKind.Should().Be(JsonValueKind.Null);
        // The caller is a contact-only user with no household, so canDm is true for a contact.
        bob.GetProperty("canDm").GetBoolean().Should().BeTrue();
    }

    [Fact]
    public async Task A_family_only_caller_does_not_see_contacts()
    {
        // Alice holds ONLY family.use (no chat.read) but has a contact edge to Bob. Because she lacks
        // chat.read, the contacts source is skipped — Bob must not appear via the contact path.
        var (_, _, aliceId) = await ProvisionUser("Alice Family", "family.use");
        var (_, _, bobId) = await ProvisionUser("Bob Contact", "chat.read");
        await MakeContacts(aliceId, bobId);

        var alice = Client((await UserEmail(aliceId)));
        var people = await Json(await alice.GetAsync("/api/people"));
        Ids(people).Should().NotContain(bobId);
    }

    // ---- Household source (family.use) + dedup over the AppUser spine ----

    [Fact]
    public async Task Household_members_appear_with_role_and_a_person_who_is_both_is_deduped()
    {
        // Owner Alice (family.use + chat.read, contacts.manage so she can DM anyone), adds Bob as an adult.
        var (_, alice, aliceId) = await ProvisionUser(
            "Alice Owner", "family.use", "chat.read", "chat.contacts.manage");
        var (_, _, bobId) = await ProvisionUser("Bob Member", "family.use", "chat.read");

        // Provision Alice's household (GET auto-creates with her as owner), then add Bob as adult.
        (await alice.GetAsync("/api/family/household")).EnsureSuccessStatusCode();
        (await alice.PostAsJsonAsync("/api/family/household/members", new { userId = bobId, role = "adult" }))
            .StatusCode.Should().Be(HttpStatusCode.OK);

        // Adding an adult auto-bridges a mutual contact edge (ContactGraph.BridgeHouseholdAdultAsync), so
        // Bob is now BOTH a household member AND a contact of Alice — he must appear EXACTLY ONCE.
        var people = await Json(await alice.GetAsync("/api/people"));
        Ids(people).Where(id => id == bobId).Should().ContainSingle("a contact+member is deduped over the AppUser spine");

        var bob = Person(people, bobId);
        bob.GetProperty("isHousehold").GetBoolean().Should().BeTrue();
        bob.GetProperty("isContact").GetBoolean().Should().BeTrue();
        bob.GetProperty("role").GetString().Should().Be("adult");

        // Alice's own row is present (she's the owner), flagged self, role owner, and canDm false (no self-DM).
        var me = Person(people, aliceId);
        me.GetProperty("isSelf").GetBoolean().Should().BeTrue();
        me.GetProperty("role").GetString().Should().Be("owner");
        me.GetProperty("canDm").GetBoolean().Should().BeFalse();
    }

    // ---- Presence join + appear-offline ----

    [Fact]
    public async Task Presence_join_marks_an_active_contact_online()
    {
        var (_, alice, aliceId) = await ProvisionUser("Alice Online", "chat.read");
        var (bobEmail, bob, bobId) = await ProvisionUser("Bob Online", "chat.read");
        await MakeContacts(aliceId, bobId);

        // Bob makes an authenticated request → the presence middleware marks him online.
        (await bob.GetAsync("/api/auth/me")).EnsureSuccessStatusCode();

        var people = await Json(await alice.GetAsync("/api/people"));
        var bobRow = Person(people, bobId);
        bobRow.GetProperty("online").GetBoolean().Should().BeTrue();
        bobRow.GetProperty("lastSeenUtc").ValueKind.Should().NotBe(JsonValueKind.Null);
    }

    [Fact]
    public async Task Appear_offline_hides_a_contacts_online_state_from_others()
    {
        var (_, alice, aliceId) = await ProvisionUser("Alice Viewer", "chat.read");
        var (bobEmail, bob, bobId) = await ProvisionUser("Bob Hidden", "chat.read");
        await MakeContacts(aliceId, bobId);

        // Bob opts to appear offline, then makes a request (so he IS in the live presence set).
        await SetAppearOffline(bobEmail, true);
        (await bob.GetAsync("/api/auth/me")).EnsureSuccessStatusCode();

        // Alice (another user) must see Bob as offline despite him being live.
        var people = await Json(await alice.GetAsync("/api/people"));
        Person(people, bobId).GetProperty("online").GetBoolean().Should().BeFalse();
    }

    // ---- DisplayName applied + no email leak ----

    [Fact]
    public async Task Name_goes_through_display_name_formatter_and_no_email_leaks()
    {
        // The default DisplayNameMode is FirstInitial — "Robert Roberts" → "Robert R." (last name dropped),
        // proving the central formatter is applied (not the raw AppUser.Name).
        var (_, alice, aliceId) = await ProvisionUser("Alice Reader", "chat.read");
        var (_, _, bobId) = await ProvisionUser("Robert Roberts", "chat.read");
        await MakeContacts(aliceId, bobId);

        var resp = await alice.GetAsync("/api/people");
        var raw = await resp.Content.ReadAsStringAsync();

        // Email-privacy: nothing email-shaped anywhere in the payload, and no "email" field.
        raw.Should().NotContain("@");
        raw.Should().NotContain("email");

        var people = await Json(resp);
        foreach (var p in people.EnumerateArray())
            p.TryGetProperty("email", out _).Should().BeFalse();

        // The formatted (last-name-dropped) form, NOT the raw "Robert Roberts".
        Person(people, bobId).GetProperty("name").GetString().Should().Be("Robert R.");
    }

    // ---- Status surfaced ----

    [Fact]
    public async Task Opt_in_status_is_surfaced_for_a_contact()
    {
        var (_, alice, aliceId) = await ProvisionUser("Alice S", "chat.read");
        var (bobEmail, bob, bobId) = await ProvisionUser("Bob Status", "chat.read");
        await MakeContacts(aliceId, bobId);

        await SetStatus(bobEmail, "heads-down");

        var people = await Json(await alice.GetAsync("/api/people"));
        Person(people, bobId).GetProperty("status").GetString().Should().Be("heads-down");
    }

    // ---- helpers that mutate AppUser presence prefs directly (mirrors a user setting them) ----

    private async Task SetAppearOffline(string email, bool value)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        await db.Users.Where(u => u.Email == email)
            .ExecuteUpdateAsync(s => s.SetProperty(u => u.AppearOffline, value));
    }

    private async Task SetStatus(string email, string status)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        await db.Users.Where(u => u.Email == email)
            .ExecuteUpdateAsync(s => s.SetProperty(u => u.PresenceStatus, status));
    }

    private async Task<string> UserEmail(int id)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        return (await db.Users.AsNoTracking().FirstAsync(u => u.Id == id)).Email;
    }
}
