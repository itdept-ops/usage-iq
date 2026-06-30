import {
  ChangeDetectionStrategy, Component, computed, inject, signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { MatIconModule } from '@angular/material/icon';

import { Api } from '../../core/api';
import { Household, HouseholdCandidate, HouseholdMember } from '../../core/models';
import {
  BetaPullRefresh, BetaBottomSheet, BetaSwipeRow, BetaSkeleton,
  BetaFab, BetaToaster, ToastController,
} from '../beta-ui';

/**
 * Household settings — the mobile-first twin of the live /family/household page, rebuilt on the shared
 * beta-ui "Strata" kit (`@use '../beta-ui/beta-kit'`). One signature accent — a warm HEARTH AMBER → EMBER —
 * re-skins the screen via the per-page accent contract. An immersive scrolling header (an accent bloom +
 * the household name with an inline rename for the owner + a member-count stat), a glassy roster of member
 * cards (each owner-removable row is a {@link BetaSwipeRow}: swipe left to remove; the owner row is pinned
 * and never removable), an OWNER-ONLY {@link BetaFab} + {@link BetaBottomSheet} to add a member from the
 * people-picker, plus pull-to-refresh, skeleton loaders, and elevated empty/error states.
 *
 * DATA PARITY + PRIVACY: every member comes straight from the SAME endpoints the live page uses —
 * {@link Api.getHousehold} (roster), {@link Api.householdCandidates} (addable people, lazy on the add
 * sheet), {@link Api.renameHousehold}, {@link Api.addMember}, {@link Api.removeMember} VERBATIM. Identity
 * everywhere is `userId` + display `name` + `picture`; NO email is ever shown (email-privacy). The server
 * enforces owner-only mutation regardless of the UI; we gate the owner controls off the caller's own member
 * row exactly like the live page (`isSelf` + `role === 'owner'`).
 *
 * ISOLATION: gated by `platform.mobile` + the SAME route as the live /family/household; it consumes the kit
 * + the SAME Api/models as the live counterpart. No live page is imported or modified. Mobile-first (44px
 * targets, safe-area insets, no 390px overflow), centers on desktop; reduced motion collapses kit anims.
 */
@Component({
  selector: 'app-household-mobile',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [ToastController],
  imports: [
    FormsModule, MatIconModule,
    BetaPullRefresh, BetaBottomSheet, BetaSwipeRow, BetaSkeleton, BetaFab, BetaToaster,
  ],
  template: `
    <!-- ─────────────── PULL-TO-REFRESH OWNS THE SCROLL ─────────────── -->
    <app-bs-pull-refresh class="hh-ptr" [busy]="refreshing()" (refresh)="reload()">
      <div class="hh-scroll" aria-live="polite">

        <!-- ─── IMMERSIVE HEADER: kicker + household name (inline rename for owner) + count ─── -->
        <header class="hh-hero">
          <p class="hh-hero__kicker"><mat-icon aria-hidden="true">home</mat-icon> Household</p>

          @if (loading()) {
            <app-bs-skeleton width="62%" height="34px" radius="var(--r-tile)" />
          } @else if (!errored()) {
            <h1 class="hh-hero__title">{{ household()?.name || 'Your family' }}</h1>
            <p class="hh-hero__sub">
              <span class="mono-num">{{ memberCount() }}</span>
              {{ memberCount() === 1 ? 'member' : 'members' }}
              @if (isOwner()) { · you're the owner }
            </p>

            @if (isOwner()) {
              <!-- inline household rename (owner only) -->
              <div class="hh-rename">
                <input class="hh-rename__input" type="text" name="hhName"
                       [ngModel]="nameDraft()" (ngModelChange)="nameDraft.set($event)"
                       placeholder="Family name" autocomplete="off" maxlength="80"
                       aria-label="Household name" [disabled]="saving()" />
                <button type="button" class="hh-rename__save" [disabled]="!nameDirty() || saving()"
                        (click)="saveName()" aria-label="Save household name">
                  @if (saving()) { <span class="hh-spin" aria-hidden="true"></span> }
                  @else { <mat-icon aria-hidden="true">check</mat-icon> }
                </button>
              </div>
            }
          }
        </header>

        @if (loading()) {
          <!-- skeleton roster -->
          <div class="hh-list" aria-hidden="true">
            @for (n of skeletonCells; track n) {
              <app-bs-skeleton height="76px" radius="var(--r-tile)" />
            }
          </div>

        } @else if (errored()) {
          <div class="hh-state">
            <span class="hh-state__orb"><mat-icon aria-hidden="true">cloud_off</mat-icon></span>
            <h2 class="hh-state__title">Couldn't load your household</h2>
            <p class="hh-state__body">Something went wrong fetching your family. Give it another go.</p>
            <button type="button" class="hh-state__cta" (click)="reload()">
              <mat-icon aria-hidden="true">refresh</mat-icon> Try again
            </button>
          </div>

        } @else {
          @if (members().length) {
            <p class="hh-section-label" aria-hidden="true">
              <mat-icon aria-hidden="true">group</mat-icon> Members
            </p>
            <div class="hh-list">
              @for (m of members(); track m.userId; let i = $index) {
                @if (isOwner() && m.role !== 'owner') {
                  <!-- OWNER VIEW of a removable member: swipe left to remove -->
                  <app-bs-swipe-row class="hh-swipe hh-reveal" [style.--ri]="i"
                    leftLabel="Remove" [rightLabel]="''" [disabled]="removingId() === m.userId"
                    [label]="m.name"
                    (swipe)="onSwipe(m, $event)">
                    <div class="hh-card" [class.is-busy]="removingId() === m.userId">
                      <span class="hh-avatar" aria-hidden="true">
                        @if (m.picture) { <img [src]="m.picture" alt="" /> }
                        @else { <span class="hh-avatar__txt">{{ initials(m.name) }}</span> }
                      </span>
                      <span class="hh-card__body">
                        <span class="hh-card__name">{{ m.name }}@if (m.isSelf) { <i class="hh-you">you</i> }</span>
                        <span class="hh-card__role">{{ roleLabel(m.role) }}</span>
                      </span>
                      @if (removingId() === m.userId) {
                        <span class="hh-spin hh-spin--row" aria-hidden="true"></span>
                      } @else {
                        <mat-icon class="hh-card__hint" aria-hidden="true">swipe_left</mat-icon>
                      }
                    </div>
                  </app-bs-swipe-row>
                } @else {
                  <!-- NON-REMOVABLE row (the owner, or every row for a non-owner caller) -->
                  <div class="hh-card hh-reveal" [style.--ri]="i">
                    <span class="hh-avatar" [class.is-owner]="m.role === 'owner'" aria-hidden="true">
                      @if (m.picture) { <img [src]="m.picture" alt="" /> }
                      @else { <span class="hh-avatar__txt">{{ initials(m.name) }}</span> }
                    </span>
                    <span class="hh-card__body">
                      <span class="hh-card__name">{{ m.name }}@if (m.isSelf) { <i class="hh-you">you</i> }</span>
                      <span class="hh-card__role">{{ roleLabel(m.role) }}</span>
                    </span>
                    @if (m.role === 'owner') {
                      <span class="hh-crown" aria-hidden="true"><mat-icon>workspace_premium</mat-icon></span>
                    }
                  </div>
                }
              }
            </div>

            @if (isOwner()) {
              <p class="hh-foot" aria-hidden="true">Swipe a member left to remove · the owner can't be removed</p>
            }

          } @else {
            <!-- EMPTY roster (defensive — there's always at least the owner) -->
            <div class="hh-empty">
              <span class="hh-empty__orb"><mat-icon aria-hidden="true">groups</mat-icon></span>
              <h2 class="hh-empty__title">No members yet</h2>
              @if (isOwner()) {
                <p class="hh-empty__body">Tap + to add the first person to your household.</p>
                <button type="button" class="hh-empty__cta" (click)="openAdd()">
                  <mat-icon aria-hidden="true">person_add</mat-icon> Add member
                </button>
              } @else {
                <p class="hh-empty__body">Your household roster will show up here.</p>
              }
            </div>
          }
        }
      </div>
    </app-bs-pull-refresh>

    <!-- ─── ADD-MEMBER FAB (owner only) ─── -->
    @if (!loading() && !errored() && isOwner() && members().length) {
      <app-bs-fab icon="person_add" label="Add member" [extended]="true" [fixed]="true" (action)="openAdd()" />
    }

    <!-- ─────────────── ADD-MEMBER BOTTOM SHEET (owner only) ─────────────── -->
    <app-bs-sheet [(open)]="addOpen" detent="half" [dismissable]="!adding()" label="Add a household member">
      <div class="hm">
        <div class="hm__head">
          <span class="hm__glyph" aria-hidden="true"><mat-icon>person_add</mat-icon></span>
          <div class="hm__titles">
            <h3 class="hm__title">Add a member</h3>
            <span class="hm__sub">Pick someone to add to your household.</span>
          </div>
          <button type="button" class="hm__close" (click)="closeAdd()" aria-label="Cancel" [disabled]="adding()">
            <mat-icon aria-hidden="true">close</mat-icon>
          </button>
        </div>

        @if (candidatesLoading()) {
          <div class="hm__list" aria-hidden="true">
            @for (n of skeletonCells; track n) {
              <app-bs-skeleton height="60px" radius="var(--r-tile)" />
            }
          </div>
        } @else if (candidates().length) {
          <div class="hm__list" role="radiogroup" aria-label="People you can add">
            @for (c of candidates(); track c.userId) {
              <button type="button" class="hm__cand" role="radio"
                      [class.is-picked]="pickedUserId() === c.userId"
                      [attr.aria-checked]="pickedUserId() === c.userId"
                      [disabled]="adding()" (click)="pickedUserId.set(c.userId)">
                <span class="hh-avatar" aria-hidden="true">
                  @if (c.picture) { <img [src]="c.picture" alt="" /> }
                  @else { <span class="hh-avatar__txt">{{ initials(c.name) }}</span> }
                </span>
                <span class="hm__cand-name">{{ c.name }}</span>
                <span class="hm__radio" [class.is-on]="pickedUserId() === c.userId" aria-hidden="true">
                  @if (pickedUserId() === c.userId) { <mat-icon>check</mat-icon> }
                </span>
              </button>
            }
          </div>
        } @else {
          <div class="hm__empty">
            <span class="hm__empty-orb"><mat-icon aria-hidden="true">person_search</mat-icon></span>
            <p class="hm__empty-txt">No one to add right now. People you can add to your household will appear here.</p>
          </div>
        }

        <div class="hm__actions">
          <button type="button" class="hm__btn hm__btn--ghost" (click)="closeAdd()" [disabled]="adding()">Cancel</button>
          <button type="button" class="hm__btn hm__btn--add"
                  [disabled]="pickedUserId() === null || adding()" (click)="addMember()">
            @if (adding()) { <span class="hh-spin" aria-hidden="true"></span> Adding… }
            @else { <mat-icon aria-hidden="true">person_add</mat-icon> Add to household }
          </button>
        </div>
      </div>
    </app-bs-sheet>

    <app-bs-toaster />
  `,
  styleUrl: './household-mobile.page.scss',
})
export class HouseholdMobilePage {
  private api = inject(Api);
  private toast = inject(ToastController);

  readonly household = signal<Household | null>(null);
  readonly loading = signal(true);
  readonly errored = signal(false);
  readonly refreshing = signal(false);

  /** Draft household name bound to the inline rename field (seeded from the loaded household). */
  readonly nameDraft = signal('');
  readonly saving = signal(false);

  /** People the owner may add (loaded lazily when the add sheet opens). */
  readonly candidates = signal<HouseholdCandidate[]>([]);
  readonly candidatesLoading = signal(false);
  /** The candidate userId selected in the add-member sheet (null = nothing chosen). */
  readonly pickedUserId = signal<number | null>(null);
  readonly adding = signal(false);
  /** userId currently being removed (drives the per-row spinner), or null. */
  readonly removingId = signal<number | null>(null);

  /** The add-member sheet's open state. */
  readonly addOpen = signal(false);

  readonly skeletonCells = Array.from({ length: 4 }, (_, i) => i);

  readonly members = computed<HouseholdMember[]>(() => this.household()?.members ?? []);
  readonly memberCount = computed(() => this.members().length);

  /** The caller's own member row (whatever role), or undefined until loaded. */
  private readonly self = computed(() => this.members().find((m) => m.isSelf));

  /** True when the caller is the household owner — gates every mutating control (mirrors the server). */
  readonly isOwner = computed(() => this.self()?.role === 'owner');

  /** True once the rename field differs from the saved name (enables the Save button). */
  readonly nameDirty = computed(() => {
    const saved = this.household()?.name ?? '';
    return this.nameDraft().trim().length > 0 && this.nameDraft().trim() !== saved;
  });

  constructor() {
    void this.reload();
  }

  // ─────────────── LOAD ───────────────

  async reload(): Promise<void> {
    const wasLoaded = !this.loading();
    if (wasLoaded) this.refreshing.set(true); else this.loading.set(true);
    this.errored.set(false);
    try {
      const h = await firstValueFrom(this.api.getHousehold());
      this.apply(h);
    } catch {
      this.errored.set(true);
    } finally {
      this.loading.set(false);
      if (wasLoaded) {
        this.refreshing.set(false);
        this.toast.show('Household refreshed', { tone: 'success', durationMs: 1600 });
      }
    }
  }

  private apply(h: Household): void {
    this.household.set(h);
    this.nameDraft.set(h.name);
  }

  // ─────────────── helpers ───────────────

  roleLabel(role: string): string {
    return role === 'owner' ? 'Owner' : 'Member';
  }

  initials(name: string): string {
    const parts = (name || '').split(/\s+/).filter(Boolean);
    return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
  }

  // ─────────────── RENAME (owner only) ───────────────

  /** Persist a household rename (owner only). */
  async saveName(): Promise<void> {
    const name = this.nameDraft().trim();
    if (!name || !this.nameDirty() || this.saving()) return;
    this.saving.set(true);
    try {
      const h = await firstValueFrom(this.api.renameHousehold(name));
      this.apply(h);
      this.toast.show('Family name updated', { tone: 'success', durationMs: 1800 });
    } catch {
      this.toast.show("Couldn't rename the family — try again", { tone: 'warn' });
    } finally {
      this.saving.set(false);
    }
  }

  // ─────────────── ADD MEMBER (owner only) ───────────────

  openAdd(): void {
    this.pickedUserId.set(null);
    this.addOpen.set(true);
    this.loadCandidates();
  }

  closeAdd(): void {
    if (this.adding()) return;
    this.addOpen.set(false);
  }

  /** Lazy-load the candidate people when the add sheet first opens. */
  private loadCandidates(): void {
    if (this.candidatesLoading() || this.candidates().length > 0) return;
    this.candidatesLoading.set(true);
    firstValueFrom(this.api.householdCandidates())
      .then((list) => this.candidates.set(list ?? []))
      .catch(() => this.candidates.set([]))
      .finally(() => this.candidatesLoading.set(false));
  }

  /** Add the picked person to the household (owner only). */
  async addMember(): Promise<void> {
    const userId = this.pickedUserId();
    if (userId == null || this.adding()) return;
    this.adding.set(true);
    try {
      const h = await firstValueFrom(this.api.addMember(userId));
      this.apply(h);
      // Drop the just-added person from the picker so it can't be re-added, and reset the selection.
      this.candidates.update((list) => list.filter((c) => c.userId !== userId));
      this.pickedUserId.set(null);
      this.addOpen.set(false);
      this.toast.show('Welcome to the family!', { tone: 'success', durationMs: 2000 });
    } catch (e) {
      this.toast.show(this.messageOf(e, "Couldn't add that person — try again"), { tone: 'warn' });
    } finally {
      this.adding.set(false);
    }
  }

  // ─────────────── REMOVE MEMBER (owner only; never the owner) ───────────────

  /** A swipe-row commit on a removable card: left = remove. */
  onSwipe(m: HouseholdMember, side: 'left' | 'right'): void {
    if (side === 'left') void this.removeMember(m);
  }

  /** Remove a member (owner only; never the owner). */
  async removeMember(m: HouseholdMember): Promise<void> {
    if (!this.isOwner() || m.role === 'owner' || this.removingId() != null) return;
    if (typeof confirm === 'function' && !confirm(`Remove ${m.name} from the family?`)) return;
    this.removingId.set(m.userId);
    try {
      const h = await firstValueFrom(this.api.removeMember(m.userId));
      this.apply(h);
      // Refresh the picker so the removed person becomes addable again.
      this.candidates.set([]);
      this.toast.show(`${m.name} was removed from the family`, { tone: 'success', durationMs: 2000 });
    } catch (e) {
      this.toast.show(this.messageOf(e, "Couldn't remove that member — try again"), { tone: 'warn' });
    } finally {
      this.removingId.set(null);
    }
  }

  /** Pull the server's friendly `message` from an HttpErrorResponse, falling back to a default. */
  private messageOf(e: unknown, fallback: string): string {
    const msg = (e as { error?: { message?: string } })?.error?.message;
    return typeof msg === 'string' && msg ? msg : fallback;
  }
}
