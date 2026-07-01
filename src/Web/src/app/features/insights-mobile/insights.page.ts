import {
  ChangeDetectionStrategy, Component, computed, inject, signal,
} from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import type { EChartsOption } from 'echarts';
import { firstValueFrom } from 'rxjs';

import { Api } from '../../core/api';
import {
  InsightCard, InsightKind, InsightWindow, InsightsNarrateResponse, InsightsResponse,
} from '../../core/models';
import { ChartComponent } from '../../shared/chart';
import {
  BetaEmptyState, BetaErrorState, BetaPullRefresh, BetaSegmentedControl, BetaSkeleton, type Segment,
} from '../beta-ui';

/** One feed card augmented with its kind-section label so the swipe stack reads as grouped. */
interface FeedCard extends InsightCard {
  readonly sectionLabel: string;
  readonly sectionIcon: string;
  readonly sectionBlurb: string;
  readonly sectionCount: number;
  readonly isFirstOfKind: boolean;
  /** Stable id ("kind:index") for the expandable correlation chart. */
  readonly cardId: string;
}

/**
 * THE INSIGHT ENGINE — the MOBILE `/insights` twin: a Strata swipeable, scroll-snapped STACKED CARD FEED of
 * the caller's OWN cross-domain insights (Correlations / Trends / Streaks / Anomalies / Best & worst), reusing
 * the SAME `GET /api/insights` DTOs and the shared beta-ui "Strata" kit. Each card shows the deterministic stat
 * + a domain accent + the `dataPoints` honesty count; correlation cards carry the visible "Association, not
 * causation" + non-medical chips. A segmented window selector (30 / 90 / 365) sits in the sticky glass top; an
 * optional AI narrative banner appears only when the caller holds tracker.ai (hidden on `fellBackToPlain`).
 * Pull-to-refresh + an elevated loading / empty (keep-logging) / error state.
 *
 * DATA + PRIVACY: every figure comes from {@link Api.insights}, computed server-side over the caller's OWN
 * already-derived per-day series and STRICTLY owner-scoped (no household, no other user). The optional
 * narrative comes from {@link Api.insightsNarrate} (always 200 — floor when AI is off). This page renders only
 * the caller's own data, performs NO writes, and re-derives nothing client-side.
 *
 * ISOLATION: gated by `platform.mobile`; consumes the kit + the SAME read-only Api as the desktop page. No live
 * page is imported or modified; the kit is consumed, never changed. Reduced-motion is honoured by the kit.
 */
