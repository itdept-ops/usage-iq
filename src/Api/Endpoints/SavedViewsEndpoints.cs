using Ccusage.Api.Auth;
using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Ccusage.Api.Dtos;
using Microsoft.EntityFrameworkCore;

namespace Ccusage.Api.Endpoints;

/// <summary>
/// Per-user personal saved dashboard views. EVERY operation is scoped to the caller (resolved from
/// the JWT via <see cref="CurrentUserAccessor"/>): a user can only ever list/read/update/delete their
/// OWN views. Cross-user access returns 404 (never leaks another user's data or even the existence of
/// their rows). Gated by dashboard.view OR calendar.view.
/// </summary>
public static class SavedViewsEndpoints
{
    public static void MapSavedViewsEndpoints(this WebApplication app)
    {
        var g = app.MapGroup("/api/saved-views").RequireAuthorization()
            .RequireAnyPermission(Permissions.DashboardView, Permissions.CalendarView);

        // GET — the caller's own views, ordered by name.
        g.MapGet("/", async (CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var user = await me.GetUserAsync(ct);
            if (user is null) return Results.Forbid();

            var views = await db.SavedViews.AsNoTracking()
                .Where(v => v.UserId == user.Id)
                .OrderBy(v => v.Name)
                .ToListAsync(ct);
            return Results.Ok(views.Select(ToDto));
        });

        // POST — create for the caller; upsert-by-name (a duplicate name updates the existing view).
        g.MapPost("/", async (SavedViewUpsertRequest req, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var user = await me.GetUserAsync(ct);
            if (user is null) return Results.Forbid();

            var name = (req.Name ?? "").Trim();
            if (name.Length == 0) return Results.BadRequest(new { message = "Name is required." });

            // Upsert by (owner, name): never duplicate a name for the same user.
            var view = await db.SavedViews.FirstOrDefaultAsync(v => v.UserId == user.Id && v.Name == name, ct);
            if (view is null)
            {
                view = new SavedView { UserId = user.Id, Name = name, CreatedUtc = DateTime.UtcNow };
                db.SavedViews.Add(view);
            }
            Apply(view, req, name);
            await db.SaveChangesAsync(ct);
            return Results.Ok(ToDto(view));
        });

        // PUT — update name/filter only if the view belongs to the caller (404 otherwise; don't leak existence).
        g.MapPut("/{id:int}", async (int id, SavedViewUpsertRequest req, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var user = await me.GetUserAsync(ct);
            if (user is null) return Results.Forbid();

            var name = (req.Name ?? "").Trim();
            if (name.Length == 0) return Results.BadRequest(new { message = "Name is required." });

            // Scope the lookup to the owner: another user's id resolves to null → 404.
            var view = await db.SavedViews.FirstOrDefaultAsync(v => v.Id == id && v.UserId == user.Id, ct);
            if (view is null) return Results.NotFound();

            Apply(view, req, name);
            await db.SaveChangesAsync(ct);
            return Results.Ok(ToDto(view));
        });

        // DELETE — delete only if owned (404 otherwise).
        g.MapDelete("/{id:int}", async (int id, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var user = await me.GetUserAsync(ct);
            if (user is null) return Results.Forbid();

            var view = await db.SavedViews.FirstOrDefaultAsync(v => v.Id == id && v.UserId == user.Id, ct);
            if (view is null) return Results.NotFound();

            db.SavedViews.Remove(view);
            await db.SaveChangesAsync(ct);
            return Results.NoContent();
        });
    }

    private static void Apply(SavedView v, SavedViewUpsertRequest req, string name)
    {
        v.Name = name;
        v.FromDate = req.From;
        v.ToDate = req.To;
        v.ProjectIdsCsv = string.Join(',', req.ProjectId ?? Array.Empty<int>());
        v.ModelsCsv = string.Join(',', (req.Model ?? Array.Empty<string>()).Where(s => !string.IsNullOrWhiteSpace(s)));
        v.SourcesCsv = string.Join(',', (req.Source ?? Array.Empty<string>()).Where(s => !string.IsNullOrWhiteSpace(s)));
        v.IncludeSidechain = req.IncludeSidechain;
        v.GroupBy = string.IsNullOrWhiteSpace(req.GroupBy) ? "day" : req.GroupBy.Trim();
    }

    private static SavedViewDto ToDto(SavedView v) => new()
    {
        Id = v.Id,
        Name = v.Name,
        From = v.FromDate,
        To = v.ToDate,
        ProjectId = ParseInts(v.ProjectIdsCsv),
        Model = ParseStrings(v.ModelsCsv),
        Source = ParseStrings(v.SourcesCsv),
        IncludeSidechain = v.IncludeSidechain,
        GroupBy = v.GroupBy,
        CreatedUtc = v.CreatedUtc,
        LastUsedUtc = v.LastUsedUtc,
    };

    private static int[] ParseInts(string csv) => string.IsNullOrEmpty(csv)
        ? Array.Empty<int>()
        : csv.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
             .Select(s => int.TryParse(s, out var n) ? n : (int?)null)
             .Where(n => n is not null).Select(n => n!.Value).ToArray();

    private static string[] ParseStrings(string csv) => string.IsNullOrEmpty(csv)
        ? Array.Empty<string>()
        : csv.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
}
