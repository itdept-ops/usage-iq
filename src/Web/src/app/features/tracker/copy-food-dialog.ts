import { Component, computed, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';

import { Meal } from '../../core/models';

/**
 * Opens with the entry id(s) to copy + the source meal. Source can be a single food row ("Copy to…")
 * or a whole meal section ("Copy meal to…"); either way it's just the caller's OWN entry ids.
 */
export interface CopyFoodData {
  /** The caller's own food-entry id(s) to copy onto another day. */
  entryIds: number[];
  /** The source meal slot — seeds the default target meal (kept unless the user overrides it). */
  sourceMeal: Meal;
  /** A friendly noun for the count ("1 item" / "Breakfast — 3 items") for the dialog copy. */
  label: string;
}

/** What the dialog resolves with on confirm: the target date + optional meal override (undefined === cancelled). */
export interface CopyFoodResult {
  /** The day (yyyy-MM-dd) to copy onto. */
  targetDate: string;
  /** The target meal slot — when it equals the source the caller can omit it; we always pass the explicit slot. */
  targetMeal: Meal;
}

/** The four meal slots for the optional target-meal select (matches the add-food dialog set). */
const MEALS: { value: Meal; label: string }[] = [
  { value: 'breakfast', label: 'Breakfast' },
  { value: 'lunch', label: 'Lunch' },
  { value: 'dinner', label: 'Dinner' },
  { value: 'snack', label: 'Snacks' },
];

/** Local "yyyy-MM-dd" for a Date (no UTC shift — the tracker is local-date keyed). */
function toIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Tomorrow as a local yyyy-MM-dd — the default target (a copy usually plans ahead). */
function tomorrow(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 1);
  return toIso(d);
}

/** A reasonable forward cap (today + 1 year) so the date picker can't wander absurdly far out. */
function maxDate(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setFullYear(d.getFullYear() + 1);
  return toIso(d);
}

/**
 * "Copy to day" dialog — re-log the caller's OWN food entry/entries onto another day (a COPY: the source
 * day is untouched server-side). Picks a TARGET DATE (date input, default tomorrow, forward-capped) and an
 * optional TARGET MEAL (default = the source meal). Resolves with a {@link CopyFoodResult} the page POSTs
 * via the copyFood endpoint; the page snackbars the result and refreshes if the copy landed on the viewed
 * day. Mirrors the move-day dialog's chrome (the same --tech-* tokens + the tracker-dialog panel).
 */
@Component({
  selector: 'app-copy-food-dialog',
  imports: [
    FormsModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatButtonModule,
    MatIconModule,
  ],
  template: `
    <h2 mat-dialog-title class="cf-title">Copy to another day</h2>
    <mat-dialog-content class="cf-body">
      <p class="cf-intro">
        Copy {{ data.label }} onto another day. The original stays where it is — this just re-logs the same
        food on the day you pick.
      </p>

      <mat-form-field appearance="outline" class="cf-field">
        <mat-label>Copy to</mat-label>
        <input
          matInput
          type="date"
          cdkFocusInitial
          [max]="maxDate"
          [ngModel]="targetDate()"
          (ngModelChange)="targetDate.set($event)"
        />
        <mat-hint>{{ targetDate() || '—' }}</mat-hint>
      </mat-form-field>

      <mat-form-field appearance="outline" class="cf-field">
        <mat-label>Meal</mat-label>
        <mat-select [value]="targetMeal()" (selectionChange)="targetMeal.set($any($event.value))">
          @for (m of meals; track m.value) {
            <mat-option [value]="m.value">{{ m.label }}</mat-option>
          }
        </mat-select>
      </mat-form-field>
    </mat-dialog-content>
    <mat-dialog-actions class="cf-actions" align="end">
      <button mat-stroked-button type="button" (click)="cancel()">Cancel</button>
      <button
        mat-flat-button
        type="button"
        color="primary"
        [disabled]="!canCopy()"
        (click)="copy()"
      >
        <mat-icon aria-hidden="true">content_copy</mat-icon> Copy
      </button>
    </mat-dialog-actions>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: `
    .cf-title {
      font-family: var(--tech-font-ui);
      font-weight: 700;
      color: var(--tech-text);
    }
    .cf-body {
      display: flex;
      flex-direction: column;
      gap: var(--tech-space-3);
      min-width: min(340px, 82vw);
      padding-top: 4px !important;
    }
    .cf-intro {
      margin: 0;
      color: var(--tech-text-dim);
      font-size: 0.9rem;
      line-height: 1.4;
    }
    .cf-field {
      width: 100%;
    }
    .cf-actions {
      padding: var(--tech-space-3) var(--tech-space-4);
      gap: 8px;
      button {
        border-radius: var(--tech-r-control);
        font-weight: 600;
        min-height: 44px;
      }
      mat-icon {
        font-size: 18px;
        height: 18px;
        width: 18px;
        margin-right: 4px;
        vertical-align: text-bottom;
      }
    }
  `,
})
export class CopyFoodDialog {
  private ref = inject(MatDialogRef<CopyFoodDialog, CopyFoodResult>);
  readonly data = inject<CopyFoodData>(MAT_DIALOG_DATA);

  readonly meals = MEALS;
  readonly maxDate = maxDate();

  /** Target date — defaults to tomorrow (the common "plan it for later" case). */
  readonly targetDate = signal<string>(tomorrow());

  /** Target meal — defaults to the source meal; the user can move the copy to a different slot. */
  readonly targetMeal = signal<Meal>(this.data.sourceMeal);

  /** Enabled only with a valid target date and at least one entry to copy. */
  readonly canCopy = computed(
    () => !!this.targetDate() && this.data.entryIds.length > 0,
  );

  copy(): void {
    if (!this.canCopy()) return;
    this.ref.close({ targetDate: this.targetDate(), targetMeal: this.targetMeal() });
  }

  cancel(): void {
    this.ref.close();
  }
}
