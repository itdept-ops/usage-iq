using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using FluentAssertions;

namespace Ccusage.Api.Tests.Integration;

[Collection(IntegrationCollection.Name)]
public class PresenceIntegrationTests(WebAppFactory factory)
{
    private HttpClient Client(string? email = null)
    {
        var c = factory.CreateClient();
        if (email is not null)
            c.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", TestJwt.For(email));
        return c;
    }

    [Fact]
    public async Task Presence_requires_authentication()
        => (await Client().GetAsync("/api/presence")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);

    [Fact]
    public async Task Authenticated_caller_shows_up_as_online()
    {
        var c = Client(WebAppFactory.AdminEmail);

        // The presence middleware runs on this very (authenticated) request, so the caller is
        // recorded before the endpoint reads the tracker — they appear in their own presence list.
        var res = await c.GetAsync("/api/presence");
        res.StatusCode.Should().Be(HttpStatusCode.OK);

        var list = await res.Content.ReadFromJsonAsync<JsonElement>();
        var emails = list.EnumerateArray().Select(e => e.GetProperty("email").GetString()).ToList();
        emails.Should().Contain(WebAppFactory.AdminEmail);

        var me = list.EnumerateArray().First(e => e.GetProperty("email").GetString() == WebAppFactory.AdminEmail);
        me.TryGetProperty("lastSeenUtc", out _).Should().BeTrue();   // camelCase via Web JSON defaults
        me.TryGetProperty("name", out _).Should().BeTrue();
    }
}
