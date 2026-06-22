using System.Linq;
using Ccusage.Api.Auth;
using FluentAssertions;

namespace Ccusage.Api.Tests.Unit;

public class PermissionsTests
{
    // The full catalog of 41 keys.
    private static readonly string[] AllKeys =
    {
        "dashboard.view", "dashboard.export", "sync.run",
        "calendar.view",
        "pricing.view", "pricing.manage",
        "settings.view", "settings.manage", "sources.manage",
        "reporter.view", "reporter.manage", "reporter.self", "fleet.view",
        "notifications.view", "notifications.manage",
        "chat.read", "chat.send", "chat.moderate", "chat.contacts.manage",
        "tracker.self", "tracker.viewall",
        "shares.view", "shares.manage",
        "family.use", "family.finance", "cycle.track", "chore.claim", "allowance.manage",
        "location.self", "location.share", "location.view-all",
        "users.view", "users.manage", "activity.view", "ai.usage.view",
        "tracker.ai", "family.ai", "family.ai.assistant", "finance.ai", "chat.ai", "ai.vision",
    };

    [Theory]
    [InlineData("dashboard.view")]
    [InlineData("dashboard.export")]
    [InlineData("sync.run")]
    [InlineData("calendar.view")]
    [InlineData("pricing.view")]
    [InlineData("pricing.manage")]
    [InlineData("settings.view")]
    [InlineData("settings.manage")]
    [InlineData("sources.manage")]
    [InlineData("reporter.view")]
    [InlineData("reporter.manage")]
    [InlineData("reporter.self")]
    [InlineData("fleet.view")]
    [InlineData("notifications.view")]
    [InlineData("notifications.manage")]
    [InlineData("chat.read")]
    [InlineData("chat.send")]
    [InlineData("chat.moderate")]
    [InlineData("chat.contacts.manage")]
    [InlineData("tracker.self")]
    [InlineData("tracker.viewall")]
    [InlineData("shares.view")]
    [InlineData("shares.manage")]
    [InlineData("family.use")]
    [InlineData("family.finance")]
    [InlineData("cycle.track")]
    [InlineData("chore.claim")]
    [InlineData("allowance.manage")]
    [InlineData("location.self")]
    [InlineData("location.share")]
    [InlineData("location.view-all")]
    [InlineData("users.view")]
    [InlineData("users.manage")]
    [InlineData("activity.view")]
    [InlineData("ai.usage.view")]
    [InlineData("tracker.ai")]
    [InlineData("family.ai")]
    [InlineData("family.ai.assistant")]
    [InlineData("finance.ai")]
    [InlineData("chat.ai")]
    [InlineData("ai.vision")]
    public void IsValid_is_true_for_each_known_key(string key)
    {
        Permissions.IsValid(key).Should().BeTrue();
    }

    [Theory]
    [InlineData("")]
    [InlineData("nope")]
    [InlineData("DASHBOARD.VIEW")]
    [InlineData("dashboard.viewx")]
    public void IsValid_is_false_for_unknown_or_wrong_case_key(string key)
    {
        Permissions.IsValid(key).Should().BeFalse();
    }

