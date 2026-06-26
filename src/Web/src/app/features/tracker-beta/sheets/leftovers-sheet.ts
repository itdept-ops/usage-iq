import {
  ChangeDetectionStrategy, Component, computed, effect, inject, model, output, signal,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { firstValueFrom } from 'rxjs';

import { Api } from '../../../core/api';
import { FamilyMeal, FamilyMealDay } from '../../../core/models';
import { OptimisticTracker } from '../state/optimistic-tracker';
import { BottomSheet } from '../ui/bottom-sheet';

/*
 * sheets/leftovers-sheet.ts — the "Leftovers" sheet for Tracker Beta ("Strata").
 *
 * Ports the LIVE tracker's leftovers-dialog logic into a beta bottom-sheet: pull a PLANNED meal off the
 * household meal planner and log it onto the tracker as leftovers to eat over the next day(s). On open it
 * loads the CURRENT + PREVIOUS planner weeks (so a recently-cooked dish is available), flattens every meal
 * with its planned day, de-dupes by id, and sorts most-recent-first; each row shows the meal title + a
 * kcal/protein-per-serving summary + its planned day. Only meals WITH macros are loggable (macroSource !==
 * 'none' — the from-meal endpoint 400s otherwise); macro-less rows are listed disabled with a hint.
 *
 * The user picks ONE meal, a SERVINGS amount (per day), and one or MORE days to eat it on (chips Today /
 * Tomorrow / the next several days, default Tomorrow, anchored on `tracker.date()`). On Add it runs one
 * `Api.addMealToTracker(meal.id, { localDate: iso, servings })` POST per selected day (reusing the existing
 * /tracker/food/from-meal endpoint — NO new backend), collects successes/failures, emits the result, and
 * closes. The PAGE surfaces the confirmation toast + refreshes the viewed day if it was one we logged to.
 *
 * Self-styled with the page-host Strata tokens (var(--*) only — no global --tech-*), mobile-first with
 * >=44px targets, aria labels, a visually-hidden aria-live status, reduced-motion-friendly chrome. The
 * accent matches the Food / fuel card (cal). detent="full" — it's a scrollable pick list.
 *
 * Contract (the page binds these VERBATIM):
 *   selector : app-leftovers-sheet
 *   inputs   : open   (model<boolean>, two-way)
 *   outputs  : logged ({ title; servings; loggedDates: string[]; failed: number }) — emitted after the
 *              add() loop (the sheet then closes itself)
 *
 * Usage: `<app-leftovers-sheet [(open)]="leftoversOpen" (logged)="onLeftoversLogged($event)" />`
 */

/** What the sheet emits after the add() loop: the logged meal's title, the scaled servings, the ISO dates
 *  that landed (successes only) + how many writes FAILED. The page toasts + refreshes from this. */
export interface LeftoversLogged {
  title: string;
  servings: number;
  loggedDates: string[];
  failed: number;
}

/** A planned meal flattened with its planned day, for the pick list (most-recent first). */
interface LeftoverChoice {
  meal: FamilyMeal;
  /** The meal's planned ISO date ("YYYY-MM-DD"). */
  plannedDate: string;
  /** A friendly "Wed Jun 25" style label for the planned day. */
  plannedLabel: string;
  /** True when the meal has macros set (only these are loggable — the from-meal endpoint 400s without). */
  hasMacros: boolean;
}

/** One selectable "eat it on this day" chip. */
interface DayChip {
  iso: string;
  label: string;
}

/** The default servings to log per day (one portion); mirrors the backend's historical "log ONE serving". */
const DEFAULT_SERVINGS = 1;
/** Clamp bounds for the servings input — must match the backend clamp (0.1..99). */
const MIN_SERVINGS = 0.1;
const MAX_SERVINGS = 99;
/** How many future days (beyond today) to offer as "eat the leftover on" chips. */
const FUTURE_DAYS = 6;

/** Strip a possibly-ISO-datetime down to its "YYYY-MM-DD" date part. */
function dateOnly(s: string): string {
  return (s || '').slice(0, 10);
}

/** Local "YYYY-MM-DD" for a Date (no UTC shift — the planner + tracker are local-date keyed). */
function toIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

@Component({
  selector: 'app-leftovers-sheet',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DecimalPipe, FormsModule, MatIconModule, BottomSheet],
  template: `
    <app-bottom-sheet [(open)]="open" detent="full" label="Log leftovers" [dismissable]="!saving()">
      <div class="lo-head" style="--accent-edge: var(--cal-a);">
        <span class="lo-spark" aria-hidden="true">
          <mat-icon>takeout_dining</mat-icon>
        </span>
        <div>
          <h2 class="lo-title">Log leftovers</h2>
          <p class="lo-sub">Pull a planned meal and eat it over the next day or days</p>
        </div>
      </div>

      <div class="lo-body" style="--cta-a: var(--cal-a); --cta-b: var(--cal-b); --accent-edge: var(--cal-a);">
        @if (loading()) {
          <div class="lo-status" role="status">
            <span class="lo-spin" aria-hidden="true"></span>
            <span>Loading your planned meals…</span>
          </div>
        } @else if (!hasLoggable()) {
          <div class="lo-empty" role="status">
            <mat-icon aria-hidden="true">no_meals</mat-icon>
            <p class="lo-empty-title">No planned meals with macros yet.</p>
            <p class="lo-empty-hint">
              Add macros to a meal on the meal planner (Estimate with AI or the food database), then it can
              be logged here as leftovers.
            </p>
          </div>
        } @else {
          <!-- 1) Pick a meal. -->
          <section class="lo-section" aria-label="Pick a meal">
            <span class="lo-label">Which meal?</span>

            <div class="lo-search">
              <mat-icon class="lo-search-icon" aria-hidden="true">search</mat-icon>
              <input class="lo-search-input" type="text" autocomplete="off" maxlength="80"
                     enterkeyhint="search" placeholder="Search meals — e.g. chili, lasagna"
                     aria-label="Search meals"
                     [ngModel]="query()" (ngModelChange)="query.set($event)" />
            </div>

            <div class="lo-list" role="listbox" aria-label="Planned meals">
              @for (c of filteredChoices(); track c.meal.id) {
                <button type="button" role="option" class="lo-meal"
                        [class.on]="isPicked(c)" [class.off]="!c.hasMacros"
                        [attr.aria-selected]="isPicked(c)" [disabled]="!c.hasMacros"
                        (click)="pick(c)">
                  <span class="lo-meal-main">
                    <span class="lo-meal-title">{{ c.meal.title }}</span>
                    <span class="lo-meal-meta">
                      <span class="lo-meal-day">{{ c.plannedLabel }}</span>
                      @if (c.hasMacros) {
                        <span class="lo-meal-macros">
                          {{ c.meal.perServing.calories | number }} kcal ·
                          {{ c.meal.perServing.proteinG | number: '1.0-1' }}g protein / serving
                        </span>
                      } @else {
                        <span class="lo-meal-nomacros">No macros yet — add them on the planner</span>
                      }
                    </span>
                  </span>
                  @if (isPicked(c)) {
                    <mat-icon class="lo-meal-check" aria-hidden="true">check_circle</mat-icon>
                  }
                </button>
              } @empty {
                <p class="lo-list-none">No meals match “{{ query() }}”.</p>
              }
            </div>
          </section>

          <!-- 2) Servings per day. -->
          <section class="lo-section" aria-label="Servings">
            <span class="lo-label" id="lo-servings-lbl">How much per day?</span>
            <div class="lo-stepper">
              <button type="button" class="lo-step" aria-label="Less servings"
                      (click)="bump(-0.5)">
                <mat-icon aria-hidden="true">remove</mat-icon>
              </button>
              <input class="lo-step-input" type="number" inputmode="decimal" enterkeyhint="done"
                     [min]="minServings" [max]="maxServings" step="0.5"
                     aria-labelledby="lo-servings-lbl"
                     [ngModel]="servings()" (ngModelChange)="servings.set($event)" />
              <button type="button" class="lo-step" aria-label="More servings"
                      (click)="bump(0.5)">
                <mat-icon aria-hidden="true">add</mat-icon>
              </button>
            </div>

            <!-- Live per-day macro preview, rounded exactly as the server logs it. -->
            @if (preview(); as pv) {
              <div class="lo-preview" aria-label="What will be logged each day">
                <span class="lo-preview-label">
                  <mat-icon aria-hidden="true">analytics</mat-icon> Each day
                </span>
                <div class="lo-macros">
                  <span class="lo-macro cal">{{ pv.calories | number }} <small>kcal</small></span>
                  <span class="lo-macro">{{ pv.proteinG | number: '1.0-1' }}<small>P</small></span>
                  <span class="lo-macro">{{ pv.carbG | number: '1.0-1' }}<small>C</small></span>
                  <span class="lo-macro">{{ pv.fatG | number: '1.0-1' }}<small>F</small></span>
                </div>
              </div>
            }
          </section>

          <!-- 3) Which days to eat it. -->
          <section class="lo-section" aria-label="Which days">
            <span class="lo-label">Eat it on…</span>
            <div class="lo-days" role="group" aria-label="Days to log the leftover">
              @for (chip of dayChips(); track chip.iso) {
                <button type="button" class="lo-day" [class.on]="isDaySelected(chip.iso)"
                        [attr.aria-pressed]="isDaySelected(chip.iso)"
                        (click)="toggleDay(chip.iso)">
                  @if (isDaySelected(chip.iso)) {
                    <mat-icon aria-hidden="true">check</mat-icon>
                  }
                  {{ chip.label }}
                </button>
              }
            </div>
            <p class="lo-daycount">
              @if (selectedCount() > 0) {
                Logging to {{ selectedCount() }} day{{ selectedCount() === 1 ? '' : 's' }}
              } @else {
                Pick at least one day
              }
            </p>
          </section>

          <div class="lo-actions">
            <button type="button" class="lo-cta" (click)="add()"
                    [disabled]="!canAdd() || tracker.readOnly()">
              @if (saving()) {
                <span class="lo-spin light" aria-hidden="true"></span>
              } @else {
                <mat-icon aria-hidden="true">add</mat-icon>
                Log leftovers@if (selectedCount() > 0) { · {{ selectedCount() }} day{{ selectedCount() === 1 ? '' : 's' }} }
              }
            </button>
          </div>
        }

        <span class="lo-sr" role="status" aria-live="polite">{{ announce() }}</span>
      </div>
    </app-bottom-sheet>
  `,
  styles: [`
    :host { display: contents; }

    .lo-head {
      display: flex; align-items: center; gap: 12px;
      padding: 4px 2px 14px;
    }
    .lo-spark {
      flex: 0 0 auto; display: flex; align-items: center; justify-content: center;
      width: 40px; height: 40px; border-radius: var(--r-pill);
      background: linear-gradient(135deg, var(--cal-a), var(--cal-b));
      box-shadow: var(--lift-1);
    }
    .lo-spark mat-icon { width: 22px; height: 22px; font-size: 22px; line-height: 22px; color: #fff; }
    .lo-title {
      margin: 0; font-family: var(--font-ui); font-weight: 700; font-size: 19px;
      color: var(--ink); letter-spacing: -.01em;
    }
    .lo-sub { margin: 2px 0 0; font-size: 12px; color: var(--ink-dim); }

    .lo-body { display: flex; flex-direction: column; gap: 18px; padding-bottom: 8px; }

    /* Loading + empty states */
    .lo-status {
      display: flex; align-items: center; gap: 12px; padding: 24px 4px;
      font-size: 14px; color: var(--ink-dim);
    }
    .lo-empty {
      display: flex; flex-direction: column; align-items: center; gap: 8px;
      text-align: center; padding: 28px 12px;
    }
    .lo-empty mat-icon {
      width: 40px; height: 40px; font-size: 40px; line-height: 40px; color: var(--ink-faint);
    }
    .lo-empty-title { margin: 4px 0 0; font-size: 15px; font-weight: 600; color: var(--ink); }
    .lo-empty-hint { margin: 0; font-size: 12.5px; color: var(--ink-dim); max-width: 34ch; }

    .lo-section { display: flex; flex-direction: column; gap: 10px; }
    .lo-label {
      font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--ink-dim);
      padding-left: 2px;
    }

    /* Search field — pressed-well on the matte surface (matches the quick sheets). */
    .lo-search {
      display: flex; align-items: center; gap: 8px; min-height: 48px;
      padding: 0 14px;
      background: var(--bg-sink); border: 1px solid var(--hairline); border-radius: var(--r-tile);
      box-shadow: var(--press);
    }
    .lo-search:focus-within { outline: 2px solid var(--focus); outline-offset: 2px; border-color: var(--focus); }
    .lo-search-icon { flex: 0 0 auto; width: 20px; height: 20px; font-size: 20px; line-height: 20px; color: var(--ink-faint); }
    .lo-search-input {
      flex: 1 1 auto; min-width: 0; height: 100%; border: 0; background: transparent;
      font-family: var(--font-ui); font-size: 16px; color: var(--ink);
      -webkit-appearance: none; appearance: none; outline: none;
    }
    .lo-search-input::placeholder { color: var(--ink-faint); }

    /* Pick list */
    .lo-list { display: flex; flex-direction: column; gap: 8px; }
    .lo-meal {
      display: flex; align-items: center; gap: 10px; width: 100%; min-height: 56px;
      padding: 10px 12px; text-align: left;
      background: var(--bg-rise); border: 1px solid var(--hairline); border-radius: var(--r-tile);
      color: var(--ink); cursor: pointer;
      touch-action: manipulation; -webkit-tap-highlight-color: transparent;
      transition: border-color 140ms var(--ease-out), transform 120ms var(--ease-out), box-shadow 120ms var(--ease-out);
    }
    .lo-meal:active:not(:disabled) { transform: scale(.99) translateY(1px); box-shadow: var(--press); }
    .lo-meal.on { border-color: var(--accent-edge); box-shadow: var(--lift-1); }
    .lo-meal.off { opacity: .5; cursor: default; }
    .lo-meal-main { display: flex; flex-direction: column; gap: 3px; flex: 1 1 auto; min-width: 0; }
    .lo-meal-title { font-size: 15px; font-weight: 600; color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .lo-meal-meta { display: flex; flex-direction: column; gap: 1px; }
    .lo-meal-day { font-size: 11px; text-transform: uppercase; letter-spacing: .03em; color: var(--ink-dim); }
    .lo-meal-macros { font-size: 12px; color: var(--ink-dim); font-variant-numeric: tabular-nums; }
    .lo-meal-nomacros { font-size: 12px; color: var(--ink-faint); font-style: italic; }
    .lo-meal-check { flex: 0 0 auto; width: 22px; height: 22px; font-size: 22px; line-height: 22px; color: var(--accent-edge); }
    .lo-list-none { margin: 4px 2px; font-size: 13px; color: var(--ink-dim); }

    /* Servings stepper */
    .lo-stepper { display: flex; align-items: stretch; gap: 10px; }
    .lo-step {
      flex: 0 0 auto; width: 48px; min-height: 48px; display: flex; align-items: center; justify-content: center;
      background: var(--bg-rise); border: 1px solid var(--hairline); border-radius: var(--r-tile);
      color: var(--ink); cursor: pointer; touch-action: manipulation; -webkit-tap-highlight-color: transparent;
      transition: transform 120ms var(--ease-out), box-shadow 120ms var(--ease-out);
    }
    .lo-step:active { transform: scale(.96) translateY(1px); box-shadow: var(--press); }
    .lo-step:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
    .lo-step mat-icon { width: 22px; height: 22px; font-size: 22px; line-height: 22px; }
    .lo-step-input {
      flex: 1 1 auto; min-width: 0; box-sizing: border-box; min-height: 48px; text-align: center;
      padding: 0 8px; font-family: var(--font-ui); font-size: 18px; font-weight: 600; color: var(--ink);
      background: var(--bg-sink); border: 1px solid var(--hairline); border-radius: var(--r-tile);
      box-shadow: var(--press); -webkit-appearance: none; appearance: none;
      font-variant-numeric: tabular-nums;
    }
    .lo-step-input:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; border-color: var(--focus); }

    /* Per-day macro preview */
    .lo-preview {
      display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap;
      padding: 10px 12px; background: var(--bg-sink); border: 1px solid var(--hairline);
      border-radius: var(--r-tile);
    }
    .lo-preview-label {
      display: inline-flex; align-items: center; gap: 5px;
      font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--ink-dim);
    }
    .lo-preview-label mat-icon { width: 16px; height: 16px; font-size: 16px; line-height: 16px; }
    .lo-macros { display: flex; align-items: baseline; gap: 12px; font-variant-numeric: tabular-nums; }
    .lo-macro { font-size: 14px; font-weight: 600; color: var(--ink); }
    .lo-macro.cal { color: var(--cal-a); }
    .lo-macro small { font-size: 10px; font-weight: 500; color: var(--ink-dim); margin-left: 1px; }

    /* Day chips (multi-select) */
    .lo-days { display: flex; flex-wrap: wrap; gap: 8px; }
    .lo-day {
      display: inline-flex; align-items: center; gap: 4px; min-height: 44px; padding: 0 14px;
      background: var(--bg-rise); border: 1px solid var(--hairline); border-radius: var(--r-pill);
      font-family: var(--font-ui); font-size: 13px; font-weight: 600; color: var(--ink-dim);
      cursor: pointer; touch-action: manipulation; -webkit-tap-highlight-color: transparent;
      transition: border-color 140ms var(--ease-out), color 140ms var(--ease-out), transform 120ms var(--ease-out);
    }
    .lo-day:active { transform: scale(.97) translateY(1px); }
    .lo-day:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
    .lo-day.on { border-color: var(--accent-edge); color: var(--ink); box-shadow: var(--lift-1); }
    .lo-day mat-icon { width: 16px; height: 16px; font-size: 16px; line-height: 16px; color: var(--accent-edge); }
    .lo-daycount { margin: 0; padding-left: 2px; font-size: 12px; color: var(--ink-dim); }

    /* Add CTA */
    .lo-actions { display: flex; padding-top: 2px; }
    .lo-cta {
      flex: 1 1 auto; min-height: 52px;
      display: flex; align-items: center; justify-content: center; gap: 8px;
      font-family: var(--font-ui); font-size: 16px; font-weight: 700; letter-spacing: -.01em;
      color: #fff; background: linear-gradient(135deg, var(--cta-a, var(--cal-a)), var(--cta-b, var(--cal-b)));
      border: 0; border-radius: var(--r-pill); box-shadow: var(--lift-2);
      touch-action: manipulation; -webkit-tap-highlight-color: transparent; cursor: pointer;
      transition: transform 120ms var(--ease-out), box-shadow 120ms var(--ease-out), opacity 160ms var(--ease-out);
    }
    .lo-cta mat-icon { width: 22px; height: 22px; font-size: 22px; line-height: 22px; }
    .lo-cta:active:not(:disabled) { transform: translateY(1px) scale(.99); box-shadow: var(--press); }
    .lo-cta:disabled { opacity: .45; cursor: default; }
    .lo-cta:focus-visible { outline: 2px solid var(--focus); outline-offset: 3px; }

    .lo-spin {
      width: 18px; height: 18px; border-radius: 50%;
      border: 2px solid var(--hairline); border-top-color: var(--cal-a);
      animation: lo-spin 700ms linear infinite;
    }
    .lo-spin.light { border-color: rgba(255,255,255,.4); border-top-color: #fff; }
    @keyframes lo-spin { to { transform: rotate(360deg); } }

    .lo-sr {
      position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; border: 0;
      overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap;
    }

    @media (prefers-reduced-motion: reduce) {
      .lo-meal, .lo-step, .lo-day, .lo-cta { transition: none; }
      .lo-spin { animation: none; }
    }
  `],
})
export class LeftoversSheet {
  private readonly api = inject(Api);
  protected readonly tracker = inject(OptimisticTracker);

