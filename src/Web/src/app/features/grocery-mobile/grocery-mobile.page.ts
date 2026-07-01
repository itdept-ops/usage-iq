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
  BetaBottomSheet, BetaFab,
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
    BetaBottomSheet, BetaFab,
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
          <!-- ─── OPEN ITEMS: tap to check off, swipe to delete, stepper + reorder ─── -->
          @if (openItems().length) {
            <section class="gm-group">
              <div class="gm-group__head">
                <h2 class="gm-group__title">To get</h2>
                <span class="gm-group__count">{{ openItems().length }}</span>
              </div>
              <div class="gm-list">
                @for (it of openItems(); track it.id; let first = $first; let last = $last) {
                  <app-bs-swipe-row leftLabel="Delete" [disabled]="!canEdit() || isItemBusy(it.id)"
                                    [label]="baseName(it.text)" (delete)="remove(it)">
                    <div class="gm-row" [class.is-busy]="isItemBusy(it.id)">
                      <button type="button" class="gm-row__tap"
                              [disabled]="!canEdit() || isItemBusy(it.id)"
                              (click)="toggle(it)"
                              [attr.aria-label]="'Check off ' + baseName(it.text)">
                        <span class="gm-row__box" aria-hidden="true"></span>
                        <span class="gm-row__name">{{ baseName(it.text) }}</span>
                      </button>

                      @if (canEdit()) {
                        <!-- quantity stepper: lower −1 · qty · bump +1 -->
                        <span class="gm-step" aria-hidden="false">
                          <button type="button" class="gm-step__btn"
                                  [disabled]="isItemBusy(it.id) || itemQty(it.text) <= 1"
                                  (click)="lower(it)"
                                  [attr.aria-label]="'Lower quantity of ' + baseName(it.text)">
                            <mat-icon aria-hidden="true">remove</mat-icon>
                          </button>
                          <span class="gm-step__n" aria-live="polite"
                                [attr.aria-label]="'Quantity ' + itemQty(it.text)">{{ itemQty(it.text) }}</span>
                          <button type="button" class="gm-step__btn"
                                  [disabled]="isItemBusy(it.id)"
                                  (click)="bump(it)"
                                  [attr.aria-label]="'Add one more ' + baseName(it.text)">
                            <mat-icon aria-hidden="true">add</mat-icon>
                          </button>
                        </span>

                        <!-- reorder: move up / down among the open items -->
                        <span class="gm-move">
                          <button type="button" class="gm-move__btn"
                                  [disabled]="busy() || first"
                                  (click)="move(it, -1)"
                                  [attr.aria-label]="'Move ' + baseName(it.text) + ' up'">
                            <mat-icon aria-hidden="true">keyboard_arrow_up</mat-icon>
                          </button>
                          <button type="button" class="gm-move__btn"
                                  [disabled]="busy() || last"
                                  (click)="move(it, 1)"
                                  [attr.aria-label]="'Move ' + baseName(it.text) + ' down'">
                            <mat-icon aria-hidden="true">keyboard_arrow_down</mat-icon>
                          </button>
                        </span>
                      } @else if (itemQty(it.text) > 1) {
                        <span class="gm-row__qty" aria-hidden="true">×{{ itemQty(it.text) }}</span>
                      }
                    </div>
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
                    @if (it.doneByName) {
                      <span class="gm-row__by">· by {{ it.doneByName }}</span>
                    }
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

    <!-- ─────────────── TRIP FAB (total spent · complete · past trips) ─────────────── -->
    @if (!loading() && !errored()) {
      <app-bs-fab icon="receipt_long" label="Shopping trip" [fixed]="true"
                  (action)="openTrip()" />
    }

    <!-- ─────────────── TRIP SHEET: total spent + complete + past trips ─────────────── -->
    <app-bs-sheet [(open)]="tripOpen" detent="half" label="Shopping trip">
      <div class="gm-sheet">
        @if (!showArchived()) {
          <!-- CURRENT TRIP -->
          <header class="gm-sheet__head">
            <h2 class="gm-sheet__title">This trip</h2>
            <p class="gm-sheet__sub">Record what you spent, then complete to start fresh.</p>
          </header>

          @if (canEdit()) {
            <label class="gm-cost">
              <span class="gm-cost__lbl">Total spent</span>
              <span class="gm-cost__field">
                <span class="gm-cost__sign" aria-hidden="true">$</span>
                <input class="gm-cost__input" type="number" inputmode="decimal" min="0" step="0.01"
                       placeholder="0.00" name="trip-total" autocomplete="off"
                       [value]="costDraft()" (input)="costDraft.set($any($event.target).value)"
                       (blur)="saveCost()" (keydown.enter)="saveCost()"
                       [disabled]="busy()" aria-label="Total spent on this trip" />
              </span>
            </label>

            <button type="button" class="gm-sheet__cta" [disabled]="busy() || totalCount() === 0"
                    (click)="completeTrip()">
              <mat-icon aria-hidden="true">task_alt</mat-icon> Complete &amp; archive trip
            </button>
          } @else {
            <p class="gm-readonly">
              <mat-icon aria-hidden="true">lock</mat-icon> Shared with you — view only
            </p>
          }

          <button type="button" class="gm-sheet__link" (click)="toggleArchived()">
            <mat-icon aria-hidden="true">history</mat-icon> Past trips
            <mat-icon class="gm-sheet__chev" aria-hidden="true">chevron_right</mat-icon>
          </button>

        } @else {
          <!-- PAST TRIPS -->
          <header class="gm-sheet__head gm-sheet__head--row">
            <button type="button" class="gm-sheet__back" (click)="toggleArchived()" aria-label="Back to this trip">
              <mat-icon aria-hidden="true">arrow_back</mat-icon>
            </button>
            <h2 class="gm-sheet__title">Past trips</h2>
          </header>

          @if (archivedLoading()) {
            <div class="gm-list">
              @for (n of skeletonRows; track n) {
                <app-bs-skeleton height="60px" radius="var(--r-tile)" />
              }
            </div>
          } @else if (archivedTrips().length === 0) {
            <div class="gm-state gm-state--empty">
              <span class="gm-state__orb"><mat-icon aria-hidden="true">history</mat-icon></span>
              <h2 class="gm-state__title">No past trips yet</h2>
              <p class="gm-state__body">Completed shopping trips show up here with their totals.</p>
            </div>
          } @else {
            <div class="gm-trips">
              @for (t of archivedTrips(); track t.id) {
                <div class="gm-trip">
                  <div class="gm-trip__info">
                    <span class="gm-trip__count">{{ tripItemCount(t) }} item{{ tripItemCount(t) === 1 ? '' : 's' }}</span>
                    @if (t.totalCost != null) {
                      <span class="gm-trip__cost">\${{ t.totalCost }}</span>
                    }
                  </div>
                  <button type="button" class="gm-trip__reopen" [disabled]="busy()"
                          (click)="unarchiveTrip(t)">
                    <mat-icon aria-hidden="true">undo</mat-icon> Re-open
                  </button>
                </div>
              }
            </div>
          }
        }
      </div>
    </app-bs-sheet>

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

  /** Whether the shopping-trip bottom sheet is open. */
  readonly tripOpen = signal(false);

  /** The total-cost draft (currency string; seeded from the loaded list). */
  readonly costDraft = signal('');

  /** Whether the sheet is showing the "Past trips" (archived) view vs the current trip. */
  readonly showArchived = signal(false);

  /** Past completed shopping trips (archived lists, other than the live one), loaded on demand. */
  readonly archivedTrips = signal<FamilyList[]>([]);
  readonly archivedLoading = signal(false);

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
      this.costDraft.set(list.totalCost != null ? String(list.totalCost) : '');
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
      this.costDraft.set(list.totalCost != null ? String(list.totalCost) : '');
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

  /** Bump an item's quantity by +1 (qty-aware add of its base name). */
  async bump(item: FamilyListItem): Promise<void> {
    if (this.isItemBusy(item.id) || !this.canEdit()) return;
    this.setItemBusy(item.id, true);
    try {
      const list = await firstValueFrom(this.api.groceryAddQuantity(this.baseName(item.text), 1));
      this.list.set(list);
    } catch {
      this.toast.show("Couldn't update the quantity — try again", { tone: 'warn' });
    } finally {
      this.setItemBusy(item.id, false);
    }
  }

  /**
   * Lower an item's quantity by 1. At qty 1 there's nothing lower than "one of it", so this is a no-op (the
   * user swipes to delete to remove it). The API's qty-aware add only INCREMENTS, so a decrement is done by
   * deleting the row and re-adding the base name with `qty-1` (which re-composes the "xN"). Copied verbatim
   * from the live grocery.ts — the re-added item lands at the end of the list, an accepted tradeoff.
   */
  async lower(item: FamilyListItem): Promise<void> {
    if (this.isItemBusy(item.id) || !this.canEdit()) return;
    const qty = this.itemQty(item.text);
    if (qty <= 1) return; // nothing below one; use delete to remove
    this.setItemBusy(item.id, true);
    try {
      await firstValueFrom(this.api.groceryDeleteItem(item.id));
      const list = await firstValueFrom(
        this.api.groceryAddQuantity(this.baseName(item.text), qty - 1),
      );
      this.list.set(list);
    } catch {
      this.toast.show("Couldn't update the quantity — try again", { tone: 'warn' });
      void this.load(); // re-sync after a partial failure
    } finally {
      this.setItemBusy(item.id, false);
    }
  }

  /** Move an open item up/down one slot among the open items, then persist the new order. */
  async move(item: FamilyListItem, dir: -1 | 1): Promise<void> {
    if (this.busy() || !this.canEdit()) return;
    const open = [...this.openItems()];
    const idx = open.findIndex((i) => i.id === item.id);
    const target = idx + dir;
    if (idx < 0 || target < 0 || target >= open.length) return;
    [open[idx], open[target]] = [open[target], open[idx]];
    const order = open.map((i) => i.id);
    this.busy.set(true);
    try {
      const list = await firstValueFrom(this.api.groceryReorder(order));
      this.list.set(list);
    } catch {
      this.toast.show("Couldn't reorder — try again", { tone: 'warn' });
    } finally {
      this.busy.set(false);
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

  // ─────────────── TRIP: total spent + archive + past trips ───────────────

  /** Open the shopping-trip sheet on the current-trip view (re-seed the cost draft first). */
  openTrip(): void {
    const l = this.list();
    this.costDraft.set(l?.totalCost != null ? String(l.totalCost) : '');
    this.showArchived.set(false);
    this.tripOpen.set(true);
  }

  /**
   * Save the user-entered total spent on this trip (parsed from the currency draft; an empty/blank draft
   * clears it). Saves on blur/Enter; the API stores the value and returns the whole updated list.
   */
  async saveCost(): Promise<void> {
    const l = this.list();
    if (!l || this.busy() || !this.canEdit()) return;
    const raw = this.costDraft().trim();
    const value = raw === '' ? null : Number(raw);
    if (value !== null && (!Number.isFinite(value) || value < 0)) {
      this.toast.show('Enter a valid amount', { tone: 'warn' });
      return;
    }
    // Don't write if nothing actually changed.
    if ((l.totalCost ?? null) === value) return;
    this.busy.set(true);
    try {
      const updated = await firstValueFrom(this.api.setFamilyListCost(l.id, value));
      this.list.set(updated);
      this.costDraft.set(updated.totalCost != null ? String(updated.totalCost) : '');
    } catch {
      this.toast.show("Couldn't save the total — try again", { tone: 'warn' });
    } finally {
      this.busy.set(false);
    }
  }

  /**
   * Complete the trip: archive the household Groceries list, then re-load — the find-or-create returns a
   * fresh empty Groceries list (the intended new-trip reset). The archived trip keeps its total for history.
   */
  async completeTrip(): Promise<void> {
    const l = this.list();
    if (!l || this.busy() || !this.canEdit()) return;
    this.busy.set(true);
    try {
      await firstValueFrom(this.api.archiveFamilyList(l.id, true));
      await this.load();
      this.toast.show('Trip completed', { tone: 'success' });
      this.tripOpen.set(false);
      this.showArchived.set(false);
    } catch {
      this.toast.show("Couldn't complete the trip — try again", { tone: 'warn' });
    } finally {
      this.busy.set(false);
    }
  }

  /** Toggle the "Past trips" (completed shopping lists) view inside the sheet, loading them the first time. */
  toggleArchived(): void {
    const next = !this.showArchived();
    this.showArchived.set(next);
    if (next) void this.loadArchived();
  }

  /** Fetch the archived shopping lists (other completed trips) for the "Past trips" view. */
  async loadArchived(): Promise<void> {
    this.archivedLoading.set(true);
    try {
      const all = await firstValueFrom(this.api.familyListsAll(true));
      const liveId = this.list()?.id;
      this.archivedTrips.set(
        all.filter((l) => l.kind === 'shopping' && l.isArchived && l.id !== liveId),
      );
    } catch {
      this.toast.show("Couldn't load past trips — try again", { tone: 'warn' });
    } finally {
      this.archivedLoading.set(false);
    }
  }

  /** Item count for a past trip (used in the archived list summary). */
  tripItemCount(trip: FamilyList): number {
    return trip.items.length;
  }

  /** Re-open an archived trip (unarchive it). It drops out of the "Past trips" view. */
  async unarchiveTrip(trip: FamilyList): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      await firstValueFrom(this.api.archiveFamilyList(trip.id, false));
      this.archivedTrips.update((all) => all.filter((t) => t.id !== trip.id));
      this.toast.show('Trip re-opened', { tone: 'success' });
    } catch {
      this.toast.show("Couldn't re-open that trip — try again", { tone: 'warn' });
    } finally {
      this.busy.set(false);
    }
  }
}
