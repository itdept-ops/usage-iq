import { HttpClient, HttpHeaders, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, from, throwError } from 'rxjs';
import { concatMap, last } from 'rxjs/operators';
import {
  AccessPolicy, AddCoffeeRequest, AddExerciseRequest, AddFoodRequest, UpdateFoodRequest, AddHydrationRequest, AuditEntry, BuildDayRequest, BuildDayResponse, CacheEfficiency, CalendarDay, CalendarEvent, CalendarEventInput, CalendarMemberBusy, CalendarStatus, ChatChannelDto, ChatCatchUpResult, ChatComposeAction, ChatComposeResult, ChatContactDto, ChatLocationShareDto, ChatMessageDto, ChatRepliesResult, StartLocationShareRequest, UpdateLocationShareRequest, ExtendLocationShareRequest, CommitDayRequest, CommitDayResponse, CreateChannelRequest, DaySummaryRequest, DaySummaryResponse,
  CreateShareRequest, CustomExerciseDto, CustomFoodDto, DailyCoachResponse, EstimateExerciseRequest, EstimateExerciseResponse, EstimateMacrosRequest, EstimateMacrosResponse, ExerciseEntryDto, ExerciseLibraryDto, Fleet, FleetDeleteRequest,
  FamilyAssistantResult, FamilyBriefing, FamilyChore, FamilyChoreRecurrence, FamilyChoreSource, FamilyChores, FamilyMemberEvents, ChoreSuggestAiRequest, ChoreSuggestAiResult, ChoreBalanceAiResult, ChoreValuesAiResult, ChoreSummaryAiResult, Allowance, AllowanceMe, AllowanceMoveRequest, FamilyList, FamilyListKind, FamilyMeal, FamilyMealDay, FamilyMealMacroProposal, FamilyMealMacroSource, FamilyMealSlot, FamilyNote, FamilyPoll, FamilyPollCreate, FamilyRecurrence, FamilyReminder, FamilySettings, FamilySettingsUpdate, FamilyTimer, FamilyPollKind, FamilyToday, FindTimeRequest, FindTimeAiResult, PollOptionsAiResult, PollSummaryAiResult, ReminderAiResult, ListItemsAiResult, ListSuggestAiResult, NoteDraftAiResult, NoteSummaryAiResult, AskNotesAiResult, NoteTransformAction, NoteTransformAiResult, PlanWeekAiRequest, PlanWeekAiResult, RecipeAiResult, RecipeBreakdownResult, Recipe, RecipeUpsertRequest, RecipeFromBreakdownRequest, WhatCanIMakeAiResult, TimerAiResult, FindTimeResult, QuickAddKind, QuickAddRequest, QuickAddResult, FinanceAccount, FinanceAccountPatch, FinanceAccountSummary, FinanceImportBatch, FinanceImportResult, FinanceMoneyCoachResult, FinanceSummary, FinanceSummaryAiResult, FinanceTransactionsPage, FinanceTxnKind, FinanceOwner, FinanceParseRequest, FinanceStagedImport, FinanceStagedPage, FinanceStagedRow, FinanceStagedRowPatch, FinanceCategorizeAiResult, FinanceCommitRequest,
  FinanceBudgetsResponse, FinanceBudgetDto, FinanceBudgetUpsertRequest, FinanceNetWorthDto,
  FinanceBalanceEntryRequest, FinanceSavingsResponse, FinanceSavingsGoalDto, FinanceSavingsUpsertRequest,
  FinanceContributeRequest, FinanceBudgetCheckDto, FleetDeleteResult, FleetReassignRequest, FleetReassignResult, FleetRevokeKeysRequest, FleetRevokeKeysResult, FoodEntryDto, FoodSearchItemDto, GroupBy, Household, HouseholdCandidate, FamilyMemberLocation,
  AddSupplementRequest, SupplementEntryDto, SupplementMacrosRequest, SupplementMacrosResponse,
  AddSleepRequest, SleepEntryDto, SleepInsightResponse, ClientInfoRequest,
  CoffeeEntryDto, GoalPlanDto, HeatmapCell, HydrationEntryDto, HydrationSuggestResponse, ImageRequest, IngestionSource, IngestKey, IngestKeyCreated, LocationFix, LocationSettings, LocationSettingsUpdate, AdminUserLocation, RecordLocationRequest, LogWeightRequest, LoginEvent, MachineStat, ManagedUser, MealFeedbackRequest, MealFeedbackResponse, ModelStat, MoveDayRequest, MoveDayResult, NaturalGoalRequest, NaturalGoalResponse, NotificationDto, NotificationPreferenceDto, NotificationSettings,
  AiUsageFilter, AiUsageResponse,
  NotificationUpdate, DiscordRoute, DiscordRouteUpdate, MyDiscord, MyDiscordUpdate, RecapPreview, PagedResult, ParseExerciseRequest, ParseExerciseResponse, ParseHydrationRequest, ParseHydrationResponse, ParseMealRequest, ParseMealResponse, ParseMealResultDto, PermissionItem, PermissionPreset, Presence, PersonDto, NudgeKind, Pricing, ProjectDto, PublicShare, ReactionGroupDto, ReadLabelResponse, ScanPantryResponse, ClassifyPhotoResponse, PhotoToNoteResponse, RecipeMacrosRequest, RecipeMacrosResponse, RequestLogEntry, SavedView, ScheduleAiResult, ScheduleFromImageRequest, ScheduleImageFile,
  SavedViewUpsertRequest, SessionDetail, Settings, ShareAccessItem, ShareCreated, ShareListItem, SharedUserDto, SuggestGoalResponse, SuggestWorkoutRequest, SuggestWorkoutResponse, SummaryResponse,
  SyncResult, SyncStatus, TrackerDayDto, TrackerProfileDto, TrackerRecapResult, UpsertActivityRequest, UsageFilter, UsageRecord, UsageStats,
  WatchActivityDto, WeeklyReviewResponse, WeightInsightResponse, WeightPointDto, WeightStatsDto, WhatToEatRequest, WhatToEatResult, WorkoutXSearchResultDto,
  PlanMealsRequest, PlanMealsResult, PlanMealToWrite, PlanMealsToPlanResult,
  RefineMealRequest, RefineMealResponse,
  AskRequest, AskResponse,
  ActAskRequest, ActAskResponse, AskActAction, AskActTrackerKind,
  VoiceParseRequest, VoiceParseResponse,
  CycleData, CyclePeriod, CycleNote, CycleSettings, CycleSettingsPatch, CycleOverlayMember,
  CycleDayLog, CycleDayLogPatch,
  IdentityMapData, IdentityRole, IdentityRoleInput, IdentityRolePatch, IdentityTimeEntry, IdentityTimeInput,
  IdentityRule, IdentityRuleInput, IdentityCalendarStatus, IdentityImportPreview, IdentityImportCommit,
  IdentityImportResult, IdentityAutoSuggest, IdentityAutoApply,
  HardChallengeDto, HardSharedPersonDto, StartChallengeRequest, UpsertHardDayRequest, HardDayDto, CheatDaysRequest,
  HardTaskDto, CreateHardTaskRequest, UpdateHardTaskRequest, HardLeaderboardRowDto, HardCoachDto,
  TrophiesResponse,
  WrappedPeriod,
  WrappedResponse,
  WrappedNarrative, CreateWrappedShareRequest, WrappedShareCreated, WrappedShareItem, PublicWrapped,
  BillDto, BillItemRequest, BillShareToggleResult, CreateBillRequest, PaymentHandlesDto,
  PublicBillDto, ReceiptBreakdownDto, UpdateBillRequest,
  ProfilePrefs,
  FeedPage, ReactResult,
  CommentDto, PactDto, PactProgressRowDto, CreatePactRequest, UpdatePactRequest,
  LeaderboardRowDto, LeaderboardMetric, PublicBuiltWithDto,
  AutomationRule, AutomationRuleInput,
  ScheduledAgentDto, ScheduledAgentInput, AgentPreviewResult, AgentTestResult,
  VapidPublicKey, PushSubscribeRequest,
  ResumeState, ResumeDto, ResumeApplicationDto, ResumeData, ResumeSaveRequest, ParseResumeRequest,
  HeadshotRequest, NewApplicationRequest, ApplicationSaveRequest, TailorRequest, CoverLetterRequest,
  RefineRequest, ResumeChatRequest,
  SearchResponse,
  HealthStatus, HealthSettingsPatch, HealthSyncNowResult,
} from './models';

@Injectable({ providedIn: 'root' })
export class Api {
  private http = inject(HttpClient);
  private readonly base = '/api';

  private filterParams(f: UsageFilter): HttpParams {
    let p = new HttpParams();
    if (f.from) p = p.set('from', f.from);
    if (f.to) p = p.set('to', f.to);
    for (const id of f.projectIds) p = p.append('projectId', id);
    for (const m of f.models) p = p.append('model', m);
    for (const s of f.sources) p = p.append('source', s);
    for (const mc of f.machine) p = p.append('machine', mc);
    p = p.set('includeSidechain', f.includeSidechain);
    return p;
  }

  summary(f: UsageFilter, groupBy: GroupBy): Observable<SummaryResponse> {
    return this.http.get<SummaryResponse>(`${this.base}/usage/summary`, {
      params: this.filterParams(f).set('groupBy', groupBy),
    });
  }

  records(f: UsageFilter, page: number, pageSize: number, sort: string, desc: boolean): Observable<PagedResult<UsageRecord>> {
    const params = this.filterParams(f)
      .set('page', page).set('pageSize', pageSize).set('sort', sort).set('desc', desc);
    return this.http.get<PagedResult<UsageRecord>>(`${this.base}/usage/records`, { params });
  }

  calendar(f?: UsageFilter): Observable<CalendarDay[]> {
    return this.http.get<CalendarDay[]>(`${this.base}/usage/calendar`, { params: f ? this.filterParams(f) : undefined });
  }

  /** Fleet rollup: per-machine and per-user leaderboards for the filtered range. */
  fleet(f?: UsageFilter): Observable<Fleet> {
    return this.http.get<Fleet>(`${this.base}/fleet`, { params: f ? this.filterParams(f) : undefined });
  }

  /** Reporting machines for the dashboard filter: raw Name + display Label ("local" when empty). */
  machines(): Observable<MachineStat[]> {
    return this.http.get<MachineStat[]>(`${this.base}/machines`);
  }

  // ---- Fleet management (all require reporter.manage; enforced server-side too) ----

  /** Reassign every record in a set of buckets to a single target (combine into an existing one, or transfer/re-label). */
  reassignFleet(body: FleetReassignRequest): Observable<FleetReassignResult> {
    return this.http.post<FleetReassignResult>(`${this.base}/fleet/reassign`, body);
  }

  /** Permanently delete every usage record in the named buckets. */
  deleteFleet(body: FleetDeleteRequest): Observable<FleetDeleteResult> {
    return this.http.post<FleetDeleteResult>(`${this.base}/fleet/delete`, body);
  }

  /** Revoke every active ingest key owned by a user (USER dimension only). */
  revokeFleetKeys(body: FleetRevokeKeysRequest): Observable<FleetRevokeKeysResult> {
    return this.http.post<FleetRevokeKeysResult>(`${this.base}/fleet/revoke-keys`, body);
  }

  heatmap(f?: UsageFilter): Observable<HeatmapCell[]> {
    return this.http.get<HeatmapCell[]>(`${this.base}/usage/heatmap`, { params: f ? this.filterParams(f) : undefined });
  }

  /** Cache-efficiency rollup for the filtered range (same filters as the summary). */
  cacheEfficiency(f: UsageFilter): Observable<CacheEfficiency> {
    return this.http.get<CacheEfficiency>(`${this.base}/usage/cache-efficiency`, { params: this.filterParams(f) });
  }

  stats(f?: UsageFilter): Observable<UsageStats> {
    return this.http.get<UsageStats>(`${this.base}/usage/stats`, { params: f ? this.filterParams(f) : undefined });
  }

  session(id: string): Observable<SessionDetail> {
    return this.http.get<SessionDetail>(`${this.base}/usage/session/${encodeURIComponent(id)}`);
  }

  // ---- Public share links ----
  createShare(body: CreateShareRequest): Observable<ShareCreated> {
    return this.http.post<ShareCreated>(`${this.base}/shares`, body);
  }

  listShares(): Observable<ShareListItem[]> {
    return this.http.get<ShareListItem[]>(`${this.base}/shares`);
  }

  updateShare(id: number, body: { expiresInHours: number; label?: string | null }): Observable<ShareListItem> {
    return this.http.put<ShareListItem>(`${this.base}/shares/${id}`, body);
  }

  deleteShare(id: number): Observable<unknown> {
    return this.http.delete(`${this.base}/shares/${id}`);
  }

  shareAccesses(id: number): Observable<ShareAccessItem[]> {
    return this.http.get<ShareAccessItem[]>(`${this.base}/shares/${id}/accesses`);
  }

  /** Anonymous read of a public share by token. */
  publicShare(token: string): Observable<PublicShare> {
    return this.http.get<PublicShare>(`${this.base}/share/${encodeURIComponent(token)}`);
  }

  // ---- Bill Splitter (owner CRUD gated bills.use; the public claim surface is anonymous below) ----

  /** The owner's payment handles (single global config set) — also returned on each bill DTO. */
  billPaymentHandles(): Observable<PaymentHandlesDto> {
    return this.http.get<PaymentHandlesDto>(`${this.base}/bills/payment-handles`);
  }

  /** List the caller's own bills (newest first). */
  bills(): Observable<BillDto[]> {
    return this.http.get<BillDto[]>(`${this.base}/bills/`);
  }

  /** Read one of the caller's own bills. */
  bill(id: number): Observable<BillDto> {
    return this.http.get<BillDto>(`${this.base}/bills/${id}`);
  }

  createBill(body: CreateBillRequest): Observable<BillDto> {
    return this.http.post<BillDto>(`${this.base}/bills/`, body);
  }

  updateBill(id: number, body: UpdateBillRequest): Observable<BillDto> {
    return this.http.put<BillDto>(`${this.base}/bills/${id}`, body);
  }

  deleteBill(id: number): Observable<unknown> {
    return this.http.delete(`${this.base}/bills/${id}`);
  }

  addBillItem(id: number, body: BillItemRequest): Observable<{ id: number }> {
    return this.http.post<{ id: number }>(`${this.base}/bills/${id}/items`, body);
  }

  updateBillItem(id: number, itemId: number, body: BillItemRequest): Observable<unknown> {
    return this.http.put(`${this.base}/bills/${id}/items/${itemId}`, body);
  }

  deleteBillItem(id: number, itemId: number): Observable<unknown> {
    return this.http.delete(`${this.base}/bills/${id}/items/${itemId}`);
  }

  /** Assign an item to a CONTACT (a mutual ChatContact of the owner), or clear with null. */
  assignBillItem(id: number, itemId: number, assignedToUserId: number | null): Observable<unknown> {
    return this.http.post(`${this.base}/bills/${id}/items/${itemId}/assign`, { assignedToUserId });
  }

  /** Owner marks an item settled/unsettled. */
  settleBillItem(id: number, itemId: number, settled: boolean): Observable<unknown> {
    return this.http.post(`${this.base}/bills/${id}/items/${itemId}/settle`, { settled });
  }

  /**
   * MULTIMODAL receipt breakdown (gated bills.use AND ai.vision). `imageBase64` is raw base64 (no `data:`
   * prefix). Returns the items + tax/tip for the owner to review; nothing is saved. 503 when AI is off.
   */
  billReceipt(id: number, body: { imageBase64: string; mimeType: string }): Observable<ReceiptBreakdownDto> {
    return this.http.post<ReceiptBreakdownDto>(`${this.base}/bills/${id}/receipt`, body);
  }

  /** Enable/disable the public claim link; enabling mints a token on first use. */
  toggleBillShare(id: number, enabled: boolean): Observable<BillShareToggleResult> {
    return this.http.post<BillShareToggleResult>(`${this.base}/bills/${id}/share`, { enabled });
  }

  // ---- Public, anonymous claim surface (mirrors /api/share/{token}) ----

  /** Anonymous read of a public bill by token. */
  publicBill(token: string): Observable<PublicBillDto> {
    return this.http.get<PublicBillDto>(`${this.base}/bill-share/${encodeURIComponent(token)}`);
  }

  /** Claim an open item under a display name (anonymous). Returns the refreshed public bill. */
  claimBillItem(token: string, itemId: number, name: string): Observable<PublicBillDto> {
    return this.http.post<PublicBillDto>(`${this.base}/bill-share/${encodeURIComponent(token)}/claim`, { itemId, name });
  }

  recordsCsv(f: UsageFilter): Observable<Blob> {
    return this.http.get(`${this.base}/usage/records.csv`, { params: this.filterParams(f), responseType: 'blob' });
  }

  /** Download the caller's full personal data export as a ZIP (all their own data across every domain). */
  exportMyData(): Observable<Blob> {
    return this.http.get(`${this.base}/me/export`, { responseType: 'blob' });
  }

  /**
   * The user-management audit log. Pass `revealKey` to send the X-Email-Reveal-Key header so the server
   * returns real actor/target emails; omit it and other users' emails come back masked (null). The key
   * travels only in the header — never a URL/query string — and is never persisted.
   */
  auditLog(revealKey?: string): Observable<AuditEntry[]> {
    return this.http.get<AuditEntry[]>(`${this.base}/audit`, { headers: this.revealHeader(revealKey) });
  }

  /** Build the X-Email-Reveal-Key header when a key is supplied; otherwise no extra headers (emails stay masked). */
  private revealHeader(revealKey?: string): HttpHeaders | undefined {
    return revealKey ? new HttpHeaders({ 'X-Email-Reveal-Key': revealKey }) : undefined;
  }

  requestLogs(opts: { method?: string; status?: string; q?: string; take?: number } = {}): Observable<RequestLogEntry[]> {
    let p = new HttpParams();
    if (opts.method) p = p.set('method', opts.method);
    if (opts.status) p = p.set('status', opts.status);
    if (opts.q) p = p.set('q', opts.q);
    p = p.set('take', opts.take ?? 200);
    return this.http.get<RequestLogEntry[]>(`${this.base}/logs`, { params: p });
  }

  /**
   * The admin AI-usage log: a keyset page of rows (newest-first) plus a summary computed over the whole
   * filtered window. `user` is an AppUser id (raw emails are never accepted); `from`/`to` are ISO strings.
   */
  getAiUsage(f: AiUsageFilter = {}): Observable<AiUsageResponse> {
    let p = new HttpParams();
    if (f.before != null) p = p.set('before', f.before);
    if (f.limit != null) p = p.set('limit', f.limit);
    if (f.user != null) p = p.set('user', f.user);
    if (f.feature) p = p.set('feature', f.feature);
    if (f.outcome) p = p.set('outcome', f.outcome);
    if (f.from) p = p.set('from', f.from);
    if (f.to) p = p.set('to', f.to);
    return this.http.get<AiUsageResponse>(`${this.base}/ai-usage`, { params: p });
  }

  projects(): Observable<ProjectDto[]> {
    return this.http.get<ProjectDto[]>(`${this.base}/projects`);
  }

  models(): Observable<ModelStat[]> {
    return this.http.get<ModelStat[]>(`${this.base}/models`);
  }

  pricing(): Observable<Pricing[]> {
    return this.http.get<Pricing[]>(`${this.base}/pricing`);
  }

  updatePricing(id: number, dto: Pricing): Observable<Pricing> {
    return this.http.put<Pricing>(`${this.base}/pricing/${id}`, dto);
  }

  recompute(): Observable<{ modelsUpdated: number; rowsUpdated: number }> {
    return this.http.post<{ modelsUpdated: number; rowsUpdated: number }>(`${this.base}/pricing/recompute`, {});
  }

  sources(): Observable<IngestionSource[]> {
    return this.http.get<IngestionSource[]>(`${this.base}/sources`);
  }

  updateSource(id: number, dto: IngestionSource): Observable<unknown> {
    return this.http.put(`${this.base}/sources/${id}`, dto);
  }

  settings(): Observable<Settings> {
    return this.http.get<Settings>(`${this.base}/settings`);
  }

  saveSettings(dto: Settings): Observable<unknown> {
    return this.http.put(`${this.base}/settings`, dto);
  }

  notifications(): Observable<NotificationSettings> {
    return this.http.get<NotificationSettings>(`${this.base}/notifications`);
  }

  saveNotifications(body: NotificationUpdate): Observable<NotificationSettings> {
    return this.http.put<NotificationSettings>(`${this.base}/notifications`, body);
  }

  testNotification(): Observable<{ message: string }> {
    return this.http.post<{ message: string }>(`${this.base}/notifications/test`, {});
  }

  sendUsageSnapshot(): Observable<{ message: string }> {
    return this.http.post<{ message: string }>(`${this.base}/notifications/snapshot`, {});
  }

  // ---- System Discord routing table (notifications.view to read, notifications.manage to write) ----
  discordRoutes(): Observable<DiscordRoute[]> {
    return this.http.get<DiscordRoute[]>(`${this.base}/notifications/routes`);
  }

  updateDiscordRoute(eventKey: string, body: DiscordRouteUpdate): Observable<DiscordRoute> {
    return this.http.put<DiscordRoute>(`${this.base}/notifications/routes/${encodeURIComponent(eventKey)}`, body);
  }