  readonly minServings = MIN_SERVINGS;
  readonly maxServings = MAX_SERVINGS;

  /** Two-way open state — the page sets this true when the user picks "Leftovers". */
  readonly open = model<boolean>(false);
  /** Emitted after the add() loop with the logged meal/servings + the days that landed (the sheet then closes). */
  readonly logged = output<LeftoversLogged>();

  /** True while the two planner weeks are being fetched. */
  protected readonly loading = signal(true);

  /** Every planned meal across the loaded weeks, most-recent first (macro-less ones included, flagged). */
  protected readonly choices = signal<LeftoverChoice[]>([]);

  /** The free-text filter over the pick list (by meal title). */
  protected readonly query = signal('');

  /** The id of the picked meal, or null until one is chosen. */
  protected readonly pickedId = signal<number | null>(null);

  /** The servings to log PER selected day, bound to the stepper input (clamped on Add). */
  protected readonly servings = signal<number>(DEFAULT_SERVINGS);

  /** The day chips offered (Today / Tomorrow / dated), rebuilt from the viewed date on each open. */
  protected readonly dayChips = signal<DayChip[]>([]);

  /** The set of selected day ISO dates (default: Tomorrow). */
  protected readonly selectedDays = signal<Set<string>>(new Set());

  /** True while the writes are in flight (latches Add against a double-tap; blocks dismiss). */
  protected readonly saving = signal(false);

