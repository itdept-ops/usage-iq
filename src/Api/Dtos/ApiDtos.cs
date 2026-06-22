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
    /// <summary>The creator resolved to their AppUser id, or null when the stored creator email has no
    /// AppUser row (orphaned legacy links). The raw creator email is NEVER exposed (email-privacy).</summary>
    public int? CreatedByUserId { get; set; }
    /// <summary>The creator's display name (the matching AppUser.Name, "Unknown user" when unresolved).
    /// Never an email.</summary>
    public string CreatedByName { get; set; } = "";
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
    /// <summary>Display NAMES of the users who reported from this machine (resolved from the raw owner
    /// email server-side: AppUser.Name, "Unknown user" when no AppUser, "local" for the file-sync owner).
    /// Never an email — owner emails stay server-side.</summary>
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

/// <summary>One reporting user in the fleet view: spend/volume plus the machines they reported from.
/// Identity is the resolved <see cref="UserId"/> + display <see cref="Name"/> — the raw owner email is
/// NEVER exposed. Mutations targeting this user send the <see cref="UserId"/> back (the server resolves
/// it to the raw owner email internally).</summary>
public sealed class FleetUserDto
{
    /// <summary>The matching AppUser id, or null for the local/file-sync bucket and for an orphaned
    /// attribution email that has no AppUser. The "user" dimension mutations key off this id.</summary>
    public int? UserId { get; set; }

    /// <summary>Display name: the matching AppUser.Name; "local" for the file-sync bucket; "Unknown user"
    /// when an attribution email has no AppUser (or the AppUser has no name). Never an email.</summary>
    public string Name { get; set; } = "";
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

/// <summary>Reassign (combine/transfer) every record in the source set to a single target.
/// For the <c>machine</c> dimension the values are raw machine names (<see cref="From"/> / <see cref="To"/>).
/// For the <c>user</c> dimension the client holds no emails, so it sends user IDs instead
/// (<see cref="UserIds"/> sources, <see cref="ToUserId"/> target); the server resolves each id to the
/// raw owner email before the bulk update. A null/empty <see cref="ToUserId"/> means local ("").</summary>
public sealed class FleetReassignRequest
{
    public string Dimension { get; set; } = "";       // "machine" or "user"

    // machine dimension: raw machine names.
    public string[] From { get; set; } = Array.Empty<string>();
    public string To { get; set; } = "";              // may be "" (re-label to local)

    // user dimension: the client sends user IDs (no emails); the server resolves id -> owner email.
    public int[] UserIds { get; set; } = Array.Empty<int>();
    /// <summary>Target user id for a "user" reassign, or null = local ("").</summary>
    public int? ToUserId { get; set; }
}

public sealed class FleetReassignResultDto
{
    public long Affected { get; set; }
}

/// <summary>Permanently delete every record whose dimension value is one of the named buckets.
/// For <c>machine</c> the buckets are raw machine names (<see cref="Names"/>); for <c>user</c> the client
/// sends user IDs (<see cref="UserIds"/>) which the server resolves to raw owner emails before deleting.</summary>
public sealed class FleetDeleteRequest
{
    public string Dimension { get; set; } = "";       // "machine" or "user"

    // machine dimension: raw machine names.
    public string[] Names { get; set; } = Array.Empty<string>();

    // user dimension: the client sends user IDs (no emails); the server resolves id -> owner email.
    public int[] UserIds { get; set; } = Array.Empty<int>();
}

public sealed class FleetDeleteResultDto
{
    public long Deleted { get; set; }
}

/// <summary>Revoke every currently-active ingest key owned by a user. The client sends the
/// <see cref="UserId"/> (no email); the server resolves it to the owner email, then revokes by
/// UserId OR legacy CreatedByEmail.</summary>
public sealed class FleetRevokeKeysRequest
{
    public int UserId { get; set; }
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
    public int UserId { get; set; }
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
    /// <summary>The caller's own AppUser id — lets the client compute "mine"/self in chat by id
    /// (e.g. message.senderUserId == me.userId) without ever comparing emails (email-privacy).</summary>
    public int UserId { get; set; }
    public string Email { get; set; } = "";
    public string Name { get; set; } = "";
    public string? Picture { get; set; }
    public bool IsEnabled { get; set; }
    public string[] Permissions { get; set; } = Array.Empty<string>();

