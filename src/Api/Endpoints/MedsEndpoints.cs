using Ccusage.Api.Auth;
using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Ccusage.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Ccusage.Api.Endpoints;

/// <summary>
/// Meds &amp; Vitals (/api/meds, /api/vitals) — a PRIVATE, OWNER-ONLY health vertical. PRIVACY-FIRST +
/// NON-MEDICAL.
///
/// <para>STRICTLY OWNER-ONLY (the load-bearing constraint — this is sensitive health data): every read/write is
/// the caller's OWN rows (keyed by the caller's lower-cased email; cross-user {id} → 404). Medications,
/// medication logs, and vitals are NEVER shared to a coach / family / contact, NEVER appear in the activity
/// feed, and never travel any household path — enforced + tested EXACTLY like SleepEntry / CycleDayLog. The
/// vertical is gated by <see cref="Permissions.TrackerSelf"/> (no new permission); the optional vitals insight
/// ALSO needs <see cref="Permissions.TrackerAi"/>.</para>
///
/// <para>Adherence (taken/scheduled %) and vital trends (avg/min/max + a bounded slope) are PURE deterministic
/// math (<see cref="MedsVitalsMath"/>) — they ALWAYS render. The optional <c>GET /api/vitals/insight</c> adds a
/// gentle NON-MEDICAL / non-diagnostic one-liner over AGGREGATE stats only; it ALWAYS 200s with a deterministic
/// floor when AI is absent / Gemini is off, never 503s, and writes nothing.</para>
/// </summary>
public static class MedsEndpoints
{
    // ---- Limits ----
    private const int MaxNameLen = 120;
    private const int MaxDoseLen = 60;
    private const int MaxMedNotesLen = 300;
    private const int MaxLogNotesLen = 200;
    private const int MaxUnitLen = 16;
    private const int MaxTimesPerDay = 12;
    private const int MaxTimesOfDay = 12;
    private const int MedListCap = 200;
    private const int VitalListCap = 365;

    // ===================================================================================
    // Request DTOs
    // ===================================================================================

    /// <summary>The structured dosing cadence on the wire. <see cref="DaysOfWeek"/> is the explicit day list
    /// (0=Sunday..6=Saturday); empty = every day. <see cref="TimesOfDay"/> optional "HH:mm" strings.</summary>
    public sealed record ScheduleInput(int TimesPerDay, IReadOnlyList<string>? TimesOfDay, IReadOnlyList<int>? DaysOfWeek);

    public sealed record MedicationInput(
        string Name, string Dose, ScheduleInput Schedule, MedicationForm? Form, string? Notes,
        bool? Active, DateOnly? StartDate, DateOnly? EndDate, bool? RemindersEnabled);

    public sealed record LogDoseInput(DateOnly Date, int? Slot, MedicationLogStatus Status, DateTime? TakenAt, string? Notes);

    public sealed record VitalInput(
        VitalKind Kind, decimal Value1, decimal? Value2, string Unit, DateOnly LocalDate,
        DateTime? MeasuredAt, string? Notes);

    // ===================================================================================
    // Response DTOs
    // ===================================================================================

    public sealed record ScheduleDto(int TimesPerDay, IReadOnlyList<string> TimesOfDay, IReadOnlyList<int> DaysOfWeek);

    /// <summary>A medication + its cadence + TODAY's per-slot adherence state (so the client can render the
    /// dose checklist without a second call). <see cref="TodaySlots"/> has one entry per dose due today.</summary>
    public sealed record MedicationDto(
        long Id, string Name, string Dose, ScheduleDto Schedule, MedicationForm? Form, string? Notes,
        bool Active, DateOnly StartDate, DateOnly? EndDate, bool RemindersEnabled,
        IReadOnlyList<DoseSlotDto> TodaySlots, DateTime UpdatedUtc);

    /// <summary>One of today's due doses for a med + whether it's been logged. <see cref="Status"/> is null when
    /// the slot is still unlogged.</summary>
    public sealed record DoseSlotDto(int Slot, string? Time, MedicationLogStatus? Status, long? LogId);

