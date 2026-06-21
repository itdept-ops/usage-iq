using Ccusage.Api.Auth;
using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Ccusage.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Ccusage.Api.Endpoints;

/// <summary>
/// Family Hub F3 — the "Today" snapshot and household settings (/api/family/today, /api/family/settings).
/// Everything is gated by <see cref="Permissions.FamilyUse"/> on top of <c>.RequireAuthorization()</c> and
/// obeys the Family Hub privacy rules:
///
/// <list type="bullet">
///   <item>A caller only ever addresses their OWN household (auto-provisioned on first read).</item>
///   <item>People and items are exposed by AppUser id + display name ONLY — an email is NEVER on the wire.</item>
///   <item>Settings are readable by every member but only the OWNER may edit them.</item>
/// </list>
///
/// The Today aggregate (greeting, today's reminders by local time, active timers, list open/done counts +
/// previews, pinned notes, optional weather) is built by <see cref="FamilyTodayService"/>; weather degrades
/// to null (the card hides) when unconfigured and never blocks the response.
/// </summary>
public static class FamilyTodayEndpoints
{
    public sealed record SettingsDto(
        string TimeZone, bool BriefingEnabled, int BriefingHourLocal, string? WeatherLocation,
        bool WeatherConfigured, bool EventHeadsUpEnabled, int EventHeadsUpLeadMinutes, bool CanEdit);

    /// <summary>The Today card's morning-briefing narrative: the warm AI line when available, else the plain
    /// deterministic briefing (<see cref="FellBackToPlain"/> = true). NEVER a 503 — the plain text is the
    /// guaranteed floor.</summary>
    public sealed record BriefingDto(string Narrative, bool FellBackToPlain);

    public sealed record SettingsUpdateRequest(
        string? TimeZone, bool? BriefingEnabled, int? BriefingHourLocal, string? WeatherLocation,
        bool? EventHeadsUpEnabled, int? EventHeadsUpLeadMinutes);

    public static void MapFamilyTodayEndpoints(this WebApplication app)
    {
        var g = app.MapGroup("/api/family")
            .RequireAuthorization()
            .RequirePermission(Permissions.FamilyUse);

        // ---- GET /today : the household's Today snapshot ----
        g.MapGet("/today", async (
            CurrentUserAccessor me, CurrentHouseholdAccessor households, FamilyTodayService todayService,
            CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!; // family.use filter guarantees non-null
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;
            var dto = await todayService.BuildAsync(household, caller, ct: ct);
            return Results.Ok(dto);
        });

        // ---- GET /today/briefing : the warm AI morning-briefing narrative for the Today card ----
        // Rate-limited (the shared "ai" policy) because it may spend model tokens, and CACHED per
        // (household, local-date) inside the service. It ALWAYS returns 200: when Gemini is unconfigured or
        // errors, the GUARANTEED deterministic Compose() text is returned with fellBackToPlain=true — never a
        // 503/500. The numbers come from the server; the model only narrates.
        g.MapGet("/today/briefing", async (
            CurrentUserAccessor me, CurrentHouseholdAccessor households, FamilyBriefingService briefing,
            CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;
            var text = await briefing.BriefingTextForAsync(household, caller, DateTime.UtcNow, ct);
            return Results.Ok(new BriefingDto(text.Narrative, text.FellBackToPlain));
        }).RequireRateLimiting(AiEndpoints.RateLimitPolicy);

        // ---- GET /settings : the household's settings (every member may read; only owner may edit) ----
        g.MapGet("/settings", async (
            CurrentUserAccessor me, CurrentHouseholdAccessor households, UsageDbContext db,
            WeatherService weather, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;
            var canEdit = await IsOwnerAsync(db, household.Id, caller.Id, ct);
            return Results.Ok(ToSettingsDto(household, weather.IsConfigured, canEdit));
        });

        // ---- PUT /settings : edit the household's settings (OWNER only; validates TZ + hour) ----
        g.MapPut("/settings", async (
            SettingsUpdateRequest req, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            UsageDbContext db, WeatherService weather, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;
            if (!await IsOwnerAsync(db, household.Id, caller.Id, ct))
                return Forbidden("Only the household owner can change family settings.");

            var entity = await db.Households.FirstOrDefaultAsync(h => h.Id == household.Id, ct);
            if (entity is null) return Forbidden("Only the household owner can change family settings.");

            if (req.TimeZone is not null)
            {
                var tz = req.TimeZone.Trim();
                if (tz.Length == 0) return Results.BadRequest(new { message = "A timezone is required." });
                if (tz.Length > 64 || !IsKnownTimeZone(tz))
                    return Results.BadRequest(new { message = $"Unknown timezone: {tz}" });
                entity.TimeZone = tz;
            }

            if (req.BriefingHourLocal is int hour)
            {
                if (hour is < 0 or > 23)
                    return Results.BadRequest(new { message = "Briefing hour must be between 0 and 23." });
                entity.BriefingHourLocal = hour;
            }

            if (req.BriefingEnabled is bool enabled)
                entity.BriefingEnabled = enabled;

            if (req.WeatherLocation is not null)
            {
                var loc = req.WeatherLocation.Trim();
                if (loc.Length > 120) loc = loc[..120];
                entity.WeatherLocation = loc.Length == 0 ? null : loc;
            }

            if (req.EventHeadsUpEnabled is bool headsUp)
                entity.EventHeadsUpEnabled = headsUp;

            if (req.EventHeadsUpLeadMinutes is int lead)
            {
                if (lead is < 1 or > 120)
                    return Results.BadRequest(new { message = "Heads-up lead must be between 1 and 120 minutes." });
                entity.EventHeadsUpLeadMinutes = lead;
            }

            await db.SaveChangesAsync(ct);
            return Results.Ok(ToSettingsDto(entity, weather.IsConfigured, canEdit: true));
        });
    }

    private static SettingsDto ToSettingsDto(Household h, bool weatherConfigured, bool canEdit) =>
        new(h.TimeZone, h.BriefingEnabled, h.BriefingHourLocal, h.WeatherLocation, weatherConfigured,
            h.EventHeadsUpEnabled, h.EventHeadsUpLeadMinutes, canEdit);

    private static async Task<bool> IsOwnerAsync(UsageDbContext db, int householdId, int userId, CancellationToken ct) =>
        await db.HouseholdMembers.AsNoTracking()
            .AnyAsync(m => m.HouseholdId == householdId && m.UserId == userId && m.Role == "owner", ct);

    private static bool IsKnownTimeZone(string id)
    {
        try { _ = TimeZoneInfo.FindSystemTimeZoneById(id); return true; }
        catch { return false; }
    }

    private static IResult Forbidden(string message) =>
        Results.Json(new { message }, statusCode: StatusCodes.Status403Forbidden);
}
