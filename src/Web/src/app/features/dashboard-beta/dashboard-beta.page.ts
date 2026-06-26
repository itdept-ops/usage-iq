import { ChangeDetectionStrategy, Component, computed, inject, signal, viewChild } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';

import { Api } from '../../core/api';
import {
  CacheEfficiency, GroupBy, IngestionSource, MachineStat, ModelStat, PagedResult,
  ProjectDto, SummaryResponse, UsageFilter, UsageRecord,
} from '../../core/models';
import { BetaPullRefresh, BetaToaster, ToastController } from '../beta-ui';

import { PulseHeroCard } from './hero/hero-card';
import { PulseInsightCard } from './cards/insight-card';
import { PulseTrendCard } from './cards/trend-card';
import { PulseBreakdownCard, BreakdownDim, BreakdownSlice } from './cards/breakdown-card';
import { PulseEfficiencyCard } from './cards/efficiency-card';
import { PulseRecentFeed } from './cards/recent-feed';
import { PulseFilterSheet } from './sheets/filter-sheet';

const PAGE_SIZE = 25;

/**
 * Dashboard "Pulse" — the mobile-first usage-analytics cockpit, rebuilt on the shared beta-ui "Strata"
 * kit (`@use '../beta-ui/beta-kit'`). One signature accent — a vivid PINK → MAGENTA — re-skins the whole
 * screen via the per-page accent contract. An immersive scrolling header (range pills + filter), a HERO
 * spend card (big Clash Display $ + delta vs the previous period + a gradient sparkline), the kit
 * BetaSegmentedControl for Day/Month + Cost/Tokens, a gradient SVG area TREND chart, a per-model/
 * per-source/per-project BREAKDOWN (ranked accent bars + share %), a cache-efficiency BetaSvgRing +
 * BetaStatTiles, and the recent feed. Pull-to-refresh, spring-stagger entrance, BetaSkeleton loaders.
 *
 * DATA PARITY: every figure is sourced from the SAME endpoints the live page uses — `Api.summary`
 * (hero totals + trend buckets + breakdown), `Api.records` (recent feed), `Api.cacheEfficiency`
 * (cache cockpit). The headline delta uses a SECOND `Api.summary` over the prior equivalent window
 * (computed from the active range). The server does all dedup + sidechain aggregation; this page never
 * re-aggregates client-side. The deep-link query scheme (`from/to/p/m/s/mc/sc/g/preset`) mirrors the
 * live page so shared links interoperate.
 *
 * ISOLATION: gated by `beta.access`; consumes the kit + the SAME read-only Api as /dashboard. No live
 * page is imported or modified; the flagship tracker-beta + the kit are consumed, never changed.
 */
@Component({
  selector: 'app-dashboard-beta',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [ToastController],
  imports: [
    MatIconModule, BetaPullRefresh, BetaToaster,
    PulseHeroCard, PulseInsightCard, PulseTrendCard, PulseBreakdownCard, PulseEfficiencyCard, PulseRecentFeed, PulseFilterSheet,
  ],
  template: `
    <app-bs-pull-refresh class="pb-ptr" [busy]="refreshing()" (refresh)="refreshAll()">
      <div class="pb-scroll">

        <!-- Immersive header: title + accent bloom, range pills, filter button. -->
        <header class="hh">
          <div class="hh__bloom" aria-hidden="true"></div>
          <div class="hh__row">
            <div class="hh__text">
              <span class="hh__eyebrow">Usage</span>
              <h1 class="hh__title">Spend Pulse</h1>
            </div>
            <button type="button" class="hh__filter" (click)="openFilter()" aria-label="Filters">
              <mat-icon aria-hidden="true">tune</mat-icon>
              @if (activeFilterCount()) { <span class="hh__filter-badge">{{ activeFilterCount() }}</span> }
            </button>
          </div>

          <div class="hh__pills" role="radiogroup" aria-label="Date range">
            @for (p of presets; track p.key) {
              <button type="button" class="pill" [class.pill--on]="activePreset() === p.key"
                      role="radio" [attr.aria-checked]="activePreset() === p.key"
                      (click)="setDatePreset(p.key)">{{ p.label }}</button>
            }
          </div>
        </header>

        <!-- Staggered spring entrance: each block animates in on a per-index delay (--i). -->
        <div class="rise" [style.--i]="0">
          <app-pulse-hero
            [summary]="summary()" [prevSummary]="prevSummary()" [cacheEff]="cacheEff()"
            [loading]="loading()" [rangeLabel]="rangeLabel()" [prevLabel]="prevLabel()" />
        </div>

        @if (showInsights()) {
          <div class="rise pb-card" [style.--i]="1">
            <app-pulse-insight [summary]="summary()" [cacheEff]="cacheEff()" [loading]="loading()" />
          </div>
        }

        <div class="rise pb-card" [style.--i]="1">
          <app-pulse-trend
            [summary]="summary()" [loading]="loading()" [groupBy]="groupBy()"
            (groupByChange)="setGroupBy($event)" (widen)="setDatePreset('all')" />
        </div>

        <div class="rise pb-card pb-defer" [style.--i]="2">
          <app-pulse-breakdown
            [slices]="breakdownSlices()" [dim]="breakdownDim()" [loading]="loading()"
            (dimChange)="setBreakdownDim($event)" (widen)="setDatePreset('all')" />
        </div>

        @if (showEfficiency()) {
          <div class="rise pb-card pb-defer" [style.--i]="3">
            <app-pulse-efficiency [cacheEff]="cacheEff()" [summary]="summary()" [loading]="loading()" />
          </div>
        }

        <div class="rise pb-card pb-defer" [style.--i]="4">
          <app-pulse-recent
            [page]="records()" [loading]="loading()" [loadingMore]="loadingMore()"
            (more)="loadMore()" (widen)="setDatePreset('all')" />
        </div>
      </div>
    </app-bs-pull-refresh>

    <app-pulse-filter-sheet #sheet
      [(open)]="filterOpen"
      [projects]="projects()" [models]="modelStats()" [sources]="sources()" [machines]="machines()"
      [filter]="filter()" [groupBy]="groupBy()"
      (applied)="onApplyFilters($event)" />

    <app-bs-toaster />
  `,
  styleUrl: './dashboard-beta.page.scss',
})
export class DashboardBetaPage {
  private api = inject(Api);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private toast = inject(ToastController);
  private readonly sheet = viewChild.required(PulseFilterSheet);

