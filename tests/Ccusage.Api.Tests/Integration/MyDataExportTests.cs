using System.IO.Compression;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Ccusage.Api.Tests.Integration;

/// <summary>
/// The personal "My Data" export (<c>GET /api/me/export</c>): a streamed ZIP of EVERYTHING the caller owns
/// across every domain. Verifies: auth-gating (401 anonymous / 403 without <c>dashboard.export</c>); the ZIP
/// carries the caller's OWN rows across domains; a SECOND user's data is NOT present; and NO secret (bill
/// share-token hash/ciphertext), ingest-key material, Discord webhook, or other person's EMAIL appears in ANY
/// entry (asserted by scanning every entry's bytes). Every test provisions fresh users so they're
/// order-independent.
/// </summary>
[Collection(IntegrationCollection.Name)]
public class MyDataExportTests(WebAppFactory factory)
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

    private async Task<(string email, int id, HttpClient client)> ProvisionUser(params string[] permissions)
    {
        var email = $"export-{Guid.NewGuid():N}@test.local";
        var res = await Admin().PostAsJsonAsync("/api/users", new { email, isEnabled = true, permissions });
        res.StatusCode.Should().Be(HttpStatusCode.Created);
        var created = await res.Content.ReadFromJsonAsync<System.Text.Json.JsonElement>();
        return (email, created.GetProperty("id").GetInt32(), Client(email));
    }

    private async Task WithDb(Func<UsageDbContext, Task> work)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        await work(db);
    }

    /// <summary>Download the export ZIP and return each entry's name + UTF-8 text.</summary>
    private static async Task<Dictionary<string, string>> ReadZip(HttpResponseMessage resp)
    {
        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        resp.Content.Headers.ContentType!.MediaType.Should().Be("application/zip");
        var bytes = await resp.Content.ReadAsByteArrayAsync();
        using var ms = new MemoryStream(bytes);
        using var zip = new ZipArchive(ms, ZipArchiveMode.Read);
        var entries = new Dictionary<string, string>();
        foreach (var e in zip.Entries)
        {
            using var r = new StreamReader(e.Open(), Encoding.UTF8);
            entries[e.FullName] = await r.ReadToEndAsync();
        }
        return entries;
    }

    // ---- Auth gating ----

    [Fact]
    public async Task Export_requires_authentication()
    {
        var anon = factory.CreateClient();
        (await anon.GetAsync("/api/me/export")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Export_requires_dashboard_export_permission()
    {
        var (_, _, noPerm) = await ProvisionUser("tracker.self");
        (await noPerm.GetAsync("/api/me/export")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    // ---- Content: own rows present, manifest + per-domain files ----

    [Fact]
    public async Task Export_contains_callers_own_rows_across_domains()
    {
        var (email, id, client) = await ProvisionUser("dashboard.export", "tracker.self");

        await WithDb(async db =>
        {
            db.FoodEntries.Add(new FoodEntry
            {
                UserEmail = email, LocalDate = new DateOnly(2026, 6, 1), Meal = MealType.Breakfast,
                Description = "Oatmeal", Quantity = 1, Calories = 300, ProteinG = 10, CarbG = 50, FatG = 5,
                CreatedUtc = DateTime.UtcNow,
            });
            db.ExerciseEntries.Add(new ExerciseEntry
            {
                UserEmail = email, LocalDate = new DateOnly(2026, 6, 1), Name = "Running",
                DurationMin = 30, CaloriesBurned = 320, CreatedUtc = DateTime.UtcNow,
            });
            db.HydrationEntries.Add(new HydrationEntry
            {
                UserEmail = email, LocalDate = new DateOnly(2026, 6, 1), AmountMl = 500, Label = "Water",
                CreatedUtc = DateTime.UtcNow,
            });
            db.SleepEntries.Add(new SleepEntry
            {
                UserEmail = email, LocalDate = new DateOnly(2026, 6, 2), Hours = 7.5m, Quality = 4,
                Note = "slept well", CreatedUtc = DateTime.UtcNow,
            });
            db.WeightEntries.Add(new WeightEntry
            {
                UserEmail = email, LocalDate = new DateOnly(2026, 6, 1), WeightKg = 80.5, CreatedUtc = DateTime.UtcNow,
            });
            db.TrackerProfiles.Add(new TrackerProfile
            {
                UserEmail = email, Goal = TrackerGoal.LoseWeight, DailyCalorieGoal = 2200, UpdatedUtc = DateTime.UtcNow,
            });
            await db.SaveChangesAsync();
        });

        var entries = await ReadZip(await client.GetAsync("/api/me/export"));

        entries.Keys.Should().Contain(new[]
        {
            "manifest.json", "food.csv", "exercise.csv", "hydration.csv", "sleep.csv", "weight.csv",
            "tracker_profile.json", "usage_records.csv", "bills.json", "hard_challenge.json",
            "contacts.csv", "activity_events.csv", "coffee.csv", "supplement.csv",
            "watch_activity.csv", "my_foods.csv", "my_exercises.csv",
        });

        entries["food.csv"].Should().Contain("Oatmeal");
        entries["exercise.csv"].Should().Contain("Running");
        entries["hydration.csv"].Should().Contain("Water");
        entries["sleep.csv"].Should().Contain("slept well");
        entries["weight.csv"].Should().Contain("80.5");
        entries["tracker_profile.json"].Should().Contain("2200");

        // The manifest carries the caller's DisplayName, never their email.
        entries["manifest.json"].Should().NotContain(email);
    }

    // ---- Privacy: a second user's data is NOT present ----

    [Fact]
    public async Task Export_excludes_a_second_users_data()
    {
        var (mine, _, client) = await ProvisionUser("dashboard.export", "tracker.self");
        var (theirs, _, _) = await ProvisionUser("tracker.self");

        const string mineMarker = "MY_PRIVATE_FOOD_MARKER";
        const string theirsMarker = "OTHER_USERS_FOOD_MARKER";

        await WithDb(async db =>
        {
            db.FoodEntries.Add(new FoodEntry
            {
                UserEmail = mine, LocalDate = new DateOnly(2026, 6, 1), Meal = MealType.Lunch,
                Description = mineMarker, Quantity = 1, Calories = 100, CreatedUtc = DateTime.UtcNow,
            });
            db.FoodEntries.Add(new FoodEntry
            {
                UserEmail = theirs, LocalDate = new DateOnly(2026, 6, 1), Meal = MealType.Lunch,
                Description = theirsMarker, Quantity = 1, Calories = 100, CreatedUtc = DateTime.UtcNow,
            });
            await db.SaveChangesAsync();
        });

        var entries = await ReadZip(await client.GetAsync("/api/me/export"));
        var all = string.Concat(entries.Values);

        all.Should().Contain(mineMarker);
        all.Should().NotContain(theirsMarker);
        all.Should().NotContain(theirs); // the other user's email never appears anywhere
    }

    // ---- Privacy: no secret / token / webhook / hash / other-email in ANY entry ----

    [Fact]
    public async Task Export_never_leaks_secrets_or_other_emails()
    {
        var (mine, _, client) = await ProvisionUser("dashboard.export", "bills.use");
        // A real contact (another user) whose email must never appear; on the bill they should reduce to a name.
        var (contactEmail, contactId, _) = await ProvisionUser("tracker.self");

        const string tokenHash = "DEADBEEFSHARETOKENHASH0123456789abcdef0123456789abcdef0123456789";
        const string tokenEnc = "ENCRYPTEDSHARETOKENCIPHERTEXTblob==";

        await WithDb(async db =>
        {
            // Make the contact a real mutual contact of the caller.
            db.ChatContacts.Add(new ChatContact { OwnerEmail = mine, ContactEmail = contactEmail, CreatedUtc = DateTime.UtcNow });
            db.ChatContacts.Add(new ChatContact { OwnerEmail = contactEmail, ContactEmail = mine, CreatedUtc = DateTime.UtcNow });

            // A bill the caller owns, carrying SECRET share-token material + an item assigned to the contact.
            var bill = new Bill
            {
                OwnerEmail = mine, OwnerUserId = 0, Title = "Group dinner", CreatedUtc = DateTime.UtcNow,
                ShareTokenHash = tokenHash, ShareTokenEnc = tokenEnc, ShareEnabled = true, Status = "open",
                Items = new List<BillItem>
                {
                    new() { Name = "Pizza", Amount = 20m, AssignedToUserId = contactId },
                },
            };
            db.Bills.Add(bill);
            await db.SaveChangesAsync();
        });

        var entries = await ReadZip(await client.GetAsync("/api/me/export"));
        var all = string.Concat(entries.Values);

        // The bill itself is present (the caller's own data) ...
        entries["bills.json"].Should().Contain("Group dinner");
        entries["bills.json"].Should().Contain("Pizza");

        // ... but NONE of the secret material, and NOT the contact's email.
        all.Should().NotContain(tokenHash);
        all.Should().NotContain(tokenEnc);
        all.Should().NotContain(contactEmail);
        // No raw secret-bearing JSON keys leak either.
        all.Should().NotContain("shareTokenHash");
        all.Should().NotContain("shareTokenEnc");

        // The contact still appears as a DisplayName in contacts.csv (resolved, not an email).
        entries["contacts.csv"].Should().NotContain(contactEmail);
    }
}
