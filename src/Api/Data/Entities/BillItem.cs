namespace Ccusage.Api.Data.Entities;

/// <summary>
/// One line item on a <see cref="Bill"/>. It can be PRE-ASSIGNED by the owner to a contact
/// (<see cref="AssignedToUserId"/>, a mutual ChatContact), or CLAIMED via the public share link by a
/// logged-out person under a display name (<see cref="ClaimedByName"/>) or by a logged-in claimer
/// (<see cref="ClaimedByUserId"/>). An item is "open" while it has no assignee and no claimer.
/// </summary>
public class BillItem
{
    public int Id { get; set; }

    public int BillId { get; set; }
    public Bill? Bill { get; set; }

    public string Name { get; set; } = "";
    public decimal Amount { get; set; }

    /// <summary>Owner pre-assignment: the AppUser id of a contact in the owner's mutual chat circle.</summary>
    public int? AssignedToUserId { get; set; }

    /// <summary>A public (logged-out) claimer's display name.</summary>
    public string? ClaimedByName { get; set; }

    /// <summary>A logged-in claimer's AppUser id (when the claimer was authenticated).</summary>
    public int? ClaimedByUserId { get; set; }

    public DateTime? ClaimedUtc { get; set; }

    /// <summary>Whether the owner has marked this item paid/settled.</summary>
    public bool Settled { get; set; }
}
