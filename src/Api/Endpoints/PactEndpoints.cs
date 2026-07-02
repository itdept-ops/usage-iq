using Ccusage.Api.Auth;
using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Ccusage.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Ccusage.Api.Endpoints;

/// <summary>
/// Habit pacts (<c>/api/pacts</c>) — shared accountability goals an owner creates and invites their MUTUAL
/// chat contacts to join, all gated by <see cref="Permissions.TrackerSelf"/> (no new permission). A pact tracks
/// counts of ALREADY-shareable <see cref="ActivityEvent"/> rows of one kind over a period.
///
/// PRIVACY / ANTI-SPAM (enforced server-side):
/// <list type="bullet">
///   <item>Membership is CONSTRAINED to the owner's MUTUAL chat contacts — the SAME directed-edge check the
///   feed circle uses (<see cref="ContactGraph.IsContactAsync"/>). An invite to a non-contact is rejected, so a
///   pact can never become an unsolicited-invite vector.</item>
///   <item>Members cross the wire as AppUser ids; the email is resolved server-side
///   (<see cref="ChatNotificationService.ResolveEmailsByIdAsync"/>) and NEVER serialized. Owners + members are
///   exposed as id + <see cref="DisplayName"/>-formatted name only (email-privacy).</item>
///   <item>Progress is a COUNT of matching <see cref="ActivityEvent"/> rows in the period — never a private
///   tracker amount or any health figure.</item>
/// </list>
/// </summary>
public static class PactEndpoints
{
    /// <summary>The pact owner / a member as seen on the wire: id + display name + status; never an email.</summary>
    public sealed record PactMemberDto(int UserId, string Name, string Status);

    /// <summary>A pact with its resolved owner + members. <paramref name="Mine"/> is whether the CALLER owns it.</summary>
    public sealed record PactDto(
        long Id, int OwnerUserId, string OwnerName, bool Mine, string Title, string Kind, int TargetIntValue,
        int PeriodDays, DateTime StartUtc, DateTime? EndUtc, DateTime CreatedUtc, bool Archived,
        IReadOnlyList<PactMemberDto> Members);

    /// <summary>One member's progress in a pact: id + display name + their matching-event count + whether they hit target.</summary>
    public sealed record PactProgressRowDto(int UserId, string Name, int Count, bool MetTarget);

    public sealed record CreatePactRequest(string? Title, string? Kind, int? TargetIntValue, int? PeriodDays, int[]? MemberUserIds);
    public sealed record UpdatePactRequest(string? Title, int? TargetIntValue, int? PeriodDays);
    public sealed record AddMembersRequest(int[]? MemberUserIds);

    private const int MaxTitle = 120;
    private const int MaxTarget = 100_000;
    private const int MaxPeriodDays = 366;