  /** Visually-hidden aria-live status. */
  protected readonly announce = signal('');

  constructor() {
    // Each time the sheet OPENS: rebuild the day chips from the viewed date, then (re)load the planner weeks.
    effect(() => {
      if (this.open()) {
        this.seedDays();
        void this.load();
      }
    });
  }

  // ─────────────────────────────────────────── load ────────────────────────────────────────────

  /**
   * Load the CURRENT and PREVIOUS planner weeks, flatten every meal with its planned day, de-dupe by id, and
   * sort most-recent-first so recently-cooked dishes surface at the top. Best-effort: a failed week just
   * contributes nothing.
   */
  private async load(): Promise<void> {
    this.loading.set(true);
    this.query.set('');
    this.pickedId.set(null);
    this.announce.set('Loading your planned meals…');
    try {
      const prevWeekStart = toIso(this.mondayOf(new Date(), -1));
      const [current, previous] = await Promise.all([
        firstValueFrom(this.api.familyMeals()).catch(() => [] as FamilyMealDay[]),
        firstValueFrom(this.api.familyMeals(prevWeekStart)).catch(() => [] as FamilyMealDay[]),
      ]);

      const byId = new Map<number, LeftoverChoice>();
      for (const day of [...current, ...previous]) {
        const iso = dateOnly(day.localDate);
        for (const meal of day.meals ?? []) {
          if (byId.has(meal.id)) continue; // a meal id is unique to one day; first wins.
          byId.set(meal.id, {
            meal,
            plannedDate: iso,
            plannedLabel: this.dayLabel(iso),
            hasMacros: meal.macroSource !== 'none',
          });
        }
      }

      // Most-recent first (by planned date desc), then by title for stable ordering within a day.
      const list = [...byId.values()].sort((a, b) => {
        if (a.plannedDate !== b.plannedDate) return a.plannedDate < b.plannedDate ? 1 : -1;
        return a.meal.title.localeCompare(b.meal.title);
      });
      this.choices.set(list);

      // Pre-pick the most-recent meal that actually has macros (so Add can light up immediately).
      const firstLoggable = list.find((c) => c.hasMacros);
      if (firstLoggable) this.pickedId.set(firstLoggable.meal.id);
      this.announce.set(
        list.some((c) => c.hasMacros) ? 'Planned meals loaded.' : 'No planned meals with macros yet.',
      );
    } catch {
      this.choices.set([]);
      this.announce.set('Couldn’t load planned meals.');
    } finally {
      this.loading.set(false);
    }
  }

