using Ccusage.Api.Data.Entities;

namespace Ccusage.Api.Data;

/// <summary>
/// Starting per-model rates (USD per million tokens). These are best-known public
/// tiers used as defaults; every value is editable in the Pricing page. Models with
/// no public price (e.g. <c>claude-fable-5</c>) are flagged as placeholders.
/// </summary>
public static class PricingSeed
{
    public static readonly ModelPricing[] Rows =
    [
        // Opus tier
        new() { Id = 1, ModelPattern = "claude-opus-4-8", DisplayName = "Claude Opus 4.8",
            InputPerMTok = 15m, OutputPerMTok = 75m, CacheWrite5mPerMTok = 18.75m, CacheWrite1hPerMTok = 30m, CacheReadPerMTok = 1.50m },
        new() { Id = 2, ModelPattern = "claude-opus-4-7", DisplayName = "Claude Opus 4.7",
            InputPerMTok = 15m, OutputPerMTok = 75m, CacheWrite5mPerMTok = 18.75m, CacheWrite1hPerMTok = 30m, CacheReadPerMTok = 1.50m },
        // Haiku tier (prefix matches the date-suffixed id, e.g. claude-haiku-4-5-20251001)
        new() { Id = 3, ModelPattern = "claude-haiku-4-5", DisplayName = "Claude Haiku 4.5",
            InputPerMTok = 1.00m, OutputPerMTok = 5.00m, CacheWrite5mPerMTok = 1.25m, CacheWrite1hPerMTok = 2.00m, CacheReadPerMTok = 0.10m },
        // Fable — no public price; placeholder you can correct in the UI.
        new() { Id = 4, ModelPattern = "claude-fable-5", DisplayName = "Claude Fable 5 (placeholder)",
            InputPerMTok = 3.00m, OutputPerMTok = 15.00m, CacheWrite5mPerMTok = 3.75m, CacheWrite1hPerMTok = 6.00m, CacheReadPerMTok = 0.30m, IsPlaceholder = true },
        // Catch-all fallback for any unpriced/unknown model (incl. <synthetic>): $0 until you price it.
        new() { Id = 5, ModelPattern = "*", DisplayName = "Unpriced fallback",
            InputPerMTok = 0m, OutputPerMTok = 0m, CacheWrite5mPerMTok = 0m, CacheWrite1hPerMTok = 0m, CacheReadPerMTok = 0m, IsPlaceholder = true },
    ];
}
