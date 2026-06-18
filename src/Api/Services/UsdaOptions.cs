namespace Ccusage.Api.Services;

/// <summary>
/// Bound from the <c>Usda</c> configuration section. <see cref="ApiKey"/> is a secret (read from the
/// git-ignored appsettings.Local.json locally, or the <c>Usda__ApiKey</c> env var in prod) and is
/// NEVER logged. When it is blank the food-search/details endpoints return 503; the rest of the
/// tracker still works. <see cref="BaseUrl"/> is a fixed, non-user-controlled host.
/// </summary>
public sealed class UsdaOptions
{
    public const string SectionName = "Usda";

    /// <summary>FoodData Central API key. Blank disables the food lookup endpoints (503).</summary>
    public string? ApiKey { get; set; }

    /// <summary>The FDC API root; defaults to the public host. Never chosen from user input.</summary>
    public string BaseUrl { get; set; } = "https://api.nal.usda.gov/fdc/v1";

    public bool IsConfigured => !string.IsNullOrWhiteSpace(ApiKey);
}
