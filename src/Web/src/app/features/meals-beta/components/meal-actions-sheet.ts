import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';

import { FamilyMeal } from '../../../core/models';
import { BetaBottomSheet } from '../../beta-ui';
import { hasIngredients, slotMeta } from '../meals-beta.model';

/**
 * Forage MealActionsSheet — a small BetaBottomSheet that opens when a meal card is tapped: it shows the
 * meal's title, slot, per-serving macros and ingredient list, and a stack of actions (add to grocery,
 * remove). The page wires the action outputs to the same reuse-only Api calls (mealsToGrocery /
 * deleteFamilyMeal). Read-only display — the writes live on the page so the optimistic state stays there.
 */
@Component({
  selector: 'app-forage-meal-actions-sheet',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, BetaBottomSheet],
  template: `
    <app-bs-sheet [(open)]="open" detent="half" label="Meal actions" (closed)="onClosed()">
      @if (meal(); as m) {
        <div class="ma">
          <div class="ma-top">
            <span class="ma-ic" aria-hidden="true"><mat-icon>{{ slot().icon }}</mat-icon></span>
            <div class="ma-txt">
              <span class="ma-slot">{{ slot().label }}</span>
              <h2 class="ma-title">{{ m.title }}</h2>
              <span class="ma-by">Added by {{ m.createdByName }}</span>
            </div>
          </div>

          @if (m.macroSource !== 'none') {
            <div class="ma-macros">
              <div class="ma-macro ma-macro--cal">
                <span class="ma-val">{{ perCal() }}</span><span class="ma-unit">kcal</span>
              </div>
              <div class="ma-macro"><span class="ma-val">{{ m.perServing.proteinG }}</span><span class="ma-unit">P</span></div>
              <div class="ma-macro"><span class="ma-val">{{ m.perServing.carbG }}</span><span class="ma-unit">C</span></div>
              <div class="ma-macro"><span class="ma-val">{{ m.perServing.fatG }}</span><span class="ma-unit">F</span></div>
            </div>
            <p class="ma-per">per serving · {{ m.servings }} serving{{ m.servings === 1 ? '' : 's' }} total</p>
          }

          @if (ingredientLines().length) {
            <div class="ma-ings">
              <span class="ma-ings-h">Ingredients</span>
              <ul role="list">
                @for (line of ingredientLines(); track $index) { <li>{{ line }}</li> }
              </ul>
            </div>
          }

          <div class="ma-actions">
            @if (canGrocery()) {
              <button type="button" class="ma-btn ma-btn--accent" (click)="grocery.emit()">
                <mat-icon aria-hidden="true">add_shopping_cart</mat-icon> Add to grocery list
              </button>
            }
            <button type="button" class="ma-btn ma-btn--ghost" (click)="move.emit()">
              <mat-icon aria-hidden="true">event_repeat</mat-icon> Move to another day
            </button>
            <button type="button" class="ma-btn ma-btn--danger" (click)="remove.emit()">
              <mat-icon aria-hidden="true">delete_outline</mat-icon> Remove from plan
            </button>
          </div>
        </div>
      }
    </app-bs-sheet>
  `,
  styles: [`
    :host { display: contents; }
    .ma { display: flex; flex-direction: column; gap: 14px; padding-top: 4px; }
    .ma-top { display: flex; gap: 12px; align-items: flex-start; }
    .ma-ic {
      flex: 0 0 auto; display: grid; place-items: center; width: 46px; height: 46px; border-radius: 15px;
      background: linear-gradient(135deg, var(--accent-a), var(--accent-b)); color: #07140d;
    }
    .ma-ic mat-icon { font-size: 24px; width: 24px; height: 24px; }
    .ma-txt { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
    .ma-slot {
      font-size: 11px; font-weight: 800; letter-spacing: .05em; text-transform: uppercase; color: var(--ink-dim);
    }
    .ma-title { margin: 0; font-family: var(--font-display); font-weight: 600; font-size: 21px; color: var(--ink); line-height: 1.1; }
    .ma-by { font-size: 12px; font-weight: 600; color: var(--ink-faint); }

    .ma-macros {
      display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px;
    }
    .ma-macro {
      display: flex; flex-direction: column; align-items: center; gap: 1px;
      padding: 10px 4px; border-radius: var(--r-tile); background: var(--bg-sink); border: 1px solid var(--hairline);
    }
    .ma-macro--cal { border-color: color-mix(in srgb, var(--accent-a) 36%, transparent); }
    .ma-val { font-family: var(--font-display); font-variant-numeric: tabular-nums; font-size: 19px; font-weight: 600; color: var(--ink); line-height: 1; }
    .ma-unit { font-size: 10px; font-weight: 800; letter-spacing: .03em; color: var(--ink-dim); }
    .ma-per { margin: -6px 0 0; font-size: 12px; font-weight: 600; color: var(--ink-faint); text-align: center; }

    .ma-ings { display: flex; flex-direction: column; gap: 6px; }
    .ma-ings-h { font-size: 12px; font-weight: 800; letter-spacing: .04em; text-transform: uppercase; color: var(--ink-dim); }
    .ma-ings ul { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 3px; }
    .ma-ings li { font-size: 14px; color: var(--ink); }

    .ma-actions { display: flex; flex-direction: column; gap: 10px; padding-top: 2px; }
    .ma-btn {
      display: inline-flex; align-items: center; justify-content: center; gap: 8px;
      min-height: 50px; padding: 0 18px; border-radius: var(--r-pill);
      font-family: var(--font-ui); font-size: 15px; font-weight: 800; cursor: pointer;
      -webkit-tap-highlight-color: transparent; touch-action: manipulation;
      transition: transform 120ms var(--ease-out);
    }
    .ma-btn:active { transform: scale(.98); }
    .ma-btn:focus-visible { outline: 2px solid var(--focus); outline-offset: 3px; }
    .ma-btn mat-icon { font-size: 20px; width: 20px; height: 20px; }
    .ma-btn--accent {
      border: none; background: linear-gradient(135deg, var(--accent-a), var(--accent-b)); color: #07140d;
      box-shadow: var(--lift-2);
    }
    .ma-btn--ghost {
      border: 1px solid color-mix(in srgb, var(--accent-a) 40%, var(--hairline)); background: transparent; color: var(--ink);
    }
    .ma-btn--danger {
      border: 1px solid color-mix(in srgb, var(--warn) 45%, transparent); background: transparent; color: var(--warn);
    }
  `],
})
export class ForageMealActionsSheet {
  /** Two-way open state, owned by the page. */
  readonly open = signal(false);
  /** The meal whose actions are shown (null when none). */
  readonly meal = input<FamilyMeal | null>(null);
  /** Add this meal's ingredients to the grocery list. */
  readonly grocery = output<void>();
  /** Move this meal to another day of the week (kept in the same slot). */
  readonly move = output<void>();
  /** Remove this meal from the plan. */
  readonly remove = output<void>();

  protected readonly slot = computed(() => slotMeta(this.meal()?.slot ?? 'dinner'));
  protected readonly canGrocery = computed(() => { const m = this.meal(); return !!m && hasIngredients(m); });
  protected readonly perCal = computed(() => Math.round(this.meal()?.perServing.calories ?? 0));
  protected readonly ingredientLines = computed(() =>
    (this.meal()?.ingredients ?? '').split('\n').map(s => s.trim()).filter(Boolean));

  protected onClosed(): void { /* page clears its own open flag via two-way */ }
}
