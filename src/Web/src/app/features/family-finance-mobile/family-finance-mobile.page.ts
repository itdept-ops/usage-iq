import {
  ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal, viewChild,
  type ElementRef,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { catchError, firstValueFrom, of } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatIconModule } from '@angular/material/icon';

import { Api } from '../../core/api';
import {
  FinanceAccount,
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
} from '../../core/models';
import { FINANCE_DEFAULT_CATEGORIES } from '../family/finance';
import {
  BetaPullRefresh, BetaSegmentedControl, BetaBottomSheet, BetaStatTile, BetaSkeleton,
  BetaFab, BetaToaster, BetaEmptyState, BetaErrorState, ToastController, type Segment,
} from '../beta-ui';

/** The editable column-map fields the generic-CSV step collects on mobile (header picks + a sign toggle). */
type ColumnMapField =
  | 'date' | 'amount' | 'debit' | 'credit'
  | 'description' | 'category' | 'account' | 'accountName' | 'institution';

/** Friendly His/Hers/Joint labels for the owner tags (display only — never an email). */
const OWNER_LABEL: Record<FinanceOwner, string> = {
  his: 'His', hers: 'Hers', joint: 'Joint', unassigned: 'Unassigned',
};

/**
 * A per-owner accent so His/Hers/Joint read consistently across the screen.
 * NOTE: `joint` is routed through the `--tech-success` token in ownerColor(); the literal here
 * is only the never-invisible fallback.
 */
const OWNER_COLOR: Record<FinanceOwner, string> = {
  his: '#3d8bff', hers: '#ff7eb6', joint: '#3dd68c', unassigned: '#5e6c82',
};

/** The mobile detail filter tabs: spending, recurring bills, budgets, net worth, savings goals. */
type DetailTab = 'spending' | 'recurring' | 'budgets' | 'networth' | 'goals';

/** Friendly labels for a budget's pace status. */
const BUDGET_STATUS_LABEL: Record<FinanceBudgetStatus, string> = {
  under: 'On track', near: 'Close', over: 'Over pace',
};

/**
 * Family Finance "Ledger" — the mobile-first twin of the live /family/finance Hub room, rebuilt on the
 * shared beta-ui "Strata" kit (`@use '../beta-ui/beta-kit'`). One signature accent — a cool MINT → TEAL —
 * re-skins the whole screen via the per-page accent contract. The most sensitive room in the hub: the
 * canonical route stays DOUBLE-GATED server-side by family.use AND family.finance (this twin adds no data
 * path of its own), data is household-private and never shared to outside contacts, and an import is shown
 * by display NAME only — never an email.
 *
 * It re-presents the live dashboard for the thumb: an immersive header with a prev/next MONTH stepper and
 * three headline {@link BetaStatTile} cards (Spent · Income · Net); an optional warm "✨ Explain this month"
 * AI card (read-only, never blocks); a {@link BetaSegmentedControl} flipping a list between SPENDING
 * (by-category bars + the His-vs-Hers owner split) and RECURRING (the deterministic Money-coach bills
 * floor); a recent-transactions strip that opens a {@link BetaBottomSheet} per row; and a {@link BetaFab}
 * whose only "add" path is the SAME Rocket-Money CSV import the live page uses (read-as-text → POST).
 *
 * DATA PARITY + PRIVACY: every number comes straight from the SAME double-gated `/api/family/finance/*`
 * endpoints the live page calls — {@link Api.financeSummary}, {@link Api.financeAccounts},
 * {@link Api.financeTransactions}, {@link Api.financeImports}, {@link Api.financeSummaryAi},
 * {@link Api.financeMoneyCoachAi}, and {@link Api.importFinanceCsv} VERBATIM (the import body is built
 * exactly like the live dropzone). The server resolves the month (it may fall back to the latest with data)
 * and enforces all gating + household scoping; the UI only re-presents what it returns.
 *
 * ISOLATION: gated by `platform.mobile` + the SAME double family.use/family.finance the live route carries;
 * it consumes the kit + the SAME Api as the live counterpart. No live page is imported or modified. Layout
 * is mobile-first (44px targets, safe-area insets, no 390px overflow) and centers on desktop; reduced
 * motion collapses the kit animations via the a11y killswitch. The harness mocks the Api, so every state
 * (loading skeletons, empty/first-run, error) renders cleanly with ZERO data.
 */
