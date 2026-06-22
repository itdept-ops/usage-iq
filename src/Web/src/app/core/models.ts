export interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreation5mTokens: number;
  cacheCreation1hTokens: number;
  totalTokens: number;
  costUsd: number;
  records: number;
}

export interface SummaryBucket extends TokenTotals {
  key: string;
}

export interface SummaryResponse {
  groupBy: string;
  buckets: SummaryBucket[];
  total: TokenTotals;
}

export interface CreateShareRequest {
  label?: string | null;
  expiresInHours: number;
  from: string | null;
  to: string | null;
  projectId: number[];
  model: string[];
  source: string[];
  includeSidechain: boolean;
  groupBy: string;
}

export interface ShareCreated {
  id: number;
  token: string;
  path: string;
  expiresUtc: string;
  label: string | null;
}

export interface ShareListItem {
  id: number;
  label: string | null;
  path: string | null;
  /** The creator's AppUser id, or null for an orphaned legacy link (no matching AppUser). Never an email (email-privacy). */
  createdByUserId: number | null;
  /** The creator's display name ("Unknown user" when unresolved). Never an email. */
  createdByName: string;
  createdUtc: string;
  expiresUtc: string;
  expired: boolean;
  accessCount: number;
  lastAccessedUtc: string | null;
  scope: string;
}

export interface ShareAccessItem {
  whenUtc: string;
  ip: string | null;
}

export interface PublicShare {
  label: string | null;
  generatedAtUtc: string;
  expiresUtc: string;
  groupBy: string;
  scope: string;
  summary: SummaryResponse;
  models: SummaryResponse;
}

/** One reporting machine in the fleet view: spend/volume plus the users who reported from it. */
export interface FleetMachine {
  name: string;
  lastSeenUtc: string | null;
  records: number;
  tokens: number;
  costUsd: number;
  /** Display NAMES of the users who reported from this machine (resolved server-side from the raw owner
   * email: AppUser.Name, "Unknown user" when no AppUser, "local" for the file-sync owner). Never an email. */
  users: string[];

  // System metadata from the matching MachineInfos row (LEFT-joined by raw machine name). All null
  // when no metadata has been reported for this machine yet (e.g. legacy machines, or the local bucket).
  localIp: string | null;
  publicIp: string | null;
  os: string | null;
  arch: string | null;
  osUser: string | null;
  /** Reporter client kind: "desktop" (WPF tray) or "console" (CLI). */
  agent: string | null;
  reporterVersion: string | null;
  cpuCount: number | null;
  firstSeenUtc: string | null;
  /** When metadata was last reported (distinct from `lastSeenUtc`, the last usage row). */
  metadataLastSeenUtc: string | null;
}

/**
 * One reporting user in the fleet view: spend/volume plus the machines they reported from. Identity is
 * the resolved `userId` + display `name` — the raw owner email is NEVER exposed. Mutations targeting this
 * user send the `userId` back (the server resolves it to the raw owner email internally). Mirrors FleetUserDto.
 */
export interface FleetUser {
  /** The matching AppUser id, or null for the local/file-sync bucket and for an orphaned attribution email. */
  userId?: number | null;
  /** Display name: AppUser.Name; "local" for the file-sync bucket; "Unknown user" when no AppUser. Never an email. */
  name: string;
  lastSeenUtc: string | null;
  records: number;
  tokens: number;
  costUsd: number;
  machines: string[];
}

/** The fleet rollup: per-machine and per-user leaderboards for the filtered range. */
export interface Fleet {
  machines: FleetMachine[];
  users: FleetUser[];
}

/** One machine in the dashboard filter list: the RAW name plus a display label ("local" when empty). Mirrors MachineStatDto. */
export interface MachineStat {
  name: string;        // raw machine name ("" for the local file-sync bucket)
  label: string;       // display label ("local" when name is empty)
  records: number;
  totalTokens: number;
  costUsd: number;
}

/** Which fleet dimension a management action targets. */
export type FleetDimension = 'machine' | 'user';

/**
 * Reassign (combine/transfer) every usage record in a source set to a single target. For the `machine`
 * dimension the values are raw machine names (`from` / `to`, `to` may be "" to re-label to local). For
 * the `user` dimension the client holds no emails, so it sends user IDs instead (`userIds` sources,
 * `toUserId` target, null/undefined = local); the server resolves each id to the raw owner email.
 * Mirrors FleetReassignRequest.
 */
export interface FleetReassignRequest {
  dimension: FleetDimension;
  // machine dimension: raw machine names.
  from?: string[];
  to?: string;
  // user dimension: user IDs (no emails).
  userIds?: number[];
  /** Target user id for a "user" reassign, or null/undefined = local. */
  toUserId?: number | null;
}

export interface FleetReassignResult {
  affected: number;
}

/**
 * Permanently delete every usage record whose dimension value is one of the named buckets. For `machine`
 * the buckets are raw machine names (`names`); for `user` the client sends user IDs (`userIds`) which the
 * server resolves to raw owner emails before deleting. Mirrors FleetDeleteRequest.
 */
export interface FleetDeleteRequest {
  dimension: FleetDimension;
  // machine dimension: raw machine names.
  names?: string[];
  // user dimension: user IDs (no emails).
  userIds?: number[];
}

export interface FleetDeleteResult {
  deleted: number;
}

/**
 * Revoke every currently-active ingest key owned by a user. USER dimension only. The client sends the
 * `userId` (no email); the server resolves it to the owner email then revokes that owner's keys.
 * Mirrors FleetRevokeKeysRequest.
 */
export interface FleetRevokeKeysRequest {
  userId: number;
}

export interface FleetRevokeKeysResult {
  revoked: number;
}

/**
 * Cache-efficiency rollup for the filtered range (GET /api/usage/cache-efficiency):
 * how much prompt input was served from the cheap cache, what cache-writes cost,
 * and the dollars saved by reading from cache instead of paying the full input rate.
 * Mirrors CacheEfficiencyDto on the API.
 */
export interface CacheEfficiency {
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  /** 5m + 1h cache-creation tokens. */
  cacheWriteTokens: number;
  inputTokens: number;
  outputTokens: number;
  recordCount: number;
  /** Share of prompt input served from cache: cacheRead / (cacheRead + input), 0..1. */
  cacheReadRatio: number;
  /** Dollars saved by cache reads vs paying the full input rate (never negative). */
  savingsUsd: number;
  /** Cost of the 5m + 1h cache-creation tokens. */
  cacheWriteCostUsd: number;
}

/** A personal saved dashboard view (filter payload + groupBy) owned by the caller. Mirrors SavedViewDto. */
export interface SavedView {
  id: number;
  name: string;
  from: string | null;
  to: string | null;
  projectId: number[];
  model: string[];
  source: string[];
  includeSidechain: boolean;
  groupBy: string;
  createdUtc: string;
  lastUsedUtc: string | null;
}

/** Create/update payload for a saved view (name + dashboard filter + groupBy). Mirrors SavedViewUpsertRequest. */
export interface SavedViewUpsertRequest {
  name: string;
  from: string | null;
  to: string | null;
  projectId: number[];
  model: string[];
  source: string[];
  includeSidechain: boolean;
  groupBy: string;
}

export interface UsageRecord {
  id: number;
  source: string;
  timestampUtc: string;
  localDate: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreation5mTokens: number;
  cacheCreation1hTokens: number;
  totalTokens: number;
  costUsd: number;
  projectName: string;
  sessionId: string;
  gitBranch: string | null;
  isSidechain: boolean;
}

export interface PagedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ProjectDto {
  id: number;
  name: string;
  repoRoot: string;
  records: number;
  costUsd: number;
}

export interface ModelStat {
  model: string;
  records: number;
  totalTokens: number;
  costUsd: number;
  isPlaceholderPricing: boolean;
}

export interface Pricing {
  id: number;
  modelPattern: string;
  displayName: string | null;
  inputPerMTok: number;
  outputPerMTok: number;
  cacheWrite5mPerMTok: number;
  cacheWrite1hPerMTok: number;
  cacheReadPerMTok: number;
  isPlaceholder: boolean;
}

export interface Settings {
  displayTimeZone: string;
  claudeProjectsPath: string;
  autoSyncEnabled: boolean;
  autoSyncIntervalSeconds: number;
}

export interface IngestionSource {
  id: number;
  name: string;
  kind: string;
  rootPath: string;
  enabled: boolean;
  records: number;
}

export interface IngestKey {
  id: number;
  name: string;
  prefix: string;
  createdUtc: string;
  /** The creator's AppUser id, or null when the creator email has no AppUser row. Never an email (email-privacy). */
  createdByUserId: number | null;
  /** The creator's display name ("Unknown user" when unresolved). Never an email. */
  createdByName: string;
  /** The owning user's AppUser id; null for orphaned legacy keys (no linked user). Never an email. */
  ownerUserId: number | null;
  /** The owner's display name; null for orphaned legacy keys (no linked user). Never an email. */
  ownerName: string | null;
  lastUsedUtc: string | null;
  lastUsedIp: string | null;
  revoked: boolean;
}

/** Returned once on creation — carries the full raw key. */
export interface IngestKeyCreated {
  id: number;
  name: string;
  prefix: string;
  key: string;
}

export interface SyncResult {
  timeZone: string;
  filesScanned: number;
  filesParsed: number;
  filesSkipped: number;
  newRecords: number;
  newRecordsBySource: Record<string, number>;
  sourceWarnings: string[];
  unpricedModels: string[];
  durationMs: number;
  error: string | null;
  warning: string | null;
}

/**
 * One teammate currently online (GET /api/presence). Presence is recorded server-side on every
 * authenticated request, so it stays fresh from the existing /me + /sync/status polls — the client
 * only polls this endpoint. Mirrors PresenceDto on the API. The caller themselves is included.
 */
export interface Presence {
  /** The matching AppUser id, or null when the online email has no AppUser row. */
  userId?: number | null;
  name: string;
  picture: string | null;
  /** ISO-8601 UTC timestamp of the user's last authenticated request. */
  lastSeenUtc: string;
  /** True for the caller's own row (server-resolved; the email itself is never in the response). */
  isSelf: boolean;
  /**
   * The user's latest COARSE city, surfaced ONLY to themselves and (when they share-to-household) to
   * fellow household members; null otherwise. Precise location is never exposed via presence — this is
   * a city name at most. Populated only after a location fix is recorded; absent on older sessions.
   */
  city?: string | null;
}

// ---- Location / GPS (privacy-sensitive: PRIVATE by default, capture is OPT-IN) ----------------------
// Mirrors the API's LocationDtos.cs. The precise lat/lng is only ever returned to the SHARER (their own
// history, GET /api/location/me) or to an admin holding location.view-all (GET /api/location/admin);
// household sharing surfaces only the coarse city via presence (see Presence.city above).

/** How a location fix was captured. Unknown values normalize to "manual" server-side. */
export type LocationSource = 'login' | 'periodic' | 'manual' | 'agent';

/**
 * One recorded location fix returned to its OWNER (own history) or to an admin. Carries the precise
 * lat/lng — exposed only to the sharer themselves or an admin with location.view-all. Mirrors LocationDto.
 */
export interface LocationFix {
  id: number;
  lat: number;
  lng: number;
  /** Reported GPS accuracy radius in metres, when the browser supplied one. */
  accuracyM?: number | null;
  source: LocationSource | string;
  /** Best-effort reverse-geocoded place (may be null when geocoding was unavailable). */
  city?: string | null;
  region?: string | null;
  country?: string | null;
  /** ISO-8601 UTC timestamp of when the fix was recorded. */
  capturedUtc: string;
}

/** Body of POST /api/location — the client's own browser-resolved coordinates for one fix. */
export interface RecordLocationRequest {
  lat: number;
  lng: number;
  accuracyM?: number | null;
  /** login | periodic | manual | agent. Unknown values normalize to "manual" server-side. */
  source?: LocationSource;
}

/** The caller's current location opt-in settings (GET/PATCH /api/location/settings). */
export interface LocationSettings {
  /** Opt in / out of capture. Turning it off does NOT delete history (use DELETE /api/location/me). */
  locationEnabled: boolean;
  /** Share the coarse latest city with household members (surfaced via presence). */
  shareHousehold: boolean;
}

/** Body of PATCH /api/location/settings — each field optional (null/undefined = leave unchanged). */
export interface LocationSettingsUpdate {
  locationEnabled?: boolean;
  shareHousehold?: boolean;
}

/**
 * One user's entry on the admin location map (GET /api/location/admin). Identity is userId+name — the
 * raw owner email is never put on the wire even on this admin-gated page (email-privacy preference).
 * Precise coordinates are visible here only because the endpoint is admin-gated (location.view-all).
 */
export interface AdminUserLocation {
  userId?: number | null;
  name: string;
  /** The most recent fix (the API omits users with no rows, so this is effectively always present). */
  latest?: LocationFix | null;
  /** A short window of recent fixes (newest-first) for drawing a trail on the map. */
  recent: LocationFix[];
}

export interface AuthSession {
  token: string;
  email: string;
  name: string;
  picture: string | null;
  expiresAtUtc: string;
  permissions: string[];
  /**
   * The caller's own AppUser id. Used to compute "mine"/self by id in chat (message authorship,
   * reaction membership, typing, online-dot presence cross-reference) without exposing emails.
   * Populated from /me (applyMe); a session restored from before this field landed gets it on the
   * next /me poll, so it may be momentarily undefined.
   */
  userId?: number;
  /**
   * The user's chosen landing page route (e.g. '/', '/calendar'), or null to use the default
   * first-accessible-in-order home. The login response doesn't carry it — it's populated from /me
   * (applyMe), so a freshly-restored session may be momentarily undefined until the first /me poll.
   * {@link AuthService.homeRoute} honours it only while the caller still holds that route's permission.
   */
  homeRoute?: string | null;
}

export interface ManagedUser {
  id: number;
  /** Null when masked: the email-reveal key was absent/incorrect and this is not the caller's own row. */
  email: string | null;
  name: string;
  picture: string | null;
  isEnabled: boolean;
  permissions: string[];
  /** The user's chosen landing route, or null for the default first-accessible page. Admin-settable via PATCH /api/users/{id}/home. */
  homeRoute: string | null;
  createdUtc: string;
  lastLoginUtc: string | null;
}

export interface PermissionItem {
  key: string;
  /** The UI group this permission belongs to (server-defined: Usage/Fitness/Family/Chat/Location/Admin/AI). */
  group: string;
  label: string;
  description: string;
  /** True for the AI (token-spending) permissions, so the grant matrix can flag/style them distinctly. */
  isAi: boolean;
}

/**
 * A server-defined preset template (GET /api/permission-presets): a named bundle of permission keys the
 * Users page can apply as a STARTING POINT for a user's grants. NOT a persistent role — applying it just
 * preselects its keys in the grant matrix, which the admin then edits + saves. Mirrors PermissionPresetDto.
 */
export interface PermissionPreset {
  key: string;
  label: string;
  description: string;
  permissions: string[];
}

export interface AuditEntry {
  id: number;
  whenUtc: string;
  /** Null when masked (email-reveal key absent/incorrect) and not the caller's own email. */
  actorEmail: string | null;
  action: string;
  /** Null when absent, OR when masked (email-reveal key absent/incorrect) and not the caller's own email. */
  targetEmail: string | null;
  detail: string | null;
}

/**
 * One recorded sign-in attempt in a user's login history (GET /api/users/{id}/logins).
 * Mirrors LoginEventDto on the API. `reason` is one of: "ok", "auto-provisioned",
 * "account disabled", "google id mismatch".
 */
