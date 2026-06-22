import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';

import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';

import { Api } from '../../core/api';
import {
  FamilyMeal, FamilyMealMacroProposal, FamilyMealMacroSource, FamilyMealSlot, RecipeAiResult,
} from '../../core/models';
import { confirmRecipeNotice } from './ai-recipe-notice';

/** Data passed into the meal editor: the meal being edited (null = create), the target day, and a day label. */
export interface MealEditorData {
  meal: FamilyMeal | null;
  /** The local ISO date ("YYYY-MM-DD") the meal sits on (fixed for the day's add/edit). */
  localDate: string;
  /** A friendly label for the day being planned (e.g. "Monday, Jun 23"). */
  dayLabel: string;
  /** The slot to pre-select when creating (defaults to dinner — the primary slot). */
  defaultSlot?: FamilyMealSlot;
  /** Optional prefill for a NEW meal (e.g. from "✨ What can I make?"): a dish title to seed the field. */
  prefillTitle?: string;
  /** Optional prefill for a NEW meal: newline-separated ingredient lines to seed the field. */
  prefillIngredients?: string;
}

/**
 * The result the editor returns: the meal fields, ready for the API (ingredients is raw newline text). The
 * macro block (Slice 2) carries the dish TOTALS + servings + source: on an edit it's PATCHed onto the meal;
 * on a create the macros ride along on the POST so a manually-entered estimate is kept.
 */
export interface MealEditorResult {
  slot: FamilyMealSlot;
  title: string;
  ingredients: string;
  servings: number;
  calories: number;
  proteinG: number;
  carbG: number;
  fatG: number;
  macroSource: FamilyMealMacroSource;
}

/** The meal-of-day choices for the slot select (dinner first — the primary slot at the table). */
const SLOTS: { value: FamilyMealSlot; label: string; icon: string }[] = [
  { value: 'dinner', label: 'Dinner', icon: 'dinner_dining' },
  { value: 'breakfast', label: 'Breakfast', icon: 'free_breakfast' },
  { value: 'lunch', label: 'Lunch', icon: 'lunch_dining' },
  { value: 'snack', label: 'Snack', icon: 'bakery_dining' },
];

/** Round a number to at most 1 dp for display, dropping a trailing ".0". */
function round1(n: number): number {
  return Math.round((Number.isFinite(n) ? n : 0) * 10) / 10;
}

/**
 * Create / edit a planned meal for a single day. The dish gets a title + an optional ingredients textarea
 * (one ingredient per line) — those lines feed the "add to grocery list" tie-in. The day is fixed by the
 * caller; only the slot, title, ingredients, and the macros are editable here. Warm + mobile-friendly.
 *
 * ✨ From a recipe: a collapsible box takes pasted recipe TEXT and asks Gemini to pull out the dish title +
 * ingredient lines, which PREFILL the title/ingredients fields for the user to confirm/edit before Save.
 *
 * Macros (Slice 2): a Servings input + the four dish-TOTAL inputs (calories/protein/carb/fat) for manual
 * entry, with the DERIVED per-serving block shown live beneath. Two ✨ assists (only on an existing meal,
 * which has an id the endpoints key on): "Estimate with AI" (POST /meals/{id}/ai/macros) and "Refine with
 * food database" (POST /meals/{id}/macros/refine). Each PREVIEWS its proposal (graceful, confirm-before-apply,
 * aria-live) — "Use these" fills the fields + sets the source; nothing persists until the user hits Save.
 */
@Component({
  selector: 'app-meal-editor-dialog',
  imports: [
    FormsModule, MatDialogModule, MatButtonModule, MatIconModule,
    MatFormFieldModule, MatInputModule, MatSelectModule, MatProgressSpinnerModule,
  ],
  templateUrl: './meal-editor-dialog.html',
  styleUrl: './family.scss',
})
export class MealEditorDialog {
  private api = inject(Api);
  readonly ref = inject(MatDialogRef<MealEditorDialog, MealEditorResult>);
  readonly data = inject<MealEditorData>(MAT_DIALOG_DATA);

  readonly slots = SLOTS;
  readonly isEdit = !!this.data.meal;

  readonly slot = signal<FamilyMealSlot>(this.data.meal?.slot ?? this.data.defaultSlot ?? 'dinner');
  // For a new meal, an optional prefill (e.g. from "✨ What can I make?") seeds the editable fields.
  readonly title = signal(this.data.meal?.title ?? this.data.prefillTitle ?? '');
  readonly ingredients = signal(this.data.meal?.ingredients ?? this.data.prefillIngredients ?? '');

  readonly canSave = computed(() => this.title().trim().length > 0);

  /** A live count of the non-blank ingredient lines (so the cook sees what'll head to the grocery list). */
  readonly ingredientCount = computed(() =>
    this.ingredients().split('\n').map(s => s.trim()).filter(Boolean).length);

