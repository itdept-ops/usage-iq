using System.Text.Json;
using Ccusage.Api.Dtos;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Options;

namespace Ccusage.Api.Services;

/// <summary>
/// Wraps the WorkoutX exercise catalog (<c>https://api.workoutxapp.com</c>): browse/search the
/// 1300+ exercise library and proxy the per-exercise GIF demo. The API key travels ONLY as the
/// <c>X-WorkoutX-Key</c> request header and is NEVER logged. The host is fixed (from
/// <see cref="WorkoutXOptions.BaseUrl"/>), never chosen from user input, so there is no SSRF surface.
///
/// ROBUSTNESS: any failure on a search — a network error, a non-success status (401/403 = bad/missing
/// key), a timeout, or a malformed body — is logged with a concise reason (never the key) and yields an
/// EMPTY result. <see cref="SearchAsync"/> never throws, so a flaky provider can't break the tracker.
/// Search responses are cached in memory (~10 min, keyed by the param tuple). The endpoint layer maps the
/// unconfigured case to a 503 ProblemDetails before calling here; the rest of the tracker keeps working.
///
/// GIFs require the key: the provider returns 401 for <c>/v1/gifs/{id}.gif</c> without the header, so the
/// browser cannot load <c>gifUrl</c> directly. <see cref="GetGifAsync"/> fetches the bytes server-side
/// with the key and the endpoint streams them back over the JWT-authorized API. The id is validated to be
/// digits only (it is interpolated into the upstream path), so it can never traverse to another resource.
/// </summary>
public sealed class WorkoutXService(
    IHttpClientFactory httpFactory,
    IOptions<WorkoutXOptions> options,
    IMemoryCache cache,
    ILogger<WorkoutXService> logger)
{
    public const string HttpClientName = "workoutx";
    private static readonly TimeSpan CacheTtl = TimeSpan.FromMinutes(10);
    private const string KeyHeader = "X-WorkoutX-Key";

    // Hard ceiling on a proxied GIF body. The bytes are buffered in-process, so an oversized (or
    // compromised/MITM'd) upstream response could exhaust memory; reject anything larger. 8 MB is well
    // above any real exercise demo GIF.
    private const long MaxGifBytes = 8 * 1024 * 1024;

    // Hard ceiling on a search JSON body. A full 100-item page of exercise metadata is well under this;
    // reject anything larger so a compromised/MITM'd upstream can't force an unbounded in-process buffer.
    private const long MaxSearchBytes = 4 * 1024 * 1024;

    // The free-text param: probed live, only ?name= filters (substring match, combinable with the
    // bodyPart/target/equipment filters). ?q=, ?query=, and ?search= are ignored (return all 1327).
    private const string SearchParam = "name";

    private readonly WorkoutXOptions _opt = options.Value;

    public bool IsConfigured => _opt.IsConfigured;

    /// <summary>
    /// One GIF's bytes + content type. <see cref="ContentType"/> is always the fixed, safe
    /// <c>image/gif</c> — the upstream-supplied Content-Type is NOT reflected to the browser (so a
    /// compromised provider can't make the trusted-origin API serve a renderable non-image media type).
    /// </summary>
    public readonly record struct GifResult(byte[] Bytes, string ContentType);

    /// <summary>
    /// Browse/search the catalog. <paramref name="query"/> is a free-text name filter (substring);
    /// <paramref name="bodyPart"/>/<paramref name="target"/>/<paramref name="equipment"/> are the
    /// confirmed server-side filters. Returns a page of normalized exercises plus the filter-wide total
    /// (for pagination). Empty on any failure / when unconfigured — never throws.
    /// </summary>
    public async Task<WorkoutXSearchResultDto> SearchAsync(
        string? query, string? bodyPart, string? target, string? equipment,
        int limit, int offset, CancellationToken ct = default)
    {
        if (!IsConfigured) return Empty();

        var name = (query ?? "").Trim();
        var bp = (bodyPart ?? "").Trim();
        var tg = (target ?? "").Trim();
        var eq = (equipment ?? "").Trim();
        limit = Math.Clamp(limit <= 0 ? 24 : limit, 1, 100);
        offset = Math.Max(0, offset);

        var cacheKey = $"workoutx:search:{name.ToLowerInvariant()}|{bp.ToLowerInvariant()}|"
                       + $"{tg.ToLowerInvariant()}|{eq.ToLowerInvariant()}|{limit}|{offset}";
        if (cache.TryGetValue(cacheKey, out WorkoutXSearchResultDto? cached) && cached is not null)
            return cached;

        try
        {
            // The key is a header (set per-client below), so only safe query params travel in the URL.
            var url = $"{BaseTrimmed()}/v1/exercises?limit={limit}&offset={offset}";
            if (name.Length > 0) url += $"&{SearchParam}={Uri.EscapeDataString(name)}";
            if (bp.Length > 0) url += $"&bodyPart={Uri.EscapeDataString(bp)}";
            if (tg.Length > 0) url += $"&target={Uri.EscapeDataString(tg)}";
            if (eq.Length > 0) url += $"&equipment={Uri.EscapeDataString(eq)}";

            var client = httpFactory.CreateClient(HttpClientName);
            using var req = new HttpRequestMessage(HttpMethod.Get, url);
            req.Headers.Add(KeyHeader, _opt.ApiKey);

            using var res = await client.SendAsync(req, ct);
            if (!res.IsSuccessStatusCode)
            {
                // Never log the key; a 401/403 means the key is bad/missing.
                logger.LogWarning("WorkoutX exercises returned {Status}.", (int)res.StatusCode);
                return Empty();
            }

            var bytes = await ReadCappedAsync(res, MaxSearchBytes, ct);
            if (bytes is null) return Empty();
            using var doc = JsonDocument.Parse(bytes);
            var result = ParseSearch(doc.RootElement);

            cache.Set(cacheKey, result, CacheTtl);
            return result;
        }
        catch (Exception ex)
        {
            logger.LogWarning("WorkoutX search failed: {Reason}", ex.Message);
            return Empty();
        }
    }

    /// <summary>
    /// Fetch one exercise's GIF demo with the key. Returns null when the id is invalid (not digits), the
    /// gif is missing (404), or any failure occurs — never throws. The id is validated against
    /// <see cref="IsValidGifId"/> before it's interpolated into the upstream path.
    /// </summary>
    public async Task<GifResult?> GetGifAsync(string id, CancellationToken ct = default)
    {
        if (!IsConfigured) return null;
        if (!IsValidGifId(id)) return null;

        try
        {
            var url = $"{BaseTrimmed()}/v1/gifs/{id}.gif";
            var client = httpFactory.CreateClient(HttpClientName);
            using var req = new HttpRequestMessage(HttpMethod.Get, url);
            req.Headers.Add(KeyHeader, _opt.ApiKey);

            using var res = await client.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct);
            if (!res.IsSuccessStatusCode)
            {
                logger.LogWarning("WorkoutX gif returned {Status}.", (int)res.StatusCode);
                return null;
            }

            // Fail fast on an advertised oversized body...
            if (res.Content.Headers.ContentLength is long declared && declared > MaxGifBytes)
            {
                logger.LogWarning("WorkoutX gif too large ({Bytes} bytes); rejected.", declared);
                return null;
            }

            // ...and enforce the ceiling against the actual stream (Content-Length can be absent or lie),
            // so the whole payload is never buffered unbounded in process memory.
            var bytes = await ReadCappedAsync(res, MaxGifBytes, ct);
            if (bytes is null) return null;

            // Do NOT trust the upstream Content-Type — force the fixed, safe image/gif. The endpoint pairs
            // this with X-Content-Type-Options: nosniff so the browser can't reinterpret the bytes.
            return new GifResult(bytes, "image/gif");
        }
        catch (Exception ex)
        {
            logger.LogWarning("WorkoutX gif fetch failed: {Reason}", ex.Message);
            return null;
        }
    }

    /// <summary>
    /// Read the response body into a buffer, aborting (returns null) the moment it exceeds
    /// <paramref name="maxBytes"/>. Bounds per-request memory even when the upstream omits or lies about
    /// Content-Length.
    /// </summary>
    private async Task<byte[]?> ReadCappedAsync(HttpResponseMessage res, long maxBytes, CancellationToken ct)
    {
        await using var stream = await res.Content.ReadAsStreamAsync(ct);
        using var buffer = new MemoryStream();
        var chunk = new byte[81920];
        int read;
        while ((read = await stream.ReadAsync(chunk.AsMemory(), ct)) > 0)
        {
            if (buffer.Length + read > maxBytes)
            {
                logger.LogWarning("WorkoutX response exceeded {Max} bytes; rejected.", maxBytes);
                return null;
            }
            buffer.Write(chunk, 0, read);
        }
        return buffer.ToArray();
    }

    /// <summary>
    /// A valid WorkoutX gif id is 1–8 digits (the catalog uses zero-padded ids like "0001"). Restricting
    /// to digits keeps it from traversing the upstream path (no '.', '/', or '..').
    /// </summary>
    public static bool IsValidGifId(string? id) =>
        !string.IsNullOrEmpty(id) && id.Length <= 8 && id.All(char.IsDigit);

    /// <summary>
    /// caloriesBurned = round(caloriesPerMinute * durationMin). WorkoutX provides caloriesPerMinute
    /// directly, so the estimate is independent of body weight (unlike the MET-based library estimate).
    /// Non-positive inputs yield 0.
    /// </summary>
    public static int EstimateCalories(double caloriesPerMinute, int durationMin)
    {
        if (caloriesPerMinute <= 0 || durationMin <= 0) return 0;
        return (int)Math.Round(caloriesPerMinute * durationMin, MidpointRounding.AwayFromZero);
    }

    // ===================================================================================
    // Parsing (exposed for unit tests)
    // ===================================================================================

    /// <summary>
    /// Normalize a <c>{ total, count, data: [...] }</c> WorkoutX exercises response into a result page.
    /// Tolerates a missing/null total (falls back to the data length) and a missing/non-array data
    /// (yields an empty page). Exposed so the normalization can be unit-tested over a sample payload.
    /// </summary>
    public static WorkoutXSearchResultDto ParseSearch(JsonElement root)
    {
        var data = new List<WorkoutXExerciseDto>();
        if (root.ValueKind == JsonValueKind.Object
            && root.TryGetProperty("data", out var arr) && arr.ValueKind == JsonValueKind.Array)
        {
            foreach (var el in arr.EnumerateArray())
            {
                var item = ParseOne(el);
                if (item is not null) data.Add(item);
            }
        }

        var total = GetInt(root, "total") ?? data.Count;
        return new WorkoutXSearchResultDto { Total = total, Data = data.ToArray() };
    }

    private static WorkoutXExerciseDto? ParseOne(JsonElement el)
    {
        if (el.ValueKind != JsonValueKind.Object) return null;
        var id = GetString(el, "id");
        var name = GetString(el, "name");
        if (string.IsNullOrEmpty(id) || string.IsNullOrEmpty(name)) return null;

        return new WorkoutXExerciseDto
        {
            Id = id!,
            Name = name!,
            BodyPart = GetString(el, "bodyPart") ?? "",
            Equipment = GetString(el, "equipment") ?? "",
            Target = GetString(el, "target") ?? "",
            SecondaryMuscles = GetStringArray(el, "secondaryMuscles"),
            Instructions = GetStringArray(el, "instructions"),
            Category = GetString(el, "category") ?? "",
            Difficulty = GetString(el, "difficulty") ?? "",
            Met = GetDouble(el, "met") ?? 0,
            CaloriesPerMinute = GetDouble(el, "caloriesPerMinute") ?? 0,
            Description = GetString(el, "description"),
            // Provider sends these as strings ("3", "10-15") but tolerate a numeric just in case.
            RecommendedSets = GetStringOrNumber(el, "recommendedSets"),
            RecommendedReps = GetStringOrNumber(el, "recommendedReps"),
        };
    }

    // ===================================================================================
    // Helpers
    // ===================================================================================

    private static WorkoutXSearchResultDto Empty() =>
        new() { Total = 0, Data = Array.Empty<WorkoutXExerciseDto>() };

    private string BaseTrimmed() => (_opt.BaseUrl ?? "").TrimEnd('/');

    // TryGetProperty throws on a non-object element, so every accessor guards on the kind first — that
    // keeps ParseSearch total-tolerant of any JSON shape (e.g. a bare array) without throwing.
    private static bool TryProp(JsonElement el, string prop, out JsonElement value)
    {
        if (el.ValueKind == JsonValueKind.Object) return el.TryGetProperty(prop, out value);
        value = default;
        return false;
    }

    private static string? GetString(JsonElement el, string prop) =>
        TryProp(el, prop, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static string? GetStringOrNumber(JsonElement el, string prop)
    {
        if (!TryProp(el, prop, out var v)) return null;
        return v.ValueKind switch
        {
            JsonValueKind.String => v.GetString(),
            JsonValueKind.Number => v.GetRawText(),
            _ => null,
        };
    }

    private static string[] GetStringArray(JsonElement el, string prop)
    {
        if (!TryProp(el, prop, out var v) || v.ValueKind != JsonValueKind.Array)
            return Array.Empty<string>();
        var list = new List<string>();
        foreach (var item in v.EnumerateArray())
            if (item.ValueKind == JsonValueKind.String && item.GetString() is { Length: > 0 } s)
                list.Add(s);
        return list.ToArray();
    }

    private static int? GetInt(JsonElement el, string prop)
    {
        if (!TryProp(el, prop, out var v)) return null;
        return v.ValueKind switch
        {
            JsonValueKind.Number when v.TryGetInt32(out var i) => i,
            JsonValueKind.String when int.TryParse(v.GetString(), out var i) => i,
            _ => null,
        };
    }

    private static double? GetDouble(JsonElement el, string prop)
    {
        if (!TryProp(el, prop, out var v)) return null;
        return v.ValueKind switch
        {
            JsonValueKind.Number when v.TryGetDouble(out var d) => d,
            JsonValueKind.String when double.TryParse(v.GetString(), out var d) => d,
            _ => null,
        };
    }
}