    [Fact]
    public void Constants_match_their_canonical_key_strings()
    {
        Permissions.DashboardView.Should().Be("dashboard.view");
        Permissions.DashboardExport.Should().Be("dashboard.export");
        Permissions.SyncRun.Should().Be("sync.run");
        Permissions.CalendarView.Should().Be("calendar.view");
        Permissions.PricingView.Should().Be("pricing.view");
        Permissions.PricingManage.Should().Be("pricing.manage");
        Permissions.SettingsView.Should().Be("settings.view");
        Permissions.SettingsManage.Should().Be("settings.manage");
        Permissions.SourcesManage.Should().Be("sources.manage");
        Permissions.ReporterView.Should().Be("reporter.view");
        Permissions.ReporterManage.Should().Be("reporter.manage");
        Permissions.ReporterSelf.Should().Be("reporter.self");
        Permissions.FleetView.Should().Be("fleet.view");
        Permissions.NotificationsView.Should().Be("notifications.view");
        Permissions.NotificationsManage.Should().Be("notifications.manage");
        Permissions.ChatRead.Should().Be("chat.read");
        Permissions.ChatSend.Should().Be("chat.send");
        Permissions.ChatModerate.Should().Be("chat.moderate");
        Permissions.ChatContactsManage.Should().Be("chat.contacts.manage");
        Permissions.TrackerSelf.Should().Be("tracker.self");
        Permissions.TrackerViewAll.Should().Be("tracker.viewall");
        Permissions.SharesView.Should().Be("shares.view");
        Permissions.SharesManage.Should().Be("shares.manage");
        Permissions.FamilyUse.Should().Be("family.use");
        Permissions.FamilyFinance.Should().Be("family.finance");
        Permissions.CycleTrack.Should().Be("cycle.track");
        Permissions.ChoreClaim.Should().Be("chore.claim");
        Permissions.AllowanceManage.Should().Be("allowance.manage");
        Permissions.LocationSelf.Should().Be("location.self");
        Permissions.LocationShare.Should().Be("location.share");
        Permissions.LocationViewAll.Should().Be("location.view-all");
        Permissions.UsersView.Should().Be("users.view");
        Permissions.UsersManage.Should().Be("users.manage");
        Permissions.ActivityView.Should().Be("activity.view");
        Permissions.AiUsageView.Should().Be("ai.usage.view");
        Permissions.TrackerAi.Should().Be("tracker.ai");
        Permissions.FamilyAi.Should().Be("family.ai");
        Permissions.FamilyAiAssistant.Should().Be("family.ai.assistant");
        Permissions.FinanceAi.Should().Be("finance.ai");
        Permissions.ChatAi.Should().Be("chat.ai");
        Permissions.AiVision.Should().Be("ai.vision");
    }

    [Fact]
    public void All_contains_exactly_the_forty_one_known_keys()
    {
        Permissions.All.Should().HaveCount(41);
        Permissions.All.Should().BeEquivalentTo(AllKeys);
    }

    [Fact]
    public void All_has_no_duplicates()
    {
        Permissions.All.Distinct().Count().Should().Be(Permissions.All.Length);
    }

    [Fact]
    public void Catalog_has_forty_one_entries()
    {
        Permissions.Catalog.Should().HaveCount(41);
    }

    [Fact]
    public void Every_catalog_key_passes_IsValid()
    {
        foreach (var info in Permissions.Catalog)
        {
            Permissions.IsValid(info.Key).Should().BeTrue();
        }
    }

    [Fact]
    public void Catalog_keys_equal_All_in_order()
    {
        Permissions.Catalog.Select(p => p.Key).Should().Equal(Permissions.All);
    }

    [Fact]
    public void Every_catalog_entry_has_non_empty_group_label_and_description()
    {
        foreach (var info in Permissions.Catalog)
        {
            info.Group.Should().NotBeNullOrWhiteSpace();
            info.Label.Should().NotBeNullOrWhiteSpace();
            info.Description.Should().NotBeNullOrWhiteSpace();
        }
    }

    [Fact]
    public void Views_are_the_page_view_gates_and_all_valid()
    {
        // The page-view gates: every *.view key plus chat.read (the Chat page gate) and tracker.self
        // (the Tracker page gate) — both page gates without a *.view suffix. 11 *.view keys + chat.read
        // + tracker.self = 13.
        Permissions.Views.Should().HaveCount(13);
        Permissions.Views.Should().OnlyContain(k => Permissions.IsValid(k));
        Permissions.Views.Should().OnlyContain(k =>
            k.EndsWith(".view") || k == Permissions.ChatRead || k == Permissions.TrackerSelf);
        // Every *.view key in the catalog is represented in Views.
        var catalogViews = Permissions.All.Where(k => k.EndsWith(".view"));
        Permissions.Views.Should().Contain(catalogViews);
        Permissions.Views.Should().Contain(Permissions.ChatRead);
        Permissions.Views.Should().Contain(Permissions.TrackerSelf);
    }

    [Fact]
    public void ChatModerate_is_not_defaultable()
    {
        Permissions.IsDefaultable(Permissions.ChatModerate).Should().BeFalse();
        Permissions.IsDefaultable(Permissions.ChatRead).Should().BeTrue();
        Permissions.IsDefaultable(Permissions.ChatSend).Should().BeTrue();
    }

