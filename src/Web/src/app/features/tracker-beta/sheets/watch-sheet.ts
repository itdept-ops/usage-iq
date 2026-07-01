import {
  ChangeDetectionStrategy, Component, computed, effect, inject, model, output, signal, untracked,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

import { OptimisticTracker } from '../state/optimistic-tracker';
import { UnitService } from '../../../core/unit.service';
import { ActivityCalorieMode, WatchActivityDto } from '../../../core/models';
import { BottomSheet } from '../ui/bottom-sheet';

/*
 * sheets/watch-sheet.ts — the smartwatch-stats sheet for Tracker Beta ("Strata").
 *
 * Watch stats (steps, distance, active calories) are ONE row per day — they're upserted, not appended —
 * so this sheet mirrors the weight sheet's edit-the-day's-value shape rather than the quick-add sheets'
 * append shape: it PRE-FILLS from the day's current `activity` so it edits existing values, lets any
 * field be cleared (sent as null), and commits through OptimisticTracker.upsertActivity so the Move ring
 * + burn tick instantly with revert/undo handled by the wrapper.
 *
 * The wire is metric: `distanceMeters` is always metres. The distance INPUT is unit-aware (km / mi via
 * UnitService) — it shows the day's metres converted to the user's unit, and converts the entered value
 * back to metres before saving. Steps + active calories are unit-free integers.
 *
 * Self-styled with the page-host Strata tokens (var(--*) only — no global --tech-*), mobile-first with
 * >=44px targets, aria labels, reduced-motion-friendly chrome (the sheet rise itself is governed by the
 * bottom-sheet primitive + the page killswitch). The accent matches the Move card (rose → amber).
 *
 * Contract (the page binds these VERBATIM):
 *   selector : app-watch-sheet
 *   inputs   : open   (model<boolean>, two-way)
 *   outputs  : logged (WatchActivityDto) — emitted after a successful upsert (the sheet then closes)
 *
 * Usage: `<app-watch-sheet [(open)]="watchOpen" (logged)="onWatchSaved()" />`
 */
@Component({
  selector: 'app-watch-sheet',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, BottomSheet],
  template: `
    <app-bottom-sheet [(open)]="open" detent="half" label="Watch stats" [dismissable]="!busy()">
      <div class="wt-head" style="--accent-edge: var(--move-a);">
        <h2 class="wt-title">Watch stats</h2>
        <span class="wt-sub">{{ tracker.date() }}</span>
      </div>

      <div class="wt-form" style="--cta-a: var(--move-a); --cta-b: var(--move-b); --accent-edge: var(--move-a);">
        <p class="wt-note">From your smartwatch — edits the day's totals. Leave a field blank to clear it.</p>

        <div>
          <label class="wt-label" for="wt-steps">Steps</label>
          <input id="wt-steps" class="wt-input" type="number" min="0" max="200000" step="1"
                 inputmode="numeric" enterkeyhint="done" placeholder="0"
                 [ngModel]="steps()" (ngModelChange)="steps.set($event)" />
        </div>

        <div>
          <label class="wt-label" for="wt-dist">Distance ({{ distanceUnit() }})</label>
          <input id="wt-dist" class="wt-input" type="number" min="0" max="1000" step="0.01"
                 inputmode="decimal" enterkeyhint="done" placeholder="0"
                 [ngModel]="distance()" (ngModelChange)="distance.set($event)" />
        </div>

        <div>
          <label class="wt-label" for="wt-active">Active calories (kcal)</label>
          <input id="wt-active" class="wt-input" type="number" min="0" max="20000" step="1"
                 inputmode="numeric" enterkeyhint="done" placeholder="0"
                 [ngModel]="activeCalories()" (ngModelChange)="activeCalories.set($event)" />
        </div>

        <!-- How the watch active-calories combine with logged workouts (mirrors desktop setCalorieMode). -->
        <div>
          <span class="wt-label" id="wt-mode-lbl">Active calories</span>
          <div class="wt-seg" role="group" aria-labelledby="wt-mode-lbl">
            <button type="button" class="wt-seg-btn" [class.on]="calorieMode() === 'add'"
                    [attr.aria-pressed]="calorieMode() === 'add'" (click)="calorieMode.set('add')">
              Add to workouts
            </button>
            <button type="button" class="wt-seg-btn" [class.on]="calorieMode() === 'override'"
                    [attr.aria-pressed]="calorieMode() === 'override'" (click)="calorieMode.set('override')">
              Replace workouts
            </button>
          </div>
          <p class="wt-note">
            {{ calorieMode() === 'override'
                ? 'Watch active calories replace your logged workouts in the burn total.'
                : 'Watch active calories add on top of your logged workouts.' }}
          </p>
        </div>

        <div class="wt-actions">
          <button type="button" class="wt-cta" (click)="save()" [disabled]="busy() || tracker.readOnly()">
            @if (busy()) { <span class="wt-spin" aria-hidden="true"></span> } @else { Save watch stats }
          </button>
          @if (hasExisting() && !tracker.readOnly()) {
            <button type="button" class="wt-clear" (click)="clear()" [disabled]="busy()"
                    aria-label="Clear watch stats for the day">Clear</button>
          }
        </div>
        <span class="wt-sr" role="status" aria-live="polite">{{ announce() }}</span>
      </div>
    </app-bottom-sheet>
  `,
  styles: [`
    :host { display: contents; }

    .wt-head {
      display: flex; align-items: baseline; gap: 8px;
      padding: 4px 2px 12px;
    }
    .wt-title {
      margin: 0; font-family: var(--font-ui); font-weight: 700; font-size: 19px;
      color: var(--ink); letter-spacing: -.01em;
    }
    .wt-sub { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--ink-dim); }

    .wt-form { display: flex; flex-direction: column; gap: 14px; padding-bottom: 8px; }

    .wt-note { margin: 0; font-size: 12px; color: var(--ink-dim); }

    .wt-label {
      display: block; margin: 0 0 6px 2px;
      font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--ink-dim);
    }

    /* Number inputs — pressed-well field on the matte surface (matches the quick sheets). */
    .wt-input {
      width: 100%; box-sizing: border-box; min-height: 48px;
      padding: 0 14px; font-family: var(--font-ui); font-size: 16px; color: var(--ink);
      background: var(--bg-sink); border: 1px solid var(--hairline); border-radius: var(--r-tile);
      box-shadow: var(--press);
      -webkit-appearance: none; appearance: none;
      transition: border-color 160ms var(--ease-out);
    }
    .wt-input::placeholder { color: var(--ink-faint); }
    .wt-input:focus-visible {
      outline: 2px solid var(--focus); outline-offset: 2px; border-color: var(--focus);
    }

    /* Add/Override segmented toggle. */
    .wt-seg {
      display: grid; grid-template-columns: 1fr 1fr; gap: 6px;
      padding: 4px; border-radius: var(--r-pill);
      background: var(--bg-sink); border: 1px solid var(--hairline); box-shadow: var(--press);
    }
    .wt-seg-btn {
      min-height: 44px; padding: 0 10px;
      font-family: var(--font-ui); font-size: 13px; font-weight: 600; color: var(--ink-dim);
      background: transparent; border: 0; border-radius: var(--r-pill);
      touch-action: manipulation; -webkit-tap-highlight-color: transparent; cursor: pointer;
      transition: color 160ms var(--ease-out), background 160ms var(--ease-out), box-shadow 160ms var(--ease-out);
    }
    .wt-seg-btn.on {
      color: var(--ink); background: var(--bg-rise); box-shadow: var(--lift-1);
    }
    .wt-seg-btn:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }

    .wt-actions { display: flex; gap: 10px; padding-top: 4px; }
    .wt-cta {
      flex: 1 1 auto; min-height: 52px;
      font-family: var(--font-ui); font-size: 16px; font-weight: 700; letter-spacing: -.01em;
      color: #fff; background: linear-gradient(135deg, var(--cta-a, var(--move-a)), var(--cta-b, var(--move-b)));
      border: 0; border-radius: var(--r-pill); box-shadow: var(--lift-2);
      touch-action: manipulation; -webkit-tap-highlight-color: transparent; cursor: pointer;
      display: flex; align-items: center; justify-content: center; gap: 8px;
      transition: transform 120ms var(--ease-out), box-shadow 120ms var(--ease-out), opacity 160ms var(--ease-out);
    }
    .wt-cta:active:not(:disabled) { transform: translateY(1px) scale(.99); box-shadow: var(--press); }
    .wt-cta:disabled { opacity: .45; cursor: default; }
    .wt-cta:focus-visible { outline: 2px solid var(--focus); outline-offset: 3px; }

    .wt-clear {
      flex: 0 0 auto; min-height: 52px; padding: 0 18px;
      font-family: var(--font-ui); font-size: 14px; font-weight: 600; color: var(--ink-dim);
      background: transparent; border: 1px solid var(--glass-edge); border-radius: var(--r-pill);
      touch-action: manipulation; -webkit-tap-highlight-color: transparent; cursor: pointer;
      transition: transform 120ms var(--ease-out), color 160ms var(--ease-out);
    }
    .wt-clear:active:not(:disabled) { transform: translateY(1px) scale(.98); }
    .wt-clear:disabled { opacity: .45; cursor: default; }
    .wt-clear:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }

    .wt-spin {
      width: 16px; height: 16px; border-radius: 50%;
      border: 2px solid rgba(255,255,255,.4); border-top-color: #fff;
      animation: wt-spin 700ms linear infinite;
    }
    @keyframes wt-spin { to { transform: rotate(360deg); } }

    .wt-sr {
      position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; border: 0;
      overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap;
    }

    @media (prefers-reduced-motion: reduce) {
      .wt-cta, .wt-clear { transition: none; }
      .wt-spin { animation: none; }
    }
  `],
})
export class WatchSheet {
  protected readonly tracker = inject(OptimisticTracker);
  /** Central display-preference seam — the distance field shows/parses km or mi while the wire stays metres. */
  private readonly units = inject(UnitService);

