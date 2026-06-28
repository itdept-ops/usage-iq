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
import { BetaEmptyState, BetaErrorState } from '../beta-ui';

/** A grid section: one closed `kind` group (Correlations / Trends / Streaks / Anomalies / Best & worst). */
interface KindGroup {
  readonly kind: InsightKind;
  readonly label: string;
  readonly icon: string;
  readonly blurb: string;
  readonly cards: InsightCard[];
}

/**
 * THE INSIGHT ENGINE — the DESKTOP `/insights` command center. A kind-grouped grid of the caller's OWN
 * cross-domain insights (Correlations / Trends / Streaks / Anomalies / Best & worst days) that NO single page
 * surfaces, each rendered as a glanceable card with its DETERMINISTIC stat ("r=0.61 · moderate", "+0.4 kg/wk",
 * "Best run: 9 days", "82 on Jun 14"), a domain accent, and the `dataPoints` honesty count. Correlation cards
 * expand to an ILLUSTRATIVE scatter/trend mini-chart (the shared ECharts wrapper). A window selector toggles
 * 30 / 90 / 365 days. When the caller holds tracker.ai, an optional AI narrative banner reads the same numbers
 * (hidden on `fellBackToPlain`). An insufficient-data empty state invites the user to keep logging.
 *
 * DATA + PRIVACY (load-bearing): every figure comes from {@link Api.insights} (`GET /api/insights`), computed
 * server-side over the caller's OWN already-derived per-day series and STRICTLY owner-scoped (no household, no
 * other user). The optional narrative comes from {@link Api.insightsNarrate} (always 200 — the deterministic
 * floor when AI is off). This page renders only the caller's own data, performs NO writes, and re-derives
 * nothing client-side. The scatter mini-chart is an ILLUSTRATIVE depiction of the published r / direction +
 * point count — it draws no raw values (the wire carries only the aggregate stat) and is labeled as such.
 *
 * STATISTICAL HONESTY: every correlation card carries a visible "Association, not causation" chip AND a
 * non-medical disclaimer (in addition to the server-provided `detail` microcopy); trend projections are framed
 * as estimates, not predictions. The deterministic grid is the always-rendered product; the AI banner is a
 * progressive enhancement gated on tracker.ai.
 *
 * STYLING: the app's own `--tech-*` design tokens with a per-domain accent palette pinned on `:host`.
 */
