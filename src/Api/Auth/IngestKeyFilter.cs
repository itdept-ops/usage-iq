using System.Security.Cryptography;
using System.Text;
using Ccusage.Api.Data;
using Microsoft.EntityFrameworkCore;

namespace Ccusage.Api.Auth;

/// <summary>
/// Authenticates the headless reporter on <c>POST /api/ingest</c> via the <c>X-Ingest-Key</c> header.
/// The raw key is hashed (SHA-256) and matched against a non-revoked <c>IngestKey</c> row — only the
/// hash is ever stored. This is deliberately separate from the Google-JWT user auth: the reporter is a
/// machine credential, not a person. The endpoint is otherwise anonymous + rate-limited.
/// </summary>
public sealed class IngestKeyFilter : IEndpointFilter
{
    public const string HeaderName = "X-Ingest-Key";

    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        var http = context.HttpContext;
        var ct = http.RequestAborted;

        var provided = http.Request.Headers[HeaderName].ToString().Trim();
        if (string.IsNullOrEmpty(provided))
            return Unauthorized("Missing ingest key.");

        var hash = Hash(provided);
        var db = http.RequestServices.GetRequiredService<UsageDbContext>();
        var keyId = await db.IngestKeys.AsNoTracking()
            .Where(k => k.KeyHash == hash && k.RevokedUtc == null)
            .Select(k => (int?)k.Id).FirstOrDefaultAsync(ct);
        if (keyId is null)
            return Unauthorized("Invalid or revoked ingest key.");

        // Best-effort last-used stamp; ingest must never fail because this side-write failed.
        try
        {
            var ip = http.Connection.RemoteIpAddress?.ToString();
            var now = DateTime.UtcNow;
            await db.IngestKeys.Where(k => k.Id == keyId).ExecuteUpdateAsync(s => s
                .SetProperty(x => x.LastUsedUtc, now)
                .SetProperty(x => x.LastUsedIp, ip), ct);
        }
        catch { /* ignore — informational only */ }

        return await next(context);
    }

    public static string Hash(string raw) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(raw)));

    private static IResult Unauthorized(string message) =>
        Results.Json(new { message }, statusCode: StatusCodes.Status401Unauthorized);
}
