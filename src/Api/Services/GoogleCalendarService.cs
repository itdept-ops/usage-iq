using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;
using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Microsoft.EntityFrameworkCore;

namespace Ccusage.Api.Services;

/// <summary>
/// Family Hub F6 — wraps the Google Calendar API for a connected user's OWN primary calendar, using the
/// OAuth 2.0 authorization-CODE flow (offline access). Sign-in (the ID-token flow in
/// <see cref="GoogleAuthService"/>) is a separate concern; this service additionally lets the app read +
/// manage the user's events on their behalf, offline.
///
/// FLOW:
/// <list type="bullet">
///   <item><see cref="ConnectAsync"/> exchanges a one-time auth code at the token endpoint for an access
///   token + a long-lived REFRESH token, and stores the refresh token ENCRYPTED at rest.</item>
///   <item>Every Calendar call decrypts the stored refresh token and mints a fresh, short-lived ACCESS
///   token (grant_type=refresh_token), then calls the Calendar API with it.</item>
/// </list>
///
/// SECURITY:
/// <list type="bullet">
///   <item>The OAuth CLIENT SECRET (<c>Google:ClientSecret</c>) and the user REFRESH TOKEN NEVER appear in
///   any API response, log, or client payload. The refresh token is stored AES-GCM-encrypted via
///   <see cref="TokenProtector"/> (the same encryptor the share-link feature uses).</item>
///   <item>All HTTP targets are FIXED Google endpoints (token + calendar base URLs on the named client),
///   never user-controlled — no SSRF.</item>
///   <item>We request the MINIMAL scope (calendar.events).</item>
/// </list>
///
/// GRACEFUL: when the client secret is unset OR the caller has not connected a calendar OR the stored
/// refresh token has been revoked, the read/list/mutate methods surface a clear NOT-CONNECTED outcome
/// (never a 500). Mirrors how the Gemini/Weather services degrade.
/// </summary>
public sealed class GoogleCalendarService(
    IHttpClientFactory httpFactory,
    UsageDbContext db,
    TokenProtector protector,
    IConfiguration config,
    ILogger<GoogleCalendarService> logger)
{
    public const string HttpClientName = "google-calendar";

    /// <summary>The MINIMAL scope this feature requests — manage the user's own calendar events only.</summary>
    public const string Scope = "https://www.googleapis.com/auth/calendar.events";

    /// <summary>The fixed Google OAuth token endpoint (access-code exchange + refresh).</summary>
    private const string TokenEndpoint = "https://oauth2.googleapis.com/token";

    /// <summary>The fixed Google Calendar API base (the named client's BaseAddress points here).</summary>
    private const string CalendarBase = "https://www.googleapis.com";

    private const string PrimaryCalendar = "primary";

    /// <summary>Hard ceiling on the buffered OAuth token response (a real token JSON is well under a KB);
    /// caps the allocation so a compromised/MITM'd token endpoint cannot force an unbounded read.</summary>
    private const int MaxTokenResponseBytes = 64 * 1024;

    /// <summary>Hard ceiling on a buffered Calendar API JSON response (an events page maxes at 250 slim
    /// items); caps the allocation so a compromised/MITM'd endpoint cannot force an unbounded read.</summary>
    private const int MaxApiResponseBytes = 8 * 1024 * 1024;

    /// <summary>Whether the OAuth client secret is configured. When false, calendar is "not configured".</summary>
    public bool IsConfigured =>
        !string.IsNullOrWhiteSpace(config["Google:ClientId"])
        && !string.IsNullOrWhiteSpace(config["Google:ClientSecret"]);

    /// <summary>
    /// A user-actionable hint about the LAST Calendar API failure in this scoped request (e.g. the Calendar
    /// API isn't enabled, or the scope wasn't granted), or null for a generic/transient error. The service
    /// is per-request, so the endpoint reads this immediately after an Error result. NEVER a secret — only a
    /// classification of Google's (secret-free) Calendar API error body.
    /// </summary>
    public string? LastErrorHint { get; private set; }

    // =====================================================================================
    // Outcome types — every public method returns a graceful, never-throwing result.
    // =====================================================================================

    public enum CalendarStatus { Ok, NotConfigured, NotConnected, Error }

    /// <summary>A single calendar event projected to the client (no Google-internal/PII fields).
    /// <paramref name="IsRecurring"/> is true when the event is part of a recurring series (it has a
    /// recurringEventId, or — on the create/patch reply — its own recurrence rule).</summary>
    public sealed record CalendarEvent(
        string Id, string Title, DateTime? StartUtc, DateTime? EndUtc, bool AllDay,
        string? Location, string? Description, string? HtmlLink, string? HangoutLink, bool IsRecurring);

    /// <summary>The recurrence shapes the planner offers. "None" keeps today's single-event behaviour.</summary>
    public enum Recurrence { None, Daily, Weekly, Weekdays, Monthly }

    /// <summary>A busy block for the find-a-time helper (per connected member; never an email).</summary>
    public sealed record BusyBlock(DateTime StartUtc, DateTime EndUtc);

    /// <summary>Per-member busy blocks (identity by userId + display name; NO email).</summary>
    public sealed record MemberBusy(int UserId, string Name, IReadOnlyList<BusyBlock> Busy);

    /// <summary>A single shared event from a household member's calendar (title + time only; never an
    /// email/location/description — only what the overlay needs to render a block).</summary>
    public sealed record SharedEvent(string Title, DateTime? StartUtc, DateTime? EndUtc, bool AllDay);

    /// <summary>Per-member shared events (identity by userId + display name; NO email).</summary>
    public sealed record MemberEvents(int UserId, string Name, IReadOnlyList<SharedEvent> Events);

    public sealed record CalendarResult<T>(CalendarStatus Status, T? Value)
    {
        public bool Ok => Status == CalendarStatus.Ok;
    }

    private static CalendarResult<T> Status<T>(CalendarStatus status) => new(status, default);
    private static CalendarResult<T> Value<T>(T value) => new(CalendarStatus.Ok, value);

    // =====================================================================================
    // Connection lifecycle
    // =====================================================================================

    /// <summary>True when the given user has a stored calendar connection.</summary>
    public async Task<bool> IsConnectedAsync(int userId, CancellationToken ct = default) =>
        await db.GoogleCalendarConnections.AsNoTracking().AnyAsync(c => c.UserId == userId, ct);

    /// <summary>
    /// True when the stored connection's GRANTED scope includes calendar.events — i.e. the user actually
    /// allowed calendar access at consent. False when not connected or the scope is missing (the usual cause
    /// of "connected but can't create events" when the scope wasn't added to the OAuth consent screen).
    /// </summary>
    public async Task<bool> HasEventScopeAsync(int userId, CancellationToken ct = default)
    {
        var scope = await db.GoogleCalendarConnections.AsNoTracking()
            .Where(c => c.UserId == userId).Select(c => c.Scope).FirstOrDefaultAsync(ct);
        return scope is not null
            && (scope.Contains("calendar.events", StringComparison.OrdinalIgnoreCase)
                || scope.Contains("auth/calendar ", StringComparison.OrdinalIgnoreCase)
                || scope.EndsWith("auth/calendar", StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>
    /// Exchange a one-time auth CODE (authorization-code grant) for tokens and store the encrypted refresh
    /// token for <paramref name="userId"/>. <paramref name="redirectUri"/> is whatever the client used in
    /// the GIS code flow ("postmessage" for the popup flow). Returns false when unconfigured, when Google
    /// rejects the code, or when no refresh token comes back. Never throws; never logs the secret/tokens.
    /// </summary>
    public async Task<bool> ConnectAsync(int userId, string code, string redirectUri, CancellationToken ct = default)
    {
        if (!IsConfigured) return false;
        if (string.IsNullOrWhiteSpace(code)) return false;

        try
        {
            var form = new Dictionary<string, string>
            {
                ["grant_type"] = "authorization_code",
                ["client_id"] = config["Google:ClientId"]!,
                ["client_secret"] = config["Google:ClientSecret"]!,
                ["code"] = code,
                ["redirect_uri"] = string.IsNullOrWhiteSpace(redirectUri) ? "postmessage" : redirectUri,
            };

            using var doc = await PostTokenAsync(form, ct);
            if (doc is null) return false;
            var root = doc.RootElement;

            var refreshToken = GetStr(root, "refresh_token");
            if (string.IsNullOrEmpty(refreshToken))
            {
                // No refresh token => the consent wasn't offline / was previously granted without prompt.
                // Surface as a failed connect (the client must re-consent with access_type=offline + prompt).
                logger.LogWarning("Google calendar connect: token response carried no refresh_token.");
                return false;
            }

            var scope = GetStr(root, "scope") ?? Scope;
            var encrypted = protector.Protect(refreshToken);
            var now = DateTime.UtcNow;

            var existing = await db.GoogleCalendarConnections.FirstOrDefaultAsync(c => c.UserId == userId, ct);
            if (existing is null)
            {
                db.GoogleCalendarConnections.Add(new GoogleCalendarConnection
                {
                    UserId = userId,
                    EncryptedRefreshToken = encrypted,
                    Scope = scope.Length > 512 ? scope[..512] : scope,
                    GoogleCalendarId = PrimaryCalendar,
                    ConnectedUtc = now,
                });
            }
            else
            {
                // Reconnecting refreshes the stored token + scope.
                existing.EncryptedRefreshToken = encrypted;
                existing.Scope = scope.Length > 512 ? scope[..512] : scope;
                existing.GoogleCalendarId ??= PrimaryCalendar;
                existing.ConnectedUtc = now;
            }

            try
            {
                await db.SaveChangesAsync(ct);
            }
            catch (DbUpdateException ex) when (IsUniqueViolation(ex))
            {
                // A concurrent connect won the race; treat as already connected (theirs stands).
                db.ChangeTracker.Clear();
            }
            return true;
        }
        catch (Exception ex)
        {
            logger.LogWarning("Google calendar connect failed: {Reason}", ex.Message);
            return false;
        }
    }

    /// <summary>Remove the caller's calendar connection (idempotent). True when a row was deleted.</summary>
    public async Task<bool> DisconnectAsync(int userId, CancellationToken ct = default)
    {
        var removed = await db.GoogleCalendarConnections
            .Where(c => c.UserId == userId)
            .ExecuteDeleteAsync(ct);
        return removed > 0;
    }

    // =====================================================================================
    // Events — the caller's own primary calendar
    // =====================================================================================

    /// <summary>
    /// List the caller's events in [<paramref name="startUtc"/>, <paramref name="endUtc"/>) on their
    /// primary calendar (singleEvents=true, ordered by start). Graceful: NotConfigured / NotConnected /
    /// Error are returned as statuses, never exceptions.
    /// </summary>
    public async Task<CalendarResult<IReadOnlyList<CalendarEvent>>> ListEventsAsync(
        int userId, DateTime startUtc, DateTime endUtc, CancellationToken ct = default)
    {
        var token = await MintAccessTokenAsync(userId, ct);
        if (token.Status != CalendarStatus.Ok)
            return Status<IReadOnlyList<CalendarEvent>>(token.Status);

        var path = $"/calendar/v3/calendars/{PrimaryCalendar}/events"
                   + $"?singleEvents=true&orderBy=startTime&maxResults=250"
                   + $"&timeMin={Uri.EscapeDataString(Rfc3339(startUtc))}"
                   + $"&timeMax={Uri.EscapeDataString(Rfc3339(endUtc))}";

        var doc = await CalendarGetAsync(path, token.Value!, ct);
        if (doc is null) return Status<IReadOnlyList<CalendarEvent>>(CalendarStatus.Error);

        using (doc)
        {
            var events = new List<CalendarEvent>();
            if (doc.RootElement.TryGetProperty("items", out var items) && items.ValueKind == JsonValueKind.Array)
                foreach (var item in items.EnumerateArray())
                {
                    var ev = MapEvent(item);
                    if (ev is not null) events.Add(ev);
                }
            return Value<IReadOnlyList<CalendarEvent>>(events);
        }
    }

    /// <summary>Create an event on the caller's primary calendar. Returns the created event.
    /// <paramref name="recurrence"/> (default <see cref="Recurrence.None"/>) makes it a recurring series,
    /// bounded by <paramref name="recurrenceCount"/> or <paramref name="recurrenceUntilUtc"/>.</summary>
    public async Task<CalendarResult<CalendarEvent>> CreateEventAsync(
        int userId, string title, DateTime startUtc, DateTime endUtc, bool allDay,
        string? location, string? description, Recurrence recurrence = Recurrence.None,
        int? recurrenceCount = null, DateTime? recurrenceUntilUtc = null, CancellationToken ct = default)
    {
        var token = await MintAccessTokenAsync(userId, ct);
        if (token.Status != CalendarStatus.Ok) return Status<CalendarEvent>(token.Status);

        var body = BuildEventBody(title, startUtc, endUtc, allDay, location, description,
            recurrence, recurrenceCount, recurrenceUntilUtc);
        var path = $"/calendar/v3/calendars/{PrimaryCalendar}/events";

        var doc = await CalendarSendAsync(HttpMethod.Post, path, token.Value!, body, ct);
        if (doc is null) return Status<CalendarEvent>(CalendarStatus.Error);
        using (doc)
        {
            var ev = MapEvent(doc.RootElement);
            return ev is null ? Status<CalendarEvent>(CalendarStatus.Error) : Value(ev);
        }
    }

    /// <summary>Patch an existing event on the caller's primary calendar. Returns the updated event.
    /// <paramref name="recurrence"/> (default <see cref="Recurrence.None"/>) sets/replaces the series rule;
    /// <see cref="Recurrence.None"/> sends no recurrence (PATCH leaves any existing rule untouched).</summary>
    public async Task<CalendarResult<CalendarEvent>> UpdateEventAsync(
        int userId, string eventId, string title, DateTime startUtc, DateTime endUtc, bool allDay,
        string? location, string? description, Recurrence recurrence = Recurrence.None,
        int? recurrenceCount = null, DateTime? recurrenceUntilUtc = null, CancellationToken ct = default)
    {
        var token = await MintAccessTokenAsync(userId, ct);
        if (token.Status != CalendarStatus.Ok) return Status<CalendarEvent>(token.Status);
        if (string.IsNullOrWhiteSpace(eventId)) return Status<CalendarEvent>(CalendarStatus.Error);

        var body = BuildEventBody(title, startUtc, endUtc, allDay, location, description,
            recurrence, recurrenceCount, recurrenceUntilUtc);
        var path = $"/calendar/v3/calendars/{PrimaryCalendar}/events/{Uri.EscapeDataString(eventId)}";

        // PATCH = partial update; we send the editable fields.
        var doc = await CalendarSendAsync(HttpMethod.Patch, path, token.Value!, body, ct);
        if (doc is null) return Status<CalendarEvent>(CalendarStatus.Error);
        using (doc)
        {
            var ev = MapEvent(doc.RootElement);
            return ev is null ? Status<CalendarEvent>(CalendarStatus.Error) : Value(ev);
        }
    }

    /// <summary>Delete an event from the caller's primary calendar. Ok on success or already-gone (404/410).</summary>
    public async Task<CalendarStatus> DeleteEventAsync(int userId, string eventId, CancellationToken ct = default)
    {
        var token = await MintAccessTokenAsync(userId, ct);
        if (token.Status != CalendarStatus.Ok) return token.Status;
        if (string.IsNullOrWhiteSpace(eventId)) return CalendarStatus.Error;

        var path = $"/calendar/v3/calendars/{PrimaryCalendar}/events/{Uri.EscapeDataString(eventId)}";
        try
        {
            var client = httpFactory.CreateClient(HttpClientName);
            using var req = new HttpRequestMessage(HttpMethod.Delete, path);
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token.Value!);
            using var res = await client.SendAsync(req, ct);
            // 200/204 = deleted; 404/410 = already gone — both are "done".
            if (res.IsSuccessStatusCode || res.StatusCode is HttpStatusCode.NotFound or HttpStatusCode.Gone)
                return CalendarStatus.Ok;
            if (res.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
                return CalendarStatus.NotConnected;
            logger.LogWarning("Google calendar delete returned {Status}.", (int)res.StatusCode);
            return CalendarStatus.Error;
        }
        catch (Exception ex)
        {
            logger.LogWarning("Google calendar delete failed: {Reason}", ex.Message);
            return CalendarStatus.Error;
        }
    }

    // =====================================================================================
    // Free/busy — for the find-a-time helper across CONNECTED household members
    // =====================================================================================

    /// <summary>
    /// Query free/busy for the given members over [start, end). Only members who have CONNECTED a calendar
    /// contribute blocks; unconnected members are SKIPPED entirely (not surfaced). Each member is identified
    /// by userId + display name — NEVER an email (the Google freebusy "id" we send is the member's
    /// "primary" calendar via their own minted token, so no cross-user email is exposed).
    /// </summary>
    public async Task<IReadOnlyList<MemberBusy>> FreeBusyAsync(
        IEnumerable<(int UserId, string Name)> members, DateTime startUtc, DateTime endUtc,
        CancellationToken ct = default)
    {
        var result = new List<MemberBusy>();
        if (!IsConfigured) return result;

        foreach (var (userId, name) in members)
        {
            var token = await MintAccessTokenAsync(userId, ct);
            if (token.Status != CalendarStatus.Ok) continue; // skip unconnected/errored members

            var body = new
            {
                timeMin = Rfc3339(startUtc),
                timeMax = Rfc3339(endUtc),
                items = new[] { new { id = PrimaryCalendar } },
            };

            var doc = await CalendarSendAsync(HttpMethod.Post, "/calendar/v3/freeBusy", token.Value!, body, ct);
            if (doc is null) continue;
            using (doc)
            {
                var blocks = ParseBusy(doc.RootElement);
                result.Add(new MemberBusy(userId, name, blocks));
            }
        }
        return result;
    }

    /// <summary>
    /// Read each given member's PRIMARY-calendar events over [start, end) for the family overlay, using THAT
    /// member's own minted access token (the same per-member-token pattern as <see cref="FreeBusyAsync"/>,
    /// but it reads event title+time instead of just busy blocks). Only members who have CONNECTED a calendar
    /// contribute — an unconnected/revoked member is SKIPPED entirely (never surfaced), and a single member's
    /// fetch FAILING is swallowed (that member is simply absent) so one bad calendar can't fail the whole
    /// response. Each member is identified by userId + display name — NEVER an email; only the event title +
    /// time (and an all-day flag) are returned, not location/description/links.
    /// </summary>
    public async Task<IReadOnlyList<MemberEvents>> FamilyEventsAsync(
        IEnumerable<(int UserId, string Name)> members, DateTime startUtc, DateTime endUtc,
        CancellationToken ct = default)
    {
        var result = new List<MemberEvents>();
        if (!IsConfigured) return result;

        foreach (var (userId, name) in members)
        {
            // Each member uses THEIR OWN token (skip unconnected/errored members — they don't appear).
            var listed = await ListEventsAsync(userId, startUtc, endUtc, ct);
            if (!listed.Ok || listed.Value is null) continue;

            var events = listed.Value
                .Select(e => new SharedEvent(
                    string.IsNullOrWhiteSpace(e.Title) ? "(busy)" : e.Title, e.StartUtc, e.EndUtc, e.AllDay))
                .ToList();
            result.Add(new MemberEvents(userId, name, events));
        }
        return result;
    }

    // =====================================================================================
    // Access-token minting (refresh-token grant) — graceful on revocation
    // =====================================================================================

    /// <summary>
    /// Decrypt the caller's stored refresh token and mint a fresh access token. Returns NotConfigured /
    /// NotConnected / Error as appropriate. A revoked refresh token (Google replies 400 invalid_grant)
    /// surfaces as NotConnected, and the now-dead connection row is removed so status reflects reality.
    /// </summary>
    private async Task<CalendarResult<string>> MintAccessTokenAsync(int userId, CancellationToken ct)
    {
        if (!IsConfigured) return Status<string>(CalendarStatus.NotConfigured);

        var conn = await db.GoogleCalendarConnections.FirstOrDefaultAsync(c => c.UserId == userId, ct);
        if (conn is null) return Status<string>(CalendarStatus.NotConnected);

        var refreshToken = protector.Unprotect(conn.EncryptedRefreshToken);
        if (string.IsNullOrEmpty(refreshToken))
        {
            // Undecryptable (tampered / key rotated): treat as not-connected.
            logger.LogWarning("Google calendar: stored refresh token for user {UserId} could not be decrypted.", userId);
            return Status<string>(CalendarStatus.NotConnected);
        }

        try
        {
            var form = new Dictionary<string, string>
            {
                ["grant_type"] = "refresh_token",
                ["client_id"] = config["Google:ClientId"]!,
                ["client_secret"] = config["Google:ClientSecret"]!,
                ["refresh_token"] = refreshToken,
            };

            var client = httpFactory.CreateClient(HttpClientName);
            using var req = new HttpRequestMessage(HttpMethod.Post, TokenEndpoint)
            {
                Content = new FormUrlEncodedContent(form),
            };
            using var res = await client.SendAsync(req, ct);
            if (!res.IsSuccessStatusCode)
            {
                // 400 invalid_grant => the user revoked access / the token expired: the connection is dead.
                if (res.StatusCode is HttpStatusCode.BadRequest or HttpStatusCode.Unauthorized)
                {
                    logger.LogWarning("Google calendar refresh rejected ({Status}); clearing connection for user {UserId}.",
                        (int)res.StatusCode, userId);
                    await db.GoogleCalendarConnections.Where(c => c.UserId == userId).ExecuteDeleteAsync(ct);
                    return Status<string>(CalendarStatus.NotConnected);
                }
                logger.LogWarning("Google calendar token refresh returned {Status}.", (int)res.StatusCode);
                return Status<string>(CalendarStatus.Error);
            }

            var bytes = await ReadCappedAsync(res, MaxTokenResponseBytes, ct);
            if (bytes is null) return Status<string>(CalendarStatus.Error);
            using var doc = JsonDocument.Parse(bytes);
            var accessToken = GetStr(doc.RootElement, "access_token");
            if (string.IsNullOrEmpty(accessToken)) return Status<string>(CalendarStatus.Error);

            // Best-effort touch of LastUsedUtc (never block the call on it).
            try
            {
                await db.GoogleCalendarConnections.Where(c => c.UserId == userId)
                    .ExecuteUpdateAsync(s => s.SetProperty(c => c.LastUsedUtc, DateTime.UtcNow), ct);
            }
            catch { /* bookkeeping only */ }

            return Value(accessToken);
        }
        catch (Exception ex)
        {
            logger.LogWarning("Google calendar token refresh failed: {Reason}", ex.Message);
            return Status<string>(CalendarStatus.Error);
        }
    }

    // =====================================================================================
    // HTTP helpers (fixed Google endpoints only)
    // =====================================================================================

    private async Task<JsonDocument?> PostTokenAsync(Dictionary<string, string> form, CancellationToken ct)
    {
        try
        {
            var client = httpFactory.CreateClient(HttpClientName);
            using var req = new HttpRequestMessage(HttpMethod.Post, TokenEndpoint)
            {
                Content = new FormUrlEncodedContent(form),
            };
            using var res = await client.SendAsync(req, ct);
            if (!res.IsSuccessStatusCode)
            {
                // Never log the body (it would echo the code/secret); just the status.
                logger.LogWarning("Google token endpoint returned {Status}.", (int)res.StatusCode);
                return null;
            }
            // Cap the buffered token response: a legitimate OAuth token JSON is well under a KB, so
            // reject anything larger to stop a compromised/MITM'd endpoint forcing an unbounded allocation.
            var bytes = await ReadCappedAsync(res, MaxTokenResponseBytes, ct);
            if (bytes is null) return null;
            return JsonDocument.Parse(bytes);
        }
        catch (Exception ex)
        {
            logger.LogWarning("Google token request failed: {Reason}", ex.Message);
            return null;
        }
    }

    private async Task<JsonDocument?> CalendarGetAsync(string path, string accessToken, CancellationToken ct)
    {
        try
        {
            var client = httpFactory.CreateClient(HttpClientName);
            using var req = new HttpRequestMessage(HttpMethod.Get, path);
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
            using var res = await client.SendAsync(req, ct);
            if (!res.IsSuccessStatusCode)
            {
                CaptureCalendarError("GET", (int)res.StatusCode, await SafeReadBodyAsync(res, ct));
                return null;
            }
            var bytes = await ReadCappedAsync(res, MaxApiResponseBytes, ct);
            return bytes is null ? null : JsonDocument.Parse(bytes);
        }
        catch (Exception ex)
        {
            logger.LogWarning("Google calendar GET failed: {Reason}", ex.Message);
            return null;
        }
    }

    private async Task<JsonDocument?> CalendarSendAsync(
        HttpMethod method, string path, string accessToken, object body, CancellationToken ct)
    {
        try
        {
            var client = httpFactory.CreateClient(HttpClientName);
            using var req = new HttpRequestMessage(method, path)
            {
                Content = System.Net.Http.Json.JsonContent.Create(body),
            };
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
            using var res = await client.SendAsync(req, ct);
            if (!res.IsSuccessStatusCode)
            {
                CaptureCalendarError(method.Method, (int)res.StatusCode, await SafeReadBodyAsync(res, ct));
                return null;
            }
            var bytes = await ReadCappedAsync(res, MaxApiResponseBytes, ct);
            return bytes is null ? null : JsonDocument.Parse(bytes);
        }
        catch (Exception ex)
        {
            logger.LogWarning("Google calendar {Method} failed: {Reason}", method.Method, ex.Message);
            return null;
        }
    }

    /// <summary>Buffer a response body into memory but abort if it exceeds <paramref name="maxBytes"/>,
    /// so a hostile/MITM'd endpoint cannot force an arbitrarily large allocation. Returns null if the
    /// body is over the cap or a read error occurs.</summary>
    private static async Task<byte[]?> ReadCappedAsync(HttpResponseMessage res, int maxBytes, CancellationToken ct)
    {
        // If the endpoint advertises a length, reject oversized bodies before reading a single byte.
        if (res.Content.Headers.ContentLength is long len && len > maxBytes) return null;

        await using var stream = await res.Content.ReadAsStreamAsync(ct);
        using var buffer = new MemoryStream();
        var chunk = new byte[8192];
        int read;
        while ((read = await stream.ReadAsync(chunk.AsMemory(0, chunk.Length), ct)) > 0)
        {
            if (buffer.Length + read > maxBytes) return null;
            buffer.Write(chunk, 0, read);
        }
        return buffer.ToArray();
    }

    /// <summary>Read up to 4 KB of a failed Calendar API response body (secret-free — it describes the
    /// calendar request, not the OAuth exchange). Returns null on any read error.</summary>
    private static async Task<string?> SafeReadBodyAsync(HttpResponseMessage res, CancellationToken ct)
    {
        try
        {
            var s = await res.Content.ReadAsStringAsync(ct);
            return s.Length > 4096 ? s[..4096] : s;
        }
        catch { return null; }
    }

    /// <summary>
    /// Classify a failed Calendar API call from Google's error body into a user-actionable
    /// <see cref="LastErrorHint"/> (e.g. "enable the Calendar API", "reconnect to grant scope"), and LOG the
    /// (secret-free) reason for diagnosis. The most common "connected but can't create" causes are the
    /// Calendar API being disabled in the Cloud project, or the calendar.events scope never being granted.
    /// </summary>
    private void CaptureCalendarError(string method, int statusCode, string? body)
    {
        string? reason = null, gstatus = null, message = null;
        if (!string.IsNullOrEmpty(body))
        {
            try
            {
                using var doc = JsonDocument.Parse(body);
                if (doc.RootElement.TryGetProperty("error", out var err) && err.ValueKind == JsonValueKind.Object)
                {
                    gstatus = GetStr(err, "status");
                    message = GetStr(err, "message");
                    if (err.TryGetProperty("errors", out var errs) && errs.ValueKind == JsonValueKind.Array
                        && errs.GetArrayLength() > 0)
                        reason = GetStr(errs[0], "reason");
                }
            }
            catch { /* non-JSON error body — fall back to the status code only */ }
        }

        var lc = ((reason ?? "") + " " + (gstatus ?? "") + " " + (message ?? "")).ToLowerInvariant();
        LastErrorHint =
            lc.Contains("accessnotconfigured") || lc.Contains("service_disabled")
                || lc.Contains("has not been used in project") || lc.Contains("it is disabled")
                ? "Google Calendar API access isn't enabled for this app yet. In the Google Cloud console → APIs & Services → Library, enable “Google Calendar API”, wait a minute, then try again."
            : lc.Contains("insufficient") || lc.Contains("scope")
                ? "Calendar access wasn't granted. Disconnect, then reconnect and be sure to allow the calendar permission when Google asks."
            : statusCode == 429 || lc.Contains("ratelimit") || lc.Contains("rate_limit")
                ? "Google rate-limited the request — wait a moment and try again."
            : null;

        logger.LogWarning("Google calendar {Method} error {Status}: reason={Reason} gstatus={GStatus} message={Message}",
            method, statusCode, reason, gstatus, message);
    }

    // =====================================================================================
    // Mapping + JSON helpers
    // =====================================================================================

    /// <summary>The default bound (~1 year of weekly occurrences) when a recurring event has no explicit
    /// count/until — so a series is always finite and can't run forever.</summary>
    private const int DefaultRecurrenceCount = 52;

    /// <summary>The hard cap on an explicit occurrence count (prevents an absurdly long series).</summary>
    private const int MaxRecurrenceCount = 730;

    /// <summary>
    /// Build the Google event resource body for create/patch from validated inputs. When
    /// <paramref name="recurrence"/> is anything but <see cref="Recurrence.None"/>, an RRULE is attached
    /// (bounded by <paramref name="count"/> or <paramref name="untilUtc"/>, else <see cref="DefaultRecurrenceCount"/>).
    /// Exposed (public) so the recurrence-rule construction can be unit-tested without a live Calendar call.
    /// </summary>
    public static object BuildEventBody(
        string title, DateTime startUtc, DateTime endUtc, bool allDay, string? location, string? description,
        Recurrence recurrence = Recurrence.None, int? count = null, DateTime? untilUtc = null)
    {
        object start, end;
        if (allDay)
        {
            // All-day events use date (the end date is EXCLUSIVE per the Calendar API).
            start = new { date = DateOnly.FromDateTime(startUtc).ToString("yyyy-MM-dd") };
            var endDate = DateOnly.FromDateTime(endUtc);
            if (endDate <= DateOnly.FromDateTime(startUtc)) endDate = DateOnly.FromDateTime(startUtc).AddDays(1);
            end = new { date = endDate.ToString("yyyy-MM-dd") };
        }
        else
        {
            start = new { dateTime = Rfc3339(startUtc), timeZone = "UTC" };
            end = new { dateTime = Rfc3339(endUtc), timeZone = "UTC" };
        }

        var rule = BuildRecurrenceRule(recurrence, startUtc, count, untilUtc);

        var body = new Dictionary<string, object?>
        {
            ["summary"] = title,
            ["location"] = string.IsNullOrWhiteSpace(location) ? null : location,
            ["description"] = string.IsNullOrWhiteSpace(description) ? null : description,
            ["start"] = start,
            ["end"] = end,
        };
        // Only attach recurrence when there's an actual rule. OMITTING it (rather than sending null) means a
        // PATCH/update leaves an existing series rule UNTOUCHED — Google treats an explicit null as "clear
        // recurrence", which would silently turn a recurring event into a one-off on an unrelated edit.
        if (rule is not null) body["recurrence"] = new[] { rule };
        return body;
    }

    /// <summary>
    /// Build the Google <c>RRULE:</c> line for a <see cref="Recurrence"/>, or null for
    /// <see cref="Recurrence.None"/>. The series is ALWAYS bounded: an explicit <paramref name="untilUtc"/>
    /// (UNTIL, takes precedence) or <paramref name="count"/> (COUNT, clamped 1..<see cref="MaxRecurrenceCount"/>),
    /// otherwise <see cref="DefaultRecurrenceCount"/>. <see cref="Recurrence.Weekly"/> repeats on the start's
    /// weekday; <see cref="Recurrence.Weekdays"/> is Mon–Fri. Exposed for unit testing.
    /// </summary>
    public static string? BuildRecurrenceRule(
        Recurrence recurrence, DateTime startUtc, int? count = null, DateTime? untilUtc = null)
    {
        var freqPart = recurrence switch
        {
            Recurrence.Daily => "FREQ=DAILY",
            Recurrence.Weekly => "FREQ=WEEKLY;BYDAY=" + ByDay(startUtc.DayOfWeek),
            Recurrence.Weekdays => "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
            Recurrence.Monthly => "FREQ=MONTHLY",
            _ => null,
        };
        if (freqPart is null) return null;

        // Bound the series. UNTIL wins when both are given; UNTIL is a UTC instant (trailing Z) per RFC 5545.
        string bound;
        if (untilUtc is { } until)
            bound = "UNTIL=" + DateTime.SpecifyKind(until, DateTimeKind.Utc).ToString("yyyyMMddTHHmmssZ");
        else
        {
            var c = count is { } n ? Math.Clamp(n, 1, MaxRecurrenceCount) : DefaultRecurrenceCount;
            bound = "COUNT=" + c;
        }

        return $"RRULE:{freqPart};{bound}";
    }

    /// <summary>The RFC 5545 two-letter BYDAY token for a weekday (MO, TU, …, SU).</summary>
    private static string ByDay(DayOfWeek d) => d switch
    {
        DayOfWeek.Monday => "MO",
        DayOfWeek.Tuesday => "TU",
        DayOfWeek.Wednesday => "WE",
        DayOfWeek.Thursday => "TH",
        DayOfWeek.Friday => "FR",
        DayOfWeek.Saturday => "SA",
        _ => "SU",
    };

    /// <summary>Project a Google event resource to our slim <see cref="CalendarEvent"/>. Null when unusable.</summary>
    private static CalendarEvent? MapEvent(JsonElement item)
    {
        if (item.ValueKind != JsonValueKind.Object) return null;
        var id = GetStr(item, "id");
        if (string.IsNullOrEmpty(id)) return null;

        // Cancelled instances of a recurring event come back with status=cancelled and no times — skip.
        if (string.Equals(GetStr(item, "status"), "cancelled", StringComparison.Ordinal)) return null;

        var (startUtc, startAllDay) = ReadEventTime(item, "start");
        var (endUtc, endAllDay) = ReadEventTime(item, "end");
        var allDay = startAllDay || endAllDay;

        // Recurring: a singleEvents expansion stamps each instance with recurringEventId; a freshly
        // created/patched master carries its own non-empty "recurrence" array. Either marks the UI badge.
        var isRecurring =
            !string.IsNullOrEmpty(GetStr(item, "recurringEventId"))
            || (item.TryGetProperty("recurrence", out var rec)
                && rec.ValueKind == JsonValueKind.Array && rec.GetArrayLength() > 0);

        return new CalendarEvent(
            Id: id,
            Title: GetStr(item, "summary") ?? "(no title)",
            StartUtc: startUtc,
            EndUtc: endUtc,
            AllDay: allDay,
            Location: GetStr(item, "location"),
            Description: GetStr(item, "description"),
            HtmlLink: GetStr(item, "htmlLink"),
            HangoutLink: GetStr(item, "hangoutLink"),
            IsRecurring: isRecurring);
    }

    /// <summary>Read a Google event start/end node into a UTC instant + whether it was an all-day "date".</summary>
    private static (DateTime? Utc, bool AllDay) ReadEventTime(JsonElement item, string prop)
    {
        if (!item.TryGetProperty(prop, out var node) || node.ValueKind != JsonValueKind.Object)
            return (null, false);

        if (node.TryGetProperty("dateTime", out var dt) && dt.ValueKind == JsonValueKind.String
            && DateTimeOffset.TryParse(dt.GetString(), out var dto))
            return (dto.UtcDateTime, false);

        if (node.TryGetProperty("date", out var d) && d.ValueKind == JsonValueKind.String
            && DateOnly.TryParse(d.GetString(), out var date))
            return (DateTime.SpecifyKind(date.ToDateTime(TimeOnly.MinValue), DateTimeKind.Utc), true);

        return (null, false);
    }

    /// <summary>Parse a freeBusy.query response into the primary calendar's busy blocks.</summary>
    private static List<BusyBlock> ParseBusy(JsonElement root)
    {
        var blocks = new List<BusyBlock>();
        if (!root.TryGetProperty("calendars", out var cals) || cals.ValueKind != JsonValueKind.Object)
            return blocks;
        foreach (var cal in cals.EnumerateObject())
        {
            if (!cal.Value.TryGetProperty("busy", out var busy) || busy.ValueKind != JsonValueKind.Array)
                continue;
            foreach (var b in busy.EnumerateArray())
            {
                if (b.ValueKind != JsonValueKind.Object) continue;
                var s = GetStr(b, "start");
                var e = GetStr(b, "end");
                if (DateTimeOffset.TryParse(s, out var sd) && DateTimeOffset.TryParse(e, out var ed))
                    blocks.Add(new BusyBlock(sd.UtcDateTime, ed.UtcDateTime));
            }
        }
        return blocks;
    }

    private static string Rfc3339(DateTime utc) =>
        DateTime.SpecifyKind(utc, DateTimeKind.Utc).ToString("yyyy-MM-ddTHH:mm:ssZ");

    private static string? GetStr(JsonElement el, string prop) =>
        el.ValueKind == JsonValueKind.Object && el.TryGetProperty(prop, out var v) && v.ValueKind == JsonValueKind.String
            ? v.GetString() : null;

    private static bool IsUniqueViolation(DbUpdateException ex) =>
        ex.InnerException is Npgsql.PostgresException pg && pg.SqlState == Npgsql.PostgresErrorCodes.UniqueViolation;
}
