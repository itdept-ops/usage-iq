import { CommonModule } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { forkJoin } from 'rxjs';
import type { EChartsOption } from 'echarts';

import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatMenuModule } from '@angular/material/menu';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatTableModule } from '@angular/material/table';
import { MatPaginatorModule, PageEvent } from '@angular/material/paginator';
import { MatSortModule, Sort } from '@angular/material/sort';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';

import { Api } from '../../core/api';
import { AuthService } from '../../core/auth';
import { GroupBy, IngestionSource, ModelStat, PagedResult, ProjectDto, SummaryResponse, UsageFilter, UsageRecord, PERM } from '../../core/models';
import { ChartComponent } from '../../shared/chart';
import { CompactPipe } from '../../shared/format';

@Component({
  selector: 'app-dashboard',
  imports: [
    CommonModule, FormsModule, RouterLink,
    MatCardModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatButtonModule, MatMenuModule,
    MatButtonToggleModule, MatSlideToggleModule, MatTableModule, MatPaginatorModule, MatSortModule,
    MatProgressBarModule, MatIconModule, MatTooltipModule, MatSnackBarModule,
    ChartComponent, CompactPipe,
  ],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.scss',
})
export class Dashboard {
  private api = inject(Api);
  private snack = inject(MatSnackBar);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  readonly auth = inject(AuthService);
  readonly PERM = PERM;

  // ---- filter + view state ----
  readonly filter = signal<UsageFilter>({ from: null, to: null, projectIds: [], models: [], sources: [], includeSidechain: true });
  readonly groupBy = signal<GroupBy>('day');
  readonly activePreset = signal<string>('all');
  readonly presets = [
    { key: '7d', label: '7d' }, { key: '30d', label: '30d' }, { key: '90d', label: '90d' },
    { key: 'mtd', label: 'Month' }, { key: 'all', label: 'All' },
  ] as const;
  readonly exporting = signal(false);

  readonly projects = signal<ProjectDto[]>([]);
  readonly modelStats = signal<ModelStat[]>([]);
  readonly sources = signal<IngestionSource[]>([]);
  readonly summary = signal<SummaryResponse | null>(null);
  readonly records = signal<PagedResult<UsageRecord> | null>(null);

  readonly loading = signal(false);
  readonly syncing = signal(false);

  // ---- records paging / sorting ----
  readonly page = signal(1);
  readonly pageSize = signal(25);
  readonly sort = signal('timestamp');
  readonly desc = signal(true);

  readonly displayedColumns = ['localDate', 'source', 'model', 'projectName', 'sidechain', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'totalTokens', 'costUsd'];

  constructor() {
    this.hydrateFromUrl();
    this.loadOptions();
    this.reloadAll();
  }

  /** Restore filter/groupBy/preset from the URL query params so a shared link reopens the same view. */
  private hydrateFromUrl(): void {
    const p = this.route.snapshot.queryParamMap;
    if (![...p.keys].length) return;
    const list = (k: string) => (p.get(k)?.split(',').filter(Boolean) ?? []);
    this.filter.set({
      from: p.get('from') || null,
      to: p.get('to') || null,
      projectIds: list('p').map(Number).filter(n => !Number.isNaN(n)),
      models: list('m'),
      sources: list('s'),
      includeSidechain: p.get('sc') !== '0',
    });
    if (p.get('g')) this.groupBy.set(p.get('g') as GroupBy);
    this.activePreset.set(p.get('preset') ?? '');
  }

  private shareParams(): Record<string, string> {
    const f = this.filter();
    const q: Record<string, string> = {};
    if (f.from) q['from'] = f.from;
    if (f.to) q['to'] = f.to;
    if (f.projectIds.length) q['p'] = f.projectIds.join(',');
    if (f.models.length) q['m'] = f.models.join(',');
    if (f.sources.length) q['s'] = f.sources.join(',');
    if (!f.includeSidechain) q['sc'] = '0';
    if (this.groupBy() !== 'day') q['g'] = this.groupBy();
    if (this.activePreset() && this.activePreset() !== 'all') q['preset'] = this.activePreset();
    return q;
  }

