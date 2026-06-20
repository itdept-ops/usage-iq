using System.Text.Json;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Options;

namespace Ccusage.Api.Services;

/// <summary>
/// Bound from the <c>OpenWeather</c> configuration section. <see cref="ApiKey"/> is a secret (read from
/// the git-ignored appsettings.Local.json locally, or the <c>OpenWeather__ApiKey</c> env var in prod) and
/// is NEVER logged. When it is blank the weather card simply hides — the rest of the Family Hub works.
/// </summary>
public sealed class OpenWeatherOptions
{
    public const string SectionName = "OpenWeather";

    /// <summary>OpenWeather API key, sent as the <c>appid</c> query param. Blank disables weather (card hides).</summary>
    public string? ApiKey { get; set; }

    public bool IsConfigured => !string.IsNullOrWhiteSpace(ApiKey);
}

/// <summary>The current-conditions snapshot for a household's weather card (all server-resolved + clamped).</summary>
public sealed record WeatherDto(
    string Location, double TempF, double FeelsLikeF, string Description, string Icon, double HumidityPct);

/// <summary>
/// Wraps OpenWeather (<c>https://api.openweathermap.org</c>) for the Family Hub "Today" weather card:
/// the current conditions for a household's configured location. Mirrors how <see cref="GeminiService"/>
/// degrades — when the key OR the location is missing, OR on any non-200 / timeout / network error /
/// malformed body, it returns <c>null</c> so the card simply hides and <c>/today</c> is never blocked.
/// Never throws. Results are cached briefly per location to spare the upstream quota.
///
/// SECURITY: the host is FIXED (the named client's BaseAddress), never user-controlled — no SSRF. The key
/// travels ONLY as the <c>appid</c> query param and is never logged. The location is user free text, sent
/// as the <c>q</c> query param (URL-encoded), and only ever read back as data.
/// </summary>
public sealed class WeatherService(
    IHttpClientFactory httpFactory,
    IOptions<OpenWeatherOptions> options,
    IMemoryCache cache,
    ILogger<WeatherService> logger)
{
    public const string HttpClientName = "openweather";
    private static readonly TimeSpan CacheTtl = TimeSpan.FromMinutes(10);

    private readonly OpenWeatherOptions _opt = options.Value;

    public bool IsConfigured => _opt.IsConfigured;

    /// <summary>
    /// Current conditions for <paramref name="location"/> (e.g. "Tampa,FL,US"), or <c>null</c> when the key
    /// or location is missing, or on any failure. Never throws.
    /// </summary>
    public async Task<WeatherDto?> GetCurrentAsync(string? location, CancellationToken ct = default)
    {
        if (!IsConfigured) return null;

        var loc = (location ?? "").Trim();
        if (loc.Length == 0) return null;
        if (loc.Length > 120) loc = loc[..120];

        var cacheKey = $"openweather:{loc.ToLowerInvariant()}";
        if (cache.TryGetValue(cacheKey, out WeatherDto? hit)) return hit;

        try
        {
            // imperative units => Fahrenheit; the key is a query param (never the path), host is fixed.
            var url = $"/data/2.5/weather?q={Uri.EscapeDataString(loc)}&units=imperial&appid={Uri.EscapeDataString(_opt.ApiKey!)}";

            var client = httpFactory.CreateClient(HttpClientName);
            using var res = await client.GetAsync(url, ct);
            if (!res.IsSuccessStatusCode)
            {
                // Never log the key/URL; 401 = bad key, 404 = unknown location, 429 = quota.
                logger.LogWarning("OpenWeather returned {Status}.", (int)res.StatusCode);
                return null;
            }

            await using var stream = await res.Content.ReadAsStreamAsync(ct);
            using var doc = await JsonDocument.ParseAsync(stream, cancellationToken: ct);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return null;

            var main = root.TryGetProperty("main", out var m) && m.ValueKind == JsonValueKind.Object ? m : default;
            var weather0 = root.TryGetProperty("weather", out var w) && w.ValueKind == JsonValueKind.Array
                && w.GetArrayLength() > 0 ? w[0] : default;

            var name = root.TryGetProperty("name", out var n) && n.ValueKind == JsonValueKind.String
                ? n.GetString() ?? loc : loc;

            var dto = new WeatherDto(
                Location: string.IsNullOrWhiteSpace(name) ? loc : name,
                TempF: GetNum(main, "temp"),
                FeelsLikeF: GetNum(main, "feels_like"),
                Description: Cap(GetStr(weather0, "description"), 80),
                Icon: Cap(GetStr(weather0, "icon"), 16),
                HumidityPct: GetNum(main, "humidity"));

            cache.Set(cacheKey, dto, CacheTtl);
            return dto;
        }
        catch (Exception ex)
        {
            logger.LogWarning("OpenWeather request failed: {Reason}", ex.Message);
            return null;
        }
    }

    private static double GetNum(JsonElement el, string prop)
    {
        if (el.ValueKind != JsonValueKind.Object || !el.TryGetProperty(prop, out var v)) return 0;
        return v.ValueKind == JsonValueKind.Number && v.TryGetDouble(out var d) ? Math.Round(d, 1) : 0;
    }

    private static string GetStr(JsonElement el, string prop)
    {
        if (el.ValueKind != JsonValueKind.Object || !el.TryGetProperty(prop, out var v)
            || v.ValueKind != JsonValueKind.String)
            return "";
        return v.GetString() ?? "";
    }

    private static string Cap(string s, int max) => s.Length > max ? s[..max] : s;
}