  // ---- filter + view state (shapes copied from the live dashboard for parity) ----
  readonly filter = signal<UsageFilter>({ from: null, to: null, projectIds: [], models: [], sources: [], machine: [], includeSidechain: true });
  readonly groupBy = signal<GroupBy>('day');
  readonly activePreset = signal<string>('all');
  readonly presets = [
    { key: '7d', label: '7d' }, { key: '30d', label: '30d' }, { key: '90d', label: '90d' },
    { key: 'mtd', label: 'Month' }, { key: 'all', label: 'All' },
  ] as const;

  // ---- option catalogs (for the filter sheet) ----
  readonly projects = signal<ProjectDto[]>([]);
  readonly modelStats = signal<ModelStat[]>([]);
  readonly sources = signal<IngestionSource[]>([]);
  readonly machines = signal<MachineStat[]>([]);

  // ---- data ----
  readonly summary = signal<SummaryResponse | null>(null);
  /** Prior equivalent-period summary, for the hero delta. Null when the range has no prior window. */
  readonly prevSummary = signal<SummaryResponse | null>(null);
  readonly records = signal<PagedResult<UsageRecord> | null>(null);
  readonly cacheEff = signal<CacheEfficiency | null>(null);
  /** Per-dimension breakdown summary (grouped by model/source/project via the SAME summary endpoint). */
  readonly breakdownSummary = signal<SummaryResponse | null>(null);

  readonly loading = signal(false);
  readonly loadingMore = signal(false);
  readonly refreshing = signal(false);

  readonly page = signal(1);

  // ---- filter sheet ----
  readonly filterOpen = signal(false);

  // ---- breakdown dimension (local flip, fetched on change) ----
  readonly breakdownDim = signal<BreakdownDim>('model');

  /** Count of non-default filter constraints, shown as a badge on the filter button. */
  readonly activeFilterCount = computed(() => {
    const f = this.filter();
    return f.projectIds.length + f.models.length + f.sources.length + f.machine.length + (f.includeSidechain ? 0 : 1);
  });

  readonly rangeLabel = computed(() => {
    const key = this.activePreset();
    const found = this.presets.find(p => p.key === key);
    if (found && key !== 'all') return found.label === 'Month' ? 'This month' : `Last ${found.label}`;
    const f = this.filter();
    if (f.from && f.to) return `${f.from} → ${f.to}`;
    return 'All time';
  });

  /** Human label for the prior comparison window (hero delta tooltip). */
  readonly prevLabel = computed(() => {
    const key = this.activePreset();
    if (key === 'mtd') return 'last month';
    const found = this.presets.find(p => p.key === key);
    if (found && key !== 'all') return `the previous ${found.label}`;
    return 'the previous period';
  });

  /**
   * Show the insights card only when its Top-day insight reads a real DATE (the 'day' grouping, so the
   * bucket key is YYYY-MM-DD — never a month label) AND there's at least one cost-bearing day or some
   * cache activity to surface. Hidden otherwise so the card never shows an empty or mislabelled insight.
   */
  readonly showInsights = computed(() => {
    if (this.groupBy() !== 'day') return false;
    const buckets = this.summary()?.buckets ?? [];
    const hasTopDay = buckets.some(b => b.costUsd > 0);
    const c = this.cacheEff();
    const reads = c?.cacheReadTokens ?? this.summary()?.total?.cacheReadTokens ?? 0;
    const hasCache = reads > 0;
    return hasTopDay || hasCache;
  });

