import {
  ChangeDetectionStrategy, Component, computed, inject, signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { firstValueFrom } from 'rxjs';

import { Api } from '../../core/api';
import { FamilyList, FamilyListItem } from '../../core/models';
import {
  BetaPullRefresh, BetaSwipeRow, BetaSkeleton, BetaToaster, ToastController,
} from '../beta-ui';

/**
 * Grocery "Cart" — the mobile-first twin of the live /grocery Tool page, rebuilt on the shared beta-ui
 * "Strata" kit (`@use '../beta-ui/beta-kit'`). One signature accent — a fresh GREEN (lime → emerald) —
 * re-skins the whole screen via the per-page accent contract.
 *
 * It's a one-tap shopping companion over the household's single "Groceries" FamilyList (find-or-create,
 * via /api/grocery): an immersive header with a progress ring of items-left, big tap-target rows you check
 * off (struck through + sorted to the bottom), per-item quantity badges, swipe-to-delete (BetaSwipeRow with
 * an Undo toast), a sticky bottom add bar, and a "clear checked" sweep. Pull-to-refresh re-fetches.
 *
 * DATA PARITY: every action calls the SAME /api/grocery methods the live page uses ({@link Api.grocery},
 * {@link Api.groceryAddQuantity}, {@link Api.groceryToggleItem}, {@link Api.groceryDeleteItem}). Every
 * endpoint returns the WHOLE updated list, so each action just replaces the local `list` signal — no
 * optimistic bookkeeping to drift. The quantity-aware add + base-name/qty parsing are copied verbatim from
 * the live grocery.ts so the two surfaces stay in lockstep. This page performs no new data path.
 *
 * ISOLATION: gated by `platform.mobile` + the SAME grocery.use the live route carries; consumes the kit +
 * the shared Api/models only. No live page is imported or modified. Degrades gracefully — loading skeletons,
 * an elevated empty state, and a retry-able error state (the screenshot harness mocks the API → empty data
 * renders cleanly). Mobile-first: 44px+ targets, safe-area insets, centers on desktop.
 */
@Component({
  selector: 'app-grocery-mobile',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './grocery-mobile.page.scss',
  providers: [ToastController],
  imports: [
    FormsModule, MatIconModule,
    BetaPullRefresh, BetaSwipeRow, BetaSkeleton, BetaToaster,
  ],
  template: `
    <!-- ─────────────── PULL-TO-REFRESH OWNS THE SCROLL ─────────────── -->
    <app-bs-pull-refresh class="gm-ptr" [busy]="refreshing()" (refresh)="reload()">
      <div class="gm-scroll" aria-live="polite">

        <!-- ─── IMMERSIVE HEADER: items-left ring + count ─── -->
        <header class="gm-hero">
          @if (loading()) {
            <div class="gm-hero__skel">
              <app-bs-skeleton width="60%" height="26px" radius="var(--r-pill)" />
              <app-bs-skeleton width="40%" height="16px" radius="var(--r-pill)" />
            </div>
          } @else {
            <p class="gm-hero__kicker">
              <mat-icon aria-hidden="true">shopping_cart</mat-icon> Groceries
            </p>

            <div class="gm-hero__ring" aria-hidden="true">
              <svg viewBox="0 0 120 120" class="gm-ring">
                <circle class="gm-ring__track" cx="60" cy="60" r="52" />
                <circle class="gm-ring__fill" cx="60" cy="60" r="52"
                        [style.stroke-dasharray]="ringDash()"
                        [class.is-clear]="totalCount() > 0 && openCount() === 0" />
              </svg>
              <span class="gm-ring__center">
                <span class="gm-ring__n">{{ openCount() }}</span>
                <span class="gm-ring__lbl">{{ openCount() === 1 ? 'item left' : 'items left' }}</span>
              </span>
            </div>

            <h1 class="gm-hero__title">{{ heroTitle() }}</h1>
            @if (doneCount() > 0) {
              <p class="gm-hero__sub">{{ doneCount() }} checked off · {{ totalCount() }} total</p>
            }
          }
        </header>

        @if (loading()) {
          <!-- skeleton list -->
          <div class="gm-list" aria-hidden="true">
            @for (n of skeletonRows; track n) {
              <app-bs-skeleton height="56px" radius="var(--r-tile)" />
            }
          </div>

        } @else if (errored()) {
          <div class="gm-state">
            <span class="gm-state__orb"><mat-icon aria-hidden="true">error_outline</mat-icon></span>
            <h2 class="gm-state__title">Couldn't load your list</h2>
            <p class="gm-state__body">Something went wrong fetching your groceries. Give it another go.</p>
            <button type="button" class="gm-state__cta" (click)="reload()">
              <mat-icon aria-hidden="true">refresh</mat-icon> Try again
            </button>
          </div>

        } @else if (totalCount() === 0) {
          <!-- empty cart -->
          <div class="gm-state gm-state--empty">
            <span class="gm-state__orb"><mat-icon aria-hidden="true">add_shopping_cart</mat-icon></span>
            <h2 class="gm-state__title">Your cart's empty</h2>
            <p class="gm-state__body">Add what you need below — tap a row to check it off as you shop.</p>
          </div>

        } @else {
          <!-- ─── OPEN ITEMS: tap to check off, swipe to delete ─── -->
          @if (openItems().length) {
            <section class="gm-group">
              <div class="gm-group__head">
                <h2 class="gm-group__title">To get</h2>
                <span class="gm-group__count">{{ openItems().length }}</span>
              </div>
              <div class="gm-list">
                @for (it of openItems(); track it.id) {
                  <app-bs-swipe-row leftLabel="Delete" [disabled]="!canEdit() || isItemBusy(it.id)"
                                    [label]="baseName(it.text)" (delete)="remove(it)">
                    <button type="button" class="gm-row"
                            [class.is-busy]="isItemBusy(it.id)"
                            [disabled]="!canEdit() || isItemBusy(it.id)"
                            (click)="toggle(it)"
                            [attr.aria-label]="'Check off ' + baseName(it.text)">
                      <span class="gm-row__box" aria-hidden="true"></span>
                      <span class="gm-row__name">{{ baseName(it.text) }}</span>
                      @if (itemQty(it.text) > 1) {
                        <span class="gm-row__qty" aria-hidden="true">×{{ itemQty(it.text) }}</span>
                      }
                    </button>
                  </app-bs-swipe-row>
                }
              </div>
            </section>
          }

          <!-- ─── CHECKED ITEMS: struck through, with a clear-all sweep ─── -->
          @if (doneItems().length) {
            <section class="gm-group gm-group--done">
              <div class="gm-group__head">
                <h2 class="gm-group__title">In the cart</h2>
                @if (canEdit()) {
                  <button type="button" class="gm-clear" [disabled]="busy()" (click)="clearDone()">
                    <mat-icon aria-hidden="true">delete_sweep</mat-icon> Clear
                  </button>
                }
              </div>
              <div class="gm-list">
                @for (it of doneItems(); track it.id) {
                  <button type="button" class="gm-row gm-row--done"
                          [class.is-busy]="isItemBusy(it.id)"
                          [disabled]="!canEdit() || isItemBusy(it.id)"
                          (click)="toggle(it)"
                          [attr.aria-label]="'Uncheck ' + baseName(it.text)">
                    <span class="gm-row__box gm-row__box--on" aria-hidden="true">
                      <mat-icon>check</mat-icon>
                    </span>
                    <span class="gm-row__name">{{ baseName(it.text) }}</span>
                    @if (itemQty(it.text) > 1) {
                      <span class="gm-row__qty" aria-hidden="true">×{{ itemQty(it.text) }}</span>
                    }
                  </button>
                }
              </div>
            </section>
          }

          @if (!canEdit()) {
            <p class="gm-readonly">
              <mat-icon aria-hidden="true">lock</mat-icon> Shared with you — view only
            </p>
          }
        }
      </div>
    </app-bs-pull-refresh>

    <!-- ─────────────── STICKY ADD BAR ─────────────── -->
    @if (canEdit() && !loading() && !errored()) {
      <form class="gm-add" (submit)="add(); $event.preventDefault()">
        <mat-icon class="gm-add__ic" aria-hidden="true">add</mat-icon>
        <input class="gm-add__input" type="text" name="grocery-item"
               placeholder="Add an item… (Milk x2)" autocomplete="off"
               [value]="draft()" (input)="draft.set($any($event.target).value)"
               [disabled]="busy()" aria-label="Add a grocery item" />
        <button type="submit" class="gm-add__btn" [disabled]="busy() || !draft().trim()"
                aria-label="Add item">
          <mat-icon aria-hidden="true">arrow_upward</mat-icon>
        </button>
      </form>
    }

    <app-bs-toaster />
  `,
})
export class GroceryMobilePage {
  private api = inject(Api);
  private toast = inject(ToastController);

  /** The household Groceries list (null until the first load resolves / on a hard error). */
  readonly list = signal<FamilyList | null>(null);
  readonly loading = signal(true);
  readonly errored = signal(false);
  readonly refreshing = signal(false);

  /** A list-level write is in flight (disables the add bar + clear). */
  readonly busy = signal(false);

  /** The "add an item" draft. */
  readonly draft = signal('');

  /** Per-item in-flight ids (so only the touched row's controls spin/disable). */
  private readonly busyItems = signal<Set<number>>(new Set());

  /** Stable cells for the loading skeleton list. */
  readonly skeletonRows = Array.from({ length: 5 }, (_, i) => i);

  /** Whether the caller can write to the list (server-authored; false → read-only). */
  readonly canEdit = computed(() => this.list()?.canEdit ?? false);

  /** Open (unchecked) items, in their stored sort order — the part the user shops from. */
  readonly openItems = computed<FamilyListItem[]>(() =>
    (this.list()?.items ?? []).filter((i) => !i.done).sort((a, b) => a.sortOrder - b.sortOrder),
  );

  /** Checked-off items, sorted to the bottom (keep stored order). */
  readonly doneItems = computed<FamilyListItem[]>(() =>
    (this.list()?.items ?? []).filter((i) => i.done).sort((a, b) => a.sortOrder - b.sortOrder),
  );

  readonly openCount = computed(() => this.openItems().length);
  readonly doneCount = computed(() => this.doneItems().length);
  readonly totalCount = computed(() => this.list()?.items?.length ?? 0);

  /** A warm one-liner for the hero. */
  readonly heroTitle = computed(() => {
    const total = this.totalCount();
    const open = this.openCount();
    if (total === 0) return 'Nothing on the list yet';
    if (open === 0) return 'All checked off — ready to go';
    return open === 1 ? '1 thing left to grab' : `${open} things left to grab`;
  });

  /** The progress ring's dasharray (checked-off fraction of the 52r circle, circumference ≈ 326.7). */
  readonly ringDash = computed(() => {
    const total = this.totalCount();
    const frac = total > 0 ? this.doneCount() / total : 0;
    const circ = 2 * Math.PI * 52;
    return `${(frac * circ).toFixed(1)} ${circ.toFixed(1)}`;
  });

  constructor() {
    void this.load();
  }

  // ─────────────── LOAD ───────────────

  /** Find-or-create + load the household Groceries list. Any error shows a retry-able error state. */
  private async load(): Promise<void> {
    this.loading.set(true);
    this.errored.set(false);
    try {
      const list = await firstValueFrom(this.api.grocery());
      this.list.set(list);
    } catch {
      this.list.set(null);
      this.errored.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  /** Pull-to-refresh: re-fetch the list (keeps the current view if a refresh fails). */
  async reload(): Promise<void> {
    const wasLoaded = !!this.list();
    if (wasLoaded) this.refreshing.set(true); else this.loading.set(true);
    this.errored.set(false);
    try {
      const list = await firstValueFrom(this.api.grocery());
      this.list.set(list);
    } catch {
      if (!wasLoaded) this.errored.set(true);
      else this.toast.show('Couldn’t refresh — pull again', { tone: 'warn' });
    } finally {
      this.loading.set(false);
      this.refreshing.set(false);
    }
  }

  // ─────────────── HELPERS (parsing copied from live grocery.ts) ───────────────

  isItemBusy(id: number): boolean {
    return this.busyItems().has(id);
  }

  private setItemBusy(id: number, on: boolean): void {
    this.busyItems.update((set) => {
      const next = new Set(set);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  /** Strip a trailing "xN" so the row shows the base name + a separate quantity badge. */
  baseName(text: string): string {
    return text.replace(/\s*[xX]\s*\d{1,3}\s*$/, '').trim() || text.trim();
  }

  /** The trailing "xN" quantity on an item's text (1 when none / unparsable). */
  itemQty(text: string): number {
    const m = /\s*[xX]\s*(\d{1,3})\s*$/.exec(text);
    return m ? Math.max(1, parseInt(m[1], 10)) : 1;
  }

  // ─────────────── ACTIONS (same /api/grocery methods as the live page) ───────────────

  /** Add the draft item (quantity-aware). Clears the box on success. */
  async add(): Promise<void> {
    const text = this.draft().trim();
    if (!text || this.busy() || !this.canEdit()) return;
    this.busy.set(true);
    try {
      const list = await firstValueFrom(this.api.groceryAddQuantity(text));
      this.list.set(list);
      this.draft.set('');
    } catch {
      this.toast.show("Couldn't add that — try again", { tone: 'warn' });
    } finally {
      this.busy.set(false);
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
      this.toast.show("Couldn't update that item — try again", { tone: 'warn' });
    } finally {
      this.setItemBusy(item.id, false);
    }
  }

  /**
   * Delete an item outright (swipe-to-delete commit). Offers an Undo toast that re-adds the base name
   * with its quantity — the qty-aware add re-composes the "xN" (it lands at the end of the list, an
   * accepted tradeoff for an undo of a rarely-mistaken swipe).
   */
  async remove(item: FamilyListItem): Promise<void> {
    if (this.isItemBusy(item.id) || !this.canEdit()) return;
    this.setItemBusy(item.id, true);
    try {
      const list = await firstValueFrom(this.api.groceryDeleteItem(item.id));
      this.list.set(list);
      const name = this.baseName(item.text);
      const qty = this.itemQty(item.text);
      this.toast.undo(`Removed ${name}`, () => void this.readd(name, qty));
    } catch {
      this.toast.show("Couldn't remove that item — try again", { tone: 'warn' });
    } finally {
      this.setItemBusy(item.id, false);
    }
  }

  /** Re-add a removed item (Undo) via the qty-aware add. */
  private async readd(name: string, qty: number): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      const list = await firstValueFrom(this.api.groceryAddQuantity(name, qty));
      this.list.set(list);
    } catch {
      this.toast.show("Couldn't undo — try again", { tone: 'warn' });
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
      this.toast.show(`Cleared ${n} checked item${n === 1 ? '' : 's'}`, { tone: 'success' });
    } catch {
      this.toast.show("Couldn't clear the checked items — try again", { tone: 'warn' });
      void this.load();
    } finally {
      this.busy.set(false);
    }
  }
}
