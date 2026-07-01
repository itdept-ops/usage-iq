import {
  ChangeDetectionStrategy, Component, computed, inject, output,
} from '@angular/core';
import { MatIconModule } from '@angular/material/icon';

import { OptimisticTracker } from '../state/optimistic-tracker';
import { SleepEntryDto } from '../../../core/models';
import { SwipeRow } from '../ui/swipe-row';

/**
 * Strata SLEEP & RECOVERY sediment card — the recovery domain tile in the Today dashboard, the sleep
 * twin of {@link CoffeeCard}.
 *
 * FOCUS: a glanceable RECOVERY SCORE ring (the deterministic 0..100 the backend fuses from last night's
 * sleep + the day's caffeine, training, and fuel adherence) with its short label ("Primed"/"Steady"/…),
 * plus the logged hours. The score is OWNER-ONLY and present only when a sleep entry exists — when none is
 * logged yet the card invites a log. Logged nights list under it as swipe-left-to-delete rows.
 *
 * It does NOT compute recovery itself — that's a single deterministic source of truth on the server. The
 * card just renders day.recoveryScore (+ sub-label) and the sleep entries. A tap on the header opens the
 * SleepSheet (the page wires `(log)` to it).
 *
 * Self-styled with the page-host Strata tokens (var(--*) only — NO global --tech-*). Matte sediment card
 * (.tb-card extrusion language). Mobile-first: 44px targets, aria labels on icon-only controls.
 */
@Component({
  selector: 'app-tracker-beta-sleep-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, SwipeRow],
  host: { class: 'tb-card tb-sleep-card' },
  template: `
    <header class="tb-sleep__head">
      <span class="tb-sleep__ring" aria-hidden="true">
        @if (score() != null) {
          <svg viewBox="0 0 44 44" class="tb-sleep__svg">
            <circle class="tb-sleep__track" cx="22" cy="22" r="18" fill="none" stroke-width="4" />
            <circle
              class="tb-sleep__bar" [class]="'tb-sleep__bar--' + band()"
              cx="22" cy="22" r="18" fill="none" stroke-width="4" stroke-linecap="round"
              transform="rotate(-90 22 22)"
              [attr.stroke-dasharray]="circumference"
              [attr.stroke-dashoffset]="dashOffset()" />
            <text x="22" y="26" text-anchor="middle" class="tb-sleep__score">{{ score() }}</text>
          </svg>
        } @else {
          <mat-icon>bedtime</mat-icon>
        }
      </span>

      <div class="tb-sleep__headline">
        <h3 class="tb-sleep__title">Recovery</h3>
        @if (score() != null) {
          <p class="tb-sleep__summary">
            <span class="tb-sleep__label">{{ label() }}</span>
            <span class="tb-sleep__dot" aria-hidden="true">·</span>
            <span class="tb-sleep__num">{{ hours() }}</span>
            <span class="tb-sleep__unit">h slept</span>
          </p>
        } @else {
          <p class="tb-sleep__summary tb-sleep__summary--empty">Log last night to see recovery</p>
        }
      </div>

      <button type="button" class="tb-sleep__step"
              [disabled]="readOnly()"
              (click)="log.emit()"
              aria-label="Log a night of sleep">
        <mat-icon aria-hidden="true">add</mat-icon>
      </button>
    </header>

    @if (entries().length) {
      <ul class="tb-sleep__rows" aria-label="Logged sleep">
        @for (s of entries(); track s.id) {
          <li>
            <app-swipe-row [disabled]="readOnly()"
                           [label]="rowLabel(s)"
                           (delete)="opt.deleteSleep(s.id)">
              <button type="button" class="tb-sleep__row tb-sleep__row-btn"
                      [disabled]="readOnly()"
                      (click)="editEntry.emit(s)"
                      [attr.aria-label]="'Edit sleep, ' + s.hours + ' hours, ' + qualityLabel(s.quality) + ' quality'">
                <span class="tb-sleep__row-name">{{ qualityLabel(s.quality) }}</span>
                <span class="tb-sleep__leader" aria-hidden="true"></span>
                <span class="tb-sleep__row-amt">
                  {{ s.hours }}<span class="tb-sleep__row-unit"> h</span>
                </span>
              </button>
            </app-swipe-row>
          </li>
        }
      </ul>
    }
  `,
  styles: [`
    :host { display: block; }

    .tb-sleep__head {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .tb-sleep__ring {
      flex: 0 0 auto;
      display: grid;
      place-items: center;
      width: 44px;
      height: 44px;

      mat-icon { font-size: 24px; width: 24px; height: 24px; color: var(--sleep-b); }
    }

    .tb-sleep__svg { width: 44px; height: 44px; display: block; }
    .tb-sleep__track { stroke: var(--hairline); }
    .tb-sleep__bar {
      stroke: var(--sleep-b);
      transition: stroke-dashoffset 600ms var(--ease-out);
    }
    .tb-sleep__bar--good { stroke: var(--signal); }
    .tb-sleep__bar--mid { stroke: var(--sleep-b); }
    .tb-sleep__bar--low { stroke: var(--warn); }
    .tb-sleep__bar--bad { stroke: var(--move-a); }
    .tb-sleep__score {
      font-family: var(--font-display);
      font-size: 13px;
      font-weight: 700;
      font-variant-numeric: tabular-nums;
      fill: var(--ink);
    }

    .tb-sleep__headline { flex: 1 1 auto; min-width: 0; }

    .tb-sleep__title {
      margin: 0;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: .04em;
      text-transform: uppercase;
      color: var(--ink-dim);
    }

    .tb-sleep__summary {
      margin: 2px 0 0;
      display: flex;
      align-items: baseline;
      flex-wrap: wrap;
      gap: 4px;
      color: var(--ink);
    }

    .tb-sleep__summary--empty { font-size: 13px; color: var(--ink-faint); }

    .tb-sleep__label {
      font-family: var(--font-display);
      font-size: 18px;
      font-weight: 600;
      letter-spacing: -.02em;
      line-height: 1;
    }

    .tb-sleep__num {
      font-family: var(--font-display);
      font-size: 18px;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
      line-height: 1;
    }

    .tb-sleep__unit { font-size: 12px; font-weight: 500; color: var(--ink-dim); }
    .tb-sleep__dot { color: var(--ink-faint); padding: 0 2px; }

    .tb-sleep__step {
      flex: 0 0 auto;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 44px;
      min-height: 44px;
      padding: 0 12px;
      border: 1px solid var(--glass-edge);
      border-radius: var(--r-pill);
      background: var(--bg-base);
      color: var(--ink);
      cursor: pointer;
      touch-action: manipulation;
      -webkit-tap-highlight-color: transparent;
      transition: transform 120ms var(--ease-out), box-shadow 120ms var(--ease-out);

      mat-icon { font-size: 20px; width: 20px; height: 20px; color: var(--sleep-b); }

      &:active:not(:disabled) { transform: scale(.97) translateY(1px); box-shadow: var(--press); }
      &:disabled { opacity: .45; cursor: not-allowed; }
    }

    .tb-sleep__rows {
      list-style: none;
      margin: 14px 0 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      border-top: 1px solid var(--hairline);
    }
    .tb-sleep__rows li + li { border-top: 1px solid var(--hairline); }

    .tb-sleep__row {
      display: flex;
      align-items: baseline;
      gap: 8px;
      min-height: 44px;
      padding: 0 12px;
    }

    .tb-sleep__row-btn {
      width: 100%;
      background: transparent;
      border: 0;
      text-align: left;
      cursor: pointer;
      touch-action: manipulation;
      -webkit-tap-highlight-color: transparent;
      font: inherit;
      color: inherit;
    }
    .tb-sleep__row-btn:disabled { cursor: default; }
    .tb-sleep__row-btn:active:not(:disabled) { background: var(--bg-sink); }
    .tb-sleep__row-btn:focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; border-radius: var(--r-tile); }

    .tb-sleep__row-name {
      flex: 0 1 auto;
      font-size: 15px;
      color: var(--ink);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .tb-sleep__leader {
      flex: 1 1 auto;
      align-self: flex-end;
      margin-bottom: 4px;
      border-bottom: 1px dotted var(--hairline);
      min-width: 12px;
    }

    .tb-sleep__row-amt {
      flex: 0 0 auto;
      font-family: var(--font-display);
      font-size: 15px;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
      color: var(--ink-dim);
    }

    .tb-sleep__row-unit { font-family: var(--font-ui); font-size: 12px; font-weight: 500; color: var(--ink-faint); }

    @media (prefers-reduced-motion: reduce) {
      .tb-sleep__bar, .tb-sleep__step { transition: none; }
    }
  `],
})
export class SleepCard {
  protected readonly opt = inject(OptimisticTracker);

