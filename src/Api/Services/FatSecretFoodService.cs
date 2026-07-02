using System.Globalization;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Ccusage.Api.Dtos;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Options;

namespace Ccusage.Api.Services;

/// <summary>
/// Wraps the FatSecret Platform REST API as a SECONDARY food provider (the search proxy falls back to
/// it only when USDA is unconfigured or returns nothing). OAuth2 client-credentials: the token is
/// fetched from <see cref="FatSecretOptions.TokenUrl"/> with a Basic-auth header and cached in memory
/// until just before it expires. The client id/secret and the bearer token are NEVER logged. The hosts
/// are fixed (from <see cref="FatSecretOptions"/>), never chosen from user input, so there is no SSRF
/// surface here.
///
/// ROBUSTNESS: any failure — a network error, a non-success status (a 401/403 usually means the
/// FatSecret app hasn't allowlisted this server's IP), or a malformed body — is logged with a concise
/// reason (never the secret/token) and yields an EMPTY result. This method never throws, so a flaky
/// fallback provider can never break the food search for the caller.
/// </summary>
public sealed class FatSecretFoodService(
    IHttpClientFactory httpFactory,
    IOptions<FatSecretOptions> options,
    IMemoryCache cache,
    ILogger<FatSecretFoodService> logger)
{
    public const string HttpClientName = "fatsecret";
    private const string TokenCacheKey = "fatsecret:token";

    // Response-size ceilings so a hostile/compromised/MITM'd upstream cannot force an unbounded
    // allocation. A real OAuth token JSON is well under a KB; a food API JSON is small too.
    private const int MaxTokenResponseBytes = 64 * 1024;
    private const int MaxApiResponseBytes = 512 * 1024;

    private readonly FatSecretOptions _opt = options.Value;

    public bool IsConfigured => _opt.IsConfigured;

    /// <summary>
    /// Free-text food search. Returns up to 20 normalized matches, or an empty list on any failure /
    /// when unconfigured. Each hit carries source="fatsecret" and sourceId=food_id.
    /// </summary>
    public async Task<IReadOnlyList<FoodSearchItemDto>> SearchAsync(string? query, CancellationToken ct = default)
    {
        if (!IsConfigured) return Array.Empty<FoodSearchItemDto>();
        var term = (query ?? "").Trim();
        if (term.Length == 0) return Array.Empty<FoodSearchItemDto>();

        try
        {
            var token = await GetTokenAsync(ct);
            if (token is null) return Array.Empty<FoodSearchItemDto>();

            var url = $"{ApiTrimmed()}/foods/search/v1"
                      + "?method=foods.search"
                      + $"&search_expression={Uri.EscapeDataString(term)}"
                      + "&format=json&max_results=20";

            using var doc = await GetJsonAsync(url, token, ct);
            if (doc is null) return Array.Empty<FoodSearchItemDto>();

            return ParseSearch(doc.RootElement);
        }
        catch (Exception ex)
        {
            // Never include the secret/token; the message is the concise reason only.
            logger.LogWarning("FatSecret search failed: {Reason}", ex.Message);
            return Array.Empty<FoodSearchItemDto>();
        }
    }

    /// <summary>
    /// Best-effort barcode lookup: resolve the food id from the (UPC-A padded to 13-digit GTIN) code,
    /// then fetch the food and take its first serving. Returns empty on any failure / unsupported plan.
    /// </summary>
    public async Task<IReadOnlyList<FoodSearchItemDto>> BarcodeAsync(string? code, CancellationToken ct = default)
    {
        if (!IsConfigured) return Array.Empty<FoodSearchItemDto>();
        var barcode = (code ?? "").Trim();
        if (barcode.Length == 0) return Array.Empty<FoodSearchItemDto>();

        // FatSecret expects a 13-digit GTIN; a 12-digit UPC-A is left-padded with a leading zero.
        if (barcode.Length == 12 && barcode.All(char.IsDigit)) barcode = "0" + barcode;

        try
        {
            var token = await GetTokenAsync(ct);
            if (token is null) return Array.Empty<FoodSearchItemDto>();

            var findUrl = $"{ApiTrimmed()}/food/barcode/find-by-id/v1"
                          + "?method=food.find_id_for_barcode"
                          + $"&barcode={Uri.EscapeDataString(barcode)}"
                          + "&format=json";

            using var findDoc = await GetJsonAsync(findUrl, token, ct);
            var foodId = ExtractBarcodeFoodId(findDoc?.RootElement);
            if (string.IsNullOrEmpty(foodId) || foodId == "0") return Array.Empty<FoodSearchItemDto>();

            var getUrl = $"{ApiTrimmed()}/food/v2"
                         + "?method=food.get.v2"
                         + $"&food_id={Uri.EscapeDataString(foodId)}"
                         + "&format=json";

            using var getDoc = await GetJsonAsync(getUrl, token, ct);
            if (getDoc is null) return Array.Empty<FoodSearchItemDto>();

            var item = ParseFood(getDoc.RootElement, foodId);
            return item is null ? Array.Empty<FoodSearchItemDto>() : new[] { item };
        }
        catch (Exception ex)
        {
            logger.LogWarning("FatSecret barcode lookup failed: {Reason}", ex.Message);
            return Array.Empty<FoodSearchItemDto>();
        }
    }

    // ===================================================================================
    // OAuth2 client-credentials token (cached until ~60s before expiry)
    // ===================================================================================

    private async Task<string?> GetTokenAsync(CancellationToken ct)
    {
        if (cache.TryGetValue(TokenCacheKey, out string? cached) && !string.IsNullOrEmpty(cached))
            return cached;

        var client = httpFactory.CreateClient(HttpClientName);
        using var req = new HttpRequestMessage(HttpMethod.Post, _opt.TokenUrl);
        var basic = Convert.ToBase64String(Encoding.UTF8.GetBytes($"{_opt.ClientId}:{_opt.ClientSecret}"));
        req.Headers.Authorization = new AuthenticationHeaderValue("Basic", basic);
        req.Content = new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["grant_type"] = "client_credentials",
            ["scope"] = "basic",
        });

        using var res = await client.SendAsync(req, ct);
        if (!res.IsSuccessStatusCode)
        {
            // A 401/403 here typically means the FatSecret app must allowlist this server's IP.
            logger.LogWarning("FatSecret token request returned {Status}.", (int)res.StatusCode);
            return null;
        }

        var bytes = await ReadCappedAsync(res, MaxTokenResponseBytes, ct);
        if (bytes is null) return null;
        using var doc = JsonDocument.Parse(bytes);
        var root = doc.RootElement;

        if (!root.TryGetProperty("access_token", out var tokenEl) || tokenEl.ValueKind != JsonValueKind.String)
            return null;
        var token = tokenEl.GetString();
        if (string.IsNullOrEmpty(token)) return null;

        var expiresIn = root.TryGetProperty("expires_in", out var exp) && exp.TryGetInt32(out var secs) ? secs : 3600;
        var ttl = TimeSpan.FromSeconds(Math.Max(30, expiresIn - 60));
        cache.Set(TokenCacheKey, token, ttl);
        return token;
    }

    private async Task<JsonDocument?> GetJsonAsync(string url, string token, CancellationToken ct)
    {
        var client = httpFactory.CreateClient(HttpClientName);
        using var req = new HttpRequestMessage(HttpMethod.Get, url);
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);

        using var res = await client.SendAsync(req, ct);
        if (!res.IsSuccessStatusCode)
        {
            logger.LogWarning("FatSecret API returned {Status}.", (int)res.StatusCode);
            return null;
        }

        var bytes = await ReadCappedAsync(res, MaxApiResponseBytes, ct);
        return bytes is null ? null : JsonDocument.Parse(bytes);
    }

    /// <summary>Buffer a response body into memory but abort if it exceeds <paramref name="maxBytes"/>,
    /// so a hostile/compromised/MITM'd endpoint cannot force an arbitrarily large allocation. Returns
    /// null if the body is over the cap (or lies about its Content-Length) or a read error occurs.</summary>
    private static async Task<byte[]?> ReadCappedAsync(HttpResponseMessage res, int maxBytes, CancellationToken ct)
    {
        // If the endpoint advertises a length, reject oversized bodies before reading a single byte.
        if (res.Content.Headers.ContentLength is long len && len > maxBytes) return null;

        await using var stream = await res.Content.ReadAsStreamAsync(ct);
        using var buffer = new MemoryStream();
        var chunk = new byte[8192];
        int read;
        while ((read = await stream.ReadAsync(chunk.AsMemory(0, chunk.Length), ct)) > 0)
        {
            if (buffer.Length + read > maxBytes) return null;
            buffer.Write(chunk, 0, read);
        }
        return buffer.ToArray();
    }

    // ===================================================================================
    // Parsing
    // ===================================================================================

    /// <summary>
    /// Parse a foods.search response. <c>foods.food</c> can be absent (no matches), a single object, or
    /// an array; <c>foods.total_results</c> can be "0". Each food carries a <c>food_description</c> string
    /// like "Per 100g - Calories: 89kcal | Fat: 0.33g | Carbs: 22.84g | Protein: 1.09g".
    /// </summary>
    private static IReadOnlyList<FoodSearchItemDto> ParseSearch(JsonElement root)
    {
        if (!root.TryGetProperty("foods", out var foods) || foods.ValueKind != JsonValueKind.Object)
            return Array.Empty<FoodSearchItemDto>();

        if (foods.TryGetProperty("total_results", out var total)
            && string.Equals(GetRawString(total), "0", StringComparison.Ordinal))
            return Array.Empty<FoodSearchItemDto>();

        if (!foods.TryGetProperty("food", out var food)) return Array.Empty<FoodSearchItemDto>();

        var list = new List<FoodSearchItemDto>();
        if (food.ValueKind == JsonValueKind.Array)
        {
            foreach (var el in food.EnumerateArray())
            {
                var item = ParseSearchFood(el);
                if (item is not null) list.Add(item);
            }
        }
        else if (food.ValueKind == JsonValueKind.Object)
        {
            var item = ParseSearchFood(food);
            if (item is not null) list.Add(item);
        }
        return list;
    }

    private static FoodSearchItemDto? ParseSearchFood(JsonElement food)
    {
        var foodId = GetString(food, "food_id");
        var name = GetString(food, "food_name");
        if (string.IsNullOrEmpty(foodId) || string.IsNullOrEmpty(name)) return null;

        var brand = GetString(food, "brand_name");
        var desc = GetString(food, "food_description") ?? "";
        var n = ParseDescription(desc);

        return new FoodSearchItemDto
        {
            FdcId = 0,
            Description = name!,
            Brand = string.IsNullOrEmpty(brand) ? null : brand,
            GtinUpc = null,
            Calories = n.Calories,
            ProteinG = n.ProteinG,
            CarbG = n.CarbG,
            FatG = n.FatG,
            ServingSize = n.ServingSize,
            ServingUnit = n.ServingUnit,
            Basis = n.Basis,
            Source = "fatsecret",
            SourceId = foodId,
        };
    }

    /// <summary>
    /// Parse a food.get.v2 response into one item from its FIRST serving. Returns null when the shape is
    /// unusable.
    /// </summary>
    private static FoodSearchItemDto? ParseFood(JsonElement root, string foodId)
    {
        if (!root.TryGetProperty("food", out var food) || food.ValueKind != JsonValueKind.Object)
            return null;

        var name = GetString(food, "food_name");
        if (string.IsNullOrEmpty(name)) return null;
        var brand = GetString(food, "brand_name");

        if (!food.TryGetProperty("servings", out var servings) || servings.ValueKind != JsonValueKind.Object)
            return null;
        if (!servings.TryGetProperty("serving", out var serving)) return null;

        // serving may be an array (take the first) or a single object.
        var first = serving.ValueKind == JsonValueKind.Array
            ? (serving.GetArrayLength() > 0 ? serving[0] : default)
            : serving;
        if (first.ValueKind != JsonValueKind.Object) return null;

        var calories = (int)Math.Round(GetNumber(first, "calories") ?? 0);
        var protein = Round1(GetNumber(first, "protein") ?? 0);
        var carbs = Round1(GetNumber(first, "carbohydrate") ?? 0);
        var fat = Round1(GetNumber(first, "fat") ?? 0);
        var servingDesc = GetString(first, "serving_description");
        var metricAmount = GetNumber(first, "metric_serving_amount");
        var metricUnit = GetString(first, "metric_serving_unit");
        var basis = IsPer100(servingDesc) || IsPer100(metricUnit) ? "per100g" : "perServing";

        return new FoodSearchItemDto
        {
            FdcId = 0,
            Description = name!,
            Brand = string.IsNullOrEmpty(brand) ? null : brand,
            GtinUpc = null,
            Calories = calories,
            ProteinG = protein,
            CarbG = carbs,
            FatG = fat,
            ServingSize = metricAmount,
            ServingUnit = metricUnit ?? servingDesc,
            Basis = basis,
            Source = "fatsecret",
            SourceId = foodId,
        };
    }

    private static string? ExtractBarcodeFoodId(JsonElement? rootNullable)
    {
        if (rootNullable is not { } root) return null;
        // { "food_id": { "value": "12345" } } or { "food_id": "12345" }
        if (!root.TryGetProperty("food_id", out var foodId)) return null;
        if (foodId.ValueKind == JsonValueKind.Object && foodId.TryGetProperty("value", out var inner))
            return GetRawString(inner);
        return GetRawString(foodId);
    }

    // ===================================================================================
    // food_description parser (exposed for unit tests)
    // ===================================================================================

    /// <summary>Normalized nutrition pulled from a FatSecret <c>food_description</c> string.</summary>
    public readonly record struct DescriptionNutrition(
        int Calories, double ProteinG, double CarbG, double FatG,
        double? ServingSize, string? ServingUnit, string Basis);

    private static readonly Regex CaloriesRe =
        new(@"Calories:\s*([\d.]+)\s*kcal", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex FatRe =
        new(@"Fat:\s*([\d.]+)\s*g", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex CarbsRe =
        new(@"Carbs:\s*([\d.]+)\s*g", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex ProteinRe =
        new(@"Protein:\s*([\d.]+)\s*g", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    // The "Per X" prefix up to the first " - " separator (e.g. "Per 100g", "Per 1 cup (240 g)").
    private static readonly Regex PerRe =
        new(@"^Per\s+(.+?)\s*-\s", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    /// <summary>
    /// Parse a FatSecret <c>food_description</c> such as
    /// "Per 100g - Calories: 89kcal | Fat: 0.33g | Carbs: 22.84g | Protein: 1.09g" into kcal + macros and
    /// the serving phrase after "Per". The basis is per100g when the serving phrase mentions 100g/100ml,
    /// else perServing. Missing fields default to 0 / null (never throws).
    /// </summary>
    public static DescriptionNutrition ParseDescription(string? description)
    {
        var s = description ?? "";
        var calories = (int)Math.Round(MatchNum(CaloriesRe, s));
        var fat = Round1(MatchNum(FatRe, s));
        var carbs = Round1(MatchNum(CarbsRe, s));
        var protein = Round1(MatchNum(ProteinRe, s));

        string? servingUnit = null;
        var per = PerRe.Match(s);
        if (per.Success) servingUnit = per.Groups[1].Value.Trim();

        var basis = IsPer100(servingUnit) ? "per100g" : "perServing";
        return new DescriptionNutrition(calories, protein, carbs, fat, null, servingUnit, basis);
    }

    private static bool IsPer100(string? phrase)
    {
        if (string.IsNullOrEmpty(phrase)) return false;
        var p = phrase.Replace(" ", "").ToLowerInvariant();
        return p.Contains("100g") || p.Contains("100ml");
    }

    private static double MatchNum(Regex re, string input)
    {
        var m = re.Match(input);
        return m.Success && double.TryParse(m.Groups[1].Value, NumberStyles.Float, CultureInfo.InvariantCulture, out var v)
            ? v : 0;
    }

    // ===================================================================================
    // JSON helpers (FatSecret returns numbers as JSON strings)
    // ===================================================================================

    private string ApiTrimmed() => (_opt.ApiUrl ?? "").TrimEnd('/');

    private static double Round1(double v) => Math.Round(v, 1);

    private static string? GetString(JsonElement el, string prop) =>
        el.TryGetProperty(prop, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static string? GetRawString(JsonElement v) => v.ValueKind switch
    {
        JsonValueKind.String => v.GetString(),
        JsonValueKind.Number => v.GetRawText(),
        _ => null,
    };

    private static double? GetNumber(JsonElement el, string prop)
    {
        if (!el.TryGetProperty(prop, out var v)) return null;
        return v.ValueKind switch
        {
            JsonValueKind.Number when v.TryGetDouble(out var d) => d,
            JsonValueKind.String when double.TryParse(v.GetString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var d) => d,
            _ => null,
        };
    }
}
