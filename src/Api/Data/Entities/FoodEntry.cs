namespace Ccusage.Api.Data.Entities;

/// <summary>
/// One logged food item on a user's local date. Nutrition is SNAPSHOTTED at log time (calories +
/// macros are copied onto the row and never re-fetched from USDA later), so edits to the upstream
/// food database can't retroactively change a historical day. Keyed for reads by (UserEmail, LocalDate).
/// </summary>
public class FoodEntry
{
    public long Id { get; set; }

    /// <summary>Owner email, stored lower-cased.</summary>
    public string UserEmail { get; set; } = "";

    /// <summary>The day this food was logged on, in the app's display timezone.</summary>
    public DateOnly LocalDate { get; set; }

    public MealType Meal { get; set; }

    /// <summary>USDA FoodData Central id this entry came from, if any (manual entries have none).</summary>
    public int? FdcId { get; set; }

    public string Description { get; set; } = "";
    public string? Brand { get; set; }

    /// <summary>Number of servings logged; the snapshotted nutrition already reflects this quantity.</summary>
    public double Quantity { get; set; }

    /// <summary>Human-readable serving description (e.g. "1 cup (240 g)").</summary>
    public string? ServingDesc { get; set; }

    public int Calories { get; set; }
    public double ProteinG { get; set; }
    public double CarbG { get; set; }
    public double FatG { get; set; }

    public DateTime CreatedUtc { get; set; }
}
