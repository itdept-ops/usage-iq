import {
  ChangeDetectionStrategy, Component, computed, effect, inject, model, signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';

import { Api } from '../../../core/api';
import { AuthService } from '../../../core/auth';
import {
  FoodEntryDto, Meal, PERM, UpdateFoodRequest,
} from '../../../core/models';
import { OptimisticTracker } from '../state/optimistic-tracker';
import { BottomSheet } from '../ui/bottom-sheet';
import { group } from '../util/units';

/*
 * sheets/food-edit-sheet.ts — the Tracker Beta ("Strata") EDIT-A-LOGGED-FOOD sheet, the mobile twin of the
 * desktop inline food editor (features/tracker/tracker.ts startEditFood/saveEditFood). Tapping a logged
 * meal row in the FUEL card opens this sheet seeded with that entry; the user can change the same things
 * desktop allows and delete the entry — all committed through OptimisticTracker against the SAME backend
 * API/DTO the desktop edit uses (Api.updateFood → PUT /tracker/food/{id}, UpdateFoodRequest; delete via
 * Api.deleteFood). The hero ring + meal subtotals tick instantly via the wrapper's recompute.
 *
 * Priced-vs-manual parity with desktop (keyed by the STORED row's fdcId, server-authoritative):
 *   • PRICED row (fdcId != null): only QUANTITY (+ meal slot) is editable. Macros are recomputed by the
 *     server from the stored per-unit basis; we show a live rescaled preview and send only { quantity, meal }.
 *   • MANUAL row (fdcId == null): description + calories/protein/carb/fat + quantity (+ meal) are editable;
 *     editing quantity rescales the macro fields live from the per-serving baseline (mirrors onEditQuantity).
 *
 * Self-styled with the page-host Strata tokens (var(--*) only — no global --tech-*), mobile-first with
 * >=44px targets, aria labels, and reduced-motion-friendly chrome (sheet rise governed by the bottom-sheet
 * primitive + the page killswitch). Read-only (shared) views never reach here (the card hides the affordance).
 *
 * Contract (the page binds these VERBATIM):
 *   <app-food-edit-sheet [(open)]="foodEditOpen" [entry]="editingFood()" />
 * `entry` is the FoodEntryDto to edit (or null when closed); `open` is a two-way model. Self-dismisses after
 * a successful save or delete.
 */

const MEALS: { value: Meal; label: string }[] = [
  { value: 'breakfast', label: 'Breakfast' },
  { value: 'lunch', label: 'Lunch' },
  { value: 'dinner', label: 'Dinner' },
  { value: 'snack', label: 'Snack' },
];

/** Round to one decimal (macro grams) — matches the server + the desktop editor. */
const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Coerce a possibly-null / NaN / non-finite numeric input to a finite number (0 when unusable). */
function safeNum(n: number | null | undefined): number {
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

@Component({
  selector: 'app-food-edit-sheet',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, BottomSheet],
  template: `
    <app-bottom-sheet [(open)]="open" detent="full" label="Edit food" (closed)="onClosed()">
      <div class="fe-head">
        <h2 class="fe-title">Edit food</h2>
        <span class="fe-sub">{{ tracker.date() }}</span>
      </div>

      <div class="fe-form">
        <!-- Name: read-only label for a priced row; editable for a manual row -->
        @if (isPriced()) {
          <div class="fe-named" aria-label="Food">
            <span class="fe-named-name">{{ desc() }}</span>
            @if (brand()) { <span class="fe-named-brand">{{ brand() }}</span> }
            <span class="fe-named-tag">Quantity-priced — macros scale with quantity</span>
          </div>
        } @else {
          <div>
            <label class="fe-label" for="fe-desc">Food</label>
            <input id="fe-desc" class="fe-input" type="text" maxlength="256" autocomplete="off"
                   enterkeyhint="done" placeholder="What did you eat?"
                   [ngModel]="desc()" (ngModelChange)="desc.set($event)" />
          </div>
        }

        <!-- Meal slot -->
        <div>
          <span class="fe-label" id="fe-meal-lbl">Meal</span>
          <div class="fe-chips" role="group" aria-labelledby="fe-meal-lbl">
            @for (m of MEALS; track m.value) {
              <button type="button" class="fe-chip"
                      [class.on]="meal() === m.value"
                      [attr.aria-pressed]="meal() === m.value"
                      (click)="meal.set(m.value)">{{ m.label }}</button>
            }
          </div>
        </div>

        <!-- Quantity stepper (both row kinds; priced rescales server-side, manual rescales live) -->
        <div>
          <span class="fe-label" id="fe-qty-lbl">Servings</span>
          <div class="fe-stepper" role="group" aria-labelledby="fe-qty-lbl">
            <button type="button" class="fe-step-btn" (click)="bumpQty(-1)"
                    [disabled]="quantity() <= 0.25" aria-label="Fewer servings">−</button>
            <input class="fe-step-val" type="number" min="0.25" max="9999" step="0.25"
                   inputmode="decimal" aria-labelledby="fe-qty-lbl"
                   [ngModel]="quantity()" (ngModelChange)="onQuantity($event)" />
            <button type="button" class="fe-step-btn" (click)="bumpQty(1)"
                    [disabled]="quantity() >= 9999" aria-label="More servings">+</button>
          </div>
        </div>

        <!-- Macros: live preview for a priced row; editable totals for a manual row -->
        @if (isPriced()) {
          <div class="fe-preview">
            <div class="fe-preview-cal">
              <span class="fe-preview-num">{{ group(preview().calories) }}</span>
              <span class="fe-preview-unit">kcal</span>
            </div>
            <span class="fe-preview-macros">
              P {{ group(preview().proteinG) }} · C {{ group(preview().carbG) }} · F {{ group(preview().fatG) }}
            </span>
          </div>
        } @else {
          @if (showAi()) {
            <button type="button" class="fe-ai" (click)="reEstimate()"
                    [disabled]="aiBusy() || !desc().trim() || tracker.readOnly()"
                    aria-label="Re-estimate this food's macros with AI">
              @if (aiBusy()) { <span class="fe-spin fe-spin--ai" aria-hidden="true"></span> Estimating… }
              @else { ✨ Re-estimate macros }
            </button>
          }
          <div class="fe-macros" role="group" aria-label="Macros">
            <div class="fe-macro">
              <label class="fe-label" for="fe-cal">Calories</label>
              <input id="fe-cal" class="fe-input" type="number" min="0" max="100000" step="1"
                     inputmode="numeric" placeholder="0"
                     [ngModel]="calories()" (ngModelChange)="onMacro('calories', $event)" />
            </div>
            <div class="fe-macro">
              <label class="fe-label" for="fe-pro">Protein (g)</label>
              <input id="fe-pro" class="fe-input" type="number" min="0" max="5000" step="1"
                     inputmode="decimal" placeholder="0"
                     [ngModel]="protein()" (ngModelChange)="onMacro('proteinG', $event)" />
            </div>
            <div class="fe-macro">
              <label class="fe-label" for="fe-carb">Carbs (g)</label>
              <input id="fe-carb" class="fe-input" type="number" min="0" max="5000" step="1"
                     inputmode="decimal" placeholder="0"
                     [ngModel]="carb()" (ngModelChange)="onMacro('carbG', $event)" />
            </div>
            <div class="fe-macro">
              <label class="fe-label" for="fe-fat">Fat (g)</label>
              <input id="fe-fat" class="fe-input" type="number" min="0" max="5000" step="1"
                     inputmode="decimal" placeholder="0"
                     [ngModel]="fat()" (ngModelChange)="onMacro('fatG', $event)" />
            </div>
          </div>
        }

        <div class="fe-actions">
          <button type="button" class="fe-delete" (click)="remove()"
                  [disabled]="busy() || tracker.readOnly()" aria-label="Delete this food">
            Delete
          </button>
          <button type="button" class="fe-cta" (click)="save()"
                  [disabled]="busy() || !canSave() || tracker.readOnly()">
            @if (busy()) { <span class="fe-spin" aria-hidden="true"></span> } @else { Save }
          </button>
        </div>
        <span class="fe-sr" role="status" aria-live="polite">{{ announce() }}</span>
      </div>
    </app-bottom-sheet>
  `,
  styles: [`
    :host { display: contents; }

    .fe-head { display: flex; align-items: baseline; gap: 8px; padding: 4px 2px 12px; }
    .fe-title {
      margin: 0; font-family: var(--font-ui); font-weight: 700; font-size: 19px;
      color: var(--ink); letter-spacing: -.01em;
    }
    .fe-sub { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--ink-dim); }

    .fe-form { display: flex; flex-direction: column; gap: 14px; padding-bottom: 8px;
      --accent-edge: var(--tech-accent, var(--cal-a)); }

    .fe-label {
      display: block; margin: 0 0 6px 2px;
      font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--ink-dim);
    }

    /* Priced-row name block (read-only). */
    .fe-named {
      display: flex; flex-direction: column; gap: 3px;
      padding: 12px 14px; border-radius: var(--r-tile);
      background: var(--bg-sink); border: 1px solid var(--hairline); box-shadow: var(--press);
    }
    .fe-named-name { font-family: var(--font-ui); font-size: 16px; font-weight: 600; color: var(--ink); }
    .fe-named-brand { font-size: 12px; color: var(--ink-faint); }
    .fe-named-tag { font-size: 11px; color: var(--ink-dim); margin-top: 2px; }

    .fe-input {
      width: 100%; box-sizing: border-box; min-height: 48px;
      padding: 0 14px; font-family: var(--font-ui); font-size: 16px; color: var(--ink);
      background: var(--bg-sink); border: 1px solid var(--hairline); border-radius: var(--r-tile);
      box-shadow: var(--press);
      -webkit-appearance: none; appearance: none;
      transition: border-color 160ms var(--ease-out);
    }
    .fe-input::placeholder { color: var(--ink-faint); }
    .fe-input:focus-visible {
      outline: 2px solid var(--focus); outline-offset: 2px; border-color: var(--focus);
    }

    /* Meal chips. */
    .fe-chips { display: flex; flex-wrap: wrap; gap: 8px; }
    .fe-chip {
      min-height: 44px; padding: 0 14px;
      display: inline-flex; align-items: center;
      font-family: var(--font-ui); font-size: 13px; font-weight: 600; color: var(--ink-dim);
      background: var(--bg-sink); border: 1px solid var(--hairline); border-radius: var(--r-pill);
      touch-action: manipulation; -webkit-tap-highlight-color: transparent; cursor: pointer;
      transition: transform 120ms var(--ease-out), color 160ms var(--ease-out), border-color 160ms var(--ease-out);
    }
    .fe-chip:active { transform: translateY(1px) scale(.97); box-shadow: var(--press); }
    .fe-chip:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
    .fe-chip.on {
      color: var(--ink);
      background: color-mix(in srgb, var(--tech-accent, var(--cal-a)) 18%, var(--bg-sink));
      border-color: color-mix(in srgb, var(--tech-accent, var(--cal-a)) 50%, transparent);
    }

    /* Quantity stepper: [−] value [+]. */
    .fe-stepper { display: grid; grid-template-columns: 56px 1fr 56px; align-items: stretch; gap: 8px; }
    .fe-step-btn {
      display: flex; align-items: center; justify-content: center;
      min-height: 48px; min-width: 44px;
      font-size: 24px; line-height: 1; color: var(--ink);
      background: var(--bg-rise); border: 1px solid var(--hairline); border-radius: var(--r-tile);
      box-shadow: var(--lift-1);
      touch-action: manipulation; -webkit-tap-highlight-color: transparent; cursor: pointer;
      transition: transform 120ms var(--ease-out), box-shadow 120ms var(--ease-out);
    }
    .fe-step-btn:active:not(:disabled) { transform: translateY(1px) scale(.97); box-shadow: var(--press); }
    .fe-step-btn:disabled { opacity: .4; cursor: default; }
    .fe-step-btn:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
    .fe-step-val {
      width: 100%; box-sizing: border-box; min-height: 48px; text-align: center;
      font-family: var(--font-display); font-weight: 600; font-size: 22px;
      font-variant-numeric: tabular-nums; color: var(--ink);
      background: var(--bg-sink); border: 1px solid var(--hairline); border-radius: var(--r-tile);
      box-shadow: var(--press); -webkit-appearance: none; appearance: none;
    }
    .fe-step-val:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; border-color: var(--focus); }

    /* Priced live preview. */
    .fe-preview {
      display: flex; align-items: baseline; gap: 12px;
      padding: 12px 14px; border-radius: var(--r-tile);
      background: var(--bg-rise); border: 1px solid var(--glass-edge); box-shadow: var(--lift-1);
    }
    .fe-preview-cal { display: flex; align-items: baseline; gap: 4px; }
    .fe-preview-num {
      font-family: var(--font-display); font-weight: 600; font-size: 26px;
      font-variant-numeric: tabular-nums; color: var(--ink); letter-spacing: -.02em;
    }
    .fe-preview-unit { font-size: 11px; text-transform: uppercase; color: var(--ink-faint); }
    .fe-preview-macros {
      font-family: var(--font-ui); font-size: 13px; color: var(--ink-dim);
      font-variant-numeric: tabular-nums;
    }

    .fe-macros { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }
    .fe-macro .fe-label { margin-bottom: 4px; }

    /* Actions. */
    .fe-actions { display: flex; gap: 10px; padding-top: 4px; }
    .fe-delete {
      flex: 0 0 auto; min-height: 52px; padding: 0 18px;
      font-family: var(--font-ui); font-size: 15px; font-weight: 600;
      color: var(--warn); background: transparent;
      border: 1px solid color-mix(in srgb, var(--warn) 55%, transparent);
      border-radius: var(--r-pill);
      touch-action: manipulation; -webkit-tap-highlight-color: transparent; cursor: pointer;
      transition: transform 120ms var(--ease-out), background 160ms var(--ease-out);
    }
    .fe-delete:active:not(:disabled) { transform: translateY(1px) scale(.99); }
    .fe-delete:disabled { opacity: .45; cursor: default; }
    .fe-delete:focus-visible { outline: 2px solid var(--focus); outline-offset: 3px; }
    .fe-cta {
      flex: 1 1 auto; min-height: 52px;
      display: flex; align-items: center; justify-content: center;
      font-family: var(--font-ui); font-size: 16px; font-weight: 700; letter-spacing: -.01em;
      color: #fff; background: linear-gradient(135deg, var(--tech-accent, var(--cal-a)), var(--tech-accent-2, var(--cal-b)));
      border: 0; border-radius: var(--r-pill); box-shadow: var(--lift-2);
      touch-action: manipulation; -webkit-tap-highlight-color: transparent; cursor: pointer;
      transition: transform 120ms var(--ease-out), box-shadow 120ms var(--ease-out), opacity 160ms var(--ease-out);
    }
    .fe-cta:active:not(:disabled) { transform: translateY(1px) scale(.99); box-shadow: var(--press); }
    .fe-cta:disabled { opacity: .45; cursor: default; }
    .fe-cta:focus-visible { outline: 2px solid var(--focus); outline-offset: 3px; }

    /* AI re-estimate affordance (manual rows). */
    .fe-ai {
      align-self: flex-start; min-height: 44px; padding: 0 14px;
      display: inline-flex; align-items: center; gap: 6px;
      font-family: var(--font-ui); font-size: 13px; font-weight: 600; color: var(--ink);
      background: transparent; border: 1px solid var(--glass-edge); border-radius: var(--r-pill);
      touch-action: manipulation; -webkit-tap-highlight-color: transparent; cursor: pointer;
      transition: transform 120ms var(--ease-out);
    }
    .fe-ai:active:not(:disabled) { transform: translateY(1px) scale(.98); }
    .fe-ai:disabled { opacity: .5; cursor: default; }
    .fe-ai:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }

    .fe-spin {
      width: 16px; height: 16px; border-radius: 50%;
      border: 2px solid rgba(255,255,255,.4); border-top-color: #fff;
      animation: fe-spin 700ms linear infinite;
    }
    /* On the transparent AI button the spinner needs ink-toned strokes, not white. */
    .fe-spin--ai { border-color: var(--hairline); border-top-color: var(--ink); }
    @keyframes fe-spin { to { transform: rotate(360deg); } }

    .fe-sr {
      position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; border: 0;
      overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap;
    }

    @media (prefers-reduced-motion: reduce) {
      .fe-step-btn, .fe-chip, .fe-cta, .fe-delete { transition: none; }
      .fe-spin { animation: none; }
    }
  `],
})
export class FoodEditSheet {
  protected readonly tracker = inject(OptimisticTracker);
  private readonly api = inject(Api);
  private readonly auth = inject(AuthService);

  /** AI re-estimate is gated exactly like desktop: trackerAi permission (and hidden in read-only views). */
  protected readonly showAi = signal(this.auth.hasPermission(PERM.trackerAi));
  /** True while an AI macro re-estimate is in flight (latches the button). */
  protected readonly aiBusy = signal(false);

  readonly open = model<boolean>(false);
  /** The logged food entry to edit (null when the sheet is closed / nothing selected). */
  readonly entry = model<FoodEntryDto | null>(null);

  protected readonly MEALS = MEALS;
  protected readonly group = group;

  // ── form fields (seeded from the entry on open) ──
  protected readonly isPriced = signal(false);
  protected readonly desc = signal('');
  protected readonly brand = signal<string | undefined>(undefined);
  protected readonly meal = signal<Meal>('breakfast');
  protected readonly quantity = signal<number>(1);
  protected readonly calories = signal<number | null>(null);
  protected readonly protein = signal<number | null>(null);
  protected readonly carb = signal<number | null>(null);
  protected readonly fat = signal<number | null>(null);

  protected readonly busy = signal(false);
  protected readonly announce = signal('');

  /** The stored row's original quantity + totals — the priced preview + manual rescale baseline. */
  private origQuantity = 1;
  private origTotals = { calories: 0, proteinG: 0, carbG: 0, fatG: 0 };
  /** Macros per ONE serving (the baseline a MANUAL row's quantity rescales against; refreshed on macro edits). */
  private perUnit = { calories: 0, proteinG: 0, carbG: 0, fatG: 0 };

  constructor() {
    // Seed the form each time the sheet opens with a fresh entry.
    effect(() => {
      if (this.open()) {
        const f = this.entry();
        if (f) this.seed(f);
      }
    });
  }

  /** Populate the form from the entry being edited (mirrors desktop startEditFood). */
  private seed(f: FoodEntryDto): void {
    this.isPriced.set(f.fdcId != null);
    this.desc.set(f.description);
    this.brand.set(f.brand);
    this.meal.set(f.meal);
    const q = f.quantity > 0 ? f.quantity : 1;
    this.origQuantity = q;
    this.origTotals = { calories: f.calories, proteinG: f.proteinG, carbG: f.carbG, fatG: f.fatG };
    this.perUnit = {
      calories: f.calories / q, proteinG: f.proteinG / q, carbG: f.carbG / q, fatG: f.fatG / q,
    };
    this.quantity.set(q);
    this.calories.set(f.calories);
    this.protein.set(f.proteinG);
    this.carb.set(f.carbG);
    this.fat.set(f.fatG);
    this.announce.set('');
  }

  /**
   * Live macro preview for a PRICED row: rescale the stored totals by newQty/oldQty, mirroring the server
   * recompute (and the desktop editPreview). Rounded like the server (calories int, macros 1dp, floored 0).
   */
  protected readonly preview = computed(() => {
    const q = this.quantity();
    if (!(q > 0) || !Number.isFinite(q) || this.origQuantity <= 0) {
      return this.origTotals;
    }
    const factor = q / this.origQuantity;
    const r = (n: number) => Math.max(0, Math.round(n * factor * 10) / 10);
    return {
      calories: Math.max(0, Math.round(this.origTotals.calories * factor)),
      proteinG: r(this.origTotals.proteinG),
      carbG: r(this.origTotals.carbG),
      fatG: r(this.origTotals.fatG),
    };
  });

  /** Save needs a positive quantity (both kinds); a MANUAL row also needs a description + a non-negative calorie figure. */
  protected readonly canSave = computed(() => {
    const q = this.quantity();
    if (!(Number.isFinite(q) && q > 0 && q <= 9999)) return false;
    if (this.isPriced()) return true;
    const cal = this.calories();
    return this.desc().trim().length > 0 && cal != null && Number.isFinite(cal) && cal >= 0;
  });

  protected bumpQty(delta: number): void {
    this.onQuantity(Math.min(9999, Math.max(0.25, this.quantity() + delta)));
  }

  /**
   * Quantity changed: clamp it, then — for a MANUAL row — rescale the macro fields live from the per-serving
   * baseline (a priced row scales via the preview, which reads quantity()). Mirrors desktop onEditQuantity.
   */
  protected onQuantity(v: number | null): void {
    const q = Math.min(9999, Math.max(0, safeNum(v)));
    this.quantity.set(q);
    if (this.isPriced()) return;
    this.calories.set(Math.max(0, Math.round(this.perUnit.calories * q)));
    this.protein.set(round1(Math.max(0, this.perUnit.proteinG * q)));
    this.carb.set(round1(Math.max(0, this.perUnit.carbG * q)));
    this.fat.set(round1(Math.max(0, this.perUnit.fatG * q)));
  }

  /**
   * A macro field changed on a MANUAL row. Store the typed total AND refresh that macro's per-serving rate,
   * so a later quantity change still scales from the value you typed (mirrors desktop onEditMacro).
   */
  protected onMacro(field: 'calories' | 'proteinG' | 'carbG' | 'fatG', v: number | null): void {
    const val = Math.max(0, safeNum(v));
    const clean = field === 'calories' ? Math.round(val) : val;
    if (field === 'calories') this.calories.set(clean);
    else if (field === 'proteinG') this.protein.set(clean);
    else if (field === 'carbG') this.carb.set(clean);
    else this.fat.set(clean);
    const q = this.quantity() > 0 ? this.quantity() : 1;
    this.perUnit = { ...this.perUnit, [field]: clean / q };
  }

  /**
   * Re-estimate a MANUAL row's macros from its (possibly edited) description via AI — the mobile twin of the
   * desktop repullMacros. Uses the existing Api.parseMeal (always-200 floor); takes the first parsed item,
   * replaces the quantity + macro fields with the fresh estimate, and resets the per-serving baseline so a
   * later quantity change rescales from the new figures. Leaves the description as the user typed it.
   * Gated on trackerAi (hidden otherwise) + own tracker. Priced rows never reach here (button hidden).
   */
  protected async reEstimate(): Promise<void> {
    if (!this.showAi() || this.aiBusy() || this.isPriced() || this.tracker.readOnly()) return;
    const text = this.desc().trim();
    if (text.length === 0) {
      this.announce.set('Type what the food is first, then re-estimate.');
      return;
    }
    this.aiBusy.set(true);
    this.announce.set('Re-estimating macros with AI…');
    try {
      const res = await firstValueFrom(this.api.parseMeal({ text }));
      const item = res.items?.[0];
      if (!item) {
        this.announce.set('AI couldn’t estimate that — enter it manually.');
        return;
      }
      const qty = item.quantity > 0 ? item.quantity : 1;
      const total = {
        calories: Math.max(0, Math.round(safeNum(item.calories))),
        proteinG: round1(Math.max(0, safeNum(item.proteinG))),
        carbG: round1(Math.max(0, safeNum(item.carbG))),
        fatG: round1(Math.max(0, safeNum(item.fatG))),
      };
      this.quantity.set(qty);
      this.calories.set(total.calories);
      this.protein.set(total.proteinG);
      this.carb.set(total.carbG);
      this.fat.set(total.fatG);
      this.perUnit = {
        calories: total.calories / qty, proteinG: total.proteinG / qty,
        carbG: total.carbG / qty, fatG: total.fatG / qty,
      };
      this.announce.set(`AI estimated ${total.calories} calories for ${text}.`);
    } catch {
      this.announce.set('AI estimate unavailable — enter it manually.');
    } finally {
      this.aiBusy.set(false);
    }
  }

  /**
   * Persist the edit through OptimisticTracker (instant ring tick + reconcile/rollback). Priced rows send
   * only { quantity, meal }; manual rows send the raw description + macro totals + quantity. The optimistic
   * local shape mirrors the desktop editor: priced => the live preview; manual => the typed totals.
   */
  protected async save(): Promise<void> {
    const f = this.entry();
    if (!f || this.busy() || !this.canSave() || this.tracker.readOnly()) return;
    const priced = this.isPriced();
    const meal = this.meal();

    const body: UpdateFoodRequest = priced
      ? { quantity: this.quantity(), meal }
      : {
          meal,
          description: this.desc().trim(),
          quantity: this.quantity(),
          calories: Math.max(0, Math.round(safeNum(this.calories()))),
          proteinG: Math.max(0, safeNum(this.protein())),
          carbG: Math.max(0, safeNum(this.carb())),
          fatG: Math.max(0, safeNum(this.fat())),
        };

    const optimistic: Partial<FoodEntryDto> = priced
      ? { meal, quantity: this.quantity(), ...this.preview() }
      : {
          meal,
          quantity: this.quantity(),
          description: body.description!,
          calories: body.calories!,
          proteinG: body.proteinG!,
          carbG: body.carbG!,
          fatG: body.fatG!,
        };

    this.busy.set(true);
    this.announce.set('Saving…');
    try {
      await this.tracker.updateFood(f.id, body, optimistic);
      this.announce.set(`Updated ${optimistic.description ?? f.description}.`);
      this.open.set(false);
    } finally {
      this.busy.set(false);
    }
  }

  /** Delete the entry (optimistic + undo handled by the wrapper), then dismiss. */
  protected async remove(): Promise<void> {
    const f = this.entry();
    if (!f || this.busy() || this.tracker.readOnly()) return;
    this.busy.set(true);
    try {
      await this.tracker.deleteFood(f.id);
      this.announce.set(`Deleted ${f.description}.`);
      this.open.set(false);
    } finally {
      this.busy.set(false);
    }
  }

  protected onClosed(): void {
    this.entry.set(null);
    this.busy.set(false);
    this.aiBusy.set(false);
    this.announce.set('');
  }
}