  readonly open = model<boolean>(false);
  /** Emitted with the saved watch stats after a successful upsert (the sheet then closes itself). */
  readonly logged = output<WatchActivityDto>();

  /** Distance unit label for the active system ('km' | 'mi'). */
  protected readonly distanceUnit = computed(() => this.units.distanceUnit());

  protected readonly steps = signal<number | null>(null);
  /** Distance in the DISPLAY unit (km / mi); converted to/from metres on seed + save. */
  protected readonly distance = signal<number | null>(null);
  protected readonly activeCalories = signal<number | null>(null);
  /** How watch active-calories combine with logged workouts ('add' | 'override'); seeded from the day's row. */
  protected readonly calorieMode = signal<ActivityCalorieMode>('add');

  protected readonly busy = signal(false);
  protected readonly announce = signal('');

  /** True when the day already has a watch row (so the Clear affordance is meaningful). */
  protected readonly hasExisting = computed(() => this.tracker.day()?.activity != null);

  /** Last seen open() — so seeding fires only on the false→true open transition. */
  private wasOpen = false;

  constructor() {
    // Pre-fill from the day's current activity ONLY on the open transition. seedFromDay() reads
    // tracker.day() via untracked so a concurrent same-day log (food/coffee/exercise) mutating the shared
    // day signal can't re-fire this effect and wipe the steps/distance/calories the user is typing.
    effect(() => {
      const isOpen = this.open();
      if (isOpen && !this.wasOpen) this.seedFromDay();
      this.wasOpen = isOpen;
    });
  }

