import { Component, computed, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';

import {
  ActivityCalorieMode,
  UnitSystem,
  UpsertActivityRequest,
  WatchActivityDto,
} from '../../core/models';
import { UnitService } from '../../core/unit.service';

/** Opens with the active date, the user's unit preference, and any existing watch stats to prefill. */
export interface AddActivityData {
  date: string;
  unitSystem: UnitSystem;
  /** The day's existing watch stats to prefill the form (null on a day with no row). */
  activity: WatchActivityDto | null;
}

/**
 * "Edit / add watch stats" dialog. Enters the day's steps, distance (in the user's units — mi for
 * Imperial, km for Metric), active calories, and the add/override calorie mode. Converts distance to
 * metric metres on save. Resolves with an {@link UpsertActivityRequest} for the page to persist (which
 * upserts the single per-day row and reloads the day so the calorie ring reflects the resolved burn).
 */
@Component({
  selector: 'app-add-activity-dialog',
  imports: [
    FormsModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    MatButtonToggleModule,
  ],
  template: `
    <h2 mat-dialog-title class="ac-title">Watch stats</h2>
    <mat-dialog-content class="ac-body">
      <mat-form-field appearance="outline" class="ac-field">
        <mat-label>Steps</mat-label>
        <input
          matInput
          type="number"
          min="0"
          step="1"
          inputmode="numeric"
          cdkFocusInitial
          [ngModel]="steps()"
          (ngModelChange)="steps.set($event)"
        />
        <mat-hint>Recorded for {{ data.date }}.</mat-hint>
      </mat-form-field>

      <mat-form-field appearance="outline" class="ac-field">
        <mat-label>Distance</mat-label>
        <input
          matInput
          type="number"
          min="0"
          step="0.1"
          inputmode="decimal"
          [ngModel]="distanceDisp()"
          (ngModelChange)="distanceDisp.set($event)"
        />
        <span matTextSuffix>{{ units.distanceUnit() }}</span>
      </mat-form-field>

      <mat-form-field appearance="outline" class="ac-field">
        <mat-label>Active calories</mat-label>
        <input
          matInput
          type="number"
          min="0"
          step="1"
          inputmode="numeric"
          [ngModel]="activeCalories()"
          (ngModelChange)="activeCalories.set($event)"
        />
        <span matTextSuffix>kcal</span>
      </mat-form-field>

      <div class="ac-mode">
        <span class="micro-label">How active calories count</span>
        <mat-button-toggle-group
          [value]="calorieMode()"
          (change)="calorieMode.set($event.value)"
          aria-label="How active calories count"
          class="ac-mode-toggle"
        >
          <mat-button-toggle value="add">Add to workouts</mat-button-toggle>
          <mat-button-toggle value="override">Replace workouts</mat-button-toggle>
        </mat-button-toggle-group>
        <p class="ac-mode-note">
          {{
            calorieMode() === 'override'
              ? 'Your watch total replaces the calories from logged exercises.'
              : 'Your watch active calories are added on top of logged exercises.'
          }}
        </p>
      </div>
    </mat-dialog-content>
    <mat-dialog-actions class="ac-actions" align="end">
      @if (data.activity) {
        <button mat-button type="button" class="ac-clear" (click)="clear()">Clear</button>
      }
      <button mat-stroked-button type="button" (click)="cancel()">Cancel</button>
      <button mat-flat-button type="button" color="primary" (click)="save()">Save</button>
    </mat-dialog-actions>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: `
    .ac-title {
      font-family: var(--tech-font-ui);
      font-weight: 700;
      color: var(--tech-text);
    }
    .ac-body {
      min-width: min(340px, 80vw);
      padding-top: 4px !important;
      display: flex;
      flex-direction: column;
      gap: var(--tech-space-2);
    }
    .ac-field {
      width: 100%;
    }
    .ac-mode {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .ac-mode-toggle {
      width: 100%;
    }
    .ac-mode-toggle .mat-button-toggle {
      flex: 1 1 0;
    }
    .ac-mode-note {
      margin: 0;
      font-size: var(--tech-fs-label);
      color: var(--tech-text-tertiary);
    }
    .ac-actions {
      padding: var(--tech-space-3) var(--tech-space-4);
      gap: 8px;
      button {
        border-radius: var(--tech-r-control);
        font-weight: 600;
        min-height: 44px;
      }
    }
    .ac-clear {
      margin-right: auto;
      color: var(--tech-error);
    }
  `,
})
export class AddActivityDialog {
  private ref = inject(MatDialogRef<AddActivityDialog, UpsertActivityRequest | 'clear'>);
  readonly data = inject<AddActivityData>(MAT_DIALOG_DATA);
  readonly units = inject(UnitService);

  // Seed the display preference from the unit system the dialog was opened with. This MUST be a field
  // initializer declared ABOVE the display fields below: initializers run top-to-bottom before the
  // constructor body, and `distanceDisp` reads `units.imperial()` (via toDistDisp) — so the seed
  // has to land first.
  private readonly _seed = (this.units.setLocal(this.data.unitSystem), true);

  readonly steps = signal<number | null>(this.data.activity?.steps ?? null);
  readonly distanceDisp = signal<number | null>(
    this.toDistDisp(this.data.activity?.distanceMeters),
  );
  readonly activeCalories = signal<number | null>(this.data.activity?.activeCalories ?? null);
  readonly calorieMode = signal<ActivityCalorieMode>(this.data.activity?.calorieMode ?? 'add');

  /** A metric distance (metres) as a rounded DISPLAY value in the current units (mi for Imperial, km for Metric). */
  private toDistDisp(m: number | null | undefined): number | null {
    if (m == null) return null;
    return Math.round(this.units.distanceToDisplay(m / 1000) * 10) / 10;
  }

  /** Display distance back to canonical metric metres (or null when empty/non-positive). */
  private readonly distanceMeters = computed<number | null>(() => {
    const d = this.distanceDisp();
    if (d == null || d <= 0) return null;
    return Math.round(this.units.distanceToCanonical(d) * 1000);
  });

  /** Clamp a count to a non-negative integer within `max`, or null when empty/invalid. */
  private intIn(v: number | null, max: number): number | null {
    if (v == null || v < 0) return null;
    const n = Math.round(v);
    return n <= max ? n : max;
  }

  save(): void {
    this.ref.close({
      date: this.data.date,
      steps: this.intIn(this.steps(), 200000),
      distanceMeters: this.distanceMeters(),
      activeCalories: this.intIn(this.activeCalories(), 20000),
      calorieMode: this.calorieMode(),
    });
  }

  clear(): void {
    this.ref.close('clear');
  }

  cancel(): void {
    this.ref.close();
  }
}
