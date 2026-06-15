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

export interface AuthSession {
  token: string;
  email: string;
  name: string;
  picture: string | null;
  expiresAtUtc: string;
  permissions: string[];
}

export interface ManagedUser {
  id: number;
  email: string;
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
  actorEmail: string;
  action: string;
  targetEmail: string | null;
  detail: string | null;
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

/** Canonical permission keys (mirror of the backend catalog). */
export const PERM = {
  dashboardView: 'dashboard.view',
  syncRun: 'sync.run',
  pricingManage: 'pricing.manage',
  settingsManage: 'settings.manage',
  usersManage: 'users.manage',
} as const;

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
  includeSidechain: boolean;
}

export type GroupBy = 'day' | 'month' | 'project' | 'model' | 'session' | 'source';
