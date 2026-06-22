import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
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
  FinanceAccount, FinanceAccountKind, FinanceImportBatch, FinanceMoneyCoachResult, FinanceOwner, FinanceSummary,
  FinanceSummaryAiResult, FinanceTransaction, FinanceTransactionsPage, FinanceTxnKind,
} from '../../core/models';
import { ChartComponent } from '../../shared/chart';

/** Friendly labels for the owner tag (his/hers/joint/unassigned). */
const OWNER_LABEL: Record<FinanceOwner, string> = {
  his: 'His', hers: 'Hers', joint: 'Joint', unassigned: 'Unassigned',
};

/** Friendly labels for the account kind. */
const KIND_LABEL: Record<FinanceAccountKind, string> = {
  bank: 'Bank', credit: 'Credit', other: 'Other',
};

/** Friendly labels for the transaction kind filter (expense/income/transfer). */
const TXN_KIND_LABEL: Record<FinanceTxnKind, string> = {
  expense: 'Expenses', income: 'Income', transfer: 'Transfers',
};

/** Owner options offered in the account-tagging picker. */
const OWNER_OPTIONS: FinanceOwner[] = ['his', 'hers', 'joint', 'unassigned'];
const KIND_OPTIONS: FinanceAccountKind[] = ['bank', 'credit', 'other'];

