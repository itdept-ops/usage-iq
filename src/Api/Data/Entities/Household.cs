namespace Ccusage.Api.Data.Entities;

/// <summary>
/// A family household — the private unit that owns Family Hub data. One is auto-provisioned for a
/// caller who holds <c>family.use</c> and isn't yet in a household, named after them (e.g.
/// "Alex’s Family") with the caller as the OWNER member. Family data is private to the household and
/// only selectively shareable to specific contacts later; members are exposed by AppUser id +
/// display name + picture only — never by email.
/// </summary>
public class Household
{
    public int Id { get; set; }

    /// <summary>The household's display name (e.g. "Alex’s Family"); editable by the owner.</summary>
    public string Name { get; set; } = "";

    /// <summary>AppUser id of whoever first created the household (its original owner).</summary>
    public int CreatedByUserId { get; set; }

    public DateTime CreatedUtc { get; set; }

    // ---- F3 settings: the "Today" view + the daily briefing (owner-editable) ----

    /// <summary>
    /// IANA timezone id (e.g. "America/New_York") the household lives in. All "today"/briefing-hour math
    /// is done in this zone; storage stays UTC. Defaults to the app's display timezone on creation.
    /// </summary>
    public string TimeZone { get; set; } = "America/New_York";

    /// <summary>Whether the daily morning briefing is delivered. Owner-editable; default on.</summary>
    public bool BriefingEnabled { get; set; } = true;

    /// <summary>Local hour-of-day (0–23) the briefing is composed and delivered. Default 7am.</summary>
    public int BriefingHourLocal { get; set; } = 7;

    /// <summary>
    /// OpenWeather location for the Today weather card, e.g. "Tampa,FL,US". Null/blank hides the card
    /// (the weather lookup also degrades to null when the API key is missing).
    /// </summary>
    public string? WeatherLocation { get; set; }

    /// <summary>
    /// The last household-local date a briefing was delivered. Guards "once per local day": a briefing
    /// only fires when this is not today-local. Null until the first briefing ever runs.
    /// </summary>
    public DateOnly? LastBriefingLocalDate { get; set; }

    /// <summary>
    /// Id of the household's private "Family" chat channel (ensured on first briefing). The briefing
    /// posts into it; null until the channel has been ensured.
    /// </summary>
    public int? FamilyChannelId { get; set; }

    public List<HouseholdMember> Members { get; set; } = new();
}
