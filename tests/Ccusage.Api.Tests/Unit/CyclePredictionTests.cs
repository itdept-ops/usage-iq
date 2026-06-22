using Ccusage.Api.Data.Entities;
using Ccusage.Api.Services;
using FluentAssertions;

namespace Ccusage.Api.Tests.Unit;

/// <summary>
/// The PURE deterministic cycle math (<see cref="CyclePredictionService"/>) — no AI, no I/O. Covers: the
/// average derived from gaps between logged starts (vs. the profile fallback), the next-start projection, the
/// fertile window centred ~14 days before it, and the overlay day-spans (predicted only, clipped to the window).
/// </summary>
public class CyclePredictionTests
{
    private static CyclePeriod Start(string isoDate) => new()
    {
        UserEmail = "x@test.local",
        StartDate = DateOnly.Parse(isoDate),
        LoggedUtc = DateTime.UtcNow,
    };

    [Fact]
    public void Three_starts_28_days_apart_predict_next_at_last_plus_28_with_a_fertile_window()
    {
        // Starts 28 days apart: 2026-01-01, 2026-01-29, 2026-02-26 → avg gap 28, last 2026-02-26.
        var periods = new[] { Start("2026-01-01"), Start("2026-01-29"), Start("2026-02-26") };
        var today = new DateOnly(2026, 03, 01);

        var p = CyclePredictionService.Compute(periods, profileAvgCycle: 30, profileAvgPeriod: 5, today);

        p.AvgCycleLengthDays.Should().Be(28);                       // derived from the gaps, NOT the profile (30)
        p.LastStart.Should().Be(new DateOnly(2026, 02, 26));
        p.NextPredictedStart.Should().Be(new DateOnly(2026, 03, 26)); // last + 28
        // Fertile window ~ ovulation (next - 14 = Mar 12) ± 3 days.
        p.FertileStart.Should().Be(new DateOnly(2026, 03, 09));
        p.FertileEnd.Should().Be(new DateOnly(2026, 03, 15));
    }

    [Fact]
    public void A_single_start_falls_back_to_the_profile_average()
    {
        var periods = new[] { Start("2026-02-10") };
        var today = new DateOnly(2026, 02, 12);

        var p = CyclePredictionService.Compute(periods, profileAvgCycle: 30, profileAvgPeriod: 5, today);

        // No gaps to derive from → the profile default (30) is used, and the next start is last + 30.
        p.AvgCycleLengthDays.Should().Be(30);
        p.NextPredictedStart.Should().Be(new DateOnly(2026, 03, 12));
    }

    [Fact]
    public void No_history_yields_no_projection_only_the_fallback_average()
    {
        var p = CyclePredictionService.Compute(Array.Empty<CyclePeriod>(), 28, 5, new DateOnly(2026, 02, 01));

        p.AvgCycleLengthDays.Should().Be(28);
        p.NextPredictedStart.Should().BeNull();
        p.FertileStart.Should().BeNull();
        p.FertileEnd.Should().BeNull();
        p.CurrentPhase.Should().Be("unknown");
    }

    [Fact]
    public void Derived_average_is_clamped_into_a_sane_range()
    {
        // Two starts 200 days apart would derive a 200-day "cycle"; it is clamped to 60.
        var periods = new[] { Start("2026-01-01"), Start("2026-07-20") };
        var p = CyclePredictionService.Compute(periods, 28, 5, new DateOnly(2026, 08, 01));
        p.AvgCycleLengthDays.Should().Be(60);
    }

    [Fact]
    public void Today_inside_the_period_length_is_the_period_phase()
    {
        var periods = new[] { Start("2026-03-01"), Start("2026-03-29") };
        // 2026-03-30 is day 2 of the latest period (avgPeriod 5) → "period".
        var p = CyclePredictionService.Compute(periods, 28, 5, new DateOnly(2026, 03, 30));
        p.CurrentPhase.Should().Be("period");
    }

