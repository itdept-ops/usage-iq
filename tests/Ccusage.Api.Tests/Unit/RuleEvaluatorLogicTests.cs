using Ccusage.Api.Data.Entities;
using Ccusage.Api.Services;
using FluentAssertions;

namespace Ccusage.Api.Tests.Unit;

/// <summary>
/// The pure logic of <see cref="RuleEvaluator"/>: the optional numeric condition, the message-template
/// rendering, and the sanitizer (which strips @everyone/@here and caps length). No DB / no senders.
/// </summary>
public class RuleEvaluatorLogicTests
{
    // ---- ConditionMet ----

    [Fact]
    public void None_op_always_matches_regardless_of_value()
    {
        RuleEvaluator.ConditionMet(RuleConditionOp.None, null, null).Should().BeTrue();
        RuleEvaluator.ConditionMet(RuleConditionOp.None, 5, 999).Should().BeTrue();
        RuleEvaluator.ConditionMet(RuleConditionOp.None, null, 0).Should().BeTrue();
    }

    [Theory]
    [InlineData(RuleConditionOp.Gte, 30, 30, true)]
    [InlineData(RuleConditionOp.Gte, 30, 45, true)]
    [InlineData(RuleConditionOp.Gte, 30, 29, false)]
    [InlineData(RuleConditionOp.Lte, 30, 30, true)]
    [InlineData(RuleConditionOp.Lte, 30, 10, true)]
    [InlineData(RuleConditionOp.Lte, 30, 31, false)]
    [InlineData(RuleConditionOp.Eq, 12, 12, true)]
    [InlineData(RuleConditionOp.Eq, 12, 13, false)]
    public void Numeric_ops_compare_event_value_against_threshold(
        RuleConditionOp op, int threshold, int value, bool expected)
    {
        RuleEvaluator.ConditionMet(op, threshold, value).Should().Be(expected);
    }

    [Fact]
    public void Numeric_op_never_matches_when_event_has_no_int_payload()
    {
        // challenge.started / hydration.goalHit carry no IntValue — a numeric condition can't be satisfied.
        RuleEvaluator.ConditionMet(RuleConditionOp.Gte, 1, null).Should().BeFalse();
        RuleEvaluator.ConditionMet(RuleConditionOp.Eq, 1, null).Should().BeFalse();
    }

    [Fact]
    public void Numeric_op_never_matches_when_threshold_is_missing()
    {
        RuleEvaluator.ConditionMet(RuleConditionOp.Gte, null, 50).Should().BeFalse();
    }

    // ---- Sanitize ----

    [Fact]
    public void Sanitize_strips_everyone_and_here_mass_mentions()
    {
        RuleEvaluator.Sanitize("hey @everyone done!").Should().Be("hey  done!");
        RuleEvaluator.Sanitize("@here ping").Should().Be("ping");
        RuleEvaluator.Sanitize("@EveryOne @HERE").Should().BeNull(); // collapses to empty -> null
    }

    [Fact]
    public void Sanitize_returns_null_for_blank_and_caps_length()
    {
        RuleEvaluator.Sanitize(null).Should().BeNull();
        RuleEvaluator.Sanitize("   ").Should().BeNull();
        RuleEvaluator.Sanitize(new string('x', 500))!.Length.Should().Be(200);
    }

    // ---- RenderTemplate ----

    [Fact]
    public void RenderTemplate_substitutes_value_token()
    {
        RuleEvaluator.RenderTemplate("Crushed a {value}-minute session!", ActivityEmitter.Kinds.WorkoutLogged, 42, "Run")
            .Should().Be("Crushed a 42-minute session!");
    }

    [Fact]
    public void RenderTemplate_falls_back_to_a_default_per_kind_message_when_blank()
    {
        RuleEvaluator.RenderTemplate(null, ActivityEmitter.Kinds.ChallengeDayComplete, 12, null)
            .Should().Be("You completed 75-Hard day 12.");
        RuleEvaluator.RenderTemplate("   ", ActivityEmitter.Kinds.HydrationGoalHit, null, null)
            .Should().Be("You hit your water goal.");
        RuleEvaluator.RenderTemplate(null, ActivityEmitter.Kinds.WorkoutLogged, 25, "Treadmill")
            .Should().Be("You logged a 25-minute Treadmill.");
    }

    [Fact]
    public void RenderTemplate_sanitizes_mass_mentions_even_in_a_custom_template()
    {
        RuleEvaluator.RenderTemplate("@everyone I hit day {value}", ActivityEmitter.Kinds.ChallengeDayComplete, 7, null)
            .Should().NotContain("@everyone").And.Contain("day 7");
    }
}
