using Ccusage.Api.Auth;
using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Ccusage.Api.Dtos;
using Ccusage.Api.Hubs;
using Ccusage.Api.Services;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;

namespace Ccusage.Api.Endpoints;

public static class UsersEndpoints
{
    public static void MapUsersEndpoints(this WebApplication app)
    {
        // The permission catalog (for the admin UI).
        app.MapGet("/api/permissions", () => Results.Ok(Permissions.Catalog
                .Select(p => new PermissionItemDto { Key = p.Key, Group = p.Group, Label = p.Label, Description = p.Description })))
            .RequireAuthorization().RequireAnyPermission(Permissions.UsersView, Permissions.UsersManage);

        // Recent audit entries (who changed what). Actor/target emails are masked to null unless the
        // X-Email-Reveal-Key header matches the configured key — the caller's OWN actor email stays real
        // (this log shows on the Users page, so it must honor the same email-visibility gate).
        app.MapGet("/api/audit", async (UsageDbContext db, HttpContext http, IConfiguration cfg,
                CurrentUserAccessor current, CancellationToken ct) =>
            {
                var rows = await db.AuditEntries.AsNoTracking()
                    .OrderByDescending(a => a.WhenUtc).Take(200)
                    .Select(a => new AuditEntryDto
                    {
                        Id = a.Id, WhenUtc = a.WhenUtc, ActorEmail = a.ActorEmail,
                        Action = a.Action, TargetEmail = a.TargetEmail, Detail = a.Detail,
                    }).ToListAsync(ct);

                if (!EmailsRevealed(http, cfg))
                {
                    var me = (await current.GetUserAsync(ct))?.Email;
                    foreach (var r in rows)
                    {
                        if (!SameEmail(r.ActorEmail, me)) r.ActorEmail = null;
                        if (!SameEmail(r.TargetEmail, me)) r.TargetEmail = null;
                        r.Detail = MaskEmailsInText(r.Detail); // scrub any address embedded in free-text detail
                    }
                }
                return Results.Ok(rows);
            })
            .RequireAuthorization().RequireAnyPermission(Permissions.UsersView, Permissions.UsersManage);

        // Access policy: open sign-up toggle + the default permissions for auto-provisioned users.
        app.MapGet("/api/access-policy", async (UsageDbContext db, CancellationToken ct) =>
        {
            var cfg = await db.AppConfigs.AsNoTracking().FirstAsync(ct);
            return Results.Ok(new AccessPolicyDto
            {
                OpenSignupEnabled = cfg.OpenSignupEnabled,
                DefaultPermissions = (cfg.DefaultPermissionsCsv ?? "")
                    .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                    .Where(Permissions.IsDefaultable).Distinct().ToArray(),
            });
        }).RequireAuthorization().RequireAnyPermission(Permissions.UsersView, Permissions.UsersManage);

        app.MapPut("/api/access-policy", async (AccessPolicyDto req, UsageDbContext db, AuditLogger audit, CancellationToken ct) =>
        {
            // Defaults are filtered to "defaultable" keys: users.manage is never persistable as a default,
            // so open sign-up can't be configured to auto-grant admin to every new account.
            var perms = (req.DefaultPermissions ?? Array.Empty<string>())
                .Where(Permissions.IsDefaultable).Distinct().ToArray();
            var cfg = await db.AppConfigs.FirstAsync(ct);
            cfg.OpenSignupEnabled = req.OpenSignupEnabled;
            cfg.DefaultPermissionsCsv = string.Join(",", perms);
            await db.SaveChangesAsync(ct);
            await audit.LogAsync("accesspolicy.updated", null,
                $"openSignup={cfg.OpenSignupEnabled}; defaults=[{string.Join(", ", perms)}]", ct);
            return Results.Ok(new AccessPolicyDto { OpenSignupEnabled = cfg.OpenSignupEnabled, DefaultPermissions = perms });
        }).RequireAuthorization().RequirePermission(Permissions.UsersManage);

        var users = app.MapGroup("/api/users").RequireAuthorization();

        // The user list. Each row's Email is masked to null UNLESS the X-Email-Reveal-Key header matches
        // the configured key — EXCEPT the caller's own row, which always shows their real email.
        users.MapGet("/", async (UsageDbContext db, HttpContext http, IConfiguration cfg,
            CurrentUserAccessor current, CancellationToken ct) =>
        {
            var reveal = EmailsRevealed(http, cfg);
            var me = reveal ? null : (await current.GetUserAsync(ct))?.Email;
            var rows = await db.Users.AsNoTracking().Include(u => u.Permissions)
                .OrderBy(u => u.Email).ToListAsync(ct);
            return Results.Ok(rows.Select(u => ToDto(u, maskEmail: !reveal && !SameEmail(u.Email, me))));
        }).RequireAnyPermission(Permissions.UsersView, Permissions.UsersManage);

        // Per-user sign-in history (newest first, capped). Filters by the user's email so it also
        // surfaces events recorded before a UserId was bound (and survives id churn).
        users.MapGet("/{id:int}/logins", async (int id, UsageDbContext db, CancellationToken ct) =>
        {
            var user = await db.Users.AsNoTracking().FirstOrDefaultAsync(u => u.Id == id, ct);
            if (user is null) return Results.NotFound();

            var events = await db.LoginEvents.AsNoTracking()
                .Where(e => e.Email == user.Email)
                .OrderByDescending(e => e.WhenUtc).ThenByDescending(e => e.Id)
                .Take(200)
                .Select(e => new LoginEventDto
                {
                    Id = e.Id, WhenUtc = e.WhenUtc, Ip = e.Ip, Success = e.Success,
                    Reason = e.Reason, Name = e.Name, UserAgent = e.UserAgent,
                })
                .ToListAsync(ct);
            return Results.Ok(events);
        }).RequireAnyPermission(Permissions.UsersView, Permissions.UsersManage);

        users.MapPost("/", async (UserUpsertRequest req, UsageDbContext db, AuditLogger audit, CancellationToken ct) =>
        {
            var email = (req.Email ?? "").Trim().ToLowerInvariant();
            if (email.Length == 0 || !email.Contains('@'))
                return Results.BadRequest(new { message = "A valid email is required." });
            if (await db.Users.AnyAsync(u => u.Email == email, ct))
                return Results.Conflict(new { message = $"{email} already exists." });

            var user = new AppUser
            {
                Email = email,
                Name = req.Name?.Trim() ?? "",
                IsEnabled = req.IsEnabled,
                CreatedUtc = DateTime.UtcNow,
                Permissions = ValidPermissions(req.Permissions).Select(p => new UserPermission { Permission = p }).ToList(),
            };
            db.Users.Add(user);
            await db.SaveChangesAsync(ct);
            await audit.LogAsync("user.created", email,
                $"enabled={user.IsEnabled}; permissions=[{string.Join(", ", user.Permissions.Select(p => p.Permission))}]", ct);
            return Results.Created($"/api/users/{user.Id}", ToDto(user));
        }).RequirePermission(Permissions.UsersManage);

        users.MapPut("/{id:int}", async (int id, UserUpsertRequest req, UsageDbContext db, AuditLogger audit, CancellationToken ct) =>
        {
            // Serializable so the last-admin check and the write can't be raced by a concurrent edit.
            // Run inside the execution strategy: connection-resiliency retries forbid user-initiated
            // transactions otherwise, and ChangeTracker.Clear keeps each retry attempt clean.
            var strategy = db.Database.CreateExecutionStrategy();
            return await strategy.ExecuteAsync(async () =>
            {
                db.ChangeTracker.Clear();
                await using var tx = await db.Database.BeginTransactionAsync(System.Data.IsolationLevel.Serializable, ct);

                var user = await db.Users.Include(u => u.Permissions).FirstOrDefaultAsync(u => u.Id == id, ct);
                if (user is null) return Results.NotFound();

                var newPerms = ValidPermissions(req.Permissions);
                var staysAdmin = req.IsEnabled && newPerms.Contains(Permissions.UsersManage);
                if (!staysAdmin && await IsLastAdmin(db, user.Id, ct))
                    return Results.BadRequest(new { message = "You can't remove or disable the last administrator." });

                if (req.Name is not null) user.Name = req.Name.Trim();
                user.IsEnabled = req.IsEnabled;
                db.UserPermissions.RemoveRange(user.Permissions);
                user.Permissions = newPerms.Select(p => new UserPermission { Permission = p }).ToList();
                await db.SaveChangesAsync(ct);
                await tx.CommitAsync(ct);
                await audit.LogAsync("user.updated", user.Email,
                    $"enabled={user.IsEnabled}; permissions=[{string.Join(", ", user.Permissions.Select(p => p.Permission))}]", ct);
                return Results.Ok(ToDto(user));
            });
        }).RequirePermission(Permissions.UsersManage);

        users.MapDelete("/{id:int}", async (int id, UsageDbContext db, AuditLogger audit, CancellationToken ct) =>
        {
            var strategy = db.Database.CreateExecutionStrategy();
            return await strategy.ExecuteAsync(async () =>
            {
                db.ChangeTracker.Clear();
                await using var tx = await db.Database.BeginTransactionAsync(System.Data.IsolationLevel.Serializable, ct);

                var user = await db.Users.Include(u => u.Permissions).FirstOrDefaultAsync(u => u.Id == id, ct);
                if (user is null) return Results.NotFound();
                if (await IsLastAdmin(db, user.Id, ct))
                    return Results.BadRequest(new { message = "You can't delete the last administrator." });

                var removedEmail = user.Email;
                db.Users.Remove(user);
                await db.SaveChangesAsync(ct);
                await tx.CommitAsync(ct);
                await audit.LogAsync("user.deleted", removedEmail, null, ct);
                return Results.NoContent();
            });
        }).RequirePermission(Permissions.UsersManage);

        // Force-logout: invalidate the user's CURRENT session(s) without disabling the account. Bumping
        // SessionVersion makes every outstanding token's "sv" claim stale, so the next request (or /me
        // poll) is rejected 401 and the SPA logs them out. They can sign in again to get a fresh token —
        // this is distinct from Disable, which blocks re-login.
        users.MapPost("/{id:int}/logout", async (int id, UsageDbContext db, AuditLogger audit,
            IHubContext<ChatHub> hub, CancellationToken ct) =>
        {
            var user = await db.Users.FirstOrDefaultAsync(u => u.Id == id, ct);
            if (user is null) return Results.NotFound();

            user.SessionVersion += 1;
            await db.SaveChangesAsync(ct);
            await audit.LogAsync("user.forcedlogout", user.Email, $"sessionVersion={user.SessionVersion}", ct);

            // Kill the session in REAL TIME: push a SessionRevoked event to any of the user's live SignalR
            // connections so the SPA logs them out immediately, instead of waiting for their next request or
            // the ~20s /me poll to 401. Best-effort — the SessionVersion bump above is the source of truth, so
            // even if the push no-ops (no live connection) or fails (transient hub error) the now-stale token
            // is still rejected on the next call.
            try { await hub.Clients.User(user.Email).SendAsync("SessionRevoked", ct); }
            catch { /* non-fatal: the version bump + per-request token re-check already invalidates the session */ }

            return Results.Ok(new { ok = true });
        }).RequirePermission(Permissions.UsersManage);
    }