  // ---- Per-user "Forward to my Discord" (any authenticated user; caller's own only) ----
  // The webhook URL is never returned — only { configured, hint, surfaceDiscord }.
  myDiscord(): Observable<MyDiscord> {
    return this.http.get<MyDiscord>(`${this.base}/notifications/me/discord`);
  }

  saveMyDiscord(body: MyDiscordUpdate): Observable<MyDiscord> {
    return this.http.put<MyDiscord>(`${this.base}/notifications/me/discord`, body);
  }

  // 200 { message } · 404 if no webhook saved · 502 if Discord rejects.
  testMyDiscord(): Observable<{ message: string }> {
    return this.http.post<{ message: string }>(`${this.base}/notifications/me/discord/test`, {});
  }

  // Weekly recap send-now: composes the caller's last 7 days + posts it to their own webhook immediately
  // (ignores the opt-in toggle + the weekly idempotency guard). 200 { message } · 404 no webhook · 502 rejected.
  sendMyDiscordRecap(): Observable<{ message: string }> {
    return this.http.post<{ message: string }>(`${this.base}/notifications/me/discord/recap`, {});
  }

  // Weekly recap preview: composes the embed (period/headline/fields) WITHOUT sending. No webhook required.
  previewMyDiscordRecap(): Observable<RecapPreview> {
    return this.http.post<RecapPreview>(`${this.base}/notifications/me/discord/recap?preview=true`, {});
  }

  // ---- Ingest keys (reporter credentials) ----
  // GET requires reporter.view|manage|self (manage sees all keys; self/view see only own).
  // POST/DELETE require reporter.manage|self (self acts on own keys only).
  ingestKeys(): Observable<IngestKey[]> {
    return this.http.get<IngestKey[]>(`${this.base}/ingest-keys`);
  }

  createIngestKey(name: string): Observable<IngestKeyCreated> {
    return this.http.post<IngestKeyCreated>(`${this.base}/ingest-keys`, { name });
  }

  revokeIngestKey(id: number): Observable<unknown> {
    return this.http.delete(`${this.base}/ingest-keys/${id}`);
  }

  // ---- Saved dashboard views (per-user; gated by dashboard.view OR calendar.view) ----
  savedViews(): Observable<SavedView[]> {
    return this.http.get<SavedView[]>(`${this.base}/saved-views`);
  }

  // Upsert-by-name: POSTing a name that already exists updates that view.
  saveView(body: SavedViewUpsertRequest): Observable<SavedView> {
    return this.http.post<SavedView>(`${this.base}/saved-views`, body);
  }

  updateView(id: number, body: SavedViewUpsertRequest): Observable<SavedView> {
    return this.http.put<SavedView>(`${this.base}/saved-views/${id}`, body);
  }

  deleteView(id: number): Observable<unknown> {
    return this.http.delete(`${this.base}/saved-views/${id}`);
  }

  sync(): Observable<SyncResult> {
    return this.http.post<SyncResult>(`${this.base}/sync`, {});
  }

  syncStatus(): Observable<SyncStatus> {
    return this.http.get<SyncStatus>(`${this.base}/sync/status`);
  }

  /** Teammates active within the last ~2 minutes (includes the caller). Requires any signed-in user. */
  presence(): Observable<Presence[]> {
    return this.http.get<Presence[]>(`${this.base}/presence`);
  }

  /**
   * The caller's people: their mutual chat contacts ∪ their household members, de-duplicated over the
   * single AppUser spine and decorated with live presence (self first, then online, then by name).
   * Read-only aggregation. Gated any-of chat.read | family.use (a chat-only caller sees just contacts;
   * a family-only caller sees just their household). Never an email — names are DisplayName-formatted.
   */
  people(): Observable<PersonDto[]> {
    return this.http.get<PersonDto[]>(`${this.base}/people`);
  }

  /**
   * Send a circle peer a canned NUDGE (a fixed safe template — never free text). The target must be in
   * the caller's circle (a contact or household member) and not opted out; the server enforces the circle,
   * a per-pair cooldown, and a global rate limit. `delivered:false` means a friendly no-op (cooldown or
   * the target is unavailable/opted out) — NOT an error. Identify the target by AppUser id (never email).
   */
  nudge(targetUserId: number, kind: NudgeKind): Observable<{ delivered: boolean; reason?: string }> {
    return this.http.post<{ delivered: boolean; reason?: string }>(`${this.base}/nudge`, { targetUserId, kind });
  }

  // ---- Location / GPS (PRIVATE by default; capture is OPT-IN) -------------------------------------
  // Every method maps 1:1 to /api/location/*. The settings PATCH gates capture; nothing is ever recorded
  // (recordLocation 409s) until the caller has enabled location. All require location.self except
  // adminLocations, which requires location.view-all (enforced server-side too).

  /** The caller's current opt-in settings (capture on/off + share-to-household). Requires location.self. */
  locationSettings(): Observable<LocationSettings> {
    return this.http.get<LocationSettings>(`${this.base}/location/settings`);
  }

  /** Flip one or both opt-in toggles (omit a field to leave it unchanged). Returns the saved settings. */
  patchLocationSettings(body: LocationSettingsUpdate): Observable<LocationSettings> {
    return this.http.patch<LocationSettings>(`${this.base}/location/settings`, body);
  }

  /**
   * Record one location fix for the caller. The server 409s unless the caller has enabled location
   * (the opt-in gate) — callers should only invoke this after a successful settings enable. Returns the
   * stored fix (with best-effort reverse-geocoded city).
   */
  recordLocation(body: RecordLocationRequest): Observable<LocationFix> {
    return this.http.post<LocationFix>(`${this.base}/location`, body);
  }

  /** The caller's OWN location history, newest-first (self-scoped; capped server-side). */
  myLocations(limit = 100): Observable<LocationFix[]> {
    return this.http.get<LocationFix[]>(`${this.base}/location/me`, {
      params: new HttpParams().set('limit', limit),
    });
  }

  /** Permanently clear the caller's OWN location history (privacy). Returns the deleted count. */
  clearMyLocations(): Observable<{ deleted: number }> {
    return this.http.delete<{ deleted: number }>(`${this.base}/location/me`);
  }

  /**
   * Admin oversight: every user's latest pin + a short recent trail, for the admin Locations map.
   * Identity is userId+name (no email). Requires location.view-all (enforced server-side too).
   */
  adminLocations(): Observable<AdminUserLocation[]> {
    return this.http.get<AdminUserLocation[]>(`${this.base}/location/admin`);
  }

  // ---- User management (requires users.manage) ----
  permissionCatalog(): Observable<PermissionItem[]> {
    return this.http.get<PermissionItem[]>(`${this.base}/permissions`);
  }

  /**
   * The server-defined preset templates (named permission bundles) the Users page applies as a STARTING
   * POINT when seeding a user's grant checkboxes. NOT persistent roles — applying one just preselects its
   * keys, which the admin then edits + saves. Gated by users.view|users.manage (same as the catalog).
   */
  permissionPresets(): Observable<PermissionPreset[]> {
    return this.http.get<PermissionPreset[]>(`${this.base}/permission-presets`);
  }

  /**
   * The managed-user list. Pass `revealKey` to send the X-Email-Reveal-Key header so the server returns
   * real emails; omit it and other users' emails come back masked (null — the caller's own row is always
   * real). The key travels only in the header — never a URL/query string — and is never persisted.
   */
  users(revealKey?: string): Observable<ManagedUser[]> {
    return this.http.get<ManagedUser[]>(`${this.base}/users`, { headers: this.revealHeader(revealKey) });
  }

  /** Total number of users (just the count, no row data). Gated by users.view|users.manage. */
  userCount(): Observable<{ total: number }> {
    return this.http.get<{ total: number }>(`${this.base}/users/count`);
  }

  /** A user's recent sign-in history (newest first, capped at 200). Gated by users.view|users.manage. */
  userLogins(id: number): Observable<LoginEvent[]> {
    return this.http.get<LoginEvent[]>(`${this.base}/users/${id}/logins`);
  }

