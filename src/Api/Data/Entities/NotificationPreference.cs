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

    /// <summary>
    /// Forward this user's in-app notifications to their personal Discord webhook. OFF by default; only
    /// effective when <see cref="DiscordWebhookEnc"/> is also set. The user controls this for themselves.
    /// </summary>
    public bool SurfaceDiscord { get; set; } = false;

    /// <summary>
    /// The user's personal Discord webhook URL, encrypted at rest via <c>TokenProtector</c> (AES-GCM
    /// base64 blob: nonce|tag|ciphertext). The PLAINTEXT URL is NEVER persisted. Null = not configured.
    /// </summary>
    public string? DiscordWebhookEnc { get; set; }

    /// <summary>
    /// A non-sensitive masked hint for the configured webhook (e.g. <c>discord.com/api/webhooks/12345…/abcd</c>),
    /// safe to return to the owner so the UI can show "configured as …" without ever exposing the secret URL.
    /// </summary>
    public string? DiscordWebhookHint { get; set; }

    /// <summary>
    /// Per-CATEGORY Discord-forward mask, INDEPENDENT of the in-app trigger gates (Notify*) — it only
    /// controls which categories mirror to the user's personal Discord webhook, never whether the in-app
    /// notification is created. A bitmask over <see cref="DiscordForwardCategory"/>. DEFAULT = ALL ON
    /// (<see cref="DiscordForwardCategory.All"/>) so enabling <see cref="SurfaceDiscord"/> forwards
    /// everything the user receives, exactly as before this column existed (non-breaking migration).
    /// The <see cref="SurfaceDiscord"/> master toggle still wins: off ⇒ nothing forwards regardless of
    /// this mask.
    /// </summary>
    public int DiscordCategories { get; set; } = (int)DiscordForwardCategory.All;

    /// <summary>
    /// Opt-in to the weekly personal recap (a Sunday summary of the user's OWN week — tracker totals,
    /// workouts, 75-Hard, hydration goal hits, bills — posted to <see cref="DiscordWebhookEnc"/>). OFF by
    /// default; only effective when a webhook is also configured. Independent of <see cref="SurfaceDiscord"/>.
    /// </summary>
    public bool WeeklyRecapEnabled { get; set; } = false;

    /// <summary>
    /// Idempotency marker for the weekly recap: the LOCAL date the recap was last successfully sent. The
    /// scheduler sets it (to the recap day's local date) only AFTER a confirmed send, so a restart or an
    /// extra minute-tick on the same day never double-sends. Null = never sent. The send-now/preview path
    /// ignores this guard. (A DateOnly anchor mirrors NotificationSetting.LastWeeklySent.)
    /// </summary>
    public DateOnly? LastRecapSent { get; set; }

    public DateTime UpdatedUtc { get; set; }
}
