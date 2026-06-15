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
    // (segment-based match leaves "/api/shares" management endpoints logged).
    private static readonly string[] Excluded =
    {
        "/api/health", "/api/auth/me", "/api/auth/config", "/api/sync/status", "/api/logs", "/api/share",
        "/api/ingest", // high-volume reporter pushes; the IngestKey LastUsed stamp is the activity trail
    };

    public async Task Invoke(HttpContext ctx)
    {
        if (!ShouldLog(ctx.Request))
        {
            await next(ctx);
            return;
        }

        var requestBody = await CaptureRequestBodyAsync(ctx.Request);

        var path = ctx.Request.Path.Value ?? "";
        var originalBody = ctx.Response.Body;
        await using var capture = new CapturingResponseStream(originalBody, MaxCaptureBytes);
        ctx.Response.Body = capture;

        var started = Stopwatch.GetTimestamp();
        try
        {
            await next(ctx);
        }
        finally
        {
            ctx.Response.Body = originalBody;

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
                ResponseBytes = capture.TotalBytes,
                RequestBody = requestBody,
                ResponseBody = CaptureResponseBody(ctx, capture),
            };

            queue.TryEnqueue(entry); // non-blocking; dropped if the buffer is saturated
        }
    }

    private static bool ShouldLog(HttpRequest req)
    {
        if (!req.Path.StartsWithSegments("/api")) return false;
        foreach (var ex in Excluded)
            if (req.Path.StartsWithSegments(ex)) return false;
        return true;
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
