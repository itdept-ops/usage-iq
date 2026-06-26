namespace Ccusage.Api.Auth;

/// <summary>
/// The set of page routes a user may choose as their landing "home", and the permission each one
/// requires. Mirrors the route guards in the SPA's <c>app.routes.ts</c> EXACTLY — a route may be set
/// as home only when the caller currently holds (one of) the permission(s) its guard checks. This is
/// the single source of truth the self-service <c>PATCH /api/auth/home</c> endpoint validates against,
/// so a user can never persist a home they cannot access.
/// </summary>
public static class HomeRoutes
{
    /// <summary>route -> the permission keys that grant access; the caller needs ANY one of them.</summary>
    public static readonly IReadOnlyDictionary<string, string[]> Map = new Dictionary<string, string[]>(StringComparer.Ordinal)
    {
        ["/"] = new[] { Permissions.DashboardView },
        ["/calendar"] = new[] { Permissions.CalendarView },
        ["/pricing"] = new[] { Permissions.PricingView },
        ["/settings"] = new[] { Permissions.SettingsView },
        ["/reporter"] = new[] { Permissions.ReporterView, Permissions.ReporterManage, Permissions.ReporterSelf },
        ["/fleet"] = new[] { Permissions.FleetView, Permissions.ReporterManage },
        ["/chat"] = new[] { Permissions.ChatRead },
        ["/tracker"] = new[] { Permissions.TrackerSelf },
        ["/family"] = new[] { Permissions.FamilyUse },
        ["/family/identity"] = new[] { Permissions.IdentityMap },
        ["/locations"] = new[] { Permissions.LocationSelf },
        ["/users"] = new[] { Permissions.UsersView },
        ["/activity"] = new[] { Permissions.ActivityView },

        // Beta surfaces (the mobile-first redesigns) — mirror the route guards in app.routes.ts so a beta
        // page can be set as the landing page. The /beta section is gated by beta.access; tracker-beta has
        // its own tracker.beta guard. (Routes that ALSO require a feature perm, e.g. /beta/family needs
        // family.use, are filtered in the SPA picker; beta.access is the section gate here.)
        ["/tracker-beta"] = new[] { Permissions.TrackerBeta },
        ["/beta"] = new[] { Permissions.BetaAccess },
        ["/beta/home"] = new[] { Permissions.BetaAccess },
        ["/beta/dashboard"] = new[] { Permissions.BetaAccess },
        ["/beta/family"] = new[] { Permissions.BetaAccess },
        ["/beta/bills"] = new[] { Permissions.BetaAccess },
        ["/beta/wrapped"] = new[] { Permissions.BetaAccess },
        ["/beta/settings"] = new[] { Permissions.BetaAccess },
        ["/beta/chat"] = new[] { Permissions.BetaAccess },
        ["/beta/ask"] = new[] { Permissions.BetaAccess },
        ["/beta/meals"] = new[] { Permissions.BetaAccess },
    };

    public static bool IsKnown(string route) => Map.ContainsKey(route);

    /// <summary>Whether the caller (by their permission set) may land on <paramref name="route"/>.</summary>
    public static bool CanAccess(string route, IReadOnlySet<string> permissions) =>
        Map.TryGetValue(route, out var required) && required.Any(permissions.Contains);
}