    public sealed record MedsDto(IReadOnlyList<MedicationDto> Medications, DateOnly Today);

    public sealed record LogDto(
        long Id, long MedicationId, DateOnly Date, int? Slot, MedicationLogStatus Status,
        DateTime? TakenAtUtc, string? Notes);

    public sealed record AdherenceDto(int WindowDays, int Taken, int Scheduled, double Percent);

    public sealed record VitalDto(
        long Id, VitalKind Kind, decimal Value1, decimal? Value2, string Unit, DateOnly LocalDate,
        DateTime? MeasuredAtUtc, string? Notes);

    public sealed record TrendDto(
        int Count, decimal Avg, decimal Min, decimal Max, decimal? Avg2, decimal SlopePerDay,
        DateOnly? FirstDate, DateOnly? LastDate);

    public sealed record VitalsDto(VitalKind? Kind, int WindowDays, IReadOnlyList<VitalDto> Readings, TrendDto Trend);

    /// <summary>The gentle AI insight: the one-liner + whether it fell back to the deterministic plain floor
    /// (true when tracker.ai is absent OR Gemini is off / errored). ALWAYS 200; NON-MEDICAL.</summary>
    public sealed record InsightDto(string Note, bool FellBackToPlain);

    public static void MapMedsEndpoints(this WebApplication app)
    {
        MapMeds(app);
        MapVitals(app);
    }

