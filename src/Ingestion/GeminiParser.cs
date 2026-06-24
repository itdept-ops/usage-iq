using System.Globalization;
using System.Text.Json;

namespace Ccusage.Api.Ingestion;

/// <summary>
/// Parses Google Gemini / Antigravity usage transcripts. The confirmed shape is the Antigravity
/// brain log tree:
/// <c>~/.gemini/antigravity/brain/&lt;conversation-id&gt;/.system_generated/logs/*.jsonl</c>
/// — newline-delimited JSON where per-turn token usage lives in a <c>usage_metadata</c> /
/// <c>usageMetadata</c> block that uses the Gemini-API field names (<c>promptTokenCount</c>,
/// <c>candidatesTokenCount</c>, <c>cachedContentTokenCount</c>, <c>thoughtsTokenCount</c>,
/// <c>totalTokenCount</c>) alongside a <c>model</c> id like <c>gemini-3-pro</c>.
///
/// The parser is deliberately FORMAT-TOLERANT because the exact nesting varies between Antigravity
/// builds and the other Gemini surfaces (<c>~/.gemini/history/*.json</c>, <c>.gemini/telemetry.log</c>):
/// every line is JSON-parsed independently and we recursively hunt for ANY object carrying a usage
/// block, pairing it with the nearest model id, timestamp and ids we can find on the same line. A line
/// without a usage block is skipped; a malformed line never throws.
///
/// Mapping: <c>promptTokenCount → Input</c>, <c>candidatesTokenCount → Output</c>,
/// <c>cachedContentTokenCount → CacheRead</c>, <c>thoughtsTokenCount</c> (thinking) is added to
/// <c>Output</c>. Gemini exposes no cache-write tiers, so <c>Cache5m</c>/<c>Cache1h</c> stay 0.
/// </summary>
public sealed class GeminiParser : ISourceParser
{
    public string Kind => "gemini";

    /// <summary>
    /// True for files this source owns. Both ingest call sites pass only the file name, so the primary
    /// gate is the extension (<c>.jsonl</c>/<c>.json</c>) or the well-known <c>telemetry.log</c>; the
    /// Gemini <see cref="IngestionSource"/> root (<c>~/.gemini</c>) already scopes the scan to Gemini
    /// files. When a full path IS supplied we still accept the Antigravity brain-log markers.
    /// </summary>
    public bool MatchesFile(string fileName)
    {
        if (string.IsNullOrEmpty(fileName)) return false;

        // If a full path was handed in, honor the Antigravity brain-log location explicitly.
        var norm = fileName.Replace('\\', '/');
        if (norm.Contains("antigravity/brain", StringComparison.OrdinalIgnoreCase) &&
            norm.Contains(".system_generated/logs", StringComparison.OrdinalIgnoreCase) &&
            norm.EndsWith(".jsonl", StringComparison.OrdinalIgnoreCase))
            return true;

        var name = Path.GetFileName(norm);
        return name.EndsWith(".jsonl", StringComparison.OrdinalIgnoreCase)
            || name.EndsWith(".json", StringComparison.OrdinalIgnoreCase)
            || name.Equals("telemetry.log", StringComparison.OrdinalIgnoreCase);
    }

    public IEnumerable<ParsedUsage> Parse(TextReader reader, string fileName)
    {
        var conversationId = ConversationIdFromPath(fileName);
        var fileMtime = FileMtimeUtc(fileName);
        var index = 0;

        string? line;
        while ((line = reader.ReadLine()) is not null)
        {
            if (line.Length == 0) continue;

            JsonDocument doc;
            try { doc = JsonDocument.Parse(line); }
            catch { continue; } // never throw on a bad line

            using (doc)
            {
                // A single line can in principle carry more than one usage block (batched turns);
                // emit a row for each, but keep the index monotonic so dedup keys stay stable.
                foreach (var hit in FindUsages(doc.RootElement))
                {
                    var u = hit.Usage;
                    var prompt = GetLong(u, "promptTokenCount", "prompt_token_count");
                    var candidates = GetLong(u, "candidatesTokenCount", "candidates_token_count");
                    var cached = GetLong(u, "cachedContentTokenCount", "cached_content_token_count");
                    var thoughts = GetLong(u, "thoughtsTokenCount", "thoughts_token_count");

                    // Skip lines that carry a usage object but no actual spend.
                    if (prompt == 0 && candidates == 0 && cached == 0 && thoughts == 0)
                        continue;

                    index++;

                    var turnId = hit.TurnId;
                    var ts = hit.TimestampUtc ?? fileMtime;
                    var dedup = !string.IsNullOrEmpty(turnId)
                        ? $"gemini|{conversationId}|{turnId}"
                        : $"gemini|{conversationId}|{index}|{ts:O}";

                    yield return new ParsedUsage(
                        DedupKey: dedup,
                        TimestampUtc: ts,
                        Model: string.IsNullOrEmpty(hit.Model) ? "(unknown)" : hit.Model!,
                        Input: prompt,
                        Output: candidates + thoughts, // thinking counts as output spend
                        CacheRead: cached,
                        Cache5m: 0,
                        Cache1h: 0,
                        SessionId: conversationId,
                        Cwd: hit.Cwd,
                        GitBranch: hit.GitBranch,
                        IsSidechain: false,
                        AgentId: hit.AgentId,
                        Version: hit.Version);
                }
            }
        }
    }

    /// <summary>Carries a discovered usage block plus the nearest context found on the same line.</summary>
    private readonly record struct UsageHit(
        JsonElement Usage, string? Model, DateTime? TimestampUtc, string? TurnId,
        string? Cwd, string? GitBranch, string? AgentId, string? Version);

