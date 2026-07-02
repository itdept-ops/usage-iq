using Ccusage.Api.Auth;
using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Ccusage.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Ccusage.Api.Endpoints;

/// <summary>
/// Family Hub F2 — shared REMINDERS and TIMERS (/api/family/reminders, /api/family/timers). Everything
/// is gated by <see cref="Permissions.FamilyUse"/> on top of <c>.RequireAuthorization()</c> and obeys
/// the Family Hub privacy rules:
///
/// <list type="bullet">
///   <item>Items are private to the owning HOUSEHOLD; every member can see and manage them. A caller
///   only ever addresses their OWN household — there is no way to reach another household's items, and a
///   cross-household id is a 404 (existence is never leaked).</item>
///   <item>People are exposed by AppUser id + display name ONLY — an email is NEVER put on the wire.</item>
/// </list>
///
/// Delivery of a fired reminder / finished timer is the background <see cref="FamilyReminderService"/>'s
/// job; these endpoints only own the CRUD. A reminder's target must be a member of the caller's
/// household (default: the caller themselves).
/// </summary>
public static class FamilyRemindersTimersEndpoints
{
    // ---- DTOs (people by userId + name; never email) ----

    public sealed record ReminderDto(
        long Id, string Text, DateTime DueUtc, string Recurrence, bool Active,
        int TargetUserId, string TargetName, int CreatedByUserId, string CreatedByName);

    public sealed record TimerDto(
        long Id, string Label, DateTime EndsUtc, bool Done,
        int StartedByUserId, string StartedByName);

    public sealed record ReminderCreateRequest(string? Text, DateTime? DueUtc, string? Recurrence, int? TargetUserId);
    public sealed record ReminderUpdateRequest(string? Text, DateTime? DueUtc, string? Recurrence, int? TargetUserId);
    public sealed record SnoozeRequest(int? Minutes);
    public sealed record TimerCreateRequest(string? Label, int? DurationSeconds);

    /// <summary>The "Add reminder with AI" request: the family member's free text ("remind me to call the
    /// dentist tomorrow at 9am"). <see cref="ReferenceDateUtc"/> anchors relative dates; defaults to now.</summary>
    public sealed record ReminderAiRequest(string? Text, DateTime? ReferenceDateUtc);

    /// <summary>One AI-proposed reminder the family member CONFIRMS (then the frontend creates it via POST
    /// /reminders). The due time is UTC + already clamped; <see cref="Recurrence"/> is the supported
    /// vocabulary (none/daily/weekly/weekdays). targetUserId is implicitly the caller (self) for now.</summary>
    public sealed record ReminderProposalDto(string Text, DateTime DueUtc, string Recurrence);

    /// <summary>The "Add reminder with AI" response: 0+ proposed reminders to confirm + an optional short note
    /// (an assumption made, or that an unsupported recurrence was mapped to the closest supported one).</summary>
    public sealed record ReminderAiDto(IReadOnlyList<ReminderProposalDto> Reminders, string? Notes);

    /// <summary>The "natural-language timer" request: free text ("20 minute pasta timer", "set a 5 min timeout
    /// for Lily"). Creates nothing — the frontend confirms then POSTs to /timers.</summary>
    public sealed record TimerAiRequest(string? Text);

    /// <summary>The "natural-language timer" response: a parsed label + duration (seconds, already clamped to
    /// 5..86400), in the shape the frontend POSTs to /timers on confirm.</summary>
    public sealed record TimerAiDto(string Label, int DurationSeconds);

    private static readonly string[] Recurrences = { "none", "daily", "weekly", "weekdays" };

    public static void MapFamilyRemindersTimersEndpoints(this WebApplication app)
    {
        var g = app.MapGroup("/api/family")
            .RequireAuthorization()
            .RequirePermission(Permissions.FamilyUse);

        MapReminders(g);
        MapTimers(g);
    }

    // =====================================================================================
    // REMINDERS
    // =====================================================================================

