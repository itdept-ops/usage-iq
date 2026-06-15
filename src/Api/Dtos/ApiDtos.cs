namespace Ccusage.Api.Dtos;

/// <summary>Filter shared by the summary and records endpoints (bound from the query string).</summary>
public readonly record struct UsageFilterQuery(
    DateOnly? from,
    DateOnly? to,
    int[]? projectId,
    string[]? model,
    string[]? source,
    bool? includeSidechain);

public sealed class NotificationSettingDto
{
    public bool WebhookConfigured { get; set; }
    public string? WebhookMasked { get; set; }
    public bool Enabled { get; set; }
    public int DigestHourLocal { get; set; }
    public bool DailyDigest { get; set; }
    public bool WeeklyDigest { get; set; }
    public int WeeklyDay { get; set; }
    public bool ThresholdEnabled { get; set; }
    public decimal ThresholdUsd { get; set; }
    public bool SecurityAlerts { get; set; }
    public string? MentionOnAlert { get; set; }
}

public sealed class NotificationUpdateRequest
{
    /// <summary>null = leave unchanged · "" = clear · value = set (must be a valid Discord webhook).</summary>
    public string? DiscordWebhookUrl { get; set; }
    public bool Enabled { get; set; }
    public int DigestHourLocal { get; set; }
    public bool DailyDigest { get; set; }
    public bool WeeklyDigest { get; set; }
    public int WeeklyDay { get; set; }
    public bool ThresholdEnabled { get; set; }
    public decimal ThresholdUsd { get; set; }
    public bool SecurityAlerts { get; set; }
    public string? MentionOnAlert { get; set; }
}

/// <summary>One day in the usage calendar: spend, volume, and estimated active engagement time.</summary>
public sealed class CalendarDayDto
{
    public string Date { get; set; } = "";        // yyyy-MM-dd (display timezone)
    public decimal CostUsd { get; set; }
    public long Tokens { get; set; }
    public int Messages { get; set; }
    public int Sessions { get; set; }
    public int ActiveMinutes { get; set; }         // gap-based engaged time
    public DateTime? FirstUtc { get; set; }
    public DateTime? LastUtc { get; set; }
}

public class TokenTotals
{
    public long InputTokens { get; set; }
    public long OutputTokens { get; set; }
    public long CacheReadTokens { get; set; }
    public long CacheCreation5mTokens { get; set; }
    public long CacheCreation1hTokens { get; set; }
    public long TotalTokens => InputTokens + OutputTokens + CacheReadTokens + CacheCreation5mTokens + CacheCreation1hTokens;
    public decimal CostUsd { get; set; }
    public int Records { get; set; }
}

public sealed class SummaryBucket : TokenTotals
{
    /// <summary>Bucket identity (date, "YYYY-MM", project name, model, or session id).</summary>
    public string Key { get; set; } = "";
}

public sealed class SummaryResponse
{
    public string GroupBy { get; set; } = "";
    public List<SummaryBucket> Buckets { get; set; } = new();
    public TokenTotals Total { get; set; } = new();
}

public sealed class UsageRecordDto
{
    public long Id { get; set; }
    public string Source { get; set; } = "";
    public DateTime TimestampUtc { get; set; }
    public DateOnly LocalDate { get; set; }
    public string Model { get; set; } = "";
    public int InputTokens { get; set; }
    public int OutputTokens { get; set; }
    public long CacheReadTokens { get; set; }
    public int CacheCreation5mTokens { get; set; }
    public int CacheCreation1hTokens { get; set; }
    public long TotalTokens { get; set; }
    public decimal CostUsd { get; set; }
    public string ProjectName { get; set; } = "";
    public string SessionId { get; set; } = "";
    public string? GitBranch { get; set; }
    public bool IsSidechain { get; set; }
}

public sealed class PagedResult<T>
{
    public IReadOnlyList<T> Items { get; set; } = Array.Empty<T>();
    public long Total { get; set; }
    public int Page { get; set; }
    public int PageSize { get; set; }
}

public sealed class ProjectDto
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public string RepoRoot { get; set; } = "";
    public int Records { get; set; }
    public decimal CostUsd { get; set; }
}

