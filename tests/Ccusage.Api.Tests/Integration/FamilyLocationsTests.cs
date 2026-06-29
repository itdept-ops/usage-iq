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

    // ======================= History replay (GET /api/family/locations/history) =======================

    /// <summary>Seed N fixes directly for an email at evenly spaced times ending at <paramref name="endUtc"/>,
    /// going back <paramref name="span"/>. Bypasses the live record endpoint so we control CapturedUtc.</summary>
    private async Task SeedHistory(string email, int count, DateTime endUtc, TimeSpan span,
        double lat = 1.0, double lng = 1.0)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        var stepTicks = count <= 1 ? 0 : span.Ticks / (count - 1);
        for (var i = 0; i < count; i++)
        {
            db.UserLocations.Add(new UserLocation
            {
                UserEmail = email,
                Lat = lat,
                Lng = lng,
                Source = "manual",
                CapturedUtc = endUtc - TimeSpan.FromTicks(stepTicks * (count - 1 - i)),
            });
        }
        await db.SaveChangesAsync();
    }

    private static FamilyMemberHistoryView? HistoryFor(JsonElement arr, int userId)
    {
        foreach (var e in arr.EnumerateArray())
            if (e.GetProperty("userId").GetInt32() == userId)
                return new FamilyMemberHistoryView(e);
        return null;
    }

    private sealed record FamilyMemberHistoryView(JsonElement El)
    {
        public bool IsSelf => El.GetProperty("isSelf").GetBoolean();
        public string Name => El.GetProperty("name").GetString()!;
        public JsonElement Points => El.GetProperty("points");
        public int PointCount => Points.GetArrayLength();
    }

    [Fact]
    public async Task History_requires_authentication_and_family_use()
    {
        var anon = factory.CreateClient();
        (await anon.GetAsync("/api/family/locations/history")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);

        var (_, plain, _) = await ProvisionUser("dashboard.view");
        (await plain.GetAsync("/api/family/locations/history")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task History_happy_path_returns_ordered_points_for_self_and_sharing_member()
    {
        var (ownerEmail, owner, ownerId) = await ProvisionUser("family.use", "location.self", "location.share");
        var (bobEmail, bob, bobId) = await ProvisionUser("family.use", "location.self", "location.share");

        await EnsureHousehold(owner);
        await AddMember(owner, bobId);
        await EnableAndShare(owner, share: true);
        await EnableAndShare(bob, share: true);

        var now = DateTime.UtcNow;
        await SeedHistory(ownerEmail, 5, now, TimeSpan.FromHours(2), lat: 10.0, lng: 10.0);
        await SeedHistory(bobEmail, 5, now, TimeSpan.FromHours(2), lat: 20.0, lng: 20.0);

        var arr = await Json(await owner.GetAsync("/api/family/locations/history"));
        arr.GetArrayLength().Should().Be(2);

        var self = HistoryFor(arr, ownerId)!;
        self.IsSelf.Should().BeTrue();
        self.PointCount.Should().Be(5);
        // Ordered oldest→newest.
        var times = self.Points.EnumerateArray()
            .Select(p => p.GetProperty("capturedUtc").GetDateTime()).ToList();
        times.Should().BeInAscendingOrder();

        HistoryFor(arr, bobId)!.PointCount.Should().Be(5);
    }

    [Fact]
    public async Task History_excludes_non_sharing_member_and_out_of_household_user()
    {
        var (ownerEmail, owner, ownerId) = await ProvisionUser("family.use", "location.self", "location.share");
        var (nonSharerEmail, nonSharer, nonSharerId) = await ProvisionUser("family.use", "location.self", "location.share");
        var (outsiderEmail, outsider, outsiderId) = await ProvisionUser("family.use", "location.self", "location.share");

        await EnsureHousehold(owner);
        await AddMember(owner, nonSharerId);
        await EnableAndShare(owner, share: true);
        await EnableAndShare(nonSharer, share: false); // in household, NOT sharing
        await EnsureHousehold(outsider);
        await EnableAndShare(outsider, share: true);   // sharing, but different household

        var now = DateTime.UtcNow;
        await SeedHistory(ownerEmail, 3, now, TimeSpan.FromHours(1));
        await SeedHistory(nonSharerEmail, 3, now, TimeSpan.FromHours(1));
        await SeedHistory(outsiderEmail, 3, now, TimeSpan.FromHours(1));

        var arr = await Json(await owner.GetAsync("/api/family/locations/history"));
        arr.GetArrayLength().Should().Be(1);
        HistoryFor(arr, ownerId).Should().NotBeNull();
        HistoryFor(arr, nonSharerId).Should().BeNull(); // never opted in → never in history
        HistoryFor(arr, outsiderId).Should().BeNull();  // out of household → never appears
    }

    [Fact]
    public async Task History_carries_no_email()
    {
        var (ownerEmail, owner, _) = await ProvisionUser("family.use", "location.self", "location.share");
        await EnsureHousehold(owner);
        await EnableAndShare(owner, share: true);
        await SeedHistory(ownerEmail, 3, DateTime.UtcNow, TimeSpan.FromHours(1));

        var raw = await (await owner.GetAsync("/api/family/locations/history")).Content.ReadAsStringAsync();
        raw.Should().NotContain(ownerEmail);
        raw.Should().NotContain("@test.local");
    }

    [Fact]
    public async Task History_clamps_window_to_max_48h_excluding_older_points()
    {
        var (ownerEmail, owner, ownerId) = await ProvisionUser("family.use", "location.self", "location.share");
        await EnsureHousehold(owner);
        await EnableAndShare(owner, share: true);

        var now = DateTime.UtcNow;
        // One point inside the 48h cap, one WAY outside (10 days ago).
        await SeedHistory(ownerEmail, 1, now - TimeSpan.FromHours(1), TimeSpan.Zero);
        await SeedHistory(ownerEmail, 1, now - TimeSpan.FromDays(10), TimeSpan.Zero);

        // Ask for a 30-day window: the server must CLAMP to 48h, so the 10-day-old point is excluded.
        var from = (now - TimeSpan.FromDays(30)).ToString("o");
        var to = now.ToString("o");
        var arr = await Json(await owner.GetAsync($"/api/family/locations/history?from={Uri.EscapeDataString(from)}&to={Uri.EscapeDataString(to)}"));

        var self = HistoryFor(arr, ownerId)!;
        self.PointCount.Should().Be(1); // only the within-48h point survived the clamp
    }

    [Fact]
    public async Task History_downsamples_to_max_points_per_member()
    {
        var (ownerEmail, owner, ownerId) = await ProvisionUser("family.use", "location.self", "location.share");
        await EnsureHousehold(owner);
        await EnableAndShare(owner, share: true);

        // 1000 fixes packed into the last 6h — well over the 300 cap.
        var now = DateTime.UtcNow;
        await SeedHistory(ownerEmail, 1000, now, TimeSpan.FromHours(6));

        var arr = await Json(await owner.GetAsync("/api/family/locations/history"));
        var self = HistoryFor(arr, ownerId)!;
        self.PointCount.Should().BeLessThanOrEqualTo(300);
        self.PointCount.Should().BeGreaterThan(1); // still a usable track, not collapsed
    }
}
