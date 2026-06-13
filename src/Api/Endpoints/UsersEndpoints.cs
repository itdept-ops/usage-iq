using Ccusage.Api.Auth;
using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Ccusage.Api.Dtos;
using Microsoft.EntityFrameworkCore;

namespace Ccusage.Api.Endpoints;

public static class UsersEndpoints
{
    public static void MapUsersEndpoints(this WebApplication app)
    {
        // The permission catalog (for the admin UI).
        app.MapGet("/api/permissions", () => Results.Ok(Permissions.Catalog
                .Select(p => new PermissionItemDto { Key = p.Key, Label = p.Label, Description = p.Description })))
            .RequireAuthorization().RequirePermission(Permissions.UsersManage);

        var users = app.MapGroup("/api/users")
            .RequireAuthorization()
            .RequirePermission(Permissions.UsersManage);

        users.MapGet("/", async (UsageDbContext db, CancellationToken ct) =>
            Results.Ok((await db.Users.AsNoTracking().Include(u => u.Permissions)
                .OrderBy(u => u.Email).ToListAsync(ct)).Select(ToDto)));

        users.MapPost("/", async (UserUpsertRequest req, UsageDbContext db, CancellationToken ct) =>
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
            return Results.Created($"/api/users/{user.Id}", ToDto(user));
        });

        users.MapPut("/{id:int}", async (int id, UserUpsertRequest req, UsageDbContext db, CancellationToken ct) =>
        {
            // Serializable so the last-admin check and the write can't be raced by a concurrent edit.
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
            return Results.Ok(ToDto(user));
        });

        users.MapDelete("/{id:int}", async (int id, UsageDbContext db, CancellationToken ct) =>
        {
            await using var tx = await db.Database.BeginTransactionAsync(System.Data.IsolationLevel.Serializable, ct);

            var user = await db.Users.Include(u => u.Permissions).FirstOrDefaultAsync(u => u.Id == id, ct);
            if (user is null) return Results.NotFound();
            if (await IsLastAdmin(db, user.Id, ct))
                return Results.BadRequest(new { message = "You can't delete the last administrator." });

            db.Users.Remove(user);
            await db.SaveChangesAsync(ct);
            await tx.CommitAsync(ct);
            return Results.NoContent();
        });
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
