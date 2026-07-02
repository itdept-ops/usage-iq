using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Ccusage.Api.Dtos;
using Ccusage.Api.Endpoints;
using Ccusage.Api.Hubs;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;

namespace Ccusage.Api.Services;

/// <summary>
/// The single code path for the temporary LIVE location share scoped to one chat conversation. Both the REST
/// endpoints and (if ever needed) the hub go through here so start/update/extend/stop behave identically.
///
/// A share targets a <see cref="ChatChannel"/> (a named channel or a DM — both are channels). The broadcasts go
/// to that channel's SignalR group (<see cref="ChatNotificationService.GroupFor"/>), which every member's
/// connection joins — so only participants of YOUR conversation ever receive the pin. The wire DTO carries the
/// sharer's AppUser id + display name, NEVER their email (email-privacy).
///
/// Scoped (depends on the scoped <see cref="UsageDbContext"/>); the hub would resolve it via a per-invocation
/// scope, mirroring <see cref="ChatNotificationService"/>.
/// </summary>
public sealed class ChatLocationShareService(UsageDbContext db, IHubContext<ChatHub> hub)
{
    /// <summary>The default live-share window when the caller doesn't specify one.</summary>
    public const int DefaultDurationMinutes = 15;

    /// <summary>Upper bound on a single window / extension step (8 hours) — a runaway value can't pin forever.</summary>
    public const int MaxDurationMinutes = 8 * 60;

    /// <summary>An active share may never be pushed past this far in the future (start + 24h) — even repeated
    /// extends can't make a "temporary" share effectively permanent.</summary>
    public const int MaxLifetimeMinutes = 24 * 60;

    /// <summary>True when a share is live right now: not stopped and not yet expired.</summary>
    public static bool IsActive(ChatLocationShare s, DateTime now) => !s.Stopped && now < s.ExpiresUtc;

    public static int ClampDuration(int? minutes) =>
        Math.Clamp(minutes is { } m && m > 0 ? m : DefaultDurationMinutes, 1, MaxDurationMinutes);

    private static double ClampLat(double lat) => double.IsNaN(lat) ? 0 : Math.Clamp(lat, -90, 90);
    private static double ClampLng(double lng) => double.IsNaN(lng) ? 0 : Math.Clamp(lng, -180, 180);
    private static double? ClampAccuracy(double? a) => a is double v && v >= 0 && !double.IsNaN(v) ? v : null;

    /// <summary>
    /// Start a share for the caller in a conversation they belong to. Caller membership + permissions are the
    /// endpoint's job; here we persist and broadcast <c>locationShareStarted</c> to the channel group.
    /// </summary>
    public async Task<ChatLocationShareDto> StartAsync(
        int channelId, string sharerEmail, StartLocationShareRequest req, CancellationToken ct = default)
    {
        var now = DateTime.UtcNow;
        // Archiving a channel deliberately closes it (send/hub both reject writes) — never begin a live share
        // there. Report an inactive (stopped) share, the same ended state update/extend surface, instead of
        // persisting or broadcasting a pin into a closed conversation.
        if (await IsChannelArchivedAsync(channelId, ct))
            return ToDto(
                new ChatLocationShare
                {
                    ChannelId = channelId,
                    SharerEmail = sharerEmail,
                    StartUtc = now,
                    ExpiresUtc = now,
                    LastUpdateUtc = now,
                    Stopped = true,
                    Lat = ClampLat(req.Lat),
                    Lng = ClampLng(req.Lng),
                    AccuracyM = ClampAccuracy(req.AccuracyM),
                },
                await ChatEndpoints.SenderLookupAsync(db, new[] { sharerEmail }, ct),
                now);
        // Single active share per (channel, sharer): refresh an existing live one in place rather than
        // stacking a second row (the composer hides the trigger when you have one, but guard the API too).
        var share = await db.ChatLocationShares.FirstOrDefaultAsync(
            s => s.ChannelId == channelId && s.SharerEmail == sharerEmail && !s.Stopped && s.ExpiresUtc > now, ct);
        if (share is null)
        {
            share = new ChatLocationShare { ChannelId = channelId, SharerEmail = sharerEmail };
            db.ChatLocationShares.Add(share);
        }
        share.StartUtc = now;
        share.ExpiresUtc = now.AddMinutes(ClampDuration(req.DurationMinutes));
        share.Lat = ClampLat(req.Lat);
        share.Lng = ClampLng(req.Lng);
        share.AccuracyM = ClampAccuracy(req.AccuracyM);
        share.LastUpdateUtc = now;
        share.Stopped = false;
        await db.SaveChangesAsync(ct);

        var dto = await ToDtoAsync(share, now, ct);
        await Broadcast(channelId, "locationShareStarted", dto, ct);
        return dto;
    }

