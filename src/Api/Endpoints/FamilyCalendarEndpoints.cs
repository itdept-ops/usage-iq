using Ccusage.Api.Auth;
using Ccusage.Api.Data;
using Ccusage.Api.Services;
using Microsoft.EntityFrameworkCore;
using static Ccusage.Api.Services.GoogleCalendarService;

namespace Ccusage.Api.Endpoints;

/// <summary>
/// Family Hub F6 — Google Calendar (/api/family/calendar), gated by <see cref="Permissions.FamilyUse"/>
/// on top of <c>.RequireAuthorization()</c>. Calendar access uses the OAuth 2.0 authorization-CODE flow
/// (offline access) — a SEPARATE concern from Google sign-in (the ID-token flow). All events here are the
/// CALLER's own primary calendar.
///
/// PRIVACY/SECURITY (enforced server-side):
/// <list type="bullet">
///   <item>The OAuth client secret + the user refresh token NEVER appear in any response (the refresh
///   token is stored AES-GCM-encrypted via <see cref="TokenProtector"/>).</item>
///   <item>NO other-user email is ever on the wire — free/busy is keyed by userId + display name only.</item>
///   <item>Every endpoint degrades GRACEFULLY: an unconnected (or not-configured) caller gets a clear
///   not-connected status payload, never a 500.</item>
/// </list>
/// </summary>
public static class FamilyCalendarEndpoints
{
    // ---- Request DTOs ----
    public sealed record ConnectRequest(string? Code, string? RedirectUri);
    public sealed record EventRequest(
        string? Title, DateTime StartUtc, DateTime EndUtc, bool AllDay, string? Location, string? Description);
    public sealed record FreeBusyRequest(int[]? MemberUserIds, DateTime StartUtc, DateTime EndUtc);

    // ---- Response DTOs ----
    public sealed record StatusDto(bool Configured, bool Connected);
    public sealed record ConnectedDto(bool Connected);

    /// <summary>An event on the caller's calendar (mirrors GoogleCalendarService.CalendarEvent).</summary>
    public sealed record EventDto(
        string Id, string Title, DateTime? StartUtc, DateTime? EndUtc, bool AllDay,
        string? Location, string? Description, string? HtmlLink, string? HangoutLink);

    /// <summary>One member's busy blocks for the find-a-time helper (userId + name; NEVER an email).</summary>
    public sealed record MemberBusyDto(int UserId, string Name, IReadOnlyList<BusyBlockDto> Busy);
    public sealed record BusyBlockDto(DateTime StartUtc, DateTime EndUtc);

    public static void MapFamilyCalendarEndpoints(this WebApplication app)
    {
        var g = app.MapGroup("/api/family/calendar")
            .RequireAuthorization()
            .RequirePermission(Permissions.FamilyUse);

        // ---- GET /status : is calendar configured (client secret present) + is the caller connected ----
        g.MapGet("/status", async (
            CurrentUserAccessor me, GoogleCalendarService cal, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var connected = cal.IsConfigured && await cal.IsConnectedAsync(caller.Id, ct);
            return Results.Ok(new StatusDto(cal.IsConfigured, connected));
        });

        // ---- POST /connect : exchange the auth code for tokens; store the encrypted refresh token ----
        g.MapPost("/connect", async (
            ConnectRequest req, CurrentUserAccessor me, GoogleCalendarService cal, CancellationToken ct) =>
        {
            if (!cal.IsConfigured)
                return Results.Json(new { message = "Google Calendar isn't configured on this server." },
                    statusCode: StatusCodes.Status503ServiceUnavailable);
            if (string.IsNullOrWhiteSpace(req.Code))
                return Results.BadRequest(new { message = "An authorization code is required." });

            var caller = (await me.GetUserAsync(ct))!;
            var ok = await cal.ConnectAsync(caller.Id, req.Code!, req.RedirectUri ?? "postmessage", ct);
            if (!ok)
                return Results.BadRequest(new
                {
                    message = "Couldn't connect your Google Calendar. Please try connecting again and grant offline access.",
                });
            return Results.Ok(new ConnectedDto(true));
        });

        // ---- POST /disconnect : remove the caller's connection (idempotent) ----
        g.MapPost("/disconnect", async (
            CurrentUserAccessor me, GoogleCalendarService cal, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            await cal.DisconnectAsync(caller.Id, ct);
            return Results.Ok(new ConnectedDto(false));
        });

        // ---- GET /events?startUtc=&endUtc= : the caller's own events in a window ----
        g.MapGet("/events", async (
            DateTime? startUtc, DateTime? endUtc, CurrentUserAccessor me, GoogleCalendarService cal,
            CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var (start, end) = Window(startUtc, endUtc);

            var result = await cal.ListEventsAsync(caller.Id, start, end, ct);
            if (!result.Ok) return NotReady(result.Status);

            var dtos = result.Value!.Select(ToDto).ToList();
            return Results.Ok(dtos);
        });

        // ---- POST /events : create an event on the caller's calendar ----
        g.MapPost("/events", async (
            EventRequest req, CurrentUserAccessor me, GoogleCalendarService cal, CancellationToken ct) =>
        {
            if (Validate(req) is { } bad) return bad;
            var caller = (await me.GetUserAsync(ct))!;

            var result = await cal.CreateEventAsync(
                caller.Id, req.Title!.Trim(), req.StartUtc, req.EndUtc, req.AllDay,
                Trim(req.Location, 1024), Trim(req.Description, 8192), ct);
            if (!result.Ok) return NotReady(result.Status);
            return Results.Ok(ToDto(result.Value!));
        });

        // ---- PUT /events/{id} : patch an event on the caller's calendar ----
        g.MapPut("/events/{id}", async (
            string id, EventRequest req, CurrentUserAccessor me, GoogleCalendarService cal,
            CancellationToken ct) =>
        {
            if (Validate(req) is { } bad) return bad;
            var caller = (await me.GetUserAsync(ct))!;

            var result = await cal.UpdateEventAsync(
                caller.Id, id, req.Title!.Trim(), req.StartUtc, req.EndUtc, req.AllDay,
                Trim(req.Location, 1024), Trim(req.Description, 8192), ct);
            if (!result.Ok) return NotReady(result.Status);
            return Results.Ok(ToDto(result.Value!));
        });

        // ---- DELETE /events/{id} : delete an event from the caller's calendar ----
        g.MapDelete("/events/{id}", async (
            string id, CurrentUserAccessor me, GoogleCalendarService cal, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var status = await cal.DeleteEventAsync(caller.Id, id, ct);
            if (status != CalendarStatus.Ok) return NotReady(status);
            return Results.NoContent();
        });

        // ---- POST /freebusy : per-member busy blocks for CONNECTED household members (no email) ----
        g.MapPost("/freebusy", async (
            FreeBusyRequest req, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            UsageDbContext db, GoogleCalendarService cal, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;
            var (start, end) = Window(req.StartUtc == default ? null : req.StartUtc,
                req.EndUtc == default ? null : req.EndUtc);

            // Constrain the requested ids to ACTUAL members of the caller's own household (privacy:
            // a caller can only ask about their own family). Resolve display identity (never email).
            var requested = (req.MemberUserIds ?? Array.Empty<int>()).Distinct().ToHashSet();
            var members = await db.HouseholdMembers.AsNoTracking()
                .Where(m => m.HouseholdId == household.Id)
                .Join(db.Users.AsNoTracking(), m => m.UserId, u => u.Id, (m, u) => new { u.Id, u.Name })
                .Where(x => requested.Count == 0 || requested.Contains(x.Id))
                .ToListAsync(ct);

            // FreeBusyAsync itself SKIPS any member who isn't connected — unconnected members simply
            // don't appear in the result (and their absence never leaks anything about them).
            var busy = await cal.FreeBusyAsync(
                members.Select(m => (m.Id, string.IsNullOrEmpty(m.Name) ? "Unknown user" : m.Name)), start, end, ct);

            var dtos = busy.Select(mb => new MemberBusyDto(
                mb.UserId, mb.Name,
                mb.Busy.Select(b => new BusyBlockDto(b.StartUtc, b.EndUtc)).ToList())).ToList();
            return Results.Ok(dtos);
        });
    }

