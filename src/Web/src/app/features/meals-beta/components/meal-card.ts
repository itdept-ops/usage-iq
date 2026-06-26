import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';

import { FamilyMeal } from '../../../core/models';
import { BetaSvgRing } from '../../beta-ui';
import { hasIngredients, macroTag, slotMeta } from '../meals-beta.model';

/**
 * Forage MealCard — a planned meal as a DEPTH card, wrapped by the page in a BetaSwipeRow. A calorie macro
 * RING (BetaSvgRing, calories vs the daily goal when known) anchors the left; the slot icon + title + a
 * per-serving line sit centre; protein / carb / fat micro-chips run beneath. When macros aren't set the
 * card shows a quiet "no macros" state instead of the ring. Tapping the body emits `open` (the page opens
 * the action sheet); the explicit grocery button emits `grocery`. Reads --accent-a/--accent-b off the host.
 *
 * Presentational only — the page owns the data + the swipe gesture (this card is the swipe-row body).
 */
@Component({
  selector: 'app-forage-meal-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, BetaSvgRing],
  template: `
    <button type="button" class="mc" [attr.aria-label]="meal().title + ', ' + slot().label" (click)="open.emit()">
      <!-- Calorie ring (or a quiet macro-less badge). -->
      <div class="mc-ring">
        @if (hasMacros()) {
          <app-bs-ring [value]="calFrac()" [size]="58" [stroke]="7"
                       [label]="ringLabel()" [signalOnFull]="true">
            <span class="mc-ring-num">{{ perCal() }}</span>
          </app-bs-ring>
        } @else {
          <span class="mc-slot-ic" aria-hidden="true"><mat-icon>{{ slot().icon }}</mat-icon></span>
        }
      </div>

      <!-- Title + slot + per-serving line. -->
      <div class="mc-body">
        <div class="mc-slot">
          <mat-icon class="mc-slot-glyph" aria-hidden="true">{{ slot().icon }}</mat-icon>
          <span>{{ slot().label }}</span>
          <span class="mc-tag" [class.is-set]="hasMacros()">{{ tag() }}</span>
        </div>
        <div class="mc-title">{{ meal().title }}</div>
        @if (hasMacros()) {
          <div class="mc-macros" aria-hidden="true">
            <span class="mc-chip mc-chip--p">P {{ meal().perServing.proteinG }}g</span>
            <span class="mc-chip">C {{ meal().perServing.carbG }}g</span>
            <span class="mc-chip">F {{ meal().perServing.fatG }}g</span>
            @if (meal().servings > 1) { <span class="mc-chip mc-chip--sv">{{ meal().servings }} servings</span> }
          </div>
        } @else {
          <div class="mc-sub">{{ ingredientCount() }}</div>
        }
      </div>

      <!-- Quick add-to-grocery (stops the row tap). -->
      @if (canGrocery()) {
        <span class="mc-gro" role="button" tabindex="0"
              [attr.aria-label]="'Add ' + meal().title + ' to grocery list'"
              (click)="onGrocery($event)" (keydown.enter)="onGrocery($event)">
          <mat-icon aria-hidden="true">add_shopping_cart</mat-icon>
        </span>
      }
    </button>
  `,
  styles: [`
    :host { display: block; }
    .mc {
      display: flex; align-items: center; gap: 12px; width: 100%;
      padding: 12px 12px 12px 12px; border: none; text-align: left;
      background: var(--bg-rise); border-radius: var(--r-tile);
      color: var(--ink); cursor: pointer; -webkit-tap-highlight-color: transparent; touch-action: manipulation;
      transition: opacity 120ms var(--ease-out);
    }
    .mc:active { opacity: .82; }
    .mc:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; border-radius: var(--r-tile); }

    .mc-ring { flex: 0 0 auto; display: grid; place-items: center; width: 58px; height: 58px; }
    .mc-ring-num {
      font-family: var(--font-display); font-variant-numeric: tabular-nums;
      font-size: 16px; font-weight: 600; color: var(--ink); line-height: 1;
    }
    .mc-slot-ic {
      display: grid; place-items: center; width: 50px; height: 50px; border-radius: 16px;
      background: color-mix(in srgb, var(--accent-a) 12%, var(--bg-sink));
      color: var(--accent-a);
    }
    .mc-slot-ic mat-icon { font-size: 24px; width: 24px; height: 24px; }

    .mc-body { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
    .mc-slot {
      display: inline-flex; align-items: center; gap: 5px;
      font-family: var(--font-ui); font-size: 11px; font-weight: 800; letter-spacing: .05em;
      text-transform: uppercase; color: var(--ink-dim);
    }
    .mc-slot-glyph { font-size: 15px; width: 15px; height: 15px; color: var(--accent-a); }
    .mc-tag {
      margin-left: 2px; padding: 1px 7px; border-radius: var(--r-pill);
      background: var(--bg-sink); color: var(--ink-faint);
      font-size: 10px; font-weight: 800; letter-spacing: .03em; text-transform: none;
    }
    .mc-tag.is-set { color: var(--accent-a); background: color-mix(in srgb, var(--accent-a) 12%, var(--bg-sink)); }

    .mc-title {
      font-family: var(--font-ui); font-size: 15.5px; font-weight: 700; letter-spacing: -.01em; color: var(--ink);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .mc-sub { font-size: 12.5px; font-weight: 600; color: var(--ink-faint); }

    .mc-macros { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 2px; }
    .mc-chip {
      padding: 2px 8px; border-radius: var(--r-pill);
      background: var(--bg-sink); border: 1px solid var(--hairline);
      font-family: var(--font-ui); font-size: 11px; font-weight: 700; color: var(--ink-dim);
      font-variant-numeric: tabular-nums;
    }
    .mc-chip--p { color: var(--ink); border-color: color-mix(in srgb, var(--accent-a) 30%, transparent); }
    .mc-chip--sv { color: var(--ink-faint); }

    .mc-gro {
      flex: 0 0 auto; display: grid; place-items: center; width: 40px; height: 40px;
      border-radius: 12px; border: 1px solid var(--hairline); background: var(--bg-sink);
      color: var(--accent-a); cursor: pointer; -webkit-tap-highlight-color: transparent;
      transition: transform 120ms var(--ease-spring), background 160ms var(--ease-out);
    }
    .mc-gro:active { transform: scale(.9); }
    .mc-gro:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
    .mc-gro mat-icon { font-size: 20px; width: 20px; height: 20px; }
  `],
})
export class ForageMealCard {
  /** The planned meal. */
  readonly meal = input.required<FamilyMeal>();
  /** The caller's daily calorie goal, when known (drives the ring fraction). Null = ring shows a soft default. */
  readonly calorieGoal = input<number | null>(null);
  /** Open the meal action sheet (tap the body). */
  readonly open = output<void>();
  /** Add just this meal's ingredients to the grocery list. */
  readonly grocery = output<void>();

