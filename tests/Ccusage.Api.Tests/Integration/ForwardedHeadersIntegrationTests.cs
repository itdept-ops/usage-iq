using System.Net;
using System.Net.Http.Json;
using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Ccusage.Api.Tests.Integration;

/// <summary>
/// Proves the real client-IP capture fix: ForwardedHeadersOptions.ForwardLimit = null in Program.cs
/// unwinds the FULL chain of trusted private proxies down to the leftmost public address (the real
/// client), instead of only the last hop. The X-Test-Peer-Ip header (honored by WebAppFactory's stamp
/// filter) simulates the request arriving from the container nginx — a trusted private peer — which is
/// the precondition for UseForwardedHeaders to start unwinding the X-Forwarded-For header that nginx
/// (`$proxy_add_x_forwarded_for`) appends.
///
/// The login event is the assertion anchor because RecordLoginAsync reads
/// HttpContext.Connection.RemoteIpAddress synchronously after UseForwardedHeaders — the exact value the
/// other two readers (RequestLoggingMiddleware.ClientIp and IngestEndpoints' publicIp → Fleet) consume.
/// </summary>
[Collection(IntegrationCollection.Name)]
public class ForwardedHeadersIntegrationTests(WebAppFactory factory)
{
    // Real public client, then two trusted private hops (an AWS-internal 10/8 address and a
    // 172.16/12 Docker-network address) that the proxy chain prepended. The immediate peer is the
    // nginx container, also private. Only 203.0.113.9 is public, so unwinding must stop there.
    private const string RealClient = "203.0.113.9";
    private const string ForwardedChain = RealClient + ", 10.0.0.5, 172.18.0.4";
    private const string NginxPeerIp = "172.18.0.2"; // trusted-private immediate peer (the web/nginx container)

    private async Task<HttpResponseMessage> GoogleLoginThroughProxy(string idToken)
    {
        var client = factory.CreateClient();
        var req = new HttpRequestMessage(HttpMethod.Post, "/api/auth/google")
        {
            Content = JsonContent.Create(new { idToken }),
        };
        // Simulate the production hop chain: peer is the trusted nginx container, and nginx forwarded
        // the upstream chain (real client first) in X-Forwarded-For.
        req.Headers.TryAddWithoutValidation(WebAppFactory.PeerIpHeader, NginxPeerIp);
        req.Headers.TryAddWithoutValidation("X-Forwarded-For", ForwardedChain);
        return await client.SendAsync(req);
    }

    private async Task<LoginEvent?> LatestEventFor(string email)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        return await db.LoginEvents.AsNoTracking().Where(e => e.Email == email)
            .OrderByDescending(e => e.WhenUtc).ThenByDescending(e => e.Id).FirstOrDefaultAsync();
    }

    private async Task CreateUser(string email)
    {
        var admin = factory.CreateClient();
        admin.DefaultRequestHeaders.Authorization =
            new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", TestJwt.For(WebAppFactory.AdminEmail));
        var res = await admin.PostAsJsonAsync("/api/users",
            new { email, isEnabled = true, permissions = new[] { "dashboard.view" } });
        res.StatusCode.Should().Be(HttpStatusCode.Created);
    }

    [Fact]
    public async Task Multi_hop_forwarded_for_resolves_to_the_leftmost_public_client_ip()
    {
        var email = $"xff-multihop-{Guid.NewGuid():N}@test.local";
        await CreateUser(email);

        (await GoogleLoginThroughProxy($"{email}|sub-{Guid.NewGuid():N}"))
            .StatusCode.Should().Be(HttpStatusCode.OK);

        var ev = await LatestEventFor(email);
        ev.Should().NotBeNull();
        // The full chain of trusted private proxies (172.18.0.4, 10.0.0.5) is unwound; the real client
        // (203.0.113.9) is what remains. With the old ForwardLimit = 1 only 172.18.0.4 would be peeled
        // and the recorded IP would be a private 10.0.0.5 — this is the regression guard for the fix.
        ev!.Ip.Should().Be(RealClient);
        ev.Ip.Should().NotBe("10.0.0.5");
        ev.Ip.Should().NotBe(NginxPeerIp);
    }

    [Fact]
    public async Task No_forwarded_header_falls_back_to_the_observed_peer_ip()
    {
        // Sanity: without an X-Forwarded-For, the stamped peer is what gets recorded (no spoofable
        // header to unwind), confirming the chain isn't fabricating an address.
        var email = $"xff-direct-{Guid.NewGuid():N}@test.local";
        await CreateUser(email);

        (await factory.CreateClient().PostAsJsonAsync("/api/auth/google",
            new { idToken = $"{email}|sub-{Guid.NewGuid():N}" })).StatusCode.Should().Be(HttpStatusCode.OK);

        var ev = await LatestEventFor(email);
        ev.Should().NotBeNull();
        ev!.Ip.Should().Be(WebAppFactory.TestClientIp);
    }
}
