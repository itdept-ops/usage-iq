using Ccusage.Api.Auth;
using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Ccusage.Api.Dtos;
using Ccusage.Api.Services;
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

        // Recent audit entries (who changed what).
        app.MapGet("/api/audit", async (UsageDbContext db, CancellationToken ct) =>
                Results.Ok(await db.AuditEntries.AsNoTracking()
                    .OrderByDescending(a => a.WhenUtc).Take(200)
                    .Select(a => new AuditEntryDto
                    {
                        Id = a.Id, WhenUtc = a.WhenUtc, ActorEmail = a.ActorEmail,
                        Action = a.Action, TargetEmail = a.TargetEmail, Detail = a.Detail,
                    }).ToListAsync(ct)))
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

        users.MapGet("/", async (UsageDbContext db, CancellationToken ct) =>
            Results.Ok((await db.Users.AsNoTracking().Include(u => u.Permissions)
                .OrderBy(u => u.Email).ToListAsync(ct)).Select(ToDto)))
            .RequireAnyPermission(Permissions.UsersView, Permissions.UsersManage);

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

    private static UserDto ToDto(AppUser u) => new()
    {
        Id = u.Id,
        Email = u.Email,
        Name = u.Name,
        Picture = u.Picture,
        IsEnabled = u.IsEnabled,
        Permissions = u.Permissions.Select(p => p.Permission).OrderBy(p => p).ToArray(),
        CreatedUtc = u.CreatedUtc,
        LastLoginUtc = u.LastLoginUtc,
    };
}
