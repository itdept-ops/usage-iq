using Ccusage.Api.Auth;
using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Ccusage.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Ccusage.Api.Endpoints;

/// <summary>
/// The social ACTIVITY FEED (<c>/api/feed</c>) — the read side of the activity spine. DISTINCT from the admin
/// audit page at <c>/activity</c> (<c>GET /api/logs</c>, <c>activity.view</c>): that is the RequestLog trail;
/// this is the circle-scoped social feed.
///
/// PRIVACY (enforced here):
/// <list type="bullet">
///   <item>VIEW gate: reuses <see cref="Permissions.TrackerSelf"/> (no new permission) — the only events come
///   from tracker/75-Hard actions, all gated by tracker.self, and the sharing circle is the same contacts
///   graph the tracker uses.</item>
///   <item>AUDIENCE: an event is visible only when the actor is the CALLER, OR the actor is in the caller's
///   contact circle AND that actor is sharing (<c>ShareActivity</c>). The caller always sees their OWN events.
///   A secondary per-user <c>ViewActivityFeed</c> opt-in: when OFF, the feed returns ONLY the caller's own
///   events (circle events are withheld until they opt in to viewing).</item>
///   <item>WIRE SHAPE: rows carry an AppUser id + a <see cref="DisplayName"/>-formatted name — NEVER the actor
///   email (email-privacy) — and only the non-sensitive int/label payload the emitter stored.</item>
/// </list>
/// Keyset paging mirrors <c>/api/logs</c>/<c>/api/ai-usage</c> (<c>?before=&amp;limit=</c>, newest-first).
/// </summary>
public static class FeedEndpoints
{
    /// <summary>One feed row. The actor is an AppUser id + display name — NEVER an email. <paramref name="ClapCount"/>
    /// is the total cheers (👏) on the row; <paramref name="IReacted"/> is whether the CALLER cheered it (drives the
    /// toggle button) — no reactor identity beyond the count is ever exposed.</summary>
    public sealed record FeedItemDto(
        long Id, int ActorUserId, string ActorName, string Kind, int? IntValue, string? Label, DateTime CreatedUtc,
        int ClapCount, bool IReacted);

    /// <summary>The toggle result for <c>POST /api/feed/{id}/react</c>: the row's fresh cheer count and whether the
    /// caller now has a cheer on it (true after an add, false after a remove). Lets the SPA converge after races.</summary>
    public sealed record ReactResultDto(int ClapCount, bool IReacted);

    /// <summary>A page of feed items + the keyset cursor for the next page (null when no more).</summary>
    public sealed record FeedPageDto(IReadOnlyList<FeedItemDto> Items, long? NextBefore);

