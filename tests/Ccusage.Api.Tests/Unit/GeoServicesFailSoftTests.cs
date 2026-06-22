using System.Net;
using Ccusage.Api.Services;
using FluentAssertions;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging.Abstractions;

namespace Ccusage.Api.Tests.Unit;

/// <summary>
/// The two location geocoders (<see cref="IpGeoService"/> over ip-api, <see cref="ReverseGeocodeService"/>
/// over Nominatim) must fail SOFT — they sit on the request/ingest path and may NEVER throw. On a transient
/// error, a thrown exception, or a private/loopback IP, they return null and the caller stores a null
/// city/geo. These tests assert that contract with stub HTTP handlers (no real network).
/// </summary>
public class GeoServicesFailSoftTests
{
    private sealed class StatusHandler(HttpStatusCode status) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct) =>
            Task.FromResult(new HttpResponseMessage(status) { Content = new StringContent("{\"error\":\"upstream\"}") });
    }

    private sealed class ThrowingHandler : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct) =>
            throw new HttpRequestException("boom");
    }

    private sealed class JsonHandler(string body) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct) =>
            Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body) });
    }

    private sealed class StubFactory(HttpMessageHandler handler) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) =>
            new(handler, disposeHandler: false) { BaseAddress = new Uri("http://stub.local") };
    }

    private static IpGeoService IpGeo(HttpMessageHandler handler) =>
        new(new StubFactory(handler), new MemoryCache(new MemoryCacheOptions()), NullLogger<IpGeoService>.Instance);

    private static ReverseGeocodeService ReverseGeo(HttpMessageHandler handler) =>
        new(new StubFactory(handler), new MemoryCache(new MemoryCacheOptions()), NullLogger<ReverseGeocodeService>.Instance);

    // ---- IpGeoService ----

    [Theory]
    [InlineData(HttpStatusCode.InternalServerError)]
    [InlineData(HttpStatusCode.TooManyRequests)]
    [InlineData(HttpStatusCode.BadGateway)]
    public async Task IpGeo_returns_null_on_a_transient_error(HttpStatusCode status)
    {
        var svc = IpGeo(new StatusHandler(status));
        var act = async () => await svc.LookupAsync("8.8.8.8");
        (await act.Should().NotThrowAsync()).Subject.Should().BeNull();
    }

    [Fact]
    public async Task IpGeo_returns_null_when_the_request_throws()
    {
        var svc = IpGeo(new ThrowingHandler());
        var act = async () => await svc.LookupAsync("8.8.8.8");
        (await act.Should().NotThrowAsync()).Subject.Should().BeNull();
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("not-an-ip")]
    [InlineData("127.0.0.1")]   // loopback
    [InlineData("10.1.2.3")]    // private
    [InlineData("192.168.1.5")] // private
    [InlineData("172.16.0.9")]  // private
    [InlineData("169.254.0.1")] // link-local
    public async Task IpGeo_skips_missing_invalid_and_non_public_ips(string? ip)
    {
        // For these the service must short-circuit BEFORE any HTTP call — so even a handler that would throw
        // is never reached, proving the skip.
        var svc = IpGeo(new ThrowingHandler());
        var act = async () => await svc.LookupAsync(ip);
        (await act.Should().NotThrowAsync()).Subject.Should().BeNull();
    }

    [Fact]
    public async Task IpGeo_parses_a_successful_public_lookup()
    {
        const string body = "{\"status\":\"success\",\"country\":\"United States\",\"regionName\":\"California\",\"city\":\"Mountain View\",\"lat\":37.386,\"lon\":-122.0838}";
        var svc = IpGeo(new JsonHandler(body));
        var res = await svc.LookupAsync("8.8.8.8");
        res.Should().NotBeNull();
        res!.City.Should().Be("Mountain View");
        res.Region.Should().Be("California");
        res.Country.Should().Be("United States");
        res.Lat.Should().BeApproximately(37.386, 0.001);
        res.Lng.Should().BeApproximately(-122.0838, 0.001);
    }

    [Fact]
    public async Task IpGeo_returns_null_when_ip_api_reports_a_failure_status()
    {
        // ip-api signals failure in the body, not the HTTP code.
        var svc = IpGeo(new JsonHandler("{\"status\":\"fail\",\"message\":\"reserved range\"}"));
        (await svc.LookupAsync("8.8.8.8")).Should().BeNull();
    }

    // ---- ReverseGeocodeService ----

    [Theory]
    [InlineData(HttpStatusCode.InternalServerError)]
    [InlineData(HttpStatusCode.TooManyRequests)]
    [InlineData(HttpStatusCode.ServiceUnavailable)]
    public async Task ReverseGeo_returns_null_on_a_transient_error(HttpStatusCode status)
    {
        var svc = ReverseGeo(new StatusHandler(status));
        var act = async () => await svc.CityAsync(27.95, -82.46);
        (await act.Should().NotThrowAsync()).Subject.Should().BeNull();
    }

    [Fact]
    public async Task ReverseGeo_returns_null_when_the_request_throws()
    {
        var svc = ReverseGeo(new ThrowingHandler());
        var act = async () => await svc.CityAsync(27.95, -82.46);
        (await act.Should().NotThrowAsync()).Subject.Should().BeNull();
    }

    [Theory]
    [InlineData(double.NaN, 0)]
    [InlineData(0, double.NaN)]
    [InlineData(91, 0)]
    [InlineData(0, 181)]
    public async Task ReverseGeo_returns_null_for_out_of_range_coordinates(double lat, double lng)
    {
        var svc = ReverseGeo(new ThrowingHandler()); // must short-circuit before any HTTP call
        var act = async () => await svc.CityAsync(lat, lng);
        (await act.Should().NotThrowAsync()).Subject.Should().BeNull();
    }

    [Fact]
    public async Task ReverseGeo_parses_a_successful_lookup()
    {
        const string body = "{\"address\":{\"city\":\"Tampa\",\"state\":\"Florida\",\"country\":\"United States\"}}";
        var svc = ReverseGeo(new JsonHandler(body));
        var res = await svc.CityAsync(27.95, -82.46);
        res.Should().NotBeNull();
        res!.City.Should().Be("Tampa");
        res.Region.Should().Be("Florida");
        res.Country.Should().Be("United States");
    }
}
