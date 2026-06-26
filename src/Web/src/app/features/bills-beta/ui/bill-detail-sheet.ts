import {
  ChangeDetectionStrategy, Component, computed, input, model, output, signal,
} from '@angular/core';
import { CurrencyPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';

import { BillDto, BillItemDto, ChatContactDto } from '../../../core/models';
import { BetaBottomSheet } from '../../beta-ui';
import { PersonTotalCard } from '../cards/person-total-card';
import { BillItemRow, AssignChange } from '../rows/bill-item-row';

/** A title edit committed from the detail sheet. */
export interface TitleChange { bill: BillDto; title: string; }
/** Add a new line item to the bill. */
export interface AddItem { bill: BillDto; name: string; amount: number; }
/** Bump tax or tip by a $ direction (+1 / -1). */
export interface BumpChange { bill: BillDto; dir: number; }

/**
 * Tally BILL-DETAIL sheet — the full per-bill editor, lifted into the kit {@link BetaBottomSheet}. Opening
 * a bill card raises this `full` sheet over the list: an editable title, a slim add-item bar (+ a receipt
 * SNAP button when the caller holds ai.vision), a determinate receipt-import bar, the claim-first item
 * rows ({@link BillItemRow}, swipe to settle/delete + an inline claim strip), tax/tip steppers, the big
 * Clash Display bill total, the horizontal per-person totals rail ({@link PersonTotalCard} + an amber
 * Unclaimed slide), and a SHARE-CLAIM-LINK bar (Get / Share / Copy / Off).
 *
 * Pure presentation: it owns NO Api and NO store — every mutation is emitted to the page, which performs
 * the optimistic patch + reconcile. Inherits the cream Tally accent tokens from the page `:host`.
 */
@Component({
  selector: 'app-bill-detail-sheet',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CurrencyPipe, FormsModule, MatIconModule, BetaBottomSheet, PersonTotalCard, BillItemRow],
  template: `
    <app-bs-sheet [(open)]="open" detent="full" [label]="bill()?.title || 'Bill'" (closed)="closed.emit()">
      @if (bill(); as b) {
        <div class="bd">
          <!-- Title + status -->
          <header class="bd__head">
            <input class="bd__title" [ngModel]="b.title" (blur)="commitTitle(b, $any($event.target).value)"
                   aria-label="Bill title" />
            <span class="bd__status" [class.bd__status--settled]="b.status === 'settled'">
              {{ b.status === 'settled' ? 'Settled' : 'Open' }}
            </span>
          </header>

          <!-- Receipt import progress -->
          @if (importing()) {
            <div class="bd__importing" aria-live="polite">
              <span>Adding items… {{ importDone() }}/{{ importTotal() }}</span>
              <div class="bd__importing-track"><div class="bd__importing-fill"
                   [style.width.%]="importTotal() ? (importDone() / importTotal()) * 100 : 0"></div></div>
            </div>
          }

          <!-- Add-item bar (+ snap receipt) -->
          <div class="bd__addbar">
            <div class="bd__addfield">
              <input class="bd__addname" placeholder="Add item" [ngModel]="newName()"
                     (ngModelChange)="newName.set($event)" (keydown.enter)="commitAdd(b)"
                     aria-label="New item name" />
              <input class="bd__addamt" type="number" inputmode="decimal" min="0" step="0.01"
                     placeholder="0.00" [ngModel]="newAmount()" (ngModelChange)="newAmount.set($event)"
                     (keydown.enter)="commitAdd(b)" aria-label="New item amount" />
            </div>
            <button type="button" class="bd__addbtn" aria-label="Add item"
                    [disabled]="busy()" (click)="commitAdd(b)">
              <mat-icon aria-hidden="true">add</mat-icon>
            </button>
            @if (canUseVision()) {
              <button type="button" class="bd__snap" aria-label="Snap receipt" (click)="snap.emit(b)">
                <mat-icon aria-hidden="true">photo_camera</mat-icon>
              </button>
            }
          </div>

          <!-- Items -->
          @if (b.items.length) {
            <p class="bd__h">Items</p>
            <div class="bd__items">
              @for (it of b.items; track it.id) {
                <app-bill-item-row [item]="it" [contacts]="contacts()"
                                   (settle)="settleItem.emit({ bill: b, item: $event })"
                                   (delete)="deleteItem.emit({ bill: b, item: $event })"
                                   (assign)="assignItem.emit({ bill: b, change: $event })" />
              }
            </div>

            <!-- Tax / tip steppers -->
            <div class="bd__taxtip">
              <div class="bd__stepper">
                <span class="bd__stepper-lbl">Tax</span>
                <span class="bd__stepper-v">{{ (b.taxAmount ?? 0) | currency: 'USD' }}</span>
                <div class="bd__stepper-btns">
                  <button type="button" class="bd__stepper-btn" aria-label="Decrease tax" (click)="bumpTax.emit({ bill: b, dir: -1 })">−</button>
                  <button type="button" class="bd__stepper-btn" aria-label="Increase tax" (click)="bumpTax.emit({ bill: b, dir: 1 })">+</button>
                </div>
              </div>
              <div class="bd__stepper">
                <span class="bd__stepper-lbl">Tip</span>
                <span class="bd__stepper-v">{{ (b.tipAmount ?? 0) | currency: 'USD' }}</span>
                <div class="bd__stepper-btns">
                  <button type="button" class="bd__stepper-btn" aria-label="Decrease tip" (click)="bumpTip.emit({ bill: b, dir: -1 })">−</button>
                  <button type="button" class="bd__stepper-btn" aria-label="Increase tip" (click)="bumpTip.emit({ bill: b, dir: 1 })">+</button>
                </div>
              </div>
            </div>

            <!-- Bill total -->
            <div class="bd__total">
              <span class="bd__total-lbl">Total</span>
              <span class="bd__total-v">{{ total(b) | currency: 'USD' }}</span>
            </div>

            <!-- Per-person totals rail -->
            @if (b.personTotals.length || b.unclaimedTotal > 0) {
              <p class="bd__h">Who owes what</p>
              <div class="bd__rail" aria-label="Per-person totals">
                @for (p of b.personTotals; track p.name) {
                  <app-person-total-card [person]="p" [payments]="b.payments" />
                }
                @if (b.unclaimedTotal > 0) {
                  <app-person-total-card [unclaimed]="true" [amount]="b.unclaimedTotal" />
                }
              </div>
            }
          } @else if (!importing()) {
            <div class="bd__noitems">
              <mat-icon aria-hidden="true">receipt_long</mat-icon>
              <p>No items yet. Add them above@if (canUseVision()) {, or snap the receipt}.</p>
            </div>
          }

          <!-- Share claim link -->
          <div class="bd__share">
            <button type="button" class="bd__share-btn" [class.is-active]="b.shareEnabled"
                    (click)="b.shareEnabled ? shareLink.emit(b) : enableShare.emit(b)">
              <mat-icon aria-hidden="true">{{ b.shareEnabled ? 'link' : 'ios_share' }}</mat-icon>
              {{ b.shareEnabled ? 'Share claim link' : 'Get claim link' }}
            </button>
            @if (b.shareEnabled) {
              <button type="button" class="bd__share-ic" aria-label="Copy claim link" (click)="copyShare.emit(b)">
                <mat-icon aria-hidden="true">content_copy</mat-icon>
              </button>
              <button type="button" class="bd__share-ic" aria-label="Turn off claim link" (click)="disableShare.emit(b)">
                <mat-icon aria-hidden="true">link_off</mat-icon>
              </button>
            }
          </div>

          <!-- Settle / reopen -->
          <button type="button" class="bd__settle" [class.is-settled]="b.status === 'settled'"
                  (click)="toggleSettled.emit(b)">
            <mat-icon aria-hidden="true">{{ b.status === 'settled' ? 'undo' : 'task_alt' }}</mat-icon>
            {{ b.status === 'settled' ? 'Reopen bill' : 'Mark bill settled' }}
          </button>
        </div>
      }
    </app-bs-sheet>
  `,
  styles: [`
    .bd { display: flex; flex-direction: column; gap: 14px; padding-top: 4px; color: var(--ink); }

    .bd__head { display: flex; align-items: center; gap: 10px; }
    .bd__title {
      flex: 1 1 auto; min-width: 0; background: transparent; border: none; outline: none;
      color: var(--ink); font: 600 24px/1.1 var(--font-display); letter-spacing: -.02em;
      border-bottom: 1px solid transparent; padding: 4px 0;
    }
    .bd__title:focus { border-bottom-color: var(--hairline); }
    .bd__status {
      flex: 0 0 auto; padding: 5px 11px; border-radius: var(--r-pill);
      font: 800 11px/1 var(--font-ui); letter-spacing: .05em; text-transform: uppercase;
      background: color-mix(in srgb, var(--warn) 16%, transparent); color: var(--warn);
    }
    .bd__status--settled { background: color-mix(in srgb, var(--signal) 18%, transparent); color: var(--signal); }

    .bd__importing { display: flex; align-items: center; gap: 10px; font: 600 13px/1.2 var(--font-ui); color: var(--ink-dim); }
    .bd__importing-track { flex: 1 1 auto; height: 6px; border-radius: var(--r-pill); background: var(--bg-sink); overflow: hidden; }
    .bd__importing-fill { height: 100%; background: linear-gradient(90deg, var(--accent-a), var(--accent-b)); border-radius: var(--r-pill); transition: width 200ms var(--ease-out); }

    .bd__addbar { display: flex; gap: 8px; align-items: center; }
    .bd__addfield {
      flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 6px;
      min-height: 54px; padding: 0 14px; border: 1px solid var(--hairline);
      border-radius: var(--r-tile); background: var(--bg-sink);
    }
    .bd__addfield input { background: transparent; border: none; outline: none; color: var(--ink); font: 500 15px/1 var(--font-ui); min-width: 0; }
    .bd__addname { flex: 1 1 auto; }
    .bd__addamt { width: 84px; text-align: right; font-family: var(--font-display); font-weight: 600; }
    .bd__addbtn, .bd__snap {
      flex: 0 0 auto; width: 54px; height: 54px; display: grid; place-items: center;
      border: 1px solid var(--hairline); border-radius: var(--r-tile); background: var(--bg-rise); color: var(--ink); cursor: pointer;
      &:disabled { opacity: .4; cursor: default; }
    }
    .bd__snap { background: linear-gradient(135deg, color-mix(in srgb, var(--accent-a) 22%, var(--bg-rise)), color-mix(in srgb, var(--accent-b) 22%, var(--bg-rise))); }

    .bd__h { margin: 4px 2px -4px; font: 800 12px/1 var(--font-ui); letter-spacing: .08em; text-transform: uppercase; color: var(--ink-dim); }
    .bd__items { display: flex; flex-direction: column; gap: 8px; }

    .bd__taxtip { display: flex; gap: 10px; }
    .bd__stepper {
      flex: 1 1 0; display: flex; align-items: center; justify-content: space-between; gap: 8px;
      min-height: 54px; padding: 0 8px 0 14px; border-radius: var(--r-tile); background: var(--bg-sink);
    }
    .bd__stepper-lbl { font: 600 13px/1 var(--font-ui); color: var(--ink-dim); }
    .bd__stepper-v { font: 600 16px/1 var(--font-display); color: var(--ink); min-width: 56px; text-align: right; }
    .bd__stepper-btns { display: flex; gap: 4px; }
    .bd__stepper-btn {
      width: 40px; height: 40px; display: grid; place-items: center;
      border: 1px solid var(--hairline); border-radius: 10px; background: var(--bg-rise); color: var(--ink);
      font-size: 18px; cursor: pointer;
    }

    .bd__total { display: flex; align-items: baseline; justify-content: space-between; padding: 4px 4px 0; }
    .bd__total-lbl { font: 700 13px/1 var(--font-ui); color: var(--ink-dim); text-transform: uppercase; letter-spacing: .06em; }
    .bd__total-v { font: 600 28px/1 var(--font-display); letter-spacing: -.02em; color: var(--ink); }

    .bd__rail {
      display: flex; gap: 12px; overflow-x: auto; overflow-y: hidden;
      scroll-snap-type: x mandatory; overscroll-behavior-x: contain; -webkit-overflow-scrolling: touch;
      scrollbar-width: none; padding: 2px;
      &::-webkit-scrollbar { display: none; }
    }

    .bd__noitems {
      display: flex; flex-direction: column; align-items: center; gap: 8px; text-align: center;
      padding: 22px; color: var(--ink-dim);
      mat-icon { font-size: 34px; width: 34px; height: 34px; opacity: .6; }
      p { margin: 0; font-size: 13px; }
    }

    .bd__share { display: flex; align-items: center; gap: 10px; padding-top: 2px; }
    .bd__share-btn {
      flex: 1 1 auto; min-height: 54px; display: flex; align-items: center; justify-content: center; gap: 8px;
      border: none; border-radius: var(--r-pill);
      background: linear-gradient(135deg, var(--accent-a), var(--accent-b)); color: var(--on-accent, #2a2410);
      font: 700 15px/1 var(--font-ui); cursor: pointer; box-shadow: var(--lift-1);
    }
    .bd__share-btn.is-active {
      background: color-mix(in srgb, var(--signal) 18%, var(--bg-rise)); color: var(--signal);
      border: 1px solid color-mix(in srgb, var(--signal) 40%, transparent); box-shadow: none;
    }
    .bd__share-ic {
      flex: 0 0 auto; width: 54px; height: 54px; display: grid; place-items: center;
      border: 1px solid var(--hairline); border-radius: var(--r-pill); background: var(--bg-rise); color: var(--ink); cursor: pointer;
    }

    .bd__settle {
      display: flex; align-items: center; justify-content: center; gap: 8px;
      min-height: 50px; border-radius: var(--r-pill);
      border: 1px solid var(--hairline); background: var(--bg-sink); color: var(--ink-dim);
      font: 700 14px/1 var(--font-ui); cursor: pointer; margin-bottom: 6px;
      mat-icon { font-size: 19px; width: 19px; height: 19px; }
    }
    .bd__settle.is-settled { color: var(--signal); border-color: color-mix(in srgb, var(--signal) 30%, transparent); }
  `],
})
export class BillDetailSheet {
  /** Two-way open state, mirrored onto the inner bottom-sheet. */
  readonly open = model<boolean>(false);
  /** The bill being viewed (null hides the body — kept while animating out). */
  readonly bill = input<BillDto | null>(null);
  /** The owner's contacts for the inline claim strip. */
  readonly contacts = input<ChatContactDto[]>([]);
  /** Whether the receipt-snap affordance is offered (ai.vision). */
  readonly canUseVision = input<boolean>(false);
  /** True while the page is writing other items (disable the add button). */
  readonly busy = input<boolean>(false);
  /** Receipt-import progress (drives the determinate bar). */
  readonly importing = input<boolean>(false);
  readonly importDone = input<number>(0);
  readonly importTotal = input<number>(0);