@Component({
  selector: 'app-family-finance-mobile',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [ToastController],
  imports: [
    DecimalPipe, MatIconModule,
    BetaPullRefresh, BetaSegmentedControl, BetaBottomSheet, BetaStatTile, BetaSkeleton,
    BetaFab, BetaToaster, BetaEmptyState, BetaErrorState,
  ],
  template: `
    <!-- ─────────────── PULL-TO-REFRESH OWNS THE SCROLL ─────────────── -->
    <app-bs-pull-refresh class="ff-ptr" [busy]="refreshing()" (refresh)="reload()">
      <div class="ff-scroll" aria-live="polite">

        <!-- ─── IMMERSIVE HEADER: title + month stepper ─── -->
        <header class="ff-hero">
          <p class="ff-hero__kicker"><mat-icon aria-hidden="true">account_balance_wallet</mat-icon> Family Finance</p>
          <h1 class="ff-hero__title">Ledger</h1>
          <p class="ff-hero__sub">Where the money went — private to your household, never shared out.</p>

          @if (!loading() && !errored() && hasData()) {
            <div class="ff-month" role="group" aria-label="Viewed month">
              <button type="button" class="ff-month__nav" (click)="stepMonth(-1)" aria-label="Previous month">
                <mat-icon aria-hidden="true">chevron_left</mat-icon>
              </button>
              <span class="ff-month__label">{{ monthLabel() }}</span>
              <button type="button" class="ff-month__nav" (click)="stepMonth(1)" aria-label="Next month">
                <mat-icon aria-hidden="true">chevron_right</mat-icon>
              </button>
            </div>
          }
        </header>

        @if (loading()) {
          <!-- skeleton: stat row + list -->
          <div class="ff-stats" aria-hidden="true">
            @for (n of [0,1,2]; track n) { <app-bs-skeleton height="84px" radius="var(--r-tile)" /> }
          </div>
          <div class="ff-seg-wrap" aria-hidden="true">
            <app-bs-skeleton width="100%" height="44px" radius="var(--r-pill)" />
          </div>
          <div class="ff-list" aria-hidden="true">
            @for (n of skeletonCells; track n) { <app-bs-skeleton height="62px" radius="var(--r-tile)" /> }
          </div>

        } @else if (errored()) {
          <app-bs-error
            icon="cloud_off"
            title="Couldn't load your finances"
            body="Something went wrong fetching the household ledger. Give it another go."
            (retry)="reload()" />

        } @else if (!hasData()) {
          <!-- FIRST-RUN: nothing imported yet -->
          <app-bs-empty
            icon="request_quote"
            title="No finances yet"
            body="Import a Rocket Money, bank CSV, or OFX/QFX file to see your spending, income and recurring bills. You'll review every row before anything is added — all private to your household."
            ctaLabel="Import transactions" ctaIcon="upload_file" (action)="pickFile()" />

        } @else {
          <!-- ─── HEADLINE STAT TILES: Spent · Income · Net ─── -->
          <div class="ff-stats">
            <app-bs-stat-tile [value]="money(summary()?.totalSpent ?? 0)" label="Spent"
              accentA="#fb7185" accentB="#e11d48" />
            <app-bs-stat-tile [value]="money(summary()?.totalIncome ?? 0)" label="Income"
              accentA="#34d399" accentB="#059669" />
            <app-bs-stat-tile [value]="money(net())" label="Net"
              [accentA]="net() >= 0 ? '#34d399' : '#fb7185'" [accentB]="net() >= 0 ? '#059669' : '#e11d48'" />
          </div>

          <!-- ─── ✨ EXPLAIN THIS MONTH (read-only AI narration; best-effort) ─── -->
          @if (aiSummary(); as ai) {
            <section class="ff-ai">
              <span class="ff-ai__spark" aria-hidden="true"><mat-icon>auto_awesome</mat-icon></span>
              <div class="ff-ai__body">
                <p class="ff-ai__narr">{{ ai.narrative }}</p>
                @if (ai.insights?.length) {
                  <ul class="ff-ai__insights">
                    @for (ins of ai.insights; track $index) { <li>{{ ins }}</li> }
                  </ul>
                }
              </div>
            </section>
          }

          <!-- ─── TAB SWITCH: Spending | Recurring ─── -->
          <div class="ff-seg-wrap">
            <app-bs-segmented class="ff-seg"
              [segments]="tabSegments()" [value]="tab()" label="Show"
              (change)="setTab($event)" />
          </div>

          @if (tab() === 'spending') {
            <!-- by-category bars -->
            @if (categories().length) {
              <div class="ff-bars">
                @for (c of categories(); track c.category; let i = $index) {
                  <div class="ff-bar ff-reveal" [style.--ri]="i">
                    <div class="ff-bar__top">
                      <span class="ff-bar__name">{{ c.category }}</span>
                      <span class="ff-bar__amt mono-num">{{ money(c.amount) }}</span>
                    </div>
                    <div class="ff-bar__track" aria-hidden="true">
                      <span class="ff-bar__fill" [style.width.%]="barPct(c.amount)"></span>
                    </div>
                    <span class="ff-bar__pct mono-num">{{ c.pct | number:'1.0-0' }}%</span>
                  </div>
                }
              </div>

              <!-- His vs Hers vs Joint split -->
              @if (ownerRows().length) {
                <div class="ff-owners">
                  <span class="ff-owners__title">His · Hers · Joint</span>
                  @for (o of ownerRows(); track o.owner) {
                    <div class="ff-owner">
                      <span class="ff-owner__dot" [style.background]="ownerColor(o.owner)" aria-hidden="true"></span>
                      <span class="ff-owner__name">{{ ownerLabel(o.owner) }}</span>
                      <span class="ff-owner__bar" aria-hidden="true">
                        <span class="ff-owner__fill"
                          [style.width.%]="ownerPct(o.amount)" [style.background]="ownerColor(o.owner)"></span>
                      </span>
                      <span class="ff-owner__amt mono-num">{{ money(o.amount) }}</span>
                    </div>
                  }
                </div>
              }
            } @else {
              <div class="ff-mini-empty">
                <mat-icon aria-hidden="true">savings</mat-icon>
                <p>No spending recorded for {{ monthLabel() }}.</p>
              </div>
            }

            <!-- recent transactions for the month -->
            <div class="ff-txn-head">
              <span class="ff-txn-head__title">Recent transactions</span>
              @if (txnTotal()) { <span class="ff-txn-head__count mono-num">{{ txnTotal() | number }}</span> }
            </div>
            @if (txnLoading()) {
              <div class="ff-list" aria-hidden="true">
                @for (n of [0,1,2,3]; track n) { <app-bs-skeleton height="58px" radius="var(--r-tile)" /> }
              </div>
            } @else if (txns().length) {
              <div class="ff-list">
                @for (t of txns(); track t.id; let i = $index) {
                  <button type="button" class="ff-txn ff-reveal" [style.--ri]="i"
                          (click)="openTxn(t)" [attr.aria-label]="txnAria(t)">
                    <span class="ff-txn__glyph" [class]="'is-' + t.kind" aria-hidden="true">
                      <mat-icon>{{ kindIcon(t.kind) }}</mat-icon>
                    </span>
                    <span class="ff-txn__body">
                      <span class="ff-txn__merchant">{{ t.merchant }}</span>
                      <span class="ff-txn__meta">
                        {{ txnDate(t.date) }}
                        @if (t.category) { · {{ t.category }} }
                      </span>
                    </span>
                    <span class="ff-txn__amt mono-num" [class.is-in]="t.kind === 'income'">
                      {{ signedMoney(t) }}
                    </span>
                  </button>
                }
              </div>
            } @else {
              <div class="ff-mini-empty">
                <mat-icon aria-hidden="true">receipt_long</mat-icon>
                <p>No transactions in {{ monthLabel() }}.</p>
              </div>
            }

          } @else if (tab() === 'budgets') {
            <!-- ─── BUDGETS: per-category spend/limit progress bars (green→amber→red BY PACE) ─── -->
            @if (budgetsLoading() && !budgets()) {
              <div class="ff-list" aria-hidden="true">
                @for (n of [0,1,2]; track n) { <app-bs-skeleton height="68px" radius="var(--r-tile)" /> }
              </div>
            } @else if (budgets(); as bg) {
              @if (bg.budgets?.length) {
                <div class="ff-budgets">
                  @for (b of bg.budgets; track b.id; let i = $index) {
                    <div class="ff-budget ff-reveal" [style.--ri]="i" [attr.data-status]="b.status">
                      <div class="ff-budget__top">
                        <span class="ff-budget__name">{{ budgetLabel(b) }}</span>
                        <span class="ff-budget__status" [attr.data-status]="b.status">{{ budgetStatusLabel(b.status) }}</span>
                      </div>
                      <div class="ff-budget__track" aria-hidden="true">
                        <span class="ff-budget__fill" [attr.data-status]="b.status" [style.width.%]="budgetFillPct(b)"></span>
                      </div>
                      <div class="ff-budget__foot mono-num">
                        <span class="ff-budget__nums"><strong>{{ money(b.spent) }}</strong> / {{ money(b.limitAmount) }}</span>
                        <span class="ff-budget__remain" [class.is-over]="b.remaining < 0">
                          {{ b.remaining >= 0 ? money(b.remaining) + ' left' : money(-b.remaining) + ' over' }}
                        </span>
                      </div>
                    </div>
                  }
                </div>
              } @else {
                <div class="ff-mini-empty">
                  <mat-icon aria-hidden="true">savings</mat-icon>
                  <p>No budgets yet — set per-category limits on the desktop to track them here.</p>
                </div>
              }
              @if (bg.unbudgeted.spent > 0) {
                <div class="ff-unbudgeted">
                  <mat-icon aria-hidden="true">help_outline</mat-icon>
                  <span><strong class="mono-num">{{ money(bg.unbudgeted.spent) }}</strong> unbudgeted
                    across {{ bg.unbudgeted.categoryCount }} categor{{ bg.unbudgeted.categoryCount === 1 ? 'y' : 'ies' }}</span>
                </div>
              }
            }

          } @else if (tab() === 'networth') {
            <!-- ─── NET WORTH: 3 stat tiles + a per-account balance editor (manual entry) ─── -->
            @if (netWorthLoading() && !netWorth()) {
              <div class="ff-stats" aria-hidden="true">
                @for (n of [0,1,2]; track n) { <app-bs-skeleton height="84px" radius="var(--r-tile)" /> }
              </div>
            } @else if (netWorth(); as nw) {
              <div class="ff-stats">
                <app-bs-stat-tile [value]="money(nw.assets)" label="Assets" accentA="#34d399" accentB="#059669" />
                <app-bs-stat-tile [value]="money(nw.liabilities)" label="Liabilities" accentA="#fb7185" accentB="#e11d48" />
                <app-bs-stat-tile [value]="money(nw.netWorth)" label="Net worth"
                  [accentA]="nw.netWorth >= 0 ? '#34d399' : '#fb7185'" [accentB]="nw.netWorth >= 0 ? '#059669' : '#e11d48'" />
              </div>
              <p class="ff-nw-hint"><mat-icon aria-hidden="true">edit_note</mat-icon> Balances are entered by hand — there's no live bank link.</p>
              @if (nw.accounts?.length) {
                <div class="ff-list">
                  @for (a of nw.accounts; track a.accountId; let i = $index) {
                    <button type="button" class="ff-nw-acct ff-reveal" [style.--ri]="i" (click)="openBalance(a)">
                      <span class="ff-nw-acct__dot" [style.background]="ownerColor(a.owner)" aria-hidden="true"></span>
                      <span class="ff-nw-acct__body">
                        <span class="ff-nw-acct__name">{{ a.name }}</span>
                        <span class="ff-nw-acct__meta">
                          {{ ownerLabel(a.owner) }} · {{ a.kind }}
                          @if (a.hasBalance) { · {{ txnDate(a.asOfDate!) }} }
                        </span>
                      </span>
                      <span class="ff-nw-acct__bal mono-num" [class.is-neg]="a.latestBalance < 0" [class.is-prompt]="!a.hasBalance">
                        {{ a.hasBalance ? money(a.latestBalance) : 'Set' }}
                      </span>
                    </button>
                  }
                </div>
              } @else {
                <div class="ff-mini-empty">
                  <mat-icon aria-hidden="true">account_balance</mat-icon>
                  <p>Import a CSV to populate accounts, then enter a balance for each.</p>
                </div>
              }
            }

          } @else if (tab() === 'goals') {
            <!-- ─── SAVINGS GOALS: ring-to-target cards with an owner tag ─── -->
            @if (savingsLoading() && !savings()) {
              <div class="ff-list" aria-hidden="true">
                @for (n of [0,1,2]; track n) { <app-bs-skeleton height="84px" radius="var(--r-tile)" /> }
              </div>
            } @else if (savings(); as sv) {
              @if (sv.goals?.length) {
                <div class="ff-goals">
                  @for (g of sv.goals; track g.id; let i = $index) {
                    <div class="ff-goal ff-reveal" [style.--ri]="i" [class.is-archived]="g.archived">
                      <span class="ff-goal__ring" [style.background]="goalRing(g)" aria-hidden="true">
                        <span class="ff-goal__ring-inner mono-num">{{ goalPct(g) }}%</span>
                      </span>
                      <span class="ff-goal__body">
                        <span class="ff-goal__head">
                          <span class="ff-goal__name">{{ g.name }}</span>
                          <span class="ff-goal__owner" [style.color]="ownerColor(g.owner)">{{ ownerLabel(g.owner) }}</span>
                        </span>
                        <span class="ff-goal__nums mono-num"><strong>{{ money(g.savedAmount) }}</strong> of {{ money(g.targetAmount) }}</span>
                        @if (g.targetDate || g.projectedFinish) {
                          <span class="ff-goal__meta">
                            @if (g.targetDate) { by {{ txnDate(g.targetDate) }} }
                            @if (g.projectedFinish) { · on pace {{ txnDate(g.projectedFinish) }} }
                          </span>
                        }
                      </span>
                    </div>
                  }
                </div>
              } @else {
                <div class="ff-mini-empty">
                  <mat-icon aria-hidden="true">flag</mat-icon>
                  <p>No savings goals yet — add one on the desktop to track progress here.</p>
                </div>
              }
            }

          } @else {
            <!-- ─── RECURRING: the deterministic Money-coach bills floor ─── -->
            @if (coachLoading()) {
              <div class="ff-list" aria-hidden="true">
                @for (n of [0,1,2,3]; track n) { <app-bs-skeleton height="62px" radius="var(--r-tile)" /> }
              </div>
            } @else if (coach(); as c) {
              <div class="ff-recur-total">
                <span class="ff-recur-total__l">Estimated monthly bills</span>
                <span class="ff-recur-total__n mono-num">{{ money(c.monthlyRecurringTotal) }}</span>
              </div>
              @if (c.narrative) {
                <section class="ff-ai ff-ai--tips">
                  <span class="ff-ai__spark" aria-hidden="true"><mat-icon>auto_awesome</mat-icon></span>
                  <div class="ff-ai__body">
                    <p class="ff-ai__narr">{{ c.narrative }}</p>
                    @if (c.tips?.length) {
                      <ul class="ff-ai__insights">
                        @for (tip of c.tips; track $index) { <li>{{ tip }}</li> }
                      </ul>
                    }
                  </div>
                </section>
              }
              @if (c.recurring?.length) {
                <div class="ff-list">
                  @for (r of c.recurring; track r.merchant; let i = $index) {
                    <div class="ff-recur ff-reveal" [style.--ri]="i">
                      <span class="ff-recur__glyph" aria-hidden="true"><mat-icon>autorenew</mat-icon></span>
                      <span class="ff-recur__body">
                        <span class="ff-recur__merchant">{{ r.merchant }}</span>
                        <span class="ff-recur__meta">
                          {{ r.cadence }} · seen {{ r.monthsSeen }} mo · last {{ txnDate(r.lastDate) }}
                        </span>
                      </span>
                      <span class="ff-recur__amt mono-num">{{ money(r.typicalAmount) }}</span>
                    </div>
                  }
                </div>
              } @else {
                <div class="ff-mini-empty">
                  <mat-icon aria-hidden="true">autorenew</mat-icon>
                  <p>No recurring bills detected yet.</p>
                </div>
              }
            } @else {
              <div class="ff-mini-empty">
                <mat-icon aria-hidden="true">autorenew</mat-icon>
                <p>Recurring bills will show up here once you've imported enough activity.</p>
              </div>
            }
          }

          <!-- import history strip (who, by NAME only) -->
          @if (imports().length) {
            <div class="ff-imports">
              <span class="ff-imports__title"><mat-icon aria-hidden="true">history</mat-icon> Recent imports</span>
              @for (im of imports().slice(0, 4); track im.id) {
                <div class="ff-import">
                  <span class="ff-import__file">{{ im.fileName }}</span>
                  <span class="ff-import__meta">
                    +<span class="mono-num">{{ im.importedCount }}</span> · {{ im.importedByName }} · {{ importWhen(im.createdUtc) }}
                  </span>
                </div>
              }
            </div>
          }
        }
      </div>
    </app-bs-pull-refresh>

    <!-- ─── IMPORT FAB (the only "add" path — a Rocket Money CSV) ─── -->
    @if (!loading() && !errored() && hasData()) {
      <app-bs-fab icon="upload_file" label="Import" [extended]="true" [fixed]="true"
                  [disabled]="importing()" (action)="pickFile()" />
    }

    <!-- a hidden file input the FAB / empty-state CTA trigger (.csv / .ofx / .qfx) -->
    <input #fileInput type="file" accept=".csv,.ofx,.qfx,text/csv" hidden (change)="onPick($event)" aria-hidden="true" />

    <!-- ─────────────── COLUMN-MAP SHEET (a generic / ambiguous CSV) ─────────────── -->
    <app-bs-sheet [(open)]="mapOpen" detent="full" label="Map your columns" [dismissable]="false">
      <div class="cm">
        <h3 class="cm__title">Map your columns</h3>
        <p class="cm__sub">
          We couldn't recognize this file. Pick which column holds each value — at least a
          <strong>Date</strong> and an <strong>Amount</strong> (or a <strong>Debit + Credit</strong> pair).
        </p>
        <div class="cm__fields">
          @for (f of columnMapFields; track f.key) {
            <label class="cm__field">
              <span class="cm__lbl">{{ f.label }}</span>
              <select class="cm__select" [value]="$any(columnMap()[f.key]) ?? ''"
                      (change)="setColumnMap(f.key, $any($event.target).value)">
                <option value="">— none —</option>
                @for (c of detectedColumns(); track c) { <option [value]="c">{{ c }}</option> }
              </select>
            </label>
          }
        </div>
        <label class="cm__negate">
          <input type="checkbox" [checked]="columnMap().negate" (change)="setNegate($any($event.target).checked)" />
          <span>Flip the sign of the Amount column</span>
        </label>
        <div class="cm__actions">
          <button type="button" class="cm__btn cm__btn--ghost" (click)="cancelColumnMap()">Cancel</button>
          <button type="button" class="cm__btn cm__btn--primary" [disabled]="importing()" (click)="submitColumnMap()">
            {{ importing() ? 'Parsing…' : 'Preview' }}
          </button>
        </div>
      </div>
    </app-bs-sheet>

    <!-- ─────────────── REVIEW SHEET (stacked staged rows → commit / discard) ─────────────── -->
    <app-bs-sheet [(open)]="reviewOpen" detent="full" label="Review import" [dismissable]="false">
      @if (staged(); as s) {
        <div class="rv">
          <div class="rv__head">
            <h3 class="rv__title">Review import <span class="rv__badge">{{ formatLabel(s.format) }}</span></h3>
            <p class="rv__sub">Nothing's been added yet. Check categories, drop rows you don't want, then commit.</p>
            <div class="rv__counts">
              <span class="rv__stat"><strong class="mono-num">{{ committableCount() }}</strong> to import</span>
              @if (s.duplicateCount > 0) { <span class="rv__stat is-dup">{{ s.duplicateCount }} dup</span> }
              @if (s.skippedCount > 0) { <span class="rv__stat">{{ s.skippedCount }} skipped</span> }
            </div>
          </div>

          @if (uncategorizedCount() > 0) {
            <button type="button" class="rv__ai" [disabled]="aiCategorizing()" (click)="suggestCategoriesAi()">
              <mat-icon aria-hidden="true">auto_awesome</mat-icon>
              {{ aiCategorizing() ? 'Thinking…' : 'Suggest ' + uncategorizedCount() + ' categories with AI' }}
            </button>
          }

          <div class="rv__list">
            @for (r of s.rows; track r.id) {
              <div class="rv__row" [class.is-dup]="r.isDuplicate" [class.is-excluded]="isRowExcluded(r)">
                <label class="rv__keep">
                  <input type="checkbox" [checked]="!isRowExcluded(r)" [disabled]="r.isDuplicate"
                         (change)="toggleExclude(r)" [attr.aria-label]="'Keep ' + r.merchant" />
                </label>
                <div class="rv__main">
                  <div class="rv__top">
                    <span class="rv__merchant">{{ r.merchant }}</span>
                    <span class="rv__amt mono-num" [class.is-in]="r.kind === 'income'">{{ signedStaged(r) }}</span>
                  </div>
                  <div class="rv__meta">
                    {{ txnDate(r.date) }} · {{ r.accountName }}
                    @if (r.isDuplicate) { <span class="rv__dupflag">Duplicate</span> }
                  </div>
                  <div class="rv__controls">
                    <select class="rv__select" [value]="r.category ?? ''"
                            (change)="setRowCategory(r, $any($event.target).value)">
                      <option value="">Uncategorized</option>
                      @for (c of categoryOptions; track c) { <option [value]="c">{{ c }}</option> }
                    </select>
                    @if (r.category && r.categorySource !== 'none') {
                      <span class="rv__src" [attr.data-src]="r.categorySource">{{ r.categorySource }}</span>
                    } @else if (r.suggestedCategory) {
                      <button type="button" class="rv__suggest" (click)="acceptSuggestion(r)">
                        <mat-icon aria-hidden="true">auto_awesome</mat-icon> {{ r.suggestedCategory }}
                      </button>
                    }
                  </div>
                </div>
              </div>
            }
          </div>

          <div class="rv__footer">
            <button type="button" class="rv__btn rv__btn--ghost" [disabled]="committing()" (click)="discardStaged()">
              Discard
            </button>
            <button type="button" class="rv__btn rv__btn--primary"
                    [disabled]="committing() || committableCount() === 0" (click)="commitStaged()">
              {{ committing() ? 'Committing…' : 'Commit ' + committableCount() }}
            </button>
          </div>
        </div>
      }
    </app-bs-sheet>

    <!-- ─────────────── TRANSACTION DETAIL SHEET ─────────────── -->
    <app-bs-sheet [(open)]="txnOpen" detent="peek" [label]="selected()?.merchant || 'Transaction'">
      @if (selected(); as t) {
        <div class="td">
          <div class="td__head">
            <span class="td__glyph" [class]="'is-' + t.kind" aria-hidden="true">
              <mat-icon>{{ kindIcon(t.kind) }}</mat-icon>
            </span>
            <div class="td__titles">
              <h3 class="td__merchant">{{ t.merchant }}</h3>
              <span class="td__sub">{{ txnDate(t.date) }}</span>
            </div>
            <span class="td__amt mono-num" [class.is-in]="t.kind === 'income'">{{ signedMoney(t) }}</span>
          </div>
          <dl class="td__rows">
            <div class="td__row">
              <dt>Account</dt><dd>{{ t.accountName }}</dd>
            </div>
            <div class="td__row">
              <dt>Owner</dt>
              <dd>
                <span class="td__owner-dot" [style.background]="ownerColor(t.owner)" aria-hidden="true"></span>
                {{ ownerLabel(t.owner) }}
              </dd>
            </div>
            @if (t.category) {
              <div class="td__row"><dt>Category</dt><dd>{{ t.category }}</dd></div>
            }
            <div class="td__row">
              <dt>Type</dt><dd class="td__kind is-{{ t.kind }}">{{ kindLabel(t.kind) }}</dd>
            </div>
          </dl>
        </div>
      }
    </app-bs-sheet>

    <!-- ─────────────── BALANCE-ENTRY SHEET (manual net-worth entry) ─────────────── -->
    <app-bs-sheet [(open)]="balanceOpen" detent="peek" [label]="balanceAccount()?.name || 'Enter balance'">
      @if (balanceAccount(); as a) {
        <div class="be">
          <p class="be__sub">
            Enter {{ a.name }}'s current balance.
            @if (a.kind === 'credit') { Owe a balance? Use a negative number (a liability). }
            @else { An asset balance — a positive number. }
          </p>
          <input class="be__input mono-num" type="number" inputmode="decimal" step="0.01"
                 [value]="balanceValue()" (input)="balanceValue.set($any($event.target).value)"
                 placeholder="0.00" aria-label="Current balance" />
          <div class="be__actions">
            <button type="button" class="be__btn be__btn--ghost" (click)="balanceOpen.set(false)">Cancel</button>
            <button type="button" class="be__btn be__btn--primary" [disabled]="balanceSaving()" (click)="saveBalance()">
              {{ balanceSaving() ? 'Saving…' : 'Save balance' }}
            </button>
          </div>
        </div>
      }
    </app-bs-sheet>

    <app-bs-toaster />
  `,
  styleUrl: './family-finance-mobile.page.scss',
})
export class FamilyFinanceMobilePage {
  private api = inject(Api);
  private toast = inject(ToastController);
  private destroyRef = inject(DestroyRef);

