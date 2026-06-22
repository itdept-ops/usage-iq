namespace Ccusage.Api.Data.Entities;

/// <summary>
/// A household chore on a <see cref="Household"/>'s shared board — optionally assigned to a member, worth
/// some <see cref="Points"/> (stars), and optionally recurring (daily/weekly) so it reappears each period.
/// Marking it done stamps who/when and appends a <see cref="FamilyChoreCompletion"/> to the points ledger
/// (the foundation for kid rewards). The background tick resets a recurring done chore when its period
/// rolls over. People are referenced by AppUser id only — an email is never stored here or put on the wire.
/// </summary>
public class FamilyChore
{
    public long Id { get; set; }

    /// <summary>The owning household — the chore is visible to all its members.</summary>
    public int HouseholdId { get; set; }

    public string Title { get; set; } = "";

    /// <summary>AppUser id of the member the chore is assigned to; null when unassigned (anyone can do it).</summary>
    public int? AssignedToUserId { get; set; }

    /// <summary>Checked off for the current period?</summary>
    public bool Done { get; set; }

    /// <summary>AppUser id of whoever last marked it done; null when not done.</summary>
    public int? DoneByUserId { get; set; }

    /// <summary>When it was last marked done (UTC); null when not done.</summary>
    public DateTime? DoneUtc { get; set; }

    /// <summary>Stars earned each time it's completed (default 1).</summary>
    public int Points { get; set; } = 1;

    /// <summary>How the chore repeats: "none" | "daily" | "weekly".</summary>
    public string Recurrence { get; set; } = "none";

    // ---- Marketplace + allowance (the claim/approve lifecycle + monetary credits) ----

    /// <summary>Money CREDITS awarded to the child on parent APPROVAL (cash given IRL). Default 0. Distinct
    /// from <see cref="Points"/> (the existing stars strip): Points are the display tally, CreditValue is the
    /// allowance amount that lands in the child's ledger.</summary>
    public decimal CreditValue { get; set; }

    /// <summary>Where the chore comes from: "assigned" (parent-assigned to a specific member, the existing
    /// behaviour) | "pool" (the marketplace — anyone-claimable by a child). Default "assigned".</summary>
    public string Source { get; set; } = "assigned";

    /// <summary>The claim/approval state machine, distinct from the recurring <see cref="Done"/> flag:
    /// "open" (claimable / not yet submitted) | "claimed" (a child grabbed a pool chore) |
    /// "submitted" (a child marked it done, awaiting a parent) | "approved" (a parent approved + credits
    /// awarded) | "rejected" (a parent sent it back). Default "open".</summary>
    public string Status { get; set; } = "open";

    /// <summary>AppUser id of the child who CLAIMED a pool chore; null when unclaimed.</summary>
    public int? ClaimedByUserId { get; set; }

    /// <summary>When the chore was claimed (UTC); null when unclaimed.</summary>
    public DateTime? ClaimedUtc { get; set; }

    /// <summary>AppUser id of the parent who APPROVED the chore; null until approved.</summary>
    public int? ApprovedByUserId { get; set; }

    /// <summary>When the chore was approved (UTC); null until approved.</summary>
    public DateTime? ApprovedUtc { get; set; }

    /// <summary>AppUser id of whoever created the chore (identity is by id, never email).</summary>
    public int CreatedByUserId { get; set; }

    public DateTime CreatedUtc { get; set; }
}
