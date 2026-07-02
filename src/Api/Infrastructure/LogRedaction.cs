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
    // IMPORTANT: key-name matching is a denylist and only catches the keys listed here. Review and
    // extend this constant whenever a new secret-bearing field is introduced (e.g. privateKey,
    // sessionToken, otp, backupCode, tokenHash). Value-pattern redaction below is a backstop, not a
    // substitute — it only covers a few well-known shapes (JWT, coordinates).
    private const string SecretKeys =
        "token|id_token|access_token|refresh_token|code|password|secret|clientSecret|client_secret|apiKey|api_key|authorization|webhookUrl|webhook_url|discordWebhookUrl|DiscordWebhookUrl|privateKey|private_key|sessionToken|session_token|otp|backupCode|backup_code|tokenHash|token_hash";

    [GeneratedRegex("\"(?<k>" + SecretKeys + ")\"\\s*:\\s*\"(?:[^\"\\\\]|\\\\.)*\"", RegexOptions.IgnoreCase)]
    private static partial Regex SecretJsonFieldRegex();

    [GeneratedRegex("(?<k>" + SecretKeys + ")=(?<v>[^&]*)", RegexOptions.IgnoreCase)]
    private static partial Regex SecretPairRegex();

    // Value-pattern backstop: mask values that LOOK sensitive regardless of their key name, so a
    // secret value under a key not in SecretKeys is still not stored verbatim. Emails are deliberately
    // NOT value-redacted here: other users' emails are already withheld at the /users endpoint (the
    // per-admin users.email.reveal permission) and sensitive paths are excluded from body capture in
    // the middleware, so blanket email masking would only harm debuggability of a caller's own data.
    // JWT / bearer-style token: three base64url segments separated by dots.
    [GeneratedRegex(@"\beyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\b")]
    private static partial Regex JwtValueRegex();

    // Precise lat/lng coordinate values (signed decimals with a fractional part) in JSON or pairs,
    // e.g. "lat":37.421998 / longitude=-122.084 . Whole integers are left alone to avoid over-masking.
    [GeneratedRegex(
        "(?<k>lat|lng|lon|latitude|longitude)(?<sep>\"\\s*:\\s*|\\s*=\\s*)(?<v>-?\\d+\\.\\d+)",
        RegexOptions.IgnoreCase)]
    private static partial Regex CoordinateValueRegex();

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
        cleaned = RedactValuePatterns(cleaned);
        return Truncate(cleaned);
    }

    /// <summary>Redact secret-bearing query-string params (e.g. <c>?access_token=…</c>); column-safe length.</summary>
    public static string? RedactQuery(string? query, string path)
    {
        if (string.IsNullOrEmpty(query)) return query;
        if (IsSensitivePath(path)) return SensitiveMarker;

        var cleaned = SecretPairRegex().Replace(query, m => $"{m.Groups["k"].Value}=[redacted]");
        cleaned = RedactValuePatterns(cleaned);
        return cleaned.Length <= MaxQueryChars ? cleaned : cleaned[..MaxQueryChars];
    }

    /// <summary>
    /// Backstop for key-name redaction: mask values that match known-sensitive shapes (JWT and
    /// precise coordinates) even when their key is not in <see cref="SecretKeys"/>.
    /// </summary>
    private static string RedactValuePatterns(string s)
    {
        s = JwtValueRegex().Replace(s, SensitiveMarker);
        s = CoordinateValueRegex().Replace(s, m => $"{m.Groups["k"].Value}{m.Groups["sep"].Value}[redacted]");
        return s;
    }

    public static string Truncate(string s) =>
        s.Length <= MaxBodyChars ? s : s[..MaxBodyChars] + "…[truncated]";
}
