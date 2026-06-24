using Ccusage.Api.Data.Entities;
using FluentAssertions;

namespace Ccusage.Api.Tests.Unit;

/// <summary>
/// The PER-CATEGORY Discord-forward gate (<see cref="DiscordCategoryMap"/>) — the decision logic the
/// forwarder applies AFTER the SurfaceDiscord master toggle. Proves:
/// <list type="bullet">
///   <item>every <see cref="NotificationType"/> maps to exactly one user-facing category (total mapping);</item>
///   <item>a mask forwards ONLY the categories it has enabled (and the type→category routing is correct);</item>
///   <item>the DEFAULT mask = ALL ON, and a 0 mask is taken LITERALLY as explicit-none (forward nothing);</item>
///   <item>disabling one category never suppresses an unrelated one.</item>
/// </list>
/// The SurfaceDiscord master toggle (off ⇒ nothing) is enforced upstream in the forwarder and covered by the
/// per-user endpoint integration tests; this unit pins the category predicate itself.
/// </summary>
public class DiscordCategoryGateTests
{
    public static IEnumerable<object[]> AllTypes() =>
        Enum.GetValues<NotificationType>().Select(t => new object[] { t });

    [Theory]
    [MemberData(nameof(AllTypes))]
    public void Every_type_maps_to_exactly_one_named_category(NotificationType type)
    {
        var cat = DiscordCategoryMap.For(type);
        cat.Should().NotBe(DiscordForwardCategory.None);
        // Exactly one bit set — a type belongs to a single user-facing toggle.
        ((int)cat & ((int)cat - 1)).Should().Be(0, "each type maps to a single category bit");
        // And that bit is part of the All mask.
        (DiscordForwardCategory.All & cat).Should().Be(cat);
    }

    [Theory]
    [InlineData(NotificationType.DirectMessage, DiscordForwardCategory.DirectMessages)]
    [InlineData(NotificationType.Mention, DiscordForwardCategory.Mentions)]
    [InlineData(NotificationType.ChannelMessage, DiscordForwardCategory.ChannelMessages)]
    [InlineData(NotificationType.SystemSyncFailed, DiscordForwardCategory.SystemEvents)]
    [InlineData(NotificationType.SystemUserJoined, DiscordForwardCategory.SystemEvents)]
    [InlineData(NotificationType.SystemFleetOffline, DiscordForwardCategory.SystemEvents)]
    [InlineData(NotificationType.SystemAutomation, DiscordForwardCategory.SystemEvents)]
    [InlineData(NotificationType.FamilyReminder, DiscordForwardCategory.FamilyAlerts)]
    [InlineData(NotificationType.FamilyTimer, DiscordForwardCategory.FamilyAlerts)]
    [InlineData(NotificationType.FamilyBriefing, DiscordForwardCategory.FamilyAlerts)]
    [InlineData(NotificationType.FamilyHeadsUp, DiscordForwardCategory.FamilyAlerts)]
    [InlineData(NotificationType.Cheer, DiscordForwardCategory.Cheers)]
    [InlineData(NotificationType.SystemNudge, DiscordForwardCategory.Nudges)]
    public void Type_routes_to_the_expected_category(NotificationType type, DiscordForwardCategory expected)
        => DiscordCategoryMap.For(type).Should().Be(expected);

    [Fact]
    public void Default_All_mask_forwards_every_type()
    {
        foreach (var type in Enum.GetValues<NotificationType>())
            DiscordCategoryMap.Allows((int)DiscordForwardCategory.All, type).Should().BeTrue();
    }

    [Fact]
    public void Explicit_zero_mask_forwards_nothing()
    {
        // A 0 mask is taken LITERALLY (every category off) — an explicit "forward nothing". The entity
        // CLR-defaults to all-on and the migration backfilled existing rows, so 0 only ever means the user
        // deliberately disabled every category; it must suppress the mirror for every type.
        foreach (var type in Enum.GetValues<NotificationType>())
            DiscordCategoryMap.Allows(0, type).Should().BeFalse();
    }

    [Fact]
    public void Mask_forwards_only_the_enabled_categories()
    {
        // Enable ONLY DirectMessages + FamilyAlerts.
        var mask = (int)(DiscordForwardCategory.DirectMessages | DiscordForwardCategory.FamilyAlerts);

        // Enabled categories pass.
        DiscordCategoryMap.Allows(mask, NotificationType.DirectMessage).Should().BeTrue();
        DiscordCategoryMap.Allows(mask, NotificationType.FamilyReminder).Should().BeTrue();
        DiscordCategoryMap.Allows(mask, NotificationType.FamilyTimer).Should().BeTrue();

        // Every other category is suppressed.
        DiscordCategoryMap.Allows(mask, NotificationType.Mention).Should().BeFalse();
        DiscordCategoryMap.Allows(mask, NotificationType.ChannelMessage).Should().BeFalse();
        DiscordCategoryMap.Allows(mask, NotificationType.SystemSyncFailed).Should().BeFalse();
        DiscordCategoryMap.Allows(mask, NotificationType.SystemAutomation).Should().BeFalse();
        DiscordCategoryMap.Allows(mask, NotificationType.Cheer).Should().BeFalse();
        DiscordCategoryMap.Allows(mask, NotificationType.SystemNudge).Should().BeFalse();
    }

    [Fact]
    public void Disabling_one_category_leaves_the_others_intact()
    {
        // All on EXCEPT ChannelMessages (the common "mute the noisy channel mirror" case).
        var mask = (int)(DiscordForwardCategory.All & ~DiscordForwardCategory.ChannelMessages);

        DiscordCategoryMap.Allows(mask, NotificationType.ChannelMessage).Should().BeFalse();
        // Mentions in a channel still forward — a different category.
        DiscordCategoryMap.Allows(mask, NotificationType.Mention).Should().BeTrue();
        DiscordCategoryMap.Allows(mask, NotificationType.DirectMessage).Should().BeTrue();
        DiscordCategoryMap.Allows(mask, NotificationType.SystemSyncFailed).Should().BeTrue();
        DiscordCategoryMap.Allows(mask, NotificationType.Cheer).Should().BeTrue();
    }

    [Fact]
    public void A_fully_disabled_explicit_mask_forwards_nothing()
    {
        // An explicit all-off (DiscordForwardCategory.None == 0) suppresses EVERY type — the user disabled all
        // seven categories. This is no longer conflated with a legacy fallback: 0 means nothing forwards.
        foreach (var type in Enum.GetValues<NotificationType>())
            DiscordCategoryMap.Allows((int)DiscordForwardCategory.None, type).Should().BeFalse();

        // And a single remaining bit still proves per-category suppression is real for the others.
        var oneOn = (int)DiscordForwardCategory.Cheers;
        DiscordCategoryMap.Allows(oneOn, NotificationType.Cheer).Should().BeTrue();
        DiscordCategoryMap.Allows(oneOn, NotificationType.DirectMessage).Should().BeFalse();
    }
}
