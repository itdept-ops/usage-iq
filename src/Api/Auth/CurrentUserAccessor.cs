using System.Security.Claims;
using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Microsoft.EntityFrameworkCore;

namespace Ccusage.Api.Auth;

/// <summary>
/// Resolves the signed-in user from the database on each request (by the JWT email claim),
/// so enabled-state and permission changes take effect immediately. Cached per request scope.
/// </summary>
public sealed class CurrentUserAccessor(UsageDbContext db, IHttpContextAccessor http)
{
    public sealed record CurrentUser(
        int Id, string Email, string Name, bool IsEnabled, IReadOnlySet<string> Permissions,
        string? HomeRoute = null, string? Picture = null,
        DisplayNameMode DisplayNameMode = DisplayNameMode.FirstInitial, string? Nickname = null,
        bool AppearOffline = false, string? PresenceStatus = null, bool ShareAutoContext = false,
        bool ShareActivity = false, bool ViewActivityFeed = false, bool NudgesOptOut = false);

    /// <summary>
    /// HttpContext.Items key under which the JWT <c>OnTokenValidated</c> handler stashes the AppUser it
    /// already loaded (with Permissions) to enforce the session stamp, so this accessor can reuse it
    /// rather than hitting the DB a second time.
    /// </summary>
    public const string LoadedUserKey = "Ccusage.CurrentUser.Loaded";

    private bool _loaded;
    private CurrentUser? _user;

    public async Task<CurrentUser?> GetUserAsync(CancellationToken ct = default)
    {
        if (_loaded) return _user;
        _loaded = true;

        // Reuse the AppUser the auth pipeline already loaded for session-stamp enforcement, if present.
        if (http.HttpContext?.Items.TryGetValue(LoadedUserKey, out var stashed) == true && stashed is AppUser pre)
            return _user = Map(pre);

        var email = http.HttpContext?.User.FindFirstValue("email")?.Trim().ToLowerInvariant();
        if (string.IsNullOrEmpty(email)) return _user = null;

        var u = await db.Users.AsNoTracking()
            .Include(x => x.Permissions)
            .FirstOrDefaultAsync(x => x.Email == email, ct);
        if (u is null) return _user = null;

        return _user = Map(u);
    }

    private static CurrentUser Map(AppUser u) => new(
        u.Id, u.Email, u.Name, u.IsEnabled,
        u.Permissions.Select(p => p.Permission).ToHashSet(StringComparer.Ordinal),
        u.HomeRoute, u.Picture,
        u.DisplayNameMode, u.Nickname, u.AppearOffline, u.PresenceStatus, u.ShareAutoContext,
        u.ShareActivity, u.ViewActivityFeed, u.NudgesOptOut);
}
