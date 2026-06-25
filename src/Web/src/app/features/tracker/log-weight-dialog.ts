import { Component, computed, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { LowerCasePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';

import { LogWeightRequest, UnitSystem, WeightSlot } from '../../core/models';
import { UnitService } from '../../core/unit.service';

/** Opens with the active date, the user's unit preference, and (optionally) the current weight to prefill. */
export interface LogWeightData {
  date: string;
  unitSystem: UnitSystem;
  /** The profile's current weight in kg, used to prefill the field. */
  currentKg?: number | null;
}

/** The selectable weigh-in slots (Unspecified is the implicit default when omitted). */
const SLOTS: { value: WeightSlot; label: string }[] = [
  { value: 'Morning', label: 'Morning' },
  { value: 'Afternoon', label: 'Afternoon' },
  { value: 'Evening', label: 'Evening' },
];

/** Pick the slot that matches the current local hour (so the default reflects when the user is logging). */
function currentSlot(now = new Date()): WeightSlot {
  const h = now.getHours();
  if (h < 12) return 'Morning';
  if (h < 18) return 'Afternoon';
  return 'Evening';
}

/**
 * Quick "log weight" dialog. Enters a weight in the user's chosen units; converts to metric kg on save.
 * A time-of-day SLOT selector (Morning / Afternoon / Evening) lets several weigh-ins coexist per day; it
 * defaults to the current part of the day. Resolves with a {@link LogWeightRequest} (date + metric kg +
 * slot) for the page to persist.
 */
@Component({
  selector: 'app-log-weight-dialog',
  imports: [
    FormsModule,
    LowerCasePipe,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    MatButtonToggleModule,
  ],
  template: `
    <h2 mat-dialog-title class="lw-title">Log weight</h2>
    <mat-dialog-content class="lw-body">
      <div class="lw-slot">
        <span class="micro-label" id="lw-slot-label">Time of day</span>
        <mat-button-toggle-group
          class="lw-slot-toggle"
          [value]="slot()"
          (change)="slot.set($event.value)"
          aria-labelledby="lw-slot-label"
          hideSingleSelectionIndicator
        >
          @for (s of slots; track s.value) {
            <mat-button-toggle [value]="s.value" [attr.aria-label]="s.label + ' weigh-in'">{{
              s.label
            }}</mat-button-toggle>
          }
        </mat-button-toggle-group>
      </div>

      <mat-form-field appearance="outline" class="lw-field">
        <mat-label>Weight</mat-label>
        <input
          matInput
          type="number"
          min="0"
          step="0.1"
          inputmode="decimal"
          cdkFocusInitial
          [ngModel]="weightDisp()"
          (ngModelChange)="weightDisp.set($event)"
        />
        <span matTextSuffix>{{ units.weightUnit() }}</span>
        <mat-hint
          >Recorded for {{ data.date }} ({{ slot() | lowercase }}). One entry per slot.</mat-hint
        >
      </mat-form-field>
    </mat-dialog-content>
    <mat-dialog-actions class="lw-actions" align="end">
      <button mat-stroked-button type="button" (click)="cancel()">Cancel</button>
      <button
        mat-flat-button
        type="button"
        color="primary"
        [disabled]="!canSave()"
        (click)="save()"
      >
        Save
      </button>
    </mat-dialog-actions>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: `
    .lw-title {
      font-family: var(--tech-font-ui);
      font-weight: 700;
      color: var(--tech-text);
    }
    .lw-body {
      display: flex;
      flex-direction: column;
      gap: var(--tech-space-3);
      min-width: min(320px, 80vw);
      padding-top: 4px !important;
    }
    .lw-field {
      width: 100%;
    }
    .lw-slot {
      display: flex;
      flex-direction: column;
      gap: var(--tech-space-2);
    }
    .lw-slot-toggle {
      align-self: stretch;
      border-radius: var(--tech-r-control);
      ::ng-deep .mat-button-toggle {
        flex: 1 1 0;
      }
      ::ng-deep .mat-button-toggle-label-content {
        line-height: 44px;
      }
    }
    .lw-actions {
      padding: var(--tech-space-3) var(--tech-space-4);
      gap: 8px;
      button {
        border-radius: var(--tech-r-control);
        font-weight: 600;
        min-height: 44px;
      }
    }
  `,
})
export class LogWeightDialog {
  private ref = inject(MatDialogRef<LogWeightDialog, LogWeightRequest>);
  readonly data = inject<LogWeightData>(MAT_DIALOG_DATA);
  readonly units = inject(UnitService);

  // Seed the display preference from the unit system the dialog was opened with. This MUST be a field
  // initializer declared ABOVE the display fields below: initializers run top-to-bottom before the
  // constructor body, and `weightDisp` reads `units.imperial()` — so the seed has to land first.
  private readonly _seed = (this.units.setLocal(this.data.unitSystem), true);

  readonly slots = SLOTS;

  /** Defaults to the current part of the day (Morning / Afternoon / Evening). */
  readonly slot = signal<WeightSlot>(currentSlot());

  readonly weightDisp = signal<number | null>(
    this.data.currentKg != null
      ? Math.round(this.units.weightToDisplay(this.data.currentKg) * 10) / 10
      : null,
  );

  /** Metric kg from the entered display value (1..1000 kg sane range). */
  private readonly kg = computed<number | null>(() => {
    const d = this.weightDisp();
    if (d == null || d <= 0) return null;
    const k = this.units.weightToCanonical(d);
    return k >= 1 && k <= 1000 ? Math.round(k * 100) / 100 : null;
  });

  readonly canSave = computed(() => this.kg() != null);

  save(): void {
    const kg = this.kg();
    if (kg == null) return;
    this.ref.close({ date: this.data.date, weightKg: kg, slot: this.slot() });
  }

  cancel(): void {
    this.ref.close();
  }
}
