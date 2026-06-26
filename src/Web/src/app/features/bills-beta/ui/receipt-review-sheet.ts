import { ChangeDetectionStrategy, Component, computed, effect, input, model, output, signal } from '@angular/core';
import { CurrencyPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';

import { ReceiptBreakdownDto } from '../../../core/models';
import { BetaBottomSheet } from '../../beta-ui';

/** One editable line in the review (name + amount). */
interface EditRow {
  name: string;
  amount: number | null;
}

/** What the owner approved: cleaned line items + optional tax/tip to write onto the bill. */
export interface ReceiptReviewResult {
  items: { name: string; amount: number }[];
  tax: number | null;
  tip: number | null;
}

/**
 * Tally receipt-review sheet — the live ReceiptReviewDialog logic ported into the kit
 * {@link BetaBottomSheet} for the mobile flow. Opens with the AI breakdown, lets the owner fix/delete/add
 * lines and adjust the detected tax/tip, then emits a {@link ReceiptReviewResult} (only rows with a
 * non-empty name AND amount>0; tax/tip emitted only when > 0) for the page to batch-write.
 *
 * Two-way `open` mirrors the sheet's open state; `breakdown` seeds the editable rows when it changes.
 * Inherits the cream Tally accent tokens from the page `:host`; BetaBottomSheet inherits --glass/--r-glass.
 */
@Component({
  selector: 'app-receipt-review-sheet',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CurrencyPipe, FormsModule, MatIconModule, BetaBottomSheet],
  template: `
    <app-bs-sheet [(open)]="open" detent="full" label="Review receipt" (closed)="onClosed()">
      <div class="rrs">
        <h2 class="rrs__title">Review receipt</h2>
        <p class="rrs__intro">
          We read these lines off the photo. Fix anything that's off, then add them to your bill.
          The photo was analyzed in-memory and is not stored.
        </p>

        <div class="rrs__rows">
          @for (row of rows(); track $index) {
            <div class="rrs__row">
              <input class="rrs__name" placeholder="Item" [ngModel]="row.name"
                     (ngModelChange)="setName($index, $event)" aria-label="Item name" />
              <div class="rrs__amtwrap">
                <span class="rrs__cur">$</span>
                <input class="rrs__amt" type="number" min="0" step="0.01" inputmode="decimal"
                       [ngModel]="row.amount" (ngModelChange)="setAmount($index, $event)" aria-label="Amount" />
              </div>
              <button type="button" class="rrs__del" (click)="removeRow($index)" aria-label="Remove line">
                <mat-icon aria-hidden="true">close</mat-icon>
              </button>
            </div>
          }
        </div>

        <button type="button" class="rrs__addline" (click)="addRow()">
          <mat-icon aria-hidden="true">add</mat-icon> Add line
        </button>

        <div class="rrs__taxtip">
          <label class="rrs__tt"><span>Tax</span>
            <div class="rrs__amtwrap"><span class="rrs__cur">$</span>
              <input class="rrs__amt" type="number" min="0" step="0.01" inputmode="decimal"
                     [ngModel]="tax()" (ngModelChange)="tax.set($event)" /></div>
          </label>
          <label class="rrs__tt"><span>Tip</span>
            <div class="rrs__amtwrap"><span class="rrs__cur">$</span>
              <input class="rrs__amt" type="number" min="0" step="0.01" inputmode="decimal"
                     [ngModel]="tip()" (ngModelChange)="tip.set($event)" /></div>
          </label>
        </div>

        <p class="rrs__total">
          <span>Items subtotal</span>
          <span class="rrs__total-v">{{ subtotal() | currency: 'USD' }}</span>
        </p>

        <div class="rrs__actions">
          <button type="button" class="rrs__btn rrs__btn--ghost" (click)="cancel()">Cancel</button>
          <button type="button" class="rrs__btn rrs__btn--primary" [disabled]="!canSave()" (click)="save()">
            Add to bill
          </button>
        </div>
      </div>
    </app-bs-sheet>
  `,
  styles: [`
    .rrs { display: flex; flex-direction: column; gap: 14px; padding-top: 4px; color: var(--ink); }
    .rrs__title { margin: 0; font: 600 22px/1.1 var(--font-display); letter-spacing: -.01em; color: var(--ink); }
    .rrs__intro { margin: 0; font: 500 13px/1.4 var(--font-ui); color: var(--ink-dim); }
    .rrs__rows { display: flex; flex-direction: column; gap: 8px; }
    .rrs__row { display: grid; grid-template-columns: 1fr 116px 40px; gap: 8px; align-items: center; }
    .rrs__name, .rrs__amt {
      background: var(--bg-sink); border: 1px solid var(--hairline); border-radius: 12px;
      color: var(--ink); font: 500 15px/1 var(--font-ui); min-height: 48px; padding: 0 12px; outline: none;
      &:focus { border-color: var(--accent-b); }
    }
    .rrs__amtwrap { position: relative; display: flex; align-items: center; }
    .rrs__cur { position: absolute; left: 12px; color: var(--ink-dim); font: 500 14px/1 var(--font-display); pointer-events: none; }
    .rrs__amt { width: 100%; padding-left: 26px; text-align: right; font-family: var(--font-display); font-weight: 600; }
    .rrs__del {
      width: 40px; height: 40px; display: grid; place-items: center;
      border: 1px solid var(--hairline); border-radius: 12px; background: var(--bg-sink);
      color: var(--ink-dim); cursor: pointer;
    }
    .rrs__addline {
      align-self: flex-start; display: inline-flex; align-items: center; gap: 6px;
      min-height: 44px; padding: 0 16px; border: 1px solid var(--hairline); border-radius: var(--r-pill);
      background: var(--bg-sink); color: var(--ink); font: 600 14px/1 var(--font-ui); cursor: pointer;
      mat-icon { font-size: 18px; width: 18px; height: 18px; }
    }
    .rrs__taxtip { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .rrs__tt { display: flex; flex-direction: column; gap: 6px; font: 600 12px/1 var(--font-ui); color: var(--ink-dim); }
    .rrs__total { display: flex; justify-content: space-between; align-items: baseline; margin: 0;
      font: 600 14px/1 var(--font-ui); color: var(--ink-dim); }
    .rrs__total-v { font: 600 18px/1 var(--font-display); color: var(--ink); }
    .rrs__actions { display: flex; gap: 10px; padding-top: 4px; }
    .rrs__btn { flex: 1 1 0; min-height: 54px; border-radius: var(--r-pill);
      font: 700 15px/1 var(--font-ui); cursor: pointer; border: 1px solid var(--hairline); }
    .rrs__btn--ghost { background: var(--bg-sink); color: var(--ink); }
    .rrs__btn--primary { background: linear-gradient(135deg, var(--accent-a), var(--accent-b)); color: var(--on-accent, #2a2410); border: none; }
    .rrs__btn--primary:disabled { opacity: .4; cursor: default; }
  `],
})
export class ReceiptReviewSheet {
  /** Two-way open state, mirrored onto the inner bottom-sheet. */
  readonly open = model<boolean>(false);
  /** The AI breakdown that seeds the editable rows (re-seeds whenever it changes). */
  readonly breakdown = input<ReceiptBreakdownDto | null>(null);