    public static void MapFeedEndpoints(this WebApplication app)
    {
        var g = app.MapGroup("/api/feed")
            .RequireAuthorization()
            .RequirePermission(Permissions.TrackerSelf);

        // ---- GET /api/feed : the caller's circle activity feed (newest-first, keyset paged) ----
        g.MapGet("/", async (
            long? before, int? limit, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var callerEmail = caller.Email.ToLowerInvariant();
            var take = Math.Clamp(limit ?? 50, 1, 100);

            // The caller's contact circle: actors who have the caller in their circle (row Owner=actor,
            // Contact=caller — mirrors ContactGraph.SharingEmails minus the tracker-sharing join, since the
            // feed gates on the ACTIVITY share flag, not the tracker one).
            var circleEmails = db.ChatContacts.AsNoTracking()
                .Where(c => c.ContactEmail == callerEmail)
                .Select(c => c.OwnerEmail);

            // Circle events are only included when (a) the actor opted to SHARE activity AND (b) the caller
            // opted to VIEW the feed. Otherwise the feed is the caller's OWN events only (still circle-correct:
            // a user always sees themselves).
            var sharingCircle = db.Users.AsNoTracking()
                .Where(u => u.IsEnabled && u.ShareActivity && u.Email != callerEmail
                            && circleEmails.Contains(u.Email))
                .Select(u => u.Email);

            var query = db.ActivityEvents.AsNoTracking();
            query = caller.ViewActivityFeed
                ? query.Where(e => e.ActorEmail == callerEmail || sharingCircle.Contains(e.ActorEmail))
                : query.Where(e => e.ActorEmail == callerEmail);

            if (before is { } b) query = query.Where(e => e.Id < b);

            var rows = await query
                .OrderByDescending(e => e.Id)
                .Take(take)
                .Select(e => new { e.Id, e.ActorEmail, e.Kind, e.IntValue, e.Label, e.CreatedUtc })
                .ToListAsync(ct);

            // Resolve every distinct actor email -> AppUser id + DisplayName-formatted name in ONE query
            // (email-privacy: the raw actor email NEVER reaches the client).
            var actors = await ChatNotificationService.ResolveActorsAsync(
                db, rows.Select(r => r.ActorEmail).ToArray(), ct);

            // Batch-load the cheer aggregates for this page of events in TWO grouped queries (no N+1): the
            // total count per event, and the set of events the CALLER has cheered (for iReacted). Reactor
            // identities are NEVER exposed — only the count + the caller's own flag cross the wire.
            var eventIds = rows.Select(r => r.Id).ToArray();
            var clapCounts = eventIds.Length == 0
                ? new Dictionary<long, int>()
                : (await db.ActivityReactions.AsNoTracking()
                    .Where(r => eventIds.Contains(r.ActivityEventId))
                    .GroupBy(r => r.ActivityEventId)
                    .Select(g => new { EventId = g.Key, Count = g.Count() })
                    .ToListAsync(ct))
                    .ToDictionary(x => x.EventId, x => x.Count);
            var myReactions = eventIds.Length == 0
                ? new HashSet<long>()
                : (await db.ActivityReactions.AsNoTracking()
                    .Where(r => r.ReactorEmail == callerEmail && eventIds.Contains(r.ActivityEventId))
                    .Select(r => r.ActivityEventId)
                    .ToListAsync(ct))
                    .ToHashSet();

            var items = rows.Select(r =>
            {
                var actor = actors.GetValueOrDefault(r.ActorEmail.ToLowerInvariant());
                return new FeedItemDto(
                    r.Id,
                    actor.Id,
                    string.IsNullOrEmpty(actor.Name) ? DisplayName.Unknown : actor.Name,
                    r.Kind, r.IntValue, r.Label, r.CreatedUtc,
                    clapCounts.GetValueOrDefault(r.Id, 0),
                    myReactions.Contains(r.Id));
            }).ToList();

            // Keyset cursor: a full page implies there may be more (oldest id on this page).
            long? nextBefore = items.Count == take ? items[^1].Id : null;
            return Results.Ok(new FeedPageDto(items, nextBefore));
        });

        // ---- POST /api/feed/{id}/react : toggle the caller's cheer (👏) on a feed event ----
        // Add if absent (→ iReacted:true), remove if present (→ iReacted:false). Returns the fresh count so
        // the SPA converges after races. Gated by the SAME visibility check the feed read uses: the caller
        // may only cheer an event they can SEE (own, or a sharing contact's when they've opted to view) — a
        // 404 otherwise NEVER reveals the event exists. Rate-limited like the chat react endpoint.
        g.MapPost("/{id:long}/react", async (
            long id, CurrentUserAccessor me, UsageDbContext db, ChatNotificationService notifier,
            CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var callerEmail = caller.Email.ToLowerInvariant();

            var ev = await db.ActivityEvents.AsNoTracking()
                .Where(e => e.Id == id)
                .Select(e => new { e.Id, e.ActorEmail, e.Kind })
                .FirstOrDefaultAsync(ct);
            if (ev is null) return Results.NotFound();

            // The SAME circle/visibility check as GET /api/feed: own event always visible; a circle actor's
            // event only when the actor shares AND the caller opted to view. 404 (not 403) if not visible —
            // never reveal that an out-of-circle event exists.
            var isOwn = string.Equals(ev.ActorEmail, callerEmail, StringComparison.Ordinal);
            if (!isOwn)
            {
                if (!caller.ViewActivityFeed) return Results.NotFound();
                var inCircle = await db.ChatContacts.AsNoTracking()
                    .Where(c => c.ContactEmail == callerEmail && c.OwnerEmail == ev.ActorEmail)
                    .AnyAsync(ct);
                var actorShares = inCircle && await db.Users.AsNoTracking()
                    .AnyAsync(u => u.Email == ev.ActorEmail && u.IsEnabled && u.ShareActivity, ct);
                if (!actorShares) return Results.NotFound();
            }

            // Toggle the (reactor, event) row, recovering from a concurrent racer's win on either side
            // (mirrors ToggleReactionAsync): on remove, a concurrent delete leaves the desired end state; on
            // add, a concurrent add already satisfies it (Postgres 23505).
            var existing = await db.ActivityReactions
                .FirstOrDefaultAsync(r => r.ReactorEmail == callerEmail && r.ActivityEventId == id, ct);
            bool reacted;
            if (existing is not null)
            {
                db.ActivityReactions.Remove(existing);
                try { await db.SaveChangesAsync(ct); }
                catch (DbUpdateConcurrencyException) { db.ChangeTracker.Clear(); }
                reacted = false;
            }
            else
            {
                db.ActivityReactions.Add(new ActivityReaction
                {
                    ReactorEmail = callerEmail, ActivityEventId = id, CreatedUtc = DateTime.UtcNow,
                });
                try { await db.SaveChangesAsync(ct); }
                catch (DbUpdateException ex) when (ChatEndpoints.IsUniqueViolation(ex)) { db.ChangeTracker.Clear(); }
                reacted = true;

                // ONE in-app notification to the actor on a FRESH cheer of SOMEONE ELSE's event. Never on a
                // self-cheer (own event) and never on a toggle-OFF (the remove branch). DisplayName only.
                if (!isOwn)
                    await notifier.NotifyCheerAsync(ev.ActorEmail, callerEmail, ThingFor(ev.Kind), ct);
            }

            var clapCount = await db.ActivityReactions.AsNoTracking()
                .CountAsync(r => r.ActivityEventId == id, ct);
            return Results.Ok(new ReactResultDto(clapCount, reacted));
        }).RequireRateLimiting("chat");
    }

    /// <summary>The human noun the cheer notification reads as ("cheered your <thing>"), per event kind —
    /// non-sensitive labels only, matching the feed's verb vocabulary. Forward-compatible default.</summary>
    private static string ThingFor(string kind) => kind switch
    {
        "workout.logged" => "workout",
        "challenge.dayComplete" => "75-Hard day",
        "challenge.started" => "75-Hard start",
        "hydration.goalHit" => "water goal",
        _ => "activity",
    };
}