    // ===================================================================================
    // MEDICATIONS — /api/meds
    // ===================================================================================
    private static void MapMeds(WebApplication app)
    {
        var g = app.MapGroup("/api/meds")
            .RequireAuthorization()
            .RequirePermission(Permissions.TrackerSelf);

        // ---- GET /api/meds : the caller's active meds + today's per-slot adherence state ----
        g.MapGet("/", async (CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var today = DateOnly.FromDateTime(DateTime.UtcNow);

            var meds = await db.Medications.AsNoTracking()
                .Where(m => m.UserEmail == caller.Email && m.Active)
                .OrderBy(m => m.Name)
                .Take(MedListCap)
                .ToListAsync(ct);

            var medIds = meds.Select(m => m.Id).ToList();
            var todayLogs = await db.MedicationLogs.AsNoTracking()
                .Where(l => l.UserEmail == caller.Email && l.LocalDate == today && medIds.Contains(l.MedicationId))
                .ToListAsync(ct);

            var dtos = meds.Select(m => ToMedDto(m, BuildTodaySlots(m, today, todayLogs))).ToList();
            return Results.Ok(new MedsDto(dtos, today));
        });

        // ---- POST /api/meds : add a medication (owner-scoped) ----
        g.MapPost("/", async (
            MedicationInput req, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            if (ValidateMed(req) is { } bad) return bad;
            var caller = (await me.GetUserAsync(ct))!;

            var now = DateTime.UtcNow;
            var row = new Medication
            {
                UserEmail = caller.Email,
                UserId = caller.Id,
                Name = req.Name.Trim().Truncate(MaxNameLen),
                Dose = (req.Dose ?? "").Trim().Truncate(MaxDoseLen),
                Schedule = ToSchedule(req.Schedule),
                Form = req.Form,
                Notes = Normalize(req.Notes, MaxMedNotesLen),
                Active = req.Active ?? true,
                StartDate = req.StartDate ?? DateOnly.FromDateTime(now),
                EndDate = req.EndDate,
                RemindersEnabled = req.RemindersEnabled ?? false,
                CreatedUtc = now,
                UpdatedUtc = now,
            };
            db.Medications.Add(row);
            await db.SaveChangesAsync(ct);
            var today = DateOnly.FromDateTime(now);
            return Results.Ok(ToMedDto(row, BuildTodaySlots(row, today, Array.Empty<MedicationLog>())));
        });

        // ---- PUT /api/meds/{id} : edit / activate / deactivate / toggle reminders (owner-scoped) ----
        g.MapPut("/{id:long}", async (
            long id, MedicationInput req, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            if (ValidateMed(req) is { } bad) return bad;
            var caller = (await me.GetUserAsync(ct))!;

            // Owner-scoped: the WHERE binds the id AND the caller's email — a guessed id never matches another user.
            var row = await db.Medications
                .FirstOrDefaultAsync(m => m.Id == id && m.UserEmail == caller.Email, ct);
            if (row is null) return Results.NotFound();

            row.Name = req.Name.Trim().Truncate(MaxNameLen);
            row.Dose = (req.Dose ?? "").Trim().Truncate(MaxDoseLen);
            row.Schedule = ToSchedule(req.Schedule);
            row.Form = req.Form;
            row.Notes = Normalize(req.Notes, MaxMedNotesLen);
            if (req.Active is { } active) row.Active = active;
            if (req.StartDate is { } sd) row.StartDate = sd;
            row.EndDate = req.EndDate;
            if (req.RemindersEnabled is { } rem) row.RemindersEnabled = rem;
            row.UpdatedUtc = DateTime.UtcNow;
            await db.SaveChangesAsync(ct);

            var today = DateOnly.FromDateTime(DateTime.UtcNow);
            var todayLogs = await db.MedicationLogs.AsNoTracking()
                .Where(l => l.UserEmail == caller.Email && l.LocalDate == today && l.MedicationId == row.Id)
                .ToListAsync(ct);
            return Results.Ok(ToMedDto(row, BuildTodaySlots(row, today, todayLogs)));
        });

        // ---- DELETE /api/meds/{id} : SOFT-deactivate (owner-scoped) ----
        g.MapDelete("/{id:long}", async (
            long id, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var updated = await db.Medications
                .Where(m => m.Id == id && m.UserEmail == caller.Email)
                .ExecuteUpdateAsync(s => s
                    .SetProperty(m => m.Active, false)
                    .SetProperty(m => m.UpdatedUtc, DateTime.UtcNow), ct);
            return updated == 0 ? Results.NotFound() : Results.NoContent();
        });

        // ---- POST /api/meds/{id}/log : record one dose's adherence (owner-scoped) ----
        g.MapPost("/{id:long}/log", async (
            long id, LogDoseInput req, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            if (ValidateLogDate(req.Date) is { } bad) return bad;
            if (!Enum.IsDefined(typeof(MedicationLogStatus), req.Status))
                return Results.BadRequest(new { message = "Unknown status." });
            var caller = (await me.GetUserAsync(ct))!;

            // Owner-scoped: the med must be the caller's own (a guessed id never matches another user).
            var med = await db.Medications.AsNoTracking()
                .FirstOrDefaultAsync(m => m.Id == id && m.UserEmail == caller.Email, ct);
            if (med is null) return Results.NotFound();

            var now = DateTime.UtcNow;
            var slot = req.Slot is { } s ? Math.Clamp(s, 0, MaxTimesPerDay - 1) : (int?)null;

            // Upsert the slot's log for the day so re-tapping a dose toggles its status rather than piling up rows.
            var row = await db.MedicationLogs.FirstOrDefaultAsync(
                l => l.UserEmail == caller.Email && l.MedicationId == id
                    && l.LocalDate == req.Date && l.ScheduledSlot == slot, ct);
            if (row is null)
            {
                row = new MedicationLog
                {
                    MedicationId = id,
                    UserEmail = caller.Email,
                    LocalDate = req.Date,
                    ScheduledSlot = slot,
                    CreatedUtc = now,
                };
                db.MedicationLogs.Add(row);
            }
            row.Status = req.Status;
            row.TakenAtUtc = req.Status == MedicationLogStatus.Taken ? (req.TakenAt ?? now) : null;
            row.Notes = Normalize(req.Notes, MaxLogNotesLen);
            await db.SaveChangesAsync(ct);

            return Results.Ok(new LogDto(
                row.Id, row.MedicationId, row.LocalDate, row.ScheduledSlot, row.Status, row.TakenAtUtc, row.Notes));
        });

        // ---- GET /api/meds/adherence?window= : deterministic taken/scheduled % over the window ----
        g.MapGet("/adherence", async (
            int? window, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var days = MedsVitalsMath.ClampWindow(window);
            var today = DateOnly.FromDateTime(DateTime.UtcNow);
            var from = today.AddDays(-(days - 1));

            var meds = await db.Medications.AsNoTracking()
                .Where(m => m.UserEmail == caller.Email && m.Active)
                .ToListAsync(ct);
            var medIds = meds.Select(m => m.Id).ToList();
            var logs = await db.MedicationLogs.AsNoTracking()
                .Where(l => l.UserEmail == caller.Email && medIds.Contains(l.MedicationId)
                    && l.LocalDate >= from && l.LocalDate <= today)
                .ToListAsync(ct);

            var (taken, scheduled) = AggregateAdherence(meds, logs, from, today);
            var percent = scheduled == 0 ? 0d : Math.Round(taken * 100d / scheduled, 1);
            return Results.Ok(new AdherenceDto(days, taken, scheduled, percent));
        });
    }