  // ─────────────────────────────────────────── pick list ───────────────────────────────────────

  /** The pick list after applying the free-text title filter (case-insensitive substring). */
  protected readonly filteredChoices = computed<LeftoverChoice[]>(() => {
    const q = this.query().trim().toLowerCase();
    const all = this.choices();
    if (!q) return all;
    return all.filter((c) => c.meal.title.toLowerCase().includes(q));
  });

  /** Are there any loggable (macro-bearing) meals at all? Drives the "nothing to log" hint. */
  protected readonly hasLoggable = computed(() => this.choices().some((c) => c.hasMacros));

  /** The currently-picked choice (drives Add validity + the macro preview), or null. */
  protected readonly picked = computed<LeftoverChoice | null>(() => {
    const id = this.pickedId();
    if (id == null) return null;
    return this.choices().find((c) => c.meal.id === id) ?? null;
  });

  /** Pick a meal (no-op for a macro-less one — it can't be logged). */
  protected pick(choice: LeftoverChoice): void {
    if (!choice.hasMacros) return;
    this.pickedId.set(choice.meal.id);
  }

  /** True when the given choice is the picked one. */
  protected isPicked(choice: LeftoverChoice): boolean {
    return this.pickedId() === choice.meal.id;
  }

  // ─────────────────────────────────────────── servings + days ─────────────────────────────────

