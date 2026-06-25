import {
  ChangeDetectionStrategy, Component, computed, inject, output, signal,
} from '@angular/core';
import type { EChartsOption } from 'echarts';

import { TrackerStore } from '../../../core/tracker-store';
import { WeightPointDto, WeightStatsDto } from '../../../core/models';
import { ChartComponent } from '../../../shared/chart';
import { OptimisticTracker } from '../state/optimistic-tracker';
import { UnitService } from '../../../core/unit.service';

/**
 * Strata WEIGHT sediment card. Glanceable: latest weight + a 7-day "down/up X/wk" delta, with a smoothed
 * mini trend sparkline. The sparkline draws via the in-house {@link ChartComponent} (raw `echarts.init`)
 * inside an `@defer (on viewport)` block, so the ~1MB echarts chunk stays OUT of the initial route bundle
 * and only loads once the card scrolls near. Under prefers-reduced-motion the chart gets `animation:false`
 * and the smoothing/symbols collapse.
 *
 * Reads its OWN data (these are owner-private endpoints, not part of the day DTO):
 *   - store.weightHistory(90)  → oldest-first metric kg points for the sparkline + delta
 *   - store.weightStats(90)    → per-slot averages + recent entries (latest reading)
 * Display units follow the profile (imperial → lb); the wire stays metric kg.
 *
 * Tapping the card emits {@link weigh} — the PAGE owns the weight sheet (scroll-wheel logging); this card
 * only surfaces the trend and asks to open it. After a successful logWeight the page should call
 * {@link refresh} (or re-mount) so the new point animates in. Read-only (shared) views hide the affordance.
 */