    // =====================================================================================
    // Helpers
    // =====================================================================================

    private static EventDto ToDto(CalendarEvent e) => new(
        e.Id, e.Title, e.StartUtc, e.EndUtc, e.AllDay, e.Location, e.Description, e.HtmlLink, e.HangoutLink);

    /// <summary>
    /// Map a not-Ok calendar status to a graceful, NON-500 response: a 200 not-connected/not-configured
    /// status body for the soft states, and a 502 only for a genuine upstream error.
    /// </summary>
    private static IResult NotReady(CalendarStatus status) => status switch
    {
        CalendarStatus.NotConfigured => Results.Ok(new { connected = false, configured = false,
            message = "Google Calendar isn't configured on this server." }),
        CalendarStatus.NotConnected => Results.Ok(new { connected = false, configured = true,
            message = "Connect your Google Calendar to see and manage events here." }),
        // A transient upstream hiccup — surface as 502, still not a 500/unhandled.
        _ => Results.Json(new { connected = true, configured = true,
            message = "Google Calendar is temporarily unavailable. Please try again." },
            statusCode: StatusCodes.Status502BadGateway),
    };

    /// <summary>Validate + clamp an event request; returns a BadRequest result when invalid, else null.</summary>
    private static IResult? Validate(EventRequest req)
    {
        if (string.IsNullOrWhiteSpace(req.Title))
            return Results.BadRequest(new { message = "An event title is required." });
        if (req.Title!.Trim().Length > 1024)
            return Results.BadRequest(new { message = "That title is too long." });
        if (req.EndUtc < req.StartUtc)
            return Results.BadRequest(new { message = "The event end must be at or after its start." });
        return null;
    }

    /// <summary>
    /// Resolve a [start, end) window with sane defaults (today → +7 days) and a hard cap so an
    /// open-ended request can't pull an unbounded range. Start defaults to now if only end is given.
    /// </summary>
    private static (DateTime Start, DateTime End) Window(DateTime? startUtc, DateTime? endUtc)
    {
        var now = DateTime.UtcNow;
        var start = startUtc ?? now;
        var end = endUtc ?? start.AddDays(7);
        if (end <= start) end = start.AddDays(1);
        // Cap the span at ~1 year so a runaway window can't enumerate the whole calendar.
        if (end - start > TimeSpan.FromDays(366)) end = start.AddDays(366);
        return (DateTime.SpecifyKind(start, DateTimeKind.Utc), DateTime.SpecifyKind(end, DateTimeKind.Utc));
    }

    private static string? Trim(string? s, int max)
    {
        if (string.IsNullOrWhiteSpace(s)) return null;
        s = s.Trim();
        return s.Length > max ? s[..max] : s;
    }
}