export interface LoginEvent {
  id: number;
  whenUtc: string;
  ip: string;
  success: boolean;
  reason: string;
  name: string | null;
  userAgent: string | null;
}

export interface NotificationSettings {
  webhookConfigured: boolean;
  webhookMasked: string | null;
  enabled: boolean;
  digestHourLocal: number;
  dailyDigest: boolean;
  weeklyDigest: boolean;
  weeklyDay: number;
  thresholdEnabled: boolean;
  thresholdUsd: number;
  securityAlerts: boolean;
  mentionOnAlert: string | null;
}

export interface NotificationUpdate {
  discordWebhookUrl?: string | null;
  enabled: boolean;
  digestHourLocal: number;
  dailyDigest: boolean;
  weeklyDigest: boolean;
  weeklyDay: number;
  thresholdEnabled: boolean;
  thresholdUsd: number;
  securityAlerts: boolean;
  mentionOnAlert: string | null;
}

export interface HeatmapCell { day: number; hour: number; count: number; }

export interface UsageStats {
  totalActiveHours: number;
  activeDays: number;
  avgHoursPerActiveDay: number;
  totalSessions: number;
  avgSessionMinutes: number;
  longestSessionMinutes: number;
  totalCost: number;
  costPerActiveHour: number;
  mostActiveDay: string | null;
  mostActiveDayHours: number;
  currentStreakDays: number;
  longestStreakDays: number;
  busiestHour: number;
}

export interface SessionMessage {
  timestampUtc: string;
  model: string;
  projectName: string;
  input: number;
  output: number;
  total: number;
  cost: number;
  isSidechain: boolean;
}

export interface SessionDetail {
  sessionId: string;
  projectName: string | null;
  startUtc: string;
  endUtc: string;
  messages: number;
  tokens: number;
  cost: number;
  items: SessionMessage[];
}

export interface CalendarDay {
  date: string;
  costUsd: number;
  tokens: number;
  messages: number;
  sessions: number;
  activeMinutes: number;
  firstUtc: string | null;
  lastUtc: string | null;
}

export interface RequestLogEntry {
  id: number;
  whenUtc: string;
  method: string;
  path: string;
  queryString: string | null;
  statusCode: number;
  durationMs: number;
  /** The acting user's AppUser id, or null for an anonymous/unauthenticated request. Never an email (email-privacy). */
  userId: number | null;
  /** The acting user's display name, or null for an anonymous row. Never an email. */
  userName: string | null;
  clientIp: string | null;
  requestBytes: number | null;
  responseBytes: number | null;
  requestBody: string | null;
  responseBody: string | null;
}

// ---- AI usage log (admin oversight) ----

/**
 * One AI (Gemini) call captured at the GeminiService chokepoint. Carries NO prompt or response CONTENT —
 * only who called which feature, the model, how it went, and the token counts.
 */
export interface AiUsageRow {
  id: number;
  whenUtc: string;
  /** The acting user's AppUser id, or null for a background tick / an email with no AppUser. Never an email. */
  userId: number | null;
  /** The acting user's display name, or null for a background tick / unknown user. Never an email. */
  userName: string | null;
  /** The GeminiService "kind" / feature label, e.g. "schedule", "build-day", "money-coach". */
  feature: string;
  model: string;
  /** One of: "ok" | "unavailable" | "rate-limited" | "parse-failed" | "error". */
  outcome: string;
  /** The upstream HTTP status, or null when no response was received. */
  httpStatus: number | null;
  durationMs: number;
  promptTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  /** A short status/reason hint (never response content), e.g. "HTTP 503" or "timeout". */
  errorHint: string | null;
}

/** A {key,count} pair (top users / top features) in the AI-usage summary. */
export interface AiUsageCount {
  key: string;
  /** For a top-user entry: the AppUser id (null for a background tick or an unknown email). */
  userId?: number | null;
  count: number;
  totalTokens: number;
}

/** The summary block for the queried AI-usage window: totals, per-outcome counts, tokens, top users + features. */
export interface AiUsageSummary {
  totalCalls: number;
  /** outcome -> count (e.g. {"ok":120,"rate-limited":3}); only outcomes present in the window appear. */
  byOutcome: Record<string, number>;
  totalPromptTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  topUsers: AiUsageCount[];
  topFeatures: AiUsageCount[];
}

/** The GET /api/ai-usage payload: the page of rows (newest-first) plus the window summary. */
export interface AiUsageResponse {
  rows: AiUsageRow[];
  summary: AiUsageSummary;
}

/** Filters for getAiUsage. `user` is an AppUser id (raw emails are never accepted); dates are ISO strings. */
export interface AiUsageFilter {
  before?: number | null;
  limit?: number;
  user?: number | null;
  feature?: string;
  outcome?: string;
  from?: string;
  to?: string;
}

// ---- Chat + notifications (Phase 2) ----

/** A member of a chat channel/DM (minimal identity for avatars + online dots). Mirrors the member shape in ChatChannelDto. */
export interface ChatMember {
  /** The member's AppUser id (resolved server-side; no email is exposed in member payloads). */
  userId: number;
  name: string;
  picture?: string;
}

/**
 * One chat conversation — a named channel or a 1:1 direct message. `displayName` is server-computed
 * (channel name, or the other participant's name for a DM). `unreadCount` is the per-channel unread
 * MESSAGE count. Mirrors ChatChannelDto (camelCase JSON).
 */
export interface ChatChannelDto {
  id: number;
  kind: 'channel' | 'direct';
  name?: string;
  topic?: string;
  isPrivate: boolean;
  archived: boolean;
  displayName: string;
  members: ChatMember[];
  lastMessage?: ChatMessageDto;
  unreadCount: number;
}

/**
 * One emoji reaction group on a message: the emoji, how many people used it, and the AppUser ids of
 * who reacted with it. The client derives "mine" = `reactedByUserIds` contains the caller's own
 * userId (so no server-computed Mine field is needed and the same shape serves REST and the hub
 * broadcast). No emails are exposed. Mirrors ReactionGroupDto.
 */
export interface ReactionGroupDto {
  emoji: string;
  count: number;
  reactedByUserIds: number[];
}

/**
 * One chat message. `body` is null when `deleted` is true (render a muted placeholder).
 * `editedUtc` is set on edits. Timestamps are ISO-8601 UTC strings. Mirrors ChatMessageDto.
 */
export interface ChatMessageDto {
  id: number;
  channelId: number;
  /** Author's AppUser id (resolved server-side; the sender's email is never exposed). */
  senderUserId: number;
  senderName: string;
  senderPicture?: string;
  body: string | null;
  createdUtc: string;
  editedUtc?: string;
  deleted: boolean;
  /** Emoji reaction groups, ordered by first-reacted. Never null — defaults to an empty array. */
  reactions: ReactionGroupDto[];
}

/** One in-app notification (inbox / bell). The bell UI ships in Phase 2b. Mirrors NotificationDto. */
export interface NotificationDto {
  id: number;
  type: string;
  text: string;
  link?: string;
  actorUserId?: number | null;
  actorName?: string;
  isRead: boolean;
  createdUtc: string;
}

/**
 * Per-user notification delivery preferences (GET/PUT /api/inbox/preferences). The TRIGGER prefs
 * (notify*) gate whether the server creates a notification row at all; the SURFACE prefs
 * (surfaceToasts/surfaceBrowser) are applied CLIENT-SIDE to decide whether to pop an in-app toast or
 * an OS/browser notification when one arrives live. The bell + unread badge are shown regardless.
 * Mirrors NotificationPreferenceDto.
 */
export interface NotificationPreferenceDto {
  notifyDirectMessages: boolean;
  notifyMentions: boolean;
  notifyChannelMessages: boolean;
  notifySystemEvents: boolean;
  surfaceToasts: boolean;
  surfaceBrowser: boolean;
}

/**
 * Create-a-channel payload (POST /api/chat/channels). Members are sent by AppUser id (email-privacy):
 * the client holds no other-user emails; the server resolves each id to its internal email. Mirrors
 * CreateChannelRequest.
 */
export interface CreateChannelRequest {
  name: string;
  topic?: string;
  isPrivate: boolean;
  memberUserIds: number[];
}

/**
 * One person in a chat contact circle — the curated, admin-managed candidate list the New-DM /
 * channel-member picker draws from. Identity is the server-resolved `userId` + `name`; the raw email
 * is NEVER exposed (email-privacy). The picker drives DM-open / channel-create by this `userId`.
 * Mirrors ChatContactDto (camelCase JSON).
 */
export interface ChatContactDto {
  userId: number;
  name: string;
  picture?: string | null;
}

// ---- Chat AI assists (Gemini-backed; gated chat.read/chat.send, graceful on 503) ----

/**
 * "✨ Catch me up" result (POST /api/chat/channels/{id}/ai/catch-up). The server ALWAYS returns 200:
 * a deterministic plain floor (`fellBackToPlain` = true, calmer styling, no AI flourish) covers an
 * unconfigured/failed Gemini, so this never 503s. The summary is built from message BODY + sender
 * display NAME only — never an email (email-privacy). Mirrors the catch-up response shape.
 */
export interface ChatCatchUpResult {
  /** The recap of the channel's recent activity (or the deterministic plain floor when fell back). */
  summary: string;
  /** True when Gemini was unavailable and the deterministic plain summary was returned instead. */
  fellBackToPlain: boolean;
}

/**
 * "✨ Suggest replies" result (POST /api/chat/channels/{id}/ai/replies). 2-4 short reply suggestions
 * for the caller; tapping a chip fills the composer (it never sends — the user reviews + hits Send).
 * Gated chat.send + membership; 503-graceful (no floor — the affordance just steps aside).
 */
export interface ChatRepliesResult {
  replies: string[];
}

/** The compose-assist actions the /api/chat/ai/compose endpoint accepts (mirrors the server's set). */
export type ChatComposeAction = 'draft' | 'rewrite' | 'shorten' | 'friendlier' | 'formal';

/**
 * Compose-assist request (POST /api/chat/ai/compose). `draft` starts from a free-text prompt; the
 * other actions reshape the current composer draft. 400 when there's nothing to work from (empty
 * prompt AND empty draft) or an unknown action; 503-graceful otherwise. Mirrors ComposeAssistRequest.
 */
export interface ChatComposeRequest {
  /** The free-text instruction (only used by the "draft" action). */
  prompt?: string;
  /** The current composer text (used by rewrite/shorten/friendlier/formal). */
  currentDraft?: string;
  action: ChatComposeAction;
}

/** Compose-assist result (POST /api/chat/ai/compose): the composed text to drop into the composer. */
export interface ChatComposeResult {
  body: string;
}

// ---- Food & fitness tracker (Phase 2) ----

/** Tracker macro/exercise goal preset (mirrors the backend goal enum names). */
export type TrackerGoal = 'LoseWeight' | 'Maintain' | 'GainMuscle' | 'Endurance';

/** Biological sex for metabolic estimates (BMR/TDEE). "Unspecified" => no BMR/TDEE computed. Mirrors BiologicalSex. */
export type Sex = 'Unspecified' | 'Male' | 'Female';

/** Activity level for the TDEE multiplier. Mirrors ActivityLevel (default Sedentary). */
export type ActivityLevel = 'Sedentary' | 'Light' | 'Moderate' | 'Active' | 'VeryActive';

/** Display unit preference. Backend always stores/returns metric (kg + cm). Mirrors UnitSystem. */
export type UnitSystem = 'Metric' | 'Imperial';

/** Which meal a food entry belongs to. */
export type Meal = 'breakfast' | 'lunch' | 'dinner' | 'snack';

/** Whether a food's calories/macros are quoted per listed serving or per 100 g. */
export type NutritionBasis = 'perServing' | 'per100g';

/**
 * One USDA food-search hit (GET /api/foods/search or /api/foods/{fdcId}). Calories/macros are quoted
 * either per serving or per 100 g (see `basis`); the add-food dialog scales them by quantity.
 * Mirrors FoodSearchItemDto.
 */
export interface FoodSearchItemDto {
  fdcId: number;
  description: string;
  brand?: string;
  gtinUpc?: string;
  calories: number;
  proteinG: number;
  carbG: number;
  fatG: number;
  servingSize?: number;
  servingUnit?: string;
  basis: NutritionBasis;
  /** Which provider produced this hit: "usda" | "fatsecret". */
  source: string;
  /** Provider-native id (USDA: fdcId as string; FatSecret: food_id), or null. */
  sourceId?: string;
}

/** One logged food entry on a tracker day (calories/macros are the SNAPSHOT scaled by quantity). Mirrors FoodEntryDto. */
export interface FoodEntryDto {
  id: number;
  meal: Meal;
  fdcId?: number;
  description: string;
  brand?: string;
  quantity: number;
  servingDesc?: string;
  calories: number;
  proteinG: number;
  carbG: number;
  fatG: number;
}

/**
 * One WorkoutX catalog exercise (GET /api/tracker/workoutx/exercises). The GIF is omitted on purpose —
 * the provider's gifUrl needs the secret key, so the client loads the demo via the key-authenticated
 * proxy at GET /api/tracker/workoutx/gif/{id} (responseType blob, JWT-authorized). `caloriesPerMinute`
 * drives the live estimate: round(caloriesPerMinute * durationMin). Mirrors WorkoutXExerciseDto.
 */
export interface WorkoutXExerciseDto {
  /** Provider id, e.g. "0001". Used as the gif-proxy path segment. */
  id: string;
  name: string;
  bodyPart: string;
  equipment: string;
  target: string;
  secondaryMuscles: string[];
  instructions: string[];
  category: string;
  difficulty: string;
  met: number;
  caloriesPerMinute: number;
  description?: string | null;
  recommendedSets?: string | null;
  recommendedReps?: string | null;
}

/** A page of WorkoutX exercises plus the catalog-wide total for the active filter (for paging). Mirrors WorkoutXSearchResultDto. */
export interface WorkoutXSearchResultDto {
  total: number;
  data: WorkoutXExerciseDto[];
}

/** One exercise from the library (GET /api/tracker/exercises). MET drives the server-side calorie estimate. Mirrors ExerciseLibraryDto. */
export interface ExerciseLibraryDto {
  id: number;
  name: string;
  category: string;
  met: number;
  goals: string[];
}

/** One logged exercise entry on a tracker day. Mirrors ExerciseEntryDto. */
export interface ExerciseEntryDto {
  id: number;
  exerciseId?: number;
  name: string;
  durationMin?: number;
  caloriesBurned: number;
}

/**
 * The caller's tracker profile / goals (GET/PUT /api/tracker/profile). `weightKg` comes back null when
 * viewing someone else's tracker (by design). Mirrors TrackerProfileDto.
 */
export interface TrackerProfileDto {
  goal: string;
  weightKg?: number;
  dailyCalorieGoal?: number;
  proteinGoalG?: number;
  carbGoalG?: number;
  fatGoalG?: number;
  shareWithContacts: boolean;
  /** Date of birth as `yyyy-MM-dd`, or null. Age is derived from this server-side. */
  dateOfBirth?: string | null;
  /** Height in centimetres (backend always metric), or null. */
  heightCm?: number;
  /** Biological sex for metabolic estimates ("Unspecified" => no BMR/TDEE). */
  sex: Sex;
  /** Activity level driving the TDEE multiplier. */
  activityLevel: ActivityLevel;
  /** Goal weight in kilograms (backend always metric), or null. */
  goalWeightKg?: number;
  /** Display unit preference; backend stores/returns metric regardless. */
  unitSystem: UnitSystem;
  /** Daily hydration goal in millilitres (backend always metric ml), or null to use the 2000 ml default. */
  hydrationGoalMl?: number;
  /** Daily coffee goal/cap in cups, or null to use the 3-cup default. */
  coffeeGoalCups?: number;
  /** Daily step goal (UI defaults to ~10000 when unset), or null. */
  stepGoal?: number;
}