    /// <summary>
    /// Push the sharer's latest position on an active share they own. Returns null if the share doesn't exist,
    /// isn't owned by the caller, or is no longer active (stopped/expired) — the endpoint maps that to 404/409.
    /// Broadcasts <c>locationShareUpdated</c> on success.
    /// </summary>
    public async Task<ChatLocationShareDto?> UpdatePositionAsync(
        int shareId, string sharerEmail, UpdateLocationShareRequest req, CancellationToken ct = default)
    {
        var share = await db.ChatLocationShares.FirstOrDefaultAsync(s => s.Id == shareId, ct);
        if (share is null || !OwnedBy(share, sharerEmail)) return null;

        var now = DateTime.UtcNow;
        if (!IsActive(share, now)) return null;
        // An archive shuts the conversation down (send/hub both refuse it) — treat it as inactive so a live
        // pin can't keep updating into a channel a moderator has since closed.
        if (await IsChannelArchivedAsync(share.ChannelId, ct)) return null;

        share.Lat = ClampLat(req.Lat);
        share.Lng = ClampLng(req.Lng);
        share.AccuracyM = ClampAccuracy(req.AccuracyM);
        share.LastUpdateUtc = now;
        await db.SaveChangesAsync(ct);

        var dto = await ToDtoAsync(share, now, ct);
        await Broadcast(share.ChannelId, "locationShareUpdated", dto, ct);
        return dto;
    }

    /// <summary>
    /// Extend an active share the caller owns by N minutes (clamped), never past the overall max lifetime.
    /// Returns null if absent / not owned / not active. Broadcasts <c>locationShareExtended</c> on success.
    /// </summary>
    public async Task<ChatLocationShareDto?> ExtendAsync(
        int shareId, string sharerEmail, int addMinutes, CancellationToken ct = default)
    {
        var share = await db.ChatLocationShares.FirstOrDefaultAsync(s => s.Id == shareId, ct);
        if (share is null || !OwnedBy(share, sharerEmail)) return null;

        var now = DateTime.UtcNow;
        if (!IsActive(share, now)) return null;
        // Same archived-channel guard as update/send: extending the window of a share into a closed
        // conversation would keep the live feed alive past the moderator's archive.
        if (await IsChannelArchivedAsync(share.ChannelId, ct)) return null;

        var add = Math.Clamp(addMinutes, 1, MaxDurationMinutes);
        // Push from the CURRENT expiry (extending stacks), but never beyond start + the overall lifetime cap.
        var ceiling = share.StartUtc.AddMinutes(MaxLifetimeMinutes);
        var extended = share.ExpiresUtc.AddMinutes(add);
        share.ExpiresUtc = extended > ceiling ? ceiling : extended;
        await db.SaveChangesAsync(ct);

        var dto = await ToDtoAsync(share, now, ct);
        await Broadcast(share.ChannelId, "locationShareExtended", dto, ct);
        return dto;
    }