@Component({
  selector: 'app-weight-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ChartComponent],
  template: `
    <div class="wc-head">
      <button type="button" class="wc-open"
              [disabled]="opt.readOnly()"
              [attr.aria-label]="openLabel()"
              (click)="weigh.emit()">
        <span class="wc-label">Weight</span>
        @if (latestKg(); as kg) {
          <span class="wc-value">{{ disp(kg) }}<span class="wc-unit">{{ unit() }}</span></span>
        } @else {
          <span class="wc-value wc-empty-value">—</span>
        }
        @if (deltaText(); as d) {
          <span class="wc-delta" [class.up]="deltaKg() > 0" [class.down]="deltaKg() < 0">
            <span class="wc-delta-arrow" aria-hidden="true">{{ deltaArrow() }}</span>{{ d }}
          </span>
        }
      </button>

      <button type="button" class="wc-expand" [class.open]="expanded()"
              [attr.aria-expanded]="expanded()" [attr.aria-label]="expanded() ? 'Collapse weight history' : 'Expand weight history'"
              (click)="expanded.set(!expanded())">
        <span class="wc-chev" aria-hidden="true">⌄</span>
      </button>
    </div>

    <!-- Mini sparkline — echarts is code-split via @defer (on viewport): not in the initial bundle. -->
    @if (points().length > 1) {
      <div class="wc-spark" role="img" [attr.aria-label]="sparkAria()">
        @defer (on viewport) {
          <app-chart class="wc-chart" [option]="sparkOption()" />
        } @placeholder {
          <div class="wc-spark-skeleton tb-skeleton" aria-hidden="true"></div>
        } @loading (minimum 200ms) {
          <div class="wc-spark-skeleton tb-skeleton" aria-hidden="true"></div>
        }
      </div>
    } @else if (!loading()) {
      <p class="wc-none">No weight logged yet. Tap to start your trend.</p>
    }

    <!-- Expanded history — recent readings, newest first. -->
    @if (expanded() && history().length) {
      <ul class="wc-history" aria-label="Recent weigh-ins">
        @for (h of history(); track h.date + h.slot) {
          <li class="wc-row">
            <span class="wc-row-date">{{ formatDate(h.date) }}</span>
            @if (h.slot !== 'Unspecified') { <span class="wc-row-slot">{{ h.slot }}</span> }
            <span class="wc-row-leader" aria-hidden="true"></span>
            <span class="wc-row-val">{{ disp(h.weightKg) }} {{ unit() }}</span>
          </li>
        }
      </ul>
    }
  `,
  styles: [`
    :host {
      display: block;
      font-family: var(--font-ui);
      color: var(--ink);
    }

    .wc-head {
      display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;
    }

    .wc-open {
      flex: 1 1 auto; min-width: 0;
      display: flex; flex-direction: column; align-items: flex-start; gap: 2px;
      min-height: 44px;
      background: none; border: 0; margin: 0; padding: 4px 2px;
      text-align: left; cursor: pointer; color: inherit;
      border-radius: var(--r-tile);
      -webkit-tap-highlight-color: transparent;
      touch-action: manipulation;
      transition: transform 120ms var(--ease-out);
    }
    .wc-open:active:not(:disabled) { transform: scale(.985); }
    .wc-open:disabled { cursor: default; }

    .wc-label {
      font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase;
      color: var(--ink-dim);
    }
    .wc-value {
      font-family: var(--font-display);
      font-size: clamp(26px, 8vw, 34px); font-weight: 600; letter-spacing: -.025em;
      font-variant-numeric: tabular-nums; line-height: 1.05;
      display: inline-flex; align-items: baseline; gap: 3px;
    }
    .wc-empty-value { color: var(--ink-faint); }
    .wc-unit {
      font-size: 13px; font-weight: 500; letter-spacing: 0;
      color: var(--ink-dim); font-family: var(--font-ui);
    }

    .wc-delta {
      display: inline-flex; align-items: center; gap: 3px;
      font-size: 12px; font-weight: 600;
      font-variant-numeric: tabular-nums;
      color: var(--ink-dim);
    }
    .wc-delta.down { color: var(--signal); }      /* losing toward a goal reads positive */
    .wc-delta.up   { color: var(--warn); }         /* GRAFT(Daylight): warm amber, never red */
    .wc-delta-arrow { font-size: 13px; line-height: 1; }

    .wc-expand {
      flex: 0 0 auto;
      width: 44px; height: 44px; display: grid; place-items: center;
      background: none; border: 0; padding: 0; margin: 0; cursor: pointer;
      color: var(--ink-dim);
      border-radius: var(--r-pill);
      -webkit-tap-highlight-color: transparent;
      touch-action: manipulation;
    }
    .wc-chev {
      font-size: 20px; line-height: 1; display: inline-block;
      transition: transform 200ms var(--ease-out);
    }
    .wc-expand.open .wc-chev { transform: rotate(180deg); }

    .wc-spark {
      display: block; width: 100%; height: 64px; margin-top: 8px; overflow: hidden;
    }
    .wc-chart { display: block; width: 100%; height: 64px; }
    /* The shared chart floors its inner host at 300px — override so it fits the 64px sparkline band. */
    .wc-chart ::ng-deep .chart-host { min-height: 0 !important; height: 64px !important; }
    .wc-spark-skeleton { width: 100%; height: 64px; border-radius: var(--r-tile); }

    .wc-none {
      margin: 8px 0 0; font-size: 13px; color: var(--ink-faint);
    }

    .wc-history {
      list-style: none; margin: 12px 0 0; padding: 10px 0 0;
      border-top: 1px solid var(--hairline);
      display: flex; flex-direction: column; gap: 2px;
    }
    .wc-row {
      display: flex; align-items: baseline; gap: 8px;
      min-height: 32px; padding: 4px 0;
      font-size: 14px;
    }
    .wc-row-date { color: var(--ink); flex: 0 0 auto; }
    .wc-row-slot {
      font-size: 11px; letter-spacing: .03em; text-transform: uppercase;
      color: var(--ink-faint); flex: 0 0 auto;
    }
    /* GRAFT(LEDGER): 1px dotted hairline leader between the label and the tabular value. */
    .wc-row-leader {
      flex: 1 1 auto; align-self: center;
      border-bottom: 1px dotted var(--hairline); min-width: 12px;
    }
    .wc-row-val {
      flex: 0 0 auto; color: var(--ink);
      font-variant-numeric: tabular-nums;
    }
  `],
})
export class WeightCard {
  /** The optimistic wrapper — used here only for read signals (profile/readOnly). */
  protected readonly opt = inject(OptimisticTracker);
  /** The root store — the weight history/stats endpoints live here (owner-private, not on the day DTO). */
  private readonly store = inject(TrackerStore);
  /** Central display-preference seam — formats/converts canonical kg as the user's weight unit (lb / kg). */
  private readonly units = inject(UnitService);

  /** Asked-to-log: the PAGE owns the weight sheet; this card only requests it. */
  readonly weigh = output<void>();

  /** Oldest-first metric-kg trend points (last 90 days) for the sparkline + weekly delta. */
  protected readonly points = signal<WeightPointDto[]>([]);
  /** Per-slot stats + recent entries; supplies the "latest reading" and the expanded history. */
  protected readonly stats = signal<WeightStatsDto | null>(null);
  /** True while the initial fetch is in flight (drives the placeholder vs empty state). */
  protected readonly loading = signal(true);
  /** Whether the recent-history list is shown. */
  protected readonly expanded = signal(false);

  protected readonly unit = computed(() => this.units.weightUnit());

  /** Honor the OS reduce-motion setting — disables echarts animation + smoothing. */
  private readonly reduceMotion =
    typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  constructor() {
    // Fetch the owner-private history + stats once on mount. These are not part of day(), so a day
    // navigation does not auto-refresh them; the page calls refresh() after a logWeight to re-pull.
    void this.refresh();
  }

