using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using FluentAssertions;

namespace Ccusage.Api.Tests.Integration;

/// <summary>
/// The Bill Splitter (<c>/api/bills</c> owner CRUD + receipt-AI + assign, and the PUBLIC anonymous
/// <c>/api/bill-share/{token}</c> claim surface). Verifies: <c>bills.use</c> gates the owner endpoints
/// (401 anonymous / 403 without the perm); owner-scoping (no cross-user read/write); the receipt route
/// additionally requires <c>ai.vision</c> and degrades to 503 when Gemini is unconfigured (the test host
/// has no key); the public token endpoint is anonymous, returns NO email and only this bill; a claim marks
/// an open item; per-person totals include the proportional tax/tip; and the payment handles come from the
/// (placeholder) Payments config.
/// </summary>
[Collection(IntegrationCollection.Name)]
public class BillSplitterIntegrationTests(WebAppFactory factory)
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
        var email = $"bill-{Guid.NewGuid():N}@test.local";
        var res = await Admin().PostAsJsonAsync("/api/users", new { email, isEnabled = true, permissions });
        res.StatusCode.Should().Be(HttpStatusCode.Created);
        var created = await res.Content.ReadFromJsonAsync<JsonElement>();
        return (email, created.GetProperty("id").GetInt32(), Client(email));
    }

    private static async Task<int> CreateBill(HttpClient owner, string title, decimal? tax = null, decimal? tip = null)
    {
        var res = await owner.PostAsJsonAsync("/api/bills", new { title, taxAmount = tax, tipAmount = tip });
        res.StatusCode.Should().Be(HttpStatusCode.OK);
        return (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetInt32();
    }

    private static async Task<int> AddItem(HttpClient owner, int billId, string name, decimal amount)
    {
        var res = await owner.PostAsJsonAsync($"/api/bills/{billId}/items", new { name, amount });
        res.StatusCode.Should().Be(HttpStatusCode.OK);
        return (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetInt32();
    }

    // ---- Auth gating ----

    [Fact]
    public async Task Bills_list_requires_authentication()
    {
        var anon = factory.CreateClient();
        (await anon.GetAsync("/api/bills")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Bills_endpoints_require_bills_use_permission()
    {
        var (_, _, noPerm) = await ProvisionUser("dashboard.view");
        (await noPerm.GetAsync("/api/bills")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await noPerm.PostAsJsonAsync("/api/bills", new { title = "x" }))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    // ---- Owner CRUD + scoping ----

    [Fact]
    public async Task Owner_can_create_read_and_list_their_own_bill()
    {
        var (_, _, owner) = await ProvisionUser("bills.use");
        var id = await CreateBill(owner, "Dinner");
        await AddItem(owner, id, "Burger", 12.50m);

        var read = await owner.GetAsync($"/api/bills/{id}");
        read.StatusCode.Should().Be(HttpStatusCode.OK);
        var dto = await read.Content.ReadFromJsonAsync<JsonElement>();
        dto.GetProperty("title").GetString().Should().Be("Dinner");
        dto.GetProperty("items").GetArrayLength().Should().Be(1);

        var list = await owner.GetFromJsonAsync<JsonElement>("/api/bills");
        list.GetArrayLength().Should().BeGreaterThanOrEqualTo(1);
    }

    [Fact]
    public async Task A_user_cannot_read_or_write_another_users_bill()
    {
        var (_, _, alice) = await ProvisionUser("bills.use");
        var (_, _, bob) = await ProvisionUser("bills.use");
        var id = await CreateBill(alice, "Alice's bill");

        // Bob (also bills.use) cannot see or mutate Alice's bill — owner-scoped by email.
        (await bob.GetAsync($"/api/bills/{id}")).StatusCode.Should().Be(HttpStatusCode.NotFound);
        (await bob.PutAsJsonAsync($"/api/bills/{id}", new { title = "hacked" }))
            .StatusCode.Should().Be(HttpStatusCode.NotFound);
        (await bob.DeleteAsync($"/api/bills/{id}")).StatusCode.Should().Be(HttpStatusCode.NotFound);
        (await bob.PostAsJsonAsync($"/api/bills/{id}/items", new { name = "x", amount = 1 }))
            .StatusCode.Should().Be(HttpStatusCode.NotFound);

        // Alice's bill is untouched.
        var dto = await alice.GetFromJsonAsync<JsonElement>($"/api/bills/{id}");
        dto.GetProperty("title").GetString().Should().Be("Alice's bill");
    }

    // ---- Receipt AI: requires ai.vision on top of bills.use; 503 when unconfigured ----

    [Fact]
    public async Task Receipt_requires_ai_vision_on_top_of_bills_use()
    {
        var (_, _, owner) = await ProvisionUser("bills.use"); // no ai.vision
        var id = await CreateBill(owner, "Receipt bill");
        var res = await owner.PostAsJsonAsync($"/api/bills/{id}/receipt", new
        {
            imageBase64 = Convert.ToBase64String(new byte[64]),
            mimeType = "image/png",
        });
        res.StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Receipt_with_ai_vision_returns_503_when_unconfigured_for_a_valid_image()
    {
        var (_, _, owner) = await ProvisionUser("bills.use", "ai.vision");
        var id = await CreateBill(owner, "Receipt bill");
        var res = await owner.PostAsJsonAsync($"/api/bills/{id}/receipt", new
        {
            imageBase64 = Convert.ToBase64String(new byte[64]),
            mimeType = "image/png",
        });
        res.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
    }

    [Fact]
    public async Task Receipt_rejects_a_bad_image_with_400()
    {
        var (_, _, owner) = await ProvisionUser("bills.use", "ai.vision");
        var id = await CreateBill(owner, "Receipt bill");
        var res = await owner.PostAsJsonAsync($"/api/bills/{id}/receipt", new
        {
            imageBase64 = "AAAA", mimeType = "application/pdf",
        });
        res.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    // ---- Assign to contact ----

    [Fact]
    public async Task Assign_to_a_non_contact_is_forbidden_but_a_contact_works()
    {
        var (_, ownerId, owner) = await ProvisionUser("bills.use");
        var (_, friendId, _) = await ProvisionUser("bills.use");
        var id = await CreateBill(owner, "Assign bill");
        var itemId = await AddItem(owner, id, "Pizza", 20m);

        // Not yet contacts -> 403.
        (await owner.PostAsJsonAsync($"/api/bills/{id}/items/{itemId}/assign", new { assignedToUserId = friendId }))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);

        // Admin (chat.contacts.manage) makes them mutual contacts.
        (await Admin().PostAsJsonAsync($"/api/chat/contacts/user/{ownerId}", new { contactUserId = friendId }))
            .StatusCode.Should().Be(HttpStatusCode.OK);

        // Now the assign succeeds and the item is no longer open.
        (await owner.PostAsJsonAsync($"/api/bills/{id}/items/{itemId}/assign", new { assignedToUserId = friendId }))
            .StatusCode.Should().Be(HttpStatusCode.NoContent);

        var dto = await owner.GetFromJsonAsync<JsonElement>($"/api/bills/{id}");
        var item = dto.GetProperty("items")[0];
        item.GetProperty("open").GetBoolean().Should().BeFalse();
        item.GetProperty("assignedToUserId").GetInt32().Should().Be(friendId);
    }

    // ---- Public share + anonymous claim ----

    [Fact]
    public async Task Public_token_is_anonymous_returns_no_email_and_only_this_bill()
    {
        var (ownerEmail, _, owner) = await ProvisionUser("bills.use");
        var id = await CreateBill(owner, "Shared dinner", tax: 4m, tip: 6m);
        await AddItem(owner, id, "Steak", 30m);
        await AddItem(owner, id, "Wine", 10m);

        // Enable sharing -> get the token path.
        var share = await owner.PostAsJsonAsync($"/api/bills/{id}/share", new { enabled = true });
        share.StatusCode.Should().Be(HttpStatusCode.OK);
        var sharePath = (await share.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("sharePath").GetString();
        sharePath.Should().StartWith("/bill/");
        var token = sharePath!["/bill/".Length..];

        // Anonymous read works.
        var anon = factory.CreateClient();
        var pub = await anon.GetAsync($"/api/bill-share/{token}");
        pub.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await pub.Content.ReadAsStringAsync();

        // NO owner email anywhere on the wire (the public view exposes no email at all).
        body.Should().NotContain(ownerEmail);
        body.Should().NotContain("@");

        var dto = JsonSerializer.Deserialize<JsonElement>(body);
        dto.GetProperty("title").GetString().Should().Be("Shared dinner");
        dto.GetProperty("items").GetArrayLength().Should().Be(2);
        // Payment handles come from the Payments config placeholders.
        dto.GetProperty("payments").GetProperty("cashApp").GetString().Should().Be("https://cash.app/$your-handle");

        // A bad/disabled token is an indistinguishable 404.
        (await anon.GetAsync("/api/bill-share/not-a-real-token")).StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task A_claim_marks_an_open_item_and_a_second_claim_conflicts()
    {
        var (_, _, owner) = await ProvisionUser("bills.use");
        var id = await CreateBill(owner, "Claimable");
        var itemId = await AddItem(owner, id, "Tacos", 15m);
        var share = await owner.PostAsJsonAsync($"/api/bills/{id}/share", new { enabled = true });
        var token = (await share.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("sharePath").GetString()!["/bill/".Length..];

        var anon = factory.CreateClient();
        var claim = await anon.PostAsJsonAsync($"/api/bill-share/{token}/claim", new { itemId, name = "Jordan" });
        claim.StatusCode.Should().Be(HttpStatusCode.OK);
        var after = await claim.Content.ReadFromJsonAsync<JsonElement>();
        var item = after.GetProperty("items")[0];
        item.GetProperty("open").GetBoolean().Should().BeFalse();
        item.GetProperty("claimedByName").GetString().Should().Be("Jordan");

        // A second claim on the now-taken item conflicts (409).
        (await anon.PostAsJsonAsync($"/api/bill-share/{token}/claim", new { itemId, name = "Sam" }))
            .StatusCode.Should().Be(HttpStatusCode.Conflict);

        // The owner sees the claim too.
        var ownerView = await owner.GetFromJsonAsync<JsonElement>($"/api/bills/{id}");
        ownerView.GetProperty("items")[0].GetProperty("claimedByName").GetString().Should().Be("Jordan");
    }

    [Fact]
    public async Task Claim_requires_a_live_token_and_a_display_name()
    {
        var (_, _, owner) = await ProvisionUser("bills.use");
        var id = await CreateBill(owner, "Toggle");
        var itemId = await AddItem(owner, id, "Soup", 8m);
        var share = await owner.PostAsJsonAsync($"/api/bills/{id}/share", new { enabled = true });
        var token = (await share.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("sharePath").GetString()!["/bill/".Length..];

        var anon = factory.CreateClient();
        // Blank name -> 400.
        (await anon.PostAsJsonAsync($"/api/bill-share/{token}/claim", new { itemId, name = "" }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);

        // Disable the link -> the token now 404s for both read and claim.
        (await owner.PostAsJsonAsync($"/api/bills/{id}/share", new { enabled = false }))
            .StatusCode.Should().Be(HttpStatusCode.OK);
        (await anon.GetAsync($"/api/bill-share/{token}")).StatusCode.Should().Be(HttpStatusCode.NotFound);
        (await anon.PostAsJsonAsync($"/api/bill-share/{token}/claim", new { itemId, name = "Pat" }))
            .StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    // ---- Per-person totals incl. proportional tax/tip ----

    [Fact]
    public async Task Per_person_totals_include_a_proportional_share_of_tax_and_tip()
    {
        var (_, _, owner) = await ProvisionUser("bills.use");
        // Tax 4 + tip 6 = 10 split proportionally. Two claimers: 30 and 10 of a 40 named total.
        var id = await CreateBill(owner, "Split", tax: 4m, tip: 6m);
        var steak = await AddItem(owner, id, "Steak", 30m);
        var wine = await AddItem(owner, id, "Wine", 10m);
        var open = await AddItem(owner, id, "Dessert", 5m); // left open -> excluded from totals

        var share = await owner.PostAsJsonAsync($"/api/bills/{id}/share", new { enabled = true });
        var token = (await share.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("sharePath").GetString()!["/bill/".Length..];
        var anon = factory.CreateClient();
        await anon.PostAsJsonAsync($"/api/bill-share/{token}/claim", new { itemId = steak, name = "Alex" });
        await anon.PostAsJsonAsync($"/api/bill-share/{token}/claim", new { itemId = wine, name = "Riley" });

        var dto = await owner.GetFromJsonAsync<JsonElement>($"/api/bills/{id}");
        var totals = dto.GetProperty("personTotals");
        totals.GetArrayLength().Should().Be(2);

        // Alex: 30 items + 30/40*10 = 7.5 share => 37.5. Riley: 10 + 2.5 => 12.5.
        var alex = totals.EnumerateArray().Single(p => p.GetProperty("name").GetString() == "Alex");
        alex.GetProperty("itemsTotal").GetDecimal().Should().Be(30m);
        alex.GetProperty("taxTipShare").GetDecimal().Should().Be(7.5m);
        alex.GetProperty("total").GetDecimal().Should().Be(37.5m);

        var riley = totals.EnumerateArray().Single(p => p.GetProperty("name").GetString() == "Riley");
        riley.GetProperty("total").GetDecimal().Should().Be(12.5m);

        // The open dessert is excluded from people and rolled into the unclaimed total.
        dto.GetProperty("unclaimedTotal").GetDecimal().Should().Be(5m);
        _ = open;
    }

    // ---- Payment handles come from config (placeholder) ----

    [Fact]
    public async Task Payment_handles_endpoint_reads_the_config_placeholders()
    {
        var (_, _, owner) = await ProvisionUser("bills.use");
        var dto = await owner.GetFromJsonAsync<JsonElement>("/api/bills/payment-handles");
        dto.GetProperty("cashApp").GetString().Should().Be("https://cash.app/$your-handle");
        dto.GetProperty("payPal").GetString().Should().Be("https://paypal.me/your-handle");
        dto.GetProperty("venmo").GetString().Should().Be("https://venmo.com/your-handle");
    }

    // ---- The bills.use permission is surfaced by the catalog ----

    [Fact]
    public async Task Bills_use_permission_appears_in_the_catalog()
    {
        var res = await Admin().GetAsync("/api/permissions");
        res.StatusCode.Should().Be(HttpStatusCode.OK);
        var keys = (await res.Content.ReadFromJsonAsync<List<PermissionRow>>())!.Select(p => p.Key).ToList();
        keys.Should().Contain("bills.use");
    }

    private sealed record PermissionRow(string Key, string Group, string Label, string Description);
}