  // ---- page state ----
  readonly loading = signal(true);
  readonly errored = signal(false);
  readonly refreshing = signal(false);

  /** The viewed month as `yyyy-MM`; defaults to the current month and prev/next steps it. */
  readonly month = signal<string>(this.currentMonth());

  readonly summary = signal<FinanceSummary | null>(null);
  readonly accounts = signal<FinanceAccount[]>([]);
  readonly imports = signal<FinanceImportBatch[]>([]);

  // ---- ✨ AI (read-only narration; best-effort, never blocks) ----
  readonly aiSummary = signal<FinanceSummaryAiResult | null>(null);
  private aiSummaryMonth = '';
  readonly coach = signal<FinanceMoneyCoachResult | null>(null);
  readonly coachLoading = signal(false);

  // ---- budgets / net worth / savings ----
  readonly budgets = signal<FinanceBudgetsResponse | null>(null);
  readonly budgetsLoading = signal(false);
  readonly netWorth = signal<FinanceNetWorthDto | null>(null);
  readonly netWorthLoading = signal(false);
  readonly savings = signal<FinanceSavingsResponse | null>(null);
  readonly savingsLoading = signal(false);

  // balance-entry bottom sheet
  readonly balanceOpen = signal(false);
  readonly balanceAccount = signal<FinanceAccountBalanceDto | null>(null);
  readonly balanceValue = signal('');
  readonly balanceSaving = signal(false);

