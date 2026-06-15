using System.Text.Json;

namespace Ccusage.Api.Ingestion;

/// <summary>
/// Parses Claude Code transcripts (<c>~/.claude/projects/**/*.jsonl</c>). One row per
/// assistant message with <c>usage</c>, de-duplicated on <c>message.id + requestId</c>.
/// </summary>
public sealed class ClaudeParser : ISourceParser
{
    public string Kind => "claude";

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        NumberHandling = System.Text.Json.Serialization.JsonNumberHandling.AllowReadingFromString,
    };

    public bool MatchesFile(string fileName) =>
        fileName.EndsWith(".jsonl", StringComparison.OrdinalIgnoreCase);

    public IEnumerable<ParsedUsage> Parse(TextReader reader, string fileName)
    {
        string? line;
        while ((line = reader.ReadLine()) is not null)
        {
            if (line.Length == 0) continue;

            JsonlLine? rec;
            try { rec = JsonSerializer.Deserialize<JsonlLine>(line, JsonOpts); }
            catch { continue; }

            var msg = rec?.Message;
            var usage = msg?.Usage;
            if (rec?.Type != "assistant" || usage is null || string.IsNullOrEmpty(msg!.Id))
                continue;

            var write5m = usage.CacheCreation?.Ephemeral5m ?? 0;
            var write1h = usage.CacheCreation?.Ephemeral1h ?? 0;
            if (usage.CacheCreation is null && usage.CacheCreationInputTokens is { } flat)
                write5m = flat; // older shape: treat the flat field as 5m writes

            yield return new ParsedUsage(
                DedupKey: msg.Id + "|" + (rec.RequestId ?? ""),
                TimestampUtc: (rec.Timestamp ?? DateTimeOffset.UnixEpoch).UtcDateTime,
                Model: string.IsNullOrEmpty(msg.Model) ? "(unknown)" : msg.Model!,
                Input: usage.InputTokens ?? 0,
                Output: usage.OutputTokens ?? 0,
                CacheRead: usage.CacheReadInputTokens ?? 0,
                Cache5m: write5m,
                Cache1h: write1h,
                SessionId: rec.SessionId ?? "",
                Cwd: rec.Cwd,
                GitBranch: rec.GitBranch,
                IsSidechain: rec.IsSidechain ?? false,
                AgentId: rec.AgentId,
                Version: rec.Version);
        }
    }
}
