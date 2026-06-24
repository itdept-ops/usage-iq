import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';

import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSnackBar } from '@angular/material/snack-bar';

import { Api } from '../../core/api';
import { Recipe, RecipeUpsertRequest } from '../../core/models';

/** Dialog data: an existing recipe to edit, or null to create a fresh one. */
export interface RecipeEditorData {
  recipe: Recipe | null;
}

/** One editable ingredient row (a stable key keeps @for tracking + inputs stable while typing). */
interface IngredientRow {
  key: number;
  name: string;
  quantity: string;
}

/**
 * Create / edit a recipe in "My Recipes". A focused form over POST /api/recipes (create) or
 * PUT /api/recipes/{id} (update): title, servings, per-serving macros, ingredient rows (name + free-text
 * quantity), ordered steps, free-text notes, and the share-with-contacts toggle. Owner-only — the page only
 * opens this for recipes the caller owns (or a brand-new one). Resolves with the saved {@link Recipe} on
 * success, or undefined on cancel.
 */
@Component({
  selector: 'app-recipe-editor-dialog',
  imports: [
    FormsModule, MatDialogModule, MatFormFieldModule, MatInputModule, MatButtonModule,
    MatIconModule, MatSlideToggleModule, MatProgressSpinnerModule, MatTooltipModule,
  ],
  templateUrl: './recipe-editor-dialog.html',
  styleUrl: './recipe-editor-dialog.scss',
})
export class RecipeEditorDialog {
  private ref = inject(MatDialogRef<RecipeEditorDialog, Recipe | undefined>);
  private api = inject(Api);
  private snack = inject(MatSnackBar);
  readonly data = inject<RecipeEditorData>(MAT_DIALOG_DATA);

  readonly isEdit = !!this.data.recipe;

  readonly title = signal(this.data.recipe?.title ?? '');
  readonly servings = signal(Math.max(1, this.data.recipe?.servings ?? 1));
  readonly calories = signal(this.data.recipe?.calories ?? 0);
  readonly proteinG = signal(this.data.recipe?.proteinG ?? 0);
  readonly carbG = signal(this.data.recipe?.carbG ?? 0);
  readonly fatG = signal(this.data.recipe?.fatG ?? 0);
  readonly notes = signal(this.data.recipe?.notes ?? '');
  readonly shareWithContacts = signal(this.data.recipe?.shareWithContacts ?? false);

  private keySeq = 0;
  readonly rows = signal<IngredientRow[]>(
    (this.data.recipe?.ingredients ?? []).map(i => ({ key: this.keySeq++, name: i.name, quantity: i.quantity })),
  );

  /** Steps as a single textarea (one step per line) — simplest editable form; re-split on save. */
  readonly stepsText = signal((this.data.recipe?.steps ?? []).join('\n'));

  readonly saving = signal(false);

  readonly canSave = computed(() => this.title().trim().length > 0 && !this.saving());

  // ---- ingredient rows ----

  addRow(): void {
    this.rows.update(rs => [...rs, { key: this.keySeq++, name: '', quantity: '' }]);
  }

  setRowName(key: number, name: string): void {
    this.rows.update(rs => rs.map(r => (r.key === key ? { ...r, name } : r)));
  }

  setRowQty(key: number, quantity: string): void {
    this.rows.update(rs => rs.map(r => (r.key === key ? { ...r, quantity } : r)));
  }

  removeRow(key: number): void {
    this.rows.update(rs => rs.filter(r => r.key !== key));
  }

  // ---- save ----

  private buildRequest(): RecipeUpsertRequest {
    const ingredients = this.rows()
      .map(r => ({ name: r.name.trim(), quantity: r.quantity.trim() }))
      .filter(i => i.name.length > 0);
    const steps = this.stepsText()
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean);
    return {
      title: this.title().trim(),
      servings: Math.max(1, Math.round(this.servings() || 1)),
      calories: Math.max(0, Math.round(this.calories() || 0)),
      proteinG: Math.max(0, this.proteinG() || 0),
      carbG: Math.max(0, this.carbG() || 0),
      fatG: Math.max(0, this.fatG() || 0),
      ingredients,
      steps,
      notes: this.notes().trim(),
      shareWithContacts: this.shareWithContacts(),
    };
  }

  async save(): Promise<void> {
    if (!this.canSave()) {
      if (!this.title().trim()) this.snack.open('Give the recipe a title first.', 'OK', { duration: 4000 });
      return;
    }
    this.saving.set(true);
    const req = this.buildRequest();
    try {
      const saved = this.data.recipe
        ? await firstValueFrom(this.api.updateRecipe(this.data.recipe.id, req))
        : await firstValueFrom(this.api.createRecipe(req));
      this.ref.close(saved);
    } catch {
      this.snack.open("Couldn't save the recipe — try again", 'Dismiss', { duration: 4000 });
    } finally {
      this.saving.set(false);
    }
  }

  cancel(): void {
    this.ref.close(undefined);
  }
}
