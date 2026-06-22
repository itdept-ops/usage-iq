using Ccusage.Api.Auth;
using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Ccusage.Api.Dtos;
using Ccusage.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Ccusage.Api.Endpoints;

/// <summary>
/// User location (/api/location). PRIVACY POSTURE: location is PRIVATE by default and capture is OPT-IN.
/// Identity comes from the JWT (<c>.RequireAuthorization()</c>); capability from the <c>location.*</c>
/// permissions (DB-checked). The precise lat/lng is NEVER exposed to non-admins except the sharer
/// themselves (their own history); household sharing surfaces only a COARSE city via presence.
///
/// <list type="bullet">
///   <item>POST / — record a fix for the caller. REQUIRES <c>location.self</c> AND the caller's
///   <see cref="AppUser.LocationEnabled"/> opt-in (else 409). Clamps lat/lng; best-effort city.</item>
///   <item>GET /me — the caller's OWN history (self-scoped, capped 500).</item>
///   <item>DELETE /me — clear the caller's OWN history (privacy).</item>
///   <item>PATCH /settings — the per-user opt-in toggles (enable capture / share-to-household).</item>
///   <item>GET /admin — ALL users' latest + recent history for the map. REQUIRES <c>location.view-all</c>.
///   Identity is userId+name; the raw owner email is never put on the wire.</item>
/// </list>
/// </summary>
public static class LocationEndpoints
{
    private const int HistoryCap = 500;
    private const int AdminRecentPerUser = 25;

    private static readonly string[] KnownSources = { "login", "periodic", "manual", "agent" };

