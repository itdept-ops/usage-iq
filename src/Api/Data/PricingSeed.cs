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
        // Fable — no public price yet. We seed an ESTIMATED rate that mirrors the Opus tier (its closest
        // sibling) so cost figures are reasonable rather than $0, and clear the placeholder flag so the
        // dashboard's "placeholder pricing" warning no longer fires for it. NOTE: this is an estimate —
        // adjust it on the Pricing page once a real Fable 5 rate is published.
        new() { Id = 4, ModelPattern = "claude-fable-5", DisplayName = "Claude Fable 5 (estimated)",
            InputPerMTok = 15m, OutputPerMTok = 75m, CacheWrite5mPerMTok = 18.75m, CacheWrite1hPerMTok = 30m, CacheReadPerMTok = 1.50m, IsPlaceholder = false },
        // Catch-all fallback for any unpriced/unknown model (incl. <synthetic>): $0 until you price it.
        new() { Id = 5, ModelPattern = "*", DisplayName = "Unpriced fallback",
            InputPerMTok = 0m, OutputPerMTok = 0m, CacheWrite5mPerMTok = 0m, CacheWrite1hPerMTok = 0m, CacheReadPerMTok = 0m, IsPlaceholder = true },

        // --- OpenAI / Codex (placeholder estimates; no cache-write tier — cached input maps to cache-read) ---
        new() { Id = 6, ModelPattern = "gpt-5.5", DisplayName = "GPT-5.5 (placeholder)",
            InputPerMTok = 1.25m, OutputPerMTok = 10.00m, CacheWrite5mPerMTok = 0m, CacheWrite1hPerMTok = 0m, CacheReadPerMTok = 0.125m, IsPlaceholder = true },
        new() { Id = 7, ModelPattern = "gpt-5.4", DisplayName = "GPT-5.4 (placeholder)",
            InputPerMTok = 1.25m, OutputPerMTok = 10.00m, CacheWrite5mPerMTok = 0m, CacheWrite1hPerMTok = 0m, CacheReadPerMTok = 0.125m, IsPlaceholder = true },
        // Prefix matches gpt-5.3-codex-spark and other 5.3 codex variants.
        new() { Id = 8, ModelPattern = "gpt-5.3-codex", DisplayName = "GPT-5.3 Codex (placeholder)",
            InputPerMTok = 0.50m, OutputPerMTok = 4.00m, CacheWrite5mPerMTok = 0m, CacheWrite1hPerMTok = 0m, CacheReadPerMTok = 0.05m, IsPlaceholder = true },
        // Catch-all for any other GPT model.
        new() { Id = 9, ModelPattern = "gpt-", DisplayName = "Other GPT (placeholder)",
            InputPerMTok = 1.25m, OutputPerMTok = 10.00m, CacheWrite5mPerMTok = 0m, CacheWrite1hPerMTok = 0m, CacheReadPerMTok = 0.125m, IsPlaceholder = true },
    ];
}
