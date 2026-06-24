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
/// Hub Wrapped (/api/wrapped): auth (401) + tracker.self (403) gating; numbers DERIVED from the caller's own
/// existing tracker / 75-Hard / bills / usage data over the chosen period window; STRICT own-data scoping (another
/// user's data never appears in the caller's Wrapped); the period window is respected (a row outside [from,to] is
/// excluded); the derived numbers AGREE with the source aggregations for the same window; and NO email / secret
/// anywhere in the DTO. Every test provisions fresh users so they're order-independent.
/// </summary>
[Collection(IntegrationCollection.Name)]
public class WrappedTests(WebAppFactory factory)
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
        var email = $"wrapped-{Guid.NewGuid():N}@test.local";
        var res = await Admin().PostAsJsonAsync("/api/users", new { email, isEnabled = true, permissions });
        res.StatusCode.Should().Be(HttpStatusCode.Created);
        return (email.ToLowerInvariant(), Client(email));
    }

    private static async Task<JsonElement> Json(HttpResponseMessage resp) =>
        await resp.Content.ReadFromJsonAsync<JsonElement>();

    private static JsonElement Card(JsonElement root, string key) =>
        root.GetProperty("cards").EnumerateArray().First(c => c.GetProperty("key").GetString() == key);

    private static bool HasCard(JsonElement root, string key) =>
        root.GetProperty("cards").EnumerateArray().Any(c => c.GetProperty("key").GetString() == key);

    private async Task Seed(Action<UsageDbContext, string> seed, string email)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        seed(db, email);
        await db.SaveChangesAsync();
    }

    // "today" must match the API's window, which anchors off the configured DISPLAY timezone (default
    // America/New_York), NOT raw UTC. Using UTC here is off-by-one whenever the run straddles the tz offset
    // (e.g. late-evening America/New_York is already the next UTC day), which silently drops the Today-seeded rows.
    private static readonly DateOnly Today = DisplayTzToday();
    private static readonly DateOnly ThisMonthStart = new(Today.Year, Today.Month, 1);

    private static DateOnly DisplayTzToday()
    {
        // Mirror TrackerVisibility.DisplayTzAsync: the appsettings default with a UTC fallback on a bad id.
        TimeZoneInfo tz;
        try { tz = TimeZoneInfo.FindSystemTimeZoneById("America/New_York"); } catch { tz = TimeZoneInfo.Utc; }
        return DateOnly.FromDateTime(TimeZoneInfo.ConvertTimeFromUtc(DateTime.UtcNow, tz));
    }

    // ---- Gating ----

    [Fact]
    public async Task Wrapped_requires_authentication()
    {
        var anon = factory.CreateClient();
        (await anon.GetAsync("/api/wrapped")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Wrapped_requires_tracker_self()
    {
        var (_, noTracker) = await ProvisionUser("dashboard.view");
        (await noTracker.GetAsync("/api/wrapped?period=year")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    // ---- Period normalization ----

    [Fact]
    public async Task Unknown_period_defaults_to_month_and_window_is_returned()
    {
        var (_, user) = await ProvisionUser("tracker.self");
        var root = await Json(await user.GetAsync("/api/wrapped?period=banana"));
        root.GetProperty("period").GetString().Should().Be("month");
        root.GetProperty("fromDate").GetString().Should().Be(ThisMonthStart.ToString("yyyy-MM-dd"));
        root.GetProperty("toDate").GetString().Should().Be(Today.ToString("yyyy-MM-dd"));
    }

    [Fact]
    public async Task Year_period_window_starts_january_first()
    {
        var (_, user) = await ProvisionUser("tracker.self");
        var root = await Json(await user.GetAsync("/api/wrapped?period=year"));
        root.GetProperty("period").GetString().Should().Be("year");
        root.GetProperty("fromDate").GetString().Should().Be(new DateOnly(Today.Year, 1, 1).ToString("yyyy-MM-dd"));
    }

    // ---- Fresh user: no story cards (every number is 0 ⇒ all dropped) ----

    [Fact]
    public async Task Fresh_user_has_no_cards_and_zeroed_extras()
    {
        var (_, user) = await ProvisionUser("tracker.self");
        var root = await Json(await user.GetAsync("/api/wrapped?period=year"));
        root.GetProperty("cards").EnumerateArray().Should().BeEmpty("nothing happened ⇒ no story to tell");
        root.GetProperty("daysTracked").GetInt32().Should().Be(0);
        root.GetProperty("workouts").GetInt32().Should().Be(0);
        root.GetProperty("usageRequests").GetInt32().Should().Be(0);
    }

    // ---- Derivation: numbers match the source aggregations for the window ----

    [Fact]
    public async Task Workouts_and_days_tracked_match_seeded_window_data()
    {
        var (email, user) = await ProvisionUser("tracker.self");
        await Seed((db, e) =>
        {
            // 3 workouts on 2 distinct in-window dates, 90 minutes total.
            db.ExerciseEntries.Add(new ExerciseEntry { UserEmail = e, LocalDate = ThisMonthStart, Name = "Run", DurationMin = 30, CaloriesBurned = 200, CreatedUtc = DateTime.UtcNow });
            db.ExerciseEntries.Add(new ExerciseEntry { UserEmail = e, LocalDate = ThisMonthStart, Name = "Lift", DurationMin = 30, CaloriesBurned = 100, CreatedUtc = DateTime.UtcNow });
            db.ExerciseEntries.Add(new ExerciseEntry { UserEmail = e, LocalDate = Today, Name = "Swim", DurationMin = 30, CaloriesBurned = 150, CreatedUtc = DateTime.UtcNow });
            // A food log on a 3rd distinct date so days-tracked = 3.
            db.FoodEntries.Add(new FoodEntry { UserEmail = e, LocalDate = Today, Calories = 600, ProteinG = 40 });
        }, email);

        var root = await Json(await user.GetAsync("/api/wrapped?period=month"));
        root.GetProperty("workouts").GetInt32().Should().Be(3);
        root.GetProperty("workoutMinutes").GetInt32().Should().Be(90);
        root.GetProperty("daysTracked").GetInt32().Should().Be(2, "two distinct dates had food or exercise");
        root.GetProperty("caloriesOutTotal").GetInt32().Should().Be(450);

        Card(root, "workouts").GetProperty("headline").GetString().Should().Be("3");
        Card(root, "days-tracked").GetProperty("headline").GetString().Should().Be("2");
    }

    [Fact]
    public async Task Hydration_best_streak_is_longest_consecutive_run_in_window()
    {
        var (email, user) = await ProvisionUser("tracker.self");
        // Default goal 2000ml. Qualify on 4 consecutive days, miss one, then 2 more — best run = 4.
        var d0 = ThisMonthStart;
        await Seed((db, e) =>
        {
            void Hit(DateOnly day) => db.HydrationEntries.Add(new HydrationEntry { UserEmail = e, LocalDate = day, AmountMl = 2100, CreatedUtc = DateTime.UtcNow });
            Hit(d0); Hit(d0.AddDays(1)); Hit(d0.AddDays(2)); Hit(d0.AddDays(3));
            // gap at +4
            Hit(d0.AddDays(5)); Hit(d0.AddDays(6));
        }, email);

        var root = await Json(await user.GetAsync("/api/wrapped?period=month"));
        root.GetProperty("hydrationDays").GetInt32().Should().Be(6);
        root.GetProperty("hydrationBestStreak").GetInt32().Should().Be(4);
    }

    [Fact]
    public async Task Weight_delta_is_last_minus_first_reading_in_window_as_lb()
    {
        var (email, user) = await ProvisionUser("tracker.self");
        await Seed((db, e) =>
        {
            db.WeightEntries.Add(new WeightEntry { UserEmail = e, LocalDate = ThisMonthStart, WeightKg = 90.0, CreatedUtc = DateTime.UtcNow });
            db.WeightEntries.Add(new WeightEntry { UserEmail = e, LocalDate = Today, WeightKg = 88.0, CreatedUtc = DateTime.UtcNow });
        }, email);

        var root = await Json(await user.GetAsync("/api/wrapped?period=month"));
        root.GetProperty("weightDeltaKg").GetDouble().Should().BeApproximately(-2.0, 1e-6);
        // -2.0 kg ≈ -4.4 lb.
        Card(root, "weight-delta").GetProperty("headline").GetString().Should().Be("-4.4 lb");
    }

    [Fact]
    public async Task Sleep_avg_is_mean_hours_over_window()
    {
        var (email, user) = await ProvisionUser("tracker.self");
        await Seed((db, e) =>
        {
            db.SleepEntries.Add(new SleepEntry { UserEmail = e, LocalDate = ThisMonthStart, Hours = 7.0m, Quality = 4, CreatedUtc = DateTime.UtcNow });
            db.SleepEntries.Add(new SleepEntry { UserEmail = e, LocalDate = Today, Hours = 8.0m, Quality = 4, CreatedUtc = DateTime.UtcNow });
        }, email);

        var root = await Json(await user.GetAsync("/api/wrapped?period=month"));
        root.GetProperty("sleepAvgHours").GetDouble().Should().BeApproximately(7.5, 1e-6);
    }

    [Fact]
    public async Task Usage_cost_and_tokens_match_callers_reported_records_in_window()
    {
        var (email, user) = await ProvisionUser("tracker.self");
        await Seed((db, e) =>
        {
            var file = new IngestedFile { Path = $"remote://{Guid.NewGuid():N}", LastSyncUtc = DateTime.UtcNow };
            var project = new Project { Name = "proj", RepoRoot = $"/repo/{Guid.NewGuid():N}" };
            db.UsageRecords.Add(new UsageRecord
            {
                Source = "claude-code", TimestampUtc = DateTime.UtcNow, LocalDate = ThisMonthStart,
                Model = "claude-opus", InputTokens = 1000, OutputTokens = 500, CostUsd = 1.50m,
                MachineName = "m1", ReportedByUser = e, IngestedFile = file, Project = project,
                DedupKey = $"dk-{Guid.NewGuid():N}",
            });
            db.UsageRecords.Add(new UsageRecord
            {
                Source = "claude-code", TimestampUtc = DateTime.UtcNow, LocalDate = Today,
                Model = "claude-opus", InputTokens = 2000, OutputTokens = 1000, CostUsd = 2.00m,
                MachineName = "m1", ReportedByUser = e, IngestedFile = file, Project = project,
                DedupKey = $"dk-{Guid.NewGuid():N}",
            });
        }, email);

        var root = await Json(await user.GetAsync("/api/wrapped?period=month"));
        root.GetProperty("usageRequests").GetInt32().Should().Be(2);
        root.GetProperty("usageCostUsd").GetDecimal().Should().Be(3.50m);
        root.GetProperty("usageTokens").GetInt64().Should().Be(4500, "1000+500 + 2000+1000");
        Card(root, "usage").GetProperty("headline").GetString().Should().Be("$3.50");
    }

    // ---- The period window is respected ----

    [Fact]
    public async Task Rows_outside_the_period_window_are_excluded()
    {
        var (email, user) = await ProvisionUser("tracker.self");
        var lastYear = new DateOnly(Today.Year - 1, 6, 15);
        await Seed((db, e) =>
        {
            // In THIS month (counts for month + year).
            db.ExerciseEntries.Add(new ExerciseEntry { UserEmail = e, LocalDate = ThisMonthStart, Name = "Run", DurationMin = 30, CreatedUtc = DateTime.UtcNow });
            // LAST year (must NOT count for month or year).
            db.ExerciseEntries.Add(new ExerciseEntry { UserEmail = e, LocalDate = lastYear, Name = "Old", DurationMin = 30, CreatedUtc = DateTime.UtcNow });
        }, email);

        var month = await Json(await user.GetAsync("/api/wrapped?period=month"));
        month.GetProperty("workouts").GetInt32().Should().Be(1, "only the in-month workout counts");

        var year = await Json(await user.GetAsync("/api/wrapped?period=year"));
        year.GetProperty("workouts").GetInt32().Should().Be(1, "last year's workout is outside this year");

        var all = await Json(await user.GetAsync("/api/wrapped?period=all"));
        all.GetProperty("workouts").GetInt32().Should().Be(2, "all-time spans the whole history");
    }

    // ---- Own-data scoping: a second user's data never appears ----

    [Fact]
    public async Task Another_users_data_never_appears_in_the_callers_wrapped()
    {
        var (_, me) = await ProvisionUser("tracker.self");
        var (theirsEmail, _) = await ProvisionUser("tracker.self");

        await Seed((db, e) =>
        {
            for (var i = 0; i < 50; i++)
                db.ExerciseEntries.Add(new ExerciseEntry { UserEmail = e, LocalDate = ThisMonthStart, Name = "Run", DurationMin = 30, CaloriesBurned = 300, CreatedUtc = DateTime.UtcNow });
            db.CoffeeEntries.Add(new CoffeeEntry { UserEmail = e, LocalDate = ThisMonthStart, Cups = 99, CreatedUtc = DateTime.UtcNow });
            db.UsageRecords.Add(new UsageRecord
            {
                Source = "claude-code", TimestampUtc = DateTime.UtcNow, LocalDate = ThisMonthStart,
                Model = "claude-opus", InputTokens = 99999, OutputTokens = 1, CostUsd = 999m,
                MachineName = "m1", ReportedByUser = e,
                IngestedFile = new IngestedFile { Path = $"remote://{Guid.NewGuid():N}", LastSyncUtc = DateTime.UtcNow },
                Project = new Project { Name = "proj", RepoRoot = $"/repo/{Guid.NewGuid():N}" },
                DedupKey = $"dk-{Guid.NewGuid():N}",
            });
        }, theirsEmail);

        var root = await Json(await me.GetAsync("/api/wrapped?period=month"));
        root.GetProperty("workouts").GetInt32().Should().Be(0);
        root.GetProperty("coffeeCups").GetInt32().Should().Be(0);
        root.GetProperty("usageCostUsd").GetDecimal().Should().Be(0);
        root.GetProperty("cards").EnumerateArray().Should().BeEmpty("the caller has no data of their own");
    }

    // ---- Privacy: no email / secret on the wire ----

    [Fact]
    public async Task Response_carries_no_email_anywhere()
    {
        var (email, user) = await ProvisionUser("tracker.self");
        await Seed((db, e) =>
            db.CoffeeEntries.Add(new CoffeeEntry { UserEmail = e, LocalDate = ThisMonthStart, Cups = 12, CreatedUtc = DateTime.UtcNow }),
            email);

        var raw = await (await user.GetAsync("/api/wrapped?period=year")).Content.ReadAsStringAsync();
        raw.Should().NotContain("@", "no email may appear in the Wrapped DTO");
        raw.Should().NotContain(email);
    }
}