/** A donut/bar accent per owner so His/Hers/Joint read consistently across the page. */
const OWNER_COLOR: Record<FinanceOwner, string> = {
  his: '#3d8bff', hers: '#ff7eb6', joint: '#3dd68c', unassigned: '#5e6c82',
};

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
    RouterLink, MatIconModule, MatButtonModule, MatTooltipModule, MatProgressSpinnerModule,
    MatSnackBarModule, ChartComponent,
  ],
  templateUrl: './finance.html',
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

  // ---- import dropzone ----
  readonly importing = signal(false);
  readonly dragOver = signal(false);

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
  readonly categories = computed(() => (this.summary()?.byCategory ?? []).map(c => c.category));

  /** Total expense pages for the current filter. */
  readonly txnPages = computed(() => Math.max(1, Math.ceil(this.txnTotal() / this.pageSize)));

  /** Whether any transactions have been imported yet (drives the empty/first-run state). */
  readonly hasData = computed(() =>
    this.accounts().length > 0 || (this.summary()?.byCategory.length ?? 0) > 0 || this.imports().length > 0);

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
  }

  private loadSummary(): void {
    this.api.financeSummary(this.month())
      .pipe(catchError(() => { if (this.loading()) this.error.set(true); return of<FinanceSummary | null>(null); }),
        takeUntilDestroyed(this.destroyRef))
      .subscribe(s => {
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
    this.api.financeAccounts()
      .pipe(catchError(() => of<FinanceAccount[]>([])), takeUntilDestroyed(this.destroyRef))
      .subscribe(a => this.accounts.set(a));
  }

  private loadImports(): void {
    this.api.financeImports()
      .pipe(catchError(() => of<FinanceImportBatch[]>([])), takeUntilDestroyed(this.destroyRef))
      .subscribe(i => this.imports.set(i));
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
    this.api.financeSummaryAi(month)
      .pipe(catchError(() => of<FinanceSummaryAiResult | null>(null)), takeUntilDestroyed(this.destroyRef))
      .subscribe(s => {
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
    this.api.financeMoneyCoachAi()
      .pipe(catchError(() => of<FinanceMoneyCoachResult | null>(null)), takeUntilDestroyed(this.destroyRef))
      .subscribe(c => {
        this.coach.set(c);
        this.coachLoading.set(false);
      });
  }

  private loadTxns(): void {
    this.txnLoading.set(true);
    this.api.financeTransactions({
      month: this.month(), accountId: this.fAccount(), category: this.fCategory(),
      owner: this.fOwner(), kind: this.fKind(), page: this.txnPage(),
    })
      .pipe(catchError(() => of<FinanceTransactionsPage | null>(null)), takeUntilDestroyed(this.destroyRef))
      .subscribe(p => {
        if (p) { this.txns.set(p.items); this.txnTotal.set(p.total); }
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
    if (file) void this.readAndImport(file);
  }

  onPick(e: Event): void {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) void this.readAndImport(file);
    input.value = ''; // allow re-picking the same file
  }

  /** Read the chosen CSV as text in the browser, POST it, toast the de-duped result, and refresh. */
  private async readAndImport(file: File): Promise<void> {
    if (this.importing()) return;
    if (!/\.csv$/i.test(file.name)) {
      this.snack.open('Please choose a .csv file exported from Rocket Money.', 'OK', { duration: 4000 });
      return;
    }
    this.importing.set(true);
    try {
      const content = await file.text();
      const res = await firstValueFrom(this.api.importFinanceCsv(file.name, content));
      const dup = res.skipped === 1 ? 'duplicate' : 'duplicates';
      this.snack.open(`Imported ${res.imported}, skipped ${res.skipped} ${dup}`, undefined, { duration: 4000 });
      this.txnPage.set(1);
      this.reloadAll();
    } catch (e) {
      this.snack.open(this.messageOf(e, "Couldn't import that file. Please try again."), 'OK', { duration: 5000 });
    } finally {
      this.importing.set(false);
    }
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
    account: FinanceAccount, patch: { owner?: FinanceOwner; kind?: FinanceAccountKind; name?: string },
  ): Promise<void> {
    try {
      const updated = await firstValueFrom(this.api.updateFinanceAccount(account.id, patch));
      this.accounts.update(list =>
        list.map(a => (a.id === account.id ? { ...a, name: updated.name, owner: updated.owner, kind: updated.kind } : a)));
      // Owner/name changes re-flow into the his/hers split + the table — refresh those.
      this.loadSummary();
      this.loadTxns();
    } catch (e) {
      this.snack.open(this.messageOf(e, "Couldn't update that account."), 'OK', { duration: 4000 });
    }
  }

  // ============================================================== transaction filters / paging

  setAccountFilter(id: number | null): void { this.fAccount.set(id); this.txnPage.set(1); this.loadTxns(); }
  setCategoryFilter(c: string | null): void { this.fCategory.set(c); this.txnPage.set(1); this.loadTxns(); }
  setOwnerFilter(o: FinanceOwner | null): void { this.fOwner.set(o); this.txnPage.set(1); this.loadTxns(); }
  setKindFilter(k: FinanceTxnKind | null): void { this.fKind.set(k); this.txnPage.set(1); this.loadTxns(); }

  clearFilters(): void {
    this.fAccount.set(null); this.fCategory.set(null); this.fOwner.set(null); this.fKind.set(null);
    this.txnPage.set(1);
    this.loadTxns();
  }

  readonly hasFilters = computed(() =>
    this.fAccount() != null || this.fCategory() != null || this.fOwner() != null || this.fKind() != null);

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
          data: cats.map(c => ({ name: c.category, value: Number(c.amount.toFixed(2)) })),
        },
      ],
    };
  });

  /** The His vs Hers (vs Joint) split as a compact horizontal bar. */
  readonly ownerOption = computed<EChartsOption>(() => {
    const owners = this.summary()?.byOwner ?? [];
    const order: FinanceOwner[] = ['his', 'hers', 'joint', 'unassigned'];
    const rows = order
      .map(o => owners.find(x => x.owner === o))
      .filter((x): x is NonNullable<typeof x> => !!x && x.amount > 0);
    return {
      grid: { left: 70, right: 24, top: 8, bottom: 8 },
      tooltip: { trigger: 'axis', valueFormatter: (v) => (typeof v === 'number' ? this.money(v) : String(v)) },
      xAxis: { type: 'value', axisLabel: { formatter: (v: number) => this.moneyShort(v) } },
      yAxis: { type: 'category', data: rows.map(r => this.ownerLabel(r.owner)) },
      series: [
        {
          type: 'bar',
          data: rows.map(r => ({ value: Number(r.amount.toFixed(2)), itemStyle: { color: OWNER_COLOR[r.owner] } })),
          barWidth: 22,
          label: {
            show: true, position: 'right', color: '#9ba9bd',
            formatter: (p) => this.moneyShort(typeof p.value === 'number' ? p.value : 0),
          },
        },
      ],
    };
  });

  /** The rolling 12-month spent vs income trend line. */
  readonly trendOption = computed<EChartsOption>(() => {
    const pts = this.summary()?.monthlyTrend ?? [];
    const labels = pts.map(p => {
      const [y, m] = p.month.split('-').map(Number);
      return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'short' });
    });
    return {
      grid: { left: 56, right: 16, top: 28, bottom: 28 },
      tooltip: { trigger: 'axis', valueFormatter: (v) => (typeof v === 'number' ? this.money(v) : String(v)) },
      legend: { top: 0, right: 0, data: ['Spent', 'Income'] },
      xAxis: { type: 'category', boundaryGap: false, data: labels },
      yAxis: { type: 'value', axisLabel: { formatter: (v: number) => this.moneyShort(v) } },
      series: [
        { name: 'Spent', type: 'line', smooth: true, showSymbol: false, lineStyle: { width: 2 },
          areaStyle: { opacity: 0.1 }, data: pts.map(p => Number(p.spent.toFixed(2))) },
        { name: 'Income', type: 'line', smooth: true, showSymbol: false, lineStyle: { width: 2 },
          data: pts.map(p => Number(p.income.toFixed(2))) },
      ],
    };
  });

  // ============================================================== formatting helpers

  ownerLabel(o: FinanceOwner): string { return OWNER_LABEL[o] ?? o; }
  kindLabel(k: FinanceAccountKind): string { return KIND_LABEL[k] ?? k; }
  txnKindLabel(k: FinanceTxnKind): string { return TXN_KIND_LABEL[k] ?? k; }

  /** A signed currency string, e.g. "$1,234.56". */
  money(n: number): string {
    return n.toLocaleString(undefined, { style: 'currency', currency: 'USD' });
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
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
      + ' · ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
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
