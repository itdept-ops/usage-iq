using Ccusage.Api.Data.Entities;

namespace Ccusage.Api.Services;

/// <summary>
/// PURE deterministic math for the Meds &amp; Vitals vertical — the always-renders floor (no AI). Computes which
/// medication slots are due on a local date, the adherence percentage over a window, and per-vital-kind trend
/// stats (avg/min/max + a bounded slope). All methods are static + side-effect-free so the endpoints, the
/// MedicationDue agent, and the tests share ONE definition of "due" / "adherent" / "trend".
/// </summary>
public static class MedsVitalsMath
{
    /// <summary>How many days back the windowed reads default to when a caller omits/over/under-shoots it.</summary>
    public const int DefaultWindowDays = 30;
    public const int MinWindowDays = 1;
    public const int MaxWindowDays = 365;

    /// <summary>Clamp a requested window-day count into the sane range (default when null).</summary>
    public static int ClampWindow(int? days) =>
        days is { } d ? Math.Clamp(d, MinWindowDays, MaxWindowDays) : DefaultWindowDays;

    /// <summary>
    /// Whether <paramref name="med"/> is scheduled to be taken at all on <paramref name="date"/> — its active
    /// window (StartDate..EndDate inclusive) covers the date AND the day-of-week mask includes it (0 or 127 ⇒
    /// every day). Does NOT consider Active (the caller filters that) — purely the calendar cadence.
    /// </summary>
    public static bool IsScheduledOn(Medication med, DateOnly date)
    {
        if (date < med.StartDate) return false;
        if (med.EndDate is { } end && date > end) return false;
        var mask = med.Schedule.DaysOfWeekMask;
        if (mask is 0 or 127) return true;
        var bit = 1 << (int)date.DayOfWeek; // DayOfWeek.Sunday == 0
        return (mask & bit) != 0;
    }

    /// <summary>The number of doses scheduled for <paramref name="med"/> on <paramref name="date"/> (0 when the
    /// med isn't scheduled that day), clamped to a sane 1..12 per active day.</summary>
    public static int DosesDueOn(Medication med, DateOnly date) =>
        IsScheduledOn(med, date) ? Math.Clamp(med.Schedule.TimesPerDay, 1, 12) : 0;

    /// <summary>
    /// Deterministic adherence over a window: the percentage of SCHEDULED doses (across active days in
    /// [from, to] inclusive) that were logged Taken. Returns (taken, scheduled, percent) with percent rounded to
    /// one decimal; 0 scheduled ⇒ 0% (nothing was due). Only Taken counts toward adherence; Skipped/Missed don't.
    /// </summary>
    public static (int Taken, int Scheduled, double Percent) Adherence(
        Medication med, IReadOnlyList<MedicationLog> logs, DateOnly from, DateOnly to)
    {
        var scheduled = 0;
        for (var d = from; d <= to; d = d.AddDays(1))
            scheduled += DosesDueOn(med, d);

        // Count distinct Taken doses within the window. Cap per-day taken at the doses due that day so a
        // duplicate / over-log can never push adherence past 100%.
        var taken = 0;
        var byDay = logs
            .Where(l => l.MedicationId == med.Id && l.Status == MedicationLogStatus.Taken
                && l.LocalDate >= from && l.LocalDate <= to)
            .GroupBy(l => l.LocalDate);
        foreach (var g in byDay)
            taken += Math.Min(g.Count(), DosesDueOn(med, g.Key));

        var percent = scheduled == 0 ? 0d : Math.Round(taken * 100d / scheduled, 1);
        return (taken, scheduled, percent);
    }

    /// <summary>A vital-kind's deterministic trend over the readings supplied (already filtered to one kind):
    /// count, avg/min/max of the primary value, and a bounded least-squares slope (units/day, rounded). Null
    /// when there are no readings. Uses Value1 (systolic for BP) as the trended series.</summary>
    public sealed record VitalTrend(
        int Count, decimal Avg, decimal Min, decimal Max, decimal? Avg2, decimal SlopePerDay,
        DateOnly FirstDate, DateOnly LastDate);

    public static VitalTrend? Trend(IReadOnlyList<VitalReading> readings)
    {
        if (readings.Count == 0) return null;

        var ordered = readings.OrderBy(r => r.LocalDate).ThenBy(r => r.Id).ToList();
        var v1 = ordered.Select(r => r.Value1).ToList();
        var avg = Math.Round(v1.Average(), 2);
        var min = v1.Min();
        var max = v1.Max();

        // Optional second-value average (diastolic for BP) when any reading carries one.
        var v2 = ordered.Where(r => r.Value2 is not null).Select(r => r.Value2!.Value).ToList();
        decimal? avg2 = v2.Count > 0 ? Math.Round(v2.Average(), 2) : null;

        var slope = Slope(ordered);
        return new VitalTrend(
            ordered.Count, avg, min, max, avg2, slope, ordered[0].LocalDate, ordered[^1].LocalDate);
    }

    /// <summary>A bounded least-squares slope of Value1 vs. day-offset (units per day), rounded to 3 decimals.
    /// 0 when fewer than 2 readings or all on one day (no horizontal span). Bounded to keep an outlier-heavy
    /// series from yielding an absurd number.</summary>
    private static decimal Slope(IReadOnlyList<VitalReading> ordered)
    {
        if (ordered.Count < 2) return 0m;
        var baseDate = ordered[0].LocalDate;
        var xs = ordered.Select(r => (double)(r.LocalDate.DayNumber - baseDate.DayNumber)).ToList();
        var ys = ordered.Select(r => (double)r.Value1).ToList();
        var n = xs.Count;
        var meanX = xs.Average();
        var meanY = ys.Average();
        double num = 0, den = 0;
        for (var i = 0; i < n; i++)
        {
            num += (xs[i] - meanX) * (ys[i] - meanY);
            den += (xs[i] - meanX) * (xs[i] - meanX);
        }
        if (den == 0) return 0m; // all readings on one day
        var slope = num / den;
        // Bound to a sane range so a hostile/outlier series can't produce an absurd value.
        slope = Math.Clamp(slope, -10000d, 10000d);
        return Math.Round((decimal)slope, 3);
    }
}
