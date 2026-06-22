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

    // ---- Response DTOs ----
    public sealed record PeriodDto(int Id, DateOnly StartDate, DateOnly? EndDate, DateTime LoggedUtc);
    public sealed record FertileWindowDto(DateOnly Start, DateOnly End);

    /// <summary>The deterministic prediction block (no AI). <see cref="NextPredictedStart"/>/<see cref="FertileWindow"/>
    /// are null until there's at least one logged period to anchor from.</summary>
    public sealed record PredictionDto(
        int AvgCycleLengthDays, DateOnly? NextPredictedStart, FertileWindowDto? FertileWindow, string CurrentPhase);

    public sealed record SettingsDto(int AvgCycleLengthDays, int AvgPeriodLengthDays, bool OverlayToFamily);

    /// <summary>The main GET payload: the owner's recent periods + the deterministic predictions + their settings.</summary>
    public sealed record CycleDto(
        IReadOnlyList<PeriodDto> Periods, PredictionDto Prediction, SettingsDto Settings);

    /// <summary>The gentle AI note: the one-liner + whether it fell back to the deterministic plain floor
    /// (true when family.ai is absent or Gemini is off). ALWAYS 200.</summary>
    public sealed record NoteDto(string Note, bool FellBackToPlain);

    private const int RecentCap = 24;

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

            var prediction = BuildPrediction(periods, profile);
            return Results.Ok(new CycleDto(
                periods.Select(ToDto).ToList(),
                prediction,
                ToSettingsDto(profile)));
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

            var today = DateOnly.FromDateTime(DateTime.UtcNow);
            var prediction = CyclePredictionService.Compute(
                periods, profile.AvgCycleLengthDays, profile.AvgPeriodLengthDays, today);

            var plain = ComposePlainNote(prediction);

            // Gemini off → the deterministic floor (fellBackToPlain=true), ALWAYS 200.
            if (!gemini.IsConfigured)
                return Results.Ok(new NoteDto(plain, true));

            string? ai = null;
            try { ai = await gemini.CycleNoteAsync(FactsSummary(prediction), ct); }
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

        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        var floor = today.AddYears(-5);
        var ceil = today.AddYears(1);
        if (req.StartDate < floor || req.StartDate > ceil)
            return Results.BadRequest(new { message = "That start date is out of range." });
        if (req.EndDate is { } e && (e < floor || e > ceil))
            return Results.BadRequest(new { message = "That end date is out of range." });
        return null;
    }

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

    private static PredictionDto BuildPrediction(IReadOnlyList<CyclePeriod> periods, CycleProfile profile)
    {
        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        var p = CyclePredictionService.Compute(
            periods, profile.AvgCycleLengthDays, profile.AvgPeriodLengthDays, today);
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
    /// AGGREGATE projection — never raw logged entries — so cycle content never reaches the AI as content.</summary>
    private static string FactsSummary(CyclePredictionService.Prediction p)
    {
        var lines = new List<string> { $"AVG_CYCLE_DAYS: {p.AvgCycleLengthDays}" };
        if (p.NextPredictedStart is { } n) lines.Add($"NEXT_PREDICTED_START: {n:yyyy-MM-dd}");
        if (p.FertileStart is { } fs && p.FertileEnd is { } fe)
            lines.Add($"FERTILE_WINDOW: {fs:yyyy-MM-dd} to {fe:yyyy-MM-dd}");
        lines.Add($"CURRENT_PHASE: {p.CurrentPhase}");
        return string.Join("\n", lines);
    }

    private static PeriodDto ToDto(CyclePeriod p) => new(p.Id, p.StartDate, p.EndDate, p.LoggedUtc);

    private static SettingsDto ToSettingsDto(CycleProfile p) =>
        new(p.AvgCycleLengthDays, p.AvgPeriodLengthDays, p.OverlayToFamily);
}
