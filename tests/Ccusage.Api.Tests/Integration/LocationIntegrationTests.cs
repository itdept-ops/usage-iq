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
/// GPS/location backend: the opt-in record gate (location.self + LocationEnabled), lat/lng clamping, the
/// self-scoped /me history + DELETE, the settings toggle, and the admin /admin map (location.view-all
/// required, 403 without; identity by name, never an email). Every test provisions fresh users so they're
/// order-independent. The reverse-geocoder is unconfigured-host in tests (no network), so it gracefully
/// returns null cities — that's expected and asserted as a non-failure.
/// </summary>
[Collection(IntegrationCollection.Name)]
public class LocationIntegrationTests(WebAppFactory factory)
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

    private async Task<(string email, HttpClient client)> ProvisionUser(params string[] permissions)
    {
        var email = $"loc-{Guid.NewGuid():N}@test.local";
        var res = await Admin().PostAsJsonAsync("/api/users", new { email, isEnabled = true, permissions });
        res.StatusCode.Should().Be(HttpStatusCode.Created);
        return (email, Client(email));
    }

    private static async Task<JsonElement> Json(HttpResponseMessage resp) =>
        await resp.Content.ReadFromJsonAsync<JsonElement>();

    /// <summary>Flip the caller's LocationEnabled opt-in on via the settings PATCH.</summary>
    private static async Task EnableLocation(HttpClient client)
    {
        var res = await client.PatchAsJsonAsync("/api/location/settings", new { locationEnabled = true });
        res.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    // ---- AuthN / permission gating ----

    [Fact]
    public async Task Location_endpoints_require_authentication()
    {
        var anon = factory.CreateClient();
        (await anon.GetAsync("/api/location/me")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await anon.GetAsync("/api/location/admin")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await anon.PostAsJsonAsync("/api/location", new { lat = 1.0, lng = 2.0 }))
            .StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Turning_on_household_sharing_requires_location_share()
    {
        // location.self is enough to capture + opt in; broadcasting your city to the household additionally
        // needs the explicit location.share grant.
        var (_, selfOnly) = await ProvisionUser("location.self");
        await EnableLocation(selfOnly);
        (await selfOnly.PatchAsJsonAsync("/api/location/settings", new { shareHousehold = true }))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);

        var (_, sharer) = await ProvisionUser("location.self", "location.share");
        await EnableLocation(sharer);
        (await sharer.PatchAsJsonAsync("/api/location/settings", new { shareHousehold = true }))
            .StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Record_and_me_require_location_self()
    {
        var (_, noLoc) = await ProvisionUser("dashboard.view");
        (await noLoc.GetAsync("/api/location/me")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await noLoc.PostAsJsonAsync("/api/location", new { lat = 1.0, lng = 2.0 }))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await noLoc.GetAsync("/api/location/settings")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    // ---- Opt-in gate ----

    [Fact]
    public async Task Record_requires_LocationEnabled_opt_in_first()
    {
        var (_, user) = await ProvisionUser("location.self");

        // location.self but NOT enabled yet -> 409 "enable location first".
        var blocked = await user.PostAsJsonAsync("/api/location", new { lat = 27.9, lng = -82.4, source = "manual" });
        blocked.StatusCode.Should().Be(HttpStatusCode.Conflict);

        await EnableLocation(user);

        var ok = await user.PostAsJsonAsync("/api/location", new { lat = 27.9, lng = -82.4, source = "manual" });
        ok.StatusCode.Should().Be(HttpStatusCode.OK);
        var dto = await Json(ok);
        dto.GetProperty("lat").GetDouble().Should().BeApproximately(27.9, 0.0001);
        dto.GetProperty("lng").GetDouble().Should().BeApproximately(-82.4, 0.0001);
        dto.GetProperty("source").GetString().Should().Be("manual");
    }

    // ---- Clamping ----

    [Fact]
    public async Task Record_clamps_out_of_range_lat_lng()
    {
        var (_, user) = await ProvisionUser("location.self");
        await EnableLocation(user);

        var res = await user.PostAsJsonAsync("/api/location", new { lat = 200.0, lng = -999.0, source = "weird" });
        res.StatusCode.Should().Be(HttpStatusCode.OK);
        var dto = await Json(res);
        dto.GetProperty("lat").GetDouble().Should().Be(90.0);
        dto.GetProperty("lng").GetDouble().Should().Be(-180.0);
        // An unknown source normalizes to "manual".
        dto.GetProperty("source").GetString().Should().Be("manual");
    }

    // ---- /me is self-scoped ----

    [Fact]
    public async Task Me_returns_only_the_callers_own_history()
    {
        var (_, alice) = await ProvisionUser("location.self");
        var (_, bob) = await ProvisionUser("location.self");
        await EnableLocation(alice);
        await EnableLocation(bob);

        (await alice.PostAsJsonAsync("/api/location", new { lat = 10.0, lng = 10.0 })).EnsureSuccessStatusCode();
        (await alice.PostAsJsonAsync("/api/location", new { lat = 11.0, lng = 11.0 })).EnsureSuccessStatusCode();
        (await bob.PostAsJsonAsync("/api/location", new { lat = 50.0, lng = 50.0 })).EnsureSuccessStatusCode();

        var aliceHist = await Json(await alice.GetAsync("/api/location/me"));
        aliceHist.GetArrayLength().Should().Be(2);

        var bobHist = await Json(await bob.GetAsync("/api/location/me"));
        bobHist.GetArrayLength().Should().Be(1);
        bobHist[0].GetProperty("lat").GetDouble().Should().Be(50.0);
    }

    [Fact]
    public async Task Me_limit_is_capped_and_orders_newest_first()
    {
        var (_, user) = await ProvisionUser("location.self");
        await EnableLocation(user);
        (await user.PostAsJsonAsync("/api/location", new { lat = 1.0, lng = 1.0 })).EnsureSuccessStatusCode();
        (await user.PostAsJsonAsync("/api/location", new { lat = 2.0, lng = 2.0 })).EnsureSuccessStatusCode();

        // limit=1 returns only the newest.
        var one = await Json(await user.GetAsync("/api/location/me?limit=1"));
        one.GetArrayLength().Should().Be(1);
        one[0].GetProperty("lat").GetDouble().Should().Be(2.0);
    }

    // ---- DELETE /me clears ----

    [Fact]
    public async Task Delete_me_clears_only_the_callers_history()
    {
        var (_, alice) = await ProvisionUser("location.self");
        var (_, bob) = await ProvisionUser("location.self");
        await EnableLocation(alice);
        await EnableLocation(bob);
        (await alice.PostAsJsonAsync("/api/location", new { lat = 10.0, lng = 10.0 })).EnsureSuccessStatusCode();
        (await bob.PostAsJsonAsync("/api/location", new { lat = 20.0, lng = 20.0 })).EnsureSuccessStatusCode();

        var del = await alice.DeleteAsync("/api/location/me");
        del.StatusCode.Should().Be(HttpStatusCode.OK);

        (await Json(await alice.GetAsync("/api/location/me"))).GetArrayLength().Should().Be(0);
        // Bob's history is untouched.
        (await Json(await bob.GetAsync("/api/location/me"))).GetArrayLength().Should().Be(1);
    }

    // ---- Settings toggle ----

    [Fact]
    public async Task Settings_toggle_round_trips()
    {
        // location.share too: turning ON household sharing now requires the explicit share grant.
        var (_, user) = await ProvisionUser("location.self", "location.share");

        var initial = await Json(await user.GetAsync("/api/location/settings"));
        initial.GetProperty("locationEnabled").GetBoolean().Should().BeFalse();
        initial.GetProperty("shareHousehold").GetBoolean().Should().BeFalse();

        var patched = await user.PatchAsJsonAsync("/api/location/settings",
            new { locationEnabled = true, shareHousehold = true });
        patched.StatusCode.Should().Be(HttpStatusCode.OK);
        var p = await Json(patched);
        p.GetProperty("locationEnabled").GetBoolean().Should().BeTrue();
        p.GetProperty("shareHousehold").GetBoolean().Should().BeTrue();

        // A partial patch leaves the unspecified field alone.
        var partial = await Json(await user.PatchAsJsonAsync("/api/location/settings", new { shareHousehold = false }));
        partial.GetProperty("locationEnabled").GetBoolean().Should().BeTrue();
        partial.GetProperty("shareHousehold").GetBoolean().Should().BeFalse();
    }

    // ---- Admin map ----

    [Fact]
    public async Task Admin_requires_location_view_all()
    {
        var (_, selfOnly) = await ProvisionUser("location.self");
        (await selfOnly.GetAsync("/api/location/admin")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Admin_lists_all_users_latest_and_recent_without_leaking_email()
    {
        var (aliceEmail, alice) = await ProvisionUser("location.self");
        await EnableLocation(alice);
        (await alice.PostAsJsonAsync("/api/location", new { lat = 12.34, lng = 56.78 })).EnsureSuccessStatusCode();
        (await alice.PostAsJsonAsync("/api/location", new { lat = 12.35, lng = 56.79 })).EnsureSuccessStatusCode();

        var (_, viewer) = await ProvisionUser("location.view-all");
        var res = await viewer.GetAsync("/api/location/admin");
        res.StatusCode.Should().Be(HttpStatusCode.OK);

        var raw = await res.Content.ReadAsStringAsync();
        // The raw owner email must NEVER appear in the admin payload (email-privacy; identity is id+name).
        raw.Should().NotContain(aliceEmail);

        var arr = await Json(res);
        // Find Alice's entry by her resolved user id.
        var aliceId = await UserIdFor(aliceEmail);
        JsonElement? aliceEntry = null;
        foreach (var e in arr.EnumerateArray())
            if (e.TryGetProperty("userId", out var uid) && uid.ValueKind == JsonValueKind.Number && uid.GetInt32() == aliceId)
                aliceEntry = e;

        aliceEntry.Should().NotBeNull();
        aliceEntry!.Value.GetProperty("latest").GetProperty("lat").GetDouble().Should().BeApproximately(12.35, 0.0001);
        aliceEntry!.Value.GetProperty("recent").GetArrayLength().Should().Be(2);
    }

    private async Task<int> UserIdFor(string email)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        return await db.Users.AsNoTracking().Where(u => u.Email == email).Select(u => u.Id).FirstAsync();
    }
}