  /** Nudge the servings stepper by a delta, clamped into [MIN, MAX]. */
  protected bump(delta: number): void {
    const next = Math.round((this.safeServings() + delta) * 10) / 10;
    this.servings.set(Math.min(Math.max(next, MIN_SERVINGS), MAX_SERVINGS));
  }

  /** The clamped, finite servings used for the preview + the writes. */
  protected readonly safeServings = computed(() => {
    const s = this.servings();
    if (!Number.isFinite(s) || s <= 0) return DEFAULT_SERVINGS;
    return Math.min(Math.max(s, MIN_SERVINGS), MAX_SERVINGS);
  });

  /**
   * Live per-day macro preview = the picked meal's per-serving macros × servings, rounded the way the server
   * rounds the logged portion (calories to int, P/C/F to 0.1, floored at 0). Null when nothing is picked.
   */
  protected readonly preview = computed(() => {
    const c = this.picked();
    if (!c) return null;
    const s = this.safeServings();
    const p = c.meal.perServing;
    return {
      calories: Math.max(0, Math.round(p.calories * s)),
      proteinG: this.round1(p.proteinG * s),
      carbG: this.round1(p.carbG * s),
      fatG: this.round1(p.fatG * s),
    };
  });

  /** Toggle a day chip in/out of the selection (the multi-select). */
  protected toggleDay(iso: string): void {
    this.selectedDays.update((set) => {
      const next = new Set(set);
      if (next.has(iso)) next.delete(iso);
      else next.add(iso);
      return next;
    });
  }

