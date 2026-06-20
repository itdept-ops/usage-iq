import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';

import { FamilyMeal, FamilyMealSlot } from '../../core/models';

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
 */
@Component({
  selector: 'app-meal-editor-dialog',
  imports: [
    FormsModule, MatDialogModule, MatButtonModule, MatIconModule,
    MatFormFieldModule, MatInputModule, MatSelectModule,
  ],
  templateUrl: './meal-editor-dialog.html',
})
export class MealEditorDialog {
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

  save(): void {
    if (!this.canSave()) return;
    this.ref.close({
      slot: this.slot(),
      title: this.title().trim(),
      ingredients: this.ingredients().trim(),
    });
  }
}
