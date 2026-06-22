using Ccusage.Api.Auth;
using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Ccusage.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Ccusage.Api.Endpoints;

/// <summary>
/// Family Hub foundation (/api/family): a caller's private household and its members. Everything here
/// is gated by <see cref="Permissions.FamilyUse"/> (DB-checked each request) on top of
/// <c>.RequireAuthorization()</c>. A household is auto-provisioned on first read with the caller as the
/// OWNER, so the hub is never empty.
///
/// PRIVACY (the core rules, enforced server-side):
/// <list type="bullet">
///   <item>A household is private to its members; an endpoint only ever resolves the CALLER's own
///   household — there is no way to address someone else's.</item>
///   <item>People are exposed by AppUser id + display name + picture ONLY. An email is NEVER put on the
///   wire (no entity here even stores one).</item>
///   <item>Mutations (rename, add/remove member) are OWNER-ONLY — a non-owner member gets 403.</item>
/// </list>
/// Member identity is by AppUser id; the candidate/member name+picture is resolved via a Users join.
/// </summary>
public static class FamilyEndpoints
{
    /// <summary>A household member as seen by the family (id + display identity + role; never email).</summary>
    public sealed record MemberDto(int UserId, string Name, string? Picture, string Role, bool IsSelf);

    /// <summary>The caller's household with its resolved members.</summary>
    public sealed record HouseholdDto(int Id, string Name, IReadOnlyList<MemberDto> Members);

    /// <summary>A person the owner may add to the household (id + display identity; never email).</summary>
    public sealed record CandidateDto(int UserId, string Name, string? Picture);

    public sealed record RenameRequest(string? Name);

    /// <summary>Add a member. <see cref="Role"/> is optional: "adult" (default) for a full member, or "child"
    /// for a kid (a chore.claim holder). "owner" is never accepted here (the owner is the household creator).</summary>
    public sealed record AddMemberRequest(int UserId, string? Role);

    public static void MapFamilyEndpoints(this WebApplication app)
    {
        var g = app.MapGroup("/api/family")
            .RequireAuthorization()
            .RequirePermission(Permissions.FamilyUse);

        // ---- The caller's household (auto-provisioned on first read) ----
        g.MapGet("/household", async (
            CurrentUserAccessor me, CurrentHouseholdAccessor households, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!; // family.use filter guarantees non-null
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!; // family.use ⇒ always provisioned
            return Results.Ok(await ToDtoAsync(db, household, caller.Id, ct));
        });

        // ---- Rename the household (OWNER only) ----
        g.MapPatch("/household", async (
            RenameRequest req, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;
            if (!await IsOwnerAsync(db, household.Id, caller.Id, ct))
                return Forbidden("Only the household owner can rename the family.");

            var name = req.Name?.Trim();
            if (string.IsNullOrEmpty(name))
                return Results.BadRequest(new { message = "A family name is required." });
            if (name.Length > 120) name = name[..120];

            await db.Households.Where(h => h.Id == household.Id)
                .ExecuteUpdateAsync(s => s.SetProperty(h => h.Name, name), ct);

            var fresh = (await households.GetForCallerAsync(caller, ct))!;
            return Results.Ok(await ToDtoAsync(db, fresh, caller.Id, ct));
        });

        // ---- People the owner may add (caller's contacts / family.use users not yet in a household) ----
        g.MapGet("/household/candidates", async (
            CurrentUserAccessor me, CurrentHouseholdAccessor households, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;

            // Owner-only — the candidate picker is the "add a member" surface, which is itself owner-only. A
            // non-owner member (e.g. a child holding family.use) must never see the contacts/add-candidate list.
            if (!await IsOwnerAsync(db, household.Id, caller.Id, ct))
                return Forbidden("Only the household owner can add members.");

            return Results.Ok(await CandidatesForAsync(db, caller.Id, caller.Email, ct));
        });

        // ---- Add a member (OWNER only) ----
        g.MapPost("/household/members", async (
            AddMemberRequest req, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;
            if (!await IsOwnerAsync(db, household.Id, caller.Id, ct))
                return Forbidden("Only the household owner can add members.");

            // The requested role: "adult" (default, a full member) or "child" (a kid). "owner" is never
            // accepted here — the owner is the household creator. An unknown value is rejected.
            var role = (req.Role ?? "adult").Trim().ToLowerInvariant();
            if (role is not ("adult" or "child"))
                return Results.BadRequest(new { message = "Role must be adult or child." });

            // The target must exist AND be enabled AND hold the right Family Hub access for their role:
            // a full member needs family.use; a child needs chore.claim (their kid capability). The "child"
            // preset grants both, so a child also has family.use, but we accept a chore.claim holder explicitly
            // so the gate matches the role.
            var target = await db.Users.AsNoTracking()
                .Where(u => u.Id == req.UserId)
                .Select(u => new { u.Id, u.IsEnabled, Perms = u.Permissions.Select(p => p.Permission) })
                .FirstOrDefaultAsync(ct);
            if (target is null || !target.IsEnabled)
                return Results.NotFound(new { message = "That person doesn't exist or is disabled." });

            var perms = target.Perms.ToHashSet(StringComparer.Ordinal);
            var hasAccess = role == "child"
                ? perms.Contains(Permissions.ChoreClaim)   // a kid is admitted by their chore.claim capability
                : perms.Contains(Permissions.FamilyUse);   // a full member needs Family Hub access
            if (!hasAccess)
                return Results.BadRequest(new { message = role == "child"
                    ? "That child doesn't have chore access yet (apply the Child preset on the Users page)."
                    : "That person doesn't have Family Hub access yet." });

            // One household per user — reject anyone already in a household (including this one).
            if (await db.HouseholdMembers.AsNoTracking().AnyAsync(m => m.UserId == req.UserId, ct))
                return Results.BadRequest(new { message = "That person already belongs to a household." });

            db.HouseholdMembers.Add(new HouseholdMember
            {
                HouseholdId = household.Id, UserId = req.UserId, Role = role, JoinedUtc = DateTime.UtcNow,
            });
            try
            {
                await db.SaveChangesAsync(ct);
            }
            catch (DbUpdateException ex) when (IsUniqueViolation(ex))
            {
                // A concurrent add slipped the same person in first — treat as already-a-member.
                db.ChangeTracker.Clear();
                return Results.BadRequest(new { message = "That person already belongs to a household." });
            }

            var fresh = (await households.GetForCallerAsync(caller, ct))!;
            return Results.Ok(await ToDtoAsync(db, fresh, caller.Id, ct));
        });

        // ---- Remove a member (OWNER only; never the owner) ----
        g.MapDelete("/household/members/{userId:int}", async (
            int userId, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;
            if (!await IsOwnerAsync(db, household.Id, caller.Id, ct))
                return Forbidden("Only the household owner can remove members.");

            var member = await db.HouseholdMembers
                .FirstOrDefaultAsync(m => m.HouseholdId == household.Id && m.UserId == userId, ct);
            if (member is not null)
            {
                if (member.Role == "owner")
                    return Forbidden("The household owner can't be removed.");
                db.HouseholdMembers.Remove(member);
                await db.SaveChangesAsync(ct);
            }
            // Removing someone not in the household is a harmless no-op (returns the unchanged list).

            var fresh = (await households.GetForCallerAsync(caller, ct))!;
            return Results.Ok(await ToDtoAsync(db, fresh, caller.Id, ct));
        });
    }