    /// <summary>The user's chosen landing route, or null to use the default first-accessible page.</summary>
    public string? HomeRoute { get; set; }
}

/// <summary>Body for <c>PATCH /api/auth/home</c>: the route to land on, or null to clear (use default).</summary>
public sealed class SetHomeRequest
{
    public string? Route { get; set; }
}

/// <summary>One teammate currently online (active within the presence window). Carries public identity
/// only — the raw email is NEVER exposed (email-privacy). <see cref="UserId"/> is the matching AppUser id
/// (null when the online email has no AppUser row); <see cref="IsSelf"/> marks the caller's own row.</summary>
public sealed class PresenceDto
{
    /// <summary>The matching AppUser id, or null when the online email has no AppUser row.</summary>
    public int? UserId { get; set; }
    public string Name { get; set; } = "";
    public string? Picture { get; set; }
    public DateTime LastSeenUtc { get; set; }
    /// <summary>True for the row whose email matches the caller's (server-resolved; the email itself is
    /// never put in the response).</summary>
    public bool IsSelf { get; set; }
}

public sealed class UserDto
{
    public int Id { get; set; }
    /// <summary>The user's email, or null when masked (server-side email-visibility gate). The caller's
    /// own row is always real; OTHER users' emails are null unless the X-Email-Reveal-Key header matches.</summary>
    public string? Email { get; set; }
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
    /// <summary>The acting admin's email, or null when masked. The caller's own actor email stays real;
    /// other actors' emails are null unless the X-Email-Reveal-Key header matches the configured key.</summary>
    public string? ActorEmail { get; set; }
    public string Action { get; set; } = "";
    /// <summary>The affected user's email, or null when masked (same gate as <see cref="ActorEmail"/>).</summary>
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
    /// <summary>The acting user resolved to their AppUser id, or null for an anonymous/unauthenticated
    /// request or when the logged email has no AppUser row. The raw user email is NEVER exposed
    /// (email-privacy).</summary>
    public int? UserId { get; set; }
    /// <summary>The acting user's display name (the matching AppUser.Name), or null for an anonymous row
    /// or an email with no AppUser. Never an email.</summary>
    public string? UserName { get; set; }
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

/// <summary>A participant in a channel or DM (identity for rendering message authorship / membership).
/// Identity is the server-resolved <see cref="UserId"/> + <see cref="Name"/> — the raw email is NEVER
/// exposed (email-privacy). <see cref="UserId"/> is 0 when the member email has no AppUser row.</summary>
public sealed class MemberDto
{
    /// <summary>The matching AppUser id, or 0 when the member email has no AppUser row.</summary>
    public int UserId { get; set; }
    public string Name { get; set; } = "";
    public string? Picture { get; set; }
}

/// <summary>
/// One emoji reaction group on a message: the emoji, how many reacted with it, and the server-resolved
/// AppUser ids of who did. The client derives "mine" = <see cref="ReactedByUserIds"/> contains my
/// userId, so the same shape serves both the REST response and the hub broadcast (no server-computed
/// Mine field). Raw reactor emails are NEVER exposed (email-privacy); a reactor whose email has no
/// AppUser row contributes id 0.
/// </summary>
public sealed class ReactionGroupDto
{
    public string Emoji { get; set; } = "";
    public int Count { get; set; }
    public int[] ReactedByUserIds { get; set; } = Array.Empty<int>();
}

/// <summary>One chat message. <see cref="Body"/> is null and <see cref="Deleted"/> is true for soft-deleted messages — deleted text is never exposed.</summary>
public sealed class ChatMessageDto
{
    public long Id { get; set; }
    public int ChannelId { get; set; }
    /// <summary>The author's server-resolved AppUser id, or 0 when the sender email has no AppUser row.
    /// The raw sender email is NEVER exposed (email-privacy); the client computes "mine" = senderUserId
    /// == my userId.</summary>
    public int SenderUserId { get; set; }
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