  protected readonly slot = computed(() => slotMeta(this.meal().slot));
  protected readonly hasMacros = computed(() => this.meal().macroSource !== 'none');
  protected readonly canGrocery = computed(() => hasIngredients(this.meal()));
  protected readonly tag = computed(() => macroTag(this.meal()));

  protected readonly perCal = computed(() => Math.round(this.meal().perServing.calories));

  /**
   * The ring fraction: this meal's per-serving calories as a share of the daily goal (so a single meal
   * reads as a meaningful slice of the day). Without a goal we show a gentle ~⅓ fill so the ring still
   * renders the accent gradient rather than an empty track.
   */
  protected readonly calFrac = computed(() => {
    const goal = this.calorieGoal();
    if (!goal || goal <= 0) return 0.34;
    return Math.max(0, Math.min(1, this.perCal() / goal));
  });

  protected readonly ringLabel = computed(() => {
    const goal = this.calorieGoal();
    return goal
      ? `${this.perCal()} kcal per serving, ${Math.round((this.perCal() / goal) * 100)}% of daily goal`
      : `${this.perCal()} kcal per serving`;
  });

  protected ingredientCount(): string {
    const lines = this.meal().ingredients.split('\n').map(s => s.trim()).filter(Boolean).length;
    if (lines === 0) return 'No ingredients yet';
    return `${lines} ingredient${lines === 1 ? '' : 's'}`;
  }

  protected onGrocery(e: Event): void {
    e.stopPropagation();
    e.preventDefault();
    if (this.canGrocery()) this.grocery.emit();
  }
}
