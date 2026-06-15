import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import {
  AuditEntry, CalendarDay, GroupBy, IngestionSource, ManagedUser, ModelStat, NotificationSettings, NotificationUpdate,
  PagedResult, PermissionItem, Pricing, ProjectDto, RequestLogEntry, Settings, SummaryResponse, SyncResult, SyncStatus,
  UsageFilter, UsageRecord,
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

  createUser(body: { email: string; name?: string; isEnabled: boolean; permissions: string[] }): Observable<ManagedUser> {
    return this.http.post<ManagedUser>(`${this.base}/users`, body);
  }

  updateUser(id: number, body: { name?: string; isEnabled: boolean; permissions: string[] }): Observable<ManagedUser> {
    return this.http.put<ManagedUser>(`${this.base}/users/${id}`, body);
  }

  deleteUser(id: number): Observable<unknown> {
    return this.http.delete(`${this.base}/users/${id}`);
  }
}