    /// <summary>For a direct message, the OTHER member's name ("Unknown user" when unresolved); for a channel, the channel name.</summary>
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

    /// <summary>The actor (the user who triggered this) resolved to their AppUser.Id, or null when the
    /// actor email has no AppUser row (or there is no actor, e.g. a system event). The raw actor email is
    /// NEVER exposed — other-user emails live only in the admin Users table (email-privacy).</summary>
    public int? ActorUserId { get; set; }

    /// <summary>The actor's display name, resolved server-side (the matching AppUser.Name, falling back to
    /// the name snapshotted at event time). Null when there is no actor.</summary>
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
    /// <summary>The requested members by AppUser id (email-privacy: the client holds no other-user
    /// emails). The server resolves each id to its internal email, validates it's an enabled user, and
    /// builds the membership; unknown/disabled ids are silently dropped (the creator is always added).</summary>
    public int[] MemberUserIds { get; set; } = Array.Empty<int>();
}

public sealed class SendMessageRequest
{
    public string Body { get; set; } = "";
    /// <summary>The mentioned members by AppUser id (email-privacy). The server resolves each id to its
    /// internal email, intersects with channel membership, and fires the mention notification for them.</summary>
    public int[]? MentionedUserIds { get; set; }
}

public sealed class OpenDirectRequest
{
    /// <summary>The other participant's AppUser id (email-privacy: the client holds no other-user email).
    /// The server resolves it to the internal email, validates the user exists + is enabled, then
    /// get-or-creates the DM.</summary>
    public int UserId { get; set; }
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

/// <summary>One person in a user's chat contacts (their circle), with display identity for the picker.
/// Identity is the server-resolved <see cref="UserId"/> + <see cref="Name"/> — the raw email is NEVER
/// exposed (email-privacy). The contact picker drives DM-open / channel-create by this <see cref="UserId"/>.</summary>
public sealed class ChatContactDto
{
    /// <summary>The matching AppUser id (the picker sends this back to open a DM / add a channel member).</summary>
    public int UserId { get; set; }
    public string Name { get; set; } = "";
    public string? Picture { get; set; }
}

/// <summary>Add a person to a user's chat contacts (mutual: writes both directions). The contact is
/// identified by AppUser id (email-privacy); the server resolves it to the internal email.</summary>
public sealed class AddContactRequest
{
    public int ContactUserId { get; set; }
}

// ---------------------------------------------------------------------------
// Food & fitness tracker
// ---------------------------------------------------------------------------

/// <summary>One USDA FoodData Central match, normalized for logging. <see cref="Basis"/> tells the
/// frontend whether the nutrition is per serving ("perServing", typically Branded) or per 100 g
/// ("per100g", typically Foundation / SR Legacy) so quantities can be scaled correctly.</summary>
public sealed class FoodSearchItemDto
{
    public int FdcId { get; set; }
    public string Description { get; set; } = "";
    public string? Brand { get; set; }
    public string? GtinUpc { get; set; }
    public int Calories { get; set; }
    public double ProteinG { get; set; }
    public double CarbG { get; set; }
    public double FatG { get; set; }
    public double? ServingSize { get; set; }
    public string? ServingUnit { get; set; }
    /// <summary>"perServing" or "per100g".</summary>
    public string Basis { get; set; } = "per100g";

    /// <summary>Which provider produced this hit: "usda" | "fatsecret". REQUIRED.</summary>
    public string Source { get; set; } = "usda";