public sealed class ModelStatDto
{
    public string Model { get; set; } = "";
    public int Records { get; set; }
    public long TotalTokens { get; set; }
    public decimal CostUsd { get; set; }
    public bool IsPlaceholderPricing { get; set; }
}

public sealed class PricingDto
{
    public int Id { get; set; }
    public string ModelPattern { get; set; } = "";
    public string? DisplayName { get; set; }
    public decimal InputPerMTok { get; set; }
    public decimal OutputPerMTok { get; set; }
    public decimal CacheWrite5mPerMTok { get; set; }
    public decimal CacheWrite1hPerMTok { get; set; }
    public decimal CacheReadPerMTok { get; set; }
    public bool IsPlaceholder { get; set; }
}

public sealed class SettingsDto
{
    public string DisplayTimeZone { get; set; } = "";
    public string ClaudeProjectsPath { get; set; } = "";
    public bool AutoSyncEnabled { get; set; }
    public int AutoSyncIntervalSeconds { get; set; }
}

public sealed class SourceDto
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public string Kind { get; set; } = "";
    public string RootPath { get; set; } = "";
    public bool Enabled { get; set; }
    public int Records { get; set; }
}

public sealed class GoogleLoginRequest
{
    public string IdToken { get; set; } = "";
}

public sealed class AuthResultDto
{
    public string Token { get; set; } = "";
    public string Email { get; set; } = "";
    public string Name { get; set; } = "";
    public string? Picture { get; set; }
    public DateTime ExpiresAtUtc { get; set; }
    public string[] Permissions { get; set; } = Array.Empty<string>();
}

public sealed class AuthConfigDto
{
    public string GoogleClientId { get; set; } = "";
}

public sealed class MeDto
{
    public string Email { get; set; } = "";
    public string Name { get; set; } = "";
    public string? Picture { get; set; }
    public bool IsEnabled { get; set; }
    public string[] Permissions { get; set; } = Array.Empty<string>();
}

public sealed class UserDto
{
    public int Id { get; set; }
    public string Email { get; set; } = "";
    public string Name { get; set; } = "";
    public string? Picture { get; set; }
    public bool IsEnabled { get; set; }
    public string[] Permissions { get; set; } = Array.Empty<string>();
    public DateTime CreatedUtc { get; set; }
    public DateTime? LastLoginUtc { get; set; }
}

public sealed class UserUpsertRequest
{
    public string Email { get; set; } = "";
    public string? Name { get; set; }
    public bool IsEnabled { get; set; } = true;
    public string[] Permissions { get; set; } = Array.Empty<string>();
}

public sealed class PermissionItemDto
{
    public string Key { get; set; } = "";
    public string Label { get; set; } = "";
    public string Description { get; set; } = "";
}

public sealed class AuditEntryDto
{
    public long Id { get; set; }
    public DateTime WhenUtc { get; set; }
    public string ActorEmail { get; set; } = "";
    public string Action { get; set; } = "";
    public string? TargetEmail { get; set; }
    public string? Detail { get; set; }
}

public sealed class RequestLogDto
{
    public long Id { get; set; }
    public DateTime WhenUtc { get; set; }
    public string Method { get; set; } = "";
    public string Path { get; set; } = "";
    public string? QueryString { get; set; }
    public int StatusCode { get; set; }
    public int DurationMs { get; set; }
    public string? UserEmail { get; set; }
    public string? ClientIp { get; set; }
    public long? RequestBytes { get; set; }
    public long? ResponseBytes { get; set; }
    public string? RequestBody { get; set; }
    public string? ResponseBody { get; set; }
}

public sealed class SyncStatusDto
{
    public DateTime? LastSyncUtc { get; set; }
    public int LastNewRecords { get; set; }
    public long LastDurationMs { get; set; }
    public int LastFilesParsed { get; set; }
    public int LastFilesScanned { get; set; }
    public string? LastError { get; set; }
    public bool IsRunning { get; set; }
    public bool AutoSyncEnabled { get; set; }
    public int IntervalSeconds { get; set; }
}