    [Fact]
    public void ChatContactsManage_is_not_defaultable()
    {
        Permissions.IsDefaultable(Permissions.ChatContactsManage).Should().BeFalse();
        Permissions.IsDefaultable(Permissions.UsersManage).Should().BeFalse();
    }

    [Fact]
    public void TrackerViewAll_is_not_defaultable_but_TrackerSelf_is()
    {
        // Reading every user's food & fitness log is a coach/admin capability that must be granted
        // deliberately; logging your own is a defaultable, per-user capability.
        Permissions.IsDefaultable(Permissions.TrackerViewAll).Should().BeFalse();
        Permissions.IsDefaultable(Permissions.TrackerSelf).Should().BeTrue();
    }

    [Fact]
    public void Family_permissions_are_not_defaultable()
    {
        // The Family Hub holds private household data + shared finances; access must be granted
        // deliberately per user, never inherited by every new account.
        Permissions.IsDefaultable(Permissions.FamilyUse).Should().BeFalse();
        Permissions.IsDefaultable(Permissions.FamilyFinance).Should().BeFalse();
    }

    [Fact]
    public void CycleTrack_is_in_the_Family_group_non_ai_not_defaultable_and_granted_deliberately()
    {
        // Private health data: cycle.track lives in the Family group, is NOT an AI key, and is never
        // defaultable — an admin grants it deliberately to the person who tracks.
        Permissions.Catalog.Single(p => p.Key == Permissions.CycleTrack).Group.Should().Be("Family");
        Permissions.Catalog.Single(p => p.Key == Permissions.CycleTrack).IsAi.Should().BeFalse();
        Permissions.IsAi(Permissions.CycleTrack).Should().BeFalse();
        Permissions.IsDefaultable(Permissions.CycleTrack).Should().BeFalse();
        // It is part of the administrator preset (the full catalog) but NOT the family-member preset — the
        // owner grants it on purpose, it is not bundled into a standard household member.
        Permissions.Presets.Single(p => p.Key == "administrator")
            .Permissions.Should().Contain(Permissions.CycleTrack);
        Permissions.Presets.Single(p => p.Key == "family-member")
            .Permissions.Should().NotContain(Permissions.CycleTrack);
        // It is not a page-view gate.
        Permissions.Views.Should().NotContain(Permissions.CycleTrack);
    }

    [Fact]
    public void Chore_marketplace_keys_are_in_the_Family_group_non_ai_and_not_defaultable()
    {
        // chore.claim (a child capability) and allowance.manage (a parent capability) live in the Family
        // group, are NOT AI keys, and are never defaultable — granted deliberately via the presets so open
        // sign-up can never auto-mint a child or an allowance manager.
        foreach (var key in new[] { Permissions.ChoreClaim, Permissions.AllowanceManage })
        {
            Permissions.Catalog.Single(p => p.Key == key).Group.Should().Be("Family");
            Permissions.Catalog.Single(p => p.Key == key).IsAi.Should().BeFalse();
            Permissions.IsAi(key).Should().BeFalse();
            Permissions.IsDefaultable(key).Should().BeFalse();
            Permissions.Views.Should().NotContain(key); // not a page-view gate
        }
    }

    [Fact]
    public void Child_preset_is_minimal_family_use_plus_chore_claim_and_nothing_privileged()
    {
        var child = Permissions.Presets.Single(p => p.Key == "child");
        // Exactly the two keys: the minimal family.use (to be a household member) + the chore.claim capability.
        child.Permissions.Should().BeEquivalentTo(new[] { Permissions.FamilyUse, Permissions.ChoreClaim });
        // It must NOT carry any privileged/parent/AI/admin/finance/location/tracker key.
        child.Permissions.Should().NotContain(Permissions.AllowanceManage);
        child.Permissions.Should().NotContain(Permissions.FamilyFinance);
        child.Permissions.Should().NotContain(Permissions.CycleTrack);
        child.Permissions.Should().NotContain(Permissions.UsersManage);
        child.Permissions.Should().NotContain(Permissions.TrackerSelf);
        child.Permissions.Should().NotContain(Permissions.ChatRead);
        foreach (var ai in Permissions.AiKeys) child.Permissions.Should().NotContain(ai);
        foreach (var loc in Permissions.LocationKeys) child.Permissions.Should().NotContain(loc);
    }