  /**
   * Stamp best-effort web client info (device/agent characteristics — NO precise location, no PII) onto
   * the caller's most-recent successful login event. Authentication only; best-effort server-side (it
   * always 200s, even on no-op). Fire-and-forget right after a successful sign-in.
   */
  clientInfo(body: ClientInfoRequest): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>(`${this.base}/auth/client-info`, body);
  }

  createUser(body: { email: string; name?: string; isEnabled: boolean; permissions: string[] }): Observable<ManagedUser> {
    return this.http.post<ManagedUser>(`${this.base}/users`, body);
  }

  updateUser(id: number, body: { name?: string; isEnabled: boolean; permissions: string[] }): Observable<ManagedUser> {
    return this.http.put<ManagedUser>(`${this.base}/users/${id}`, body);
  }

  deleteUser(id: number): Observable<unknown> {
    return this.http.delete(`${this.base}/users/${id}`);
  }

  /**
   * Force-log a user out of their current session by invalidating their active JWT (bumps the user's
   * SessionVersion). Non-destructive — the account stays enabled and they can sign back in immediately.
   * Requires users.manage.
   */
  forceLogout(userId: number): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>(`${this.base}/users/${userId}/logout`, {});
  }

  /**
   * Admin set-home: set (or clear) ANOTHER user's landing page (PATCH /api/users/{id}/home). Pass a
   * known page route the TARGET user can reach, or null to clear (default first-accessible page).
   * Validated server-side against the TARGET's persisted permissions (400 if they can't reach it).
   * Requires users.manage. Returns the updated ManagedUser (its homeRoute reflects the change).
   */
  adminSetHomeRoute(userId: number, route: string | null): Observable<ManagedUser> {
    return this.http.patch<ManagedUser>(`${this.base}/users/${userId}/home`, { route });
  }

  // ---- Chat (channels, DMs, messages) — gated by chat.read/chat.send/chat.moderate ----

  /** All channels + DMs the caller can see, with unread counts and last-message previews. */
  chatChannels(): Observable<ChatChannelDto[]> {
    return this.http.get<ChatChannelDto[]>(`${this.base}/chat/channels`);
  }

  /** Create a channel (requires chat.send). */
  createChannel(body: CreateChannelRequest): Observable<ChatChannelDto> {
    return this.http.post<ChatChannelDto>(`${this.base}/chat/channels`, body);
  }

  /** Open (or fetch the existing) 1:1 direct-message conversation with a user by AppUser id (requires chat.send). */
  openDirect(userId: number): Observable<ChatChannelDto> {
    return this.http.post<ChatChannelDto>(`${this.base}/chat/direct`, { userId });
  }

  /**
   * One page of a channel's messages, newest-first. Paginate older history by passing
   * `before` = the oldest message id already loaded; `limit` caps the page size.
   */
  chatMessages(channelId: number, opts: { before?: number; limit?: number } = {}): Observable<ChatMessageDto[]> {
    let p = new HttpParams();
    if (opts.before != null) p = p.set('before', opts.before);
    if (opts.limit != null) p = p.set('limit', opts.limit);
    return this.http.get<ChatMessageDto[]>(`${this.base}/chat/channels/${channelId}/messages`, { params: p });
  }

  /** Post a message via REST (the realtime hub is preferred; this is the fallback). Mentions are sent by AppUser id. */
  sendChatMessage(channelId: number, body: string, mentionedUserIds: number[] | null = null): Observable<ChatMessageDto> {
    return this.http.post<ChatMessageDto>(`${this.base}/chat/channels/${channelId}/messages`, { body, mentionedUserIds });
  }

  /** Edit a message's body (own message, or any with chat.moderate). */
  editChatMessage(messageId: number, body: string): Observable<unknown> {
    return this.http.patch(`${this.base}/chat/messages/${messageId}`, { body });
  }

  /** Soft-delete a message (own message, or any with chat.moderate). */
  deleteChatMessage(messageId: number): Observable<unknown> {
    return this.http.delete(`${this.base}/chat/messages/${messageId}`);
  }

  /** Mark a channel read up to `messageId`; returns the resulting unread count. */
  markChatRead(channelId: number, messageId: number): Observable<{ unreadCount: number }> {
    return this.http.post<{ unreadCount: number }>(`${this.base}/chat/channels/${channelId}/read`, { messageId });
  }

  /**
   * Toggle an emoji reaction on a message (add if absent, remove if present) via REST — the realtime
   * hub is preferred, this is the fallback. Returns the message's full updated reaction groups.
   * Requires chat.send + membership of the message's channel.
   */
  toggleReaction(messageId: number, emoji: string): Observable<ReactionGroupDto[]> {
    return this.http.post<ReactionGroupDto[]>(`${this.base}/chat/messages/${messageId}/reactions`, { emoji });
  }

  // ---- Chat AI assists (Gemini-backed; catch-up always 200, replies/compose 503-graceful) ----

  /**
   * "✨ Catch me up" — summarise a channel's recent messages (read-only; WRITES NOTHING). Gated
   * chat.read + membership (non-member 404). ALWAYS 200: a deterministic plain floor covers an
   * unavailable Gemini (`fellBackToPlain` = true), so this never 503s.
   */
  chatCatchUp(channelId: number): Observable<ChatCatchUpResult> {
    return this.http.post<ChatCatchUpResult>(`${this.base}/chat/channels/${channelId}/ai/catch-up`, {});
  }

  /**
   * "✨ Suggest replies" — 2-4 reply suggestions for the caller (read-only; SENDS NOTHING). Gated
   * chat.send + membership (non-member 404). 503 when Gemini is unavailable (handle gracefully — the
   * affordance just steps aside).
   */
  chatSuggestReplies(channelId: number): Observable<ChatRepliesResult> {
    return this.http.post<ChatRepliesResult>(`${this.base}/chat/channels/${channelId}/ai/replies`, {});
  }

  /**
   * "✨ Compose assist" — draft/rewrite/shorten/friendlier/formal the composer text (SENDS NOTHING).
   * Gated chat.send. 400 when there's nothing to work from (empty prompt AND empty draft) or an unknown
   * action; 503 when Gemini is unavailable. The result fills the composer; the user sends via Send.
   */
  chatCompose(action: ChatComposeAction, opts: { prompt?: string; currentDraft?: string } = {}): Observable<ChatComposeResult> {
    return this.http.post<ChatComposeResult>(`${this.base}/chat/ai/compose`, {
      action, prompt: opts.prompt ?? '', currentDraft: opts.currentDraft ?? '',
    });
  }

  // ---- Chat live-location share (temporary, scoped to ONE conversation) -----------------------------
  // start/update/extend/stop require chat.send + location.self + membership/ownership; the active read
  // requires chat.read + membership (non-member 404). The realtime hub broadcasts the result to every
  // participant; these REST calls return the same ChatLocationShareDto. Identity is userId+name, never email.

  /** Active (not stopped, not expired) live-location shares in a conversation, so a late-joiner sees one in progress. */
  activeLocationShares(channelId: number): Observable<ChatLocationShareDto[]> {
    return this.http.get<ChatLocationShareDto[]>(`${this.base}/chat/channels/${channelId}/location-shares`);
  }

  /** Start a live-location share in a conversation the caller belongs to (carries the first fix + duration). */
  startLocationShare(channelId: number, body: StartLocationShareRequest): Observable<ChatLocationShareDto> {
    return this.http.post<ChatLocationShareDto>(`${this.base}/chat/channels/${channelId}/location-share`, body);
  }

  /** Push the sharer's latest live position on an active share they own (404 when absent/not owned/ended). */
  updateLocationShare(shareId: number, body: UpdateLocationShareRequest): Observable<ChatLocationShareDto> {
    return this.http.put<ChatLocationShareDto>(`${this.base}/chat/location-share/${shareId}/position`, body);
  }

  /** Extend an active share the caller owns by N minutes (e.g. +15/+60), clamped server-side (404 when ended). */
  extendLocationShare(shareId: number, body: ExtendLocationShareRequest): Observable<ChatLocationShareDto> {
    return this.http.post<ChatLocationShareDto>(`${this.base}/chat/location-share/${shareId}/extend`, body);
  }

  /** Stop a share the caller owns (idempotent; 404 only when absent/not owned). */
  stopLocationShare(shareId: number): Observable<ChatLocationShareDto> {
    return this.http.post<ChatLocationShareDto>(`${this.base}/chat/location-share/${shareId}/stop`, {});
  }

  // ---- Chat contacts / circles (admin-managed; the picker draws from these) ----

  /** The CALLER's own chat contacts (their circle) — the New-DM / member-picker candidate source. Gated by chat.read. */
  myContacts(): Observable<ChatContactDto[]> {
    return this.http.get<ChatContactDto[]>(`${this.base}/chat/contacts/me`);
  }

  /** Every enabled user except the caller, name-sorted — the admin editor's search pool (and the admin's own picker). Gated by chat.contacts.manage. */
  chatDirectory(): Observable<ChatContactDto[]> {
    return this.http.get<ChatContactDto[]>(`${this.base}/chat/directory`);
  }

  /** A specific user's chat contacts (admin editor), addressed by owner AppUser id. Gated by chat.contacts.manage. */
  userContacts(userId: number): Observable<ChatContactDto[]> {
    return this.http.get<ChatContactDto[]>(`${this.base}/chat/contacts/user/${userId}`);
  }

  /**
   * Add a contact to a user's circle (mutual, idempotent); returns the updated list. Both the owner and
   * the contact are addressed by AppUser id (email-privacy). Gated by chat.contacts.manage.
   */
  addUserContact(userId: number, contactUserId: number): Observable<ChatContactDto[]> {
    return this.http.post<ChatContactDto[]>(`${this.base}/chat/contacts/user/${userId}`, { contactUserId });
  }

  /**
   * Remove a contact from a user's circle (mutual, no-op if absent); returns the updated list. Both the
   * owner and the contact are addressed by AppUser id (email-privacy). Gated by chat.contacts.manage.
   */
  removeUserContact(userId: number, contactUserId: number): Observable<ChatContactDto[]> {
    return this.http.delete<ChatContactDto[]>(`${this.base}/chat/contacts/user/${userId}/${contactUserId}`);
  }

  // ---- Inbox / notifications (bell UI is Phase 2b; methods provided now for the realtime service) ----

  /** The caller's notifications, newest-first. `unreadOnly` filters to unread; `limit` caps the page (1..100). */
  inboxNotifications(opts: { unreadOnly?: boolean; limit?: number } = {}): Observable<NotificationDto[]> {
    let p = new HttpParams();
    if (opts.unreadOnly != null) p = p.set('unreadOnly', opts.unreadOnly);
    if (opts.limit != null) p = p.set('limit', opts.limit);
    return this.http.get<NotificationDto[]>(`${this.base}/inbox`, { params: p });
  }

  /** The caller's unread notification count. */
  inboxUnreadCount(): Observable<{ count: number }> {
    return this.http.get<{ count: number }>(`${this.base}/inbox/unread-count`);
  }

  /**
   * Mark one or more notifications read in a single request. Routes to POST /api/inbox/read with a
   * body of `{ ids: [...] }` (NOT /api/inbox/{id}/read); returns the resulting unread total.
   */
  markNotificationsRead(ids: number[]): Observable<{ unreadCount: number }> {
    return this.http.post<{ unreadCount: number }>(`${this.base}/inbox/read`, { ids });
  }

  /** Mark every notification read; returns the new (zero) unread total. */
  markAllNotificationsRead(): Observable<{ unreadCount: number }> {
    return this.http.post<{ unreadCount: number }>(`${this.base}/inbox/read-all`, {});
  }

  /** The caller's notification delivery preferences. */
  getNotificationPreferences(): Observable<NotificationPreferenceDto> {
    return this.http.get<NotificationPreferenceDto>(`${this.base}/inbox/preferences`);
  }

  /** Persist the caller's notification delivery preferences; returns the saved row. */
  updateNotificationPreferences(dto: NotificationPreferenceDto): Observable<NotificationPreferenceDto> {
    return this.http.put<NotificationPreferenceDto>(`${this.base}/inbox/preferences`, dto);
  }

  // ---- Home-page preference (self-service; any authenticated user sets their OWN landing page) ----

  /**
   * Set (or clear) the CALLER's own landing page (PATCH /api/auth/home). Pass a known page route the
   * caller can currently reach, or null to clear it (fall back to the default first-accessible home).
   * The server re-validates the route against the caller's live permissions; returns the saved value.
   */
  setHomeRoute(route: string | null): Observable<{ homeRoute: string | null }> {
    return this.http.patch<{ homeRoute: string | null }>(`${this.base}/auth/home`, { route });
  }

  /**
   * Update the CALLER's own display/presence preferences (PATCH /api/auth/profile). Every field is
   * optional — send only the ones you're changing. displayNameMode controls how the caller appears to
   * EVERYONE ("full" | "firstName" | "firstInitial" | "nickname"); nickname/presenceStatus are sanitized
   * server-side (empty string clears). Returns the fresh effective values.
   */
  setProfile(body: Partial<ProfilePrefs>): Observable<ProfilePrefs> {
    return this.http.patch<ProfilePrefs>(`${this.base}/auth/profile`, body);
  }

  /**
   * The caller's circle ACTIVITY FEED (GET /api/feed) — the social feed, DISTINCT from the admin audit
   * page at /activity (GET /api/logs). Newest-first, keyset paged: pass `before` = the oldest id already
   * loaded to fetch the next (older) page; `limit` caps the page (1..100). The response carries a
   * `nextBefore` cursor (null when there are no more). Actors are an id + DisplayName-formatted name —
   * never an email. Audience + opt-in gating are enforced server-side.
   */
  feed(opts: { before?: number; limit?: number } = {}): Observable<FeedPage> {
    let p = new HttpParams();
    if (opts.before != null) p = p.set('before', opts.before);
    if (opts.limit != null) p = p.set('limit', opts.limit);
    return this.http.get<FeedPage>(`${this.base}/feed`, { params: p });
  }

  /**
   * Toggle a cheer (👏) on a feed event (POST /api/feed/{id}/react). Adds the caller's cheer if absent,
   * removes it if present. Returns the row's fresh `clapCount` + `iReacted` so the UI converges after races.
   * The server enforces that the caller can only cheer an event they can already SEE in the feed. The actor
   * gets ONE in-app notification on a fresh cheer of someone else's event (none on self-cheer or un-cheer).
   */
  reactFeed(eventId: number): Observable<ReactResult> {
    return this.http.post<ReactResult>(`${this.base}/feed/${eventId}/react`, {});
  }

  // ---- Feed comments (the social thread under a feed event; gated tracker.self, same 404 visibility gate) ----

  /**
   * The visible comment thread under one feed event (GET /api/feed/{id}/comments, oldest-first). The server
   * enforces the SAME circle/visibility gate as the feed — 404 (not 403) when the caller can't see the event,
   * so the existence of a non-visible event is never revealed. Soft-deleted comments are excluded; each author
   * is resolved to an AppUser id + DisplayName (never an email).
   */
  feedComments(eventId: number): Observable<CommentDto[]> {
    return this.http.get<CommentDto[]>(`${this.base}/feed/${eventId}/comments`);
  }

  /**
   * Add a comment to a visible feed event (POST /api/feed/{id}/comments). The body is validated server-side
   * (trim, non-empty, cap 500, control-char strip). Rate-limited like chat; 404 when the event isn't visible.
   * On a comment of someone else's event the actor gets ONE in-app notification (DisplayName only, body never
   * in the text). Returns the created comment (with `mine` = true).
   */
  addFeedComment(eventId: number, body: string): Observable<CommentDto> {
    return this.http.post<CommentDto>(`${this.base}/feed/${eventId}/comments`, { body });
  }

  /**
   * Soft-delete a comment (DELETE /api/feed/comments/{cid}). The author may delete their own; a chat.moderate
   * caller may delete anyone's. 404 when absent/already deleted; 403 when neither author nor moderator.
   */
  deleteFeedComment(commentId: number): Observable<unknown> {
    return this.http.delete(`${this.base}/feed/comments/${commentId}`);
  }

  // ---- Habit pacts (shared accountability goals; gated tracker.self; mutual-contact membership) ----

  /** The caller's pacts (owned OR a member of), newest-first. Members are ids + DisplayName (never email). */
  pacts(): Observable<PactDto[]> {
    return this.http.get<PactDto[]>(`${this.base}/pacts`);
  }

  /**
   * Create a pact (POST /api/pacts, rate-limited like chat). `memberUserIds` are AppUser ids of the owner's
   * MUTUAL chat contacts — a non-contact id is rejected (400) server-side. Returns the created pact.
   */
  createPact(body: CreatePactRequest): Observable<PactDto> {
    return this.http.post<PactDto>(`${this.base}/pacts`, body);
  }

  /** Edit a pact (PUT /api/pacts/{id}, OWNER only). Returns the updated pact. */
  updatePact(id: number, body: UpdatePactRequest): Observable<PactDto> {
    return this.http.put<PactDto>(`${this.base}/pacts/${id}`, body);
  }

  /** Archive a pact (DELETE /api/pacts/{id}, OWNER only). 204 on success. */
  archivePact(id: number): Observable<unknown> {
    return this.http.delete(`${this.base}/pacts/${id}`);
  }

  /**
   * Invite more members to a pact (POST /api/pacts/{id}/members, OWNER only, rate-limited). Each id MUST be a
   * mutual contact of the owner (a non-contact is rejected, 400). Returns the refreshed pact.
   */
  addPactMembers(id: number, memberUserIds: number[]): Observable<PactDto> {
    return this.http.post<PactDto>(`${this.base}/pacts/${id}/members`, { memberUserIds });
  }

  /** Accept a pact invite (POST /api/pacts/{id}/join). 204 on success; 404 when never invited. */
  joinPact(id: number): Observable<unknown> {
    return this.http.post(`${this.base}/pacts/${id}/join`, {});
  }

  /** Leave a pact (POST /api/pacts/{id}/leave). 204 on success; 404 when not a member. */
  leavePact(id: number): Observable<unknown> {
    return this.http.post(`${this.base}/pacts/${id}/leave`, {});
  }

  /**
   * Each member's matching-event count in the pact's period (GET /api/pacts/{id}/progress). Only a participant
   * may read it (404 otherwise). Counts are of ALREADY-shareable ActivityEvents — never a private amount.
   */
  pactProgress(id: number): Observable<PactProgressRowDto[]> {
    return this.http.get<PactProgressRowDto[]>(`${this.base}/pacts/${id}/progress`);
  }

  // ---- Family leaderboard (household-scoped; gated family.use; ranks shareable activity counts only) ----

  /**
   * Rank the caller's OWN household members over shareable ActivityEvent counts for one metric
   * (GET /api/family/leaderboard?metric=). Ties share a rank (competition ranking). Identity is id +
   * DisplayName — never an email; NEVER a private tracker amount or any health figure.
   */
  familyLeaderboard(metric: LeaderboardMetric = 'workout'): Observable<LeaderboardRowDto[]> {
    return this.http.get<LeaderboardRowDto[]>(`${this.base}/family/leaderboard`, {
      params: new HttpParams().set('metric', metric),
    });
  }

  // ---- "Built With Usage IQ" badge (PUBLIC, anonymous, cached; aggregate numbers only) ----

  /**
   * The public "Built With Usage IQ" badge figures (GET /api/public/built-with). Anonymous + cacheable —
   * AGGREGATE NUMBERS ONLY for the deterministic owner account (no email/name/project/model), identical for
   * every caller. Powers the live counter band on the marketing landing page.
   */
  builtWith(): Observable<PublicBuiltWithDto> {
    return this.http.get<PublicBuiltWithDto>(`${this.base}/public/built-with`);
  }

  // ---- Automations (the caller's OWN rules; strictly owner-scoped server-side) ----
  automations(): Observable<AutomationRule[]> {
    return this.http.get<AutomationRule[]>(`${this.base}/automations`);
  }
  createAutomation(body: AutomationRuleInput): Observable<AutomationRule> {
    return this.http.post<AutomationRule>(`${this.base}/automations`, body);
  }
  updateAutomation(id: number, body: AutomationRuleInput): Observable<AutomationRule> {
    return this.http.put<AutomationRule>(`${this.base}/automations/${id}`, body);
  }
  deleteAutomation(id: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/automations/${id}`);
  }

  // ---- Proactive scheduled agents (the caller's OWN per-kind prefs; strictly owner-scoped server-side) ----
  /** List the caller's agent prefs (one row per kind; upserts disabled defaults on first read). */
  agents(): Observable<ScheduledAgentDto[]> {
    return this.http.get<ScheduledAgentDto[]>(`${this.base}/agents`);
  }
  /** Upsert one agent kind's prefs (enabled/deliver-hour/quiet-hours/timezone). */
  updateAgent(kind: string, body: ScheduledAgentInput): Observable<ScheduledAgentDto> {
    return this.http.put<ScheduledAgentDto>(`${this.base}/agents/${kind}`, body);
  }
  /** Render the deterministic floor NOW (ignores quiet-hours/idempotency; never delivers). */
  previewAgent(kind: string): Observable<AgentPreviewResult> {
    return this.http.post<AgentPreviewResult>(`${this.base}/agents/${kind}/preview`, {});
  }
  /** Deliver a real one-off AgentNudge (does NOT touch the idempotency stamps). */
  testAgent(kind: string): Observable<AgentTestResult> {
    return this.http.post<AgentTestResult>(`${this.base}/agents/${kind}/test`, {});
  }

  // ---- Access policy (open sign-up + default permissions; requires users.manage to edit) ----
  getAccessPolicy(): Observable<AccessPolicy> {
    return this.http.get<AccessPolicy>(`${this.base}/access-policy`);
  }

  updateAccessPolicy(body: AccessPolicy): Observable<AccessPolicy> {
    return this.http.put<AccessPolicy>(`${this.base}/access-policy`, body);
  }

  // ---- Food & fitness tracker (gated by tracker.self; tracker.viewall to view others) ----

  /**
   * USDA food search. Pass `q` for a name search OR `barcode` for a UPC/EAN lookup (not both).
   * Returns 503 ProblemDetails when USDA is unconfigured — the caller should fall back to manual entry.
   */
  searchFoods(opts: { q?: string; barcode?: string }): Observable<FoodSearchItemDto[]> {
    let p = new HttpParams();
    if (opts.q) p = p.set('q', opts.q);
    if (opts.barcode) p = p.set('barcode', opts.barcode);
    return this.http.get<FoodSearchItemDto[]>(`${this.base}/foods/search`, { params: p });
  }

  /** Fetch a single food by its USDA FDC id. */
  food(fdcId: number): Observable<FoodSearchItemDto> {
    return this.http.get<FoodSearchItemDto>(`${this.base}/foods/${fdcId}`);
  }

  /**
   * A full tracker day. Omit `user` for self; pass the target's AppUser id to view someone you may
   * (read-only). The client holds no other-user emails (email-privacy) — the server resolves the id.
   */
  trackerDay(date: string, user?: number): Observable<TrackerDayDto> {
    let p = new HttpParams().set('date', date);
    if (user != null) p = p.set('user', String(user));
    return this.http.get<TrackerDayDto>(`${this.base}/tracker/day`, { params: p });
  }

  /** Log a food entry (snapshot the scaled calories/macros into the request). */
  addFood(body: AddFoodRequest): Observable<FoodEntryDto> {
    return this.http.post<FoodEntryDto>(`${this.base}/tracker/food`, body);
  }

  /**
   * Edit a logged food entry (owner only). The server is authoritative on priced-vs-manual (keyed by the
   * stored row's fdcId): a priced row recomputes macros from a new `quantity`; a manual row stores the
   * sent `description`/macros directly. Returns the updated entry. See `UpdateFoodRequest`.
   */
  updateFood(id: number, body: UpdateFoodRequest): Observable<FoodEntryDto> {
    return this.http.put<FoodEntryDto>(`${this.base}/tracker/food/${id}`, body);
  }

  /** Delete a logged food entry. */
  deleteFood(id: number): Observable<unknown> {
    return this.http.delete(`${this.base}/tracker/food/${id}`);
  }

  /**
   * The caller's saved "My foods" library (auto-built from manual food logs), newest-used first.
   * Pass `q` for a case-insensitive description/brand filter. Pass `recent: true` to ALSO append
   * recently-logged foods (read-only, `isRecent`, deduped against the saved list) for one-tap re-add.
   */
  savedFoods(q?: string, recent?: boolean): Observable<CustomFoodDto[]> {
    let params = new HttpParams();
    if (q) params = params.set('q', q);
    if (recent) params = params.set('recent', 'true');
    return this.http.get<CustomFoodDto[]>(`${this.base}/tracker/foods/saved`,
      params.keys().length ? { params } : undefined);
  }

  /** Delete one of the caller's saved foods (owner-only). */
  deleteSavedFood(id: number): Observable<unknown> {
    return this.http.delete(`${this.base}/tracker/foods/saved/${id}`);
  }

  /**
   * Log an exercise entry. Pass `exerciseId` + `durationMin` (with a profile weight) to let the server
   * estimate the calories burned; otherwise `caloriesBurned` is required.
   */
  addExercise(body: AddExerciseRequest): Observable<ExerciseEntryDto> {
    return this.http.post<ExerciseEntryDto>(`${this.base}/tracker/exercise`, body);
  }

  /** Delete a logged exercise entry. */
  deleteExercise(id: number): Observable<unknown> {
    return this.http.delete(`${this.base}/tracker/exercise/${id}`);
  }

  /**
   * The caller's saved "My exercises" library (auto-built from manual exercise logs), newest-used first.
   * Pass `q` for a case-insensitive name filter.
   */
  savedExercises(q?: string): Observable<CustomExerciseDto[]> {
    const params = q ? new HttpParams().set('q', q) : undefined;
    return this.http.get<CustomExerciseDto[]>(`${this.base}/tracker/exercises/saved`, { params });
  }

  /** Delete one of the caller's saved exercises (owner-only). */
  deleteSavedExercise(id: number): Observable<unknown> {
    return this.http.delete(`${this.base}/tracker/exercises/saved/${id}`);
  }

  /** The exercise library, filtered to a goal. Omit `goal` to use the caller's profile goal. */
  exerciseLibrary(goal?: string): Observable<ExerciseLibraryDto[]> {
    const params = goal ? new HttpParams().set('goal', goal) : undefined;
    return this.http.get<ExerciseLibraryDto[]>(`${this.base}/tracker/exercises`, { params });
  }

  /**
   * Browse/search the WorkoutX exercise catalog. `q` is a free-text name filter (server-side substring);
   * `bodyPart`/`target`/`equipment` are the confirmed catalog filters; `limit`/`offset` paginate.
   * Returns 503 ProblemDetails when WorkoutX is unconfigured — the tab shows a friendly steer.
   */
  workoutxExercises(opts: {
    q?: string; bodyPart?: string; target?: string; equipment?: string; limit?: number; offset?: number;
  } = {}): Observable<WorkoutXSearchResultDto> {
    let p = new HttpParams();
    if (opts.q) p = p.set('q', opts.q);
    if (opts.bodyPart) p = p.set('bodyPart', opts.bodyPart);
    if (opts.target) p = p.set('target', opts.target);
    if (opts.equipment) p = p.set('equipment', opts.equipment);
    if (opts.limit != null) p = p.set('limit', opts.limit);
    if (opts.offset != null) p = p.set('offset', opts.offset);
    return this.http.get<WorkoutXSearchResultDto>(`${this.base}/tracker/workoutx/exercises`, { params: p });
  }

  /**
   * Fetch one WorkoutX exercise's GIF demo as a Blob (the provider needs the secret key the browser
   * lacks, so the backend proxies it). The JWT interceptor authorizes this request; the caller turns the
   * Blob into an object URL (and must revoke it). `id` is digits only (provider ids like "0001").
   */
  workoutxGif(id: string): Observable<Blob> {
    return this.http.get(`${this.base}/tracker/workoutx/gif/${encodeURIComponent(id)}`, { responseType: 'blob' });
  }

  /** The caller's tracker profile / goals. */
  trackerProfile(): Observable<TrackerProfileDto> {
    return this.http.get<TrackerProfileDto>(`${this.base}/tracker/profile`);
  }

  /** Persist the caller's tracker profile / goals; returns the saved row. */
  saveTrackerProfile(body: TrackerProfileDto): Observable<TrackerProfileDto> {
    return this.http.put<TrackerProfileDto>(`${this.base}/tracker/profile`, body);
  }

  /**
   * The caller's dated goal-plan history (newest-first). Each save that changes a target field versions a
   * new plan server-side; the top row is the one active today. Owner-only (no `?user=`). Used by the Plan
   * History section of the My Profile & Goal page.
   */
  goalPlans(): Observable<GoalPlanDto[]> {
    return this.http.get<GoalPlanDto[]>(`${this.base}/tracker/goal-plans`);
  }

  /** People whose tracker the caller may view read-only. */
  trackerShared(): Observable<SharedUserDto[]> {
    return this.http.get<SharedUserDto[]>(`${this.base}/tracker/shared`);
  }

  /**
   * Log (upsert) the caller's weight for a date — one entry per day. Also sets the profile's current
   * weight to the most-recent-dated entry. Returns the updated profile (so the client refreshes current
   * weight + stats). OWN tracker only; weight in 1..1000 kg.
   */
  logWeight(body: LogWeightRequest): Observable<TrackerProfileDto> {
    return this.http.post<TrackerProfileDto>(`${this.base}/tracker/weight`, body);
  }

  /** The caller's OWN weight history (oldest-first) for the last N days (default 90, max 365). Private — never another user's. */
  weightHistory(days?: number): Observable<WeightPointDto[]> {
    const params = days != null ? new HttpParams().set('days', days) : undefined;
    return this.http.get<WeightPointDto[]>(`${this.base}/tracker/weight`, { params });
  }

  /**
   * The caller's OWN weight statistics: per-slot (Morning/Afternoon/Evening) averages + latest + count,
   * the typical morning to evening delta, and recent readings. Private — owner-only, never another user's.
   */
  weightStats(days?: number): Observable<WeightStatsDto> {
    const params = days != null ? new HttpParams().set('days', days) : undefined;
    return this.http.get<WeightStatsDto>(`${this.base}/tracker/weight/stats`, { params });
  }

  // ---- AI assists (Gemini-backed; each returns 503 ProblemDetails when unconfigured/unavailable) ----

  /** Estimate calories + macros for a free-text food description (+ optional free-text quantity). */
  estimateMacros(body: EstimateMacrosRequest): Observable<EstimateMacrosResponse> {
    return this.http.post<EstimateMacrosResponse>(`${this.base}/ai/estimate-macros`, body);
  }

  /** Estimate a supplement's kind + macros from its name (+ optional dose). 503 when Gemini off. */
  estimateSupplement(body: SupplementMacrosRequest): Observable<SupplementMacrosResponse> {
    return this.http.post<SupplementMacrosResponse>(`${this.base}/ai/supplement-macros`, body);
  }

  /** Suggest a daily calorie + macro goal from the CALLER's own profile (read server-side; empty body). */
  suggestGoal(): Observable<SuggestGoalResponse> {
    return this.http.post<SuggestGoalResponse>(`${this.base}/ai/suggest-goal`, {});
  }

  /** Estimate calories burned for a free-text exercise name over a duration in minutes. */
  estimateExercise(body: EstimateExerciseRequest): Observable<EstimateExerciseResponse> {
    return this.http.post<EstimateExerciseResponse>(`${this.base}/ai/estimate-exercise`, body);
  }

  /** Parse a natural-language exercise log into a structured exercise (calories use the caller's own body weight, server-side). */
  parseExercise(body: ParseExerciseRequest): Observable<ParseExerciseResponse> {
    return this.http.post<ParseExerciseResponse>(`${this.base}/ai/parse-exercise`, body);
  }

  /** Suggest a workout plan for a focus area + duration (minutes) + optional equipment. */
  suggestWorkout(body: SuggestWorkoutRequest): Observable<SuggestWorkoutResponse> {
    return this.http.post<SuggestWorkoutResponse>(`${this.base}/ai/suggest-workout`, body);
  }

  /**
   * Parse a free-text meal OR a meal PHOTO into individual, editable food items (PARSE-ONLY — writes
   * nothing). Always 200: AI off/unconfigured/unparseable/error → `{ aiUsed:false, items:[] }` so the
   * dialog falls back to manual entry. The image path is additionally ai.vision-gated server-side (403
   * without it; 400 on a bad/oversized image). Each returned item maps straight to {@link AddFoodRequest}.
   */
  parseMeal(body: ParseMealRequest): Observable<ParseMealResultDto> {
    return this.http.post<ParseMealResultDto>(`${this.base}/ai/parse-meal`, body);
  }

  /** MULTIMODAL: identify foods + macros from a meal photo. `imageBase64` is raw base64 (no `data:` prefix). */
  photoMeal(body: ImageRequest): Observable<ParseMealResponse> {
    return this.http.post<ParseMealResponse>(`${this.base}/ai/photo-meal`, body);
  }

  /** MULTIMODAL: read a nutrition label from a photo. `imageBase64` is raw base64 (no `data:` prefix). */
  readLabel(body: ImageRequest): Observable<ReadLabelResponse> {
    return this.http.post<ReadLabelResponse>(`${this.base}/ai/read-label`, body);
  }

  /**
   * MULTIMODAL: scan a pantry/fridge photo for the food ingredients on hand. `imageBase64` is raw base64 (no
   * `data:` prefix). ALWAYS 200: AI off/unconfigured/unreadable → `{ ingredients: [], aiUsed: false }`; a bad/
   * oversized image is the only non-200 (400). ai.vision-gated server-side; rate-limited "ai-photo".
   */
  scanPantry(body: ImageRequest): Observable<ScanPantryResponse> {
    return this.http.post<ScanPantryResponse>(`${this.base}/ai/scan-pantry`, body);
  }

  /**
   * SNAP & ROUTE: classify ONE captured photo into a domain (receipt|label|meal|pantry|schedule|note|unknown)
   * so the capture surface can route it to the matching existing reader. CHEAP classify-only call — the per-route
   * EXTRACTION is the destination endpoint's job. `imageBase64` is raw base64 (no `data:` prefix). ALWAYS 200:
   * AI off/unconfigured/unreadable/low-confidence → `{ kind:'unknown', confidence:0 }` so the surface degrades to
   * a manual route picker (never a 503). The ONLY non-200 is a bad/oversized image (400). The kind is a HINT —
   * every write re-gates downstream. ai.vision + tracker.ai gated server-side; rate-limited "ai-photo". Image never stored.
   */
  classifyPhoto(body: ImageRequest): Observable<ClassifyPhotoResponse> {
    return this.http.post<ClassifyPhotoResponse>(`${this.base}/ai/classify-photo`, body);
  }

  /**
   * SNAP & ROUTE: transcribe a whiteboard/handwritten/printed-note photo into a reviewable `{ title, body }`
   * (markdown). `imageBase64` is raw base64 (no `data:` prefix). INJECTION-GUARDED server-side (the photo's text
   * is strictly DATA). WRITES NOTHING — the caller posts the CONFIRMED note to {@link createFamilyNote}. ALWAYS 200:
   * AI off/unconfigured/unreadable → `{ aiUsed:false, title:'', body:'' }` (a blank editor); the ONLY non-200 is a
   * bad/oversized image (400). ai.vision + family.ai gated server-side; rate-limited "ai-photo". Image never stored.
   */
  photoToNote(body: ImageRequest): Observable<PhotoToNoteResponse> {
    return this.http.post<PhotoToNoteResponse>(`${this.base}/ai/photo-to-note`, body);
  }

  /**
   * "✨ What should I eat?": ask Gemini for 3-5 meal/snack OPTIONS that fit the caller's REMAINING macros
   * today. Reads the caller's OWN context server-side (today's logged foods + goal, recent foods, on-hand
   * groceries, planned meals) — NO identity is sent. Pass an empty body on open; `craving`/`constraints`
   * refine ("high protein", "quick", a craving) and `meal` is the slot hint. Each option carries its own
   * macros so it's addable to the tracker in one call. AI-off returns 200 with `aiUsed:false` and a friendly
   * deterministic list from planned meals/grocery (never a 503). Gated tracker.ai; rate-limited "ai".
   */
  whatToEat(body: WhatToEatRequest = {}): Observable<WhatToEatResult> {
    return this.http.post<WhatToEatResult>(`${this.base}/ai/what-to-eat`, {
      craving: body.craving ?? null,
      constraints: body.constraints ?? null,
      meal: body.meal ?? null,
    });
  }

  /**
   * "✨ Plan my day / week": ask Gemini for a macro-aware multi-day meal plan that fits the caller's REMAINING
   * budget. Reads the caller's OWN context server-side (remaining macros, recent foods, saved recipes, on-hand
   * groceries, already-planned meals) — NO identity is sent. `days` is clamped 1..7; `slots` defaults to
   * breakfast/lunch/dinner. Each option carries its own macros + a FULL ingredient list labelled onList/listedQty
   * against the grocery list. ALWAYS 200: AI-off returns `aiUsed:false` with a deterministic fallback plan (never
   * a 503). WRITES NOTHING — committing is the separate `planMealsToPlan` call. Gated tracker.ai; rate-limited "ai".
   */
  planMeals(body: PlanMealsRequest = {}): Observable<PlanMealsResult> {
    return this.http.post<PlanMealsResult>(`${this.base}/ai/plan-meals`, {
      days: body.days ?? null,
      slots: body.slots ?? null,
      constraints: body.constraints ?? null,
      weekStart: body.weekStart ?? null,
      ingredientsOnHand: body.ingredientsOnHand ?? null,
    });
  }

  /**
   * Commit the reviewed AI plan: write the chosen `meals` into the household meal plan (the SAME create path as
   * POST /api/family/meals — clamped, household-scoped). The AI wrote nothing; the user confirmed first. ADDITIONALLY
   * gated by meals.use (checked in-handler since the route group is /ai). Returns how many meals were created.
   */
  planMealsToPlan(meals: PlanMealToWrite[]): Observable<PlanMealsToPlanResult> {
    return this.http.post<PlanMealsToPlanResult>(`${this.base}/ai/plan-meals/to-plan`, { meals });
  }

  /**
   * "Refine with AI": rewrite ONE planned meal to honour a free-text `preference` (e.g. "make it vegetarian",
   * "lower the carbs"). The current meal travels in the body; `calories` is the dish TOTAL and `proteinG`/`carbG`/
   * `fatG` are PER-SERVING (matching FamilyMeal.perServing). ALWAYS 200 — AI off/unavailable echoes the original
   * with `aiUsed:false`. WRITES NOTHING; the caller persists the accepted rewrite via patchFamilyMeal. Gated
   * tracker.ai; rate-limited "ai".
   */
  refineMeal(body: RefineMealRequest): Observable<RefineMealResponse> {
    return this.http.post<RefineMealResponse>(`${this.base}/ai/refine-meal`, body);
  }

  /**
   * "Ask my life": a grounded, cross-domain Q&A over the CALLER's OWN tracked data. Sends ONLY the free-text
   * `question` (treated as DATA) — NO identity. The server assembles a perm-filtered, caller-scoped snapshot
   * (tracker/sleep/75-Hard/bills/family/usage — only the domains the caller has permission for) and Gemini
   * answers strictly from it. ALWAYS 200: when AI is off/unavailable it floors to a deterministic plain
   * summary (`aiUsed:false`) naming the domains it has data for — never a 503. Gated tracker.ai; rate-limited
   * "ai". A 400 is only returned for an empty question (guarded client-side).
   */
  askMyLife(question: string): Observable<AskResponse> {
    return this.http.post<AskResponse>(`${this.base}/ai/ask`, { question } as AskRequest);
  }

  /**
   * "ASK THAT ACTS" (POST /api/ai/ask-act): a SUPERSET of {@link askMyLife}. The server assembles the SAME
   * perm-filtered, caller-scoped snapshot, answers from it, AND proposes 0..N confirm-chip `actions` the user
   * approves per-chip (each carrying a SERVER-issued endpoint + clamped params). Gated tracker.ai + ai.act;
   * rate-limited "ai". ALWAYS 200: AI off / ai.act off / unconfigured / parse-fail floors to the deterministic
   * plain answer with `actions: []` — exactly today's answer-only Ask. Nothing is written here; a write only
   * happens when the user confirms a chip, via {@link executeAskAction} (calendar_event/goal_tweak first open
   * a prefilled review dialog in the page). A 400 is only returned for an empty question (guarded client-side).
   */
  askAndAct(question: string): Observable<ActAskResponse> {
    return this.http.post<ActAskResponse>(`${this.base}/ai/ask-act`, { question } as ActAskRequest);
  }

  /**
   * The FROZEN allow-list of "Ask that Acts" action types → the EXISTING write each maps to (mirrors the
   * backend's `AskActEndpointFor`). {@link executeAskAction} re-validates `action.type` against this BEFORE
   * invoking the matching Api.* write — so a tampered/unknown type is rejected client-side and we never aim a
   * write at an arbitrary path (the write still re-gates server-side). `calendar_event` and `goal_tweak` are
   * marked `dialog: true`: they must NOT be silently executed here — the page opens a PREFILLED review dialog
   * and only then calls the underlying write ({@link createEvent} / {@link saveTrackerProfile}) on confirm.
   */
  static readonly ASK_ACTION_ENDPOINTS: Readonly<Record<AskActAction['type'], { endpoint: string; dialog: boolean }>> = {
    calendar_event: { endpoint: '/api/family/events', dialog: true },
    grocery_add:    { endpoint: '/api/grocery/items', dialog: false },
    meal:           { endpoint: '/api/family/meals', dialog: false },
    goal_tweak:     { endpoint: '/api/tracker/profile', dialog: true },
    tracker_log:    { endpoint: '/api/tracker', dialog: false },
    reminder:       { endpoint: '/api/family/quick-add', dialog: false },
    timer:          { endpoint: '/api/family/timers', dialog: false },
    note:           { endpoint: '/api/family/quick-add', dialog: false },
  };

  /** The closed tracker_log sub-kinds → their concrete /api/tracker/{kind} write (server-validated; re-checked here). */
  private static readonly ASK_TRACKER_KINDS = new Set<AskActTrackerKind>([
    'food', 'exercise', 'hydration', 'coffee', 'weight', 'supplement', 'sleep',
  ]);

  /**
   * Execute ONE confirmed "Ask that Acts" action via the matching EXISTING owner/household-scoped write. The
   * action's `type` is re-validated against the frozen {@link ASK_ACTION_ENDPOINTS} allow-list FIRST (mirrors
   * {@link postVoiceIntent}) so an unknown/tampered type is rejected with NO request sent. The `dialog` types
   * (calendar_event, goal_tweak) are NOT executed here — they require the page's prefilled review dialog, so
   * calling this for them rejects (the page calls {@link createEvent}/{@link saveTrackerProfile} on confirm).
   * Every body is built ONLY from the action's clamped `params` (the underlying write re-clamps + re-gates).
   */
  executeAskAction(action: AskActAction): Observable<unknown> {
    const allow = Api.ASK_ACTION_ENDPOINTS[action.type];
    if (!allow) return throwError(() => new Error('Unsupported action.'));
    if (allow.dialog) {
      return throwError(() => new Error('This action needs a review dialog (handle it in the page).'));
    }
    const p = action.params ?? {};
    switch (action.type) {
      case 'grocery_add': {
        const items = Api.asStringList(p['items']);
        if (items.length === 0) return throwError(() => new Error('Nothing to add.'));
        // The Groceries endpoint adds one item per call (find-or-create + de-dupe); chain them.
        return from(items).pipe(
          concatMap(text => this.groceryAddItem(text)),
          last(),
        );
      }
      case 'meal': {
        const title = Api.asStr(p['title']);
        if (!title) return throwError(() => new Error('No meal title.'));
        const date = Api.localDateOf(Api.asStr(p['mealDateLocal'])) || Api.todayLocalDate();
        const ingredients = Api.asStr(p['ingredients']);
        return this.createFamilyMeal({
          localDate: date, slot: 'dinner', title,
          ingredients: ingredients || undefined,
        });
      }
      case 'tracker_log':
        return this.execTrackerLog(p);
      case 'reminder': {
        const text = Api.asStr(p['text']);
        if (!text) return throwError(() => new Error('No reminder text.'));
        // quick-add files it as the right item; the time phrase rides inside the text when present.
        const when = Api.asStr(p['whenLocal']);
        return this.quickAdd(when ? `${text} ${when}` : text, 'reminder');
      }
      case 'timer': {
        const seconds = Math.max(5, Math.min(86400, Math.round(Api.asNum(p['durationSeconds']) || 0)));
        if (seconds < 5) return throwError(() => new Error('Invalid timer.'));
        return this.createFamilyTimer({ label: Api.asStr(p['label']) || 'Timer', durationSeconds: seconds });
      }
      case 'note': {
        const text = Api.asStr(p['text']);
        if (!text) return throwError(() => new Error('No note text.'));
        return this.quickAdd(text, 'note');
      }
      default:
        return throwError(() => new Error('Unsupported action.'));
    }
  }

  /** tracker_log → the right /api/tracker/{kind} write. `kind` is re-validated against the frozen set first. */
  private execTrackerLog(p: Record<string, unknown>): Observable<unknown> {
    const kind = Api.asStr(p['kind']).toLowerCase() as AskActTrackerKind;
    if (!Api.ASK_TRACKER_KINDS.has(kind)) return throwError(() => new Error('Unsupported log type.'));
    const description = Api.asStr(p['description']);
    if (!description) return throwError(() => new Error('Nothing to log.'));
    const date = Api.localDateOf(Api.asStr(p['dateLocal'])) || Api.todayLocalDate();
    switch (kind) {
      case 'food':
        // A MANUAL food log: a description with zeroed macros (no provider/fdcId → auto-saved to "My foods").
        return this.addFood({
          date, meal: 'snack', description, quantity: 1,
          calories: 0, proteinG: 0, carbG: 0, fatG: 0,
        });
      case 'exercise':
        return this.addExercise({ date, name: description });
      case 'supplement':
        return this.addSupplement({ date, name: description });
      case 'coffee':
        // One cup with the free-text as its label (server clamps cups 1..20).
        return this.addCoffee({ date, cups: 1, label: description.slice(0, 64) });
      case 'hydration':
        // A default glass (250 ml) labelled by the description (server clamps 1..5000 ml).
        return this.addHydration({ date, amountMl: 250, label: description.slice(0, 64) });
      case 'weight': {
        const kg = Api.firstNumberIn(description);
        if (kg == null) return throwError(() => new Error('No weight value found.'));
        return this.logWeight({ date, weightKg: Math.max(1, Math.min(1000, kg)) });
      }
      case 'sleep': {
        const hours = Api.firstNumberIn(description);
        if (hours == null) return throwError(() => new Error('No sleep hours found.'));
        return this.addSleep({ date, hours: Math.max(0, Math.min(24, hours)), note: description });
      }
    }
  }

  // ---- "Ask that Acts" param coercion helpers (the params come off the wire as unknown) ----

  /** Coerce an unknown param to a trimmed string ("" when null/undefined/non-stringable). */
  private static asStr(v: unknown): string {
    return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
  }

  /** Coerce an unknown param to a finite number (0 when not numeric). */
  private static asNum(v: unknown): number {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  /** Coerce an unknown param to a de-duped, non-empty string[] (caps at 30 to mirror the server). */
  private static asStringList(v: unknown): string[] {
    if (!Array.isArray(v)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of v) {
      const s = Api.asStr(raw);
      const key = s.toLowerCase();
      if (s && !seen.has(key)) { seen.add(key); out.push(s); if (out.length >= 30) break; }
    }
    return out;
  }

  /** A bare local date ("yyyy-MM-dd") from an offset-less local ISO string (date or datetime), or "" if unparseable. */
  private static localDateOf(local: string): string {
    const s = (local || '').trim();
    if (s.length < 8) return '';
    return s.slice(0, 10);
  }

  /** Today's local "yyyy-MM-dd" (browser zone). */
  private static todayLocalDate(): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  /** The first number embedded in a free-text string (e.g. "82.5 kg" → 82.5), or null when none. */
  private static firstNumberIn(text: string): number | null {
    const m = (text || '').match(/-?\d+(?:\.\d+)?/);
    if (!m) return null;
    const n = Number(m[0]);
    return Number.isFinite(n) ? n : null;
  }

  /** Quick verdict + healthier swaps on a free-text meal. */
  mealFeedback(body: MealFeedbackRequest): Observable<MealFeedbackResponse> {
    return this.http.post<MealFeedbackResponse>(`${this.base}/ai/meal-feedback`, body);
  }

  /** Per-serving macros for a free-text recipe (+ optional number of servings). */
  recipeMacros(body: RecipeMacrosRequest): Observable<RecipeMacrosResponse> {
    return this.http.post<RecipeMacrosResponse>(`${this.base}/ai/recipe-macros`, body);
  }

  /** Daily coaching from the CALLER's own day so far (GET; cached ~6h server-side). */
  dailyCoach(): Observable<DailyCoachResponse> {
    return this.http.get<DailyCoachResponse>(`${this.base}/ai/daily-coach`);
  }

  /** Weekly review of the CALLER's own last 7 days (GET; cached ~6h server-side). */
  weeklyReview(): Observable<WeeklyReviewResponse> {
    return this.http.get<WeeklyReviewResponse>(`${this.base}/ai/weekly-review`);
  }

  /** Weight insight from the CALLER's own weight stats (GET; cached ~6h server-side). */
  weightInsight(): Observable<WeightInsightResponse> {
    return this.http.get<WeightInsightResponse>(`${this.base}/ai/weight-insight`);
  }

  /** Sleep & recovery insight from the CALLER's own sleep/caffeine/training snapshot (GET; cached ~6h server-side). */
  sleepInsight(): Observable<SleepInsightResponse> {
    return this.http.get<SleepInsightResponse>(`${this.base}/ai/sleep-insight`);
  }

  /** Suggest a daily hydration target from the CALLER's own profile (read server-side; empty body). */
  hydrationSuggest(): Observable<HydrationSuggestResponse> {
    return this.http.post<HydrationSuggestResponse>(`${this.base}/ai/hydration-suggest`, {});
  }

  /** Parse free-text drinks ("2 coffees and a big water") into discrete amounts. */
  parseHydration(body: ParseHydrationRequest): Observable<ParseHydrationResponse> {
    return this.http.post<ParseHydrationResponse>(`${this.base}/ai/parse-hydration`, body);
  }

  /** Turn a free-text goal ("lose 10 lbs in 3 months") into a structured plan. */
  naturalGoal(body: NaturalGoalRequest): Observable<NaturalGoalResponse> {
    return this.http.post<NaturalGoalResponse>(`${this.base}/ai/natural-goal`, body);
  }

  /**
   * AI Day Builder: reconstruct a COMPLETE day (meals+foods, exercises, hydration, weight, activity) from a
   * free-text brain-dump (+ optional meal photos) into a reviewable, fully-clamped draft. Multi-turn: pass
   * `priorDraft` + `answers` to refine. NOTHING is logged — the whole-day write happens via {@link bulkCommitDay}.
   */
  buildDay(body: BuildDayRequest): Observable<BuildDayResponse> {
    return this.http.post<BuildDayResponse>(`${this.base}/ai/build-day`, body);
  }

  /** AI end-of-day recap of the CALLER's own LOGGED day (read server-side; cached ~6h). Body carries only a date. */
  daySummary(body: DaySummaryRequest): Observable<DaySummaryResponse> {
    return this.http.post<DaySummaryResponse>(`${this.base}/ai/day-summary`, body);
  }

  /**
   * PARSE-ONLY voice capture (POST /api/ai/voice-parse). Sends a spoken note as an on-device STT
   * `transcript` (preferred — audio never leaves the device) OR an inline `audioBase64` + `mimeType` clip
   * (the ai.vision-gated fallback). The server parses intent ONLY — it WRITES NOTHING — and returns
   * confirmable {@link VoiceIntentDto}s, each carrying the exact payload for an EXISTING owner-scoped write
   * endpoint the caller posts on confirm (see {@link postVoiceIntent}). ALWAYS 200: AI off/unconfigured/error
   * floors to `{ aiUsed:false, intents:[], message }` so the mic never 500s. The transcript/audio is
   * processed in-memory and is never persisted; nothing identifying is echoed back.
   */
  voiceParse(body: VoiceParseRequest): Observable<VoiceParseResponse> {
    return this.http.post<VoiceParseResponse>(`${this.base}/ai/voice-parse`, body);
  }

  /**
   * Log ONE confirmed voice intent by posting its server-issued, fully-clamped `payload` to its
   * server-issued `endpoint` (one of the EXISTING owner-scoped tracker/family write routes). The endpoint
   * is validated against the known voice-intent route allow-list FIRST, so a tampered/unknown path is
   * rejected client-side and we never aim a write at an arbitrary URL — the actual write still rides that
   * endpoint's own permission gate (tracker.self / family.use) + clamps server-side. No new write path is
   * introduced. Rejects (no request sent) when the endpoint isn't an allowed voice-write route.
   */
  postVoiceIntent(endpoint: string, payload: Record<string, unknown>): Observable<unknown> {
    if (!Api.VOICE_INTENT_ENDPOINTS.has(endpoint)) {
      return throwError(() => new Error('Unsupported voice action.'));
    }
    return this.http.post(`${this.base}${endpoint}`, payload);
  }

  /**
   * The closed allow-list of EXISTING owner-scoped write routes a voice intent may post to (mirrors the
   * backend's `VoiceEndpointFor` map). Used by {@link postVoiceIntent} so voice can only ever drive these
   * already-gated endpoints — never an arbitrary path.
   */
  private static readonly VOICE_INTENT_ENDPOINTS = new Set<string>([
    '/api/tracker/food',
    '/api/tracker/exercise',
    '/api/tracker/hydration',
    '/api/tracker/coffee',
    '/api/tracker/weight',
    '/api/tracker/supplement',
    '/api/tracker/sleep',
    '/api/family/quick-add',
  ]);

  /**
   * "✨ This week" recap: a warm, encouraging read-only narration (+ 0–4 gentle coaching insight bullets) of
   * the CALLER's OWN last 7 local days, aggregated server-side from their food/exercise/activity/hydration/
   * weight (the model invents nothing). Gated by tracker.self alone (NOT tracker.ai) and NEVER 503 — when AI
   * is unavailable/unconfigured the GUARANTEED deterministic plain floor comes back with `fellBackToPlain` =
   * true (same handling as the morning briefing). Read-only — nothing is mutated.
   */
  trackerRecapAi(): Observable<TrackerRecapResult> {
    return this.http.get<TrackerRecapResult>(`${this.base}/ai/tracker-recap`);
  }

  /**
   * Atomically + idempotently log the user-EDITED day draft (POST /api/tracker/day/commit; OWN tracker only,
   * no Gemini). Send the server-issued `buildId` from {@link buildDay}; a re-submit of the same id is a no-op
   * that returns `alreadyCommitted`. Returns the per-kind counts + the rebuilt authoritative day.
   */
  bulkCommitDay(body: CommitDayRequest): Observable<CommitDayResponse> {
    return this.http.post<CommitDayResponse>(`${this.base}/tracker/day/commit`, body);
  }

  /**
   * Move the caller's OWN entries from one local date to another, by category (POST /api/tracker/day/move;
   * OWN tracker only). Re-dates food/exercise/hydration in place; for the one-per-day weight/activity the
   * moved entry replaces any conflicting entry already on `toDate`. Returns the per-domain counts moved +
   * what was replaced; the page reloads the day afterward (totals are server-computed on read).
   */
  moveDay(body: MoveDayRequest): Observable<MoveDayResult> {
    return this.http.post<MoveDayResult>(`${this.base}/tracker/day/move`, body);
  }

  /** Log a drink toward the day's hydration goal (OWN tracker only; amountMl 1..5000). Returns the created entry. */
  addHydration(body: AddHydrationRequest): Observable<HydrationEntryDto> {
    return this.http.post<HydrationEntryDto>(`${this.base}/tracker/hydration`, body);
  }

  /** Delete a logged hydration entry (owner-only; 404 otherwise). */
  deleteHydration(id: number): Observable<unknown> {
    return this.http.delete(`${this.base}/tracker/hydration/${id}`);
  }

  /** Log coffee toward the day's coffee cap (OWN tracker only; cups 1..20). Returns the created entry. */
  addCoffee(body: AddCoffeeRequest): Observable<CoffeeEntryDto> {
    return this.http.post<CoffeeEntryDto>(`${this.base}/tracker/coffee`, body);
  }

  /** Delete a logged coffee entry (owner-only; 404 otherwise). */
  deleteCoffee(id: number): Observable<unknown> {
    return this.http.delete(`${this.base}/tracker/coffee/${id}`);
  }

  /** Log a supplement onto the day (OWN tracker only; macros default to 0). Returns the created entry. */
  addSupplement(body: AddSupplementRequest): Observable<SupplementEntryDto> {
    return this.http.post<SupplementEntryDto>(`${this.base}/tracker/supplement`, body);
  }

  /** Delete a logged supplement entry (owner-only; 404 otherwise). */
  deleteSupplement(id: number): Observable<unknown> {
    return this.http.delete(`${this.base}/tracker/supplement/${id}`);
  }

  /** Log a night of sleep onto the day's WAKE date (OWN tracker only; owner-only data). Returns the created entry. */
  addSleep(body: AddSleepRequest): Observable<SleepEntryDto> {
    return this.http.post<SleepEntryDto>(`${this.base}/tracker/sleep`, body);
  }

  /** Delete a logged sleep entry (owner-only; 404 otherwise). */
  deleteSleep(id: number): Observable<unknown> {
    return this.http.delete(`${this.base}/tracker/sleep/${id}`);
  }

  /**
   * Upsert (replace) the caller's manually-recorded smartwatch stats for a date — one row per day (OWN
   * tracker only). `distanceMeters` is always metric metres. Returns the saved watch stats; the page
   * reloads the day so the calorie ring / burned figure reflects the resolved burn.
   */
  upsertActivity(body: UpsertActivityRequest): Observable<WatchActivityDto> {
    return this.http.put<WatchActivityDto>(`${this.base}/tracker/activity`, body);
  }

  /** Clear the caller's watch stats for a date (owner-only; 204, no-op when no row). */
  clearActivity(date: string): Observable<unknown> {
    return this.http.delete(`${this.base}/tracker/activity`, { params: new HttpParams().set('date', date) });
  }

  // ---- Family Hub (foundation) — every call gated by family.use server-side ----

  /**
   * The caller's household with its members (auto-provisioned on first read with the caller as OWNER, so
   * the hub is never empty). Members carry display identity only (userId + name + picture + role); never
   * an email. There is no way to address anyone else's household — the server resolves the caller's own.
   */
  getHousehold(): Observable<Household> {
    return this.http.get<Household>(`${this.base}/family/household`);
  }

  /** Rename the household (OWNER only; non-owners get 403). Returns the updated household. */
  renameHousehold(name: string): Observable<Household> {
    return this.http.patch<Household>(`${this.base}/family/household`, { name });
  }

  /**
   * People the owner may add to the household — the caller's circle / family-capable users not yet in a
   * household, by userId + display name (never an email). Drives the member people-picker.
   */
  householdCandidates(): Observable<HouseholdCandidate[]> {
    return this.http.get<HouseholdCandidate[]>(`${this.base}/family/household/candidates`);
  }

  /** Add a member to the household by AppUser id (OWNER only). Returns the updated household. */
  addMember(userId: number): Observable<Household> {
    return this.http.post<Household>(`${this.base}/family/household/members`, { userId });
  }

  /** Remove a member from the household by AppUser id (OWNER only; the owner can't be removed). Returns the updated household. */
  removeMember(userId: number): Observable<Household> {
    return this.http.delete<Household>(`${this.base}/family/household/members/${userId}`);
  }

  /**
   * Family-finder: the latest PRECISE pin for opted-in members of the caller's own household
   * (GET /api/family/locations, gated family.use). The caller always sees their own pin; other members
   * appear only when they've opted into household sharing AND have a recent fix. Identity is userId +
   * display name only — never an email. Empty array when nobody has shared yet.
   */
  familyLocations(): Observable<FamilyMemberLocation[]> {
    return this.http.get<FamilyMemberLocation[]>(`${this.base}/family/locations`);
  }

  // ---- Family Hub F7: Quick-Add (one-line capture → list item / reminder / note) ----

  /**
   * Capture a single line and let the household file it as the right item. `kind` defaults to `auto` (the
   * server routes by the leading keyword / time phrase); pass `listName` only when forcing a list. Returns
   * the resolved kind, the new item's id, and a warm one-line summary for a toast.
   */
  quickAdd(text: string, kind: QuickAddKind = 'auto', listName?: string): Observable<QuickAddResult> {
    const body: QuickAddRequest = { text, kind };
    if (listName && listName.trim()) body.listName = listName.trim();
    return this.http.post<QuickAddResult>(`${this.base}/family/quick-add`, body);
  }

  // ---- Family Hub F1: shared notes (markdown body; pin; share to contacts) ----

  /** Notes the caller can see: their household's notes + notes shared directly with them (pinned first, then most-recently-updated). */
  familyNotes(): Observable<FamilyNote[]> {
    return this.http.get<FamilyNote[]>(`${this.base}/family/notes`);
  }

  /** Create a note in the caller's household. Returns the created note. */
  createFamilyNote(req: { title?: string; body?: string; pinned: boolean }): Observable<FamilyNote> {
    return this.http.post<FamilyNote>(`${this.base}/family/notes`, req);
  }

  /** Edit a note (household member or a canEdit-share). Returns the updated note. */
  updateFamilyNote(id: number, req: { title?: string; body?: string; pinned: boolean }): Observable<FamilyNote> {
    return this.http.put<FamilyNote>(`${this.base}/family/notes/${id}`, req);
  }

  /** Delete a note (creator or any household member). */
  deleteFamilyNote(id: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/family/notes/${id}`);
  }

  /** Share a note with a contact by AppUser id (manage: creator or member). Returns the updated note. */
  shareFamilyNote(id: number, userId: number, canEdit: boolean): Observable<FamilyNote> {
    return this.http.post<FamilyNote>(`${this.base}/family/notes/${id}/share`, { userId, canEdit });
  }

  /** Remove a note's share for the given AppUser id (manage). Returns the updated note. */
  unshareFamilyNote(id: number, userId: number): Observable<FamilyNote> {
    return this.http.delete<FamilyNote>(`${this.base}/family/notes/${id}/share/${userId}`);
  }

  /**
   * "✨ Draft with AI" / "✨ Rewrite": send a `prompt` for Gemini to DRAFT a fresh note, or — when
   * `currentBody` is supplied — REWRITE/clean that body per the prompt. Saves NOTHING; the editor previews
   * the returned title+body with Use / Try-again, and only the user's Save persists it. Degrades gracefully:
   * a 503 when AI is unavailable / not configured, a 400 for an empty prompt.
   */
  draftFamilyNoteAi(prompt: string, currentTitle?: string, currentBody?: string): Observable<NoteDraftAiResult> {
    return this.http.post<NoteDraftAiResult>(`${this.base}/family/notes/ai/draft`,
      { prompt, currentTitle: currentTitle ?? null, currentBody: currentBody ?? null });
  }

  /**
   * "✨ Summarize": summarise a saved note into a short summary + 0+ action items (each with an optional
   * natural-time `duePhrase`). Read-only — creates NOTHING; the user then chooses "Add to a list" or "Make
   * reminders". 404 if the caller can't view the note; degrades to a 503 when AI is unavailable.
   */
  summarizeFamilyNoteAi(id: number): Observable<NoteSummaryAiResult> {
    return this.http.post<NoteSummaryAiResult>(`${this.base}/family/notes/${id}/ai/summarize`, {});
  }

  /**
   * "✨ Ask your notes": answer a free-text `question` STRICTLY from the caller's household notes (the server
   * reads them — nothing is trusted from the client) and returns a plain-text answer + the `usedNoteIds` the
   * model drew on (so the UI can link back). Read-only — creates NOTHING. 400 for an empty question; degrades
   * to a 503 when AI is unavailable / not configured.
   */
  askFamilyNotesAi(question: string): Observable<AskNotesAiResult> {
    return this.http.post<AskNotesAiResult>(`${this.base}/family/notes/ai/ask`, { question });
  }

  /**
   * "✨ Transform": apply an in-editor `action` ("continue" | "checklist" | "shorten" | "translate") to the
   * editor `body` (`lang` is used by "translate"). Operates on editor content only — touches NO stored note
   * and saves NOTHING; the editor previews the returned markdown body with Use / Try-again. 400 for an empty
   * body or an unknown action; degrades to a 503 when AI is unavailable / not configured.
   */
  transformFamilyNoteAi(body: string, action: NoteTransformAction, lang?: string): Observable<NoteTransformAiResult> {
    return this.http.post<NoteTransformAiResult>(`${this.base}/family/notes/ai/transform`,
      { body, action, lang: lang ?? null });
  }

  // ---- Family Hub F1: shared lists (shopping / to-do; checkable items; assignees; share) ----

  /** Lists the caller can see (household + shared-with-me), each with its items (most-recently-updated first). */
  familyLists(): Observable<FamilyList[]> {
    return this.http.get<FamilyList[]>(`${this.base}/family/lists`);
  }

  /** Create a list of the given kind in the caller's household. Returns the created list. */
  createFamilyList(name: string, kind: FamilyListKind): Observable<FamilyList> {
    return this.http.post<FamilyList>(`${this.base}/family/lists`, { name, kind });
  }

  /** Rename a list (edit access). Returns the updated list. */
  renameFamilyList(id: number, name: string): Observable<FamilyList> {
    return this.http.put<FamilyList>(`${this.base}/family/lists/${id}`, { name });
  }

  /** Set (or clear, with null) a shopping list's user-entered total spent. Edit access. Returns the updated list. */
  setFamilyListCost(id: number, totalCost: number | null): Observable<FamilyList> {
    return this.http.put<FamilyList>(`${this.base}/family/lists/${id}/cost`, { totalCost });
  }

  /** Archive (complete) or unarchive a list — both kinds. Edit access. Returns the updated list. */
  archiveFamilyList(id: number, archived: boolean): Observable<FamilyList> {
    return this.http.put<FamilyList>(`${this.base}/family/lists/${id}/archive`, { archived });
  }

  /** Lists including archived (for a "show completed" toggle). Defaults to active-only without the flag. */
  familyListsAll(includeArchived = true): Observable<FamilyList[]> {
    return this.http.get<FamilyList[]>(`${this.base}/family/lists`, { params: { includeArchived } });
  }

  /** Delete a list (creator or any household member); its items cascade. */
  deleteFamilyList(id: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/family/lists/${id}`);
  }

  /** Add an item to a list (edit access); optionally assigned to a household member / shared person by AppUser id. Returns the updated list. */
  addFamilyListItem(listId: number, text: string, assignedToUserId?: number | null): Observable<FamilyList> {
    return this.http.post<FamilyList>(`${this.base}/family/lists/${listId}/items`,
      { text, assignedToUserId: assignedToUserId ?? null });
  }

  /**
   * Patch a list item (edit access): toggle `done` (stamps/clears who checked it), rename `text`, or set
   * `assignedToUserId`. Omitted fields are unchanged. Returns the updated list.
   */
  patchFamilyListItem(
    listId: number, itemId: number,
    req: { text?: string; done?: boolean; assignedToUserId?: number }): Observable<FamilyList> {
    return this.http.patch<FamilyList>(`${this.base}/family/lists/${listId}/items/${itemId}`, req);
  }

  /** Delete a list item (edit access). Returns the updated list. */
  deleteFamilyListItem(listId: number, itemId: number): Observable<FamilyList> {
    return this.http.delete<FamilyList>(`${this.base}/family/lists/${listId}/items/${itemId}`);
  }

  /** Share a list with a contact by AppUser id (manage). Returns the updated list. */
  shareFamilyList(id: number, userId: number, canEdit: boolean): Observable<FamilyList> {
    return this.http.post<FamilyList>(`${this.base}/family/lists/${id}/share`, { userId, canEdit });
  }

  /** Remove a list's share for the given AppUser id (manage). Returns the updated list. */
  unshareFamilyList(id: number, userId: number): Observable<FamilyList> {
    return this.http.delete<FamilyList>(`${this.base}/family/lists/${id}/share/${userId}`);
  }

  /**
   * "✨ Add several": send a free-text blob ("milk, eggs, bread" or a pasted recipe) for Gemini to parse into
   * a clean, de-duped, capped list of item NAMES the user reviews — this creates NOTHING. Each confirmed item
   * is added via the existing {@link addFamilyListItem}. `kind` ("shopping"|"todo") only nudges the parse.
   * Degrades gracefully: a 503 when AI is unavailable / not configured, a 400 for empty text — the caller
   * falls back to manual add.
   */
  parseListItemsAi(text: string, kind?: FamilyListKind): Observable<ListItemsAiResult> {
    return this.http.post<ListItemsAiResult>(`${this.base}/family/lists/ai/parse-items`,
      { text, kind: kind ?? null });
  }

  /**
   * "✨ What am I missing?": given a list's current items (read server-side) + a free-text `goal` ("a kids
   * birthday party"), propose ADDITIONAL item names not already on the list. Creates NOTHING — the user
   * confirms the proposed chips, then each is added via the existing {@link addFamilyListItem}. 404 if the
   * caller can't view the list; 400 for an empty goal; degrades to a 503 when AI is unavailable.
   */
  suggestListItemsAi(listId: number, goal: string): Observable<ListSuggestAiResult> {
    return this.http.post<ListSuggestAiResult>(`${this.base}/family/lists/${listId}/ai/suggest`, { goal });
  }

  // ---- Family Hub F2: reminders (due-time nudges; recurrence; target a member) ----

  /** The household's reminders (active first, then by due time). When one fires it lands in the bell. */
  familyReminders(): Observable<FamilyReminder[]> {
    return this.http.get<FamilyReminder[]>(`${this.base}/family/reminders`);
  }

  /**
   * Create a reminder in the caller's household. `dueUtc` is an ISO UTC instant (convert from local on the
   * client). `targetUserId` must be a household member (defaults to the caller). Returns the created reminder.
   */
  createFamilyReminder(req: {
    text: string; dueUtc: string; recurrence: FamilyRecurrence; targetUserId?: number | null;
  }): Observable<FamilyReminder> {
    return this.http.post<FamilyReminder>(`${this.base}/family/reminders`, req);
  }

  /** Edit a reminder (any household member). Omitted fields are unchanged. Returns the updated reminder. */
  updateFamilyReminder(id: number, req: {
    text?: string; dueUtc?: string; recurrence?: FamilyRecurrence; targetUserId?: number;
  }): Observable<FamilyReminder> {
    return this.http.put<FamilyReminder>(`${this.base}/family/reminders/${id}`, req);
  }

  /** Snooze a reminder by N minutes from now (re-activates a fired one-shot). Returns the updated reminder. */
  snoozeFamilyReminder(id: number, minutes: number): Observable<FamilyReminder> {
    return this.http.post<FamilyReminder>(`${this.base}/family/reminders/${id}/snooze`, { minutes });
  }

  /** Delete a reminder (any household member). */
  deleteFamilyReminder(id: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/family/reminders/${id}`);
  }

  /**
   * "Add reminder with AI": send free text ("call the dentist next Tuesday at 3, every month") for Gemini to
   * parse into 0+ PROPOSED reminders (with recurrence) the user then confirms — this creates NOTHING. Each
   * confirmed proposal is created via the existing {@link createFamilyReminder}. `referenceDateUtc` defaults
   * to now (the server anchors relative dates in the household timezone). Degrades gracefully: a 503 when AI
   * is unavailable / not configured, a 400 for empty text — the caller surfaces a friendly message.
   */
  parseReminderAi(text: string, referenceDateUtc?: string): Observable<ReminderAiResult> {
    return this.http.post<ReminderAiResult>(`${this.base}/family/reminders/ai/parse`,
      { text, referenceDateUtc: referenceDateUtc ?? null });
  }

  // ---- Family Hub F2: shared timers (live countdowns the whole household sees) ----

  /** The household's timers (active soonest-ending first, then recently-finished). */
  familyTimers(): Observable<FamilyTimer[]> {
    return this.http.get<FamilyTimer[]>(`${this.base}/family/timers`);
  }

  /** Start a shared countdown of `durationSeconds`, with an optional label. Returns the created timer. */
  createFamilyTimer(req: { label?: string; durationSeconds: number }): Observable<FamilyTimer> {
    return this.http.post<FamilyTimer>(`${this.base}/family/timers`, req);
  }

  /** Cancel a timer (any household member). */
  deleteFamilyTimer(id: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/family/timers/${id}`);
  }

  /**
   * "✨ Quick timer": parse natural-language `text` ("20 min pasta") into a proposed { label, durationSeconds }
   * (the duration is clamped to 5..86400 server-side). Creates NOTHING — the user confirms the chip, then it's
   * started via the existing {@link createFamilyTimer}. 400 for empty text; degrades to a 503 when AI is down.
   */
  parseTimerAi(text: string): Observable<TimerAiResult> {
    return this.http.post<TimerAiResult>(`${this.base}/family/timers/ai/parse`, { text });
  }

  // ---- Family Hub F3: Today snapshot & settings ----

  /**
   * The household's "Today" snapshot: greeting + local date, today's reminders, active timers, list
   * summaries (open/done + a peek), pinned notes, and an optional weather card (null when unconfigured).
   * People are by userId + display name only — never an email (email-privacy).
   */
  familyToday(): Observable<FamilyToday> {
    return this.http.get<FamilyToday>(`${this.base}/family/today`);
  }

  /**
   * The warm AI morning-briefing narrative for the top of Today. ALWAYS returns 200: when Gemini is
   * unconfigured or errors, the guaranteed deterministic briefing text is returned with `fellBackToPlain` =
   * true (never a 503/500). The numbers come from the server; the model only narrates them.
   */
  familyBriefing(): Observable<FamilyBriefing> {
    return this.http.get<FamilyBriefing>(`${this.base}/family/today/briefing`);
  }

  /** The household's Family Hub settings (every member may read; `canEdit` is true only for the owner). */
  familySettings(): Observable<FamilySettings> {
    return this.http.get<FamilySettings>(`${this.base}/family/settings`);
  }

  /** Update the household's settings (OWNER only; non-owners get 403). Omitted fields are unchanged. Returns the saved settings. */
  updateFamilySettings(body: FamilySettingsUpdate): Observable<FamilySettings> {
    return this.http.put<FamilySettings>(`${this.base}/family/settings`, body);
  }

  // ---- Family Hub F4: weekly meal planner (dishes per day; ingredients → grocery list) ----

  /**
   * The 7 local days of a week, each with its planned meals (ordered by slot). `weekStart` is a plain
   * "YYYY-MM-DD" date (the week's Monday); omit it for the current local week (server-resolved).
   */
  familyMeals(weekStart?: string): Observable<FamilyMealDay[]> {
    const params = weekStart ? new HttpParams().set('weekStart', weekStart) : undefined;
    return this.http.get<FamilyMealDay[]>(`${this.base}/family/meals`, { params });
  }

  /**
   * Add a meal to a day/slot. `localDate` is "YYYY-MM-DD"; `ingredients` is newline-separated text. The
   * optional macro fields (Slice 2: `servings` + the four dish TOTALS + `macroSource`) ride along when the
   * user entered them manually. Returns the created meal.
   */
  createFamilyMeal(req: {
    localDate: string; slot: FamilyMealSlot; title: string; ingredients?: string;
    servings?: number; calories?: number; proteinG?: number; carbG?: number; fatG?: number;
    macroSource?: FamilyMealMacroSource;
  }): Observable<FamilyMeal> {
    return this.http.post<FamilyMeal>(`${this.base}/family/meals`, req);
  }

  /** Edit a meal (any household member). Omitted fields are unchanged. Returns the updated meal. */
  updateFamilyMeal(id: number, req: {
    localDate?: string; slot?: FamilyMealSlot; title?: string; ingredients?: string;
  }): Observable<FamilyMeal> {
    return this.http.put<FamilyMeal>(`${this.base}/family/meals/${id}`, req);
  }

  /**
   * Partial-update a meal (PATCH — the macro-save path). Carries the plain fields AND the Slice 2 macro
   * fields: `servings` + the four dish TOTALS + `macroSource` (manual edit, or confirming an AI/DB proposal).
   * Omitted fields are unchanged; everything is clamped + household-scoped server-side. Returns the updated meal.
   */
  patchFamilyMeal(id: number, req: {
    localDate?: string; slot?: FamilyMealSlot; title?: string; ingredients?: string;
    servings?: number; calories?: number; proteinG?: number; carbG?: number; fatG?: number;
    macroSource?: FamilyMealMacroSource;
  }): Observable<FamilyMeal> {
    return this.http.patch<FamilyMeal>(`${this.base}/family/meals/${id}`, req);
  }

  /** Delete a meal (any household member). */
  deleteFamilyMeal(id: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/family/meals/${id}`);
  }

  /**
   * "✨ Estimate with AI": ask Gemini for a meal's dish TOTAL macros + a suggested servings count from its
   * title + ingredients. Returns a PROPOSAL (saves NOTHING) — the editor previews it, and the user confirms
   * before the meal PATCH writes it. Household-scoped (foreign meal → 404); 503 when AI is unavailable.
   */
  estimateMealMacros(id: number): Observable<FamilyMealMacroProposal> {
    return this.http.post<FamilyMealMacroProposal>(`${this.base}/family/meals/${id}/ai/macros`, {});
  }

  /**
   * "✨ Refine with food database": sum per-ingredient food-DB (USDA) lookups into dish TOTALS, keeping the
   * meal's current servings. Returns a PROPOSAL (saves NOTHING) plus the `matched`/`unmatched` ingredient
   * lines so the user sees what was found. Household-scoped (foreign meal → 404); 503 when the DB is unavailable.
   */
  refineMealMacros(id: number): Observable<FamilyMealMacroProposal> {
    return this.http.post<FamilyMealMacroProposal>(`${this.base}/family/meals/${id}/macros/refine`, {});
  }

  /**
   * "✨ Add to tracker": log a planned meal's per-serving macros (× `servings`, default 1) onto a tracker day
   * (gated tracker.self). The meal must already have macros set (else 400) and the caller must be a member of
   * its household (else 404). `opts.localDate` ("YYYY-MM-DD") defaults to the meal's own planned date;
   * `opts.servings` (0.1..99, default 1) scales the logged portion; `opts.targetUserId` logs onto a household
   * co-member's tracker (defaults to the caller; a non-member target → 404). Returns the created food entry.
   */
  addMealToTracker(
    mealId: number,
    opts: { localDate?: string; servings?: number; targetUserId?: number } = {},
  ): Observable<FoodEntryDto> {
    return this.http.post<FoodEntryDto>(`${this.base}/tracker/food/from-meal`, {
      mealId,
      localDate: opts.localDate ?? null,
      servings: opts.servings ?? null,
      targetUserId: opts.targetUserId ?? null,
    });
  }

  /**
   * Append the chosen meals' ingredient lines to a shopping list. Pass `mealIds` for a specific set, else
   * `weekStart` ("YYYY-MM-DD") to take the whole week (defaults to the current local week). Omit `listId`
   * to find-or-create the household's "Groceries" list. Skips blanks + duplicates already on the list.
   * Returns the updated F1 list (the page reads `items` length before/after to report how many were added).
   */
  mealsToGrocery(req: {
    weekStart?: string; mealIds?: number[]; listId?: number;
  }): Observable<FamilyList> {
    return this.http.post<FamilyList>(`${this.base}/family/meals/to-grocery`, req);
  }

  /**
   * "✨ Plan our week": ask Gemini to propose varied dinners for the week's empty (or all) dinner slots.
   * The server computes the target dates + reads the household's recent titles (a "don't repeat" hint) —
   * neither is trusted from the client. Saves NOTHING; the page reviews/edits, then POSTs each accepted meal
   * to /meals (and can run mealsToGrocery). Degrades to a 503 when AI is unavailable / not configured.
   */
  planWeekAi(req: PlanWeekAiRequest): Observable<PlanWeekAiResult> {
    return this.http.post<PlanWeekAiResult>(`${this.base}/family/meals/ai/plan-week`, {
      weekStart: req.weekStart ?? null,
      constraints: req.constraints ?? null,
      fillSlots: req.fillSlots ?? null,
    });
  }

  /**
   * "✨ From a recipe": parse already-extracted recipe TEXT into a meal (title + newline-joined ingredients)
   * to PREFILL the editor. The server NEVER fetches a URL (no SSRF) — for a recipe link the caller pastes the
   * page text. Saves NOTHING; the user confirms/edits then Saves. 400 on empty text; 503 when AI is down.
   */
  recipeToMealAi(text: string): Observable<RecipeAiResult> {
    return this.http.post<RecipeAiResult>(`${this.base}/family/meals/ai/from-recipe`, { text });
  }

  /**
   * "✨ What can I make?": send on-hand `ingredients` ("chicken, rice, broccoli, soy sauce") + optional
   * free-text `constraints` (kid-friendly / vegetarian / quick) for Gemini to propose dinner IDEAS (title +
   * the ingredients it uses + a few small missing items). Creates NOTHING — picking an idea PREFILLS the meal
   * editor, and the meal is only created on the user's Save. 400 on empty ingredients; 503 when AI is down.
   */
  whatCanIMakeAi(ingredients: string, constraints?: string | null): Observable<WhatCanIMakeAiResult> {
    return this.http.post<WhatCanIMakeAiResult>(`${this.base}/family/meals/ai/what-can-i-make`,
      { ingredients, constraints: constraints ?? null });
  }

  /**
   * "✨ Break it down": turn a recipe IDEA — a dish NAME ("chicken alfredo") OR a pasted recipe — into a
   * structured breakdown ({ title, servings, ingredients:[{name,quantity}], macrosPerServing, steps? }). The
   * server NEVER fetches a URL (the client passes recipe TEXT only — no SSRF). Saves NOTHING; the page shows
   * an EDITABLE review, then the user adds the ingredients to the grocery list and/or saves it as a meal.
   * 400 on empty text; 503 when AI is unavailable / not configured.
   */
  recipeBreakdown(text: string): Observable<RecipeBreakdownResult> {
    return this.http.post<RecipeBreakdownResult>(`${this.base}/family/meals/recipe-breakdown`, { text });
  }

  /**
   * Append a recipe breakdown's reviewed ingredient NAMEs to a shopping list (reuses the shared grocery-add
   * path). Omit `listId` to find-or-create the household's "Groceries" list. Skips blanks + de-dupes against
   * the list's OPEN items server-side. NOT generative (only family.use). Returns the updated F1 list (the page
   * reads `items` length before/after to report how many were added).
   */
  recipeBreakdownToGrocery(items: string[], listId?: number): Observable<FamilyList> {
    return this.http.post<FamilyList>(`${this.base}/family/meals/recipe-breakdown/to-grocery`,
      { items, listId: listId ?? null });
  }

  // ---- Grocery Tool: the household's single "Groceries" list (find-or-create), gated grocery.use + family.use ----

  /** The household's Groceries list (find-or-create). Returns the F1 list shape (items + shares). */
  grocery(): Observable<FamilyList> {
    return this.http.get<FamilyList>(`${this.base}/grocery`);
  }

  /** Add one item to the Groceries list (plain de-dupe against open items). Returns the updated list. */
  groceryAddItem(text: string): Observable<FamilyList> {
    return this.http.post<FamilyList>(`${this.base}/grocery/items`, { text });
  }

  /**
   * Quantity-aware add: append a new item OR increment an existing matching item's trailing "xN" quantity.
   * `text` is the item NAME (an embedded "xN" is honoured as the amount); `quantity` is how many to add
   * (default 1). e.g. adding "Milk" when "Milk x2" is on the list bumps it to "Milk x3". Returns the updated list.
   */
  groceryAddQuantity(text: string, quantity?: number): Observable<FamilyList> {
    return this.http.post<FamilyList>(`${this.base}/grocery/items/quantity`, { text, quantity: quantity ?? null });
  }

  /** Toggle (or set) an item's done flag. Omit `done` to flip it. Returns the updated list. */
  groceryToggleItem(itemId: number, done?: boolean): Observable<FamilyList> {
    return this.http.patch<FamilyList>(`${this.base}/grocery/items/${itemId}`, { done: done ?? null });
  }

  /** Delete an item from the Groceries list. Returns the updated list. */
  groceryDeleteItem(itemId: number): Observable<FamilyList> {
    return this.http.delete<FamilyList>(`${this.base}/grocery/items/${itemId}`);
  }

  /** Reorder the Groceries list: items named in `itemIds` take that order; the rest keep their relative order. */
  groceryReorder(itemIds: number[]): Observable<FamilyList> {
    return this.http.put<FamilyList>(`${this.base}/grocery/reorder`, { itemIds });
  }

  // ---- My Recipes: the caller's own per-user recipe book (find/CRUD/share), gated recipes.use ----

  /** The caller's OWN saved recipes, newest-first (each `owned: true`). */
  recipes(): Observable<Recipe[]> {
    return this.http.get<Recipe[]>(`${this.base}/recipes`);
  }

  /** Recipes shared TO the caller by their mutual contacts (each `owned: false`, id + owner display name only). */
  recipesSharedWithMe(): Observable<Recipe[]> {
    return this.http.get<Recipe[]>(`${this.base}/recipes/shared`);
  }

  /** A single recipe — the caller's own, OR one shared by a mutual contact (else 404 server-side). */
  recipe(id: number): Observable<Recipe> {
    return this.http.get<Recipe>(`${this.base}/recipes/${id}`);
  }

  /** Create a new recipe (owned). Returns the saved row. */
  createRecipe(req: RecipeUpsertRequest): Observable<Recipe> {
    return this.http.post<Recipe>(`${this.base}/recipes`, req);
  }

  /** Save a what-to-eat / recipe-breakdown PROPOSAL as the caller's recipe ("export a recipe"). */
  saveRecipeFromBreakdown(req: RecipeFromBreakdownRequest): Observable<Recipe> {
    return this.http.post<Recipe>(`${this.base}/recipes/from-breakdown`, req);
  }

  /** Update an OWN recipe (foreign/missing → 404). Returns the saved row. */
  updateRecipe(id: number, req: RecipeUpsertRequest): Observable<Recipe> {
    return this.http.put<Recipe>(`${this.base}/recipes/${id}`, req);
  }

  /** Toggle share-with-contacts on an OWN recipe. Returns `{ id, shareWithContacts }`. */
  setRecipeShare(id: number, shareWithContacts: boolean): Observable<{ id: number; shareWithContacts: boolean }> {
    return this.http.put<{ id: number; shareWithContacts: boolean }>(
      `${this.base}/recipes/${id}/share`, { shareWithContacts });
  }

  /** Delete an OWN recipe (cascade removes its ingredients; foreign/missing → 404). */
  deleteRecipe(id: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/recipes/${id}`);
  }

  // ---- Resume Builder: the gated /resume Tool (master + tailored applications + AI), all owner-scoped ----

  /** The caller's whole Resume Builder state: their master resume (null until first save) + its applications. */
  resumeState(): Observable<ResumeState> {
    return this.http.get<ResumeState>(`${this.base}/resume`);
  }

  /** Create/replace the single master resume for the owner (upsert). Returns the saved master. */
  saveResume(req: ResumeSaveRequest): Observable<ResumeDto> {
    return this.http.put<ResumeDto>(`${this.base}/resume`, req);
  }

  /** Delete the master resume + cascade its applications. */
  deleteResume(): Observable<void> {
    return this.http.delete<void>(`${this.base}/resume`);
  }

  /** Parse an existing resume (uploaded file OR pasted text) into structured data. 503 when AI unconfigured. */
  parseResume(req: ParseResumeRequest): Observable<{ data: ResumeData; aiUsed: boolean }> {
    return this.http.post<{ data: ResumeData; aiUsed: boolean }>(`${this.base}/resume/parse`, req);
  }

  /** Upload/replace the master headshot (base64 image + mime). Returns `{ ok: true }`. */
  uploadResumeHeadshot(req: HeadshotRequest): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>(`${this.base}/resume/headshot`, req);
  }

  /** The stored headshot image bytes (as a Blob), or a 404 when none is set. */
  resumeHeadshot(): Observable<Blob> {
    return this.http.get(`${this.base}/resume/headshot`, { responseType: 'blob' });
  }

  /** Remove the stored headshot. */
  deleteResumeHeadshot(): Observable<void> {
    return this.http.delete<void>(`${this.base}/resume/headshot`);
  }

  /** Start a new tailored application off the master (AI tailors data + drafts a cover letter), persisted. */
  createResumeApplication(req: NewApplicationRequest): Observable<ResumeApplicationDto> {
    return this.http.post<ResumeApplicationDto>(`${this.base}/resume/applications`, req);
  }

  /** Save an application's edits (job pin, tailored data, cover letter). Returns the saved row. */
  saveResumeApplication(id: number, req: ApplicationSaveRequest): Observable<ResumeApplicationDto> {
    return this.http.put<ResumeApplicationDto>(`${this.base}/resume/applications/${id}`, req);
  }

  /** Delete a tailored application. */
  deleteResumeApplication(id: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/resume/applications/${id}`);
  }

  /** AI: tailor the supplied resume data toward a job description (a proposal — nothing persisted). */
  tailorResume(req: TailorRequest): Observable<{ data: ResumeData }> {
    return this.http.post<{ data: ResumeData }>(`${this.base}/resume/ai/tailor`, req);
  }

  /** AI: draft a cover letter for a job from the supplied resume data. */
  resumeCoverLetter(req: CoverLetterRequest): Observable<{ coverLetter: string }> {
    return this.http.post<{ coverLetter: string }>(`${this.base}/resume/ai/cover-letter`, req);
  }

  /** AI: refine one section's content under a free-text instruction (whole data as context). */
  refineResumeSection(req: RefineRequest): Observable<{ result: string }> {
    return this.http.post<{ result: string }>(`${this.base}/resume/ai/refine`, req);
  }

  /** AI: the resume-assistant chat (history + optional data/job context). Returns the assistant reply. */
  resumeChat(req: ResumeChatRequest): Observable<{ reply: string }> {
    return this.http.post<{ reply: string }>(`${this.base}/resume/ai/chat`, req);
  }

  /**
   * Export a resume or cover letter as a downloadable file (Blob). `source` master|application; `kind`
   * resume|cover; `format` pdf|docx; `style` ats|designed (designed embeds the stored headshot). `id` is the
   * application id when `source==='application'`.
   */
  exportResume(opts: {
    source: 'master' | 'application';
    id?: number | null;
    kind: 'resume' | 'cover';
    format: 'pdf' | 'docx';
    style: 'ats' | 'designed';
  }): Observable<Blob> {
    let params = new HttpParams()
      .set('source', opts.source)
      .set('kind', opts.kind)
      .set('format', opts.format)
      .set('style', opts.style);
    if (opts.source === 'application' && opts.id != null) params = params.set('id', opts.id);
    return this.http.get(`${this.base}/resume/export`, { params, responseType: 'blob' });
  }

  // ---- Family Hub F4: chore board (assignee; stars/points; recurrence; the stars tally) ----

  /** The household's chores (open first, then done) + the per-member all-time stars tally. */
  familyChores(): Observable<FamilyChores> {
    return this.http.get<FamilyChores>(`${this.base}/family/chores`);
  }

  /**
   * Add a chore (PARENT only — a child cannot create chores). `source` is `assigned` (to a specific child via
   * `assignedToUserId`) or `pool` (anyone-claimable marketplace chore); `creditValue` is the allowance money
   * awarded on approval; `points` are the stars per completion (default 1); `recurrence` is none/daily/weekly.
   * Returns the full updated board.
   */
  createFamilyChore(req: {
    title: string; assignedToUserId?: number | null; points?: number; recurrence?: FamilyChoreRecurrence;
    source?: FamilyChoreSource; creditValue?: number;
  }): Observable<FamilyChores> {
    return this.http.post<FamilyChores>(`${this.base}/family/chores`, req);
  }

  /**
   * Patch a chore (PARENT only): edit title/assignee/points/recurrence/source/creditValue, or toggle the
   * legacy `done` flag. Omitted fields are unchanged. Returns the full updated board.
   */
  patchFamilyChore(id: number, req: {
    title?: string; assignedToUserId?: number | null; points?: number;
    recurrence?: FamilyChoreRecurrence; done?: boolean;
    source?: FamilyChoreSource; creditValue?: number;
  }): Observable<FamilyChores> {
    return this.http.patch<FamilyChores>(`${this.base}/family/chores/${id}`, req);
  }

  /** Delete a chore (PARENT only); its completion ledger cascades. Returns nothing (the page reloads). */
  deleteFamilyChore(id: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/family/chores/${id}`);
  }

  // ---- Chore marketplace: the claim → submit → approve/reject state machine ----
  // Each returns the full updated board (rescoped server-side by the caller's role). Claim/submit are CHILD
  // actions (chore.claim); approve/reject are PARENT actions (allowance.manage).

  /** A CHILD claims an OPEN pool (marketplace) chore → it becomes theirs to do. */
  claimFamilyChore(id: number): Observable<FamilyChores> {
    return this.http.post<FamilyChores>(`${this.base}/family/chores/${id}/claim`, {});
  }

  /** A CHILD marks their claimed/assigned chore done → submitted, awaiting a parent's approval (no credits yet). */
  submitFamilyChore(id: number): Observable<FamilyChores> {
    return this.http.post<FamilyChores>(`${this.base}/family/chores/${id}/submit`, {});
  }

  /** A PARENT approves a submitted chore → credits are awarded to the child exactly once. */
  approveFamilyChore(id: number): Observable<FamilyChores> {
    return this.http.post<FamilyChores>(`${this.base}/family/chores/${id}/approve`, {});
  }

  /** A PARENT rejects a submitted chore → sent back to the child to retry (awards nothing); optional `note`. */
  rejectFamilyChore(id: number, note?: string): Observable<FamilyChores> {
    return this.http.post<FamilyChores>(`${this.base}/family/chores/${id}/reject`, { note: note ?? null });
  }

  // ---- Allowance: the per-child credit ledger + balance (cash given IRL; recorded here) ----

  /** A CHILD's OWN balance + ledger (kid-safe; only theirs). Gated by chore.claim server-side. */
  myAllowance(): Observable<AllowanceMe> {
    return this.http.get<AllowanceMe>(`${this.base}/family/allowance/me`);
  }

  /** The PARENT manager: every household child's balance + a recent ledger. Gated by allowance.manage. */
  allowance(): Observable<Allowance> {
    return this.http.get<Allowance>(`${this.base}/family/allowance`);
  }

  /** Record a cash PAYOUT handed over IRL (debits the in-app balance). Returns the refreshed manager view. */
  allowancePayout(childUserId: number, req: AllowanceMoveRequest): Observable<Allowance> {
    return this.http.post<Allowance>(`${this.base}/family/allowance/${childUserId}/payout`, req);
  }

  /** Record a SPEND against the balance (with an optional category). Returns the refreshed manager view. */
  allowanceSpend(childUserId: number, req: AllowanceMoveRequest): Observable<Allowance> {
    return this.http.post<Allowance>(`${this.base}/family/allowance/${childUserId}/spend`, req);
  }

  /** Record a manual ADJUST (bonus = sign +1, penalty = sign −1). Returns the refreshed manager view. */
  allowanceAdjust(childUserId: number, req: AllowanceMoveRequest): Observable<Allowance> {
    return this.http.post<Allowance>(`${this.base}/family/allowance/${childUserId}/adjust`, req);
  }

  // ---- Family Hub F4: chore-board AI assists (suggest / balance / values / "good job" summary) ----
  // Each assist APPLIES NOTHING — it returns proposals the page reviews then writes via the existing
  // createFamilyChore / patchFamilyChore. suggest/balance/values degrade to a 503 when AI is unavailable;
  // the summary NEVER 503s (a deterministic plain floor is returned with fellBackToPlain=true).

  /**
   * "✨ Suggest chores": ask Gemini for age-appropriate chore ideas. Optional `ages` (e.g. [8, 5]) tailor
   * difficulty; the server reads the household's existing titles as a "don't duplicate" hint (not trusted from
   * the client) and creates NOTHING — the page reviews/edits, then POSTs each accepted one to /chores.
   * 503 when AI is unavailable / not configured.
   */
  suggestChoresAi(req: ChoreSuggestAiRequest): Observable<ChoreSuggestAiResult> {
    return this.http.post<ChoreSuggestAiResult>(`${this.base}/family/chores/ai/suggest`, {
      ages: req.ages ?? null,
    });
  }

  /**
   * "✨ Balance": ask Gemini to fairly assign the household's chores across members (it sees the current
   * chores + members + the stars tally). Every returned id is validated server-side, so a foreign/hallucinated
   * id can never assign to an outsider. Applies NOTHING — the page reviews per row, then PATCHes each accepted
   * /chores/{id} with the new assignee. 503 when AI is unavailable.
   */
  balanceChoresAi(): Observable<ChoreBalanceAiResult> {
    return this.http.post<ChoreBalanceAiResult>(`${this.base}/family/chores/ai/balance`, {});
  }

  /**
   * "✨ Suggest stars": ask Gemini for fair point values for the household's chores. Foreign choreIds are
   * dropped server-side. Applies NOTHING — the page reviews, then PATCHes each accepted /chores/{id} with the
   * new points. 503 when AI is unavailable.
   */
  suggestChoreValuesAi(): Observable<ChoreValuesAiResult> {
    return this.http.post<ChoreValuesAiResult>(`${this.base}/family/chores/ai/values`, {});
  }

  /**
   * "Good job" weekly chore summary: a warm read-only narrative of the week's chore wins, built off the
   * server's completion ledger (the model invents nothing). NEVER 503 — when AI is unavailable the guaranteed
   * deterministic plain summary comes back with `fellBackToPlain` = true (same handling as the morning
   * briefing). Cached server-side per (household, ISO week).
   */
  choreSummaryAi(): Observable<ChoreSummaryAiResult> {
    return this.http.get<ChoreSummaryAiResult>(`${this.base}/family/chores/ai/summary`);
  }

  // ---- Family Hub F5: FINANCE (Rocket Money CSV) — gated by family.use AND family.finance server-side ----

  /**
   * Import a Rocket Money CSV. The file is read as TEXT in the browser and POSTed as `{ fileName, content }`;
   * the server parses it, find-or-creates accounts, and inserts DEDUPED transactions (re-imports add nothing).
   * Returns the import counts + touched accounts so the page can toast and refresh.
   */
  importFinanceCsv(fileName: string, content: string): Observable<FinanceImportResult> {
    return this.http.post<FinanceImportResult>(`${this.base}/family/finance/import`, { fileName, content });
  }

  /** The household's finance accounts with per-account txn count + total spend (for the Accounts panel). */
  financeAccounts(): Observable<FinanceAccount[]> {
    return this.http.get<FinanceAccount[]>(`${this.base}/family/finance/accounts`);
  }

  /**
   * Relabel an account — set its `owner` (his/hers/joint/unassigned), `kind` (bank/credit/other), and/or
   * `name`. This is how the two SoFi accounts get tagged his vs hers; the his/hers split re-flows from it.
   * Send only the fields you're changing. Returns the updated account summary.
   */
  updateFinanceAccount(id: number, patch: FinanceAccountPatch): Observable<FinanceAccountSummary> {
    return this.http.put<FinanceAccountSummary>(`${this.base}/family/finance/accounts/${id}`, patch);
  }

  /**
   * A page of transactions, filterable by month (`yyyy-MM`), accountId, category, owner, and kind. `page` is
   * 1-based; the server fixes the page size. Newest-first.
   */
  financeTransactions(filter: {
    month?: string | null; accountId?: number | null; category?: string | null;
    owner?: FinanceOwner | null; kind?: FinanceTxnKind | null; page?: number | null;
  } = {}): Observable<FinanceTransactionsPage> {
    let p = new HttpParams();
    if (filter.month) p = p.set('month', filter.month);
    if (filter.accountId != null) p = p.set('accountId', filter.accountId);
    if (filter.category) p = p.set('category', filter.category);
    if (filter.owner) p = p.set('owner', filter.owner);
    if (filter.kind) p = p.set('kind', filter.kind);
    if (filter.page != null) p = p.set('page', filter.page);
    return this.http.get<FinanceTransactionsPage>(`${this.base}/family/finance/transactions`, { params: p });
  }

  /**
   * The dashboard summary for a month (`yyyy-MM`; omit to let the server pick the most recent month with
   * data): headline totals, by-category/by-account/by-owner breakdowns, and a rolling 12-month trend.
   */
  financeSummary(month?: string | null): Observable<FinanceSummary> {
    let p = new HttpParams();
    if (month) p = p.set('month', month);
    return this.http.get<FinanceSummary>(`${this.base}/family/finance/summary`, { params: p });
  }

  /** Recent import batches (file, counts, who-by-name, when) for the import-history strip. */
  financeImports(): Observable<FinanceImportBatch[]> {
    return this.http.get<FinanceImportBatch[]>(`${this.base}/family/finance/imports`);
  }

  // ---- Bank / transaction import: parse → review → commit STAGING flow ----
  // Every format (Rocket Money, generic bank CSV, OFX/QFX) routes through staging. /parse writes a 'staged'
  // batch + staged rows and NEVER touches the live ledger; /commit atomically materializes the kept rows.
  // All household-scoped + double-gated server-side (family.use + family.finance); cross-household → 404.

  /**
   * Parse a file into a STAGED, reviewable batch (does NOT touch the live ledger). `format` defaults to
   * 'auto' (detect by extension/shape); a generic/ambiguous CSV must carry a `columnMap` (date + amount, or
   * a debit/credit pair). The server parses, rule-categorizes, and dedups (vs the committed ledger AND
   * within-batch, FITID-preferred), then returns the batch id + counts + touched accounts + a capped preview.
   */
  financeParse(req: FinanceParseRequest): Observable<FinanceStagedImport> {
    return this.http.post<FinanceStagedImport>(`${this.base}/family/finance/import/parse`, req);
  }

  /** A page of staged review rows for a batch (1-based; the server fixes the page size). */
  financeStaged(importId: number, page?: number | null): Observable<FinanceStagedPage> {
    let p = new HttpParams();
    if (page != null) p = p.set('page', page);
    return this.http.get<FinanceStagedPage>(`${this.base}/family/finance/import/${importId}/staged`, { params: p });
  }

  /**
   * OPTIONAL: ask Gemini to classify the still-Uncategorized, non-excluded staged rows, CONSTRAINED to the
   * fixed category set. Writes `suggestedCategory` + categorySource='ai'. NEVER 503 — floors to rows-unchanged
   * + `fellBackToPlain` when AI is off/unconfigured/errors, and never blocks commit. Extra finance.ai gate.
   */
  financeCategorizeAi(importId: number): Observable<FinanceCategorizeAiResult> {
    return this.http.post<FinanceCategorizeAiResult>(
      `${this.base}/family/finance/import/${importId}/categorize-ai`, {});
  }

  /**
   * Edit one staged row — set its `category`, `excluded`, and/or `kind`. `applyToFuture` additionally upserts
   * a household category rule (equals on the merchant) so the category sticks for future imports. Returns the
   * updated staged row.
   */
  financePatchStagedRow(
    importId: number, stagedId: number, patch: FinanceStagedRowPatch,
  ): Observable<FinanceStagedRow> {
    return this.http.patch<FinanceStagedRow>(
      `${this.base}/family/finance/import/${importId}/rows/${stagedId}`, patch);
  }

  /**
   * Commit a staged batch into the ledger: atomically find-or-create accounts, insert the deduped, non-excluded
   * rows (skipping duplicates), and flip the batch to 'committed'. `excludeIds` excludes extra rows on top of
   * any already toggled off. Returns the standard import result (counts + touched accounts).
   */
  financeCommit(importId: number, req: FinanceCommitRequest = {}): Observable<FinanceImportResult> {
    return this.http.post<FinanceImportResult>(
      `${this.base}/family/finance/import/${importId}/commit`, req);
  }

  /** Discard a STAGED batch (committed batches are immutable → 400). Returns 204. */
  financeDiscard(importId: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/family/finance/import/${importId}`);
  }

  /**
   * "✨ Explain this month": a warm, calm, read-only narration (+ up to 5 insight bullets) of where the
   * month's money went, built off the AUTHORITATIVE server-computed summary numbers (the model invents
   * nothing). NEVER 503 — when AI is unavailable/unconfigured (or the month is empty) the guaranteed
   * deterministic plain floor comes back with `fellBackToPlain` = true (same handling as the morning
   * briefing). Read-only — nothing is mutated. Pass the dashboard's `month` (yyyy-MM).
   */
  financeSummaryAi(month?: string | null): Observable<FinanceSummaryAiResult> {
    let p = new HttpParams();
    if (month) p = p.set('month', month);
    return this.http.get<FinanceSummaryAiResult>(`${this.base}/family/finance/ai/summary`, { params: p });
  }

  /**
   * "✨ Money coach": a DETERMINISTIC recurring-charges list (merchant · typical amount · monthly) + the
   * monthly recurring total — the authoritative floor that always renders — plus, when Gemini is configured,
   * a calm read-only `narrative` + up to 5 trim `tips` NARRATED from those same facts (advice only; nothing
   * is ever cancelled or edited). NEVER 503 — when AI is unavailable/unconfigured (or no recurring charges
   * are found) `narrative` is null, `tips` is empty, and `fellBackToPlain` is true. The server always picks
   * the recent-activity window, so the optional `month` param is reserved/ignored. Read-only.
   */
  financeMoneyCoachAi(_month?: string | null): Observable<FinanceMoneyCoachResult> {
    return this.http.get<FinanceMoneyCoachResult>(`${this.base}/family/finance/ai/money-coach`);
  }

  // ---- MONEY, DEEPENED: budgets · net worth · savings (all on the double-gated /family/finance room) ----
  // Every call is household-scoped server-side; a cross-household {id} answers 404 (existence never leaked).
  // People are by AppUser id + DisplayName only (never an email); deterministic math is the authoritative floor.

  /**
   * The household's per-category BUDGETS for a month (`yyyy-MM`; omit to let the server resolve the latest
   * with data). Each budget carries its deterministic month-to-date spend (EXPENSE-only, transfers excluded),
   * remaining, pct, a pace projection, and a pace status — plus an 'unbudgeted' rollup + the month's total spend.
   */
  financeBudgets(month?: string | null): Observable<FinanceBudgetsResponse> {
    let p = new HttpParams();
    if (month) p = p.set('month', month);
    return this.http.get<FinanceBudgetsResponse>(`${this.base}/family/finance/budgets`, { params: p });
  }

  /** Create a budget (category null/blank = the OVERALL whole-month budget). 409 when one already exists. */
  createFinanceBudget(req: FinanceBudgetUpsertRequest): Observable<FinanceBudgetDto> {
    return this.http.post<FinanceBudgetDto>(`${this.base}/family/finance/budgets`, req);
  }

  /** Update a budget's limit (and/or move its category). Cross-household id → 404; duplicate category → 409. */
  updateFinanceBudget(id: number, req: FinanceBudgetUpsertRequest): Observable<FinanceBudgetDto> {
    return this.http.put<FinanceBudgetDto>(`${this.base}/family/finance/budgets/${id}`, req);
  }

  /** Delete a budget. Cross-household id → 404. Returns 204. */
  deleteFinanceBudget(id: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/family/finance/budgets/${id}`);
  }

  /**
   * The household's MANUAL net worth: the newest signed balance per account → assets/liabilities/net totals,
   * the per-account latest-balance rows (positive = asset, negative = liability), and a net-worth-by-month
   * trend from the snapshot history. There is NO live bank feed — balances are entered by hand.
   */
  financeNetWorth(): Observable<FinanceNetWorthDto> {
    return this.http.get<FinanceNetWorthDto>(`${this.base}/family/finance/net-worth`);
  }

  /**
   * Enter today's (or a chosen day's) SIGNED balance for one household account (positive asset / negative
   * liability), upserted latest-wins on (account, day). Cross-household account id → 404. Returns 204.
   */
  setFinanceBalance(accountId: number, req: FinanceBalanceEntryRequest): Observable<void> {
    return this.http.post<void>(`${this.base}/family/finance/accounts/${accountId}/balance`, req);
  }

  /**
   * The household's SAVINGS goals with saved/target/pct + a deterministic projected-finish from contribution
   * pace, plus the totals across non-archived goals. Pass `includeArchived` to also return archived goals.
   */
  financeSavings(includeArchived = false): Observable<FinanceSavingsResponse> {
    let p = new HttpParams();
    if (includeArchived) p = p.set('includeArchived', true);
    return this.http.get<FinanceSavingsResponse>(`${this.base}/family/finance/savings`, { params: p });
  }

  /** Create a savings goal. */
  createFinanceSavingsGoal(req: FinanceSavingsUpsertRequest): Observable<FinanceSavingsGoalDto> {
    return this.http.post<FinanceSavingsGoalDto>(`${this.base}/family/finance/savings`, req);
  }

  /** Update a savings goal's fields (NOT savedAmount — use contribute). Cross-household id → 404. */
  updateFinanceSavingsGoal(id: number, req: FinanceSavingsUpsertRequest): Observable<FinanceSavingsGoalDto> {
    return this.http.put<FinanceSavingsGoalDto>(`${this.base}/family/finance/savings/${id}`, req);
  }

  /** Contribute to (or withdraw from, negative amount) a goal's savedAmount. Cross-household id → 404. */
  contributeFinanceSavingsGoal(id: number, req: FinanceContributeRequest): Observable<FinanceSavingsGoalDto> {
    return this.http.post<FinanceSavingsGoalDto>(`${this.base}/family/finance/savings/${id}/contribute`, req);
  }

  /** Delete a savings goal. Cross-household id → 404. Returns 204. */
  deleteFinanceSavingsGoal(id: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/family/finance/savings/${id}`);
  }

  /**
   * "✨ Budget check-in": the DETERMINISTIC floor (which budgets are over/near/under by pace + the over/near
   * counts + net-worth direction) ALWAYS renders; the finance.ai-gated Gemini narration (`narrative` + `tips`)
   * is the only token spend. NEVER 503 — `fellBackToPlain` is true when finance.ai is absent / Gemini is off /
   * there are no budgets. Cached per (household, month); writes nothing. Pass the dashboard's `month` (yyyy-MM).
   */
  financeBudgetCheckAi(month?: string | null): Observable<FinanceBudgetCheckDto> {
    let p = new HttpParams();
    if (month) p = p.set('month', month);
    return this.http.get<FinanceBudgetCheckDto>(`${this.base}/family/finance/ai/budget-check`, { params: p });
  }

  // ---- Cycle calendar — PRIVACY-FIRST + NON-MEDICAL ----
  // The cycle LOG is PRIVATE to its owner: every /family/cycle call is gated by cycle.track server-side
  // and owner-scoped — a caller only ever reads/edits their OWN periods/profile. Predictions are pure
  // deterministic math (no AI). The overlay (gated family.use, NOT cycle.track) returns ONLY PREDICTED
  // day-spans for opted-in members — never raw entries, never another user's email.

  /** The caller's OWN recent periods + the deterministic predictions + their settings (GET /family/cycle). */
  cycleData(): Observable<CycleData> {
    return this.http.get<CycleData>(`${this.base}/family/cycle/`);
  }

  /** Log one of the caller's OWN periods (POST /family/cycle/period). `startDate`/`endDate` are ISO dates
   *  ("YYYY-MM-DD"); `endDate` is optional (null = ongoing / not yet recorded). Returns the created period. */
  logPeriod(startDate: string, endDate?: string | null): Observable<CyclePeriod> {
    return this.http.post<CyclePeriod>(`${this.base}/family/cycle/period`,
      { startDate, endDate: endDate ?? null });
  }

  /** Delete one of the caller's OWN logged periods by id (204; owner-scoped — can't touch another user's). */
  deletePeriod(id: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/family/cycle/period/${id}`);
  }

  /**
   * PARTIAL upsert of one day's PRIVATE self-log (PUT /family/cycle/day-log) — HEALTH + INTIMATE data,
   * owner-scoped (cycle.track). `date` is required; an OMITTED field is PRESERVED on an existing row
   * (it is not cleared) and `symptoms`, when present, REPLACE the stored set. Returns the saved day-log.
   * This data NEVER appears in the family overlay or on the wire for any other viewer.
   */
  upsertCycleDayLog(patch: CycleDayLogPatch): Observable<CycleDayLog> {
    return this.http.put<CycleDayLog>(`${this.base}/family/cycle/day-log`, patch);
  }

  /** Clear an entire day's private log (DELETE /family/cycle/day-log?date=; 204, or 404 if none; owner-scoped). */
  deleteCycleDayLog(date: string): Observable<void> {
    const params = new HttpParams().set('date', date);
    return this.http.delete<void>(`${this.base}/family/cycle/day-log`, { params });
  }

  /** Patch the caller's OWN cycle settings — the two averages + the family-overlay opt-in (clamped
   *  server-side). Returns the updated settings (PATCH /family/cycle/settings). */
  patchCycleSettings(patch: CycleSettingsPatch): Observable<CycleSettings> {
    return this.http.patch<CycleSettings>(`${this.base}/family/cycle/settings`, patch);
  }

  /**
   * A gentle, NON-MEDICAL one-liner narrating the deterministic facts (GET /family/cycle/note). Gated by
   * cycle.track AND family.ai server-side; ALWAYS 200 (when Gemini is off it returns the deterministic
   * plain floor with `fellBackToPlain` = true — same handling as the briefing). Never diagnostic; cycle
   * content is never sent to the AI-usage log. A 403 means the caller lacks family.ai — degrade silently.
   */
  cycleNote(): Observable<CycleNote> {
    return this.http.get<CycleNote>(`${this.base}/family/cycle/note`);
  }

  /**
   * The family-calendar PREDICTED-phase overlay for [fromUtc, toUtc) (GET /family/cycle/overlay; gated
   * family.use, NOT cycle.track). Returns ONLY predicted period/fertile day-spans for opted-in household
   * members (the caller's own only when they hold cycle.track). Identity is userId + display name only —
   * NEVER an email; raw logged entries are NEVER exposed. The window is clamped to ≤92 days server-side.
   * Read-only; degrades to an empty list when nobody has opted in.
   */
  cycleOverlay(fromUtc: string, toUtc: string): Observable<CycleOverlayMember[]> {
    const params = new HttpParams().set('fromUtc', fromUtc).set('toUtc', toUtc);
    return this.http.get<CycleOverlayMember[]>(`${this.base}/family/cycle/overlay`, { params });
  }

  // ---- Identity Map — PRIVATE + owner-scoped (/family/identity) ----
  // Every call is gated by identity.map ON TOP OF the group's family.use and owner-scoped server-side: a
  // caller only ever reads/edits their OWN roles, time entries and rules. The split is computed by the
  // server (GroupBy role over the range). Manual time logging always works; the calendar import is a purely
  // OPTIONAL enhancement that reuses the already-connected Google Calendar and degrades gracefully when it
  // isn't configured/connected. No email is ever on the wire (it's the caller's own data); no AI is involved.

  /** The caller's OWN roles + the aggregated minutes-per-role over [fromUtc, toUtc) + their rules. The
   *  window defaults server-side (last ~30 days) and is hard-capped; pass plain ISO dates ("YYYY-MM-DD"). */
  identityMap(fromUtc?: string, toUtc?: string): Observable<IdentityMapData> {
    let params = new HttpParams();
    if (fromUtc) params = params.set('fromUtc', fromUtc);
    if (toUtc) params = params.set('toUtc', toUtc);
    return this.http.get<IdentityMapData>(`${this.base}/family/identity`, { params });
  }

  /** Create one of the caller's OWN roles (name + hex colour). Returns the created role. */
  createIdentityRole(body: IdentityRoleInput): Observable<IdentityRole> {
    return this.http.post<IdentityRole>(`${this.base}/family/identity/roles`, body);
  }

  /** Rename / recolor / archive / reorder one of the caller's OWN roles (owner-scoped). Returns the role. */
  patchIdentityRole(id: number, patch: IdentityRolePatch): Observable<IdentityRole> {
    return this.http.patch<IdentityRole>(`${this.base}/family/identity/roles/${id}`, patch);
  }

  /** Delete one of the caller's OWN roles AND its time entries + rules (owner-scoped; 204, or 404 if none). */
  deleteIdentityRole(id: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/family/identity/roles/${id}`);
  }

  /** Log one manual time entry against a role — the always-available path (no calendar needed). */
  addIdentityTime(body: IdentityTimeInput): Observable<IdentityTimeEntry> {
    return this.http.post<IdentityTimeEntry>(`${this.base}/family/identity/time`, body);
  }

  /** Delete one of the caller's OWN time entries by id (owner-scoped; 204, or 404 if none). */
  deleteIdentityTime(id: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/family/identity/time/${id}`);
  }

  /** Whether calendar is configured on the server + whether the caller has connected theirs. Drives the
   *  OPTIONAL "Import from calendar" affordance — calendar is NEVER required for the page to work. */
  identityCalendarStatus(): Observable<IdentityCalendarStatus> {
    return this.http.get<IdentityCalendarStatus>(`${this.base}/family/identity/calendar-status`);
  }

  /** Preview a calendar import over [fromUtc, toUtc): read the caller's OWN events, classify each by the
   *  stored rules, and return matched + unmatched + an already-imported count. Creates NOTHING (confirm
   *  first). Degrades to a `notReady` body when the calendar isn't configured/connected — never a 500. */
  identityImportPreview(fromUtc: string, toUtc: string): Observable<IdentityImportPreview> {
    return this.http.post<IdentityImportPreview>(`${this.base}/family/identity/import/preview`,
      { fromUtc, toUtc });
  }

  /** Persist confirmed imported rows + optionally upsert "remember this" rules. Re-commit is idempotent
   *  (the source-event-id dedup index skips already-imported events). Returns { imported, skipped }. */
  identityImportCommit(body: IdentityImportCommit): Observable<IdentityImportResult> {
    return this.http.post<IdentityImportResult>(`${this.base}/family/identity/import/commit`, body);
  }

  /** Auto-ingest: derive the caller's OWN recent Hub activity (workouts = real minutes; completed chores =
   *  an estimate) into time signals over [fromUtc, toUtc). Pure READ — proposes, writes nothing. Each signal
   *  carries a best-effort `suggestedRoleId` (0 = none) the user can confirm/override before Apply. Only the
   *  caller's own data, only the caller's own household — never another member's, never another household's. */
  identityAutoSuggest(fromUtc?: string, toUtc?: string): Observable<IdentityAutoSuggest> {
    let params = new HttpParams();
    if (fromUtc) params = params.set('fromUtc', fromUtc);
    if (toUtc) params = params.set('toUtc', toUtc);
    return this.http.get<IdentityAutoSuggest>(`${this.base}/family/identity/suggest`, { params });
  }

  /** Apply confirmed (signal → role) auto-suggestions over the SAME window. The server RE-DERIVES the minutes
   *  (client minutes are never trusted) and writes one idempotent `auto` row per signal — re-applying the same
   *  window never double-counts (Refresh → Apply is safe). Returns { imported, skipped }. */
  identityAutoApply(body: IdentityAutoApply): Observable<IdentityImportResult> {
    return this.http.post<IdentityImportResult>(`${this.base}/family/identity/auto/apply`, body);
  }

  /** Create/update a classification rule directly (manage rules outside an import). Returns the rule. */
  upsertIdentityRule(body: IdentityRuleInput): Observable<IdentityRule> {
    return this.http.post<IdentityRule>(`${this.base}/family/identity/rules`, body);
  }

  /** Delete one of the caller's OWN classification rules by id (owner-scoped; 204, or 404 if none). */
  deleteIdentityRule(id: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/family/identity/rules/${id}`);
  }

  // ---- 75 Hard challenge (/api/challenge) — gated by the SAME tracker permissions (tracker.self own
  // use; tracker.viewall coach read). AUTO scoring is recomputed live from the tracker server-side; only
  // the manual portion is persisted. The client never sends an email — it sends ?user={userId}. ----

  /**
   * The caller's active challenge, or — when `user` is set — someone else's (read-only) if permitted.
   * Resolves to `null` when there's no active challenge (the server writes a JSON `null` body, which
   * Angular parses to null). A non-viewable / non-existent target is 404 (never leaks existence).
   */
  challenge(user?: number): Observable<HardChallengeDto | null> {
    const params = user != null ? new HttpParams().set('user', String(user)) : undefined;
    return this.http.get<HardChallengeDto | null>(`${this.base}/challenge/`, { params });
  }

  /** Start a challenge (owner; one active at a time — 409 when one already exists). */
  startChallenge(body: StartChallengeRequest = {}): Observable<HardChallengeDto> {
    return this.http.post<HardChallengeDto>(`${this.base}/challenge/`, body);
  }

  /** One day's six-task breakdown (auto fields computed live). Pass `user` for a read-only view. */
  challengeDay(date: string, user?: number): Observable<HardDayDto> {
    let p = new HttpParams().set('date', date);
    if (user != null) p = p.set('user', String(user));
    return this.http.get<HardDayDto>(`${this.base}/challenge/day`, { params: p });
  }

  /**
   * Upsert the MANUAL portion of a day (owner): read, photo-boolean, no-alcohol, confession,
   * workout-2 outdoor, diet override. There is NO image payload, EVER. Returns the rebuilt day.
   */
  upsertChallengeDay(body: UpsertHardDayRequest): Observable<HardDayDto> {
    return this.http.put<HardDayDto>(`${this.base}/challenge/day`, body);
  }

  /** Pre-declare / clear FUTURE-only cheat dates within the window (owner). Returns the rebuilt challenge. */
  setChallengeCheatDays(body: CheatDaysRequest): Observable<HardChallengeDto> {
    return this.http.post<HardChallengeDto>(`${this.base}/challenge/cheat-days`, body);
  }

  /** People whose 75 Hard the caller may view read-only (userId + name only, NEVER email). */
  challengeShared(): Observable<HardSharedPersonDto[]> {
    return this.http.get<HardSharedPersonDto[]>(`${this.base}/challenge/shared`);
  }

  /** The configurable task set (own, or read-only when `user` is set + permitted). */
  challengeTasks(user?: number): Observable<HardTaskDto[]> {
    const params = user != null ? new HttpParams().set('user', String(user)) : undefined;
    return this.http.get<HardTaskDto[]>(`${this.base}/challenge/tasks`, { params });
  }

  /** Add a CUSTOM manual task (owner). */
  createChallengeTask(body: CreateHardTaskRequest): Observable<HardTaskDto> {
    return this.http.post<HardTaskDto>(`${this.base}/challenge/tasks`, body);
  }

  /** Edit a task's target/points/enable/etc (owner). */
  updateChallengeTask(id: number, body: UpdateHardTaskRequest): Observable<HardTaskDto> {
    return this.http.put<HardTaskDto>(`${this.base}/challenge/tasks/${id}`, body);
  }

  /** Delete a CUSTOM task (owner). Built-in auto tasks can only be disabled (400). */
  deleteChallengeTask(id: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/challenge/tasks/${id}`);
  }

  /** The caller + each sharing mutual contact, ranked by totalPoints desc (userId + name only, NEVER email). */
  challengeLeaderboard(): Observable<HardLeaderboardRowDto[]> {
    return this.http.get<HardLeaderboardRowDto[]>(`${this.base}/challenge/leaderboard`);
  }

  /** The AI coach recap (gated tracker.ai; ALWAYS 200 with a deterministic plain floor). */
  challengeCoach(): Observable<HardCoachDto> {
    return this.http.get<HardCoachDto>(`${this.base}/challenge/coach`);
  }

  // ---- Trophy Wall (/api/trophies) — the caller's OWN milestone badges, gated by tracker.self ----

  /** The caller's own trophy wall: badges DERIVED from existing tracker/75-Hard/bills data (no email). */
  trophies(): Observable<TrophiesResponse> {
    return this.http.get<TrophiesResponse>(`${this.base}/trophies/`);
  }

  // ---- Hub Wrapped (/api/wrapped) — the caller's OWN period story, gated by tracker.self ----

  /**
   * The caller's own Wrapped for a period (month / year / all-time). Every number is DERIVED server-side by
   * reusing the existing owner-scoped aggregations (so it agrees with the rest of the app) — no email, no secret.
   */
  wrapped(period: WrappedPeriod = 'month'): Observable<WrappedResponse> {
    return this.http.get<WrappedResponse>(`${this.base}/wrapped`, { params: { period } });
  }

  /**
   * The AI (or deterministic-floor) narrative for the caller's OWN recap. Gated server-side by tracker.self AND
   * tracker.ai (token-spend); ALWAYS 200 — a caller without AI (or AI unconfigured/errored) gets the floor
   * (`fellBackToPlain=true`). Grounded strictly in the same server-derived numbers — never invents a figure.
   */
  wrappedNarrative(period: WrappedPeriod = 'month'): Observable<WrappedNarrative> {
    return this.http.get<WrappedNarrative>(`${this.base}/wrapped/narrative`, { params: { period } });
  }

  /** Create a public Wrapped share for the caller's OWN recap (owner/window/whitelist/narrative baked server-side). */
  createWrappedShare(body: CreateWrappedShareRequest): Observable<WrappedShareCreated> {
    return this.http.post<WrappedShareCreated>(`${this.base}/wrapped/shares`, body);
  }

  /** List the caller's OWN Wrapped shares. */
  listWrappedShares(): Observable<WrappedShareItem[]> {
    return this.http.get<WrappedShareItem[]>(`${this.base}/wrapped/shares`);
  }

  /** Update a Wrapped share's label/expiry (caller's OWN share only). */
  updateWrappedShare(id: number, body: { expiresInHours: number; label?: string | null }): Observable<WrappedShareItem> {
    return this.http.put<WrappedShareItem>(`${this.base}/wrapped/shares/${id}`, body);
  }

  /** Delete a Wrapped share (caller's OWN share only). */
  deleteWrappedShare(id: number): Observable<unknown> {
    return this.http.delete(`${this.base}/wrapped/shares/${id}`);
  }

  /** Per-view access detail for a Wrapped share (caller's OWN share only). */
  wrappedShareAccesses(id: number): Observable<ShareAccessItem[]> {
    return this.http.get<ShareAccessItem[]>(`${this.base}/wrapped/shares/${id}/accesses`);
  }

  /** ANONYMOUS read of a public Wrapped link by token. PII-safe (whitelisted cards + frozen narrative; no auth). */
  publicWrapped(token: string): Observable<PublicWrapped> {
    return this.http.get<PublicWrapped>(`${this.base}/share/wrapped/${encodeURIComponent(token)}`);
  }

  // ---- Family Hub F6: Google Calendar (OAuth code flow; the caller's own primary calendar) ----
  // The server stores the refresh token encrypted and NEVER returns the client secret or any token; these
  // calls only ever carry a one-time auth code (on connect) and slim event DTOs. Every call degrades
  // gracefully: status reports configured/connected, and an unconnected caller never triggers a 500.

  /** Whether calendar is configured on the server + whether the caller has connected their Google Calendar. */
  calendarStatus(): Observable<CalendarStatus> {
    return this.http.get<CalendarStatus>(`${this.base}/family/calendar/status`);
  }

  /**
   * Exchange a one-time Google OAuth auth `code` (from the GIS code client) for offline access; the server
   * stores the resulting refresh token encrypted. `redirectUri` is "postmessage" for the popup code flow.
   */
  connectCalendar(code: string, redirectUri = 'postmessage'): Observable<{ connected: boolean }> {
    return this.http.post<{ connected: boolean }>(`${this.base}/family/calendar/connect`, { code, redirectUri });
  }

  /** Remove the caller's calendar connection (idempotent); forgets the stored refresh token. */
  disconnectCalendar(): Observable<{ connected: boolean }> {
    return this.http.post<{ connected: boolean }>(`${this.base}/family/calendar/disconnect`, {});
  }

  /** The caller's own events in [startUtc, endUtc) (ISO UTC instants), ordered by start. */
  calendarEvents(startUtc: string, endUtc: string): Observable<CalendarEvent[]> {
    const params = new HttpParams().set('startUtc', startUtc).set('endUtc', endUtc);
    return this.http.get<CalendarEvent[]>(`${this.base}/family/calendar/events`, { params });
  }

  /** Create an event on the caller's calendar. Returns the created event. */
  createEvent(input: CalendarEventInput): Observable<CalendarEvent> {
    return this.http.post<CalendarEvent>(`${this.base}/family/calendar/events`, input);
  }

  /**
   * OTHER household members' shared calendar events over [fromUtc, toUtc) for the family overlay (GET
   * /family/calendar/family-events). Each member that BOTH opted in AND connected a calendar appears once with
   * their userId + display name (NEVER an email) and their events (title + time only). Read-only; the caller's
   * own events come from {@link calendarEvents}. Degrades to an empty list when nobody shares.
   */
  familyEvents(fromUtc: string, toUtc: string): Observable<FamilyMemberEvents[]> {
    const params = new HttpParams().set('fromUtc', fromUtc).set('toUtc', toUtc);
    return this.http.get<FamilyMemberEvents[]>(`${this.base}/family/calendar/family-events`, { params });
  }

  /**
   * Opt the caller in/out of sharing their connected calendar's events with the household (PATCH
   * /family/calendar/share). Only meaningful once a calendar is connected; returns the new opt-in state.
   */
  setCalendarShare(share: boolean): Observable<{ shareHousehold: boolean }> {
    return this.http.patch<{ shareHousehold: boolean }>(`${this.base}/family/calendar/share`,
      { shareHousehold: share });
  }

  /** Update (patch) an event on the caller's calendar. Returns the updated event. */
  updateEvent(id: string, input: CalendarEventInput): Observable<CalendarEvent> {
    return this.http.put<CalendarEvent>(`${this.base}/family/calendar/events/${encodeURIComponent(id)}`, input);
  }

  /** Delete an event from the caller's calendar (204; idempotent when already gone). */
  deleteEvent(id: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/family/calendar/events/${encodeURIComponent(id)}`);
  }

  /**
   * Per-member busy blocks across the caller's household for the given window (find-a-time). Members are
   * identified by userId + display name only — never an email; only connected members are returned.
   */
  freeBusy(startUtc: string, endUtc: string, memberUserIds?: number[]): Observable<CalendarMemberBusy[]> {
    return this.http.post<CalendarMemberBusy[]>(`${this.base}/family/calendar/freebusy`,
      { startUtc, endUtc, memberUserIds: memberUserIds ?? [] });
  }

  // ---- Family Hub F6b: Find-a-time (candidate slots free for every selected CONNECTED member) ----

  /**
   * Find candidate meeting slots free for every selected member who has a connected calendar, within the
   * window + optional workday hours. Unconnected members don't constrain the search; the response lists who
   * was considered (and whether each was connected) so the UI can note them. Degrades cleanly (never 500).
   */
  findTime(req: FindTimeRequest): Observable<FindTimeResult> {
    return this.http.post<FindTimeResult>(`${this.base}/family/calendar/find-time`, req);
  }

  /**
   * "Schedule with AI": send free text ("dentist next Friday 9am") for Gemini to parse into 0+ PROPOSED
   * events (with recurrence) the user then confirms — this creates NOTHING. `referenceDateUtc` defaults to
   * now (the server anchors relative dates in the household timezone). Degrades gracefully: a 503 when AI is
   * unavailable / not configured, a 400 for empty text — the caller surfaces a friendly message.
   */
  scheduleAiEvents(text: string, referenceDateUtc?: string): Observable<ScheduleAiResult> {
    return this.http.post<ScheduleAiResult>(`${this.base}/family/calendar/schedule-ai`,
      { text, referenceDateUtc: referenceDateUtc ?? null });
  }

  /**
   * "Schedule from image": upload 1–5 schedule images / PDFs (a school calendar, a shift schedule, a sports
   * roster) for Gemini to EXTRACT into 0+ PROPOSED events the user then confirms — this creates + stores
   * NOTHING (the bytes are passed inline to the model and discarded). Returns the SAME {@link ScheduleAiResult}
   * proposal shape as {@link scheduleAiEvents}. `referenceDateUtc` defaults to now (anchors relative/implied
   * dates in the household timezone). Degrades gracefully: a 503 when AI is unavailable / not configured, a
   * 400 for empty / too-many / oversized / bad-mime files — the caller surfaces a friendly message.
   */
  scheduleFromImage(files: ScheduleImageFile[], referenceDateUtc?: string): Observable<ScheduleAiResult> {
    const body: ScheduleFromImageRequest = { files, referenceDateUtc: referenceDateUtc ?? null };
    return this.http.post<ScheduleAiResult>(`${this.base}/family/calendar/ai/from-image`, body);
  }

  /**
   * "✨ Best time for X": send free text ("a 45-min slot for the dentist next week, mornings") for Gemini to
   * fill the find-time form, then the EXISTING deterministic engine finds candidate slots across the whole
   * household. Returns those `slots` + the `interpreted` form + who was considered (connected or not). Creates
   * NOTHING — picking a slot opens the event editor. `referenceDateUtc` defaults to now. Degrades gracefully:
   * a 503 when AI is unavailable / not configured, a 400 for empty text — the caller surfaces a friendly line.
   */
  findTimeAi(text: string, referenceDateUtc?: string): Observable<FindTimeAiResult> {
    return this.http.post<FindTimeAiResult>(`${this.base}/family/calendar/ai/find-time`,
      { text, referenceDateUtc: referenceDateUtc ?? null });
  }

  // ---- Family Hub F6b: Plan polls (Doodle-style; time/text; vote/close/book) ----

  /** The household's plan polls (newest first), each with live vote counts + the caller's own selections. */
  familyPolls(): Observable<FamilyPoll[]> {
    return this.http.get<FamilyPoll[]>(`${this.base}/family/polls`);
  }

  /** Create a time or text poll with its options (2–30). Returns the created poll. */
  createFamilyPoll(req: FamilyPollCreate): Observable<FamilyPoll> {
    return this.http.post<FamilyPoll>(`${this.base}/family/polls`, req);
  }

  /** Replace the caller's votes for a poll with `optionIds` (every option that works for them). Returns the poll. */
  voteFamilyPoll(id: number, optionIds: number[]): Observable<FamilyPoll> {
    return this.http.post<FamilyPoll>(`${this.base}/family/polls/${id}/vote`, { optionIds });
  }

  /** Close a poll, picking a winner (defaults to the most-voted option when `winningOptionId` is omitted). */
  closeFamilyPoll(id: number, winningOptionId?: number | null): Observable<FamilyPoll> {
    return this.http.post<FamilyPoll>(`${this.base}/family/polls/${id}/close`, { winningOptionId: winningOptionId ?? null });
  }

  /**
   * Book a closed TIME poll's option onto the caller's connected Google Calendar. Returns a slim booked-event
   * payload; degrades to a clear 400 when the caller has no connected calendar (never a 500).
   */
  bookFamilyPoll(id: number, optionId: number): Observable<{ id: string; title: string; startUtc: string | null; endUtc: string | null; htmlLink: string | null }> {
    return this.http.post<{ id: string; title: string; startUtc: string | null; endUtc: string | null; htmlLink: string | null }>(
      `${this.base}/family/polls/${id}/book`, { optionId });
  }

  /** Delete a household poll (options + votes cascade). */
  deleteFamilyPoll(id: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/family/polls/${id}`);
  }

  /**
   * "✨ Suggest options": ask Gemini to propose poll options from a free-text `prompt` ("plan a Saturday family
   * outing"). Pass `kind` to force time/text, or omit it to let the model choose. Creates NOTHING — the dialog
   * fills its editable option rows from the result, then the user submits the normal create-poll form (which
   * re-validates). 503 when AI is unavailable / not configured; 400 for an empty prompt.
   */
  pollOptionsAi(prompt: string, kind?: FamilyPollKind | null, referenceDateUtc?: string): Observable<PollOptionsAiResult> {
    return this.http.post<PollOptionsAiResult>(`${this.base}/family/polls/ai/options`,
      { prompt, kind: kind ?? null, referenceDateUtc: referenceDateUtc ?? null });
  }

  /**
   * "✨ Summarize": a short read-only narrative of where a poll stands, built off the AUTHORITATIVE vote tally
   * (the model invents nothing). NEVER 503 — when AI is unavailable the guaranteed deterministic plain summary
   * comes back with `fellBackToPlain` = true (same handling as the morning briefing). 404 for a foreign poll.
   */
  pollSummaryAi(id: number): Observable<PollSummaryAiResult> {
    return this.http.get<PollSummaryAiResult>(`${this.base}/family/polls/${id}/ai/summary`);
  }

  // ---- Family Assistant: one ask-anything box over the whole household ----

  /**
   * "✨ Family Assistant": send a free-text `message` ("what's for dinner and what chores does Lily have? add
   * milk to groceries and remind me to call the dentist Tuesday"). The server assembles a compact, read-only
   * household snapshot and asks Gemini for a warm `answer` plus 0..6 PROPOSED actions (the closed list_add/
   * reminder/timer/calendar_event/chore/meal set). The assistant WRITES NOTHING — the frontend executes each
   * action via the matching EXISTING write endpoint only when the user clicks it. 400 for an empty message;
   * degrades gracefully to a 503 when AI is unavailable / not configured (the user can do it manually).
   */
  familyAssistant(message: string): Observable<FamilyAssistantResult> {
    return this.http.post<FamilyAssistantResult>(`${this.base}/family/assistant`, { message });
  }

  // ---- Search Everything (GET /api/search) ----

  /**
   * "Search Everything": query every domain the caller can see in one shot. The endpoint unions hits
   * server-side, permission-checks + scopes each one to what the caller may view, and returns typed results
   * that deep-link into existing pages. `domains` (optional) is a comma-joined subset of the domain tokens to
   * restrict to; omit for all. Gated by `search.use` (a page-gate only — every result is independently
   * re-gated by its own domain's permission). Min query length 2; the caller should debounce.
   */
  search(q: string, domains?: readonly string[], limit?: number): Observable<SearchResponse> {
    let params = new HttpParams().set('q', q);
    if (domains && domains.length) params = params.set('domains', domains.join(','));
    if (limit != null) params = params.set('limit', String(limit));
    return this.http.get<SearchResponse>(`${this.base}/search`, { params });
  }

  // ---- Wearable / Health sync (Fitbit v1; gated health.sync, owner-scoped) ----

  /**
   * The caller's wearable connection status (never 500). `configured` false ⇒ the provider isn't set up on
   * this server; `connected` false ⇒ no wearable linked yet. `clientId` + `scopes` let the SPA build the
   * Fitbit authorize URL (PKCE).
   */
  healthStatus(): Observable<HealthStatus> {
    return this.http.get<HealthStatus>(`${this.base}/health/status`);
  }

  /**
   * Complete the Fitbit PKCE auth-code exchange. `code` is the one-time code from the OAuth callback,
   * `redirectUri` MUST match the one used to build the authorize URL, and `codeVerifier` is the raw PKCE
   * verifier whose SHA-256 challenge was sent to authorize. 503 when the provider isn't configured.
   */
  healthConnect(code: string, redirectUri: string, codeVerifier: string): Observable<{ connected: boolean }> {
    return this.http.post<{ connected: boolean }>(`${this.base}/health/connect`, {
      code, redirectUri, codeVerifier,
    });
  }

  /** Remove the caller's wearable connection (idempotent — 200 even when nothing is linked). */
  healthDisconnect(): Observable<{ connected: boolean }> {
    return this.http.delete<{ connected: boolean }>(`${this.base}/health/disconnect`);
  }

  /** Patch the per-signal + auto-sync toggles (each field omitted = unchanged). Returns the fresh status. */
  healthSettings(patch: HealthSettingsPatch): Observable<HealthStatus> {
    return this.http.patch<HealthStatus>(`${this.base}/health/settings`, patch);
  }

  /** Run a manual bounded backfill now; returns the per-signal {imported, updated, skipped} summary. */
  healthSyncNow(): Observable<HealthSyncNowResult> {
    return this.http.post<HealthSyncNowResult>(`${this.base}/health/sync-now`, {});
  }

  // ---- Web Push (PWA background notifications) ----

  /**
   * Fetch the public VAPID key the browser subscribes with (anonymous endpoint). The server returns 404
   * when web-push is unconfigured (no keypair set) — callers treat that as "push unavailable" and skip
   * subscribing, leaving the SignalR/in-app surfaces untouched.
   */
  vapidPublicKey(): Observable<VapidPublicKey> {
    return this.http.get<VapidPublicKey>(`${this.base}/push/vapid-public`);
  }

  /**
   * Register (upsert) this device's browser PushSubscription. Owner is taken from the JWT server-side,
   * never the body; re-subscribing re-keys the device to the caller. Requires chat.read (the auth
   * interceptor attaches the bearer token).
   */
  pushSubscribe(sub: PushSubscribeRequest): Observable<void> {
    return this.http.post<void>(`${this.base}/push/subscribe`, sub);
  }

  /** Caller-scoped removal of a device subscription by endpoint; idempotent (200 even on no-match). */
  pushUnsubscribe(endpoint: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/push/subscribe`, {
      params: new HttpParams().set('endpoint', endpoint),
    });
  }
}