  /** Mirror the current view into the URL (replace, so it doesn't spam history). */
  private syncUrl(): void {
    this.router.navigate([], { relativeTo: this.route, queryParams: this.shareParams(), replaceUrl: true });
  }

  /** Open a small, chrome-less stats window for one source — sized for screen-share/capture. */
  popOut(source: string): void {
    window.open(`/widget/${encodeURIComponent(source)}`, `uiq-widget-${source}`, 'popup,width=440,height=360');
  }

  copyShareLink(): void {
    this.syncUrl();
    const tree = this.router.createUrlTree([], { relativeTo: this.route, queryParams: this.shareParams() });
    const url = window.location.origin + this.router.serializeUrl(tree);
    navigator.clipboard?.writeText(url).then(
      () => this.snack.open('Shareable link copied to clipboard', 'OK', { duration: 3000 }),
      () => this.snack.open('Could not copy link', 'Dismiss', { duration: 3000 }),
    );
  }

  private loadOptions(): void {
    this.api.projects().subscribe(p => this.projects.set(p));
    this.api.models().subscribe(m => this.modelStats.set(m));
    this.api.sources().subscribe(s => this.sources.set(s));
  }

  // mutate filter helpers (immutability for signal change detection)
  patch<K extends keyof UsageFilter>(key: K, value: UsageFilter[K]): void {
    this.filter.update(f => ({ ...f, [key]: value }));
  }

  applyFilters(): void {
    this.page.set(1);
    this.syncUrl();
    this.reloadAll();
  }

  setDatePreset(kind: string): void {
    const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const today = new Date();
    let from: string | null = null;
    if (kind === 'mtd') {
      from = fmt(new Date(today.getFullYear(), today.getMonth(), 1));
    } else if (kind !== 'all') {
      const days = kind === '7d' ? 6 : kind === '30d' ? 29 : 89;
      const d = new Date(today);
      d.setDate(d.getDate() - days);
      from = fmt(d);
    }
    const to = kind === 'all' ? null : fmt(today);
    this.activePreset.set(kind);
    this.filter.update(f => ({ ...f, from, to }));
    this.applyFilters();
  }

  exportCsv(): void {
    this.exporting.set(true);
    this.api.recordsCsv(this.filter()).subscribe({
      next: blob => {
        this.exporting.set(false);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `usage-iq-records-${new Date().toISOString().slice(0, 10)}.csv`;
        a.click();
        URL.revokeObjectURL(url);
      },
      error: () => { this.exporting.set(false); this.snack.open('Export failed', 'Dismiss', { duration: 4000 }); },
    });
  }

  resetFilters(): void {
    this.filter.set({ from: null, to: null, projectIds: [], models: [], sources: [], includeSidechain: true });
    this.activePreset.set('all');
    this.page.set(1);
    this.syncUrl();
    this.reloadAll();
  }

  setGroupBy(g: GroupBy): void {
    this.groupBy.set(g);
    this.syncUrl();
    this.reloadSummary();
  }

  private reloadAll(): void {
    this.loading.set(true);
    forkJoin({
      summary: this.api.summary(this.filter(), this.groupBy()),
      records: this.api.records(this.filter(), this.page(), this.pageSize(), this.sort(), this.desc()),
    }).subscribe({
      next: r => { this.summary.set(r.summary); this.records.set(r.records); this.loading.set(false); },
      error: () => { this.loading.set(false); this.snack.open('Failed to load data — is the API running?', 'Dismiss', { duration: 5000 }); },
    });
  }

  private reloadSummary(): void {
    this.api.summary(this.filter(), this.groupBy()).subscribe(s => this.summary.set(s));
  }

  private reloadRecords(): void {
    this.api.records(this.filter(), this.page(), this.pageSize(), this.sort(), this.desc())
      .subscribe(r => this.records.set(r));
  }

  onPage(e: PageEvent): void {
    this.page.set(e.pageIndex + 1);
    this.pageSize.set(e.pageSize);
    this.reloadRecords();
  }

  private static readonly SORT_MAP: Record<string, string> = {
    localDate: 'timestamp', model: 'model', inputTokens: 'input', outputTokens: 'output', costUsd: 'cost',
  };

