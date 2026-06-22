namespace Ccusage.Api.Data.Entities;

/// <summary>
/// What a supplement row's <see cref="SupplementEntry.Kind"/> is. Stored as an int (the enum order is the
/// contract — do NOT reorder). Most supplements (vitamins/creatine/medications) carry 0 macros; protein
/// powders carry real calories + protein, so the macros live on the row regardless of kind.
/// </summary>
public enum SupplementKind
{
    Supplement = 0,
    Vitamin = 1,
    Protein = 2,
    Medication = 3,
    PreWorkout = 4,
    Other = 5,
}

/// <summary>
/// One supplement / vitamin / protein-powder / medication / pre-workout log on a user's local date. Like
/// <see cref="HydrationEntry"/> and <see cref="CoffeeEntry"/>, multiple rows per (user, local date) are
/// expected — a person takes several supplements a day — so there is NO unique constraint, just a read index
/// on (UserEmail, LocalDate). Supplement macros are part of the tracker DAY (like food): they SUM into the
/// day's calorie/macro roll-up AND show as a labelled supplement subtotal + list. A permitted viewer sees
/// them read-only (the same gate as the rest of the day). Prescription/medication NAMES are health-adjacent
/// — they stay in the owner's tracker day, shared only via the tracker-sharing the user already controls.
/// </summary>
public class SupplementEntry
{
    public long Id { get; set; }

    /// <summary>Owner email, stored lower-cased.</summary>
    public string UserEmail { get; set; } = "";

    /// <summary>The day this supplement was logged on, in the app's display timezone.</summary>
    public DateOnly LocalDate { get; set; }

    /// <summary>Supplement name (e.g. "Whey protein", "Vitamin D", "Creatine"); trimmed, &lt;= 120 chars.</summary>
    public string Name { get; set; } = "";

    /// <summary>Optional free-text dose (e.g. "1 scoop", "5 g", "1 tablet"); trimmed, &lt;= 60 chars.</summary>
    public string? Dose { get; set; }

    /// <summary>What kind of supplement this is (int-stored; default <see cref="SupplementKind.Supplement"/>).</summary>
    public SupplementKind Kind { get; set; } = SupplementKind.Supplement;

    /// <summary>Calories this supplement contributes to the day (0 for most; real for protein powders).</summary>
    public int Calories { get; set; }

    /// <summary>Protein grams this supplement contributes to the day.</summary>
    public decimal ProteinG { get; set; }

    /// <summary>Carb grams this supplement contributes to the day.</summary>
    public decimal CarbG { get; set; }

    /// <summary>Fat grams this supplement contributes to the day.</summary>
    public decimal FatG { get; set; }

    public DateTime CreatedUtc { get; set; }
}
