import {
  ChangeDetectionStrategy, Component, computed, inject, output, signal,
} from '@angular/core';
import { MatIconModule } from '@angular/material/icon';

import { OptimisticTracker } from '../state/optimistic-tracker';
import { SwipeRow } from '../ui/swipe-row';
import { FoodEntryDto, Meal } from '../../../core/models';
import { group } from '../util/units';

/** A meal group as rendered by the ledger: its display title, the foods in it, and its calorie subtotal. */
interface MealGroup {
  meal: Meal;
  title: string;
  foods: FoodEntryDto[];
  calories: number;
  proteinG: number;
}

/** The four meals in their canonical ledger order (matches the backend `Meal` union). */
const MEAL_ORDER: ReadonlyArray<{ meal: Meal; title: string }> = [
  { meal: 'breakfast', title: 'Breakfast' },
  { meal: 'lunch', title: 'Lunch' },
  { meal: 'dinner', title: 'Dinner' },
  { meal: 'snack', title: 'Snack' },
];

/**
 * Strata FUEL card — the day's food, read straight from `OptimisticTracker.day().foods` and grouped into
 * the four meals (Breakfast / Lunch / Dinner / Snack). Each food is a GRAFT(LEDGER) typeset row: humanist
 * dish name on the left, tabular kcal on the right, a 1px dotted `--hairline` leader stretched between, and
 * a muted macro sub-line beneath. The whole card collapses/expands behind a chevron; each row swipes left
 * (via `app-swipe-row`) to optimistically delete (with the wrapper's own undo snackbar); an inline
 * "+ add to {meal}" affordance under every group asks the page to open the food sheet pre-targeted at that
 * meal.
 *
 * This component OWNS its sediment-card styling with the Strata `var(--*)` tokens inherited from the page
 * host (no global `--tech-*`). It does NOT open the food sheet itself — the sheet is a sibling component —
 * it merely emits `addToMeal(meal)` so the page can route the request. All numbers come from the wrapper's
 * locally-recomputed `day()`, so adds/deletes reflect instantly without a reload.
 *
 *   selector: app-fuel-card
 *   outputs:  addToMeal (Meal) — the user tapped "+ add to {meal}"; the page opens the food sheet for it
 */
@Component({
  selector: 'app-fuel-card',
  standalone: true,
  imports: [MatIconModule, SwipeRow],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'tb-card' },
  template: `
    <button type="button" class="fc-head" (click)="toggle()"
            [attr.aria-expanded]="expanded()" aria-controls="fc-body">
      <span class="fc-head-text">
        <span class="fc-title">Fuel</span>
        <span class="fc-total">{{ totalKcalLabel() }}</span>
        <span class="fc-unit">kcal</span>
      </span>
      <mat-icon class="fc-chevron" [class.open]="expanded()" aria-hidden="true">expand_more</mat-icon>
    </button>

    @if (expanded()) {
      <div id="fc-body" class="fc-body">
        @if (totalKcal() === 0) {
          <p class="fc-empty">No food logged yet.</p>
        }

        @for (g of groups(); track g.meal) {
          @if (g.foods.length || !readOnly()) {
            <section class="fc-group" [attr.aria-label]="g.title">
              <header class="fc-group-head">
                <span class="fc-group-title">{{ g.title }}</span>
                @if (g.foods.length) {
                  <span class="fc-group-sub">{{ groupSub(g) }}</span>
                }
              </header>

              @for (f of g.foods; track f.id) {
                <app-swipe-row
                  [disabled]="readOnly()"
                  [label]="'Delete ' + f.description"
                  (delete)="onDelete(f)">
                  <div class="fc-row">
                    <div class="fc-row-main">
                      <span class="fc-name">{{ f.description }}</span>
                      <span class="fc-leader" aria-hidden="true"></span>
                      <span class="fc-kcal">{{ kcal(f) }}</span>
                    </div>
                    @if (macroLine(f); as ml) {
                      <span class="fc-macros">{{ ml }}</span>
                    }
                  </div>
                </app-swipe-row>
              }

              @if (!readOnly()) {
                <button type="button" class="fc-add" (click)="addToMeal.emit(g.meal)">
                  <mat-icon aria-hidden="true">add</mat-icon>
                  <span>add to {{ g.title.toLowerCase() }}</span>
                </button>
              }
            </section>
          }
        }
      </div>
    }
  `,
  styles: [`
    :host {
      display: block;
      padding: 16px max(16px, env(safe-area-inset-left)) 14px max(16px, env(safe-area-inset-right));
      -webkit-tap-highlight-color: transparent;
    }

    /* ── header (collapse/expand) ─────────────────────────────────────────── */
    .fc-head {
      display: flex; align-items: baseline; justify-content: space-between; gap: 12px;
      width: 100%; min-height: 44px;
      background: none; border: 0; padding: 0; margin: 0; cursor: pointer;
      color: var(--ink); text-align: left;
      touch-action: manipulation; -webkit-tap-highlight-color: transparent;
    }
    .fc-head-text { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
    .fc-title {
      font-family: var(--font-ui); font-size: 13px; font-weight: 600;
      text-transform: uppercase; letter-spacing: .06em; color: var(--ink-dim);
    }
    .fc-total {
      font-family: var(--font-display); font-size: 22px; font-weight: 600;
      letter-spacing: -.02em; font-variant-numeric: tabular-nums; color: var(--ink);
    }
    .fc-unit {
      font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--ink-faint);
    }
    .fc-chevron {
      flex: 0 0 auto; color: var(--ink-dim);
      transition: transform 220ms var(--ease-out);
    }
    .fc-chevron.open { transform: rotate(180deg); }

    /* ── body ─────────────────────────────────────────────────────────────── */
    .fc-body { margin-top: 12px; }
    .fc-empty {
      margin: 4px 0 0; font-family: var(--font-ui); font-size: 13px; color: var(--ink-faint);
    }

    .fc-group { margin-top: 14px; }
    .fc-group:first-child { margin-top: 0; }
    .fc-group-head {
      display: flex; align-items: baseline; justify-content: space-between; gap: 10px;
      margin-bottom: 4px;
    }
    .fc-group-title {
      font-family: var(--font-ui); font-size: 11px; font-weight: 700;
      text-transform: uppercase; letter-spacing: .08em; color: var(--ink-dim);
    }
    .fc-group-sub {
      font-family: var(--font-ui); font-size: 11px; font-variant-numeric: tabular-nums;
      color: var(--ink-faint); letter-spacing: .02em;
    }

    /* ── ledger row (GRAFT LEDGER: name · dotted-leader · tabular kcal) ─────── */
    app-swipe-row { margin: 2px 0; }
    .fc-row { padding: 7px 2px; min-height: 30px; }
    .fc-row-main { display: flex; align-items: baseline; gap: 6px; }
    .fc-name {
      font-family: var(--font-ui); font-size: 15px; font-weight: 500; color: var(--ink);
      line-height: 1.25; min-width: 0; flex: 0 1 auto;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .fc-leader {
      flex: 1 1 auto; align-self: flex-end; min-width: 14px;
      height: 0; margin-bottom: 4px;
      border-bottom: 1px dotted var(--hairline);
    }
    .fc-kcal {
      flex: 0 0 auto;
      font-family: var(--font-display); font-size: 15px; font-weight: 500;
      font-variant-numeric: tabular-nums; letter-spacing: -.01em; color: var(--ink);
    }
    .fc-macros {
      display: block; margin-top: 1px;
      font-family: var(--font-ui); font-size: 12px; color: var(--ink-faint);
      letter-spacing: .01em;
    }

    /* ── inline add ───────────────────────────────────────────────────────── */
    .fc-add {
      display: inline-flex; align-items: center; gap: 4px;
      margin-top: 6px; min-height: 44px; padding: 0 4px;
      background: none; border: 0; cursor: pointer;
      font-family: var(--font-ui); font-size: 13px; font-weight: 600; color: var(--ink-dim);
      touch-action: manipulation; -webkit-tap-highlight-color: transparent;
      transition: color 120ms var(--ease-out);
    }
    .fc-add:active { color: var(--ink); }
    .fc-add mat-icon {
      font-size: 18px; width: 18px; height: 18px;
    }

    /* ── focus + reduced-motion ───────────────────────────────────────────── */
    .fc-head:focus-visible, .fc-add:focus-visible {
      outline: 2px solid var(--focus); outline-offset: 3px; border-radius: var(--r-tile);
    }
    @media (prefers-reduced-motion: reduce) {
      .fc-chevron, .fc-add { transition: none; }
    }
  `],
})
export class FuelCard {
  private readonly tracker = inject(OptimisticTracker);

