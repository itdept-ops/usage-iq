using Ccusage.Api.Endpoints;
using FluentAssertions;

namespace Ccusage.Api.Tests.Unit;

/// <summary>
/// The DETERMINISTIC recurring-charge detector behind the finance "Money coach"
/// (<see cref="FamilyFinanceEndpoints.DetectRecurring"/>) — the authoritative floor that works with Gemini
/// off. Pure + DB-free:
///
/// <list type="bullet">
///   <item>3 monthly Netflix charges (across 3 distinct months, stable amount) collapse to ONE recurring row
///   with the median amount, monthsSeen=3, and the latest date.</item>
///   <item>A one-off charge (a single month) is EXCLUDED — recurring needs &gt;= 2 distinct months.</item>
///   <item>Merchant normalization groups "Netflix.com", "NETFLIX #4471", and "Netflix" together.</item>
///   <item>A wildly-varying merchant (groceries you visit monthly for very different totals) is NOT treated as
///   a stable subscription.</item>
/// </list>
/// </summary>
public class RecurringChargeDetectorTests
{
    private static FamilyFinanceEndpoints.ExpenseRow Row(string merchant, decimal amount, int year, int month, int day) =>
        new(merchant, amount, new DateOnly(year, month, day));

    [Fact]
    public void Three_monthly_netflix_charges_collapse_to_one_recurring_row()
    {
        var rows = new[]
        {
            Row("Netflix", 15.99m, 2026, 3, 5),
            Row("Netflix", 15.99m, 2026, 4, 5),
            Row("Netflix", 15.99m, 2026, 5, 5),
        };

        var recurring = FamilyFinanceEndpoints.DetectRecurring(rows);

        recurring.Should().HaveCount(1);
        var netflix = recurring[0];
        netflix.Merchant.Should().Be("Netflix");
        netflix.TypicalAmount.Should().Be(15.99m);
        netflix.MonthsSeen.Should().Be(3);
        netflix.LastDate.Should().Be(new DateOnly(2026, 5, 5)); // the latest occurrence
    }

    [Fact]
    public void A_one_off_charge_is_excluded()
    {
        var rows = new[]
        {
            // A single Best Buy purchase in one month — not recurring.
            Row("Best Buy", 499.00m, 2026, 4, 12),
            // Netflix recurs across 2 months — the only recurring merchant.
            Row("Netflix", 15.99m, 2026, 4, 5),
            Row("Netflix", 15.99m, 2026, 5, 5),
        };

        var recurring = FamilyFinanceEndpoints.DetectRecurring(rows);

        recurring.Should().ContainSingle();
        recurring.Select(r => r.Merchant).Should().NotContain("Best Buy");
        recurring[0].Merchant.Should().Be("Netflix");
    }

    [Fact]
    public void Merchant_normalization_groups_variant_spellings_and_pos_ids()
    {
        var rows = new[]
        {
            Row("Netflix.com", 15.99m, 2026, 3, 5),
            Row("NETFLIX #4471", 15.99m, 2026, 4, 5),
            Row("Netflix", 15.99m, 2026, 5, 5),
        };

        var recurring = FamilyFinanceEndpoints.DetectRecurring(rows);

        recurring.Should().HaveCount(1);
        recurring[0].MonthsSeen.Should().Be(3); // all three variants grouped into one merchant
    }

    [Fact]
    public void Twice_in_the_same_month_only_is_not_recurring()
    {
        var rows = new[]
        {
            // Two charges, same merchant, SAME calendar month -> only 1 distinct month -> not recurring.
            Row("Corner Cafe", 6.50m, 2026, 4, 3),
            Row("Corner Cafe", 6.50m, 2026, 4, 18),
        };

        FamilyFinanceEndpoints.DetectRecurring(rows).Should().BeEmpty();
    }

    [Fact]
    public void A_wildly_varying_merchant_is_not_a_stable_subscription()
    {
        var rows = new[]
        {
            // Same store across 3 months but wildly different totals — irregular shopping, not a subscription.
            Row("Whole Foods", 30.00m, 2026, 3, 2),
            Row("Whole Foods", 145.00m, 2026, 4, 9),
            Row("Whole Foods", 280.00m, 2026, 5, 21),
        };

        FamilyFinanceEndpoints.DetectRecurring(rows).Should().BeEmpty();
    }

    [Fact]
    public void Multiple_subscriptions_are_returned_ordered_by_amount_desc()
    {
        var rows = new[]
        {
            Row("Spotify", 9.99m, 2026, 4, 1),
            Row("Spotify", 9.99m, 2026, 5, 1),
            Row("Gym Membership", 49.99m, 2026, 4, 15),
            Row("Gym Membership", 49.99m, 2026, 5, 15),
        };

        var recurring = FamilyFinanceEndpoints.DetectRecurring(rows);

        recurring.Should().HaveCount(2);
        recurring[0].Merchant.Should().Be("Gym Membership"); // higher amount first
        recurring[1].Merchant.Should().Be("Spotify");
        recurring.Sum(r => r.TypicalAmount).Should().Be(59.98m); // monthly recurring total
    }
}
