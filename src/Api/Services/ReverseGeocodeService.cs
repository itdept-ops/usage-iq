using System.Text.Json;
using Microsoft.Extensions.Caching.Memory;

namespace Ccusage.Api.Services;

/// <summary>A reverse-geocoded place: the coarse city/region/country for a lat/lng (any may be null).</summary>
public sealed record PlaceResult(string? City, string? Region, string? Country);

/// <summary>
/// Reverse-geocodes a lat/lng to a coarse city/region/country via OpenStreetMap Nominatim (free, no API
/// key). Used to attach a human-readable city to a recorded <c>UserLocation</c> so household members the
/// user shares with see a COARSE city rather than precise coordinates.
///
/// Respects Nominatim's usage policy: a descriptive User-Agent is sent on every request, and calls are
/// throttled to AT MOST 1 req/s process-wide (a simple gate). Results are cached by lat/lng rounded to
/// ~2 decimal places (~1 km cells) so repeated fixes in the same area never re-hit the service. The host
/// is FIXED (named client BaseAddress), never user-controlled (no SSRF). Like the other outbound
/// services it NEVER throws into the request path — any failure (timeout, non-200, malformed) returns
/// null and the caller stores a null city.
/// </summary>
public sealed class ReverseGeocodeService(
    IHttpClientFactory httpFactory,
    IMemoryCache cache,
    ILogger<ReverseGeocodeService> logger)
{
    public const string HttpClientName = "nominatim";

    /// <summary>Nominatim asks for a genuine, identifying User-Agent so abuse can be traced to the app.</summary>
    public const string UserAgent = "UsageIQ/1.0 (https://usageiq.online)";

    private static readonly TimeSpan CacheTtl = TimeSpan.FromDays(30);

    // Process-wide 1 req/s throttle (Nominatim policy). A single gate serializes outbound calls; the cache
    // absorbs the common case so this rarely actually waits.
    private static readonly SemaphoreSlim Gate = new(1, 1);
    private static DateTime _lastCallUtc = DateTime.MinValue;

    /// <summary>
    /// Coarse place for (<paramref name="lat"/>, <paramref name="lng"/>), or null on any failure / when the
    /// coordinates are out of range. Never throws. Cached by rounded coordinates.
    /// </summary>
    public async Task<PlaceResult?> CityAsync(double lat, double lng, CancellationToken ct = default)
    {
        if (double.IsNaN(lat) || double.IsNaN(lng)) return null;
        if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;

        // ~2dp ≈ 1.1 km cells: nearby fixes share a cache entry, sparing the upstream quota.
        var rLat = Math.Round(lat, 2);
        var rLng = Math.Round(lng, 2);
        var cacheKey = $"nominatim:{rLat:F2}:{rLng:F2}";
        if (cache.TryGetValue(cacheKey, out PlaceResult? hit)) return hit;

        await Gate.WaitAsync(ct);
        try
        {
            // Re-check the cache after acquiring the gate (a concurrent caller may have filled it).
            if (cache.TryGetValue(cacheKey, out hit)) return hit;

            // Honor the 1 req/s policy: wait out the remainder of the second since the last actual call.
            var since = DateTime.UtcNow - _lastCallUtc;
            if (since < TimeSpan.FromSeconds(1))
                await Task.Delay(TimeSpan.FromSeconds(1) - since, ct);

            var url = $"/reverse?format=jsonv2&zoom=10&addressdetails=1&lat={rLat.ToString(System.Globalization.CultureInfo.InvariantCulture)}&lon={rLng.ToString(System.Globalization.CultureInfo.InvariantCulture)}";

            var client = httpFactory.CreateClient(HttpClientName);
            using var req = new HttpRequestMessage(HttpMethod.Get, url);
            req.Headers.UserAgent.ParseAdd(UserAgent);

            using var res = await client.SendAsync(req, ct);
            _lastCallUtc = DateTime.UtcNow;

            if (!res.IsSuccessStatusCode)
            {
                logger.LogWarning("Nominatim returned {Status}.", (int)res.StatusCode);
                cache.Set(cacheKey, (PlaceResult?)null, TimeSpan.FromMinutes(10)); // brief negative cache
                return null;
            }

            await using var stream = await res.Content.ReadAsStreamAsync(ct);
            using var doc = await JsonDocument.ParseAsync(stream, cancellationToken: ct);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return null;

            var addr = root.TryGetProperty("address", out var a) && a.ValueKind == JsonValueKind.Object ? a : default;

            var place = new PlaceResult(
                // Settlement name falls through several Nominatim granularities.
                City: First(addr, "city", "town", "village", "hamlet", "municipality", "county"),
                Region: First(addr, "state", "region", "state_district"),
                Country: First(addr, "country"));

            // All-null is useless — store it as a (negative) miss rather than pretending we resolved a place.
            cache.Set(cacheKey, place, CacheTtl);
            return place;
        }
        catch (Exception ex)
        {
            logger.LogWarning("Nominatim request failed: {Reason}", ex.Message);
            return null;
        }
        finally
        {
            Gate.Release();
        }
    }

    private static string? First(JsonElement addr, params string[] props)
    {
        if (addr.ValueKind != JsonValueKind.Object) return null;
        foreach (var p in props)
        {
            if (addr.TryGetProperty(p, out var v) && v.ValueKind == JsonValueKind.String)
            {
                var s = v.GetString();
                if (!string.IsNullOrWhiteSpace(s)) return s.Length > 120 ? s[..120] : s;
            }
        }
        return null;
    }
}
