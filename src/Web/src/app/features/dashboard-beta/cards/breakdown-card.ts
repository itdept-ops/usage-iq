import { DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

import { BetaSegmentedControl, BetaSkeleton, BetaSectionHeader, type Segment } from '../../beta-ui';

/** One ranked breakdown row — name + cost, dimension-agnostic. */
export interface BreakdownSlice {
  readonly name: string;
  readonly costUsd: number;
  /** True when this slice's pricing is estimated (drives the "estimated" chip). Only models carry it. */
  readonly estimated?: boolean;
}

export type BreakdownDim = 'model' | 'source' | 'project';

/**
 * The BREAKDOWN card — a per-MODEL / per-SOURCE / per-PROJECT ranked list, rebuilt on the shared
 * beta-ui kit. A {@link BetaSegmentedControl} flips the dimension; the page supplies the slices per
 * dimension (fetched via the SAME `Api.summary` grouped by that dimension, so totals match the live
 * page). Each row is a horizontal ACCENT BAR proportional to its share of total cost, with the cost +
 * share %. An "estimated" chip appears when any visible model slice uses placeholder pricing. Tasteful
 * skeleton while loading; a clean empty state otherwise.
 */
@Component({
  selector: 'app-pulse-breakdown',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DecimalPipe, BetaSegmentedControl, BetaSkeleton, BetaSectionHeader],
  template: `
    <div class="bd">
      <app-bs-section-header title="Breakdown" [subtitle]="subLabel()" icon="leaderboard" />

      <div class="bd__bar">
        <app-bs-segmented class="bd__seg" [segments]="dimSegs" [value]="dim()"
                          label="Breakdown dimension" (change)="dimChange.emit($any($event))" />
        @if (hasEstimated()) {
          <span class="bd__chip" title="Some pricing is estimated (placeholder rates)">estimated</span>
        }
      </div>

      @if (loading() && !slices().length) {
        <div class="bd__skeleton">
          @for (i of [1,2,3,4]; track i) { <app-bs-skeleton height="34px" radius="var(--r-tile)" /> }
        </div>
      } @else if (top().length) {
        <ol class="bd__list">
          @for (s of top(); track s.name; let i = $index) {
            <li class="row">
              <span class="row__head">
                <span class="row__rank">{{ i + 1 }}</span>
                <span class="row__name" [title]="s.name">{{ s.name }}</span>
                <span class="row__share">{{ share(s.costUsd) }}%</span>
                <span class="row__cost">\${{ s.costUsd | number:'1.2-2' }}</span>
              </span>
              <span class="row__meter" aria-hidden="true">
                <span class="row__fill" [style.width.%]="pct(s.costUsd)"></span>
              </span>
            </li>
          }
        </ol>
        @if (otherCount()) {
          <p class="bd__more">+{{ otherCount() }} more · \${{ otherCost() | number:'1.2-2' }}</p>
        }
      } @else {
        <p class="bd__empty">No cost in this range</p>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .bd { display: flex; flex-direction: column; gap: 14px; }

    .bd__bar { display: flex; align-items: center; gap: 10px; }
    .bd__seg { flex: 1 1 auto; min-width: 0; }
    .bd__chip {
      flex: 0 0 auto;
      font-size: 11px; font-weight: 700; letter-spacing: .03em; padding: 4px 10px; border-radius: var(--r-pill);
      background: color-mix(in srgb, var(--warn) 18%, transparent);
      color: var(--warn); border: 1px solid color-mix(in srgb, var(--warn) 38%, transparent);
    }

    .bd__skeleton { display: flex; flex-direction: column; gap: 10px; }

    .bd__list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 12px; }
    .row { display: flex; flex-direction: column; gap: 6px; }
    .row__head { display: flex; align-items: baseline; gap: 8px; }
    .row__rank {
      flex: 0 0 auto; width: 18px; text-align: center;
      font-family: var(--font-display); font-size: 13px; font-weight: 600; color: var(--ink-faint);
      font-variant-numeric: tabular-nums;
    }
    .row__name {
      flex: 1 1 auto; min-width: 0; font-size: 14px; font-weight: 600; color: var(--ink);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .row__share {
      flex: 0 0 auto; font-size: 12px; font-weight: 700; color: var(--ink-dim); font-variant-numeric: tabular-nums;
    }
    .row__cost {
      flex: 0 0 auto; font-family: var(--font-display); font-size: 14px; font-weight: 600; color: var(--ink);
      font-variant-numeric: tabular-nums;
    }
    .row__meter {
      display: block; height: 7px; border-radius: var(--r-pill);
      background: color-mix(in srgb, var(--ink) 7%, transparent); overflow: hidden;
    }
    .row__fill {
      display: block; height: 100%; border-radius: var(--r-pill);
      background: linear-gradient(90deg, var(--accent-a), var(--accent-b));
      box-shadow: 0 0 10px color-mix(in srgb, var(--accent-a) 40%, transparent);
      transition: width 600ms var(--ease-spring);
    }
    .bd__more { margin: 2px 0 0; font-size: 12px; font-weight: 600; color: var(--ink-faint); font-variant-numeric: tabular-nums; }
    .bd__empty { margin: 16px 0; text-align: center; color: var(--ink-dim); font-size: 14px; }
  `],
})
export class PulseBreakdownCard {
  /** Full ranked slices for the active dimension (page supplies, sorted desc by cost). */
  readonly slices = input<BreakdownSlice[]>([]);
  readonly dim = input.required<BreakdownDim>();
  readonly loading = input<boolean>(false);

  /** Emitted when the user flips the dimension toggle (page swaps the slices). */
  readonly dimChange = output<BreakdownDim>();

  protected readonly dimSegs: Segment[] = [
    { key: 'model', label: 'Model' },
    { key: 'source', label: 'Source' },
    { key: 'project', label: 'Project' },
  ];

  protected readonly subLabel = computed(() => {
    const d = this.dim();
    return d === 'model' ? 'Cost by model' : d === 'source' ? 'Cost by source' : 'Cost by project';
  });

  /** Cost-bearing slices only. */
  private readonly positive = computed(() => this.slices().filter(s => s.costUsd > 0));
  /** Top 6 cost-bearing slices. */
  readonly top = computed(() => this.positive().slice(0, 6));

  readonly hasEstimated = computed(() => this.top().some(s => s.estimated));

  /** Total cost across ALL positive slices (share % denominator). */
  private readonly totalCost = computed(() => this.positive().reduce((sum, s) => sum + s.costUsd, 0));
  private readonly maxCost = computed(() => Math.max(0, ...this.top().map(s => s.costUsd)));

  readonly otherCount = computed(() => Math.max(0, this.positive().length - this.top().length));
  readonly otherCost = computed(() =>
    this.positive().slice(6).reduce((sum, s) => sum + s.costUsd, 0));

  /** Bar fill as a fraction of the largest visible slice (so #1 is full-width). */
  pct(c: number): number {
    const m = this.maxCost();
    return m > 0 ? (c / m) * 100 : 0;
  }
  /** Share of the grand total, rounded for the label. */
  share(c: number): string {
    const t = this.totalCost();
    if (t <= 0) return '0';
    const p = (c / t) * 100;
    return p >= 10 ? Math.round(p).toString() : p.toFixed(1).replace(/\.0$/, '');
  }
}
