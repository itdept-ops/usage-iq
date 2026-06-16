namespace Ccusage.Api.Auth;

public sealed record PermissionInfo(string Key, string Group, string Label, string Description);

/// <summary>The catalog of permissions users can be granted. Add new capabilities here.</summary>
public static class Permissions
{
    // ---- Dashboard ----
    public const string DashboardView = "dashboard.view";
    public const string DashboardExport = "dashboard.export";
    public const string SyncRun = "sync.run";

    // ---- Calendar ----
    public const string CalendarView = "calendar.view";

    // ---- Pricing ----
    public const string PricingView = "pricing.view";
    public const string PricingManage = "pricing.manage";

    // ---- Settings ----
    public const string SettingsView = "settings.view";
    public const string SettingsManage = "settings.manage";
    public const string SourcesManage = "sources.manage";

    // ---- Reporter ----
    public const string ReporterView = "reporter.view";
    public const string ReporterManage = "reporter.manage";
    public const string ReporterSelf = "reporter.self";

    // ---- Notifications ----
    public const string NotificationsView = "notifications.view";
    public const string NotificationsManage = "notifications.manage";

    // ---- Shares ----
    public const string SharesView = "shares.view";
    public const string SharesManage = "shares.manage";

    // ---- Administration ----
    public const string UsersView = "users.view";
    public const string UsersManage = "users.manage";
    public const string ActivityView = "activity.view";

    public static readonly IReadOnlyList<PermissionInfo> Catalog = new[]
    {
        new PermissionInfo(DashboardView, "Dashboard", "View dashboard", "View the dashboard and core usage data."),
        new PermissionInfo(DashboardExport, "Dashboard", "Export records", "Export usage records to CSV."),
        new PermissionInfo(SyncRun, "Dashboard", "Run sync", "Trigger a manual incremental sync."),

        new PermissionInfo(CalendarView, "Calendar", "View calendar", "View the calendar heatmap, stats, and session drill-down."),

        new PermissionInfo(PricingView, "Pricing", "View pricing", "View the model pricing table."),
        new PermissionInfo(PricingManage, "Pricing", "Manage pricing", "Edit or add model pricing and recompute costs."),

        new PermissionInfo(SettingsView, "Settings", "View settings", "View settings and ingestion sources."),
        new PermissionInfo(SettingsManage, "Settings", "Manage settings", "Edit timezone and the auto-sync timer."),
        new PermissionInfo(SourcesManage, "Settings", "Manage sources", "Edit ingestion sources."),

        new PermissionInfo(ReporterView, "Reporter", "View reporter", "View ingest keys and reporter docs."),
        new PermissionInfo(ReporterManage, "Reporter", "Manage reporter", "Create and revoke ingest keys."),
        new PermissionInfo(ReporterSelf, "Reporter", "Manage own reporter keys", "Create and revoke your own ingest keys to report your own usage."),

        new PermissionInfo(NotificationsView, "Notifications", "View notifications", "View the Discord/notification config."),
        new PermissionInfo(NotificationsManage, "Notifications", "Manage notifications", "Edit notifications and send a test."),

        new PermissionInfo(SharesView, "Shares", "View shares", "View share links and access logs."),
        new PermissionInfo(SharesManage, "Shares", "Manage shares", "Create, edit, and revoke share links."),

        new PermissionInfo(UsersView, "Administration", "View users", "View the user list, permission catalog, and audit log."),
        new PermissionInfo(UsersManage, "Administration", "Manage users", "Create, edit, and delete users, set permissions, and edit the access policy."),
        new PermissionInfo(ActivityView, "Administration", "View activity", "View request logs on the Activity page."),
    };

    public static readonly string[] All = Catalog.Select(p => p.Key).ToArray();

    /// <summary>The nine <c>*.view</c> keys — every page-level viewing capability.</summary>
    public static readonly string[] Views =
    {
        DashboardView, CalendarView, PricingView, SettingsView,
        ReporterView, NotificationsView, SharesView, UsersView, ActivityView,
    };

    public static bool IsValid(string key) => All.Contains(key);

    /// <summary>
    /// Whether a permission may appear in the open-sign-up default set. Excludes <see cref="UsersManage"/>
    /// so auto-provisioning can never mint an administrator: granting admin must always be an explicit,
    /// per-user action on the Users page, never something every new Google account inherits by default.
    /// </summary>
    public static bool IsDefaultable(string key) => IsValid(key) && key != UsersManage;
}
