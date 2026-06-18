using System.Net;
using System.Text.Json;
using Ccusage.Api.Dtos;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Options;

namespace Ccusage.Api.Services;

/// <summary>
/// Thrown when a USDA lookup is attempted but no API key is configured. The endpoint layer maps this
/// to a 503 ProblemDetails ("USDA FoodData Central is not configured.") while the rest of the tracker
/// keeps working.
/// </summary>
public sealed class UsdaNotConfiguredException() : Exception("USDA FoodData Central is not configured.");

/// <summary>
/// Wraps the USDA FoodData Central (FDC) REST API: full-text + barcode (UPC/GTIN) search and
/// single-food details, normalized to <see cref="FoodSearchItemDto"/>. Responses are cached in memory
/// (keyed by query/fdcId) for a few minutes to respect the ~1000 req/hr key limit. The api_key is
/// passed only as a query parameter and is NEVER logged. The host is fixed (from <see cref="UsdaOptions.BaseUrl"/>),
/// never chosen from user input, so there is no SSRF surface here.
/// </summary>
public sealed class UsdaFoodService(
    IHttpClientFactory httpFactory,
    IOptions<UsdaOptions> options,
    IMemoryCache cache,
    ILogger<UsdaFoodService> logger)
{
    public const string HttpClientName = "usda";
    private static readonly TimeSpan CacheTtl = TimeSpan.FromMinutes(5);

    private readonly UsdaOptions _opt = options.Value;

    public bool IsConfigured => _opt.IsConfigured;

    /// <summary>
    /// Search for foods by free-text query OR by barcode (the UPC/GTIN digits). Returns up to 25
    /// normalized matches. Cached by the effective query for a few minutes. Throws
    /// <see cref="UsdaNotConfiguredException"/> when no API key is set.
    /// </summary>
    public async Task<IReadOnlyList<FoodSearchItemDto>> SearchAsync(
        string? query, string? barcode, CancellationToken ct = default)
    {
        EnsureConfigured();

        var term = !string.IsNullOrWhiteSpace(barcode) ? barcode!.Trim() : (query ?? "").Trim();
        if (term.Length == 0) return Array.Empty<FoodSearchItemDto>();

        var cacheKey = $"usda:search:{term.ToLowerInvariant()}";
        if (cache.TryGetValue(cacheKey, out IReadOnlyList<FoodSearchItemDto>? cached) && cached is not null)
            return cached;

        // The api_key + query travel as query-string params; never interpolate them into a host.
        var url = $"{BaseTrimmed()}/foods/search"
                  + $"?api_key={Uri.EscapeDataString(_opt.ApiKey!)}"
                  + $"&query={Uri.EscapeDataString(term)}"
                  + "&pageSize=25";

        using var doc = await GetAsync(url, ct);
        var items = ParseSearch(doc);

        cache.Set(cacheKey, items, CacheTtl);
        return items;
    }

    /// <summary>
    /// Fetch one food by its FDC id, normalized. Cached for a few minutes. Returns null when the id is
    /// unknown (404). Throws <see cref="UsdaNotConfiguredException"/> when no API key is set.
    /// </summary>
    public async Task<FoodSearchItemDto?> GetDetailsAsync(int fdcId, CancellationToken ct = default)
    {
        EnsureConfigured();

        var cacheKey = $"usda:food:{fdcId}";
        if (cache.TryGetValue(cacheKey, out FoodSearchItemDto? cached))
            return cached;

        var url = $"{BaseTrimmed()}/food/{fdcId}?api_key={Uri.EscapeDataString(_opt.ApiKey!)}";

        using var doc = await GetAsync(url, ct, allowNotFound: true);
        var item = doc is null ? null : ParseOne(doc.RootElement);

        cache.Set(cacheKey, item, CacheTtl);
        return item;
    }

    private void EnsureConfigured()
    {
        if (!_opt.IsConfigured) throw new UsdaNotConfiguredException();
    }

    private string BaseTrimmed() => (_opt.BaseUrl ?? "").TrimEnd('/');

    /// <summary>GET + parse JSON. Returns null on 404 when <paramref name="allowNotFound"/>; throws otherwise.</summary>
    private async Task<JsonDocument?> GetAsync(string url, CancellationToken ct, bool allowNotFound = false)
    {
        var client = httpFactory.CreateClient(HttpClientName);
        using var res = await client.GetAsync(url, ct);

        if (allowNotFound && res.StatusCode == HttpStatusCode.NotFound) return null;

        if (!res.IsSuccessStatusCode)
        {
            // Never log the URL — it carries the api_key. Log the status only.
            logger.LogWarning("USDA FoodData Central returned {Status}.", (int)res.StatusCode);
            res.EnsureSuccessStatusCode(); // surfaces as a 500/handled upstream
        }

        await using var stream = await res.Content.ReadAsStreamAsync(ct);
        return await JsonDocument.ParseAsync(stream, cancellationToken: ct);
    }

    private static IReadOnlyList<FoodSearchItemDto> ParseSearch(JsonDocument? doc)
    {
        if (doc is null) return Array.Empty<FoodSearchItemDto>();
        if (!doc.RootElement.TryGetProperty("foods", out var foods) || foods.ValueKind != JsonValueKind.Array)
            return Array.Empty<FoodSearchItemDto>();

        var list = new List<FoodSearchItemDto>();
        foreach (var food in foods.EnumerateArray())
            list.Add(ParseOne(food));
        return list;
    }

    /// <summary>
    /// Normalize one FDC food element to our DTO: energy kcal (208/1008), protein (203), carbs (205),
    /// fat (204); serving size/unit; brand + gtinUpc; and the per-serving vs per-100g basis. Branded
    /// foods report per-serving values; Foundation / SR Legacy report per 100 g.
    /// </summary>
    private static FoodSearchItemDto ParseOne(JsonElement food)
    {
        var dataType = GetString(food, "dataType");
        // Value checks, not presence: FDC can emit a null brandOwner on a non-branded row, and
        // TryGetProperty is true even for a null value — which would mis-flag SR/Foundation as per-serving.
        var isBranded = string.Equals(dataType, "Branded", StringComparison.OrdinalIgnoreCase)
                        || !string.IsNullOrEmpty(GetString(food, "brandOwner"))
                        || !string.IsNullOrEmpty(GetString(food, "brandName"))
                        || !string.IsNullOrEmpty(GetString(food, "gtinUpc"));

        var brand = GetString(food, "brandName") ?? GetString(food, "brandOwner");
        var gtin = GetString(food, "gtinUpc");

        double calories = 0, protein = 0, carbs = 0, fat = 0;
        if (food.TryGetProperty("foodNutrients", out var nutrients) && nutrients.ValueKind == JsonValueKind.Array)
        {
            foreach (var n in nutrients.EnumerateArray())
            {
                var (number, id, name, unit, amount) = ReadNutrient(n);
                if (IsEnergyKcal(number, id, name, unit)) calories = amount;
                else if (number == "203" || id == 1003) protein = amount;
                else if (number == "205" || id == 1005) carbs = amount;
                else if (number == "204" || id == 1004) fat = amount;
            }
        }

        double? servingSize = GetDouble(food, "servingSize");
        var servingUnit = GetString(food, "servingSizeUnit");

        return new FoodSearchItemDto
        {
            FdcId = GetInt(food, "fdcId") ?? 0,
            Description = GetString(food, "description") ?? "",
            Brand = brand,
            GtinUpc = gtin,
            Calories = (int)Math.Round(calories),
            ProteinG = Round1(protein),
            CarbG = Round1(carbs),
            FatG = Round1(fat),
            ServingSize = servingSize,
            ServingUnit = servingUnit,
            Basis = isBranded ? "perServing" : "per100g",
        };
    }

    /// <summary>Energy in kcal: nutrientNumber 208 / nutrientId 1008, or a name containing "Energy"
    /// reported in kcal (FDC also lists Energy in kJ, which must be ignored).</summary>
    private static bool IsEnergyKcal(string? number, int? id, string? name, string? unit)
    {
        if (number == "208" || id == 1008) return true;
        return name is not null
               && name.Contains("Energy", StringComparison.OrdinalIgnoreCase)
               && string.Equals(unit, "kcal", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// FDC returns nutrients in two shapes: search results flatten the fields onto the element
    /// (nutrientNumber/nutrientId/nutrientName/unitName/value), while /food details nest them under a
    /// "nutrient" object with "amount". Read both.
    /// </summary>
    private static (string? number, int? id, string? name, string? unit, double amount) ReadNutrient(JsonElement n)
    {
        if (n.TryGetProperty("nutrient", out var nested) && nested.ValueKind == JsonValueKind.Object)
        {
            return (
                GetString(nested, "number"),
                GetInt(nested, "id"),
                GetString(nested, "name"),
                GetString(nested, "unitName"),
                GetDouble(n, "amount") ?? 0);
        }

        return (
            GetString(n, "nutrientNumber"),
            GetInt(n, "nutrientId"),
            GetString(n, "nutrientName"),
            GetString(n, "unitName"),
            GetDouble(n, "value") ?? 0);
    }

    private static double Round1(double v) => Math.Round(v, 1);

    private static string? GetString(JsonElement el, string prop) =>
        el.TryGetProperty(prop, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static int? GetInt(JsonElement el, string prop)
    {
        if (!el.TryGetProperty(prop, out var v)) return null;
        return v.ValueKind switch
        {
            JsonValueKind.Number when v.TryGetInt32(out var i) => i,
            JsonValueKind.String when int.TryParse(v.GetString(), out var i) => i,
            _ => null,
        };
    }

    private static double? GetDouble(JsonElement el, string prop)
    {
        if (!el.TryGetProperty(prop, out var v)) return null;
        return v.ValueKind switch
        {
            JsonValueKind.Number when v.TryGetDouble(out var d) => d,
            JsonValueKind.String when double.TryParse(v.GetString(), out var d) => d,
            _ => null,
        };
    }
}
