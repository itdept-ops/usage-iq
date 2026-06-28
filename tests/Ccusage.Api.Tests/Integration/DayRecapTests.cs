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
/// The Day Recap (GET /api/ai/day-recap): auth (401) + tracker.self (403) gating; the DETERMINISTIC
/// always-200 timeline floor; the AI-OFF degradation (timeline present, narrative null — the test host has
/// no Gemini key); STRICT owner-scoping (another user's day NEVER appears in the caller's recap); PER-DOMAIN
/// permission gating (a domain the caller LACKS the perm for is excluded); no email/PII on the wire; and the
/// recap WRITES NOTHING. Every test provisions fresh users so they're order-independent.
/// </summary>
[Collection(IntegrationCollection.Name)]
public class DayRecapTests(WebAppFactory factory)
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
        var email = $"dayrecap-{Guid.NewGuid():N}@test.local";
        var res = await Admin().PostAsJsonAsync("/api/users", new { email, isEnabled = true, permissions });
        res.StatusCode.Should().Be(HttpStatusCode.Created);
        return (email.ToLowerInvariant(), Client(email));
    }

    private static async Task<JsonElement> Json(HttpResponseMessage resp) =>
        await resp.Content.ReadFromJsonAsync<JsonElement>();

    private async Task Seed(Action<UsageDbContext> seed)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        seed(db);
        await db.SaveChangesAsync();
    }

    // Anchor off the display tz (mirrors InsightsTests) so seeded rows land on the resolved local date.
    private static readonly DateOnly Today = DisplayTzToday();
    private static DateOnly DisplayTzToday()
    {
        TimeZoneInfo tz;
        try { tz = TimeZoneInfo.FindSystemTimeZoneById("America/New_York"); } catch { tz = TimeZoneInfo.Utc; }
        return DateOnly.FromDateTime(TimeZoneInfo.ConvertTimeFromUtc(DateTime.UtcNow, tz));
    }

    private static string Date(DateOnly d) => d.ToString("yyyy-MM-dd");

    // ---- Gating ----

    [Fact]
    public async Task DayRecap_requires_authentication()
    {
        var anon = factory.CreateClient();
        (await anon.GetAsync("/api/ai/day-recap")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task DayRecap_requires_tracker_self()
    {
        var (_, noTracker) = await ProvisionUser("dashboard.view");
        (await noTracker.GetAsync("/api/ai/day-recap")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    // ---- Happy path: a logged day yields a chronological timeline + stats + highlights ----

    [Fact]
    public async Task Logged_day_returns_timeline_stats_and_highlights()
    {
        var (email, user) = await ProvisionUser("tracker.self");
        await Seed(db =>
        {
            db.FoodEntries.Add(new FoodEntry
            { UserEmail = email, LocalDate = Today, Description = "Oatmeal", Calories = 350, ProteinG = 12 });
            db.ExerciseEntries.Add(new ExerciseEntry
            { UserEmail = email, LocalDate = Today, Name = "Running", DurationMin = 30, CaloriesBurned = 300 });
            db.SleepEntries.Add(new SleepEntry
            { UserEmail = email, LocalDate = Today, Hours = 7.5m, Quality = 4 });
            db.HydrationEntries.Add(new HydrationEntry
            { UserEmail = email, LocalDate = Today, AmountMl = 2000 });
        });

        var root = await Json(await user.GetAsync($"/api/ai/day-recap?date={Date(Today)}"));
        root.GetProperty("date").GetString().Should().Be(Date(Today));
        root.GetProperty("timeline").EnumerateArray().Should().NotBeEmpty();
        root.GetProperty("highlights").EnumerateArray().Should().NotBeEmpty();
        // The deterministic stats rollup is populated from the logged domains.
        var stats = root.GetProperty("stats");
        stats.GetProperty("caloriesIn").GetInt32().Should().Be(350);
        stats.GetProperty("exerciseCalories").GetInt32().Should().Be(300);
        stats.GetProperty("sleepHours").GetDouble().Should().BeApproximately(7.5, 0.01);
        stats.GetProperty("recoveryScore").ValueKind.Should().NotBe(JsonValueKind.Null);
        root.GetProperty("domainsIncluded").EnumerateArray()
            .Select(d => d.GetString()).Should().Contain("tracker");
        // No email anywhere on the wire.
        root.GetRawText().Should().NotContain("@");
    }

    // ---- AI-off degradation: timeline present, narrative null (Gemini unconfigured in the test host) ----

    [Fact]
    public async Task Ai_off_returns_timeline_with_null_narrative_never_503()
    {
        // tracker.ai is present, but Gemini is OFF in the test host -> the narrative floors to null and the
        // deterministic timeline still returns (never a 503).
        var (email, user) = await ProvisionUser("tracker.self", "tracker.ai");
        await Seed(db => db.FoodEntries.Add(new FoodEntry
        { UserEmail = email, LocalDate = Today, Description = "Lunch", Calories = 620, ProteinG = 30 }));

        var res = await user.GetAsync($"/api/ai/day-recap?date={Date(Today)}");
        res.StatusCode.Should().Be(HttpStatusCode.OK);
        var root = await Json(res);
        root.GetProperty("narrative").ValueKind.Should().Be(JsonValueKind.Null);
        root.GetProperty("timeline").EnumerateArray().Should().NotBeEmpty();
    }

    // ---- Per-domain perm gate: a domain the caller LACKS the perm for is EXCLUDED ----

    [Fact]
    public async Task Finance_spend_is_excluded_without_family_finance_perm()
    {
        // A tracker.self-only caller in a household with an expense that day: WITHOUT family.finance the finance
        // domain must NOT appear, even though the household row exists.
        var (email, user) = await ProvisionUser("tracker.self");

        await Seed(db =>
        {
            // Anchor a tracker row so the day has a timeline at all.
            db.FoodEntries.Add(new FoodEntry
            { UserEmail = email, LocalDate = Today, Description = "Dinner", Calories = 700, ProteinG = 35 });

            var uid = db.Users.First(u => u.Email == email).Id;
            var hh = new Household { Name = "H", CreatedByUserId = uid };
            db.Households.Add(hh);
            db.SaveChanges();
            db.HouseholdMembers.Add(new HouseholdMember { HouseholdId = hh.Id, UserId = uid, Role = "owner" });
            db.FinanceAccounts.Add(new FinanceAccount { HouseholdId = hh.Id, Name = "Checking" });
            db.SaveChanges();
            var acctId = db.FinanceAccounts.First(a => a.HouseholdId == hh.Id).Id;
            db.FinanceTransactions.Add(new FinanceTransaction
            {
                HouseholdId = hh.Id, AccountId = acctId, Date = Today, Merchant = "Store",
                Magnitude = 42m, RawAmount = -42m, Kind = "expense", DedupHash = Guid.NewGuid().ToString("N"),
            });
        });

        var root = await Json(await user.GetAsync($"/api/ai/day-recap?date={Date(Today)}"));
        root.GetProperty("domainsIncluded").EnumerateArray()
            .Select(d => d.GetString()).Should().NotContain("finance");
        root.GetProperty("stats").GetProperty("spendUsd").ValueKind.Should().Be(JsonValueKind.Null);
        // The expense amount must not leak into the timeline either.
        root.GetRawText().Should().NotContain("42.00");
    }

    // ---- Owner-scoping: another user's day NEVER appears in the caller's recap ----

    [Fact]
    public async Task Another_users_day_never_appears()
    {
        var (mineEmail, me) = await ProvisionUser("tracker.self");
        var (otherEmail, _) = await ProvisionUser("tracker.self");

        // I log nothing; the OTHER user logs a full day.
        await Seed(db =>
        {
            db.FoodEntries.Add(new FoodEntry
            { UserEmail = otherEmail, LocalDate = Today, Description = "SecretMeal", Calories = 999, ProteinG = 50 });
            db.SleepEntries.Add(new SleepEntry
            { UserEmail = otherEmail, LocalDate = Today, Hours = 8m, Quality = 5 });
        });

        var root = await Json(await me.GetAsync($"/api/ai/day-recap?date={Date(Today)}"));
        // My recap is empty — the other user's rows are invisible to me.
        root.GetProperty("timeline").EnumerateArray().Should().BeEmpty();
        root.GetProperty("domainsIncluded").EnumerateArray().Should().BeEmpty();
        root.GetRawText().Should().NotContain("SecretMeal");
        root.GetRawText().Should().NotContain(otherEmail);
    }

    // ---- The recap writes nothing ----

    [Fact]
    public async Task DayRecap_read_writes_nothing()
    {
        var (email, user) = await ProvisionUser("tracker.self");
        await Seed(db => db.FoodEntries.Add(new FoodEntry
        { UserEmail = email, LocalDate = Today, Description = "Snack", Calories = 200, ProteinG = 8 }));

        int CountFood()
        {
            using var scope = factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
            return db.FoodEntries.Count(f => f.UserEmail == email);
        }

        var before = CountFood();
        (await user.GetAsync($"/api/ai/day-recap?date={Date(Today)}")).StatusCode.Should().Be(HttpStatusCode.OK);
        CountFood().Should().Be(before, "the recap is read-only");
    }
}