  /** Show the efficiency card only when there's cache activity (degrade gracefully otherwise). */
  readonly showEfficiency = computed(() => {
    const c = this.cacheEff();
    if (!c) return false;
    return !(c.cacheReadTokens === 0 && c.inputTokens === 0 && c.cacheWriteTokens === 0);
  });

  /** Breakdown slices for the active dimension, mapped from the SAME server summary buckets. */
  readonly breakdownSlices = computed<BreakdownSlice[]>(() => {
    const s = this.breakdownSummary();
    if (!s) return [];
    const dim = this.breakdownDim();
    // Model dimension can carry the placeholder-pricing flag from the models catalog.
    const placeholderByModel = new Map(this.modelStats().map(m => [m.model, m.isPlaceholderPricing]));
    return s.buckets
      .map(b => ({
        name: b.key,
        costUsd: b.costUsd,
        estimated: dim === 'model' ? (placeholderByModel.get(b.key) ?? false) : false,
        // Full bucket totals carried through so the detail sheet needs NO second fetch.
        totalTokens: b.totalTokens,
        inputTokens: b.inputTokens,
        outputTokens: b.outputTokens,
        cacheReadTokens: b.cacheReadTokens,
        cacheWriteTokens: b.cacheCreation5mTokens + b.cacheCreation1hTokens,
        records: b.records,
      }))
      .sort((a, b) => b.costUsd - a.costUsd);
  });

  constructor() {
    this.hydrateFromUrl();
    this.loadOptions();
    this.reloadAll();
    this.reloadBreakdown();
  }

