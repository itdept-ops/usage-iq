using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Ccusage.Api.Services.Health;

/// <summary>
/// PROGRAM-2 #1 — the Fitbit Web API <see cref="IHealthProvider"/>. Hand-rolled HTTP (named
/// <see cref="HttpClientName"/> client) on FIXED Fitbit hosts (api.fitbit.com), mirroring
/// <see cref="GoogleCalendarService"/>: an auth-code+PKCE <see cref="ConnectAsync"/> exchange stores an
/// ENCRYPTED refresh token; each pull mints a short-lived access token from it.
///
/// FITBIT DEVIATION (the #1 correctness rule): every token refresh returns a NEW refresh token and
/// invalidates the old one. <see cref="MintAccessTokenAsync"/> therefore RE-STORES the rotated refresh token
/// on EVERY refresh; skip that and the connection silently dies on the next sync. (Google does NOT rotate —
/// that's the deliberate difference from the calendar template.)
///
/// SECURITY: the client secret + the user refresh token NEVER appear in any response, log, or client
/// payload. The refresh token is AES-GCM-encrypted at rest via <see cref="TokenProtector"/>. All hosts are
/// fixed (no SSRF). GRACEFUL: an unconfigured server / revoked token / rate-limit surfaces a status, never a 500.
/// </summary>
public sealed class FitbitHealthProvider(
    IHttpClientFactory httpFactory,
    UsageDbContext db,
    TokenProtector protector,
    IOptions<FitbitOptions> options,
    ILogger<FitbitHealthProvider> logger) : IHealthProvider
{
    public const string HttpClientName = "fitbit";

    /// <summary>The fixed Fitbit OAuth token endpoint (auth-code exchange + refresh).</summary>
    private const string TokenEndpoint = "https://api.fitbit.com/oauth2/token";

    /// <summary>The fixed Fitbit Web API base (the named client's BaseAddress points here).</summary>
    private const string ApiBase = "https://api.fitbit.com";

    /// <summary>The MINIMAL Fitbit scopes the sync needs (steps/distance/calories, sleep, HR, workouts).</summary>
    public const string FitbitScopes = "activity heartrate sleep profile";

    private readonly FitbitOptions _opts = options.Value;

    public HealthProvider Provider => HealthProvider.Fitbit;
    public bool IsConfigured => _opts.IsConfigured;
    public string Scopes => FitbitScopes;

    /// <summary>The OAuth client id (NOT a secret — the browser needs it to build the authorize URL). Null
    /// when unconfigured.</summary>
    public string? ClientIdForAuthorize => string.IsNullOrWhiteSpace(_opts.ClientId) ? null : _opts.ClientId;

    // =====================================================================================
    // Connect — auth-code + PKCE exchange
    // =====================================================================================

    public async Task<bool> ConnectAsync(
        int userId, string userEmail, string code, string redirectUri, string? codeVerifier, CancellationToken ct = default)
    {
        if (!IsConfigured) return false;
        if (string.IsNullOrWhiteSpace(code)) return false;

        try
        {
            var form = new Dictionary<string, string>
            {
                ["grant_type"] = "authorization_code",
                ["client_id"] = _opts.ClientId!,
                ["code"] = code,
                ["redirect_uri"] = redirectUri ?? "",
            };
            // PKCE: when the SPA used a code challenge, the verifier must be echoed here.
            if (!string.IsNullOrWhiteSpace(codeVerifier)) form["code_verifier"] = codeVerifier;

            var (doc, _) = await PostTokenAsync(form, ct);
            if (doc is null) return false;
            using var _doc = doc;
            var root = doc.RootElement;

            var refreshToken = GetStr(root, "refresh_token");
            if (string.IsNullOrEmpty(refreshToken))
            {
                logger.LogWarning("Fitbit connect: token response carried no refresh_token.");
                return false;
            }

            var scope = GetStr(root, "scope") ?? FitbitScopes;
            var providerUserId = GetStr(root, "user_id");
            var encrypted = protector.Protect(refreshToken);
            var now = DateTime.UtcNow;
            var email = userEmail.Trim().ToLowerInvariant();

            var existing = await db.HealthConnections
                .FirstOrDefaultAsync(c => c.UserId == userId && c.Provider == HealthProvider.Fitbit, ct);
            if (existing is null)
            {
                db.HealthConnections.Add(new HealthConnection
                {
                    UserId = userId,
                    UserEmail = email,
                    Provider = HealthProvider.Fitbit,
                    EncryptedRefreshToken = encrypted,
                    Scope = Trunc(scope, 512) ?? FitbitScopes,
                    ProviderUserId = Trunc(providerUserId, 64),
                    AutoSyncEnabled = true,
                    ConnectedUtc = now,
                    LastSyncStatus = HealthSyncStatus.Ok,
                });
            }
            else
            {
                // Reconnecting refreshes the stored token + scope (and clears a prior auth-expired status).
                existing.UserEmail = email;
                existing.EncryptedRefreshToken = encrypted;
                existing.Scope = Trunc(scope, 512) ?? FitbitScopes;
                existing.ProviderUserId = Trunc(providerUserId, 64) ?? existing.ProviderUserId;
                existing.ConnectedUtc = now;
                existing.LastSyncStatus = HealthSyncStatus.Ok;
            }

            try
            {
                await db.SaveChangesAsync(ct);
            }
            catch (DbUpdateException ex) when (IsUniqueViolation(ex))
            {
                db.ChangeTracker.Clear();
            }
            return true;
        }
        catch (Exception ex)
        {
            logger.LogWarning("Fitbit connect failed: {Reason}", ex.Message);
            return false;
        }
    }

    // =====================================================================================
    // Pull one local day's signals
    // =====================================================================================

    public async Task<HealthDayResult> PullDayAsync(
        HealthConnection conn, DateOnly localDate, TimeZoneInfo tz, CancellationToken ct = default)
    {
        if (!IsConfigured) return HealthDayResult.Of(HealthPullStatus.NotConfigured);

        var token = await MintAccessTokenAsync(conn, ct);
        if (token.Status != HealthPullStatus.Ok) return HealthDayResult.Of(token.Status);

        var date = localDate.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

        DailySummary? activity = null;
        if (conn.SyncSteps || conn.SyncHeartRate)
        {
            var (status, summary) = await PullActivityAsync(token.Value!, date, conn, ct);
            if (status is HealthPullStatus.AuthExpired or HealthPullStatus.RateLimited)
                return HealthDayResult.Of(status);
            activity = summary;
        }

        var sleeps = new List<SleepRecord>();
        if (conn.SyncSleep)
        {
            var (status, recs) = await PullSleepAsync(token.Value!, date, ct);
            if (status is HealthPullStatus.AuthExpired or HealthPullStatus.RateLimited)
                return HealthDayResult.Of(status);
            sleeps.AddRange(recs);
        }

        var workouts = new List<WorkoutRecord>();
        if (conn.SyncWorkouts)
        {
            var (status, recs) = await PullWorkoutsAsync(token.Value!, date, ct);
            if (status is HealthPullStatus.AuthExpired or HealthPullStatus.RateLimited)
                return HealthDayResult.Of(status);
            workouts.AddRange(recs);
        }

        return HealthDayResult.Value(new HealthDaySignals(localDate, activity, sleeps, workouts));
    }

    // =====================================================================================
    // REST pulls (fixed Fitbit endpoints only)
    // =====================================================================================

    /// <summary>Pull the day's activity summary (steps, distance, active calories) + resting HR. Steps land
    /// only when SyncSteps is on; resting HR only when SyncHeartRate is on.</summary>
    private async Task<(HealthPullStatus, DailySummary?)> PullActivityAsync(
        string accessToken, string date, HealthConnection conn, CancellationToken ct)
    {
        int? steps = null, distanceMeters = null, activeCalories = null, restingHr = null;

        if (conn.SyncSteps)
        {
            var (status, doc) = await ApiGetAsync($"/1/user/-/activities/date/{date}.json", accessToken, ct);
            if (status != HealthPullStatus.Ok) return (status, null);
            using (doc)
            {
                if (doc!.RootElement.TryGetProperty("summary", out var summary) && summary.ValueKind == JsonValueKind.Object)
                {
                    steps = GetInt(summary, "steps");
                    activeCalories = GetInt(summary, "activityCalories") ?? GetInt(summary, "caloriesOut");
                    distanceMeters = ReadTotalDistanceMeters(summary);
                }
            }
        }

        if (conn.SyncHeartRate)
        {
            var (status, doc) = await ApiGetAsync($"/1/user/-/activities/heart/date/{date}/1d.json", accessToken, ct);
            // HR is a soft signal: a plain Error (no data / not enabled) doesn't fail the whole day — only
            // auth/rate-limit short-circuits. Steps may have already populated the summary.
            if (status is HealthPullStatus.AuthExpired or HealthPullStatus.RateLimited) return (status, null);
            if (status == HealthPullStatus.Ok && doc is not null)
                using (doc)
                    restingHr = ReadRestingHeartRate(doc.RootElement);
        }

        if (steps is null && distanceMeters is null && activeCalories is null && restingHr is null)
            return (HealthPullStatus.Ok, null);
        return (HealthPullStatus.Ok, new DailySummary(steps, distanceMeters, activeCalories, restingHr));
    }

    /// <summary>Pull sleep logs for the date (Fitbit's sleep "date" is the WAKE date — the same convention
    /// SleepEntry uses). Each log is keyed by its vendor logId.</summary>
    private async Task<(HealthPullStatus, IReadOnlyList<SleepRecord>)> PullSleepAsync(
        string accessToken, string date, CancellationToken ct)
    {
        var (status, doc) = await ApiGetAsync($"/1.2/user/-/sleep/date/{date}.json", accessToken, ct);
        if (status != HealthPullStatus.Ok) return (status, Array.Empty<SleepRecord>());
        using (doc)
        {
            var list = new List<SleepRecord>();
            if (doc!.RootElement.TryGetProperty("sleep", out var sleeps) && sleeps.ValueKind == JsonValueKind.Array)
                foreach (var s in sleeps.EnumerateArray())
                {
                    var rec = MapSleep(s);
                    if (rec is not null) list.Add(rec);
                }
            return (HealthPullStatus.Ok, list);
        }
    }

    /// <summary>Pull the day's workouts (the activity log list filtered to the date). Each is keyed by its
    /// vendor logId.</summary>
    private async Task<(HealthPullStatus, IReadOnlyList<WorkoutRecord>)> PullWorkoutsAsync(
        string accessToken, string date, CancellationToken ct)
    {
        var path = $"/1/user/-/activities/list.json?afterDate={date}&sort=asc&offset=0&limit=20";
        var (status, doc) = await ApiGetAsync(path, accessToken, ct);
        if (status != HealthPullStatus.Ok) return (status, Array.Empty<WorkoutRecord>());
        using (doc)
        {
            var list = new List<WorkoutRecord>();
            if (doc!.RootElement.TryGetProperty("activities", out var acts) && acts.ValueKind == JsonValueKind.Array)
                foreach (var a in acts.EnumerateArray())
                {
                    // Keep only activities that START on the requested local date (Fitbit's afterDate is
                    // inclusive but can return later days; the mapper anchors each to its own start date).
                    var startDate = ReadActivityLocalDate(a);
                    if (startDate is null || startDate != date) continue;
                    var rec = MapWorkout(a);
                    if (rec is not null) list.Add(rec);
                }
            return (HealthPullStatus.Ok, list);
        }
    }

    // =====================================================================================
    // Access-token minting (refresh-token grant) — RE-STORES the ROTATED refresh token
    // =====================================================================================

    /// <summary>
    /// Decrypt the connection's stored refresh token and mint a fresh access token. CRITICAL: Fitbit returns
    /// a NEW refresh token on every refresh and invalidates the old one, so the rotated token is RE-STORED
    /// (encrypted) before the access token is returned. A revoked/expired token (Fitbit 400/401) surfaces as
    /// AuthExpired and stamps the connection so the UI can prompt a reconnect (the row is kept, not deleted).
    /// </summary>
    private async Task<(HealthPullStatus Status, string? Value)> MintAccessTokenAsync(
        HealthConnection conn, CancellationToken ct)
    {
        if (!IsConfigured) return (HealthPullStatus.NotConfigured, null);

        var refreshToken = protector.Unprotect(conn.EncryptedRefreshToken);
        if (string.IsNullOrEmpty(refreshToken))
        {
            logger.LogWarning("Fitbit: stored refresh token for connection {Id} could not be decrypted.", conn.Id);
            return (HealthPullStatus.AuthExpired, null);
        }

        try
        {
            var form = new Dictionary<string, string>
            {
                ["grant_type"] = "refresh_token",
                ["refresh_token"] = refreshToken,
                ["client_id"] = _opts.ClientId!,
            };

            var (doc, statusCode) = await PostTokenAsync(form, ct);
            if (doc is null)
            {
                // 400/401 from the token endpoint => the refresh token is dead (revoked / already rotated).
                if (statusCode is HttpStatusCode.BadRequest or HttpStatusCode.Unauthorized)
                {
                    await StampStatusAsync(conn, HealthSyncStatus.AuthExpired, ct);
                    return (HealthPullStatus.AuthExpired, null);
                }
                if (statusCode == HttpStatusCode.TooManyRequests)
                    return (HealthPullStatus.RateLimited, null);
                return (HealthPullStatus.Error, null);
            }

            using var _doc = doc;
            var root = doc.RootElement;
            var accessToken = GetStr(root, "access_token");
            if (string.IsNullOrEmpty(accessToken)) return (HealthPullStatus.Error, null);

            // ROTATE: persist the NEW refresh token (Fitbit invalidated the old one). This is the #1
            // correctness rule — without it the next sync's refresh fails with invalid_grant. The refresh
            // HTTP call already succeeded (the old token is dead server-side), so the re-store MUST complete:
            // use CancellationToken.None so a cancel here (host shutdown / caller ct) can't strand the rotated
            // token and permanently brick the connection.
            var rotated = GetStr(root, "refresh_token");
            var now = DateTime.UtcNow;
            if (!string.IsNullOrEmpty(rotated))
            {
                var enc = protector.Protect(rotated);
                conn.EncryptedRefreshToken = enc;
                await db.HealthConnections.Where(c => c.Id == conn.Id)
                    .ExecuteUpdateAsync(s => s
                        .SetProperty(c => c.EncryptedRefreshToken, enc)
                        .SetProperty(c => c.LastUsedUtc, now), CancellationToken.None);
            }
            else
            {
                await db.HealthConnections.Where(c => c.Id == conn.Id)
                    .ExecuteUpdateAsync(s => s.SetProperty(c => c.LastUsedUtc, now), ct);
            }

            return (HealthPullStatus.Ok, accessToken);
        }
        catch (Exception ex)
        {
            logger.LogWarning("Fitbit token refresh failed: {Reason}", ex.Message);
            return (HealthPullStatus.Error, null);
        }
    }

    // =====================================================================================
    // HTTP helpers (fixed Fitbit endpoints only)
    // =====================================================================================

    /// <summary>POST the token endpoint with HTTP Basic auth (client_id:client_secret) per Fitbit's spec.
    /// The status code is surfaced so the caller can distinguish a dead token (400/401) from a transient
    /// error. Never logs the body (it would echo the code/secret/token).</summary>
    private async Task<(JsonDocument? Doc, HttpStatusCode Status)> PostTokenAsync(
        Dictionary<string, string> form, CancellationToken ct)
    {
        try
        {
            var client = httpFactory.CreateClient(HttpClientName);
            using var req = new HttpRequestMessage(HttpMethod.Post, TokenEndpoint)
            {
                Content = new FormUrlEncodedContent(form),
            };
            var basic = Convert.ToBase64String(Encoding.UTF8.GetBytes($"{_opts.ClientId}:{_opts.ClientSecret}"));
            req.Headers.Authorization = new AuthenticationHeaderValue("Basic", basic);

            using var res = await client.SendAsync(req, ct);
            if (!res.IsSuccessStatusCode)
            {
                logger.LogWarning("Fitbit token endpoint returned {Status}.", (int)res.StatusCode);
                return (null, res.StatusCode);
            }
            var bytes = await ReadCappedAsync(res, ct);
            return (bytes is null ? null : JsonDocument.Parse(bytes), res.StatusCode);
        }
        catch (Exception ex)
        {
            logger.LogWarning("Fitbit token request failed: {Reason}", ex.Message);
            return (null, HttpStatusCode.InternalServerError);
        }
    }

    private async Task<(HealthPullStatus, JsonDocument?)> ApiGetAsync(string path, string accessToken, CancellationToken ct)
    {
        try
        {
            var client = httpFactory.CreateClient(HttpClientName);
            using var req = new HttpRequestMessage(HttpMethod.Get, ApiBase + path);
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
            req.Headers.AcceptLanguage.ParseAdd("en_US"); // metric-friendly: distances come back in km we convert.
            using var res = await client.SendAsync(req, ct);
            if (res.IsSuccessStatusCode)
            {
                var bytes = await ReadCappedAsync(res, ct);
                if (bytes is null)
                {
                    logger.LogWarning("Fitbit GET {Path} response exceeded the size cap.", path);
                    return (HealthPullStatus.Error, null);
                }
                return (HealthPullStatus.Ok, JsonDocument.Parse(bytes));
            }
            if (res.StatusCode == HttpStatusCode.TooManyRequests) return (HealthPullStatus.RateLimited, null);
            if (res.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
                return (HealthPullStatus.AuthExpired, null);
            logger.LogWarning("Fitbit GET {Path} returned {Status}.", path, (int)res.StatusCode);
            return (HealthPullStatus.Error, null);
        }
        catch (Exception ex)
        {
            logger.LogWarning("Fitbit GET failed: {Reason}", ex.Message);
            return (HealthPullStatus.Error, null);
        }
    }

    /// <summary>Max bytes we will buffer from a Fitbit token/API response. These are small JSON payloads;
    /// the cap stops a hostile/MITM'd endpoint from driving an unbounded allocation on the sync thread.</summary>
    private const int MaxResponseBytes = 256 * 1024;

    /// <summary>Read the response body into memory with a hard ceiling. Returns null (rather than allocating
    /// the whole body) once the stream exceeds <see cref="MaxResponseBytes"/>.</summary>
    private static async Task<byte[]?> ReadCappedAsync(HttpResponseMessage res, CancellationToken ct)
    {
        // Trust the header only as an early reject; an unset/lying length still hits the streamed guard below.
        if (res.Content.Headers.ContentLength is > MaxResponseBytes) return null;

        await using var stream = await res.Content.ReadAsStreamAsync(ct);
        using var buffer = new MemoryStream();
        var chunk = new byte[8192];
        int read;
        while ((read = await stream.ReadAsync(chunk, ct)) > 0)
        {
            if (buffer.Length + read > MaxResponseBytes) return null;
            buffer.Write(chunk, 0, read);
        }
        return buffer.ToArray();
    }

    private async Task StampStatusAsync(HealthConnection conn, HealthSyncStatus status, CancellationToken ct)
    {
        try
        {
            await db.HealthConnections.Where(c => c.Id == conn.Id)
                .ExecuteUpdateAsync(s => s.SetProperty(c => c.LastSyncStatus, status), ct);
        }
        catch { /* bookkeeping only */ }
    }

    // =====================================================================================
    // Mapping + JSON helpers
    // =====================================================================================

    /// <summary>Fitbit's activity summary carries a "distances" array; the "total" entry is in km — convert
    /// to whole metres to match DailyActivity's metric storage.</summary>
    private static int? ReadTotalDistanceMeters(JsonElement summary)
    {
        if (!summary.TryGetProperty("distances", out var distances) || distances.ValueKind != JsonValueKind.Array)
            return null;
        foreach (var d in distances.EnumerateArray())
        {
            if (d.ValueKind != JsonValueKind.Object) continue;
            if (string.Equals(GetStr(d, "activity"), "total", StringComparison.OrdinalIgnoreCase)
                && d.TryGetProperty("distance", out var dist) && dist.ValueKind == JsonValueKind.Number)
                return (int)Math.Round(dist.GetDouble() * 1000.0);
        }
        return null;
    }

    /// <summary>Read resting HR from the heart-rate intraday summary (activities-heart[0].value.restingHeartRate).</summary>
    private static int? ReadRestingHeartRate(JsonElement root)
    {
        if (!root.TryGetProperty("activities-heart", out var arr) || arr.ValueKind != JsonValueKind.Array
            || arr.GetArrayLength() == 0)
            return null;
        var first = arr[0];
        if (first.ValueKind == JsonValueKind.Object && first.TryGetProperty("value", out var val)
            && val.ValueKind == JsonValueKind.Object)
            return GetInt(val, "restingHeartRate");
        return null;
    }

    /// <summary>Map a Fitbit sleep log to a normalized record (hours from minutesAsleep, bed/wake from the
    /// log's startTime/endTime, quality bucketed off the efficiency 0–100 → 1–5).</summary>
    private static SleepRecord? MapSleep(JsonElement s)
    {
        if (s.ValueKind != JsonValueKind.Object) return null;
        var logId = ReadLogId(s, "logId");
        if (string.IsNullOrEmpty(logId)) return null;

        var minutes = GetInt(s, "minutesAsleep") ?? 0;
        var hours = Math.Round((decimal)minutes / 60m, 1);

        TimeOnly? bed = ParseLocalTime(GetStr(s, "startTime"));
        TimeOnly? wake = ParseLocalTime(GetStr(s, "endTime"));

        // Efficiency (0..100) → a coarse 1..5 quality. Default to 3 (neutral) when absent.
        var efficiency = GetInt(s, "efficiency");
        var quality = efficiency switch
        {
            null => 3,
            >= 95 => 5,
            >= 85 => 4,
            >= 70 => 3,
            >= 50 => 2,
            _ => 1,
        };

        return new SleepRecord(logId, hours, bed, wake, quality);
    }

    /// <summary>Map a Fitbit activity-log entry to a normalized workout (name, duration in minutes, calories).</summary>
    private static WorkoutRecord? MapWorkout(JsonElement a)
    {
        if (a.ValueKind != JsonValueKind.Object) return null;
        var logId = ReadLogId(a, "logId");
        if (string.IsNullOrEmpty(logId)) return null;

        var name = GetStr(a, "activityName") ?? GetStr(a, "name") ?? "Workout";
        if (name.Length > 128) name = name[..128];

        // Fitbit reports duration in MILLISECONDS.
        int? durationMin = null;
        if (a.TryGetProperty("duration", out var dur) && dur.ValueKind == JsonValueKind.Number)
        {
            var mins = (int)Math.Round(dur.GetDouble() / 60000.0);
            if (mins > 0) durationMin = mins;
        }

        var calories = GetInt(a, "calories") ?? 0;
        return new WorkoutRecord(logId, name, durationMin, Math.Max(0, calories));
    }

    /// <summary>The local START date (yyyy-MM-dd) of a Fitbit activity-log entry, from its startTime.</summary>
    private static string? ReadActivityLocalDate(JsonElement a)
    {
        var start = GetStr(a, "startTime");
        if (string.IsNullOrEmpty(start)) return null;
        // Fitbit startTime is local wall-clock with an offset, e.g. "2026-06-27T07:15:00.000-04:00".
        return DateTimeOffset.TryParse(start, CultureInfo.InvariantCulture, DateTimeStyles.None, out var dto)
            ? dto.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture)
            : (start.Length >= 10 ? start[..10] : null);
    }

    /// <summary>Read a logId that may come back as a JSON number or string.</summary>
    private static string? ReadLogId(JsonElement el, string prop)
    {
        if (!el.TryGetProperty(prop, out var v)) return null;
        return v.ValueKind switch
        {
            JsonValueKind.Number => v.GetInt64().ToString(CultureInfo.InvariantCulture),
            JsonValueKind.String => v.GetString(),
            _ => null,
        };
    }

    /// <summary>Parse a Fitbit local wall-clock datetime ("2026-06-27T23:10:30.000") into a TimeOnly.</summary>
    private static TimeOnly? ParseLocalTime(string? s)
    {
        if (string.IsNullOrWhiteSpace(s)) return null;
        if (DateTime.TryParse(s, CultureInfo.InvariantCulture, DateTimeStyles.None, out var dt))
            return TimeOnly.FromDateTime(dt);
        return null;
    }

    private static int? GetInt(JsonElement el, string prop)
    {
        if (el.ValueKind != JsonValueKind.Object || !el.TryGetProperty(prop, out var v)) return null;
        if (v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var i)) return i;
        if (v.ValueKind == JsonValueKind.Number) return (int)Math.Round(v.GetDouble());
        if (v.ValueKind == JsonValueKind.String && int.TryParse(v.GetString(), out var si)) return si;
        return null;
    }

    private static string? GetStr(JsonElement el, string prop) =>
        el.ValueKind == JsonValueKind.Object && el.TryGetProperty(prop, out var v) && v.ValueKind == JsonValueKind.String
            ? v.GetString() : null;

    private static string? Trunc(string? s, int max) =>
        string.IsNullOrEmpty(s) ? s : (s.Length > max ? s[..max] : s);

    private static bool IsUniqueViolation(DbUpdateException ex) =>
        ex.InnerException is Npgsql.PostgresException pg && pg.SqlState == Npgsql.PostgresErrorCodes.UniqueViolation;
}
