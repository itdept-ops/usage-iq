using Ccusage.Api.Auth;
using Ccusage.Api.Data;
using Ccusage.Api.Dtos;
using Microsoft.EntityFrameworkCore;

namespace Ccusage.Api.Endpoints;

public static class ObservabilityEndpoints
{
    public static void MapObservabilityEndpoints(this WebApplication app)
    {
        // Recent request/response action log. Admin-only (it can contain request/response bodies).
        app.MapGet("/api/logs", async (
                UsageDbContext db, string? method, string? status, string? q, int? take, CancellationToken ct) =>
            {
                var query = db.RequestLogs.AsNoTracking().AsQueryable();

                if (!string.IsNullOrWhiteSpace(method))
                    query = query.Where(r => r.Method == method.ToUpper());

                // status = "2xx" | "3xx" | "4xx" | "5xx"
                if (!string.IsNullOrWhiteSpace(status) && status.Length == 3 && char.IsDigit(status[0]))
                {
                    var lo = (status[0] - '0') * 100;
                    query = query.Where(r => r.StatusCode >= lo && r.StatusCode < lo + 100);
                }

                if (!string.IsNullOrWhiteSpace(q))
                    query = query.Where(r => EF.Functions.ILike(r.Path, $"%{q}%"));

                var rows = await query
                    .OrderByDescending(r => r.Id)
                    .Take(Math.Clamp(take ?? 200, 1, 1000))
                    .Select(r => new RequestLogDto
                    {
                        Id = r.Id,
                        WhenUtc = r.WhenUtc,
                        Method = r.Method,
                        Path = r.Path,
                        QueryString = r.QueryString,
                        StatusCode = r.StatusCode,
                        DurationMs = r.DurationMs,
                        UserEmail = r.UserEmail,
                        ClientIp = r.ClientIp,
                        RequestBytes = r.RequestBytes,
                        ResponseBytes = r.ResponseBytes,
                        RequestBody = r.RequestBody,
                        ResponseBody = r.ResponseBody,
                    })
                    .ToListAsync(ct);

                return Results.Ok(rows);
            })
            .RequireAuthorization().RequirePermission(Permissions.UsersManage);
    }
}
