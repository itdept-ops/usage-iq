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
        app.MapPost("/api/ingest", async (IngestBatchDto batch, IngestWriteService writer, CancellationToken ct) =>
        {
            if (!IngestWriteService.IsKnownSource(batch.Source))
                return Results.BadRequest(new { message = "Unknown source. Expected 'claude' or 'codex'." });
            if (batch.Rows is null || batch.Rows.Count == 0)
                return Results.Ok(new IngestResultDto());
            if (batch.Rows.Count > IngestWriteService.MaxRowsPerBatch)
                return Results.BadRequest(new { message = $"Batch too large. Max {IngestWriteService.MaxRowsPerBatch} rows per request." });

            return Results.Ok(await writer.WriteAsync(batch.Source, batch.Machine, batch.Rows, ct));
        })
        .AllowAnonymous()
        .AddEndpointFilter(new IngestKeyFilter())
        .RequireRateLimiting("ingest");

        // ---- Ingest key management (admins) ----
        var keys = app.MapGroup("/api/ingest-keys")
            .RequireAuthorization().RequirePermission(Permissions.SettingsManage);

        keys.MapGet("/", async (UsageDbContext db, CancellationToken ct) =>
            Results.Ok(await db.IngestKeys.AsNoTracking().OrderByDescending(k => k.Id)
                .Select(k => new IngestKeyDto
                {
                    Id = k.Id, Name = k.Name, Prefix = k.Prefix,
                    CreatedUtc = k.CreatedUtc, CreatedByEmail = k.CreatedByEmail,
                    LastUsedUtc = k.LastUsedUtc, LastUsedIp = k.LastUsedIp,
                    Revoked = k.RevokedUtc != null,
                }).ToListAsync(ct)));

        keys.MapPost("/", async (CreateIngestKeyRequest req, UsageDbContext db, CurrentUserAccessor me, AuditLogger audit, CancellationToken ct) =>
        {
            var raw = GenerateKey();
            var name = req.Name?.Trim();
            name = string.IsNullOrEmpty(name) ? "reporter" : (name.Length > 64 ? name[..64] : name);
            var user = await me.GetUserAsync(ct);

            var key = new IngestKey
            {
                Name = name,
                KeyHash = IngestKeyFilter.Hash(raw),
                Prefix = raw[..12] + "…",
                CreatedUtc = DateTime.UtcNow,
                CreatedByEmail = user?.Email ?? "",
            };
            db.IngestKeys.Add(key);
            await db.SaveChangesAsync(ct);
            await audit.LogAsync("ingestkey.create", null, $"{key.Name} ({key.Prefix})", ct);

            // The raw key is returned exactly once — only its hash is stored.
            return Results.Ok(new IngestKeyCreatedDto { Id = key.Id, Name = key.Name, Prefix = key.Prefix, Key = raw });
        });

        keys.MapDelete("/{id:int}", async (int id, UsageDbContext db, AuditLogger audit, CancellationToken ct) =>
        {
            var key = await db.IngestKeys.FirstOrDefaultAsync(k => k.Id == id, ct);
            if (key is null) return Results.NotFound();
            if (key.RevokedUtc is null)
            {
                key.RevokedUtc = DateTime.UtcNow;
                await db.SaveChangesAsync(ct);
                await audit.LogAsync("ingestkey.revoke", null, $"{key.Name} ({key.Prefix})", ct);
            }
            return Results.NoContent();
        });
    }

    // uiq_<43 base64url chars of 32 random bytes> — recognizable prefix, 256 bits of entropy.
    private static string GenerateKey() =>
        "uiq_" + Convert.ToBase64String(RandomNumberGenerator.GetBytes(32))
            .Replace('+', '-').Replace('/', '_').TrimEnd('=');
}