    /// <summary>
    /// Recursively walk the line's JSON and yield every <c>usage_metadata</c>/<c>usageMetadata</c>
    /// object found, pairing each with the model/timestamp/ids carried by the nearest ancestor (context
    /// is inherited down the tree and overridden by closer values).
    /// </summary>
    private static IEnumerable<UsageHit> FindUsages(JsonElement root)
    {
        var hits = new List<UsageHit>();
        Walk(root, new Ctx(), hits);
        return hits;
    }

    private readonly record struct Ctx(
        string? Model = null, DateTime? Ts = null, string? TurnId = null,
        string? Cwd = null, string? GitBranch = null, string? AgentId = null, string? Version = null);

    private static void Walk(JsonElement el, Ctx ctx, List<UsageHit> hits)
    {
        switch (el.ValueKind)
        {
            case JsonValueKind.Object:
            {
                // Refine the inherited context from any recognizable scalar fields at this level.
                ctx = ctx with
                {
                    Model = FirstStr(el, "model", "modelVersion", "model_version", "modelId", "model_id") ?? ctx.Model,
                    Ts = ParseTs(FirstStr(el, "timestamp", "time", "createTime", "create_time", "createdAt", "created_at", "ts")) ?? ctx.Ts,
                    TurnId = FirstStr(el, "turnId", "turn_id", "messageId", "message_id", "responseId", "response_id", "id") ?? ctx.TurnId,
                    Cwd = FirstStr(el, "cwd", "workingDirectory", "working_directory", "workspace") ?? ctx.Cwd,
                    GitBranch = FirstStr(el, "gitBranch", "git_branch", "branch") ?? ctx.GitBranch,
                    AgentId = FirstStr(el, "installationId", "installation_id", "sessionId", "session_id", "agentId", "agent_id") ?? ctx.AgentId,
                    Version = FirstStr(el, "version", "appVersion", "app_version", "cliVersion", "cli_version") ?? ctx.Version,
                };

                // Did THIS object carry a usage block (either casing)?
                if (TryGetUsage(el, out var usage))
                    hits.Add(new UsageHit(usage, ctx.Model, ctx.Ts, ctx.TurnId, ctx.Cwd, ctx.GitBranch, ctx.AgentId, ctx.Version));

                foreach (var prop in el.EnumerateObject())
                {
                    // Don't recurse INTO the usage object itself (its scalars aren't context).
                    if (IsUsageName(prop.Name)) continue;
                    Walk(prop.Value, ctx, hits);
                }
                break;
            }
            case JsonValueKind.Array:
                foreach (var item in el.EnumerateArray())
                    Walk(item, ctx, hits);
                break;
        }
    }

    private static bool TryGetUsage(JsonElement obj, out JsonElement usage)
    {
        foreach (var prop in obj.EnumerateObject())
        {
            if (IsUsageName(prop.Name) && prop.Value.ValueKind == JsonValueKind.Object)
            {
                usage = prop.Value;
                return true;
            }
        }
        usage = default;
        return false;
    }

    private static bool IsUsageName(string name) =>
        name.Equals("usageMetadata", StringComparison.OrdinalIgnoreCase) ||
        name.Equals("usage_metadata", StringComparison.OrdinalIgnoreCase);

    // ---- path / id helpers ----

    /// <summary>
    /// Pull the Antigravity conversation id from the path: the directory segment immediately above
    /// <c>.system_generated</c> (i.e. the <c>&lt;conversation-id&gt;</c> under <c>antigravity/brain</c>).
    /// Falls back to the file name without extension when the path doesn't follow that layout.
    /// </summary>
    private static string ConversationIdFromPath(string path)
    {
        var norm = path.Replace('\\', '/');
        var parts = norm.Split('/', StringSplitOptions.RemoveEmptyEntries);
        for (var i = 0; i < parts.Length; i++)
            if (parts[i].Equals(".system_generated", StringComparison.OrdinalIgnoreCase) && i > 0)
                return parts[i - 1];

        return Path.GetFileNameWithoutExtension(norm);
    }

    private static DateTime FileMtimeUtc(string path)
    {
        try
        {
            // path may be just a file name (server passes Path.GetFileName); guard the FS hit.
            if (path.IndexOfAny(new[] { '/', '\\' }) >= 0 && File.Exists(path))
                return File.GetLastWriteTimeUtc(path);
        }
        catch { /* fall through */ }
        return DateTimeOffset.UnixEpoch.UtcDateTime;
    }

    // ---- JSON scalar helpers (null-safe) ----

    private static string? FirstStr(JsonElement obj, params string[] names)
    {
        foreach (var n in names)
            if (obj.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.String)
            {
                var s = v.GetString();
                if (!string.IsNullOrWhiteSpace(s)) return s;
            }
        return null;
    }

    private static long GetLong(JsonElement obj, params string[] names)
    {
        foreach (var n in names)
            if (obj.TryGetProperty(n, out var v))
            {
                if (v.ValueKind == JsonValueKind.Number)
                {
                    if (v.TryGetInt64(out var l)) return l;
                    if (v.TryGetDouble(out var d)) return (long)d;
                }
                else if (v.ValueKind == JsonValueKind.String &&
                         long.TryParse(v.GetString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var sl))
                {
                    return sl;
                }
            }
        return 0;
    }

    private static DateTime? ParseTs(string? s)
    {
        if (string.IsNullOrWhiteSpace(s)) return null;
        if (DateTimeOffset.TryParse(s, CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var dto))
            return dto.UtcDateTime;
        // epoch millis / seconds as a bare number-in-string
        if (long.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out var num))
        {
            var ms = num > 9_999_999_999L ? num : num * 1000; // >10 digits ⇒ already millis
            try { return DateTimeOffset.FromUnixTimeMilliseconds(ms).UtcDateTime; } catch { }
        }
        return null;
    }
}