/**
 * Computed body/metabolic stats for the CURRENT profile (server-computed from the profile). Any field
 * whose inputs are missing comes back null (partial stats are fine — e.g. BMI without BMR). The WHOLE
 * object is null in the readOnly/viewer branch (body metrics must not leak). Mirrors TrackerStatsDto.
 */
export interface TrackerStatsDto {
  age?: number | null;
  bmi?: number | null;
  bmiCategory?: string | null;
  bmr?: number | null;
  tdee?: number | null;
  suggestedCalorieGoal?: number | null;
  suggestedProteinG?: number | null;
  suggestedCarbG?: number | null;
  suggestedFatG?: number | null;
}

/** One point in the weight trend (GET /api/tracker/weight). Mirrors WeightPointDto. */
export interface WeightPointDto {
  date: string;
  weightKg: number;
}

/**
 * One logged hydration (fluid-intake) entry on a tracker day. Amount is always stored/returned in
 * millilitres (the UI converts to oz for Imperial). `label` is an optional drink name (Water/Coffee/…).
 * `createdUtc` is an ISO-8601 UTC string. Mirrors HydrationEntryDto.
 */
export interface HydrationEntryDto {
  id: number;
  amountMl: number;
  label?: string;
  createdUtc: string;
}

/**
 * One logged coffee entry on a tracker day. `cups` is a whole number (server-clamped 1..20).
 * `caffeineMg` is an optional caffeine amount and `label` an optional drink name (Mug/Espresso/…).
 * `createdUtc` is an ISO-8601 UTC string. Mirrors CoffeeEntryDto.
 */
export interface CoffeeEntryDto {
  id: number;
  cups: number;
  caffeineMg?: number;
  label?: string;
  createdUtc: string;
}

/** How a day's watch active-calories combine with the logged-exercise sum. Mirrors ActivityCalorieMode. */
export type ActivityCalorieMode = 'add' | 'override';

/**
 * The day's manually-recorded smartwatch stats (steps, distance, active calories) plus how the active
 * calories factor into the day's burn. `calorieMode` is "add" (active calories on top of logged
 * exercises) or "override" (active calories replace the logged-exercise sum). All metric — distance is
 * metres; the UI converts to mi/km. Null on a day with no watch row. Mirrors WatchActivityDto.
 */
export interface WatchActivityDto {
  steps?: number;
  distanceMeters?: number;
  activeCalories?: number;
  calorieMode: ActivityCalorieMode;
}

/**
 * Upsert-the-day's-watch-stats payload (PUT /api/tracker/activity). OWN tracker only (resolves to the
 * caller; no user param). `distanceMeters` is always metric metres; the UI converts from the user's
 * display units before sending. Mirrors UpsertActivityRequest.
 */
export interface UpsertActivityRequest {
  date: string;
  steps?: number | null;
  distanceMeters?: number | null;
  activeCalories?: number | null;
  calorieMode: ActivityCalorieMode;
}

/** Which part of the day a weigh-in was taken (so several can coexist per day). Mirrors WeightSlot. */
export type WeightSlot = 'Morning' | 'Afternoon' | 'Evening' | 'Unspecified';

/**
 * Log-today's-weight payload (POST /api/tracker/weight). `slot` lets several weigh-ins coexist on one
 * day; omit/Unspecified for the back-compat single-per-day behavior. Mirrors LogWeightRequest.
 */
export interface LogWeightRequest {
  date: string;
  weightKg: number;
  /** Slot name: Morning | Afternoon | Evening | Unspecified. Omitted => Unspecified. */
  slot?: WeightSlot;
}

/** Per-slot weight statistics (GET /api/tracker/weight/stats). Weight is always kg. Mirrors WeightSlotStatDto. */
export interface WeightSlotStatDto {
  /** Slot name: Unspecified | Morning | Afternoon | Evening. */
  slot: WeightSlot;
  avgKg: number;
  latestKg: number;
  count: number;
}

/** One weigh-in (date + slot) for the stats view. Weight is always kg. Mirrors WeightStatEntryDto. */
export interface WeightStatEntryDto {
  date: string;
  slot: WeightSlot;
  weightKg: number;
}

/**
 * The caller's OWN weight statistics (GET /api/tracker/weight/stats). Per-slot averages/latest/counts,
 * the typical morning→evening delta (avg evening − avg morning; null when either slot has no reading),
 * and recent readings. PRIVATE — owner-only. Mirrors WeightStatsDto.
 */
export interface WeightStatsDto {
  bySlot: WeightSlotStatDto[];
  /** Avg evening minus avg morning (kg); null when morning or evening has no readings. */
  morningEveningDeltaKg: number | null;
  entries: WeightStatEntryDto[];
}

// ---- AI assists (Gemini-backed; each may 503 when unconfigured) ----

/**
 * Estimate-macros request (POST /api/ai/estimate-macros). `description` is free-text food; `quantity`
 * is an optional free-text amount ("2 eggs", "100 g"). Mirrors EstimateMacrosRequest.
 */
export interface EstimateMacrosRequest {
  description: string;
  quantity?: string;
}

/** An AI macro estimate (clamped server-side). `note` is an optional model assumption. Mirrors EstimateMacrosResponse. */
export interface EstimateMacrosResponse {
  calories: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  note?: string | null;
}

/** A suggested daily target from the caller's own profile (POST /api/ai/suggest-goal). Mirrors SuggestGoalResponse. */
export interface SuggestGoalResponse {
  calorieTarget: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  rationale?: string | null;
}

/** Estimate-exercise request (POST /api/ai/estimate-exercise). Mirrors EstimateExerciseRequest. */
export interface EstimateExerciseRequest {
  name: string;
  durationMin: number;
}

/** An AI exercise-calorie estimate (clamped server-side). `note` is an optional model assumption. Mirrors EstimateExerciseResponse. */
export interface EstimateExerciseResponse {
  caloriesBurned: number;
  note?: string | null;
}

/** Parse-exercise request (POST /api/ai/parse-exercise). Free-text exercise log ("3x10 squats", "jogged 2mi"). Mirrors ParseExerciseRequest. */
export interface ParseExerciseRequest {
  text: string;
}

/**
 * A parsed exercise (clamped server-side; calories use the CALLER's own body weight read server-side).
 * Mirrors ParseExerciseResponse.
 */
export interface ParseExerciseResponse {
  name: string;
  calories: number;
  durationMin?: number | null;
  sets?: number | null;
  reps?: number | null;
  /** Free-text distance the model extracted (e.g. "2 mi"), or null. */
  distanceText?: string | null;
  note?: string | null;
}

/** Suggest-workout request (POST /api/ai/suggest-workout): a focus area, minutes, and optional equipment. Mirrors SuggestWorkoutRequest. */
export interface SuggestWorkoutRequest {
  focus: string;
  minutes: number;
  equipment?: string;
}

/** One suggested exercise in a workout plan. Mirrors WorkoutItemDto. */
export interface WorkoutItemDto {
  name: string;
  setsReps: string;
  note?: string | null;
}

/** A suggested workout (POST /api/ai/suggest-workout). `estCalories` is clamped server-side. Mirrors SuggestWorkoutResponse. */
export interface SuggestWorkoutResponse {
  title: string;
  items: WorkoutItemDto[];
  estCalories: number;
}

/** Parse-meal request (POST /api/ai/parse-meal): free-text meal to split into items ("Big Mac, fries, Coke"). Mirrors ParseMealRequest. */
export interface ParseMealRequest {
  text: string;
}

/** One parsed food item (clamped server-side). Mirrors MealItemDto. */
export interface MealItemDto {
  description: string;
  calories: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
}

/** A parsed meal: zero or more items, each with clamped macros (POST /api/ai/parse-meal). Mirrors ParseMealResponse. */
export interface ParseMealResponse {
  items: MealItemDto[];
}

/**
 * A base64-encoded image + mime type for the multimodal photo features (POST /api/ai/photo-meal,
 * /api/ai/read-label). `imageBase64` is the raw base64 (NO `data:` prefix); `mimeType` is one of
 * image/jpeg, image/png, image/webp. Mirrors ImageRequest.
 */
export interface ImageRequest {
  imageBase64: string;
  mimeType: string;
}

/** A single nutrition-label read from a photo (POST /api/ai/read-label; clamped server-side). Mirrors ReadLabelResponse. */
export interface ReadLabelResponse {
  description: string;
  calories: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  /** The serving size the label states (e.g. "1 cup (240 ml)"), or null. */
  servingSize?: string | null;
}

/** A suggested food to round out the day (clamped server-side). Mirrors FoodSuggestionDto. */
export interface FoodSuggestionDto {
  food: string;
  why?: string | null;
  calories: number;
  proteinG: number;
}

/**
 * Food suggestions to hit the caller's remaining targets (POST /api/ai/suggest-foods; reads the caller's
 * OWN remaining calories/macros today server-side — empty body). Mirrors SuggestFoodsResponse.
 */
export interface SuggestFoodsResponse {
  suggestions: FoodSuggestionDto[];
}

/** Meal-feedback request (POST /api/ai/meal-feedback): a free-text meal to get a verdict + swaps for. Mirrors MealFeedbackRequest. */
export interface MealFeedbackRequest {
  description: string;
}

/** A quick verdict on a meal + healthier swaps (POST /api/ai/meal-feedback). Mirrors MealFeedbackResponse. */
export interface MealFeedbackResponse {
  verdict: string;
  goodForGoal: boolean;
  swaps: string[];
}

/** Recipe-macros request (POST /api/ai/recipe-macros): a free-text recipe + number of servings. Mirrors RecipeMacrosRequest. */
export interface RecipeMacrosRequest {
  recipe: string;
  servings?: number;
}

/** Per-serving macros (clamped server-side). Mirrors MacroSet. */
export interface MacroSet {
  calories: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
}

/** Per-serving macros for a recipe (POST /api/ai/recipe-macros). Mirrors RecipeMacrosResponse. */
export interface RecipeMacrosResponse {
  perServing: MacroSet;
}

/** A short daily-coaching insight + actionable tips (GET /api/ai/daily-coach; cached server-side). Mirrors DailyCoachResponse. */
export interface DailyCoachResponse {
  insight: string;
  tips: string[];
}

/** A short weekly review + one forward-looking suggestion (GET /api/ai/weekly-review; cached). Mirrors WeeklyReviewResponse. */
export interface WeeklyReviewResponse {
  summary: string;
  suggestion: string;
}

/** A short insight on the caller's weight stats + a trend label (GET /api/ai/weight-insight; cached). Mirrors WeightInsightResponse. */
export interface WeightInsightResponse {
  insight: string;
  trend: string;
}

/** A suggested daily hydration target in ml (clamped 0..10000) + rationale (POST /api/ai/hydration-suggest; reads profile, empty body). Mirrors HydrationSuggestResponse. */
export interface HydrationSuggestResponse {
  targetMl: number;
  rationale?: string | null;
}

/** Parse-hydration request (POST /api/ai/parse-hydration): free-text drinks ("2 coffees and a big water"). Mirrors ParseHydrationRequest. */
export interface ParseHydrationRequest {
  text: string;
}

/** One parsed drink (clamped server-side). Mirrors HydrationItemDto. */
export interface HydrationItemDto {
  label: string;
  ml: number;
}

/** Parsed drinks from a free-text hydration description (POST /api/ai/parse-hydration). Mirrors ParseHydrationResponse. */
export interface ParseHydrationResponse {
  items: HydrationItemDto[];
}

/** Natural-goal request (POST /api/ai/natural-goal): a free-text goal ("lose 10 lbs in 3 months"). Mirrors NaturalGoalRequest. */
export interface NaturalGoalRequest {
  text: string;
}

/**
 * A structured goal parsed from free text (POST /api/ai/natural-goal; clamped server-side). `realistic`
 * flags whether the model judged the timeline sensible. Mirrors NaturalGoalResponse.
 */
export interface NaturalGoalResponse {
  calorieTarget: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  timeline?: string | null;
  realistic: boolean;
  rationale?: string | null;
}

// ---- AI Day Builder (POST /api/ai/build-day, /api/ai/day-summary, /api/tracker/day/commit) ----

/**
 * One answer to a server-issued clarifying question from the prior build-day round (mirrors ClarifyAnswer).
 * `questionId` is the id the server assigned that question ("q1", "q2"…); `answer` is the user's reply
 * (blank = "skip — best-guess"). Sent back on a refine round.
 */
export interface ClarifyAnswer {
  questionId: string;
  questionText?: string;
  answer: string;
}

/**
 * One AI-drafted food item (mirrors DraftFood). Note the SINGULAR `carbG` (tracker convention) so it maps
 * 1:1 onto a FoodEntry at commit. `confidence` is 0..1 (the UI derives "estimated"/"guess" chips);
 * `clamped` is true when any number was capped down from the raw model output. All numbers are clamped
 * server-side on the way out AND again at commit.
 */
export interface DraftFood {
  description: string;
  /** The resolved free-text portion ("2 eggs", "1 cup"); display only. */
  quantity?: string | null;
  brand?: string | null;
  calories: number;
  proteinG: number;
  carbG: number;
  fatG: number;
  confidence: number;
  clamped: boolean;
}

/** One meal in the draft (mirrors MealDraft): its meal slot + its food items. */
export interface MealDraft {
  meal: Meal;
  items: DraftFood[];
}

/** One AI-drafted exercise (mirrors DraftExercise). Numbers clamped server-side. */
export interface DraftExercise {
  name: string;
  durationMin?: number | null;
  caloriesBurned: number;
  confidence: number;
  clamped: boolean;
}

/** One AI-drafted drink (mirrors DraftDrink). `ml` clamped 1..5000. */
export interface DraftDrink {
  label?: string | null;
  ml: number;
}

/** The AI-drafted body-weight reading (mirrors DraftWeight). Clamped 1..1000 kg. */
export interface DraftWeight {
  weightKg: number;
  /** "morning" | "afternoon" | "evening" | "unspecified". */
  slot: string;
}

/** The AI-drafted watch activity (mirrors DraftActivity). Distance is METRES (model emits km, ×1000). */
export interface DraftActivity {
  steps?: number | null;
  distanceMeters?: number | null;
  activeCalories?: number | null;
  /** "add" | "override". */
  calorieMode: ActivityCalorieMode;
}

/**
 * The editable day draft (mirrors DayDraft) — the model's reconstruction of the whole day. Used as both
 * the build-day response and (echoed back, fully untrusted) the refine input. Every number is re-clamped
 * server-side on the way out AND again at commit.
 */
export interface DayDraft {
  meals: MealDraft[];
  exercises: DraftExercise[];
  hydration: DraftDrink[];
  weight?: DraftWeight | null;
  activity?: DraftActivity | null;
  /** The assumptions the model made (resolved portions, sizes). */
  assumptions: string[];
  /** A 1–2 sentence summary of the reconstructed day. */
  summary: string;
}

/**
 * One clarifying question the model asked (mirrors ClarifyQuestion). The id is SERVER-generated (never
 * model-chosen). `kind` is "text" | "yesno" | "choice"; `choices` is present only for "choice".
 */
export interface ClarifyQuestion {
  questionId: string;
  text: string;
  kind: string;
  choices?: string[] | null;
}

