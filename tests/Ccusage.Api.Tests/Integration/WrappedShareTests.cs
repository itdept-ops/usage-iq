using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using FluentAssertions;
using Microsoft.Extensions.DependencyInjection;

namespace Ccusage.Api.Tests.Integration;

/// <summary>
/// Hub Wrapped SHARING (the public "Year in the Hub" link + the narrative endpoint). The security review hammers:
/// (1) a holder CANNOT widen the baked owner/period/whitelist; (2) sensitive cards (weight/sleep/finance) NEVER
/// appear on the public read (default-excluded + server-side filtered); (3) the public read serves the CACHED
/// narrative snapshot and makes NO live Gemini call (Gemini is unconfigured in tests, so the snapshot is the
/// deterministic floor — and it's identical on every read); (4) invalid/expired tokens → 404-indistinguishable;
/// (5) no email ever leaks; plus the narrative endpoint floors (never 503) and CRUD is owner-scoped.
/// </summary>
[Collection(IntegrationCollection.Name)]
public class WrappedShareTests(WebAppFactory factory)
{
    private HttpClient Admin() => Client(WebAppFactory.AdminEmail);

    private HttpClient Client(string email)
    {
        var c = factory.CreateClient();
        c.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", TestJwt.For(email));
        return c;
    }

    private async Task<(string email, HttpClient client)> ProvisionUser(params string[] permissions)
    {
        var email = $"wshare-{Guid.NewGuid():N}@test.local";
        var res = await Admin().PostAsJsonAsync("/api/users", new { email, isEnabled = true, permissions });
        res.StatusCode.Should().Be(HttpStatusCode.Created);
        return (email.ToLowerInvariant(), Client(email));
    }

    private static async Task<JsonElement> Json(HttpResponseMessage resp) =>
        await resp.Content.ReadFromJsonAsync<JsonElement>();

