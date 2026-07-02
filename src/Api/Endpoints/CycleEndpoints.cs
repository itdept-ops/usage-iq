using Ccusage.Api.Auth;
using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Ccusage.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Ccusage.Api.Endpoints;

/// <summary>
/// Family Hub — Cycle calendar (/api/family/cycle). PRIVACY-FIRST + NON-MEDICAL.
///
/// <para>The cycle LOG is PRIVATE to its owner: every endpoint here is gated by <see cref="Permissions.CycleTrack"/>
/// on top of <c>.RequireAuthorization()</c> and is OWNER-SCOPED — a caller only ever reads or edits their OWN
/// periods/profile (rows are keyed by the caller's email; ids are owner-checked on delete). Nobody else ever
/// sees raw entries.</para>
///
/// <para>Predictions are PURE deterministic math (<see cref="CyclePredictionService"/>) — no AI required. The
/// optional <c>GET /note</c> adds a gentle NON-MEDICAL one-liner that ALSO needs <see cref="Permissions.FamilyAi"/>;
/// it ALWAYS 200s with a deterministic plain floor when AI is absent. The framing is informational and gentle:
/// this tracker NEVER diagnoses or gives medical advice, and cycle data is NEVER sent to the AI-usage log as content.</para>
///
/// <para>The family overlay lives in <see cref="CycleOverlayEndpoints"/> (gated by <c>family.use</c>, not
/// <c>cycle.track</c>) and exposes ONLY PREDICTED day-spans for members who opted in. NO other-user email
/// appears anywhere.</para>
/// </summary>
public static class CycleEndpoints
{
    // ---- Request DTOs ----
    public sealed record LogPeriodRequest(DateOnly StartDate, DateOnly? EndDate);
    public sealed record SettingsRequest(int? AvgCycleLengthDays, int? AvgPeriodLengthDays, bool? OverlayToFamily);

    /// <summary>
    /// A PARTIAL upsert of one day's private log (HEALTH + INTIMATE data, owner-only). The date is required;
    /// every other field is optional and a field left null/absent is PRESERVED on an existing row (it is not
    /// cleared). To clear a whole day use <c>DELETE /day-log?date=</c>. Symptoms (when present) REPLACE the
    /// stored set. <see cref="Protected"/> is only meaningful when <see cref="Intimacy"/> is true.
    /// </summary>
    public sealed record DayLogRequest(
        DateOnly Date, string? Mood, IReadOnlyList<string>? Symptoms, CycleFlowLevel? FlowLevel,
        bool? Intimacy, bool? Protected, int? Energy, string? Notes);

    // ---- Response DTOs ----
    public sealed record PeriodDto(int Id, DateOnly StartDate, DateOnly? EndDate, DateTime LoggedUtc);
    public sealed record FertileWindowDto(DateOnly Start, DateOnly End);

    /// <summary>One day's private self-log (owner-only; mirrors <see cref="CycleDayLog"/>). This DTO is ONLY
    /// ever returned to the owner on their own GET — it NEVER appears in the family overlay and is never sent
    /// to the AI as raw content (only an aggregate projection is narrated).</summary>
    public sealed record DayLogDto(
        DateOnly Date, string? Mood, IReadOnlyList<string> Symptoms, CycleFlowLevel FlowLevel,
        bool Intimacy, bool? Protected, int? Energy, string? Notes, DateTime UpdatedUtc);

    /// <summary>The deterministic prediction block (no AI). <see cref="NextPredictedStart"/>/<see cref="FertileWindow"/>
    /// are null until there's at least one logged period to anchor from.</summary>
    public sealed record PredictionDto(
        int AvgCycleLengthDays, DateOnly? NextPredictedStart, FertileWindowDto? FertileWindow, string CurrentPhase);

    public sealed record SettingsDto(int AvgCycleLengthDays, int AvgPeriodLengthDays, bool OverlayToFamily);