    [Fact]
    public void Overlay_spans_are_predicted_only_and_clipped_to_the_window()
    {
        var periods = new[] { Start("2026-01-01"), Start("2026-01-29"), Start("2026-02-26") };
        var prediction = CyclePredictionService.Compute(periods, 28, 5, new DateOnly(2026, 03, 01));

        var from = new DateOnly(2026, 03, 01);
        var to = new DateOnly(2026, 03, 31);
        var spans = CyclePredictionService.OverlaySpans(prediction, avgPeriod: 5, from, to);

        spans.Should().NotBeEmpty();
        // Every span is within the window and one of the two predicted kinds.
        spans.Should().OnlyContain(s => s.Start >= from && s.End <= to);
        spans.Should().OnlyContain(s => s.Kind == "period" || s.Kind == "fertile");
        // The predicted period (Mar 26 + 5 days) and fertile window (Mar 9–15) both fall in the window.
        spans.Should().Contain(s => s.Kind == "period" && s.Start == new DateOnly(2026, 03, 26));
        spans.Should().Contain(s => s.Kind == "fertile" && s.Start == new DateOnly(2026, 03, 09));
    }

    [Fact]
    public void Overlay_spans_are_empty_without_logged_history()
    {
        var prediction = CyclePredictionService.Compute(Array.Empty<CyclePeriod>(), 28, 5, new DateOnly(2026, 03, 01));
        var spans = CyclePredictionService.OverlaySpans(
            prediction, 5, new DateOnly(2026, 03, 01), new DateOnly(2026, 03, 31));
        spans.Should().BeEmpty();
    }

    private static CycleDayLog Heavy(string isoDate) => new()
    {
        UserEmail = "x@test.local",
        LocalDate = DateOnly.Parse(isoDate),
        FlowLevel = CycleFlowLevel.Heavy,
        CreatedUtc = DateTime.UtcNow,
        UpdatedUtc = DateTime.UtcNow,
    };

    [Fact]
    public void A_heavy_flow_day_confirms_a_period_start_the_owner_didnt_log_as_a_period()
    {
        // Only ONE logged period start. A heavy-flow day-log 28 days later (well beyond the confirm gap) adds
        // a SECOND start, so the average becomes a derived 28-day gap (not the profile fallback of 35).
        var periods = new[] { Start("2026-01-01") };
        var dayLogs = new[] { Heavy("2026-01-29") };
        var today = new DateOnly(2026, 02, 01);

        var p = CyclePredictionService.Compute(periods, profileAvgCycle: 35, profileAvgPeriod: 5, today, dayLogs);

        p.AvgCycleLengthDays.Should().Be(28);                         // derived from the confirmed gap, not 35
        p.LastStart.Should().Be(new DateOnly(2026, 01, 29));          // the heavy-flow day is the latest start
        p.NextPredictedStart.Should().Be(new DateOnly(2026, 02, 26)); // 2026-01-29 + 28
    }

    [Fact]
    public void A_heavy_flow_day_near_a_logged_start_does_not_double_count()
    {
        // A heavy-flow day 2 days after a logged start is WITHIN that period (inside the confirm gap) → it
        // must NOT become a separate start. With one real start, the average falls back to the profile.
        var periods = new[] { Start("2026-02-01") };
        var dayLogs = new[] { Heavy("2026-02-03") };
        var p = CyclePredictionService.Compute(periods, profileAvgCycle: 30, profileAvgPeriod: 5,
            new DateOnly(2026, 02, 05), dayLogs);

        p.LastStart.Should().Be(new DateOnly(2026, 02, 01)); // unchanged — the heavy day was not a new anchor
        p.AvgCycleLengthDays.Should().Be(30);                // profile fallback (no derived second start)
    }

    [Fact]
    public void Non_heavy_flow_days_never_confirm_a_start()
    {
        // A MEDIUM-flow day (below the confirm threshold) far from any start is ignored — still one start.
        var periods = new[] { Start("2026-01-01") };
        var dayLogs = new[]
        {
            new CycleDayLog
            {
                UserEmail = "x@test.local", LocalDate = new DateOnly(2026, 01, 29),
                FlowLevel = CycleFlowLevel.Medium, CreatedUtc = DateTime.UtcNow, UpdatedUtc = DateTime.UtcNow,
            },
        };
        var p = CyclePredictionService.Compute(periods, 30, 5, new DateOnly(2026, 02, 01), dayLogs);
        p.LastStart.Should().Be(new DateOnly(2026, 01, 01)); // medium flow did NOT add a start
        p.AvgCycleLengthDays.Should().Be(30);
    }
}
