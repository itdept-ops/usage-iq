using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Ccusage.Api.Ingestion;

/// <summary>
/// Parses OpenAI Codex CLI rollout transcripts (<c>~/.codex/**/rollout-*.jsonl</c>).
/// Usage lives in <c>event_msg</c> records with <c>payload.type == "token_count"</c>; the
/// per-turn delta is <c>info.last_token_usage</c> (which sums to <c>total_token_usage</c>).
/// <c>input_tokens</c> already includes <c>cached_input_tokens</c>, and <c>output_tokens</c>
/// already includes reasoning tokens, so we split them out without double counting.
/// </summary>
public sealed partial class CodexParser : ISourceParser
{
    public string Kind => "codex";

    public bool MatchesFile(string fileName) =>
        fileName.StartsWith("rollout-", StringComparison.OrdinalIgnoreCase) &&
        fileName.EndsWith(".jsonl", StringComparison.OrdinalIgnoreCase);

    public IEnumerable<ParsedUsage> Parse(TextReader reader, string fileName)
    {
        var sessionId = SessionIdFromFileName(fileName);
        string? model = null, cwd = null, gitBranch = null, version = null;
        var ordinal = 0;

        string? line;
        while ((line = reader.ReadLine()) is not null)
        {
            if (line.Length == 0) continue;

            JsonDocument doc;
            try { doc = JsonDocument.Parse(line); }
            catch { continue; }

            using (doc)
            {
                var root = doc.RootElement;
                switch (GetStr(root, "type"))
                {
                    case "session_meta":
                    {
                        var p = GetObj(root, "payload");
                        cwd = GetStr(p, "cwd") ?? cwd;
                        version = GetStr(p, "cli_version") ?? version;
                        model = GetStr(p, "model") ?? model;
                        gitBranch = GetStr(GetObj(p, "git"), "branch") ?? gitBranch;
                        var id = GetStr(p, "id");
                        if (!string.IsNullOrEmpty(id)) sessionId = id!;
                        break;
                    }
                    case "turn_context":
                    {
                        var p = GetObj(root, "payload");
                        model = GetStr(p, "model") ?? model;
                        cwd = GetStr(p, "cwd") ?? cwd;
                        break;
                    }
                    case "event_msg":
                    {
                        var p = GetObj(root, "payload");
                        if (GetStr(p, "type") != "token_count") break;

                        var lu = GetObj(GetObj(p, "info"), "last_token_usage");
                        if (lu.ValueKind != JsonValueKind.Object) break;

                        ordinal++;
                        var input = GetLong(lu, "input_tokens");
                        var cached = GetLong(lu, "cached_input_tokens");
                        var output = GetLong(lu, "output_tokens");
                        if (input == 0 && output == 0) break; // no spend this turn

                        yield return new ParsedUsage(
                            DedupKey: $"codex|{sessionId}|{ordinal}",
                            TimestampUtc: ParseTs(GetStr(root, "timestamp")),
                            Model: model ?? "(unknown)",
                            Input: Math.Max(0, input - cached), // non-cached input
                            Output: output,                     // includes reasoning tokens
                            CacheRead: cached,
                            Cache5m: 0,
                            Cache1h: 0,
                            SessionId: sessionId,
                            Cwd: cwd,
                            GitBranch: gitBranch,
                            IsSidechain: false,
                            AgentId: null,
                            Version: version);
                        break;
                    }
                }
            }
        }
    }

    private static string SessionIdFromFileName(string fileName)
    {
        var m = UuidRegex().Match(fileName);
        return m.Success ? m.Value : Path.GetFileNameWithoutExtension(fileName);
    }

    private static DateTime ParseTs(string? s) =>
        DateTimeOffset.TryParse(s, CultureInfo.InvariantCulture,
            DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var dto)
            ? dto.UtcDateTime
            : DateTimeOffset.UnixEpoch.UtcDateTime;

    private static string? GetStr(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String
            ? v.GetString() : null;

    private static JsonElement GetObj(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) ? v : default;

    private static long GetLong(JsonElement e, string name)
    {
        if (e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number)
        {
            if (v.TryGetInt64(out var l)) return l;
            if (v.TryGetDouble(out var d)) return (long)d;
        }
        return 0;
    }

    [GeneratedRegex(@"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")]
    private static partial Regex UuidRegex();
}