  /** The user tapped "+ add to {meal}" — the page opens the food sheet pre-targeted at this meal. */
  readonly addToMeal = output<Meal>();

  /** Collapsed state is local UI; the card opens expanded. */
  protected readonly expanded = signal(true);

  /** Read-only (shared) views hide deletes + the inline add. */
  protected readonly readOnly = computed(() => this.tracker.readOnly());

  /** The day's foods bucketed into the four meals in canonical order, with per-meal subtotals. */
  protected readonly groups = computed<MealGroup[]>(() => {
    const foods = this.tracker.day()?.foods ?? [];
    return MEAL_ORDER.map(({ meal, title }) => {
      const inMeal = foods.filter(f => f.meal === meal);
      return {
        meal, title, foods: inMeal,
        calories: inMeal.reduce((a, f) => a + (f.calories || 0), 0),
        proteinG: inMeal.reduce((a, f) => a + (f.proteinG || 0), 0),
      };
    });
  });

  /** Total food calories for the day (the card header figure). */
  protected readonly totalKcal = computed(() =>
    (this.tracker.day()?.foods ?? []).reduce((a, f) => a + (f.calories || 0), 0));

  protected readonly totalKcalLabel = computed(() => group(this.totalKcal()));

  protected toggle(): void {
    this.expanded.update(v => !v);
  }

  /** Rounded, grouped kcal for one food row. */
  protected kcal(f: FoodEntryDto): string {
    return group(f.calories);
  }

  /** The muted macro sub-line under a food (omitted when every macro is zero/absent). */
  protected macroLine(f: FoodEntryDto): string | null {
    const p = Math.round(f.proteinG || 0);
    const c = Math.round(f.carbG || 0);
    const ft = Math.round(f.fatG || 0);
    const qty = f.quantity && f.quantity !== 1 ? `${this.trim(f.quantity)}× ` : '';
    if (!p && !c && !ft) return qty ? qty.trim() : null;
    return `${qty}P ${p} · C ${c} · F ${ft}`;
  }

  /** Per-meal subtotal line (kcal + protein) in the group header. */
  protected groupSub(g: MealGroup): string {
    return `${group(g.calories)} kcal · P ${Math.round(g.proteinG)}`;
  }

  protected onDelete(f: FoodEntryDto): void {
    void this.tracker.deleteFood(f.id);
  }

  /** Drop a trailing .0 from a quantity for the sub-line (2 -> "2", 1.5 -> "1.5"). */
  private trim(n: number): string {
    return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
  }
}
