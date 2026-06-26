import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

import { PagedResult, UsageRecord } from '../../../core/models';
import { CompactPipe } from '../../../shared/format';
import { BetaSectionHeader, BetaSkeleton } from '../../beta-ui';

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
  imports: [DatePipe, CompactPipe, BetaSectionHeader, BetaSkeleton],
  template: `
    <div class="rf">
      <app-bs-section-header title="Recent" [subtitle]="countLabel()" icon="receipt_long" />

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
            </li>
          }
        </ul>

        @if (hasMore()) {
          <button type="button" class="rf__more" [disabled]="loadingMore()" (click)="more.emit()">
            {{ loadingMore() ? 'Loading…' : 'Load more' }}
          </button>
        }
      } @else {
        <p class="rf__empty">No records in this range</p>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .rf { display: flex; flex-direction: column; gap: 12px; }

    .rf__skeleton { display: flex; flex-direction: column; gap: 16px; padding: 4px 0; }
    .rf__sk-row { display: flex; flex-direction: column; gap: 7px; }

    .rf__list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
    .rec {
      display: flex; flex-direction: column; gap: 3px; min-height: 56px; justify-content: center;
      padding: 10px 0; border-bottom: 1px solid var(--hairline);
    }
    .rec:last-child { border-bottom: 0; }
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
      cursor: pointer; margin-top: 4px; transition: transform 120ms var(--ease-spring);
    }
    .rf__more:active { transform: scale(.98); }
    .rf__more:disabled { opacity: .6; }
    .rf__empty { margin: 16px 0; text-align: center; color: var(--ink-dim); font-size: 14px; }
  `],
})
export class PulseRecentFeed {
  readonly page = input<PagedResult<UsageRecord> | null>(null);
  readonly loading = input<boolean>(false);
  readonly loadingMore = input<boolean>(false);

  /** Emitted to ask the page for the next page (it appends + re-renders). */
  readonly more = output<void>();

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
}