    // ===================================================================================
    // VITALS — /api/vitals
    // ===================================================================================
    private static void MapVitals(WebApplication app)
    {
        var g = app.MapGroup("/api/vitals")
            .RequireAuthorization()
            .RequirePermission(Permissions.TrackerSelf);

        // ---- GET /api/vitals?kind=&window= : readings newest-first + a deterministic trend ----
        g.MapGet("/", async (
            VitalKind? kind, int? window, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var days = MedsVitalsMath.ClampWindow(window);
            var today = DateOnly.FromDateTime(DateTime.UtcNow);
            var from = today.AddDays(-(days - 1));

            var q = db.VitalReadings.AsNoTracking()
                .Where(v => v.UserEmail == caller.Email && v.LocalDate >= from && v.LocalDate <= today);
            if (kind is { } k) q = q.Where(v => v.Kind == k);

            var readings = await q
                .OrderByDescending(v => v.LocalDate).ThenByDescending(v => v.Id)
                .Take(VitalListCap)
                .ToListAsync(ct);

            var trend = MedsVitalsMath.Trend(readings);
            return Results.Ok(new VitalsDto(kind, days, readings.Select(ToVitalDto).ToList(), ToTrendDto(trend)));
        });

        // ---- POST /api/vitals : log a reading (owner-scoped) ----
        g.MapPost("/", async (
            VitalInput req, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            if (ValidateVital(req) is { } bad) return bad;
            var caller = (await me.GetUserAsync(ct))!;

            var now = DateTime.UtcNow;
            var row = new VitalReading
            {
                UserEmail = caller.Email,
                UserId = caller.Id,
                Kind = req.Kind,
                Value1 = req.Value1,
                Value2 = req.Kind == VitalKind.BloodPressure ? req.Value2 : null,
                Unit = (req.Unit ?? "").Trim().Truncate(MaxUnitLen),
                LocalDate = req.LocalDate,
                MeasuredAtUtc = req.MeasuredAt,
                Notes = Normalize(req.Notes, MaxLogNotesLen),
                CreatedUtc = now,
            };
            db.VitalReadings.Add(row);
            await db.SaveChangesAsync(ct);
            return Results.Ok(ToVitalDto(row));
        });

        // ---- PUT /api/vitals/{id} : edit a reading (owner-scoped) ----
        g.MapPut("/{id:long}", async (
            long id, VitalInput req, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            if (ValidateVital(req) is { } bad) return bad;
            var caller = (await me.GetUserAsync(ct))!;

            var row = await db.VitalReadings
                .FirstOrDefaultAsync(v => v.Id == id && v.UserEmail == caller.Email, ct);
            if (row is null) return Results.NotFound();

            row.Kind = req.Kind;
            row.Value1 = req.Value1;
            row.Value2 = req.Kind == VitalKind.BloodPressure ? req.Value2 : null;
            row.Unit = (req.Unit ?? "").Trim().Truncate(MaxUnitLen);
            row.LocalDate = req.LocalDate;
            row.MeasuredAtUtc = req.MeasuredAt;
            row.Notes = Normalize(req.Notes, MaxLogNotesLen);
            await db.SaveChangesAsync(ct);
            return Results.Ok(ToVitalDto(row));
        });

        // ---- DELETE /api/vitals/{id} : delete a reading (owner-scoped) ----
        g.MapDelete("/{id:long}", async (
            long id, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var deleted = await db.VitalReadings
                .Where(v => v.Id == id && v.UserEmail == caller.Email)
                .ExecuteDeleteAsync(ct);
            return deleted == 0 ? Results.NotFound() : Results.NoContent();
        });

        // ---- GET /api/vitals/insight?window= : a floored, NON-MEDICAL AI summary over AGGREGATE stats ----
        // tracker.self (the group) gates the route; the AI NARRATION additionally needs tracker.ai. ALWAYS 200
        // with a deterministic plain floor (fellBackToPlain=true) when tracker.ai is absent OR Gemini is off /
        // errors. Only AGGREGATE stats (adherence %, vital avg/min/max/trend) ever reach the model — never a raw
        // reading, dated row, or note. Never 503; writes nothing.
        g.MapGet("/insight", async (
            int? window, CurrentUserAccessor me, UsageDbContext db, GeminiService gemini, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var days = MedsVitalsMath.ClampWindow(window);
            var today = DateOnly.FromDateTime(DateTime.UtcNow);
            var from = today.AddDays(-(days - 1));

            // AGGREGATE adherence over active meds.
            var meds = await db.Medications.AsNoTracking()
                .Where(m => m.UserEmail == caller.Email && m.Active)
                .ToListAsync(ct);
            var medIds = meds.Select(m => m.Id).ToList();
            var medLogs = await db.MedicationLogs.AsNoTracking()
                .Where(l => l.UserEmail == caller.Email && medIds.Contains(l.MedicationId)
                    && l.LocalDate >= from && l.LocalDate <= today)
                .ToListAsync(ct);
            var (taken, scheduled) = AggregateAdherence(meds, medLogs, from, today);
            double? adherencePct = scheduled == 0 ? null : Math.Round(taken * 100d / scheduled, 1);

            // AGGREGATE vital trends per kind (no raw rows).
            var vitals = await db.VitalReadings.AsNoTracking()
                .Where(v => v.UserEmail == caller.Email && v.LocalDate >= from && v.LocalDate <= today)
                .ToListAsync(ct);
            var trendsByKind = vitals
                .GroupBy(v => v.Kind)
                .Select(grp => (Kind: grp.Key, Trend: MedsVitalsMath.Trend(grp.ToList())!))
                .ToList();

            var plain = ComposePlainInsight(adherencePct, trendsByKind);

            // tracker.ai gates the narration; without it (or with Gemini off) we serve the deterministic floor.
            var allowAi = caller.Permissions.Contains(Permissions.TrackerAi);
            if (!allowAi || !gemini.IsConfigured)
                return Results.Ok(new InsightDto(plain, true));

            string? ai = null;
            // Only the AGGREGATE stats summary goes to the model — never a raw reading / note / dated row.
            try { ai = await gemini.VitalsInsightAsync(StatsSummary(days, adherencePct, trendsByKind), ct); }
            catch { ai = null; } // AI must never fail this endpoint — fall back to the plain floor.

            return string.IsNullOrWhiteSpace(ai)
                ? Results.Ok(new InsightDto(plain, true))
                : Results.Ok(new InsightDto(ai!, false));
        });
    }