  /** Emitted when the user taps + to log a night of sleep — the page opens the SleepSheet. */
  readonly log = output<void>();
  /** Emitted when a logged night row is tapped — the page opens the SleepSheet seeded to edit it. */
  readonly editEntry = output<SleepEntryDto>();

  protected readonly readOnly = this.opt.readOnly;

  private static readonly QUALITY = ['—', 'Poor', 'Fair', 'Okay', 'Good', 'Great'];

  /** The deterministic recovery score (0..100), or null when no sleep is logged for the day. */
  protected readonly score = computed(() => this.opt.day()?.recoveryScore ?? null);
  /** Short recovery label ("Primed"/"Steady"/…), or '' when no sleep logged. */
  protected readonly label = computed(() => this.opt.day()?.recoveryLabel ?? '');
  /** Total hours slept today. */
  protected readonly hours = computed(() => this.opt.day()?.sleepHours ?? 0);
  /** The day's sleep entries, oldest-first. */
  protected readonly entries = computed(() => this.opt.day()?.sleep ?? []);

  protected readonly circumference = 2 * Math.PI * 18;

  /** Arc fill: the score as a fraction of 100. */
  protected readonly dashOffset = computed(() => {
    const pct = Math.max(0, Math.min(100, this.score() ?? 0)) / 100;
    return this.circumference * (1 - pct);
  });

  /** Colour band mirroring the label thresholds (≥80/≥65/≥45/else). */
  protected readonly band = computed<'good' | 'mid' | 'low' | 'bad'>(() => {
    const s = this.score() ?? 0;
    if (s >= 80) return 'good';
    if (s >= 65) return 'mid';
    if (s >= 45) return 'low';
    return 'bad';
  });

  protected qualityLabel(q: number): string {
    return SleepCard.QUALITY[Math.max(0, Math.min(5, q))] ?? '—';
  }

  protected rowLabel(s: { hours: number; quality: number }): string {
    return `Delete sleep, ${s.hours} hours, ${this.qualityLabel(s.quality)} quality`;
  }
}
