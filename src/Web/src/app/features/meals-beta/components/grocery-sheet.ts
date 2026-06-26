import { ChangeDetectionStrategy, Component, computed, inject, output, signal } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { firstValueFrom } from 'rxjs';

import { Api } from '../../../core/api';
import { FamilyList, FamilyListItem } from '../../../core/models';
import { BetaBottomSheet, BetaSkeleton } from '../../beta-ui';

/**
 * Forage GrocerySheet — the one-tap "add to grocery" hand-off destination: a CHECKABLE grocery list in a
 * BetaBottomSheet. Loads the household's Groceries list via the EXISTING `familyLists`, lets the user tick
 * items off with optimistic `patchFamilyListItem` (revert on failure), and shows a live "N left" header
 * ring. Open / done counts drive a progress bar. No new endpoint — pure reuse of the F1 list API.
 *
 * The page calls `loadList()` (after a meals-to-grocery hand-off) then opens this; this sheet owns the
 * fetched list + the optimistic ticking. Reads --accent-a/--accent-b off the host.
 */
@Component({
  selector: 'app-forage-grocery-sheet',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, BetaBottomSheet, BetaSkeleton],
  template: `
    <app-bs-sheet [(open)]="open" detent="full" label="Grocery list" (closed)="onClosed()">
      <div class="gs">
        <header class="gs-head">
          <div class="gs-head-txt">
            <h2 class="gs-title">{{ list()?.name || 'Groceries' }}</h2>
            <p class="gs-sub">
              @if (loading()) { Loading… }
              @else if (total() === 0) { Nothing here yet }
              @else { {{ openCount() }} left · {{ doneCount() }} done }
            </p>
          </div>
          @if (total() > 0) {
            <div class="gs-prog" aria-hidden="true">
              <svg viewBox="0 0 44 44" class="gs-prog-svg">
                <circle class="gs-prog-track" cx="22" cy="22" r="18" fill="none" stroke-width="5" />
                <circle class="gs-prog-arc" cx="22" cy="22" r="18" fill="none" stroke-width="5"
                        stroke-linecap="round" transform="rotate(-90 22 22)"
                        [attr.stroke-dasharray]="CIRC" [attr.stroke-dashoffset]="arc()" />
              </svg>
              <span class="gs-prog-pct">{{ pct() }}<i>%</i></span>
            </div>
          }
        </header>

        @if (loading()) {
          <div class="gs-skel">
            @for (s of [0,1,2,3,4]; track s) { <app-bs-skeleton height="48px" radius="14px" /> }
          </div>
        } @else if (total() === 0) {
          <div class="gs-empty">
            <mat-icon aria-hidden="true">shopping_cart</mat-icon>
            <p>Your grocery list is empty. Add a meal's ingredients to fill it up.</p>
          </div>
        } @else {
          <ul class="gs-list" role="list">
            @for (it of items(); track it.id) {
              <li class="gs-item" [class.is-done]="it.done">
                <button type="button" class="gs-row" (click)="toggle(it)"
                        [attr.aria-pressed]="it.done"
                        [attr.aria-label]="(it.done ? 'Uncheck ' : 'Check ') + it.text">
                  <span class="gs-box" [class.on]="it.done" aria-hidden="true">
                    @if (it.done) { <mat-icon>check</mat-icon> }
                  </span>
                  <span class="gs-text">{{ it.text }}</span>
                  @if (it.done && it.doneByName) { <span class="gs-by">{{ it.doneByName }}</span> }
                </button>
              </li>
            }
          </ul>
        }
      </div>
    </app-bs-sheet>
  `,
  styles: [`
    :host { display: contents; }
    .gs { display: flex; flex-direction: column; gap: 14px; padding-top: 4px; }
    .gs-head { display: flex; align-items: center; gap: 12px; }
    .gs-head-txt { flex: 1 1 auto; min-width: 0; }
    .gs-title {
      margin: 0; font-family: var(--font-display); font-weight: 600; font-size: 22px; color: var(--ink);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .gs-sub { margin: 2px 0 0; font-size: 13px; font-weight: 600; color: var(--ink-dim); }

    .gs-prog { position: relative; flex: 0 0 auto; width: 44px; height: 44px; display: grid; place-items: center; }
    .gs-prog-svg { width: 44px; height: 44px; }
    .gs-prog-track { stroke: var(--hairline); }
    .gs-prog-arc { stroke: var(--accent-a); transition: stroke-dashoffset 500ms var(--ease-spring); }
    .gs-prog-pct {
      position: absolute; font-family: var(--font-display); font-variant-numeric: tabular-nums;
      font-size: 13px; font-weight: 600; color: var(--ink);
    }
    .gs-prog-pct i { font-family: var(--font-ui); font-style: normal; font-size: 9px; color: var(--ink-dim); }
    @media (prefers-reduced-motion: reduce) { .gs-prog-arc { transition: none; } }

    .gs-skel { display: flex; flex-direction: column; gap: 8px; }
    .gs-empty {
      display: flex; flex-direction: column; align-items: center; text-align: center; gap: 10px;
      padding: 30px 16px; color: var(--ink-dim);
    }
    .gs-empty mat-icon { font-size: 36px; width: 36px; height: 36px; color: var(--ink-faint); }
    .gs-empty p { margin: 0; font-size: 14px; max-width: 26ch; }

    .gs-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
    .gs-item { border-radius: 14px; }
    .gs-row {
      display: flex; align-items: center; gap: 12px; width: 100%; text-align: left;
      padding: 11px 12px; min-height: 48px; border: 1px solid var(--hairline);
      background: var(--bg-rise); border-radius: 14px; color: var(--ink);
      cursor: pointer; -webkit-tap-highlight-color: transparent; touch-action: manipulation;
      transition: opacity 160ms var(--ease-out), background 160ms var(--ease-out);
    }
    .gs-row:active { background: var(--bg-sink); }
    .gs-row:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
    .gs-item.is-done .gs-row { opacity: .6; }

    .gs-box {
      flex: 0 0 auto; display: grid; place-items: center; width: 24px; height: 24px; border-radius: 8px;
      border: 2px solid var(--ink-faint); color: #07140d;
      transition: background 160ms var(--ease-out), border-color 160ms var(--ease-out);
    }
    .gs-box.on { background: linear-gradient(135deg, var(--accent-a), var(--accent-b)); border-color: transparent; }
    .gs-box mat-icon { font-size: 17px; width: 17px; height: 17px; }
    .gs-text { flex: 1 1 auto; min-width: 0; font-size: 15px; font-weight: 600; }
    .gs-item.is-done .gs-text { text-decoration: line-through; color: var(--ink-dim); }
    .gs-by { flex: 0 0 auto; font-size: 11px; font-weight: 700; color: var(--ink-faint); }
  `],
})
export class ForageGrocerySheet {
  private readonly api = inject(Api);