@Component({
  selector: 'app-insights',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, ChartComponent, BetaEmptyState, BetaErrorState],
  styleUrl: './insights.page.scss',
  template: `
    <div class="iq">
      <!-- ─────────── HEADER ─────────── -->
      <header class="iq-head">
        <div class="iq-head__lead">
          <p class="iq-head__kicker">
            <mat-icon aria-hidden="true">insights</mat-icon> The Insight Engine
          </p>
          <h1 class="iq-head__title">Cross-domain insights</h1>
          <p class="iq-head__sub">
            Correlations, trends, streaks &amp; anomalies across everything you track — computed only from
            <strong>your</strong> own data. Statistical, not medical, advice.
          </p>
        </div>
        <div class="iq-head__windows" role="tablist" aria-label="Insight window">
          @for (w of windows; track w.value) {
            <button type="button" class="iq-chip" role="tab"
                    [class.is-on]="window() === w.value" [attr.aria-selected]="window() === w.value"
                    [disabled]="loading()" (click)="setWindow(w.value)">{{ w.label }}</button>
          }
        </div>
      </header>

      <!-- ─────────── AI NARRATIVE BANNER (tracker.ai only; hidden on fellBackToPlain) ─────────── -->
      @if (showNarrative()) {
        <section class="iq-ai" aria-label="AI read of your insights">
          <p class="iq-ai__kicker">
            <mat-icon aria-hidden="true">auto_awesome</mat-icon> AI read
          </p>
          <p class="iq-ai__text">{{ narrative()?.narrative }}</p>
          @if (narrative()?.insights?.length) {
            <ul class="iq-ai__bullets">
              @for (b of narrative()?.insights ?? []; track b) {
                <li><mat-icon aria-hidden="true">arrow_right_alt</mat-icon>{{ b }}</li>
              }
            </ul>
          }
          <p class="iq-ai__foot">
            <mat-icon aria-hidden="true">verified_user</mat-icon>
            The AI narrates only the numbers below — it never invents or diagnoses.
          </p>
        </section>
      }

      <!-- ─────────── BODY ─────────── -->
      @if (loading()) {
        <div class="iq-grid" aria-hidden="true">
          @for (s of [1,2,3,4,5,6]; track s) {
            <div class="iq-card iq-card--skel"></div>
          }
        </div>
      } @else if (errored()) {
        <app-bs-error
          title="Couldn't load your insights"
          body="Something went wrong crunching the numbers. Give it another go."
          (retry)="reload()" />
      } @else if (!hasData()) {
        <app-bs-empty
          icon="query_stats"
          title="Keep logging — insights appear once there's enough data"
          body="The engine needs a steady run of days across a couple of domains (sleep, food, activity, water, weight, coffee, AI spend …) before correlations and trends become statistically honest. Log a few more days and your first insights will surface here."
          ctaLabel="Open the tracker"
          ctaLink="/tracker" />
      } @else {
        @for (g of groups(); track g.kind) {
          @if (g.cards.length) {
            <section class="iq-group" [attr.aria-label]="g.label">
              <div class="iq-group__head">
                <span class="iq-group__ico"><mat-icon aria-hidden="true">{{ g.icon }}</mat-icon></span>
                <div>
                  <h2 class="iq-group__title">{{ g.label }}</h2>
                  <p class="iq-group__blurb">{{ g.blurb }}</p>
                </div>
                <span class="iq-group__count">{{ g.cards.length }}</span>
              </div>

              <div class="iq-grid">
                @for (c of g.cards; track c.title; let i = $index) {
                  <article class="iq-card" [style.--da]="accentA(c.domain)" [style.--db]="accentB(c.domain)">
                    <header class="iq-card__top">
                      <span class="iq-card__dico"><mat-icon aria-hidden="true">{{ domainIcon(c.domain) }}</mat-icon></span>
                      <span class="iq-card__domain">{{ c.domain }}</span>
                      <span class="iq-card__mag" [attr.data-dir]="dirOf(c)">{{ c.magnitude }}</span>
                    </header>

                    <h3 class="iq-card__title">{{ c.title }}</h3>
                    <p class="iq-card__stat">{{ c.stat }}</p>
                    <p class="iq-card__detail">{{ c.detail }}</p>

                    <footer class="iq-card__foot">
                      <span class="iq-card__points" [attr.title]="pointsTitle(c)">
                        <mat-icon aria-hidden="true">scatter_plot</mat-icon> {{ c.dataPoints }} {{ pointNoun(c) }}
                      </span>
                      @if (c.kind === 'correlation') {
                        <button type="button" class="iq-card__expand"
                                [attr.aria-expanded]="expanded() === cardId(g.kind, i)"
                                (click)="toggle(cardId(g.kind, i))">
                          <mat-icon aria-hidden="true">{{ expanded() === cardId(g.kind, i) ? 'expand_less' : 'show_chart' }}</mat-icon>
                          {{ expanded() === cardId(g.kind, i) ? 'Hide chart' : 'Show chart' }}
                        </button>
                      }
                    </footer>

                    <!-- Per-invariant visible disclaimer chips on correlation (health-adjacent) cards. -->
                    @if (c.kind === 'correlation') {
                      <div class="iq-card__chips">
                        <span class="iq-chip2"><mat-icon aria-hidden="true">link_off</mat-icon> Association, not causation</span>
                        <span class="iq-chip2 iq-chip2--med"><mat-icon aria-hidden="true">medical_information</mat-icon> Not medical advice</span>
                      </div>

                      @if (expanded() === cardId(g.kind, i)) {
                        <div class="iq-card__chart">
                          <app-chart [option]="scatterOption(c)" />
                          <p class="iq-card__chart-note">
                            Illustrative scatter — depicts the published strength (r) &amp; direction over
                            {{ c.dataPoints }} paired days, not raw logged values.
                          </p>
                        </div>
                      }
                    }

                    @if (c.kind === 'trend' && hasProjection(c)) {
                      <p class="iq-card__est">
                        <mat-icon aria-hidden="true">trending_flat</mat-icon> Projection is an estimate, not a prediction.
                      </p>
                    }
                  </article>
                }
              </div>
            </section>
          }
        }

        <p class="iq-foot">
          <mat-icon aria-hidden="true">lock</mat-icon>
          Computed only from your own logs — never household or other-user data. Correlations need ≥10 paired
          days; figures are statistical signals, not medical or diagnostic advice.
        </p>
      }
    </div>
  `,
})
export class InsightsPage {
  private api = inject(Api);

  readonly windows: { value: InsightWindow; label: string }[] = [
    { value: 30, label: '30 days' },
    { value: 90, label: '90 days' },
    { value: 365, label: '1 year' },
  ];

  readonly window = signal<InsightWindow>(90);
  readonly data = signal<InsightsResponse | null>(null);
  readonly narrative = signal<InsightsNarrateResponse | null>(null);
  readonly loading = signal(true);
  readonly errored = signal(false);
  /** The id ("kind:index") of the correlation card whose mini-chart is open, or null. */
  readonly expanded = signal<string | null>(null);

