import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';

import { GroupBy, SummaryResponse } from '../../../core/models';
import { BetaSegmentedControl, BetaSkeleton, BetaSectionHeader, type Segment } from '../../beta-ui';

type Metric = 'cost' | 'tokens';

/**
 * The TREND card — one honest time-series, rebuilt on the shared beta-ui kit. A hand-rolled SVG
 * GRADIENT AREA chart (accent stroke over a soft area fill, never flat) of Cost OR Tokens over the
 * day/month buckets, flipped by two {@link BetaSegmentedControl}s: Day/Month (re-fetches `groupBy`,
 * bubbled to the page) and Cost/Tokens (local, no network). The bucket mapping mirrors the live
 * dashboard's time branch, so the curve matches for the same filter. Tasteful skeleton while loading,
 * a clean empty state otherwise. Honors reduced-motion (the host killswitch collapses the draw-in).
 */
@Component({
  selector: 'app-pulse-trend',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BetaSegmentedControl, BetaSkeleton, BetaSectionHeader],
  template: `
    <div class="trend">
      <app-bs-section-header title="Trend" [subtitle]="subLabel()" icon="show_chart" />

      <div class="trend__segs">
        <app-bs-segmented class="trend__seg" [segments]="groupSegs" [value]="groupBy()"
                          label="Group by" (change)="onGroup($event)" />
        <app-bs-segmented class="trend__seg" [segments]="metricSegs" [value]="metric()"
                          label="Metric" (change)="metric.set($any($event))" />
      </div>

      @if (loading() && !summary()) {
        <div class="trend__skeleton">
          <app-bs-skeleton height="180px" radius="var(--r-tile)" />
        </div>
      } @else if (chart(); as c) {
        <div class="trend__chart">
          <svg [attr.viewBox]="'0 0 ' + VW + ' ' + VH" preserveAspectRatio="none"
               class="trend__svg" role="img" [attr.aria-label]="ariaLabel()"
               [style.--len]="c.len">
            <defs>
              <linearGradient [attr.id]="lineId" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0" stop-color="var(--accent-a)" />
                <stop offset="1" stop-color="var(--accent-b)" />
              </linearGradient>
              <linearGradient [attr.id]="fillId" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stop-color="var(--accent-a)" stop-opacity="0.30" />
                <stop offset="1" stop-color="var(--accent-a)" stop-opacity="0" />
              </linearGradient>
            </defs>
            <!-- baseline gridlines -->
            @for (g of c.grid; track g) {
              <line class="trend__grid" [attr.x1]="0" [attr.x2]="VW" [attr.y1]="g" [attr.y2]="g" />
            }
            <path [attr.d]="c.area" [attr.fill]="'url(#' + fillId + ')'" />
            <path class="trend__line" [attr.d]="c.line" fill="none" [attr.stroke]="'url(#' + lineId + ')'"
                  stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" />
            <circle [attr.cx]="c.peakX" [attr.cy]="c.peakY" r="3.4" fill="var(--accent-b)" />
          </svg>
          <div class="trend__axis">
            <span>{{ c.firstKey }}</span>
            @if (c.midKey) { <span>{{ c.midKey }}</span> }
            <span>{{ c.lastKey }}</span>
          </div>
        </div>

        <div class="trend__legend">
          <span class="trend__peak">
            Peak {{ metric() === 'cost' ? '$' + c.peakLabel : c.peakLabel }} · {{ c.peakKey }}
          </span>
        </div>
      } @else {
        <p class="trend__empty">No data in this range</p>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .trend { display: flex; flex-direction: column; gap: 14px; }

    .trend__segs { display: flex; flex-direction: column; gap: 8px; }
    /* NOTE: never set a display value on app-bs-segmented — it clobbers the kit host inline-flex
       (equal specificity) and collapses the control. It is already width:100% as a flex item. */

    .trend__skeleton { padding-top: 4px; }

    .trend__chart { display: flex; flex-direction: column; gap: 6px; }
    .trend__svg {
      width: 100%; height: 190px; display: block; overflow: visible;
    }
    .trend__line {
      stroke-dasharray: var(--len, 0); stroke-dashoffset: var(--len, 0);
      animation: trend-draw 900ms var(--ease-out) forwards;
    }
    @keyframes trend-draw { to { stroke-dashoffset: 0; } }
    @media (prefers-reduced-motion: reduce) { .trend__line { animation: none; stroke-dashoffset: 0; } }
    .trend__grid { stroke: var(--hairline); stroke-width: 1; vector-effect: non-scaling-stroke; }

    .trend__axis {
      display: flex; justify-content: space-between; gap: 8px;
      font-size: 11px; font-weight: 600; color: var(--ink-faint); font-variant-numeric: tabular-nums;
    }
    .trend__legend { display: flex; align-items: center; gap: 8px; }
    .trend__peak {
      font-size: 12px; font-weight: 700; color: var(--ink-dim); font-variant-numeric: tabular-nums;
    }
    .trend__empty { margin: 24px 0; text-align: center; color: var(--ink-dim); font-size: 14px; }
  `],
})
export class PulseTrendCard {
  readonly summary = input<SummaryResponse | null>(null);
  readonly loading = input<boolean>(false);
  readonly groupBy = input.required<GroupBy>();

