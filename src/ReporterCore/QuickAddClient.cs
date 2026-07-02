using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace Ccusage.Reporter.Core;

/// <summary>The quick-add request body POSTed to <c>/api/family/quick-add</c>. The agent always sends
/// <c>kind = "auto"</c> and lets the server route the text to a list item / reminder / note.</summary>
public sealed record QuickAddRequest(string Text, string Kind);

/// <summary>The server's reply: the RESOLVED kind, the new item id, and a warm one-line summary to toast.</summary>
public sealed record QuickAddResponse(string Kind, long CreatedId, string Summary);

/// <summary>
/// Posts a one-line family quick-add to <c>/api/family/quick-add</c> using the SAME <c>X-Ingest-Key</c>
/// credential + server URL the reporter already uses for <c>/api/ingest</c> — so the tray app can jot a
/// note without a browser. The endpoint resolves the acting user from the key's OWNER server-side; no
/// identity is sent on the wire. Errors are surfaced as a short message for the tray notification:
/// a rejected key (401/403) or a missing-permission (the owner lacks family.use, also 403) is fatal-ish
/// for THIS action (no retry); a transient 429/5xx is retried briefly.
/// </summary>
public sealed class QuickAddClient : IDisposable
{
    private const string Version = "usage-iq-agent-quickadd/1.0";
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private readonly HttpClient _http;

    public QuickAddClient(string baseUrl, string key)
    {
        var baseAddress = new Uri(baseUrl.TrimEnd('/') + "/");
        // The X-Ingest-Key is a bearer secret; over plain http to a non-local host it travels in
        // cleartext and can be MITM'd. Refuse to send it rather than leak it (the console reporter
        // warns; the tray has no console, so we hard-fail before constructing the client).
        if (baseAddress.Scheme == "http" && !baseAddress.IsLoopback)
            throw new QuickAddException("Server URL is http:// to a non-local host — refusing to send your key in cleartext. Use https in Settings.");

        // AllowAutoRedirect = false so the X-Ingest-Key credential is never re-sent to a redirect
        // target on a different host: .NET strips Authorization on cross-origin redirects but not
        // custom headers, so an auto-followed 3xx would otherwise leak it (mirrors IngestClient).
        var handler = new HttpClientHandler { AllowAutoRedirect = false };
        _http = new HttpClient(handler)
        {
            BaseAddress = baseAddress,
            Timeout = TimeSpan.FromSeconds(30),
        };
        _http.DefaultRequestHeaders.Add("X-Ingest-Key", key);
        _http.DefaultRequestHeaders.UserAgent.ParseAdd(Version);
    }

    /// <summary>
    /// Send <paramref name="text"/> as an auto-routed quick-add. Returns the server's summary on success;
    /// throws <see cref="QuickAddException"/> with a user-facing message on any failure (the caller shows
    /// it as a tray notification). A couple of transient retries smooth over a rate-limit window boundary.
    /// </summary>
    public async Task<QuickAddResponse> AddAsync(string text, CancellationToken ct)
    {
        var body = new QuickAddRequest(text, "auto");
        const int maxAttempts = 3;

        for (var attempt = 1; ; attempt++)
        {
            try
            {
                using var resp = await _http.PostAsJsonAsync("api/family/quick-add", body, Json, ct);

                if (resp.StatusCode is HttpStatusCode.Unauthorized)
                    throw new QuickAddException("Your ingest key was rejected. Check it in Settings.");
                if (resp.StatusCode is HttpStatusCode.Forbidden)
                    throw new QuickAddException("This account can't use Family quick-add (needs the family.use permission).");

                if ((int)resp.StatusCode == 429 || (int)resp.StatusCode >= 500)
                {
                    if (attempt >= maxAttempts)
                        throw new QuickAddException("Usage IQ is busy right now — please try again in a moment.");
                    await Task.Delay(TimeSpan.FromSeconds(Math.Min(8, Math.Pow(2, attempt))), ct);
                    continue;
                }

                if (!resp.IsSuccessStatusCode)
                    throw new QuickAddException($"Quick-add failed ({(int)resp.StatusCode}).");

                var result = await resp.Content.ReadFromJsonAsync<QuickAddResponse>(Json, ct);
                return result ?? throw new QuickAddException("Quick-add returned an empty response.");
            }
            catch (QuickAddException) { throw; }
            catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException && !ct.IsCancellationRequested)
            {
                if (attempt >= maxAttempts)
                    throw new QuickAddException("Couldn't reach Usage IQ — check your connection and server URL.");
                await Task.Delay(TimeSpan.FromSeconds(Math.Min(8, Math.Pow(2, attempt))), ct);
            }
        }
    }

    public void Dispose() => _http.Dispose();
}

/// <summary>A quick-add failure carrying a short, user-facing message ready for a tray notification.</summary>
public sealed class QuickAddException(string message) : Exception(message);
