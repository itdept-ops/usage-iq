import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { CacheEfficiency, SummaryResponse } from '../../../core/models';
import { CompactPipe } from '../../../shared/format';

/**
 * The HERO spend card — the immersive cockpit headline, rebuilt on the shared beta-ui "Strata" kit.
 * A big Clash Display total cost over the active range, a signed delta vs the previous equivalent
 * period, an inline SVG gradient SPARKLINE of the trend (accent stroke + soft area fill, never flat),
 * and a secondary stat strip (tokens / records / cache-hit %). Every figure comes straight from
 * `summary.total`, the prior-period summary, and `cacheEfficiency`, so the numbers match the live
 * dashboard exactly.
 *
 * Reads the page accent (--accent-a/--accent-b) + ink/glass/elevation tokens off the host cascade —
 * no isolated palette. Cache-hit degrades GRACEFULLY: when `cacheEff` is null/empty the chip hides.
 */
@Component({
  selector: 'app-pulse-hero',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CompactPipe],
  template: `
    <div class="hero">
      <div class="hero__glow" aria-hidden="true"></div>

      <div class="hero__top">
        <span class="hero__label">Total spend</span>
        @if (delta() !== null) {
          <span class="hero__delta" [class.is-up]="delta()! > 0" [class.is-down]="delta()! < 0"
                [attr.title]="'vs ' + prevLabel()">
            <span class="hero__delta-arrow" aria-hidden="true">{{ delta()! >= 0 ? '▲' : '▼' }}</span>
            <span aria-hidden="true">{{ absDeltaPct() }}%</span>
            <span class="hero__sr">{{ deltaSr() }}</span>
          </span>
        } @else {
          <span class="hero__delta hero__delta--none">no prior period to compare</span>
        }
      </div>

      <div class="hero__cost-row">
        <div class="hero__cost-wrap">
          <span class="hero__cur" aria-hidden="true">$</span>
          <span class="hero__cost">{{ costText() }}</span>
        </div>

        @if (spark(); as sp) {
          <svg class="hero__spark" viewBox="0 0 120 44" preserveAspectRatio="none"
               role="img" aria-label="Spend trend over the selected range">
            <defs>
              <linearGradient [attr.id]="lineId" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0" stop-color="var(--accent-a)" />
                <stop offset="1" stop-color="var(--accent-b)" />
              </linearGradient>
              <linearGradient [attr.id]="fillId" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stop-color="var(--accent-a)" stop-opacity="0.34" />
                <stop offset="1" stop-color="var(--accent-a)" stop-opacity="0" />
              </linearGradient>
            </defs>
            <path [attr.d]="sp.area" [attr.fill]="'url(#' + fillId + ')'" />
            <path [attr.d]="sp.line" fill="none" [attr.stroke]="'url(#' + lineId + ')'"
                  stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" />
            <circle [attr.cx]="sp.lastX" [attr.cy]="sp.lastY" r="3" fill="var(--accent-b)" />
            <circle [attr.cx]="sp.lastX" [attr.cy]="sp.lastY" r="6" fill="var(--accent-b)" opacity="0.22" />
          </svg>
        }
      </div>

      <p class="hero__sub">{{ rangeLabel() }}</p>

      <div class="hero__stats">
        <div class="stat">
          <span class="stat__val">{{ (summary()?.total?.totalTokens ?? 0) | compact }}</span>
          <span class="stat__key">tokens</span>
        </div>
        <div class="stat">
          <span class="stat__val">{{ (summary()?.total?.records ?? 0) | compact }}</span>
          <span class="stat__key">records</span>
        </div>
        <!-- Prompt (input) vs completion (output) token split — mirrors the live "Input / Output" KPI. -->
        <div class="stat stat--io" title="prompt (input) vs completion (output)">
          <span class="stat__val">
            {{ (summary()?.total?.inputTokens ?? 0) | compact }}<span class="stat__slash"> / </span>{{ (summary()?.total?.outputTokens ?? 0) | compact }}
          </span>
          <span class="stat__key">in / out</span>
        </div>
        <!-- Estimated active engagement (gap-based, from the calendar) + avg per active weekday. -->
        @if (showActive()) {
          <div class="stat stat--active" [title]="activeSubText()">
            <span class="stat__val">{{ activeHoursText() }}<span class="stat__unit">h</span></span>
            <span class="stat__key">{{ activeSubText() }}</span>
          </div>
        }
        @if (showCache()) {
          <div class="stat stat--cache">
            <span class="stat__val">{{ cachePct() }}%</span>
            <span class="stat__key">cache hit</span>
          </div>
        }
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; }

    .hero {
      position: relative; isolation: isolate; overflow: hidden;
      display: flex; flex-direction: column; align-items: flex-start; gap: 4px;
      padding: 22px 20px;
      border-radius: var(--r-glass);
      background:
        radial-gradient(135% 95% at 0% 0%, color-mix(in srgb, var(--accent-a) 22%, transparent), transparent 58%),
        var(--glass);
      backdrop-filter: blur(var(--blur-glass)) saturate(1.4);
      -webkit-backdrop-filter: blur(var(--blur-glass)) saturate(1.4);
      border: 1px solid var(--glass-edge);
      box-shadow: var(--lift-3);
    }
    .hero__glow {
      position: absolute; z-index: -1; pointer-events: none;
      top: -50px; right: -40px; width: 180px; height: 180px;
      background: radial-gradient(circle at 60% 40%, color-mix(in srgb, var(--accent-b) 40%, transparent), transparent 68%);
      filter: blur(22px); opacity: .8;
    }

    .hero__top { display: flex; align-items: center; gap: 10px; width: 100%; }
    .hero__label {
      font-size: 12px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; color: var(--ink-dim);
    }
    .hero__delta {
      margin-left: auto; display: inline-flex; align-items: center; gap: 3px;
      padding: 3px 9px; border-radius: var(--r-pill);
      font-size: 12px; font-weight: 800; font-variant-numeric: tabular-nums;
      background: color-mix(in srgb, var(--ink) 8%, transparent); color: var(--ink-dim);
      border: 1px solid var(--hairline);
    }
    .hero__delta.is-up { color: var(--warn); background: color-mix(in srgb, var(--warn) 14%, transparent); border-color: color-mix(in srgb, var(--warn) 32%, transparent); }
    .hero__delta.is-down { color: var(--signal); background: color-mix(in srgb, var(--signal) 14%, transparent); border-color: color-mix(in srgb, var(--signal) 32%, transparent); }
    .hero__delta--none { font-weight: 600; letter-spacing: 0; text-transform: none; color: var(--ink-faint); }
    .hero__delta-arrow { font-size: 9px; }
    /* Visually-hidden text — read by screen readers, conveys the delta direction the color/arrow imply. */
    .hero__sr {
      position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; border: 0;
      overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap;
    }

    .hero__cost-row { display: flex; align-items: flex-end; justify-content: space-between; gap: 14px; width: 100%; margin-top: 6px; }
    .hero__cost-wrap { display: flex; align-items: baseline; gap: 3px; line-height: 1; min-width: 0; }
    .hero__cur {
      font-family: var(--font-display); font-weight: 600; font-size: 26px;
      color: color-mix(in srgb, var(--accent-a) 70%, var(--ink));
    }
    .hero__cost {
      font-family: var(--font-display); font-weight: 600; font-size: 52px; line-height: .92;
      color: var(--ink); font-variant-numeric: tabular-nums; letter-spacing: -0.03em;
    }
    .hero__spark { flex: 0 0 auto; width: 118px; height: 44px; }

    .hero__sub { margin: 8px 0 0; font-size: 13px; font-weight: 600; color: var(--ink-dim); }

    .hero__stats {
      display: flex; flex-wrap: wrap; gap: 22px; margin-top: 16px;
      width: 100%; padding-top: 16px; border-top: 1px solid var(--hairline);
    }
    .stat { display: flex; flex-direction: column; gap: 2px; }
    .stat__val { font-family: var(--font-display); font-size: 20px; font-weight: 600; color: var(--ink); font-variant-numeric: tabular-nums; }
    .stat__key { font-size: 11px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; color: var(--ink-dim); }
    .stat--cache .stat__val { color: var(--signal); }
    .stat__slash { color: var(--ink-faint); font-weight: 500; }
    .stat__unit { font-size: 13px; color: var(--ink-dim); margin-left: 1px; }
    .stat--active .stat__val { color: var(--accent-b); }
  `],
})
export class PulseHeroCard {
  readonly summary = input<SummaryResponse | null>(null);
  /** Prior equivalent-period summary, used to compute the headline delta. Null when no prior window. */
  readonly prevSummary = input<SummaryResponse | null>(null);
  readonly cacheEff = input<CacheEfficiency | null>(null);
  readonly loading = input<boolean>(false);
  readonly rangeLabel = input<string>('All time');
  /** Human label for the prior window (for the delta tooltip), e.g. "previous 30d". */
  readonly prevLabel = input<string>('the previous period');

