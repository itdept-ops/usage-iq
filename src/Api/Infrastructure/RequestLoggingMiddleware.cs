using System.Diagnostics;
using System.Text;
using Ccusage.Api.Data.Entities;

namespace Ccusage.Api.Infrastructure;

/// <summary>
/// Captures one <see cref="RequestLog"/> per API request — method, path, status, duration, caller,
/// IP, payload sizes, and truncated+redacted request/response bodies — and hands it to the
/// background <see cref="RequestLogWriter"/>. Registered as the outermost middleware so the status
/// it records is the final one (after the exception handler). Health/probe and high-frequency
/// polling routes are skipped to keep the log signal-rich.
/// </summary>
public sealed class RequestLoggingMiddleware(RequestDelegate next, RequestLogQueue queue)
{
    private const int MaxCaptureBytes = 16 * 1024;       // capture window; the text is further trimmed on redact
    private const long MaxRequestBufferBytes = 256 * 1024; // don't EnableBuffering for uploads larger than this

    // Logged surface: everything under /api except these (probes + the SPA's background polls + self).
    // "/api/share" (singular) is the public token read — exclude it so live tokens never land in the log
    // (segment-based match leaves "/api/shares" management endpoints logged). "/api/bill-share" is the Bill
    // Splitter's public anonymous token read + claim — excluded for the same reason (live tokens out of the log).
    private static readonly string[] Excluded =
    {
        "/api/auth/me", "/api/auth/config", "/api/sync/status", "/api/presence", "/api/logs", "/api/share",
        "/api/bill-share", // public bill-claim token read + claim; live tokens must never land in the action log
        "/api/ingest", // high-volume reporter pushes; the IngestKey LastUsed stamp is the activity trail
    };

    // The anonymous DB-free liveness probe lives at exactly "/api/health". Match it EXACTLY (not as a
    // segment prefix) so the wearable Health-Sync actions mapped under /api/health/* (connect/sync-now/
    // disconnect) are still recorded in the action log; their bodies are dropped via BodyExcluded.
    private static readonly string[] ExcludedExact =
    {
        "/api/health",
    };

    // Privacy: these paths carry special-category PII in their request/response bodies and must NOT be
    // stored in a RequestLog that the Activity page replays to any holder of activity.view (a permission
    // distinct from — and weaker than — the ones gating the source endpoints). Two families:
    //   1. OTHER users' emails (the Users table, audit feed, access-policy editor, chat pickers) — restricted
    //      to the admin Users table + audit + add-user + own account.
    //   2. Same-user special-category data: precise GPS coordinates (location), reproductive-health logs
    //      (cycle), medications/vitals (meds, health), household finance (family/finance, bills), and the
    //      tracker's health/diet data. LogRedaction only scrubs secret KEY names, never these VALUES, so the
    //      bodies must be dropped at capture time rather than relying on redaction.
    // The request LINE (method/path/status/timing/bytes) is still logged — only the PII-bearing bodies are
    // dropped, preserving the log's diagnostic value.
    private static readonly string[] BodyExcluded =
    {
        "/api/users", "/api/audit", "/api/access-policy",
        "/api/chat/contacts", "/api/chat/directory",
        // Same-user special-category PII (precise location, health, reproductive, finance).
        // "/api/cycle" is kept as a forward-looking guard; the live reproductive-health routes are all
        // under "/api/family/cycle". "/api/vitals" carries blood-pressure/weight (health data).
        "/api/location", "/api/family/locations", "/api/cycle", "/api/family/cycle",
        "/api/meds", "/api/vitals", "/api/health",
        "/api/family/finance", "/api/bills", "/api/tracker",
    };