    /// <summary>Provider-native id (USDA: <see cref="FdcId"/> as string; FatSecret: food_id), or null.</summary>
    public string? SourceId { get; set; }
}

/// <summary>One logged food, with its meal so the day view can group by meal. Nutrition is the
/// snapshot stored at log time.</summary>
public sealed class FoodEntryDto
{
    public long Id { get; set; }
    /// <summary>"breakfast" | "lunch" | "dinner" | "snack".</summary>
    public string Meal { get; set; } = "";
    public int? FdcId { get; set; }
    public string Description { get; set; } = "";
    public string? Brand { get; set; }
    public double Quantity { get; set; }
    public string? ServingDesc { get; set; }
    public int Calories { get; set; }
    public double ProteinG { get; set; }
    public double CarbG { get; set; }
    public double FatG { get; set; }
}

/// <summary>One seeded activity with its MET and the goals it suits (for the goal-filtered picker).</summary>
public sealed class ExerciseLibraryDto
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public string Category { get; set; } = "";
    public double Met { get; set; }
    public string[] Goals { get; set; } = Array.Empty<string>();
}

/// <summary>One logged workout.</summary>
public sealed class ExerciseEntryDto
{
    public long Id { get; set; }
    public int? ExerciseId { get; set; }
    public string Name { get; set; } = "";
    public int? DurationMin { get; set; }
    public int CaloriesBurned { get; set; }
}

/// <summary>
/// One WorkoutX catalog exercise, normalized from the provider's payload. The GIF is omitted on purpose
/// (the provider's gifUrl needs the secret key, which never reaches the client) — the client loads the
/// demo via the key-authenticated proxy at <c>/api/tracker/workoutx/gif/{Id}</c> instead.
/// <see cref="CaloriesPerMinute"/> drives the client's live estimate (round(caloriesPerMinute * minutes)).
/// </summary>
public sealed class WorkoutXExerciseDto
{
    /// <summary>Provider id, e.g. "0001". Used as the gif-proxy path segment.</summary>
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string BodyPart { get; set; } = "";
    public string Equipment { get; set; } = "";
    public string Target { get; set; } = "";
    public string[] SecondaryMuscles { get; set; } = Array.Empty<string>();
    public string[] Instructions { get; set; } = Array.Empty<string>();
    public string Category { get; set; } = "";
    public string Difficulty { get; set; } = "";
    public double Met { get; set; }
    public double CaloriesPerMinute { get; set; }
    public string? Description { get; set; }
    public string? RecommendedSets { get; set; }
    public string? RecommendedReps { get; set; }
}

/// <summary>A page of WorkoutX exercises plus the catalog-wide total for the active filter (for paging).</summary>
public sealed class WorkoutXSearchResultDto
{
    public int Total { get; set; }
    public WorkoutXExerciseDto[] Data { get; set; } = Array.Empty<WorkoutXExerciseDto>();
}

/// <summary>A user's tracker profile: goal, body profile, optional calorie/macro targets, sharing flag.
/// Doubles as the body of <c>PUT /api/tracker/profile</c> (UpdateTrackerProfileRequest). All body
/// measures are metric (kg + cm); <see cref="UnitSystem"/> is a display preference only.</summary>
public sealed class TrackerProfileDto
{
    /// <summary>One of the <c>TrackerGoal</c> names: "LoseWeight" | "Maintain" | "GainMuscle" | "Endurance".</summary>
    public string Goal { get; set; } = "Maintain";
    public double? WeightKg { get; set; }
    public int? DailyCalorieGoal { get; set; }
    public int? ProteinGoalG { get; set; }
    public int? CarbGoalG { get; set; }
    public int? FatGoalG { get; set; }
    public bool ShareWithContacts { get; set; }

    /// <summary>"yyyy-MM-dd" or null.</summary>
    public string? DateOfBirth { get; set; }
    public double? HeightCm { get; set; }
    /// <summary>One of the <c>BiologicalSex</c> names: "Unspecified" | "Male" | "Female".</summary>
    public string Sex { get; set; } = "Unspecified";
    /// <summary>One of the <c>ActivityLevel</c> names: "Sedentary" | "Light" | "Moderate" | "Active" | "VeryActive".</summary>
    public string ActivityLevel { get; set; } = "Sedentary";
    public double? GoalWeightKg { get; set; }
    /// <summary>"Metric" | "Imperial" — display preference; backend always stores/returns metric.</summary>
    public string UnitSystem { get; set; } = "Metric";

    /// <summary>Daily fluid-intake goal in millilitres, or null (the day then uses a 2000 ml default).</summary>
    public int? HydrationGoalMl { get; set; }

