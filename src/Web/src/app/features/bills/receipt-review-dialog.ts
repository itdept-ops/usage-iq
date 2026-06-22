import { CurrencyPipe } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';

import { ReceiptBreakdownDto } from '../../core/models';

/** The AI breakdown to seed the editable review form with. */
export interface ReceiptReviewData {
  breakdown: ReceiptBreakdownDto;
}

/** One editable line in the review (name + amount), kept as strings so the inputs bind cleanly. */
interface EditRow {
  name: string;
  amount: number | null;
}

/** What the owner approved: the (cleaned) line items plus the optional tax/tip to write onto the bill. */
export interface ReceiptReviewResult {
  items: { name: string; amount: number }[];
  tax: number | null;
  tip: number | null;
}

/**
 * Review the AI receipt breakdown before saving. The model's output is editable — the owner can fix a
 * misread line, delete a junk row, add a missing one, and adjust the detected tax/tip. Nothing is
 * persisted until they hit "Add to bill"; the source image was already digested in-memory and never
 * stored. Resolves with the cleaned items + tax/tip for the page to write onto the bill.
 */
@Component({
  selector: 'app-receipt-review-dialog',
  imports: [
    CurrencyPipe, FormsModule, MatDialogModule, MatFormFieldModule, MatInputModule, MatButtonModule,
    MatIconModule,
  ],
  template: `
    <h2 mat-dialog-title class="rr-title">Review receipt</h2>
    <mat-dialog-content class="rr-body">
      <p class="rr-intro">
        We read these lines off the photo. Fix anything that's off, then add them to your bill.
        The photo was analyzed in-memory and is not stored.
      </p>

      <div class="rr-rows">
        @for (row of rows(); track $index) {
          <div class="rr-row">
            <mat-form-field appearance="outline" class="rr-name">
              <mat-label>Item</mat-label>
              <input matInput [ngModel]="row.name" (ngModelChange)="setName($index, $event)" />
            </mat-form-field>
            <mat-form-field appearance="outline" class="rr-amt">
              <mat-label>Amount</mat-label>
              <span matTextPrefix>$&nbsp;</span>
              <input matInput type="number" min="0" step="0.01" inputmode="decimal"
                     [ngModel]="row.amount" (ngModelChange)="setAmount($index, $event)" />
            </mat-form-field>
            <button mat-icon-button type="button" class="rr-del" (click)="removeRow($index)"
                    aria-label="Remove line">
              <mat-icon aria-hidden="true">close</mat-icon>
            </button>
          </div>
        }
      </div>

      <button mat-stroked-button type="button" class="rr-add" (click)="addRow()">
        <mat-icon aria-hidden="true">add</mat-icon> Add line
      </button>

      <div class="rr-taxtip">
        <mat-form-field appearance="outline" class="rr-tt">
          <mat-label>Tax</mat-label>
          <span matTextPrefix>$&nbsp;</span>
          <input matInput type="number" min="0" step="0.01" inputmode="decimal"
                 [ngModel]="tax()" (ngModelChange)="tax.set($event)" />
        </mat-form-field>
        <mat-form-field appearance="outline" class="rr-tt">
          <mat-label>Tip</mat-label>
          <span matTextPrefix>$&nbsp;</span>
          <input matInput type="number" min="0" step="0.01" inputmode="decimal"
                 [ngModel]="tip()" (ngModelChange)="tip.set($event)" />
        </mat-form-field>
      </div>

      <p class="rr-total">
        <span>Items subtotal</span>
        <span class="rr-total__v">{{ subtotal() | currency: 'USD' }}</span>
      </p>
    </mat-dialog-content>
    <mat-dialog-actions class="rr-actions" align="end">
      <button mat-stroked-button type="button" (click)="cancel()">Cancel</button>
      <button mat-flat-button type="button" color="primary" [disabled]="!canSave()" (click)="save()">
        Add to bill
      </button>
    </mat-dialog-actions>
  `,
  styles: `
    .rr-title { font-family: var(--tech-font-ui); font-weight: 700; color: var(--tech-text); }
    .rr-body { display: flex; flex-direction: column; gap: var(--tech-space-3);
      min-width: min(460px, 86vw); padding-top: 4px !important; }
    .rr-intro { margin: 0; color: var(--tech-text-dim); font-size: .88rem; line-height: 1.4; }
    .rr-rows { display: flex; flex-direction: column; gap: var(--tech-space-1); }
    .rr-row { display: grid; grid-template-columns: 1fr 130px 40px; gap: 8px; align-items: center; }
    .rr-name, .rr-amt { width: 100%; margin-bottom: -1.25em; }
    .rr-del { color: var(--tech-text-dim); }
    .rr-add { align-self: flex-start; border-radius: var(--tech-r-control); }
    .rr-add mat-icon { font-size: 18px; height: 18px; width: 18px; }
    .rr-taxtip { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .rr-tt { width: 100%; margin-bottom: -1.25em; }
    .rr-total { display: flex; justify-content: space-between; align-items: baseline; margin: 0;
      font-size: .92rem; color: var(--tech-text-secondary);
      &__v { font-family: var(--tech-font-mono); font-weight: 700; color: var(--tech-text); } }
    .rr-actions { padding: var(--tech-space-3) var(--tech-space-4); gap: 8px;
      button { border-radius: var(--tech-r-control); font-weight: 600; min-height: 44px; } }
  `,
})
export class ReceiptReviewDialog {
  private ref = inject(MatDialogRef<ReceiptReviewDialog, ReceiptReviewResult>);
  private data = inject<ReceiptReviewData>(MAT_DIALOG_DATA);

  readonly rows = signal<EditRow[]>(
    (this.data.breakdown.items ?? []).map(i => ({ name: i.name, amount: i.amount })),
  );
  readonly tax = signal<number | null>(this.data.breakdown.tax ?? null);
  readonly tip = signal<number | null>(this.data.breakdown.tip ?? null);

  constructor() {
    if (this.rows().length === 0) this.addRow();
  }

  setName(i: number, v: string): void {
    const next = [...this.rows()];
    next[i] = { ...next[i], name: v };
    this.rows.set(next);
  }

  setAmount(i: number, v: number | null): void {
    const next = [...this.rows()];
    next[i] = { ...next[i], amount: v };
    this.rows.set(next);
  }

  addRow(): void {
    this.rows.set([...this.rows(), { name: '', amount: null }]);
  }

  removeRow(i: number): void {
    this.rows.set(this.rows().filter((_, idx) => idx !== i));
  }

  /** Only rows with a non-empty name AND a positive amount are real lines. */
  private readonly valid = computed(() =>
    this.rows().filter(r => r.name.trim().length > 0 && (r.amount ?? 0) > 0));

  readonly subtotal = computed(() => this.valid().reduce((s, r) => s + (r.amount ?? 0), 0));

  readonly canSave = computed(() => this.valid().length > 0);

  save(): void {
    if (!this.canSave()) return;
    this.ref.close({
      items: this.valid().map(r => ({ name: r.name.trim(), amount: r.amount ?? 0 })),
      tax: this.tax() != null && this.tax()! > 0 ? this.tax() : null,
      tip: this.tip() != null && this.tip()! > 0 ? this.tip() : null,
    });
  }

  cancel(): void {
    this.ref.close();
  }
}