  // ---- transactions (recent strip for the viewed month) ----
  readonly txns = signal<FinanceTransaction[]>([]);
  readonly txnTotal = signal(0);
  readonly txnLoading = signal(false);

  // ---- detail sheet ----
  readonly txnOpen = signal(false);
  readonly selected = signal<FinanceTransaction | null>(null);

  // ---- import (parse → [column-map] → review → commit/discard STAGING flow) ----
  readonly importing = signal(false);
  private readonly fileInput = viewChild<ElementRef<HTMLInputElement>>('fileInput');

  /** The raw file held while we walk the column-map step. */
  private pendingFile: { name: string; content: string } | null = null;

  // column-map sheet
  readonly mapOpen = signal(false);
  readonly detectedColumns = signal<string[]>([]);
  readonly columnMap = signal<FinanceColumnMap>(this.emptyColumnMap());

  // review sheet
  readonly reviewOpen = signal(false);
  readonly staged = signal<FinanceStagedImport | null>(null);
  readonly excludedIds = signal<Set<number>>(new Set());
  readonly committing = signal(false);
  readonly aiCategorizing = signal(false);

  readonly categoryOptions = FINANCE_DEFAULT_CATEGORIES;
  readonly txnKindEditOptions: FinanceTxnKind[] = ['expense', 'income', 'transfer'];
  readonly columnMapFields: { key: ColumnMapField; label: string }[] = [
    { key: 'date', label: 'Date' },
    { key: 'amount', label: 'Amount (signed)' },
    { key: 'debit', label: 'Debit' },
    { key: 'credit', label: 'Credit' },
    { key: 'description', label: 'Merchant / description' },
    { key: 'category', label: 'Category' },
    { key: 'account', label: 'Account key' },
    { key: 'accountName', label: 'Account name' },
    { key: 'institution', label: 'Institution' },
  ];