    /// <summary>
    /// Stop a share the caller owns (idempotent: stopping an already-stopped/expired share still reports the
    /// ended state). Returns null only if the share is absent or not owned by the caller. Broadcasts
    /// <c>locationShareStopped</c>.
    /// </summary>
    public async Task<ChatLocationShareDto?> StopAsync(int shareId, string sharerEmail, CancellationToken ct = default)
    {
        var share = await db.ChatLocationShares.FirstOrDefaultAsync(s => s.Id == shareId, ct);
        if (share is null || !OwnedBy(share, sharerEmail)) return null;

        if (!share.Stopped)
        {
            share.Stopped = true;
            await db.SaveChangesAsync(ct);
        }

        var dto = await ToDtoAsync(share, DateTime.UtcNow, ct);
        await Broadcast(share.ChannelId, "locationShareStopped", dto, ct);
        return dto;
    }

    /// <summary>
    /// The currently-ACTIVE shares for a conversation (server-filtered: not stopped, not yet expired), so a
    /// late-joiner sees an in-progress share. Membership is the caller's; this read assumes it's verified.
    /// </summary>
    public async Task<List<ChatLocationShareDto>> GetActiveAsync(int channelId, CancellationToken ct = default)
    {
        var now = DateTime.UtcNow;
        var rows = await db.ChatLocationShares.AsNoTracking()
            .Where(s => s.ChannelId == channelId && !s.Stopped && s.ExpiresUtc > now)
            .OrderByDescending(s => s.StartUtc)
            .ToListAsync(ct);
        if (rows.Count == 0) return new();

        var names = await ChatEndpoints.SenderLookupAsync(db, rows.Select(r => r.SharerEmail), ct);
        return rows.Select(r => ToDto(r, names, now)).ToList();
    }

    private static bool OwnedBy(ChatLocationShare s, string email) =>
        string.Equals(s.SharerEmail, email, StringComparison.Ordinal);

    /// <summary>
    /// True when the share's owning channel has been archived. An archive deliberately shuts a conversation
    /// down — message-send (<see cref="ChatEndpoints"/>) and the hub (<see cref="ChatHub"/>) both refuse to
    /// write to it, so the whole live-share lifecycle (start/update/extend) must treat an archived channel as
    /// inactive too, or a live GPS feed would keep broadcasting into a closed conversation.
    /// </summary>
    private async Task<bool> IsChannelArchivedAsync(int channelId, CancellationToken ct) =>
        await db.ChatChannels.AsNoTracking()
            .AnyAsync(c => c.Id == channelId && c.ArchivedUtc != null, ct);

    private async Task Broadcast(int channelId, string evt, ChatLocationShareDto dto, CancellationToken ct) =>
        await hub.Clients.Group(ChatNotificationService.GroupFor(channelId)).SendAsync(evt, dto, ct);

    private async Task<ChatLocationShareDto> ToDtoAsync(ChatLocationShare s, DateTime now, CancellationToken ct)
    {
        var names = await ChatEndpoints.SenderLookupAsync(db, new[] { s.SharerEmail }, ct);
        return ToDto(s, names, now);
    }

    /// <summary>Map to the wire DTO. The sharer is exposed as id+name — the raw email NEVER reaches the client.</summary>
    private static ChatLocationShareDto ToDto(
        ChatLocationShare s, IReadOnlyDictionary<string, ChatNotificationService.SenderIdentity> names, DateTime now)
    {
        var who = names.TryGetValue(s.SharerEmail, out var id) ? id : new ChatNotificationService.SenderIdentity(0, "Unknown user", null);
        return new ChatLocationShareDto
        {
            Id = s.Id,
            ChannelId = s.ChannelId,
            SharerUserId = who.Id,
            SharerName = string.IsNullOrEmpty(who.Name) ? "Unknown user" : who.Name,
            Lat = s.Lat,
            Lng = s.Lng,
            AccuracyM = s.AccuracyM,
            StartUtc = s.StartUtc,
            ExpiresUtc = s.ExpiresUtc,
            LastUpdateUtc = s.LastUpdateUtc,
            Stopped = s.Stopped,
            Active = IsActive(s, now),
        };
    }
}
