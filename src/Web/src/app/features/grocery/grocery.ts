import { Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';

import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';

import { Api } from '../../core/api';
import { FamilyList, FamilyListItem } from '../../core/models';

/**
 * The gated /grocery Tool page (permissionGuard(grocery.use)). A focused, single-list shopping UX over the
 * household's one "Groceries" FamilyList (find-or-create, via /api/grocery). Pulled OUT of the Family Hub
 * into the Tools nav so it's a one-tap shopping companion; the meal-planner → grocery tie-in still lives on
 * the Family meals page and writes to this same list.
 *
 * Capabilities: add an item (quantity-aware — "Milk x2" or a "+2" stepper bumps an existing item's trailing
 * "xN"), check items off (struck through, sorted to the bottom), bump/lower a per-item quantity, delete, and
 * reorder the open items with up/down moves (a dependency-free reorder over the /grocery/reorder endpoint).
 *
 * Every endpoint returns the WHOLE updated list, so each action just replaces the local list signal — no
 * optimistic bookkeeping to drift. Mobile-first: a sticky add bar + a comfortable tap-target list.
 */
@Component({
  selector: 'app-grocery',
  imports: [
    CommonModule, FormsModule, MatIconModule, MatButtonModule, MatCheckboxModule,
    MatProgressSpinnerModule, MatTooltipModule, MatSnackBarModule,
  ],
  templateUrl: './grocery.html',
  styleUrl: './grocery.scss',
})
export class Grocery {
  private api = inject(Api);
  private snack = inject(MatSnackBar);

  /** The household Groceries list (null until the first load resolves / on a hard error). */
  readonly list = signal<FamilyList | null>(null);
  readonly loading = signal(true);
  readonly error = signal(false);

  /** The "add an item" draft. */
  readonly draft = signal('');

  /** Whether a list-level write is in flight (disables the add bar + clear). */
  readonly busy = signal(false);

  /** Per-item in-flight ids (so only the touched row's controls spin/disable). */
  private readonly busyItems = signal<Set<number>>(new Set());

  /** Whether the caller can write to the list (server-authored on the list; false → read-only view). */
  readonly canEdit = computed(() => this.list()?.canEdit ?? false);

  /** Open (unchecked) items, in their stored sort order — the part the user shops from + reorders. */
  readonly openItems = computed<FamilyListItem[]>(() =>
    (this.list()?.items ?? []).filter(i => !i.done).sort((a, b) => a.sortOrder - b.sortOrder));

  /** Checked-off items, sorted to the bottom (most-recently-done feel: keep stored order). */
  readonly doneItems = computed<FamilyListItem[]>(() =>
    (this.list()?.items ?? []).filter(i => i.done).sort((a, b) => a.sortOrder - b.sortOrder));

  readonly openCount = computed(() => this.openItems().length);
  readonly doneCount = computed(() => this.doneItems().length);

  constructor() {
    void this.load();
  }

  // ─────────────────────────────────────────── load ────────────────────────────────────────────

  /** Find-or-create + load the household Groceries list. Any error shows a retry-able error state. */
  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(false);
    try {
      const list = await firstValueFrom(this.api.grocery());
      this.list.set(list);
    } catch {
      this.list.set(null);
      this.error.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  // ─────────────────────────────────────────── helpers ─────────────────────────────────────────

  isItemBusy(id: number): boolean {
    return this.busyItems().has(id);
  }

  private setItemBusy(id: number, on: boolean): void {
    this.busyItems.update(set => {
      const next = new Set(set);
      if (on) next.add(id); else next.delete(id);
      return next;
    });
  }

  /** Strip a trailing "xN" so the row can show the base name + a separate quantity badge. */
  baseName(text: string): string {
    return text.replace(/\s*[xX]\s*\d{1,3}\s*$/, '').trim() || text.trim();
  }

  /** The trailing "xN" quantity on an item's text (1 when none / unparsable). */
  itemQty(text: string): number {
    const m = /\s*[xX]\s*(\d{1,3})\s*$/.exec(text);
    return m ? Math.max(1, parseInt(m[1], 10)) : 1;
  }

  // ─────────────────────────────────────────── actions ─────────────────────────────────────────

  /**
   * Add the draft item (quantity-aware: an embedded "xN" in the text is honoured, and adding a name that's
   * already on the list bumps its quantity). Clears the box on success.
   */
  async add(): Promise<void> {
    const text = this.draft().trim();
    if (!text || this.busy() || !this.canEdit()) return;
    this.busy.set(true);
    try {
      const list = await firstValueFrom(this.api.groceryAddQuantity(text));
      this.list.set(list);
      this.draft.set('');
    } catch {
      this.snack.open("Couldn't add that — try again", 'Dismiss', { duration: 4000 });
    } finally {
      this.busy.set(false);
    }
  }

  /** Bump an item's quantity by +1 (qty-aware add of its base name). */
  async bump(item: FamilyListItem): Promise<void> {
    if (this.isItemBusy(item.id) || !this.canEdit()) return;
    this.setItemBusy(item.id, true);
    try {
      const list = await firstValueFrom(this.api.groceryAddQuantity(this.baseName(item.text), 1));
      this.list.set(list);
    } catch {
      this.snack.open("Couldn't update the quantity — try again", 'Dismiss', { duration: 4000 });
    } finally {
      this.setItemBusy(item.id, false);
    }
  }

  /**
   * Lower an item's quantity by 1. At qty 1 there's nothing lower than "one of it", so this is a no-op (the
   * user deletes to remove it). The API has no "set text" endpoint and the qty-aware add only INCREMENTS, so
   * a decrement is done by deleting the row and re-adding the base name with `qty-1` (which re-composes the
   * "xN"). The re-added item lands at the end of the list — an accepted tradeoff for a rarely-used control.
   */
  async lower(item: FamilyListItem): Promise<void> {
    if (this.isItemBusy(item.id) || !this.canEdit()) return;
    const qty = this.itemQty(item.text);
    if (qty <= 1) return; // nothing below one; use delete to remove
    this.setItemBusy(item.id, true);
    try {
      // Remove the row, then re-add the base name with the decremented quantity (qty-aware add re-composes "xN").
      await firstValueFrom(this.api.groceryDeleteItem(item.id));
      const list = await firstValueFrom(this.api.groceryAddQuantity(this.baseName(item.text), qty - 1));
      this.list.set(list);
    } catch {
      this.snack.open("Couldn't update the quantity — try again", 'Dismiss', { duration: 4000 });
      void this.load(); // re-sync after a partial failure
    } finally {
      this.setItemBusy(item.id, false);
    }
  }

  /** Toggle an item's done flag (checks it off / un-checks it). */
  async toggle(item: FamilyListItem): Promise<void> {
    if (this.isItemBusy(item.id) || !this.canEdit()) return;
    this.setItemBusy(item.id, true);
    try {
      const list = await firstValueFrom(this.api.groceryToggleItem(item.id, !item.done));
      this.list.set(list);
    } catch {
      this.snack.open("Couldn't update that item — try again", 'Dismiss', { duration: 4000 });
    } finally {
      this.setItemBusy(item.id, false);
    }
  }

  /** Delete an item outright. */
  async remove(item: FamilyListItem): Promise<void> {
    if (this.isItemBusy(item.id) || !this.canEdit()) return;
    this.setItemBusy(item.id, true);
    try {
      const list = await firstValueFrom(this.api.groceryDeleteItem(item.id));
      this.list.set(list);
    } catch {
      this.snack.open("Couldn't remove that item — try again", 'Dismiss', { duration: 4000 });
    } finally {
      this.setItemBusy(item.id, false);
    }
  }

  /** Move an open item up/down one slot among the open items, then persist the new order. */
  async move(item: FamilyListItem, dir: -1 | 1): Promise<void> {
    if (this.busy() || !this.canEdit()) return;
    const open = [...this.openItems()];
    const idx = open.findIndex(i => i.id === item.id);
    const target = idx + dir;
    if (idx < 0 || target < 0 || target >= open.length) return;
    [open[idx], open[target]] = [open[target], open[idx]];
    const order = open.map(i => i.id);
    this.busy.set(true);
    try {
      const list = await firstValueFrom(this.api.groceryReorder(order));
      this.list.set(list);
    } catch {
      this.snack.open("Couldn't reorder — try again", 'Dismiss', { duration: 4000 });
    } finally {
      this.busy.set(false);
    }
  }

  /** Clear all checked-off items (delete them one by one, then a single re-sync). */
  async clearDone(): Promise<void> {
    const done = this.doneItems();
    if (done.length === 0 || this.busy() || !this.canEdit()) return;
    this.busy.set(true);
    try {
      for (const it of done) {
        await firstValueFrom(this.api.groceryDeleteItem(it.id));
      }
      await this.load();
      const n = done.length;
      this.snack.open(`Cleared ${n} checked item${n === 1 ? '' : 's'}`, 'OK', { duration: 2500 });
    } catch {
      this.snack.open("Couldn't clear the checked items — try again", 'Dismiss', { duration: 4000 });
      void this.load();
    } finally {
      this.busy.set(false);
    }
  }
}
