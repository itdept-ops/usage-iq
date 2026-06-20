namespace Ccusage.Api.Data.Entities;

/// <summary>
/// Family Hub F6 — a single user's Google Calendar connection, established via the OAuth 2.0
/// authorization-CODE flow (offline access). This is a SEPARATE concern from Google sign-in (which uses
/// an ID token): connecting a calendar additionally grants the app offline access to the user's events.
///
/// SECURITY: the long-lived Google REFRESH TOKEN is stored ENCRYPTED at rest in
/// <see cref="EncryptedRefreshToken"/> (AES-GCM via the app's <c>TokenProtector</c>, the same symmetric
/// encryptor the share-link feature uses). The plaintext refresh token NEVER leaves the server — it is
/// never put in an API response, a log, or any client payload. A row exists only after the user has
/// explicitly connected; deleting it (disconnect) revokes the app's stored access immediately.
/// </summary>
public class GoogleCalendarConnection
{
    public int Id { get; set; }

    /// <summary>AppUser id this connection belongs to (one connection per user — unique).</summary>
    public int UserId { get; set; }

    /// <summary>
    /// The user's Google OAuth refresh token, ENCRYPTED at rest (AES-GCM via TokenProtector). Decrypted
    /// server-side only, to mint short-lived access tokens. Never exposed on the wire or logged.
    /// </summary>
    public string EncryptedRefreshToken { get; set; } = "";

    /// <summary>The OAuth scope(s) granted for this connection (e.g. the calendar.events scope).</summary>
    public string Scope { get; set; } = "";

    /// <summary>
    /// The calendar id events are read from / written to — usually "primary" (the user's primary calendar).
    /// </summary>
    public string? GoogleCalendarId { get; set; }

    /// <summary>When the user connected their calendar.</summary>
    public DateTime ConnectedUtc { get; set; }

    /// <summary>When the connection was last used to mint an access token / call the Calendar API.</summary>
    public DateTime? LastUsedUtc { get; set; }
}
