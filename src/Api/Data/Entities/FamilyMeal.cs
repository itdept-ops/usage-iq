namespace Ccusage.Api.Data.Entities;

/// <summary>
/// One planned meal on a <see cref="Household"/>'s weekly meal plan — a dish slotted onto a local date
/// and a meal slot (breakfast/lunch/dinner/snack). Its optional <see cref="Ingredients"/> (one per line)
/// feed the "auto grocery list" tie-in: the chosen meals' ingredient lines are appended to a shopping
/// <see cref="FamilyList"/>. People are referenced by AppUser id only — an email is never stored here or
/// put on the wire.
/// </summary>
public class FamilyMeal
{
    public long Id { get; set; }

    /// <summary>The owning household — the meal is visible to all its members.</summary>
    public int HouseholdId { get; set; }

    /// <summary>The local date (in the household timezone) this meal is planned for.</summary>
    public DateOnly LocalDate { get; set; }

    /// <summary>Which meal of the day: "breakfast" | "lunch" | "dinner" | "snack" (default "dinner").</summary>
    public string Slot { get; set; } = "dinner";

    public string Title { get; set; } = "";

    /// <summary>Newline-separated ingredient lines (optional); the source for the grocery-list tie-in.</summary>
    public string Ingredients { get; set; } = "";

    /// <summary>AppUser id of whoever added the meal (identity is by id, never email).</summary>
    public int CreatedByUserId { get; set; }

    public DateTime CreatedUtc { get; set; }
}