    /// <summary>The main GET payload: the owner's recent periods + the deterministic predictions + their
    /// settings + their recent private day-logs. <see cref="DayLogs"/> is OWNER-ONLY (never overlaid, never
    /// on the wire for any other viewer); it is returned newest-date-first so the client can index by date.</summary>
    public sealed record CycleDto(
        IReadOnlyList<PeriodDto> Periods, PredictionDto Prediction, SettingsDto Settings,
        IReadOnlyList<DayLogDto> DayLogs);

    /// <summary>The gentle AI note: the one-liner + whether it fell back to the deterministic plain floor
    /// (true when family.ai is absent or Gemini is off). ALWAYS 200.</summary>
    public sealed record NoteDto(string Note, bool FellBackToPlain);

    private const int RecentCap = 24;

    /// <summary>How many recent day-logs the GET returns (a generous window for the calendar + pattern note).</summary>
    private const int DayLogCap = 120;
    /// <summary>Max symptoms persisted per day (the vocabulary is small; this caps a hostile payload).</summary>
    private const int MaxSymptomsPerDay = 16;
    private const int MaxMoodLen = 32;
    private const int MaxNotesLen = 500;

    /// <summary>The accepted MOOD vocabulary (free-stored but normalised to this small set; unknown → dropped).</summary>
    private static readonly IReadOnlySet<string> MoodVocab = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        { "happy", "calm", "irritable", "sad", "anxious", "energized" };

    /// <summary>The accepted SYMPTOM vocabulary (anything outside it is dropped on write).</summary>
    private static readonly IReadOnlySet<string> SymptomVocab = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        { "cramps", "headache", "bloating", "fatigue", "tender", "acne", "nausea", "backache" };

