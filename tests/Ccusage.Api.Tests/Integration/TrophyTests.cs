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
/// The Trophy Wall (/api/trophies): auth (401) + tracker.self (403) gating; badges DERIVED from the caller's own
/// existing tracker/bills data with correct earned/locked tiers + progress; STRICT own-data scoping (another
/// user's workouts/bills never inflate the caller's badges); and NO email anywhere in the DTO. Every test
/// provisions fresh users so they're order-independent.
/// </summary>
[Collection(IntegrationCollection.Name)]
public class TrophyTests(WebAppFactory factory)
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
        var email = $"trophy-{Guid.NewGuid():N}@test.local";
        var res = await Admin().PostAsJsonAsync("/api/users", new { email, isEnabled = true, permissions });
        res.StatusCode.Should().Be(HttpStatusCode.Created);
        return (email.ToLowerInvariant(), Client(email));
    }

    private static async Task<JsonElement> Json(HttpResponseMessage resp) =>
        await resp.Content.ReadFromJsonAsync<JsonElement>();

    private static JsonElement Badge(JsonElement root, string id) =>
        root.GetProperty("badges").EnumerateArray().First(b => b.GetProperty("id").GetString() == id);

    private async Task Seed(Action<UsageDbContext, string> seed, string email)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        seed(db, email);
        await db.SaveChangesAsync();
    }

    private static readonly string Today = DateTime.UtcNow.ToString("yyyy-MM-dd");

    // ---- Gating ----

    [Fact]
    public async Task Trophies_requires_authentication()
    {
        var anon = factory.CreateClient();
        (await anon.GetAsync("/api/trophies")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Trophies_requires_tracker_self()
    {
        var (_, noTracker) = await ProvisionUser("dashboard.view");
        (await noTracker.GetAsync("/api/trophies")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    // ---- Empty wall ----

    [Fact]
    public async Task Fresh_user_has_all_badges_locked()
    {
        var (_, user) = await ProvisionUser("tracker.self");
        var root = await Json(await user.GetAsync("/api/trophies"));

        root.GetProperty("earnedCount").GetInt32().Should().Be(0);
        root.GetProperty("totalCount").GetInt32().Should().Be(12);
        foreach (var b in root.GetProperty("badges").EnumerateArray())
        {
            b.GetProperty("earned").GetBoolean().Should().BeFalse();
            b.GetProperty("tier").GetString().Should().Be("none");
            b.GetProperty("value").GetDecimal().Should().Be(0);
        }
    }

    // ---- Derivation + thresholds ----

    [Fact]
    public async Task Workouts_badge_earns_bronze_at_ten_with_progress_to_silver()
    {
        var (email, user) = await ProvisionUser("tracker.self");
        await Seed((db, e) =>
        {
            for (var i = 0; i < 10; i++)
                db.ExerciseEntries.Add(new ExerciseEntry
                {
                    UserEmail = e, LocalDate = DateOnly.Parse(Today), Name = "Run",
                    DurationMin = 30, CreatedUtc = DateTime.UtcNow,
                });
        }, email);

        var root = await Json(await user.GetAsync("/api/trophies"));
        var b = Badge(root, "workouts");
        b.GetProperty("value").GetDecimal().Should().Be(10);
        b.GetProperty("earned").GetBoolean().Should().BeTrue();
        b.GetProperty("tier").GetString().Should().Be("bronze");
        b.GetProperty("nextTier").GetProperty("name").GetString().Should().Be("silver");
        b.GetProperty("progressToNext").GetDouble().Should().BeApproximately(10.0 / 50.0, 1e-6);
        root.GetProperty("earnedCount").GetInt32().Should().Be(1);
    }

    [Fact]
    public async Task Bills_settled_counts_only_settled_owner_bills()
    {
        var (email, user) = await ProvisionUser("tracker.self");
        await Seed((db, e) =>
        {
            db.Bills.Add(new Bill { OwnerEmail = e, Title = "A", Status = "settled", CreatedUtc = DateTime.UtcNow });
            db.Bills.Add(new Bill { OwnerEmail = e, Title = "B", Status = "open", CreatedUtc = DateTime.UtcNow });
        }, email);

        var b = Badge(await Json(await user.GetAsync("/api/trophies")), "bills-settled");
        b.GetProperty("value").GetDecimal().Should().Be(1); // only the settled one
        b.GetProperty("earned").GetBoolean().Should().BeTrue(); // bronze threshold is 1
        b.GetProperty("tier").GetString().Should().Be("bronze");
    }

    // ---- Own-data scoping ----

    [Fact]
    public async Task Another_users_data_never_inflates_the_callers_badges()
    {
        var (mineEmail, me) = await ProvisionUser("tracker.self");
        var (theirsEmail, _) = await ProvisionUser("tracker.self");

        // Seed the OTHER user with lots of activity; the caller has none.
        await Seed((db, e) =>
        {
            for (var i = 0; i < 100; i++)
                db.ExerciseEntries.Add(new ExerciseEntry
                {
                    UserEmail = e, LocalDate = DateOnly.Parse(Today), Name = "Run",
                    DurationMin = 30, CreatedUtc = DateTime.UtcNow,
                });
            db.CoffeeEntries.Add(new CoffeeEntry { UserEmail = e, LocalDate = DateOnly.Parse(Today), Cups = 500, CreatedUtc = DateTime.UtcNow });
            db.Bills.Add(new Bill { OwnerEmail = e, Title = "X", Status = "settled", CreatedUtc = DateTime.UtcNow });
        }, theirsEmail);

        var root = await Json(await me.GetAsync("/api/trophies"));
        root.GetProperty("earnedCount").GetInt32().Should().Be(0);
        Badge(root, "workouts").GetProperty("value").GetDecimal().Should().Be(0);
        Badge(root, "coffee").GetProperty("value").GetDecimal().Should().Be(0);
        Badge(root, "bills-settled").GetProperty("value").GetDecimal().Should().Be(0);
    }

    // ---- Privacy: no email on the wire ----

    [Fact]
    public async Task Response_carries_no_email_anywhere()
    {
        var (email, user) = await ProvisionUser("tracker.self");
        await Seed((db, e) =>
            db.CoffeeEntries.Add(new CoffeeEntry { UserEmail = e, LocalDate = DateOnly.Parse(Today), Cups = 12, CreatedUtc = DateTime.UtcNow }),
            email);

        var raw = await (await user.GetAsync("/api/trophies")).Content.ReadAsStringAsync();
        raw.Should().NotContain("@");
        raw.Should().NotContain(email);
    }
}