@Component({
  selector: 'app-insights-mobile',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './insights.page.scss',
  imports: [
    MatIconModule, ChartComponent,
    BetaPullRefresh, BetaSegmentedControl, BetaSkeleton, BetaEmptyState, BetaErrorState,
  ],
  template: `
    <!-- ─────────── STICKY GLASS TOP: window switcher ─────────── -->
    <header class="im-top">
      <p class="im-top__title">
        <mat-icon aria-hidden="true">insights</mat-icon> Insights
      </p>
      <app-bs-segmented class="im-top__seg"
        [segments]="windowSegments" [value]="String(window())" label="Insight window"
        [disabled]="loading()" (change)="setWindow($event)" />
    </header>

    <app-bs-pull-refresh class="im-ptr" [busy]="refreshing()" (refresh)="reload()">
      <div class="im-scroll">

        <!-- ─── hero ─── -->
        <header class="im-hero">
          <p class="im-hero__kicker"><mat-icon aria-hidden="true">query_stats</mat-icon> Your patterns</p>
          <h1 class="im-hero__title">The Insight Engine</h1>
          <p class="im-hero__sub">Cross-domain signals surfaced from your own logs — no other user's data.</p>
        </header>

        @if (loading()) {
          <div class="im-load" aria-hidden="true">
            <app-bs-skeleton height="118px" radius="var(--r-card)" />
            <app-bs-skeleton height="160px" radius="var(--r-card)" />
            <app-bs-skeleton height="160px" radius="var(--r-card)" />
          </div>

        } @else if (errored()) {
          <app-bs-error
            title="Couldn't load insights"
            body="Something went wrong crunching the numbers. Give it another go."
            (retry)="reload()" />

        } @else if (!hasData()) {
          <app-bs-empty
            icon="query_stats"
            title="Keep logging"
            body="Insights appear once there's enough data. Log a steady run of days across a few domains — sleep, food, activity, water, weight, coffee, AI spend — and your first correlations & trends surface here."
            ctaLabel="Open the tracker"
            ctaLink="/tracker-beta" />

        } @else {
          <!-- ─── optional AI narrative banner (tracker.ai only) ─── -->
          @if (showNarrative()) {
            <article class="im-ai">
              <p class="im-ai__kicker"><mat-icon aria-hidden="true">auto_awesome</mat-icon> AI read</p>
              <p class="im-ai__text">{{ narrative()?.narrative }}</p>
              @if (narrative()?.insights?.length) {
                <ul class="im-ai__bullets">
                  @for (b of narrative()?.insights ?? []; track b) {
                    <li><mat-icon aria-hidden="true">arrow_right_alt</mat-icon>{{ b }}</li>
                  }
                </ul>
              }
              <p class="im-ai__foot">Narrates only the numbers below — never invents or diagnoses.</p>
            </article>
          }

          <!-- ─── the swipeable stacked card feed ─── -->
          <div class="im-feed" role="list" aria-label="Your insights">
            @for (c of feed(); track c.title) {
              @if (c.isFirstOfKind) {
                <div class="im-section" [attr.aria-label]="c.sectionLabel">
                  <p class="im-section__head" aria-hidden="true">
                    <span class="im-section__lead">
                      <mat-icon aria-hidden="true">{{ c.sectionIcon }}</mat-icon> {{ c.sectionLabel }}
                    </span>
                    <span class="im-section__count">{{ c.sectionCount }}</span>
                  </p>
                  <p class="im-section__blurb">{{ c.sectionBlurb }}</p>
                </div>
              }
              <article class="im-card" role="listitem"
                       [style.--da]="accentA(c.domain)" [style.--db]="accentB(c.domain)">
                <header class="im-card__top">
                  <span class="im-card__dico"><mat-icon aria-hidden="true">{{ domainIcon(c.domain) }}</mat-icon></span>
                  <span class="im-card__domain">{{ c.domain }}</span>
                  <span class="im-card__mag" [attr.data-dir]="dirOf(c)">{{ c.magnitude }}</span>
                </header>
                <h3 class="im-card__title">{{ c.title }}</h3>
                <p class="im-card__stat">{{ c.stat }}</p>
                <p class="im-card__detail">{{ c.detail }}</p>
                <footer class="im-card__foot">
                  <span class="im-card__points">
                    <mat-icon aria-hidden="true">scatter_plot</mat-icon>
                    {{ c.dataPoints }} {{ c.kind === 'correlation' ? 'paired days' : 'data points' }}
                  </span>
                  @if (c.kind === 'correlation') {
                    <button type="button" class="im-card__expand"
                            [attr.aria-expanded]="expanded() === c.cardId"
                            (click)="toggle(c.cardId)">
                      <mat-icon aria-hidden="true">{{ expanded() === c.cardId ? 'expand_less' : 'show_chart' }}</mat-icon>
                      {{ expanded() === c.cardId ? 'Hide chart' : 'Show chart' }}
                    </button>
                  }
                </footer>
                @if (c.kind === 'correlation') {
                  <div class="im-card__chips">
                    <span class="im-chip"><mat-icon aria-hidden="true">link_off</mat-icon> Association, not causation</span>
                    <span class="im-chip im-chip--med"><mat-icon aria-hidden="true">medical_information</mat-icon> Not medical advice</span>
                  </div>
                  @if (expanded() === c.cardId) {
                    <div class="im-card__chart">
                      <app-chart [option]="scatterOption(c)" />
                      <p class="im-card__chart-note">
                        Illustrative scatter — depicts the published strength (r) &amp; direction over
                        {{ c.dataPoints }} paired days, not raw logged values.
                      </p>
                    </div>
                  }
                }
                @if (c.kind === 'trend' && hasProjection(c)) {
                  <p class="im-card__est"><mat-icon aria-hidden="true">trending_flat</mat-icon> Estimate, not a prediction.</p>
                }
              </article>
            }
          </div>

          <p class="im-foot">
            <mat-icon aria-hidden="true">lock</mat-icon>
            Only your own logs — never household or other-user data. Statistical signals, not medical advice.
          </p>
        }
      </div>
    </app-bs-pull-refresh>
  `,
})
export class InsightsMobilePage {
  private api = inject(Api);

  /** Expose String() to the template for the segmented-control value coercion. */
  readonly String = String;

  readonly windowSegments: Segment[] = [
    { key: '30', label: '30d' },
    { key: '90', label: '90d' },
    { key: '365', label: '1y' },
  ];

  readonly window = signal<InsightWindow>(90);
  readonly data = signal<InsightsResponse | null>(null);
  readonly narrative = signal<InsightsNarrateResponse | null>(null);
  readonly loading = signal(true);
  readonly errored = signal(false);
  readonly refreshing = signal(false);
  /** The id ("kind:index") of the correlation card whose mini-chart is open, or null. */
  readonly expanded = signal<string | null>(null);

