import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

import { DayCell } from '../meals-beta.model';

/**
 * Forage DayStrip — the SWIPEABLE week strip: 7 day chips on a horizontal momentum-scroll rail (hidden
 * scrollbar, scroll-snap), each chip showing the short weekday, the day-of-month numeral (big Clash
 * Display), a today ring, the planned-meal count, and a tiny accent fill bar that grows with how many
 * meals are planned. Tapping a chip selects that day; the selected chip lifts onto the accent gradient.
 *
 * Pure presentational: the page owns the cells + selection. Reads --accent-a/--accent-b off the host
 * cascade (the page's Forage-green). 44px+ touch targets, press feedback, reduced-motion safe.
 */
@Component({
  selector: 'app-forage-day-strip',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="ds-rail" role="group" aria-label="Days of the week">
      @for (c of cells(); track c.localDate; let i = $index) {
        <button type="button" class="ds-chip"
                [class.is-sel]="c.localDate === selected()"
                [class.is-today]="c.isToday"
                [attr.aria-pressed]="c.localDate === selected()"
                [attr.aria-label]="c.weekdayLong + ' ' + c.dateLabel + ', ' + c.meals.length + ' meals'"
                [style.--i]="i"
                (click)="pick.emit(c.localDate)">
          <span class="ds-wd">{{ c.weekdayShort }}</span>
          <span class="ds-num">{{ c.dayNum }}</span>
          <span class="ds-meta">
            @if (c.meals.length) {
              <span class="ds-dots" aria-hidden="true">
                @for (d of dots(c.meals.length); track $index) { <span class="ds-dot"></span> }
              </span>
            } @else {
              <span class="ds-empty" aria-hidden="true">·</span>
            }
          </span>
          @if (c.isToday) { <span class="ds-today-pip" aria-hidden="true"></span> }
        </button>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .ds-rail {
      display: flex; gap: 8px; overflow-x: auto; overflow-y: hidden;
      scroll-snap-type: x proximity; overscroll-behavior-x: contain; -webkit-overflow-scrolling: touch;
      scrollbar-width: none; padding: 4px 2px; margin-inline: -2px;
    }
    .ds-rail::-webkit-scrollbar { display: none; }

    .ds-chip {
      position: relative; flex: 0 0 auto; scroll-snap-align: center;
      display: flex; flex-direction: column; align-items: center; gap: 2px;
      width: 52px; min-height: 78px; padding: 9px 0 8px;
      border-radius: 18px; border: 1px solid var(--hairline);
      background: color-mix(in srgb, var(--accent-a) 5%, var(--bg-rise));
      color: var(--ink-dim); cursor: pointer;
      -webkit-tap-highlight-color: transparent; touch-action: manipulation;
      transition: transform 140ms var(--ease-spring), background 200ms var(--ease-out),
                  color 200ms var(--ease-out), border-color 200ms var(--ease-out), box-shadow 200ms var(--ease-out);
      animation: ds-in 420ms var(--ease-spring-up) both;
      animation-delay: calc(var(--i, 0) * 34ms);
    }
    @keyframes ds-in { from { opacity: 0; transform: translateY(10px) scale(.96); } to { opacity: 1; transform: none; } }
    .ds-chip:active { transform: scale(.93); }
    .ds-chip:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }

    .ds-chip.is-today {
      border-color: color-mix(in srgb, var(--accent-a) 45%, transparent);
    }
    .ds-chip.is-sel {
      background: linear-gradient(160deg, var(--accent-a), var(--accent-b));
      color: var(--tech-text-on-accent, #07140d); border-color: transparent;
      box-shadow: 0 8px 22px color-mix(in srgb, var(--accent-a) 38%, transparent);
    }

    .ds-wd {
      font-family: var(--font-ui); font-size: 11px; font-weight: 800; letter-spacing: .06em;
      text-transform: uppercase; opacity: .9;
    }
    .ds-num {
      font-family: var(--font-display); font-variant-numeric: tabular-nums;
      font-size: 23px; font-weight: 600; line-height: 1; letter-spacing: -.02em;
      color: var(--ink);
    }
    .ds-chip.is-sel .ds-num { color: var(--tech-text-on-accent, #07140d); }

    .ds-meta { display: grid; place-items: center; height: 10px; }
    .ds-dots { display: inline-flex; gap: 3px; }
    .ds-dot {
      width: 4px; height: 4px; border-radius: 50%;
      background: linear-gradient(135deg, var(--accent-a), var(--accent-b));
    }
    .ds-chip.is-sel .ds-dot { background: var(--tech-text-on-accent, #07140d); }
    .ds-empty { color: var(--ink-faint); font-weight: 800; line-height: 1; }

    .ds-today-pip {
      position: absolute; top: 6px; right: 7px; width: 6px; height: 6px; border-radius: 50%;
      background: linear-gradient(135deg, var(--accent-a), var(--accent-b));
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent-a) 22%, transparent);
    }
    .ds-chip.is-sel .ds-today-pip { background: var(--tech-text-on-accent, #07140d); box-shadow: none; }
  `],
})
export class ForageDayStrip {
  /** The 7 day cells of the viewed week. */
  readonly cells = input.required<DayCell[]>();
  /** The selected day's "YYYY-MM-DD". */
  readonly selected = input.required<string>();
  /** Emits the picked day's "YYYY-MM-DD". */
  readonly pick = output<string>();

  /** Up to 3 dots representing planned-meal density on the chip. */
  protected dots(n: number): number[] {
    return Array.from({ length: Math.min(3, n) });
  }
}