  /** True when the given day is selected. */
  protected isDaySelected(iso: string): boolean {
    return this.selectedDays().has(iso);
  }

  /** How many days are selected (drives the "Logging to N day(s)" note + Add validity). */
  protected readonly selectedCount = computed(() => this.selectedDays().size);

  /** Whether Add is enabled: a loggable meal picked AND at least one day selected AND not saving. */
  protected readonly canAdd = computed(
    () => !this.saving() && this.picked() != null && this.selectedCount() > 0,
  );

  // ─────────────────────────────────────────── confirm ─────────────────────────────────────────

  /**
   * Add: run one `addMealToTracker(meal.id, { localDate, servings })` POST per selected day, collect
   * successes/failures, emit the result, then close. The PAGE toasts + refreshes the viewed day. Latched
   * against a double-tap; a total failure still emits (with failed > 0) so the page can report it.
   */
  protected async add(): Promise<void> {
    if (!this.canAdd() || this.tracker.readOnly()) return;
    const choice = this.picked();
    if (!choice) return;
    const servings = this.safeServings();
    const days = [...this.selectedDays()].sort();

    this.saving.set(true);
    this.announce.set('Logging leftovers…');
    const loggedDates: string[] = [];
    let failed = 0;
    for (const iso of days) {
      try {
        await firstValueFrom(
          this.api.addMealToTracker(choice.meal.id, { localDate: iso, servings }),
        );
        loggedDates.push(iso);
      } catch {
        failed++;
      }
    }
    this.saving.set(false);
    this.announce.set(
      loggedDates.length > 0
        ? `Logged ${choice.meal.title} to ${loggedDates.length} day(s).`
        : `Couldn’t log ${choice.meal.title}.`,
    );
    this.logged.emit({ title: choice.meal.title, servings, loggedDates, failed });
    this.open.set(false);
  }

