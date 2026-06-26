import {
  ChangeDetectionStrategy, Component, computed, effect, input, model, output, signal,
} from '@angular/core';
import { CurrencyPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';

import { ChatContactDto } from '../../../core/models';
import { BetaBottomSheet, BetaSegmentedControl, Segment } from '../../beta-ui';

/** One participant's share emitted to the page. `userId` is the assignee contact (null = you / unassigned). */
export interface SplitShare {
  name: string;
  userId: number | null;
  amount: number;
}

/** What the owner approved in the new-bill flow: the bill title + the split lines to write. */
export interface NewBillResult {
  title: string;
  shares: SplitShare[];
}

/** A pickable participant in the sheet (you, plus each contact). `userId: null` is the "You" row. */
interface Participant {
  userId: number | null;
  name: string;
  picture?: string | null;
  initials: string;
  /** Custom-mode per-person amount (only used when mode === 'custom'). */
  custom: number | null;
}

/**
 * Tally NEW-BILL / SPLIT sheet — the polished "we got the check, split it now" flow, in the kit
 * {@link BetaBottomSheet}. A big amount KEYPAD drives the total; a name field titles the bill; a
 * participant strip (You + contact avatars) picks who's in; a {@link BetaSegmentedControl} switches
 * EVEN vs CUSTOM split; and a live per-person share list (with avatars + big numerals) shows the math,
 * flagging any remainder. On confirm it emits a {@link NewBillResult} of split lines for the page to
 * batch-write as the new bill + its items.
 *
 * Pure UI: no Api, no store. Inherits the cream Tally accent tokens from the page `:host`; the BottomSheet
 * + SegmentedControl inherit --glass/--accent-a/etc off the same cascade.
 */
@Component({
  selector: 'app-new-bill-sheet',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CurrencyPipe, FormsModule, MatIconModule, BetaBottomSheet, BetaSegmentedControl],
  template: `
    <app-bs-sheet [(open)]="open" detent="full" label="New bill — split the check" (closed)="onClosed()">
      <div class="nb">
        <h2 class="nb__title">Split the check</h2>

        <!-- Bill name -->
        <input class="nb__name" [ngModel]="name()" (ngModelChange)="name.set($event)"
               placeholder="What's this bill? (e.g. Dinner at Mara's)" aria-label="Bill name"
               autocomplete="off" enterkeyhint="done" />

        <!-- The amount, big -->
        <div class="nb__amt" aria-live="polite">
          <span class="nb__amt-cur">$</span>
          <span class="nb__amt-v">{{ amountStr() }}</span>
        </div>

        <!-- KEYPAD -->
        <div class="nb__pad" role="group" aria-label="Amount keypad">
          @for (k of KEYS; track k) {
            <button type="button" class="nb__key" [class.nb__key--wide]="k === '0'"
                    [class.nb__key--act]="k === '⌫'"
                    (click)="press(k)" [attr.aria-label]="keyLabel(k)">
              @if (k === '⌫') { <mat-icon aria-hidden="true">backspace</mat-icon> } @else { {{ k }} }
            </button>
          }
        </div>

        <!-- Participants -->
        <p class="nb__h">Who's splitting?</p>
        <div class="nb__people" role="group" aria-label="Participants">
          @for (p of participants(); track p.userId ?? -1) {
            <button type="button" class="nb__person" [class.is-on]="picked().has(p.userId)"
                    (click)="toggle(p.userId)"
                    [attr.aria-pressed]="picked().has(p.userId)" [attr.aria-label]="p.name">
              <span class="nb__av">
                @if (p.picture) { <img [src]="p.picture" alt="" /> }
                @else { <span aria-hidden="true">{{ p.initials }}</span> }
                @if (picked().has(p.userId)) { <span class="nb__av-tick" aria-hidden="true"><mat-icon>check</mat-icon></span> }
              </span>
              <span class="nb__person-name">{{ p.userId === null ? 'You' : p.name }}</span>
            </button>
          }
        </div>

        <!-- Split mode -->
        <div class="nb__mode">
          <app-bs-segmented [segments]="MODES" [(value)]="mode" label="Split mode" />
        </div>

        <!-- Per-person shares -->
        <ul class="nb__shares">
          @for (s of shareRows(); track s.userId ?? -1) {
            <li class="nb__share">
              <span class="nb__share-av" [style.--av]="s.color">{{ s.initials }}</span>
              <span class="nb__share-name">{{ s.name }}</span>
              @if (mode() === 'custom') {
                <span class="nb__share-input">
                  <span class="nb__share-cur">$</span>
                  <input type="number" min="0" step="0.01" inputmode="decimal"
                         [ngModel]="s.amount" (ngModelChange)="setCustom(s.userId, $event)"
                         [attr.aria-label]="'Amount for ' + s.name" />
                </span>
              } @else {
                <span class="nb__share-amt">{{ s.amount | currency: 'USD' }}</span>
              }
            </li>
          }
          @if (!shareRows().length) {
            <li class="nb__share nb__share--hint">Pick at least one person to split with.</li>
          }
        </ul>

        <!-- Remainder / reconcile line -->
        <div class="nb__sum" [class.nb__sum--off]="remainder() !== 0">
          <span>{{ remainder() === 0 ? 'Splits evenly' : (remainder() > 0 ? 'Left to assign' : 'Over by') }}</span>
          <span class="nb__sum-v">{{ absRemainder() | currency: 'USD' }}</span>
        </div>

        <div class="nb__actions">
          <button type="button" class="nb__btn nb__btn--ghost" (click)="cancel()">Cancel</button>
          <button type="button" class="nb__btn nb__btn--primary" [disabled]="!canSave()" (click)="save()">
            Create bill
          </button>
        </div>
      </div>
    </app-bs-sheet>
  `,
  styles: [`
    .nb { display: flex; flex-direction: column; gap: 14px; padding-top: 4px; color: var(--ink); }
    .nb__title { margin: 0; font-family: var(--font-display); font-weight: 600; font-size: 22px; color: var(--ink); }

    .nb__name {
      min-height: 50px; padding: 0 16px; border-radius: var(--r-tile);
      border: 1px solid var(--hairline); background: var(--bg-sink); color: var(--ink);
      font: 600 15px/1 var(--font-ui); outline: none;
    }
    .nb__name::placeholder { color: var(--ink-faint); }
    .nb__name:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }

    .nb__amt {
      display: flex; align-items: baseline; justify-content: center; gap: 6px;
      padding: 6px 0 2px;
    }
    .nb__amt-cur { font-family: var(--font-display); font-weight: 600; font-size: 26px; color: var(--ink-dim); }
    .nb__amt-v {
      font-family: var(--font-display); font-variant-numeric: tabular-nums;
      font-weight: 600; font-size: 52px; line-height: 1; letter-spacing: -.03em; color: var(--ink);
    }

    .nb__pad { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
    .nb__key {
      min-height: 54px; border-radius: var(--r-tile);
      border: 1px solid var(--hairline); background: var(--bg-rise); color: var(--ink);
      font-family: var(--font-display); font-weight: 600; font-size: 22px; cursor: pointer;
      transition: transform 90ms var(--ease-spring), background 120ms var(--ease-out);
      -webkit-tap-highlight-color: transparent;
    }
    .nb__key:active { transform: scale(.95); background: var(--bg-sink); }
    .nb__key:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
    .nb__key--wide { grid-column: span 1; }
    .nb__key--act { color: var(--ink-dim); }
    .nb__key--act mat-icon { font-size: 22px; width: 22px; height: 22px; }

    .nb__h { margin: 4px 0 -4px; font-size: 12px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; color: var(--ink-dim); }

    .nb__people {
      display: flex; gap: 12px; overflow-x: auto; overflow-y: hidden; padding: 4px 2px;
      scrollbar-width: none; -webkit-overflow-scrolling: touch;
    }
    .nb__people::-webkit-scrollbar { display: none; }
    .nb__person {
      flex: 0 0 auto; display: flex; flex-direction: column; align-items: center; gap: 6px;
      width: 60px; border: none; background: transparent; cursor: pointer; padding: 0;
      color: var(--ink-dim);
    }
    .nb__person.is-on { color: var(--ink); }
    .nb__person:focus-visible { outline: 2px solid var(--focus); outline-offset: 3px; border-radius: 12px; }
    .nb__av {
      position: relative; display: grid; place-items: center; width: 50px; height: 50px;
      border-radius: 50%; border: 2px solid var(--hairline); background: var(--bg-sink); overflow: hidden;
      font: 800 15px/1 var(--font-ui); color: var(--ink-dim);
      transition: border-color 140ms var(--ease-out);
      img { width: 100%; height: 100%; object-fit: cover; }
    }
    .nb__person.is-on .nb__av { border-color: var(--accent-b); }
    .nb__av-tick {
      position: absolute; inset: 0; display: grid; place-items: center;
      background: color-mix(in srgb, var(--accent-a) 60%, transparent);
      color: var(--on-accent, #2a2410);
      mat-icon { font-size: 24px; width: 24px; height: 24px; }
    }
    .nb__person-name {
      font-size: 12px; font-weight: 700; max-width: 60px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }

    .nb__mode { padding: 2px 0; }

    .nb__shares { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
    .nb__share {
      display: flex; align-items: center; gap: 10px;
      min-height: 48px; padding: 6px 12px; border-radius: var(--r-tile);
      background: var(--bg-rise); border: 1px solid var(--hairline);
    }
    .nb__share--hint { justify-content: center; color: var(--ink-dim); font-size: 13px; font-weight: 600; }
    .nb__share-av {
      flex: 0 0 auto; display: grid; place-items: center; width: 30px; height: 30px;
      border-radius: 50%; background: var(--av, var(--accent-a)); color: #1a160a; font: 800 11px/1 var(--font-ui);
    }
    .nb__share-name {
      flex: 1 1 auto; min-width: 0; font-size: 14px; font-weight: 600; color: var(--ink);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .nb__share-amt { flex: 0 0 auto; font-family: var(--font-display); font-weight: 600; font-size: 18px; color: var(--ink); }
    .nb__share-input { position: relative; display: flex; align-items: center; }
    .nb__share-cur { position: absolute; left: 10px; color: var(--ink-dim); font: 600 13px/1 var(--font-display); pointer-events: none; }
    .nb__share-input input {
      width: 96px; min-height: 40px; padding: 0 10px 0 22px; text-align: right;
      border-radius: 10px; border: 1px solid var(--hairline); background: var(--bg-sink); color: var(--ink);
      font-family: var(--font-display); font-weight: 600; font-size: 16px; outline: none;
    }
    .nb__share-input input:focus-visible { outline: 2px solid var(--focus); }

    .nb__sum {
      display: flex; align-items: center; justify-content: space-between;
      padding: 6px 4px 0; font-size: 13px; font-weight: 700; color: var(--ink-dim);
    }
    .nb__sum--off { color: var(--warn); }
    .nb__sum-v { font-family: var(--font-display); font-weight: 600; font-size: 16px; }

    .nb__actions { display: flex; gap: 10px; padding-top: 6px; }
    .nb__btn {
      flex: 1 1 0; min-height: 54px; border-radius: var(--r-pill);
      font: 700 15px/1 var(--font-ui); cursor: pointer; border: 1px solid var(--hairline);
      transition: transform 120ms var(--ease-spring);
    }
    .nb__btn:active { transform: scale(.97); }
    .nb__btn--ghost { background: var(--bg-sink); color: var(--ink); }
    .nb__btn--primary {
      background: linear-gradient(135deg, var(--accent-a), var(--accent-b));
      color: var(--on-accent, #2a2410); border: none; box-shadow: var(--lift-2);
    }
    .nb__btn--primary:disabled { opacity: .42; cursor: default; box-shadow: none; }
  `],
})
export class NewBillSheet {
  /** Two-way open state, mirrored onto the inner bottom-sheet. */
  readonly open = model<boolean>(false);
  /** The owner's contacts available as split participants. */
  readonly contacts = input<ChatContactDto[]>([]);

