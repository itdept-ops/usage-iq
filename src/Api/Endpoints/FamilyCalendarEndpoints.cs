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

    /// <summary>
    /// A create/update event request. <see cref="Recurrence"/> is optional and one of
    /// "none"|"daily"|"weekly"|"weekdays"|"monthly" (absent/blank/"none" = a single event, today's
    /// behaviour). For a recurring event the series is bounded by <see cref="RecurrenceCount"/> (number of
    /// occurrences) or <see cref="RecurrenceUntilUtc"/> (an end instant); when neither is given the server
    /// applies a sane default cap so a series is always finite.
    /// </summary>
    public sealed record EventRequest(
        string? Title, DateTime StartUtc, DateTime EndUtc, bool AllDay, string? Location, string? Description,
        string? Recurrence = null, int? RecurrenceCount = null, DateTime? RecurrenceUntilUtc = null);

    public sealed record FreeBusyRequest(int[]? MemberUserIds, DateTime StartUtc, DateTime EndUtc);

    /// <summary>The "Schedule with AI" request: the family member's free-text ("dentist next Friday 9am").
    /// <see cref="ReferenceDateUtc"/> anchors relative dates ("tomorrow"); defaults to the server's now.</summary>
    public sealed record ScheduleAiRequest(string? Text, DateTime? ReferenceDateUtc);

    /// <summary>The find-a-time request: which members, how long, the window, and the optional workday bounds.</summary>
    public sealed record FindTimeRequest(
        int[]? MemberUserIds, int DurationMinutes, DateTime FromUtc, DateTime ToUtc,
        int? DayStartHourLocal, int? DayEndHourLocal);

    /// <summary>The "Best time for X" request: the family member's free-text ("a 45-min slot for a dentist
    /// next week, mornings"). <see cref="ReferenceDateUtc"/> anchors relative dates; defaults to now.</summary>
    public sealed record FindTimeAiRequest(string? Text, DateTime? ReferenceDateUtc);

    /// <summary>One attached schedule file for "schedule from image": base64 + its mime
    /// (image/jpeg|png|webp or application/pdf). The bytes are passed inline to Gemini and DISCARDED — never
    /// stored. See the endpoint's own validator (which, unlike the food-photo path, also allows PDF).</summary>
    public sealed record ScheduleImageFile(string? ImageBase64, string? Mime);

    /// <summary>The "schedule from image" request: 1..5 schedule images/PDFs to extract events from.
    /// <see cref="ReferenceDateUtc"/> anchors relative/implied dates in the document; defaults to now.</summary>
    public sealed record ScheduleFromImageRequest(
        IReadOnlyList<ScheduleImageFile>? Files, DateTime? ReferenceDateUtc);

    // ---- Response DTOs ----
    public sealed record StatusDto(bool Configured, bool Connected, bool ScopeOk);
    public sealed record ConnectedDto(bool Connected);

    /// <summary>An event on the caller's calendar (mirrors GoogleCalendarService.CalendarEvent).
    /// <see cref="IsRecurring"/> flags an event that is part of a recurring series (for a UI badge).</summary>
    public sealed record EventDto(
        string Id, string Title, DateTime? StartUtc, DateTime? EndUtc, bool AllDay,
        string? Location, string? Description, string? HtmlLink, string? HangoutLink, bool IsRecurring);

    /// <summary>One AI-proposed event the family member CONFIRMS (then the frontend creates it via POST
    /// /events). Times are UTC + already clamped; <see cref="Recurrence"/> is the supported vocabulary.</summary>
    public sealed record ScheduleEventDto(
        string Title, DateTime StartUtc, DateTime EndUtc, bool AllDay,
        string? Location, string? Description, string Recurrence);

    /// <summary>The "Schedule with AI" response: 0+ proposed events to confirm + an optional short note.</summary>
    public sealed record ScheduleAiDto(IReadOnlyList<ScheduleEventDto> Events, string? Notes);

    /// <summary>One member's busy blocks for the find-a-time helper (userId + name; NEVER an email).</summary>
    public sealed record MemberBusyDto(int UserId, string Name, IReadOnlyList<BusyBlockDto> Busy);
    public sealed record BusyBlockDto(DateTime StartUtc, DateTime EndUtc);

    /// <summary>A candidate free slot the find-a-time helper found (works for every connected member).</summary>
    public sealed record SlotDto(DateTime StartUtc, DateTime EndUtc);

    /// <summary>A member the find-a-time helper considered, and whether their calendar was connected.</summary>
    public sealed record ConsideredMemberDto(int UserId, string Name, bool Connected);

    /// <summary>The find-a-time response: candidate slots + which members were considered (connected or not).</summary>
    public sealed record FindTimeDto(
        IReadOnlyList<SlotDto> Slots, IReadOnlyList<ConsideredMemberDto> ConsideredMembers);

    /// <summary>What the AI understood from the free text (the find-time FORM it filled). All clamped; the
    /// window is UTC. The UI shows this so the family can see what was interpreted before booking.</summary>
    public sealed record InterpretedFindTimeDto(
        int DurationMinutes, DateTime FromUtc, DateTime ToUtc,
        int DayStartHourLocal, int DayEndHourLocal, string? Note);

    /// <summary>The "Best time for X" response: the EXISTING deterministic find-time output (slots +
    /// considered members) PLUS the <see cref="Interpreted"/> form the AI filled from the free text.</summary>
    public sealed record FindTimeAiDto(
        IReadOnlyList<SlotDto> Slots, IReadOnlyList<ConsideredMemberDto> ConsideredMembers,
        InterpretedFindTimeDto Interpreted);

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
            // scopeOk distinguishes "connected but calendar.events scope was never granted" (reconnect) from
            // a working connection (then a create failure points at the Calendar API being disabled instead).
            var scopeOk = connected && await cal.HasEventScopeAsync(caller.Id, ct);
            return Results.Ok(new StatusDto(cal.IsConfigured, connected, scopeOk));
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
            if (!result.Ok) return NotReady(result.Status, cal.LastErrorHint);

            var dtos = result.Value!.Select(ToDto).ToList();
            return Results.Ok(dtos);
        });

        // ---- POST /events : create an event on the caller's calendar ----
        g.MapPost("/events", async (
            EventRequest req, CurrentUserAccessor me, GoogleCalendarService cal, CancellationToken ct) =>
        {
            if (Validate(req, out var recurrence) is { } bad) return bad;
            var caller = (await me.GetUserAsync(ct))!;

            var result = await cal.CreateEventAsync(
                caller.Id, req.Title!.Trim(), req.StartUtc, req.EndUtc, req.AllDay,
                Trim(req.Location, 1024), Trim(req.Description, 8192),
                recurrence, req.RecurrenceCount, NormalizeUntil(req.RecurrenceUntilUtc), ct);
            if (!result.Ok) return NotReady(result.Status, cal.LastErrorHint);
            return Results.Ok(ToDto(result.Value!));
        });

        // ---- PUT /events/{id} : patch an event on the caller's calendar ----
        g.MapPut("/events/{id}", async (
            string id, EventRequest req, CurrentUserAccessor me, GoogleCalendarService cal,
            CancellationToken ct) =>
        {
            if (Validate(req, out var recurrence) is { } bad) return bad;
            var caller = (await me.GetUserAsync(ct))!;

            var result = await cal.UpdateEventAsync(
                caller.Id, id, req.Title!.Trim(), req.StartUtc, req.EndUtc, req.AllDay,
                Trim(req.Location, 1024), Trim(req.Description, 8192),
                recurrence, req.RecurrenceCount, NormalizeUntil(req.RecurrenceUntilUtc), ct);
            if (!result.Ok) return NotReady(result.Status, cal.LastErrorHint);
            return Results.Ok(ToDto(result.Value!));
        });

        // ---- DELETE /events/{id} : delete an event from the caller's calendar ----
        g.MapDelete("/events/{id}", async (
            string id, CurrentUserAccessor me, GoogleCalendarService cal, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var status = await cal.DeleteEventAsync(caller.Id, id, ct);
            if (status != CalendarStatus.Ok) return NotReady(status, cal.LastErrorHint);
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

        // ---- POST /find-time : candidate slots free for every selected CONNECTED member in the workday ----
        g.MapPost("/find-time", async (
            FindTimeRequest req, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            UsageDbContext db, GoogleCalendarService cal, CancellationToken ct) =>
        {
            if (req.DurationMinutes <= 0)
                return Results.BadRequest(new { message = "A positive durationMinutes is required." });
            if (req.DurationMinutes > 24 * 60)
                return Results.BadRequest(new { message = "That meeting is too long (max 24 hours)." });

            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;
            var (start, end) = Window(req.FromUtc == default ? null : req.FromUtc,
                req.ToUtc == default ? null : req.ToUtc);

            // Workday bounds: caller-supplied or the sensible default 9–17 local. The household timezone does
            // the local-day clipping.
            var dayStart = req.DayStartHourLocal ?? 9;
            var dayEnd = req.DayEndHourLocal ?? 17;
            var tz = FamilyTodayService.ResolveTimeZone(household.TimeZone);

            var (slots, considered) = await RunFindTimeAsync(
                db, cal, household.Id, req.MemberUserIds ?? Array.Empty<int>(), start, end,
                req.DurationMinutes, dayStart, dayEnd, tz, ct);
            return Results.Ok(new FindTimeDto(slots, considered));
        });

        // ---- POST /ai/find-time : Gemini fills the find-time FORM from free text, then the EXISTING ----
        // deterministic engine finds the slots over ALL household members. Creates NOTHING — booking still
        // goes through POST /events on user confirm. Rate-limited (shared "ai" policy). Graceful: 400 empty
        // text; 503 (never 500) when the PARSE is unavailable (Gemini unconfigured or the call failed). The
        // find-time itself degrades gracefully (no connected calendars -> empty slots) exactly as today.
        g.MapPost("/ai/find-time", async (
            FindTimeAiRequest req, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            UsageDbContext db, GoogleCalendarService cal, GeminiService gemini, CancellationToken ct) =>
        {
            if (string.IsNullOrWhiteSpace(req?.Text))
                return Results.BadRequest(new { message = "Type what you'd like to find a time for." });
            if (!gemini.IsConfigured)
                return AiUnavailable();

            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;
            var tz = FamilyTodayService.ResolveTimeZone(household.TimeZone);

            // Anchor relative dates to the supplied reference (or now); reject an absurd reference.
            var reference = req.ReferenceDateUtc is { } r
                ? DateTime.SpecifyKind(r, DateTimeKind.Utc) : DateTime.UtcNow;
            if (reference < DateTime.UtcNow.AddYears(-2) || reference > DateTime.UtcNow.AddYears(2))
                reference = DateTime.UtcNow;

            // The MODEL only fills the form; an unavailable parse is a graceful 503 (never a 500).
            var parsed = await gemini.ParseFindTimeAsync(req.Text, reference, tz, ct);
            if (parsed is null) return AiUnavailable();

            // Run the EXISTING deterministic find-time over ALL household members with the parsed params.
            var (start, end) = Window(parsed.FromUtc, parsed.ToUtc);
            var (slots, considered) = await RunFindTimeAsync(
                db, cal, household.Id, Array.Empty<int>(), start, end,
                parsed.DurationMinutes, parsed.DayStartHourLocal, parsed.DayEndHourLocal, tz, ct);

            var interpreted = new InterpretedFindTimeDto(
                parsed.DurationMinutes, start, end,
                parsed.DayStartHourLocal, parsed.DayEndHourLocal, parsed.Note);
            return Results.Ok(new FindTimeAiDto(slots, considered, interpreted));
        }).RequireRateLimiting(AiEndpoints.RateLimitPolicy);

        // ---- POST /schedule-ai : Gemini parses free text into PROPOSED events the user then confirms ----
        // Creates NOTHING — the frontend creates each confirmed event via POST /events. Rate-limited (the
        // shared "ai" policy) because it spends model tokens. Graceful: a 503 (never a 500) when Gemini is
        // unconfigured or the call fails; a 400 for empty text.
        g.MapPost("/schedule-ai", async (
            ScheduleAiRequest req, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            GeminiService gemini, CancellationToken ct) =>
        {
            if (string.IsNullOrWhiteSpace(req?.Text))
                return Results.BadRequest(new { message = "Type what you'd like to schedule." });
            if (!gemini.IsConfigured)
                return AiUnavailable();

            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;
            var tz = FamilyTodayService.ResolveTimeZone(household.TimeZone);

            // Anchor relative dates to the supplied reference (or now); reject an absurd reference.
            var reference = req.ReferenceDateUtc is { } r
                ? DateTime.SpecifyKind(r, DateTimeKind.Utc) : DateTime.UtcNow;
            if (reference < DateTime.UtcNow.AddYears(-2) || reference > DateTime.UtcNow.AddYears(2))
                reference = DateTime.UtcNow;

            var result = await gemini.ScheduleEventsAsync(req.Text, reference, tz, ct);
            if (result is null) return AiUnavailable();

            var events = result.Events.Select(e => new ScheduleEventDto(
                e.Title, e.StartUtc, e.EndUtc, e.AllDay, e.Location, e.Description, e.Recurrence)).ToList();
            return Results.Ok(new ScheduleAiDto(events, result.Notes));
        }).RequireRateLimiting(AiEndpoints.RateLimitPolicy);

        // ---- POST /ai/from-image : Gemini EXTRACTS proposed events from attached schedule image(s)/PDF(s) ----
        // (a school calendar, a shift schedule, a sports roster). Returns the SAME ScheduleAiDto shape as
        // /schedule-ai for the frontend to CONFIRM then create via POST /events. Image-heavy, so it runs under
        // the tighter ai-photo cap. STORES NOTHING and CREATES NOTHING — the bytes are passed inline to Gemini
        // and discarded. Its OWN validator additionally allows application/pdf (the GLOBAL food-photo allowlist
        // is deliberately NOT widened). Graceful: 400 for empty/too-many/oversized/bad-mime; 503 (never 500)
        // when Gemini is unconfigured or the call fails.
        g.MapPost("/ai/from-image", async (
            ScheduleFromImageRequest req, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            GeminiService gemini, CancellationToken ct) =>
        {
            // Validate the attachments FIRST so a bad/oversized/too-many upload is a clear 400 regardless of
            // config (and its own allowlist allows PDF, unlike the global food-photo path).
            if (!TryValidateScheduleFiles(req?.Files, out var files, out var bad)) return bad;
            if (!gemini.IsConfigured) return AiUnavailable();

            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;
            var tz = FamilyTodayService.ResolveTimeZone(household.TimeZone);

            // Anchor relative/implied dates to the supplied reference (or now); reject an absurd reference.
            var reference = req!.ReferenceDateUtc is { } r
                ? DateTime.SpecifyKind(r, DateTimeKind.Utc) : DateTime.UtcNow;
            if (reference < DateTime.UtcNow.AddYears(-2) || reference > DateTime.UtcNow.AddYears(2))
                reference = DateTime.UtcNow;

            var result = await gemini.ScheduleFromImagesAsync(files, reference, tz, ct);
            if (result is null) return AiUnavailable();

            var events = result.Events.Select(e => new ScheduleEventDto(
                e.Title, e.StartUtc, e.EndUtc, e.AllDay, e.Location, e.Description, e.Recurrence)).ToList();
            return Results.Ok(new ScheduleAiDto(events, result.Notes));
        }).RequireRateLimiting(AiEndpoints.PhotoRateLimitPolicy);
    }

    // =====================================================================================
    // "Schedule from image" file validation — its OWN allowlist (adds application/pdf), SCOPED to this
    // endpoint so the GLOBAL food-photo path is never widened to accept PDFs.
    // =====================================================================================

    /// <summary>Allowed mime types for a schedule attachment: images PLUS application/pdf (scoped here only).</summary>
    private static readonly IReadOnlySet<string> ScheduleAllowedMimeTypes =
        new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        { "image/jpeg", "image/png", "image/webp", "application/pdf" };

    private const int MaxScheduleFiles = 5;
    /// <summary>Per-file decoded cap: 5 MB for images, ~10 MB for a PDF (a multi-page calendar is bigger).</summary>
    private const long MaxScheduleImageBytes = 5L * 1024 * 1024;
    private const long MaxSchedulePdfBytes = 10L * 1024 * 1024;
    /// <summary>Total decoded payload cap across all files, to stay under Gemini's inline request limit.</summary>
    private const long MaxScheduleTotalBytes = 15L * 1024 * 1024;

    /// <summary>
    /// Validate the attached schedule files: 1..5 present, each a permitted mime (image/* or PDF) whose
    /// base64 decodes cleanly and is under its per-type cap, and a total under the request cap. On failure,
    /// <paramref name="bad"/> is a 400 and the method returns false. On success, <paramref name="valid"/> is
    /// the decoded-and-checked (base64, mime) list ready for the model.
    /// </summary>
    private static bool TryValidateScheduleFiles(
        IReadOnlyList<ScheduleImageFile>? files, out List<(string base64, string mime)> valid, out IResult bad)
    {
        valid = new List<(string, string)>();
        bad = Results.BadRequest(new
        {
            message = "Attach 1–5 schedule images (jpeg/png/webp, up to 5 MB each) or PDFs (up to 10 MB), " +
                      "under 15 MB total.",
        });

        if (files is null || files.Count == 0) return false;
        if (files.Count > MaxScheduleFiles) return false;

        long total = 0;
        foreach (var f in files)
        {
            var mime = (f?.Mime ?? "").Trim();
            var data = (f?.ImageBase64 ?? "").Trim();
            if (mime.Length == 0 || data.Length == 0) return false;
            if (!ScheduleAllowedMimeTypes.Contains(mime)) return false;

            // Strip an optional data-URL prefix ("data:application/pdf;base64,...") before decoding.
            var comma = data.IndexOf(',');
            if (data.StartsWith("data:", StringComparison.OrdinalIgnoreCase) && comma >= 0)
                data = data[(comma + 1)..];

            var cap = string.Equals(mime, "application/pdf", StringComparison.OrdinalIgnoreCase)
                ? MaxSchedulePdfBytes
                : MaxScheduleImageBytes;

            // Cheap pre-decode bound (base64 ≈ 4 chars per 3 bytes) so an oversized payload is rejected early.
            if ((long)data.Length / 4 * 3 > cap) return false;

            byte[] decoded;
            try { decoded = Convert.FromBase64String(data); }
            catch (FormatException) { return false; }
            if (decoded.Length == 0 || decoded.Length > cap) return false;

            total += decoded.Length;
            if (total > MaxScheduleTotalBytes) return false;

            valid.Add((data, mime));
        }

        return true;
    }

    // =====================================================================================
    // Helpers
    // =====================================================================================

    /// <summary>
    /// The SHARED deterministic find-time core (used by both <c>POST /find-time</c> and <c>POST
    /// /ai/find-time</c>): constrain the requested ids to ACTUAL members of the caller's household (privacy;
    /// empty = the whole household), pull each connected member's busy blocks (FreeBusyAsync SKIPS the
    /// unconnected, who simply don't constrain the search), and run <see cref="SlotFinder"/> within the local
    /// workday window. Returns the candidate slots + which members were considered (connected or not). Degrades
    /// cleanly — no connected calendars yields an empty slot list, never a 500.
    /// </summary>
    private static async Task<(List<SlotDto> Slots, List<ConsideredMemberDto> Considered)> RunFindTimeAsync(
        UsageDbContext db, GoogleCalendarService cal, int householdId, int[] memberUserIds,
        DateTime start, DateTime end, int durationMinutes, int dayStartHourLocal, int dayEndHourLocal,
        TimeZoneInfo tz, CancellationToken ct)
    {
        var requested = memberUserIds.Distinct().ToHashSet();
        var members = await db.HouseholdMembers.AsNoTracking()
            .Where(m => m.HouseholdId == householdId)
            .Join(db.Users.AsNoTracking(), m => m.UserId, u => u.Id, (m, u) => new { u.Id, u.Name })
            .Where(x => requested.Count == 0 || requested.Contains(x.Id))
            .ToListAsync(ct);

        var busy = await cal.FreeBusyAsync(
            members.Select(m => (m.Id, string.IsNullOrEmpty(m.Name) ? "Unknown user" : m.Name)), start, end, ct);
        var connectedIds = busy.Select(b => b.UserId).ToHashSet();

        var considered = members
            .Select(m => new ConsideredMemberDto(
                m.Id, string.IsNullOrEmpty(m.Name) ? "Unknown user" : m.Name, connectedIds.Contains(m.Id)))
            .ToList();

        var found = SlotFinder.FindFreeSlots(
            busy.Select(b => new SlotFinder.MemberBusy(
                b.Busy.Select(x => (x.StartUtc, x.EndUtc)).ToList())),
            start, end, durationMinutes, dayStartHourLocal, dayEndHourLocal, tz);

        var slots = found.Select(s => new SlotDto(s.StartUtc, s.EndUtc)).ToList();
        return (slots, considered);
    }

    private static EventDto ToDto(CalendarEvent e) => new(
        e.Id, e.Title, e.StartUtc, e.EndUtc, e.AllDay, e.Location, e.Description, e.HtmlLink, e.HangoutLink,
        e.IsRecurring);

    /// <summary>503 (never 500) when "Schedule with AI" can't run — Gemini unconfigured or the call failed.
    /// One consistent degraded path the frontend shows as "AI scheduling isn't available right now".</summary>
    private static IResult AiUnavailable() => Results.Problem(
        title: "AI scheduling is not available.",
        detail: "AI scheduling is not available right now. You can add the event manually.",
        statusCode: StatusCodes.Status503ServiceUnavailable);

    /// <summary>
    /// Map a not-Ok calendar status to a graceful, NON-500 response: a 200 not-connected/not-configured
    /// status body for the soft states, and a 502 only for a genuine upstream error.
    /// </summary>
    private static IResult NotReady(CalendarStatus status, string? hint = null) => status switch
    {
        CalendarStatus.NotConfigured => Results.Ok(new { connected = false, configured = false,
            message = "Google Calendar isn't configured on this server." }),
        CalendarStatus.NotConnected => Results.Ok(new { connected = false, configured = true,
            message = "Connect your Google Calendar to see and manage events here." }),
        // An upstream error — surface the SPECIFIC reason when we could classify it (e.g. the Calendar API
        // isn't enabled, or the scope wasn't granted), else a generic transient message. 502, never a 500.
        _ => Results.Json(new { connected = true, configured = true,
            message = hint ?? "Google Calendar is temporarily unavailable. Please try again." },
            statusCode: StatusCodes.Status502BadGateway),
    };

    /// <summary>
    /// Validate an event request and resolve its <paramref name="recurrence"/>; returns a BadRequest result
    /// when invalid, else null. Absent/blank/"none" recurrence keeps the single-event behaviour.
    /// </summary>
    private static IResult? Validate(EventRequest req, out Recurrence recurrence)
    {
        recurrence = Recurrence.None;
        if (string.IsNullOrWhiteSpace(req.Title))
            return Results.BadRequest(new { message = "An event title is required." });
        if (req.Title!.Trim().Length > 1024)
            return Results.BadRequest(new { message = "That title is too long." });
        if (req.EndUtc < req.StartUtc)
            return Results.BadRequest(new { message = "The event end must be at or after its start." });
        if (!TryParseRecurrence(req.Recurrence, out recurrence))
            return Results.BadRequest(new { message = "Recurrence must be one of: none, daily, weekly, weekdays, monthly." });
        if (req.RecurrenceCount is { } c && (c < 1 || c > 730))
            return Results.BadRequest(new { message = "Recurrence count must be between 1 and 730." });
        return null;
    }

    /// <summary>Parse the optional recurrence string (case-insensitive). Absent/blank -> None+true; an
    /// unrecognised value -> false (the caller surfaces a 400).</summary>
    private static bool TryParseRecurrence(string? s, out Recurrence recurrence)
    {
        recurrence = Recurrence.None;
        if (string.IsNullOrWhiteSpace(s)) return true;
        switch (s.Trim().ToLowerInvariant())
        {
            case "none": recurrence = Recurrence.None; return true;
            case "daily": recurrence = Recurrence.Daily; return true;
            case "weekly": recurrence = Recurrence.Weekly; return true;
            case "weekdays": recurrence = Recurrence.Weekdays; return true;
            case "monthly": recurrence = Recurrence.Monthly; return true;
            default: return false;
        }
    }

    /// <summary>Normalise an optional recurrence-until to a UTC instant (or null).</summary>
    private static DateTime? NormalizeUntil(DateTime? until) =>
        until is { } u ? DateTime.SpecifyKind(u, DateTimeKind.Utc) : null;

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