    // ===================================================================================
    // Deterministic helpers (shared math is in MedsVitalsMath)
    // ===================================================================================

    /// <summary>Aggregate (taken, scheduled) across every active med over [from, to] — the adherence numerator
    /// and denominator the % and the insight share.</summary>
    private static (int Taken, int Scheduled) AggregateAdherence(
        IReadOnlyList<Medication> meds, IReadOnlyList<MedicationLog> logs, DateOnly from, DateOnly to)
    {
        int taken = 0, scheduled = 0;
        foreach (var m in meds)
        {
            var a = MedsVitalsMath.Adherence(m, logs, from, to);
            taken += a.Taken;
            scheduled += a.Scheduled;
        }
        return (taken, scheduled);
    }

    /// <summary>Build today's per-slot dose checklist for a med from today's logs (one entry per due dose).</summary>
    private static IReadOnlyList<DoseSlotDto> BuildTodaySlots(
        Medication med, DateOnly today, IReadOnlyList<MedicationLog> todayLogs)
    {
        var due = MedsVitalsMath.DosesDueOn(med, today);
        if (due == 0) return Array.Empty<DoseSlotDto>();

        var bySlot = todayLogs
            .Where(l => l.MedicationId == med.Id && l.LocalDate == today)
            .GroupBy(l => l.ScheduledSlot ?? 0)
            .ToDictionary(grp => grp.Key, grp => grp.OrderByDescending(l => l.Id).First());

        var times = med.Schedule.TimesOfDay;
        var slots = new List<DoseSlotDto>(due);
        for (var i = 0; i < due; i++)
        {
            var time = i < times.Count ? times[i].ToString("HH:mm") : null;
            if (bySlot.TryGetValue(i, out var log))
                slots.Add(new DoseSlotDto(i, time, log.Status, log.Id));
            else
                slots.Add(new DoseSlotDto(i, time, null, null));
        }
        return slots;
    }