  // ---- Macros (dish TOTALS + servings; per-serving is derived) ----
  /** Servings as a string for the input (blank-tolerant); coerced on read. */
  readonly servings = signal(String(this.data.meal?.servings ?? 1));
  readonly calories = signal(this.data.meal && this.data.meal.macroSource !== 'none' ? String(this.data.meal.calories) : '');
  readonly proteinG = signal(this.data.meal && this.data.meal.macroSource !== 'none' ? String(round1(this.data.meal.proteinG)) : '');
  readonly carbG = signal(this.data.meal && this.data.meal.macroSource !== 'none' ? String(round1(this.data.meal.carbG)) : '');
  readonly fatG = signal(this.data.meal && this.data.meal.macroSource !== 'none' ? String(round1(this.data.meal.fatG)) : '');
  /** Where the current macro values came from; flips to "manual" on a hand-edit, or to ai/database on Use. */
  readonly macroSource = signal<FamilyMealMacroSource>(this.data.meal?.macroSource ?? 'none');

  /** Coerced servings (>=1). */
  private readonly servingsNum = computed(() => {
    const n = Math.floor(Number(this.servings()));
    return Number.isFinite(n) && n >= 1 ? n : 1;
  });

  /** True once any macro total has a value (so we show the per-serving line + a "set" state). */
  readonly hasMacros = computed(() =>
    [this.calories(), this.proteinG(), this.carbG(), this.fatG()].some(v => v.trim().length > 0));

