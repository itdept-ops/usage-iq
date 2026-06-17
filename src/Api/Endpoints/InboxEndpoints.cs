using Ccusage.Api.Auth;
using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Ccusage.Api.Dtos;
using Ccusage.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Ccusage.Api.Endpoints;

/// <summary>
/// The per-user in-app notification inbox and delivery preferences. Distinct from the Discord-config
/// group at <c>/api/notifications</c> — this lives at <c>/api/inbox</c>. Every operation is scoped to
/// the caller's own rows (by lower-cased email); a user can never read or mutate another's inbox. All
/// gated by chat.read (the same page-view gate as chat).
/// </summary>
public static class InboxEndpoints
{
    public static void MapInboxEndpoints(this WebApplication app)
    {
        var g = app.MapGroup("/api/inbox").RequireAuthorization().RequirePermission(Permissions.ChatRead);

        // ---- List my notifications (newest-first; optionally unread only) ----
        g.MapGet("/", async (bool? unreadOnly, int? limit, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var user = (await me.GetUserAsync(ct))!;
            var take = Math.Clamp(limit ?? 50, 1, 100);

            var q = db.Notifications.AsNoTracking().Where(n => n.RecipientEmail == user.Email);
            if (unreadOnly == true) q = q.Where(n => !n.IsRead);

            var rows = await q.OrderByDescending(n => n.Id).Take(take).ToListAsync(ct);
            return Results.Ok(rows.Select(ToDto));
        });

        // ---- Unread count ----
        g.MapGet("/unread-count", async (CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var user = (await me.GetUserAsync(ct))!;
            var count = await db.Notifications.CountAsync(n => n.RecipientEmail == user.Email && !n.IsRead, ct);
            return Results.Ok(new { count });
        });

        // ---- Mark specific notifications read (only the caller's own) ----
        g.MapPost("/read", async (MarkNotificationsReadRequest req, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var user = (await me.GetUserAsync(ct))!;
            var ids = (req.Ids ?? Array.Empty<long>()).Distinct().ToArray();
            if (ids.Length > 0)
                await db.Notifications
                    .Where(n => n.RecipientEmail == user.Email && !n.IsRead && ids.Contains(n.Id))
                    .ExecuteUpdateAsync(s => s.SetProperty(n => n.IsRead, true), ct);

            var unread = await db.Notifications.CountAsync(n => n.RecipientEmail == user.Email && !n.IsRead, ct);
            return Results.Ok(new { unreadCount = unread });
        });

        // ---- Mark all read ----
        g.MapPost("/read-all", async (CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var user = (await me.GetUserAsync(ct))!;
            await db.Notifications
                .Where(n => n.RecipientEmail == user.Email && !n.IsRead)
                .ExecuteUpdateAsync(s => s.SetProperty(n => n.IsRead, true), ct);
            return Results.Ok(new { unreadCount = 0 });
        });

        // ---- Read delivery preferences (create a defaults row on first read) ----
        g.MapGet("/preferences", async (CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var user = (await me.GetUserAsync(ct))!;
            var pref = await db.NotificationPreferences.FirstOrDefaultAsync(p => p.UserEmail == user.Email, ct);
            if (pref is null)
            {
                pref = new NotificationPreference { UserEmail = user.Email, UpdatedUtc = DateTime.UtcNow };
                db.NotificationPreferences.Add(pref);
                await db.SaveChangesAsync(ct);
            }
            return Results.Ok(ToDto(pref));
        });

        // ---- Update delivery preferences ----
        g.MapPut("/preferences", async (NotificationPreferenceDto req, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var user = (await me.GetUserAsync(ct))!;
            var pref = await db.NotificationPreferences.FirstOrDefaultAsync(p => p.UserEmail == user.Email, ct);
            if (pref is null)
            {
                pref = new NotificationPreference { UserEmail = user.Email };
                db.NotificationPreferences.Add(pref);
            }
            pref.NotifyDirectMessages = req.NotifyDirectMessages;
            pref.NotifyMentions = req.NotifyMentions;
            pref.NotifyChannelMessages = req.NotifyChannelMessages;
            pref.NotifySystemEvents = req.NotifySystemEvents;
            pref.SurfaceToasts = req.SurfaceToasts;
            pref.SurfaceBrowser = req.SurfaceBrowser;
            pref.UpdatedUtc = DateTime.UtcNow;
            await db.SaveChangesAsync(ct);
            return Results.Ok(ToDto(pref));
        });
    }

    private static NotificationDto ToDto(Notification n) => new()
    {
        Id = n.Id,
        Type = ChatNotificationService.NotificationTypeName(n.Type),
        Text = n.Text,
        Link = n.Link,
        ActorEmail = n.ActorEmail,
        ActorName = n.ActorName,
        IsRead = n.IsRead,
        CreatedUtc = n.CreatedUtc,
    };

    private static NotificationPreferenceDto ToDto(NotificationPreference p) => new()
    {
        NotifyDirectMessages = p.NotifyDirectMessages,
        NotifyMentions = p.NotifyMentions,
        NotifyChannelMessages = p.NotifyChannelMessages,
        NotifySystemEvents = p.NotifySystemEvents,
        SurfaceToasts = p.SurfaceToasts,
        SurfaceBrowser = p.SurfaceBrowser,
    };
}
