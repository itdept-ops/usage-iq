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

    /// <summary>HttpContext.Items keys the ingest handler reads to drive server-side attribution.</summary>
    public const string OwnerEmailItem = "ingest.ownerEmail";
    public const string KeyIdItem = "ingest.keyId";

    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        var http = context.HttpContext;
        var ct = http.RequestAborted;

        var provided = http.Request.Headers[HeaderName].ToString().Trim();
        if (string.IsNullOrEmpty(provided))
            return Unauthorized("Missing ingest key.");

        var hash = Hash(provided);
        var db = http.RequestServices.GetRequiredService<UsageDbContext>();
        // Resolve the key plus its owner's email in one round-trip so the handler can attribute the
        // rows to the owning user (server-derived). The key must be non-revoked AND still owned by an
        // enabled user: an offboarded owner (disabled) — or one whose account was deleted, which nulls
        // UserId via ON DELETE SET NULL — leaves the row live but must no longer authenticate. This also
        // rejects legacy orphan keys with no linked user: attribution to a null owner is not allowed.
        var match = await db.IngestKeys.AsNoTracking()
            .Where(k => k.KeyHash == hash && k.RevokedUtc == null
                && k.User != null && k.User.IsEnabled)
            .Select(k => new { k.Id, OwnerEmail = k.User != null ? k.User.Email : null })
            .FirstOrDefaultAsync(ct);
        if (match is null)
            return Unauthorized("Invalid or revoked ingest key.");

        var keyId = match.Id;
        http.Items[KeyIdItem] = keyId;
        http.Items[OwnerEmailItem] = match.OwnerEmail;

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
