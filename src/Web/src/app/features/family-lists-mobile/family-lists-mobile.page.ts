import {
  ChangeDetectionStrategy, Component, computed, inject, signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { MatIconModule } from '@angular/material/icon';

import { Api } from '../../core/api';
import { FamilyList, FamilyListItem, FamilyListKind } from '../../core/models';
import {
  BetaPullRefresh, BetaSegmentedControl, BetaBottomSheet, BetaSwipeRow, BetaSkeleton,
  BetaFab, BetaToaster, BetaEmptyState, BetaErrorState, ToastController, type Segment,
} from '../beta-ui';

/**
 * Family Lists — the mobile-first twin of the live /family/lists page, rebuilt on the shared beta-ui
 * "Strata" kit (`@use '../beta-ui/beta-kit'`). One signature accent — a fresh LIME → TEAL — re-skins the
 * whole screen via the per-page accent contract. An immersive scrolling header (an accent bloom + a small
 * lists/items stat strip), a {@link BetaSegmentedControl} flipping the OVERVIEW between Shopping and To-do
 * lists, a list of glassy list-cards (each a {@link BetaSwipeRow} on manageable rows: swipe left to delete,
 * right to complete/archive) showing a check-off progress count, a {@link BetaBottomSheet} DETAIL with
 * tap-to-check items + an add-item box, a second tiny create sheet, and a {@link BetaFab} to create.
 * Pull-to-refresh, skeleton loaders, and elevated empty/error states round it out.
 *
 * DATA PARITY + PRIVACY: every list comes straight from the SAME household-scoped, share-gated
 * `/api/family/lists` endpoints the live page uses — {@link Api.familyListsAll} (active + archived).
 * Writes go through {@link Api.createFamilyList} / {@link Api.addFamilyListItem} /
 * {@link Api.patchFamilyListItem} / {@link Api.deleteFamilyListItem} / {@link Api.deleteFamilyList} /
 * {@link Api.archiveFamilyList} VERBATIM. The server enforces all access; the UI only offers edit/check
 * on lists the server returned as `canEdit`, and delete on lists the caller manages. Checkers are shown by
 * display NAME only — never an email.
 *
 * ISOLATION: gated by `platform.mobile` + the SAME family access the live /family route carries; it
 * consumes the kit + the SAME Api as the live counterpart. No live page is imported or modified. Layout is
 * mobile-first (44px targets, safe-area insets, no 390px overflow) and centers on desktop.
 */
@Component({
  selector: 'app-family-lists-mobile',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [ToastController],
  imports: [
    FormsModule, MatIconModule,
    BetaPullRefresh, BetaSegmentedControl, BetaBottomSheet, BetaSwipeRow, BetaSkeleton,
    BetaFab, BetaToaster, BetaEmptyState, BetaErrorState,
  ],
  template: `
    <!-- ─────────────── PULL-TO-REFRESH OWNS THE SCROLL ─────────────── -->
    <app-bs-pull-refresh class="fl-ptr" [busy]="refreshing()" (refresh)="reload()">
      <div class="fl-scroll" aria-live="polite">

        <!-- ─── IMMERSIVE HEADER: title + a tiny stat strip ─── -->
        <header class="fl-hero">
          <p class="fl-hero__kicker"><mat-icon aria-hidden="true">checklist</mat-icon> Family Lists</p>
          <h1 class="fl-hero__title">Lists</h1>
          <p class="fl-hero__sub">Your household's shared lists — add, check off, done together.</p>

          @if (!loading() && !errored()) {
            <div class="fl-stats">
              <div class="fl-stat">
                <span class="fl-stat__n mono-num">{{ activeCount() }}</span>
                <span class="fl-stat__l">{{ activeCount() === 1 ? 'list' : 'lists' }}</span>
              </div>
              <div class="fl-stat">
                <span class="fl-stat__n mono-num">{{ openItems() }}</span>
                <span class="fl-stat__l">to do</span>
              </div>
              @if (archivedCount(); as a) {
                <div class="fl-stat">
                  <span class="fl-stat__n mono-num">{{ a }}</span>
                  <span class="fl-stat__l">completed</span>
                </div>
              }
            </div>
          }
        </header>

        @if (loading()) {
          <!-- skeleton list -->
          <div class="fl-seg-wrap" aria-hidden="true">
            <app-bs-skeleton width="100%" height="44px" radius="var(--r-pill)" />
          </div>
          <div class="fl-list" aria-hidden="true">
            @for (n of skeletonCells; track n) {
              <app-bs-skeleton height="86px" radius="var(--r-tile)" />
            }
          </div>

        } @else if (errored()) {
          <app-bs-error
            icon="cloud_off"
            title="Couldn't load your lists"
            body="Something went wrong fetching your family lists. Give it another go."
            (retry)="reload()" />

        } @else {
          <!-- ─── TAB SWITCH: Shopping | To-do ─── -->
          <div class="fl-seg-wrap">
            <app-bs-segmented class="fl-seg"
              [segments]="tabSegments()" [value]="tab()" label="Show lists"
              (change)="setTab($event)" />
          </div>

          <!-- archived toggle -->
          <button type="button" class="fl-arch-toggle" [class.is-on]="showArchived()" (click)="toggleArchived()">
            <mat-icon aria-hidden="true">{{ showArchived() ? 'check_box' : 'check_box_outline_blank' }}</mat-icon>
            Show completed lists
          </button>

          @if (activeList(); as list) {
            @if (list.length) {
              <div class="fl-list">
                @for (l of list; track l.id; let i = $index) {
                  @if (canManage(l)) {
                    <!-- MANAGEABLE: swipe left to delete, right to complete -->
                    <app-bs-swipe-row class="fl-swipe fl-reveal" [id]="'list-' + l.id" [style.--ri]="i"
                      leftLabel="Delete" [rightLabel]="l.isArchived ? 'Reopen' : 'Done'"
                      [disabled]="isBusy(l.id)" [label]="l.name"
                      (swipe)="onSwipe(l, $event)">
                      <button type="button" class="fl-card" (click)="openDetail(l)"
                              [class.is-busy]="isBusy(l.id)" [class.is-archived]="l.isArchived"
                              [attr.aria-label]="cardAria(l)">
                        <span class="fl-card__glyph" aria-hidden="true">
                          <mat-icon>{{ l.kind === 'shopping' ? 'shopping_cart' : 'task_alt' }}</mat-icon>
                        </span>
                        <span class="fl-card__body">
                          <span class="fl-card__title">{{ l.name }}</span>
                          <span class="fl-card__meta">
                            @if (l.items.length) {
                              <span class="mono-num">{{ doneCount(l) }}</span>/<span class="mono-num">{{ l.items.length }}</span> done
                            } @else {
                              empty list
                            }
                            @if (l.isArchived) { · completed }
                            @if (!l.isMine) { · <mat-icon class="fl-card__shared-ic" aria-hidden="true">group</mat-icon>{{ l.createdByName }} }
                          </span>
                          @if (l.items.length) {
                            <span class="fl-card__bar" aria-hidden="true">
                              <span class="fl-card__bar-fill" [style.width.%]="pct(l)"></span>
                            </span>
                          }
                        </span>
                        <mat-icon class="fl-card__go" aria-hidden="true">chevron_right</mat-icon>
                      </button>
                    </app-bs-swipe-row>
                  } @else {
                    <!-- SHARED-IN read-only: tap for detail (check-off still allowed if canEdit) -->
                    <button type="button" class="fl-card fl-card--shared fl-reveal"
                            [id]="'list-' + l.id" [style.--ri]="i"
                            (click)="openDetail(l)" [attr.aria-label]="cardAria(l)">
                      <span class="fl-card__glyph" aria-hidden="true">
                        <mat-icon>{{ l.kind === 'shopping' ? 'shopping_cart' : 'task_alt' }}</mat-icon>
                      </span>
                      <span class="fl-card__body">
                        <span class="fl-card__title">{{ l.name }}</span>
                        <span class="fl-card__meta">
                          <mat-icon class="fl-card__shared-ic" aria-hidden="true">person</mat-icon>{{ l.createdByName }}
                          @if (l.items.length) { · <span class="mono-num">{{ doneCount(l) }}</span>/<span class="mono-num">{{ l.items.length }}</span> done }
                        </span>
                        @if (l.items.length) {
                          <span class="fl-card__bar" aria-hidden="true">
                            <span class="fl-card__bar-fill" [style.width.%]="pct(l)"></span>
                          </span>
                        }
                      </span>
                      <mat-icon class="fl-card__go" aria-hidden="true">chevron_right</mat-icon>
                    </button>
                  }
                }
              </div>

              <p class="fl-foot" aria-hidden="true">Swipe a list left to delete · right to {{ showArchived() ? 'reopen/complete' : 'complete' }}</p>

            } @else {
              <!-- EMPTY for the active tab -->
              <app-bs-empty
                [icon]="tab() === 'shopping' ? 'shopping_cart' : 'task_alt'"
                [title]="'No ' + (tab() === 'shopping' ? 'shopping' : 'to-do') + ' lists yet'"
                [body]="'Tap the + to start your first ' + (tab() === 'shopping' ? 'shopping' : 'to-do') + ' list.'"
                ctaLabel="New list" ctaIcon="add" (action)="openCreate()" />
            }
          }
        }
      </div>
    </app-bs-pull-refresh>

    <!-- ─── CREATE FAB ─── -->
    @if (!loading() && !errored()) {
      <app-bs-fab icon="add" label="New list" [extended]="true" [fixed]="true" (action)="openCreate()" />
    }

    <!-- ─────────────── DETAIL BOTTOM SHEET ─────────────── -->
    <app-bs-sheet [(open)]="detailOpen" detent="full" [label]="selected()?.name || 'List detail'">
      @if (selected(); as l) {
        <div class="ld">
          <div class="ld__head">
            <span class="ld__glyph" aria-hidden="true">
              <mat-icon>{{ l.kind === 'shopping' ? 'shopping_cart' : 'task_alt' }}</mat-icon>
            </span>
            <div class="ld__titles">
              <h3 class="ld__title">{{ l.name }}</h3>
              <span class="ld__sub">
                @if (!l.isMine) {
                  <mat-icon aria-hidden="true">person</mat-icon> Shared by {{ l.createdByName }} ·
                }
                <span class="mono-num">{{ doneCount(l) }}</span>/<span class="mono-num">{{ l.items.length }}</span> done
                @if (l.isArchived) { · completed }
              </span>
            </div>
          </div>

          <!-- progress bar -->
          @if (l.items.length) {
            <span class="ld__bar" aria-hidden="true">
              <span class="ld__bar-fill" [style.width.%]="pct(l)"></span>
            </span>
          }

          <!-- add-item box -->
          @if (l.canEdit) {
            <form class="ld__add" (ngSubmit)="addItem(l)">
              <input class="ld__add-input" type="text" [ngModel]="draft()" (ngModelChange)="draft.set($event)"
                     name="newItem" autocomplete="off" maxlength="300"
                     [placeholder]="l.kind === 'shopping' ? 'Add an item…' : 'Add a to-do…'" />
              <button type="submit" class="ld__add-btn" [disabled]="!draft().trim() || isBusy(l.id)"
                      aria-label="Add item">
                <mat-icon aria-hidden="true">add</mat-icon>
              </button>
            </form>
          }

          <!-- items -->
          @if (l.items.length) {
            <ul class="ld__items">
              @for (it of l.items; track it.id) {
                <li class="ld__item" [class.is-done]="it.done">
                  <button type="button" class="ld__check" [class.is-on]="it.done"
                          [disabled]="!l.canEdit || isBusy(l.id)" (click)="toggleItem(l, it)"
                          [attr.aria-pressed]="it.done"
                          [attr.aria-label]="(it.done ? 'Uncheck ' : 'Check ') + it.text">
                    <mat-icon aria-hidden="true">{{ it.done ? 'check_circle' : 'radio_button_unchecked' }}</mat-icon>
                  </button>
                  <span class="ld__item-body">
                    <span class="ld__item-text">{{ it.text }}</span>
                    @if (it.done && it.doneByName) {
                      <span class="ld__item-by"><mat-icon aria-hidden="true">done</mat-icon> {{ it.doneByName }}</span>
                    } @else if (it.assignedToName) {
                      <span class="ld__item-by"><mat-icon aria-hidden="true">person</mat-icon> {{ it.assignedToName }}</span>
                    }
                  </span>
                  @if (l.canEdit) {
                    <button type="button" class="ld__item-del" [disabled]="isBusy(l.id)"
                            (click)="deleteItem(l, it)" aria-label="Remove item">
                      <mat-icon aria-hidden="true">close</mat-icon>
                    </button>
                  }
                </li>
              }
            </ul>
          } @else {
            <div class="ld__empty">
              <mat-icon aria-hidden="true">inventory_2</mat-icon>
              <p>Nothing on this list yet.@if (l.canEdit) {  Add the first item above.}</p>
            </div>
          }

          <!-- manage actions -->
          @if (canManage(l)) {
            <div class="ld__actions">
              @if (l.canEdit) {
                <button type="button" class="ld__btn" [disabled]="isBusy(l.id)" (click)="toggleArchive(l)">
                  <mat-icon aria-hidden="true">{{ l.isArchived ? 'unarchive' : 'task_alt' }}</mat-icon>
                  {{ l.isArchived ? 'Reopen' : 'Complete' }}
                </button>
              }
              <button type="button" class="ld__btn ld__btn--del" [disabled]="isBusy(l.id)" (click)="remove(l)">
                <mat-icon aria-hidden="true">delete_outline</mat-icon> Delete
              </button>
            </div>
          } @else {
            <p class="ld__shared-note">
              <mat-icon aria-hidden="true">{{ l.canEdit ? 'edit' : 'visibility' }}</mat-icon>
              Shared with you{{ l.canEdit ? ' — you can check items off' : ' read-only' }}.
            </p>
          }
        </div>
      }
    </app-bs-sheet>

    <!-- ─────────────── CREATE SHEET ─────────────── -->
    <app-bs-sheet [(open)]="createOpen" detent="half" [dismissable]="!creating()" label="New list">
      <form class="lf" (ngSubmit)="create()">
        <div class="lf__head">
          <h3 class="lf__title">New list</h3>
          <button type="button" class="lf__close" (click)="closeCreate()" aria-label="Cancel" [disabled]="creating()">
            <mat-icon aria-hidden="true">close</mat-icon>
          </button>
        </div>

        <span class="lf__seg-label">Kind</span>
        <div class="lf__kinds" role="radiogroup" aria-label="List kind">
          <button type="button" class="lf__kind" [class.is-on]="newKind() === 'shopping'"
                  role="radio" [attr.aria-checked]="newKind() === 'shopping'" (click)="newKind.set('shopping')">
            <mat-icon aria-hidden="true">shopping_cart</mat-icon> Shopping
          </button>
          <button type="button" class="lf__kind" [class.is-on]="newKind() === 'todo'"
                  role="radio" [attr.aria-checked]="newKind() === 'todo'" (click)="newKind.set('todo')">
            <mat-icon aria-hidden="true">task_alt</mat-icon> To-do
          </button>
        </div>

        <label class="lf__field">
          <span class="lf__label">Name</span>
          <input class="lf__input" type="text" [ngModel]="newName()" (ngModelChange)="newName.set($event)"
                 name="listName" autocomplete="off" maxlength="200"
                 [placeholder]="newKind() === 'shopping' ? 'e.g. Groceries' : 'e.g. Weekend chores'" required />
        </label>

        <div class="lf__actions">
          <button type="button" class="lf__btn lf__btn--ghost" (click)="closeCreate()" [disabled]="creating()">Cancel</button>
          <button type="submit" class="lf__btn lf__btn--save" [disabled]="!newName().trim() || creating()">
            @if (creating()) { <span class="lf__spin" aria-hidden="true"></span> Creating… }
            @else { <mat-icon aria-hidden="true">check</mat-icon> Create list }
          </button>
        </div>
      </form>
    </app-bs-sheet>

    <app-bs-toaster />
  `,
  styleUrl: './family-lists-mobile.page.scss',
})
export class FamilyListsMobilePage {
  private api = inject(Api);
  private toast = inject(ToastController);
  private route = inject(ActivatedRoute);

  /** A pending #list-{id} fragment to scroll/flash once the lists have loaded (deep-link from Search). */
  private pendingFragment: string | null = null;

  /** All lists (active + archived) straight from the live endpoint. */
  readonly lists = signal<FamilyList[]>([]);

  readonly loading = signal(true);
  readonly errored = signal(false);
  readonly refreshing = signal(false);

  /** Whether completed (archived) lists are included in the view. */
  readonly showArchived = signal(false);

  /** Which kind the segmented control shows. */
  readonly tab = signal<FamilyListKind>('shopping');

  /** Per-list in-flight ids so only that card's controls disable. */
  private readonly busyIds = signal<Set<number>>(new Set());

  /** Detail sheet state + the list it's showing. */
  readonly detailOpen = signal(false);
  readonly selected = signal<FamilyList | null>(null);
  /** Add-item draft for the open detail sheet. */
  readonly draft = signal('');

  /** Create sheet state + fields. */
  readonly createOpen = signal(false);
  readonly creating = signal(false);
  readonly newName = signal('');
  readonly newKind = signal<FamilyListKind>('shopping');

  readonly skeletonCells = Array.from({ length: 4 }, (_, i) => i);

  /** Lists honoring the archived toggle (active-only by default). */
  private readonly visible = computed(() =>
    this.showArchived() ? this.lists() : this.lists().filter((l) => !l.isArchived));

  readonly shoppingLists = computed(() => this.visible().filter((l) => l.kind === 'shopping'));
  readonly todoLists = computed(() => this.visible().filter((l) => l.kind === 'todo'));

  /** The list backing the active tab. */
  readonly activeList = computed<FamilyList[]>(() =>
    this.tab() === 'shopping' ? this.shoppingLists() : this.todoLists());

  readonly activeCount = computed(() => this.lists().filter((l) => !l.isArchived).length);
  readonly archivedCount = computed(() => this.lists().filter((l) => l.isArchived).length);
  /** Total un-done items across active lists — the "to do" stat. */
  readonly openItems = computed(() =>
    this.lists().filter((l) => !l.isArchived)
      .reduce((sum, l) => sum + l.items.filter((i) => !i.done).length, 0));

  readonly tabSegments = computed<Segment[]>(() => [
    { key: 'shopping', label: `Shopping${this.shoppingLists().length ? ' · ' + this.shoppingLists().length : ''}` },
    { key: 'todo', label: `To-do${this.todoLists().length ? ' · ' + this.todoLists().length : ''}` },
  ]);

  constructor() {
    // Deep-link from Search: #list-{id} scrolls + flashes that list once they're loaded (parity with the
    // desktop /family/lists consumer). An absent/non-matching fragment is a no-op, so a normal visit
    // behaves exactly as before.
    this.route.fragment.pipe(takeUntilDestroyed()).subscribe((frag) => {
      this.pendingFragment = frag;
      if (frag && !this.loading()) this.scrollToFragment(frag);
    });
    void this.reload();
  }

  /**
   * Scroll a #list-{id} target into view and flash it (deep-link from Search). The target may be archived
   * (hidden by default) or under the other tab, so we reveal completed lists + flip to the list's kind
   * first to guarantee the anchor renders, then scroll.
   */
  private scrollToFragment(frag: string): void {
    const id = Number(frag.replace(/^list-/, ''));
    const target = Number.isInteger(id) ? this.lists().find((l) => l.id === id) : undefined;
    if (target) {
      if (target.isArchived) this.showArchived.set(true);
      this.tab.set(target.kind);
    }
    setTimeout(() => {
      const el = document.getElementById(frag);
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('fl-card--flash');
      setTimeout(() => el.classList.remove('fl-card--flash'), 1600);
    });
  }

  // ─────────────── LOAD ───────────────

  async reload(): Promise<void> {
    const wasLoaded = !this.loading();
    if (wasLoaded) this.refreshing.set(true); else this.loading.set(true);
    this.errored.set(false);
    try {
      const all = await firstValueFrom(this.api.familyListsAll(true));
      this.lists.set(all ?? []);
      // Keep the open detail sheet in sync with the freshly loaded row (if still present).
      const sel = this.selected();
      if (sel) {
        const next = (all ?? []).find((l) => l.id === sel.id);
        this.selected.set(next ?? null);
        if (!next) this.detailOpen.set(false);
      }
    } catch {
      this.errored.set(true);
    } finally {
      this.loading.set(false);
      if (wasLoaded) {
        this.refreshing.set(false);
        this.toast.show('Lists refreshed', { tone: 'success', durationMs: 1600 });
      }
    }
    // Apply any pending deep-link fragment now the lists are loaded (the anchor exists).
    if (this.pendingFragment) this.scrollToFragment(this.pendingFragment);
  }

  setTab(key: string): void {
    this.tab.set(key === 'todo' ? 'todo' : 'shopping');
  }

  toggleArchived(): void {
    this.showArchived.update((v) => !v);
  }

  // ─────────────── helpers ───────────────

  isBusy(id: number): boolean {
    return this.busyIds().has(id);
  }

  private setBusy(id: number, on: boolean): void {
    this.busyIds.update((set) => {
      const next = new Set(set);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  doneCount(l: FamilyList): number {
    return l.items.filter((i) => i.done).length;
  }

  pct(l: FamilyList): number {
    if (!l.items.length) return 0;
    return Math.round((this.doneCount(l) / l.items.length) * 100);
  }

  /**
   * True when the caller may MANAGE this list (delete / complete) — i.e. it's their own household list.
   * A shared-in list (author in another household) is not manageable here. Mirrors the live page's rule
   * (the live page also allows household members; the mobile twin keeps the conservative `isMine` gate,
   * and the server enforces the real check on every write).
   */
  canManage(l: FamilyList): boolean {
    return l.isMine;
  }

  cardAria(l: FamilyList): string {
    const kind = l.kind === 'shopping' ? 'shopping list' : 'to-do list';
    const prog = l.items.length ? `, ${this.doneCount(l)} of ${l.items.length} done` : ', empty';
    const owner = l.isMine ? '' : `, shared by ${l.createdByName}`;
    return `${l.name}, ${kind}${prog}${owner}. Open list.`;
  }

  // ─────────────── DETAIL SHEET ───────────────

  openDetail(l: FamilyList): void {
    this.selected.set(l);
    this.draft.set('');
    this.detailOpen.set(true);
  }

  /** A swipe-row commit on a manageable card: left = delete, right = complete/reopen. */
  onSwipe(l: FamilyList, side: 'left' | 'right'): void {
    if (side === 'left') void this.remove(l);
    else void this.toggleArchive(l);
  }

  // ─────────────── ITEM ACTIONS (reuse the live Api verbatim) ───────────────

  /** Add an item to the open list from the draft input. */
  async addItem(l: FamilyList): Promise<void> {
    const text = this.draft().trim();
    if (!text || !l.canEdit || this.isBusy(l.id)) return;
    this.setBusy(l.id, true);
    try {
      const updated = await firstValueFrom(this.api.addFamilyListItem(l.id, text));
      this.upsert(updated);
      this.draft.set('');
    } catch {
      this.toast.show("Couldn't add that item — try again", { tone: 'warn' });
    } finally {
      this.setBusy(l.id, false);
    }
  }

  /** Check / uncheck an item (server stamps who checked it). */
  async toggleItem(l: FamilyList, item: FamilyListItem): Promise<void> {
    if (!l.canEdit || this.isBusy(l.id)) return;
    this.setBusy(l.id, true);
    try {
      const updated = await firstValueFrom(
        this.api.patchFamilyListItem(l.id, item.id, { done: !item.done }),
      );
      this.upsert(updated);
    } catch {
      this.toast.show("Couldn't update that item — try again", { tone: 'warn' });
    } finally {
      this.setBusy(l.id, false);
    }
  }

  async deleteItem(l: FamilyList, item: FamilyListItem): Promise<void> {
    if (!l.canEdit || this.isBusy(l.id)) return;
    this.setBusy(l.id, true);
    try {
      const updated = await firstValueFrom(this.api.deleteFamilyListItem(l.id, item.id));
      this.upsert(updated);
    } catch {
      this.toast.show("Couldn't remove that item — try again", { tone: 'warn' });
    } finally {
      this.setBusy(l.id, false);
    }
  }

  // ─────────────── LIST ACTIONS ───────────────

  /** Complete (archive) or reopen (unarchive) a list. */
  async toggleArchive(l: FamilyList): Promise<void> {
    if (!l.canEdit || !this.canManage(l) || this.isBusy(l.id)) return;
    const archive = !l.isArchived;
    this.setBusy(l.id, true);
    try {
      const updated = await firstValueFrom(this.api.archiveFamilyList(l.id, archive));
      this.upsert(updated);
      this.toast.show(archive ? 'List completed' : 'List reopened', { tone: 'success', durationMs: 1800 });
    } catch {
      this.toast.show("Couldn't update the list — try again", { tone: 'warn' });
    } finally {
      this.setBusy(l.id, false);
    }
  }

  /** Delete a manageable list (with a confirm). */
  async remove(l: FamilyList): Promise<void> {
    if (!this.canManage(l) || this.isBusy(l.id)) return;
    if (typeof confirm === 'function' &&
        !confirm(`Delete “${l.name}”? It will be removed for everyone it's shared with.`)) return;
    this.setBusy(l.id, true);
    try {
      await firstValueFrom(this.api.deleteFamilyList(l.id));
      this.lists.update((ls) => ls.filter((x) => x.id !== l.id));
      if (this.selected()?.id === l.id) this.detailOpen.set(false);
      this.toast.show('List deleted', { tone: 'success', durationMs: 1800 });
    } catch {
      this.toast.show("Couldn't delete the list — try again", { tone: 'warn' });
    } finally {
      this.setBusy(l.id, false);
    }
  }

  /** Reflect an updated list returned by the server into the store + the open detail sheet. */
  private upsert(list: FamilyList): void {
    this.lists.update((all) =>
      all.some((l) => l.id === list.id)
        ? all.map((l) => (l.id === list.id ? list : l))
        : [list, ...all],
    );
    if (this.selected()?.id === list.id) this.selected.set(list);
  }

  // ─────────────── CREATE SHEET ───────────────

  openCreate(): void {
    this.newName.set('');
    this.newKind.set(this.tab());
    this.detailOpen.set(false);
    this.createOpen.set(true);
  }

  closeCreate(): void {
    if (this.creating()) return;
    this.createOpen.set(false);
  }

  async create(): Promise<void> {
    const name = this.newName().trim();
    if (!name || this.creating()) return;
    this.creating.set(true);
    const kind = this.newKind();
    try {
      const list = await firstValueFrom(this.api.createFamilyList(name, kind));
      this.lists.update((ls) => [list, ...ls]);
      this.tab.set(kind);
      this.createOpen.set(false);
      this.toast.show(`Created “${list.name}”`, { tone: 'success', durationMs: 2000 });
      // Drop the user straight into the new list to start adding items.
      this.openDetail(list);
    } catch {
      this.toast.show("Couldn't create the list — try again", { tone: 'warn' });
    } finally {
      this.creating.set(false);
    }
  }
}
