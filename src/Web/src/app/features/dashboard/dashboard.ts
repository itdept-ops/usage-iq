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
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
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
import { ShareDialog } from '../share/share-dialog';
import { AuthService } from '../../core/auth';
import { CacheEfficiency, CalendarDay, GroupBy, IngestionSource, ModelStat, PagedResult, ProjectDto, SavedView, SummaryResponse, UsageFilter, UsageRecord, PERM } from '../../core/models';
import { ChartComponent } from '../../shared/chart';
import { CompactPipe } from '../../shared/format';

@Component({
  selector: 'app-dashboard',
  imports: [
    CommonModule, FormsModule, RouterLink,
    MatCardModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatButtonModule, MatMenuModule, MatDialogModule,
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
  private dialog = inject(MatDialog);
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

  // Cache-efficiency rollup — reactive to the current filter (refetched on every Apply/reload).
  readonly cacheEff = signal<CacheEfficiency | null>(null);

  // ---- saved views (per-user) ----
  readonly savedViews = signal<SavedView[]>([]);
  readonly savingView = signal(false);
  // Inline rename state for the views menu.
  readonly renamingViewId = signal<number | null>(null);
  readonly renameDraft = signal('');

  readonly loading = signal(false);
  readonly syncing = signal(false);

  // ---- records paging / sorting ----
  readonly page = signal(1);
  readonly pageSize = signal(25);
  readonly sort = signal('timestamp');
  readonly desc = signal(true);

  readonly displayedColumns = ['localDate', 'source', 'model', 'projectName', 'sidechain', 'inputTokens', 'outputTokens', 'totalTokens', 'costUsd'];

  // Estimated active engagement time (gap-based) for the current filter — per-day, from the calendar.
  readonly calendarDays = signal<CalendarDay[]>([]);
  readonly activeHours = computed(() => this.calendarDays().reduce((a, d) => a + d.activeMinutes, 0) / 60);

  // Cache-efficiency derived figures. Empty state = no input and no cache reads in the range.
  readonly cachePct = computed(() => Math.round((this.cacheEff()?.cacheReadRatio ?? 0) * 100));
  readonly cacheEmpty = computed(() => {
    const c = this.cacheEff();
    return !c || (c.cacheReadTokens === 0 && c.inputTokens === 0 && c.cacheWriteTokens === 0);
  });

  constructor() {
    this.hydrateFromUrl();
    this.loadOptions();
    // Always fetch on init so every panel (usage-over-time, cost-by-model, messages) is
    // populated on first paint — no manual Apply required. The default filter is an
    // all-time range (from/to null), which the API treats as "all data", matching the
    // "All" quick-range that is highlighted by default.
    this.reloadAll();
  }

  /**
   * Restore filter/groupBy/preset from the URL query params so a shared link reopens the same view.
   * When the URL carries no usable range we keep the all-time default and leave the "All" chip
   * highlighted, so a fresh/bookmark-less visit still shows existing data immediately.
   */
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
    // The URL only carries an explicit preset for non-"all" ranges. If none is present we are on
    // the all-time view, so fall back to 'all' (not blank) to keep the chip highlighted and the
    // default state self-consistent — otherwise no quick-range reads as active on load.
    this.activePreset.set(p.get('preset') || 'all');
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

  /** Open the external-share dialog (public, token-based, time-limited links). */
  openShare(): void {
    this.dialog.open(ShareDialog, {
      data: { filter: this.filter(), groupBy: this.groupBy() },
      width: '560px', maxWidth: '94vw', autoFocus: false,
    });
  }


  /** Build the upsert payload from the CURRENT dashboard state (filter + groupBy). */
  private viewPayload(name: string) {
    const f = this.filter();
    return {
      name,
      from: f.from, to: f.to,
      projectId: f.projectIds, model: f.models, source: f.sources,
      includeSidechain: f.includeSidechain, groupBy: this.groupBy(),
    };
  }

  /** Save the current filter set as a named view (upsert-by-name on the server). */
  saveCurrentView(): void {
    const name = (prompt('Save current filters as a view named:') ?? '').trim();
    if (!name) return;
    this.savingView.set(true);
    this.api.saveView(this.viewPayload(name)).subscribe({
      next: v => {
        this.savingView.set(false);
        // Upsert-by-name: replace if it already exists, else append; keep sorted by name.
        this.savedViews.update(list => {
          const rest = list.filter(x => x.id !== v.id && x.name.toLowerCase() !== v.name.toLowerCase());
          return [...rest, v].sort((a, b) => a.name.localeCompare(b.name));
        });
        this.snack.open(`Saved view “${v.name}”`, 'OK', { duration: 2500 });
      },
      error: () => { this.savingView.set(false); this.snack.open('Could not save view', 'Dismiss', { duration: 4000 }); },
    });
  }

  /** Load a saved view's filters + groupBy into dashboard state and apply through the normal path. */
  applyView(v: SavedView): void {
    this.filter.set({
      from: v.from, to: v.to,
      projectIds: [...v.projectId], models: [...v.model], sources: [...v.source],
      includeSidechain: v.includeSidechain,
    });
    this.groupBy.set((v.groupBy || 'day') as GroupBy);
    // A saved view carries an explicit range, so it's no longer the all-time quick-range.
    this.activePreset.set(v.from || v.to ? '' : 'all');
    this.applyFilters();
    this.snack.open(`Applied “${v.name}”`, 'OK', { duration: 2000 });
  }

  startRename(v: SavedView, ev: Event): void {
    ev.stopPropagation();
    this.renamingViewId.set(v.id);
    this.renameDraft.set(v.name);
  }

  cancelRename(ev?: Event): void {
    ev?.stopPropagation();
    this.renamingViewId.set(null);
  }

  /** Commit a rename — reuses the view's stored filter payload, only the name changes. */
  commitRename(v: SavedView, ev?: Event): void {
    ev?.stopPropagation();
    const name = this.renameDraft().trim();
    if (!name || name === v.name) { this.renamingViewId.set(null); return; }
    this.api.updateView(v.id, {
      name,
      from: v.from, to: v.to,
      projectId: v.projectId, model: v.model, source: v.source,
      includeSidechain: v.includeSidechain, groupBy: v.groupBy,
    }).subscribe({
      next: updated => {
        this.renamingViewId.set(null);
        this.savedViews.update(list =>
          list.map(x => x.id === updated.id ? updated : x).sort((a, b) => a.name.localeCompare(b.name)));
      },
      error: () => this.snack.open('Rename failed', 'Dismiss', { duration: 4000 }),
    });
  }

  deleteView(v: SavedView, ev: Event): void {
    ev.stopPropagation();
    if (!confirm(`Delete the saved view “${v.name}”?`)) return;
    this.api.deleteView(v.id).subscribe({
      next: () => this.savedViews.update(list => list.filter(x => x.id !== v.id)),
      error: () => this.snack.open('Could not delete view', 'Dismiss', { duration: 4000 }),
    });
  }

  private loadOptions(): void {
    this.api.projects().subscribe(p => this.projects.set(p));
    this.api.models().subscribe(m => this.modelStats.set(m));
    this.api.sources().subscribe(s => this.sources.set(s));
    this.loadSavedViews();
  }

  private loadSavedViews(): void {
    this.api.savedViews().subscribe({ next: v => this.savedViews.set(v), error: () => { /* non-critical */ } });
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
      calendar: this.api.calendar(this.filter()),
      cacheEff: this.api.cacheEfficiency(this.filter()),
    }).subscribe({
      next: r => {
        this.summary.set(r.summary);
        this.records.set(r.records);
        this.calendarDays.set(r.calendar);
        this.cacheEff.set(r.cacheEff);
        this.loading.set(false);
      },
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
    // While the first fetch is in flight (summary still null, or a reload running) show a neutral
    // "Loading…" placeholder rather than "No data", so a fresh visit never reads as empty before
    // the data has actually arrived. "No data" is reserved for a resolved-but-empty result.
    if (!s) {
      const text = this.loading() ? 'Loading…' : 'No data';
      return { title: { text, left: 'center', top: 'center', textStyle: { color: '#5e6c82' } } };
    }
    if (s.buckets.length === 0) return { title: { text: 'No data', left: 'center', top: 'center', textStyle: { color: '#5e6c82' } } };

    const isTime = s.groupBy === 'day' || s.groupBy === 'month';
    if (isTime) {
      const keys = s.buckets.map(b => b.key);
      // Active hours per bucket, from the calendar data (exact day, or summed across the month).
      const cal = this.calendarDays();
      const dayMins = new Map(cal.map(d => [d.date, d.activeMinutes]));
      const hours = keys.map(k => {
        const mins = s.groupBy === 'day'
          ? (dayMins.get(k) ?? 0)
          : cal.reduce((a, d) => a + (d.date.startsWith(k) ? d.activeMinutes : 0), 0);
        return +(mins / 60).toFixed(1);
      });

      return {
        tooltip: { trigger: 'axis' },
        legend: { data: ['Cost (USD)', 'Tokens', 'Active hours'], top: 0 },
        grid: { left: 56, right: 104, top: 34, bottom: 48 },
        xAxis: { type: 'category', data: keys, axisLabel: { rotate: keys.length > 14 ? 45 : 0 } },
        yAxis: [
          { type: 'value', name: 'USD', position: 'left', axisLabel: { formatter: '${value}' } },
          { type: 'value', name: 'Tokens', position: 'right', axisLabel: { formatter: (v: number) => this.shortNum(v) } },
          { type: 'value', name: 'Hours', position: 'right', offset: 52, splitLine: { show: false }, axisLabel: { formatter: '{value}h' } },
        ],
        series: [
          { name: 'Cost (USD)', type: 'bar', data: s.buckets.map(b => +b.costUsd.toFixed(2)), itemStyle: { color: '#f472b6', borderRadius: [4, 4, 0, 0] } },
          { name: 'Tokens', type: 'line', yAxisIndex: 1, smooth: true, symbol: 'none', data: s.buckets.map(b => b.totalTokens), itemStyle: { color: '#3fd8d0' }, lineStyle: { width: 2, color: '#3fd8d0', shadowColor: 'rgba(63,216,208,0.4)', shadowBlur: 10 } },
          { name: 'Active hours', type: 'line', yAxisIndex: 2, smooth: true, symbol: 'none', data: hours, itemStyle: { color: '#f2b340' }, lineStyle: { width: 2, color: '#f2b340', type: 'dashed' } },
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
