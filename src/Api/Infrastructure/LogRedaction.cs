using System.Text.RegularExpressions;

namespace Ccusage.Api.Infrastructure;

/// <summary>
/// Sanitizes captured request/response data before it is persisted: whole-value redaction for auth
/// routes (which carry the Google token and the issued JWT), field-level redaction of common secret
/// keys in JSON and urlencoded/query forms elsewhere, and truncation to a fixed cap.
/// </summary>
public static partial class LogRedaction
{
    public const int MaxBodyChars = 4096;
    private const int MaxQueryChars = 4096; // must fit the RequestLog.QueryString column

    // Secret keys, matched in JSON ("key":"value") and in urlencoded/query pairs (key=value).
    private const string SecretKeys =
        "token|id_token|access_token|refresh_token|code|password|secret|clientSecret|client_secret|apiKey|api_key|authorization|webhookUrl|webhook_url|discordWebhookUrl|DiscordWebhookUrl";

    [GeneratedRegex("\"(?<k>" + SecretKeys + ")\"\\s*:\\s*\"(?:[^\"\\\\]|\\\\.)*\"", RegexOptions.IgnoreCase)]
    private static partial Regex SecretJsonFieldRegex();

    [GeneratedRegex("(?<k>" + SecretKeys + ")=(?<v>[^&]*)", RegexOptions.IgnoreCase)]
    private static partial Regex SecretPairRegex();

    private const string SensitiveMarker = "[redacted]";

    /// <summary>True for paths whose request/response carry a secret and must never be stored verbatim.</summary>
    public static bool IsSensitivePath(string path) =>
        path.StartsWith("/api/auth", StringComparison.OrdinalIgnoreCase)            // Google token in, JWT out
        || path.StartsWith("/api/notifications", StringComparison.OrdinalIgnoreCase) // Discord webhook URL
        || path.StartsWith("/api/shares", StringComparison.OrdinalIgnoreCase)        // share tokens travel in create/list bodies
        || path.StartsWith("/api/ingest-keys", StringComparison.OrdinalIgnoreCase)   // create response carries the raw ingest key
        || path.StartsWith("/api/family/calendar", StringComparison.OrdinalIgnoreCase); // /connect body carries a one-time Google auth code

    /// <summary>Redact a captured request/response body (JSON or urlencoded), then truncate.</summary>
    public static string? Redact(string? body, string path)
    {
        if (string.IsNullOrEmpty(body)) return body;
        if (IsSensitivePath(path)) return SensitiveMarker;

        var cleaned = SecretJsonFieldRegex().Replace(body, m => $"\"{m.Groups["k"].Value}\":\"[redacted]\"");
        cleaned = SecretPairRegex().Replace(cleaned, m => $"{m.Groups["k"].Value}=[redacted]");
        return Truncate(cleaned);
    }

    /// <summary>Redact secret-bearing query-string params (e.g. <c>?access_token=…</c>); column-safe length.</summary>
    public static string? RedactQuery(string? query, string path)
    {
        if (string.IsNullOrEmpty(query)) return query;
        if (IsSensitivePath(path)) return SensitiveMarker;

        var cleaned = SecretPairRegex().Replace(query, m => $"{m.Groups["k"].Value}=[redacted]");
        return cleaned.Length <= MaxQueryChars ? cleaned : cleaned[..MaxQueryChars];
    }

    public static string Truncate(string s) =>
        s.Length <= MaxBodyChars ? s : s[..MaxBodyChars] + "…[truncated]";
}
