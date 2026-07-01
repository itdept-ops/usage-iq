import {
  ChangeDetectionStrategy, Component, computed, inject, signal,
} from '@angular/core';
import { forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { MatIconModule } from '@angular/material/icon';
import type { EChartsOption } from 'echarts';

import { Api } from '../../core/api';
import {
  CalendarDay, HeatmapCell, SessionDetail, SummaryBucket, UsageFilter, UsageStats,
} from '../../core/models';
import { ChartComponent } from '../../shared/chart';
import {
  BetaBottomSheet, BetaPullRefresh, BetaSegmentedControl, BetaSkeleton, BetaStatTile,
  type Segment,
} from '../beta-ui';

/** The metric the activity strip + busiest-day reading colours by. */
type Metric = 'cost' | 'tokens' | 'hours';

/** A single bar in the recent-activity strip (one calendar day). */
interface DayBar {
  readonly day: CalendarDay;
  /** 0..1 of the busiest day in the window, for the bar height. */
  readonly frac: number;
  /** Weekday initial (M/T/W…) for the axis tick. */
  readonly dow: string;
  /** Short numeric day-of-month label. */
  readonly dom: string;
  /** True for today's column (subtle highlight). */
  readonly isToday: boolean;
}

/** One cell in the hour×weekday heatmap. */
interface HeatCell {
  readonly weekday: number;
  readonly hour: number;
  readonly count: number;
  /** 0..1 of the busiest cell, for the tint intensity. */
  readonly frac: number;
}

/** One weekday row (24 hour cells) in the hour×weekday heatmap. */
interface HeatRow {
  readonly weekday: number;
  readonly dow: string;
  readonly cells: HeatCell[];
}

/**
 * Calendar "Activity" — the mobile-first twin of the live `/calendar` page, rebuilt on the shared
 * beta-ui "Strata" kit (`@use '../beta-ui/beta-kit'`). One signature accent — a cool CYAN → INDIGO —
 * re-skins the whole screen via the per-page accent contract.
 *
 * The heavy full-calendar echarts view doesn't read on a phone, so this twin favours compact,
 * glanceable surfaces: an immersive header with a Cost / Tokens / Active-hours
 * {@link BetaSegmentedControl}; the four headline {@link BetaStatTile}s (total active time, avg/active
 * day + busiest-day sub-label, sessions, total spend) plus an efficiency row (when `stats` resolves)
 * carrying avg-session and most-active-weekday sub-labels; a horizontally-scrolling RECENT-ACTIVITY
 * strip of pure-CSS day bars coloured by the active metric; a "WHEN YOU WORK" hour×weekday heatmap
 * (pure-CSS 7×24 grid from the heatmap cells); and a TOP-SESSIONS list. Tapping a session opens a
 * {@link BetaBottomSheet} that lazily fetches {@link Api.session} and shows the per-message drill-down
 * (start/end timestamps, a cumulative-cost step-line {@link ChartComponent}, and model · tokens · cost
 * per message to 4 decimals) — mirroring the live SessionDialog. Pull-to-refresh re-fetches everything.
 *
 * DATA PARITY: every figure comes from the SAME endpoints the live page calls — {@link Api.calendar}
 * (per-day rollup), {@link Api.stats} (active-time / streak stats), {@link Api.heatmap} (hour×weekday
 * cells, rendered as the full 7×24 grid), {@link Api.summary} grouped by `session`
 * (top sessions) and {@link Api.session} (the drill-down). No client-side re-aggregation; the server
 * does all dedup + sidechain handling. The all-time filter matches the live page VERBATIM.
 *
 * ISOLATION: gated by `platform.mobile` + the SAME `calendar.view` the live `/calendar` route carries;
 * consumes the kit + the SAME read-only Api as the live counterpart. No live page is imported or
 * modified. Degrades gracefully — loading skeletons, empty + error states — so the API-mocked
 * screenshot harness renders cleanly with zero data. Mobile-first (44px targets, safe-area insets),
 * centres on desktop; reduced-motion handled by the kit a11y killswitch.
 */
@Component({
  selector: 'app-calendar-mobile',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './calendar-mobile.page.scss',
  imports: [
    MatIconModule, ChartComponent,
    BetaPullRefresh, BetaSegmentedControl, BetaStatTile, BetaSkeleton, BetaBottomSheet,
  ],
  template: `
    <app-bs-pull-refresh class="cm-ptr" [busy]="refreshing()" (refresh)="reload()">
      <div class="cm-scroll" aria-live="polite">

        <!-- ─── IMMERSIVE HEADER: title + metric switch ─── -->
        <header class="cm-hero">
          <p class="cm-hero__eyebrow"><mat-icon aria-hidden="true">calendar_month</mat-icon> Activity</p>
          <h1 class="cm-hero__title">Usage calendar</h1>
          <p class="cm-hero__sub">Spend, messages &amp; active time — gaps over 30&nbsp;min count as idle.</p>

          <div class="cm-seg-wrap">
            <app-bs-segmented class="cm-seg"
              [segments]="metricSegments" [value]="metric()" label="Colour activity by"
              (change)="setMetric($event)" />
          </div>
        </header>

        <!-- ─── HEADLINE STAT TILES ─── -->
        @if (loading()) {
          <div class="cm-tiles">
            @for (n of skeletonTiles; track n) {
              <app-bs-skeleton height="84px" radius="var(--r-tile)" />
            }
          </div>
        } @else if (errored()) {
          <div class="cm-state">
            <span class="cm-state__orb"><mat-icon aria-hidden="true">error_outline</mat-icon></span>
            <h2 class="cm-state__title">Couldn't load your calendar</h2>
            <p class="cm-state__body">Something went wrong fetching your activity. Give it another go.</p>
            <button type="button" class="cm-state__cta" (click)="reload()">
              <mat-icon aria-hidden="true">refresh</mat-icon> Try again
            </button>
          </div>
        } @else {
          <div class="cm-tiles">
            <app-bs-stat-tile
              [value]="fmtInt(stats().totalHours)" unit="h" label="Active time"
              [ringValue]="null" />
            <div class="cm-tile-wrap">
              <app-bs-stat-tile
                [value]="fmt1(stats().avgHoursPerDay)" unit="h" label="Avg / active day" />
              <span class="cm-tile-sub">busiest {{ fmt1(stats().maxDayHours) }}h / day</span>
            </div>
            <app-bs-stat-tile
              [value]="fmtCompact(stats().totalSessions)" label="Sessions" />
            <app-bs-stat-tile
              [value]="'$' + fmtInt(stats().totalCost)" label="Total spend" />
          </div>

          <p class="cm-context">
            {{ stats().activeDays }} active {{ stats().activeDays === 1 ? 'day' : 'days' }}
            @if (stats().busiest; as b) { · peak {{ b.date }} ({{ peakReading(b) }}) }
            · {{ fmtCompact(stats().totalMsgs) }} messages
          </p>

          <!-- ─── EFFICIENCY / STREAK ROW (only when stats resolves) ─── -->
          @if (metrics(); as m) {
            <div class="cm-tiles cm-tiles--2">
              <app-bs-stat-tile [value]="'$' + fmtInt(m.costPerActiveHour)" label="$ / active hour" />
              <div class="cm-tile-wrap">
                <app-bs-stat-tile [value]="fmtInt(m.longestSessionMinutes)" unit="m" label="Longest session" />
                <span class="cm-tile-sub">avg {{ fmtInt(m.avgSessionMinutes) }}m / session</span>
              </div>
              <app-bs-stat-tile [value]="fmtInt(m.currentStreakDays)" unit="d" label="Current streak" />
              <div class="cm-tile-wrap">
                <app-bs-stat-tile [value]="m.busiestHour >= 0 ? fmtHour(m.busiestHour) : '0'" label="Busiest hour" />
                @if (mostActiveWeekday(); as wd) { <span class="cm-tile-sub">most active {{ wd }}</span> }
              </div>
            </div>
          }

          <!-- ─── RECENT ACTIVITY STRIP: pure-CSS day bars ─── -->
          @if (recentBars().length) {
            <section class="cm-card">
              <div class="cm-card__head">
                <h2 class="cm-card__title">Recent activity</h2>
                <span class="cm-card__hint">last {{ recentBars().length }} days · {{ metricLabel() }}</span>
              </div>
              <div class="cm-bars" role="img" [attr.aria-label]="recentAria()">
                @for (b of recentBars(); track b.day.date) {
                  <span class="cm-bar" [class.is-today]="b.isToday"
                        [class.is-zero]="b.day.messages === 0">
                    <span class="cm-bar__track">
                      <span class="cm-bar__fill" [style.height.%]="b.frac * 100"></span>
                    </span>
                    <span class="cm-bar__dom">{{ b.dom }}</span>
                    <span class="cm-bar__dow">{{ b.dow }}</span>
                  </span>
                }
              </div>
            </section>
          }

          <!-- ─── WHEN YOU WORK: hour × weekday heatmap (full 24h × 7-weekday grid) ─── -->
          @if (heatGrid().length) {
            <section class="cm-card">
              <div class="cm-card__head">
                <h2 class="cm-card__title">When you work</h2>
                <span class="cm-card__hint">messages · hour × weekday</span>
              </div>
              <div class="cm-heat" role="img" [attr.aria-label]="hourAria()">
                @for (row of heatGrid(); track row.weekday) {
                  <span class="cm-heat__dow" aria-hidden="true">{{ row.dow }}</span>
                  <span class="cm-heat__row">
                    @for (c of row.cells; track c.hour) {
                      <span class="cm-heat__cell"
                            [class.is-peak]="c.weekday === peakCell().weekday && c.hour === peakCell().hour"
                            [style.--i]="c.frac"></span>
                    }
                  </span>
                }
              </div>
              <div class="cm-heat__axis" aria-hidden="true">
                <span>12a</span><span>6a</span><span>12p</span><span>6p</span><span>11p</span>
              </div>
            </section>
          }

          <!-- ─── TOP SESSIONS → drill-down sheet ─── -->
          <section class="cm-card">
            <div class="cm-card__head">
              <h2 class="cm-card__title">Top sessions</h2>
              <span class="cm-card__hint">tap to drill in</span>
            </div>
            @if (!sessions().length) {
              <div class="cm-empty">
                <span class="cm-empty__orb"><mat-icon aria-hidden="true">history</mat-icon></span>
                <p class="cm-empty__title">No sessions yet</p>
                <p class="cm-empty__hint">They'll appear here as you log usage.</p>
              </div>
            } @else {
              <ul class="cm-sess">
                @for (s of sessions(); track s.key) {
                  <li>
                    <button type="button" class="cm-sess__row" (click)="openSession(s.key)"
                            [attr.aria-label]="sessionAria(s)">
                      <span class="cm-sess__dot" aria-hidden="true"></span>
                      <span class="cm-sess__body">
                        <span class="cm-sess__id">{{ shortId(s.key) }}</span>
                        <span class="cm-sess__meta">{{ fmtCompact(s.records) }} msgs · {{ fmtCompact(s.totalTokens) }} tok</span>
                      </span>
                      <span class="cm-sess__cost">{{ '$' + fmt2(s.costUsd) }}</span>
                      <mat-icon class="cm-sess__chev" aria-hidden="true">chevron_right</mat-icon>
                    </button>
                  </li>
                }
              </ul>
            }
          </section>

          <p class="cm-foot" aria-hidden="true">
            Same data as the desktop calendar · all-time, dedup + sidechain handled server-side
          </p>
        }
      </div>
    </app-bs-pull-refresh>

    <!-- ─────────────── SESSION DRILL-DOWN SHEET ─────────────── -->
    <app-bs-sheet [(open)]="sheetOpen" detent="half"
                  [label]="'Session ' + (selectedId() ? shortId(selectedId()!) : 'detail')"
                  (closed)="onSheetClosed()">
      <div class="sd">
        <div class="sd__head">
          <span class="sd__dot" aria-hidden="true"></span>
          <div class="sd__titles">
            <h3 class="sd__title">{{ selectedId() ? shortId(selectedId()!) : 'Session' }}</h3>
            @if (sessionDetail(); as d) {
              <span class="sd__sub">{{ d.projectName || 'No project' }} · {{ durationMin(d) }} min</span>
            } @else if (sessionLoading()) {
              <span class="sd__sub">Loading…</span>
            }
          </div>
        </div>

        @if (sessionLoading()) {
          <div class="sd__skel">
            <app-bs-skeleton height="64px" radius="var(--r-tile)" />
            <app-bs-skeleton height="220px" radius="var(--r-tile)" />
          </div>
        } @else if (sessionError()) {
          <div class="cm-empty">
            <span class="cm-empty__orb"><mat-icon aria-hidden="true">error_outline</mat-icon></span>
            <p class="cm-empty__title">Couldn't load session</p>
            <p class="cm-empty__hint">Give it another go by closing and reopening.</p>
          </div>
        } @else if (sessionDetail(); as d) {
          <p class="sd__range">{{ fmtStamp(d.startUtc, true) }} → {{ fmtStamp(d.endUtc, false) }}</p>

          <div class="sd__stats">
            <span class="sd__stat"><b>{{ fmtCompact(d.messages) }}</b> messages</span>
            <span class="sd__stat"><b>{{ fmtCompact(d.tokens) }}</b> tokens</span>
            <span class="sd__stat"><b>{{ '$' + fmt2(d.cost) }}</b> cost</span>
          </div>

          @if (d.items.length) {
            <div class="sd__chart"><app-chart [option]="sessionChart()" /></div>
          }

          @if (!d.items.length) {
            <div class="cm-empty">
              <span class="cm-empty__orb"><mat-icon aria-hidden="true">inbox</mat-icon></span>
              <p class="cm-empty__title">No messages</p>
              <p class="cm-empty__hint">This session has no recorded messages.</p>
            </div>
          } @else {
            <ul class="sd__msgs">
              @for (m of d.items; track $index) {
                <li class="sd__msg" [class.is-side]="m.isSidechain">
                  <span class="sd__msg-top">
                    <span class="sd__msg-model">{{ m.model || '—' }}</span>
                    <span class="sd__msg-cost">{{ '$' + fmt4(m.cost) }}</span>
                  </span>
                  <span class="sd__msg-bot">
                    <span class="sd__msg-time">{{ fmtTime(m.timestampUtc) }}</span>
                    <span class="sd__msg-tok">{{ fmtCompact(m.total) }} tok</span>
                    @if (m.isSidechain) { <span class="sd__msg-tag">sidechain</span> }
                  </span>
                </li>
              }
            </ul>
          }
        }
      </div>
    </app-bs-sheet>
  `,
})
export class CalendarMobilePage {
  private api = inject(Api);

  // ---- top-level data (same endpoints + all-time filter as the live calendar) ----
  readonly days = signal<CalendarDay[]>([]);
  readonly metrics = signal<UsageStats | null>(null);
  readonly heat = signal<HeatmapCell[]>([]);
  readonly sessions = signal<SummaryBucket[]>([]);

  readonly loading = signal(true);
  readonly errored = signal(false);
  readonly refreshing = signal(false);

  /** The active colouring metric (mirrors the live page's button-toggle). */
  readonly metric = signal<Metric>('cost');

  // ---- session drill-down sheet ----
  readonly sheetOpen = signal(false);
  readonly selectedId = signal<string | null>(null);
  readonly sessionDetail = signal<SessionDetail | null>(null);
  readonly sessionLoading = signal(false);
  readonly sessionError = signal(false);

  readonly metricSegments: Segment[] = [
    { key: 'cost', label: 'Cost' },
    { key: 'tokens', label: 'Tokens' },
    { key: 'hours', label: 'Active hrs' },
  ];

  readonly skeletonTiles = Array.from({ length: 4 }, (_, i) => i);

  /** The all-time filter — copied VERBATIM from the live calendar so the data agrees exactly. */
  private static readonly ALL: UsageFilter = {
    from: null, to: null, projectIds: [], models: [], sources: [], machine: [], includeSidechain: true,
  };

  constructor() {
    this.reload();
  }

  // ─────────────── LOAD ───────────────

  reload(): void {
    const wasLoaded = this.days().length > 0 || !!this.metrics();
    if (wasLoaded) this.refreshing.set(true); else this.loading.set(true);
    this.errored.set(false);

    forkJoin({
      days: this.api.calendar(),
      stats: this.api.stats().pipe(catchError(() => of<UsageStats | null>(null))),
      heat: this.api.heatmap().pipe(catchError(() => of<HeatmapCell[]>([]))),
      sessions: this.api.summary(CalendarMobilePage.ALL, 'session')
        .pipe(catchError(() => of({ groupBy: 'session', buckets: [], total: null as any }))),
    }).subscribe({
      next: r => {
        this.days.set(r.days ?? []);
        this.metrics.set(r.stats);
        this.heat.set(r.heat ?? []);
        this.sessions.set((r.sessions?.buckets ?? []).slice(0, 12));
        this.loading.set(false);
        this.refreshing.set(false);
      },
      // The calendar stream is the critical one — if the whole join fails, surface the error state.
      error: () => {
        this.loading.set(false);
        this.refreshing.set(false);
        this.errored.set(true);
      },
    });
  }

  setMetric(key: string): void {
    this.metric.set(key === 'tokens' ? 'tokens' : key === 'hours' ? 'hours' : 'cost');
  }

  // ─────────────── DERIVED: HEADLINE STATS (computed client-side from the SAME days the live page reads) ───────────────

  /** Mirrors the live calendar's `stats` computed — totals over the per-day rollup. */
  readonly stats = computed(() => {
    const ds = this.days();
    const active = ds.filter(d => d.messages > 0);
    const totalMin = ds.reduce((a, d) => a + d.activeMinutes, 0);
    const totalCost = ds.reduce((a, d) => a + d.costUsd, 0);
    const totalSessions = ds.reduce((a, d) => a + d.sessions, 0);
    const totalMsgs = ds.reduce((a, d) => a + d.messages, 0);
    const m = this.metric();
    const busiest = active.reduce<CalendarDay | null>(
      (b, d) => (!b || this.metricValue(d, m) > this.metricValue(b, m) ? d : b), null);
    return {
      totalHours: totalMin / 60,
      activeDays: active.length,
      avgHoursPerDay: active.length ? totalMin / 60 / active.length : 0,
      // Busiest single day by active hours — the sub-label under the avg/active-day tile (mirrors
      // the live page's `stats.maxDayHours`).
      maxDayHours: active.reduce((mx, d) => Math.max(mx, d.activeMinutes / 60), 0),
      totalSessions,
      totalCost,
      totalMsgs,
      busiest,
    };
  });

  private metricValue(d: CalendarDay, m: Metric): number {
    if (m === 'cost') return d.costUsd;
    if (m === 'tokens') return d.tokens;
    return d.activeMinutes / 60;
  }

  readonly metricLabel = computed(() =>
    this.metric() === 'cost' ? 'cost' : this.metric() === 'tokens' ? 'tokens' : 'active hours');

  /** The most recent ~35 days as a horizontal bar strip, scaled to the busiest day in that window. */
  readonly recentBars = computed<DayBar[]>(() => {
    const ds = [...this.days()].sort((a, b) => a.date.localeCompare(b.date)).slice(-35);
    if (!ds.length) return [];
    const m = this.metric();
    const max = Math.max(...ds.map(d => this.metricValue(d, m)), 1e-9);
    const todayKey = this.todayKey();
    const dowNames = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
    return ds.map(d => {
      const v = this.metricValue(d, m);
      // Parse YYYY-MM-DD as a local date for the weekday/day-of-month ticks (no TZ shift).
      const dt = new Date(`${d.date}T00:00:00`);
      const valid = !Number.isNaN(dt.getTime());
      return {
        day: d,
        frac: max > 0 ? Math.max(d.messages > 0 ? 0.06 : 0, v / max) : 0,
        dow: valid ? dowNames[dt.getDay()] : '',
        dom: valid ? String(dt.getDate()) : '',
        isToday: d.date === todayKey,
      };
    });
  });

  /**
   * The FULL hour×weekday heatmap (7 weekday rows × 24 hour columns) — restores the weekday
   * dimension the live page carries (previously collapsed to an hour-of-day strip). Each cell's
   * `frac` (0..1 of the busiest cell) drives its tint via the `--i` custom property in SCSS.
   */
  readonly heatGrid = computed<HeatRow[]>(() => {
    const cells = this.heat();
    if (!cells.length) return [];
    // grid[weekday][hour] = count
    const grid: number[][] = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
    let max = 0;
    for (const c of cells) {
      if (c.day >= 0 && c.day < 7 && c.hour >= 0 && c.hour < 24) {
        grid[c.day][c.hour] += c.count;
        if (grid[c.day][c.hour] > max) max = grid[c.day][c.hour];
      }
    }
    if (max <= 0) return [];
    const dowNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return grid.map((row, weekday) => ({
      weekday,
      dow: dowNames[weekday],
      cells: row.map((count, hour) => ({ weekday, hour, count, frac: count / max })),
    }));
  });

  /** The single busiest cell (weekday+hour) for the peak highlight; {-1,-1} when no data. */
  readonly peakCell = computed<{ weekday: number; hour: number; count: number }>(() => {
    let best = { weekday: -1, hour: -1, count: -1 };
    for (const row of this.heatGrid()) {
      for (const c of row.cells) {
        if (c.count > best.count) best = { weekday: c.weekday, hour: c.hour, count: c.count };
      }
    }
    return best;
  });

  /** The weekday with the most total messages, as a short name (or '' when no data). */
  readonly mostActiveWeekday = computed<string>(() => {
    const rows = this.heatGrid();
    if (!rows.length) return '';
    let bestIdx = -1;
    let bestTotal = -1;
    for (const row of rows) {
      const total = row.cells.reduce((a, c) => a + c.count, 0);
      if (total > bestTotal) { bestTotal = total; bestIdx = row.weekday; }
    }
    const dowNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return bestIdx >= 0 && bestTotal > 0 ? dowNames[bestIdx] : '';
  });

  // ─────────────── SESSION DRILL-DOWN ───────────────

  openSession(id: string): void {
    this.selectedId.set(id);
    this.sessionDetail.set(null);
    this.sessionError.set(false);
    this.sessionLoading.set(true);
    this.sheetOpen.set(true);
    this.api.session(id).subscribe({
      next: d => { this.sessionDetail.set(d); this.sessionLoading.set(false); },
      error: () => { this.sessionError.set(true); this.sessionLoading.set(false); },
    });
  }

  onSheetClosed(): void {
    this.selectedId.set(null);
    this.sessionDetail.set(null);
    this.sessionError.set(false);
    this.sessionLoading.set(false);
  }

  durationMin(d: SessionDetail): number {
    const ms = new Date(d.endUtc).getTime() - new Date(d.startUtc).getTime();
    return Number.isFinite(ms) ? Math.max(0, Math.round(ms / 60000)) : 0;
  }

  /**
   * Cumulative-cost step-line for the open session — a mobile-flavoured twin of the live
   * SessionDialog chart. Sums each message's cost in timestamp order and plots the running total as a
   * step ('end') line; chrome/axes are themed by the shared ChartComponent. Empty when no items.
   */
  readonly sessionChart = computed<EChartsOption>(() => {
    const d = this.sessionDetail();
    if (!d || !d.items.length) return {};
    let cum = 0;
    const points = d.items.map(m => {
      cum += m.cost;
      return [m.timestampUtc, +cum.toFixed(4)] as [string, number];
    });
    return {
      tooltip: { trigger: 'axis', valueFormatter: (v) => '$' + Number(v).toFixed(2) },
      grid: { left: 56, right: 16, top: 14, bottom: 30 },
      xAxis: { type: 'time' },
      yAxis: { type: 'value', name: 'Cumulative $', axisLabel: { formatter: '${value}' } },
      series: [
        {
          type: 'line',
          step: 'end',
          symbol: 'none',
          data: points,
          areaStyle: { opacity: 0.14 },
          itemStyle: { color: 'var(--accent-a)' },
          lineStyle: { color: 'var(--accent-a)', width: 2 },
        },
      ],
    };
  });

  // ─────────────── ARIA STRINGS ───────────────

  recentAria(): string {
    const s = this.stats();
    const peak = s.busiest ? `, peak day ${s.busiest.date}` : '';
    return `Recent daily ${this.metricLabel()} across ${s.activeDays} active days${peak}. See the stat tiles for totals.`;
  }

  hourAria(): string {
    const p = this.peakCell();
    if (p.weekday < 0 || p.hour < 0) return 'Message volume by hour of day and weekday.';
    const dowNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return `Message volume by hour of day and weekday; busiest ${dowNames[p.weekday]} at ${this.fmtHour(p.hour)}.`;
  }

  sessionAria(s: SummaryBucket): string {
    return `Session ${this.shortId(s.key)}, ${s.records} messages, $${this.fmt2(s.costUsd)}. Open detail.`;
  }

  peakReading(d: CalendarDay): string {
    const m = this.metric();
    if (m === 'cost') return '$' + this.fmt2(d.costUsd);
    if (m === 'tokens') return this.fmtCompact(d.tokens) + ' tok';
    return this.fmt1(d.activeMinutes / 60) + 'h';
  }

  // ─────────────── FORMAT HELPERS ───────────────

  private todayKey(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  shortId(id: string): string {
    return id.length > 16 ? id.slice(0, 7) + '…' + id.slice(-5) : id;
  }

  fmtInt(n: number | null | undefined): string {
    if (n == null || !Number.isFinite(n)) return '0';
    return Math.round(n).toLocaleString('en-US');
  }

  fmt1(n: number | null | undefined): string {
    if (n == null || !Number.isFinite(n)) return '0.0';
    return n.toFixed(1);
  }

  fmt2(n: number | null | undefined): string {
    if (n == null || !Number.isFinite(n)) return '0.00';
    return n.toFixed(2);
  }

  /** Per-message cost to 4 decimals (matches the live dialog's 1.2-4 currency format). */
  fmt4(n: number | null | undefined): string {
    if (n == null || !Number.isFinite(n)) return '0.0000';
    return n.toFixed(4);
  }

  /** Compact large numbers (1.2K / 3.4M / 1.1B) for tokens + message counts. */
  fmtCompact(n: number | null | undefined): string {
    if (n == null || !Number.isFinite(n)) return '0';
    const a = Math.abs(n);
    if (a >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (a >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (a >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(Math.round(n));
  }

  fmtHour(h: number | null | undefined): string {
    if (h == null || !Number.isFinite(h) || h < 0) return '—';
    const hr = ((h % 24) + 24) % 24;
    const am = hr < 12;
    const h12 = hr % 12 === 0 ? 12 : hr % 12;
    return `${h12}${am ? 'am' : 'pm'}`;
  }

  fmtTime(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }

  /**
   * Session start/end timestamp. The start carries the date (mirrors the live dialog's
   * `MMM d, HH:mm → HH:mm`); the end is time-only since it usually shares the day.
   */
  fmtStamp(iso: string, withDate: boolean): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return withDate
      ? d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
      : d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }
}
