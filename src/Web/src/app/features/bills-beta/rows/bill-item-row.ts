import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { CurrencyPipe } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';

import { BillItemDto, ChatContactDto } from '../../../core/models';
import { BetaSwipeRow } from '../../beta-ui';

/** Emitted when the user picks (or clears) who an item is assigned to. `userId: null` = open for claiming. */
export interface AssignChange {
  item: BillItemDto;
  userId: number | null;
}

/**
 * Tally claim-first item row — REBUILT on the shared beta-ui foundation. A 48px+ tappable row wrapped in
 * the kit {@link BetaSwipeRow} (swipe LEFT to delete, swipe RIGHT to settle). Tapping the row expands an
 * inline contact-avatar strip so the owner assigns the item to a contact (or "Open" to clear) WITHOUT a
 * per-item dialog. A settle toggle and the amount sit on the right; claimed/settled items get the green
 * signal ink.
 *
 * Pure presentation + gesture: all writes are emitted to the page, which owns the optimistic patch +
 * reconcile. Inherits the cream Tally accent tokens from the page `:host`; BetaSwipeRow inherits
 * --r-tile/--warn/--accent-a etc off the same cascade.
 */
@Component({
  selector: 'app-bill-item-row',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CurrencyPipe, MatIconModule, BetaSwipeRow],
  template: `
    <app-bs-swipe-row [label]="item().name" leftLabel="Delete" rightLabel="Settle"
                      [leftDestructive]="true" (swipe)="onSwipe($event)">
      <div class="bir">
        <div class="bir__main" (click)="expanded.set(!expanded())"
             role="button" tabindex="0"
             (keydown.enter)="expanded.set(!expanded())" (keydown.space)="expanded.set(!expanded()); $event.preventDefault()"
             [attr.aria-expanded]="expanded()"
             [attr.aria-label]="'Assign ' + item().name">
          <button type="button" class="bir__check" [class.is-on]="item().settled"
                  (click)="$event.stopPropagation(); settle.emit(item())"
                  [attr.aria-label]="(item().settled ? 'Mark unsettled: ' : 'Mark settled: ') + item().name">
            <mat-icon aria-hidden="true">{{ item().settled ? 'check_circle' : 'radio_button_unchecked' }}</mat-icon>
          </button>

          <div class="bir__body">
            <span class="bir__name" [class.is-settled]="item().settled">{{ item().name }}</span>
            <span class="bir__who" [class.is-claimed]="claimedLabel()">{{ claimedLabel() || 'Tap to claim' }}</span>
          </div>

          <span class="bir__amt">{{ item().amount | currency: 'USD' }}</span>
          <mat-icon class="bir__chev" aria-hidden="true">{{ expanded() ? 'expand_less' : 'expand_more' }}</mat-icon>
        </div>

        @if (expanded()) {
          <div class="bir__claimstrip" role="listbox" [attr.aria-label]="'Assign ' + item().name">
            <button type="button" class="bir__avatar bir__avatar--open"
                    [class.is-sel]="!item().assignedToUserId"
                    (click)="pick(null)" role="option" [attr.aria-selected]="!item().assignedToUserId"
                    aria-label="Open — anyone can claim">
              <mat-icon aria-hidden="true">how_to_reg</mat-icon>
            </button>
            @for (c of contacts(); track c.userId) {
              <button type="button" class="bir__avatar"
                      [class.is-sel]="item().assignedToUserId === c.userId"
                      (click)="pick(c.userId)" role="option"
                      [attr.aria-selected]="item().assignedToUserId === c.userId"
                      [attr.aria-label]="'Assign to ' + c.name">
                @if (c.picture) {
                  <img [src]="c.picture" alt="" />
                } @else {
                  <span aria-hidden="true">{{ initials(c.name) }}</span>
                }
              </button>
            }
          </div>
        }
      </div>
    </app-bs-swipe-row>
  `,
  styles: [`
    .bir { background: var(--bg-rise); }
    .bir__main {
      display: flex; align-items: center; gap: 10px;
      min-height: 56px; padding: 8px 12px;
      cursor: pointer;
    }
    .bir__check {
      flex: 0 0 auto; width: 40px; height: 40px;
      display: grid; place-items: center;
      border: none; background: transparent; cursor: pointer;
      color: var(--ink-dim);
      &.is-on { color: var(--signal); }
      mat-icon { font-size: 24px; width: 24px; height: 24px; }
    }
    .bir__body { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .bir__name {
      font: 600 15px/1.2 var(--font-ui); color: var(--ink);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      &.is-settled { color: var(--ink-dim); text-decoration: line-through; }
    }
    .bir__who {
      font: 500 12px/1.2 var(--font-ui); color: var(--ink-dim);
      &.is-claimed { color: var(--signal); }
    }
    .bir__amt { flex: 0 0 auto; font: 600 16px/1 var(--font-display); color: var(--ink); }
    .bir__chev { flex: 0 0 auto; color: var(--ink-dim); font-size: 20px; width: 20px; height: 20px; }

    .bir__claimstrip {
      display: flex; gap: 8px; overflow-x: auto; overflow-y: hidden;
      padding: 4px 12px 12px; scrollbar-width: none;
      -webkit-overflow-scrolling: touch;
      &::-webkit-scrollbar { display: none; }
    }
    .bir__avatar {
      flex: 0 0 auto; width: 44px; height: 44px;
      display: grid; place-items: center;
      border-radius: 50%;
      border: 2px solid var(--hairline);
      background: var(--bg-sink);
      color: var(--ink-dim);
      font: 700 13px/1 var(--font-display);
      cursor: pointer; overflow: hidden; padding: 0;
      img { width: 100%; height: 100%; object-fit: cover; }
      mat-icon { font-size: 20px; width: 20px; height: 20px; }
      &.is-sel { border-color: var(--accent-b); color: var(--accent-b); }
    }
    .bir__avatar--open.is-sel { border-color: var(--ink-dim); color: var(--ink); }
  `],
})
export class BillItemRow {
  /** The line item to render. */
  readonly item = input.required<BillItemDto>();
  /** The owner's contacts for the inline claim strip. */
  readonly contacts = input<ChatContactDto[]>([]);

  /** Toggle this item's settled flag. */
  readonly settle = output<BillItemDto>();
  /** Delete this item (swipe-left). */
  readonly delete = output<BillItemDto>();
  /** Assign / clear who owns this item. */
  readonly assign = output<AssignChange>();

  protected readonly expanded = signal(false);

  /** "Assigned to / Claimed by …" label, or empty when open. */
  protected readonly claimedLabel = computed(() => {
    const it = this.item();
    if (it.assignedToName) return 'For ' + it.assignedToName;
    if (it.claimedByName) return 'Claimed by ' + it.claimedByName;
    return '';
  });

  protected onSwipe(side: 'left' | 'right'): void {
    if (side === 'left') this.delete.emit(this.item());
    else this.settle.emit(this.item());
  }

  protected pick(userId: number | null): void {
    this.assign.emit({ item: this.item(), userId });
    this.expanded.set(false);
  }

  protected initials(name: string): string {
    return name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]!.toUpperCase()).join('') || '?';
  }
}
