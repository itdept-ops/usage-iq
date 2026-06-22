import { CommonModule } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';

import { Api } from '../../core/api';
import { AiUsageCount, AiUsageRow, AiUsageSummary } from '../../core/models';

/** A {value,label} option for the user/feature filter selects, derived from the data itself. */
interface FilterOption { value: string; label: string; }

const PAGE_SIZE = 100;

@Component({
  selector: 'app-ai-usage',
  imports: [
    CommonModule, FormsModule, MatCardModule, MatFormFieldModule, MatInputModule, MatSelectModule,
    MatButtonModule, MatIconModule, MatProgressBarModule, MatTooltipModule, MatSnackBarModule,
  ],
  templateUrl: './ai-usage.html',
  styleUrl: './ai-usage.scss',
})
export class AiUsage {
  private api = inject(Api);
  private snack = inject(MatSnackBar);

  readonly rows = signal<AiUsageRow[]>([]);
  readonly summary = signal<AiUsageSummary | null>(null);
  readonly loading = signal(true);
  /** Whether the last load failed (so the table shows an error block, not the empty copy). */
  readonly error = signal(false);
  /** Whether the last page came back full (so an older page may exist). */
  readonly hasMore = signal(false);
  /** The current page index (0-based) for the "page N" label and keyset cursor stack. */
  readonly page = signal(0);

  // ---- Filters ----
  readonly user = signal('');        // AppUser id as string ('' = all)
  readonly feature = signal('');     // feature label ('' = all)
  readonly outcome = signal('');     // outcome ('' = all)
  readonly from = signal('');        // yyyy-MM-dd ('' = none)
  readonly to = signal('');          // yyyy-MM-dd ('' = none)

  /** Keyset cursor stack: the `before` id used to fetch each page (index 0 = newest, no cursor). */
  private cursors: (number | null)[] = [null];

  /** Outcomes the table/filter understands, in display order. */
  readonly outcomes = [
    { v: '', l: 'All outcomes' },
    { v: 'ok', l: 'OK' },
    { v: 'unavailable', l: 'Unavailable' },
    { v: 'rate-limited', l: 'Rate-limited' },
    { v: 'parse-failed', l: 'Parse-failed' },
    { v: 'error', l: 'Error' },
  ];

  /** Top users from the summary, as filter options (userId -> name). Background ticks have no id. */
  readonly userOptions = computed<FilterOption[]>(() =>
    (this.summary()?.topUsers ?? [])
      .filter(u => u.userId != null)
      .map(u => ({ value: String(u.userId), label: u.key })));

  /** Top features from the summary, as filter options. */
  readonly featureOptions = computed<FilterOption[]>(() =>
    (this.summary()?.topFeatures ?? []).map(f => ({ value: f.key, label: f.key })));

  readonly failures = computed(() => {
    const by = this.summary()?.byOutcome ?? {};
    let n = 0;
    for (const [k, v] of Object.entries(by)) if (k !== 'ok') n += v;
    return n;
  });

  readonly topUser = computed<AiUsageCount | null>(() => this.summary()?.topUsers[0] ?? null);
  readonly topFeature = computed<AiUsageCount | null>(() => this.summary()?.topFeatures[0] ?? null);

  constructor() { this.reload(); }

  /** Reset to the first page and load (used on any filter change or Refresh). */
  reload(): void {
    this.cursors = [null];
    this.page.set(0);
    this.load();
  }

  private load(): void {
    this.loading.set(true);
    this.error.set(false);
    const before = this.cursors[this.page()];
    this.api.getAiUsage({
      before,
      limit: PAGE_SIZE,
      user: this.user() ? Number(this.user()) : null,
      feature: this.feature(),
      outcome: this.outcome(),
      from: this.from() ? new Date(this.from() + 'T00:00:00').toISOString() : undefined,
      to: this.to() ? new Date(this.to() + 'T23:59:59').toISOString() : undefined,
    }).subscribe({
      next: r => {
        this.rows.set(r.rows);
        this.summary.set(r.summary);
        this.hasMore.set(r.rows.length === PAGE_SIZE);
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
        this.error.set(true);
        this.snack.open('Failed to load AI usage', 'Dismiss', { duration: 4000 });
      },
    });
  }

  nextPage(): void {
    if (!this.hasMore() || !this.rows().length) return;
    const lastId = this.rows()[this.rows().length - 1].id;
    const next = this.page() + 1;
    this.cursors[next] = lastId;            // keyset cursor for the older page
    this.page.set(next);
    this.load();
  }

  prevPage(): void {
    if (this.page() === 0) return;
    this.page.set(this.page() - 1);
    this.load();
  }

  clearFilters(): void {
    this.user.set(''); this.feature.set(''); this.outcome.set('');
    this.from.set(''); this.to.set('');
    this.reload();
  }

  readonly hasFilters = computed(() =>
    !!(this.user() || this.feature() || this.outcome() || this.from() || this.to()));

  /** Color band for an outcome: ok=success, unavailable/rate-limited=warning, else danger. */
  outcomeClass(outcome: string): string {
    if (outcome === 'ok') return 'oc-ok';
    if (outcome === 'unavailable' || outcome === 'rate-limited') return 'oc-warn';
    return 'oc-danger';
  }

  outcomeLabel(outcome: string): string {
    return this.outcomes.find(o => o.v === outcome)?.l ?? outcome;
  }

  fmtNum(n: number | null | undefined): string {
    if (n == null) return '—';
    return n.toLocaleString();
  }
}
