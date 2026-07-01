import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';

import { PagedResult, UsageRecord } from '../../../core/models';
import { CompactPipe } from '../../../shared/format';
import { BetaSectionHeader, BetaSkeleton, BetaSegmentedControl, type Segment } from '../../beta-ui';

/** Server sort keys accepted by Api.records (date/model/input/output/cost). */
export type RecordSort = 'timestamp' | 'model' | 'input' | 'output' | 'cost';

/**
 * The RECENT feed — a vertical two-line list of {@link UsageRecord}s for the current filter, rebuilt
 * on the shared beta-ui kit. Fetched via the SAME `Api.records` paging the live dashboard uses
 * (page/pageSize/sort/desc). Infinite scroll: a "Load more" affordance emits `more` when there are
 * further pages. Rows are 56px touch targets. Tasteful skeleton rows while loading.
 */
@Component({
  selector: 'app-pulse-recent',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, CompactPipe, MatIconModule, BetaSectionHeader, BetaSkeleton, BetaSegmentedControl],
  template: `
    <div class="rf">
      <app-bs-section-header title="Recent" [subtitle]="countLabel()" icon="receipt_long" />

      <div class="rf__sort-scroll">
        <app-bs-segmented class="rf__sort" [segments]="sortSegs" [value]="sort()"
                          label="Sort records" (change)="sortChange.emit($any($event))" />
      </div>

      @if (loading() && !items().length) {
        <div class="rf__skeleton">
          @for (i of [1,2,3,4,5]; track i) {
            <div class="rf__sk-row">
              <app-bs-skeleton width="55%" height="14px" />
              <app-bs-skeleton width="70%" height="11px" />
            </div>
          }
        </div>
      } @else if (items().length) {
        <ul class="rf__list">
          @for (r of items(); track r.id) {
            <li class="rec">
              <span class="rec__orb" aria-hidden="true">{{ modelInitial(r.model) }}</span>
              <span class="rec__body">
                <span class="rec__main">
                  <span class="rec__model">{{ r.model || 'unknown' }}</span>
                  <span class="rec__cost">\${{ fmtCost(r.costUsd) }}</span>
                </span>
                <span class="rec__meta">
                  <span class="rec__when">{{ r.timestampUtc | date:'MMM d, h:mm a' }}</span>
                  <span class="rec__dot" aria-hidden="true">·</span>
                  <span class="rec__proj">{{ r.projectName || r.source }}</span>
                  @if (r.isSidechain) { <span class="rec__tag">subagent</span> }
                  <span class="rec__tok">{{ r.totalTokens | compact }} tok</span>
                </span>
              </span>
            </li>
          }
        </ul>

        @if (hasMore()) {
          <button type="button" class="rf__more" [disabled]="loadingMore()" (click)="more.emit()">
            {{ loadingMore() ? 'Loading…' : 'Load more' }}
          </button>
        }
      } @else {
        <div class="rf__empty">
          <span class="rf__empty-ic" aria-hidden="true"><mat-icon>receipt_long</mat-icon></span>
          <p class="rf__empty-msg">No records in this range</p>
          <button type="button" class="rf__empty-cta" (click)="widen.emit()">Widen range</button>
        </div>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .rf { display: flex; flex-direction: column; gap: 12px; }

    /* 5 sort options overflow 390px — scroll the segmented control horizontally, momentum + hidden bar. */
    .rf__sort-scroll {
      overflow-x: auto; overflow-y: hidden; -webkit-overflow-scrolling: touch;
      overscroll-behavior-x: contain; scrollbar-width: none; margin-inline: -2px; padding: 2px;
    }
    .rf__sort-scroll::-webkit-scrollbar { display: none; }
    .rf__sort-scroll app-bs-segmented { min-width: max-content; }

    .rf__skeleton { display: flex; flex-direction: column; gap: 16px; padding: 4px 0; }
    .rf__sk-row { display: flex; flex-direction: column; gap: 7px; }

    .rf__list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
    .rec {
      display: flex; align-items: center; gap: 12px; min-height: 56px;
      padding: 10px 0; border-bottom: 1px solid var(--hairline);
    }
    .rec:last-child { border-bottom: 0; }
    .rec__orb {
      flex: 0 0 auto; width: 36px; height: 36px; border-radius: 50%; display: grid; place-items: center;
      background: color-mix(in srgb, var(--accent-a) 18%, transparent);
      color: color-mix(in srgb, var(--accent-a) 80%, var(--ink));
      font-family: var(--font-display); font-size: 14px; font-weight: 700; text-transform: uppercase;
      user-select: none;
    }
    .rec__body { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
    .rec__main { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
    .rec__model { font-size: 14px; font-weight: 600; color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .rec__cost {
      flex: 0 0 auto; font-family: var(--font-display); font-size: 14px; font-weight: 600;
      color: color-mix(in srgb, var(--accent-a) 70%, var(--ink)); font-variant-numeric: tabular-nums;
    }
    .rec__meta { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; font-size: 12px; color: var(--ink-dim); }
    .rec__dot { opacity: .6; }
    .rec__proj { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 45%; }
    .rec__tok { margin-left: auto; font-variant-numeric: tabular-nums; }
    .rec__tag {
      font-size: 10px; font-weight: 700; letter-spacing: .03em; padding: 1px 7px; border-radius: var(--r-pill);
      background: color-mix(in srgb, var(--accent-b) 22%, transparent); color: color-mix(in srgb, var(--accent-b) 80%, var(--ink));
    }

    .rf__more {
      min-height: 48px; border-radius: var(--r-pill); border: 1px solid var(--hairline);
      background: var(--bg-rise); color: var(--ink); font: inherit; font-size: 14px; font-weight: 700;
      cursor: pointer; margin-top: 4px;
      transition: transform 120ms var(--ease-spring), box-shadow 160ms var(--ease-out), background 160ms var(--ease-out);
    }
    .rf__more:hover:not(:disabled) { background: color-mix(in srgb, var(--accent-a) 8%, var(--bg-rise)); box-shadow: var(--lift-2); transform: translateY(-1px); }
    .rf__more:active { transform: scale(.98); }
    .rf__more:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
    .rf__more:disabled { opacity: .6; cursor: not-allowed; }
    .rf__empty {
      display: flex; flex-direction: column; align-items: center; gap: 10px;
      margin: 16px 0; text-align: center;
    }
    .rf__empty-ic {
      display: grid; place-items: center; width: 48px; height: 48px; border-radius: 50%;
      background: color-mix(in srgb, var(--accent-a) 12%, transparent);
      color: color-mix(in srgb, var(--accent-a) 70%, var(--ink));
    }
    .rf__empty-ic mat-icon { font-size: 26px; width: 26px; height: 26px; }
    .rf__empty-msg { margin: 0; color: var(--ink-dim); font-size: 14px; font-weight: 600; }
    .rf__empty-cta {
      min-height: 44px; padding: 0 18px; border-radius: var(--r-pill); border: 0; cursor: pointer;
      background: linear-gradient(135deg, var(--accent-a), var(--accent-b)); color: var(--ink-on-accent);
      font: inherit; font-size: 14px; font-weight: 700;
      box-shadow: 0 4px 14px -4px color-mix(in srgb, var(--accent-a) 50%, transparent);
      transition: transform 120ms var(--ease-spring), box-shadow 160ms var(--ease-out);
    }
    .rf__empty-cta:hover { transform: translateY(-1px); box-shadow: 0 8px 22px -6px color-mix(in srgb, var(--accent-a) 60%, transparent); }
    .rf__empty-cta:active { transform: scale(.96); box-shadow: none; }
    .rf__empty-cta:focus-visible { outline: 2px solid var(--focus); outline-offset: 3px; }
  `],
})
export class PulseRecentFeed {
  readonly page = input<PagedResult<UsageRecord> | null>(null);
  readonly loading = input<boolean>(false);
  readonly loadingMore = input<boolean>(false);
  /** Active server sort key (owned by the page; the feed just reflects + emits changes). */
  readonly sort = input<RecordSort>('timestamp');

  /** Emitted when the user picks a different sort; the page refetches page 1 with it. */
  readonly sortChange = output<RecordSort>();

  protected readonly sortSegs: Segment[] = [
    { key: 'timestamp', label: 'Date' },
    { key: 'cost', label: 'Cost' },
    { key: 'model', label: 'Model' },
    { key: 'input', label: 'Input' },
    { key: 'output', label: 'Output' },
  ];

  /** Emitted to ask the page for the next page (it appends + re-renders). */
  readonly more = output<void>();

  /** Emitted from the empty-state CTA so the page can widen to the all-time range. */
  readonly widen = output<void>();

  readonly items = computed(() => this.page()?.items ?? []);

  readonly countLabel = computed(() => {
    const t = this.page()?.total;
    return t ? `${t.toLocaleString()} total` : '';
  });

  readonly hasMore = computed(() => {
    const p = this.page();
    if (!p) return false;
    return p.page < Math.ceil(p.total / p.pageSize);
  });

  fmtCost(c: number): string {
    return c.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  /** One-letter orb initial for the model name (first non-whitespace char). */
  modelInitial(model: string | null | undefined): string {
    const s = (model || '?').trim();
    return s.charAt(0).toUpperCase();
  }
}