    private static void MapReminders(RouteGroupBuilder g)
    {
        // ---- GET /reminders : the household's reminders ----
        g.MapGet("/reminders", async (
            CurrentUserAccessor me, CurrentHouseholdAccessor households, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;

            var reminders = await db.FamilyReminders.AsNoTracking()
                .Where(r => r.HouseholdId == household.Id)
                .OrderBy(r => r.Active ? 0 : 1).ThenBy(r => r.DueUtc)
                .ToListAsync(ct);

            var names = await NamesAsync(db,
                reminders.Select(r => r.TargetUserId).Concat(reminders.Select(r => r.CreatedByUserId)), ct);
            return Results.Ok(reminders.Select(r => ToReminderDto(r, names)).ToList());
        });

        // ---- POST /reminders ----
        g.MapPost("/reminders", async (
            ReminderCreateRequest req, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;

            var text = (req.Text ?? "").Trim();
            if (string.IsNullOrEmpty(text)) return Results.BadRequest(new { message = "Reminder text is required." });
            if (text.Length > 500) text = text[..500];

            if (req.DueUtc is not DateTime due)
                return Results.BadRequest(new { message = "A due time is required." });
            if (!TryNormalizeRecurrence(req.Recurrence, out var recurrence))
                return Results.BadRequest(new { message = "Recurrence must be none, daily, weekly, or weekdays." });

            // The target defaults to the caller; if given, it must be a member of the caller's household.
            var targetId = req.TargetUserId ?? caller.Id;
            if (!IsHouseholdMember(household, targetId))
                return Results.BadRequest(new { message = "The reminder target must be a member of your family." });

            var reminder = new FamilyReminder
            {
                HouseholdId = household.Id,
                CreatedByUserId = caller.Id,
                TargetUserId = targetId,
                Text = text,
                DueUtc = DateTime.SpecifyKind(due, DateTimeKind.Utc),
                Recurrence = recurrence,
                Active = true,
                CreatedUtc = DateTime.UtcNow,
            };
            db.FamilyReminders.Add(reminder);
            await db.SaveChangesAsync(ct);

            return Results.Ok(await SingleReminderDtoAsync(db, reminder, ct));
        });

        // ---- POST /reminders/ai/parse : Gemini parses free text into PROPOSED reminders the user confirms ----
        // Creates NOTHING — the frontend creates each confirmed reminder via POST /reminders (targetUserId
        // stays the caller/self for now). Rate-limited (the shared "ai" policy) because it spends model
        // tokens, and NOT cached. Graceful: a 503 (never a 500) when Gemini is unconfigured or the call
        // fails; a 400 for empty text.
        g.MapPost("/reminders/ai/parse", async (
            ReminderAiRequest req, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            GeminiService gemini, CancellationToken ct) =>
        {
            if (string.IsNullOrWhiteSpace(req?.Text))
                return Results.BadRequest(new { message = "Type what you'd like to be reminded of." });
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

            var result = await gemini.ParseRemindersAsync(req.Text, reference, tz, ct);
            if (result is null) return AiUnavailable();

            var reminders = result.Reminders
                .Select(p => new ReminderProposalDto(p.Text, p.DueUtc, p.Recurrence)).ToList();
            return Results.Ok(new ReminderAiDto(reminders, result.Notes));
        }).RequirePermission(Permissions.FamilyAi).RequireRateLimiting(AiEndpoints.RateLimitPolicy);

        // ---- PUT /reminders/{id} ----
        g.MapPut("/reminders/{id:long}", async (
            long id, ReminderUpdateRequest req, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;

            var reminder = await db.FamilyReminders.FirstOrDefaultAsync(r => r.Id == id, ct);
            if (reminder is null || reminder.HouseholdId != household.Id) return NotFound();

            if (req.Text is not null)
            {
                var text = req.Text.Trim();
                if (string.IsNullOrEmpty(text)) return Results.BadRequest(new { message = "Reminder text is required." });
                reminder.Text = text.Length > 500 ? text[..500] : text;
            }
            if (req.DueUtc is DateTime due)
            {
                reminder.DueUtc = DateTime.SpecifyKind(due, DateTimeKind.Utc);
                reminder.Active = true; // re-scheduling revives a fired one-shot
            }
            if (req.Recurrence is not null)
            {
                if (!TryNormalizeRecurrence(req.Recurrence, out var recurrence))
                    return Results.BadRequest(new { message = "Recurrence must be none, daily, weekly, or weekdays." });
                reminder.Recurrence = recurrence;
            }
            if (req.TargetUserId is int targetId)
            {
                if (!IsHouseholdMember(household, targetId))
                    return Results.BadRequest(new { message = "The reminder target must be a member of your family." });
                reminder.TargetUserId = targetId;
            }

            await db.SaveChangesAsync(ct);
            return Results.Ok(await SingleReminderDtoAsync(db, reminder, ct));
        });

        // ---- POST /reminders/{id}/snooze ----
        g.MapPost("/reminders/{id:long}/snooze", async (
            long id, SnoozeRequest req, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;

            var reminder = await db.FamilyReminders.FirstOrDefaultAsync(r => r.Id == id, ct);
            if (reminder is null || reminder.HouseholdId != household.Id) return NotFound();

            var minutes = req.Minutes ?? 10;
            if (minutes < 1) minutes = 1;
            if (minutes > 7 * 24 * 60) minutes = 7 * 24 * 60; // cap snooze at a week

            // Snooze pushes the next fire out from now and re-activates a fired reminder.
            reminder.DueUtc = DateTime.UtcNow.AddMinutes(minutes);
            reminder.Active = true;
            await db.SaveChangesAsync(ct);

            return Results.Ok(await SingleReminderDtoAsync(db, reminder, ct));
        });

        // ---- DELETE /reminders/{id} ----
        g.MapDelete("/reminders/{id:long}", async (
            long id, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;

            var reminder = await db.FamilyReminders.FirstOrDefaultAsync(r => r.Id == id, ct);
            if (reminder is null || reminder.HouseholdId != household.Id) return NotFound();

            db.FamilyReminders.Remove(reminder);
            await db.SaveChangesAsync(ct);
            return Results.NoContent();
        });
    }