    public static void MapCycleEndpoints(this WebApplication app)
    {
        var g = app.MapGroup("/api/family/cycle")
            .RequireAuthorization()
            .RequirePermission(Permissions.CycleTrack);

        // ---- GET / : the owner's recent periods + deterministic predictions + settings ----
        g.MapGet("/", async (CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!; // cycle.track filter guarantees non-null
            var profile = await GetOrCreateProfileAsync(db, caller, ct);

            var periods = await db.CyclePeriods.AsNoTracking()
                .Where(p => p.UserEmail == caller.Email)
                .OrderByDescending(p => p.StartDate)
                .Take(RecentCap)
                .ToListAsync(ct);

            // The owner's recent private day-logs (OWNER-ONLY — never overlaid/on the wire for anyone else).
            // Newest-date-first so the client can index/lookup by date.
            var dayLogs = await db.CycleDayLogs.AsNoTracking()
                .Where(d => d.UserEmail == caller.Email)
                .OrderByDescending(d => d.LocalDate)
                .Take(DayLogCap)
                .ToListAsync(ct);

            var prediction = await BuildPrediction(db, periods, profile, dayLogs, ct);
            return Results.Ok(new CycleDto(
                periods.Select(ToDto).ToList(),
                prediction,
                ToSettingsDto(profile),
                dayLogs.Select(ToDayLogDto).ToList()));
        });

        // ---- POST /period : log a period (owner-scoped) ----
        g.MapPost("/period", async (
            LogPeriodRequest req, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            if (Validate(req) is { } bad) return bad;
            var caller = (await me.GetUserAsync(ct))!;

            var row = new CyclePeriod
            {
                UserEmail = caller.Email, // already lower-cased in CurrentUserAccessor
                UserId = caller.Id,
                StartDate = req.StartDate,
                EndDate = req.EndDate,
                LoggedUtc = DateTime.UtcNow,
            };
            db.CyclePeriods.Add(row);
            await db.SaveChangesAsync(ct);
            return Results.Ok(ToDto(row));
        });

        // ---- DELETE /period/{id} : delete one of the OWNER's own periods (owner-only) ----
        g.MapDelete("/period/{id:int}", async (
            int id, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            // Owner-scoped: the WHERE binds both the id AND the caller's email, so a caller can never delete
            // another user's period even by guessing an id.
            var deleted = await db.CyclePeriods
                .Where(p => p.Id == id && p.UserEmail == caller.Email)
                .ExecuteDeleteAsync(ct);
            if (deleted == 0) return Results.NotFound();
            return Results.NoContent();
        });

        // ---- PUT /day-log : PARTIAL upsert of one private day-log (HEALTH + INTIMATE; owner-scoped) ----
        // Unspecified fields are PRESERVED on an existing row (partial). Symptoms, when present, REPLACE the
        // stored set. 400 on a bad/out-of-range date. This data NEVER reaches the overlay or any other viewer.
        g.MapPut("/day-log", async (
            DayLogRequest req, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            if (ValidateDate(req.Date) is { } bad) return bad;
            var caller = (await me.GetUserAsync(ct))!;

            var now = DateTime.UtcNow;
            var row = await db.CycleDayLogs
                .FirstOrDefaultAsync(d => d.UserEmail == caller.Email && d.LocalDate == req.Date, ct);

            if (row is null)
            {
                row = new CycleDayLog
                {
                    UserEmail = caller.Email, // already lower-cased in CurrentUserAccessor
                    UserId = caller.Id,
                    LocalDate = req.Date,
                    CreatedUtc = now,
                };
                db.CycleDayLogs.Add(row);
            }

            // PARTIAL: only overwrite a field the request actually carried; an absent field is preserved.
            if (req.Mood is not null) row.Mood = NormalizeMood(req.Mood);
            if (req.Symptoms is not null) row.Symptoms = NormalizeSymptoms(req.Symptoms);
            if (req.FlowLevel is { } fl) row.FlowLevel = NormalizeFlow(fl);
            if (req.Intimacy is { } intim) row.Intimacy = intim;
            // Protected is only meaningful when intimacy is recorded true; otherwise force it null.
            if (req.Protected is not null || req.Intimacy is not null)
                row.Protected = row.Intimacy ? req.Protected : null;
            if (req.Energy is { } en) row.Energy = Math.Clamp(en, 1, 5);
            if (req.Notes is not null) row.Notes = NormalizeNotes(req.Notes);

            row.UpdatedUtc = now;
            try
            {
                await db.SaveChangesAsync(ct);
            }
            catch (DbUpdateException ex) when (TrackerVisibility.IsUniqueViolation(ex))
            {
                // A concurrent insert raced the same (email, date); reload + re-apply onto the winner.
                db.ChangeTracker.Clear();
                row = await db.CycleDayLogs
                    .FirstAsync(d => d.UserEmail == caller.Email && d.LocalDate == req.Date, ct);
                if (req.Mood is not null) row.Mood = NormalizeMood(req.Mood);
                if (req.Symptoms is not null) row.Symptoms = NormalizeSymptoms(req.Symptoms);
                if (req.FlowLevel is { } fl2) row.FlowLevel = NormalizeFlow(fl2);
                if (req.Intimacy is { } intim2) row.Intimacy = intim2;
                if (req.Protected is not null || req.Intimacy is not null)
                    row.Protected = row.Intimacy ? req.Protected : null;
                if (req.Energy is { } en2) row.Energy = Math.Clamp(en2, 1, 5);
                if (req.Notes is not null) row.Notes = NormalizeNotes(req.Notes);
                row.UpdatedUtc = now;
                await db.SaveChangesAsync(ct);
            }
            return Results.Ok(ToDayLogDto(row));
        });

        // ---- DELETE /day-log?date= : clear one whole day's private log (owner-scoped) ----
        g.MapDelete("/day-log", async (
            DateOnly? date, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            if (date is not { } d) return Results.BadRequest(new { message = "A date is required." });
            if (ValidateDate(d) is { } bad) return bad;
            var caller = (await me.GetUserAsync(ct))!;

            // Owner-scoped: the WHERE binds both the date AND the caller's email, so a caller can never clear
            // another user's day even by guessing.
            var deleted = await db.CycleDayLogs
                .Where(x => x.UserEmail == caller.Email && x.LocalDate == d)
                .ExecuteDeleteAsync(ct);
            return deleted == 0 ? Results.NotFound() : Results.NoContent();
        });

        // ---- PATCH /settings : the owner's averages + the family-overlay opt-in (clamped) ----
        g.MapPatch("/settings", async (
            SettingsRequest req, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var profile = await GetOrCreateProfileForUpdateAsync(db, caller, ct);

            if (req.AvgCycleLengthDays is int c) profile.AvgCycleLengthDays = Math.Clamp(c, 15, 60);
            if (req.AvgPeriodLengthDays is int pd) profile.AvgPeriodLengthDays = Math.Clamp(pd, 1, 14);
            if (req.OverlayToFamily is bool o) profile.OverlayToFamily = o;
            await db.SaveChangesAsync(ct);

            return Results.Ok(ToSettingsDto(profile));
        });

        // ---- GET /note : a gentle, NON-MEDICAL one-liner narrating the deterministic facts ----
        // Gated by cycle.track (the group) AND family.ai. ALWAYS 200: when family.ai is absent the AI filter
        // would 403 the route, so the gentle floor for the no-AI case is served by GET / 's prediction block on
        // the client; here (family.ai present) we still fall back to a deterministic plain line if Gemini is
        // off or errors (fellBackToPlain=true). NEVER diagnostic; never logs cycle content beyond the aggregate.
        g.MapGet("/note", async (
            CurrentUserAccessor me, UsageDbContext db, GeminiService gemini, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var profile = await GetOrCreateProfileAsync(db, caller, ct);
            var periods = await db.CyclePeriods.AsNoTracking()
                .Where(p => p.UserEmail == caller.Email)
                .OrderByDescending(p => p.StartDate)
                .Take(RecentCap)
                .ToListAsync(ct);

            // The recent day-logs feed (a) an optional heavy-flow confirmation of a period start and (b) the
            // AGGREGATE pattern projection the AI narrates. Raw rows NEVER leave the server.
            var dayLogs = await db.CycleDayLogs.AsNoTracking()
                .Where(d => d.UserEmail == caller.Email)
                .OrderByDescending(d => d.LocalDate)
                .Take(DayLogCap)
                .ToListAsync(ct);

            var today = await TrackerVisibility.DisplayTzTodayAsync(db, ct);
            var prediction = CyclePredictionService.Compute(
                periods, profile.AvgCycleLengthDays, profile.AvgPeriodLengthDays, today, dayLogs);

            var plain = ComposePlainNote(prediction);

            // Gemini off → the deterministic floor (fellBackToPlain=true), ALWAYS 200.
            if (!gemini.IsConfigured)
                return Results.Ok(new NoteDto(plain, true));

            string? ai = null;
            // Only the AGGREGATE projection (predictions + summarised patterns) goes to the model — never a
            // raw intimate entry, never a per-day row.
            try { ai = await gemini.CycleNoteAsync(FactsSummary(prediction, dayLogs), ct); }
            catch { ai = null; } // AI must never fail this endpoint — fall back to the plain floor.

            return string.IsNullOrWhiteSpace(ai)
                ? Results.Ok(new NoteDto(plain, true))
                : Results.Ok(new NoteDto(ai!, false));
        }).RequirePermission(Permissions.FamilyAi);
    }

