import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { CacheEfficiency, SummaryResponse } from '../../../core/models';
import { CompactPipe } from '../../../shared/format';
import { BetaSvgRing, BetaStatTile, BetaSectionHeader, BetaSkeleton } from '../../beta-ui';

/**
 * The EFFICIENCY card — a cache cockpit, built on the shared beta-ui kit. A big {@link BetaSvgRing}
 * shows the cache-read ratio (share of prompt input served from cache), with the dollars-saved beside
 * it, and a row of {@link BetaStatTile}s for the key throughput/efficiency metrics (savings, input,
 * output, cache-write cost). Every figure comes from `cacheEfficiency` + `summary.total`, so the
 * numbers match the live dashboard. Degrades GRACEFULLY: hides itself when there's no cache data.
 */
@Component({
  selector: 'app-pulse-efficiency',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CompactPipe, BetaSvgRing, BetaStatTile, BetaSectionHeader, BetaSkeleton],
  template: `
    <div class="ef">
      <app-bs-section-header title="Cache efficiency" subtitle="Prompt input served from cache" icon="bolt" />

      @if (loading() && !cacheEff()) {
        <app-bs-skeleton height="120px" radius="var(--r-card)" />
      } @else if (cacheEff(); as c) {
        <div class="ef__ring-row">
          <app-bs-ring [value]="ratio()" [size]="108" [stroke]="11"
                       [label]="cachePct() + '% of input served from cache'">
            <div class="ef__ring-center">
              <span class="ef__ring-pct">{{ cachePct() }}<i>%</i></span>
              <span class="ef__ring-cap">cache hit</span>
            </div>
          </app-bs-ring>

          <div class="ef__saved">
            <span class="ef__saved-label">Saved by cache</span>
            <span class="ef__saved-val">\${{ savedText() }}</span>
            <span class="ef__saved-sub">{{ (c.cacheReadTokens) | compact }} tokens read from cache</span>
          </div>
        </div>

        <div class="ef__tiles">
          <app-bs-stat-tile [value]="(c.inputTokens) | compact" label="Input" />
          <app-bs-stat-tile [value]="(c.outputTokens) | compact" label="Output" />
          <app-bs-stat-tile [value]="'$' + writeCostText()" label="Cache write" />
        </div>
      } @else {
        <p class="ef__empty">No cache activity in this range</p>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .ef { display: flex; flex-direction: column; gap: 16px; }

    .ef__ring-row { display: flex; align-items: center; gap: 18px; }
    .ef__ring-center { display: flex; flex-direction: column; align-items: center; gap: 1px; line-height: 1; }
    .ef__ring-pct {
      font-family: var(--font-display); font-size: 28px; font-weight: 600; color: var(--ink);
      font-variant-numeric: tabular-nums; letter-spacing: -.02em;
    }
    .ef__ring-pct i { font-size: 15px; font-style: normal; color: var(--ink-dim); margin-left: 1px; }
    .ef__ring-cap { font-size: 10px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-dim); }

    .ef__saved { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
    .ef__saved-label { font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-dim); }
    .ef__saved-val {
      font-family: var(--font-display); font-size: 32px; font-weight: 600; color: var(--signal);
      font-variant-numeric: tabular-nums; letter-spacing: -.03em; line-height: 1;
    }
    .ef__saved-sub { font-size: 12px; font-weight: 600; color: var(--ink-dim); }

    .ef__tiles { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
    .ef__tiles app-bs-stat-tile { min-width: 0; }

    .ef__empty { margin: 12px 0; text-align: center; color: var(--ink-dim); font-size: 14px; }
  `],
})
export class PulseEfficiencyCard {
  readonly cacheEff = input<CacheEfficiency | null>(null);
  readonly summary = input<SummaryResponse | null>(null);
  readonly loading = input<boolean>(false);

  readonly ratio = computed(() => Math.max(0, Math.min(1, this.cacheEff()?.cacheReadRatio ?? 0)));
  readonly cachePct = computed(() => Math.round(this.ratio() * 100));

  readonly savedText = computed(() =>
    (this.cacheEff()?.savingsUsd ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  readonly writeCostText = computed(() =>
    (this.cacheEff()?.cacheWriteCostUsd ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

  /** Whether this card has anything to show (page auto-hides it otherwise). */
  readonly hasData = computed(() => {
    const c = this.cacheEff();
    if (!c) return false;
    return !(c.cacheReadTokens === 0 && c.inputTokens === 0 && c.cacheWriteTokens === 0);
  });
}