  /** Pull the day's metric activity into the inputs (distance metres → the user's display unit). */
  private seedFromDay(): void {
    const a = untracked(() => this.tracker.day())?.activity ?? null;
    this.steps.set(a?.steps ?? null);
    this.activeCalories.set(a?.activeCalories ?? null);
    const meters = a?.distanceMeters;
    this.distance.set(
      meters != null
        ? Math.round(this.units.distanceToDisplay(meters / 1000) * 100) / 100
        : null,
    );
    this.calorieMode.set(a?.calorieMode ?? 'add');
    this.announce.set('');
  }

  /** A numeric input as a clamped non-negative integer, or null (cleared). */
  private intOf(value: number | null, max: number): number | null {
    if (value == null || !Number.isFinite(value) || value <= 0) return null;
    return Math.min(Math.round(value), max);
  }

  protected async save(): Promise<void> {
    if (this.busy() || this.tracker.readOnly()) return;
    const dist = this.distance();
    // Display unit → canonical km → metres on the wire; null clears the field.
    const distanceMeters = dist != null && Number.isFinite(dist) && dist > 0
      ? Math.round(this.units.distanceToCanonical(dist) * 1000)
      : null;
    this.busy.set(true);
    this.announce.set('Saving watch stats…');
    try {
      const saved = await this.tracker.upsertActivity({
        date: this.tracker.date(),
        steps: this.intOf(this.steps(), 200000),
        distanceMeters,
        activeCalories: this.intOf(this.activeCalories(), 20000),
        // Use the user's chosen combine mode (seeded from the existing row on open).
        calorieMode: this.calorieMode(),
      });
      this.announce.set('Watch stats saved.');
      this.logged.emit(saved);
      this.open.set(false);
    } catch {
      // The optimistic wrapper already surfaced a Retry snackbar + reverted; keep the sheet open.
    } finally {
      this.busy.set(false);
    }
  }

  /** Clear the day's watch stats (send every field null; keeps the existing combine mode). */
  protected async clear(): Promise<void> {
    if (this.busy() || this.tracker.readOnly()) return;
    this.busy.set(true);
    this.announce.set('Clearing watch stats…');
    try {
      const saved = await this.tracker.upsertActivity({
        date: this.tracker.date(),
        steps: null,
        distanceMeters: null,
        activeCalories: null,
        calorieMode: this.calorieMode(),
      });
      this.announce.set('Watch stats cleared.');
      this.logged.emit(saved);
      this.open.set(false);
    } catch {
      // Wrapper surfaced Retry + reverted; keep the sheet open.
    } finally {
      this.busy.set(false);
    }
  }
}
