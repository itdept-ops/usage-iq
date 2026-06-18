namespace Ccusage.Api.Dtos;

/// <summary>Filter shared by the summary and records endpoints (bound from the query string).</summary>
public readonly record struct UsageFilterQuery(
    DateOnly? from,
    DateOnly? to,
    int[]? projectId,
    string[]? model,
    string[]? source,
    bool? includeSidechain,
    string[]? machine = null,
    string[]? user = null);

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

public sealed class CreateShareRequest
{
    public string? Label { get; set; }
    public int ExpiresInHours { get; set; } = 168; // default 7 days
    public DateOnly? From { get; set; }
    public DateOnly? To { get; set; }
    public int[]? ProjectId { get; set; }
    public string[]? Model { get; set; }
    public string[]? Source { get; set; }
    public bool IncludeSidechain { get; set; } = true;
    public string GroupBy { get; set; } = "day";
}

/// <summary>Returned once on creation — the only time the full token is exposed.</summary>
public sealed class ShareCreatedDto
{
    public int Id { get; set; }
    public string Token { get; set; } = "";
    public string Path { get; set; } = "";   // e.g. /share/<token>
    public DateTime ExpiresUtc { get; set; }
    public string? Label { get; set; }
}

/// <summary>A share in the management list (auth-only; carries the copyable path).</summary>
public sealed class ShareDto
{
    public int Id { get; set; }
    public string? Label { get; set; }
    public string? Path { get; set; }   // /share/<token>, decrypted for re-copy (null for legacy links)
    public string CreatedByEmail { get; set; } = "";
    public DateTime CreatedUtc { get; set; }
    public DateTime ExpiresUtc { get; set; }
    public bool Expired { get; set; }
    public int AccessCount { get; set; }
    public DateTime? LastAccessedUtc { get; set; }
    public string Scope { get; set; } = "";
}

public sealed class UpdateShareRequest
{
    public int ExpiresInHours { get; set; }
    public string? Label { get; set; }
}

/// <summary>One recorded view of a share link.</summary>
public sealed class ShareAccessDto
{
    public DateTime WhenUtc { get; set; }
    public string? Ip { get; set; }
}

/// <summary>The read-only payload served to an anonymous viewer of a valid share link.</summary>
public sealed class PublicShareDto
{
    public string? Label { get; set; }
    public DateTime GeneratedAtUtc { get; set; }
    public DateTime ExpiresUtc { get; set; }
    public string GroupBy { get; set; } = "day";
    public string Scope { get; set; } = "";
    public SummaryResponse Summary { get; set; } = new();
    public SummaryResponse Models { get; set; } = new();
}

/// <summary>One cell of the hour × weekday activity heatmap (local time).</summary>
public sealed class HeatmapCellDto
{
    public int Day { get; set; }   // 0 = Sunday … 6 = Saturday
    public int Hour { get; set; }  // 0–23 (display timezone)
    public int Count { get; set; }
}

/// <summary>Headline efficiency / streak figures for the filtered range.</summary>
public sealed class UsageStatsDto
{
    public double TotalActiveHours { get; set; }
    public int ActiveDays { get; set; }
    public double AvgHoursPerActiveDay { get; set; }
    public int TotalSessions { get; set; }
    public double AvgSessionMinutes { get; set; }
    public double LongestSessionMinutes { get; set; }
    public decimal TotalCost { get; set; }
    public decimal CostPerActiveHour { get; set; }
    public string? MostActiveDay { get; set; }
    public double MostActiveDayHours { get; set; }
    public int CurrentStreakDays { get; set; }
    public int LongestStreakDays { get; set; }
    public int BusiestHour { get; set; }
}

public sealed class SessionMessageDto
{
    public DateTime TimestampUtc { get; set; }
    public string Model { get; set; } = "";
    public string ProjectName { get; set; } = "";
    public long Input { get; set; }
    public long Output { get; set; }
    public long Total { get; set; }
    public decimal Cost { get; set; }
    public bool IsSidechain { get; set; }
}

