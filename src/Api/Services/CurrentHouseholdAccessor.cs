using Ccusage.Api.Auth;
using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Microsoft.EntityFrameworkCore;

namespace Ccusage.Api.Services;

/// <summary>
/// Resolves the caller's <see cref="Household"/> for the Family Hub. A user belongs to at most one
/// household for now. Auto-provisioning is the entry point: the first time a <c>family.use</c> caller
/// hits the hub we create a household named after them ("{display name}’s Family") with the caller as
/// the OWNER member, so the hub is never empty. Households are private to their members — this service
/// only ever resolves the CALLER's own household, never anyone else's.
/// </summary>
public sealed class CurrentHouseholdAccessor(UsageDbContext db)
{
    /// <summary>
    /// The household the caller belongs to, or null if they aren't a member of one yet. Read-only:
    /// never creates a household. The <see cref="Household.Members"/> are loaded.
    /// </summary>
    public async Task<Household?> GetForCallerAsync(CurrentUserAccessor.CurrentUser caller, CancellationToken ct = default)
    {
        var householdId = await db.HouseholdMembers.AsNoTracking()
            .Where(m => m.UserId == caller.Id)
            .Select(m => (int?)m.HouseholdId)
            .FirstOrDefaultAsync(ct);
        if (householdId is null) return null;

        return await db.Households.AsNoTracking()
            .Include(h => h.Members)
            .FirstOrDefaultAsync(h => h.Id == householdId.Value, ct);
    }

    /// <summary>
    /// The caller's household, auto-creating one if they hold <c>family.use</c> and aren't yet in any
    /// household. The new household is named "{caller display name}’s Family" with the caller as the
    /// OWNER member. Idempotent under a race: if a concurrent request created the membership first
    /// (tripping the UNIQUE index on HouseholdMember.UserId), we discard our attempt and return the
    /// existing one. Returns null only if the caller lacks <c>family.use</c> and has no household —
    /// callers are gated by the endpoint filter, so in practice this always returns a household.
    /// </summary>
    public async Task<Household?> GetOrCreateForCallerAsync(CurrentUserAccessor.CurrentUser caller, CancellationToken ct = default)
    {
        var existing = await GetForCallerAsync(caller, ct);
        if (existing is not null) return existing;

        if (!caller.Permissions.Contains(Permissions.FamilyUse)) return null;

        var now = DateTime.UtcNow;
        // Seed the household timezone from the app's display timezone so the Today view + briefing land on
        // the right local day out of the box (owner can change it later in family settings).
        var appTz = await db.AppConfigs.AsNoTracking()
            .Select(c => c.DisplayTimeZone)
            .FirstOrDefaultAsync(ct);
        var household = new Household
        {
            Name = $"{DisplayName(caller)}’s Family",
            CreatedByUserId = caller.Id,
            CreatedUtc = now,
            TimeZone = string.IsNullOrWhiteSpace(appTz) ? "America/New_York" : appTz,
            Members =
            {
                new HouseholdMember { UserId = caller.Id, Role = "owner", JoinedUtc = now },
            },
        };
        db.Households.Add(household);
        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException ex) when (IsUniqueViolation(ex))
        {
            // A concurrent first request already provisioned this caller's household — discard our
            // attempt and return theirs.
            db.ChangeTracker.Clear();
            return await GetForCallerAsync(caller, ct);
        }

        // Auto-bridge the owner into any existing adult members' contact circles. A freshly-provisioned
        // household has only the owner, so this is normally a no-op; it keeps the contact graph correct
        // for the owner-provision path symmetrically with member-add (idempotent, email-resolved).
        await ContactGraph.BridgeHouseholdAdultAsync(db, household.Id, caller.Id, "owner", caller.Email, ct);

        // Return a fresh, tracking-free read so callers see exactly the persisted shape.
        return await GetForCallerAsync(caller, ct);
    }

    private static string DisplayName(CurrentUserAccessor.CurrentUser caller) =>
        string.IsNullOrWhiteSpace(caller.Name) ? "My" : caller.Name.Trim();

    private static bool IsUniqueViolation(DbUpdateException ex) =>
        ex.InnerException is Npgsql.PostgresException pg && pg.SqlState == Npgsql.PostgresErrorCodes.UniqueViolation;
}
