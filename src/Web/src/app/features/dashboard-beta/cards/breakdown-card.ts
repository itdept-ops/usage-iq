import { DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';

import { CompactPipe } from '../../../shared/format';
import { BetaBottomSheet, BetaSegmentedControl, BetaSkeleton, BetaSectionHeader, BetaStatTile, type Segment } from '../../beta-ui';

/**
 * One ranked breakdown row — name + cost plus the full token/cache totals for that bucket (so a
 * tapped row can open a rich detail sheet WITHOUT a second fetch — every figure is mapped from the
 * same `Api.summary` bucket the page already loaded).
 */
export interface BreakdownSlice {
  readonly name: string;
  readonly costUsd: number;
  /** True when this slice's pricing is estimated (drives the "estimated" chip). Only models carry it. */
  readonly estimated?: boolean;
  // ---- full bucket totals (already in-component; power the tap-through detail sheet) ----
  readonly totalTokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly records: number;
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
  imports: [
    DecimalPipe, CompactPipe, MatIconModule,
    BetaSegmentedControl, BetaSkeleton, BetaSectionHeader, BetaBottomSheet, BetaStatTile,
  ],
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
              <button type="button" class="row__btn" (click)="openDetail(s)"
                      [attr.aria-label]="s.name + ', $' + (s.costUsd | number:'1.2-2') + ', ' + share(s.costUsd) + '% of total — tap for detail'">
                <span class="row__head">
                  <span class="row__rank">{{ i + 1 }}</span>
                  <span class="row__name" [title]="s.name">{{ s.name }}</span>
                  <span class="row__share">{{ share(s.costUsd) }}%</span>
                  <span class="row__cost">\${{ s.costUsd | number:'1.2-2' }}</span>
                  <mat-icon class="row__chev" aria-hidden="true">chevron_right</mat-icon>
                </span>
                <span class="row__meter" aria-hidden="true">
                  <span class="row__fill" [style.width.%]="pct(s.costUsd)"></span>
                </span>
              </button>
            </li>
          }
        </ol>
        @if (otherCount()) {
          <p class="bd__more">+{{ otherCount() }} more · \${{ otherCost() | number:'1.2-2' }}</p>
        }
      } @else {
        <div class="bd__empty">
          <span class="bd__empty-ic" aria-hidden="true"><mat-icon>leaderboard</mat-icon></span>
          <p class="bd__empty-msg">No cost in this range</p>
          <button type="button" class="bd__empty-cta" (click)="widen.emit()">Widen range</button>
        </div>
      }
    </div>

    <!-- Tap-through detail: full totals for the picked slice, all derived from already-loaded data. -->
    <app-bs-sheet [(open)]="detailOpen" detent="half" [label]="dimNoun() + ' detail'">
      @if (picked(); as p) {
        <div class="dt">
          <header class="dt__head">
            <span class="dt__eyebrow">{{ dimNoun() }}</span>
            <h2 class="dt__name" [title]="p.name">{{ p.name }}</h2>
            <div class="dt__big">
              <span class="dt__big-cur" aria-hidden="true">$</span>
              <span class="dt__big-val">{{ p.costUsd | number:'1.2-2' }}</span>
              <span class="dt__big-share">{{ share(p.costUsd) }}% of total</span>
            </div>
            @if (p.estimated) {
              <span class="dt__est" title="Pricing is estimated (placeholder rates)">estimated pricing</span>
            }
          </header>

          <div class="dt__tiles">
            <app-bs-stat-tile [value]="p.totalTokens | compact" label="Total tokens" />
            <app-bs-stat-tile [value]="p.records | compact" label="Records" />
            <app-bs-stat-tile [value]="p.inputTokens | compact" label="Input" />
            <app-bs-stat-tile [value]="p.outputTokens | compact" label="Output" />
          </div>

          <section class="dt__cache">
            <h3 class="dt__cache-title">Cache split</h3>
            <div class="dt__cache-row">
              <span class="dt__cache-meter" aria-hidden="true">
                <span class="dt__cache-read" [style.width.%]="cacheReadPct(p)"></span>
              </span>
              <span class="dt__cache-pct">{{ cacheReadPct(p) }}%</span>
            </div>
            <p class="dt__cache-sub">
              {{ cacheReadPct(p) }}% of input served from cache · {{ p.cacheReadTokens | compact }} read · {{ p.cacheWriteTokens | compact }} written
            </p>
          </section>
        </div>
      }
    </app-bs-sheet>
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

    .bd__list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
    .row { display: block; }
    .row__btn {
      display: flex; flex-direction: column; gap: 6px; width: 100%;
      background: none; border: 0; padding: 8px 6px; margin: 0; cursor: pointer; text-align: left;
      border-radius: var(--r-tile); font: inherit; color: inherit;
      transition: background 140ms var(--ease-out);
      -webkit-tap-highlight-color: transparent;
    }
    .row__btn:active { background: color-mix(in srgb, var(--ink) 6%, transparent); }
    .row__btn:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
    .row__head { display: flex; align-items: baseline; gap: 8px; }
    .row__chev {
      flex: 0 0 auto; align-self: center; font-size: 18px; width: 18px; height: 18px;
      color: var(--ink-faint); margin-left: -2px;
    }
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
    .bd__empty {
      display: flex; flex-direction: column; align-items: center; gap: 10px;
      margin: 16px 0; text-align: center;
    }
    .bd__empty-ic {
      display: grid; place-items: center; width: 48px; height: 48px; border-radius: 50%;
      background: color-mix(in srgb, var(--accent-a) 12%, transparent);
      color: color-mix(in srgb, var(--accent-a) 70%, var(--ink));
    }
    .bd__empty-ic mat-icon { font-size: 26px; width: 26px; height: 26px; }
    .bd__empty-msg { margin: 0; color: var(--ink-dim); font-size: 14px; font-weight: 600; }
    .bd__empty-cta {
      min-height: 44px; padding: 0 18px; border-radius: var(--r-pill); border: 0; cursor: pointer;
      background: linear-gradient(135deg, var(--accent-a), var(--accent-b)); color: var(--ink-on-accent);
      font: inherit; font-size: 14px; font-weight: 700;
      transition: transform 120ms var(--ease-spring);
    }
    .bd__empty-cta:active { transform: scale(.96); }

    /* ---- tap-through detail sheet ---- */
    .dt { display: flex; flex-direction: column; gap: 20px; padding: 4px 0 24px; }
    .dt__head { display: flex; flex-direction: column; gap: 4px; }
    .dt__eyebrow {
      font-size: 11px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; color: var(--ink-dim);
    }
    .dt__name {
      margin: 0; font-size: 19px; font-weight: 800; color: var(--ink);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .dt__big { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; margin-top: 6px; }
    .dt__big-cur {
      font-family: var(--font-display); font-weight: 600; font-size: 24px;
      color: color-mix(in srgb, var(--accent-a) 70%, var(--ink));
    }
    .dt__big-val {
      font-family: var(--font-display); font-weight: 600; font-size: 44px; line-height: .92;
      color: var(--ink); font-variant-numeric: tabular-nums; letter-spacing: -.03em;
    }
    .dt__big-share { font-size: 13px; font-weight: 700; color: var(--ink-dim); font-variant-numeric: tabular-nums; }
    .dt__est {
      align-self: flex-start; margin-top: 6px;
      font-size: 11px; font-weight: 700; letter-spacing: .03em; padding: 4px 10px; border-radius: var(--r-pill);
      background: color-mix(in srgb, var(--warn) 18%, transparent);
      color: var(--warn); border: 1px solid color-mix(in srgb, var(--warn) 38%, transparent);
    }

    .dt__tiles { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }
    .dt__tiles app-bs-stat-tile { min-width: 0; }

    .dt__cache { display: flex; flex-direction: column; gap: 8px; }
    .dt__cache-title {
      margin: 0; font-size: 12px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: var(--ink-dim);
    }
    .dt__cache-row { display: flex; align-items: center; gap: 10px; }
    .dt__cache-meter {
      flex: 1 1 auto; display: block; height: 9px; border-radius: var(--r-pill);
      background: color-mix(in srgb, var(--ink) 8%, transparent); overflow: hidden;
    }
    .dt__cache-read {
      display: block; height: 100%; border-radius: var(--r-pill);
      background: linear-gradient(90deg, var(--accent-a), var(--accent-b));
      box-shadow: 0 0 10px color-mix(in srgb, var(--accent-a) 40%, transparent);
      transition: width 600ms var(--ease-spring);
    }
    .dt__cache-pct {
      flex: 0 0 auto; font-family: var(--font-display); font-size: 15px; font-weight: 600;
      color: var(--ink); font-variant-numeric: tabular-nums;
    }
    .dt__cache-sub { margin: 0; font-size: 12px; font-weight: 600; color: var(--ink-dim); font-variant-numeric: tabular-nums; }
  `],
})
export class PulseBreakdownCard {
  /** Full ranked slices for the active dimension (page supplies, sorted desc by cost). */
  readonly slices = input<BreakdownSlice[]>([]);
  readonly dim = input.required<BreakdownDim>();
  readonly loading = input<boolean>(false);

  /** Emitted when the user flips the dimension toggle (page swaps the slices). */
  readonly dimChange = output<BreakdownDim>();

  /** Emitted from the empty-state CTA so the page can widen to the all-time range. */
  readonly widen = output<void>();

  protected readonly dimSegs: Segment[] = [
    { key: 'model', label: 'Model' },
    { key: 'source', label: 'Source' },
    { key: 'project', label: 'Project' },
  ];

  protected readonly subLabel = computed(() => {
    const d = this.dim();
    return d === 'model' ? 'Cost by model' : d === 'source' ? 'Cost by source' : 'Cost by project';
  });

  /** Singular noun for the active dimension (detail-sheet eyebrow + aria). */
  protected readonly dimNoun = computed(() => {
    const d = this.dim();
    return d === 'model' ? 'Model' : d === 'source' ? 'Source' : 'Project';
  });

  // ---- tap-through detail sheet (no extra fetch — slices already carry the full totals) ----
  readonly detailOpen = signal(false);
  readonly picked = signal<BreakdownSlice | null>(null);

  protected openDetail(s: BreakdownSlice): void {
    this.picked.set(s);
    this.detailOpen.set(true);
  }

  /** Cache-read share of input for the picked slice: read / (read + input), rounded. */
  protected cacheReadPct(s: BreakdownSlice): number {
    const denom = s.cacheReadTokens + s.inputTokens;
    return denom > 0 ? Math.round((s.cacheReadTokens / denom) * 100) : 0;
  }

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
