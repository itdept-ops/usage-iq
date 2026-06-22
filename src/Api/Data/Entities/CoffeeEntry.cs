namespace Ccusage.Api.Data.Entities;

/// <summary>
/// One coffee (caffeine) log on a user's local date. Like <see cref="HydrationEntry"/>, multiple rows per
/// (user, local date) are expected — a person drinks several coffees a day — so there is NO unique
/// constraint, just a read index on (UserEmail, LocalDate). Intake is counted in CUPS (1..20); the optional
/// caffeine estimate is in milligrams. Coffee totals/entries are part of the tracker DAY (like
/// food/exercise/hydration): a permitted viewer sees them read-only.
/// </summary>
public class CoffeeEntry
{
    public long Id { get; set; }

    /// <summary>Owner email, stored lower-cased.</summary>
    public string UserEmail { get; set; } = "";

    /// <summary>The day this coffee was logged on, in the app's display timezone.</summary>
    public DateOnly LocalDate { get; set; }

    /// <summary>Number of cups (1..20, server-clamped).</summary>
    public int Cups { get; set; }

    /// <summary>Optional caffeine estimate in milligrams.</summary>
    public int? CaffeineMg { get; set; }

    /// <summary>Optional drink label (e.g. "Espresso", "Cold Brew"); trimmed, &lt;= 64 chars.</summary>
    public string? Label { get; set; }

    public DateTime CreatedUtc { get; set; }
}
