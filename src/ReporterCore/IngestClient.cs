using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Ccusage.Api.Ingestion;

namespace Ccusage.Reporter.Core;

/// <summary>Thrown for unrecoverable conditions (e.g. a rejected key) — the run should stop, not retry.</summary>
public sealed class FatalReporterException(string message) : Exception(message);

/// <summary>
/// The batch envelope POSTed to <c>/api/ingest</c>. Rows are parsed locally; no transcript text leaves
/// the box. <see cref="MachineInfo"/> carries the machine metadata for the Fleet page (camelCase
/// <c>machineInfo</c> on the wire); it is gathered once and attached to every batch.
/// </summary>
public sealed record IngestBatch(
    string Source, string Machine, string Reporter, MachineInfo MachineInfo, IReadOnlyList<ParsedUsage> Rows);

/// <summary>Server's response to an ingest batch.</summary>
public sealed record IngestResult(int Received, int Inserted, long InsertedTokens, int Duplicates, int Skipped, string[]? UnpricedModels);

/// <summary>
/// Posts batches to the Usage IQ ingest endpoint with the <c>X-Ingest-Key</c> credential. Transient
/// failures (timeouts, 5xx, 429) are retried with exponential backoff; an auth rejection is fatal.
/// </summary>
public sealed class IngestClient : IDisposable
{
    private const string Version = "usage-iq-reporter/1.0";
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private readonly HttpClient _http;
    private readonly string _machine;
    private readonly MachineInfo _machineInfo;

    public IngestClient(string baseUrl, string key, string machine, MachineInfo machineInfo)
    {
        _machine = machine;
        _machineInfo = machineInfo;
        // AllowAutoRedirect = false so the X-Ingest-Key credential is never re-sent to a redirect
        // target on a different host: .NET strips Authorization on cross-origin redirects but not
        // custom headers, so an auto-followed 3xx (or a cleartext-http MITM) would otherwise leak it.
        var handler = new HttpClientHandler { AllowAutoRedirect = false };
        _http = new HttpClient(handler) { BaseAddress = new Uri(baseUrl.TrimEnd('/') + "/"), Timeout = TimeSpan.FromSeconds(100) };
        _http.DefaultRequestHeaders.Add("X-Ingest-Key", key);
        _http.DefaultRequestHeaders.UserAgent.ParseAdd(Version);
    }

    public async Task<IngestResult> PushAsync(string source, IReadOnlyList<ParsedUsage> rows, CancellationToken ct)
    {
        var batch = new IngestBatch(source, _machine, Version, _machineInfo, rows);
        // Patient enough that a transient 429 near a 1-minute rate-limit window boundary recovers.
        const int maxAttempts = 6;

        for (var attempt = 1; ; attempt++)
        {
            try
            {
                using var resp = await _http.PostAsJsonAsync("api/ingest", batch, Json, ct);

                if (resp.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
                    throw new FatalReporterException("Ingest key was rejected (401/403). Check the key and the URL.");

                if ((int)resp.StatusCode == 429 || (int)resp.StatusCode >= 500)
                {
                    if (attempt >= maxAttempts)
                        throw new HttpRequestException($"Server returned {(int)resp.StatusCode} after {attempt} attempts.");
                    await BackoffAsync(attempt, ct);
                    continue;
                }

                resp.EnsureSuccessStatusCode(); // 4xx (other than 401/403/429) → surface as error
                return await resp.Content.ReadFromJsonAsync<IngestResult>(Json, ct)
                       ?? new IngestResult(rows.Count, 0, 0, 0, 0, null);
            }
            catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException && !ct.IsCancellationRequested)
            {
                if (attempt >= maxAttempts) throw;
                await BackoffAsync(attempt, ct);
            }
        }
    }

    private static Task BackoffAsync(int attempt, CancellationToken ct) =>
        Task.Delay(TimeSpan.FromSeconds(Math.Min(45, Math.Pow(2, attempt))), ct);

    public void Dispose() => _http.Dispose();
}
