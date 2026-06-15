using System.Text.Json.Serialization;

namespace Ccusage.Api.Ingestion;

/// <summary>One line of a Claude Code <c>.jsonl</c> transcript (only fields we use).</summary>
public sealed class JsonlLine
{
    [JsonPropertyName("type")] public string? Type { get; set; }
    [JsonPropertyName("timestamp")] public DateTimeOffset? Timestamp { get; set; }
    [JsonPropertyName("requestId")] public string? RequestId { get; set; }
    [JsonPropertyName("sessionId")] public string? SessionId { get; set; }
    [JsonPropertyName("version")] public string? Version { get; set; }
    [JsonPropertyName("cwd")] public string? Cwd { get; set; }
    [JsonPropertyName("gitBranch")] public string? GitBranch { get; set; }
    [JsonPropertyName("isSidechain")] public bool? IsSidechain { get; set; }
    [JsonPropertyName("agentId")] public string? AgentId { get; set; }
    [JsonPropertyName("message")] public JsonlMessage? Message { get; set; }
}

public sealed class JsonlMessage
{
    [JsonPropertyName("id")] public string? Id { get; set; }
    [JsonPropertyName("model")] public string? Model { get; set; }
    [JsonPropertyName("usage")] public JsonlUsage? Usage { get; set; }
}

public sealed class JsonlUsage
{
    [JsonPropertyName("input_tokens")] public long? InputTokens { get; set; }
    [JsonPropertyName("output_tokens")] public long? OutputTokens { get; set; }
    [JsonPropertyName("cache_read_input_tokens")] public long? CacheReadInputTokens { get; set; }
    [JsonPropertyName("cache_creation_input_tokens")] public long? CacheCreationInputTokens { get; set; }
    [JsonPropertyName("cache_creation")] public JsonlCacheCreation? CacheCreation { get; set; }
}

public sealed class JsonlCacheCreation
{
    [JsonPropertyName("ephemeral_5m_input_tokens")] public long? Ephemeral5m { get; set; }
    [JsonPropertyName("ephemeral_1h_input_tokens")] public long? Ephemeral1h { get; set; }
}