    /// <summary>Daily step goal, or null (the UI then shows a ~10000 default). Not required.</summary>
    public int? StepGoal { get; set; }
}

/// <summary>Computed body-metric estimates from the current profile (all metric inputs). Any field whose
/// inputs are missing is null — partial stats are expected. NULLED entirely when a viewer reads someone
/// else's day (body metrics are private).</summary>
public sealed class TrackerStatsDto
{
    public int? Age { get; set; }
    public double? Bmi { get; set; }
    /// <summary>"Underweight" | "Normal" | "Overweight" | "Obese".</summary>
    public string? BmiCategory { get; set; }
    public int? Bmr { get; set; }
    public int? Tdee { get; set; }
    public int? SuggestedCalorieGoal { get; set; }
    public int? SuggestedProteinG { get; set; }
    public int? SuggestedCarbG { get; set; }
    public int? SuggestedFatG { get; set; }
}

/// <summary>A whole day's tracker: the profile, foods (grouped by meal on the client), exercises, and
/// the rolled-up totals. <see cref="ReadOnly"/> is true when viewing someone else's tracker.</summary>
public sealed class TrackerDayDto
{
    public string Date { get; set; } = "";
    /// <summary>The day owner resolved to their AppUser id. The raw owner email is NEVER exposed
    /// (email-privacy); for the caller's OWN day this is the caller's id.</summary>
    public int UserId { get; set; }
    /// <summary>The day owner's display name (the matching AppUser.Name). Never an email.</summary>
    public string UserName { get; set; } = "";
    public bool ReadOnly { get; set; }
    public TrackerProfileDto Profile { get; set; } = new();
    /// <summary>Computed body-metric estimates for the owner. NULL in the read-only (viewer) branch —
    /// BMI/BMR/weight must not leak to a sharing contact or a coach.</summary>
    public TrackerStatsDto? Stats { get; set; }
    public FoodEntryDto[] Foods { get; set; } = Array.Empty<FoodEntryDto>();
    public ExerciseEntryDto[] Exercises { get; set; } = Array.Empty<ExerciseEntryDto>();
    public int CaloriesIn { get; set; }
    /// <summary>The day's RESOLVED calories burned: the logged-exercise sum, then the watch active
    /// calories applied per the day's <see cref="WatchActivityDto.CalorieMode"/> (ADD on top, OVERRIDE
    /// replaces). With no watch entry it equals <see cref="ExerciseCalories"/>.</summary>
    public int CaloriesOut { get; set; }
    /// <summary>The raw sum of logged-exercise calories, BEFORE the watch add/override is applied.</summary>
    public int ExerciseCalories { get; set; }
    public int NetCalories { get; set; }
    public double ProteinG { get; set; }
    public double CarbG { get; set; }
    public double FatG { get; set; }
    public int? CalorieGoal { get; set; }
    /// <summary>When a goal is set: goal − caloriesIn + caloriesOut.</summary>
    public int? Remaining { get; set; }

    /// <summary>Total fluid intake for the day in millilitres (sum of <see cref="Hydration"/>).</summary>
    public int HydrationMl { get; set; }
    /// <summary>The resolved daily hydration goal in ml: the profile's goal, else a 2000 ml default.</summary>
    public int HydrationGoalMl { get; set; }
    /// <summary>The day's hydration entries (drinks), oldest-first. Visible to a permitted viewer too.</summary>
    public HydrationEntryDto[] Hydration { get; set; } = Array.Empty<HydrationEntryDto>();

