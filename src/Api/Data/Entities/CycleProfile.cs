namespace Ccusage.Api.Data.Entities;

/// <summary>
/// One per user: the cycle tracker's per-owner settings. PRIVATE health data — a row exists only because the
/// owner (who holds <c>cycle.track</c>) tracks; nobody else ever reads it. The two averages are sane defaults
/// the deterministic predictor falls back to when there isn't enough logged history to derive a cycle length;
/// both are clamped at the endpoint. <see cref="OverlayToFamily"/> is the per-user OPT-IN (default false) that
/// lets the owner overlay ONLY PREDICTED period/fertile day-spans (never raw logged entries) onto the in-app
/// family calendar — mirrors <see cref="AppUser.LocationShareHousehold"/> / <see cref="AppUser.CalendarShareHousehold"/>.
/// This tracker is NON-MEDICAL and informational; it never diagnoses or advises.
/// </summary>
public class CycleProfile
{
    public int Id { get; set; }

    /// <summary>The owner, stored lower-cased (the identity key; UNIQUE — one profile per user).</summary>
    public string UserEmail { get; set; } = "";

    /// <summary>The owner's AppUser id, kept alongside the email for identity joins (overlay returns userId+name).</summary>
    public int UserId { get; set; }

    /// <summary>Average cycle length in days; default 28, clamped to [15, 60] at the endpoint. The fallback the
    /// predictor uses when there aren't enough logged starts to derive an average from real gaps.</summary>
    public int AvgCycleLengthDays { get; set; } = 28;

    /// <summary>Average period length in days; default 5, clamped to [1, 14] at the endpoint.</summary>
    public int AvgPeriodLengthDays { get; set; } = 5;

    /// <summary>Per-user OPT-IN to overlay ONLY PREDICTED period/fertile day-spans (a soft phase layer) onto the
    /// household's in-app family calendar. False by default — sharing is an explicit, separate choice from
    /// tracking. Raw logged entries are NEVER shared, only the deterministic predictions.</summary>
    public bool OverlayToFamily { get; set; }
}