    // =====================================================================================
    // TIMERS
    // =====================================================================================

    private static void MapTimers(RouteGroupBuilder g)
    {
        // ---- GET /timers : the household's active/recent timers ----
        g.MapGet("/timers", async (
            CurrentUserAccessor me, CurrentHouseholdAccessor households, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;

            // Active timers first (soonest-ending), then recently-finished ones.
            var timers = await db.FamilyTimers.AsNoTracking()
                .Where(t => t.HouseholdId == household.Id)
                .OrderBy(t => t.Done ? 1 : 0).ThenBy(t => t.EndsUtc)
                .Take(50)
                .ToListAsync(ct);

            var names = await NamesAsync(db, timers.Select(t => t.StartedByUserId), ct);
            return Results.Ok(timers.Select(t => ToTimerDto(t, names)).ToList());
        });

        // ---- POST /timers ----
        g.MapPost("/timers", async (
            TimerCreateRequest req, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;

            var label = (req.Label ?? "").Trim();
            if (string.IsNullOrEmpty(label)) label = "Timer";
            if (label.Length > 120) label = label[..120];

            var seconds = req.DurationSeconds ?? 0;
            if (seconds < 1) return Results.BadRequest(new { message = "A timer duration (in seconds) is required." });
            if (seconds > 24 * 60 * 60) seconds = 24 * 60 * 60; // cap a shared countdown at a day

            var now = DateTime.UtcNow;
            var timer = new FamilyTimer
            {
                HouseholdId = household.Id,
                StartedByUserId = caller.Id,
                Label = label,
                EndsUtc = now.AddSeconds(seconds),
                Done = false,
                CreatedUtc = now,
            };
            db.FamilyTimers.Add(timer);
            await db.SaveChangesAsync(ct);

            var names = await NamesAsync(db, new[] { timer.StartedByUserId }, ct);
            return Results.Ok(ToTimerDto(timer, names));
        });

        // ---- POST /timers/ai/parse : Gemini parses free text into a PROPOSED timer the user confirms (round 2) ----
        // Parse "20 minute pasta timer" / "set a 5 min timeout for Lily" -> { label, durationSeconds }. Creates
        // NOTHING — the frontend confirms then POSTs to /timers. durationSeconds is CLAMPED to 5..86400 in the
        // service. Rate-limited (the shared "ai" policy) + NOT cached. Graceful: 503 (never 500) when Gemini is
        // unconfigured or the call fails; 400 for empty text.
        g.MapPost("/timers/ai/parse", async (
            TimerAiRequest req, GeminiService gemini, CancellationToken ct) =>
        {
            if (string.IsNullOrWhiteSpace(req?.Text))
                return Results.BadRequest(new { message = "Describe the timer you'd like to set." });
            if (!gemini.IsConfigured) return AiUnavailable();

            var result = await gemini.ParseTimerAsync(req.Text, ct);
            if (result is null) return AiUnavailable();

            return Results.Ok(new TimerAiDto(result.Label, result.DurationSeconds));
        }).RequirePermission(Permissions.FamilyAi).RequireRateLimiting(AiEndpoints.RateLimitPolicy);

        // ---- DELETE /timers/{id} : cancel ----
        g.MapDelete("/timers/{id:long}", async (
            long id, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;

            var timer = await db.FamilyTimers.FirstOrDefaultAsync(t => t.Id == id, ct);
            if (timer is null || timer.HouseholdId != household.Id) return NotFound();

            db.FamilyTimers.Remove(timer);
            await db.SaveChangesAsync(ct);
            return Results.NoContent();
        });
    }

