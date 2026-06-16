using System.Security.Cryptography;
using Ccusage.Api.Auth;
using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Ccusage.Api.Dtos;
using Ccusage.Api.Ingestion;
using Ccusage.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Ccusage.Api.Endpoints;

public static class IngestEndpoints
{
    public static void MapIngestEndpoints(this WebApplication app)
    {
        // ---- Public ingest (machine-authenticated by an ingest key, not a user JWT) ----
        app.MapPost("/api/ingest", async (IngestBatchDto batch, HttpContext http, IngestWriteService writer, CancellationToken ct) =>
        {
            if (!IngestWriteService.IsKnownSource(batch.Source))
                return Results.BadRequest(new { message = "Unknown source. Expected 'claude' or 'codex'." });
            if (batch.Rows is null || batch.Rows.Count == 0)
                return Results.Ok(new IngestResultDto());
            if (batch.Rows.Count > IngestWriteService.MaxRowsPerBatch)
                return Results.BadRequest(new { message = $"Batch too large. Max {IngestWriteService.MaxRowsPerBatch} rows per request." });

            // Attribute the rows to the key owner the filter resolved — never a client-supplied user.
            var ownerEmail = http.Items[IngestKeyFilter.OwnerEmailItem] as string;
            return Results.Ok(await writer.WriteAsync(batch.Source, batch.Machine, batch.Rows, ct, ownerEmail));
        })
        .AllowAnonymous()
        .AddEndpointFilter(new IngestKeyFilter())
        .RequireRateLimiting("ingest");

        // ---- Ingest key management (reporter.*) ----
        // Ownership is enforced in-handler: reporter.manage sees/acts on every key; reporter.self
        // (and reporter.view, read-only) is scoped to keys the caller owns (key.UserId == caller.Id).
        var keys = app.MapGroup("/api/ingest-keys").RequireAuthorization();

        keys.MapGet("/", async (UsageDbContext db, CurrentUserAccessor me, CancellationToken ct) =>
        {
            var caller = await me.GetUserAsync(ct);
            if (caller is null) return Results.Forbid();
            var canManage = caller.Permissions.Contains(Permissions.ReporterManage);

            var q = db.IngestKeys.AsNoTracking().OrderByDescending(k => k.Id).AsQueryable();
            if (!canManage) q = q.Where(k => k.UserId == caller.Id); // self/view: only my keys

            return Results.Ok(await q.Select(k => new IngestKeyDto
            {
                Id = k.Id, Name = k.Name, Prefix = k.Prefix,
                CreatedUtc = k.CreatedUtc, CreatedByEmail = k.CreatedByEmail,
                OwnerEmail = k.User != null ? k.User.Email : null,
                LastUsedUtc = k.LastUsedUtc, LastUsedIp = k.LastUsedIp,
                Revoked = k.RevokedUtc != null,
            }).ToListAsync(ct));
        }).RequireAnyPermission(Permissions.ReporterView, Permissions.ReporterManage, Permissions.ReporterSelf);

        keys.MapPost("/", async (CreateIngestKeyRequest req, UsageDbContext db, CurrentUserAccessor me, AuditLogger audit, CancellationToken ct) =>
        {
            var caller = await me.GetUserAsync(ct);
            if (caller is null) return Results.Forbid();

            var raw = GenerateKey();
            var name = req.Name?.Trim();
            name = string.IsNullOrEmpty(name) ? "reporter" : (name.Length > 64 ? name[..64] : name);

            // A key is always owned by its creator — both the link and the display email.
            var key = new IngestKey
            {
                Name = name,
                KeyHash = IngestKeyFilter.Hash(raw),
                Prefix = raw[..12] + "…",
                CreatedUtc = DateTime.UtcNow,
                CreatedByEmail = caller.Email,
                UserId = caller.Id,
            };
            db.IngestKeys.Add(key);
            await db.SaveChangesAsync(ct);
            await audit.LogAsync("ingestkey.create", null, $"{key.Name} ({key.Prefix})", ct);

            // The raw key is returned exactly once — only its hash is stored.
            return Results.Ok(new IngestKeyCreatedDto { Id = key.Id, Name = key.Name, Prefix = key.Prefix, Key = raw });
        }).RequireAnyPermission(Permissions.ReporterManage, Permissions.ReporterSelf);

        keys.MapDelete("/{id:int}", async (int id, UsageDbContext db, CurrentUserAccessor me, AuditLogger audit, CancellationToken ct) =>
        {
            var caller = await me.GetUserAsync(ct);
            if (caller is null) return Results.Forbid();

            var key = await db.IngestKeys.FirstOrDefaultAsync(k => k.Id == id, ct);
            if (key is null) return Results.NotFound();

            // reporter.manage may revoke any key; otherwise only the caller's own.
            var canManage = caller.Permissions.Contains(Permissions.ReporterManage);
            if (!canManage && key.UserId != caller.Id) return Results.Forbid();

            if (key.RevokedUtc is null)
            {
                key.RevokedUtc = DateTime.UtcNow;
                await db.SaveChangesAsync(ct);
                await audit.LogAsync("ingestkey.revoke", null, $"{key.Name} ({key.Prefix})", ct);
            }
            return Results.NoContent();
        }).RequireAnyPermission(Permissions.ReporterManage, Permissions.ReporterSelf);
    }

    // uiq_<43 base64url chars of 32 random bytes> — recognizable prefix, 256 bits of entropy.
    private static string GenerateKey() =>
        "uiq_" + Convert.ToBase64String(RandomNumberGenerator.GetBytes(32))
            .Replace('+', '-').Replace('/', '_').TrimEnd('=');
}
