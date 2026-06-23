using Ccusage.Api.Services;
using FluentAssertions;

namespace Ccusage.Api.Tests.Unit;

/// <summary>
/// The pure trophy composer <see cref="TrophyComposer"/>: a tier is earned at-or-above its threshold and locked
/// below; the current tier is the highest earned; progress to the next unearned tier is value/threshold clamped
/// to 0..1 (1.0 when maxed); a one-shot badge is single-tier; the full catalog composes; and the earned-count
/// headline is correct.
/// </summary>
public class TrophyComposerTests
{
    private static TrophyComposer.TrophyInputs Zero => new(
        WorkoutsLogged: 0, DaysTracked: 0, HydrationGoalDays: 0, HydrationStreak: 0,
        WeighIns: 0, CoffeeCups: 0, Supplements: 0,
        HasChallenge: false, HardLongestStreak: 0, HardCompletedDays: 0, HardTotalPoints: 0m, HardFinished: false,
        BillsSettled: 0);

    private static TrophyComposer.TrophyBadge Badge(TrophyComposer.TrophyInputs m, string id) =>
        TrophyComposer.Compose(m).Single(b => b.Id == id);

    [Fact]
    public void Below_first_threshold_is_locked_with_no_tier()
    {
        var b = Badge(Zero with { WorkoutsLogged = 9 }, "workouts"); // ladder 10/50/100
        b.Earned.Should().BeFalse();
        b.Tier.Should().Be("none");
        b.Tiers.Should().OnlyContain(t => t.Earned == false);
        b.NextTier!.Name.Should().Be("bronze");
        b.NextTier.Threshold.Should().Be(10);
        b.ProgressToNext.Should().BeApproximately(0.9, 1e-9); // 9/10
    }

    [Fact]
    public void At_threshold_is_earned_boundary_inclusive()
    {
        // Exactly at bronze ⇒ earned bronze; next target is silver.
        var b = Badge(Zero with { WorkoutsLogged = 10 }, "workouts");
        b.Earned.Should().BeTrue();
        b.Tier.Should().Be("bronze");
        b.Tiers[0].Earned.Should().BeTrue();
        b.Tiers[1].Earned.Should().BeFalse();
        b.NextTier!.Name.Should().Be("silver");
        b.NextTier.Threshold.Should().Be(50);
        b.ProgressToNext.Should().BeApproximately(10.0 / 50.0, 1e-9);
    }

    [Fact]
    public void Mid_ladder_reports_highest_earned_tier_and_next_progress()
    {
        var b = Badge(Zero with { WorkoutsLogged = 60 }, "workouts"); // earned bronze+silver, toward gold
        b.Tier.Should().Be("silver");
        b.NextTier!.Name.Should().Be("gold");
        b.ProgressToNext.Should().BeApproximately(60.0 / 100.0, 1e-9);
    }

    [Fact]
    public void Maxed_ladder_has_no_next_tier_and_full_progress()
    {
        var b = Badge(Zero with { WorkoutsLogged = 250 }, "workouts");
        b.Tier.Should().Be("gold");
        b.Earned.Should().BeTrue();
        b.NextTier.Should().BeNull();
        b.ProgressToNext.Should().Be(1.0);
        b.Tiers.Should().OnlyContain(t => t.Earned);
    }

    [Fact]
    public void One_shot_finisher_is_locked_until_done_then_complete()
    {
        var locked = Badge(Zero, "hard-finisher");
        locked.Tiers.Should().ContainSingle();
        locked.Tiers[0].Name.Should().Be("complete");
        locked.Earned.Should().BeFalse();
        locked.Value.Should().Be(0);
        locked.ProgressToNext.Should().Be(0.0);

        var done = Badge(Zero with { HardFinished = true }, "hard-finisher");
        done.Earned.Should().BeTrue();
        done.Tier.Should().Be("complete");
        done.Value.Should().Be(75);
        done.NextTier.Should().BeNull();
        done.ProgressToNext.Should().Be(1.0);
    }

    [Fact]
    public void Decimal_metric_points_progress_uses_threshold_ratio()
    {
        var b = Badge(Zero with { HardTotalPoints = 500m }, "hard-points"); // 250/1000/3000
        b.Tier.Should().Be("bronze");
        b.Value.Should().Be(500);
        b.NextTier!.Threshold.Should().Be(1000);
        b.ProgressToNext.Should().BeApproximately(500.0 / 1000.0, 1e-9);
    }

    [Fact]
    public void No_challenge_leaves_all_hard_badges_locked_at_zero()
    {
        var badges = TrophyComposer.Compose(Zero);
        foreach (var id in new[] { "hard-streak", "hard-days", "hard-points", "hard-finisher" })
        {
            var b = badges.Single(x => x.Id == id);
            b.Earned.Should().BeFalse();
            b.Value.Should().Be(0);
        }
    }

    [Fact]
    public void Earned_count_tallies_badges_with_any_tier()
    {
        var m = Zero with
        {
            WorkoutsLogged = 10,     // earned
            BillsSettled = 1,        // earned (bronze threshold 1)
            CoffeeCups = 3,          // locked (bronze 10)
        };
        var badges = TrophyComposer.Compose(m);
        TrophyComposer.EarnedCount(badges).Should().Be(2);
    }

    [Fact]
    public void Catalog_is_stable_with_unique_ids_and_known_groups()
    {
        var badges = TrophyComposer.Compose(Zero);
        badges.Select(b => b.Id).Should().OnlyHaveUniqueItems();
        badges.Should().HaveCount(12);
        badges.Select(b => b.Group).Distinct().Should()
            .BeEquivalentTo(new[] { "Tracker", "75 Hard", "Bills" });
    }
}