  // ---- emitted mutations / actions (the page owns the Api + optimistic patch) ----
  readonly closed = output<void>();
  readonly titleChange = output<TitleChange>();
  readonly addItem = output<AddItem>();
  readonly settleItem = output<{ bill: BillDto; item: BillItemDto }>();
  readonly deleteItem = output<{ bill: BillDto; item: BillItemDto }>();
  readonly assignItem = output<{ bill: BillDto; change: AssignChange }>();
  readonly bumpTax = output<BumpChange>();
  readonly bumpTip = output<BumpChange>();
  readonly toggleSettled = output<BillDto>();
  readonly snap = output<BillDto>();
  readonly enableShare = output<BillDto>();
  readonly disableShare = output<BillDto>();
  readonly shareLink = output<BillDto>();
  readonly copyShare = output<BillDto>();

  protected readonly newName = signal('');
  protected readonly newAmount = signal<number | null>(null);

  /** Bill list price = items + tax + tip. */
  protected total(b: BillDto): number {
    return b.items.reduce((s, i) => s + i.amount, 0) + (b.taxAmount ?? 0) + (b.tipAmount ?? 0);
  }

  protected commitTitle(b: BillDto, title: string): void {
    const t = title.trim();
    if (!t || t === b.title) return;
    this.titleChange.emit({ bill: b, title: t });
  }

  protected commitAdd(b: BillDto): void {
    const name = this.newName().trim();
    const amount = this.newAmount() ?? 0;
    if (!name || amount <= 0) return;
    this.addItem.emit({ bill: b, name, amount });
    this.newName.set('');
    this.newAmount.set(null);
  }
}