public sealed class SessionDetailDto
{
    public string SessionId { get; set; } = "";
    public string? ProjectName { get; set; }
    public DateTime StartUtc { get; set; }
    public DateTime EndUtc { get; set; }
    public int Messages { get; set; }
    public long Tokens { get; set; }
    public decimal Cost { get; set; }
    public List<SessionMessageDto> Items { get; set; } = new();
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

/// <summary>One reporting machine in the fleet view: spend/volume plus the users who reported from it.</summary>
public sealed class FleetMachineDto
{
    public string Name { get; set; } = "";          // "local" for the file-sync path
    public DateTime? LastSeenUtc { get; set; }       // max TimestampUtc in the bucket
    public int Records { get; set; }
    public long Tokens { get; set; }                 // combined total across all tiers
    public decimal CostUsd { get; set; }
    public string[] Users { get; set; } = Array.Empty<string>();

    // System metadata from the matching MachineInfos row (LEFT-joined by raw machine name). All null
    // when no metadata has been reported for this machine yet (e.g. legacy machines, or the local bucket).
    public string? LocalIp { get; set; }
    public string? PublicIp { get; set; }
    public string? Os { get; set; }
    public string? Arch { get; set; }
    public string? OsUser { get; set; }
    public string? Agent { get; set; }
    public string? ReporterVersion { get; set; }
    public int? CpuCount { get; set; }
    public DateTime? FirstSeenUtc { get; set; }
    /// <summary>When metadata was last reported (distinct from <see cref="LastSeenUtc"/>, the last usage row).</summary>
    public DateTime? MetadataLastSeenUtc { get; set; }
}

/// <summary>One reporting user in the fleet view: spend/volume plus the machines they reported from.</summary>
public sealed class FleetUserDto
{
    public string Email { get; set; } = "";          // "local" for the file-sync path
    public DateTime? LastSeenUtc { get; set; }
    public int Records { get; set; }
    public long Tokens { get; set; }
    public decimal CostUsd { get; set; }
    public string[] Machines { get; set; } = Array.Empty<string>();
}

/// <summary>The fleet rollup: per-machine and per-user buckets for the filtered range.</summary>
public sealed class FleetDto
{
    public List<FleetMachineDto> Machines { get; set; } = new();
    public List<FleetUserDto> Users { get; set; } = new();
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

/// <summary>
/// One machine in the filter-options list. Carries the RAW <see cref="Name"/> the client filters by
/// (empty for the local file-sync path) plus a display <see cref="Label"/> ("local" when empty).
/// </summary>
public sealed class MachineStatDto
{
    public string Name { get; set; } = "";    // raw MachineName ("" for local)
    public string Label { get; set; } = "";    // display label ("local" when Name is empty)
    public int Records { get; set; }
    public long TotalTokens { get; set; }
    public decimal CostUsd { get; set; }
}

// ---- Fleet management (reporter.manage) ----

/// <summary>Reassign (combine/transfer) every record in <c>From</c> to a single <c>To</c> value.</summary>
public sealed class FleetReassignRequest
{
    public string Dimension { get; set; } = "";       // "machine" or "user"
    public string[] From { get; set; } = Array.Empty<string>();
    public string To { get; set; } = "";              // may be "" (re-label to local)
}

public sealed class FleetReassignResultDto
{
    public long Affected { get; set; }
}

/// <summary>Permanently delete every record whose dimension value is one of <c>Names</c>.</summary>
public sealed class FleetDeleteRequest
{
    public string Dimension { get; set; } = "";       // "machine" or "user"
    public string[] Names { get; set; } = Array.Empty<string>();
}

public sealed class FleetDeleteResultDto
{
    public long Deleted { get; set; }
}

/// <summary>Revoke every currently-active ingest key owned by a user (by id or legacy email).</summary>
public sealed class FleetRevokeKeysRequest
{
    public string Email { get; set; } = "";
}

public sealed class FleetRevokeKeysResultDto
{
    public int Revoked { get; set; }
}

/// <summary>
/// Cache-efficiency rollup for the filtered range: how much prompt input was served from the
/// (cheap) cache, what cache-writes cost, and the dollars saved by reading from cache instead
/// of paying the full input rate.
/// </summary>
public sealed class CacheEfficiencyDto
{
    public long CacheReadTokens { get; set; }
    public long CacheWrite5mTokens { get; set; }
    public long CacheWrite1hTokens { get; set; }

