using Ccusage.Api.Data.Entities;

namespace Ccusage.Api.Ingestion;

/// <summary>
/// Resolves the right <see cref="ModelPricing"/> for a model string and computes cost.
/// Match order: exact &gt; longest matching prefix &gt; the <c>*</c> fallback row.
/// </summary>
public sealed class PricingMatcher
{
    private readonly Dictionary<string, ModelPricing> _exact;
    private readonly List<ModelPricing> _prefixes; // longest pattern first
    private readonly ModelPricing _fallback;
    private readonly Dictionary<string, ModelPricing> _cache = new(StringComparer.Ordinal);

    public PricingMatcher(IEnumerable<ModelPricing> rows)
    {
        var list = rows.ToList();
        _fallback = list.FirstOrDefault(r => r.ModelPattern == "*")
            ?? new ModelPricing { ModelPattern = "*", IsPlaceholder = true };
        _exact = list.Where(r => r.ModelPattern != "*")
            .GroupBy(r => r.ModelPattern, StringComparer.Ordinal)
            .ToDictionary(g => g.Key, g => g.First(), StringComparer.Ordinal);
        _prefixes = list.Where(r => r.ModelPattern != "*")
            .OrderByDescending(r => r.ModelPattern.Length)
            .ToList();
    }

    /// <summary>The set of model strings that matched only the fallback row (for diagnostics).</summary>
    public HashSet<string> UnpricedModels { get; } = new(StringComparer.Ordinal);

    public ModelPricing Resolve(string model)
    {
        if (_cache.TryGetValue(model, out var hit)) return hit;

        ModelPricing match;
        if (_exact.TryGetValue(model, out var exact))
        {
            match = exact;
        }
        else
        {
            match = _prefixes.FirstOrDefault(p => model.StartsWith(p.ModelPattern, StringComparison.Ordinal))
                    ?? _fallback;
            if (ReferenceEquals(match, _fallback)) UnpricedModels.Add(model);
        }

        _cache[model] = match;
        return match;
    }

    /// <summary>USD cost for a single record using its model's resolved rates.</summary>
    public decimal Cost(string model, long input, long output, long read, long write5m, long write1h)
    {
        var p = Resolve(model);
        const decimal M = 1_000_000m;
        return input  / M * p.InputPerMTok
             + output / M * p.OutputPerMTok
             + read   / M * p.CacheReadPerMTok
             + write5m / M * p.CacheWrite5mPerMTok
             + write1h / M * p.CacheWrite1hPerMTok;
    }
}
