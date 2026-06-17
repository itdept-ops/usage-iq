using Ccusage.Api.Auth;
using FluentAssertions;

namespace Ccusage.Api.Tests.Unit;

public class PermissionsTests
{
    // The full catalog of 22 keys.
    private static readonly string[] AllKeys =
    {
        "dashboard.view", "dashboard.export", "sync.run",
        "calendar.view",
        "pricing.view", "pricing.manage",
        "settings.view", "settings.manage", "sources.manage",
        "reporter.view", "reporter.manage", "reporter.self",
        "notifications.view", "notifications.manage",
        "chat.read", "chat.send", "chat.moderate",
        "shares.view", "shares.manage",
        "users.view", "users.manage", "activity.view",
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
    [InlineData("notifications.view")]
    [InlineData("notifications.manage")]
    [InlineData("chat.read")]
    [InlineData("chat.send")]
    [InlineData("chat.moderate")]
    [InlineData("shares.view")]
    [InlineData("shares.manage")]
    [InlineData("users.view")]
    [InlineData("users.manage")]
    [InlineData("activity.view")]
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
        Permissions.NotificationsView.Should().Be("notifications.view");
        Permissions.NotificationsManage.Should().Be("notifications.manage");
        Permissions.ChatRead.Should().Be("chat.read");
        Permissions.ChatSend.Should().Be("chat.send");
        Permissions.ChatModerate.Should().Be("chat.moderate");
        Permissions.SharesView.Should().Be("shares.view");
        Permissions.SharesManage.Should().Be("shares.manage");
        Permissions.UsersView.Should().Be("users.view");
        Permissions.UsersManage.Should().Be("users.manage");
        Permissions.ActivityView.Should().Be("activity.view");
    }

    [Fact]
    public void All_contains_exactly_the_twenty_two_known_keys()
    {
        Permissions.All.Should().HaveCount(22);
        Permissions.All.Should().BeEquivalentTo(AllKeys);
    }

    [Fact]
    public void All_has_no_duplicates()
    {
        Permissions.All.Distinct().Count().Should().Be(Permissions.All.Length);
    }

    [Fact]
    public void Catalog_has_twenty_two_entries()
    {
        Permissions.Catalog.Should().HaveCount(22);
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
        // The page-view gates: every *.view key plus chat.read (the Chat page gate, which has
        // no *.view suffix). 9 *.view keys + chat.read = 10.
        Permissions.Views.Should().HaveCount(10);
        Permissions.Views.Should().OnlyContain(k => Permissions.IsValid(k));
        Permissions.Views.Should().OnlyContain(k => k.EndsWith(".view") || k == Permissions.ChatRead);
        // Every *.view key in the catalog is represented in Views.
        var catalogViews = Permissions.All.Where(k => k.EndsWith(".view"));
        Permissions.Views.Should().Contain(catalogViews);
        Permissions.Views.Should().Contain(Permissions.ChatRead);
    }

    [Fact]
    public void ChatModerate_is_not_defaultable()
    {
        Permissions.IsDefaultable(Permissions.ChatModerate).Should().BeFalse();
        Permissions.IsDefaultable(Permissions.ChatRead).Should().BeTrue();
        Permissions.IsDefaultable(Permissions.ChatSend).Should().BeTrue();
    }
}
