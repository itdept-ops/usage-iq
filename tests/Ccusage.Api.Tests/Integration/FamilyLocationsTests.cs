using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using FluentAssertions;

namespace Ccusage.Api.Tests.Integration;

/// <summary>
/// Family-finder locations (GET /api/family/locations). Covers: requires family.use (403) + auth (401);
/// returns the caller's own latest pin PLUS opted-in household members' latest; EXCLUDES a household member
/// who is NOT sharing and any non-household user; carries NO email; and returns the NEWEST pin per user.
/// Every test provisions fresh users so they're order-independent. The precise lat/lng is intentionally
/// returned here — for the finder, a member's household-share opt-in IS the consent.
/// </summary>
[Collection(IntegrationCollection.Name)]
public class FamilyLocationsTests(WebAppFactory factory)
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

    /// <summary>Provision a fresh, enabled user with the given permissions; returns email + client + id.</summary>
    private async Task<(string email, HttpClient client, int id)> ProvisionUser(params string[] permissions)
    {
        var email = $"famloc-{Guid.NewGuid():N}@test.local";
        var res = await Admin().PostAsJsonAsync("/api/users", new { email, isEnabled = true, permissions });
        res.StatusCode.Should().Be(HttpStatusCode.Created);
        var id = (await Json(res)).GetProperty("id").GetInt32();
        return (email, Client(email), id);
    }

    private static async Task<JsonElement> Json(HttpResponseMessage resp) =>
        await resp.Content.ReadFromJsonAsync<JsonElement>();

    /// <summary>Ensure the caller's household exists (auto-provisions the caller as owner).</summary>
    private static async Task EnsureHousehold(HttpClient client) =>
        (await client.GetAsync("/api/family/household")).EnsureSuccessStatusCode();

    /// <summary>Owner adds an existing family.use user to their household.</summary>
    private static async Task AddMember(HttpClient owner, int userId) =>
        (await owner.PostAsJsonAsync("/api/family/household/members", new { userId })).EnsureSuccessStatusCode();

    /// <summary>Turn on capture (always) and, when sharing, the household-share opt-in too.</summary>
    private static async Task EnableAndShare(HttpClient client, bool share) =>
        (await client.PatchAsJsonAsync("/api/location/settings",
            new { locationEnabled = true, shareHousehold = share })).EnsureSuccessStatusCode();

    /// <summary>Record one precise fix for the caller.</summary>
    private static async Task Record(HttpClient client, double lat, double lng) =>
        (await client.PostAsJsonAsync("/api/location", new { lat, lng })).EnsureSuccessStatusCode();

    private static FamilyLocationsPin? PinFor(JsonElement arr, int userId)
    {
        foreach (var e in arr.EnumerateArray())
            if (e.GetProperty("userId").GetInt32() == userId)
                return new FamilyLocationsPin(e);
        return null;
    }

    private sealed record FamilyLocationsPin(JsonElement El)
    {
        public double Lat => El.GetProperty("lat").GetDouble();
        public double Lng => El.GetProperty("lng").GetDouble();
        public bool IsSelf => El.GetProperty("isSelf").GetBoolean();
        public string Name => El.GetProperty("name").GetString()!;
    }

    // ---- Gating ----

    [Fact]
    public async Task Family_locations_requires_authentication()
    {
        var anon = factory.CreateClient();
        (await anon.GetAsync("/api/family/locations")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Family_locations_requires_family_use()
    {
        var (_, plain, _) = await ProvisionUser("dashboard.view");
        (await plain.GetAsync("/api/family/locations")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    // ---- The finder: own latest + opted-in members' latest ----

    [Fact]
    public async Task Returns_caller_own_latest_and_opted_in_member_latest()
    {
        var (_, owner, ownerId) = await ProvisionUser("family.use", "location.self", "location.share");
        var (_, bob, bobId) = await ProvisionUser("family.use", "location.self", "location.share");

        await EnsureHousehold(owner);
        await AddMember(owner, bobId);

        // Owner records but does NOT share — still sees their OWN pin (self is exempt from the share gate).
        await EnableAndShare(owner, share: false);
        await Record(owner, 27.95, -82.46);

        // Bob shares and records.
        await EnableAndShare(bob, share: true);
        await Record(bob, 40.71, -74.00);

        var arr = await Json(await owner.GetAsync("/api/family/locations"));
        arr.GetArrayLength().Should().Be(2);

        var self = PinFor(arr, ownerId)!;
        self.IsSelf.Should().BeTrue();
        self.Lat.Should().BeApproximately(27.95, 0.0001);

        var bobPin = PinFor(arr, bobId)!;
        bobPin.IsSelf.Should().BeFalse();
        bobPin.Lat.Should().BeApproximately(40.71, 0.0001);
        bobPin.Lng.Should().BeApproximately(-74.00, 0.0001);
    }

    // ---- Excludes a non-sharing member and a non-household user ----

    [Fact]
    public async Task Excludes_non_sharing_member_and_non_household_user()
    {
        var (_, owner, ownerId) = await ProvisionUser("family.use", "location.self", "location.share");
        var (_, nonSharer, nonSharerId) = await ProvisionUser("family.use", "location.self", "location.share");
        var (_, outsider, outsiderId) = await ProvisionUser("family.use", "location.self", "location.share");

        await EnsureHousehold(owner);
        await AddMember(owner, nonSharerId);

        await EnableAndShare(owner, share: true);
        await Record(owner, 1.0, 1.0);

        // In the household but NOT sharing -> excluded even though they have a recent fix.
        await EnableAndShare(nonSharer, share: false);
        await Record(nonSharer, 2.0, 2.0);

        // Sharing but NOT in this household -> excluded.
        await EnsureHousehold(outsider);
        await EnableAndShare(outsider, share: true);
        await Record(outsider, 3.0, 3.0);

        var arr = await Json(await owner.GetAsync("/api/family/locations"));
        arr.GetArrayLength().Should().Be(1);
        PinFor(arr, ownerId).Should().NotBeNull();
        PinFor(arr, nonSharerId).Should().BeNull();
        PinFor(arr, outsiderId).Should().BeNull();
    }

    // ---- No email on the wire ----

    [Fact]
    public async Task Payload_carries_no_email()
    {
        var (ownerEmail, owner, _) = await ProvisionUser("family.use", "location.self", "location.share");
        var (bobEmail, bob, bobId) = await ProvisionUser("family.use", "location.self", "location.share");

        await EnsureHousehold(owner);
        await AddMember(owner, bobId);
        await EnableAndShare(owner, share: true);
        await Record(owner, 10.0, 10.0);
        await EnableAndShare(bob, share: true);
        await Record(bob, 20.0, 20.0);

        var raw = await (await owner.GetAsync("/api/family/locations")).Content.ReadAsStringAsync();
        raw.Should().NotContain(ownerEmail);
        raw.Should().NotContain(bobEmail);
        raw.Should().NotContain("@test.local");
    }

    // ---- Newest pin per user ----

    [Fact]
    public async Task Returns_newest_pin_per_user()
    {
        var (_, owner, ownerId) = await ProvisionUser("family.use", "location.self", "location.share");
        await EnsureHousehold(owner);
        await EnableAndShare(owner, share: true);

        await Record(owner, 5.0, 5.0);
        await Record(owner, 6.0, 6.0); // newest

        var arr = await Json(await owner.GetAsync("/api/family/locations"));
        var self = PinFor(arr, ownerId)!;
        self.Lat.Should().BeApproximately(6.0, 0.0001);
        self.Lng.Should().BeApproximately(6.0, 0.0001);
    }
}
