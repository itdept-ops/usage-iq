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

    public DateTime UpdatedUtc { get; set; }
}
