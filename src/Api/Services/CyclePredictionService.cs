using Ccusage.Api.Data.Entities;

namespace Ccusage.Api.Services;

/// <summary>
/// PURE, DETERMINISTIC cycle math — no AI, no I/O. Given a user's logged period starts (and their profile
/// defaults), it derives the average cycle length from the GAPS between consecutive starts (falling back to
/// the profile default when there isn't enough history), then projects the next predicted start, a fertile
/// window (~ovulation 14 days before the next start, ±a few days), and the current phase. This is the single
/// source of truth shared by the cycle endpoints and the family-calendar overlay so both agree exactly.
///
/// NON-MEDICAL + informational: these are simple calendar projections, never a diagnosis or advice.
/// </summary>
public static class CyclePredictionService
{
    /// <summary>How many days before the next predicted start ovulation is assumed (the classic luteal-phase
    /// constant). The fertile window is centred a few days around it.</summary>
    public const int OvulationOffsetDays = 14;

    /// <summary>The fertile window spans <see cref="OvulationOffsetDays"/> ± this many days.</summary>
    public const int FertileSpreadDays = 3;

    /// <summary>The deterministic prediction result. All dates are calendar days (DateOnly); null when there is
    /// no logged history to anchor a projection from.</summary>
    public sealed record Prediction(
        int AvgCycleLengthDays,
        DateOnly? LastStart,
        DateOnly? NextPredictedStart,
        DateOnly? FertileStart,
        DateOnly? FertileEnd,
        string CurrentPhase);

    /// <summary>
    /// A logged day at or above this flow level can CONFIRM a period start the owner didn't log as a period
    /// row — but only when no logged period start is already near it (within <see cref="ConfirmGapDays"/>), so
    /// it adds a missing anchor without double-counting an existing one. Kept conservative + deterministic.
    /// </summary>
    public const CycleFlowLevel ConfirmFlowLevel = CycleFlowLevel.Heavy;

    /// <summary>A heavy-flow day only becomes a candidate start when every existing start is more than this many
    /// days away (otherwise it's just a day WITHIN an already-known period).</summary>
    public const int ConfirmGapDays = 10;

    /// <summary>
    /// Compute the deterministic prediction as of <paramref name="today"/> from the user's logged
    /// <paramref name="periods"/> (any order) and their profile fallbacks. The average cycle length is the
    /// mean gap between consecutive logged starts (rounded, clamped to a sane [15,60]); with fewer than two
    /// starts there are no gaps, so the profile's <paramref name="profileAvgCycle"/> is used. The next start is
    /// the most-recent logged start + the average; the fertile window is centred ~14 days before that next
    /// start. The current phase is derived from where <paramref name="today"/> falls relative to the last
    /// start, the typical period length, and the predicted fertile window.
    /// </summary>
    public static Prediction Compute(
        IReadOnlyList<CyclePeriod> periods, int profileAvgCycle, int profileAvgPeriod, DateOnly today,
        IReadOnlyList<CycleDayLog>? dayLogs = null)
    {
        var starts = DeriveStarts(periods, dayLogs);
        if (starts.Count == 0)
        {
            // No history at all — nothing to anchor a projection from. Report the fallback average only.
            return new Prediction(Clamp(profileAvgCycle, 15, 60), null, null, null, null, "unknown");
        }

        var lastStart = starts[^1];

        // Derive the average cycle length from the gaps between consecutive starts; fall back to the profile
        // default when there are no gaps (fewer than two logged starts).
        int avgCycle;
        if (starts.Count >= 2)
        {
            double sum = 0;
            for (var i = 1; i < starts.Count; i++)
                sum += starts[i].DayNumber - starts[i - 1].DayNumber;
            avgCycle = (int)Math.Round(sum / (starts.Count - 1));
        }
        else
        {
            avgCycle = profileAvgCycle;
        }
        avgCycle = Clamp(avgCycle, 15, 60);
        var avgPeriod = Clamp(profileAvgPeriod, 1, 14);

        var nextStart = lastStart.AddDays(avgCycle);
        // Ovulation ~14 days before the next start; the fertile window is a few days either side.
        var ovulation = nextStart.AddDays(-OvulationOffsetDays);
        var fertileStart = ovulation.AddDays(-FertileSpreadDays);
        var fertileEnd = ovulation.AddDays(FertileSpreadDays);

        var phase = DerivePhase(today, lastStart, nextStart, avgPeriod, fertileStart, fertileEnd);
        return new Prediction(avgCycle, lastStart, nextStart, fertileStart, fertileEnd, phase);
    }

