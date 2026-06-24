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
/// "My Recipes" (<c>/api/recipes</c>): permission gating; OWNER-SCOPED CRUD (a caller only ever sees/edits
/// their own recipes; a foreign or missing id is a 404); save-from-breakdown persistence; and the
/// share-with-contacts visibility (a shared recipe is readable by a MUTUAL contact but a NON-contact gets a
/// 404 / empty list, and the owner email is never on the wire). Every test provisions fresh users so they're
/// order-independent.
/// </summary>
[Collection(IntegrationCollection.Name)]
public class RecipeIntegrationTests(WebAppFactory factory)
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
        var email = $"rcp-{Guid.NewGuid():N}@test.local";
        var res = await Admin().PostAsJsonAsync("/api/users", new { email, isEnabled = true, permissions });
        res.StatusCode.Should().Be(HttpStatusCode.Created);
        return (email, Client(email));
    }

    private async Task MakeContacts(string aEmail, string bEmail)
    {
        var aId = await UserIdFor(aEmail);
        var bId = await UserIdFor(bEmail);
        var res = await Admin().PostAsJsonAsync($"/api/chat/contacts/user/{aId}", new { contactUserId = bId });
        res.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    private async Task<int> UserIdFor(string email)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        return await db.Users.AsNoTracking().Where(u => u.Email == email).Select(u => u.Id).FirstAsync();
    }

    private static async Task<JsonElement> Json(HttpResponseMessage resp) =>
        await resp.Content.ReadFromJsonAsync<JsonElement>();

    private static object SampleRecipe(string title = "Chili", bool share = false) => new
    {
        title,
        servings = 4,
        calories = 500,
        proteinG = 30.0,
        carbG = 40.0,
        fatG = 20.0,
        ingredients = new[]
        {
            new { name = "Ground beef", quantity = "500 g" },
            new { name = "Beans", quantity = "2 cans" },
        },
        steps = new[] { "Brown the beef", "Simmer with beans" },
        notes = "Family favorite",
        shareWithContacts = share,
    };

    // ---- Permission gating ----

    [Fact]
    public async Task Recipe_endpoints_require_authentication()
    {
        var anon = factory.CreateClient();
        (await anon.GetAsync("/api/recipes")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Recipe_endpoints_require_recipes_use()
    {
        var (_, noPerm) = await ProvisionUser("dashboard.view");
        (await noPerm.GetAsync("/api/recipes")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await noPerm.PostAsJsonAsync("/api/recipes", SampleRecipe())).StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    // ---- Owner-scoped CRUD ----

    [Fact]
    public async Task Create_then_read_round_trips_all_fields()
    {
        var (_, user) = await ProvisionUser("recipes.use");

        var created = await user.PostAsJsonAsync("/api/recipes", SampleRecipe("Tacos"));
        created.StatusCode.Should().Be(HttpStatusCode.OK);
        var dto = await Json(created);
        var id = dto.GetProperty("id").GetInt64();
        dto.GetProperty("title").GetString().Should().Be("Tacos");
        dto.GetProperty("servings").GetInt32().Should().Be(4);
        dto.GetProperty("calories").GetInt32().Should().Be(500);
        dto.GetProperty("owned").GetBoolean().Should().BeTrue();
        dto.GetProperty("ingredients").GetArrayLength().Should().Be(2);
        dto.GetProperty("steps").GetArrayLength().Should().Be(2);

        var fetched = await Json(await user.GetAsync($"/api/recipes/{id}"));
        fetched.GetProperty("title").GetString().Should().Be("Tacos");
        fetched.GetProperty("ingredients")[0].GetProperty("name").GetString().Should().Be("Ground beef");

        // It shows up in the caller's list.
        var list = await Json(await user.GetAsync("/api/recipes"));
        list.EnumerateArray().Select(r => r.GetProperty("id").GetInt64()).Should().Contain(id);
    }

    [Fact]
    public async Task Update_replaces_fields_and_ingredients()
    {
        var (_, user) = await ProvisionUser("recipes.use");
        var id = (await Json(await user.PostAsJsonAsync("/api/recipes", SampleRecipe()))).GetProperty("id").GetInt64();

        var put = await user.PutAsJsonAsync($"/api/recipes/{id}", new
        {
            title = "Updated",
            servings = 2,
            calories = 300,
            proteinG = 10.0,
            carbG = 5.0,
            fatG = 8.0,
            ingredients = new[] { new { name = "Egg", quantity = "2" } },
            steps = new[] { "Cook" },
            notes = "",
        });
        put.StatusCode.Should().Be(HttpStatusCode.OK);

        var saved = await Json(await user.GetAsync($"/api/recipes/{id}"));
        saved.GetProperty("title").GetString().Should().Be("Updated");
        saved.GetProperty("servings").GetInt32().Should().Be(2);
        saved.GetProperty("ingredients").GetArrayLength().Should().Be(1);
        saved.GetProperty("ingredients")[0].GetProperty("name").GetString().Should().Be("Egg");
    }

    [Fact]
    public async Task Delete_removes_the_recipe()
    {
        var (_, user) = await ProvisionUser("recipes.use");
        var id = (await Json(await user.PostAsJsonAsync("/api/recipes", SampleRecipe()))).GetProperty("id").GetInt64();

        (await user.DeleteAsync($"/api/recipes/{id}")).StatusCode.Should().Be(HttpStatusCode.NoContent);
        (await user.GetAsync($"/api/recipes/{id}")).StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task Another_users_recipe_is_404_for_read_update_and_delete()
    {
        var (_, owner) = await ProvisionUser("recipes.use");
        var (_, other) = await ProvisionUser("recipes.use");
        var id = (await Json(await owner.PostAsJsonAsync("/api/recipes", SampleRecipe()))).GetProperty("id").GetInt64();

        (await other.GetAsync($"/api/recipes/{id}")).StatusCode.Should().Be(HttpStatusCode.NotFound);
        (await other.PutAsJsonAsync($"/api/recipes/{id}", SampleRecipe("Hijack")))
            .StatusCode.Should().Be(HttpStatusCode.NotFound);
        (await other.DeleteAsync($"/api/recipes/{id}")).StatusCode.Should().Be(HttpStatusCode.NotFound);

        // The owner's copy is untouched.
        var stillThere = await Json(await owner.GetAsync($"/api/recipes/{id}"));
        stillThere.GetProperty("title").GetString().Should().Be("Chili");

        // The other user's list does not contain it.
        var otherList = await Json(await other.GetAsync("/api/recipes"));
        otherList.EnumerateArray().Select(r => r.GetProperty("id").GetInt64()).Should().NotContain(id);
    }

    [Fact]
    public async Task Missing_id_is_404()
    {
        var (_, user) = await ProvisionUser("recipes.use");
        (await user.GetAsync("/api/recipes/999999")).StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    // ---- Save-as-recipe (export a breakdown) ----

    [Fact]
    public async Task Save_from_breakdown_persists_a_recipe()
    {
        var (_, user) = await ProvisionUser("recipes.use");
        var res = await user.PostAsJsonAsync("/api/recipes/from-breakdown", new
        {
            title = "AI Stew",
            servings = 6,
            macros = new { calories = 420, protein = 25.0, carb = 35.0, fat = 12.0 },
            ingredients = new[]
            {
                new { name = "Carrot", quantity = "3" },
                new { name = "Potato", quantity = "4" },
            },
            steps = new[] { "Chop", "Boil" },
        });
        res.StatusCode.Should().Be(HttpStatusCode.OK);
        var dto = await Json(res);
        var id = dto.GetProperty("id").GetInt64();
        dto.GetProperty("title").GetString().Should().Be("AI Stew");
        dto.GetProperty("servings").GetInt32().Should().Be(6);
        dto.GetProperty("calories").GetInt32().Should().Be(420);
        dto.GetProperty("shareWithContacts").GetBoolean().Should().BeFalse();

        var fetched = await Json(await user.GetAsync($"/api/recipes/{id}"));
        fetched.GetProperty("ingredients").GetArrayLength().Should().Be(2);
        fetched.GetProperty("steps").GetArrayLength().Should().Be(2);
    }

    // ---- Sharing with mutual contacts ----

    [Fact]
    public async Task Shared_recipe_is_visible_to_a_mutual_contact_only()
    {
        var (ownerEmail, owner) = await ProvisionUser("recipes.use");
        var (contactEmail, contact) = await ProvisionUser("recipes.use");
        var (_, stranger) = await ProvisionUser("recipes.use");
        await MakeContacts(ownerEmail, contactEmail);

        var id = (await Json(await owner.PostAsJsonAsync("/api/recipes", SampleRecipe("Shared", share: true))))
            .GetProperty("id").GetInt64();

        // The mutual contact may read it.
        var asContact = await contact.GetAsync($"/api/recipes/{id}");
        asContact.StatusCode.Should().Be(HttpStatusCode.OK);
        var dto = await Json(asContact);
        dto.GetProperty("owned").GetBoolean().Should().BeFalse();
        dto.GetProperty("ownerUserId").GetInt32().Should().Be(await UserIdFor(ownerEmail));
        // No email anywhere on the wire.
        dto.ToString().Should().NotContain(ownerEmail);

        // It appears in the contact's "shared" list.
        var shared = await Json(await contact.GetAsync("/api/recipes/shared"));
        shared.EnumerateArray().Select(r => r.GetProperty("id").GetInt64()).Should().Contain(id);

        // A non-contact gets a 404 and an empty shared list.
        (await stranger.GetAsync($"/api/recipes/{id}")).StatusCode.Should().Be(HttpStatusCode.NotFound);
        var strangerShared = await Json(await stranger.GetAsync("/api/recipes/shared"));
        strangerShared.EnumerateArray().Select(r => r.GetProperty("id").GetInt64()).Should().NotContain(id);
    }

    [Fact]
    public async Task Unshared_recipe_is_404_even_to_a_mutual_contact()
    {
        var (ownerEmail, owner) = await ProvisionUser("recipes.use");
        var (contactEmail, contact) = await ProvisionUser("recipes.use");
        await MakeContacts(ownerEmail, contactEmail);

        // share = false (default).
        var id = (await Json(await owner.PostAsJsonAsync("/api/recipes", SampleRecipe("Private", share: false))))
            .GetProperty("id").GetInt64();

        (await contact.GetAsync($"/api/recipes/{id}")).StatusCode.Should().Be(HttpStatusCode.NotFound);
        var shared = await Json(await contact.GetAsync("/api/recipes/shared"));
        shared.EnumerateArray().Select(r => r.GetProperty("id").GetInt64()).Should().NotContain(id);
    }

    [Fact]
    public async Task Toggling_share_off_revokes_contact_access()
    {
        var (ownerEmail, owner) = await ProvisionUser("recipes.use");
        var (contactEmail, contact) = await ProvisionUser("recipes.use");
        await MakeContacts(ownerEmail, contactEmail);

        var id = (await Json(await owner.PostAsJsonAsync("/api/recipes", SampleRecipe("Toggle", share: true))))
            .GetProperty("id").GetInt64();
        (await contact.GetAsync($"/api/recipes/{id}")).StatusCode.Should().Be(HttpStatusCode.OK);

        var off = await owner.PutAsJsonAsync($"/api/recipes/{id}/share", new { shareWithContacts = false });
        off.StatusCode.Should().Be(HttpStatusCode.OK);

        (await contact.GetAsync($"/api/recipes/{id}")).StatusCode.Should().Be(HttpStatusCode.NotFound);
    }
}
