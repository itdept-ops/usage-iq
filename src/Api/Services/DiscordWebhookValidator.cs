namespace Ccusage.Api.Services;

/// <summary>
/// The single SSRF allowlist + hint-masking helper shared by BOTH the per-user webhook save and the
/// system webhook save. A user-supplied webhook URL is an SSRF surface, so this is the one place that
/// decides a URL is a genuine Discord webhook (https + a Discord host + a /api/webhooks/ path) — it
/// delegates the host/scheme/path check to <see cref="DiscordNotifier.IsValidWebhook"/> (the SAME
/// allowlist the poster re-checks at send time) so there is exactly one definition of "valid".
/// </summary>
public static class DiscordWebhookValidator
{
    /// <summary>
    /// True only for an https Discord webhook URL on an allowlisted host with a /api/webhooks/ path.
    /// Rejects every non-Discord host, http, localhost/private IPs, metadata endpoints, and bad paths.
    /// </summary>
    public static bool IsValid(string? url) => DiscordNotifier.IsValidWebhook(url);

    /// <summary>
    /// A NON-SENSITIVE masked hint for a (validated) webhook URL — the numeric id segment and the last
    /// 4 chars of the token, e.g. <c>discord.com/api/webhooks/12345…/abcd</c>. Never exposes the full
    /// token. Returns null for a null/empty/invalid URL.
    /// </summary>
    public static string? Hint(string? url)
    {
        if (string.IsNullOrWhiteSpace(url) || !IsValid(url)) return null;

        // Path looks like /api/webhooks/{id}/{token}. Pull id + last 4 of token without ever keeping the token.
        var uri = new Uri(url);
        var parts = uri.AbsolutePath.Split('/', StringSplitOptions.RemoveEmptyEntries);
        // parts: ["api","webhooks","{id}","{token}"]
        var id = parts.Length >= 3 ? parts[2] : "";
        var token = parts.Length >= 4 ? parts[3] : "";
        var idHint = string.IsNullOrEmpty(id) ? "…" : $"{id[..Math.Min(id.Length, 8)]}…";
        var tokenTail = token.Length <= 4 ? token : token[^4..];
        return $"discord.com/api/webhooks/{idHint}/{tokenTail}";
    }
}