    /// <summary>5m + 1h cache-creation tokens.</summary>
    public long CacheWriteTokens { get; set; }

    public long InputTokens { get; set; }
    public long OutputTokens { get; set; }
    public int RecordCount { get; set; }

    /// <summary>Share of prompt input served from cache: cacheRead / (cacheRead + input), 0..1.</summary>
    public double CacheReadRatio { get; set; }

    /// <summary>Dollars saved by cache reads vs paying the full input rate (never negative).</summary>
    public decimal SavingsUsd { get; set; }

    /// <summary>Cost of the 5m + 1h cache-creation tokens.</summary>
    public decimal CacheWriteCostUsd { get; set; }
}

/// <summary>A personal saved dashboard view (filter payload) owned by the caller.</summary>
public sealed class SavedViewDto
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public DateOnly? From { get; set; }
    public DateOnly? To { get; set; }
    public int[] ProjectId { get; set; } = Array.Empty<int>();
    public string[] Model { get; set; } = Array.Empty<string>();
    public string[] Source { get; set; } = Array.Empty<string>();
    public bool IncludeSidechain { get; set; } = true;
    public string GroupBy { get; set; } = "day";
    public DateTime CreatedUtc { get; set; }
    public DateTime? LastUsedUtc { get; set; }
}

/// <summary>Create/update payload for a saved view (name + dashboard filter).</summary>
public sealed class SavedViewUpsertRequest
{
    public string Name { get; set; } = "";
    public DateOnly? From { get; set; }
    public DateOnly? To { get; set; }
    public int[]? ProjectId { get; set; }
    public string[]? Model { get; set; }
    public string[]? Source { get; set; }
    public bool IncludeSidechain { get; set; } = true;
    public string GroupBy { get; set; } = "day";
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

/// <summary>One teammate currently online (active within the presence window).</summary>
public sealed class PresenceDto
{
    public string Email { get; set; } = "";
    public string Name { get; set; } = "";
    public string? Picture { get; set; }
    public DateTime LastSeenUtc { get; set; }
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
    public string Group { get; set; } = "";
    public string Label { get; set; } = "";
    public string Description { get; set; } = "";
}

/// <summary>The access policy: open sign-up toggle + default permissions for auto-provisioned users.</summary>
public sealed class AccessPolicyDto
{
    public bool OpenSignupEnabled { get; set; }
    public string[] DefaultPermissions { get; set; } = Array.Empty<string>();
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

/// <summary>One recorded sign-in attempt for a user (the per-user login history).</summary>
public sealed class LoginEventDto
{
    public long Id { get; set; }
    public DateTime WhenUtc { get; set; }
    public string Ip { get; set; } = "";
    public bool Success { get; set; }
    public string Reason { get; set; } = "";
    public string? Name { get; set; }
    public string? UserAgent { get; set; }
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

// ---- Chat + Notifications ----

/// <summary>A participant in a channel or DM (identity for rendering message authorship / membership).</summary>
public sealed class MemberDto
{
    public string Email { get; set; } = "";
    public string Name { get; set; } = "";
    public string? Picture { get; set; }
}

/// <summary>
/// One emoji reaction group on a message: the emoji, how many reacted with it, and the lowercased
/// emails of who did. The client derives "mine" = <see cref="ReactedBy"/> contains my email, so the
/// same shape serves both the REST response and the hub broadcast (no server-computed Mine field).
/// </summary>
public sealed class ReactionGroupDto
{
    public string Emoji { get; set; } = "";
    public int Count { get; set; }
    public string[] ReactedBy { get; set; } = Array.Empty<string>();
}

/// <summary>One chat message. <see cref="Body"/> is null and <see cref="Deleted"/> is true for soft-deleted messages — deleted text is never exposed.</summary>
public sealed class ChatMessageDto
{
    public long Id { get; set; }
    public int ChannelId { get; set; }
    public string SenderEmail { get; set; } = "";
    public string SenderName { get; set; } = "";
    public string? SenderPicture { get; set; }
    public string? Body { get; set; }
    public DateTime CreatedUtc { get; set; }
    public DateTime? EditedUtc { get; set; }
    public bool Deleted { get; set; }

