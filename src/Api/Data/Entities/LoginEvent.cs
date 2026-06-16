namespace Ccusage.Api.Data.Entities;

/// <summary>
/// A structured, per-account record of a sign-in attempt that reached a known/created user row.
/// Written best-effort by <c>GoogleAuthService.SignInAsync</c> (a logging failure never blocks a
/// sign-in). Distinct from <see cref="AuditEntry"/>: this is the user-facing login history (with the
/// server-observed IP + user-agent), not the security audit trail. The unprovisioned-unknown-account
/// and invalid-token paths are deliberately NOT recorded here.
/// </summary>
public class LoginEvent
{
    public long Id { get; set; }

    /// <summary>The account email, stored lower-cased. Indexed (the per-user history filters on it).</summary>
    public string Email { get; set; } = "";

    /// <summary>The <see cref="AppUser.Id"/> when the row is known/created; null otherwise.</summary>
    public int? UserId { get; set; }

    public DateTime WhenUtc { get; set; }

    /// <summary>The server-observed client IP (post-UseForwardedHeaders); may be "" if unavailable.</summary>
    public string Ip { get; set; } = "";

    public bool Success { get; set; }

    /// <summary>Short outcome: "ok", "auto-provisioned", "account disabled", or "google id mismatch".</summary>
    public string Reason { get; set; } = "";

    /// <summary>Display name from the Google token, if any.</summary>
    public string? Name { get; set; }

    /// <summary>The request User-Agent header, truncated to ~256 chars.</summary>
    public string? UserAgent { get; set; }
}
