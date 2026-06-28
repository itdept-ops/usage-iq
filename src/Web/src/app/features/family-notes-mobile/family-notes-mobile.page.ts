import {
  ChangeDetectionStrategy, Component, computed, inject, signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { MatIconModule } from '@angular/material/icon';
import { catchError, firstValueFrom, of } from 'rxjs';

import { Api } from '../../core/api';
import { FamilyNote, FamilyShareTarget, Household } from '../../core/models';
import { renderMarkdown } from '../family/markdown';
import {
  BetaPullRefresh, BetaBottomSheet, BetaSwipeRow, BetaSkeleton, BetaFab,
  BetaToaster, ToastController,
} from '../beta-ui';

/**
 * Family Notes — the mobile-first twin of the live /family/notes board, rebuilt on the shared beta-ui
 * "Strata" kit (`@use '../beta-ui/beta-kit'`). One signature accent — a soft AMBER → ROSE — re-skins the
 * whole screen via the per-page accent contract. An immersive scrolling header (an accent bloom + a tiny
 * notes/pinned/shared stat strip), a list of glassy note cards (pinned float to the top; each an owned-row
 * {@link BetaSwipeRow}: swipe left to delete, right to pin/unpin), a {@link BetaBottomSheet} DETAIL that
 * renders the markdown body + share roster, a second sheet that is the ADD/EDIT editor (title + markdown
 * body + an optional ✨ AI draft/rewrite), and a {@link BetaFab} to create. Pull-to-refresh, skeleton
 * loaders, and elevated empty/error states round it out.
 *
 * DATA PARITY + PRIVACY: every note comes straight from the SAME household-scoped, share-gated
 * `/api/family/notes` endpoints the live page uses — {@link Api.familyNotes} (pinned-first, then
 * most-recently-updated). Writes go through {@link Api.createFamilyNote} / {@link Api.updateFamilyNote} /
 * {@link Api.deleteFamilyNote} VERBATIM (the request bodies match the live editor). The optional draft uses
 * {@link Api.draftFamilyNoteAi} (saves NOTHING — preview only). People render by display name + initials
 * avatar only; an email is NEVER shown (email-privacy). The server enforces all ownership + visibility, so
 * edit/pin/delete/share are only offered on rows the server marked `canEdit` / a manageable household note.
 *
 * ISOLATION: gated by `platform.mobile` + the SAME `family.use` the live route carries; it consumes the kit
 * + the SAME Api as the live counterpart. No live page is imported (only the shared markdown renderer) or
 * modified. Layout is mobile-first (44px targets, safe-area insets, no 390px overflow) and centers on
 * desktop; reduced motion collapses the kit animations via the a11y killswitch.
 */
@Component({
  selector: 'app-family-notes-mobile',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [ToastController],
  imports: [
    FormsModule, MatIconModule,
    BetaPullRefresh, BetaBottomSheet, BetaSwipeRow, BetaSkeleton, BetaFab, BetaToaster,
  ],
  template: `
    <!-- ─────────────── PULL-TO-REFRESH OWNS THE SCROLL ─────────────── -->
    <app-bs-pull-refresh class="nt-ptr" [busy]="refreshing()" (refresh)="reload()">
      <div class="nt-scroll" aria-live="polite">

        <!-- ─── IMMERSIVE HEADER: title + accent bloom + a tiny stat strip ─── -->
        <header class="nt-hero">
          <div class="nt-hero__bloom" aria-hidden="true"></div>
          <p class="nt-hero__kicker"><mat-icon aria-hidden="true">sticky_note_2</mat-icon> Family Hub</p>
          <h1 class="nt-hero__title">Notes</h1>
          <p class="nt-hero__sub">Shared notes for your household — pin the ones that matter, share read-only with a contact.</p>

          @if (!loading() && !errored()) {
            <div class="nt-stats">
              <div class="nt-stat">
                <span class="nt-stat__n mono-num">{{ noteCount() }}</span>
                <span class="nt-stat__l">{{ noteCount() === 1 ? 'note' : 'notes' }}</span>
              </div>
              <div class="nt-stat">
                <span class="nt-stat__n mono-num">{{ pinnedCount() }}</span>
                <span class="nt-stat__l">pinned</span>
              </div>
              <div class="nt-stat">
                <span class="nt-stat__n mono-num">{{ sharedCount() }}</span>
                <span class="nt-stat__l">shared in</span>
              </div>
            </div>
          }
        </header>

        @if (loading()) {
          <!-- skeleton list -->
          <div class="nt-list" aria-hidden="true">
            @for (n of skeletonCells; track n) {
              <app-bs-skeleton height="104px" radius="var(--r-tile)" />
            }
          </div>

        } @else if (errored()) {
          <div class="nt-state">
            <span class="nt-state__orb"><mat-icon aria-hidden="true">cloud_off</mat-icon></span>
            <h2 class="nt-state__title">Couldn't load your notes</h2>
            <p class="nt-state__body">Something went wrong fetching the board. Give it another go.</p>
            <button type="button" class="nt-state__cta" (click)="reload()">
              <mat-icon aria-hidden="true">refresh</mat-icon> Try again
            </button>
          </div>

        } @else if (board().length) {
          <div class="nt-list">
            @for (note of board(); track note.id; let i = $index) {
              @if (note.canEdit) {
                <!-- MANAGEABLE: swipe left to delete, right to pin/unpin -->
                <app-bs-swipe-row class="nt-swipe nt-reveal" [id]="'note-' + note.id" [style.--ni]="i"
                  leftLabel="Delete" [rightLabel]="note.pinned ? 'Unpin' : 'Pin'"
                  [disabled]="isBusy(note.id)" [label]="cardAria(note)"
                  (swipe)="onSwipe(note, $event)">
                  <button type="button" class="nt-card" (click)="openDetail(note)"
                          [class.is-busy]="isBusy(note.id)" [class.is-pinned]="note.pinned"
                          [attr.aria-label]="cardAria(note)">
                    @if (note.pinned) {
                      <span class="nt-card__pin" aria-hidden="true"><mat-icon>push_pin</mat-icon></span>
                    }
                    <span class="nt-card__body">
                      <span class="nt-card__title">{{ note.title?.trim() || 'Untitled note' }}</span>
                      <span class="nt-card__excerpt">{{ excerpt(note.body) }}</span>
                      <span class="nt-card__meta">
                        <span class="nt-avatar" aria-hidden="true">{{ initials(note.createdByName) }}</span>
                        <span class="nt-card__by">{{ note.createdByName }}</span>
                        @if (note.sharedWith.length) {
                          <span class="nt-card__share"><mat-icon aria-hidden="true">group</mat-icon>{{ note.sharedWith.length }}</span>
                        }
                      </span>
                    </span>
                    <mat-icon class="nt-card__go" aria-hidden="true">chevron_right</mat-icon>
                  </button>
                </app-bs-swipe-row>
              } @else {
                <!-- SHARED-IN read-only: tap for detail -->
                <button type="button" class="nt-card nt-card--shared nt-reveal"
                        [id]="'note-' + note.id" [style.--ni]="i"
                        [class.is-pinned]="note.pinned" (click)="openDetail(note)"
                        [attr.aria-label]="cardAria(note)">
                  @if (note.pinned) {
                    <span class="nt-card__pin" aria-hidden="true"><mat-icon>push_pin</mat-icon></span>
                  }
                  <span class="nt-card__body">
                    <span class="nt-card__title">{{ note.title?.trim() || 'Untitled note' }}</span>
                    <span class="nt-card__excerpt">{{ excerpt(note.body) }}</span>
                    <span class="nt-card__meta">
                      <span class="nt-avatar" aria-hidden="true">{{ initials(note.createdByName) }}</span>
                      <span class="nt-card__by">{{ note.createdByName }}</span>
                      <span class="nt-card__ro"><mat-icon aria-hidden="true">visibility</mat-icon>read-only</span>
                    </span>
                  </span>
                  <mat-icon class="nt-card__go" aria-hidden="true">chevron_right</mat-icon>
                </button>
              }
            }
          </div>
          <p class="nt-foot" aria-hidden="true">Swipe a note left to delete · right to pin or unpin</p>

        } @else {
          <!-- EMPTY -->
          <div class="nt-empty">
            <span class="nt-empty__orb"><mat-icon aria-hidden="true">edit_note</mat-icon></span>
            <h2 class="nt-empty__title">No notes yet</h2>
            <p class="nt-empty__body">Tap the + to jot your first shared note — groceries, plans, anything the household needs.</p>
            <button type="button" class="nt-empty__cta" (click)="openCreate()">
              <mat-icon aria-hidden="true">add</mat-icon> New note
            </button>
          </div>
        }
      </div>
    </app-bs-pull-refresh>

    <!-- ─── CREATE FAB ─── -->
    @if (!loading() && !errored()) {
      <app-bs-fab icon="add" label="New note" [extended]="true" [fixed]="true" (action)="openCreate()" />
    }

    <!-- ─────────────── DETAIL BOTTOM SHEET ─────────────── -->
    <app-bs-sheet [(open)]="detailOpen" detent="half" [label]="selected()?.title || 'Note detail'">
      @if (selected(); as note) {
        <div class="nd">
          <div class="nd__head">
            @if (note.pinned) {
              <span class="nd__glyph nd__glyph--pin" aria-hidden="true"><mat-icon>push_pin</mat-icon></span>
            } @else {
              <span class="nd__glyph" aria-hidden="true"><mat-icon>sticky_note_2</mat-icon></span>
            }
            <div class="nd__titles">
              <h3 class="nd__title">{{ note.title?.trim() || 'Untitled note' }}</h3>
              <span class="nd__sub">
                <span class="nt-avatar nt-avatar--sm" aria-hidden="true">{{ initials(note.createdByName) }}</span>
                {{ note.createdByName }}@if (!note.canEdit) { · shared read-only }
              </span>
            </div>
          </div>

          @if (note.body?.trim()) {
            <div class="nd__body markdown" [innerHTML]="bodyHtml(note.body)"></div>
          } @else {
            <p class="nd__empty">This note has no body yet.</p>
          }

          @if (note.sharedWith.length) {
            <div class="nd__block">
              <span class="nd__block-title"><mat-icon aria-hidden="true">group</mat-icon> Shared with</span>
              <div class="nd__shares">
                @for (s of note.sharedWith; track s.userId) {
                  <span class="nd__chip">
                    <span class="nt-avatar nt-avatar--sm" aria-hidden="true">{{ initials(s.name) }}</span>
                    {{ s.name }}
                    @if (s.canEdit) { <i class="nd__chip-tag">can edit</i> }
                  </span>
                }
              </div>
            </div>
          }

          @if (note.canEdit) {
            <div class="nd__actions">
              <button type="button" class="nd__btn" [disabled]="isBusy(note.id)" (click)="togglePin(note)">
                <mat-icon aria-hidden="true">{{ note.pinned ? 'push_pin' : 'push_pin' }}</mat-icon>
                {{ note.pinned ? 'Unpin' : 'Pin' }}
              </button>
              <button type="button" class="nd__btn" [disabled]="isBusy(note.id)" (click)="openEdit(note)">
                <mat-icon aria-hidden="true">edit</mat-icon> Edit
              </button>
              <button type="button" class="nd__btn nd__btn--del" [disabled]="isBusy(note.id)" (click)="remove(note)">
                <mat-icon aria-hidden="true">delete_outline</mat-icon> Delete
              </button>
            </div>
          } @else {
            <p class="nd__shared-note">
              <mat-icon aria-hidden="true">visibility</mat-icon>
              Shared with you read-only by {{ note.createdByName }}.
            </p>
          }
        </div>
      }
    </app-bs-sheet>

    <!-- ─────────────── ADD / EDIT EDITOR SHEET ─────────────── -->
    <app-bs-sheet [(open)]="formOpen" detent="full" [dismissable]="!saving()"
                  [label]="editing() ? 'Edit note' : 'New note'">
      <form class="nf" (ngSubmit)="save()">
        <div class="nf__head">
          <h3 class="nf__title">{{ editing() ? 'Edit note' : 'New note' }}</h3>
          <button type="button" class="nf__close" (click)="closeForm()" aria-label="Cancel" [disabled]="saving()">
            <mat-icon aria-hidden="true">close</mat-icon>
          </button>
        </div>

        <label class="nf__field">
          <span class="nf__label">Title</span>
          <input class="nf__input" type="text" [ngModel]="fTitle()" (ngModelChange)="fTitle.set($event)"
                 name="title" placeholder="e.g. Weekend plans" autocomplete="off" maxlength="160" />
        </label>

        <label class="nf__field">
          <span class="nf__label"><mat-icon class="nf__label-ic" aria-hidden="true">notes</mat-icon> Body <i>(markdown)</i></span>
          <textarea class="nf__input nf__area" rows="8" [ngModel]="fBody()" (ngModelChange)="fBody.set($event)"
                    name="body" placeholder="- Pick up milk&#10;**Bold** and *italic* welcome"></textarea>
        </label>

        <!-- ✨ AI draft / rewrite (preview only — saves nothing) -->
        <div class="nf__ai">
          <label class="nf__field nf__field--ai">
            <span class="nf__label"><mat-icon class="nf__label-ic" aria-hidden="true">auto_awesome</mat-icon> Draft with AI <i>(optional)</i></span>
            <input class="nf__input" type="text" [ngModel]="aiPrompt()" (ngModelChange)="aiPrompt.set($event)"
                   name="aiPrompt" placeholder="e.g. a packing list for a weekend camping trip"
                   autocomplete="off" maxlength="240" [disabled]="drafting()" />
          </label>
          <button type="button" class="nf__ai-btn" [disabled]="!aiPrompt().trim() || drafting()" (click)="draft()">
            @if (drafting()) { <span class="nf__spin" aria-hidden="true"></span> Drafting… }
            @else {
              <mat-icon aria-hidden="true">auto_awesome</mat-icon>
              {{ fBody().trim() ? 'Rewrite' : 'Draft' }}
            }
          </button>
          @if (aiStatus()) { <p class="nf__ai-status" aria-live="polite">{{ aiStatus() }}</p> }
        </div>

        <!-- pin toggle -->
        <button type="button" class="nf__pin" [class.is-on]="fPinned()" (click)="fPinned.set(!fPinned())">
          <mat-icon aria-hidden="true">push_pin</mat-icon>
          <span class="nf__pin-txt">Pin to the top of the board</span>
          <span class="nd__switch" [class.is-on]="fPinned()" aria-hidden="true"><span class="nd__switch-knob"></span></span>
        </button>

        <div class="nf__actions">
          <button type="button" class="nf__btn nf__btn--ghost" (click)="closeForm()" [disabled]="saving()">Cancel</button>
          <button type="submit" class="nf__btn nf__btn--save" [disabled]="!canSave()">
            @if (saving()) { <span class="nf__spin" aria-hidden="true"></span> Saving… }
            @else { <mat-icon aria-hidden="true">check</mat-icon> {{ editing() ? 'Save changes' : 'Create note' }} }
          </button>
        </div>
      </form>
    </app-bs-sheet>

    <app-bs-toaster />
  `,
  styleUrl: './family-notes-mobile.page.scss',
})
export class FamilyNotesMobilePage {
  private api = inject(Api);
  private toast = inject(ToastController);
  private sanitizer = inject(DomSanitizer);
  private route = inject(ActivatedRoute);

  /** A pending #note-{id} fragment to scroll/flash once the board has loaded (deep-link from Search). */
  private pendingFragment: string | null = null;

  /** The board, pinned-first then most-recently-updated (the server sorts; we keep it stable on local upserts). */
  readonly notes = signal<FamilyNote[]>([]);

  readonly loading = signal(true);
  readonly errored = signal(false);
  readonly refreshing = signal(false);

  /** Per-note in-flight ids (pin / delete) so only that card's controls disable. */
  private readonly busyIds = signal<Set<number>>(new Set());

  /**
   * The caller's household member userIds — used to tell a manageable household note from a note merely
   * shared IN from another household. The server enforces management regardless; this just keeps the menu
   * honest (mirrors the live page).
   */
  private readonly memberIds = signal<Set<number>>(new Set());

  /** Detail sheet state + the note it's showing. */
  readonly detailOpen = signal(false);
  readonly selected = signal<FamilyNote | null>(null);

  /** Editor sheet state. `editing` is the note being edited, or null for a create. */
  readonly formOpen = signal(false);
  readonly editing = signal<FamilyNote | null>(null);
  readonly saving = signal(false);

  // ---- editor fields (mirror the live editor dialog body) ----
  readonly fTitle = signal('');
  readonly fBody = signal('');
  readonly fPinned = signal(false);

  // ---- ✨ AI draft / rewrite (preview only) ----
  readonly aiPrompt = signal('');
  readonly drafting = signal(false);
  readonly aiStatus = signal('');

  readonly skeletonCells = Array.from({ length: 4 }, (_, i) => i);

  readonly board = computed(() => this.notes());
  readonly noteCount = computed(() => this.notes().length);
  readonly pinnedCount = computed(() => this.notes().filter((n) => n.pinned).length);
  /** Notes shared IN from another household (a shared-in author is never one of my members). */
  readonly sharedCount = computed(() => this.notes().filter((n) => !this.canManage(n)).length);

  readonly canSave = computed(
    () => !this.saving() && (this.fTitle().trim().length > 0 || this.fBody().trim().length > 0),
  );

  constructor() {
    // Deep-link from Search: #note-{id} scrolls + flashes that note once the board is loaded (parity with
    // the desktop /family/notes consumer). An absent/non-matching fragment is a no-op, so a normal visit
    // behaves exactly as before.
    this.route.fragment.pipe(takeUntilDestroyed()).subscribe((frag) => {
      this.pendingFragment = frag;
      if (frag && !this.loading()) this.scrollToFragment(frag);
    });
    void this.reload();
    // Member ids power the "is this a manageable household note?" check; failure is non-fatal.
    this.api
      .getHousehold()
      .pipe(catchError(() => of<Household | null>(null)))
      .subscribe((h) => {
        if (h) this.memberIds.set(new Set(h.members.map((m) => m.userId)));
      });
  }

  /** Scroll a #note-{id} target into view and flash it (deep-link from Search). */
  private scrollToFragment(frag: string): void {
    setTimeout(() => {
      const el = document.getElementById(frag);
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('nt-card--flash');
      setTimeout(() => el.classList.remove('nt-card--flash'), 1600);
    });
  }

  // ─────────────── LOAD ───────────────

  async reload(): Promise<void> {
    const wasLoaded = !this.loading();
    if (wasLoaded) this.refreshing.set(true);
    else this.loading.set(true);
    this.errored.set(false);
    try {
      const list = await firstValueFrom(this.api.familyNotes());
      this.notes.set(this.sort(list ?? []));
      // Keep the open detail sheet in sync with the freshly loaded row (if still present).
      const sel = this.selected();
      if (sel) {
        const next = (list ?? []).find((n) => n.id === sel.id);
        this.selected.set(next ?? null);
        if (!next) this.detailOpen.set(false);
      }
    } catch {
      this.errored.set(true);
    } finally {
      this.loading.set(false);
      if (wasLoaded) {
        this.refreshing.set(false);
        this.toast.show('Notes refreshed', { tone: 'success', durationMs: 1600 });
      }
    }
    // Apply any pending deep-link fragment now the board has its rows (the anchor exists).
    if (this.pendingFragment) this.scrollToFragment(this.pendingFragment);
  }

  // ─────────────── helpers ───────────────

  /** True when the caller may MANAGE this note (a household member of the note's household). Mirrors the live page. */
  canManage(note: FamilyNote): boolean {
    return note.isMine || this.memberIds().has(note.createdByUserId);
  }

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

  initials(name: string): string {
    const parts = (name || '').split(/\s+/).filter(Boolean);
    return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
  }

  /** Render a note body to safe HTML (renderMarkdown escapes the source first). */
  bodyHtml(body: string): SafeHtml {
    return this.sanitizer.bypassSecurityTrustHtml(renderMarkdown(body));
  }

  /** A short plain-text excerpt of the markdown body for a card (strip syntax, collapse whitespace). */
  excerpt(body: string): string {
    const plain = (body || '')
      .replace(/[#>*_`~\-]+/g, ' ')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
    return plain.length > 120 ? plain.slice(0, 117).trimEnd() + '…' : plain || 'No body yet';
  }

  cardAria(note: FamilyNote): string {
    const title = note.title?.trim() || 'Untitled note';
    const pin = note.pinned ? ', pinned' : '';
    const ro = note.canEdit ? '' : ', shared read-only';
    return `${title}${pin}, by ${note.createdByName}${ro}. Open details.`;
  }

  /** Pinned-first, then most-recently-updated (mirrors the server's order so it stays stable on local upserts). */
  private sort(list: FamilyNote[]): FamilyNote[] {
    return [...list].sort(
      (a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedUtc.localeCompare(a.updatedUtc),
    );
  }

  /** Replace one note in the board with its fresh copy (after edit/pin), or append a new one. */
  private upsert(note: FamilyNote): void {
    this.notes.update((list) => {
      const next = list.some((n) => n.id === note.id)
        ? list.map((n) => (n.id === note.id ? note : n))
        : [...list, note];
      return this.sort(next);
    });
    const sel = this.selected();
    if (sel?.id === note.id) this.selected.set(note);
  }

  // ─────────────── DETAIL SHEET ───────────────

  openDetail(note: FamilyNote): void {
    this.selected.set(note);
    this.detailOpen.set(true);
  }

  /** A swipe-row commit on a manageable card: left = delete, right = pin/unpin. */
  onSwipe(note: FamilyNote, side: 'left' | 'right'): void {
    if (side === 'left') void this.remove(note);
    else void this.togglePin(note);
  }

  // ─────────────── ACTIONS (reuse the live Api verbatim) ───────────────

  /** Toggle a note's pinned state (members / canEdit-shares). */
  async togglePin(note: FamilyNote): Promise<void> {
    if (!note.canEdit || this.isBusy(note.id)) return;
    this.setBusy(note.id, true);
    try {
      const updated = await firstValueFrom(
        this.api.updateFamilyNote(note.id, {
          title: note.title,
          body: note.body,
          pinned: !note.pinned,
        }),
      );
      this.upsert(updated);
      this.toast.show(updated.pinned ? 'Pinned' : 'Unpinned', { tone: 'success', durationMs: 1500 });
    } catch {
      this.toast.show("Couldn't update that note — try again", { tone: 'warn' });
    } finally {
      this.setBusy(note.id, false);
    }
  }

  /** Delete a note (creator or any household member) with a confirm. */
  async remove(note: FamilyNote): Promise<void> {
    if (!note.canEdit || this.isBusy(note.id)) return;
    const label = note.title?.trim() || 'this note';
    if (typeof confirm === 'function' && !confirm(`Delete “${label}”? It'll be removed for everyone it's shared with.`)) return;
    this.setBusy(note.id, true);
    try {
      await firstValueFrom(this.api.deleteFamilyNote(note.id));
      this.notes.update((list) => list.filter((n) => n.id !== note.id));
      if (this.selected()?.id === note.id) this.detailOpen.set(false);
      this.toast.show('Note deleted', { tone: 'success', durationMs: 1800 });
    } catch {
      this.toast.show("Couldn't delete that note — try again", { tone: 'warn' });
    } finally {
      this.setBusy(note.id, false);
    }
  }

  // ─────────────── ADD / EDIT EDITOR ───────────────

  openCreate(): void {
    this.editing.set(null);
    this.seedForm(null);
    this.detailOpen.set(false);
    this.formOpen.set(true);
  }

  openEdit(note: FamilyNote): void {
    if (!note.canEdit) return;
    this.editing.set(note);
    this.seedForm(note);
    this.detailOpen.set(false);
    this.formOpen.set(true);
  }

  closeForm(): void {
    if (this.saving()) return;
    this.formOpen.set(false);
  }

  private seedForm(note: FamilyNote | null): void {
    this.fTitle.set(note?.title ?? '');
    this.fBody.set(note?.body ?? '');
    this.fPinned.set(note?.pinned ?? false);
    this.aiPrompt.set('');
    this.aiStatus.set('');
  }

  /**
   * "✨ Draft with AI" / "Rewrite": send the prompt (with the current body for a rewrite) for Gemini to draft
   * a note. Saves NOTHING — the returned title+body fill the editor for the user to review + Save. Degrades
   * gracefully: a 503 (AI unavailable) or any error shows a friendly status line; the editor still works.
   */
  async draft(): Promise<void> {
    const prompt = this.aiPrompt().trim();
    if (!prompt || this.drafting()) return;
    this.drafting.set(true);
    this.aiStatus.set('Drafting…');
    try {
      const body = this.fBody().trim();
      const result = await firstValueFrom(
        this.api.draftFamilyNoteAi(prompt, this.fTitle().trim() || undefined, body || undefined),
      );
      if (result.title?.trim()) this.fTitle.set(result.title);
      this.fBody.set(result.body ?? '');
      this.aiStatus.set(result.note ?? 'Drafted — tweak it and Save when you like it.');
    } catch (e) {
      const status = (e as { status?: number })?.status;
      this.aiStatus.set(
        status === 503
          ? "AI isn't available right now — you can still write the note yourself."
          : "Couldn't reach the AI just now. Please try again.",
      );
    } finally {
      this.drafting.set(false);
    }
  }

  async save(): Promise<void> {
    if (!this.canSave()) {
      this.toast.show('Add a title or body first.', { tone: 'warn' });
      return;
    }
    this.saving.set(true);
    const req = {
      title: this.fTitle().trim(),
      body: this.fBody().trim(),
      pinned: this.fPinned(),
    };
    const editRow = this.editing();
    try {
      const saved = editRow
        ? await firstValueFrom(this.api.updateFamilyNote(editRow.id, req))
        : await firstValueFrom(this.api.createFamilyNote(req));
      this.upsert(saved);
      this.toast.show(editRow ? 'Note updated' : `Saved “${saved.title?.trim() || 'note'}”`, {
        tone: 'success',
        durationMs: 1900,
      });
      this.formOpen.set(false);
    } catch {
      this.toast.show("Couldn't save the note — try again", { tone: 'warn' });
    } finally {
      this.saving.set(false);
    }
  }

  /** First three share targets for the avatar stack; the rest collapse into a "+N". */
  visibleShares(shares: FamilyShareTarget[]): FamilyShareTarget[] {
    return shares.slice(0, 3);
  }
  extraShares(shares: FamilyShareTarget[]): number {
    return Math.max(0, shares.length - 3);
  }
}