    /// <summary>
    /// Classify <paramref name="today"/> into a soft phase label: "period" while within the typical period
    /// length of the last start, "fertile" while inside the predicted fertile window, "premenstrual" in the
    /// few days before the next predicted start, "predicted-late" once past it, else "follicular"/"luteal".
    /// Informational only.
    /// </summary>
    private static string DerivePhase(
        DateOnly today, DateOnly lastStart, DateOnly nextStart, int avgPeriod,
        DateOnly fertileStart, DateOnly fertileEnd)
    {
        if (today >= lastStart && today < lastStart.AddDays(avgPeriod)) return "period";
        if (today >= fertileStart && today <= fertileEnd) return "fertile";
        if (today > nextStart) return "predicted-late";
        if (today >= nextStart.AddDays(-FertileSpreadDays) && today <= nextStart) return "premenstrual";
        if (today < fertileStart) return "follicular";
        return "luteal";
    }

    /// <summary>
    /// The PREDICTED phase day-spans the family overlay surfaces for one member over a [from, to] window: the
    /// upcoming period (next predicted start + the typical period length) and the predicted fertile window,
    /// each clipped to the window and emitted ONLY when it overlaps. Pure projection — never raw logged data.
    /// Returns nothing when there's no logged history to project from.
    /// </summary>
    public static IReadOnlyList<(string Kind, DateOnly Start, DateOnly End)> OverlaySpans(
        Prediction p, int avgPeriod, DateOnly from, DateOnly to)
    {
        var spans = new List<(string, DateOnly, DateOnly)>();
        if (p.NextPredictedStart is not { } nextStart) return spans;

        avgPeriod = Clamp(avgPeriod, 1, 14);

        // Project successive predicted period + fertile spans forward across the window so a multi-month range
        // shows each upcoming cycle, not just the first. Bounded by the window itself.
        var cycle = p.AvgCycleLengthDays;
        var start = nextStart;

        // Walk forward, capping the number of projected cycles to keep it bounded even on a wide window.
        for (var i = 0; i < 24 && start.AddDays(-OvulationOffsetDays - FertileSpreadDays) <= to; i++)
        {
            var periodStart = start;
            var periodEnd = start.AddDays(avgPeriod - 1);
            AddIfOverlaps(spans, "period", periodStart, periodEnd, from, to);

            var ovulation = start.AddDays(-OvulationOffsetDays);
            var fStart = ovulation.AddDays(-FertileSpreadDays);
            var fEnd = ovulation.AddDays(FertileSpreadDays);
            AddIfOverlaps(spans, "fertile", fStart, fEnd, from, to);

            start = start.AddDays(cycle);
        }

        return spans;
    }

    private static void AddIfOverlaps(
        List<(string, DateOnly, DateOnly)> spans, string kind, DateOnly start, DateOnly end,
        DateOnly from, DateOnly to)
    {
        if (end < from || start > to) return; // no overlap with the window
        var clippedStart = start < from ? from : start;
        var clippedEnd = end > to ? to : end;
        spans.Add((kind, clippedStart, clippedEnd));
    }

    /// <summary>
    /// The sorted, de-duplicated set of period START dates the prediction anchors on. Logged
    /// <paramref name="periods"/> are the authoritative starts; a heavy-flow day-log can CONFIRM an ADDITIONAL
    /// start the owner forgot to log as a period, but ONLY when it is the first heavy day of a run AND no
    /// existing start is within <see cref="ConfirmGapDays"/> of it (so it never double-counts a known period or
    /// adds noise mid-period). Stays fully deterministic — same inputs, same starts. The day-log's intimate
    /// fields are never consulted; only the flow level + date.
    /// </summary>
    private static List<DateOnly> DeriveStarts(
        IReadOnlyList<CyclePeriod> periods, IReadOnlyList<CycleDayLog>? dayLogs)
    {
        var starts = periods.Select(p => p.StartDate).ToList();

        if (dayLogs is { Count: > 0 })
        {
            // Heavy-flow days, sorted; the set of all heavy dates lets us keep only a RUN's first day.
            var heavyDates = dayLogs
                .Where(d => d.FlowLevel >= ConfirmFlowLevel)
                .Select(d => d.LocalDate)
                .ToHashSet();

            foreach (var date in heavyDates.OrderBy(d => d))
            {
                // Only the FIRST heavy day of a contiguous run is a candidate start (skip if yesterday was heavy).
                if (heavyDates.Contains(date.AddDays(-1))) continue;
                // Skip if any already-known start (logged or already-confirmed) is within the gap window.
                if (starts.Any(s => Math.Abs(s.DayNumber - date.DayNumber) <= ConfirmGapDays)) continue;
                starts.Add(date);
            }
        }

        return starts.Distinct().OrderBy(d => d).ToList();
    }

    private static int Clamp(int v, int lo, int hi) => v < lo ? lo : v > hi ? hi : v;
}