  /** Emitted with the split lines when the owner taps "Create bill". */
  readonly confirmed = output<NewBillResult>();
  /** Emitted when the sheet is dismissed without saving. */
  readonly cancelled = output<void>();

  protected readonly KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '⌫'] as const;
  protected readonly MODES: Segment[] = [
    { key: 'even', label: 'Split evenly' },
    { key: 'custom', label: 'Custom' },
  ];

  /** Avatar/segment palette mirrors the bill card so the visual identity is consistent. */
  private static readonly PALETTE = ['#e8d9a8', '#9ad7c2', '#f0b27a', '#a8c5e8', '#d9a8d2', '#c2d99a'];

  protected readonly name = signal('');
  /** The amount as a raw cents-string the keypad edits (so leading zeros / decimals stay intuitive). */
  protected readonly amountStr = signal('0');
  protected readonly mode = model<string>('even');

  /** Selected participant userIds (null = you). */
  protected readonly picked = signal<ReadonlySet<number | null>>(new Set([null]));
  /** Custom per-person overrides keyed by userId (null = you). */
  private readonly customAmounts = signal<Map<number | null, number>>(new Map());

  constructor() {
    // Reset the form to a clean slate every time the sheet (re)opens.
    effect(() => {
      if (this.open()) {
        this.name.set('');
        this.amountStr.set('0');
        this.mode.set('even');
        this.picked.set(new Set([null]));
        this.customAmounts.set(new Map());
        this.committed = false;
      }
    });
  }

  private committed = false;

  /** Numeric total parsed from the keypad string. */
  protected readonly amount = computed(() => {
    const n = parseFloat(this.amountStr());
    return Number.isFinite(n) ? n : 0;
  });

  /** You + every contact, as pickable participants. */
  protected readonly participants = computed<Participant[]>(() => {
    const you: Participant = { userId: null, name: 'You', initials: 'You', picture: null, custom: null };
    const rest = this.contacts().map(c => ({
      userId: c.userId, name: c.name, picture: c.picture, initials: this.initials(c.name), custom: null,
    }));
    return [you, ...rest];
  });

  /** Just the picked participants (preserving the participant order). */
  private readonly chosen = computed(() =>
    this.participants().filter(p => this.picked().has(p.userId)));

  /** The live per-person share rows the template renders (with palette color + computed amount). */
  protected readonly shareRows = computed(() => {
    const chosen = this.chosen();
    const n = chosen.length || 1;
    const even = Math.round((this.amount() / n) * 100) / 100;
    const custom = this.customAmounts();
    return chosen.map((p, i) => ({
      userId: p.userId,
      name: p.userId === null ? 'You' : p.name,
      initials: p.userId === null ? this.initials('You') : p.initials,
      color: NewBillSheet.PALETTE[i % NewBillSheet.PALETTE.length],
      amount: this.mode() === 'custom' ? (custom.get(p.userId) ?? 0) : even,
    }));
  });

  /** Total minus the sum of shares (positive = left to assign, negative = over). */
  protected readonly remainder = computed(() => {
    const assigned = this.shareRows().reduce((s, r) => s + r.amount, 0);
    return Math.round((this.amount() - assigned) * 100) / 100;
  });
  protected readonly absRemainder = computed(() => Math.abs(this.remainder()));

  /** Saveable once there's a positive total, at least one person, and (custom) the math reconciles. */
  protected readonly canSave = computed(() => {
    if (this.amount() <= 0) return false;
    if (!this.shareRows().length) return false;
    if (this.mode() === 'custom') return Math.abs(this.remainder()) < 0.01;
    return true;
  });

  // ---- keypad ----
  protected press(k: string): void {
    if (k === '⌫') {
      const s = this.amountStr();
      this.amountStr.set(s.length <= 1 ? '0' : s.slice(0, -1));
      return;
    }
    let s = this.amountStr();
    if (k === '.') {
      if (s.includes('.')) return;
      this.amountStr.set(s + '.');
      return;
    }
    // digit: drop a sole leading zero; cap to 2 decimals.
    if (s === '0') s = '';
    if (s.includes('.') && s.split('.')[1].length >= 2) return;
    if (s.replace('.', '').length >= 8) return; // sane ceiling
    this.amountStr.set((s + k) || '0');
  }

  protected keyLabel(k: string): string {
    if (k === '⌫') return 'Delete';
    if (k === '.') return 'Decimal point';
    return k;
  }

  // ---- participants ----
  protected toggle(userId: number | null): void {
    this.picked.update(set => {
      const next = new Set(set);
      if (next.has(userId)) next.delete(userId); else next.add(userId);
      // Never allow an empty split.
      if (next.size === 0) next.add(null);
      return next;
    });
  }

  protected setCustom(userId: number | null, v: number | null): void {
    this.customAmounts.update(m => {
      const next = new Map(m);
      next.set(userId, Math.max(0, v ?? 0));
      return next;
    });
  }

  protected save(): void {
    if (!this.canSave()) return;
    this.committed = true;
    const title = this.name().trim() || 'New bill';
    const shares: SplitShare[] = this.shareRows()
      .filter(r => r.amount > 0)
      .map(r => ({ name: r.name, userId: r.userId, amount: Math.round(r.amount * 100) / 100 }));
    this.confirmed.emit({ title, shares });
    this.open.set(false);
  }

  protected cancel(): void {
    this.open.set(false);
  }

  protected onClosed(): void {
    if (!this.committed) this.cancelled.emit();
    this.committed = false;
  }

  private initials(name: string): string {
    return name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]!.toUpperCase()).join('') || '?';
  }
}
