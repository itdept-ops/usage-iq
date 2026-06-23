using Ccusage.Api.Auth;
using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Microsoft.EntityFrameworkCore;

namespace Ccusage.Api.Services;

/// <summary>
/// The single source of truth for the chat "contact circle" graph (<see cref="ChatContact"/>): the
/// "is X my contact?" predicate, the caller's mutual sharing-users list query, and the mutual-edge
/// write. Contacts are MUTUAL — adding A→B writes both directions — so "owner→contact exists" is a
/// sufficient + correct membership test for either direction. Every email is compared/stored
/// lower-cased; a self-contact is never written.
///
/// This consolidates copies that were previously inlined across Bills, Family notes/lists, the tracker
/// visibility gate, the tracker "shared" list, and the 75 Hard leaderboard. It is BEHAVIOR-PRESERVING:
/// the queries are the same shape those sites used.
/// </summary>
public static class ContactGraph
{
    /// <summary>
    /// Whether <paramref name="contactEmail"/> is in <paramref name="ownerEmail"/>'s mutual contact
    /// circle. Because contacts are written in both directions, the directed row
    /// (Owner=owner, Contact=contact) existing is sufficient. Emails are lower-cased before the check.
    /// </summary>
    public static async Task<bool> IsContactAsync(
        UsageDbContext db, string ownerEmail, string contactEmail, CancellationToken ct = default)
    {
        var owner = (ownerEmail ?? "").Trim().ToLowerInvariant();
        var contact = (contactEmail ?? "").Trim().ToLowerInvariant();
        if (owner.Length == 0 || contact.Length == 0 || owner == contact) return false;

        return await db.ChatContacts.AsNoTracking()
            .AnyAsync(c => c.OwnerEmail == owner && c.ContactEmail == contact, ct);
    }

    /// <summary>
    /// The emails of the caller's mutual contacts whose tracker is shared-with-contacts — i.e. the
    /// sharing users whose tracker/75-Hard data the caller may read. The caller being in X's circle is
    /// the row (Owner=X, Contact=caller). Returned as an <see cref="IQueryable{T}"/> of email so a call
    /// site can compose further (e.g. <c>.Contains(u.Email)</c>) without materialising.
    /// </summary>
    public static IQueryable<string> SharingEmails(UsageDbContext db, string callerEmail)
    {
        var caller = (callerEmail ?? "").Trim().ToLowerInvariant();
        return db.ChatContacts.AsNoTracking()
            .Where(c => c.ContactEmail == caller)
            .Join(db.TrackerProfiles.AsNoTracking().Where(p => p.ShareWithContacts),
                c => c.OwnerEmail, p => p.UserEmail, (c, p) => p.UserEmail);
    }

    /// <summary>
    /// The caller's mutual sharing-users as <see cref="AppUser"/> identities: every enabled user (other
    /// than the caller) who shares their tracker with their contacts AND has the caller in their circle.
    /// This is the exact shape the tracker "/shared" list and the 75 Hard leaderboard need.
    /// </summary>
    public static IQueryable<AppUser> SharingUsers(UsageDbContext db, string callerEmail)
    {
        var caller = (callerEmail ?? "").Trim().ToLowerInvariant();
        var sharingEmails = SharingEmails(db, caller);
        return db.Users.AsNoTracking()
            .Where(u => u.IsEnabled && u.Email != caller && sharingEmails.Contains(u.Email));
    }

    /// <summary>
    /// Write both directions of a contact pair if missing. Idempotent: an existing pair is left as-is,
    /// and a concurrent insert that trips the unique index is swallowed (the pair already exists). A
    /// self-pair (same email) is a no-op. Emails are lower-cased before the write. This is the shared
    /// mutual-write used by the admin contacts editor AND the household→contacts auto-bridge.
    /// </summary>
    public static async Task EnsureMutualAsync(
        UsageDbContext db, string ownerEmail, string contactEmail, string actorEmail, CancellationToken ct = default)
    {
        var owner = (ownerEmail ?? "").Trim().ToLowerInvariant();
        var contact = (contactEmail ?? "").Trim().ToLowerInvariant();
        if (owner.Length == 0 || contact.Length == 0 || owner == contact) return;

        var present = await db.ChatContacts.AsNoTracking()
            .Where(c => (c.OwnerEmail == owner && c.ContactEmail == contact)
                     || (c.OwnerEmail == contact && c.ContactEmail == owner))
            .Select(c => new { c.OwnerEmail, c.ContactEmail })
            .ToListAsync(ct);
        var has = present.ToHashSet();

        var now = DateTime.UtcNow;
        if (!has.Contains(new { OwnerEmail = owner, ContactEmail = contact }))
            db.ChatContacts.Add(new ChatContact
            {
                OwnerEmail = owner, ContactEmail = contact, CreatedUtc = now, AddedByEmail = actorEmail,
            });
        if (!has.Contains(new { OwnerEmail = contact, ContactEmail = owner }))
            db.ChatContacts.Add(new ChatContact
            {
                OwnerEmail = contact, ContactEmail = owner, CreatedUtc = now, AddedByEmail = actorEmail,
            });

        if (db.ChangeTracker.HasChanges())
        {
            try
            {
                await db.SaveChangesAsync(ct);
            }
            catch (DbUpdateException ex) when (TrackerVisibility.IsUniqueViolation(ex))
            {
                // A concurrent caller added the same pair between our read and save — the desired
                // state already exists, so treat it as a successful no-op.
                db.ChangeTracker.Clear();
            }
        }
    }

    /// <summary>
    /// Auto-bridge a newly-joined ADULT household member into the contact circles of the other ADULT
    /// members (owner + adults). Children are SKIPPED on BOTH sides — they may lack <c>chat.read</c>, so
    /// a contact edge to/from a child would be useless and could surface a child in an adult's picker.
    /// Writes MUTUAL edges (via <see cref="EnsureMutualAsync"/>, so it's idempotent: no duplicate rows if
    /// the edge already exists). When the new member is themselves a child, this is a no-op.
    ///
    /// Identity is resolved server-side: the member rows carry only userId, which is joined to AppUser to
    /// get the internal email. No email is ever returned or logged beyond what <see cref="ChatContact"/>
    /// already stores. Only call this on member-ADD / owner-provision — never on a read path.
    /// </summary>
    public static async Task BridgeHouseholdAdultAsync(
        UsageDbContext db, int householdId, int newMemberUserId, string newMemberRole,
        string actorEmail, CancellationToken ct = default)
    {
        // Children never get a contact edge (they may lack chat.read).
        if (string.Equals(newMemberRole, "child", StringComparison.OrdinalIgnoreCase)) return;

        // The new member's email (resolved from their AppUser id).
        var newEmail = await db.Users.AsNoTracking()
            .Where(u => u.Id == newMemberUserId)
            .Select(u => u.Email)
            .FirstOrDefaultAsync(ct);
        if (string.IsNullOrWhiteSpace(newEmail)) return;

        // Every OTHER adult/owner member of this household, resolved to their email.
        var otherAdultEmails = await db.HouseholdMembers.AsNoTracking()
            .Where(m => m.HouseholdId == householdId
                     && m.UserId != newMemberUserId
                     && (m.Role == "owner" || m.Role == "adult"))
            .Join(db.Users.AsNoTracking(), m => m.UserId, u => u.Id, (m, u) => u.Email)
            .ToListAsync(ct);

        foreach (var otherEmail in otherAdultEmails)
            await EnsureMutualAsync(db, newEmail, otherEmail, actorEmail, ct);
    }
}