    private static MedicationSchedule ToSchedule(ScheduleInput s)
    {
        var times = new List<TimeOnly>();
        if (s.TimesOfDay is not null)
            foreach (var t in s.TimesOfDay)
            {
                if (times.Count >= MaxTimesOfDay) break;
                if (TimeOnly.TryParse(t, out var parsed)) times.Add(parsed);
            }

        var mask = 0;
        if (s.DaysOfWeek is not null)
            foreach (var d in s.DaysOfWeek)
                if (d is >= 0 and <= 6) mask |= 1 << d;

        return new MedicationSchedule
        {
            TimesPerDay = Math.Clamp(s.TimesPerDay, 1, MaxTimesPerDay),
            TimesOfDay = times,
            DaysOfWeekMask = mask,
        };
    }

    // ---- Plain (deterministic) insight floor + the AGGREGATE-only stats summary the AI narrates ----

    private static string ComposePlainInsight(
        double? adherencePct, IReadOnlyList<(VitalKind Kind, MedsVitalsMath.VitalTrend Trend)> trends)
    {
        var parts = new List<string>();
        if (adherencePct is { } pct)
            parts.Add($"You've taken about {pct:0.#}% of your scheduled doses.");
        if (trends.Count > 0)
        {
            var t = trends[0];
            var dir = t.Trend.SlopePerDay > 0.05m ? "trending up"
                : t.Trend.SlopePerDay < -0.05m ? "trending down" : "holding steady";
            parts.Add($"Your {KindLabel(t.Kind)} readings have averaged {t.Trend.Avg:0.#} and are {dir}.");
        }
        return parts.Count == 0
            ? "Log a medication or a vital reading to start seeing your private summary here."
            : string.Join(" ", parts);
    }

    /// <summary>The compact AGGREGATE-only facts the model NARRATES (it invents nothing). Carries ONLY computed
    /// stats — an adherence percentage and per-kind avg/min/max/slope — never a raw reading, a dated row, or a
    /// free-text note.</summary>
    private static string StatsSummary(
        int days, double? adherencePct,
        IReadOnlyList<(VitalKind Kind, MedsVitalsMath.VitalTrend Trend)> trends)
    {
        var lines = new List<string> { $"WINDOW_DAYS: {days}" };
        if (adherencePct is { } pct) lines.Add($"MEDICATION_ADHERENCE_PCT: {pct:0.#}");
        foreach (var (kind, t) in trends)
        {
            var dir = t.SlopePerDay > 0.05m ? "up" : t.SlopePerDay < -0.05m ? "down" : "steady";
            var second = t.Avg2 is { } a2 ? $", avg2={a2:0.#}" : "";
            lines.Add($"{KindLabel(kind).ToUpperInvariant().Replace(' ', '_')}: " +
                $"avg={t.Avg:0.#}, min={t.Min:0.#}, max={t.Max:0.#}{second}, trend={dir} ({t.Count} readings)");
        }
        return string.Join("\n", lines);
    }

