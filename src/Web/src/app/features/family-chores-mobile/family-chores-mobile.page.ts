import {
  ChangeDetectionStrategy, Component, computed, inject, signal,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { MatIconModule } from '@angular/material/icon';

import { Api } from '../../core/api';
import {
  AllowanceMe, FamilyChore, FamilyChoreRecurrence, FamilyChores as FamilyChoresDto,
  FamilyChoreTally, FamilyCreditEntry,
} from '../../core/models';
import {
  BetaPullRefresh, BetaSegmentedControl, BetaBottomSheet, BetaSkeleton,
  BetaToaster, BetaEmptyState, BetaErrorState, ToastController, type Segment,
} from '../beta-ui';

/** Friendly labels for the recurrence chip. */
const RECURRENCE_LABEL: Record<FamilyChoreRecurrence, string> = {
  none: 'One-time',
  daily: 'Daily',
  weekly: 'Weekly',
};

/**
 * Chore Marketplace — the mobile-first twin of the live /family/chores board, rebuilt on the shared
 * beta-ui "Strata" kit (`@use '../beta-ui/beta-kit'`). One signature accent — a bright LIME → EMERALD —
 * re-skins the whole screen via the per-page accent contract. An immersive scrolling header (an accent
 * bloom + a tiny chores/stars stat strip, and — for a CHILD — their OWN balance chip), a
 * {@link BetaSegmentedControl} flipping between the OPEN marketplace (pool chores to claim), MINE (the
 * caller's in-progress chores), and a third tab that is the parent APPROVAL QUEUE or the child's PENDING
 * list (whichever the role calls for). Big glassy chore cards carry a star value + a recurrence chip and a
 * single primary action (claim / mark done / approve), a {@link BetaBottomSheet} DETAIL with the full
 * lifecycle + actions, pull-to-refresh, skeleton loaders, and elevated empty/error states.
 *
 * DATA PARITY + KID-SAFETY: every chore comes straight from the SAME role-scoped `/api/family/chores`
 * endpoint the live page uses — {@link Api.familyChores} (for a CHILD the server already rescopes the board
 * to the open pool + their OWN chores, and empties the tally). The claim → submit → approve/reject state
 * machine goes through {@link Api.claimFamilyChore} / {@link Api.submitFamilyChore} /
 * {@link Api.approveFamilyChore} / {@link Api.rejectFamilyChore} VERBATIM, each returning the full
 * re-scoped board. A child's own balance reads {@link Api.myAllowance}. The server enforces all role gating
 * (a child can only claim/submit; a parent approves/rejects), so the UI only ever offers the action the
 * returned `role` + `status` allow.
 *
 * ISOLATION: gated by `platform.mobile` + the SAME family route this twin lives under; it consumes the kit
 * + the SAME Api/models as the live counterpart. No live page is imported or modified. Layout is
 * mobile-first (44px+ targets, safe-area insets, no 390px overflow) and centers on desktop; reduced motion
 * collapses the kit animations via the a11y killswitch. Everyone is shown by display name + initials only;
 * an email is never rendered (email-privacy).
 */
@Component({
  selector: 'app-family-chores-mobile',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [ToastController],
  imports: [
    MatIconModule,
    BetaPullRefresh, BetaSegmentedControl, BetaBottomSheet, BetaSkeleton, BetaToaster,
    BetaEmptyState, BetaErrorState,
  ],
  template: `
    <app-bs-pull-refresh class="cm-ptr" [busy]="refreshing()" (refresh)="reload()">
      <div class="cm-scroll" aria-live="polite">

        <!-- ─── IMMERSIVE HEADER: title + stat strip ─── -->
        <header class="cm-hero">
          <p class="cm-hero__kicker"><mat-icon aria-hidden="true">checklist</mat-icon> Chores</p>
          <h1 class="cm-hero__title">{{ isChild() ? 'Earn your stars' : 'Chore Marketplace' }}</h1>
          <p class="cm-hero__sub">{{ isChild() ? 'Claim a chore, finish it, and send it for approval.' : 'Kids claim chores from the pool; you approve and award stars.' }}</p>

          @if (!loading() && !errored()) {
            <div class="cm-stats">
              <div class="cm-stat">
                <span class="cm-stat__n mono-num">{{ poolCount() }}</span>
                <span class="cm-stat__l">open to claim</span>
              </div>
              <div class="cm-stat">
                <span class="cm-stat__n mono-num">{{ mineCount() }}</span>
                <span class="cm-stat__l">{{ isChild() ? 'my chores' : 'in progress' }}</span>
              </div>
              @if (isChild()) {
                <div class="cm-stat cm-stat--bal">
                  <span class="cm-stat__n mono-num">{{ money(myBalance()) }}</span>
                  <span class="cm-stat__l">my balance</span>
                </div>
              } @else {
                <div class="cm-stat">
                  <span class="cm-stat__n mono-num">{{ totalStars() }}</span>
                  <span class="cm-stat__l">stars earned</span>
                </div>
              }
            </div>
          }
        </header>

        @if (loading()) {
          <div class="cm-seg-wrap" aria-hidden="true">
            <app-bs-skeleton width="100%" height="44px" radius="var(--r-pill)" />
          </div>
          <div class="cm-list" aria-hidden="true">
            @for (n of skeletonCells; track n) {
              <app-bs-skeleton height="88px" radius="var(--r-tile)" />
            }
          </div>

        } @else if (errored()) {
          <app-bs-error
            icon="cloud_off"
            title="Couldn't load the chore board"
            body="Something went wrong fetching the chores. Give it another go."
            (retry)="reload()" />

        } @else {
          <!-- ─── TAB SWITCH: Open | Mine | (Approve / Pending) ─── -->
          <div class="cm-seg-wrap">
            <app-bs-segmented class="cm-seg"
              [segments]="tabSegments()" [value]="tab()" label="Show chores"
              (change)="setTab($event)" />
          </div>

          @if (activeList(); as list) {
            @if (list.length) {
              <div class="cm-list">
                @for (c of list; track c.id; let i = $index) {
                  <article class="cm-card cm-reveal" [style.--ri]="i"
                           [class.is-busy]="isBusy(c.id)">
                    <button type="button" class="cm-card__main" (click)="openDetail(c)"
                            [attr.aria-label]="cardAria(c)">
                      <span class="cm-card__glyph" aria-hidden="true">
                        <mat-icon>{{ statusGlyph(c) }}</mat-icon>
                      </span>
                      <span class="cm-card__body">
                        <span class="cm-card__title">{{ c.title }}</span>
                        <span class="cm-card__meta">
                          <span class="cm-stars" aria-hidden="true">
                            @for (p of starPips(c.points); track p) { <mat-icon>star</mat-icon> }
                          </span>
                          <span class="mono-num">{{ c.points }}</span> star{{ c.points === 1 ? '' : 's' }}
                          @if (c.creditValue > 0) {
                            · <span class="cm-credit mono-num">{{ money(c.creditValue) }}</span>
                          }
                          @if (c.recurrence !== 'none') {
                            · <span class="cm-recur">{{ recurrenceLabel(c.recurrence) }}</span>
                          }
                        </span>
                        @if (whoLine(c); as who) {
                          <span class="cm-card__who">
                            <mat-icon aria-hidden="true">person</mat-icon>{{ who }}
                          </span>
                        }
                      </span>
                      <span class="cm-chip cm-chip--{{ c.status }}">{{ statusLabel(c) }}</span>
                    </button>

                    @if (primaryAction(c); as act) {
                      <button type="button" class="cm-card__cta cm-card__cta--{{ act.kind }}"
                              [disabled]="isBusy(c.id)" (click)="runPrimary(c)">
                        @if (isBusy(c.id)) { <span class="cm-spin" aria-hidden="true"></span> }
                        @else { <mat-icon aria-hidden="true">{{ act.icon }}</mat-icon> }
                        {{ act.label }}
                      </button>
                    }
                  </article>
                }
              </div>

            } @else {
              <app-bs-empty [icon]="emptyGlyph()" [title]="emptyTitle()" [body]="emptyBody()" />
            }
          }

          <!-- CHILD: their own balance ledger, a friendly recent strip -->
          @if (isChild() && myLedger().length) {
            <section class="cm-ledger">
              <h2 class="cm-ledger__title"><mat-icon aria-hidden="true">savings</mat-icon> My recent earnings</h2>
              <ul class="cm-ledger__list">
                @for (e of myLedger(); track e.id) {
                  <li class="cm-ledger__row">
                    <span class="cm-ledger__ic" [class.is-plus]="e.amount >= 0" aria-hidden="true">
                      <mat-icon>{{ e.amount >= 0 ? 'add' : 'remove' }}</mat-icon>
                    </span>
                    <span class="cm-ledger__note">{{ e.note || ledgerLabel(e) }}</span>
                    <span class="cm-ledger__amt mono-num" [class.is-plus]="e.amount >= 0">
                      {{ e.amount >= 0 ? '+' : '−' }}{{ money(e.amount) }}
                    </span>
                  </li>
                }
              </ul>
            </section>
          }
        }
      </div>
    </app-bs-pull-refresh>

    <!-- ─────────────── DETAIL BOTTOM SHEET ─────────────── -->
    <app-bs-sheet [(open)]="detailOpen" detent="half" [label]="selected()?.title || 'Chore detail'">
      @if (selected(); as c) {
        <div class="cd">
          <div class="cd__head">
            <span class="cd__glyph" aria-hidden="true"><mat-icon>{{ statusGlyph(c) }}</mat-icon></span>
            <div class="cd__titles">
              <h3 class="cd__title">{{ c.title }}</h3>
              <span class="cd__chip cm-chip cm-chip--{{ c.status }}">{{ statusLabel(c) }}</span>
            </div>
          </div>

          <div class="cd__rewards">
            <div class="cd__reward">
              <span class="cd__reward-n mono-num">{{ c.points }}</span>
              <span class="cd__reward-l"><mat-icon aria-hidden="true">star</mat-icon> star{{ c.points === 1 ? '' : 's' }}</span>
            </div>
            @if (c.creditValue > 0) {
              <div class="cd__reward cd__reward--credit">
                <span class="cd__reward-n mono-num">{{ money(c.creditValue) }}</span>
                <span class="cd__reward-l"><mat-icon aria-hidden="true">paid</mat-icon> on approval</span>
              </div>
            }
            <div class="cd__reward">
              <span class="cd__reward-n">{{ recurrenceLabel(c.recurrence) }}</span>
              <span class="cd__reward-l"><mat-icon aria-hidden="true">event_repeat</mat-icon> repeats</span>
            </div>
          </div>

          @if (whoLine(c); as who) {
            <p class="cd__who"><mat-icon aria-hidden="true">person</mat-icon> {{ who }}</p>
          }

          <p class="cd__hint">{{ statusHint(c) }}</p>

          @if (primaryAction(c); as act) {
            <button type="button" class="cd__cta cd__cta--{{ act.kind }}"
                    [disabled]="isBusy(c.id)" (click)="runPrimary(c)">
              @if (isBusy(c.id)) { <span class="cm-spin" aria-hidden="true"></span> Working… }
              @else { <mat-icon aria-hidden="true">{{ act.icon }}</mat-icon> {{ act.label }} }
            </button>
          }

          <!-- PARENT secondary action: send a submitted chore back -->
          @if (canReject(c)) {
            <button type="button" class="cd__cta cd__cta--reject"
                    [disabled]="isBusy(c.id)" (click)="reject(c)">
              <mat-icon aria-hidden="true">undo</mat-icon> Send back to try again
            </button>
          }
        </div>
      }
    </app-bs-sheet>

    <app-bs-toaster />
  `,
  styleUrl: './family-chores-mobile.page.scss',
})
export class FamilyChoresMobilePage {
  private api = inject(Api);
  private toast = inject(ToastController);

  /** The whole role-scoped board straight off the wire. */
  readonly chores = signal<FamilyChore[]>([]);
  readonly tally = signal<FamilyChoreTally[]>([]);
  /** The caller's household role — 'child' renders the kid-safe view. */
  readonly role = signal<'owner' | 'adult' | 'child'>('adult');
  /** The child's OWN allowance (kid view only; null until/unless loaded). */
  readonly myAllowance = signal<AllowanceMe | null>(null);

  readonly loading = signal(true);
  readonly errored = signal(false);
  readonly refreshing = signal(false);

  /** Which tab the segmented control shows. */
  readonly tab = signal<'open' | 'mine' | 'queue'>('open');

  /** Per-chore in-flight ids (claim / submit / approve / reject) so only that card's controls disable. */
  private readonly busyIds = signal<Set<number>>(new Set());

  /** Detail sheet state + the chore it's showing. */
  readonly detailOpen = signal(false);
  readonly selected = signal<FamilyChore | null>(null);

  readonly skeletonCells = Array.from({ length: 4 }, (_, i) => i);

  readonly isChild = computed(() => this.role() === 'child');

  // ── Buckets (mirror the live page's lifecycle splits) ──
  /** Open marketplace (pool) chores anyone can claim. */
  readonly pool = computed(() =>
    (this.chores() ?? []).filter((c) => c.source === 'pool' && c.status === 'open'),
  );
  /** The caller's in-progress chores: claimed / rejected (retry) / assigned-still-open. */
  readonly mine = computed(() =>
    (this.chores() ?? []).filter(
      (c) =>
        c.status === 'claimed' ||
        c.status === 'rejected' ||
        (c.source === 'assigned' && c.status === 'open'),
    ),
  );
  /** Submitted chores awaiting a parent's nod (the approval queue / the child's pending list). */
  readonly queue = computed(() => (this.chores() ?? []).filter((c) => c.status === 'submitted'));

  readonly poolCount = computed(() => this.pool().length);
  readonly mineCount = computed(() => this.mine().length);
  readonly queueCount = computed(() => this.queue().length);

  readonly totalStars = computed(() => (this.tally() ?? []).reduce((n, t) => n + t.points, 0));
  readonly myBalance = computed(() => this.myAllowance()?.balance ?? 0);
  /** The child's most-recent ledger rows (kid view), newest first, capped for a tidy strip. */
  readonly myLedger = computed<FamilyCreditEntry[]>(() => (this.myAllowance()?.ledger ?? []).slice(0, 6));

  readonly tabSegments = computed<Segment[]>(() => [
    { key: 'open', label: `Open${this.poolCount() ? ' · ' + this.poolCount() : ''}` },
    { key: 'mine', label: `Mine${this.mineCount() ? ' · ' + this.mineCount() : ''}` },
    {
      key: 'queue',
      label: `${this.isChild() ? 'Pending' : 'Approve'}${this.queueCount() ? ' · ' + this.queueCount() : ''}`,
    },
  ]);

  /** The list backing the active tab. */
  readonly activeList = computed<FamilyChore[]>(() => {
    switch (this.tab()) {
      case 'mine': return this.mine();
      case 'queue': return this.queue();
      default: return this.pool();
    }
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
      const board = await firstValueFrom(this.api.familyChores());
      this.applyBoard(board);
      // A child's own balance lives behind a separate kid-safe endpoint; load it best-effort.
      if (board.role === 'child') {
        try {
          this.myAllowance.set(await firstValueFrom(this.api.myAllowance()));
        } catch {
          this.myAllowance.set(this.myAllowance());
        }
      } else {
        this.myAllowance.set(null);
      }
    } catch {
      this.errored.set(true);
    } finally {
      this.loading.set(false);
      if (wasLoaded) {
        this.refreshing.set(false);
        this.toast.show('Chores refreshed', { tone: 'success', durationMs: 1600 });
      }
    }
  }

  /** Push a fresh board into state + keep the open detail sheet in sync (drop it if the chore is gone). */
  private applyBoard(board: FamilyChoresDto): void {
    const chores = board.chores ?? [];
    this.chores.set(chores);
    this.tally.set(board.tally ?? []);
    this.role.set(board.role ?? 'adult');
    const sel = this.selected();
    if (sel) {
      const next = chores.find((c) => c.id === sel.id);
      this.selected.set(next ?? null);
      if (!next) this.detailOpen.set(false);
    }
  }

  setTab(key: string): void {
    this.tab.set(key === 'mine' ? 'mine' : key === 'queue' ? 'queue' : 'open');
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

  recurrenceLabel(r: FamilyChoreRecurrence): string {
    return RECURRENCE_LABEL[r] ?? 'One-time';
  }

  /** A small array (1..5) to render the star pips on a chore card. */
  starPips(points: number): number[] {
    return Array.from({ length: Math.min(5, Math.max(1, points)) }, (_, i) => i);
  }

  /** Format a credit amount as money (e.g. 1.5 → "$1.50"); the sign is handled by the caller. */
  money(amount: number): string {
    return `$${Math.abs(amount).toFixed(2)}`;
  }

  /** The status chip glyph for a chore's lifecycle. */
  statusGlyph(c: FamilyChore): string {
    switch (c.status) {
      case 'submitted': return 'hourglass_top';
      case 'claimed': return 'pending_actions';
      case 'approved': return 'task_alt';
      case 'rejected': return 'replay';
      default: return c.source === 'pool' ? 'campaign' : 'assignment';
    }
  }

  statusLabel(c: FamilyChore): string {
    switch (c.status) {
      case 'submitted': return 'Awaiting approval';
      case 'claimed': return 'In progress';
      case 'approved': return 'Done';
      case 'rejected': return 'Try again';
      default: return c.source === 'pool' ? 'Open to claim' : 'To do';
    }
  }

  /** A friendly sentence describing where the chore is in its lifecycle (shown in the detail sheet). */
  statusHint(c: FamilyChore): string {
    switch (c.status) {
      case 'submitted':
        return this.isChild()
          ? 'A grown-up is reviewing this. You’ll get your stars once it’s approved.'
          : 'This chore is done and waiting for your approval.';
      case 'claimed':
        return this.isChild()
          ? 'You claimed this. Finish it, then mark it done for approval.'
          : 'Claimed and in progress.';
      case 'rejected':
        return 'This came back to try again — give it another go, then resubmit.';
      case 'approved':
        return 'All done and approved.';
      default:
        return c.source === 'pool'
          ? this.isChild()
            ? 'Up for grabs — claim it to make it yours.'
            : 'In the pool, waiting for a kid to claim it.'
          : 'Assigned and ready to start.';
    }
  }

  /** The person tied to this chore (claimer or assignee) — display name only, never email. */
  whoLine(c: FamilyChore): string | null {
    return c.claimedByName ?? c.assignedToName ?? null;
  }

  ledgerLabel(e: FamilyCreditEntry): string {
    if (e.choreCompletionId != null) return 'Chore reward';
    return e.amount >= 0 ? 'Bonus' : 'Spent';
  }

  cardAria(c: FamilyChore): string {
    const reward = `${c.points} star${c.points === 1 ? '' : 's'}${c.creditValue > 0 ? `, ${this.money(c.creditValue)} on approval` : ''}`;
    return `${c.title}, ${this.statusLabel(c)}, ${reward}. Open details.`;
  }

  // ── empty-state copy, per tab + role ──
  emptyGlyph(): string {
    return this.tab() === 'open' ? 'storefront' : this.tab() === 'mine' ? 'inbox' : 'inventory';
  }
  emptyTitle(): string {
    if (this.tab() === 'open') return 'No open chores';
    if (this.tab() === 'mine') return this.isChild() ? 'Nothing on your plate' : 'Nothing in progress';
    return this.isChild() ? 'Nothing pending' : 'Approval queue is clear';
  }
  emptyBody(): string {
    if (this.tab() === 'open') {
      return this.isChild()
        ? 'When a grown-up posts a chore to the pool, it shows up here to claim.'
        : 'Post a pool chore from the desktop board and kids can claim it here.';
    }
    if (this.tab() === 'mine') {
      return this.isChild()
        ? 'Claim a chore from the Open tab to get started.'
        : 'Claimed and rejected chores in flight will appear here.';
    }
    return this.isChild()
      ? 'Chores you’ve sent for approval will wait here.'
      : 'Nothing is waiting on you — every submitted chore is handled.';
  }

  // ── the single primary action a card/detail offers, derived from role + status ──
  /**
   * Returns the one lifecycle action available to THIS caller on THIS chore, or null. The server is the real
   * gate; this only surfaces the action the returned role + status make valid (claim/submit for a child,
   * approve for a parent).
   */
  primaryAction(c: FamilyChore): { kind: 'claim' | 'submit' | 'approve'; icon: string; label: string } | null {
    if (this.isChild()) {
      if (c.source === 'pool' && c.status === 'open') {
        return { kind: 'claim', icon: 'pan_tool_alt', label: 'Claim it' };
      }
      if (c.status === 'claimed' || c.status === 'rejected' || (c.source === 'assigned' && c.status === 'open')) {
        return { kind: 'submit', icon: 'check', label: 'Mark done' };
      }
      return null;
    }
    // Parent
    if (c.status === 'submitted') {
      return { kind: 'approve', icon: 'verified', label: 'Approve' };
    }
    return null;
  }

  /** A parent can send a submitted chore back to retry. */
  canReject(c: FamilyChore): boolean {
    return !this.isChild() && c.status === 'submitted';
  }

  // ─────────────── DETAIL ───────────────

  openDetail(c: FamilyChore): void {
    this.selected.set(c);
    this.detailOpen.set(true);
  }

  // ─────────────── ACTIONS (reuse the live Api verbatim; each returns the full re-scoped board) ───────────────

  /** Run the card's primary action (claim / submit / approve) via the matching endpoint. */
  async runPrimary(c: FamilyChore): Promise<void> {
    const act = this.primaryAction(c);
    if (!act) return;
    switch (act.kind) {
      case 'claim':
        return this.runAction(c, () => this.api.claimFamilyChore(c.id), 'Claimed — it’s yours now 🙌', "Couldn't claim that chore.");
      case 'submit':
        return this.runAction(c, () => this.api.submitFamilyChore(c.id), 'Sent for approval ✅', "Couldn't submit that chore.");
      case 'approve': {
        const credit = c.creditValue > 0 ? ` ${this.money(c.creditValue)} earned 💰` : '';
        return this.runAction(c, () => this.api.approveFamilyChore(c.id), `Approved!${credit}`, "Couldn't approve that chore.");
      }
    }
  }

  /** A parent sends a submitted chore back to the child (with a confirm). */
  async reject(c: FamilyChore): Promise<void> {
    const who = c.claimedByName ?? c.assignedToName ?? 'the child';
    if (typeof confirm === 'function' &&
        !confirm(`Send “${c.title}” back to ${who} to try again? Nothing is awarded.`)) {
      return;
    }
    await this.runAction(c, () => this.api.rejectFamilyChore(c.id), 'Sent back to try again.', "Couldn't send that chore back.");
  }

  /** Shared runner: lock the row, call the endpoint, apply the refreshed board, toast the outcome. */
  private async runAction(
    c: FamilyChore,
    call: () => ReturnType<Api['familyChores']>,
    okMsg: string,
    failMsg: string,
  ): Promise<void> {
    if (this.isBusy(c.id)) return;
    this.setBusy(c.id, true);
    try {
      const board = await firstValueFrom(call());
      this.applyBoard(board);
      // A parent approval can move money — refresh nothing else; the child's own balance is their device.
      this.toast.show(okMsg, { tone: 'success', durationMs: 2200 });
    } catch (e) {
      this.toast.show(this.messageOf(e, failMsg), { tone: 'warn', durationMs: 3200 });
    } finally {
      this.setBusy(c.id, false);
    }
  }

  private messageOf(e: unknown, fallback: string): string {
    const msg = (e as { error?: { message?: string } })?.error?.message;
    return typeof msg === 'string' && msg ? msg : fallback;
  }
}