  // ---- URL deep-linking (same query scheme as the live dashboard) ----
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
      machine: list('mc'),
      includeSidechain: p.get('sc') !== '0',
    });
    if (p.get('g')) this.groupBy.set(p.get('g') as GroupBy);
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
    if (f.machine.length) q['mc'] = f.machine.join(',');
    if (!f.includeSidechain) q['sc'] = '0';
    if (this.groupBy() !== 'day') q['g'] = this.groupBy();
    if (this.activePreset() && this.activePreset() !== 'all') q['preset'] = this.activePreset();
    return q;
  }

  private syncUrl(): void {
    this.router.navigate([], { relativeTo: this.route, queryParams: this.shareParams(), replaceUrl: true });
  }

  // ---- range pills (apply instantly) ----
  setDatePreset(kind: string): void {
    // Local-date formatter copied VERBATIM from the live dashboard so ranges match exactly
    // (never toISOString, which would shift the boundary across timezones).
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
    this.applyAndReload();
  }

  // ---- filter sheet ----
  openFilter(): void {
    // Seed the sheet's draft from the committed filter, then open.
    this.sheet().seed();
    this.filterOpen.set(true);
  }

  onApplyFilters(e: { filter: UsageFilter; groupBy: GroupBy }): void {
    this.filter.set(e.filter);
    this.groupBy.set(e.groupBy);
    // A manual filter selection clears the named-preset highlight unless it's still all-time.
    const f = e.filter;
    if (!f.from && !f.to) {
      if (this.activePreset() !== 'all') this.activePreset.set('all');
    } else {
      this.activePreset.set('');
    }
    this.applyAndReload();
  }

  private applyAndReload(): void {
    this.page.set(1);
    this.syncUrl();
    this.reloadAll();
    this.reloadBreakdown();
  }

  // ---- trend groupBy toggle (only the summary refetches) ----
  setGroupBy(g: GroupBy): void {
    this.groupBy.set(g);
    this.syncUrl();
    this.reloadSummary();
  }

  // ---- breakdown dimension toggle (only the breakdown summary refetches) ----
  setBreakdownDim(dim: BreakdownDim): void {
    this.breakdownDim.set(dim);
    this.reloadBreakdown();
  }

  /**
   * Build the prior equivalent-period filter: shift [from,to] back by its own length. Returns null
   * when the active range is open-ended (all-time / one-sided), in which case there's no comparison.
   */
  private priorFilter(): UsageFilter | null {
    const f = this.filter();
    if (!f.from || !f.to) return null;
    const from = new Date(`${f.from}T00:00:00`);
    const to = new Date(`${f.to}T00:00:00`);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
    const dayMs = 86400000;
    const lenDays = Math.round((to.getTime() - from.getTime()) / dayMs) + 1; // inclusive span
    const prevTo = new Date(from.getTime() - dayMs);
    const prevFrom = new Date(prevTo.getTime() - (lenDays - 1) * dayMs);
    const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return { ...f, from: fmt(prevFrom), to: fmt(prevTo) };
  }

  // ---- data loads ----
  private loadOptions(): void {
    this.api.projects().subscribe({ next: p => this.projects.set(p), error: () => { /* non-critical */ } });
    this.api.models().subscribe({ next: m => this.modelStats.set(m), error: () => { /* non-critical */ } });
    this.api.sources().subscribe({ next: s => this.sources.set(s), error: () => { /* non-critical */ } });
    this.api.machines().subscribe({ next: m => this.machines.set(m), error: () => { /* non-critical */ } });
  }

  private reloadAll(): void {
    this.loading.set(true);
    const prior = this.priorFilter();
    forkJoin({
      summary: this.api.summary(this.filter(), this.groupBy()),
      records: this.api.records(this.filter(), 1, PAGE_SIZE, 'timestamp', true),
      cacheEff: this.api.cacheEfficiency(this.filter()).pipe(catchError(() => of<CacheEfficiency | null>(null))),
      // Prior-period summary for the delta — best-effort (null when no prior window or it errors).
      prev: prior ? this.api.summary(prior, this.groupBy()).pipe(catchError(() => of<SummaryResponse | null>(null))) : of<SummaryResponse | null>(null),
    }).subscribe({
      next: r => {
        this.summary.set(r.summary);
        this.records.set(r.records);
        this.cacheEff.set(r.cacheEff);
        this.prevSummary.set(r.prev);
        this.loading.set(false);
      },
      // If the critical streams fail, still clear loading so the cards show their resolved-empty state,
      // then best-effort retry the two essential streams alone.
      error: () => {
        this.loading.set(false);
        this.api.summary(this.filter(), this.groupBy()).subscribe({ next: s => this.summary.set(s), error: () => {} });
        this.api.records(this.filter(), 1, PAGE_SIZE, 'timestamp', true).subscribe({ next: rec => this.records.set(rec), error: () => {} });
        this.cacheEff.set(null);
        this.prevSummary.set(null);
      },
    });
  }

  private reloadSummary(): void {
    this.api.summary(this.filter(), this.groupBy()).subscribe({
      next: s => this.summary.set(s),
      error: () => { /* keep prior chart */ },
    });
  }

  /** Fetch the breakdown using the SAME summary endpoint, grouped by the active dimension. */
  private reloadBreakdown(): void {
    this.api.summary(this.filter(), this.breakdownDim()).subscribe({
      next: s => this.breakdownSummary.set(s),
      error: () => { /* keep prior breakdown */ },
    });
  }

  /** Pull-to-refresh: re-run all data loads. Flips the spinner + confirms with a toast. */
  async refreshAll(): Promise<void> {
    this.refreshing.set(true);
    const prior = this.priorFilter();
    forkJoin({
      summary: this.api.summary(this.filter(), this.groupBy()).pipe(catchError(() => of<SummaryResponse | null>(null))),
      records: this.api.records(this.filter(), 1, PAGE_SIZE, 'timestamp', true).pipe(catchError(() => of<PagedResult<UsageRecord> | null>(null))),
      cacheEff: this.api.cacheEfficiency(this.filter()).pipe(catchError(() => of<CacheEfficiency | null>(null))),
      breakdown: this.api.summary(this.filter(), this.breakdownDim()).pipe(catchError(() => of<SummaryResponse | null>(null))),
      prev: prior ? this.api.summary(prior, this.groupBy()).pipe(catchError(() => of<SummaryResponse | null>(null))) : of<SummaryResponse | null>(null),
    }).subscribe({
      next: r => {
        if (r.summary) this.summary.set(r.summary);
        if (r.records) this.records.set(r.records);
        this.cacheEff.set(r.cacheEff);
        if (r.breakdown) this.breakdownSummary.set(r.breakdown);
        this.prevSummary.set(r.prev);
        this.page.set(1);
        this.refreshing.set(false);
        this.toast.show('Usage refreshed', { tone: 'success', durationMs: 1800 });
      },
      error: () => {
        this.refreshing.set(false);
        this.toast.show('Couldn’t refresh — pull again', { tone: 'warn' });
      },
    });
  }

  // ---- infinite scroll: append the next records page ----
  loadMore(): void {
    const cur = this.records();
    if (!cur || this.loadingMore()) return;
    if (cur.page >= Math.ceil(cur.total / cur.pageSize)) return;
    const next = cur.page + 1;
    this.loadingMore.set(true);
    this.api.records(this.filter(), next, PAGE_SIZE, 'timestamp', true).subscribe({
      next: r => {
        this.records.set({ ...r, items: [...cur.items, ...r.items] });
        this.page.set(next);
        this.loadingMore.set(false);
      },
      error: () => this.loadingMore.set(false),
    });
  }
}