    public async Task Invoke(HttpContext ctx)
    {
        if (!ShouldLog(ctx.Request))
        {
            await next(ctx);
            return;
        }

        var path = ctx.Request.Path.Value ?? "";

        // Email-bearing admin paths: log the request line but never buffer/store the bodies (PII).
        var captureBodies = !SkipBodyCapture(path);

        var requestBody = captureBodies ? await CaptureRequestBodyAsync(ctx.Request) : null;

        var originalBody = ctx.Response.Body;
        await using var capture = captureBodies ? new CapturingResponseStream(originalBody, MaxCaptureBytes) : null;
        if (capture is not null) ctx.Response.Body = capture;

        var started = Stopwatch.GetTimestamp();
        try
        {
            await next(ctx);
        }
        finally
        {
            if (capture is not null) ctx.Response.Body = originalBody;

            var entry = new RequestLog
            {
                WhenUtc = DateTime.UtcNow,
                Method = ctx.Request.Method,
                Path = Trim(path, 2048),
                QueryString = ctx.Request.QueryString.HasValue
                    ? LogRedaction.RedactQuery(ctx.Request.QueryString.Value, path)
                    : null,
                StatusCode = ctx.Response.StatusCode,
                DurationMs = (int)Stopwatch.GetElapsedTime(started).TotalMilliseconds,
                UserEmail = ctx.User.FindFirst("email")?.Value,
                ClientIp = ClientIp(ctx),
                RequestBytes = ctx.Request.ContentLength,
                ResponseBytes = capture?.TotalBytes ?? 0,
                RequestBody = requestBody,
                ResponseBody = capture is not null ? CaptureResponseBody(ctx, capture) : null,
            };

            queue.TryEnqueue(entry); // non-blocking; dropped if the buffer is saturated
        }
    }

    private static bool ShouldLog(HttpRequest req)
    {
        if (!req.Path.StartsWithSegments("/api")) return false;
        foreach (var ex in ExcludedExact)
            if (req.Path.Equals(ex, StringComparison.OrdinalIgnoreCase)) return false;
        foreach (var ex in Excluded)
            if (req.Path.StartsWithSegments(ex)) return false;
        return true;
    }

    // True for email-bearing admin paths whose bodies must not be persisted (see BodyExcluded).
    // Segment-based match so "/api/users", "/api/users/{id}", "/api/chat/contacts/{email}" all hit.
    private static bool SkipBodyCapture(string path)
    {
        var p = new PathString(path);
        foreach (var ex in BodyExcluded)
            if (p.StartsWithSegments(ex)) return true;
        return false;
    }

    private static async Task<string?> CaptureRequestBodyAsync(HttpRequest req)
    {
        if (req.ContentLength is null or 0) return null;
        // Don't buffer large uploads (EnableBuffering would spill them to a temp file just to log a snippet).
        if (req.ContentLength > MaxRequestBufferBytes) return $"[body too large: {req.ContentLength} bytes]";
        if (!IsTextual(req.ContentType)) return "[non-text body omitted]";

        req.EnableBuffering();
        var buffer = new byte[MaxCaptureBytes];
        var read = await req.Body.ReadAtLeastAsync(buffer, buffer.Length, throwOnEndOfStream: false);
        req.Body.Position = 0; // rewind so model binding can read it again

        var text = Encoding.UTF8.GetString(buffer, 0, read);
        return LogRedaction.Redact(text, req.Path.Value ?? "");
    }

    private static string? CaptureResponseBody(HttpContext ctx, CapturingResponseStream capture)
    {
        if (capture.TotalBytes == 0) return null;
        if (!IsTextual(ctx.Response.ContentType)) return "[non-text body omitted]";
        return LogRedaction.Redact(capture.GetCapturedText(), ctx.Request.Path.Value ?? "");
    }

    private static bool IsTextual(string? contentType)
    {
        if (string.IsNullOrEmpty(contentType)) return false;
        var c = contentType.ToLowerInvariant();
        return c.Contains("json") || c.Contains("text/") || c.Contains("xml") || c.Contains("csv") || c.Contains("urlencoded");
    }

    // RemoteIpAddress is already the real client (UseForwardedHeaders runs first); don't trust the raw
    // header here, which a direct caller could spoof.
    private static string? ClientIp(HttpContext ctx) => ctx.Connection.RemoteIpAddress?.ToString();

    private static string Trim(string s, int max) => s.Length <= max ? s : s[..max];
}
