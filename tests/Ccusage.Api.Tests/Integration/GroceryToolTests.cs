using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using FluentAssertions;

namespace Ccusage.Api.Tests.Integration;

/// <summary>
/// The standalone Grocery Tool — <c>/api/grocery</c>. A THIN wrapper over the household's single "Groceries"
/// shopping list (find-or-create), gated by BOTH <c>family.use</c> (the household-data group) and the dedicated
/// <c>grocery.use</c>. These tests verify the gate (401 anon / 403 missing-grocery.use / allowed with both), the
/// find-or-create + add / toggle / delete / reorder flow, the QUANTITY-AWARE add (increments an existing match's
/// "xN" instead of duplicating), household-scoping (a foreign item id is a 404 — never leaked), and that no email
/// ever appears on the wire.
/// </summary>
[Collection(IntegrationCollection.Name)]
public class GroceryToolTests(WebAppFactory factory)
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
        var email = $"groc-{Guid.NewGuid():N}@test.local";
        var res = await Admin().PostAsJsonAsync("/api/users", new { email, isEnabled = true, permissions });
        res.StatusCode.Should().Be(HttpStatusCode.Created);
        return (email, Client(email));
    }

    private static async Task<JsonElement> Json(HttpResponseMessage resp) =>
        JsonDocument.Parse(await resp.Content.ReadAsStringAsync()).RootElement.Clone();

    private static List<JsonElement> Items(JsonElement list) =>
        list.GetProperty("items").EnumerateArray().ToList();

    private static string TextOf(JsonElement item) => item.GetProperty("text").GetString()!;

    // =====================================================================================
    // Gating
    // =====================================================================================

    [Fact]
    public async Task Anonymous_is_401()
    {
        (await factory.CreateClient().GetAsync("/api/grocery"))
            .StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Family_use_without_grocery_use_is_403()
    {
        var (_, user) = await ProvisionUser("family.use");
        (await user.GetAsync("/api/grocery")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Grocery_use_without_family_use_is_403()
    {
        var (_, user) = await ProvisionUser("grocery.use");
        (await user.GetAsync("/api/grocery")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Both_perms_get_the_list_and_no_email_on_the_wire()
    {
        var (_, user) = await ProvisionUser("family.use", "grocery.use");
        var res = await user.GetAsync("/api/grocery");
        res.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await res.Content.ReadAsStringAsync();
        var list = JsonDocument.Parse(body).RootElement;
        list.GetProperty("name").GetString().Should().Be("Groceries");
        list.GetProperty("kind").GetString().Should().Be("shopping");
        body.Should().NotContain("@"); // names + ids only, never email
    }

    // =====================================================================================
    // Add / toggle / delete
    // =====================================================================================

    [Fact]
    public async Task Add_toggle_delete_roundtrip()
    {
        var (_, user) = await ProvisionUser("family.use", "grocery.use");

        var afterAdd = await Json(await user.PostAsJsonAsync("/api/grocery/items", new { text = "Bananas" }));
        var item = Items(afterAdd).Single(i => TextOf(i) == "Bananas");
        item.GetProperty("done").GetBoolean().Should().BeFalse();
        var itemId = item.GetProperty("id").GetInt64();

        // Adding the same text again de-dupes (no second open row).
        var afterDup = await Json(await user.PostAsJsonAsync("/api/grocery/items", new { text = "bananas" }));
        Items(afterDup).Count(i => TextOf(i).Equals("Bananas", StringComparison.OrdinalIgnoreCase)).Should().Be(1);

        // Toggle done.
        var afterToggle = await Json(await user.PatchAsync($"/api/grocery/items/{itemId}",
            JsonContent.Create(new { done = true })));
        Items(afterToggle).Single(i => i.GetProperty("id").GetInt64() == itemId)
            .GetProperty("done").GetBoolean().Should().BeTrue();

        // Delete.
        var afterDelete = await Json(await user.DeleteAsync($"/api/grocery/items/{itemId}"));
        Items(afterDelete).Should().NotContain(i => i.GetProperty("id").GetInt64() == itemId);
    }

    [Fact]
    public async Task Toggle_or_delete_of_a_foreign_item_is_404()
    {
        var (_, user) = await ProvisionUser("family.use", "grocery.use");
        await user.GetAsync("/api/grocery"); // find-or-create the list

        (await user.PatchAsync("/api/grocery/items/999999", JsonContent.Create(new { done = true })))
            .StatusCode.Should().Be(HttpStatusCode.NotFound);
        (await user.DeleteAsync("/api/grocery/items/999999"))
            .StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    // =====================================================================================
    // Quantity-aware add
    // =====================================================================================

    [Fact]
    public async Task Quantity_add_increments_an_existing_match_instead_of_duplicating()
    {
        var (_, user) = await ProvisionUser("family.use", "grocery.use");

        // First add: qty 2 -> "Milk x2".
        var a = await Json(await user.PostAsJsonAsync("/api/grocery/items/quantity", new { text = "Milk", quantity = 2 }));
        Items(a).Should().ContainSingle(i => TextOf(i) == "Milk x2");

        // Second add: qty 1 on the SAME name (case-insensitive) bumps the existing row to x3 — no duplicate.
        var b = await Json(await user.PostAsJsonAsync("/api/grocery/items/quantity", new { text = "milk", quantity = 1 }));
        Items(b).Count(i => TextOf(i).StartsWith("Milk", StringComparison.OrdinalIgnoreCase)).Should().Be(1);
        Items(b).Should().ContainSingle(i => TextOf(i) == "Milk x3");

        // A different item is appended, not merged.
        var c = await Json(await user.PostAsJsonAsync("/api/grocery/items/quantity", new { text = "Eggs", quantity = 1 }));
        Items(c).Should().Contain(i => TextOf(i) == "Eggs");   // qty 1 -> no "xN" suffix
        Items(c).Should().Contain(i => TextOf(i) == "Milk x3");
    }

    [Fact]
    public async Task Quantity_add_honours_an_embedded_xN_in_the_text()
    {
        var (_, user) = await ProvisionUser("family.use", "grocery.use");
        var a = await Json(await user.PostAsJsonAsync("/api/grocery/items/quantity", new { text = "Apples x3" }));
        Items(a).Should().ContainSingle(i => TextOf(i) == "Apples x3");
        // Adding "Apples" (qty 1) increments to x4.
        var b = await Json(await user.PostAsJsonAsync("/api/grocery/items/quantity", new { text = "Apples" }));
        Items(b).Should().ContainSingle(i => TextOf(i) == "Apples x4");
    }

    // =====================================================================================
    // Reorder + scoping
    // =====================================================================================

    [Fact]
    public async Task Reorder_sets_the_named_order_first()
    {
        var (_, user) = await ProvisionUser("family.use", "grocery.use");
        await user.PostAsJsonAsync("/api/grocery/items", new { text = "A" });
        await user.PostAsJsonAsync("/api/grocery/items", new { text = "B" });
        var afterC = await Json(await user.PostAsJsonAsync("/api/grocery/items", new { text = "C" }));
        var byText = Items(afterC).ToDictionary(TextOf, i => i.GetProperty("id").GetInt64());

        // Put C, then A first (B drifts after them, keeping its relative order).
        var reordered = await Json(await user.PutAsync("/api/grocery/reorder",
            JsonContent.Create(new { itemIds = new[] { byText["C"], byText["A"] } })));
        var ordered = Items(reordered).OrderBy(i => i.GetProperty("sortOrder").GetInt32()).Select(TextOf).ToList();
        ordered.Should().Equal("C", "A", "B");
    }

    [Fact]
    public async Task The_list_is_household_scoped_one_user_does_not_see_anothers_items()
    {
        var (_, alice) = await ProvisionUser("family.use", "grocery.use");
        var (_, bob) = await ProvisionUser("family.use", "grocery.use");
        var marker = $"Alice-{Guid.NewGuid():N}";
        await alice.PostAsJsonAsync("/api/grocery/items", new { text = marker });

        var bobList = await Json(await bob.GetAsync("/api/grocery"));
        Items(bobList).Should().NotContain(i => TextOf(i) == marker);
    }
}