  /**
   * Estimated active engagement hours over the range + its per-active-weekday average, derived on the
   * page from the SAME calendar endpoint the live dashboard uses. -1 avgHours signals "no calendar yet".
   */
  readonly activeHours = input<number>(0);
  readonly dailyAvgHours = input<number>(0);
  readonly activeWeekdays = input<number>(0);

  /** Unique gradient ids so the sparkline strokes/fills don't collide. */
  protected readonly lineId = `hero-line-${Math.random().toString(36).slice(2, 8)}`;
  protected readonly fillId = `hero-fill-${Math.random().toString(36).slice(2, 8)}`;

  /** Big cost numeral with grouping + 2 decimals (matches the live dashboard's tabular cost). */
  readonly costText = computed(() => {
    const c = this.summary()?.total?.costUsd ?? 0;
    return c.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  });

  /** Signed % change vs the prior period; null when there's no prior summary or it had zero spend. */
  readonly delta = computed<number | null>(() => {
    const cur = this.summary()?.total?.costUsd;
    const prev = this.prevSummary()?.total?.costUsd;
    if (cur == null || prev == null || prev <= 0) return null;
    return ((cur - prev) / prev) * 100;
  });
  readonly absDeltaPct = computed(() => {
    const d = this.delta();
    if (d === null) return '0';
    const a = Math.abs(d);
    return a >= 100 ? Math.round(a).toString() : a.toFixed(1).replace(/\.0$/, '');
  });