    public static void MapLocationEndpoints(this WebApplication app)
    {
        var g = app.MapGroup("/api/location").RequireAuthorization();

        // ---- Record one fix for the caller (own only; opt-in REQUIRED) ----
        g.MapPost("/", async (
            RecordLocationRequest req, CurrentUserAccessor me, UsageDbContext db,
            ReverseGeocodeService geocoder, PresenceTracker presence, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!; // location.self filter guarantees non-null

            // The opt-in gate: even with location.self, nothing is recorded until the user enabled capture.
            var enabled = await db.Users.AsNoTracking()
                .Where(u => u.Id == caller.Id).Select(u => u.LocationEnabled).FirstOrDefaultAsync(ct);
            if (!enabled)
                return Results.Json(new { message = "Enable location first." },
                    statusCode: StatusCodes.Status409Conflict);

            if (double.IsNaN(req.Lat) || double.IsNaN(req.Lng))
                return Results.BadRequest(new { message = "lat and lng are required." });

            // Clamp to valid ranges (never reject a slightly-off client value — just bound it).
            var lat = Math.Clamp(req.Lat, -90, 90);
            var lng = Math.Clamp(req.Lng, -180, 180);
            var accuracy = req.AccuracyM is double a && a >= 0 && !double.IsNaN(a) ? a : (double?)null;
            var source = NormalizeSource(req.Source);

            // Best-effort reverse-geocode; the service never throws and returns null on any failure.
            var place = await geocoder.CityAsync(lat, lng, ct);

            var row = new UserLocation
            {
                UserEmail = caller.Email, // already lower-cased in CurrentUserAccessor
                Lat = lat,
                Lng = lng,
                AccuracyM = accuracy,
                Source = source,
                City = place?.City,
                Region = place?.Region,
                Country = place?.Country,
                CapturedUtc = DateTime.UtcNow,
            };
            db.UserLocations.Add(row);
            await db.SaveChangesAsync(ct);

            // Reflect the latest coarse city in presence (shown to self + shared household members).
            presence.SetCity(caller.Email, place?.City, caller.Name, null);

            return Results.Ok(ToDto(row));
        }).RequirePermission(Permissions.LocationSelf);

        // ---- The caller's own history (self-scoped) ----
        g.MapGet("/me", async (int? limit, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var take = Math.Clamp(limit ?? 100, 1, HistoryCap);

            var rows = await db.UserLocations.AsNoTracking()
                .Where(x => x.UserEmail == caller.Email)
                .OrderByDescending(x => x.CapturedUtc)
                .Take(take)
                .ToListAsync(ct);

            return Results.Ok(rows.Select(ToDto).ToList());
        }).RequirePermission(Permissions.LocationSelf);

        // ---- Clear the caller's own history (privacy) ----
        g.MapDelete("/me", async (CurrentUserAccessor me, UsageDbContext db, PresenceTracker presence, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var deleted = await db.UserLocations
                .Where(x => x.UserEmail == caller.Email).ExecuteDeleteAsync(ct);

            // Drop the cached presence city too — there's no location left to surface.
            presence.SetCity(caller.Email, null, caller.Name, null);

            return Results.Ok(new { deleted });
        }).RequirePermission(Permissions.LocationSelf);

        // ---- The per-user opt-in toggles ----
        g.MapGet("/settings", async (CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var s = await db.Users.AsNoTracking()
                .Where(u => u.Id == caller.Id)
                .Select(u => new LocationSettingsDto { LocationEnabled = u.LocationEnabled, ShareHousehold = u.LocationShareHousehold })
                .FirstAsync(ct);
            return Results.Ok(s);
        }).RequirePermission(Permissions.LocationSelf);

        g.MapPatch("/settings", async (
            LocationSettingsRequest req, CurrentUserAccessor me, UsageDbContext db, PresenceTracker presence, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var user = await db.Users.FirstOrDefaultAsync(u => u.Id == caller.Id, ct);
            if (user is null) return Results.Forbid();

            // Turning ON household sharing requires the explicit location.share grant; just toggling
            // capture (location.self) is not enough to start broadcasting your city to the household.
            if (req.ShareHousehold == true && !caller.Permissions.Contains(Permissions.LocationShare))
                return Results.Forbid();

            if (req.LocationEnabled is bool en) user.LocationEnabled = en;
            if (req.ShareHousehold is bool sh) user.LocationShareHousehold = sh;
            await db.SaveChangesAsync(ct);

            // If the user just stopped sharing, suppress any cached presence city immediately.
            if (req.ShareHousehold == false)
                presence.SetCity(caller.Email, null, caller.Name, null);

            return Results.Ok(new LocationSettingsDto
            {
                LocationEnabled = user.LocationEnabled,
                ShareHousehold = user.LocationShareHousehold,
            });
        }).RequirePermission(Permissions.LocationSelf);

        // ---- Admin map: ALL users' latest + recent history (admin oversight) ----
        // Identity by userId+name (email-privacy preference even on an admin-gated page). Only users with
        // at least one recorded fix appear.
        g.MapGet("/admin", async (UsageDbContext db, CancellationToken ct) =>
        {
            // Pull a bounded recent window per user in one pass. The (UserEmail, CapturedUtc desc) index
            // serves the ordering; we cap the rows scanned with a generous overall take and group in memory.
            // To keep it bounded on large datasets, fetch the most recent rows across everyone, then group.
            var recentRows = await db.UserLocations.AsNoTracking()
                .OrderByDescending(x => x.CapturedUtc)
                .Take(HistoryCap * 4)
                .ToListAsync(ct);

            // Resolve owner emails -> {AppUser.Id, Name}; the raw email never reaches the DTO (email-privacy).
            var lowerEmails = recentRows.Select(r => r.UserEmail).Distinct().ToList();
            var usersByEmail = (await db.Users.AsNoTracking()
                    .Where(u => lowerEmails.Contains(u.Email))
                    .Select(u => new { u.Id, u.Email, u.Name }).ToListAsync(ct))
                .ToDictionary(u => u.Email, StringComparer.OrdinalIgnoreCase);

            var result = recentRows
                .GroupBy(r => r.UserEmail, StringComparer.OrdinalIgnoreCase)
                .Select(grp =>
                {
                    var ordered = grp.OrderByDescending(x => x.CapturedUtc).ToList();
                    usersByEmail.TryGetValue(grp.Key, out var u);
                    return new AdminUserLocationDto
                    {
                        UserId = u?.Id,
                        Name = string.IsNullOrWhiteSpace(u?.Name) ? "Unknown user" : u!.Name,
                        Latest = ToDto(ordered[0]),
                        Recent = ordered.Take(AdminRecentPerUser).Select(ToDto).ToList(),
                    };
                })
                .OrderBy(d => d.Name, StringComparer.OrdinalIgnoreCase)
                .ToList();

            return Results.Ok(result);
        }).RequirePermission(Permissions.LocationViewAll);
    }

    private static LocationDto ToDto(UserLocation x) => new()
    {
        Id = x.Id,
        Lat = x.Lat,
        Lng = x.Lng,
        AccuracyM = x.AccuracyM,
        Source = x.Source,
        City = x.City,
        Region = x.Region,
        Country = x.Country,
        CapturedUtc = x.CapturedUtc,
    };

    private static string NormalizeSource(string? source)
    {
        var s = (source ?? "").Trim().ToLowerInvariant();
        return KnownSources.Contains(s) ? s : "manual";
    }
}