    private static string KindLabel(VitalKind kind) => kind switch
    {
        VitalKind.BloodPressure => "blood pressure",
        VitalKind.HeartRate => "heart rate",
        VitalKind.Glucose => "glucose",
        VitalKind.Temperature => "temperature",
        VitalKind.OxygenSaturation => "oxygen saturation",
        VitalKind.BodyWeight => "body weight",
        _ => "reading",
    };

    // ---- Validation ----

    private static IResult? ValidateMed(MedicationInput req)
    {
        if (string.IsNullOrWhiteSpace(req.Name))
            return Results.BadRequest(new { message = "A medication name is required." });
        if (req.Schedule is null || req.Schedule.TimesPerDay < 1)
            return Results.BadRequest(new { message = "Schedule must have at least one dose per day." });
        if (req.Form is { } f && !Enum.IsDefined(typeof(MedicationForm), f))
            return Results.BadRequest(new { message = "Unknown medication form." });
        if (req.StartDate is { } sd && DateOutOfRange(sd))
            return Results.BadRequest(new { message = "That start date is out of range." });
        if (req.EndDate is { } ed)
        {
            if (DateOutOfRange(ed)) return Results.BadRequest(new { message = "That end date is out of range." });
            if (req.StartDate is { } s && ed < s)
                return Results.BadRequest(new { message = "The end date must be on or after the start date." });
        }
        return null;
    }

    private static IResult? ValidateVital(VitalInput req)
    {
        if (!Enum.IsDefined(typeof(VitalKind), req.Kind))
            return Results.BadRequest(new { message = "Unknown vital kind." });
        if (req.Value1 is < 0 or > 100000)
            return Results.BadRequest(new { message = "That reading is out of range." });
        if (req.Value2 is { } v2 && v2 is < 0 or > 100000)
            return Results.BadRequest(new { message = "That secondary reading is out of range." });
        if (string.IsNullOrWhiteSpace(req.Unit))
            return Results.BadRequest(new { message = "A unit is required." });
        if (ValidateLogDate(req.LocalDate) is { } bad) return bad;
        return null;
    }

    private static IResult? ValidateLogDate(DateOnly date)
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

    private static string? Normalize(string? s, int max)
    {
        var t = s?.Trim();
        return string.IsNullOrEmpty(t) ? null : t.Truncate(max);
    }

    // ---- Projections ----

    private static MedicationDto ToMedDto(Medication m, IReadOnlyList<DoseSlotDto> todaySlots) => new(
        m.Id, m.Name, m.Dose, ToScheduleDto(m.Schedule), m.Form, m.Notes, m.Active,
        m.StartDate, m.EndDate, m.RemindersEnabled, todaySlots, m.UpdatedUtc);

    private static ScheduleDto ToScheduleDto(MedicationSchedule s) => new(
        s.TimesPerDay,
        s.TimesOfDay.Select(t => t.ToString("HH:mm")).ToList(),
        DaysFromMask(s.DaysOfWeekMask));

    private static IReadOnlyList<int> DaysFromMask(int mask)
    {
        if (mask is 0 or 127) return Array.Empty<int>(); // "every day"
        var days = new List<int>();
        for (var d = 0; d < 7; d++)
            if ((mask & (1 << d)) != 0) days.Add(d);
        return days;
    }

    private static VitalDto ToVitalDto(VitalReading v) => new(
        v.Id, v.Kind, v.Value1, v.Value2, v.Unit, v.LocalDate, v.MeasuredAtUtc, v.Notes);

    private static TrendDto ToTrendDto(MedsVitalsMath.VitalTrend? t) => t is null
        ? new TrendDto(0, 0, 0, 0, null, 0, null, null)
        : new TrendDto(t.Count, t.Avg, t.Min, t.Max, t.Avg2, t.SlopePerDay, t.FirstDate, t.LastDate);
}

/// <summary>Small string helpers local to the meds vertical.</summary>
internal static class MedsStringExtensions
{
    public static string Truncate(this string s, int max) => s.Length <= max ? s : s[..max];
}