    public static void MapPactEndpoints(this WebApplication app)
    {
        var g = app.MapGroup("/api/pacts")
            .RequireAuthorization()
            .RequirePermission(Permissions.TrackerSelf);

        // ---- GET /api/pacts : the caller's pacts (owned OR a member of), newest-first ----
        g.MapGet("/", async (CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var callerEmail = caller.Email.ToLowerInvariant();

            // Pacts the caller owns, plus pacts where the caller is a (non-Left) member.
            var memberPactIds = db.HabitPactMembers.AsNoTracking()
                .Where(m => m.MemberEmail == callerEmail && m.Status != HabitPactMemberStatus.Left)
                .Select(m => m.HabitPactId);
            var pacts = await db.HabitPacts.AsNoTracking()
                .Where(p => p.OwnerEmail == callerEmail || memberPactIds.Contains(p.Id))
                .OrderByDescending(p => p.Id)
                .ToListAsync(ct);

            return Results.Ok(await ToDtosAsync(db, pacts, callerEmail, ct));
        });

        // ---- POST /api/pacts : create a pact (optionally inviting mutual contacts) ----
        g.MapPost("/", async (
            CreatePactRequest req, CurrentUserAccessor me, UsageDbContext db, ChatNotificationService notifier,
            CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var callerEmail = caller.Email.ToLowerInvariant();

            var title = (req?.Title ?? "").Trim();
            if (title.Length == 0) return Results.BadRequest(new { message = "A pact title is required." });
            if (title.Length > MaxTitle) title = title[..MaxTitle];

            var kind = (req?.Kind ?? "").Trim();
            if (!IsValidKind(kind)) return Results.BadRequest(new { message = "Unsupported pact kind." });

            var target = Math.Clamp(req?.TargetIntValue ?? 1, 1, MaxTarget);
            var periodDays = Math.Clamp(req?.PeriodDays ?? 7, 1, MaxPeriodDays);
            var now = DateTime.UtcNow;

            var pact = new HabitPact
            {
                OwnerEmail = callerEmail, Title = title, Kind = kind, TargetIntValue = target,
                PeriodDays = periodDays, StartUtc = now, EndUtc = now.AddDays(periodDays), CreatedUtc = now,
            };
            db.HabitPacts.Add(pact);
            await db.SaveChangesAsync(ct); // assigns pact.Id

            // The owner is an Active member from the start.
            db.HabitPactMembers.Add(new HabitPactMember
            {
                HabitPactId = pact.Id, MemberEmail = callerEmail, JoinedUtc = now,
                Status = HabitPactMemberStatus.Active,
            });
            await db.SaveChangesAsync(ct);

            // Invite any requested members — each MUST be a mutual contact of the owner (resolved server-side).
            if (req?.MemberUserIds is { Length: > 0 } ids)
                await InviteMembersAsync(db, notifier, pact, callerEmail, ids, ct);

            var fresh = await db.HabitPacts.AsNoTracking().FirstAsync(p => p.Id == pact.Id, ct);
            return Results.Ok((await ToDtosAsync(db, new[] { fresh }, callerEmail, ct))[0]);
        }).RequireRateLimiting("chat");

        // ---- PUT /api/pacts/{id} : edit a pact (OWNER only) ----
        g.MapPut("/{id:long}", async (
            long id, UpdatePactRequest req, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var callerEmail = caller.Email.ToLowerInvariant();

            var pact = await db.HabitPacts.FirstOrDefaultAsync(p => p.Id == id, ct);
            if (pact is null) return Results.NotFound();
            if (!string.Equals(pact.OwnerEmail, callerEmail, StringComparison.Ordinal))
                return Results.StatusCode(StatusCodes.Status403Forbidden);

            if (req?.Title is { } t)
            {
                var title = t.Trim();
                if (title.Length == 0) return Results.BadRequest(new { message = "A pact title is required." });
                pact.Title = title.Length > MaxTitle ? title[..MaxTitle] : title;
            }
            if (req?.TargetIntValue is { } tv) pact.TargetIntValue = Math.Clamp(tv, 1, MaxTarget);
            if (req?.PeriodDays is { } pd)
            {
                pact.PeriodDays = Math.Clamp(pd, 1, MaxPeriodDays);
                pact.EndUtc = pact.StartUtc.AddDays(pact.PeriodDays);
            }
            await db.SaveChangesAsync(ct);

            return Results.Ok((await ToDtosAsync(db, new[] { pact }, callerEmail, ct))[0]);
        });

        // ---- DELETE /api/pacts/{id} : archive a pact (OWNER only) ----
        g.MapDelete("/{id:long}", async (
            long id, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var callerEmail = caller.Email.ToLowerInvariant();

            var pact = await db.HabitPacts.FirstOrDefaultAsync(p => p.Id == id, ct);
            if (pact is null) return Results.NotFound();
            if (!string.Equals(pact.OwnerEmail, callerEmail, StringComparison.Ordinal))
                return Results.StatusCode(StatusCodes.Status403Forbidden);

            pact.ArchivedUtc = DateTime.UtcNow;
            await db.SaveChangesAsync(ct);
            return Results.NoContent();
        });

        // ---- POST /api/pacts/{id}/members : invite more mutual contacts (OWNER only) ----
        g.MapPost("/{id:long}/members", async (
            long id, AddMembersRequest req, CurrentUserAccessor me, UsageDbContext db,
            ChatNotificationService notifier, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var callerEmail = caller.Email.ToLowerInvariant();

            var pact = await db.HabitPacts.FirstOrDefaultAsync(p => p.Id == id, ct);
            if (pact is null) return Results.NotFound();
            if (!string.Equals(pact.OwnerEmail, callerEmail, StringComparison.Ordinal))
                return Results.StatusCode(StatusCodes.Status403Forbidden);

            var ids = req?.MemberUserIds ?? Array.Empty<int>();
            var invited = await InviteMembersAsync(db, notifier, pact, callerEmail, ids, ct);
            if (invited.rejectedNonContact)
                return Results.BadRequest(new { message = "You can only invite your mutual contacts to a pact." });

            return Results.Ok((await ToDtosAsync(db, new[] { pact }, callerEmail, ct))[0]);
        }).RequireRateLimiting("chat");

        // ---- POST /api/pacts/{id}/join : the caller accepts their invite ----
        g.MapPost("/{id:long}/join", async (
            long id, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var callerEmail = caller.Email.ToLowerInvariant();

            var member = await db.HabitPactMembers
                .FirstOrDefaultAsync(m => m.HabitPactId == id && m.MemberEmail == callerEmail, ct);
            if (member is null) return Results.NotFound(); // never invited ⇒ existence not revealed

            // Join only transitions a PENDING invite → Active. An already-Active member is idempotent (no-op
            // success). A member who Left (or declined) must NOT be able to silently re-activate — they need a
            // fresh owner invite. This keeps the Left status meaning "not a participant" airtight, so a future
            // owner-remove feature can safely reuse Left without this path letting the removed user re-add themselves.
            if (member.Status != HabitPactMemberStatus.Invited)
                return member.Status == HabitPactMemberStatus.Active
                    ? Results.NoContent()
                    : Results.Conflict(new { message = "This invite is no longer pending. Ask the pact owner to invite you again." });

            member.Status = HabitPactMemberStatus.Active;
            member.JoinedUtc = DateTime.UtcNow;
            await db.SaveChangesAsync(ct);
            return Results.NoContent();
        });

        // ---- POST /api/pacts/{id}/leave : the caller leaves a pact ----
        g.MapPost("/{id:long}/leave", async (
            long id, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var callerEmail = caller.Email.ToLowerInvariant();

            var member = await db.HabitPactMembers
                .FirstOrDefaultAsync(m => m.HabitPactId == id && m.MemberEmail == callerEmail, ct);
            if (member is null) return Results.NotFound();

            member.Status = HabitPactMemberStatus.Left;
            await db.SaveChangesAsync(ct);
            return Results.NoContent();
        });

        // ---- GET /api/pacts/{id}/progress : each member's matching-event count in the period ----
        g.MapGet("/{id:long}/progress", async (
            long id, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var callerEmail = caller.Email.ToLowerInvariant();

            var pact = await db.HabitPacts.AsNoTracking().FirstOrDefaultAsync(p => p.Id == id, ct);
            if (pact is null) return Results.NotFound();

            // Only an active participant (owner or an Active member) may read progress — 404 otherwise.
            // An invited-but-unjoined (or declined/left) member must not see other participants' counts.
            var isOwner = string.Equals(pact.OwnerEmail, callerEmail, StringComparison.Ordinal);
            var isMember = await db.HabitPactMembers.AsNoTracking()
                .AnyAsync(m => m.HabitPactId == id && m.MemberEmail == callerEmail
                               && m.Status == HabitPactMemberStatus.Active, ct);
            if (!isOwner && !isMember) return Results.NotFound();

            // Active participants (owner + Active members). The window is [StartUtc, EndUtc ?? +PeriodDays).
            var memberEmails = await db.HabitPactMembers.AsNoTracking()
                .Where(m => m.HabitPactId == id && m.Status == HabitPactMemberStatus.Active)
                .Select(m => m.MemberEmail)
                .ToListAsync(ct);
            var windowEnd = pact.EndUtc ?? pact.StartUtc.AddDays(pact.PeriodDays);

            // Count matching ActivityEvents per member in ONE grouped query (no N+1).
            var counts = (await db.ActivityEvents.AsNoTracking()
                .Where(e => e.Kind == pact.Kind && memberEmails.Contains(e.ActorEmail)
                            && e.CreatedUtc >= pact.StartUtc && e.CreatedUtc < windowEnd)
                .GroupBy(e => e.ActorEmail)
                .Select(grp => new { Email = grp.Key, Count = grp.Count() })
                .ToListAsync(ct))
                .ToDictionary(x => x.Email, x => x.Count, StringComparer.Ordinal);

            var actors = await ChatNotificationService.ResolveActorsAsync(db, memberEmails, ct);
            var rows = memberEmails.Select(email =>
            {
                var a = actors.GetValueOrDefault(email.ToLowerInvariant());
                var c = counts.GetValueOrDefault(email, 0);
                return new PactProgressRowDto(
                    a.Id, string.IsNullOrEmpty(a.Name) ? DisplayName.Unknown : a.Name, c, c >= pact.TargetIntValue);
            })
            .OrderByDescending(r => r.Count).ThenBy(r => r.Name)
            .ToList();
            return Results.Ok(rows);
        });
    }

