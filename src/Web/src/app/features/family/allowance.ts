import {
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
  ChangeDetectionStrategy,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { catchError, firstValueFrom, of } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';

import { Api } from '../../core/api';
import { BetaEmptyState, BetaErrorState } from '../beta-ui';
import {
  Allowance as AllowanceDto,
  AllowanceMoveRequest,
  AllowanceSpendCategory,
  ChildBalance,
  FamilyCreditEntry,
} from '../../core/models';

/** Which money-move sheet is open for which child (only one at a time), or none. */
type MoveKind = 'payout' | 'spend' | 'adjust';

/** The fixed spend categories offered in the spend form (mirrors the backend's small enum). */
const SPEND_CATEGORIES: { value: AllowanceSpendCategory; label: string }[] = [
  { value: 'toys', label: 'Toys' },
  { value: 'games', label: 'Games' },
  { value: 'books', label: 'Books' },
  { value: 'clothes', label: 'Clothes' },
  { value: 'treats', label: 'Treats' },
  { value: 'savings', label: 'Savings' },
  { value: 'other', label: 'Other' },
];

/**
 * Family Hub — the Allowance Manager (features/family/allowance, a child of /family gated by allowance.manage).
 * A PARENT-only money manager for every household child's earned credits: a balance card per child, the recent
 * credit ledger across the family, and inline actions to record a cash PAYOUT (debits the in-app balance to
 * mirror cash handed over IRL), a SPEND (against a category), or a manual ADJUST (bonus/penalty).
 *
 * Children are shown by display name + initials avatar only — NEVER an email (email-privacy). Every write is
 * gated by allowance.manage server-side and scoped to a CHILD member of the caller's own household. Overdraw
 * is allowed (a parent may advance cash); a negative balance is surfaced with a gentle warning.
 */
@Component({
  selector: 'app-family-allowance',
  imports: [
    FormsModule,
    RouterLink,
    MatIconModule,
    MatButtonModule,
    MatTooltipModule,
    MatProgressSpinnerModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatSnackBarModule,
    BetaEmptyState,
    BetaErrorState,
  ],
  templateUrl: './allowance.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrls: ['./family.scss', './chores.scss', './allowance.scss'],
})
export class FamilyAllowance {
  private api = inject(Api);
  private snack = inject(MatSnackBar);
  private destroyRef = inject(DestroyRef);

  readonly children = signal<ChildBalance[]>([]);
  readonly recent = signal<FamilyCreditEntry[]>([]);
  readonly loading = signal(true);
  readonly error = signal(false);

  readonly categories = SPEND_CATEGORIES;

  /** The child whose money-move form is open + which kind, or null. */
  readonly openChildId = signal<number | null>(null);
  readonly moveKind = signal<MoveKind>('payout');
  /** True while a payout/spend/adjust write is in flight. */
  readonly saving = signal(false);

  // The move form fields (reset when a sheet opens).
  readonly amount = signal<number | null>(null);
  readonly category = signal<AllowanceSpendCategory>('toys');
  readonly note = signal('');
  /** Adjust direction: +1 = bonus, −1 = dock. */
  readonly adjustSign = signal<number>(1);

  /** The total balance across all children (the page headline). */
  readonly totalBalance = computed(() => this.children().reduce((n, c) => n + c.balance, 0));

  constructor() {
    this.reload(true);
  }

  /** Public retry for the error-state CTA: clear the error flag and re-run the initial load. */
  retryLoad(): void {
    this.error.set(false);
    this.reload(true);
  }

  private reload(initial = false): void {
    if (initial) this.loading.set(true);
    this.api
      .allowance()
      .pipe(
        catchError(() => {
          if (initial) this.error.set(true);
          return of<AllowanceDto | null>(null);
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((a) => {
        if (a) this.apply(a);
        this.loading.set(false);
      });
  }

  private apply(a: AllowanceDto): void {
    this.children.set(a?.children ?? []);
    this.recent.set(a?.recent ?? []);
  }

  initials(name: string): string {
    const parts = (name || '').split(/\s+/).filter(Boolean);
    return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
  }

  money(amount: number): string {
    return `$${Math.abs(amount).toFixed(2)}`;
  }

  ledgerIcon(kind: FamilyCreditEntry['kind']): string {
    switch (kind) {
      case 'earn':
        return 'star';
      case 'spend':
        return 'shopping_bag';
      case 'payout':
        return 'payments';
      default:
        return 'tune';
    }
  }

  // ---- Open / close a money-move sheet ----

  /** Open (or toggle closed) a payout/spend/adjust form for one child. Resets the form fields. */
  toggleMove(child: ChildBalance, kind: MoveKind): void {
    if (this.saving()) return;
    if (this.openChildId() === child.childUserId && this.moveKind() === kind) {
      this.openChildId.set(null);
      return;
    }
    this.openChildId.set(child.childUserId);
    this.moveKind.set(kind);
    this.amount.set(null);
    this.category.set('toys');
    this.note.set('');
    this.adjustSign.set(1);
  }

  isOpen(child: ChildBalance, kind: MoveKind): boolean {
    return this.openChildId() === child.childUserId && this.moveKind() === kind;
  }

  readonly canSave = computed(() => {
    const a = this.amount();
    return a != null && Number.isFinite(a) && a > 0;
  });

  /** Record the open money move. Partial-failure aware via a clear snackbar; refreshes the manager on success. */
  async save(child: ChildBalance): Promise<void> {
    if (!this.canSave() || this.saving()) return;
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

    // Warn (don't block) on an overdraw — a parent may advance cash, so the server allows a negative balance.
    if ((kind === 'payout' || kind === 'spend') && amount > child.balance) {
      this.snack.open(`Heads up: this puts ${child.name} below zero.`, undefined, {
        duration: 2600,
      });
    }

    this.saving.set(true);
    try {
      const a = await firstValueFrom(call);
      this.apply(a);
      this.openChildId.set(null);
      const verb =
        kind === 'payout' ? 'Paid out' : kind === 'spend' ? 'Recorded spend' : 'Adjusted';
      this.snack.open(`${verb} ${this.money(amount)} for ${child.name}.`, undefined, {
        duration: 2600,
      });
    } catch (e) {
      this.snack.open(this.messageOf(e, "Couldn't record that just now. Please try again."), 'OK', {
        duration: 4000,
      });
    } finally {
      this.saving.set(false);
    }
  }

  private messageOf(e: unknown, fallback: string): string {
    const msg = (e as { error?: { message?: string } })?.error?.message;
    return typeof msg === 'string' && msg ? msg : fallback;
  }
}
