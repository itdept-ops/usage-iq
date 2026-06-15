namespace Ccusage.Api.Ingestion;

/// <summary>Source-neutral usage row produced by a parser, before pricing/project resolution.</summary>
public sealed record ParsedUsage(
    string DedupKey,
    DateTime TimestampUtc,
    string Model,
    long Input,
    long Output,
    long CacheRead,
    long Cache5m,
    long Cache1h,
    string SessionId,
    string? Cwd,
    string? GitBranch,
    bool IsSidechain,
    string? AgentId,
    string? Version);

/// <summary>Parses one tool's JSONL transcript format into <see cref="ParsedUsage"/> rows.</summary>
public interface ISourceParser
{
    /// <summary>The ingestion source kind this parser handles (e.g. "claude", "codex").</summary>
    string Kind { get; }

    /// <summary>True if a file (by name) belongs to this source.</summary>
    bool MatchesFile(string fileName);

    /// <summary>Yield every usage row in the file. Malformed lines should be skipped, not thrown.</summary>
    IEnumerable<ParsedUsage> Parse(TextReader reader, string fileName);
}
