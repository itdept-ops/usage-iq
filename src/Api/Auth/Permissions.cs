namespace Ccusage.Api.Auth;

public sealed record PermissionInfo(string Key, string Label, string Description);

/// <summary>The catalog of permissions users can be granted. Add new capabilities here.</summary>
public static class Permissions
{
    public const string DashboardView = "dashboard.view";
    public const string SyncRun = "sync.run";
    public const string PricingManage = "pricing.manage";
    public const string SettingsManage = "settings.manage";
    public const string UsersManage = "users.manage";

    public static readonly IReadOnlyList<PermissionInfo> Catalog = new[]
    {
        new PermissionInfo(DashboardView, "View dashboard", "See usage data, charts, records, pricing and settings."),
        new PermissionInfo(SyncRun, "Run sync", "Trigger a manual incremental sync."),
        new PermissionInfo(PricingManage, "Manage pricing", "Edit model pricing and recompute costs."),
        new PermissionInfo(SettingsManage, "Manage settings", "Edit timezone, sources, and the auto-sync timer."),
        new PermissionInfo(UsersManage, "Manage users", "Add or remove users and edit their permissions."),
    };

    public static readonly string[] All = Catalog.Select(p => p.Key).ToArray();

    public static bool IsValid(string key) => All.Contains(key);
}