    // =====================================================================================
    // Helpers
    // =====================================================================================

    /// <summary>Validate a log-period request: a non-default start, and (when given) an end at/after it, both
    /// within a sane calendar range so a fat-fingered year can't poison the gap math.</summary>
    private static IResult? Validate(LogPeriodRequest req)
    {
        if (req.StartDate == default)
            return Results.BadRequest(new { message = "A start date is required." });
        if (req.EndDate is { } end && end < req.StartDate)
            return Results.BadRequest(new { message = "The period end must be on or after its start." });

        if (DateOutOfRange(req.StartDate))
            return Results.BadRequest(new { message = "That start date is out of range." });
        if (req.EndDate is { } e && DateOutOfRange(e))
            return Results.BadRequest(new { message = "That end date is out of range." });
        return null;
    }

    /// <summary>Validate a day-log date: a non-default day within the same sane calendar range as a period.</summary>
    private static IResult? ValidateDate(DateOnly date)
    {
        if (date == default)
            return Results.BadRequest(new { message = "A date is required." });
        if (DateOutOfRange(date))
            return Results.BadRequest(new { message = "That date is out of range." });
        return null;
    }

    /// <summary>Reject a fat-fingered year that would poison the calendar (5 years back, 1 forward).</summary>
    private static bool DateOutOfRange(DateOnly date)
    {
        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        return date < today.AddYears(-5) || date > today.AddYears(1);
    }

