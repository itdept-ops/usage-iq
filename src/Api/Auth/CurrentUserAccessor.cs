using System.Security.Claims;
using Ccusage.Api.Data;
using Microsoft.EntityFrameworkCore;

namespace Ccusage.Api.Auth;

/// <summary>
/// Resolves the signed-in user from the database on each request (by the JWT email claim),
/// so enabled-state and permission changes take effect immediately. Cached per request scope.
/// </summary>
public sealed class CurrentUserAccessor(UsageDbContext db, IHttpContextAccessor http)
{
    public sealed record CurrentUser(int Id, string Email, string Name, bool IsEnabled, IReadOnlySet<string> Permissions);

    private bool _loaded;
    private CurrentUser? _user;

    public async Task<CurrentUser?> GetUserAsync(CancellationToken ct = default)
    {
        if (_loaded) return _user;
        _loaded = true;

        var email = http.HttpContext?.User.FindFirstValue("email")?.Trim().ToLowerInvariant();
        if (string.IsNullOrEmpty(email)) return _user = null;

        var u = await db.Users.AsNoTracking()
            .Include(x => x.Permissions)
            .FirstOrDefaultAsync(x => x.Email == email, ct);
        if (u is null) return _user = null;

        return _user = new CurrentUser(
            u.Id, u.Email, u.Name, u.IsEnabled,
            u.Permissions.Select(p => p.Permission).ToHashSet(StringComparer.Ordinal));
    }
}