    [Fact]
    public void Family_member_preset_includes_allowance_manage_but_not_chore_claim()
    {
        // A full member is a PARENT: they manage allowance; they are not a chore-claiming child.
        var member = Permissions.Presets.Single(p => p.Key == "family-member");
        member.Permissions.Should().Contain(Permissions.AllowanceManage);
        member.Permissions.Should().NotContain(Permissions.ChoreClaim);
    }

    [Fact]
    public void Ai_permissions_are_not_defaultable_and_are_not_page_view_gates()
    {
        // AI capabilities spend tokens, so NONE are defaultable — every new account starts AI-off and they
        // can never be selected into the open-signup default set. They are also not page-view gates, so they
        // are absent from Views.
        foreach (var key in Permissions.AiKeys)
        {
            Permissions.IsAi(key).Should().BeTrue();
            Permissions.IsDefaultable(key).Should().BeFalse();
            Permissions.Views.Should().NotContain(key);
        }
    }

    [Fact]
    public void AiUsageView_is_not_defaultable_and_is_in_the_Admin_group_and_not_an_AI_key()
    {
        // The AI usage log is admin oversight of token spend: it must be granted deliberately (not
        // defaultable), it is NOT a token-spending AI key (IsAi=false), and it lives in the Admin group.
        Permissions.IsDefaultable(Permissions.AiUsageView).Should().BeFalse();
        Permissions.IsAi(Permissions.AiUsageView).Should().BeFalse();
        Permissions.AiKeys.Should().NotContain(Permissions.AiUsageView);
        Permissions.Catalog.Single(p => p.Key == Permissions.AiUsageView).Group.Should().Be("Admin");
        // It is part of the administrator preset automatically (preset = the full catalog).
        Permissions.Presets.Single(p => p.Key == "administrator")
            .Permissions.Should().Contain(Permissions.AiUsageView);
    }

    [Fact]
    public void Location_permissions_are_not_defaultable()
    {
        // The Location feature reveals where a user is, so access must be granted deliberately per user and
        // never inherited by every new account.
        Permissions.IsDefaultable(Permissions.LocationSelf).Should().BeFalse();
        Permissions.IsDefaultable(Permissions.LocationShare).Should().BeFalse();
        Permissions.IsDefaultable(Permissions.LocationViewAll).Should().BeFalse();
    }

    [Fact]
    public void IsAi_is_true_for_exactly_the_six_AI_keys_and_matches_the_AI_group()
    {
        // Exactly the six AI keys carry IsAi — nothing else.
        Permissions.AiKeys.Should().HaveCount(6);
        Permissions.Catalog.Where(p => p.IsAi).Select(p => p.Key)
            .Should().BeEquivalentTo(Permissions.AiKeys);

        // The "AI" group and the IsAi flag are the SAME set, in both directions, and the helper agrees.
        foreach (var p in Permissions.Catalog)
        {
            (p.Group == "AI").Should().Be(p.IsAi, "group/IsAi must agree for {0}", p.Key);
            Permissions.IsAi(p.Key).Should().Be(p.IsAi);
        }
        Permissions.Catalog.Where(p => p.Group == "AI").Select(p => p.Key)
            .Should().BeEquivalentTo(Permissions.AiKeys);
    }

    [Fact]
    public void Presets_reference_only_valid_keys_and_administrator_is_everything()
    {
        var valid = Permissions.All.ToHashSet();
        Permissions.Presets.Should().HaveCount(5);
        Permissions.Presets.Select(p => p.Key).Should()
            .BeEquivalentTo(new[] { "administrator", "family-member", "child", "friend-tracker", "viewer" });

        // Every preset only grants real catalog keys.
        foreach (var preset in Permissions.Presets)
            preset.Permissions.Should().OnlyContain(k => valid.Contains(k),
                "preset '{0}' must only grant real catalog keys", preset.Key);

        // The administrator preset is exactly the full catalog.
        Permissions.Presets.Single(p => p.Key == "administrator")
            .Permissions.Should().BeEquivalentTo(Permissions.All);
    }
}