  onSort(e: Sort): void {
    this.sort.set(e.direction ? (Dashboard.SORT_MAP[e.active] ?? 'timestamp') : 'timestamp');
    this.desc.set(e.direction !== 'asc');
    this.page.set(1);
    this.reloadRecords();
  }

  sync(): void {
    this.syncing.set(true);
    this.api.sync().subscribe({
      next: r => {
        this.syncing.set(false);
        const msg = r.error
          ? `Sync error: ${r.error}`
          : `Synced: +${r.newRecords.toLocaleString()} rows from ${r.filesParsed}/${r.filesScanned} files (${(r.durationMs / 1000).toFixed(1)}s)`;
        this.snack.open(msg, 'OK', { duration: 6000 });
        this.loadOptions();
        this.reloadAll();
      },
      error: () => { this.syncing.set(false); this.snack.open('Sync failed', 'Dismiss', { duration: 5000 }); },
    });
  }

  // ---- chart options ----
  readonly mainChart = computed<EChartsOption>(() => {
    const s = this.summary();
    if (!s || s.buckets.length === 0) return { title: { text: 'No data', left: 'center', top: 'center', textStyle: { color: '#5e6c82' } } };

    const isTime = s.groupBy === 'day' || s.groupBy === 'month';
    if (isTime) {
      const keys = s.buckets.map(b => b.key);
      return {
        tooltip: { trigger: 'axis' },
        legend: { data: ['Cost (USD)', 'Tokens'], top: 0 },
        grid: { left: 56, right: 60, top: 34, bottom: 48 },
        xAxis: { type: 'category', data: keys, axisLabel: { rotate: keys.length > 14 ? 45 : 0 } },
        yAxis: [
          { type: 'value', name: 'USD', axisLabel: { formatter: '${value}' } },
          { type: 'value', name: 'Tokens', axisLabel: { formatter: (v: number) => this.shortNum(v) } },
        ],
        series: [
          { name: 'Cost (USD)', type: 'bar', data: s.buckets.map(b => +b.costUsd.toFixed(2)), itemStyle: { color: '#f472b6', borderRadius: [4, 4, 0, 0] } },
          { name: 'Tokens', type: 'line', yAxisIndex: 1, smooth: true, symbol: 'none', data: s.buckets.map(b => b.totalTokens), itemStyle: { color: '#3fd8d0' }, lineStyle: { width: 2, color: '#3fd8d0', shadowColor: 'rgba(63,216,208,0.4)', shadowBlur: 10 } },
        ],
      };
    }

    const top = s.buckets.slice(0, 15).reverse();
    return {
      tooltip: { trigger: 'axis', valueFormatter: (v) => '$' + Number(v).toLocaleString() },
      grid: { left: 150, right: 28, top: 12, bottom: 32 },
      xAxis: { type: 'value', axisLabel: { formatter: '${value}' } },
      yAxis: { type: 'category', data: top.map(b => this.label(b.key)) },
      series: [{ type: 'bar', data: top.map(b => +b.costUsd.toFixed(2)), itemStyle: { color: '#f472b6', borderRadius: [0, 4, 4, 0] } }],
    };
  });

  readonly hasPlaceholder = computed(() => this.modelStats().some(m => m.isPlaceholderPricing && m.costUsd > 0));

  readonly modelChart = computed<EChartsOption>(() => {
    const ms = this.modelStats().filter(m => m.costUsd > 0);
    return {
      tooltip: { trigger: 'item', formatter: (p: any) => `${p.name}: $${Number(p.value).toLocaleString()} (${p.percent}%)` },
      legend: { bottom: 0, type: 'scroll' },
      series: [{
        type: 'pie', radius: ['45%', '72%'], avoidLabelOverlap: true, label: { show: false },
        itemStyle: { borderColor: '#111722', borderWidth: 2 },
        data: ms.map(m => ({ name: m.model, value: +m.costUsd.toFixed(2) })),
      }],
    };
  });

  private shortNum(v: number): string {
    if (Math.abs(v) >= 1e9) return (v / 1e9).toFixed(1) + 'B';
    if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(1) + 'K';
    return `${v}`;
  }

  private label(key: string): string {
    return key.length > 24 ? key.slice(0, 10) + '…' + key.slice(-6) : key;
  }
}