    private async Task Seed(Action<UsageDbContext, string> seed, string email)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        seed(db, email);
        await db.SaveChangesAsync();
    }

    private static readonly DateOnly Today = DisplayTzToday();
    private static readonly DateOnly ThisMonthStart = new(Today.Year, Today.Month, 1);

    private static DateOnly DisplayTzToday()
    {
        TimeZoneInfo tz;
        try { tz = TimeZoneInfo.FindSystemTimeZoneById("America/New_York"); } catch { tz = TimeZoneInfo.Utc; }
        return DateOnly.FromDateTime(TimeZoneInfo.ConvertTimeFromUtc(DateTime.UtcNow, tz));
    }

    /// <summary>Seed a user with a rich, mixed-sensitivity month: public-safe cards (workouts, coffee, usage)
    /// AND sensitive cards (weight delta, sleep). Used to prove the sensitive ones never reach the public read.</summary>
    private async Task SeedRichMonth(string email) => await Seed((db, e) =>
    {
        db.ExerciseEntries.Add(new ExerciseEntry { UserEmail = e, LocalDate = ThisMonthStart, Name = "Run", DurationMin = 30, CaloriesBurned = 300, CreatedUtc = DateTime.UtcNow });
        db.ExerciseEntries.Add(new ExerciseEntry { UserEmail = e, LocalDate = Today, Name = "Lift", DurationMin = 45, CaloriesBurned = 200, CreatedUtc = DateTime.UtcNow });
        db.CoffeeEntries.Add(new CoffeeEntry { UserEmail = e, LocalDate = ThisMonthStart, Cups = 12, CreatedUtc = DateTime.UtcNow });
        // Sensitive: weight delta + sleep.
        db.WeightEntries.Add(new WeightEntry { UserEmail = e, LocalDate = ThisMonthStart, WeightKg = 90.0, CreatedUtc = DateTime.UtcNow });
        db.WeightEntries.Add(new WeightEntry { UserEmail = e, LocalDate = Today, WeightKg = 86.0, CreatedUtc = DateTime.UtcNow });
        db.SleepEntries.Add(new SleepEntry { UserEmail = e, LocalDate = ThisMonthStart, Hours = 7.5m, Quality = 4, CreatedUtc = DateTime.UtcNow });
        // Sensitive: a settled bill (finance).
        db.Bills.Add(new Bill { OwnerEmail = e, Title = "Dinner", CreatedUtc = DateTime.UtcNow, Status = "settled" });
    }, email);

    // =====================================================================================
    // Narrative endpoint — gating + floor (never 503)
    // =====================================================================================

    [Fact]
    public async Task Narrative_requires_authentication()
    {
        var anon = factory.CreateClient();
        (await anon.GetAsync("/api/wrapped/narrative")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Narrative_requires_tracker_self()
    {
        var (_, noTracker) = await ProvisionUser("dashboard.view");
        (await noTracker.GetAsync("/api/wrapped/narrative?period=year")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Narrative_floors_to_plain_when_ai_unconfigured_and_never_503s()
    {
        // tracker.self only (no tracker.ai) — and Gemini is unconfigured in tests anyway → deterministic floor.
        var (email, user) = await ProvisionUser("tracker.self");
        await SeedRichMonth(email);

        var resp = await user.GetAsync("/api/wrapped/narrative?period=month");
        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var root = await Json(resp);
        root.GetProperty("fellBackToPlain").GetBoolean().Should().BeTrue();
        root.GetProperty("narrative").GetString().Should().NotBeNullOrWhiteSpace();
    }

    // =====================================================================================
    // Create CRUD — owner-scoped; gated by shares.manage
    // =====================================================================================

    [Fact]
    public async Task Create_requires_shares_manage()
    {
        var (_, user) = await ProvisionUser("tracker.self"); // no shares.manage
        var resp = await user.PostAsJsonAsync("/api/wrapped/shares", new { period = "month" });
        resp.StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Create_returns_token_once_and_w_path()
    {
        var (email, user) = await ProvisionUser("tracker.self", "shares.manage", "shares.view");
        await SeedRichMonth(email);

        var created = await Json(await user.PostAsJsonAsync("/api/wrapped/shares", new { period = "month", label = "My month" }));
        created.GetProperty("token").GetString().Should().NotBeNullOrWhiteSpace();
        created.GetProperty("path").GetString().Should().StartWith("/w/");
    }

    // =====================================================================================
    // INVARIANT 1 — the holder cannot widen the baked scope (owner / period / whitelist)
    // =====================================================================================

    [Fact]
    public async Task Holder_cannot_widen_whitelist_to_include_a_sensitive_card()
    {
        var (email, user) = await ProvisionUser("tracker.self", "shares.manage");
        await SeedRichMonth(email);

        // Try to FORCE sensitive cards into the whitelist via the create body — they must be dropped server-side.
        var created = await Json(await user.PostAsJsonAsync("/api/wrapped/shares", new
        {
            period = "month",
            cardKeys = new[] { "workouts", "weight-delta", "sleep", "bills", "coffee" },
        }));
        var token = created.GetProperty("token").GetString();

        var anon = factory.CreateClient();
        var pub = await Json(await anon.GetAsync($"/api/share/wrapped/{token}"));
        var keys = pub.GetProperty("cards").EnumerateArray().Select(c => c.GetProperty("key").GetString()).ToList();
        keys.Should().Contain("workouts").And.Contain("coffee");
        keys.Should().NotContain("weight-delta").And.NotContain("sleep").And.NotContain("bills",
            "sensitive cards can never be added to a public Wrapped link");
    }

    // =====================================================================================
    // INVARIANT 1/2 — sensitive cards NEVER appear on the public read (default-excluded)
    // =====================================================================================

    [Fact]
    public async Task Public_read_never_exposes_sensitive_cards_by_default()
    {
        var (email, user) = await ProvisionUser("tracker.self", "shares.manage");
        await SeedRichMonth(email);

        var created = await Json(await user.PostAsJsonAsync("/api/wrapped/shares", new { period = "month" }));
        var token = created.GetProperty("token").GetString();

        var anon = factory.CreateClient();
        var resp = await anon.GetAsync($"/api/share/wrapped/{token}");
        resp.StatusCode.Should().Be(HttpStatusCode.OK);

        var raw = await resp.Content.ReadAsStringAsync();
        // The sensitive card keys must be wholly absent from the public payload.
        raw.Should().NotContain("weight-delta").And.NotContain("\"sleep\"").And.NotContain("\"bills\"");

        var pub = JsonDocument.Parse(raw).RootElement;
        var keys = pub.GetProperty("cards").EnumerateArray().Select(c => c.GetProperty("key").GetString()).ToList();
        keys.Should().Contain("workouts", "public-safe cards still appear");
        keys.Should().NotIntersectWith(new[] { "weight-delta", "sleep", "bills" });
    }

    // =====================================================================================
    // INVARIANT 2 — the public read serves the CACHED snapshot (no live Gemini call)
    // =====================================================================================

    [Fact]
    public async Task Public_read_serves_the_frozen_narrative_snapshot_unchanged()
    {
        var (email, user) = await ProvisionUser("tracker.self", "shares.manage");
        await SeedRichMonth(email);

        var created = await Json(await user.PostAsJsonAsync("/api/wrapped/shares", new { period = "month" }));
        var token = created.GetProperty("token").GetString();

        var anon = factory.CreateClient();
        var first = (await Json(await anon.GetAsync($"/api/share/wrapped/{token}"))).GetProperty("narrative").GetString();
        var second = (await Json(await anon.GetAsync($"/api/share/wrapped/{token}"))).GetProperty("narrative").GetString();

        first.Should().NotBeNullOrWhiteSpace();
        second.Should().Be(first, "the public path serves the FROZEN snapshot, not a fresh per-request narration");
    }

    // =====================================================================================
    // INVARIANT 4 — invalid / expired → 404-indistinguishable
    // =====================================================================================

    [Fact]
    public async Task Invalid_token_is_404()
    {
        var anon = factory.CreateClient();
        (await anon.GetAsync("/api/share/wrapped/not-a-real-token")).StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task Expired_link_is_404_indistinguishable_from_invalid()
    {
        var (email, user) = await ProvisionUser("tracker.self", "shares.manage");
        await SeedRichMonth(email);

        var created = await Json(await user.PostAsJsonAsync("/api/wrapped/shares", new { period = "month", expiresInHours = 1 }));
        var token = created.GetProperty("token").GetString();
        var id = created.GetProperty("id").GetInt32();

        // Force-expire the link directly in the DB.
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
            var link = db.WrappedShareLinks.Single(s => s.Id == id);
            link.ExpiresUtc = DateTime.UtcNow.AddMinutes(-5);
            await db.SaveChangesAsync();
        }

        var anon = factory.CreateClient();
        (await anon.GetAsync($"/api/share/wrapped/{token}")).StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    // =====================================================================================
    // INVARIANT 5 — no email leaks; owner exposed as a display name
    // =====================================================================================

    [Fact]
    public async Task Public_read_carries_no_email_and_an_owner_display_name()
    {
        var (email, user) = await ProvisionUser("tracker.self", "shares.manage");
        await SeedRichMonth(email);

        var created = await Json(await user.PostAsJsonAsync("/api/wrapped/shares", new { period = "month" }));
        var token = created.GetProperty("token").GetString();

        var anon = factory.CreateClient();
        var resp = await anon.GetAsync($"/api/share/wrapped/{token}");
        var raw = await resp.Content.ReadAsStringAsync();
        raw.Should().NotContain("@", "no email may appear on the public Wrapped read");
        raw.Should().NotContain(email);

        var pub = JsonDocument.Parse(raw).RootElement;
        pub.GetProperty("ownerName").GetString().Should().NotBeNullOrWhiteSpace();
        pub.GetProperty("ownerName").GetString().Should().NotContain("@");
    }

    // =====================================================================================
    // Owner-scoping — another user can't see / mutate your share; access log is owner-only
    // =====================================================================================

    [Fact]
    public async Task A_share_is_not_listed_or_mutable_by_another_user()
    {
        var (mineEmail, mine) = await ProvisionUser("tracker.self", "shares.manage", "shares.view");
        await SeedRichMonth(mineEmail);
        var created = await Json(await mine.PostAsJsonAsync("/api/wrapped/shares", new { period = "month" }));
        var id = created.GetProperty("id").GetInt32();

        var (_, other) = await ProvisionUser("tracker.self", "shares.manage", "shares.view");

        // Not in the other user's list.
        var theirList = await Json(await other.GetAsync("/api/wrapped/shares"));
        theirList.EnumerateArray().Select(s => s.GetProperty("id").GetInt32()).Should().NotContain(id);

        // Can't delete or read accesses for someone else's share.
        (await other.DeleteAsync($"/api/wrapped/shares/{id}")).StatusCode.Should().Be(HttpStatusCode.NotFound);
        (await other.GetAsync($"/api/wrapped/shares/{id}/accesses")).StatusCode.Should().Be(HttpStatusCode.NotFound);

        // The owner still sees it.
        var myList = await Json(await mine.GetAsync("/api/wrapped/shares"));
        myList.EnumerateArray().Select(s => s.GetProperty("id").GetInt32()).Should().Contain(id);
    }
}