  /** Bubbled up so the page can re-fetch the summary with the new groupBy. */
  readonly groupByChange = output<GroupBy>();

  readonly metric = signal<Metric>('cost');

  protected readonly groupSegs: Segment[] = [
    { key: 'day', label: 'Day' },
    { key: 'month', label: 'Month' },
  ];
  protected readonly metricSegs: Segment[] = [
    { key: 'cost', label: 'Cost' },
    { key: 'tokens', label: 'Tokens' },
  ];

  protected readonly VW = 320;
  protected readonly VH = 190;

  /** Unique gradient ids so multiple instances don't collide. */
  protected readonly lineId = `trend-line-${Math.random().toString(36).slice(2, 8)}`;
  protected readonly fillId = `trend-fill-${Math.random().toString(36).slice(2, 8)}`;

  protected readonly subLabel = computed(() =>
    this.metric() === 'cost' ? 'Cost (USD)' : 'Total tokens');

  protected onGroup(g: string): void {
    if (this.groupBy() !== g) this.groupByChange.emit(g as GroupBy);
  }

  protected ariaLabel(): string {
    return `${this.metric() === 'cost' ? 'Cost' : 'Tokens'} trend by ${this.groupBy()}`;
  }

  /** Build the SVG area-chart geometry from the summary buckets for the active metric. */
  readonly chart = computed(() => {
    const s = this.summary();
    if (!s || s.buckets.length === 0) return null;

    const isCost = this.metric() === 'cost';
    const keys = s.buckets.map(b => b.key);
    const vals = isCost ? s.buckets.map(b => +b.costUsd.toFixed(2)) : s.buckets.map(b => b.totalTokens);

    const W = this.VW, H = this.VH, PAD_Y = 10;
    const max = Math.max(...vals);
    const min = Math.min(0, ...vals);
    const span = max - min || 1;
    const n = vals.length;

    const pts = vals.map((v, i) => {
      const x = n === 1 ? W / 2 : (i / (n - 1)) * W;
      const y = PAD_Y + (1 - (v - min) / span) * (H - PAD_Y * 2);
      return { x, y };
    });

    const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ');
    const area = `${line} L${W} ${H} L0 ${H} Z`;

    // Approx path length for the draw-in dash animation (sum of segment lengths).
    let len = 0;
    for (let i = 1; i < pts.length; i++) {
      len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    }

    // Peak point + its key/label.
    let peakIdx = 0;
    for (let i = 1; i < vals.length; i++) if (vals[i] > vals[peakIdx]) peakIdx = i;
    const peak = pts[peakIdx];

    // 3 baseline gridlines across the band.
    const grid = [0.25, 0.5, 0.75].map(f => +(PAD_Y + f * (H - PAD_Y * 2)).toFixed(1));

    return {
      line, area,
      grid,
      peakX: peak.x, peakY: peak.y,
      peakKey: keys[peakIdx],
      peakLabel: isCost
        ? vals[peakIdx].toLocaleString(undefined, { maximumFractionDigits: 2 })
        : shortNum(vals[peakIdx]),
      firstKey: keys[0],
      midKey: keys.length > 2 ? keys[Math.floor((keys.length - 1) / 2)] : '',
      lastKey: keys[keys.length - 1],
      len,
    };
  });
}

/** B/M/K compact formatter (copied from the live dashboard's shortNum). */
function shortNum(v: number): string {
  if (Math.abs(v) >= 1e9) return (v / 1e9).toFixed(1) + 'B';
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return `${v}`;
}
