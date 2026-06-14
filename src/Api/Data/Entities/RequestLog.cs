namespace Ccusage.Api.Data.Entities;

/// <summary>
/// One HTTP request/response captured by the request-logging middleware. Bodies are truncated and
/// have secrets/auth routes redacted; the table is pruned to a recent window by the writer.
/// </summary>
public class RequestLog
{
    public long Id { get; set; }
    public DateTime WhenUtc { get; set; }

    public string Method { get; set; } = "";
    public string Path { get; set; } = "";
    public string? QueryString { get; set; }

    public int StatusCode { get; set; }
    public int DurationMs { get; set; }

    /// <summary>The authenticated caller's email, or null for anonymous requests.</summary>
    public string? UserEmail { get; set; }
    public string? ClientIp { get; set; }

    public long? RequestBytes { get; set; }
    public long? ResponseBytes { get; set; }

    /// <summary>Truncated, redacted request/response bodies (null when none/omitted).</summary>
    public string? RequestBody { get; set; }
    public string? ResponseBody { get; set; }
}