  /** Two-way open state, owned by the page. */
  readonly open = signal(false);
  /** Emitted when an item's done-state was successfully toggled (so the page can re-toast counts if it wants). */
  readonly changed = output<void>();

  protected readonly list = signal<FamilyList | null>(null);
  protected readonly loading = signal(false);

  protected readonly CIRC = 2 * Math.PI * 18;

  protected readonly items = computed<FamilyListItem[]>(() => {
    const l = this.list();
    if (!l) return [];
    // Open items first (most actionable), then done — stable within each by sortOrder.
    return [...l.items].sort((a, b) =>
      a.done === b.done ? a.sortOrder - b.sortOrder : a.done ? 1 : -1);
  });
  protected readonly total = computed(() => this.list()?.items.length ?? 0);
  protected readonly doneCount = computed(() => this.list()?.items.filter(i => i.done).length ?? 0);
  protected readonly openCount = computed(() => this.total() - this.doneCount());
  protected readonly pct = computed(() => {
    const t = this.total();
    return t === 0 ? 0 : Math.round((this.doneCount() / t) * 100);
  });
  protected readonly arc = computed(() => this.CIRC * (1 - this.pct() / 100));

  protected onClosed(): void { /* page clears its own open flag via two-way */ }

  /**
   * Load (or refresh) the household's Groceries list. Picks the shopping list whose name matches
   * /groceries/i, else the first shopping list — the same find rule the live planner uses. Best-effort.
   */
  async loadList(): Promise<void> {
    this.loading.set(true);
    try {
      const lists = await firstValueFrom(this.api.familyLists());
      const groceries =
        lists.find(l => l.kind === 'shopping' && /groceries/i.test(l.name)) ??
        lists.find(l => l.kind === 'shopping') ??
        null;
      this.list.set(groceries);
    } catch {
      this.list.set(null);
    } finally {
      this.loading.set(false);
    }
  }

  /** Optimistically flip an item's done-state; revert + reload on failure. */
  protected async toggle(item: FamilyListItem): Promise<void> {
    const l = this.list();
    if (!l || !l.canEdit) return;
    const next = !item.done;
    // Optimistic local flip.
    this.list.set({ ...l, items: l.items.map(i => i.id === item.id ? { ...i, done: next } : i) });
    try {
      const updated = await firstValueFrom(this.api.patchFamilyListItem(l.id, item.id, { done: next }));
      this.list.set(updated);
      this.changed.emit();
    } catch {
      // Revert: re-fetch the authoritative list.
      void this.loadList();
    }
  }
}