    /// <summary>The day's recorded watch stats (steps/distance/active calories + mode), or null when none
    /// recorded. Visible to a permitted viewer too (read-only).</summary>
    public WatchActivityDto? Activity { get; set; }
    /// <summary>The profile's daily step goal, or null (the UI then shows a ~10000 default).</summary>
    public int? StepGoal { get; set; }
}

/// <summary>One day's recorded smartwatch activity stats: steps, distance (always metres), active
/// calories, and how the active calories factor into the day's calories out. Part of the tracker day —
/// visible to a permitted viewer read-only, but only the owner may write it.</summary>
public sealed class WatchActivityDto
{
    public int? Steps { get; set; }
    /// <summary>Distance covered in metres (the client converts to mi/km for display).</summary>
    public int? DistanceMeters { get; set; }
    public int? ActiveCalories { get; set; }
    /// <summary>"add" — active calories add on top of logged exercises; "override" — they replace the
    /// logged-exercise sum.</summary>
    public string CalorieMode { get; set; } = "add";
}

/// <summary>One logged drink: its volume in millilitres, an optional label, and when it was logged.</summary>
public sealed class HydrationEntryDto
{
    public long Id { get; set; }
    public int AmountMl { get; set; }
    public string? Label { get; set; }
    /// <summary>ISO-8601 UTC timestamp of when the drink was logged.</summary>
    public string CreatedUtc { get; set; } = "";
}

/// <summary>A person whose tracker the caller may view (a sharing mutual contact, or anyone when the
/// caller has tracker.viewall).</summary>
public sealed class SharedUserDto
{
    /// <summary>The shared user's AppUser id (the client opens their tracker via GET /day?user={userId}).
    /// The raw email is NEVER exposed (email-privacy).</summary>
    public int UserId { get; set; }
    public string Name { get; set; } = "";
    public string? Picture { get; set; }
}

/// <summary>Log a food onto a day/meal with its snapshotted nutrition.</summary>
public sealed class AddFoodRequest
{
    public string Date { get; set; } = "";
    public string Meal { get; set; } = "";
    public int? FdcId { get; set; }
    public string Description { get; set; } = "";
    public string? Brand { get; set; }
    public double Quantity { get; set; }
    public string? ServingDesc { get; set; }
    public int Calories { get; set; }
    public double ProteinG { get; set; }
    public double CarbG { get; set; }
    public double FatG { get; set; }

    /// <summary>
    /// Where the food came from ("usda" | "fatsecret" | "custom"), or null/absent when MANUALLY typed.
    /// A manual log (no source AND no <see cref="FdcId"/>) is auto-saved to the caller's "My foods"
    /// library; a "custom" log bumps the matching saved food's use count; usda/fatsecret logs are not saved.
    /// </summary>
    public string? Source { get; set; }
}

/// <summary>
/// Log ONE serving of a planned Family Hub meal onto the caller's OWN tracker day (Slice 2 tie-in). The
/// <see cref="MealId"/> names a <c>FamilyMeal</c> in a household the caller is a member of (else 404 — never
/// leaked); the endpoint logs the meal's DERIVED per-serving macros (dish total / servings). <see cref="LocalDate"/>
/// (yyyy-MM-dd) is optional — absent, the meal's own planned date is used.
/// </summary>
public sealed class AddFoodFromMealRequest
{
    public long MealId { get; set; }