  /** Count of kept (non-duplicate, non-excluded) rows in the staged batch. */
  readonly committableCount = computed(() => {
    const s = this.staged();
    if (!s) return 0;
    const excl = this.excludedIds();
    return s.rows.filter((r) => !r.isDuplicate && !this.isRowExcluded(r, excl)).length;
  });

  /** Count of still-Uncategorized, non-excluded staged rows (drives the AI-suggest affordance). */
  readonly uncategorizedCount = computed(() => {
    const s = this.staged();
    if (!s) return 0;
    const excl = this.excludedIds();
    return s.rows.filter((r) => !r.category && !this.isRowExcluded(r, excl)).length;
  });

  /** Which detail list the segmented control shows. */
  readonly tab = signal<DetailTab>('spending');

  readonly skeletonCells = Array.from({ length: 4 }, (_, i) => i);

  readonly tabSegments = computed<Segment[]>(() => [
    { key: 'spending', label: 'Spending' },
    { key: 'budgets', label: `Budgets${this.budgets()?.budgets?.length ? ' · ' + this.budgets()!.budgets!.length : ''}` },
    { key: 'networth', label: 'Net worth' },
    { key: 'goals', label: `Goals${this.savings()?.goals?.length ? ' · ' + this.savings()!.goals!.length : ''}` },
    { key: 'recurring', label: `Recurring${this.coach()?.recurring?.length ? ' · ' + this.coach()!.recurring!.length : ''}` },
  ]);

