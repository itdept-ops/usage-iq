import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import {
  AccessPolicy, AuditEntry, CacheEfficiency, CalendarDay, CreateShareRequest, Fleet, FleetDeleteRequest,
  FleetDeleteResult, FleetReassignRequest, FleetReassignResult, FleetRevokeKeysRequest, FleetRevokeKeysResult, GroupBy,
  HeatmapCell, IngestionSource, IngestKey, IngestKeyCreated, LoginEvent, MachineStat, ManagedUser, ModelStat, NotificationSettings,
  NotificationUpdate, PagedResult, PermissionItem, Pricing, ProjectDto, PublicShare, RequestLogEntry, SavedView,
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

  // ---- Access policy (open sign-up + default permissions; requires users.manage to edit) ----
  getAccessPolicy(): Observable<AccessPolicy> {
    return this.http.get<AccessPolicy>(`${this.base}/access-policy`);
  }

  updateAccessPolicy(body: AccessPolicy): Observable<AccessPolicy> {
    return this.http.put<AccessPolicy>(`${this.base}/access-policy`, body);
  }
}
