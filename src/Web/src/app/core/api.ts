import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import {
  AccessPolicy, AuditEntry, CacheEfficiency, CalendarDay, ChatChannelDto, ChatContactDto, ChatMessageDto, CreateChannelRequest,
  CreateShareRequest, Fleet, FleetDeleteRequest,
  FleetDeleteResult, FleetReassignRequest, FleetReassignResult, FleetRevokeKeysRequest, FleetRevokeKeysResult, GroupBy,
  HeatmapCell, IngestionSource, IngestKey, IngestKeyCreated, LoginEvent, MachineStat, ManagedUser, ModelStat, NotificationDto, NotificationPreferenceDto, NotificationSettings,
  NotificationUpdate, PagedResult, PermissionItem, Presence, Pricing, ProjectDto, PublicShare, ReactionGroupDto, RequestLogEntry, SavedView,
  SavedViewUpsertRequest, SessionDetail, Settings, ShareAccessItem, ShareCreated, ShareListItem, SummaryResponse,
  SyncResult, SyncStatus, UsageFilter, UsageRecord, UsageStats,
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

  auditLog(): Observable<AuditEntry[]> {
    return this.http.get<AuditEntry[]>(`${this.base}/audit`);
  }

  requestLogs(opts: { method?: string; status?: string; q?: string; take?: number } = {}): Observable<RequestLogEntry[]> {
    let p = new HttpParams();
    if (opts.method) p = p.set('method', opts.method);
    if (opts.status) p = p.set('status', opts.status);
    if (opts.q) p = p.set('q', opts.q);
    p = p.set('take', opts.take ?? 200);
    return this.http.get<RequestLogEntry[]>(`${this.base}/logs`, { params: p });
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

  // ---- User management (requires users.manage) ----
  permissionCatalog(): Observable<PermissionItem[]> {
    return this.http.get<PermissionItem[]>(`${this.base}/permissions`);
  }

  users(): Observable<ManagedUser[]> {
    return this.http.get<ManagedUser[]>(`${this.base}/users`);
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

  // ---- Chat (channels, DMs, messages) — gated by chat.read/chat.send/chat.moderate ----

  /** All channels + DMs the caller can see, with unread counts and last-message previews. */
  chatChannels(): Observable<ChatChannelDto[]> {
    return this.http.get<ChatChannelDto[]>(`${this.base}/chat/channels`);
  }

  /** Create a channel (requires chat.send). */
  createChannel(body: CreateChannelRequest): Observable<ChatChannelDto> {
    return this.http.post<ChatChannelDto>(`${this.base}/chat/channels`, body);
  }

  /** Open (or fetch the existing) 1:1 direct-message conversation with a user (requires chat.send). */
  openDirect(userEmail: string): Observable<ChatChannelDto> {
    return this.http.post<ChatChannelDto>(`${this.base}/chat/direct`, { userEmail });
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

  /** Post a message via REST (the realtime hub is preferred; this is the fallback). */
  sendChatMessage(channelId: number, body: string, mentionedEmails: string[] | null = null): Observable<ChatMessageDto> {
    return this.http.post<ChatMessageDto>(`${this.base}/chat/channels/${channelId}/messages`, { body, mentionedEmails });
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

  // ---- Chat contacts / circles (admin-managed; the picker draws from these) ----

  /** The CALLER's own chat contacts (their circle) — the New-DM / member-picker candidate source. Gated by chat.read. */
  myContacts(): Observable<ChatContactDto[]> {
    return this.http.get<ChatContactDto[]>(`${this.base}/chat/contacts/me`);
  }

  /** Every enabled user except the caller, name-sorted — the admin editor's search pool (and the admin's own picker). Gated by chat.contacts.manage. */
  chatDirectory(): Observable<ChatContactDto[]> {
    return this.http.get<ChatContactDto[]>(`${this.base}/chat/directory`);
  }

  /** A specific user's chat contacts (admin editor). Gated by chat.contacts.manage. */
  userContacts(email: string): Observable<ChatContactDto[]> {
    return this.http.get<ChatContactDto[]>(`${this.base}/chat/contacts/user/${encodeURIComponent(email)}`);
  }

  /** Add a contact to a user's circle (mutual, idempotent); returns the updated list. Gated by chat.contacts.manage. */
  addUserContact(email: string, contactEmail: string): Observable<ChatContactDto[]> {
    return this.http.post<ChatContactDto[]>(`${this.base}/chat/contacts/user/${encodeURIComponent(email)}`, { contactEmail });
  }

  /** Remove a contact from a user's circle (mutual, no-op if absent); returns the updated list. Gated by chat.contacts.manage. */
  removeUserContact(email: string, contactEmail: string): Observable<ChatContactDto[]> {
    return this.http.delete<ChatContactDto[]>(
      `${this.base}/chat/contacts/user/${encodeURIComponent(email)}/${encodeURIComponent(contactEmail)}`);
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

  // ---- Access policy (open sign-up + default permissions; requires users.manage to edit) ----
  getAccessPolicy(): Observable<AccessPolicy> {
    return this.http.get<AccessPolicy>(`${this.base}/access-policy`);
  }

  updateAccessPolicy(body: AccessPolicy): Observable<AccessPolicy> {
    return this.http.put<AccessPolicy>(`${this.base}/access-policy`, body);
  }
}
