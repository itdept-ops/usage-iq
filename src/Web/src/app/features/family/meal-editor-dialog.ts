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
import { FamilyMeal, FamilyMealSlot, RecipeAiResult } from '../../core/models';
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
}

/** The result the editor returns: the meal fields, ready for the API (ingredients is raw newline text). */
export interface MealEditorResult {
  slot: FamilyMealSlot;
  title: string;
  ingredients: string;
}

/** The meal-of-day choices for the slot select (dinner first — the primary slot at the table). */
const SLOTS: { value: FamilyMealSlot; label: string; icon: string }[] = [
  { value: 'dinner', label: 'Dinner', icon: 'dinner_dining' },
  { value: 'breakfast', label: 'Breakfast', icon: 'free_breakfast' },
  { value: 'lunch', label: 'Lunch', icon: 'lunch_dining' },
  { value: 'snack', label: 'Snack', icon: 'bakery_dining' },
];

/**
 * Create / edit a planned meal for a single day. The dish gets a title + an optional ingredients textarea
 * (one ingredient per line) — those lines feed the "add to grocery list" tie-in. The day is fixed by the
 * caller; only the slot, title, and ingredients are editable here. Warm + mobile-friendly.
 *
 * ✨ From a recipe: a collapsible box takes pasted recipe TEXT and asks Gemini to pull out the dish title +
 * ingredient lines, which PREFILL the title/ingredients fields for the user to confirm/edit before Save —
 * nothing is saved by the assist itself. A one-time privacy notice (the pasted text goes to Google) gates
 * the first use, mirroring the tracker photo notice. Degrades gracefully (aria-live) when AI is unavailable;
 * the manual fields always work. For a recipe URL we instruct the user to paste the text — the app never
 * fetches URLs.
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
  readonly title = signal(this.data.meal?.title ?? '');
  readonly ingredients = signal(this.data.meal?.ingredients ?? '');

  readonly canSave = computed(() => this.title().trim().length > 0);

  /** A live count of the non-blank ingredient lines (so the cook sees what'll head to the grocery list). */
  readonly ingredientCount = computed(() =>
    this.ingredients().split('\n').map(s => s.trim()).filter(Boolean).length);

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
    this.ref.close({
      slot: this.slot(),
      title: this.title().trim(),
      ingredients: this.ingredients().trim(),
    });
  }

  private messageOf(e: unknown, fallback: string): string {
    const msg = (e as { error?: { message?: string } })?.error?.message;
    return typeof msg === 'string' && msg ? msg : fallback;
  }
}