    // =====================================================================================
    // HELPERS
    // =====================================================================================

    private static bool TryNormalizeRecurrence(string? raw, out string recurrence)
    {
        recurrence = string.IsNullOrWhiteSpace(raw) ? "none" : raw.Trim().ToLowerInvariant();
        return Recurrences.Contains(recurrence);
    }

    // Membership check reuses the members already loaded on the caller's household (CurrentHouseholdAccessor
    // Includes them), so there is no separate DB round-trip or duplicated membership predicate here.
    private static bool IsHouseholdMember(Household household, int userId) =>
        household.Members.Any(m => m.UserId == userId);

    /// <summary>Resolve a set of userIds to display names (email is never read). Missing → "Unknown user".</summary>
    private static async Task<Dictionary<int, string>> NamesAsync(
        UsageDbContext db, IEnumerable<int> userIds, CancellationToken ct)
    {
        // Centralized: each TARGET user's wire name applies their own DisplayNameMode/Nickname
        // (presence/chat/family/leaderboard all show the same chosen form). Never an email.
        return await DisplayName.ResolveNamesByIdAsync(db, userIds, ct);
    }

    private static string Name(Dictionary<int, string> names, int userId) =>
        names.TryGetValue(userId, out var n) ? n : "Unknown user";

    private static ReminderDto ToReminderDto(FamilyReminder r, Dictionary<int, string> names) =>
        new(r.Id, r.Text, r.DueUtc, r.Recurrence, r.Active,
            r.TargetUserId, Name(names, r.TargetUserId),
            r.CreatedByUserId, Name(names, r.CreatedByUserId));

    private static TimerDto ToTimerDto(FamilyTimer t, Dictionary<int, string> names) =>
        new(t.Id, t.Label, t.EndsUtc, t.Done, t.StartedByUserId, Name(names, t.StartedByUserId));

    private static async Task<ReminderDto> SingleReminderDtoAsync(
        UsageDbContext db, FamilyReminder reminder, CancellationToken ct)
    {
        var names = await NamesAsync(db, new[] { reminder.TargetUserId, reminder.CreatedByUserId }, ct);
        return ToReminderDto(reminder, names);
    }

    private static IResult NotFound() =>
        Results.NotFound(new { message = "That item doesn't exist." });

    /// <summary>503 (never 500) when "Add reminder with AI" can't run — Gemini unconfigured or the call
    /// failed. One consistent degraded path the frontend shows as "AI reminders aren't available right now;
    /// you can add the reminder manually".</summary>
    private static IResult AiUnavailable() => Results.Problem(
        title: "AI reminders are not available.",
        detail: "AI reminders are not available right now. You can add the reminder manually.",
        statusCode: StatusCodes.Status503ServiceUnavailable);
}
