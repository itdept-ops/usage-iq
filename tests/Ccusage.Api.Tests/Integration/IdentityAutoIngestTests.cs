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
/// Family Hub — Identity Map AUTO-INGEST (GET /api/family/identity/suggest + POST /api/family/identity/auto/apply).
/// The map is OWNER/SELF-scoped, so auto-ingest derives the CALLER's OWN recent Hub activity into time signals
/// (workouts = real minutes; completed chores = an estimate) and, on Apply, writes them as idempotent Auto rows.
///
/// <list type="bullet">
///   <item>GATING: both endpoints require identity.map (403 without) and auth (401 unauthenticated).</item>
///   <item>DERIVATION MATH: workout minutes sum exactly; chore points × the fixed proxy; only &gt; 0 signals appear.</item>
///   <item>SELF + HOUSEHOLD SCOPE: only the caller's OWN workouts, and only the caller's OWN completions of chores
///   in the caller's OWN household — never another member's, never another household's.</item>
///   <item>NO LEAK: no email or sensitive field appears in the suggest payload.</item>
///   <item>APPLY: writes Auto rows that show up in the map aggregate; re-applying the same window is idempotent
///   (Refresh→Apply never double-counts); the server re-derives minutes (client minutes are not trusted).</item>
///   <item>APPLY OWNERSHIP: a confirmed role the caller doesn't own is skipped.</item>
/// </list>
/// </summary>
[Collection(IntegrationCollection.Name)]
public class IdentityAutoIngestTests(WebAppFactory factory)
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

    private async Task<(string email, HttpClient client, int id)> ProvisionUser(params string[] permissions)
    {
        var email = $"autoid-{Guid.NewGuid():N}@test.local";
        var res = await Admin().PostAsJsonAsync("/api/users", new { email, isEnabled = true, permissions });
        res.StatusCode.Should().Be(HttpStatusCode.Created);
        var id = (await Json(res)).GetProperty("id").GetInt32();
        return (email, Client(email), id);
    }

    private static async Task<JsonElement> Json(HttpResponseMessage resp) =>
        await resp.Content.ReadFromJsonAsync<JsonElement>();

    private async Task<int> CreateRole(HttpClient client, string name, string color = "#3d8bff")
    {
        var res = await client.PostAsJsonAsync("/api/family/identity/roles", new { name, color });
        res.StatusCode.Should().Be(HttpStatusCode.OK);
        return (await Json(res)).GetProperty("id").GetInt32();
    }

    private async Task<int> HouseholdIdFor(int userId)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        return await db.HouseholdMembers.AsNoTracking().Where(m => m.UserId == userId)
            .Select(m => m.HouseholdId).FirstAsync();
    }

    private async Task SeedWorkout(string email, DateOnly date, int? durationMin, int calories = 0)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        db.ExerciseEntries.Add(new ExerciseEntry
        {
            UserEmail = email.ToLowerInvariant(),
            LocalDate = date,
            Name = "Run",
            DurationMin = durationMin,
            CaloriesBurned = calories,
            CreatedUtc = DateTime.UtcNow,
        });
        await db.SaveChangesAsync();
    }

    /// <summary>Seed a household chore + one completion by <paramref name="byUserId"/>. Returns nothing — the
    /// completion feeds the chore signal.</summary>
    private async Task SeedChoreCompletion(int householdId, int byUserId, int points, DateTime atUtc)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        var chore = new FamilyChore
        {
            HouseholdId = householdId,
            Title = "Dishes",
            Points = points,
            CreatedByUserId = byUserId,
            CreatedUtc = atUtc,
        };
        db.FamilyChores.Add(chore);
        await db.SaveChangesAsync();
        db.FamilyChoreCompletions.Add(new FamilyChoreCompletion
        {
            ChoreId = chore.Id,
            ByUserId = byUserId,
            Points = points,
            AtUtc = atUtc,
        });
        await db.SaveChangesAsync();
    }

    private static List<JsonElement> Signals(JsonElement body) =>
        body.GetProperty("signals").EnumerateArray().ToList();

    private static int MinutesOf(List<JsonElement> signals, string key) =>
        signals.Single(s => s.GetProperty("key").GetString() == key).GetProperty("minutes").GetInt32();

    private const string Window = "?fromUtc=2026-06-01T00:00:00Z&toUtc=2026-06-30T00:00:00Z";

    // =====================================================================================
    // GATING
    // =====================================================================================

    [Fact]
    public async Task Auto_ingest_endpoints_require_identity_map()
    {
        var (_, plain, _) = await ProvisionUser("family.use"); // family.use is NOT enough
        (await plain.GetAsync("/api/family/identity/suggest")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await plain.PostAsJsonAsync("/api/family/identity/auto/apply", new { items = Array.Empty<object>() }))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Auto_ingest_endpoints_require_authentication()
    {
        var anon = factory.CreateClient();
        (await anon.GetAsync("/api/family/identity/suggest")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await anon.PostAsJsonAsync("/api/family/identity/auto/apply", new { items = Array.Empty<object>() }))
            .StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    // =====================================================================================
    // DERIVATION MATH — workouts sum exactly, chores use the fixed proxy, only > 0 surfaces
    // =====================================================================================

    [Fact]
    public async Task Workout_minutes_sum_into_a_real_signal()
    {
        var (email, owner, _) = await ProvisionUser("identity.map");
        await SeedWorkout(email, new DateOnly(2026, 6, 10), 30);
        await SeedWorkout(email, new DateOnly(2026, 6, 12), 45);
        await SeedWorkout(email, new DateOnly(2026, 6, 13), null); // null duration ignored

        var body = await Json(await owner.GetAsync($"/api/family/identity/suggest{Window}"));
        var signals = Signals(body);
        MinutesOf(signals, "workouts").Should().Be(75); // 30 + 45; the null is skipped
        signals.Single(s => s.GetProperty("key").GetString() == "workouts")
            .GetProperty("estimated").GetBoolean().Should().BeFalse(); // real minutes, not an estimate
        // No chore household → no chore signal at all.
        signals.Should().ContainSingle();
    }

    [Fact]
    public async Task Chore_points_become_an_estimated_signal_at_the_fixed_proxy()
    {
        var (_, owner, ownerId) = await ProvisionUser("identity.map", "family.use");
        await owner.GetAsync("/api/family/household"); // auto-provision the caller's household
        var householdId = await HouseholdIdFor(ownerId);
        // 2 points + 3 points = 5 ⭐ → 5 × 15 = 75 minutes.
        await SeedChoreCompletion(householdId, ownerId, 2, new DateTime(2026, 6, 10, 12, 0, 0, DateTimeKind.Utc));
        await SeedChoreCompletion(householdId, ownerId, 3, new DateTime(2026, 6, 11, 12, 0, 0, DateTimeKind.Utc));

        var body = await Json(await owner.GetAsync($"/api/family/identity/suggest{Window}"));
        var signals = Signals(body);
        MinutesOf(signals, "chores").Should().Be(75);
        signals.Single(s => s.GetProperty("key").GetString() == "chores")
            .GetProperty("estimated").GetBoolean().Should().BeTrue();
    }

    [Fact]
    public async Task Suggest_is_empty_when_there_is_no_recent_activity()
    {
        var (_, owner, _) = await ProvisionUser("identity.map");
        var body = await Json(await owner.GetAsync($"/api/family/identity/suggest{Window}"));
        Signals(body).Should().BeEmpty();
    }

    // =====================================================================================
    // SCOPE — only the caller's OWN workouts; only the caller's OWN completions in their OWN household
    // =====================================================================================

    [Fact]
    public async Task Another_members_chore_completion_is_NOT_attributed_to_the_caller()
    {
        var (_, owner, ownerId) = await ProvisionUser("identity.map", "family.use");
        var (_, _, bobId) = await ProvisionUser("identity.map", "family.use");
        await owner.GetAsync("/api/family/household");
        await owner.PostAsJsonAsync("/api/family/household/members", new { userId = bobId });
        var householdId = await HouseholdIdFor(ownerId);

        // Owner did 1 point; Bob (same household) did 10 points. Owner's signal must reflect ONLY owner's 1.
        await SeedChoreCompletion(householdId, ownerId, 1, new DateTime(2026, 6, 10, 12, 0, 0, DateTimeKind.Utc));
        await SeedChoreCompletion(householdId, bobId, 10, new DateTime(2026, 6, 10, 12, 0, 0, DateTimeKind.Utc));

        var body = await Json(await owner.GetAsync($"/api/family/identity/suggest{Window}"));
        MinutesOf(Signals(body), "chores").Should().Be(15); // 1 ⭐ × 15 — Bob's 10 are excluded
    }

    [Fact]
    public async Task Another_households_chore_completion_is_NOT_visible()
    {
        // Two separate households. The caller's completion lives in another household and must never count.
        var (_, owner, ownerId) = await ProvisionUser("identity.map", "family.use");
        await owner.GetAsync("/api/family/household");
        var ownHouseholdId = await HouseholdIdFor(ownerId);

        var (_, stranger, strangerId) = await ProvisionUser("identity.map", "family.use");
        await stranger.GetAsync("/api/family/household");
        var foreignHouseholdId = await HouseholdIdFor(strangerId);

        // Attribute a completion to the OWNER but on a chore in the STRANGER's household — must be excluded
        // because the derivation only reads chores in the caller's OWN household.
        await SeedChoreCompletion(foreignHouseholdId, ownerId, 8, new DateTime(2026, 6, 10, 12, 0, 0, DateTimeKind.Utc));
        // And one legit completion in the owner's own household.
        await SeedChoreCompletion(ownHouseholdId, ownerId, 2, new DateTime(2026, 6, 11, 12, 0, 0, DateTimeKind.Utc));

        var body = await Json(await owner.GetAsync($"/api/family/identity/suggest{Window}"));
        MinutesOf(Signals(body), "chores").Should().Be(30); // only the 2 ⭐ in the owner's household × 15
    }

    [Fact]
    public async Task Another_users_workout_is_NOT_attributed_to_the_caller()
    {
        var (email, owner, _) = await ProvisionUser("identity.map");
        var (otherEmail, _, _) = await ProvisionUser("identity.map");
        await SeedWorkout(email, new DateOnly(2026, 6, 10), 20);
        await SeedWorkout(otherEmail, new DateOnly(2026, 6, 10), 999); // a different user's workout

        var body = await Json(await owner.GetAsync($"/api/family/identity/suggest{Window}"));
        MinutesOf(Signals(body), "workouts").Should().Be(20); // only the caller's own 20
    }

    [Fact]
    public async Task Suggest_payload_leaks_no_email_or_sensitive_field()
    {
        var (email, owner, _) = await ProvisionUser("identity.map");
        await SeedWorkout(email, new DateOnly(2026, 6, 10), 30);
        var raw = await (await owner.GetAsync($"/api/family/identity/suggest{Window}")).Content.ReadAsStringAsync();
        raw.Should().NotContain(email);
        raw.Should().NotContain("@");
        raw.ToLowerInvariant().Should().NotContain("cycle");
        raw.ToLowerInvariant().Should().NotContain("intimacy");
    }

    // =====================================================================================
    // APPLY — writes Auto rows; idempotent re-apply; server re-derives; role ownership
    // =====================================================================================

    [Fact]
    public async Task Apply_writes_the_derived_minutes_into_the_map_and_is_idempotent()
    {
        var (email, owner, _) = await ProvisionUser("identity.map");
        var athlete = await CreateRole(owner, "Athlete", "#22c55e");
        await SeedWorkout(email, new DateOnly(2026, 6, 10), 40);
        await SeedWorkout(email, new DateOnly(2026, 6, 12), 20);

        var payload = new { items = new[] { new { key = "workouts", roleId = athlete } }, fromUtc = "2026-06-01T00:00:00Z", toUtc = "2026-06-30T00:00:00Z" };

        var first = await Json(await owner.PostAsJsonAsync("/api/family/identity/auto/apply", payload));
        first.GetProperty("imported").GetInt32().Should().Be(1);
        first.GetProperty("skipped").GetInt32().Should().Be(0);

        // It shows up in the map aggregate as 60 minutes against the Athlete role.
        var map = await Json(await owner.GetAsync($"/api/family/identity/{Window}"));
        var totals = map.GetProperty("totals").EnumerateArray().ToList();
        totals.Single(t => t.GetProperty("roleId").GetInt32() == athlete)
            .GetProperty("minutes").GetInt32().Should().Be(60);

        // RE-APPLY the same window → idempotent: imported 0, skipped 1, aggregate UNCHANGED.
        var second = await Json(await owner.PostAsJsonAsync("/api/family/identity/auto/apply", payload));
        second.GetProperty("imported").GetInt32().Should().Be(0);
        second.GetProperty("skipped").GetInt32().Should().Be(1);

        var map2 = await Json(await owner.GetAsync($"/api/family/identity/{Window}"));
        map2.GetProperty("totals").EnumerateArray()
            .Single(t => t.GetProperty("roleId").GetInt32() == athlete)
            .GetProperty("minutes").GetInt32().Should().Be(60);
    }

    [Fact]
    public async Task Apply_re_derives_minutes_and_ignores_an_unknown_or_foreign_role()
    {
        var (email, owner, _) = await ProvisionUser("identity.map");
        var (_, other, _) = await ProvisionUser("identity.map");
        var athlete = await CreateRole(owner, "Athlete", "#22c55e");
        var foreign = await CreateRole(other, "Stranger");
        await SeedWorkout(email, new DateOnly(2026, 6, 10), 50);

        var payload = new
        {
            items = new[]
            {
                new { key = "workouts", roleId = foreign },   // not owned → skipped
                new { key = "nonsense", roleId = athlete },   // no such signal → skipped
            },
            fromUtc = "2026-06-01T00:00:00Z", toUtc = "2026-06-30T00:00:00Z",
        };
        var res = await Json(await owner.PostAsJsonAsync("/api/family/identity/auto/apply", payload));
        res.GetProperty("imported").GetInt32().Should().Be(0);
        res.GetProperty("skipped").GetInt32().Should().Be(2);

        // Nothing landed against the athlete role.
        var map = await Json(await owner.GetAsync($"/api/family/identity/{Window}"));
        map.GetProperty("totals").GetArrayLength().Should().Be(0);
    }
}
