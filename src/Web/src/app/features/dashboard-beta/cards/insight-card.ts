import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';

import { CacheEfficiency, SummaryResponse } from '../../../core/models';
import { BetaSkeleton } from '../../beta-ui';

/**
 * The INSIGHTS card — at-a-glance, fully-derived takeaways with NO extra fetch. Two insights, both
 * computed from data the page already holds:
 *
 *  • "Top day" — the single highest-spend day in the active range, read straight from the day-grouped
 *    summary buckets (`summary.buckets`), shown with its date + dollar amount + share of the range.
 *  • "Cache efficiency" — a one-line "X% of input tokens were cache reads — saved ~$Y", surfaced only
 *    when the loaded summary/cacheEfficiency actually carry cache reads (degrades to hidden otherwise).
 *
 * The Top-day insight only makes sense over DAY buckets; the page hides this card when grouped by
 * month (so a "day" label is never a month). The card self-hides when it has nothing to say.
 */
@Component({
  selector: 'app-pulse-insight',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, BetaSkeleton],
  template: `
    <div class="in">
      @if (loading() && !summary()) {
        <app-bs-skeleton height="92px" radius="var(--r-card)" />
      } @else {
        @if (topDay(); as td) {
          <div class="in__row in__row--top">
            <span class="in__ic" aria-hidden="true"><mat-icon>local_fire_department</mat-icon></span>
            <div class="in__text">
              <span class="in__eyebrow">Top day</span>
              <span class="in__head">
                <span class="in__amt">\${{ td.amount }}</span>
                <span class="in__on">on {{ td.label }}</span>
              </span>
              <span class="in__sub">{{ td.share }}% of this range’s spend</span>
            </div>
          </div>
        }

        @if (cacheLine(); as cl) {
          <div class="in__row in__row--cache" [class.in__row--first]="!topDay()">
            <span class="in__ic in__ic--alt" aria-hidden="true"><mat-icon>bolt</mat-icon></span>
            <div class="in__text">
              <span class="in__eyebrow">Cache efficiency</span>
              <span class="in__cache-line">
                <b>{{ cl.pct }}%</b> of input tokens were cache reads
                @if (cl.savedText) { <span class="in__saved">— saved ~\${{ cl.savedText }}</span> }
              </span>
            </div>
          </div>
        }
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .in { display: flex; flex-direction: column; gap: 4px; }

    .in__row {
      display: flex; align-items: flex-start; gap: 14px;
      padding: 14px 4px;
    }
    .in__row--cache:not(.in__row--first) { border-top: 1px solid var(--hairline); }

    .in__ic {
      flex: 0 0 auto; display: grid; place-items: center; width: 40px; height: 40px; border-radius: 50%;
      background: color-mix(in srgb, var(--accent-a) 16%, transparent);
      color: color-mix(in srgb, var(--accent-a) 78%, var(--ink));
    }
    .in__ic--alt {
      background: color-mix(in srgb, var(--signal) 16%, transparent);
      color: var(--signal);
    }
    .in__ic mat-icon { font-size: 22px; width: 22px; height: 22px; }

    .in__text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .in__eyebrow {
      font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-dim);
    }
    .in__head { display: flex; align-items: baseline; gap: 7px; flex-wrap: wrap; }
    .in__amt {
      font-family: var(--font-display); font-size: 22px; font-weight: 600; color: var(--ink);
      font-variant-numeric: tabular-nums; letter-spacing: -.02em; line-height: 1.1;
    }
    .in__on { font-size: 14px; font-weight: 600; color: var(--ink-dim); }
    .in__sub { font-size: 12px; font-weight: 600; color: var(--ink-faint); font-variant-numeric: tabular-nums; }

    .in__cache-line { font-size: 14px; font-weight: 600; color: var(--ink); line-height: 1.35; }
    .in__cache-line b { font-family: var(--font-display); font-weight: 700; font-variant-numeric: tabular-nums; }
    .in__saved { color: var(--signal); font-weight: 700; }
  `],
})
export class PulseInsightCard {
  readonly summary = input<SummaryResponse | null>(null);
  readonly cacheEff = input<CacheEfficiency | null>(null);
  readonly loading = input<boolean>(false);

  /**
   * The single highest-spend bucket in the range. Built from the SAME day-grouped summary buckets the
   * trend chart uses; null when there are no cost-bearing buckets. The page only renders this card on
   * the 'day' grouping, so the bucket key IS a date.
   */
  protected readonly topDay = computed(() => {
    const buckets = this.summary()?.buckets ?? [];
    if (!buckets.length) return null;
    let best = buckets[0];
    for (const b of buckets) if (b.costUsd > best.costUsd) best = b;
    if (best.costUsd <= 0) return null;
    const total = buckets.reduce((sum, b) => sum + b.costUsd, 0);
    const share = total > 0 ? Math.round((best.costUsd / total) * 100) : 0;
    return {
      amount: best.costUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      label: formatDayKey(best.key),
      share,
    };
  });

  /**
   * The cache-efficiency takeaway: percentage of input tokens served from cache + dollars saved.
   * Prefers the dedicated `cacheEfficiency` figures (ratio + savings); falls back to the summary's
   * own cache/input token fields for the ratio. Null when there's no cache activity to talk about.
   */
  protected readonly cacheLine = computed(() => {
    const ce = this.cacheEff();
    const t = this.summary()?.total;

    const reads = ce?.cacheReadTokens ?? t?.cacheReadTokens ?? 0;
    const input = ce?.inputTokens ?? t?.inputTokens ?? 0;
    if (reads <= 0 || reads + input <= 0) return null;

    const ratio = ce && ce.cacheReadRatio > 0 ? ce.cacheReadRatio : reads / (reads + input);
    const pct = Math.round(ratio * 100);
    if (pct <= 0) return null;

    const saved = ce?.savingsUsd ?? 0;
    const savedText = saved > 0
      ? saved.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : '';
    return { pct, savedText };
  });
}

/** Render a "YYYY-MM-DD" day-bucket key as a friendly "Mon, Jun 24". Non-date keys pass through. */
function formatDayKey(key: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return key;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return key;
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}