    /// <summary>The pact kinds that map to a countable activity (a subset of <see cref="ActivityEmitter.Kinds"/>).</summary>
    private static bool IsValidKind(string kind) => kind is
        ActivityEmitter.Kinds.WorkoutLogged
        or ActivityEmitter.Kinds.ChallengeDayComplete
        or ActivityEmitter.Kinds.HydrationGoalHit
        or ActivityEmitter.Kinds.HabitDayComplete;

    /// <summary>
    /// Invite a set of AppUser ids to the pact as <see cref="HabitPactMemberStatus.Invited"/> members. Each id
    /// is resolved server-side to an email and MUST be a MUTUAL contact of the owner (the anti-spam constraint)
    /// — a non-contact is skipped and flagged. Self + existing members are skipped. Fires a PactInvite
    /// notification per newly-invited member. Returns whether any id was rejected for not being a contact.
    /// </summary>
    private static async Task<(bool rejectedNonContact, int invited)> InviteMembersAsync(
        UsageDbContext db, ChatNotificationService notifier, HabitPact pact, string ownerEmail, int[] memberUserIds,
        CancellationToken ct)
    {
        var ids = memberUserIds.Where(i => i > 0).Distinct().ToArray();
        if (ids.Length == 0) return (false, 0);

        var emailById = await ChatNotificationService.ResolveEmailsByIdAsync(db, ids, ct);
        var existing = (await db.HabitPactMembers.AsNoTracking()
            .Where(m => m.HabitPactId == pact.Id).Select(m => m.MemberEmail).ToListAsync(ct))
            .ToHashSet(StringComparer.Ordinal);

        var now = DateTime.UtcNow;
        var rejected = false;
        var toNotify = new List<string>();
        foreach (var (_, rawEmail) in emailById)
        {
            var email = rawEmail.ToLowerInvariant();
            if (string.Equals(email, ownerEmail, StringComparison.Ordinal)) continue; // never invite self
            if (existing.Contains(email)) continue;                                    // already in the pact

            // The ANTI-SPAM constraint: the invitee must be in the owner's MUTUAL contact circle.
            if (!await ContactGraph.IsContactAsync(db, ownerEmail, email, ct)) { rejected = true; continue; }

            db.HabitPactMembers.Add(new HabitPactMember
            {
                HabitPactId = pact.Id, MemberEmail = email, JoinedUtc = now,
                Status = HabitPactMemberStatus.Invited,
            });
            existing.Add(email);
            toNotify.Add(email);
        }

        if (toNotify.Count > 0)
        {
            await db.SaveChangesAsync(ct);
            foreach (var email in toNotify)
                await notifier.NotifyPactAsync(email, ownerEmail, pact.Title, ct);
        }
        return (rejected, toNotify.Count);
    }

