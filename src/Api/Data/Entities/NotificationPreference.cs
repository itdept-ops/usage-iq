namespace Ccusage.Api.Data.Entities;

/// <summary>
/// Per-user delivery preferences for in-app notifications. One row per user (unique by email);
/// a defaults row is created on first read if none exists.
/// </summary>
public class NotificationPreference
{
    public int Id { get; set; }

    /// <summary>Owner email, unique and stored lower-cased.</summary>
    public string UserEmail { get; set; } = "";

    public bool NotifyDirectMessages { get; set; } = true;

    public bool NotifyMentions { get; set; } = true;

    public bool NotifyChannelMessages { get; set; } = false;

    public bool NotifySystemEvents { get; set; } = true;

    /// <summary>Surface notifications as in-app toasts.</summary>
    public bool SurfaceToasts { get; set; } = true;

    /// <summary>Surface notifications as native browser notifications.</summary>
    public bool SurfaceBrowser { get; set; } = false;

    public DateTime UpdatedUtc { get; set; }
}