  /** (Re)load the weight history + stats. Call after a successful logWeight so the new point animates in. */
  async refresh(): Promise<void> {
    this.loading.set(true);
    try {
      const [pts, st] = await Promise.all([this.store.weightHistory(90), this.store.weightStats(90)]);
      this.points.set(pts);
      this.stats.set(st);
    } catch {
      // Leave whatever we had; the card degrades to its empty/last-known state silently.
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * Latest weight in metric kg. Prefer the freshly-patched optimistic profile on the day signal — after
   * a weigh-in the page patches `day().profile.weightKg` synchronously, so a just-logged value shows
   * instantly (before refresh() re-pulls the history). Fall back to the newest history point, then the
   * live profile.
   */
  protected readonly latestKg = computed<number | null>(() => {
    const optimistic = this.opt.day()?.profile?.weightKg;
    if (optimistic != null) return optimistic;
    const pts = this.points();
    if (pts.length) return pts[pts.length - 1].weightKg;
    return this.opt.profile()?.weightKg ?? null;
  });

  /**
   * The ~weekly change (kg): latest minus the reading closest to 7 days before the latest, normalized to
   * a 7-day rate. Negative = trending down. Null when there is not enough spread to be meaningful.
   */
  protected readonly deltaKg = computed<number>(() => {
    const pts = this.points();
    if (pts.length < 2) return 0;
    const latest = pts[pts.length - 1];
    const latestT = this.dayMs(latest.date);
    const targetT = latestT - 7 * 86_400_000;
    // Closest point at or before ~7 days ago; else the earliest point we have.
    let base = pts[0];
    for (const p of pts) {
      if (this.dayMs(p.date) <= targetT) base = p; else break;
    }
    const spanDays = Math.max(1, (latestT - this.dayMs(base.date)) / 86_400_000);
    const rawDelta = latest.weightKg - base.weightKg;
    // Normalize to a 7-day rate so "per week" is honest regardless of logging cadence.
    return (rawDelta / spanDays) * 7;
  });

  protected readonly deltaArrow = computed(() => {
    const d = this.deltaKg();
    return d > 0.05 ? '▲' : d < -0.05 ? '▼' : '–';
  });

  /** "0.4/wk" in the display unit, or null when the change rounds to zero (hide the clause). */
  protected readonly deltaText = computed<string | null>(() => {
    if (this.points().length < 2) return null;
    // The delta is a kg difference; weightToDisplay is linear so it converts the rate too (kg/wk → lb/wk).
    const dispDelta = this.units.weightToDisplay(this.deltaKg());
    const mag = Math.abs(dispDelta);
    if (mag < 0.05) return 'steady';
    return `${mag.toFixed(1)}/wk`;
  });

  protected readonly openLabel = computed(() => {
    const kg = this.latestKg();
    if (kg == null) return 'Log your weight';
    return `Weight ${this.disp(kg)} ${this.unit()}. Log a new weigh-in.`;
  });

  /** Recent weigh-ins, newest first (for the expanded list). */
  protected readonly history = computed(() => {
    const e = this.stats()?.entries ?? [];
    return [...e].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)).slice(0, 12);
  });

  /** Visually-hidden text equivalent of the sparkline canvas. */
  protected readonly sparkAria = computed(() => {
    const kg = this.latestKg();
    const unit = this.unit();
    const parts: string[] = [];
    if (kg != null) parts.push(`Weight trend. Latest ${this.disp(kg)} ${unit}.`);
    const d = this.deltaText();
    if (d && d !== 'steady') {
      const dir = this.deltaKg() < 0 ? 'down' : 'up';
      parts.push(`Trending ${dir} ${d}.`);
    } else if (d === 'steady') {
      parts.push('Holding steady.');
    }
    parts.push(`${this.points().length} readings over the last 90 days.`);
    return parts.join(' ');
  });

  /** The smoothed mini sparkline option — trend line emphasized, raw dots faded, no axes/grid chrome. */
  protected readonly sparkOption = computed<EChartsOption>(() => {
    const reduce = this.reduceMotion;
    const data = this.points().map(p => Math.round(this.units.weightToDisplay(p.weightKg) * 10) / 10);

    return {
      animation: !reduce,
      backgroundColor: 'transparent',
      grid: { left: 2, right: 2, top: 6, bottom: 4, containLabel: false },
      xAxis: { type: 'category', show: false, boundaryGap: false, data: this.points().map(p => p.date) },
      yAxis: { type: 'value', show: false, scale: true },
      tooltip: { show: false },
      series: [
        {
          type: 'line',
          data,
          smooth: reduce ? false : 0.4,
          // Raw dots faded; the trend line carries the read.
          showSymbol: !reduce && data.length <= 45,
          symbolSize: 3,
          itemStyle: { color: 'rgba(124, 92, 255, .35)' },
          lineStyle: { width: 2.5, color: '#7c5cff' },
          areaStyle: {
            opacity: reduce ? 0.1 : 0.18,
            color: {
              type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [
                { offset: 0, color: 'rgba(124, 92, 255, .30)' },
                { offset: 1, color: 'rgba(59, 130, 246, 0)' },
              ],
            },
          },
        },
      ],
    } as EChartsOption;
  });

  /** kg → display-unit number, 1 dp. */
  protected disp(kg: number): string {
    const v = this.units.weightToDisplay(kg);
    return (Math.round(v * 10) / 10).toFixed(1);
  }

  protected formatDate(date: string): string {
    return new Date(date + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  private dayMs(date: string): number {
    return new Date(date + 'T00:00:00').getTime();
  }
}
