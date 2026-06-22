namespace Ccusage.Api.Data.Entities;

/// <summary>
/// One row of a child's ALLOWANCE ledger — the money-history behind the derived per-child balance. The
/// balance for a child is simply SUM(<see cref="Amount"/>) over their rows: an "earn" (+) is auto-created
/// when a parent approves a chore (linked to the approving <see cref="FamilyChoreCompletion"/>); a "spend"
/// (−) records a purchase against the balance; a "payout" (−) records cash the parent handed over IRL and
/// debits the in-app balance; an "adjust" (±) is a manual parent correction (bonus/penalty).
///
/// People are referenced by AppUser id only — an email is NEVER stored here or put on the wire. This is the
/// single source of truth for the balance (the FamilyChoreCompletion.Credits snapshot is chore-history only,
/// not summed for money — so credits can never be double-counted).
/// </summary>
public class FamilyCreditEntry
{
    public long Id { get; set; }

    /// <summary>The owning household — the ledger is private to its members.</summary>
    public int HouseholdId { get; set; }

    /// <summary>AppUser id of the CHILD the entry belongs to (identity is by id, never email).</summary>
    public int ChildUserId { get; set; }

    /// <summary>The kind of movement: "earn" | "spend" | "payout" | "adjust".</summary>
    public string Kind { get; set; } = "earn";

    /// <summary>Signed credits: POSITIVE for earn/adjust+, NEGATIVE for spend/payout (and adjust−). The
    /// balance is SUM(Amount) over the child's rows.</summary>
    public decimal Amount { get; set; }

    /// <summary>Spend category for a "spend" row (e.g. toys/games/books); null for earn/payout/adjust.</summary>
    public string? Category { get; set; }

    /// <summary>Links an "earn" row to the <see cref="FamilyChoreCompletion"/> it came from; null otherwise.
    /// FK is ON DELETE SET NULL so deleting a chore (which cascade-deletes its completions) preserves the
    /// money-history row (the balance is unaffected — the earn already happened).</summary>
    public long? ChoreCompletionId { get; set; }

    /// <summary>Optional free-text note (e.g. the purchase description or a payout memo).</summary>
    public string? Note { get; set; }

    /// <summary>AppUser id of whoever recorded the row: the PARENT for spend/payout/adjust; the CHILD (the
    /// claimant) for an auto-created earn. Identity is by id, never email.</summary>
    public int CreatedByUserId { get; set; }

    public DateTime CreatedUtc { get; set; }
}