  /** A friendly "June 2026" label for the month stepper. */
  readonly monthLabel = computed(() => {
    const [y, m] = this.month().split('-').map(Number);
    if (!y || !m) return this.month();
    return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  });

  /** Net = income − spent for the headline card. */
  readonly net = computed(() => {
    const s = this.summary();
    return s ? s.totalIncome - s.totalSpent : 0;
  });

  /** By-category spending slices (sorted as the server returned them). */
  readonly categories = computed(() => this.summary()?.byCategory ?? []);

  /** The His/Hers/Joint owner split rows with a positive amount, in a stable order. */
  readonly ownerRows = computed(() => {
    const owners = this.summary()?.byOwner ?? [];
    const order: FinanceOwner[] = ['his', 'hers', 'joint', 'unassigned'];
    return order
      .map((o) => owners.find((x) => x.owner === o))
      .filter((x): x is NonNullable<typeof x> => !!x && x.amount > 0);
  });

  /** The largest category amount, for scaling the spending bars. */
  private readonly maxCategory = computed(() =>
    Math.max(1, ...this.categories().map((c) => c.amount)));

  /** The largest owner amount, for scaling the owner split bars. */
  private readonly maxOwner = computed(() =>
    Math.max(1, ...this.ownerRows().map((o) => o.amount)));

  /** Whether anything's been imported yet (drives the empty/first-run state). */
  readonly hasData = computed(
    () =>
      this.accounts().length > 0 ||
      this.categories().length > 0 ||
      this.imports().length > 0,
  );

  constructor() {
    void this.reload(true);
  }

  // ─────────────── LOAD ───────────────

  async reload(initial = false): Promise<void> {
    if (initial) this.loading.set(true); else this.refreshing.set(true);
    this.errored.set(false);
    try {
      const [summary, accounts, imports] = await Promise.all([
        firstValueFrom(this.api.financeSummary(this.month())),
        firstValueFrom(this.api.financeAccounts().pipe(catchError(() => of<FinanceAccount[]>([])))),
        firstValueFrom(this.api.financeImports().pipe(catchError(() => of<FinanceImportBatch[]>([])))),
      ]);
      this.summary.set(summary ?? null);
      this.accounts.set(accounts ?? []);
      this.imports.set(imports ?? []);
      // The server resolves the month (it may fall back to the latest with data) — follow it.
      if (summary?.month && summary.month !== this.month()) this.month.set(summary.month);
      this.loadTxns();
      this.loadAiSummary();
      this.loadCoach(!initial);
      this.loadBudgets();
      this.loadNetWorth();
      this.loadSavings();
    } catch {
      this.errored.set(true);
    } finally {
      this.loading.set(false);
      if (!initial) {
        this.refreshing.set(false);
        this.toast.show('Finances refreshed', { tone: 'success', durationMs: 1600 });
      }
    }
  }