/**
 * Build-day request (POST /api/ai/build-day; mirrors BuildDayRequest). `text` is the end-of-day brain-dump;
 * `date` is echoed for display only; `localTimeOfDay` ("HH:mm") helps resolve "this morning"/"tonight".
 * `images` are optional meal photos (capped 4). For a refine round, send `priorDraft` + `answers` to the
 * prior round's questions — refines are TEXT-ONLY (never resend photos). NOTHING is persisted.
 */
export interface BuildDayRequest {
  text?: string;
  date?: string;
  localTimeOfDay?: string;
  images?: ImageRequest[];
  answers?: ClarifyAnswer[];
  priorDraft?: DayDraft | null;
}

/**
 * Build-day response (mirrors BuildDayResponse): a server-issued idempotency `buildId` (REQUIRED by
 * commit; a re-run yields a new one), the editable `draft`, any clarifying `questions` (empty => ready to
 * review), and the refine `round` (1 on first build). `notes` is an optional one-line model note.
 */
export interface BuildDayResponse {
  buildId: string;
  draft: DayDraft;
  questions: ClarifyQuestion[];
  round: number;
  notes?: string | null;
}

/** Day-summary request (POST /api/ai/day-summary; mirrors DaySummaryRequest). Body carries only a date. */
export interface DaySummaryRequest {
  date?: string;
}

/**
 * A celebratory end-of-day recap of the LOGGED day (mirrors DaySummaryResponse; read server-side, cached
 * ~6h). `headline` is a one-liner; `highlights` are up to 4 bullets; `tomorrow` is an optional forward
 * nudge. When nothing is logged the server returns a "Nothing logged yet today." headline + empty rest.
 */
export interface DaySummaryResponse {
  headline: string;
  highlights: string[];
  tomorrow?: string | null;
}

/**
 * Commit-the-whole-day request (POST /api/tracker/day/commit; mirrors CommitDayRequest). Atomic +
 * idempotent: send the server-issued `buildId` from build-day, the `date` ("yyyy-MM-dd"), and the
 * user-EDITED `draft` (re-validated + clamped server-side). Nothing is written until this call.
 */
export interface CommitDayRequest {
  buildId: string;
  date: string;
  draft: DayDraft;
}

/** How many of each kind the commit logged (mirrors CommitCounts). `weight`/`activity` are booleans. */
export interface CommitCounts {
  foods: number;
  exercises: number;
  drinks: number;
  weight: boolean;
  activity: boolean;
}

/**
 * Commit-the-whole-day response (mirrors CommitDayResponse). `alreadyCommitted` is true when the same
 * `buildId` was already committed (a double-submit) — nothing was re-written. `logged` is the per-kind
 * counts; `day` is the rebuilt authoritative day to render.
 */
export interface CommitDayResponse {
  alreadyCommitted: boolean;
  logged: CommitCounts;
  day: TrackerDayDto;
}

/** The categories a "Move day" can move. null/empty in the request = all of them. */
export type MoveDayCategory = 'food' | 'exercise' | 'hydration' | 'weight' | 'activity';

/**
 * Move-a-day payload (POST /api/tracker/day/move; OWN tracker only). Re-dates the caller's own entries
 * from `fromDate` onto `toDate` for the chosen `categories` (omit/empty = all). For the one-per-day
 * domains (weight/activity) the moved entry replaces any conflicting entry already on `toDate`.
 * Mirrors MoveDayRequest.
 */
export interface MoveDayRequest {
  /** Source local date (YYYY-MM-DD) to move entries OFF of. */
  fromDate: string;
  /** Target local date (YYYY-MM-DD) to move entries ONTO. Must differ from `fromDate`. */
  toDate: string;
  /** Subset of categories to move; omit/empty = all. */
  categories?: MoveDayCategory[];
}

/** How many rows of each domain were re-dated onto the target date. Mirrors MoveDayCounts. */
export interface MoveDayCounts {
  food: number;
  exercise: number;
  hydration: number;
  weight: number;
  /** True when the source date had an activity row that was moved onto the target. */
  activity: boolean;
}

/** What target-date rows the move replaced (the moved entry wins on a one-per-day conflict). Mirrors MoveDayReplaced. */
export interface MoveDayReplaced {
  /** How many target weight rows (same slot) were deleted so the moved reading could win. */
  weight: number;
  /** True when a target activity row was deleted so the moved one could win. */
  activity: boolean;
}

/** Outcome of a day move: per-domain counts re-dated, what was replaced, and the echoed target date. Mirrors MoveDayResponse. */
export interface MoveDayResult {
  moved: MoveDayCounts;
  replaced: MoveDayReplaced;
  /** The target date entries were moved onto (YYYY-MM-DD). */
  toDate: string;
}

/**
 * Log-a-drink payload (POST /api/tracker/hydration). `amountMl` is always metric ml (1..5000); the UI
 * converts from the user's display units before sending. `label` is an optional drink name (<=64 chars).
 * Mirrors AddHydrationRequest.
 */
export interface AddHydrationRequest {
  date: string;
  amountMl: number;
  label?: string;
}

/**
 * Log-a-coffee payload (POST /api/tracker/coffee). `cups` is a whole number (server-clamped 1..20).
 * `caffeineMg` is an optional caffeine amount; `label` an optional drink name (<=64 chars).
 * Mirrors AddCoffeeRequest.
 */
export interface AddCoffeeRequest {
  date: string;
  cups: number;
  caffeineMg?: number;
  label?: string;
}

/**
 * A full tracker day (GET /api/tracker/day). `readOnly` is true when viewing someone else's tracker —
 * the UI then hides all add/delete controls. Totals are server-computed. Mirrors TrackerDayDto.
 */
export interface TrackerDayDto {
  date: string;
  /** The day owner's AppUser id (the caller's own id for the caller's day). Never an email (email-privacy). */
  userId: number;
  /** The day owner's display name. Never an email. */
  userName: string;
  readOnly: boolean;
  profile: TrackerProfileDto;
  /** Computed body/metabolic stats from the profile; null when viewing someone else (privacy). */
  stats?: TrackerStatsDto | null;
  foods: FoodEntryDto[];
  exercises: ExerciseEntryDto[];
  caloriesIn: number;
  /**
   * Resolved calories burned: the logged-exercise sum combined with the watch active calories per the
   * day's {@link WatchActivityDto.calorieMode} (add → exercise + active; override → active replaces the
   * sum). Equals {@link exerciseCalories} when there's no watch row / no active-calories value.
   */
  caloriesOut: number;
  netCalories: number;
  proteinG: number;
  carbG: number;
  fatG: number;
  calorieGoal?: number;
  remaining?: number;
  /** Total fluid intake logged for the day, in millilitres (sum of all hydration entries). */
  hydrationMl: number;
  /** Resolved daily hydration goal in ml: the profile's goal, or the 2000 ml server default. */
  hydrationGoalMl: number;
  /** The day's hydration entries, oldest-first (by id). Visible even when read-only (like food/exercise). */
  hydration: HydrationEntryDto[];
  /** Total cups of coffee logged for the day (sum of all coffee entries). */
  coffeeCups: number;
  /** Total caffeine (mg) logged for the day across coffee entries (0 when none specified). */
  caffeineMg: number;
  /** Resolved daily coffee goal/cap in cups: the profile's goal, or the 3-cup server default. */
  coffeeGoalCups: number;
  /** The day's coffee entries, oldest-first (by id). Visible even when read-only (like food/exercise). */
  coffee: CoffeeEntryDto[];
  /** The day's manually-recorded smartwatch stats + calorie mode, or null when no watch row exists. */
  activity?: WatchActivityDto | null;
  /** Resolved daily step goal (the profile's goal), or null when unset. */
  stepGoal?: number;
  /** Raw logged-exercise calorie sum for the day, BEFORE the watch add/override is applied. */
  exerciseCalories: number;
}

/** Someone whose tracker the caller may view read-only (GET /api/tracker/shared). Mirrors SharedUserDto. */
export interface SharedUserDto {
  /** The shared user's AppUser id (the client opens their tracker via GET /day?user={userId}). Never an email (email-privacy). */
  userId: number;
  name: string;
  picture?: string;
}

/** Log-a-food payload (POST /api/tracker/food) — snapshot the scaled calories/macros into the request. Mirrors AddFoodRequest. */
export interface AddFoodRequest {
  date: string;
  meal: string;
  fdcId?: number;
  description: string;
  brand?: string;
  quantity: number;
  servingDesc?: string;
  calories: number;
  proteinG: number;
  carbG: number;
  fatG: number;
  /**
   * The provider the food came from ("usda" | "fatsecret" | "custom"), or null/omitted when MANUALLY
   * typed. A manual log (no source + no fdcId) gets auto-saved to the caller's "My foods" library.
   */
  source?: string;
}

/**
 * One of the caller's saved "My foods" (GET /api/tracker/foods/saved) — a per-user library auto-built
 * from manual food logs. Calories/macros are the verbatim totals first logged; the dialog can scale
 * them by quantity when re-picking. Mirrors CustomFoodDto.
 */
export interface CustomFoodDto {
  id: number;
  description: string;
  brand?: string;
  servingDesc?: string;
  calories: number;
  proteinG: number;
  carbG: number;
  fatG: number;
  useCount: number;
}

/**
 * Log-an-exercise payload (POST /api/tracker/exercise). Pass `exerciseId` + `durationMin` (with a
 * profile weight) to let the server estimate `caloriesBurned`; otherwise `caloriesBurned` is required.
 * Mirrors AddExerciseRequest.
 */
export interface AddExerciseRequest {
  date: string;
  exerciseId?: number;
  name?: string;
  durationMin?: number;
  caloriesBurned?: number;
  /**
   * Where the exercise came from ("library" | "workoutx" | "custom"), or null/omitted when MANUALLY
   * typed. A manual log (no source + no exerciseId) gets auto-saved to the caller's "My exercises"
   * library; a "custom" log (re-picked from My exercises) bumps that saved row's use count.
   */
  source?: string;
}

/**
 * One of the caller's saved "My exercises" (GET /api/tracker/exercises/saved) — a per-user library
 * auto-built from manual exercise logs. The defaults are the calories/duration last logged; re-picking
 * one prefills the manual form. Mirrors CustomExerciseDto.
 */
export interface CustomExerciseDto {
  id: number;
  name: string;
  defaultCaloriesBurned?: number;
  defaultDurationMin?: number;
  useCount: number;
}

// ---- Family Hub (foundation) ----

/**
 * The caller's household with its resolved members (GET /api/family/household; auto-provisioned on first
 * read with the caller as OWNER). Members carry display identity only — userId + name + picture + role —
 * and NEVER an email (email-privacy; the backend stores none here). Mirrors HouseholdDto.
 */
export interface Household {
  id: number;
  name: string;
  members: HouseholdMember[];
}

/**
 * One member of the household. Identity is `userId` + display `name` (+ optional `picture`); no email is
 * ever exposed. `role` is the member's household role ("owner" | "adult"); `isSelf` is true for the
 * caller's own row (server-computed). Mirrors MemberDto.
 */
export interface HouseholdMember {
  userId: number;
  name: string;
  picture?: string | null;
  role: string;
  isSelf: boolean;
}

/**
 * One household member's latest pin on the family-finder map (GET /api/family/locations). Identity is
 * `userId` + display `name` only — no email is ever on the wire. The precise lat/lng is present because,
 * for the family-finder, the member's household-sharing opt-in IS the consent to show their exact latest
 * location to the household. The caller always sees their own pin (`isSelf` = true); other members appear
 * only when they share AND have a recent fix. Mirrors FamilyMemberLocationDto.
 */
export interface FamilyMemberLocation {
  userId: number;
  name: string;
  /** True for the caller's own pin (always included if they have any history, regardless of sharing). */
  isSelf: boolean;
  lat: number;
  lng: number;
  city?: string | null;
  region?: string | null;
  country?: string | null;
  accuracyM?: number | null;
  capturedUtc: string;
}

/**
 * A person the owner may add to the household (GET /api/family/household/candidates) — the caller's
 * circle / family-capable users not yet in a household. Identity is `userId` + `name` (+ optional
 * `picture`); never an email. The picker adds by `userId`. Mirrors CandidateDto.
 */
export interface HouseholdCandidate {
  userId: number;
  name: string;
  picture?: string | null;
}

// ---- Family Hub F1: shared notes & lists ----

/**
 * A person a family item is shared with (mirrors ShareTargetDto). Identity is `userId` + display `name`;
 * never an email (email-privacy). `canEdit` is the share's edit flag. Only populated on items the caller
 * manages (a household member) — shared-in contacts never see the full share roster.
 */
export interface FamilyShareTarget {
  userId: number;
  name: string;
  canEdit: boolean;
}

/**
 * A shared family note (mirrors NoteDto). Body is markdown text (rendered client-side). Author identity is
 * `createdByUserId` + `createdByName`; no email. `isMine` is true when the caller authored it; `canEdit` is
 * true for household members or canEdit-shares (read-only otherwise). `sharedWith` lists the share targets
 * (only for items the caller manages).
 */
export interface FamilyNote {
  id: number;
  title: string;
  body: string;
  pinned: boolean;
  createdByUserId: number;
  createdByName: string;
  updatedUtc: string;
  isMine: boolean;
  canEdit: boolean;
  sharedWith: FamilyShareTarget[];
}

/** A list's kind — fast add+check-off groceries, or assignable to-dos. Mirrors the backend "shopping"/"todo". */
export type FamilyListKind = 'shopping' | 'todo';

/**
 * One item on a family list (mirrors ListItemDto). `done` strikes it through; `doneByName` is who checked
 * it (identity by userId + name, never email). To-do items may carry an `assignedToUserId` + name (a
 * household member / shared person), shown as an assignee avatar.
 */
export interface FamilyListItem {
  id: number;
  text: string;
  done: boolean;
  doneByUserId?: number | null;
  doneByName?: string | null;
  assignedToUserId?: number | null;
  assignedToName?: string | null;
  sortOrder: number;
}

/**
 * A shared family list with its items (mirrors ListDto). `kind` groups Shopping vs To-do. Same identity +
 * access rules as a note: `canEdit` gates writes, `sharedWith` lists share targets for managers only.
 */
export interface FamilyList {
  id: number;
  name: string;
  kind: FamilyListKind;
  createdByUserId: number;
  createdByName: string;
  isMine: boolean;
  canEdit: boolean;
  sharedWith: FamilyShareTarget[];
  items: FamilyListItem[];
}

// ---- Family Hub F7: Quick-Add (one-line capture → list item / reminder / note) ----

/**
 * What kind a quick-add line should become. `auto` (the default) lets the server route by the text's
 * leading keyword/time phrase; the rest force a specific kind. Mirrors the backend's lowercase strings.
 */
export type QuickAddKind = 'auto' | 'list' | 'reminder' | 'note';

/**
 * Request body for POST /api/family/quick-add. `text` is the captured line; `kind` defaults to `auto`;
 * `listName` is only honoured when `kind` resolves to a list (else the server uses its "Quick Capture"
 * default). No identity travels on the wire — the acting user is the caller's JWT (web) or ingest-key
 * owner (desktop agent), resolved server-side.
 */
export interface QuickAddRequest {
  text: string;
  kind?: QuickAddKind;
  listName?: string;
}

/**
 * Result of a quick-add (mirrors QuickAddResult): the RESOLVED `kind` ("list" | "reminder" | "note"),
 * the new item's `createdId`, and a warm one-line `summary` ready to show in a toast — e.g.
 * `Added "milk" to Quick Capture.` or `I'll remind you to call the dentist.`
 */
export interface QuickAddResult {
  kind: 'list' | 'reminder' | 'note';
  createdId: number;
  summary: string;
}

