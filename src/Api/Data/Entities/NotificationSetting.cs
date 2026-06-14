namespace Ccusage.Api.Data.Entities;

/// <summary>Singleton (Id = 1) holding the Discord-notification configuration.</summary>
public class NotificationSetting
{
    public int Id { get; set; }

    /// <summary>Discord incoming-webhook URL (https://discord.com/api/webhooks/…). Secret.</summary>
    public string? DiscordWebhookUrl { get; set; }

    public bool Enabled { get; set; }

    /// <summary>Local-time hour (0–23) at which the daily/weekly digests are sent.</summary>
    public int DigestHourLocal { get; set; } = 9;

    public bool DailyDigest { get; set; }

    public bool WeeklyDigest { get; set; }

    /// <summary>Day of week the weekly digest is sent (0 = Sunday … 6 = Saturday).</summary>
    public int WeeklyDay { get; set; } = 1;

    public bool ThresholdEnabled { get; set; }

    /// <summary>Alert once a day when the running daily spend reaches this many USD.</summary>
    public decimal ThresholdUsd { get; set; }

    // "Already sent" guards (local dates) so the per-minute scheduler never double-sends.
    public DateOnly? LastDailySent { get; set; }
    public DateOnly? LastWeeklySent { get; set; }
    public DateOnly? LastThresholdSent { get; set; }
}