  readonly cards = computed<InsightCard[]>(() => this.data()?.cards ?? []);
  readonly hasData = computed(() => !!this.data()?.hasData && this.cards().length > 0);

  /** Show the AI banner only when the narration didn't fall back to the plain floor. */
  readonly showNarrative = computed(() => {
    const n = this.narrative();
    return !!n && !n.fellBackToPlain && !!n.narrative;
  });

  /** The closed-kind grid sections, in display order, each carrying its matching cards. */
  readonly groups = computed<KindGroup[]>(() => {
    const by = this.cards();
    return InsightsPage.GROUP_META.map(m => ({
      ...m,
      cards: by.filter(c => c.kind === m.kind),
    }));
  });

  constructor() {
    this.reload();
  }

  setWindow(w: InsightWindow): void {
    if (w === this.window()) return;
    this.window.set(w);
    this.expanded.set(null);
    this.reload();
  }

  async reload(): Promise<void> {
    this.loading.set(true);
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
    }
  }

  /** Best-effort narrative load (the endpoint always 200s; a transport hiccup just leaves the banner off). */
  private async loadNarrative(w: InsightWindow): Promise<void> {
    try {
      const n = await firstValueFrom(this.api.insightsNarrate(w));
      if (w === this.window()) this.narrative.set(n);
    } catch { /* progressive enhancement — leave the grid as-is */ }
  }

  // ─────────────── CARD EXPAND ───────────────

  cardId(kind: string, index: number): string { return `${kind}:${index}`; }

  toggle(id: string): void {
    this.expanded.update(cur => (cur === id ? null : id));
  }

  // ─────────────── DERIVED DISPLAY HELPERS ───────────────

  /** A short direction tag for the magnitude pill colour ("up" | "down" | "flat" | ""). */
  dirOf(c: InsightCard): string {
    const m = (c.magnitude ?? '').toLowerCase();
    if (m.includes('positive') || m.includes('up')) return 'up';
    if (m.includes('negative') || m.includes('down')) return 'down';
    if (m.includes('flat') || m.includes('idle')) return 'flat';
    return '';
  }

  /** True when a trend card's stat looks like it carries a projection (so we surface the "estimate" note). */
  hasProjection(c: InsightCard): boolean {
    const s = `${c.stat} ${c.detail}`.toLowerCase();
    return s.includes('→') || s.includes('est') || s.includes('project');
  }

  pointNoun(c: InsightCard): string {
    return c.kind === 'correlation' ? 'paired days' : 'data points';
  }

  pointsTitle(c: InsightCard): string {
    return `${c.dataPoints} ${this.pointNoun(c)} behind this stat`;
  }

  // ─────────────── ACCENT + ICON MAPPING ───────────────

  private static readonly DOMAIN_KEYS = new Set([
    'sleep', 'coffee', 'weight', 'usage', 'food', 'activity', 'cycle', 'hydration', 'primary',
  ]);
  private domainKey(d: string | null | undefined): string {
    return d && InsightsPage.DOMAIN_KEYS.has(d) ? d : 'primary';
  }
  accentA(d: string): string { return `var(--da-${this.domainKey(d)})`; }
  accentB(d: string): string { return `var(--db-${this.domainKey(d)})`; }

  private static readonly DOMAIN_ICONS: Record<string, string> = {
    sleep: 'bedtime',
    coffee: 'local_cafe',
    weight: 'monitor_weight',
    usage: 'insights',
    food: 'restaurant',
    activity: 'directions_walk',
    cycle: 'cyclone',
    hydration: 'water_drop',
    primary: 'auto_graph',
  };
  domainIcon(d: string): string {
    return InsightsPage.DOMAIN_ICONS[this.domainKey(d)] ?? 'auto_graph';
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

  // ─────────────── GROUP METADATA ───────────────

  private static readonly GROUP_META: { kind: InsightKind; label: string; icon: string; blurb: string }[] = [
    { kind: 'correlation', label: 'Correlations', icon: 'sync_alt',
      blurb: 'Paired-day associations across domains (≥10 days). Association, not causation.' },
    { kind: 'trend', label: 'Trends', icon: 'trending_up',
      blurb: 'Where a metric is drifting — with a bounded estimate, not a prediction.' },
    { kind: 'streak', label: 'Streaks', icon: 'local_fire_department',
      blurb: 'Your longest & current qualifying runs.' },
    { kind: 'anomaly', label: 'Anomalies', icon: 'warning_amber',
      blurb: 'Statistical outlier days (|z| ≥ 2).' },
    { kind: 'bestworst', label: 'Best & worst', icon: 'emoji_events',
      blurb: 'Your standout high & low days per metric.' },
  ];
}