    /// <summary>The day (yyyy-MM-dd) to log onto; null/blank/invalid ⇒ the meal's own planned date.</summary>
    public string? LocalDate { get; set; }
}

/// <summary>One of the caller's saved "My foods" — a per-user library auto-built from manual food logs.
/// Calories/macros are the verbatim totals first logged; <see cref="UseCount"/> tracks how often it was
/// logged (newest-used first in the list).</summary>
public sealed class CustomFoodDto
{
    public long Id { get; set; }
    public string Description { get; set; } = "";
    public string? Brand { get; set; }
    public string? ServingDesc { get; set; }
    public int Calories { get; set; }
    public double ProteinG { get; set; }
    public double CarbG { get; set; }
    public double FatG { get; set; }
    public int UseCount { get; set; }
}

/// <summary>One body-weight reading on a day, for the trend chart. Weight is always kg.</summary>
public sealed class WeightPointDto
{
    /// <summary>"yyyy-MM-dd".</summary>
    public string Date { get; set; } = "";
    public double WeightKg { get; set; }
}

/// <summary>
/// One body-weight reading on a day at a named slot, for charting in the stats view. Weight is always kg.
/// </summary>
public sealed class WeightStatEntryDto
{
    /// <summary>"yyyy-MM-dd".</summary>
    public string Date { get; set; } = "";
    /// <summary>The slot name: Unspecified | Morning | Afternoon | Evening.</summary>
    public string Slot { get; set; } = "";
    public double WeightKg { get; set; }
}

/// <summary>Per-slot weight statistics: the average, the latest reading, and how many readings.</summary>
public sealed class WeightSlotStatDto
{
    /// <summary>The slot name: Unspecified | Morning | Afternoon | Evening.</summary>
    public string Slot { get; set; } = "";
    public double AvgKg { get; set; }
    public double LatestKg { get; set; }
    public int Count { get; set; }
}

/// <summary>
/// The caller's own weight statistics. Per-slot averages/latest/counts, the typical morning→evening
/// delta (avg evening − avg morning; null if either slot has no readings), and recent readings for
/// charting. PRIVATE — owner-only, never exposed to viewers.
/// </summary>
public sealed class WeightStatsDto
{
    public List<WeightSlotStatDto> BySlot { get; set; } = [];
    /// <summary>Avg evening minus avg morning (kg); null when either morning or evening is missing.</summary>
    public double? MorningEveningDeltaKg { get; set; }
    public List<WeightStatEntryDto> Entries { get; set; } = [];
}

/// <summary>
/// Log (upsert) today's-or-any-day body weight at an optional slot; weight is always kilograms. When
/// <see cref="Slot"/> is omitted/empty it defaults to Unspecified (back-compat single-per-day behavior).
/// </summary>
public sealed class LogWeightRequest
{
    public string Date { get; set; } = "";
    public double WeightKg { get; set; }
    /// <summary>Optional slot name: Unspecified | Morning | Afternoon | Evening.</summary>
    public string? Slot { get; set; }
}

/// <summary>Log an exercise. When <see cref="CaloriesBurned"/> is omitted and an
/// <see cref="ExerciseId"/> + <see cref="DurationMin"/> are given and the profile has a weight, the
/// server computes calories burned from the library MET.</summary>
public sealed class AddExerciseRequest
{
    public string Date { get; set; } = "";
    public int? ExerciseId { get; set; }
    public string? Name { get; set; }
    public int? DurationMin { get; set; }
    public int? CaloriesBurned { get; set; }

