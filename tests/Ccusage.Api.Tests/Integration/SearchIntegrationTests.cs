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
/// "Search Everything" (GET /api/search) — the SCOPE-ISOLATION suite. Search unions hits from every domain
/// the caller can see, so the load-bearing property is that it NEVER surfaces another user's owner-scoped
/// data, another household's data, or a chat channel the caller isn't a member of — and never an email or a
/// sensitive field (the cycle health log, a finance/bill amount, a location coordinate). Every test
/// provisions two SEPARATE users/households and asserts the cross-user / cross-household / non-member
/// isolation directly, plus the sensitive-field exclusions.
/// </summary>
[Collection(IntegrationCollection.Name)]
public class SearchIntegrationTests(WebAppFactory factory)
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
        var email = $"search-{Guid.NewGuid():N}@test.local";
        var res = await Admin().PostAsJsonAsync("/api/users", new { email, name, isEnabled = true, permissions });
        res.StatusCode.Should().Be(HttpStatusCode.Created);
        var id = (await Json(res)).GetProperty("id").GetInt32();
        return (email, Client(email), id);
    }

    private static async Task<JsonElement> Json(HttpResponseMessage resp) =>
        await resp.Content.ReadFromJsonAsync<JsonElement>();

    private static async Task<JsonElement> Search(HttpClient c, string q, string? domains = null)
    {
        var url = $"/api/search?q={Uri.EscapeDataString(q)}";
        if (domains is not null) url += $"&domains={Uri.EscapeDataString(domains)}";
        var resp = await c.GetAsync(url);
        resp.EnsureSuccessStatusCode();
        return await Json(resp);
    }

    private static List<JsonElement> Results(JsonElement resp) =>
        resp.GetProperty("results").EnumerateArray().ToList();

    private static List<(string domain, string id, string title)> Rows(JsonElement resp) =>
        Results(resp).Select(r => (
            r.GetProperty("domain").GetString()!,
            r.GetProperty("id").GetString()!,
            r.GetProperty("title").GetString()!)).ToList();

    private TScope Scope<TScope>(Func<UsageDbContext, TScope> f)
    {
        using var scope = factory.Services.CreateScope();
        return f(scope.ServiceProvider.GetRequiredService<UsageDbContext>());
    }

    private async Task Db(Func<UsageDbContext, Task> f)
    {
        using var scope = factory.Services.CreateScope();
        await f(scope.ServiceProvider.GetRequiredService<UsageDbContext>());
    }

    // ============ Auth + page-gate basics ============

    [Fact]
    public async Task Search_requires_authentication()
        => (await factory.CreateClient().GetAsync("/api/search?q=test")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);

    [Fact]
    public async Task A_caller_with_search_use_but_no_data_perms_gets_an_empty_result_set()
    {
        // search.use is a PAGE gate that grants no data; with no domain perms, the box returns nothing even
        // when matching data of OTHER users exists.
        var (otherEmail, _, _) = await ProvisionUser("Other Owner", "recipes.use");
        await Db(async db =>
        {
            db.Recipes.Add(new Recipe { OwnerEmail = otherEmail, Title = "Zucchini Boats", UpdatedUtc = DateTime.UtcNow });
            await db.SaveChangesAsync();
        });

        var (_, gated, _) = await ProvisionUser("Just Search", "search.use");
        var resp = await Search(gated, "Zucchini");
        Results(resp).Should().BeEmpty();
    }

    [Fact]
    public async Task Short_query_returns_empty_without_touching_data()
    {
        var (_, c, _) = await ProvisionUser("Shorty", "search.use", "recipes.use");
        Results(await Search(c, "a")).Should().BeEmpty();
        Results(await Search(c, " ")).Should().BeEmpty();
    }

    // ============ OWNER-scoped isolation: recipes ============

    [Fact]
    public async Task Recipes_a_user_cannot_find_another_users_owner_scoped_recipe()
    {
        var (aliceEmail, alice, _) = await ProvisionUser("Alice", "search.use", "recipes.use");
        var (bobEmail, bob, _) = await ProvisionUser("Bob", "search.use", "recipes.use");

        await Db(async db =>
        {
            db.Recipes.Add(new Recipe { OwnerEmail = aliceEmail, Title = "Quinoa Salad Supreme", UpdatedUtc = DateTime.UtcNow });
            db.Recipes.Add(new Recipe { OwnerEmail = bobEmail, Title = "Quinoa Power Bowl", UpdatedUtc = DateTime.UtcNow });
            await db.SaveChangesAsync();
        });

        // Alice finds ONLY her own "Quinoa Salad Supreme", never Bob's "Quinoa Power Bowl".
        var aliceRows = Rows(await Search(alice, "Quinoa"));
        aliceRows.Where(r => r.domain == "recipes").Select(r => r.title)
            .Should().Contain("Quinoa Salad Supreme").And.NotContain("Quinoa Power Bowl");

        // And symmetrically Bob never sees Alice's.
        var bobRows = Rows(await Search(bob, "Quinoa"));
        bobRows.Where(r => r.domain == "recipes").Select(r => r.title)
            .Should().Contain("Quinoa Power Bowl").And.NotContain("Quinoa Salad Supreme");
    }

    [Fact]
    public async Task Recipes_are_skipped_entirely_without_recipes_use()
    {
        var (aliceEmail, _, _) = await ProvisionUser("Alice NoPerm", "search.use");
        await Db(async db =>
        {
            db.Recipes.Add(new Recipe { OwnerEmail = aliceEmail, Title = "Secret Lasagna", UpdatedUtc = DateTime.UtcNow });
            await db.SaveChangesAsync();
        });
        // The SAME user owns it, but without recipes.use the sub-query never runs.
        var alice = Client(aliceEmail);
        Rows(await Search(alice, "Lasagna")).Should().BeEmpty();
    }

    // ============ OWNER-scoped isolation: automations + bills + foods ============

    [Fact]
    public async Task Automations_a_user_cannot_find_another_users_rule_and_no_webhook_leaks()
    {
        var (aliceEmail, alice, _) = await ProvisionUser("Alice A", "search.use", "automations.use");
        var (bobEmail, _, _) = await ProvisionUser("Bob A", "search.use", "automations.use");

        await Db(async db =>
        {
            db.AutomationRules.Add(new AutomationRule
            {
                OwnerEmail = aliceEmail, Name = "Streak Saver", TriggerKind = "streak_at_risk",
                WebhookEnc = "ENCRYPTED-SECRET-BLOB", CreatedUtc = DateTime.UtcNow, UpdatedUtc = DateTime.UtcNow,
            });
            db.AutomationRules.Add(new AutomationRule
            {
                OwnerEmail = bobEmail, Name = "Streak Watcher", TriggerKind = "streak_at_risk",
                CreatedUtc = DateTime.UtcNow, UpdatedUtc = DateTime.UtcNow,
            });
            await db.SaveChangesAsync();
        });

        var resp = await alice.GetAsync("/api/search?q=Streak");
        var raw = await resp.Content.ReadAsStringAsync();
        // The encrypted webhook blob must never reach the wire.
        raw.Should().NotContain("ENCRYPTED-SECRET-BLOB");

        var rows = Rows(await Json(resp));
        rows.Where(r => r.domain == "automations").Select(r => r.title)
            .Should().Contain("Streak Saver").And.NotContain("Streak Watcher");
    }

    [Fact]
    public async Task Bills_search_is_title_only_and_redacts_amounts_and_is_owner_scoped()
    {
        var (aliceEmail, alice, aliceId) = await ProvisionUser("Alice B", "search.use", "bills.use");
        var (bobEmail, _, bobId) = await ProvisionUser("Bob B", "search.use", "bills.use");

        await Db(async db =>
        {
            db.Bills.Add(new Bill
            {
                OwnerEmail = aliceEmail, OwnerUserId = aliceId, Title = "Sushi Night Dinner",
                TaxAmount = 12.34m, TipAmount = 56.78m, Status = "open", CreatedUtc = DateTime.UtcNow,
                Items = { new BillItem { Name = "Dragon Roll", Amount = 18.99m } },
            });
            db.Bills.Add(new Bill
            {
                OwnerEmail = bobEmail, OwnerUserId = bobId, Title = "Sushi Lunch Outing",
                Status = "open", CreatedUtc = DateTime.UtcNow,
            });
            await db.SaveChangesAsync();
        });

        var resp = await alice.GetAsync("/api/search?q=Sushi");
        var raw = await resp.Content.ReadAsStringAsync();
        // No amount (tax/tip/item) ever appears in the search payload — sensitive-field redaction.
        raw.Should().NotContain("12.34").And.NotContain("56.78").And.NotContain("18.99");
        // Title-only: an item NAME is not searchable through the bill domain.
        var rows = Rows(await Json(resp));
        rows.Where(r => r.domain == "bills").Select(r => r.title)
            .Should().Contain("Sushi Night Dinner").And.NotContain("Sushi Lunch Outing");

        // The item name "Dragon Roll" must not be reachable via bills search (title-only).
        Rows(await Search(alice, "Dragon Roll")).Where(r => r.domain == "bills").Should().BeEmpty();
    }

    [Fact]
    public async Task Foods_a_user_cannot_find_another_users_logged_food()
    {
        var (aliceEmail, alice, _) = await ProvisionUser("Alice F", "search.use", "tracker.self");
        var (bobEmail, _, _) = await ProvisionUser("Bob F", "search.use", "tracker.self");
        var today = DateOnly.FromDateTime(DateTime.UtcNow);

        await Db(async db =>
        {
            db.FoodEntries.Add(new FoodEntry { UserEmail = aliceEmail, Description = "Marmalade Toast", LocalDate = today, CreatedUtc = DateTime.UtcNow });
            db.FoodEntries.Add(new FoodEntry { UserEmail = bobEmail, Description = "Marmalade Scone", LocalDate = today, CreatedUtc = DateTime.UtcNow });
            await db.SaveChangesAsync();
        });

        var rows = Rows(await Search(alice, "Marmalade"));
        rows.Where(r => r.domain == "foods").Select(r => r.title)
            .Should().Contain("Marmalade Toast").And.NotContain("Marmalade Scone");
        // Deep-link carries the date.
        var food = Results(await Search(alice, "Marmalade")).Single(r => r.GetProperty("domain").GetString() == "foods");
        food.GetProperty("deepLink").GetString().Should().Contain($"date={today:yyyy-MM-dd}");
    }

    // ============ HOUSEHOLD-scoped isolation: notes / lists / chores / meals ============

    /// <summary>Provision a family-owner whose household is auto-created, returning the household id.</summary>
    private async Task<(string email, HttpClient client, int id, int householdId)> ProvisionFamilyOwner(string name, params string[] extra)
    {
        var perms = new[] { "search.use", "family.use", "meals.use" }.Concat(extra).ToArray();
        var (email, client, id) = await ProvisionUser(name, perms);
        (await client.GetAsync("/api/family/household")).EnsureSuccessStatusCode(); // auto-creates the household
        var hid = Scope(db => db.HouseholdMembers.AsNoTracking().Where(m => m.UserId == id).Select(m => m.HouseholdId).First());
        return (email, client, id, hid);
    }

    [Fact]
    public async Task Household_notes_lists_chores_meals_are_limited_to_the_callers_household()
    {
        var (_, alice, aliceId, aHid) = await ProvisionFamilyOwner("Alice Home");
        var (_, bob, bobId, bHid) = await ProvisionFamilyOwner("Bob Home");
        aHid.Should().NotBe(bHid); // two separate households

        await Db(async db =>
        {
            db.FamilyNotes.Add(new FamilyNote { HouseholdId = aHid, CreatedByUserId = aliceId, Title = "Birthday Plan A", Body = "balloons", CreatedUtc = DateTime.UtcNow, UpdatedUtc = DateTime.UtcNow });
            db.FamilyNotes.Add(new FamilyNote { HouseholdId = bHid, CreatedByUserId = bobId, Title = "Birthday Plan B", Body = "cake", CreatedUtc = DateTime.UtcNow, UpdatedUtc = DateTime.UtcNow });
            db.FamilyLists.Add(new FamilyList { HouseholdId = aHid, CreatedByUserId = aliceId, Name = "Camping Gear A", Kind = "todo", CreatedUtc = DateTime.UtcNow, UpdatedUtc = DateTime.UtcNow });
            db.FamilyLists.Add(new FamilyList { HouseholdId = bHid, CreatedByUserId = bobId, Name = "Camping Gear B", Kind = "todo", CreatedUtc = DateTime.UtcNow, UpdatedUtc = DateTime.UtcNow });
            db.FamilyChores.Add(new FamilyChore { HouseholdId = aHid, CreatedByUserId = aliceId, Title = "Mow Lawn A", CreatedUtc = DateTime.UtcNow });
            db.FamilyChores.Add(new FamilyChore { HouseholdId = bHid, CreatedByUserId = bobId, Title = "Mow Lawn B", CreatedUtc = DateTime.UtcNow });
            db.FamilyMeals.Add(new FamilyMeal { HouseholdId = aHid, CreatedByUserId = aliceId, Title = "Taco Tuesday A", LocalDate = DateOnly.FromDateTime(DateTime.UtcNow), CreatedUtc = DateTime.UtcNow });
            db.FamilyMeals.Add(new FamilyMeal { HouseholdId = bHid, CreatedByUserId = bobId, Title = "Taco Tuesday B", LocalDate = DateOnly.FromDateTime(DateTime.UtcNow), CreatedUtc = DateTime.UtcNow });
            await db.SaveChangesAsync();
        });

        var aliceTitles = Rows(await Search(alice, "Plan")).Concat(Rows(await Search(alice, "Camping")))
            .Concat(Rows(await Search(alice, "Mow"))).Concat(Rows(await Search(alice, "Taco")))
            .Select(r => r.title).ToList();
        aliceTitles.Should().Contain(new[] { "Birthday Plan A", "Camping Gear A", "Mow Lawn A", "Taco Tuesday A" });
        aliceTitles.Should().NotContain(new[] { "Birthday Plan B", "Camping Gear B", "Mow Lawn B", "Taco Tuesday B" });

        var bobTitles = Rows(await Search(bob, "Plan")).Concat(Rows(await Search(bob, "Camping")))
            .Concat(Rows(await Search(bob, "Mow"))).Concat(Rows(await Search(bob, "Taco")))
            .Select(r => r.title).ToList();
        bobTitles.Should().Contain(new[] { "Birthday Plan B", "Camping Gear B", "Mow Lawn B", "Taco Tuesday B" });
        bobTitles.Should().NotContain(new[] { "Birthday Plan A", "Camping Gear A", "Mow Lawn A", "Taco Tuesday A" });
    }

    [Fact]
    public async Task A_user_with_no_household_gets_no_family_results_even_with_family_use()
    {
        // Holds family.use but never created/joined a household → the household resolves to null → no leak of
        // any other household's data.
        var (otherEmail, _, otherId, otherHid) = await ProvisionFamilyOwner("Has House");
        await Db(async db =>
        {
            db.FamilyNotes.Add(new FamilyNote { HouseholdId = otherHid, CreatedByUserId = otherId, Title = "Floating Note", Body = "x", CreatedUtc = DateTime.UtcNow, UpdatedUtc = DateTime.UtcNow });
            await db.SaveChangesAsync();
        });

        var (_, lonely, _) = await ProvisionUser("No House", "search.use", "family.use");
        Rows(await Search(lonely, "Floating")).Should().BeEmpty();
    }

    // ============ MEMBERSHIP-scoped isolation: chat ============

    [Fact]
    public async Task Chat_results_come_only_from_channels_the_caller_is_a_member_of()
    {
        // Alice and Bob both have chat. They share a contact edge so a DM can be opened. Carol is a stranger
        // who posts in a channel Alice is NOT in — Alice must never find Carol's message.
        var (aliceEmail, alice, aliceId) = await ProvisionUser("Alice C", "search.use", "chat.read", "chat.send", "chat.contacts.manage");
        var (bobEmail, bob, bobId) = await ProvisionUser("Bob C", "search.use", "chat.read", "chat.send");
        var (carolEmail, carol, carolId) = await ProvisionUser("Carol C", "search.use", "chat.read", "chat.send");

        // Alice + Bob: a DM with a message Alice should find.
        var dm = await alice.PostAsJsonAsync("/api/chat/direct", new { userId = bobId });
        dm.StatusCode.Should().Be(HttpStatusCode.OK);
        var dmId = (await Json(dm)).GetProperty("id").GetInt32();
        (await alice.PostAsJsonAsync($"/api/chat/channels/{dmId}/messages", new { body = "Pineapple on the agenda" }))
            .EnsureSuccessStatusCode();

        // Bob + Carol: a separate DM that Alice is NOT a member of — its message must be invisible to Alice.
        // (Bob can DM Carol since chat.contacts.manage isn't needed when they're contacts; make them contacts.)
        (await Admin().PostAsJsonAsync($"/api/chat/contacts/user/{bobId}", new { contactUserId = carolId }))
            .EnsureSuccessStatusCode();
        var dm2 = await bob.PostAsJsonAsync("/api/chat/direct", new { userId = carolId });
        dm2.StatusCode.Should().Be(HttpStatusCode.OK);
        var dm2Id = (await Json(dm2)).GetProperty("id").GetInt32();
        (await bob.PostAsJsonAsync($"/api/chat/channels/{dm2Id}/messages", new { body = "Pineapple secret meeting" }))
            .EnsureSuccessStatusCode();

        var aliceChat = Rows(await Search(alice, "Pineapple")).Where(r => r.domain == "chat").ToList();
        aliceChat.Should().ContainSingle();
        aliceChat.Single().id.Should().NotBeNullOrEmpty();
        // Alice sees her own DM message; the Bob↔Carol message is in a channel she isn't a member of.
        var resp = await alice.GetAsync("/api/search?q=Pineapple");
        (await resp.Content.ReadAsStringAsync()).Should().NotContain("secret meeting");

        // Carol, a member of the Bob↔Carol DM, DOES find that message.
        Rows(await Search(carol, "Pineapple")).Where(r => r.domain == "chat").Should().ContainSingle();
    }

    [Fact]
    public async Task Chat_excludes_soft_deleted_messages()
    {
        var (_, alice, aliceId) = await ProvisionUser("Alice D", "search.use", "chat.read", "chat.send", "chat.contacts.manage");
        var (_, _, bobId) = await ProvisionUser("Bob D", "search.use", "chat.read");

        var dm = await alice.PostAsJsonAsync("/api/chat/direct", new { userId = bobId });
        var dmId = (await Json(dm)).GetProperty("id").GetInt32();
        var msg = await alice.PostAsJsonAsync($"/api/chat/channels/{dmId}/messages", new { body = "Rutabaga reminder" });
        var msgId = (await Json(msg)).GetProperty("id").GetInt64();

        Rows(await Search(alice, "Rutabaga")).Where(r => r.domain == "chat").Should().ContainSingle();

        (await alice.DeleteAsync($"/api/chat/messages/{msgId}")).EnsureSuccessStatusCode();
        Rows(await Search(alice, "Rutabaga")).Where(r => r.domain == "chat").Should().BeEmpty();
    }

    // ============ UNION-scoped: people via DisplayName, never email ============

    [Fact]
    public async Task People_search_surfaces_contacts_by_display_name_and_never_leaks_email()
    {
        var (_, alice, aliceId) = await ProvisionUser("Alice P", "search.use", "chat.read");
        var (_, _, bobId) = await ProvisionUser("Zebediah Zimmerman", "search.use", "chat.read");
        (await Admin().PostAsJsonAsync($"/api/chat/contacts/user/{aliceId}", new { contactUserId = bobId }))
            .EnsureSuccessStatusCode();

        var resp = await alice.GetAsync("/api/search?q=Zebediah");
        resp.EnsureSuccessStatusCode();
        var raw = await resp.Content.ReadAsStringAsync();
        raw.Should().NotContain("@"); // no email anywhere in the payload

        var people = Rows(await Json(resp)).Where(r => r.domain == "people").ToList();
        people.Should().ContainSingle();
        // The wire-facing formatted form (FirstInitial: "Zebediah Z."), not the raw full name, and it's the AppUser id.
        people.Single().title.Should().Be("Zebediah Z.");
        people.Single().id.Should().Be(bobId.ToString());
    }

    [Fact]
    public async Task People_search_does_not_surface_a_stranger_who_is_neither_contact_nor_household_member()
    {
        var (_, alice, _) = await ProvisionUser("Alice S2", "search.use", "chat.read", "family.use");
        // A user with a matching name who is NOT in Alice's contacts or household.
        await ProvisionUser("Quentin Stranger", "search.use", "chat.read");

        Rows(await Search(alice, "Quentin")).Where(r => r.domain == "people").Should().BeEmpty();
    }

    // ============ SENSITIVE-FIELD EXCLUSION: cycle / finance amount / location coord ============

    [Fact]
    public async Task Cycle_health_log_is_never_searchable_and_no_cycle_domain_exists()
    {
        // The cycle health log is EXCLUDED from v1 entirely. Even the owner with cycle.track can't reach a note
        // through search, and there is no "cycle" domain key in the response.
        var (aliceEmail, _, _) = await ProvisionUser("Alice Cy", "search.use", "cycle.track", "family.use");
        var (_, _, aliceUid) = (aliceEmail, default(HttpClient), Scope(db => db.Users.AsNoTracking().First(u => u.Email == aliceEmail).Id));
        await Db(async db =>
        {
            db.CycleDayLogs.Add(new CycleDayLog { UserId = aliceUid, LocalDate = DateOnly.FromDateTime(DateTime.UtcNow), Notes = "Pomegranate symptom note" });
            await db.SaveChangesAsync();
        });

        var alice = Client(aliceEmail);
        var resp = await Search(alice, "Pomegranate");
        Results(resp).Should().BeEmpty();
        resp.GetProperty("countsByDomain").EnumerateObject().Select(p => p.Name).Should().NotContain("cycle");
    }

    [Fact]
    public async Task No_finance_transaction_domain_leaks_amounts_or_descriptions()
    {
        // There is no finance-transaction search domain (finance amounts are sensitive). A bank-transaction
        // description must not be reachable via search even with family.finance.
        var (aliceEmail, alice, _, aHid) = await ProvisionFamilyOwner("Alice Fi", "family.finance");
        await Db(async db =>
        {
            var acct = new FinanceAccount { HouseholdId = aHid, Name = "Checking", CreatedUtc = DateTime.UtcNow };
            db.FinanceAccounts.Add(acct);
            await db.SaveChangesAsync();
            db.FinanceTransactions.Add(new FinanceTransaction
            {
                HouseholdId = aHid, AccountId = acct.Id, Merchant = "Mulberry Coffee Roasters",
                Description = "Mulberry latte", Magnitude = 42.50m, RawAmount = -42.50m, Kind = "expense",
                Date = DateOnly.FromDateTime(DateTime.UtcNow), DedupHash = Guid.NewGuid().ToString("N"),
                ImportId = 0, CreatedUtc = DateTime.UtcNow,
            });
            await db.SaveChangesAsync();
        });

        var resp = await alice.GetAsync("/api/search?q=Mulberry");
        var json = await Json(resp);
        // No finance domain → no results at all (the echoed query field naturally repeats the search term).
        Results(json).Should().BeEmpty();
        json.GetProperty("countsByDomain").EnumerateObject().Should().BeEmpty();
        // The amount + the merchant DESCRIPTION ("Mulberry latte") never appear in a result snippet/title.
        var raw = await resp.Content.ReadAsStringAsync();
        raw.Should().NotContain("42.50").And.NotContain("latte");
    }

    [Fact]
    public async Task No_location_domain_exists_so_place_names_and_coordinates_never_surface()
    {
        var (aliceEmail, _, _) = await ProvisionUser("Alice Lo", "search.use", "location.self");
        await Db(async db =>
        {
            db.UserLocations.Add(new UserLocation
            {
                UserEmail = aliceEmail, City = "Huckleberry", Region = "CA", Country = "US",
                Lat = 37.123456, Lng = -122.654321, Source = "manual", CapturedUtc = DateTime.UtcNow,
            });
            await db.SaveChangesAsync();
        });

        var alice = Client(aliceEmail);
        var resp = await alice.GetAsync("/api/search?q=Huckleberry");
        var json = await Json(resp);
        // No location domain → no results (the echoed query field naturally repeats the place name searched).
        Results(json).Should().BeEmpty();
        json.GetProperty("countsByDomain").EnumerateObject().Should().BeEmpty();
        // The precise coordinates never appear anywhere in the payload.
        var raw = await resp.Content.ReadAsStringAsync();
        raw.Should().NotContain("37.123456").And.NotContain("-122.654321");
    }
}
