import { HttpClient, HttpHeaders, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import {
  AccessPolicy, AddExerciseRequest, AddFoodRequest, AddHydrationRequest, AuditEntry, BuildDayRequest, BuildDayResponse, CacheEfficiency, CalendarDay, CalendarEvent, CalendarEventInput, CalendarMemberBusy, CalendarStatus, ChatChannelDto, ChatCatchUpResult, ChatComposeAction, ChatComposeResult, ChatContactDto, ChatMessageDto, ChatRepliesResult, CommitDayRequest, CommitDayResponse, CreateChannelRequest, DaySummaryRequest, DaySummaryResponse,
  CreateShareRequest, CustomExerciseDto, CustomFoodDto, DailyCoachResponse, EstimateExerciseRequest, EstimateExerciseResponse, EstimateMacrosRequest, EstimateMacrosResponse, ExerciseEntryDto, ExerciseLibraryDto, Fleet, FleetDeleteRequest,
  FamilyAssistantResult, FamilyBriefing, FamilyChore, FamilyChoreRecurrence, FamilyChores, FamilyMemberEvents, ChoreSuggestAiRequest, ChoreSuggestAiResult, ChoreBalanceAiResult, ChoreValuesAiResult, ChoreSummaryAiResult, FamilyList, FamilyListKind, FamilyMeal, FamilyMealDay, FamilyMealMacroProposal, FamilyMealMacroSource, FamilyMealSlot, FamilyNote, FamilyPoll, FamilyPollCreate, FamilyRecurrence, FamilyReminder, FamilySettings, FamilySettingsUpdate, FamilyTimer, FamilyPollKind, FamilyToday, FindTimeRequest, FindTimeAiResult, PollOptionsAiResult, PollSummaryAiResult, ReminderAiResult, ListItemsAiResult, ListSuggestAiResult, NoteDraftAiResult, NoteSummaryAiResult, AskNotesAiResult, NoteTransformAction, NoteTransformAiResult, PlanWeekAiRequest, PlanWeekAiResult, RecipeAiResult, WhatCanIMakeAiResult, TimerAiResult, FindTimeResult, QuickAddKind, QuickAddRequest, QuickAddResult, FinanceAccount, FinanceAccountPatch, FinanceAccountSummary, FinanceImportBatch, FinanceImportResult, FinanceMoneyCoachResult, FinanceSummary, FinanceSummaryAiResult, FinanceTransactionsPage, FinanceTxnKind, FinanceOwner, FleetDeleteResult, FleetReassignRequest, FleetReassignResult, FleetRevokeKeysRequest, FleetRevokeKeysResult, FoodEntryDto, FoodSearchItemDto, GroupBy, Household, HouseholdCandidate,
  HeatmapCell, HydrationEntryDto, HydrationSuggestResponse, ImageRequest, IngestionSource, IngestKey, IngestKeyCreated, LocationFix, LocationSettings, LocationSettingsUpdate, AdminUserLocation, RecordLocationRequest, LogWeightRequest, LoginEvent, MachineStat, ManagedUser, MealFeedbackRequest, MealFeedbackResponse, ModelStat, MoveDayRequest, MoveDayResult, NaturalGoalRequest, NaturalGoalResponse, NotificationDto, NotificationPreferenceDto, NotificationSettings,
  AiUsageFilter, AiUsageResponse,
  NotificationUpdate, PagedResult, ParseExerciseRequest, ParseExerciseResponse, ParseHydrationRequest, ParseHydrationResponse, ParseMealRequest, ParseMealResponse, PermissionItem, PermissionPreset, Presence, Pricing, ProjectDto, PublicShare, ReactionGroupDto, ReadLabelResponse, RecipeMacrosRequest, RecipeMacrosResponse, RequestLogEntry, SavedView, ScheduleAiResult, ScheduleFromImageRequest, ScheduleImageFile,
  SavedViewUpsertRequest, SessionDetail, Settings, ShareAccessItem, ShareCreated, ShareListItem, SharedUserDto, SuggestFoodsResponse, SuggestGoalResponse, SuggestWorkoutRequest, SuggestWorkoutResponse, SummaryResponse,
  SyncResult, SyncStatus, TrackerDayDto, TrackerProfileDto, TrackerRecapResult, UpsertActivityRequest, UsageFilter, UsageRecord, UsageStats,
  WatchActivityDto, WeeklyReviewResponse, WeightInsightResponse, WeightPointDto, WeightStatsDto, WorkoutXSearchResultDto,
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

  recordsCsv(f: UsageFilter): Observable<Blob> {
    return this.http.get(`${this.base}/usage/records.csv`, { params: this.filterParams(f), responseType: 'blob' });
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

  /** Delete a logged food entry. */
  deleteFood(id: number): Observable<unknown> {
    return this.http.delete(`${this.base}/tracker/food/${id}`);
  }

  /**
   * The caller's saved "My foods" library (auto-built from manual food logs), newest-used first.
   * Pass `q` for a case-insensitive description/brand filter.
   */
  savedFoods(q?: string): Observable<CustomFoodDto[]> {
    const params = q ? new HttpParams().set('q', q) : undefined;
    return this.http.get<CustomFoodDto[]>(`${this.base}/tracker/foods/saved`, { params });
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

  /** Parse a free-text multi-item meal ("Big Mac, fries, Coke") into individual food items. */
  parseMeal(body: ParseMealRequest): Observable<ParseMealResponse> {
    return this.http.post<ParseMealResponse>(`${this.base}/ai/parse-meal`, body);
  }

  /** MULTIMODAL: identify foods + macros from a meal photo. `imageBase64` is raw base64 (no `data:` prefix). */
  photoMeal(body: ImageRequest): Observable<ParseMealResponse> {
    return this.http.post<ParseMealResponse>(`${this.base}/ai/photo-meal`, body);
  }

  /** MULTIMODAL: read a nutrition label from a photo. `imageBase64` is raw base64 (no `data:` prefix). */
  readLabel(body: ImageRequest): Observable<ReadLabelResponse> {
    return this.http.post<ReadLabelResponse>(`${this.base}/ai/read-label`, body);
  }

  /** Suggest foods from the CALLER's own remaining calories/macros today (read server-side; empty body). */
  suggestFoods(): Observable<SuggestFoodsResponse> {
    return this.http.post<SuggestFoodsResponse>(`${this.base}/ai/suggest-foods`, {});
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
   * "✨ Add to my tracker": log ONE serving of a planned meal's per-serving macros onto the caller's OWN
   * tracker day (gated tracker.self). The meal must already have macros set (else 400) and the caller must be
   * a member of its household (else 404). `localDate` ("YYYY-MM-DD") defaults to the meal's own planned date.
   * Returns the created food entry.
   */
  addMealToTracker(mealId: number, localDate?: string): Observable<FoodEntryDto> {
    return this.http.post<FoodEntryDto>(`${this.base}/tracker/food/from-meal`,
      { mealId, localDate: localDate ?? null });
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

  // ---- Family Hub F4: chore board (assignee; stars/points; recurrence; the stars tally) ----

  /** The household's chores (open first, then done) + the per-member all-time stars tally. */
  familyChores(): Observable<FamilyChores> {
    return this.http.get<FamilyChores>(`${this.base}/family/chores`);
  }

  /**
   * Add a chore. `assignedToUserId` must be a household member (omit/null = unassigned); `points` are the
   * stars per completion (default 1); `recurrence` is none/daily/weekly. Returns the full updated board.
   */
  createFamilyChore(req: {
    title: string; assignedToUserId?: number | null; points?: number; recurrence?: FamilyChoreRecurrence;
  }): Observable<FamilyChores> {
    return this.http.post<FamilyChores>(`${this.base}/family/chores`, req);
  }

  /**
   * Patch a chore (any household member): edit title/assignee/points/recurrence, or toggle `done`. Checking
   * it (done:true) stamps the caller and stars them in the ledger; un-checking clears the stamp but keeps
   * the stars. Omitted fields are unchanged. Returns the full updated board.
   */
  patchFamilyChore(id: number, req: {
    title?: string; assignedToUserId?: number | null; points?: number;
    recurrence?: FamilyChoreRecurrence; done?: boolean;
  }): Observable<FamilyChores> {
    return this.http.patch<FamilyChores>(`${this.base}/family/chores/${id}`, req);
  }

  /** Delete a chore (any household member); its completion ledger cascades. Returns nothing (the page reloads). */
  deleteFamilyChore(id: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/family/chores/${id}`);
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
}