    // ---- Day-log normalisation (vocab-restricted, length-capped, never trusted) ----

    /// <summary>Normalise a mood to the small vocabulary; an empty/unknown value → null (cleared).</summary>
    private static string? NormalizeMood(string? mood)
    {
        var m = mood?.Trim().ToLowerInvariant();
        return !string.IsNullOrEmpty(m) && MoodVocab.Contains(m) ? m
            : (m is { Length: > 0 } ? Truncate(m, MaxMoodLen) : null);
    }

    /// <summary>Normalise symptoms to the known vocabulary, de-duplicated + capped; unknown values dropped.</summary>
    private static List<string> NormalizeSymptoms(IReadOnlyList<string> symptoms)
    {
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var outList = new List<string>();
        foreach (var s in symptoms)
        {
            var v = s?.Trim().ToLowerInvariant();
            if (string.IsNullOrEmpty(v) || !SymptomVocab.Contains(v)) continue;
            if (!seen.Add(v)) continue;
            outList.Add(v);
            if (outList.Count >= MaxSymptomsPerDay) break;
        }
        return outList;
    }

    private static CycleFlowLevel NormalizeFlow(CycleFlowLevel fl) =>
        Enum.IsDefined(typeof(CycleFlowLevel), fl) ? fl : CycleFlowLevel.None;

    private static string? NormalizeNotes(string? notes)
    {
        var n = notes?.Trim();
        return string.IsNullOrEmpty(n) ? null : Truncate(n, MaxNotesLen);
    }

    private static string Truncate(string s, int max) => s.Length <= max ? s : s[..max];

    /// <summary>Read the caller's profile (no-tracking), materialising the in-memory defaults when none exists
    /// yet — reading never has to persist a row.</summary>
    private static async Task<CycleProfile> GetOrCreateProfileAsync(
        UsageDbContext db, CurrentUserAccessor.CurrentUser caller, CancellationToken ct)
    {
        var profile = await db.CycleProfiles.AsNoTracking()
            .FirstOrDefaultAsync(p => p.UserEmail == caller.Email, ct);
        return profile ?? new CycleProfile { UserEmail = caller.Email, UserId = caller.Id };
    }

    /// <summary>Get the caller's tracked profile for an update, creating + persisting one on first write so the
    /// PATCH always has a row to mutate.</summary>
    private static async Task<CycleProfile> GetOrCreateProfileForUpdateAsync(
        UsageDbContext db, CurrentUserAccessor.CurrentUser caller, CancellationToken ct)
    {
        var profile = await db.CycleProfiles.FirstOrDefaultAsync(p => p.UserEmail == caller.Email, ct);
        if (profile is not null) return profile;

        profile = new CycleProfile { UserEmail = caller.Email, UserId = caller.Id };
        db.CycleProfiles.Add(profile);
        return profile;
    }

    private static async Task<PredictionDto> BuildPrediction(
        UsageDbContext db, IReadOnlyList<CyclePeriod> periods, CycleProfile profile,
        IReadOnlyList<CycleDayLog> dayLogs, CancellationToken ct)
    {
        var today = await TrackerVisibility.DisplayTzTodayAsync(db, ct);
        var p = CyclePredictionService.Compute(
            periods, profile.AvgCycleLengthDays, profile.AvgPeriodLengthDays, today, dayLogs);
        var window = p.FertileStart is { } fs && p.FertileEnd is { } fe
            ? new FertileWindowDto(fs, fe) : null;
        return new PredictionDto(p.AvgCycleLengthDays, p.NextPredictedStart, window, p.CurrentPhase);
    }

    /// <summary>The deterministic plain note — the GUARANTEED floor the AI rephrases (and the fallback when AI
    /// is off). Gentle + informational; never diagnostic.</summary>
    private static string ComposePlainNote(CyclePredictionService.Prediction p)
    {
        if (p.NextPredictedStart is not { } next)
            return "Log a period to start seeing gentle, informational predictions here.";
        var avg = p.AvgCycleLengthDays;
        return $"Your cycles have averaged about {avg} days; your next is likely around {next:MMM d}.";
    }