  /** Page-1 of the viewed month's transactions (newest-first); best-effort. */
  private loadTxns(): void {
    this.txnLoading.set(true);
    this.api
      .financeTransactions({ month: this.month(), page: 1 })
      .pipe(
        catchError(() => of<FinanceTransactionsPage | null>(null)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((p) => {
        if (p) {
          this.txns.set(p.items);
          this.txnTotal.set(p.total);
        }
        this.txnLoading.set(false);
      });
  }

  /** The read-only "✨ Explain this month" narration; degrades silently to hidden on any blip. */
  private loadAiSummary(force = false): void {
    const month = this.month();
    if (!force && month === this.aiSummaryMonth && this.aiSummary()) return;
    this.aiSummaryMonth = month;
    this.api
      .financeSummaryAi(month)
      .pipe(
        catchError(() => of<FinanceSummaryAiResult | null>(null)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((s) => {
        if (this.month() === month) this.aiSummary.set(s);
      });
  }

  /** The deterministic recurring-charges floor (+ optional warm narration); month-independent. */
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

  /** The household's per-category budgets for the viewed month; best-effort. */
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

  /** The household's manual net worth (latest signed balance per account + a trend); best-effort. */
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

  /** The household's savings goals (saved/target/pct + projected finish); best-effort, month-independent. */
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

  // ─────────────── MONTH STEPPER ───────────────

  stepMonth(delta: number): void {
    const [y, m] = this.month().split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    this.month.set(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    this.refreshMonth();
  }

  /** Re-pull the month-scoped data (summary + txns + AI) after a month change. */
  private refreshMonth(): void {
    this.api
      .financeSummary(this.month())
      .pipe(
        catchError(() => of<FinanceSummary | null>(null)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((s) => {
        if (s) {
          this.summary.set(s);
          if (s.month && s.month !== this.month()) this.month.set(s.month);
        }
      });
    this.loadTxns();
    this.loadAiSummary();
    this.loadBudgets();
  }

  setTab(key: string): void {
    const valid: DetailTab[] = ['spending', 'recurring', 'budgets', 'networth', 'goals'];
    this.tab.set(valid.includes(key as DetailTab) ? (key as DetailTab) : 'spending');
  }

  // ─────────────── BUDGETS / NET WORTH / SAVINGS helpers ───────────────

  budgetStatusLabel(s: FinanceBudgetStatus): string { return BUDGET_STATUS_LABEL[s] ?? s; }
  budgetLabel(b: FinanceBudgetDto): string { return b.category ?? 'Overall'; }
  budgetFillPct(b: FinanceBudgetDto): number { return Math.max(2, Math.min(100, Math.round(b.pct))); }

  /** A ring fill (0..100) for a goal card. */
  goalPct(g: FinanceSavingsGoalDto): number { return Math.max(0, Math.min(100, Math.round(g.pct))); }

  /** The conic-gradient ring background for a goal card, tinted by owner. */
  goalRing(g: FinanceSavingsGoalDto): string {
    return `conic-gradient(${this.ownerColor(g.owner)} ${this.goalPct(g)}%, rgba(255,255,255,0.08) 0)`;
  }

  // ─────────────── BALANCE-ENTRY SHEET (manual net-worth entry) ───────────────

  openBalance(a: FinanceAccountBalanceDto): void {
    this.balanceAccount.set(a);
    this.balanceValue.set(a.hasBalance ? String(a.latestBalance) : '');
    this.balanceOpen.set(true);
  }

  /** Save today's signed balance for the open account (positive asset / negative liability). */
  async saveBalance(): Promise<void> {
    const a = this.balanceAccount();
    if (!a || this.balanceSaving()) return;
    const balance = Number(this.balanceValue());
    if (!Number.isFinite(balance)) {
      this.toast.show('Enter a number — negative for a credit card or loan.', { tone: 'warn' });
      return;
    }
    this.balanceSaving.set(true);
    try {
      await firstValueFrom(this.api.setFinanceBalance(a.accountId, { balance }));
      this.balanceOpen.set(false);
      this.loadNetWorth();
      this.toast.show('Balance saved', { tone: 'success', durationMs: 1600 });
    } catch {
      this.toast.show("Couldn't save that balance", { tone: 'warn' });
    } finally {
      this.balanceSaving.set(false);
    }
  }

  // ─────────────── DETAIL SHEET ───────────────

  openTxn(t: FinanceTransaction): void {
    this.selected.set(t);
    this.txnOpen.set(true);
  }

  // ─────────────── IMPORT (reuse the live CSV path verbatim) ───────────────

  /** Open the native file picker (FAB + first-run CTA). */
  pickFile(): void {
    if (this.importing()) return;
    this.fileInput()?.nativeElement.click();
  }

  onPick(e: Event): void {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) void this.readAndStage(file);
    input.value = ''; // allow re-picking the same file
  }

  /**
   * Read the chosen file as text and parse it into a STAGED batch (the live ledger is NOT touched). An
   * OFX/QFX or recognized Rocket-Money CSV opens the review sheet; a generic CSV opens the column-map sheet.
   */
  private async readAndStage(file: File): Promise<void> {
    if (this.importing()) return;
    if (!/\.(csv|ofx|qfx)$/i.test(file.name)) {
      this.toast.show('Choose a .csv, .ofx, or .qfx file.', { tone: 'warn' });
      return;
    }
    this.importing.set(true);
    try {
      const content = await file.text();
      this.pendingFile = { name: file.name, content };
      await this.parseStage('auto', null);
    } catch {
      this.toast.show("Couldn't read that file — try again", { tone: 'warn' });
      this.resetImport();
    } finally {
      this.importing.set(false);
    }
  }

  /** Parse the pending file with the given format + optional map; open review, or the column-map sheet on a 400. */
  private async parseStage(format: 'auto' | FinanceImportFormat, map: FinanceColumnMap | null): Promise<void> {
    const file = this.pendingFile;
    if (!file) return;
    try {
      const res = await firstValueFrom(
        this.api.financeParse({ fileName: file.name, content: file.content, format, columnMap: map }),
      );
      this.openReview(res);
    } catch (e) {
      const detected = this.detectedFromError(e);
      if (detected) {
        this.detectedColumns.set(detected);
        this.columnMap.set(this.guessColumnMap(detected));
        this.mapOpen.set(true);
        return;
      }
      this.toast.show("Couldn't parse that file — try again", { tone: 'warn' });
      this.resetImport();
    }
  }

  /** Submit the column-map sheet → re-parse as a generic CSV → open review. */
  async submitColumnMap(): Promise<void> {
    const map = this.columnMap();
    if (!map.date || (!map.amount && !map.debit && !map.credit)) {
      this.toast.show('Map a Date and an Amount (or Debit + Credit).', { tone: 'warn' });
      return;
    }
    this.importing.set(true);
    try {
      this.mapOpen.set(false);
      await this.parseStage('csv', map);
    } finally {
      this.importing.set(false);
    }
  }

  private openReview(res: FinanceStagedImport): void {
    this.staged.set(res);
    this.excludedIds.set(new Set(res.rows.filter((r) => r.excluded).map((r) => r.id)));
    this.reviewOpen.set(true);
  }

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

  /** Edit a staged row's category inline (persisting an "apply to future" household rule). */
  async setRowCategory(row: FinanceStagedRow, category: string): Promise<void> {
    const s = this.staged();
    if (!s) return;
    try {
      const updated = await firstValueFrom(
        this.api.financePatchStagedRow(s.importId, row.id, { category: category || null, applyToFuture: true }),
      );
      this.replaceStagedRow(updated);
    } catch {
      this.toast.show("Couldn't update that row", { tone: 'warn' });
    }
  }

  acceptSuggestion(row: FinanceStagedRow): void {
    if (row.suggestedCategory) void this.setRowCategory(row, row.suggestedCategory);
  }

  private replaceStagedRow(updated: FinanceStagedRow): void {
    this.staged.update((s) =>
      s ? { ...s, rows: s.rows.map((r) => (r.id === updated.id ? updated : r)) } : s,
    );
  }

  /** Optional "✨ Suggest categories" for the still-Uncategorized rows; never blocks commit. */
  async suggestCategoriesAi(): Promise<void> {
    const s = this.staged();
    if (!s || this.aiCategorizing()) return;
    this.aiCategorizing.set(true);
    try {
      const res = await firstValueFrom(this.api.financeCategorizeAi(s.importId));
      if (res.fellBackToPlain) {
        this.toast.show('AI categorization is unavailable — rows unchanged.', { tone: 'warn' });
      } else {
        await this.refreshStagedPreview();
        this.toast.show(
          res.classified === 0 ? 'Everything was already categorized.'
            : `Suggested categories for ${res.classified} rows.`,
          { tone: 'success', durationMs: 2400 },
        );
      }
    } catch {
      this.toast.show("Couldn't suggest categories", { tone: 'warn' });
    } finally {
      this.aiCategorizing.set(false);
    }
  }

  private async refreshStagedPreview(): Promise<void> {
    const s = this.staged();
    if (!s) return;
    try {
      const page = await firstValueFrom(this.api.financeStaged(s.importId, 1));
      this.staged.update((cur) => (cur ? { ...cur, rows: page.items } : cur));
    } catch { /* best-effort */ }
  }

  /** Commit the staged batch into the ledger, then refresh. */
  async commitStaged(): Promise<void> {
    const s = this.staged();
    if (!s || this.committing()) return;
    this.committing.set(true);
    try {
      const res = await firstValueFrom(this.api.financeCommit(s.importId, { excludeIds: [...this.excludedIds()] }));
      const dup = res.skipped === 1 ? 'duplicate' : 'duplicates';
      this.toast.show(`Imported ${res.imported}, skipped ${res.skipped} ${dup}`,
        { tone: 'success', durationMs: 2600 });
      this.reviewOpen.set(false);
      this.resetImport();
      await this.reload();
    } catch {
      this.toast.show("Couldn't commit — try again", { tone: 'warn' });
    } finally {
      this.committing.set(false);
    }
  }

  /** Discard the staged batch (deletes it server-side) and close the review. The ledger is untouched. */
  async discardStaged(): Promise<void> {
    const s = this.staged();
    if (s) {
      try { await firstValueFrom(this.api.financeDiscard(s.importId)); } catch { /* harmless */ }
    }
    this.reviewOpen.set(false);
    this.resetImport();
  }

  cancelColumnMap(): void {
    this.mapOpen.set(false);
    this.resetImport();
  }

  private resetImport(): void {
    this.staged.set(null);
    this.excludedIds.set(new Set());
    this.detectedColumns.set([]);
    this.columnMap.set(this.emptyColumnMap());
    this.pendingFile = null;
  }

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
      date: find('date', 'posted'),
      amount: debit && credit ? null : find('amount', 'value'),
      debit, credit, negate: false,
      description: find('description', 'merchant', 'name', 'memo', 'payee'),
      category: find('category'),
      account: find('account'),
      accountName: find('account name', 'account'),
      institution: find('institution', 'bank'),
    };
  }

  private detectedFromError(e: unknown): string[] | null {
    const body = (e as { error?: { detectedColumns?: unknown; message?: string } })?.error;
    const cols = body?.detectedColumns;
    if (Array.isArray(cols) && cols.length) return cols.map(String);
    if (typeof body?.message === 'string' && /map the columns/i.test(body.message)) {
      const headers = this.parseHeaderLine();
      if (headers?.length) return headers;
    }
    return null;
  }

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
        if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQuotes = false; }
        else cur += ch;
      } else if (ch === '"') inQuotes = true;
      else if (ch === ',') { out.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    out.push(cur.trim());
    return out.filter((h) => h.length > 0);
  }

  formatLabel(f: FinanceImportFormat): string {
    return f === 'rocketmoney' ? 'Rocket Money' : f === 'ofx' ? 'OFX / QFX' : 'Bank CSV';
  }

  /** A signed currency string for a staged row (income +, expense −, transfer unsigned). */
  signedStaged(row: FinanceStagedRow): string {
    const sign = row.kind === 'income' ? '+' : row.kind === 'expense' ? '−' : '';
    return `${sign}${this.money(row.magnitude)}`;
  }

  // ─────────────── formatting + helpers ───────────────

  ownerLabel(o: FinanceOwner): string { return OWNER_LABEL[o] ?? o; }
  /** Owner accent for UI chrome (CSS strings). Joint reads the shared success token; the rest are literals. */
  ownerColor(o: FinanceOwner): string {
    return o === 'joint' ? 'var(--tech-success, #3dd68c)' : OWNER_COLOR[o] ?? OWNER_COLOR.unassigned;
  }

  kindLabel(k: FinanceTxnKind): string {
    return k === 'expense' ? 'Expense' : k === 'income' ? 'Income' : 'Transfer';
  }
  kindIcon(k: FinanceTxnKind): string {
    return k === 'income' ? 'south_west' : k === 'transfer' ? 'swap_horiz' : 'north_east';
  }

  /** % width of a category bar relative to the month's biggest category. */
  barPct(amount: number): number {
    return Math.max(3, Math.round((amount / this.maxCategory()) * 100));
  }
  /** % width of an owner-split bar relative to the biggest owner slice. */
  ownerPct(amount: number): number {
    return Math.max(4, Math.round((amount / this.maxOwner()) * 100));
  }

  /** A signed currency string for a transaction (income +, expense −). */
  signedMoney(t: FinanceTransaction): string {
    const sign = t.kind === 'income' ? '' : '−';
    return `${sign}${this.money(t.magnitude)}`;
  }

  /** A currency string, e.g. "$1,234.56". */
  money(n: number): string {
    return n.toLocaleString(undefined, { style: 'currency', currency: 'USD' });
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
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  txnAria(t: FinanceTransaction): string {
    return `${t.merchant}, ${this.signedMoney(t)}, ${this.txnDate(t.date)}${t.category ? ', ' + t.category : ''}. Open details.`;
  }

  private currentMonth(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
}