  /** Screen-reader equivalent of the color/arrow delta (e.g. "up 12% vs the previous period"). */
  readonly deltaSr = computed(() => {
    const d = this.delta();
    if (d === null) return '';
    const dir = d > 0 ? 'up' : d < 0 ? 'down' : 'no change,';
    return `${dir} ${this.absDeltaPct()}% vs ${this.prevLabel()}`;
  });

  readonly cachePct = computed(() => Math.round((this.cacheEff()?.cacheReadRatio ?? 0) * 100));

  /** Empty-state guard copied from the live dashboard (no input + no cache reads => hide). */
  readonly showCache = computed(() => {
    const c = this.cacheEff();
    if (!c) return false;
    return !(c.cacheReadTokens === 0 && c.inputTokens === 0 && c.cacheWriteTokens === 0);
  });

  /** Active-hours stat: show only once there's measurable engaged time in the range. */
  readonly showActive = computed(() => this.activeHours() > 0);
  /** Active hours to 1 decimal, matching the live "{{ activeHours() | number: '1.0-1' }}". */
  readonly activeHoursText = computed(() =>
    this.activeHours().toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 1 }),
  );
  /**
   * Sub-line mirroring the live KPI: avg per active weekday when there are any, else "weekend activity"
   * (hours but no weekdays), else "estimated time with AI".
   */
  readonly activeSubText = computed(() => {
    if (this.activeWeekdays() > 0) {
      const avg = this.dailyAvgHours().toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 1 });
      return `avg ${avg}h/weekday`;
    }
    return this.activeHours() > 0 ? 'weekend activity' : 'estimated time with AI';
  });

  /** Build the hero sparkline from the current summary's cost buckets (≥2 points needed). */
  readonly spark = computed<{ line: string; area: string; lastX: number; lastY: number } | null>(() => {
    const buckets = this.summary()?.buckets ?? [];
    if (buckets.length < 2) return null;
    const vals = buckets.map(b => b.costUsd);
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const span = max - min || 1;
    const W = 120, H = 44, PAD = 4;
    const n = vals.length;
    const pts = vals.map((v, i) => {
      const x = (i / (n - 1)) * W;
      const y = PAD + (1 - (v - min) / span) * (H - PAD * 2);
      return { x, y };
    });
    const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ');
    const area = `${line} L${W} ${H} L0 ${H} Z`;
    const last = pts[pts.length - 1];
    return { line, area, lastX: last.x, lastY: last.y };
  });
}
