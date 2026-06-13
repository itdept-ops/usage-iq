import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import {
  GroupBy, ModelStat, PagedResult, Pricing, ProjectDto,
  Settings, SummaryResponse, SyncResult, UsageFilter, UsageRecord,
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

  settings(): Observable<Settings> {
    return this.http.get<Settings>(`${this.base}/settings`);
  }

  saveSettings(dto: Settings): Observable<unknown> {
    return this.http.put(`${this.base}/settings`, dto);
  }

  sync(): Observable<SyncResult> {
    return this.http.post<SyncResult>(`${this.base}/sync`, {});
  }
}
