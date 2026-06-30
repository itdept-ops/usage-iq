import {
  ChangeDetectionStrategy, Component, computed, inject, signal,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { MatIconModule } from '@angular/material/icon';

import { Api } from '../../core/api';
import {
  Allowance, AllowanceMoveRequest, AllowanceSpendCategory, ChildBalance, FamilyCreditEntry,
} from '../../core/models';
import {
  BetaPullRefresh, BetaBottomSheet, BetaSkeleton, BetaSegmentedControl, BetaToaster,
  BetaEmptyState, BetaErrorState, ToastController, type Segment,
} from '../beta-ui';

/** Which money-move the open sheet records (mirrors the live page's MoveKind). */
type MoveKind = 'payout' | 'spend' | 'adjust';

/** The fixed spend categories (mirrors the live page + the backend SpendCategories enum). */
const SPEND_CATEGORIES: { value: AllowanceSpendCategory; label: string; icon: string }[] = [
  { value: 'toys', label: 'Toys', icon: 'toys' },
  { value: 'games', label: 'Games', icon: 'sports_esports' },
  { value: 'books', label: 'Books', icon: 'menu_book' },
  { value: 'clothes', label: 'Clothes', icon: 'checkroom' },
  { value: 'treats', label: 'Treats', icon: 'icecream' },
  { value: 'savings', label: 'Savings', icon: 'savings' },
  { value: 'other', label: 'Other', icon: 'category' },
];

/**
 * Family Hub — Allowance Manager, the mobile-first twin of the live `/family/allowance` page
 * (features/family/allowance.ts), rebuilt on the shared beta-ui "Strata" kit. A PARENT-only money
 * manager for every household child's earned credits, gated server-side by `allowance.manage`.
 *
 * Re-presents the SAME data path verbatim: {@link Api.allowance} returns each child's balance card +
 * a recent family-wide credit ledger; writes go through {@link Api.allowancePayout} /
 * {@link Api.allowanceSpend} / {@link Api.allowanceAdjust} EXACTLY as the live page calls them
 * (`amount` is the positive magnitude; the server signs it — `category` for spends, `sign` ±1 for
 * adjusts). Children are shown by display name + initials avatar only — NEVER an email (email-privacy);
 * the server enforces all gating + child-ownership scoping.
 *
 * Layout: an immersive scrolling header with the total-across-children headline, a balance card per
 * child (its own balance + a "record" affordance), and a recent-activity ledger. Tapping a child (or
 * its Pay / Spend / Adjust action) opens a {@link BetaBottomSheet} record-transaction form — a
 * segmented Pay-out / Spend / Adjust control, an amount field, a category picker (spend) or a
 * bonus/dock toggle (adjust), and an optional note. Overdraw is allowed (a parent may advance cash);
 * a negative balance is surfaced with a gentle warning, never blocked. Pull-to-refresh, skeleton
 * loaders, and elevated empty/error states round it out — and it renders cleanly with ZERO children.
 *
 * ISOLATION: gated by `platform.mobile` + the SAME `allowance.manage` the live route carries; it
 * consumes the kit + the SAME Api/models as the live counterpart. No live page is imported or changed.
 */
@Component({
  selector: 'app-family-allowance-mobile',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [ToastController],
  imports: [
    DecimalPipe, FormsModule, MatIconModule,
    BetaPullRefresh, BetaBottomSheet, BetaSkeleton, BetaSegmentedControl, BetaToaster,
    BetaEmptyState, BetaErrorState,
  ],
  template: `
    <!-- ─────────────── PULL-TO-REFRESH OWNS THE SCROLL ─────────────── -->
    <app-bs-pull-refresh class="al-ptr" [busy]="refreshing()" (refresh)="reload()">
      <div class="al-scroll" aria-live="polite">

        <!-- ─── IMMERSIVE HEADER: total balance across all children ─── -->
        <header class="al-hero">
          <p class="al-hero__kicker"><mat-icon aria-hidden="true">savings</mat-icon> Allowance</p>
          <h1 class="al-hero__title">Allowance Manager</h1>
          <p class="al-hero__sub">Each child's earned credits — pay out cash, log a spend, or adjust.</p>

          @if (!loading() && !errored()) {
            <div class="al-total">
              <span class="al-total__l">Total owed across {{ children().length }} {{ children().length === 1 ? 'child' : 'children' }}</span>
              <span class="al-total__n mono-num" [class.is-neg]="totalBalance() < 0">
                {{ totalBalance() < 0 ? '−' : '' }}\${{ absMoney(totalBalance()) | number:'1.2-2' }}
              </span>
            </div>
          }
        </header>

        @if (loading()) {
          <!-- skeleton cards -->
          <div class="al-list" aria-hidden="true">
            @for (n of skeletonCells; track n) {
              <app-bs-skeleton height="104px" radius="var(--r-tile)" />
            }
          </div>

        } @else if (errored()) {
          <app-bs-error
            icon="cloud_off"
            title="Couldn't load allowances"
            body="Something went wrong fetching the manager. Give it another go."
            (retry)="reload()" />

        } @else if (!children().length) {
          <!-- EMPTY: no children in the household -->
          <app-bs-empty
            icon="family_restroom"
            title="No children yet"
            body="When a child joins your household, their allowance balance shows up here. Earned credits come from approved chores; you record pay-outs and spends against them." />

        } @else {
          <!-- ─── BALANCE CARD PER CHILD ─── -->
          <section class="al-list" aria-label="Children's balances">
            @for (c of children(); track c.childUserId; let i = $index) {
              <article class="al-card al-reveal" [style.--ri]="i" [class.is-neg]="c.balance < 0">
                <button type="button" class="al-card__main" (click)="openMove(c, 'payout')"
                        [attr.aria-label]="'Record a transaction for ' + c.name + ', balance ' + balanceAria(c.balance)">
                  <span class="al-card__avatar" aria-hidden="true">{{ initials(c.name) }}</span>
                  <span class="al-card__id">
                    <span class="al-card__name">{{ c.name }}</span>
                    <span class="al-card__bal-l">Balance</span>
                  </span>
                  <span class="al-card__bal mono-num" [class.is-neg]="c.balance < 0">
                    {{ c.balance < 0 ? '−' : '' }}\${{ absMoney(c.balance) | number:'1.2-2' }}
                  </span>
                </button>

                @if (c.balance < 0) {
                  <p class="al-card__warn"><mat-icon aria-hidden="true">info</mat-icon> Below zero — cash advanced</p>
                }

                <div class="al-card__actions">
                  <button type="button" class="al-act al-act--pay" (click)="openMove(c, 'payout')">
                    <mat-icon aria-hidden="true">payments</mat-icon> Pay out
                  </button>
                  <button type="button" class="al-act al-act--spend" (click)="openMove(c, 'spend')">
                    <mat-icon aria-hidden="true">shopping_bag</mat-icon> Spend
                  </button>
                  <button type="button" class="al-act al-act--adjust" (click)="openMove(c, 'adjust')">
                    <mat-icon aria-hidden="true">tune</mat-icon> Adjust
                  </button>
                </div>
              </article>
            }
          </section>

          <!-- ─── RECENT ACTIVITY LEDGER ─── -->
          <section class="al-ledger" aria-label="Recent activity">
            <h2 class="al-ledger__title"><mat-icon aria-hidden="true">history</mat-icon> Recent activity</h2>
            @if (recent().length) {
              <ul class="al-feed">
                @for (e of recent(); track e.id) {
                  <li class="al-feed__row">
                    <span class="al-feed__ic" [attr.data-kind]="e.kind" aria-hidden="true">
                      <mat-icon>{{ ledgerIcon(e.kind) }}</mat-icon>
                    </span>
                    <span class="al-feed__body">
                      <span class="al-feed__head">{{ kindLabel(e.kind) }}{{ e.category ? ' · ' + categoryLabel(e.category) : '' }}</span>
                      @if (e.note) { <span class="al-feed__note">{{ e.note }}</span> }
                      <span class="al-feed__when">{{ whenLabel(e.createdUtc) }}</span>
                    </span>
                    <span class="al-feed__amt mono-num" [class.is-pos]="e.amount > 0" [class.is-neg]="e.amount < 0">
                      {{ e.amount > 0 ? '+' : e.amount < 0 ? '−' : '' }}\${{ absMoney(e.amount) | number:'1.2-2' }}
                    </span>
                  </li>
                }
              </ul>
            } @else {
              <p class="al-feed__empty"><mat-icon aria-hidden="true">inbox</mat-icon> No activity yet. Pay-outs, spends and adjustments will show here.</p>
            }
          </section>
        }
      </div>
    </app-bs-pull-refresh>

    <!-- ─────────────── RECORD-TRANSACTION SHEET ─────────────── -->
    <app-bs-sheet [(open)]="moveOpen" detent="half" [dismissable]="!saving()"
                  [label]="activeChild() ? 'Record for ' + activeChild()!.name : 'Record transaction'">
      @if (activeChild(); as c) {
        <form class="mv" (ngSubmit)="save()">
          <div class="mv__head">
            <span class="mv__avatar" aria-hidden="true">{{ initials(c.name) }}</span>
            <div class="mv__titles">
              <h3 class="mv__name">{{ c.name }}</h3>
              <span class="mv__bal" [class.is-neg]="c.balance < 0">
                Balance {{ c.balance < 0 ? '−' : '' }}\${{ absMoney(c.balance) | number:'1.2-2' }}
              </span>
            </div>
            <button type="button" class="mv__close" (click)="closeMove()" aria-label="Cancel" [disabled]="saving()">
              <mat-icon aria-hidden="true">close</mat-icon>
            </button>
          </div>

          <!-- kind switch -->
          <app-bs-segmented class="mv__seg"
            [segments]="moveSegments" [value]="moveKind()" label="Transaction kind"
            [disabled]="saving()" (change)="setKind($event)" />

          <p class="mv__hint">{{ kindHint() }}</p>

          <!-- amount -->
          <label class="mv__field">
            <span class="mv__label">Amount</span>
            <span class="mv__amount">
              <span class="mv__dollar" aria-hidden="true">$</span>
              <input class="mv__input mono-num" type="number" inputmode="decimal" min="0" step="0.01"
                     [ngModel]="amount()" (ngModelChange)="amount.set($event === '' || $event == null ? null : +$event)"
                     name="amount" placeholder="0.00" autocomplete="off" />
            </span>
          </label>

          <!-- spend category -->
          @if (moveKind() === 'spend') {
            <div class="mv__cats" role="radiogroup" aria-label="Spend category">
              @for (cat of categories; track cat.value) {
                <button type="button" class="mv__cat" [class.is-on]="category() === cat.value"
                        role="radio" [attr.aria-checked]="category() === cat.value"
                        (click)="category.set(cat.value)">
                  <mat-icon aria-hidden="true">{{ cat.icon }}</mat-icon>
                  <span>{{ cat.label }}</span>
                </button>
              }
            </div>
          }

          <!-- adjust direction -->
          @if (moveKind() === 'adjust') {
            <div class="mv__dir" role="radiogroup" aria-label="Adjustment direction">
              <button type="button" class="mv__dir-btn mv__dir-btn--up" [class.is-on]="adjustSign() === 1"
                      role="radio" [attr.aria-checked]="adjustSign() === 1" (click)="adjustSign.set(1)">
                <mat-icon aria-hidden="true">add_circle</mat-icon> Bonus
              </button>
              <button type="button" class="mv__dir-btn mv__dir-btn--down" [class.is-on]="adjustSign() === -1"
                      role="radio" [attr.aria-checked]="adjustSign() === -1" (click)="adjustSign.set(-1)">
                <mat-icon aria-hidden="true">remove_circle</mat-icon> Dock
              </button>
            </div>
          }

          <!-- note -->
          <label class="mv__field">
            <span class="mv__label">Note <i>(optional)</i></span>
            <input class="mv__input" type="text" [ngModel]="note()" (ngModelChange)="note.set($event)"
                   name="note" maxlength="160" autocomplete="off"
                   [placeholder]="notePlaceholder()" />
          </label>

          @if (overdrawWarning()) {
            <p class="mv__overdraw"><mat-icon aria-hidden="true">warning</mat-icon> This puts {{ c.name }} below zero.</p>
          }

          <div class="mv__actions">
            <button type="button" class="mv__btn mv__btn--ghost" (click)="closeMove()" [disabled]="saving()">Cancel</button>
            <button type="submit" class="mv__btn mv__btn--save" [disabled]="!canSave()">
              @if (saving()) { <span class="mv__spin" aria-hidden="true"></span> Saving… }
              @else { <mat-icon aria-hidden="true">check</mat-icon> {{ saveLabel() }} }
            </button>
          </div>
        </form>
      }
    </app-bs-sheet>

    <app-bs-toaster />
  `,
  styleUrl: './family-allowance-mobile.page.scss',
})
export class FamilyAllowanceMobilePage {
  private api = inject(Api);
  private toast = inject(ToastController);

  /** Per-child balance cards from the parent manager (server-scoped to the caller's household). */
  readonly children = signal<ChildBalance[]>([]);
  /** The recent family-wide credit ledger. */
  readonly recent = signal<FamilyCreditEntry[]>([]);

  readonly loading = signal(true);
  readonly errored = signal(false);
  readonly refreshing = signal(false);

  readonly categories = SPEND_CATEGORIES;
  readonly skeletonCells = Array.from({ length: 3 }, (_, i) => i);

  readonly moveSegments: Segment[] = [
    { key: 'payout', label: 'Pay out' },
    { key: 'spend', label: 'Spend' },
    { key: 'adjust', label: 'Adjust' },
  ];

  // ---- record-transaction sheet state (mirrors the live page's fields) ----
  readonly moveOpen = signal(false);
  readonly activeChild = signal<ChildBalance | null>(null);
  readonly moveKind = signal<MoveKind>('payout');
  readonly saving = signal(false);

  readonly amount = signal<number | null>(null);
  readonly category = signal<AllowanceSpendCategory>('toys');
  readonly note = signal('');
  /** Adjust direction: +1 = bonus, −1 = dock. */
  readonly adjustSign = signal<number>(1);

  /** Total balance across all children (the page headline). */
  readonly totalBalance = computed(() => this.children().reduce((n, c) => n + c.balance, 0));

  readonly canSave = computed(() => {
    const a = this.amount();
    return !this.saving() && a != null && Number.isFinite(a) && a > 0;
  });

  /** True when a payout/spend would push the active child negative (warn, never block). */
  readonly overdrawWarning = computed(() => {
    const c = this.activeChild();
    const a = this.amount();
    const k = this.moveKind();
    if (!c || a == null || !Number.isFinite(a) || a <= 0) return false;
    return (k === 'payout' || k === 'spend') && a > c.balance;
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
      const a = await firstValueFrom(this.api.allowance());
      this.apply(a);
    } catch {
      if (!wasLoaded) this.errored.set(true);
      else this.toast.show("Couldn't refresh — try again", { tone: 'warn' });
    } finally {
      this.loading.set(false);
      if (wasLoaded) {
        this.refreshing.set(false);
        if (!this.errored()) this.toast.show('Allowances refreshed', { tone: 'success', durationMs: 1500 });
      }
    }
  }

  private apply(a: Allowance): void {
    this.children.set(a?.children ?? []);
    this.recent.set(a?.recent ?? []);
    // Keep the open sheet's child in sync with the freshly loaded balance.
    const open = this.activeChild();
    if (open) {
      const next = (a?.children ?? []).find((c) => c.childUserId === open.childUserId);
      this.activeChild.set(next ?? open);
    }
  }

  // ─────────────── DISPLAY HELPERS ───────────────

  initials(name: string): string {
    const parts = (name || '').split(/\s+/).filter(Boolean);
    return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
  }

  absMoney(amount: number): number {
    return Math.abs(amount);
  }

  balanceAria(balance: number): string {
    return `${balance < 0 ? 'negative ' : ''}$${Math.abs(balance).toFixed(2)}`;
  }

  ledgerIcon(kind: FamilyCreditEntry['kind']): string {
    switch (kind) {
      case 'earn': return 'star';
      case 'spend': return 'shopping_bag';
      case 'payout': return 'payments';
      default: return 'tune';
    }
  }

  kindLabel(kind: FamilyCreditEntry['kind']): string {
    switch (kind) {
      case 'earn': return 'Earned';
      case 'spend': return 'Spent';
      case 'payout': return 'Paid out';
      default: return 'Adjusted';
    }
  }

  categoryLabel(cat: string): string {
    return this.categories.find((c) => c.value === cat)?.label ?? cat;
  }

  whenLabel(iso: string): string {
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return '';
    const diff = Date.now() - t;
    const mins = Math.round(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.round(hrs / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  // ─────────────── RECORD-TRANSACTION SHEET ───────────────

  openMove(child: ChildBalance, kind: MoveKind): void {
    this.activeChild.set(child);
    this.moveKind.set(kind);
    this.amount.set(null);
    this.category.set('toys');
    this.note.set('');
    this.adjustSign.set(1);
    this.moveOpen.set(true);
  }

  setKind(key: string): void {
    if (key === 'spend' || key === 'adjust') this.moveKind.set(key);
    else this.moveKind.set('payout');
  }

  closeMove(): void {
    if (this.saving()) return;
    this.moveOpen.set(false);
  }

  kindHint(): string {
    switch (this.moveKind()) {
      case 'payout': return 'Record cash you handed over — debits the in-app balance.';
      case 'spend': return 'Log a purchase made from this balance.';
      default: return 'A manual bonus (+) or dock (−) to the balance.';
    }
  }

  notePlaceholder(): string {
    switch (this.moveKind()) {
      case 'payout': return 'e.g. Saturday allowance';
      case 'spend': return 'e.g. New Lego set';
      default: return 'e.g. Extra chores this week';
    }
  }

  saveLabel(): string {
    switch (this.moveKind()) {
      case 'payout': return 'Record pay-out';
      case 'spend': return 'Record spend';
      default: return this.adjustSign() === 1 ? 'Add bonus' : 'Dock balance';
    }
  }

  /** Record the open money move via the SAME Api the live page uses; refresh on success. */
  async save(): Promise<void> {
    const child = this.activeChild();
    if (!child || !this.canSave()) return;

    const amount = Math.round((this.amount() as number) * 100) / 100;
    const kind = this.moveKind();
    const note = this.note().trim() || null;
    const req: AllowanceMoveRequest = { amount, note };

    let call;
    if (kind === 'payout') {
      call = this.api.allowancePayout(child.childUserId, req);
    } else if (kind === 'spend') {
      req.category = this.category();
      call = this.api.allowanceSpend(child.childUserId, req);
    } else {
      req.sign = this.adjustSign();
      call = this.api.allowanceAdjust(child.childUserId, req);
    }

    this.saving.set(true);
    try {
      const a = await firstValueFrom(call);
      this.apply(a);
      this.moveOpen.set(false);
      const verb = kind === 'payout' ? 'Paid out' : kind === 'spend' ? 'Recorded spend of' : 'Adjusted';
      this.toast.show(`${verb} $${amount.toFixed(2)} for ${child.name}.`,
        { tone: 'success', durationMs: 2400 });
    } catch (e) {
      this.toast.show(this.messageOf(e, "Couldn't record that — try again"), { tone: 'warn' });
    } finally {
      this.saving.set(false);
    }
  }

  private messageOf(e: unknown, fallback: string): string {
    const msg = (e as { error?: { message?: string } })?.error?.message;
    return typeof msg === 'string' && msg ? msg : fallback;
  }
}