// ---- Family Hub F2: reminders & timers ----

/** How a reminder repeats. Mirrors the backend's lowercase strings. */
export type FamilyRecurrence = 'none' | 'daily' | 'weekly' | 'weekdays';

/**
 * A household reminder (mirrors ReminderDto). People are identified by `targetUserId`/`createdByUserId`
 * + display name only — never an email (email-privacy). `dueUtc` is an ISO UTC instant (rendered in the
 * viewer's LOCAL time); `recurrence` drives the chip; `active` is false once a one-shot has fired (a
 * recurring reminder stays active, its `dueUtc` advancing to the next occurrence). When it fires the alert
 * arrives through the existing notification bell/toast — no per-reminder delivery UI here.
 */
export interface FamilyReminder {
  id: number;
  text: string;
  dueUtc: string;
  recurrence: FamilyRecurrence;
  active: boolean;
  targetUserId: number;
  targetName: string;
  createdByUserId: number;
  createdByName: string;
}

/**
 * A shared household countdown (mirrors TimerDto). `endsUtc` is an ISO UTC instant the client ticks down
 * to; `done` is true once it has finished (and the household has been pinged via the notification bell).
 * The starter is identified by `startedByUserId` + `startedByName` only — never an email.
 */
export interface FamilyTimer {
  id: number;
  label: string;
  endsUtc: string;
  done: boolean;
  startedByUserId: number;
  startedByName: string;
}

/**
 * "✨ Quick timer" response (POST /api/family/timers/ai/parse; mirrors TimerAiDto): a parsed `label` +
 * `durationSeconds` (already clamped to 5..86400 server-side), in the shape the frontend POSTs to /timers on
 * confirm. Creates NOTHING — the user confirms the chip, then it's started via createFamilyTimer.
 */
export interface TimerAiResult {
  label: string;
  durationSeconds: number;
}

/**
 * The "Add reminder with AI" request (POST /api/family/reminders/ai/parse; mirrors ReminderAiRequest). The
 * family member's free text ("call the dentist next Tuesday at 3, every month"); `referenceDateUtc` anchors
 * relative dates and defaults to the server's now when omitted.
 */
export interface ReminderAiRequest {
  text: string;
  referenceDateUtc?: string | null;
}

/**
 * One AI-proposed reminder to CONFIRM before it's created (mirrors ReminderProposalDto). `dueUtc` is an
 * already-clamped ISO UTC instant (rendered in the viewer's LOCAL time); `recurrence` is the supported
 * vocabulary (none/daily/weekly/weekdays). The user confirms/edits, then the frontend creates it via the
 * existing POST /family/reminders (the target stays the caller/self for now).
 */
export interface ReminderAiProposal {
  text: string;
  dueUtc: string;
  recurrence: FamilyRecurrence;
}

/**
 * The "Add reminder with AI" response (mirrors ReminderAiDto): 0+ proposed `reminders` to confirm plus an
 * optional short `notes` clarification of any assumption the model made (e.g. a guessed time, or that an
 * unsupported recurrence like "monthly" was mapped to the closest supported one). An empty `reminders` list
 * means the AI couldn't find a real thing to be reminded of in the text.
 */
export interface ReminderAiResult {
  reminders: ReminderAiProposal[];
  notes: string | null;
}

// ---- Family Hub F1 slice 2: AI assists for lists + notes ----

/**
 * "✨ Add several" request (POST /api/family/lists/ai/parse-items; mirrors ListItemsAiRequest). `text` is a
 * free-text blob ("milk, eggs, bread" or a pasted recipe); the optional `kind` ("shopping"|"todo") only
 * nudges interpretation and need not match the destination list. Nothing is created — the user reviews the
 * proposed items, then each is added via the existing addFamilyListItem.
 */
export interface ListItemsAiRequest {
  text: string;
  kind?: FamilyListKind | null;
}

/**
 * "✨ Add several" response (mirrors ListItemsAiDto): a clean, de-duped, capped list of item `items` (names
 * only) plus an optional short `notes` line (e.g. "pulled ingredients from the recipe"). An empty `items`
 * list means the AI found nothing to add — the user can still add items manually.
 */
export interface ListItemsAiResult {
  items: string[];
  notes: string | null;
}

/**
 * "✨ What am I missing?" response (POST /api/family/lists/{id}/ai/suggest; mirrors ListSuggestAiDto): 0+
 * proposed extra item names for a goal ("a kids birthday party"), de-duped server-side against the list's
 * current items. Nothing is created — the user confirms chips, then each is added via addFamilyListItem.
 */
export interface ListSuggestAiResult {
  items: string[];
}

/**
 * "✨ Draft with AI" / "✨ Rewrite" request (POST /api/family/notes/ai/draft; mirrors NoteDraftAiRequest).
 * `prompt` drives the change. When `currentBody` is present the note is REWRITTEN per the prompt; otherwise
 * a fresh note is drafted. The server saves NOTHING — the editor shows the draft with Use / Try-again.
 */
export interface NoteDraftAiRequest {
  prompt: string;
  currentTitle?: string | null;
  currentBody?: string | null;
}

/**
 * "✨ Draft with AI" / "✨ Rewrite" response (mirrors NoteDraftAiDto): a `title` + markdown `body` (to be
 * RENDERED by the safe renderer, never executed) + an optional short `note` about an assumption made.
 */
export interface NoteDraftAiResult {
  title: string;
  body: string;
  note: string | null;
}

/**
 * One action item from "✨ Summarize" (mirrors NoteActionItemDto). `text` is a concise task; `duePhrase` is
 * a natural-time phrase ("tomorrow", "by Friday") the frontend can feed into the slice-1 reminder parser
 * ("make reminders"), or null when the note implied no time.
 */
export interface NoteActionItem {
  text: string;
  duePhrase: string | null;
}

/**
 * "✨ Summarize" response (POST /api/family/notes/{id}/ai/summarize; mirrors NoteSummaryAiDto): a short
 * `summary` of the note plus 0+ `actionItems`. Read-only — nothing changes until the user picks an action
 * ("Add to a list" or "Make reminders").
 */
export interface NoteSummaryAiResult {
  summary: string;
  actionItems: NoteActionItem[];
}

// ---- Family Hub round 2: ask your notes / transform a note ----

/**
 * "✨ Ask your notes" response (POST /api/family/notes/ai/ask; mirrors AskNotesAiDto): a plain-text `answer`
 * drawn ONLY from the caller's household notes (or "I couldn't find that in your notes."), plus the
 * `usedNoteIds` of the notes the model actually drew on — the UI lets the user tap to open those notes.
 * Read-only — nothing is created or saved.
 */
export interface AskNotesAiResult {
  answer: string;
  usedNoteIds: number[];
}

/** The in-editor transform actions the note "✨ Transform" row offers (mirrors the server vocabulary). */
export type NoteTransformAction = 'continue' | 'checklist' | 'shorten' | 'translate';

/**
 * "✨ Transform" response (POST /api/family/notes/ai/transform; mirrors NoteTransformAiDto): the transformed
 * markdown `body` (to be RENDERED by the safe renderer, never executed). Saves NOTHING — the editor previews
 * it with Use / Try-again and only the user's Save persists it.
 */
export interface NoteTransformAiResult {
  body: string;
}

// ---- Family Hub F3: Today snapshot & settings ----

/**
 * Current-conditions for the Today weather card (mirrors WeatherDto). All server-resolved + clamped;
 * the whole card only renders when the server returns weather (non-null) — i.e. an OpenWeather key AND
 * a household location are configured. `icon` is the OpenWeather icon code (e.g. "04d").
 */
export interface FamilyWeather {
  location: string;
  tempF: number;
  feelsLikeF: number;
  description: string;
  icon: string;
  humidityPct: number;
}

/**
 * One of today's reminders on the Today snapshot (mirrors TodayReminderDto). `localTime` is the due time
 * pre-formatted in the household timezone (e.g. "3:30 PM"); the target person is `targetUserId` +
 * `targetName` only — never an email (email-privacy).
 */
export interface FamilyTodayReminder {
  id: number;
  text: string;
  dueUtc: string;
  localTime: string;
  recurrence: FamilyRecurrence;
  targetUserId: number;
  targetName: string;
}

/**
 * An active timer on the Today snapshot (mirrors TodayTimerDto). `endsUtc` is the instant to tick down to;
 * the starter is `startedByUserId` + `startedByName` only.
 */
export interface FamilyTodayTimer {
  id: number;
  label: string;
  endsUtc: string;
  startedByUserId: number;
  startedByName: string;
}

/**
 * A list summary on the Today snapshot (mirrors TodayListDto): the open/done counts plus the first few
 * still-open item texts for a glanceable shopping/to-do peek.
 */
export interface FamilyTodayList {
  id: number;
  name: string;
  kind: FamilyListKind;
  openCount: number;
  doneCount: number;
  firstFewOpenItems: string[];
}

/** A pinned note on the Today snapshot (mirrors TodayNoteDto) — id + title only. */
export interface FamilyTodayNote {
  id: number;
  title: string;
}

/**
 * One of today's calendar events on the Today snapshot (mirrors TodayEventDto). `localTime` is pre-formatted
 * in the household timezone (e.g. "3:30 PM" or "All day"). These come from the caller's connected Google
 * Calendar and are present only when a calendar is connected; otherwise the list is simply empty.
 */
export interface FamilyTodayEvent {
  id: string;
  title: string;
  startUtc: string | null;
  endUtc: string | null;
  allDay: boolean;
  localTime: string;
}

/**
 * The household's "Today" snapshot (GET /api/family/today; mirrors TodayDto). A warm, time-of-day
 * `greeting` addressed to the caller by first name + the household-local `dateLocal` (ISO date), then the
 * glance cards: today's `reminders` (by local time), active `timers`, list summaries, `pinnedNotes`, and an
 * optional `weather` card (null — and hidden — when unconfigured). Everyone is by userId + name, never email.
 */
export interface FamilyToday {
  greeting: string;
  dateLocal: string;
  reminders: FamilyTodayReminder[];
  timers: FamilyTodayTimer[];
  lists: FamilyTodayList[];
  pinnedNotes: FamilyTodayNote[];
  weather: FamilyWeather | null;
  /** Today's events from the caller's connected Google Calendar; empty when no calendar is connected. */
  events: FamilyTodayEvent[];
}

/**
 * The warm AI morning-briefing narrative for the top of Today (GET /api/family/today/briefing; mirrors
 * BriefingDto). `narrative` is the friendly AI line when available, else the GUARANTEED deterministic
 * briefing text with `fellBackToPlain` = true. This endpoint NEVER 503s — the plain text is the floor — so
 * the card always has something warm to show; it just renders plainly (no "AI" flourish) when it fell back.
 */
export interface FamilyBriefing {
  narrative: string;
  fellBackToPlain: boolean;
}

/**
 * Whether Google Calendar is usable for the caller (GET /api/family/calendar/status; mirrors StatusDto).
 * `configured` is false when the server has no OAuth client secret yet (nothing to connect to); `connected`
 * is true once the caller has linked their own Google Calendar via the OAuth code flow. The server never
 * returns the client secret or the user's refresh token — only these two booleans.
 */
export interface CalendarStatus {
  configured: boolean;
  connected: boolean;
  /** True when the connection actually granted the calendar.events scope. When connected but this is false,
   *  the calendar permission wasn't allowed at consent — the user should disconnect + reconnect. */
  scopeOk?: boolean;
  /** The caller's "share my calendar with the household" opt-in (mirrors StatusDto.ShareHousehold). Only
   *  meaningful when `connected`; when true, the caller's events show in their household's overlay. */
  shareHousehold?: boolean;
}

/**
 * One shared event on a household member's calendar for the family overlay (mirrors FamilyEventDto): title +
 * time ONLY. Times are ISO UTC instants (null only for malformed source events). Overlay events are
 * READ-ONLY — never an id, location, notes, or any email/other identifying detail.
 */
export interface FamilyEventItem {
  title: string;
  startUtc: string | null;
  endUtc: string | null;
  allDay: boolean;
}

/**
 * One OTHER household member's shared events for the calendar overlay (GET /api/family/calendar/family-events;
 * mirrors FamilyMemberEventsDto). Identity is `userId` + display `name` ONLY — NEVER an email. Only members
 * who BOTH opted in (shareHousehold) AND connected a calendar appear. The caller's own events are NOT here
 * (they come from GET /events). `userId` keys the stable per-member overlay color.
 */
export interface FamilyMemberEvents {
  userId: number;
  name: string;
  events: FamilyEventItem[];
}

/**
 * The recurrence vocabulary the planner offers (mirrors GoogleCalendarService.Recurrence + the API's
 * accepted strings). `none` is a single, one-off event (today's default behaviour); the rest attach a
 * bounded RRULE on the server. `weekly` repeats on the start day's weekday; `weekdays` is Mon–Fri.
 */
export type CalendarRecurrence = 'none' | 'daily' | 'weekly' | 'weekdays' | 'monthly';

/**
 * A single event on the caller's connected Google Calendar (mirrors EventDto). Times are ISO UTC instants
 * (null only for malformed source events); `allDay` events span whole days. `htmlLink`/`hangoutLink` are
 * Google-provided links for the caller's own event. `isRecurring` flags an event that's part of a repeating
 * series (drives the "repeats" badge). No other-person identity is ever carried here.
 */
export interface CalendarEvent {
  id: string;
  title: string;
  startUtc: string | null;
  endUtc: string | null;
  allDay: boolean;
  location: string | null;
  description: string | null;
  htmlLink: string | null;
  hangoutLink: string | null;
  /** True when the event is part of a recurring series (mirrors EventDto.IsRecurring). */
  isRecurring?: boolean;
}

/**
 * Create/update payload for a calendar event. `startUtc`/`endUtc` are ISO UTC instants (local→UTC on the
 * client). `recurrence` (default `none`) makes it a repeating series; the server bounds it by
 * `recurrenceCount` (number of occurrences) or applies a sane default cap so a series is always finite.
 */
export interface CalendarEventInput {
  title: string;
  startUtc: string;
  endUtc: string;
  allDay: boolean;
  location?: string | null;
  description?: string | null;
  recurrence?: CalendarRecurrence;
  /** Optional explicit occurrence count (1–730) for a recurring event; omit to let the server cap it. */
  recurrenceCount?: number | null;
}

/**
 * The "Schedule with AI" request (POST /api/family/calendar/schedule-ai; mirrors ScheduleAiRequest). The
 * family member's free text ("soccer every Tuesday at 4pm"); `referenceDateUtc` anchors relative dates and
 * defaults to the server's now when omitted.
 */
export interface ScheduleAiRequest {
  text: string;
  referenceDateUtc?: string | null;
}

/**
 * One AI-proposed event to CONFIRM before it's created (mirrors ScheduleEventDto). Times are already-clamped
 * ISO UTC instants; `recurrence` is the supported vocabulary. The user edits/confirms, then the frontend
 * creates it via POST /events (passing the recurrence).
 */
export interface ScheduleAiEvent {
  title: string;
  startUtc: string;
  endUtc: string;
  allDay: boolean;
  location: string | null;
  description: string | null;
  recurrence: CalendarRecurrence;
}

/**
 * The "Schedule with AI" response (mirrors ScheduleAiDto): 0+ proposed `events` to confirm plus an optional
 * short `notes` clarification of any assumption the model made. An empty `events` list means the AI couldn't
 * find a real event in the text.
 */
export interface ScheduleAiResult {
  events: ScheduleAiEvent[];
  notes: string | null;
}