    /// <summary>
    /// Where the exercise came from ("library" | "workoutx" | "custom"), or null/absent when MANUALLY typed.
    /// A manual log (no source AND no <see cref="ExerciseId"/>) is auto-saved to the caller's "My exercises"
    /// library; a "custom" log bumps the matching saved exercise's use count; library/workoutx logs are not
    /// saved (library is goal-tagged + searchable; workoutx is searchable upstream).
    /// </summary>
    public string? Source { get; set; }
}

/// <summary>One of the caller's saved "My exercises" — a per-user library auto-built from manual exercise
/// logs. The default calories/duration are the values last logged; <see cref="UseCount"/> tracks how often
/// it was logged (newest-used first in the list).</summary>
public sealed class CustomExerciseDto
{
    public long Id { get; set; }
    public string Name { get; set; } = "";
    public int? DefaultCaloriesBurned { get; set; }
    public int? DefaultDurationMin { get; set; }
    public int UseCount { get; set; }
}

/// <summary>Log a drink onto a day; <see cref="AmountMl"/> is always millilitres (1..5000), with an
/// optional drink <see cref="Label"/> (trimmed, &lt;= 64 chars). Multiple drinks per day are expected.</summary>
public sealed class AddHydrationRequest
{
    public string Date { get; set; } = "";
    public int AmountMl { get; set; }
    public string? Label { get; set; }
}

/// <summary>Upsert the caller's watch activity stats for a day. Distance is always metres (1..1000000),
/// steps 0..200000, active calories 0..20000; <see cref="CalorieMode"/> is "add" | "override" (how the
/// active calories factor into the day's calories out). All-null stats keep the row (with nulls).</summary>
public sealed class UpsertActivityRequest
{
    public string Date { get; set; } = "";
    public int? Steps { get; set; }
    public int? DistanceMeters { get; set; }
    public int? ActiveCalories { get; set; }
    /// <summary>"add" (default) | "override".</summary>
    public string CalorieMode { get; set; } = "add";
}

/// <summary>
/// Commit a whole AI Day Builder draft (all meals + foods, exercises, hydration, weight, activity) in ONE
/// atomic, idempotent pass. The <see cref="Draft"/> is the user-EDITED draft and is treated as fully
/// UNTRUSTED — every field is re-validated + re-clamped server-side exactly like the single-entry
/// endpoints. <see cref="BuildId"/> is the server-issued idempotency token from <c>build-day</c>: a
/// repeat commit with the same id writes nothing and reports <see cref="CommitDayResponse.AlreadyCommitted"/>.
/// </summary>
public sealed class CommitDayRequest
{
    /// <summary>The idempotency token from build-day (required).</summary>
    public string BuildId { get; set; } = "";
    /// <summary>"yyyy-MM-dd" (required); the authoritative date all entries are logged on.</summary>
    public string Date { get; set; } = "";
    /// <summary>The user-edited day draft (untrusted; re-validated + re-clamped server-side).</summary>
    public Ccusage.Api.Dtos.DayDraft Draft { get; set; } = new();
}

/// <summary>The outcome of a day commit: whether it was a no-op repeat, the counts logged, and the
/// rebuilt authoritative day (so the client can refresh without a second round-trip).</summary>
public sealed class CommitDayResponse
{
    /// <summary>True when this build id was already committed — nothing was written this time.</summary>
    public bool AlreadyCommitted { get; set; }
    public CommitCounts Logged { get; set; } = new();
    /// <summary>The rebuilt authoritative day after the commit (same shape as GET /day).</summary>
    public TrackerDayDto Day { get; set; } = new();
}

/// <summary>How many entries of each domain the commit actually wrote (after caps + skips).</summary>
public sealed class CommitCounts
{
    public int Foods { get; set; }
    public int Exercises { get; set; }
    public int Drinks { get; set; }
    public bool Weight { get; set; }
    public bool Activity { get; set; }
}

/// <summary>
/// Move the CALLER's OWN tracker entries from one local date to another, by category — the fix for "the AI
/// Day Builder (or manual logging) put my day on the wrong date." <see cref="Categories"/> is a subset of
/// ["food","exercise","hydration","weight","activity"]; null/empty means ALL. <see cref="FromDate"/> must
/// differ from <see cref="ToDate"/> (both yyyy-MM-dd). Only the caller's rows are ever touched. For the
/// one-per-day domains (weight per slot, activity per day), a moved row WINS over a conflicting target row.
/// </summary>
public sealed class MoveDayRequest
{
    /// <summary>The source local date (yyyy-MM-dd) to move entries OFF of.</summary>
    public string FromDate { get; set; } = "";
    /// <summary>The target local date (yyyy-MM-dd) to move entries ONTO.</summary>
    public string ToDate { get; set; } = "";
    /// <summary>Subset of ["food","exercise","hydration","weight","activity"]; null/empty = all categories.</summary>
    public string[]? Categories { get; set; }
}

/// <summary>The outcome of a day move: how many rows of each domain were re-dated, and what target
/// rows were replaced (where a one-per-day uniqueness conflict made the moved entry win).</summary>
public sealed class MoveDayResponse
{
    public MoveDayCounts Moved { get; set; } = new();
    public MoveDayReplaced Replaced { get; set; } = new();
    /// <summary>The target date entries were moved onto (yyyy-MM-dd), echoed for the client.</summary>
    public string ToDate { get; set; } = "";
}

/// <summary>How many rows of each domain were re-dated onto the target date.</summary>
public sealed class MoveDayCounts
{
    public int Food { get; set; }
    public int Exercise { get; set; }
    public int Hydration { get; set; }
    public int Weight { get; set; }
    /// <summary>True when the source date had an activity row that was moved onto the target.</summary>
    public bool Activity { get; set; }
}

/// <summary>What target-date rows the move replaced (the moved entry wins on a one-per-day conflict).</summary>
public sealed class MoveDayReplaced
{
    /// <summary>How many target weight rows (same slot) were deleted so the moved reading could win.</summary>
    public int Weight { get; set; }
    /// <summary>True when a target activity row was deleted so the moved one could win.</summary>
    public bool Activity { get; set; }
}