  /** Emitted with the cleaned result when the owner taps "Add to bill". */
  readonly confirmed = output<ReceiptReviewResult>();
  /** Emitted when the sheet is dismissed without saving. */
  readonly cancelled = output<void>();

  protected readonly rows = signal<EditRow[]>([]);
  protected readonly tax = signal<number | null>(null);
  protected readonly tip = signal<number | null>(null);
  private committed = false;

  constructor() {
    // Re-seed the editable form each time a fresh breakdown arrives.
    effect(() => {
      const b = this.breakdown();
      const seeded = (b?.items ?? []).map(i => ({ name: i.name, amount: i.amount }));
      this.rows.set(seeded.length ? seeded : [{ name: '', amount: null }]);
      this.tax.set(b?.tax ?? null);
      this.tip.set(b?.tip ?? null);
      this.committed = false;
    });
  }

  protected setName(i: number, v: string): void {
    const next = [...this.rows()];
    next[i] = { ...next[i], name: v };
    this.rows.set(next);
  }

  protected setAmount(i: number, v: number | null): void {
    const next = [...this.rows()];
    next[i] = { ...next[i], amount: v };
    this.rows.set(next);
  }

  protected addRow(): void {
    this.rows.set([...this.rows(), { name: '', amount: null }]);
  }

  protected removeRow(i: number): void {
    this.rows.set(this.rows().filter((_, idx) => idx !== i));
  }

  /** Only rows with a non-empty name AND a positive amount are real lines. */
  private readonly valid = computed(() =>
    this.rows().filter(r => r.name.trim().length > 0 && (r.amount ?? 0) > 0));

  protected readonly subtotal = computed(() => this.valid().reduce((s, r) => s + (r.amount ?? 0), 0));
  protected readonly canSave = computed(() => this.valid().length > 0);

  protected save(): void {
    if (!this.canSave()) return;
    this.committed = true;
    this.confirmed.emit({
      items: this.valid().map(r => ({ name: r.name.trim(), amount: r.amount ?? 0 })),
      tax: this.tax() != null && this.tax()! > 0 ? this.tax() : null,
      tip: this.tip() != null && this.tip()! > 0 ? this.tip() : null,
    });
    this.open.set(false);
  }

  protected cancel(): void {
    this.open.set(false);
  }

  /** The inner sheet settled closed (swipe/scrim/Escape/cancel). Emit cancel unless we already saved. */
  protected onClosed(): void {
    if (!this.committed) this.cancelled.emit();
    this.committed = false;
  }
}
