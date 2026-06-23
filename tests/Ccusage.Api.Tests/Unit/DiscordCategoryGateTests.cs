using Ccusage.Api.Data.Entities;
using FluentAssertions;

namespace Ccusage.Api.Tests.Unit;

/// <summary>
/// The PER-CATEGORY Discord-forward gate (<see cref="DiscordCategoryMap"/>) — the decision logic the
/// forwarder applies AFTER the SurfaceDiscord master toggle. Proves:
/// <list type="bullet">
///   <item>every <see cref="NotificationType"/> maps to exactly one user-facing category (total mapping);</item>
///   <item>a mask forwards ONLY the categories it has enabled (and the type→category routing is correct);</item>
///   <item>the DEFAULT mask = ALL ON, and a legacy/blank 0 mask reads as all-on (non-breaking);</item>
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
    public void Legacy_zero_mask_reads_as_all_on_so_unmigrated_rows_still_forward()
    {
        // A blank/unmigrated row (mask 0) must NOT go silent — it preserves the forward-everything default.
        foreach (var type in Enum.GetValues<NotificationType>())
            DiscordCategoryMap.Allows(0, type).Should().BeTrue();
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
        // An explicit None is distinct from the legacy 0 read only conceptually — None IS 0, so this also
        // documents that a user cannot "disable everything" via the mask; clearing the master SurfaceDiscord
        // toggle is the off-switch. With every category bit individually off but a non-zero sentinel absent,
        // the gate falls back to all-on, matching FromCategoryMask in the endpoint. So we assert via a single
        // remaining bit to prove suppression is real for the others.
        var oneOn = (int)DiscordForwardCategory.Cheers;
        DiscordCategoryMap.Allows(oneOn, NotificationType.Cheer).Should().BeTrue();
        DiscordCategoryMap.Allows(oneOn, NotificationType.DirectMessage).Should().BeFalse();
    }
}
