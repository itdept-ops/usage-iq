import {
  ChangeDetectionStrategy, Component, computed, inject, input, signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';

import { FamilyToday, FamilyTodayList } from '../../../core/models';
import { HearthCard, HearthPhase } from './hearth-card';
import { OptimisticFamily } from '../state/optimistic-family';

/**
 * Hearth "Lists" glance card — each shopping / to-do list with its open count and the first couple of
 * still-open items, plus a one-tap add-item box per list. The glance data comes from the page-owned
 * `today` snapshot (`today.lists` carries openCount + firstFewOpenItems); add-item posts via the existing
 * fast-action endpoint through {@link OptimisticFamily} (the new item shows provisionally and reconciles).
 * Deep-links to the live `/family/lists`.
 *
 * `loading` is passed from the page (whether the shared snapshot has resolved) so this card shows the same
 * skeleton/empty/failed lifecycle as the self-loading cards without owning a duplicate network call.
 */
@Component({
  selector: 'fb-lists-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HearthCard, FormsModule, MatIconModule],
  template: `
    <fb-hearth-card
      title="Lists" route="/family/lists" accentVar="--list"
      [phase]="phase()" emptyText="No lists yet — start one in Lists.">

      @if (phase() === 'ready') {
        <div body class="lists">
          @for (l of lists(); track l.id) {
            <div class="lst">
              <div class="lst__head">
                <mat-icon class="lst__icon" aria-hidden="true">{{ l.kind === 'shopping' ? 'shopping_cart' : 'checklist' }}</mat-icon>
                <span class="lst__name">{{ l.name }}</span>
                <span class="lst__count">{{ l.openCount }} open</span>
              </div>
              @if (l.firstFewOpenItems.length) {
                <ul class="lst__peek">
                  @for (it of l.firstFewOpenItems.slice(0, 2); track it) { <li>{{ it }}</li> }
                </ul>
              }
              <form class="add" (submit)="add(l, $event)">
                <input class="add__input" type="text" [(ngModel)]="drafts[l.id]" name="draft{{ l.id }}"
                       [placeholder]="'Add to ' + l.name" [attr.aria-label]="'Add an item to ' + l.name"
                       autocomplete="off" enterkeyhint="done" />
                <button type="submit" class="add__btn" [disabled]="!draftFor(l.id)"
                        [attr.aria-label]="'Add item to ' + l.name">
                  <mat-icon aria-hidden="true">add</mat-icon>
                </button>
              </form>
            </div>
          }
        </div>
      }
    </fb-hearth-card>
  `,
  styles: [`
    .lists { display: flex; flex-direction: column; gap: 14px; }
    .lst { display: flex; flex-direction: column; gap: 6px; }
    .lst + .lst { padding-top: 12px; border-top: 1px solid var(--glass-edge); }
    .lst__head { display: flex; align-items: center; gap: 8px; }
    .lst__icon { flex: 0 0 auto; color: var(--list); font-size: 20px; width: 20px; height: 20px; }
    .lst__name { font-size: 15px; font-weight: 600; color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .lst__count {
      margin-left: auto; flex: 0 0 auto; font-size: 12px; font-weight: 700;
      padding: 2px 8px; border-radius: 999px;
      background: color-mix(in srgb, var(--list) 18%, transparent); color: var(--list);
    }
    .lst__peek { list-style: none; margin: 0; padding: 0 0 0 28px; display: flex; flex-direction: column; gap: 2px; }
    .lst__peek li { font-size: 13px; color: var(--ink-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    .add { display: flex; gap: 8px; margin-top: 2px; }
    .add__input {
      flex: 1 1 auto; min-width: 0; min-height: 44px; padding: 0 14px;
      border-radius: var(--r-pill, 999px); border: 1px solid var(--glass-edge);
      background: var(--bg-base); color: var(--ink); font: inherit; font-size: 14px;
    }
    .add__input::placeholder { color: var(--ink-faint, var(--ink-dim)); }
    .add__input:focus-visible { outline: 2px solid var(--list); outline-offset: 1px; }
    .add__btn {
      flex: 0 0 auto; display: grid; place-items: center; width: 44px; height: 44px;
      border-radius: 999px; border: none; cursor: pointer;
      background: var(--list); color: #0a0f14;
    }
    .add__btn:disabled { opacity: .4; cursor: default; }
    .add__btn:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
  `],
})
export class ListsCard {
  private readonly optimistic = inject(OptimisticFamily);

  /** The shared Today snapshot (page-owned, best-effort). */
  readonly today = input<FamilyToday | null>(null);
  /** Whether the shared snapshot is still loading (page-owned). */
  readonly loading = input<boolean>(true);
  /** Whether the shared snapshot load failed (page-owned). */
  readonly failed = input<boolean>(false);

  /** Per-list add-item drafts, keyed by list id. */
  readonly drafts: Record<number, string> = {};

  readonly lists = computed<FamilyTodayList[]>(() => this.today()?.lists ?? []);

  readonly phase = computed<HearthPhase>(() => {
    if (this.loading()) return 'loading';
    if (this.failed()) return 'failed';
    return this.lists().length ? 'ready' : 'empty';
  });

  draftFor(id: number): string {
    return (this.drafts[id] ?? '').trim();
  }

  /** Add the drafted item to the list via the fast-action endpoint (optimistic; clears the box on send). */
  async add(l: FamilyTodayList, ev: Event): Promise<void> {
    ev.preventDefault();
    const text = this.draftFor(l.id);
    if (!text) return;
    this.drafts[l.id] = '';
    const retry = () => { this.drafts[l.id] = text; };
    await this.optimistic.addListItem(l.id, text, /* rollback */ retry, retry);
    // The list page reconciles full state on next visit; here the open count is refreshed when the page
    // re-pulls the snapshot (pull-to-refresh / day-rollover). The optimistic contract restores the draft
    // on failure so the user can retry inline.
  }
}