/**
 * One attached schedule file for "Schedule from image" (mirrors ScheduleImageFile): raw base64 (NO `data:`
 * prefix) plus its mime. Allowed mimes are image/jpeg|png|webp OR application/pdf (PDF is scoped to this
 * endpoint only). The bytes are passed inline to Gemini and DISCARDED — never stored.
 */
export interface ScheduleImageFile {
  imageBase64: string;
  mime: string;
}

/**
 * The "Schedule from image" request (POST /api/family/calendar/ai/from-image; mirrors
 * ScheduleFromImageRequest). 1–5 schedule images/PDFs to EXTRACT events from (a school calendar, a shift
 * schedule, a sports roster, a flyer). `referenceDateUtc` anchors relative/implied dates in the document
 * and defaults to the server's now when omitted. Creates + stores NOTHING — the returned events are
 * confirmed by the user (same {@link ScheduleAiResult} proposal shape as Schedule-with-AI).
 */
export interface ScheduleFromImageRequest {
  files: ScheduleImageFile[];
  referenceDateUtc?: string | null;
}

/** One busy block on a member's calendar for the find-a-time helper (mirrors BusyBlockDto). */
export interface CalendarBusyBlock {
  startUtc: string;
  endUtc: string;
}

/**
 * A household member's busy blocks for the find-a-time helper (mirrors MemberBusyDto). Identity is
 * `userId` + display `name` only — NEVER an email (email-privacy). Only members who have connected a
 * calendar appear; unconnected members are omitted entirely.
 */
export interface CalendarMemberBusy {
  userId: number;
  name: string;
  busy: CalendarBusyBlock[];
}

// ---- Family Hub F6b: Find-a-time ----

/**
 * The find-a-time request (POST /api/family/calendar/find-time; mirrors FindTimeRequest). Which household
 * members to consider (by `userId` only — the server constrains them to the caller's own household), how
 * long the meeting is, the date window (ISO UTC instants), and optional workday hours (0–23, local to the
 * household timezone). Omit `memberUserIds` to consider the whole household.
 */
export interface FindTimeRequest {
  memberUserIds?: number[];
  durationMinutes: number;
  fromUtc: string;
  toUtc: string;
  dayStartHourLocal?: number | null;
  dayEndHourLocal?: number | null;
}

/** A candidate free slot the find-a-time helper found — free for every CONNECTED member (mirrors SlotDto). */
export interface FindTimeSlot {
  startUtc: string;
  endUtc: string;
}

/**
 * A member the find-a-time helper considered, and whether their Google Calendar was connected (mirrors
 * ConsideredMemberDto). Identity is `userId` + display `name` only — NEVER an email. An unconnected member
 * doesn't constrain the search; we surface a gentle note so the family knows their availability is unknown.
 */
export interface FindTimeConsideredMember {
  userId: number;
  name: string;
  connected: boolean;
}

/**
 * The find-a-time response (mirrors FindTimeDto): the candidate `slots` plus the `consideredMembers` (who
 * was looked at, and whether each was connected). When nobody is connected the slot list is empty and every
 * member reads connected:false — the UI degrades to a warm "no one's connected yet" message.
 */
export interface FindTimeResult {
  slots: FindTimeSlot[];
  consideredMembers: FindTimeConsideredMember[];
}

// ---- Family Hub F6b: Plan polls (Doodle-style) ----

/** Whether a poll's options are candidate TIME slots or free-`text` labels (mirrors the API's poll kind). */
export type FamilyPollKind = 'time' | 'text';

/**
 * Someone who voted for a poll option (mirrors VoterDto). Identity is `userId` + display `name` ONLY —
 * never an email (email-privacy). Voter avatars render from the name's initials.
 */
export interface FamilyPollVoter {
  userId: number;
  name: string;
}

/**
 * One option on a family poll (mirrors PollOptionDto). For a TIME poll `startUtc`/`endUtc` are the candidate
 * slot (ISO UTC); for a TEXT poll `label` is the choice (e.g. "Zoo"). `voteCount` + `voters` are live; the
 * winning option is highlighted on a closed poll.
 */
export interface FamilyPollOption {
  id: number;
  startUtc: string | null;
  endUtc: string | null;
  label: string | null;
  sortOrder: number;
  voteCount: number;
  voters: FamilyPollVoter[];
}

/**
 * A household plan poll (GET /api/family/polls; mirrors PollDto). `kind` is time/text; `myVotes` are the
 * caller's currently-selected option ids (voting REPLACES the prior set, so multi-select is "every option
 * that works for me"). When `closed`, `winningOptionId` is highlighted; a closed TIME poll can be booked
 * onto the caller's connected calendar. Creator identity is `createdByUserId` + `createdByName` (never email).
 */
export interface FamilyPoll {
  id: number;
  title: string;
  kind: FamilyPollKind;
  closed: boolean;
  winningOptionId: number | null;
  createdByUserId: number;
  createdByName: string;
  createdUtc: string;
  options: FamilyPollOption[];
  myVotes: number[];
}

/** One option in a create-poll request. TIME polls send `startUtc`+`endUtc`; TEXT polls send `label`. */
export interface FamilyPollOptionInput {
  startUtc?: string | null;
  endUtc?: string | null;
  label?: string | null;
}

/** Create-poll payload (POST /api/family/polls). 2–30 options; `kind` defaults to "time" server-side. */
export interface FamilyPollCreate {
  title: string;
  kind: FamilyPollKind;
  options: FamilyPollOptionInput[];
}

// ---- Family Hub F6c: Calendar + Polls AI assists (slice 5) ----

/**
 * The "✨ Best time for X" request (POST /api/family/calendar/ai/find-time; mirrors FindTimeAiRequest). The
 * family member's free text ("a 45-min slot for the dentist next week, mornings"); `referenceDateUtc` anchors
 * relative dates and defaults to the server's now when omitted. Gemini ONLY fills the find-time form — the
 * existing deterministic slot engine then runs over the household, so nothing is booked.
 */
export interface FindTimeAiRequest {
  text: string;
  referenceDateUtc?: string | null;
}

/**
 * What the AI understood from the free text (mirrors InterpretedFindTimeDto): the find-time FORM it filled,
 * all clamped — the duration, the UTC window, and the local workday hours (0–23, in the household timezone).
 * The UI shows this "here's what I understood" line so the family sees the interpretation before booking.
 */
export interface FindTimeAiInterpreted {
  durationMinutes: number;
  fromUtc: string;
  toUtc: string;
  dayStartHourLocal: number;
  dayEndHourLocal: number;
  note: string | null;
}

/**
 * The "✨ Best time for X" response (mirrors FindTimeAiDto): the EXISTING deterministic find-time output
 * (candidate `slots` + the `consideredMembers`, who was connected or not) PLUS the `interpreted` form the AI
 * filled from the free text. Picking a slot opens the event editor prefilled; nothing is booked automatically.
 */
export interface FindTimeAiResult {
  slots: FindTimeSlot[];
  consideredMembers: FindTimeConsideredMember[];
  interpreted: FindTimeAiInterpreted;
}

/**
 * The "✨ Suggest options" request (POST /api/family/polls/ai/options; mirrors PollOptionsAiRequest). A
 * free-text `prompt` ("plan a Saturday family outing" / "best dinner spot") + an optional `kind` to force the
 * option shape (omit/null lets the model choose). `referenceDateUtc` anchors relative dates for time options.
 */
export interface PollOptionsAiRequest {
  prompt: string;
  kind?: FamilyPollKind | null;
  referenceDateUtc?: string | null;
}

/**
 * One AI-proposed poll option (mirrors ProposedOptionDto), in the create-poll `FamilyPollOptionInput` shape so
 * it can fill an editable option row directly. A TIME option carries `startUtc`/`endUtc`; a TEXT option carries
 * a `label`; the unused fields are null. The user EDITS these rows before the normal Create — nothing is made.
 */
export interface PollOptionProposal {
  startUtc?: string | null;
  endUtc?: string | null;
  label?: string | null;
}

/**
 * The "✨ Suggest options" response (mirrors PollOptionsAiDto): the resolved `kind` ("time"|"text") + the
 * proposed `options` for the user to review/edit before creating. Nothing is created — the dialog fills its
 * rows from this, then the user POSTs the confirmed set through the normal create-poll flow (re-validated).
 */
export interface PollOptionsAiResult {
  kind: FamilyPollKind;
  options: PollOptionProposal[];
}

/**
 * The "✨ Summarize" poll response (GET /api/family/polls/{id}/ai/summary; mirrors PollSummaryDto): a short
 * read-only `summary` of where the poll stands, built off the AUTHORITATIVE vote tally. `fellBackToPlain` is
 * true when Gemini was unavailable and the deterministic plain summary was used instead — same handling as the
 * slice-1 morning briefing. NEVER a 503; the plain text is the guaranteed floor.
 */
export interface PollSummaryAiResult {
  summary: string;
  fellBackToPlain: boolean;
}

/**
 * The household's Family Hub settings (GET /api/family/settings; mirrors SettingsDto). Every member may
 * read; only the OWNER may edit (`canEdit`). `timeZone` is an IANA id used for all "today" math; the daily
 * `briefingEnabled` morning briefing posts at `briefingHourLocal` (0–23) in that zone. `weatherLocation`
 * is free text (e.g. "Tampa,FL,US"); the weather card only appears once an OpenWeather key is configured
 * server-side (`weatherConfigured`). F6b adds event heads-ups: when `eventHeadsUpEnabled`, the hub posts a
 * note to the family chat `eventHeadsUpLeadMinutes` (1–120) before each connected member's calendar events.
 */
export interface FamilySettings {
  timeZone: string;
  briefingEnabled: boolean;
  briefingHourLocal: number;
  weatherLocation: string | null;
  weatherConfigured: boolean;
  eventHeadsUpEnabled: boolean;
  eventHeadsUpLeadMinutes: number;
  canEdit: boolean;
}

/** Patch for PUT /api/family/settings (owner only). Every field is optional — omitted ones are unchanged. */
export interface FamilySettingsUpdate {
  timeZone?: string;
  briefingEnabled?: boolean;
  briefingHourLocal?: number;
  weatherLocation?: string | null;
  eventHeadsUpEnabled?: boolean;
  eventHeadsUpLeadMinutes?: number;
}

// ---- Family Hub F4: meal planner & chore board ----

/** Which meal of the day a planned dish sits in (mirrors the backend's lowercase slots). */
export type FamilyMealSlot = 'breakfast' | 'lunch' | 'dinner' | 'snack';

/** How a chore repeats (mirrors the backend's lowercase strings). Note: chores have no "weekdays". */
export type FamilyChoreRecurrence = 'none' | 'daily' | 'weekly';

// ---- Family Assistant: one ask-anything box over the whole household ----

/**
 * The Family Assistant request (POST /api/family/assistant; mirrors AssistantRequest). The member's free-text
 * `message` only — the household snapshot is assembled server-side, so the client never sends any household
 * data or facts on the wire.
 */
export interface FamilyAssistantRequest {
  message: string;
}

/**
 * The closed set of action TYPES the assistant may propose (mirrors the backend's AssistantActionTypes enum).
 * Each maps to an EXISTING write endpoint the frontend calls on the user's confirm — the assistant itself
 * creates nothing.
 */
export type FamilyAssistantActionType =
  | 'list_add' | 'reminder' | 'timer' | 'calendar_event' | 'chore' | 'meal';

/** `list_add` → find the list by name (create it if missing), then add each item via addFamilyListItem. */
export interface FamilyAssistantListAddParams {
  listName: string;
  items: string[];
}

/** `reminder` → createFamilyReminder. `whenLocal` is an offset-less local ISO string ("2026-06-23T15:00:00") or "" (no time implied). */
export interface FamilyAssistantReminderParams {
  text: string;
  whenLocal: string;
}

/** `timer` → createFamilyTimer. `durationSeconds` is already clamped (5..86400) server-side. */
export interface FamilyAssistantTimerParams {
  label: string;
  durationSeconds: number;
}

/** `calendar_event` → open the event editor PREFILLED (user saves) or createEvent. Times are offset-less local ISO strings ("" = unset). */
export interface FamilyAssistantCalendarEventParams {
  title: string;
  startLocal: string;
  endLocal: string;
  allDay: boolean;
  location: string;
  notes: string;
}

/** `chore` → createFamilyChore. `assigneeName` is a display name (resolved to a household member on the client, else unassigned). */
export interface FamilyAssistantChoreParams {
  title: string;
  points: number;
  recurrence: FamilyChoreRecurrence;
  assigneeName: string;
}

/** `meal` → createFamilyMeal. `mealDateLocal` is a bare local date ("2026-06-23") or "" (defaults to today; slot defaults to dinner). */
export interface FamilyAssistantMealParams {
  title: string;
  ingredients: string;
  mealDateLocal: string;
}

/**
 * One PROPOSED action the user confirms before it writes (mirrors AssistantActionDto). The discriminated
 * `type` selects the matching `params` shape above; `title` is the confirm-card label. Nothing is created
 * until the user clicks the action — and then via the EXISTING write endpoint, never the assistant.
 */
export type FamilyAssistantAction =
  | { type: 'list_add'; title: string; params: FamilyAssistantListAddParams }
  | { type: 'reminder'; title: string; params: FamilyAssistantReminderParams }
  | { type: 'timer'; title: string; params: FamilyAssistantTimerParams }
  | { type: 'calendar_event'; title: string; params: FamilyAssistantCalendarEventParams }
  | { type: 'chore'; title: string; params: FamilyAssistantChoreParams }
  | { type: 'meal'; title: string; params: FamilyAssistantMealParams };

/**
 * The Family Assistant response (mirrors AssistantDto): a warm, concise `answer` drawn only from the
 * household snapshot, plus 0..6 proposed `actions` to confirm. The endpoint always WRITES NOTHING; a 503
 * (never 500) means the assistant is unavailable and the user can act manually.
 */
export interface FamilyAssistantResult {
  answer: string;
  actions: FamilyAssistantAction[];
}

/** Where a meal's macros came from (mirrors the backend vocabulary). "none" = unset. */
export type FamilyMealMacroSource = 'none' | 'ai' | 'database' | 'manual';

/**
 * The DERIVED per-serving macros for a meal (mirrors MacroPerServingDto): the dish TOTAL over
 * max(servings, 1), calories whole + macros to 1 dp. One person's portion — what the planner rollups
 * show and what "✨ Add to my tracker" logs. Never stored; the server always recomputes it from the totals.
 */
export interface FamilyMealPerServing {
  calories: number;
  proteinG: number;
  carbG: number;
  fatG: number;
}

/**
 * One planned meal on the weekly plan (mirrors MealDto). `localDate` is an ISO date in the household
 * timezone; `slot` is the meal-of-day. `ingredients` is raw newline-separated text (one per line) that
 * feeds the grocery-list tie-in. The author is `createdByUserId` + `createdByName` only — never an email.
 *
 * Macros (Slice 2): `servings` + the four dish TOTALS (`calories`/`proteinG`/`carbG`/`fatG`) + `macroSource`
 * are the stored values; `perServing` is the server-DERIVED one-portion block (total / max(servings, 1))
 * the cards show prominently and "✨ Add to my tracker" logs. `macroSource === 'none'` means macros aren't set.
 */