    /// <summary>
    /// Reaction groups on this message, ordered by first-reacted (stable chip order). Never null —
    /// defaults to an empty array; only the message-history endpoint populates real reactions.
    /// </summary>
    public ReactionGroupDto[] Reactions { get; set; } = Array.Empty<ReactionGroupDto>();
}

/// <summary>A channel or direct message as seen by the calling member, with unread state and last message.</summary>
public sealed class ChatChannelDto
{
    public int Id { get; set; }

    /// <summary>"channel" or "direct".</summary>
    public string Kind { get; set; } = "";

    public string? Name { get; set; }
    public string? Topic { get; set; }
    public bool IsPrivate { get; set; }
    public bool Archived { get; set; }

    /// <summary>For a direct message, the OTHER member's name (or email); for a channel, the channel name.</summary>
    public string DisplayName { get; set; } = "";

    public MemberDto[] Members { get; set; } = Array.Empty<MemberDto>();
    public ChatMessageDto? LastMessage { get; set; }
    public int UnreadCount { get; set; }
}

/// <summary>One in-app inbox notification for the caller.</summary>
public sealed class NotificationDto
{
    public long Id { get; set; }

    /// <summary>The <see cref="Data.Entities.NotificationType"/> serialized as a camelCase string.</summary>
    public string Type { get; set; } = "";

    public string Text { get; set; } = "";
    public string? Link { get; set; }
    public string? ActorEmail { get; set; }
    public string? ActorName { get; set; }
    public bool IsRead { get; set; }
    public DateTime CreatedUtc { get; set; }
}

/// <summary>The caller's notification-delivery preferences.</summary>
public sealed class NotificationPreferenceDto
{
    public bool NotifyDirectMessages { get; set; }
    public bool NotifyMentions { get; set; }
    public bool NotifyChannelMessages { get; set; }
    public bool NotifySystemEvents { get; set; }
    public bool SurfaceToasts { get; set; }
    public bool SurfaceBrowser { get; set; }
}

public sealed class CreateChannelRequest
{
    public string Name { get; set; } = "";
    public string? Topic { get; set; }
    public bool IsPrivate { get; set; }
    public string[] MemberEmails { get; set; } = Array.Empty<string>();
}

public sealed class SendMessageRequest
{
    public string Body { get; set; } = "";
    public string[]? MentionedEmails { get; set; }
}

public sealed class OpenDirectRequest
{
    public string UserEmail { get; set; } = "";
}

public sealed class EditMessageRequest
{
    public string Body { get; set; } = "";
}

public sealed class MarkReadRequest
{
    public long MessageId { get; set; }
}

/// <summary>Toggle a single emoji reaction on a message (add if absent, remove if present).</summary>
public sealed class ReactRequest
{
    public string Emoji { get; set; } = "";
}

public sealed class MarkNotificationsReadRequest
{
    public long[] Ids { get; set; } = Array.Empty<long>();
}

/// <summary>One person in a user's chat contacts (their circle), with display identity for the picker.</summary>
public sealed class ChatContactDto
{
    public string Email { get; set; } = "";
    public string Name { get; set; } = "";
    public string? Picture { get; set; }
}

/// <summary>Add a person to a user's chat contacts (mutual: writes both directions).</summary>
public sealed class AddContactRequest
{
    public string ContactEmail { get; set; } = "";
}
