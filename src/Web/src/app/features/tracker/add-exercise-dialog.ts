import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';

import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';

import { Api } from '../../core/api';
import { AddExerciseRequest, ExerciseLibraryDto } from '../../core/models';

/** Opens with the active day + whether the profile has a weight (so we can estimate from duration). */
export interface AddExerciseData {
  date: string;
  goal: string;
  /** True when the profile has a weight → duration alone yields a server-side calorie estimate. */
  hasWeight: boolean;
}

/**
 * Add-exercise dialog. Two ways in: pick from the exercise LIBRARY (default = your goal, with a toggle
 * to show all goals) then enter a duration — the server estimates calories from your profile weight, or
 * you can override with a manual figure; OR log a fully MANUAL exercise (free-text name + calories).
 * Resolves with the {@link AddExerciseRequest} for the page to persist via the store.
 */
@Component({
  selector: 'app-add-exercise-dialog',
  imports: [
    FormsModule, MatDialogModule, MatFormFieldModule, MatInputModule, MatButtonModule,
    MatButtonToggleModule, MatCheckboxModule, MatIconModule, MatProgressBarModule,
  ],
  templateUrl: './add-exercise-dialog.html',
  styleUrl: './add-exercise-dialog.scss',
})
export class AddExerciseDialog {
  private api = inject(Api);
  private ref = inject(MatDialogRef<AddExerciseDialog, AddExerciseRequest>);
  readonly data = inject<AddExerciseData>(MAT_DIALOG_DATA);

  readonly mode = signal<'library' | 'manual'>('library');

  // ---- library ----
  readonly loading = signal(false);
  readonly library = signal<ExerciseLibraryDto[]>([]);
  readonly showAll = signal(false);
  readonly query = signal('');
  readonly selected = signal<ExerciseLibraryDto | null>(null);
  readonly durationMin = signal<number | null>(30);
  /** When true, the user overrides the server estimate with a typed calorie figure. */
  readonly overrideCals = signal(false);
  readonly manualCalsForLib = signal<number | null>(null);

  // ---- fully manual ----
  readonly mName = signal('');
  readonly mCalories = signal<number | null>(null);

  readonly saving = signal(false);
  readonly error = signal<string | null>(null);

  /** Whether we can let the server estimate (profile weight + a chosen library item + a duration). */
  readonly canEstimate = computed(() =>
    this.data.hasWeight && !!this.selected() && (this.durationMin() ?? 0) > 0);

  readonly filtered = computed<ExerciseLibraryDto[]>(() => {
    const q = this.query().trim().toLowerCase();
    const list = this.library();
    if (!q) return list;
    return list.filter(e => e.name.toLowerCase().includes(q) || e.category.toLowerCase().includes(q));
  });

  readonly canSave = computed(() => {
    if (this.saving()) return false;
    if (this.mode() === 'manual') return this.mName().trim().length > 0 && (this.mCalories() ?? 0) > 0;
    if (!this.selected()) return false;
    if (this.canEstimate() && !this.overrideCals()) return true; // server estimates
    return (this.effectiveCals() ?? 0) > 0; // need an explicit figure
  });

  /** The calorie figure that will be logged when we're NOT deferring to the server estimate. */
  readonly effectiveCals = computed<number | null>(() =>
    this.overrideCals() || !this.data.hasWeight ? this.manualCalsForLib() : null);

  constructor() {
    void this.loadLibrary();
  }

  async loadLibrary(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const goal = this.showAll() ? undefined : this.data.goal || undefined;
      this.library.set(await firstValueFrom(this.api.exerciseLibrary(goal)));
    } catch {
      this.error.set('Could not load the exercise library.');
      this.library.set([]);
    } finally {
      this.loading.set(false);
    }
  }

  toggleShowAll(on: boolean): void {
    this.showAll.set(on);
    void this.loadLibrary();
  }

  pick(e: ExerciseLibraryDto): void {
    this.selected.set(this.selected()?.id === e.id ? null : e);
  }

  setMode(m: 'library' | 'manual'): void {
    this.mode.set(m);
    this.error.set(null);
  }

  save(): void {
    if (!this.canSave()) return;
    let body: AddExerciseRequest;
    if (this.mode() === 'manual') {
      body = {
        date: this.data.date,
        name: this.mName().trim(),
        caloriesBurned: this.mCalories() ?? 0,
      };
    } else {
      const e = this.selected()!;
      const deferToServer = this.canEstimate() && !this.overrideCals();
      body = {
        date: this.data.date,
        exerciseId: e.id,
        name: e.name,
        durationMin: this.durationMin() ?? undefined,
        // Omit caloriesBurned so the server estimates from weight + duration + MET; otherwise send it.
        caloriesBurned: deferToServer ? undefined : (this.effectiveCals() ?? undefined),
      };
    }
    this.ref.close(body);
  }

  cancel(): void {
    this.ref.close();
  }
}