export interface FamilyMeal {
  id: number;
  localDate: string;
  slot: FamilyMealSlot;
  title: string;
  ingredients: string;
  createdByUserId: number;
  createdByName: string;
  /** How many servings the dish makes (>=1); per-serving = total / max(servings, 1). */
  servings: number;
  /** Dish TOTAL calories (kcal) across all servings. */
  calories: number;
  /** Dish TOTAL protein (g) across all servings. */
  proteinG: number;
  /** Dish TOTAL carbohydrate (g) across all servings. */
  carbG: number;
  /** Dish TOTAL fat (g) across all servings. */
  fatG: number;
  /** Where the macros came from; "none" until an AI/DB/manual estimate is saved. */
  macroSource: FamilyMealMacroSource;
  /** Server-derived per-serving macros (total / max(servings, 1)). One person's portion. */
  perServing: FamilyMealPerServing;
}

/**
 * An AI/DB macro PROPOSAL for a meal (mirrors MealMacroProposalDto): the dish TOTALS + a suggested/kept
 * `servings` count + the derived `perServing` block + an optional `note`. NOTHING is saved — the editor
 * previews it, then the user confirms and the meal PATCH writes the totals + servings + source. The
 * DB-refine variant also carries `matched`/`unmatched` ingredient lines so the user sees what was looked up.
 */
export interface FamilyMealMacroProposal {
  calories: number;
  proteinG: number;
  carbG: number;
  fatG: number;
  servings: number;
  perServing: FamilyMealPerServing;
  note: string | null;
  /** Ingredient lines that matched a food-DB hit (DB-refine only; null for the AI estimate). */
  matched: string[] | null;
  /** Ingredient lines with no food-DB match (DB-refine only; null for the AI estimate). */
  unmatched: string[] | null;
}

/**
 * One day of the weekly plan (mirrors MealDayDto): its `localDate` (ISO date) + the meals planned on it,
 * already ordered by slot. The week view renders one of these per day.
 */
export interface FamilyMealDay {
  localDate: string;
  meals: FamilyMeal[];
}

/**
 * "✨ Plan our week" request (POST /api/family/meals/ai/plan-week; mirrors PlanWeekAiRequest). `weekStart`
 * is the week's Monday ("YYYY-MM-DD"; defaults to the household's current week). `constraints` is optional
 * free text (kid-friendly / budget / no nuts). `fillSlots` chooses which dinners to propose: "emptyDinners"
 * (only the week's empty dinner slots — the default) or "allDinners" (all 7). The server computes the target
 * dates + the household's recent titles (neither trusted from the client) and saves NOTHING — the frontend
 * reviews then POSTs each accepted meal to /meals.
 */
export interface PlanWeekAiRequest {
  weekStart?: string | null;
  constraints?: string | null;
  fillSlots?: 'emptyDinners' | 'allDinners' | null;
}

/**
 * One proposed dinner from "✨ Plan our week" (mirrors PlanWeekMealDto), in the same shape the frontend
 * POSTs to /meals: `localDate` ("YYYY-MM-DD"), `slot` (always "dinner" here), `title`, and newline-separated
 * `ingredients`. The user reviews/edits before any of it is created.
 */
export interface PlanWeekMeal {
  localDate: string;
  slot: FamilyMealSlot;
  title: string;
  ingredients: string;
}

/**
 * "✨ Plan our week" response (mirrors PlanWeekAiDto): 0+ proposed `meals` to review + an optional short
 * `notes`. An empty `meals` list means every targeted dinner was already planned (or the model returned
 * nothing) — the page says so.
 */
export interface PlanWeekAiResult {
  meals: PlanWeekMeal[];
  notes: string | null;
}

/**
 * "✨ From a recipe" request (POST /api/family/meals/ai/from-recipe; mirrors RecipeAiRequest). `text` is the
 * already-extracted recipe TEXT — the server NEVER fetches a URL (no SSRF), so for a recipe link the user
 * pastes the page's text. Saves nothing; the editor PREFILLS from the response for the user to confirm.
 */
export interface RecipeAiRequest {
  text: string;
}

/**
 * "✨ From a recipe" response (mirrors RecipeAiDto): a parsed `title` + newline-joined `ingredients` to
 * PREFILL the meal editor, plus an optional short `notes`. Nothing is saved until the user hits Save.
 */
export interface RecipeAiResult {
  title: string;
  ingredients: string;
  notes: string | null;
}

/**
 * One dinner idea from "✨ What can I make?" (mirrors MealIdeaDto): a `title`, the newline-joined
 * `ingredients` it uses (from the on-hand list), and the few small `missing` items still needed. Picking an
 * idea PREFILLS the meal editor (title + ingredients) — nothing is created until the user Saves.
 */
export interface MealIdea {
  title: string;
  ingredients: string;
  missing: string[];
}

/**
 * "✨ What can I make?" response (POST /api/family/meals/ai/what-can-i-make; mirrors WhatCanIMakeAiDto): 0+
 * dinner `ideas` to review. An empty list means nothing came back — the user can still add a meal manually.
 */
export interface WhatCanIMakeAiResult {
  ideas: MealIdea[];
}

/**
 * A household chore on the shared board (mirrors ChoreDto). Optionally assigned to a member
 * (`assignedToUserId` + name; null = unassigned/anyone). `done` checks it off for the current period and
 * stamps `doneByUserId`/`doneByName`/`doneUtc`. `points` are the stars earned each completion; `recurrence`
 * drives the chip and the background reset. Everyone is by userId + name only — never an email.
 */
export interface FamilyChore {
  id: number;
  title: string;
  assignedToUserId?: number | null;
  assignedToName?: string | null;
  done: boolean;
  doneByUserId?: number | null;
  doneByName?: string | null;
  doneUtc?: string | null;
  points: number;
  recurrence: FamilyChoreRecurrence;
}

/**
 * A member's all-time stars tally (mirrors TallyEntryDto) — the sum of their completion ledger. Identity
 * is `userId` + `name` only; never an email. The board's "stars" strip renders these, highest first.
 */
export interface FamilyChoreTally {
  userId: number;
  name: string;
  points: number;
}

/**
 * The chore board response (mirrors ChoresDto): the household's `chores` (open first, then done) and the
 * per-member all-time `tally` of stars earned. People throughout are by userId + name only — never email.
 */
export interface FamilyChores {
  chores: FamilyChore[];
  tally: FamilyChoreTally[];
}

// ── Family Hub F4: chore-board AI assists (suggest / balance / values / "good job" summary) ───────
// All mirror the server DTOs in FamilyMealsChoresEndpoints. Every assist APPLIES NOTHING — it returns
// proposals the page reviews then writes via the existing create/patch chore calls. suggest/balance/values
// degrade to a 503 when AI is unavailable; the summary NEVER 503s (a deterministic plain floor is returned).

/**
 * "✨ Suggest chores" request (POST /api/family/chores/ai/suggest; mirrors ChoreSuggestAiRequest). Optional
 * children's `ages` (e.g. [8, 5]) tailor difficulty. The server reads the household's existing chore titles
 * as a "don't duplicate" hint (never trusted from the client) and creates NOTHING — the page reviews then
 * POSTs each accepted chore to /chores.
 */
export interface ChoreSuggestAiRequest {
  ages?: number[] | null;
}

/**
 * One proposed chore from "✨ Suggest chores" (mirrors ChoreSuggestionDto), in the shape the frontend POSTs
 * to /chores: a `title`, a star `points` value, and a `recurrence`, plus a short `ageHint` for the review row
 * (e.g. "Great for a 5-year-old"). The user edits/removes before any of it is created.
 */
export interface ChoreSuggestion {
  title: string;
  points: number;
  recurrence: FamilyChoreRecurrence;
  ageHint?: string | null;
}

/** "✨ Suggest chores" response (mirrors ChoreSuggestAiDto): 0+ age-appropriate `suggestions` to review. */
export interface ChoreSuggestAiResult {
  suggestions: ChoreSuggestion[];
}

/**
 * One proposed assignment from "✨ Balance chores" (mirrors ChoreAssignmentDto), in the shape the frontend
 * PATCHes to /chores/{id}. Both ids are already validated server-side (the chore belongs to the household;
 * the assignee is a member), so `assignedToName` is safe to render directly.
 */
export interface ChoreAssignment {
  choreId: number;
  assignedToUserId: number;
  assignedToName: string;
}

/** "✨ Balance chores" response (mirrors ChoreBalanceAiDto): 0+ validated `assignments` to review + apply. */
export interface ChoreBalanceAiResult {
  assignments: ChoreAssignment[];
}

/**
 * One proposed point value from "✨ Suggest stars" (mirrors ChoreValueDto), in the shape the frontend PATCHes
 * to /chores/{id}. The `choreId` is already validated to belong to the household.
 */
export interface ChoreValue {
  choreId: number;
  points: number;
}

/** "✨ Suggest stars" response (mirrors ChoreValuesAiDto): 0+ validated point `values` to review + apply. */
export interface ChoreValuesAiResult {
  values: ChoreValue[];
}

/**
 * The "Good job" weekly chore summary (GET /api/family/chores/ai/summary; mirrors ChoreSummaryAiDto): a short
 * warm read-only `summary` of the week's chore wins. `fellBackToPlain` is true when Gemini was unavailable and
 * the deterministic plain summary was used instead — same handling as the slice-1 morning briefing. NEVER a
 * 503; the plain text is the guaranteed floor.
 */
export interface ChoreSummaryAiResult {
  summary: string;
  fellBackToPlain: boolean;
}

// ── Family Hub F5: FINANCE (Rocket Money CSV import) ──────────────────────────────────────────────
// Extra-sensitive: every endpoint is gated by BOTH family.use AND family.finance, household-private, and
// NOT shareable to outside contacts. People (the importer) are by userId + name only — never an email.

/** Who an account belongs to: "his" | "hers" | "joint", or "unassigned" until the family labels it. */
export type FinanceOwner = 'his' | 'hers' | 'joint' | 'unassigned';

/** Account flavor inferred from the CSV, editable by the family: "bank" | "credit" | "other". */
export type FinanceAccountKind = 'bank' | 'credit' | 'other';

/** Classified money flow. Spending math sums "expense" only; transfers never count as spending. */
export type FinanceTxnKind = 'expense' | 'income' | 'transfer';

/** A thumbnail of an account as returned on an import (mirrors AccountSummaryDto). */
export interface FinanceAccountSummary {
  id: number;
  name: string;
  institution?: string | null;
  owner: FinanceOwner;
  kind: FinanceAccountKind;
}

/**
 * The outcome of importing a Rocket Money CSV (mirrors ImportResultDto): how many rows the file held,
 * how many new transactions were inserted vs skipped (dupes + unparseable), and the accounts it touched.
 */
export interface FinanceImportResult {
  importId: number;
  rowCount: number;
  imported: number;
  skipped: number;
  accounts: FinanceAccountSummary[];
}

/**
 * A finance account (mirrors AccountDto) with its rollups: how many transactions hang on it and its total
 * EXPENSE magnitude (spending). The family sets `owner`/`kind`/`name` to tag the two SoFi accounts apart.
 */
export interface FinanceAccount {
  id: number;
  name: string;
  institution?: string | null;
  owner: FinanceOwner;
  kind: FinanceAccountKind;
  txnCount: number;
  totalSpentMagnitude: number;
}

/** A relabel of an account (mirrors AccountPatchRequest); send only the fields you're changing. */
export interface FinanceAccountPatch {
  owner?: FinanceOwner;
  kind?: FinanceAccountKind;
  name?: string;
}

/**
 * One transaction row (mirrors TransactionDto). `magnitude` is the non-negative size of the movement and
 * `rawAmount` is the signed CSV value (negative = money out). `kind` styles expense vs income vs transfer.
 * `owner` is the account's owner (denormalized for the table's his/hers styling). Date is an ISO `yyyy-MM-dd`.
 */
export interface FinanceTransaction {
  id: number;
  date: string;
  merchant: string;
  category?: string | null;
  magnitude: number;
  rawAmount: number;
  kind: FinanceTxnKind;
  accountId: number;
  accountName: string;
  owner: FinanceOwner;
}

/** A page of transactions (mirrors TransactionsPageDto) for the filterable, paged table. */
export interface FinanceTransactionsPage {
  page: number;
  pageSize: number;
  total: number;
  items: FinanceTransaction[];
}

/** A spending slice by category (mirrors CategoryAmountDto); `pct` is the share of the month's spend. */
export interface FinanceCategoryAmount {
  category: string;
  amount: number;
  pct: number;
}

/** A spending slice by account (mirrors AccountAmountDto), carrying the account's owner for grouping. */
export interface FinanceAccountAmount {
  accountId: number;
  name: string;
  owner: FinanceOwner;
  amount: number;
}

/** A spending slice by owner (mirrors OwnerAmountDto) — the his/hers/joint split. */
export interface FinanceOwnerAmount {
  owner: FinanceOwner;
  amount: number;
}

/** One month on the rolling trend (mirrors TrendPointDto): spent + income for that `yyyy-MM`. */
export interface FinanceTrendPoint {
  month: string;
  spent: number;
  income: number;
}

/**
 * The dashboard summary for a month (mirrors SummaryDto): headline totals plus the by-category, by-account,
 * and by-owner breakdowns and a rolling 12-month trend. `month` is the resolved `yyyy-MM` (the server falls
 * back to the most recent month with data when none is requested). Spending is expense-only.
 */
export interface FinanceSummary {
  month: string;
  totalSpent: number;
  totalIncome: number;
  byCategory: FinanceCategoryAmount[];
  byAccount: FinanceAccountAmount[];
  byOwner: FinanceOwnerAmount[];
  monthlyTrend: FinanceTrendPoint[];
}

/**
 * One import batch in the history strip (mirrors ImportBatchDto): the file, its counts, and WHO ran it —
 * by userId + display name only, never an email — and when (UTC ISO).
 */
export interface FinanceImportBatch {
  id: number;
  fileName: string;
  rowCount: number;
  importedCount: number;
  skippedCount: number;
  importedByUserId: number;
  importedByName: string;
  createdUtc: string;
}

/**
 * The "✨ Explain this month" finance summary (GET /api/family/finance/ai/summary?month=; mirrors
 * FinanceAiSummaryDto): a warm, calm read-only `narrative` of where the money went plus up to 5 short
 * `insights` bullets, both NARRATED from the same authoritative server-computed numbers GET /summary
 * returns (the model invents nothing). `fellBackToPlain` is true when Gemini was unavailable/unconfigured
 * (or the month is empty) and the GUARANTEED deterministic plain floor was returned instead — same handling
 * as the slice-1 morning briefing (we drop the AI flourish). NEVER a 503; the plain text is the floor. It is
 * purely read-only — nothing is mutated.
 */
export interface FinanceSummaryAiResult {
  narrative: string;
  insights: string[];
  fellBackToPlain: boolean;
}

/**
 * One detected recurring charge in the "✨ Money coach" (mirrors RecurringChargeDto): a subscription/bill
 * that recurs monthly — its display `merchant`, the `typicalAmount` (the median of its occurrences), the
 * `cadence` ("monthly"), the count of distinct `monthsSeen`, and the ISO `lastDate` it was last seen. These
 * are computed DETERMINISTICALLY server-side from the household's recent expenses — they (and the monthly
 * total) are the AUTHORITATIVE floor and always render, even when Gemini is off (fellBackToPlain).
 */
export interface FinanceRecurringCharge {
  merchant: string;
  typicalAmount: number;
  cadence: string;
  monthsSeen: number;
  lastDate: string;
}

/**
 * The "✨ Money coach" result (GET /api/family/finance/ai/money-coach; mirrors MoneyCoachDto). The
 * `recurring` list + `monthlyRecurringTotal` are the DETERMINISTIC, authoritative FLOOR — present whether
 * Gemini is on or off, so they ALWAYS render prominently. When Gemini is configured it ALSO narrates those
 * facts into a calm, reassuring `narrative` + up to 5 actionable `tips`; otherwise `narrative` is null,
 * `tips` is empty, and `fellBackToPlain` is true (we drop the AI flourish, same as the briefing). The coach
 * NEVER cancels or edits anything — advice only. NEVER a 503; the recurring list is the floor. Read-only.
 */