  readonly cards = computed<InsightCard[]>(() => this.data()?.cards ?? []);
  readonly hasData = computed(() => !!this.data()?.hasData && this.cards().length > 0);

  readonly showNarrative = computed(() => {
    const n = this.narrative();
    return !!n && !n.fellBackToPlain && !!n.narrative;
  });

  /** The feed: cards sorted into kind order, each tagged with whether it opens a new section. */
  readonly feed = computed<FeedCard[]>(() => {
    const order = InsightsMobilePage.KIND_ORDER;
    const sorted = [...this.cards()].sort(
      (a, b) => order.indexOf(a.kind as InsightKind) - order.indexOf(b.kind as InsightKind),
    );
    const counts = new Map<string, number>();
    for (const c of sorted) counts.set(c.kind, (counts.get(c.kind) ?? 0) + 1);
    let prevKind: string | null = null;
    let indexInKind = 0;
    return sorted.map(c => {
      const meta = InsightsMobilePage.KIND_META[c.kind as InsightKind]
        ?? { label: 'Insights', icon: 'insights', blurb: '' };
      const first = c.kind !== prevKind;
      indexInKind = first ? 0 : indexInKind + 1;
      const card: FeedCard = {
        ...c,
        sectionLabel: meta.label,
        sectionIcon: meta.icon,
        sectionBlurb: meta.blurb,
        sectionCount: counts.get(c.kind) ?? 0,
        isFirstOfKind: first,
        cardId: `${c.kind}:${indexInKind}`,
      };
      prevKind = c.kind;
      return card;
    });
  });

  constructor() {
    this.reload();
  }

  setWindow(key: string): void {
    const w = (Number(key) as InsightWindow) || 30;
    if (w === this.window()) return;
    this.window.set(w);
    this.expanded.set(null);
    this.reload();
  }

  async reload(): Promise<void> {
    const wasLoaded = !!this.data();
    if (wasLoaded) this.refreshing.set(true); else this.loading.set(true);
    this.errored.set(false);
    this.narrative.set(null);
    this.expanded.set(null);
    const w = this.window();
    try {
      const res = await firstValueFrom(this.api.insights(w));
      this.data.set(res);
      if (res.hasData && res.cards.length) void this.loadNarrative(w);
    } catch {
      this.errored.set(true);
    } finally {
      this.loading.set(false);
      this.refreshing.set(false);
    }
  }

  private async loadNarrative(w: InsightWindow): Promise<void> {
    try {
      const n = await firstValueFrom(this.api.insightsNarrate(w));
      if (w === this.window()) this.narrative.set(n);
    } catch { /* progressive enhancement */ }
  }

  // ─────────────── CARD EXPAND ───────────────

  toggle(id: string): void {
    this.expanded.update(cur => (cur === id ? null : id));
  }

  // ─────────────── DISPLAY HELPERS ───────────────

  dirOf(c: InsightCard): string {
    const m = (c.magnitude ?? '').toLowerCase();
    if (m.includes('positive') || m.includes('up')) return 'up';
    if (m.includes('negative') || m.includes('down')) return 'down';
    if (m.includes('flat') || m.includes('idle')) return 'flat';
    return '';
  }

  hasProjection(c: InsightCard): boolean {
    const s = `${c.stat} ${c.detail}`.toLowerCase();
    return s.includes('→') || s.includes('est') || s.includes('project');
  }

  // ─────────────── ACCENT + ICON ───────────────

  private static readonly DOMAIN_KEYS = new Set([
    'sleep', 'coffee', 'weight', 'usage', 'food', 'activity', 'cycle', 'hydration', 'primary',
  ]);
  private domainKey(d: string | null | undefined): string {
    return d && InsightsMobilePage.DOMAIN_KEYS.has(d) ? d : 'primary';
  }
  accentA(d: string): string { return `var(--da-${this.domainKey(d)})`; }
  accentB(d: string): string { return `var(--db-${this.domainKey(d)})`; }

  private static readonly DOMAIN_ICONS: Record<string, string> = {
    sleep: 'bedtime', coffee: 'local_cafe', weight: 'monitor_weight', usage: 'insights',
    food: 'restaurant', activity: 'directions_walk', cycle: 'cyclone', hydration: 'water_drop',
    primary: 'auto_graph',
  };
  domainIcon(d: string): string {
    return InsightsMobilePage.DOMAIN_ICONS[this.domainKey(d)] ?? 'auto_graph';
  }

  // ─────────────── CORRELATION SCATTER (illustrative) ───────────────

