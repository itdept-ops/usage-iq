import {
  ChangeDetectionStrategy, Component, computed, effect, inject, model, output, signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';

import { Api } from '../../../core/api';
import { MoveDayCategory, MoveDayRequest, MoveDayResult } from '../../../core/models';
import { OptimisticTracker } from '../state/optimistic-tracker';
import { BottomSheet } from '../ui/bottom-sheet';

/*
 * sheets/move-day-sheet.ts — the "Move day" bottom-sheet for Tracker Beta ("Strata"), the mobile twin of the
 * desktop MoveDayDialog (features/tracker/move-day-dialog.ts). Re-dates the viewed day's entries onto another
 * date for the chosen categories via the EXISTING endpoint (Api.moveDay → POST /tracker/day/move,
 * MoveDayRequest / MoveDayResult). The target defaults to the day before the viewed date (a "logged on the
 * wrong day" fix usually means yesterday); all categories are checked by default; weight/activity replace any
 * existing entry on the target day. On success it emits the result (the page toasts + reloads if the target
 * is on screen) and closes.
 *
 * Self-styled with the page-host Strata tokens (var(--*) only — no global --tech-*), mobile-first with >=44px
 * targets + aria. OWN tracker only (the page never opens it in a read-only view).
 *
 * Contract (the page binds these VERBATIM):
 *   <app-move-day-sheet [(open)]="moveDayOpen" (moved)="onDayMoved($event)" />
 */

interface CategoryRow { key: MoveDayCategory; label: string; icon: string; }
const CATEGORIES: readonly CategoryRow[] = [
  { key: 'food', label: 'Food', icon: 'restaurant' },
  { key: 'exercise', label: 'Exercise', icon: 'fitness_center' },
  { key: 'hydration', label: 'Hydration', icon: 'water_drop' },
  { key: 'weight', label: 'Weight', icon: 'monitor_weight' },
  { key: 'activity', label: 'Activity', icon: 'directions_walk' },
];

/** The day before `iso` as a local YYYY-MM-DD (the default target). */
function dayBefore(iso: string): string {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

@Component({
  selector: 'app-move-day-sheet',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, BottomSheet],
  template: `
    <app-bottom-sheet [(open)]="open" detent="half" label="Move day" [dismissable]="!busy()">
      <div class="md-head">
        <h2 class="md-title">Move day</h2>
        <span class="md-sub">{{ tracker.date() }}</span>
      </div>

      <div class="md-form">
        <p class="md-intro">Move this day's entries to another date. Handy when a day was logged on the wrong date.</p>

        <div>
          <label class="md-label" for="md-to">Move to</label>
          <input id="md-to" class="md-input" type="date"
                 [ngModel]="toDate()" (ngModelChange)="toDate.set($event)" />
          <p class="md-hint">From {{ tracker.date() }} → {{ toDate() || '—' }}</p>
        </div>

        <div>
          <span class="md-label" id="md-cats-lbl">What to move</span>
          <ul class="md-cats" role="group" aria-labelledby="md-cats-lbl">
            @for (c of categories; track c.key) {
              <li>
                <button type="button" class="md-cat" [class.on]="isChecked(c.key)"
                        [attr.aria-pressed]="isChecked(c.key)"
                        (click)="toggle(c.key)">
                  <span class="md-check" aria-hidden="true">{{ isChecked(c.key) ? '✓' : '' }}</span>
                  <span class="md-cat-label">{{ c.label }}</span>
                </button>
              </li>
            }
          </ul>
        </div>

        <p class="md-note">Weight and activity will replace any existing entry on the target day.</p>

        @if (sameDate()) {
          <p class="md-warn" role="alert">Pick a different date — the target can't be the same day.</p>
        }

        <div class="md-actions">
          <button type="button" class="md-cta" (click)="move()"
                  [disabled]="busy() || !canMove() || tracker.readOnly()">
            @if (busy()) { <span class="md-spin" aria-hidden="true"></span> } @else { Move day }
          </button>
        </div>
        <span class="md-sr" role="status" aria-live="polite">{{ announce() }}</span>
      </div>
    </app-bottom-sheet>
  `,
  styles: [`
    :host { display: contents; }

    .md-head { display: flex; align-items: baseline; gap: 8px; padding: 4px 2px 12px; }
    .md-title { margin: 0; font-family: var(--font-ui); font-weight: 700; font-size: 19px; color: var(--ink); letter-spacing: -.01em; }
    .md-sub { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--ink-dim); }

    .md-form { display: flex; flex-direction: column; gap: 14px; padding-bottom: 8px; }
    .md-intro { margin: 0; font-size: 13px; line-height: 1.4; color: var(--ink-dim); }

    .md-label {
      display: block; margin: 0 0 6px 2px;
      font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--ink-dim);
    }
    .md-input {
      width: 100%; box-sizing: border-box; min-height: 48px;
      padding: 0 14px; font-family: var(--font-ui); font-size: 16px; color: var(--ink);
      background: var(--bg-sink); border: 1px solid var(--hairline); border-radius: var(--r-tile);
      box-shadow: var(--press); -webkit-appearance: none; appearance: none;
      transition: border-color 160ms var(--ease-out);
    }
    .md-input:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; border-color: var(--focus); }
    .md-hint { margin: 6px 0 0 2px; font-size: 12px; color: var(--ink-faint); }

    .md-cats { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
    .md-cat {
      width: 100%; min-height: 48px; padding: 0 14px;
      display: flex; align-items: center; gap: 10px;
      font-family: var(--font-ui); font-size: 15px; font-weight: 600; color: var(--ink-dim);
      background: var(--bg-sink); border: 1px solid var(--hairline); border-radius: var(--r-tile);
      touch-action: manipulation; -webkit-tap-highlight-color: transparent; cursor: pointer;
      transition: color 160ms var(--ease-out), border-color 160ms var(--ease-out), background 160ms var(--ease-out);
    }
    .md-cat.on {
      color: var(--ink);
      background: color-mix(in srgb, var(--tech-accent, var(--cal-a)) 14%, var(--bg-sink));
      border-color: color-mix(in srgb, var(--tech-accent, var(--cal-a)) 50%, transparent);
    }
    .md-cat:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
    .md-check {
      flex: 0 0 auto; width: 22px; height: 22px; display: grid; place-items: center;
      border-radius: 6px; border: 1px solid var(--hairline);
      font-size: 14px; font-weight: 700; color: #fff;
    }
    .md-cat.on .md-check {
      background: linear-gradient(135deg, var(--tech-accent, var(--cal-a)), var(--tech-accent-2, var(--cal-b)));
      border-color: transparent;
    }

    .md-note { margin: 0; font-size: 12px; line-height: 1.35; color: var(--ink-dim); }
    .md-warn { margin: 0; font-size: 13px; line-height: 1.35; color: var(--warn); }

    .md-actions { display: flex; gap: 10px; padding-top: 4px; }
    .md-cta {
      flex: 1 1 auto; min-height: 52px;
      display: flex; align-items: center; justify-content: center; gap: 8px;
      font-family: var(--font-ui); font-size: 16px; font-weight: 700; letter-spacing: -.01em;
      color: #fff; background: linear-gradient(135deg, var(--tech-accent, var(--cal-a)), var(--tech-accent-2, var(--cal-b)));
      border: 0; border-radius: var(--r-pill); box-shadow: var(--lift-2);
      touch-action: manipulation; -webkit-tap-highlight-color: transparent; cursor: pointer;
      transition: transform 120ms var(--ease-out), box-shadow 120ms var(--ease-out), opacity 160ms var(--ease-out);
    }
    .md-cta:active:not(:disabled) { transform: translateY(1px) scale(.99); box-shadow: var(--press); }
    .md-cta:disabled { opacity: .45; cursor: default; }
    .md-cta:focus-visible { outline: 2px solid var(--focus); outline-offset: 3px; }

    .md-spin {
      width: 16px; height: 16px; border-radius: 50%;
      border: 2px solid rgba(255,255,255,.4); border-top-color: #fff;
      animation: md-spin 700ms linear infinite;
    }
    @keyframes md-spin { to { transform: rotate(360deg); } }

    .md-sr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; border: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

    @media (prefers-reduced-motion: reduce) { .md-cat, .md-cta { transition: none; } .md-spin { animation: none; } }
  `],
})
export class MoveDaySheet {
  protected readonly tracker = inject(OptimisticTracker);
  private readonly api = inject(Api);

  readonly open = model<boolean>(false);
  /** Emitted with the server result after a successful move (the page toasts + conditionally reloads). */
  readonly moved = output<MoveDayResult>();

  protected readonly categories = CATEGORIES;

  /** Target date — reset to the day before the viewed date each time the sheet opens. */
  protected readonly toDate = signal<string>(dayBefore(this.tracker.date()));
  private readonly selected = signal<Set<MoveDayCategory>>(new Set(CATEGORIES.map(c => c.key)));

  protected readonly busy = signal(false);
  protected readonly announce = signal('');

  private wasOpen = false;

  constructor() {
    // Reset target + selection on the open transition (fresh, defaults to yesterday + all categories).
    effect(() => {
      const isOpen = this.open();
      if (isOpen && !this.wasOpen) {
        this.toDate.set(dayBefore(this.tracker.date()));
        this.selected.set(new Set(CATEGORIES.map(c => c.key)));
        this.announce.set('');
      }
      this.wasOpen = isOpen;
    });
  }

  protected isChecked(key: MoveDayCategory): boolean {
    return this.selected().has(key);
  }

  protected toggle(key: MoveDayCategory): void {
    const next = new Set(this.selected());
    if (next.has(key)) next.delete(key); else next.add(key);
    this.selected.set(next);
  }

  /** True when the picked target equals the source (an invalid no-op move). */
  protected readonly sameDate = computed(() => !!this.toDate() && this.toDate() === this.tracker.date());

  protected readonly canMove = computed(
    () => !!this.toDate() && !this.sameDate() && this.selected().size > 0,
  );

  protected async move(): Promise<void> {
    if (this.busy() || !this.canMove() || this.tracker.readOnly()) return;
    // Order canonically; if all are selected, omit (server treats null/empty as all).
    const all = CATEGORIES.length;
    const chosen = CATEGORIES.map(c => c.key).filter(k => this.selected().has(k));
    const body: MoveDayRequest = {
      fromDate: this.tracker.date(),
      toDate: this.toDate(),
      categories: chosen.length === all ? undefined : chosen,
    };
    this.busy.set(true);
    this.announce.set('Moving the day…');
    try {
      const res = await firstValueFrom(this.api.moveDay(body));
      this.announce.set('Day moved.');
      this.moved.emit(res);
      this.open.set(false);
    } catch {
      this.announce.set('Could not move the day — nothing was changed.');
    } finally {
      this.busy.set(false);
    }
  }
}
