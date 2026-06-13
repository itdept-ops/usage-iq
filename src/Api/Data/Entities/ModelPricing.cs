namespace Ccusage.Api.Data.Entities;

/// <summary>
/// Editable per-model pricing. Rates are USD per <b>million</b> tokens. Lookup is
/// exact match first, then longest matching prefix, then the catch-all <c>*</c> row.
/// </summary>
public class ModelPricing
{
    public int Id { get; set; }

    /// <summary>Exact model id, a prefix, or <c>*</c> for the fallback row.</summary>
    public string ModelPattern { get; set; } = "";

    /// <summary>Friendly label shown in the pricing editor.</summary>
    public string? DisplayName { get; set; }

    public decimal InputPerMTok { get; set; }
    public decimal OutputPerMTok { get; set; }
    public decimal CacheWrite5mPerMTok { get; set; }
    public decimal CacheWrite1hPerMTok { get; set; }
    public decimal CacheReadPerMTok { get; set; }

    /// <summary>True when the rate is a guess (e.g. internal models with no public price).</summary>
    public bool IsPlaceholder { get; set; }
}