  /** The DERIVED per-serving block from the current totals ÷ servings (calories whole, macros 1 dp). */
  readonly perServing = computed(() => {
    const s = this.servingsNum();
    const num = (v: string) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };
    return {
      calories: Math.round(num(this.calories()) / s),
      proteinG: round1(num(this.proteinG()) / s),
      carbG: round1(num(this.carbG()) / s),
      fatG: round1(num(this.fatG()) / s),
    };
  });

  // ---- Macro source pretty label (mirrors the card tag) ----
  readonly macroSourceLabel = computed(() => {
    switch (this.macroSource()) {
      case 'ai': return 'AI estimate';
      case 'database': return 'from food database';
      case 'manual': return 'manual';
      default: return 'not set';
    }
  });

  // ---- ✨ Estimate with AI / Refine with food database (preview → Use) ----
  /** Which assist is running ('' = none), so we can disable the other + show its spinner. */
  readonly macroBusy = signal<'' | 'ai' | 'database'>('');
  /** A friendly aria-live status line for the macro assists (an error, or a "here's what I found" hint). */
  readonly macroStatus = signal('');
  /** The pending proposal awaiting confirm (null = nothing staged). Its `source` tags the Use action. */
  readonly proposal = signal<{ source: 'ai' | 'database'; data: FamilyMealMacroProposal } | null>(null);

  /**
   * Ask Gemini to estimate this meal's dish TOTAL macros + a suggested servings count from its title +
   * ingredients. PREVIEWS the proposal (saves nothing); "Use these" fills the fields. Only on an existing
   * meal (the endpoint keys on its id). Degrades gracefully: a 503 (AI unavailable) or any error shows a
   * friendly aria-live line; the manual fields always work.
   */
  async estimateMacros(): Promise<void> {
    const meal = this.data.meal;
    if (!meal || this.macroBusy()) return;
    this.macroBusy.set('ai');
    this.macroStatus.set('Estimating macros…');
    this.proposal.set(null);
    try {
      const data = await firstValueFrom(this.api.estimateMealMacros(meal.id));
      this.proposal.set({ source: 'ai', data });
      this.macroStatus.set(data.note?.trim()
        || 'Here’s an AI estimate — review it, then tap “Use these” to fill the fields.');
    } catch (e) {
      this.proposal.set(null);
      this.macroStatus.set(this.assistError(e, 'AI'));
    } finally {
      this.macroBusy.set('');
    }
  }

  /**
   * Sum per-ingredient food-database (USDA) lookups into dish TOTALS (keeping the current servings).
   * PREVIEWS the proposal + the matched/unmatched lines; "Use these" fills the fields. Only on an existing
   * meal. Degrades gracefully on a 503 / error.
   */
  async refineMacros(): Promise<void> {
    const meal = this.data.meal;
    if (!meal || this.macroBusy()) return;
    this.macroBusy.set('database');
    this.macroStatus.set('Looking up your ingredients…');
    this.proposal.set(null);
    try {
      const data = await firstValueFrom(this.api.refineMealMacros(meal.id));
      this.proposal.set({ source: 'database', data });
      const matched = data.matched?.length ?? 0;
      this.macroStatus.set(matched > 0
        ? `Matched ${matched} ${matched === 1 ? 'ingredient' : 'ingredients'} in the food database — review the totals, then tap “Use these.”`
        : 'Couldn’t match any ingredients in the food database — try editing the ingredient lines, or enter macros manually.');
    } catch (e) {
      this.proposal.set(null);
      this.macroStatus.set(this.assistError(e, 'The food database'));
    } finally {
      this.macroBusy.set('');
    }
  }

  /** Apply the staged proposal into the macro fields (and tag the source). Nothing persists until Save. */
  useProposal(): void {
    const p = this.proposal();
    if (!p) return;
    this.servings.set(String(Math.max(1, Math.floor(p.data.servings) || 1)));
    this.calories.set(String(Math.round(p.data.calories)));
    this.proteinG.set(String(round1(p.data.proteinG)));
    this.carbG.set(String(round1(p.data.carbG)));
    this.fatG.set(String(round1(p.data.fatG)));
    this.macroSource.set(p.source);
    this.proposal.set(null);
    this.macroStatus.set('Applied — adjust if you like, then Save.');
  }

  /** Dismiss the staged proposal without applying it. */
  dismissProposal(): void {
    this.proposal.set(null);
    this.macroStatus.set('');
  }

  /** A hand-edit of any macro field marks the source as "manual" (and clears any stale proposal preview). */
  onMacroEdited(): void {
    if (this.macroSource() !== 'manual') this.macroSource.set('manual');
    if (this.proposal()) { this.proposal.set(null); this.macroStatus.set(''); }
  }

  /** Clear all macro fields back to "not set" (servings resets to 1). */
  clearMacros(): void {
    this.calories.set(''); this.proteinG.set(''); this.carbG.set(''); this.fatG.set('');
    this.servings.set('1');
    this.macroSource.set('none');
    this.proposal.set(null);
    this.macroStatus.set('');
  }

  // ---- ✨ From a recipe (paste recipe TEXT → prefill title + ingredients) ----
  /** Whether the "From a recipe" box is open. */
  readonly recipeOpen = signal(false);
  /** The pasted recipe text. */
  readonly recipeText = signal('');
  readonly recipeBusy = signal(false);
  /** A friendly status line for aria-live (an error, or a "here's what I found" hint). */
  readonly recipeStatus = signal('');

  toggleRecipe(): void {
    this.recipeOpen.update(o => !o);
    if (!this.recipeOpen()) this.recipeStatus.set('');
  }

  /**
   * Send the pasted recipe text to Gemini and PREFILL the title + ingredients fields with what it parses —
   * the user still confirms/edits + Saves; nothing persists here. Gated by a one-time privacy notice (the
   * text goes to Google) on first use; declining aborts silently. Degrades gracefully: a 503 (AI unavailable
   * / not configured), a 400 (empty text), or any error shows a friendly aria-live line.
   */
  async runRecipe(): Promise<void> {
    const text = this.recipeText().trim();
    if (!text || this.recipeBusy()) return;
    // One-time notice that the pasted recipe text is sent to Google; cancel aborts without sending.
    if (!(await confirmRecipeNotice())) return;

    this.recipeBusy.set(true);
    this.recipeStatus.set('Reading your recipe…');
    try {
      const result: RecipeAiResult = await firstValueFrom(this.api.recipeToMealAi(text));
      // Prefill the editable fields — keep the user's title if the model returned a blank one.
      if (result.title.trim()) this.title.set(result.title.trim());
      if (result.ingredients.trim()) this.ingredients.set(result.ingredients);
      this.recipeOpen.set(false);
      this.recipeStatus.set('');
    } catch (e) {
      const status = (e as { status?: number })?.status;
      this.recipeStatus.set(status === 503
        ? "AI isn't available right now — you can fill in the dish and ingredients yourself below."
        : this.messageOf(e, "I couldn't read that recipe just now. Please try again, or type it in below."));
    } finally {
      this.recipeBusy.set(false);
    }
  }

  save(): void {
    if (!this.canSave()) return;
    const num = (v: string) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };
    this.ref.close({
      slot: this.slot(),
      title: this.title().trim(),
      ingredients: this.ingredients().trim(),
      servings: this.servingsNum(),
      calories: Math.round(num(this.calories())),
      proteinG: round1(num(this.proteinG())),
      carbG: round1(num(this.carbG())),
      fatG: round1(num(this.fatG())),
      macroSource: this.macroSource(),
    });
  }

  /** A friendly message for an assist failure: 503 → "not available", else the server/fallback message. */
  private assistError(e: unknown, who: string): string {
    const status = (e as { status?: number })?.status;
    return status === 503
      ? `${who} isn’t available right now — you can enter macros manually below.`
      : this.messageOf(e, `${who} couldn’t estimate the macros just now. Please try again, or enter them manually.`);
  }

  private messageOf(e: unknown, fallback: string): string {
    const msg = (e as { error?: { message?: string } })?.error?.message;
    return typeof msg === 'string' && msg ? msg : fallback;
  }
}
