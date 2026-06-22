namespace Ccusage.Api.Data.Entities;

/// <summary>
/// One row of the chore points/stars ledger — appended each time a <see cref="FamilyChore"/> is marked
/// done (never on re-marking an already-done chore). This is the durable history behind the per-member
/// points tally, and the foundation for kid rewards. It survives a recurring chore's reset, so resetting a
/// chore for the next period preserves the points already earned. People are referenced by AppUser id
/// only — an email is never stored here or put on the wire.
/// </summary>
public class FamilyChoreCompletion
{
    public long Id { get; set; }

    /// <summary>The chore that was completed (cascade-deletes with the chore).</summary>
    public long ChoreId { get; set; }
    public FamilyChore? Chore { get; set; }

    /// <summary>AppUser id of whoever completed it (identity is by id, never email).</summary>
    public int ByUserId { get; set; }

    /// <summary>When the completion was recorded (UTC).</summary>
    public DateTime AtUtc { get; set; }

    /// <summary>Stars earned by this completion (snapshotted from the chore's points at completion time).</summary>
    public int Points { get; set; }

    /// <summary>Money CREDITS awarded by this approved completion (snapshotted from the chore's
    /// <see cref="FamilyChore.CreditValue"/> at approval). Default 0. This is the chore-HISTORY snapshot;
    /// the per-child balance is summed from the <see cref="FamilyCreditEntry"/> ledger (the money-history),
    /// not from here — keeping the two avoids double-counting (one earn row per approval links back here).</summary>
    public decimal Credits { get; set; }
}