  // ─────────────────────────────────────────── helpers ─────────────────────────────────────────

  private round1(n: number): number {
    return Math.max(0, Math.round((Number.isFinite(n) ? n : 0) * 10) / 10);
  }

  /** Rebuild the day chips + default selection from the currently-viewed tracker date. */
  private seedDays(): void {
    this.dayChips.set(this.buildDayChips());
    this.selectedDays.set(new Set(this.defaultSelectedDays()));
  }

  /** The Monday of the week containing `from`, offset by `weekOffset` weeks (-1 = previous week). */
  private mondayOf(from: Date, weekOffset = 0): Date {
    const d = new Date(from);
    d.setHours(0, 0, 0, 0);
    const dow = (d.getDay() + 6) % 7; // 0 = Monday … 6 = Sunday
    d.setDate(d.getDate() - dow + weekOffset * 7);
    return d;
  }

  /** Build the "eat it on" chips: Today, Tomorrow, then the next several dated days from the viewed date. */
  private buildDayChips(): DayChip[] {
    const base = this.startDate();
    const chips: DayChip[] = [];
    for (let i = 0; i <= 1 + FUTURE_DAYS; i++) {
      const d = new Date(base);
      d.setDate(d.getDate() + i);
      chips.push({ iso: toIso(d), label: this.dayLabel(toIso(d)) });
    }
    return chips;
  }

  /** Tomorrow (relative to the viewed date) is the default leftover day. */
  private defaultSelectedDays(): string[] {
    const base = this.startDate();
    base.setDate(base.getDate() + 1);
    return [toIso(base)];
  }

  /** The chip anchor: the viewed tracker date when valid, else local today. */
  private startDate(): Date {
    const iso = dateOnly(this.tracker.date() ?? '');
    const d = new Date(`${iso}T00:00:00`);
    if (isNaN(d.getTime())) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      return today;
    }
    return d;
  }

  /** A friendly label for an ISO date: Today / Tomorrow / Yesterday, else "Wed Jun 25". */
  private dayLabel(iso: string): string {
    const d = new Date(`${iso}T00:00:00`);
    if (isNaN(d.getTime())) return iso;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diff = Math.round((d.getTime() - today.getTime()) / 86_400_000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Tomorrow';
    if (diff === -1) return 'Yesterday';
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  }
}
