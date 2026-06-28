import {
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
  ChangeDetectionStrategy,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import type { EChartsOption } from 'echarts';
import { catchError, firstValueFrom, of } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';

import { Api } from '../../core/api';
import {
  FinanceAccount,
  FinanceAccountKind,
  FinanceCategorySource,
  FinanceColumnMap,
  FinanceImportBatch,
  FinanceImportFormat,
  FinanceMoneyCoachResult,
  FinanceOwner,
  FinanceStagedImport,
  FinanceStagedRow,
  FinanceSummary,
  FinanceSummaryAiResult,
  FinanceTransaction,
  FinanceTransactionsPage,
  FinanceTxnKind,
  FinanceBudgetDto,
  FinanceBudgetsResponse,
  FinanceBudgetStatus,
  FinanceNetWorthDto,
  FinanceAccountBalanceDto,
  FinanceSavingsGoalDto,
  FinanceSavingsResponse,
  FinanceBudgetCheckDto,
} from '../../core/models';
import { ChartComponent } from '../../shared/chart';
import { DialogA11yDirective } from '../../core/dialog-a11y.directive';

/** The closed category set the review dropdown offers (the AI's enum + the household's ledger categories). */
export const FINANCE_DEFAULT_CATEGORIES: readonly string[] = [
  'Groceries', 'Dining', 'Gas', 'Shopping', 'Entertainment', 'Travel',
  'Utilities', 'Rent', 'Mortgage', 'Insurance', 'Health', 'Fitness',
  'Subscriptions', 'Transportation', 'Education', 'Kids', 'Pets',
  'Personal Care', 'Home', 'Gifts', 'Charity', 'Fees', 'Taxes',
  'Income', 'Transfer',
];

/** The editable column-map fields the generic-CSV step collects (header-name picks + a sign toggle). */
type ColumnMapField =
  | 'date' | 'amount' | 'debit' | 'credit'
  | 'description' | 'category' | 'account' | 'accountName' | 'institution';

/** Friendly labels for the owner tag (his/hers/joint/unassigned). */
const OWNER_LABEL: Record<FinanceOwner, string> = {
  his: 'His',
  hers: 'Hers',
  joint: 'Joint',
  unassigned: 'Unassigned',
};

/** Friendly labels for the account kind. */
const KIND_LABEL: Record<FinanceAccountKind, string> = {
  bank: 'Bank',
  credit: 'Credit',
  other: 'Other',
};

/** Friendly labels for the transaction kind filter (expense/income/transfer). */
const TXN_KIND_LABEL: Record<FinanceTxnKind, string> = {
  expense: 'Expenses',
  income: 'Income',
  transfer: 'Transfers',
};

/** Owner options offered in the account-tagging picker. */
const OWNER_OPTIONS: FinanceOwner[] = ['his', 'hers', 'joint', 'unassigned'];
const KIND_OPTIONS: FinanceAccountKind[] = ['bank', 'credit', 'other'];

/** A donut/bar accent per owner so His/Hers/Joint read consistently across the page. */
const OWNER_COLOR: Record<FinanceOwner, string> = {
  his: '#3d8bff',
  hers: '#ff7eb6',
  joint: '#3dd68c',
  unassigned: '#5e6c82',
};

/** Friendly labels for a budget's pace status. */
const BUDGET_STATUS_LABEL: Record<FinanceBudgetStatus, string> = {
  under: 'On track',
  near: 'Close to limit',
  over: 'Over by pace',
};

/** The sentinel category for the OVERALL (null-category) whole-month budget. */
const OVERALL_BUDGET = '__overall__';

/** An in-progress savings goal (create when id is null, else edit). */
interface GoalDraft {
  id: number | null;
  name: string;
  target: string;
  owner: FinanceOwner;
  targetDate: string;
}

/**
 * Family Hub F5 — FINANCE. A clean personal-finance dashboard over a Rocket Money CSV import. This is the
 * most sensitive room in the hub: the whole route is reachable only with family.finance (on top of the
 * group's family.use), data is household-private and never shared to outside contacts, and the importer is
 * shown by display NAME only — never an email.
 *
 * The page has five parts: an IMPORT dropzone (reads the chosen .csv as text and POSTs { fileName, content },
 * toasts the result, refreshes); a monthly DASHBOARD (prev/next month) with headline cards, an ECharts
 * by-category donut, a by-account list, a His-vs-Hers owner split, and a 12-month trend line; an ACCOUNTS
 * panel to tag each account's owner/kind/name (this is how the two SoFi accounts get told apart); a
 * filterable, paged TRANSACTIONS table; and an import-history strip.
 */
@Component({
  selector: 'app-family-finance',
  imports: [
    RouterLink,
    MatIconModule,
    MatButtonModule,
    MatTooltipModule,
    MatProgressSpinnerModule,
    MatSnackBarModule,
    ChartComponent,
    DialogA11yDirective,
  ],
  templateUrl: './finance.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrls: ['./family.scss', './finance.scss'],
})
export class FamilyFinance {
  private api = inject(Api);
  private snack = inject(MatSnackBar);
  private destroyRef = inject(DestroyRef);

  // ---- page state ----
  readonly loading = signal(true);
  readonly error = signal(false);

  /** The viewed month as `yyyy-MM`; defaults to the current month and prev/next steps it. */
  readonly month = signal<string>(this.currentMonth());

  readonly summary = signal<FinanceSummary | null>(null);
  readonly accounts = signal<FinanceAccount[]>([]);
  readonly imports = signal<FinanceImportBatch[]>([]);

  // ---- ✨ "Explain this month" (read-only AI narration of the month's authoritative numbers) ----
  /** The warm AI summary for the viewed month; null until loaded (best-effort, never blocks the page). */
  readonly aiSummary = signal<FinanceSummaryAiResult | null>(null);
  readonly aiLoading = signal(false);
  /** The yyyy-MM the AI summary was last loaded for, so we only refetch when the month actually changes. */
  private aiSummaryMonth = '';

  // ---- ✨ "Money coach" (DETERMINISTIC recurring-charges floor + optional read-only AI narration) ----
  /**
   * The recurring-charges detector + optional warm narration. The `recurring` list + `monthlyRecurringTotal`
   * are the DETERMINISTIC floor and always render once loaded (even when `fellBackToPlain`). Null until
   * loaded. The endpoint always anchors to recent activity (no month param), so we load it once on init —
   * the month stepper doesn't change it. Best-effort; a network blip just hides the card.
   */
  readonly coach = signal<FinanceMoneyCoachResult | null>(null);
  readonly coachLoading = signal(false);

  // ---- BUDGETS (per-category spend-vs-limit by pace + an 'unbudgeted' rollup) ----
  readonly budgets = signal<FinanceBudgetsResponse | null>(null);
  readonly budgetsLoading = signal(false);
  /** The category being added/edited inline; '' = the 'overall' (null-category) budget, null = no draft open. */
  readonly budgetDraftCategory = signal<string | null>(null);
  readonly budgetDraftLimit = signal<string>('');
  readonly budgetSaving = signal(false);

  // ---- NET WORTH (manual signed balances → assets/liabilities/net + a trend) ----
  readonly netWorth = signal<FinanceNetWorthDto | null>(null);
  readonly netWorthLoading = signal(false);
  /** The account whose balance is being entered (null = no editor open). */
  readonly balanceDraftAccount = signal<FinanceAccountBalanceDto | null>(null);
  readonly balanceDraftValue = signal<string>('');
  readonly balanceSaving = signal(false);

  // ---- SAVINGS GOALS (cards with a ring to target + a Contribute button) ----
  readonly savings = signal<FinanceSavingsResponse | null>(null);
  readonly savingsLoading = signal(false);
  /** A goal being created/edited (id null = create), or null when the dialog is closed. */
  readonly goalDraft = signal<GoalDraft | null>(null);
  readonly goalSaving = signal(false);

  // ---- ✨ Budget check-in (deterministic over/near floor + optional AI narration) ----
  readonly budgetCheck = signal<FinanceBudgetCheckDto | null>(null);
  readonly budgetCheckLoading = signal(false);
  private budgetCheckMonth = '';

  // ---- import dropzone + staging flow (parse → [column-map] → review → commit/discard) ----
  readonly importing = signal(false);
  readonly dragOver = signal(false);

  /**
   * The wizard step. `idle` = the plain dropzone; `map` = a generic CSV awaiting a column mapping;
   * `review` = a staged batch shown for review before commit. The live dashboard underneath is never
   * mutated until the user commits.
   */
  readonly importStep = signal<'idle' | 'map' | 'review'>('idle');

  /** The raw file held while we walk the column-map step (a generic/ambiguous CSV). */
  private pendingFile: { name: string; content: string } | null = null;
  /** The CSV's detected header names (drive the column-map selects). */
  readonly detectedColumns = signal<string[]>([]);
  /** The in-progress column map for a generic CSV. */
  readonly columnMap = signal<FinanceColumnMap>(this.emptyColumnMap());

  /** The staged batch under review (parse result + the rows the review panel renders). */
  readonly staged = signal<FinanceStagedImport | null>(null);
  /** Row-level ids the user has excluded from the commit (on top of the parser's IsDuplicate flags). */
  readonly excludedIds = signal<Set<number>>(new Set());
  readonly committing = signal(false);
  /** True while the optional "✨ Suggest categories" call is in flight. */
  readonly aiCategorizing = signal(false);

  readonly categoryOptions = FINANCE_DEFAULT_CATEGORIES;
  readonly txnKindEditOptions: FinanceTxnKind[] = ['expense', 'income', 'transfer'];
  readonly columnMapFields: { key: ColumnMapField; label: string; hint?: string }[] = [
    { key: 'date', label: 'Date', hint: 'required' },
    { key: 'amount', label: 'Amount', hint: 'signed — or map Debit + Credit' },
    { key: 'debit', label: 'Debit' },
    { key: 'credit', label: 'Credit' },
    { key: 'description', label: 'Description / Merchant' },
    { key: 'category', label: 'Category' },
    { key: 'account', label: 'Account key' },
    { key: 'accountName', label: 'Account name' },
    { key: 'institution', label: 'Institution' },
  ];

  /** Whether the staged review has at least one committable (kept, non-duplicate) row. */
  readonly committableCount = computed(() => {
    const s = this.staged();
    if (!s) return 0;
    const excl = this.excludedIds();
    return s.rows.filter((r) => !r.isDuplicate && !this.isRowExcluded(r, excl)).length;
  });

  /** Count of rows still Uncategorized (drives the "Suggest with AI" affordance + commit hint). */
  readonly uncategorizedCount = computed(() => {
    const s = this.staged();
    if (!s) return 0;
    const excl = this.excludedIds();
    return s.rows.filter((r) => !r.category && !this.isRowExcluded(r, excl)).length;
  });

  /** The staged rows grouped by account (for the account-grouped review). */
  readonly stagedByAccount = computed(() => {
    const s = this.staged();
    if (!s) return [];
    const groups = new Map<string, { name: string; institution?: string | null; rows: FinanceStagedRow[] }>();
    for (const r of s.rows) {
      let g = groups.get(r.accountKey);
      if (!g) {
        g = { name: r.accountName, institution: r.institution, rows: [] };
        groups.set(r.accountKey, g);
      }
      g.rows.push(r);
    }
    return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
  });

  // ---- transactions table ----
  readonly txns = signal<FinanceTransaction[]>([]);
  readonly txnTotal = signal(0);
  readonly txnPage = signal(1);
  readonly txnLoading = signal(false);
  /** The active table filters (account/category/owner/kind). Month always follows the dashboard month. */
  readonly fAccount = signal<number | null>(null);
  readonly fCategory = signal<string | null>(null);
  readonly fOwner = signal<FinanceOwner | null>(null);
  readonly fKind = signal<FinanceTxnKind | null>(null);

  readonly ownerOptions = OWNER_OPTIONS;
  readonly kindOptions = KIND_OPTIONS;
  readonly txnKindOptions: FinanceTxnKind[] = ['expense', 'income', 'transfer'];
  private readonly pageSize = 50;

  /** A friendly "June 2026" label for the month stepper. */
  readonly monthLabel = computed(() => {
    const [y, m] = this.month().split('-').map(Number);
    if (!y || !m) return this.month();
    return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  });

  /** Net = income − spent for the headline cards. */
  readonly net = computed(() => {
    const s = this.summary();
    return s ? s.totalIncome - s.totalSpent : 0;
  });

  /** Distinct categories present this month — drives the table's category filter. */
  readonly categories = computed(() => (this.summary()?.byCategory ?? []).map((c) => c.category));

  /** Total expense pages for the current filter. */
  readonly txnPages = computed(() => Math.max(1, Math.ceil(this.txnTotal() / this.pageSize)));

  /** Whether any transactions have been imported yet (drives the empty/first-run state). */
  readonly hasData = computed(
    () =>
      this.accounts().length > 0 ||
      (this.summary()?.byCategory?.length ?? 0) > 0 ||
      this.imports().length > 0,
  );

  constructor() {
    this.reloadAll(true);
  }

  // ============================================================== loading

  private reloadAll(initial = false): void {
    if (initial) this.loading.set(true);
    this.loadSummary();
    this.loadAccounts();
    this.loadImports();
    this.loadTxns();
    this.loadAiSummary();
    // A fresh import can change the recurring-charges floor, so force a coach refetch on a non-initial reload.
    this.loadCoach(!initial);
    this.loadBudgets();
    this.loadNetWorth();
    this.loadSavings();
    this.loadBudgetCheck(!initial);
  }

  /** The household's per-category budgets for the viewed month (deterministic spend-vs-limit by pace). */
  private loadBudgets(): void {
    this.budgetsLoading.set(true);
    this.api
      .financeBudgets(this.month())
      .pipe(
        catchError(() => of<FinanceBudgetsResponse | null>(null)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((b) => {
        if (b) this.budgets.set(b);
        this.budgetsLoading.set(false);
      });
  }

  /** The household's manual net worth (latest signed balance per account + a trend). */
  private loadNetWorth(): void {
    this.netWorthLoading.set(true);
    this.api
      .financeNetWorth()
      .pipe(
        catchError(() => of<FinanceNetWorthDto | null>(null)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((n) => {
        if (n) this.netWorth.set(n);
        this.netWorthLoading.set(false);
      });
  }

  /** The household's savings goals (saved/target/pct + projected finish). Month-independent. */
  private loadSavings(): void {
    this.savingsLoading.set(true);
    this.api
      .financeSavings()
      .pipe(
        catchError(() => of<FinanceSavingsResponse | null>(null)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((s) => {
        if (s) this.savings.set(s);
        this.savingsLoading.set(false);
      });
  }

  /**
   * The "✨ Budget check-in" floor (over/near/under by pace + net-worth direction) + optional AI narration
   * for the viewed month. NEVER 503s; degrades silently on a network blip. Skips a redundant refetch when
   * the month is unchanged.
   */
  private loadBudgetCheck(force = false): void {
    const month = this.month();
    if (!force && month === this.budgetCheckMonth && this.budgetCheck()) return;
    this.budgetCheckMonth = month;
    this.budgetCheckLoading.set(true);
    this.api
      .financeBudgetCheckAi(month)
      .pipe(
        catchError(() => of<FinanceBudgetCheckDto | null>(null)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((c) => {
        if (this.month() === month) {
          this.budgetCheck.set(c);
          this.budgetCheckLoading.set(false);
        }
      });
  }

  private loadSummary(): void {
    this.api
      .financeSummary(this.month())
      .pipe(
        catchError(() => {
          if (this.loading()) this.error.set(true);
          return of<FinanceSummary | null>(null);
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((s) => {
        if (s) {
          this.summary.set(s);
          // The server resolves the month (it may fall back to the latest with data) — follow it.
          if (s.month && s.month !== this.month()) {
            this.month.set(s.month);
            this.loadTxns();
            this.loadAiSummary(); // re-narrate the month the server actually landed on
          }
        }
        this.loading.set(false);
      });
  }

  private loadAccounts(): void {
    this.api
      .financeAccounts()
      .pipe(
        catchError(() => of<FinanceAccount[]>([])),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((a) => this.accounts.set(a ?? []));
  }

  private loadImports(): void {
    this.api
      .financeImports()
      .pipe(
        catchError(() => of<FinanceImportBatch[]>([])),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((i) => this.imports.set(i ?? []));
  }

  /**
   * Load the read-only "✨ Explain this month" narration for the viewed month. This endpoint NEVER 503s
   * (it returns a guaranteed deterministic plain floor with fellBackToPlain=true when AI is unavailable),
   * so a network blip is the only failure path — we degrade silently and just hide the card. Skips the
   * refetch when the month is unchanged so the month stepper doesn't re-hit it needlessly.
   */
  private loadAiSummary(force = false): void {
    const month = this.month();
    if (!force && month === this.aiSummaryMonth && this.aiSummary()) return;
    this.aiSummaryMonth = month;
    this.aiLoading.set(true);
    this.api
      .financeSummaryAi(month)
      .pipe(
        catchError(() => of<FinanceSummaryAiResult | null>(null)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((s) => {
        // Guard against an out-of-order response if the month changed mid-flight.
        if (this.month() === month) {
          this.aiSummary.set(s);
          this.aiLoading.set(false);
        }
      });
  }

  /**
   * Load the "✨ Money coach": the DETERMINISTIC recurring-charges floor (+ optional warm narration). The
   * endpoint always anchors to the household's recent activity (no month param) and NEVER 503s — when AI is
   * unavailable it returns the recurring list with fellBackToPlain=true and a null narrative — so a network
   * blip is the only failure path; we degrade silently and hide the card. Loaded once on init / after an
   * import (the month stepper doesn't change it). Skips a redundant refetch if it's already loaded.
   */
  private loadCoach(force = false): void {
    if (this.coachLoading()) return;
    if (!force && this.coach()) return;
    this.coachLoading.set(true);
    this.api
      .financeMoneyCoachAi()
      .pipe(
        catchError(() => of<FinanceMoneyCoachResult | null>(null)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((c) => {
        this.coach.set(c);
        this.coachLoading.set(false);
      });
  }

  private loadTxns(): void {
    this.txnLoading.set(true);
    this.api
      .financeTransactions({
        month: this.month(),
        accountId: this.fAccount(),
        category: this.fCategory(),
        owner: this.fOwner(),
        kind: this.fKind(),
        page: this.txnPage(),
      })
      .pipe(
        catchError(() => of<FinanceTransactionsPage | null>(null)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((p) => {
        if (p) {
          this.txns.set(p.items ?? []);
          this.txnTotal.set(p.total ?? 0);
        }
        this.txnLoading.set(false);
      });
  }

  // ============================================================== month stepper

  stepMonth(delta: number): void {
    const [y, m] = this.month().split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    this.month.set(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    this.txnPage.set(1);
    this.loadSummary();
    this.loadTxns();
    this.loadAiSummary();
    this.loadBudgets();
    this.loadBudgetCheck();
  }

  // ============================================================== budgets / net worth / savings

  /** Distinct imported categories the budget picker offers (the household's ledger ∪ the default set). */
  readonly budgetCategoryOptions = computed<string[]>(() => {
    const present = new Set<string>();
    for (const c of this.summary()?.byCategory ?? []) if (c.category) present.add(c.category);
    for (const c of FINANCE_DEFAULT_CATEGORIES) present.add(c);
    // Drop categories already budgeted (and the overall budget) so the picker only offers free ones.
    const taken = new Set((this.budgets()?.budgets ?? []).map((b) => b.category).filter((x): x is string => !!x));
    return [...present].filter((c) => !taken.has(c)).sort((a, b) => a.localeCompare(b));
  });

  /** Whether an overall (null-category) budget already exists (so the picker can hide that option). */
  readonly hasOverallBudget = computed(() =>
    (this.budgets()?.budgets ?? []).some((b) => !b.category));

  budgetStatusLabel(s: FinanceBudgetStatus): string {
    return BUDGET_STATUS_LABEL[s] ?? s;
  }

  /** The fill width for a budget bar (clamped 0..100; pace can exceed but the bar caps at full). */
  budgetFillPct(b: FinanceBudgetDto): number {
    return Math.max(0, Math.min(100, Math.round(b.pct)));
  }

  budgetLabel(b: FinanceBudgetDto): string {
    return b.category ?? 'Overall (whole month)';
  }

  /** Open the inline add-budget draft for a chosen category ('' = overall). */
  startBudget(category: string): void {
    this.budgetDraftCategory.set(category === OVERALL_BUDGET ? '' : category);
    this.budgetDraftLimit.set('');
  }

  cancelBudgetDraft(): void {
    this.budgetDraftCategory.set(null);
    this.budgetDraftLimit.set('');
  }

  /** Persist the inline add-budget draft (category '' → the overall budget). */
  async saveBudgetDraft(): Promise<void> {
    const cat = this.budgetDraftCategory();
    if (cat === null || this.budgetSaving()) return;
    const limit = Number(this.budgetDraftLimit());
    if (!Number.isFinite(limit) || limit <= 0) {
      this.snack.open('Enter a budget amount greater than zero.', 'OK', { duration: 3500 });
      return;
    }
    this.budgetSaving.set(true);
    try {
      await firstValueFrom(this.api.createFinanceBudget({ category: cat || null, limitAmount: limit }));
      this.cancelBudgetDraft();
      this.loadBudgets();
    } catch (e) {
      this.snack.open(this.messageOf(e, "Couldn't save that budget."), 'OK', { duration: 4000 });
    } finally {
      this.budgetSaving.set(false);
    }
  }

  /** Edit a budget's limit inline (a quick prompt — keeps the panel lean). */
  async editBudgetLimit(b: FinanceBudgetDto): Promise<void> {
    const raw = window.prompt(`New monthly limit for ${this.budgetLabel(b)}`, String(b.limitAmount))?.trim();
    if (raw == null) return;
    const limit = Number(raw);
    if (!Number.isFinite(limit) || limit <= 0) {
      this.snack.open('Enter a budget amount greater than zero.', 'OK', { duration: 3500 });
      return;
    }
    try {
      await firstValueFrom(this.api.updateFinanceBudget(b.id, { category: b.category, limitAmount: limit }));
      this.loadBudgets();
    } catch (e) {
      this.snack.open(this.messageOf(e, "Couldn't update that budget."), 'OK', { duration: 4000 });
    }
  }

  async deleteBudget(b: FinanceBudgetDto): Promise<void> {
    if (!window.confirm(`Remove the ${this.budgetLabel(b)} budget?`)) return;
    try {
      await firstValueFrom(this.api.deleteFinanceBudget(b.id));
      this.loadBudgets();
    } catch (e) {
      this.snack.open(this.messageOf(e, "Couldn't remove that budget."), 'OK', { duration: 4000 });
    }
  }

  // ---- net worth: manual per-account balance entry ----

  /** Open the balance editor for one account, seeded with its latest balance. */
  startBalance(a: FinanceAccountBalanceDto): void {
    this.balanceDraftAccount.set(a);
    this.balanceDraftValue.set(a.hasBalance ? String(a.latestBalance) : '');
  }

  cancelBalanceDraft(): void {
    this.balanceDraftAccount.set(null);
    this.balanceDraftValue.set('');
  }

  /** Save today's signed balance for the open account (positive asset / negative liability). */
  async saveBalanceDraft(): Promise<void> {
    const a = this.balanceDraftAccount();
    if (!a || this.balanceSaving()) return;
    const balance = Number(this.balanceDraftValue());
    if (!Number.isFinite(balance)) {
      this.snack.open('Enter a balance (a number — negative for a credit card or loan).', 'OK', { duration: 4000 });
      return;
    }
    this.balanceSaving.set(true);
    try {
      await firstValueFrom(this.api.setFinanceBalance(a.accountId, { balance }));
      this.cancelBalanceDraft();
      this.loadNetWorth();
    } catch (e) {
      this.snack.open(this.messageOf(e, "Couldn't save that balance."), 'OK', { duration: 4000 });
    } finally {
      this.balanceSaving.set(false);
    }
  }

  /** A hint for the kind of value to enter (assets positive, credit/loan negative). */
  balanceHint(a: FinanceAccountBalanceDto): string {
    return a.kind === 'credit'
      ? 'Owe? Enter a negative number (a liability).'
      : 'Asset balance — a positive number.';
  }

  // ---- savings goals ----

  /** A ring fill (0..100) for a goal card. */
  goalPct(g: FinanceSavingsGoalDto): number {
    return Math.max(0, Math.min(100, Math.round(g.pct)));
  }

  /** The conic-gradient ring background for a goal card, tinted by owner. */
  goalRing(g: FinanceSavingsGoalDto): string {
    const color = OWNER_COLOR[g.owner] ?? OWNER_COLOR.unassigned;
    return `conic-gradient(${color} ${this.goalPct(g)}%, var(--tech-bg-sunken) 0)`;
  }

  openNewGoal(): void {
    this.goalDraft.set({ id: null, name: '', target: '', owner: 'joint', targetDate: '' });
  }

  openEditGoal(g: FinanceSavingsGoalDto): void {
    this.goalDraft.set({
      id: g.id, name: g.name, target: String(g.targetAmount),
      owner: g.owner, targetDate: g.targetDate ?? '',
    });
  }

  cancelGoalDraft(): void {
    this.goalDraft.set(null);
  }

  patchGoalDraft(patch: Partial<GoalDraft>): void {
    this.goalDraft.update((d) => (d ? { ...d, ...patch } : d));
  }

  /** Create or update the savings goal in the dialog. */
  async saveGoalDraft(): Promise<void> {
    const d = this.goalDraft();
    if (!d || this.goalSaving()) return;
    const name = d.name.trim();
    if (!name) {
      this.snack.open('Give your goal a name.', 'OK', { duration: 3000 });
      return;
    }
    const target = Number(d.target);
    if (!Number.isFinite(target) || target < 0) {
      this.snack.open('Enter a target amount.', 'OK', { duration: 3000 });
      return;
    }
    this.goalSaving.set(true);
    const body = {
      name, targetAmount: target, owner: d.owner,
      targetDate: d.targetDate || null,
    };
    try {
      if (d.id == null) await firstValueFrom(this.api.createFinanceSavingsGoal(body));
      else await firstValueFrom(this.api.updateFinanceSavingsGoal(d.id, body));
      this.goalDraft.set(null);
      this.loadSavings();
    } catch (e) {
      this.snack.open(this.messageOf(e, "Couldn't save that goal."), 'OK', { duration: 4000 });
    } finally {
      this.goalSaving.set(false);
    }
  }

  /** Add (or, with a negative amount, withdraw) a contribution to a goal. */
  async contributeToGoal(g: FinanceSavingsGoalDto): Promise<void> {
    const raw = window.prompt(`Add to "${g.name}" (a negative number withdraws)`, '')?.trim();
    if (!raw) return;
    const amount = Number(raw);
    if (!Number.isFinite(amount) || amount === 0) {
      this.snack.open('Enter an amount to contribute.', 'OK', { duration: 3000 });
      return;
    }
    try {
      await firstValueFrom(this.api.contributeFinanceSavingsGoal(g.id, { amount }));
      this.loadSavings();
    } catch (e) {
      this.snack.open(this.messageOf(e, "Couldn't record that contribution."), 'OK', { duration: 4000 });
    }
  }

  async deleteGoal(g: FinanceSavingsGoalDto): Promise<void> {
    if (!window.confirm(`Delete the "${g.name}" goal?`)) return;
    try {
      await firstValueFrom(this.api.deleteFinanceSavingsGoal(g.id));
      this.loadSavings();
    } catch (e) {
      this.snack.open(this.messageOf(e, "Couldn't delete that goal."), 'OK', { duration: 4000 });
    }
  }

  /** A friendly direction phrase for the budget-check net-worth line. */
  netWorthDirectionLabel(dir: string): string {
    return dir === 'up' ? 'trending up' : dir === 'down' ? 'trending down'
      : dir === 'flat' ? 'holding steady' : 'not enough history yet';
  }

  // ============================================================== import

  onDragOver(e: DragEvent): void {
    e.preventDefault();
    this.dragOver.set(true);
  }

  onDragLeave(e: DragEvent): void {
    e.preventDefault();
    this.dragOver.set(false);
  }

  onDrop(e: DragEvent): void {
    e.preventDefault();
    this.dragOver.set(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) void this.readAndStage(file);
  }

  onPick(e: Event): void {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) void this.readAndStage(file);
    input.value = ''; // allow re-picking the same file
  }

  /** Whether a filename is one we can import (.csv / .ofx / .qfx). */
  private acceptable(name: string): boolean {
    return /\.(csv|ofx|qfx)$/i.test(name);
  }

  /**
   * Read the chosen file as text in the browser and parse it into a STAGED batch (the live ledger is NOT
   * touched). The server auto-detects the format; an OFX/QFX or a recognized Rocket-Money CSV goes straight
   * to the review panel, while a generic/ambiguous CSV bounces to the column-map step first (the server
   * answers 400 "Map the columns…" and hands back the detected headers).
   */
  private async readAndStage(file: File): Promise<void> {
    if (this.importing()) return;
    if (!this.acceptable(file.name)) {
      this.snack.open('Choose a .csv, .ofx, or .qfx file to import.', 'OK', { duration: 4000 });
      return;
    }
    this.importing.set(true);
    try {
      const content = await file.text();
      this.pendingFile = { name: file.name, content };
      await this.parseStage('auto', null);
    } catch (e) {
      this.snack.open(this.messageOf(e, "Couldn't read that file. Please try again."), 'OK', {
        duration: 5000,
      });
      this.resetImport();
    } finally {
      this.importing.set(false);
    }
  }

  /**
   * Parse the pending file into a staged batch with the given format + optional column map. A generic CSV
   * that arrives without a usable map answers a friendly 400; we read the detected headers off the (failed)
   * preview path by re-requesting an 'auto' parse and opening the column-map step.
   */
  private async parseStage(format: 'auto' | FinanceImportFormat, map: FinanceColumnMap | null): Promise<void> {
    const file = this.pendingFile;
    if (!file) return;
    try {
      const res = await firstValueFrom(
        this.api.financeParse({ fileName: file.name, content: file.content, format, columnMap: map }),
      );
      this.openReview(res);
    } catch (e) {
      // A generic CSV needs a column map: surface the column-map step seeded with its detected headers.
      const detected = this.detectedFromError(e);
      if (detected) {
        this.detectedColumns.set(detected);
        this.columnMap.set(this.guessColumnMap(detected));
        this.importStep.set('map');
        return;
      }
      this.snack.open(this.messageOf(e, "Couldn't parse that file. Please try again."), 'OK', {
        duration: 5000,
      });
      this.resetImport();
    }
  }

  /** Submit the column-map step → re-parse as a generic CSV → open the review panel. */
  async submitColumnMap(): Promise<void> {
    const map = this.columnMap();
    if (!map.date || (!map.amount && !map.debit && !map.credit)) {
      this.snack.open('Map at least a Date column and an Amount (or a Debit/Credit pair).', 'OK', {
        duration: 4500,
      });
      return;
    }
    this.importing.set(true);
    try {
      await this.parseStage('csv', map);
    } finally {
      this.importing.set(false);
    }
  }

  /** Open the review panel for a freshly-staged batch (seeds the exclude set from any pre-flagged rows). */
  private openReview(res: FinanceStagedImport): void {
    this.staged.set(res);
    this.excludedIds.set(new Set(res.rows.filter((r) => r.excluded).map((r) => r.id)));
    this.importStep.set('review');
  }

  /** Toggle a row's excluded flag in the local set (the commit sends excludeIds; duplicates are auto-skipped). */
  toggleExclude(row: FinanceStagedRow): void {
    this.excludedIds.update((set) => {
      const next = new Set(set);
      if (next.has(row.id)) next.delete(row.id);
      else next.add(row.id);
      return next;
    });
  }

  isRowExcluded(row: FinanceStagedRow, set = this.excludedIds()): boolean {
    return row.excluded || set.has(row.id);
  }

  /** Edit a staged row's category inline (optionally persisting an "apply to future" household rule). */
  async setRowCategory(row: FinanceStagedRow, category: string, applyToFuture = false): Promise<void> {
    const s = this.staged();
    if (!s) return;
    const value = category || null;
    try {
      const updated = await firstValueFrom(
        this.api.financePatchStagedRow(s.importId, row.id, { category: value, applyToFuture }),
      );
      this.replaceStagedRow(updated);
    } catch (e) {
      this.snack.open(this.messageOf(e, "Couldn't update that row."), 'OK', { duration: 4000 });
    }
  }

  /** Edit a staged row's kind (expense/income/transfer) inline. */
  async setRowKind(row: FinanceStagedRow, kind: FinanceTxnKind): Promise<void> {
    const s = this.staged();
    if (!s || row.kind === kind) return;
    try {
      const updated = await firstValueFrom(
        this.api.financePatchStagedRow(s.importId, row.id, { kind }),
      );
      this.replaceStagedRow(updated);
    } catch (e) {
      this.snack.open(this.messageOf(e, "Couldn't update that row."), 'OK', { duration: 4000 });
    }
  }

  /** Accept a row's AI suggestion as its category (and learn it for future imports). */
  acceptSuggestion(row: FinanceStagedRow): void {
    if (!row.suggestedCategory) return;
    void this.setRowCategory(row, row.suggestedCategory, true);
  }

  private replaceStagedRow(updated: FinanceStagedRow): void {
    this.staged.update((s) =>
      s ? { ...s, rows: s.rows.map((r) => (r.id === updated.id ? updated : r)) } : s,
    );
  }

  /**
   * OPTIONAL "✨ Suggest categories": ask Gemini to label the still-Uncategorized rows (constrained to the
   * fixed set). NEVER blocks commit — when AI is off/unconfigured/errors it floors to rows-unchanged and we
   * say so. On success we re-pull the staged preview so the new suggestions/badges render.
   */
  async suggestCategoriesAi(): Promise<void> {
    const s = this.staged();
    if (!s || this.aiCategorizing()) return;
    this.aiCategorizing.set(true);
    try {
      const res = await firstValueFrom(this.api.financeCategorizeAi(s.importId));
      if (res.fellBackToPlain) {
        this.snack.open('AI categorization is unavailable right now — your rows are unchanged.', 'OK', {
          duration: 4000,
        });
      } else {
        await this.refreshStagedPreview();
        this.snack.open(
          res.classified === 0
            ? 'No new suggestions — everything was already categorized.'
            : `Suggested categories for ${res.classified} of ${res.eligible} rows.`,
          undefined,
          { duration: 3500 },
        );
      }
    } catch (e) {
      this.snack.open(this.messageOf(e, "Couldn't suggest categories just now."), 'OK', {
        duration: 4000,
      });
    } finally {
      this.aiCategorizing.set(false);
    }
  }

  /** Re-pull the first page of staged rows after a server-side change (AI suggest), keeping the exclude set. */
  private async refreshStagedPreview(): Promise<void> {
    const s = this.staged();
    if (!s) return;
    try {
      const page = await firstValueFrom(this.api.financeStaged(s.importId, 1));
      this.staged.update((cur) => (cur ? { ...cur, rows: page.items } : cur));
    } catch {
      /* best-effort: a refresh blip leaves the current rows in place */
    }
  }

  /** Commit the staged batch into the ledger (atomic, dedup-safe), then refresh the dashboard. */
  async commitStaged(): Promise<void> {
    const s = this.staged();
    if (!s || this.committing()) return;
    this.committing.set(true);
    try {
      const excludeIds = [...this.excludedIds()];
      const res = await firstValueFrom(this.api.financeCommit(s.importId, { excludeIds }));
      const dup = res.skipped === 1 ? 'duplicate' : 'duplicates';
      this.snack.open(`Imported ${res.imported}, skipped ${res.skipped} ${dup}`, undefined, {
        duration: 4000,
      });
      this.resetImport();
      this.txnPage.set(1);
      this.reloadAll();
    } catch (e) {
      this.snack.open(this.messageOf(e, "Couldn't commit those transactions. Please try again."), 'OK', {
        duration: 5000,
      });
    } finally {
      this.committing.set(false);
    }
  }

  /** Discard the staged batch (deletes it server-side) and return to the dropzone. The ledger is untouched. */
  async discardStaged(): Promise<void> {
    const s = this.staged();
    if (s) {
      try {
        await firstValueFrom(this.api.financeDiscard(s.importId));
      } catch {
        /* best-effort: a stale staged batch is harmless and never reaches the ledger */
      }
    }
    this.resetImport();
  }

  /** Back out of the column-map step without staging anything. */
  cancelColumnMap(): void {
    this.resetImport();
  }

  /** Clear all import-wizard state back to the idle dropzone. */
  private resetImport(): void {
    this.importStep.set('idle');
    this.staged.set(null);
    this.excludedIds.set(new Set());
    this.detectedColumns.set([]);
    this.columnMap.set(this.emptyColumnMap());
    this.pendingFile = null;
  }

  /** Patch one field of the in-progress column map (a header pick or the negate toggle). */
  setColumnMap(field: ColumnMapField, value: string): void {
    this.columnMap.update((m) => ({ ...m, [field]: value || null }));
  }

  setNegate(negate: boolean): void {
    this.columnMap.update((m) => ({ ...m, negate }));
  }

  private emptyColumnMap(): FinanceColumnMap {
    return { date: null, amount: null, debit: null, credit: null, negate: false,
      description: null, category: null, account: null, accountName: null, institution: null };
  }

  /** Best-effort: guess a sensible default column map from the file's header names. */
  private guessColumnMap(headers: string[]): FinanceColumnMap {
    const find = (...needles: string[]): string | null => {
      for (const h of headers) {
        const lower = h.toLowerCase();
        if (needles.some((n) => lower.includes(n))) return h;
      }
      return null;
    };
    const debit = find('debit', 'withdrawal', 'money out');
    const credit = find('credit', 'deposit', 'money in');
    return {
      date: find('date', 'posted', 'transaction date'),
      amount: debit && credit ? null : find('amount', 'value'),
      debit,
      credit,
      negate: false,
      description: find('description', 'merchant', 'name', 'memo', 'payee'),
      category: find('category'),
      account: find('account'),
      accountName: find('account name', 'account'),
      institution: find('institution', 'bank'),
    };
  }

  /**
   * Pull the detected CSV header names out of a parse error. The server answers a generic CSV with a 400
   * carrying `{ message, detectedColumns }`; if it omits them we re-derive the headers from the file's first
   * line so the column-map step can still render.
   */
  private detectedFromError(e: unknown): string[] | null {
    const body = (e as { error?: { detectedColumns?: unknown; message?: string } })?.error;
    const cols = body?.detectedColumns;
    if (Array.isArray(cols) && cols.length) return cols.map(String);
    // Only treat it as a "needs a column map" case when the message says so.
    if (typeof body?.message === 'string' && /map the columns/i.test(body.message)) {
      const headers = this.parseHeaderLine();
      if (headers?.length) return headers;
    }
    return null;
  }

  /** Parse the first non-empty CSV line of the pending file into header names (simple RFC4180-ish split). */
  private parseHeaderLine(): string[] | null {
    const content = this.pendingFile?.content;
    if (!content) return null;
    const line = content.split(/\r?\n/).find((l) => l.trim().length > 0);
    if (!line) return null;
    const out: string[] = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++; } else inQuotes = false;
        } else cur += ch;
      } else if (ch === '"') inQuotes = true;
      else if (ch === ',') { out.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    out.push(cur.trim());
    return out.filter((h) => h.length > 0);
  }

  /** Friendly label for a staged row's category-source badge. */
  sourceLabel(src: FinanceCategorySource): string {
    return src === 'file' ? 'File' : src === 'rule' ? 'Rule' : src === 'ai' ? 'AI' : '';
  }

  // ============================================================== accounts (tag owner/kind/name)

  async setOwner(account: FinanceAccount, owner: FinanceOwner): Promise<void> {
    if (account.owner === owner) return;
    await this.patchAccount(account, { owner });
  }

  async setKind(account: FinanceAccount, kind: FinanceAccountKind): Promise<void> {
    if (account.kind === kind) return;
    await this.patchAccount(account, { kind });
  }

  async rename(account: FinanceAccount): Promise<void> {
    const name = window.prompt('Rename account', account.name)?.trim();
    if (!name || name === account.name) return;
    await this.patchAccount(account, { name });
  }

  private async patchAccount(
    account: FinanceAccount,
    patch: { owner?: FinanceOwner; kind?: FinanceAccountKind; name?: string },
  ): Promise<void> {
    try {
      const updated = await firstValueFrom(this.api.updateFinanceAccount(account.id, patch));
      this.accounts.update((list) =>
        list.map((a) =>
          a.id === account.id
            ? { ...a, name: updated.name, owner: updated.owner, kind: updated.kind }
            : a,
        ),
      );
      // Owner/name changes re-flow into the his/hers split + the table — refresh those.
      this.loadSummary();
      this.loadTxns();
    } catch (e) {
      this.snack.open(this.messageOf(e, "Couldn't update that account."), 'OK', { duration: 4000 });
    }
  }

  // ============================================================== transaction filters / paging

  setAccountFilter(id: number | null): void {
    this.fAccount.set(id);
    this.txnPage.set(1);
    this.loadTxns();
  }
  setCategoryFilter(c: string | null): void {
    this.fCategory.set(c);
    this.txnPage.set(1);
    this.loadTxns();
  }
  setOwnerFilter(o: FinanceOwner | null): void {
    this.fOwner.set(o);
    this.txnPage.set(1);
    this.loadTxns();
  }
  setKindFilter(k: FinanceTxnKind | null): void {
    this.fKind.set(k);
    this.txnPage.set(1);
    this.loadTxns();
  }

  clearFilters(): void {
    this.fAccount.set(null);
    this.fCategory.set(null);
    this.fOwner.set(null);
    this.fKind.set(null);
    this.txnPage.set(1);
    this.loadTxns();
  }

  readonly hasFilters = computed(
    () =>
      this.fAccount() != null ||
      this.fCategory() != null ||
      this.fOwner() != null ||
      this.fKind() != null,
  );

  stepPage(delta: number): void {
    const next = Math.min(this.txnPages(), Math.max(1, this.txnPage() + delta));
    if (next === this.txnPage()) return;
    this.txnPage.set(next);
    this.loadTxns();
  }

  // ============================================================== charts (reuse the app's ECharts wrapper)

  /** By-category spend as a donut (the dashboard's headline breakdown). */
  readonly categoryOption = computed<EChartsOption>(() => {
    const cats = this.summary()?.byCategory ?? [];
    return {
      tooltip: {
        trigger: 'item',
        valueFormatter: (v) => (typeof v === 'number' ? this.money(v) : String(v)),
      },
      legend: { type: 'scroll', bottom: 0, left: 'center' },
      series: [
        {
          type: 'pie',
          radius: ['52%', '76%'],
          center: ['50%', '44%'],
          avoidLabelOverlap: true,
          itemStyle: { borderColor: 'rgba(8,12,20,0.9)', borderWidth: 2 },
          label: { show: false },
          data: cats.map((c) => ({ name: c.category, value: Number(c.amount.toFixed(2)) })),
        },
      ],
    };
  });

  /** The His vs Hers (vs Joint) split as a compact horizontal bar. */
  readonly ownerOption = computed<EChartsOption>(() => {
    const owners = this.summary()?.byOwner ?? [];
    const order: FinanceOwner[] = ['his', 'hers', 'joint', 'unassigned'];
    const rows = order
      .map((o) => owners.find((x) => x.owner === o))
      .filter((x): x is NonNullable<typeof x> => !!x && x.amount > 0);
    return {
      grid: { left: 70, right: 24, top: 8, bottom: 8 },
      tooltip: {
        trigger: 'axis',
        valueFormatter: (v) => (typeof v === 'number' ? this.money(v) : String(v)),
      },
      xAxis: { type: 'value', axisLabel: { formatter: (v: number) => this.moneyShort(v) } },
      yAxis: { type: 'category', data: rows.map((r) => this.ownerLabel(r.owner)) },
      series: [
        {
          type: 'bar',
          data: rows.map((r) => ({
            value: Number(r.amount.toFixed(2)),
            itemStyle: { color: OWNER_COLOR[r.owner] },
          })),
          barWidth: 22,
          label: {
            show: true,
            position: 'right',
            color: '#9ba9bd',
            formatter: (p) => this.moneyShort(typeof p.value === 'number' ? p.value : 0),
          },
        },
      ],
    };
  });

  /** The rolling 12-month spent vs income trend line. */
  readonly trendOption = computed<EChartsOption>(() => {
    const pts = this.summary()?.monthlyTrend ?? [];
    const labels = pts.map((p) => {
      const [y, m] = p.month.split('-').map(Number);
      return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'short' });
    });
    return {
      grid: { left: 56, right: 16, top: 28, bottom: 28 },
      tooltip: {
        trigger: 'axis',
        valueFormatter: (v) => (typeof v === 'number' ? this.money(v) : String(v)),
      },
      legend: { top: 0, right: 0, data: ['Spent', 'Income'] },
      xAxis: { type: 'category', boundaryGap: false, data: labels },
      yAxis: { type: 'value', axisLabel: { formatter: (v: number) => this.moneyShort(v) } },
      series: [
        {
          name: 'Spent',
          type: 'line',
          smooth: true,
          showSymbol: false,
          lineStyle: { width: 2 },
          areaStyle: { opacity: 0.1 },
          data: pts.map((p) => Number(p.spent.toFixed(2))),
        },
        {
          name: 'Income',
          type: 'line',
          smooth: true,
          showSymbol: false,
          lineStyle: { width: 2 },
          data: pts.map((p) => Number(p.income.toFixed(2))),
        },
      ],
    };
  });

  /** The net-worth-over-time line (from the snapshot history). */
  readonly netWorthTrendOption = computed<EChartsOption>(() => {
    const pts = this.netWorth()?.trend ?? [];
    const labels = pts.map((p) => {
      const [y, m] = p.month.split('-').map(Number);
      return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'short' });
    });
    return {
      grid: { left: 56, right: 16, top: 16, bottom: 28 },
      tooltip: {
        trigger: 'axis',
        valueFormatter: (v) => (typeof v === 'number' ? this.money(v) : String(v)),
      },
      xAxis: { type: 'category', boundaryGap: false, data: labels },
      yAxis: { type: 'value', axisLabel: { formatter: (v: number) => this.moneyShort(v) } },
      series: [
        {
          name: 'Net worth',
          type: 'line',
          smooth: true,
          showSymbol: false,
          lineStyle: { width: 2, color: '#3dd68c' },
          itemStyle: { color: '#3dd68c' },
          areaStyle: { opacity: 0.12, color: '#3dd68c' },
          data: pts.map((p) => Number(p.netWorth.toFixed(2))),
        },
      ],
    };
  });

  // ============================================================== formatting helpers

  ownerLabel(o: FinanceOwner): string {
    return OWNER_LABEL[o] ?? o;
  }
  kindLabel(k: FinanceAccountKind): string {
    return KIND_LABEL[k] ?? k;
  }
  txnKindLabel(k: FinanceTxnKind): string {
    return TXN_KIND_LABEL[k] ?? k;
  }

  /** A signed currency string, e.g. "$1,234.56". */
  money(n: number): string {
    return n.toLocaleString(undefined, { style: 'currency', currency: 'USD' });
  }

  /** A signed currency string for a staged row (income +, expense −, transfer unsigned). */
  signedStaged(row: FinanceStagedRow): string {
    const sign = row.kind === 'income' ? '+' : row.kind === 'expense' ? '−' : '';
    return `${sign}${this.money(row.magnitude)}`;
  }

  /** A friendly label for the detected import format (Rocket Money / CSV / OFX). */
  formatLabel(f: FinanceImportFormat): string {
    return f === 'rocketmoney' ? 'Rocket Money' : f === 'ofx' ? 'OFX / QFX' : 'Bank CSV';
  }

  /** A compact currency string for axes/labels, e.g. "$1.2k". */
  moneyShort(n: number): string {
    const abs = Math.abs(n);
    if (abs >= 1000) return `$${(n / 1000).toFixed(abs >= 10000 ? 0 : 1)}k`;
    return `$${Math.round(n)}`;
  }

  /** A friendly "Jun 18, 2026" from an ISO `yyyy-MM-dd`. */
  txnDate(iso: string): string {
    const d = new Date(`${iso}T00:00:00`);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  /** A friendly absolute date+time for the import-history strip (from a UTC ISO string). */
  importWhen(utc: string): string {
    const d = new Date(utc);
    if (Number.isNaN(d.getTime())) return '';
    return (
      d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) +
      ' · ' +
      d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    );
  }

  initials(name: string): string {
    const parts = (name || '').split(/\s+/).filter(Boolean);
    return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
  }

  private currentMonth(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  private messageOf(e: unknown, fallback: string): string {
    const msg = (e as { error?: { message?: string } })?.error?.message;
    return typeof msg === 'string' && msg ? msg : fallback;
  }
}