  /**
   * Build an ILLUSTRATIVE scatter + regression-line option for a correlation card. The wire carries only the
   * aggregate stat (r + n), NOT raw values, so this fabricates NO logged data — it draws `dataPoints` points
   * with deterministic jitter whose spread scales with (1 − |r|) around a line whose slope sign matches the
   * correlation direction. It's a faithful depiction of the published strength/direction, labeled as such.
   */
  scatterOption(c: InsightCard): EChartsOption {
    const r = this.parseR(c);
    const n = Math.max(2, Math.min(c.dataPoints || 12, 60));
    const dir = r < 0 ? -1 : 1;
    const strength = Math.min(Math.abs(r), 0.98);
    const spread = (1 - strength) * 0.9 + 0.05; // tighter cloud for stronger |r|

    // deterministic pseudo-random so the chart is stable across re-renders (no layout thrash).
    const rnd = (k: number) => {
      const x = Math.sin((k + 1) * 12.9898 + n * 78.233) * 43758.5453;
      return x - Math.floor(x);
    };

    const pts: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      const x = rnd(i * 2);                       // 0..1
      const base = x;                             // perfect-correlation y
      const noise = (rnd(i * 2 + 1) - 0.5) * 2 * spread;
      let y = dir < 0 ? 1 - base : base;
      y += noise;
      y = Math.max(0, Math.min(1, y));
      pts.push([Number((x * 100).toFixed(1)), Number((y * 100).toFixed(1))]);
    }

    // regression line endpoints (direction-aware), drawn across the cloud.
    const line: [number, number][] = dir < 0 ? [[0, 90], [100, 10]] : [[0, 10], [100, 90]];
    const accent = '#7c8cff';

    return {
      grid: { left: 8, right: 14, top: 14, bottom: 18, containLabel: true },
      xAxis: { type: 'value', min: 0, max: 100, name: this.axisX(c), nameGap: 18, nameLocation: 'middle',
        nameTextStyle: { fontSize: 10 }, axisLabel: { show: false } },
      yAxis: { type: 'value', min: 0, max: 100, name: this.axisY(c), nameGap: 22, nameLocation: 'middle',
        nameTextStyle: { fontSize: 10 }, axisLabel: { show: false } },
      tooltip: { show: false },
      series: [
        {
          type: 'line', data: line, symbol: 'none', silent: true,
          lineStyle: { color: accent, width: 2, type: 'dashed', opacity: 0.7 }, z: 1,
        },
        {
          type: 'scatter', data: pts, symbolSize: 7, z: 2,
          itemStyle: { color: accent, opacity: 0.75, borderColor: 'rgba(255,255,255,0.18)', borderWidth: 0.5 },
        },
      ],
    };
  }

  /** Extract the |r| (signed) value out of a correlation stat like "r=0.61 · moderate" / "r=-0.43 …". */
  private parseR(c: InsightCard): number {
    const m = `${c.stat} ${c.detail}`.match(/r\s*=\s*(-?\d*\.?\d+)/i);
    let r = m ? Number(m[1]) : 0.5;
    if (!Number.isFinite(r)) r = 0.5;
    // honour an explicit "negative" magnitude even if the printed r is unsigned.
    if (r > 0 && (c.magnitude ?? '').toLowerCase().includes('negative')) r = -r;
    return Math.max(-1, Math.min(1, r));
  }

  /** Split a "A vs B" title into rough axis labels (illustrative). */
  private axisX(c: InsightCard): string {
    const parts = c.title.split(/\bvs\b|→|↔/i);
    return (parts[0] ?? 'A').trim().slice(0, 22) || 'A';
  }
  private axisY(c: InsightCard): string {
    const parts = c.title.split(/\bvs\b|→|↔/i);
    return (parts[1] ?? parts[0] ?? 'B').trim().slice(0, 22) || 'B';
  }

  // ─────────────── KIND ORDER + META ───────────────

  private static readonly KIND_ORDER: InsightKind[] = [
    'correlation', 'trend', 'streak', 'anomaly', 'bestworst',
  ];
  private static readonly KIND_META: Record<InsightKind, { label: string; icon: string; blurb: string }> = {
    correlation: { label: 'Correlations', icon: 'sync_alt',
      blurb: 'Paired-day associations across domains (≥10 days). Association, not causation.' },
    trend: { label: 'Trends', icon: 'trending_up',
      blurb: 'Where a metric is drifting — with a bounded estimate, not a prediction.' },
    streak: { label: 'Streaks', icon: 'local_fire_department',
      blurb: 'Your longest & current qualifying runs.' },
    anomaly: { label: 'Anomalies', icon: 'warning_amber',
      blurb: 'Statistical outlier days (|z| ≥ 2).' },
    bestworst: { label: 'Best & worst', icon: 'emoji_events',
      blurb: 'Your standout high & low days per metric.' },
  };
}