    /// <summary>Resolve a household + its members to display identity (id/name/picture via a Users join).
    /// No email is ever read into the DTO (email-privacy).</summary>
    private static async Task<HouseholdDto> ToDtoAsync(
        UsageDbContext db, Household household, int callerId, CancellationToken ct)
    {
        // The member rows carry only userId + role; join to Users for the display identity.
        var rows = await db.HouseholdMembers.AsNoTracking()
            .Where(m => m.HouseholdId == household.Id)
            .Join(db.Users.AsNoTracking(), m => m.UserId, u => u.Id, (m, u) => new
            {
                u.Id, u.Name, u.Picture, m.Role,
            })
            // Owner first, then by display name.
            .OrderBy(x => x.Role == "owner" ? 0 : 1)
            .ThenBy(x => x.Name == "" ? "" : x.Name)
            .ToListAsync(ct);

        var members = rows.Select(x => new MemberDto(
            x.Id,
            string.IsNullOrEmpty(x.Name) ? "Unknown user" : x.Name,
            x.Picture,
            x.Role,
            x.Id == callerId)).ToList();

        return new HouseholdDto(household.Id, household.Name, members);
    }

    /// <summary>
    /// People the owner may add: the caller's mutual chat contacts AND any enabled user who holds
    /// <c>family.use</c>, minus anyone already in a household (and the caller). Resolved to id +
    /// display identity (never email), name-sorted.
    /// </summary>
    private static async Task<List<CandidateDto>> CandidatesForAsync(
        UsageDbContext db, int callerId, string callerEmail, CancellationToken ct)
    {
        // Emails of the caller's mutual chat contacts (lower-cased on write).
        var contactEmails = db.ChatContacts.AsNoTracking()
            .Where(c => c.OwnerEmail == callerEmail)
            .Select(c => c.ContactEmail);

        // User ids already in SOME household — excluded from candidates.
        var takenUserIds = db.HouseholdMembers.AsNoTracking().Select(m => m.UserId);

        var people = await db.Users.AsNoTracking()
            .Where(u => u.IsEnabled
                && u.Id != callerId
                && !takenUserIds.Contains(u.Id)
                // Either a family.use holder OR one of the caller's contacts (they still need
                // family.use to actually be added, but the picker shows the caller's circle too).
                && (u.Permissions.Any(p => p.Permission == Permissions.FamilyUse)
                    || contactEmails.Contains(u.Email)))
            .OrderBy(u => u.Name)
            .Select(u => new CandidateDto(
                u.Id,
                string.IsNullOrEmpty(u.Name) ? "Unknown user" : u.Name,
                u.Picture))
            .ToListAsync(ct);

        return people;
    }

    private static async Task<bool> IsOwnerAsync(UsageDbContext db, int householdId, int userId, CancellationToken ct) =>
        await db.HouseholdMembers.AsNoTracking()
            .AnyAsync(m => m.HouseholdId == householdId && m.UserId == userId && m.Role == "owner", ct);

    private static IResult Forbidden(string message) =>
        Results.Json(new { message }, statusCode: StatusCodes.Status403Forbidden);

    private static bool IsUniqueViolation(DbUpdateException ex) =>
        ex.InnerException is Npgsql.PostgresException pg && pg.SqlState == Npgsql.PostgresErrorCodes.UniqueViolation;
}
