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
  createdByEmail: string;
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
  createdByEmail: string;
  /** Email of the owning user; null for orphaned legacy keys (no linked user). */
  ownerEmail: string | null;
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
}

export interface ManagedUser {
  id: number;
  /** Null when masked: the email-reveal key was absent/incorrect and this is not the caller's own row. */
  email: string | null;
  name: string;
  picture: string | null;
  isEnabled: boolean;
  permissions: string[];
  createdUtc: string;
  lastLoginUtc: string | null;
}

export interface PermissionItem {
  key: string;
  label: string;
  description: string;
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
  userEmail: string | null;
  clientIp: string | null;
  requestBytes: number | null;
  responseBytes: number | null;
  requestBody: string | null;
  responseBody: string | null;
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
 * A full tracker day (GET /api/tracker/day). `readOnly` is true when viewing someone else's tracker —
 * the UI then hides all add/delete controls. Totals are server-computed. Mirrors TrackerDayDto.
 */
export interface TrackerDayDto {
  date: string;
  userEmail: string;
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
  /** The day's manually-recorded smartwatch stats + calorie mode, or null when no watch row exists. */
  activity?: WatchActivityDto | null;
  /** Resolved daily step goal (the profile's goal), or null when unset. */
  stepGoal?: number;
  /** Raw logged-exercise calorie sum for the day, BEFORE the watch add/override is applied. */
  exerciseCalories: number;
}

/** Someone whose tracker the caller may view read-only (GET /api/tracker/shared). Mirrors SharedUserDto. */
export interface SharedUserDto {
  email: string;
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

/** Canonical permission keys (mirror of the backend catalog — all 22 keys). */
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
  chatRead: 'chat.read',
  chatSend: 'chat.send',
  chatModerate: 'chat.moderate',
  chatContactsManage: 'chat.contacts.manage',
  trackerSelf: 'tracker.self',
  trackerViewAll: 'tracker.viewall',
  trackerAi: 'tracker.ai',
} as const;

/**
 * UI groupings for the permission catalog, in display order. The Users page matrix groups its
 * permission columns by these. The backend catalog is the source of truth for the keys themselves;
 * any catalog key whose group isn't listed here falls back to an "Other" bucket so nothing is lost.
 */
export const PERM_GROUP_ORDER: readonly string[] = [
  'Dashboard', 'Calendar', 'Pricing', 'Settings', 'Reporter',
  'Notifications', 'Chat', 'Tracker', 'Shares', 'Administration',
];

/** Maps each permission key to its UI group (mirror of the backend catalog grouping). */
export const PERM_GROUP_OF: Readonly<Record<string, string>> = {
  [PERM.dashboardView]: 'Dashboard',
  [PERM.dashboardExport]: 'Dashboard',
  [PERM.syncRun]: 'Dashboard',
  [PERM.calendarView]: 'Calendar',
  [PERM.pricingView]: 'Pricing',
  [PERM.pricingManage]: 'Pricing',
  [PERM.settingsView]: 'Settings',
  [PERM.settingsManage]: 'Settings',
  [PERM.sourcesManage]: 'Settings',
  [PERM.reporterView]: 'Reporter',
  [PERM.reporterManage]: 'Reporter',
  [PERM.reporterSelf]: 'Reporter',
  [PERM.fleetView]: 'Reporter',
  [PERM.notificationsView]: 'Notifications',
  [PERM.notificationsManage]: 'Notifications',
  [PERM.chatRead]: 'Chat',
  [PERM.chatSend]: 'Chat',
  [PERM.chatModerate]: 'Chat',
  [PERM.chatContactsManage]: 'Chat',
  [PERM.trackerSelf]: 'Tracker',
  [PERM.trackerViewAll]: 'Tracker',
  [PERM.trackerAi]: 'Tracker',
  [PERM.sharesView]: 'Shares',
  [PERM.sharesManage]: 'Shares',
  [PERM.usersView]: 'Administration',
  [PERM.usersManage]: 'Administration',
  [PERM.activityView]: 'Administration',
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