    /// <summary>The compact, deterministic facts the model NARRATES (it invents nothing). Carries only the
    /// AGGREGATE projection — the predictions PLUS summarised, NON-INTIMATE patterns derived from the day-logs
    /// (counts/frequencies, never a per-day row, NEVER intimacy/protected/notes) — so no raw or intimate cycle
    /// content ever reaches the AI as content.</summary>
    private static string FactsSummary(
        CyclePredictionService.Prediction p, IReadOnlyList<CycleDayLog> dayLogs)
    {
        var lines = new List<string> { $"AVG_CYCLE_DAYS: {p.AvgCycleLengthDays}" };
        if (p.NextPredictedStart is { } n) lines.Add($"NEXT_PREDICTED_START: {n:yyyy-MM-dd}");
        if (p.FertileStart is { } fs && p.FertileEnd is { } fe)
            lines.Add($"FERTILE_WINDOW: {fs:yyyy-MM-dd} to {fe:yyyy-MM-dd}");
        lines.Add($"CURRENT_PHASE: {p.CurrentPhase}");
        lines.AddRange(PatternFacts(dayLogs));
        return string.Join("\n", lines);
    }

    /// <summary>
    /// Derive a few AGGREGATE, NON-INTIMATE pattern lines from the recent day-logs for the AI to narrate
    /// gently. STRICTLY counts/frequencies over moods/symptoms/energy — it deliberately NEVER emits intimacy,
    /// protected status, or free-text notes, and never a single dated row. Empty when there isn't enough to say.
    /// </summary>
    private static IEnumerable<string> PatternFacts(IReadOnlyList<CycleDayLog> dayLogs)
    {
        var lines = new List<string>();
        if (dayLogs.Count < 3) return lines; // too little to claim a "pattern"

        lines.Add($"DAYS_LOGGED: {dayLogs.Count}");

        // Most-common symptom across the window (a frequency, not a dated event).
        var symptomCounts = dayLogs
            .SelectMany(d => d.Symptoms)
            .GroupBy(s => s, StringComparer.OrdinalIgnoreCase)
            .Select(g => (Symptom: g.Key, Count: g.Count()))
            .OrderByDescending(x => x.Count)
            .ToList();
        if (symptomCounts.Count > 0 && symptomCounts[0].Count >= 2)
            lines.Add($"COMMON_SYMPTOM: {symptomCounts[0].Symptom} (logged on {symptomCounts[0].Count} days)");

        // Most-common mood (frequency only).
        var topMood = dayLogs
            .Where(d => !string.IsNullOrEmpty(d.Mood))
            .GroupBy(d => d.Mood!, StringComparer.OrdinalIgnoreCase)
            .Select(g => (Mood: g.Key, Count: g.Count()))
            .OrderByDescending(x => x.Count)
            .FirstOrDefault();
        if (topMood.Count >= 2)
            lines.Add($"COMMON_MOOD: {topMood.Mood} (logged on {topMood.Count} days)");

        // Average self-rated energy (a single aggregate number).
        var energies = dayLogs.Where(d => d.Energy is { } e && e is >= 1 and <= 5).Select(d => d.Energy!.Value).ToList();
        if (energies.Count >= 3)
            lines.Add($"AVG_ENERGY_1TO5: {energies.Average():0.#}");

        return lines;
    }

    private static PeriodDto ToDto(CyclePeriod p) => new(p.Id, p.StartDate, p.EndDate, p.LoggedUtc);

    private static SettingsDto ToSettingsDto(CycleProfile p) =>
        new(p.AvgCycleLengthDays, p.AvgPeriodLengthDays, p.OverlayToFamily);

    private static DayLogDto ToDayLogDto(CycleDayLog d) => new(
        d.LocalDate, d.Mood, d.Symptoms, d.FlowLevel, d.Intimacy, d.Protected, d.Energy, d.Notes, d.UpdatedUtc);
}