    private static string[] ValidPermissions(string[]? requested) =>
        (requested ?? Array.Empty<string>()).Where(Permissions.IsValid).Distinct().ToArray();

    /// <summary>True if <paramref name="excludingUserId"/> is currently the only enabled user with users.manage.</summary>
    private static async Task<bool> IsLastAdmin(UsageDbContext db, int excludingUserId, CancellationToken ct)
    {
        var otherAdmins = await db.Users
            .Where(u => u.Id != excludingUserId && u.IsEnabled
                        && u.Permissions.Any(p => p.Permission == Permissions.UsersManage))
            .AnyAsync(ct);
        var targetIsAdmin = await db.Users
            .Where(u => u.Id == excludingUserId && u.IsEnabled
                        && u.Permissions.Any(p => p.Permission == Permissions.UsersManage))
            .AnyAsync(ct);
        return targetIsAdmin && !otherAdmins;
    }

    /// <summary>
    /// The email-visibility gate: true when the request carries the configured reveal key in the
    /// <c>X-Email-Reveal-Key</c> header, in which case real emails are returned. Otherwise OTHER users'
    /// emails are masked. Shared by GET /api/users and GET /api/audit so the same Users page can't leak
    /// emails through the audit log. The key travels only in this header (never a URL/query string) and
    /// is not logged (RequestLoggingMiddleware records method/path/status/query/duration, not headers).
    /// </summary>
    private static bool EmailsRevealed(HttpContext http, IConfiguration cfg)
    {
        var configured = cfg["Users:EmailRevealKey"];
        if (string.IsNullOrEmpty(configured)) return false; // no key configured ⇒ never reveal
        var provided = http.Request.Headers["X-Email-Reveal-Key"].ToString();
        // Constant-time compare so the key can't be recovered by timing the response.
        return System.Security.Cryptography.CryptographicOperations.FixedTimeEquals(
            System.Text.Encoding.UTF8.GetBytes(provided),
            System.Text.Encoding.UTF8.GetBytes(configured));
    }

    /// <summary>Case-insensitive email comparison (emails are stored lowercased; be defensive about nulls).</summary>
    private static bool SameEmail(string? a, string? b) =>
        a is not null && b is not null && string.Equals(a, b, StringComparison.OrdinalIgnoreCase);

    // Email-shaped substrings, masked out of free-text audit Detail when the reveal gate is closed — so an
    // address embedded in a detail string (e.g. a fleet label) can't leak past the actor/target masking.
    private static readonly System.Text.RegularExpressions.Regex EmailLike =
        new(@"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", System.Text.RegularExpressions.RegexOptions.Compiled);
    private static string? MaskEmailsInText(string? text) =>
        text is null ? null : EmailLike.Replace(text, "•••@•••");

    private static UserDto ToDto(AppUser u, bool maskEmail = false) => new()
    {
        Id = u.Id,
        Email = maskEmail ? null : u.Email,
        Name = u.Name,
        Picture = u.Picture,
        IsEnabled = u.IsEnabled,
        Permissions = u.Permissions.Select(p => p.Permission).OrderBy(p => p).ToArray(),
        CreatedUtc = u.CreatedUtc,
        LastLoginUtc = u.LastLoginUtc,
    };
}