    /// <summary>Map pacts to DTOs, resolving the owner + every member to id + DisplayName (never email) in
    /// batched queries.</summary>
    private static async Task<List<PactDto>> ToDtosAsync(
        UsageDbContext db, IReadOnlyList<HabitPact> pacts, string callerEmail, CancellationToken ct)
    {
        if (pacts.Count == 0) return new List<PactDto>();

        var pactIds = pacts.Select(p => p.Id).ToArray();
        var allMembers = await db.HabitPactMembers.AsNoTracking()
            .Where(m => pactIds.Contains(m.HabitPactId))
            .Select(m => new { m.HabitPactId, m.MemberEmail, m.Status })
            .ToListAsync(ct);

        var emails = pacts.Select(p => p.OwnerEmail)
            .Concat(allMembers.Select(m => m.MemberEmail))
            .ToArray();
        var actors = await ChatNotificationService.ResolveActorsAsync(db, emails, ct);

        string NameFor(string email)
        {
            var a = actors.GetValueOrDefault(email.ToLowerInvariant());
            return string.IsNullOrEmpty(a.Name) ? DisplayName.Unknown : a.Name;
        }
        int IdFor(string email) => actors.GetValueOrDefault(email.ToLowerInvariant()).Id;

        var membersByPact = allMembers
            .GroupBy(m => m.HabitPactId)
            .ToDictionary(grp => grp.Key, grp => grp
                .Select(m => new PactMemberDto(IdFor(m.MemberEmail), NameFor(m.MemberEmail), m.Status.ToString()))
                .ToList());

        return pacts.Select(p => new PactDto(
            p.Id, IdFor(p.OwnerEmail), NameFor(p.OwnerEmail),
            string.Equals(p.OwnerEmail, callerEmail, StringComparison.Ordinal),
            p.Title, p.Kind, p.TargetIntValue, p.PeriodDays, p.StartUtc, p.EndUtc, p.CreatedUtc,
            p.ArchivedUtc != null,
            membersByPact.GetValueOrDefault(p.Id, new List<PactMemberDto>())))
        .ToList();
    }
}
