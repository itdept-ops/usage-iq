import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';

import { FamilyMeal } from '../../../core/models';
import { BetaBottomSheet } from '../../beta-ui';
import { DayCell, slotMeta } from '../meals-beta.model';

/**
 * Forage MoveMealSheet — a small BetaBottomSheet that reschedules ONE planned meal to another day of the
 * CURRENT week (the slot is kept). It lists the week's 7 days as rows (weekday name + friendly date); the
 * meal's current day is disabled and marked "current". Picking a day emits `move` with the target
 * "YYYY-MM-DD" — the page does the optimistic state shuffle + the reuse-only `Api.patchFamilyMeal` write,
 * keeping the optimistic state on the page (like the grocery/remove actions).
 *
 * Presentational only — no Api here; the page owns the open state + the write.
 */
@Component({
  selector: 'app-forage-move-meal-sheet',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, BetaBottomSheet],
  template: `
    <app-bs-sheet [(open)]="open" detent="half" label="Move to another day" [dismissable]="true" (closed)="onClosed()">
      @if (meal(); as m) {
        <div class="mv">
          <div class="mv-top">
            <span class="mv-ic" aria-hidden="true"><mat-icon>event_repeat</mat-icon></span>
            <div class="mv-txt">
              <h2 class="mv-title">Move to another day</h2>
              <span class="mv-sub">{{ slot().label }} · {{ m.title }}</span>
            </div>
          </div>

          <ul class="mv-days" role="list">
            @for (c of cells(); track c.localDate) {
              <li>
                <button type="button" class="mv-day" [class.is-current]="c.localDate === m.localDate"
                        [disabled]="c.localDate === m.localDate"
                        (click)="pick(c.localDate)"
                        [attr.aria-label]="'Move to ' + c.weekdayLong + ', ' + c.dateLabel
                                           + (c.localDate === m.localDate ? ' (current day)' : '')">
                  <span class="mv-day-day">
                    <b>{{ c.weekdayLong }}</b>
                    <i>{{ c.dateLabel }}</i>
                  </span>
                  @if (c.localDate === m.localDate) {
                    <span class="mv-tag">Current</span>
                  } @else {
                    <mat-icon class="mv-chev" aria-hidden="true">chevron_right</mat-icon>
                  }
                </button>
              </li>
            }
          </ul>
        </div>
      }
    </app-bs-sheet>
  `,
  styles: [`
    :host { display: contents; }
    .mv { display: flex; flex-direction: column; gap: 14px; padding-top: 4px; }
    .mv-top { display: flex; gap: 12px; align-items: center; }
    .mv-ic {
      flex: 0 0 auto; display: grid; place-items: center; width: 46px; height: 46px; border-radius: 15px;
      background: linear-gradient(135deg, var(--accent-a), var(--accent-b)); color: #07140d;
    }
    .mv-ic mat-icon { font-size: 24px; width: 24px; height: 24px; }
    .mv-txt { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
    .mv-title { margin: 0; font-family: var(--font-display); font-weight: 600; font-size: 21px; color: var(--ink); line-height: 1.1; }
    .mv-sub {
      font-size: 12.5px; font-weight: 700; color: var(--ink-faint);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }

    .mv-days { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 8px; }
    .mv-day {
      display: flex; align-items: center; justify-content: space-between; gap: 10px; width: 100%;
      min-height: 52px; padding: 8px 14px; border-radius: var(--r-tile);
      border: 1px solid var(--hairline); background: var(--bg-sink); color: var(--ink); text-align: left;
      cursor: pointer; -webkit-tap-highlight-color: transparent; touch-action: manipulation;
      transition: transform 120ms var(--ease-out), background 160ms var(--ease-out), border-color 160ms var(--ease-out);
    }
    .mv-day:active { transform: scale(.985); }
    .mv-day:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
    .mv-day:not(:disabled):hover { border-color: color-mix(in srgb, var(--accent-a) 40%, transparent); }
    .mv-day:disabled { cursor: default; opacity: .62; }
    .mv-day.is-current { border-color: color-mix(in srgb, var(--accent-a) 34%, transparent); }

    .mv-day-day { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
    .mv-day-day b { font-family: var(--font-ui); font-size: 15px; font-weight: 700; color: var(--ink); }
    .mv-day-day i { font-style: normal; font-size: 12.5px; font-weight: 600; color: var(--ink-faint); }

    .mv-chev { flex: 0 0 auto; color: var(--accent-a); font-size: 22px; width: 22px; height: 22px; }
    .mv-tag {
      flex: 0 0 auto; padding: 3px 10px; border-radius: var(--r-pill);
      background: color-mix(in srgb, var(--accent-a) 14%, var(--bg-sink)); color: var(--accent-a);
      font-size: 11px; font-weight: 800; letter-spacing: .03em;
    }
  `],
})
export class ForageMoveMealSheet {
  /** Two-way open state, owned by the page. */
  readonly open = signal(false);
  /** The meal being moved (null when none). */
  readonly meal = input<FamilyMeal | null>(null);
  /** The current week's 7 day cells (weekday + date labels, in Monday→Sunday order). */
  readonly cells = input<DayCell[]>([]);
  /** Move the meal to this target "YYYY-MM-DD" (kept in the same slot). */
  readonly move = output<string>();

  protected readonly slot = computed(() => slotMeta(this.meal()?.slot ?? 'dinner'));

  protected pick(targetIso: string): void {
    const m = this.meal();
    if (m && targetIso !== m.localDate) this.move.emit(targetIso);
  }

  protected onClosed(): void { /* page clears its own open flag via two-way */ }
}