export interface FinanceMoneyCoachResult {
  recurring: FinanceRecurringCharge[];
  monthlyRecurringTotal: number;
  narrative: string | null;
  tips: string[];
  fellBackToPlain: boolean;
}

/**
 * The tracker "✨ This week" recap (GET /api/ai/tracker-recap; mirrors TrackerRecapDto): a warm, encouraging
 * read-only `narrative` of the caller's OWN last 7 local days plus 0–4 gentle coaching `insights` bullets,
 * both NARRATED from the same server-side tracker queries (food/exercise/activity/hydration/weight) the recap
 * aggregates — the model invents nothing. `fellBackToPlain` is true when Gemini was unavailable/unconfigured
 * and the GUARANTEED deterministic plain floor was returned instead (we drop the AI flourish, same handling
 * as the morning briefing / finance "explain this month"). NEVER a 503; the plain text is the floor. Gated by
 * tracker.self alone (the floor needs no AI). Purely read-only — nothing is mutated.
 */
export interface TrackerRecapResult {
  narrative: string;
  insights: string[];
  fellBackToPlain: boolean;
}

// ──────────────────────────────────────────────────────────────────────────────────────────────
// Cycle calendar (Family Hub) — PRIVACY-FIRST + NON-MEDICAL. The LOG is private to its owner; the
// family overlay only ever exposes PREDICTED day-spans for members who opted in. Mirrors the
// /api/family/cycle (CycleEndpoints) + /api/family/cycle/overlay (CycleOverlayEndpoints) contracts.
// ──────────────────────────────────────────────────────────────────────────────────────────────

/** One logged period (the owner's OWN entry; mirrors PeriodDto). `startDate`/`endDate` are plain
 *  ISO dates ("YYYY-MM-DD"); `endDate` is null while ongoing / not yet recorded. */
export interface CyclePeriod {
  id: number;
  startDate: string;
  endDate: string | null;
  loggedUtc: string;
}

/** A predicted fertile window as a day-span (mirrors FertileWindowDto); ISO dates ("YYYY-MM-DD"). */
export interface CycleFertileWindow {
  start: string;
  end: string;
}

/**
 * The DETERMINISTIC prediction block (no AI; mirrors PredictionDto). `nextPredictedStart` +
 * `fertileWindow` are null until there's at least one logged period to anchor from. `currentPhase`
 * is a gentle informational phase label. Informational, NOT medical advice.
 */
export interface CyclePrediction {
  avgCycleLengthDays: number;
  nextPredictedStart: string | null;
  fertileWindow: CycleFertileWindow | null;
  currentPhase: string;
}

/** The owner's cycle settings (mirrors SettingsDto): the two averages + the family-overlay opt-in. */
export interface CycleSettings {
  avgCycleLengthDays: number;
  avgPeriodLengthDays: number;
  overlayToFamily: boolean;
}

/** The main GET /api/family/cycle payload (mirrors CycleDto): recent periods + predictions + settings. */
export interface CycleData {
  periods: CyclePeriod[];
  prediction: CyclePrediction;
  settings: CycleSettings;
}

/**
 * The gentle, NON-MEDICAL one-liner (GET /api/family/cycle/note; mirrors NoteDto). `note` narrates only
 * the deterministic aggregate facts (never raw entries); `fellBackToPlain` is true when family.ai is
 * absent or Gemini is off and the deterministic plain floor was returned. ALWAYS 200. Never diagnostic.
 */
export interface CycleNote {
  note: string;
  fellBackToPlain: boolean;
}

/** A PATCH /api/family/cycle/settings body (all optional; clamped server-side). */
export interface CycleSettingsPatch {
  avgCycleLengthDays?: number;
  avgPeriodLengthDays?: number;
  overlayToFamily?: boolean;
}

/**
 * One PREDICTED phase span for the family-calendar overlay (mirrors PhaseSpanDto). `kind` is "period"
 * or "fertile"; `predicted` is always true (these are NEVER raw logged entries) — it exists so the UI
 * labels the span "Period (predicted)" / "Fertile window (predicted)". ISO dates ("YYYY-MM-DD").
 */
export interface CycleOverlaySpan {
  kind: string;
  start: string;
  end: string;
  predicted: boolean;
}

/**
 * One household member's predicted spans for the family-calendar overlay (mirrors MemberOverlayDto).
 * Identity is userId + display NAME only — NEVER an email. Only opted-in members ever appear, and only
 * their soft PREDICTED phase layer (no raw logged entries).
 */
export interface CycleOverlayMember {
  userId: number;
  name: string;
  phases: CycleOverlaySpan[];
}

// ──────────────────────────────────────────────────────────────────────────────────────────────
// 75 Hard challenge (the Relaxed ruleset) — a six-task daily challenge layered on the food/fitness
// tracker. Gated by the SAME tracker permissions (tracker.self own use; tracker.viewall coach read).
// Mirrors the /api/challenge (HardChallengeEndpoints) contract. AUTO scoring (diet/water/workouts)
// is recomputed LIVE from the tracker server-side; only the MANUAL portion is persisted. There is
// NEVER an image — the progress photo is a boolean attestation only.
// ──────────────────────────────────────────────────────────────────────────────────────────────

/** Lifecycle of a challenge (mirrors HardChallengeStatus, by name). */
export type HardChallengeStatus = 'Active' | 'Completed' | 'Abandoned';

/** The rule set a run follows (mirrors HardRuleset, by name). Only "Relaxed" exists today. */
export type HardRuleset = 'Relaxed';

/**
 * One day in the 75-Hard grid (mirrors DayDto). The five AUTO task results (diet/water/workout1/
 * workout2) are recomputed LIVE from the tracker; the manual flags (read, photo-boolean, no-alcohol)
 * + the diet override + the workout-2 outdoor attestation are persisted. `dayNumber` is 1..75 within
 * the window, else null. `confession` is NULLED for a viewer (never the owner's private narration).
 */
export interface HardDayDto {
  /** The day, plain ISO ("YYYY-MM-DD"). */
  date: string;
  /** 1..75 within the challenge window, else null (a date outside the window). */
  dayNumber: number | null;
  /** AUTO: calories-in within the daily calorie goal AND within every SET macro goal (override wins). */
  dietOk: boolean;
  /** Manual override of the diet result: true/false WINS over the auto computation; null = use auto. */
  dietOverride: boolean | null;
  /** AUTO: the day's hydration sum is at least one US gallon (3785 ml). */
  waterGallonOk: boolean;
  /** AUTO: at least one logged exercise of >= 45 minutes that day. */
  workout1Ok: boolean;
  /** AUTO: at least two logged exercises of >= 45 minutes that day. */
  workout2Ok: boolean;
  /** User attestation that the second workout was outdoors. */
  workout2Outdoor: boolean;
  /** Manual: the day's reading (10 pages) was done. */
  readOk: boolean;
  /** Manual BOOLEAN attestation that a progress photo was taken (NO image is ever stored). */
  photoTaken: boolean;
  /** Whether the no-alcohol rule held that day (defaults true). */
  noAlcohol: boolean;
  /** Whether this day was pre-declared a cheat day (keeps the run counted without completing). */
  isCheatDay: boolean;
  /** True when all six tasks pass AND no-alcohol holds. */
  complete: boolean;
  /** Optional Relaxed-ruleset confession (<= 280 chars); NULL for a viewer. */
  confession: string | null;
}

/**
 * The active challenge with its derived current day, streaks, and the full day grid (mirrors
 * ChallengeDto). GET /api/challenge returns this or `null` when there's no active challenge.
 * `readOnly` is true when viewing someone else's (a coach/contact read); identity is userId + display
 * NAME only — NEVER an email (email-privacy).
 */
export interface HardChallengeDto {
  id: number;
  /** The owner's AppUser id (the client opens their challenge via GET /challenge?user={userId}). */
  userId: number;
  /** The owner's display name (never an email). */
  userName: string;
  /** True when viewing someone else's challenge (no edit controls; confessions nulled). */
  readOnly: boolean;
  /** Day 1 = this date, plain ISO ("YYYY-MM-DD"). */
  startDate: string;
  ruleset: HardRuleset;
  status: HardChallengeStatus;
  /** Derived current day, clamped 1..75. */
  currentDay: number;
  /** Always 75. */
  totalDays: number;
  /** Count of days that fully passed all six tasks. */
  completedDays: number;
  /** Current Relaxed-streak length. */
  currentStreak: number;
  /** Longest contiguous kept-run length. */
  longestStreak: number;
  /** How many confessions (the Relaxed "keep the run going" lever) have been used. */
  confessionsUsed: number;
  /** The full 75-day grid (oldest-first), each day's six task results recomputed live. */
  days: HardDayDto[];
}

/** A person whose 75 Hard the caller may view (mirrors SharedPersonDto) — userId + name only, NEVER email. */
export interface HardSharedPersonDto {
  userId: number;
  name: string;
  picture?: string;
}

/** Start-a-challenge payload (POST /api/challenge). `startDate` defaults to local today when omitted. */
export interface StartChallengeRequest {
  startDate?: string | null;
}

/**
 * Upsert the MANUAL portion of a day (PUT /api/challenge/day). Every field is optional; a null/omitted
 * field means "leave as-is" (the auto bits are recomputed live, never written from input). There is NO
 * image field, EVER — `photoTaken` is a boolean attestation only.
 */
export interface UpsertHardDayRequest {
  date: string;
  readOk?: boolean | null;
  photoTaken?: boolean | null;
  noAlcohol?: boolean | null;
  confession?: string | null;
  workout2Outdoor?: boolean | null;
  dietOverride?: boolean | null;
}

/** Pre-declare / clear FUTURE-only cheat dates within the window (POST /api/challenge/cheat-days). */
export interface CheatDaysRequest {
  /** ISO dates ("YYYY-MM-DD") to mark as cheat days (future-only, within the window, <= 10 total). */
  add?: string[];
  /** ISO dates ("YYYY-MM-DD") to clear the cheat flag from. */
  remove?: string[];
}

/** Canonical permission keys (mirror of the backend catalog). */
export const PERM = {
  dashboardView: 'dashboard.view',
  dashboardExport: 'dashboard.export',
  syncRun: 'sync.run',
  calendarView: 'calendar.view',
  pricingView: 'pricing.view',
  pricingManage: 'pricing.manage',
  settingsView: 'settings.view',
  settingsManage: 'settings.manage',
  sourcesManage: 'sources.manage',
  reporterView: 'reporter.view',
  reporterManage: 'reporter.manage',
  reporterSelf: 'reporter.self',
  fleetView: 'fleet.view',
  notificationsView: 'notifications.view',
  notificationsManage: 'notifications.manage',
  sharesView: 'shares.view',
  sharesManage: 'shares.manage',
  usersView: 'users.view',
  usersManage: 'users.manage',
  activityView: 'activity.view',
  aiUsageView: 'ai.usage.view',
  chatRead: 'chat.read',
  chatSend: 'chat.send',
  chatModerate: 'chat.moderate',
  chatContactsManage: 'chat.contacts.manage',
  trackerSelf: 'tracker.self',
  trackerViewAll: 'tracker.viewall',
  familyUse: 'family.use',
  familyFinance: 'family.finance',
  cycleTrack: 'cycle.track',
  // ---- Location (GPS feature; group "Location"; never default) ----
  locationSelf: 'location.self',
  locationShare: 'location.share',
  locationViewAll: 'location.view-all',
  // ---- AI (group "AI"; token-spending; never default) ----
  trackerAi: 'tracker.ai',
  familyAi: 'family.ai',
  familyAiAssistant: 'family.ai.assistant',
  financeAi: 'finance.ai',
  chatAi: 'chat.ai',
  aiVision: 'ai.vision',
} as const;

/**
 * UI groupings for the permission catalog, in display order — mirrors the backend catalog's Group field.
 * The Users page groups its grant matrix by these; "AI" is rendered as its own visually distinct section.
 * The backend catalog is the source of truth (the page reads each item's own `group`); this order is the
 * fallback/ordering hint. Any catalog group not listed here is appended after, so nothing is ever dropped.
 */
export const PERM_GROUP_ORDER: readonly string[] = [
  'Usage', 'Fitness', 'Family', 'Chat', 'Location', 'Admin', 'AI',
];

/** Maps each permission key to its UI group (mirror of the backend catalog grouping). */
export const PERM_GROUP_OF: Readonly<Record<string, string>> = {
  // ---- Usage ----
  [PERM.dashboardView]: 'Usage',
  [PERM.dashboardExport]: 'Usage',
  [PERM.syncRun]: 'Usage',
  [PERM.calendarView]: 'Usage',
  [PERM.pricingView]: 'Usage',
  [PERM.pricingManage]: 'Usage',
  [PERM.reporterView]: 'Usage',
  [PERM.reporterManage]: 'Usage',
  [PERM.reporterSelf]: 'Usage',
  [PERM.fleetView]: 'Usage',
  [PERM.sharesView]: 'Usage',
  [PERM.sharesManage]: 'Usage',
  [PERM.notificationsView]: 'Usage',
  [PERM.notificationsManage]: 'Usage',
  // ---- Fitness ----
  [PERM.trackerSelf]: 'Fitness',
  [PERM.trackerViewAll]: 'Fitness',
  // ---- Family ----
  [PERM.familyUse]: 'Family',
  [PERM.familyFinance]: 'Family',
  [PERM.cycleTrack]: 'Family',
  // ---- Chat ----
  [PERM.chatRead]: 'Chat',
  [PERM.chatSend]: 'Chat',
  [PERM.chatModerate]: 'Chat',
  [PERM.chatContactsManage]: 'Chat',
  // ---- Location ----
  [PERM.locationSelf]: 'Location',
  [PERM.locationShare]: 'Location',
  [PERM.locationViewAll]: 'Location',
  // ---- Admin ----
  [PERM.usersView]: 'Admin',
  [PERM.usersManage]: 'Admin',
  [PERM.activityView]: 'Admin',
  [PERM.aiUsageView]: 'Admin',
  [PERM.settingsView]: 'Admin',
  [PERM.settingsManage]: 'Admin',
  [PERM.sourcesManage]: 'Admin',
  // ---- AI ----
  [PERM.trackerAi]: 'AI',
  [PERM.familyAi]: 'AI',
  [PERM.familyAiAssistant]: 'AI',
  [PERM.financeAi]: 'AI',
  [PERM.chatAi]: 'AI',
  [PERM.aiVision]: 'AI',
};

/** Access policy for open sign-up + default permissions (GET/PUT /api/access-policy). */
export interface AccessPolicy {
  openSignupEnabled: boolean;
  defaultPermissions: string[];
}

export interface SyncStatus {
  lastSyncUtc: string | null;
  lastNewRecords: number;
  lastDurationMs: number;
  lastFilesParsed: number;
  lastFilesScanned: number;
  lastError: string | null;
  isRunning: boolean;
  autoSyncEnabled: boolean;
  intervalSeconds: number;
}

/** Client-side filter state shared by the dashboard. */
export interface UsageFilter {
  from: string | null;
  to: string | null;
  projectIds: number[];
  models: string[];
  sources: string[];
  /** Raw machine names ("" selects the local file-sync bucket). */
  machine: string[];
  includeSidechain: boolean;
}

export type GroupBy = 'day' | 'month' | 'project' | 'model' | 'session' | 'source';
