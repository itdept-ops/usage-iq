using System.Net;
using System.Text.Json;
using Microsoft.Extensions.Caching.Memory;

namespace Ccusage.Api.Services;

/// <summary>A coarse IP-geolocation result: the city/region/country and centroid lat/lng of a public IP.</summary>
public sealed record IpGeoResult(double Lat, double Lng, string? City, string? Region, string? Country);

/// <summary>
/// Resolves a PUBLIC IP address to a coarse location via ip-api.com (free, no API key, ~45 req/min). Used
/// to give a desktop machine a "fleet location" — desktops have no GPS, so a machine's location is the
/// IP-geo of its server-observed PublicIp.
///
/// Hardened like the other outbound services (<see cref="WeatherService"/>): the host is FIXED (never
/// user-controlled, no SSRF); private/loopback/link-local/non-routable IPs are skipped outright (they
/// have no public geo and would only leak a LAN address upstream); results are cached ~24h (IMemoryCache)
/// to respect the keyless rate limit; and it NEVER throws into the caller — any failure returns null.
/// </summary>
public sealed class IpGeoService(
    IHttpClientFactory httpFactory,
    IMemoryCache cache,
    ILogger<IpGeoService> logger)
{
    public const string HttpClientName = "ipgeo";
    private static readonly TimeSpan CacheTtl = TimeSpan.FromHours(24);

    /// <summary>
    /// Coarse geo for <paramref name="ip"/>, or null when the IP is missing/private/loopback, on any
    /// upstream failure, or when ip-api reports a lookup failure. Never throws.
    /// </summary>
    public async Task<IpGeoResult?> LookupAsync(string? ip, CancellationToken ct = default)
    {
        var trimmed = (ip ?? "").Trim();
        if (trimmed.Length == 0) return null;
        if (!IPAddress.TryParse(trimmed, out var addr)) return null;
        if (!IsPublic(addr)) return null; // skip private/loopback/link-local — no public geo, never leak a LAN IP

        var cacheKey = $"ipgeo:{addr}";
        if (cache.TryGetValue(cacheKey, out IpGeoResult? hit)) return hit;

        try
        {
            // Restrict to the fields we use; the host is fixed (named client BaseAddress), never user input.
            var url = $"/json/{Uri.EscapeDataString(addr.ToString())}?fields=status,country,regionName,city,lat,lon";

            var client = httpFactory.CreateClient(HttpClientName);
            using var res = await client.GetAsync(url, ct);
            if (!res.IsSuccessStatusCode)
            {
                logger.LogWarning("ip-api returned {Status}.", (int)res.StatusCode);
                return null;
            }

            await using var stream = await res.Content.ReadAsStreamAsync(ct);
            using var doc = await JsonDocument.ParseAsync(stream, cancellationToken: ct);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return null;

            // ip-api signals success/failure in a "status" field rather than the HTTP code.
            if (!root.TryGetProperty("status", out var st) || st.GetString() != "success")
                return null;
            if (!TryGetDouble(root, "lat", out var lat) || !TryGetDouble(root, "lon", out var lng))
                return null;

            var dto = new IpGeoResult(
                Lat: Math.Round(lat, 4),
                Lng: Math.Round(lng, 4),
                City: GetStr(root, "city"),
                Region: GetStr(root, "regionName"),
                Country: GetStr(root, "country"));

            cache.Set(cacheKey, dto, CacheTtl);
            return dto;
        }
        catch (Exception ex)
        {
            logger.LogWarning("ip-api request failed: {Reason}", ex.Message);
            return null;
        }
    }

    /// <summary>Whether an address is a public, routable IP worth a geo lookup (not loopback/private/link-local).</summary>
    private static bool IsPublic(IPAddress addr)
    {
        if (IPAddress.IsLoopback(addr)) return false;

        var bytes = addr.GetAddressBytes();
        if (addr.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork)
        {
            // IPv4 private/special ranges: 10/8, 172.16/12, 192.168/16, 169.254/16 (link-local),
            // 100.64/10 (CGNAT), 0/8, 127/8 (loopback handled above).
            return bytes[0] switch
            {
                0 or 10 or 127 => false,
                172 => !(bytes[1] >= 16 && bytes[1] <= 31),
                192 => !(bytes[1] == 168),
                169 => !(bytes[1] == 254),
                100 => !(bytes[1] >= 64 && bytes[1] <= 127),
                _ => true,
            };
        }

        // IPv6: skip link-local (fe80::/10), unique-local (fc00::/7), and IPv4-mapped private space.
        if (addr.IsIPv6LinkLocal || addr.IsIPv6SiteLocal) return false;
        if ((bytes[0] & 0xFE) == 0xFC) return false; // fc00::/7 unique-local
        if (addr.IsIPv4MappedToIPv6) return IsPublic(addr.MapToIPv4());
        return true;
    }

    private static bool TryGetDouble(JsonElement el, string prop, out double value)
    {
        value = 0;
        return el.TryGetProperty(prop, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetDouble(out value);
    }

    private static string? GetStr(JsonElement el, string prop)
    {
        if (!el.TryGetProperty(prop, out var v) || v.ValueKind != JsonValueKind.String) return null;
        var s = v.GetString();
        if (string.IsNullOrWhiteSpace(s)) return null;
        return s.Length > 120 ? s[..120] : s;
    }
}
