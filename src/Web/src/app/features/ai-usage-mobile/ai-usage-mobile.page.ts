import {
  ChangeDetectionStrategy, Component, computed, inject, signal,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { firstValueFrom } from 'rxjs';
import { MatIconModule } from '@angular/material/icon';

import { Api } from '../../core/api';
import { AiUsageRow, AiUsageSummary } from '../../core/models';
import {
  BetaPullRefresh, BetaSegmentedControl, BetaBottomSheet, BetaStatTile, BetaSkeleton,
  BetaSectionHeader, BetaToaster, ToastController, type Segment,
} from '../beta-ui';

const PAGE_SIZE = 100;

/**
 * AI Usage log — the MOBILE twin of the live /ai-usage page, rebuilt on the shared beta-ui "Strata" kit
 * (`@use '../beta-ui/beta-kit'`). One signature accent — a TEAL → CYAN "telemetry" ramp — re-skins the
 * whole screen via the per-page accent contract. An immersive header with the window's headline cost +
 * call/token stat tiles, a {@link BetaSegmentedControl} that scopes the feed by OUTCOME (a client-side
 * narrowing that ALSO drives the server filter on reload so paging stays consistent), a scrollable list
 * of per-call rows (feature · model · tokens · est. cost, each with an outcome status band), a "load
 * older" keyset pager, and a {@link BetaBottomSheet} per-call detail. Pull-to-refresh, skeleton loaders,
 * and elevated empty/error states round it out.
 *
 * DATA PARITY + PRIVACY: every row + the window summary come straight from the SAME admin-scoped
 * {@link Api.getAiUsage} (GET /api/ai-usage) the live page uses — same keyset `before` cursor, same
 * PAGE_SIZE, same outcome filter. The DTOs ({@link AiUsageRow}/{@link AiUsageSummary}) are consumed
 * VERBATIM; the cost/number formatters mirror the live page exactly (null cost → "—", never a fake $0).
 * The payload exposes a user's DISPLAY NAME only (never an email) and a nullable AppUser id — this twin
 * surfaces only that. No write path exists; this is a read-only log.
 *
 * ISOLATION: gated by `platform.mobile` on the SAME /ai-usage route (carrying the live page's
 * ai.usage.view permission); it consumes the kit + the SAME Api/models as the live counterpart. No live
 * page is imported or modified.
 */
@Component({
  selector: 'app-ai-usage-mobile',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [ToastController],
  imports: [
    DecimalPipe, MatIconModule,
    BetaPullRefresh, BetaSegmentedControl, BetaBottomSheet, BetaStatTile, BetaSkeleton,
    BetaSectionHeader, BetaToaster,
  ],
  template: `
    <!-- ─────────────── PULL-TO-REFRESH OWNS THE SCROLL ─────────────── -->
    <app-bs-pull-refresh class="au-ptr" [busy]="refreshing()" (refresh)="reload()">
      <div class="au-scroll" aria-live="polite">

        <!-- ─── IMMERSIVE HEADER: title + headline cost ─── -->
        <header class="au-hero">
          <p class="au-hero__kicker"><mat-icon aria-hidden="true">insights</mat-icon> AI telemetry</p>
          <h1 class="au-hero__title">AI Usage</h1>
          <p class="au-hero__sub">Every model call — feature, outcome, tokens and estimated cost.</p>
        </header>

        @if (loading()) {
          <!-- skeleton header tiles + list -->
          <div class="au-tiles" aria-hidden="true">
            <app-bs-skeleton height="84px" radius="var(--r-tile)" />
            <app-bs-skeleton height="84px" radius="var(--r-tile)" />
            <app-bs-skeleton height="84px" radius="var(--r-tile)" />
            <app-bs-skeleton height="84px" radius="var(--r-tile)" />
          </div>
          <div class="au-seg-wrap" aria-hidden="true">
            <app-bs-skeleton width="100%" height="44px" radius="var(--r-pill)" />
          </div>
          <div class="au-list" aria-hidden="true">
            @for (n of skeletonCells; track n) {
              <app-bs-skeleton height="78px" radius="var(--r-tile)" />
            }
          </div>

        } @else if (errored()) {
          <div class="au-state">
            <span class="au-state__orb"><mat-icon aria-hidden="true">cloud_off</mat-icon></span>
            <h2 class="au-state__title">Couldn't load AI usage</h2>
            <p class="au-state__body">Something went wrong fetching the telemetry. Give it another go.</p>
            <button type="button" class="au-state__cta" (click)="reload()">
              <mat-icon aria-hidden="true">refresh</mat-icon> Try again
            </button>
          </div>

        } @else {
          <!-- ─── SUMMARY TILES (window totals) ─── -->
          @if (summary(); as s) {
            <div class="au-tiles">
              <app-bs-stat-tile [value]="costLabel()" label="Est. cost" />
              <app-bs-stat-tile [value]="(s.totalCalls | number) ?? '0'" label="Calls" />
              <app-bs-stat-tile [value]="tokensLabel()" label="Total tokens" />
              <app-bs-stat-tile [value]="(failures() | number) ?? '0'" label="Failures"
                                [accentA]="failures() ? '#f87171' : 'var(--accent-a)'"
                                [accentB]="failures() ? '#fb7185' : 'var(--accent-b)'" />
            </div>

            <!-- top user + feature glance -->
            @if (topUser() || topFeature()) {
              <div class="au-tops">
                @if (topUser(); as u) {
                  <div class="au-top">
                    <mat-icon class="au-top__ic" aria-hidden="true">person</mat-icon>
                    <span class="au-top__body">
                      <span class="au-top__l">Top user</span>
                      <span class="au-top__v">{{ u.key }}</span>
                    </span>
                    <span class="au-top__n mono-num">{{ u.count | number }}</span>
                  </div>
                }
                @if (topFeature(); as f) {
                  <div class="au-top">
                    <mat-icon class="au-top__ic" aria-hidden="true">bolt</mat-icon>
                    <span class="au-top__body">
                      <span class="au-top__l">Top feature</span>
                      <span class="au-top__v">{{ f.key }}</span>
                    </span>
                    <span class="au-top__n mono-num">{{ f.count | number }}</span>
                  </div>
                }
              </div>
            }

            @if (s.hasUnpricedModels) {
              <p class="au-note" aria-hidden="true">
                <mat-icon aria-hidden="true">info</mat-icon>
                Some calls use a model with no price — their cost shows as “—”.
              </p>
            }
          }

          <!-- ─── OUTCOME FILTER ─── -->
          <div class="au-seg-wrap">
            <app-bs-segmented class="au-seg"
              [segments]="outcomeSegments" [value]="outcome()" label="Filter by outcome"
              (change)="setOutcome($event)" />
          </div>

          <app-bs-section-header class="au-sechead"
            title="Calls" [subtitle]="listSub()" icon="receipt_long" />

          @if (rows().length) {
            <div class="au-list">
              @for (r of rows(); track r.id; let i = $index) {
                <button type="button" class="au-row au-reveal" [style.--ri]="i"
                        [class]="'oc-' + outcomeTone(r.outcome)"
                        (click)="openDetail(r)" [attr.aria-label]="rowAria(r)">
                  <span class="au-row__band" aria-hidden="true"></span>
                  <span class="au-row__body">
                    <span class="au-row__top">
                      <span class="au-row__feature">{{ r.feature }}</span>
                      <span class="au-row__cost mono-num">{{ fmtCost(r.estimatedCostUsd) }}</span>
                    </span>
                    <span class="au-row__meta">
                      <span class="au-row__pill" [class]="'ocp-' + outcomeTone(r.outcome)">
                        {{ outcomeLabel(r.outcome) }}
                      </span>
                      <span class="au-row__model">{{ r.model }}</span>
                      @if (r.totalTokens != null) {
                        <span class="au-row__tok mono-num">{{ r.totalTokens | number }} tok</span>
                      }
                    </span>
                    <span class="au-row__sub">
                      @if (r.userName) {
                        <mat-icon class="au-row__sub-ic" aria-hidden="true">person</mat-icon>{{ r.userName }} ·
                      } @else {
                        <mat-icon class="au-row__sub-ic" aria-hidden="true">smart_toy</mat-icon>Background ·
                      }
                      {{ fmtTime(r.whenUtc) }}
                    </span>
                  </span>
                  <mat-icon class="au-row__go" aria-hidden="true">chevron_right</mat-icon>
                </button>
              }
            </div>

            <!-- ─── KEYSET PAGER ─── -->
            <div class="au-pager">
              <button type="button" class="au-pager__btn" [disabled]="page() === 0 || paging()"
                      (click)="prevPage()">
                <mat-icon aria-hidden="true">chevron_left</mat-icon> Newer
              </button>
              <span class="au-pager__label">Page {{ page() + 1 }}</span>
              <button type="button" class="au-pager__btn" [disabled]="!hasMore() || paging()"
                      (click)="nextPage()">
                Older <mat-icon aria-hidden="true">chevron_right</mat-icon>
              </button>
            </div>

          } @else {
            <!-- EMPTY -->
            <div class="au-empty">
              <span class="au-empty__orb"><mat-icon aria-hidden="true">manage_search</mat-icon></span>
              @if (outcome()) {
                <h2 class="au-empty__title">No {{ outcomeLabel(outcome()) }} calls</h2>
                <p class="au-empty__body">Nothing matches this outcome in the current window.</p>
                <button type="button" class="au-empty__cta" (click)="setOutcome('')">
                  <mat-icon aria-hidden="true">clear_all</mat-icon> Show all outcomes
                </button>
              } @else {
                <h2 class="au-empty__title">No AI calls yet</h2>
                <p class="au-empty__body">When the app makes a model call, it’ll be logged here.</p>
              }
            </div>
          }
        }
      </div>
    </app-bs-pull-refresh>

    <!-- ─────────────── DETAIL BOTTOM SHEET ─────────────── -->
    <app-bs-sheet [(open)]="detailOpen" detent="half" [label]="selected()?.feature || 'Call detail'">
      @if (selected(); as r) {
        <div class="ad">
          <div class="ad__head">
            <span class="ad__glyph" [class]="'oc-' + outcomeTone(r.outcome)" aria-hidden="true">
              <mat-icon>{{ outcomeIcon(r.outcome) }}</mat-icon>
            </span>
            <div class="ad__titles">
              <h3 class="ad__title">{{ r.feature }}</h3>
              <span class="ad__sub">
                <span class="au-row__pill" [class]="'ocp-' + outcomeTone(r.outcome)">{{ outcomeLabel(r.outcome) }}</span>
                · {{ fmtTime(r.whenUtc) }}
              </span>
            </div>
          </div>

          <!-- token + cost breakdown -->
          <div class="ad__macros">
            <div class="ad__macro"><span class="ad__macro-n mono-num">{{ fmtNum(r.promptTokens) }}</span><span class="ad__macro-l">prompt</span></div>
            <div class="ad__macro"><span class="ad__macro-n mono-num">{{ fmtNum(r.outputTokens) }}</span><span class="ad__macro-l">output</span></div>
            <div class="ad__macro"><span class="ad__macro-n mono-num">{{ fmtNum(r.totalTokens) }}</span><span class="ad__macro-l">total tok</span></div>
            <div class="ad__macro"><span class="ad__macro-n mono-num">{{ fmtCost(r.estimatedCostUsd) }}</span><span class="ad__macro-l">est. cost</span></div>
          </div>

          <dl class="ad__rows">
            <div class="ad__kv"><dt>User</dt><dd>{{ r.userName || 'Background tick' }}</dd></div>
            <div class="ad__kv"><dt>Model</dt><dd class="mono-num">{{ r.model }}</dd></div>
            <div class="ad__kv"><dt>Duration</dt><dd class="mono-num">{{ fmtMs(r.durationMs) }}</dd></div>
            <div class="ad__kv"><dt>HTTP status</dt><dd class="mono-num">{{ r.httpStatus ?? '—' }}</dd></div>
            <div class="ad__kv"><dt>When (UTC)</dt><dd class="mono-num">{{ r.whenUtc }}</dd></div>
            <div class="ad__kv"><dt>Call ID</dt><dd class="mono-num">#{{ r.id }}</dd></div>
          </dl>
        </div>
      }
    </app-bs-sheet>

    <app-bs-toaster />
  `,
  styleUrl: './ai-usage-mobile.page.scss',
})
export class AiUsageMobilePage {
  private api = inject(Api);
  private toast = inject(ToastController);

  /** The current page of per-call rows (newest-first from the server). */
  readonly rows = signal<AiUsageRow[]>([]);
  /** The window summary block (totals, per-outcome counts, top user/feature). */
  readonly summary = signal<AiUsageSummary | null>(null);

  readonly loading = signal(true);
  readonly errored = signal(false);
  readonly refreshing = signal(false);
  /** In-flight pager/filter load (disables the pager buttons without a full skeleton). */
  readonly paging = signal(false);

  /** The current page index (0-based) for the label + the keyset cursor stack. */
  readonly page = signal(0);
  /** Whether the last page came back full (so an older page may exist). */
  readonly hasMore = signal(false);

  /** Outcome filter ('' = all) — scopes the feed AND the server query so paging stays consistent. */
  readonly outcome = signal('');

  /** Detail sheet state + the row it's showing. */
  readonly detailOpen = signal(false);
  readonly selected = signal<AiUsageRow | null>(null);

  /** Keyset cursor stack: the `before` id used to fetch each page (index 0 = newest, no cursor). */
  private cursors: (number | null)[] = [null];

  readonly skeletonCells = Array.from({ length: 6 }, (_, i) => i);

  /** Outcome segments (mirrors the live page's outcome options, terse mobile labels). */
  readonly outcomeSegments: Segment[] = [
    { key: '', label: 'All' },
    { key: 'ok', label: 'OK' },
    { key: 'unavailable', label: 'Unavail.' },
    { key: 'rate-limited', label: 'Limited' },
    { key: 'error', label: 'Errors' },
  ];

  /** Count of non-ok outcomes in the window (drives the Failures tile + its red accent). */
  readonly failures = computed(() => {
    const by = this.summary()?.byOutcome ?? {};
    let n = 0;
    for (const [k, v] of Object.entries(by)) if (k !== 'ok') n += v;
    return n;
  });

  readonly topUser = computed(() => this.summary()?.topUsers?.[0] ?? null);
  readonly topFeature = computed(() => this.summary()?.topFeatures?.[0] ?? null);

  /** The headline est. cost, pre-formatted for the big tile numeral. */
  readonly costLabel = computed(() => this.fmtCost(this.summary()?.totalEstimatedCostUsd ?? null));

  /** Total tokens, compacted (e.g. "1.2M") so the tile numeral never overflows. */
  readonly tokensLabel = computed(() => this.compact(this.summary()?.totalTokens ?? 0));

  /** The section-header subtitle: how many rows are on this page + the active filter. */
  readonly listSub = computed(() => {
    const n = this.rows().length;
    const base = `${n} on this page`;
    const o = this.outcome();
    return o ? `${base} · ${this.outcomeLabel(o)}` : base;
  });

  constructor() {
    void this.reload();
  }

  // ─────────────── LOAD ───────────────

  async reload(): Promise<void> {
    const wasLoaded = !this.loading();
    if (wasLoaded) this.refreshing.set(true); else this.loading.set(true);
    // A reload always returns to the newest page.
    this.cursors = [null];
    this.page.set(0);
    this.errored.set(false);
    try {
      await this.fetch();
    } catch {
      this.errored.set(true);
    } finally {
      this.loading.set(false);
      if (wasLoaded) {
        this.refreshing.set(false);
        if (!this.errored()) this.toast.show('AI usage refreshed', { tone: 'success', durationMs: 1600 });
      }
    }
  }

  /** Fetch the current page (cursor at `page`) with the active filter; throws on failure. */
  private async fetch(): Promise<void> {
    const before = this.cursors[this.page()];
    const r = await firstValueFrom(
      this.api.getAiUsage({ before, limit: PAGE_SIZE, outcome: this.outcome() }),
    );
    this.rows.set(r.rows ?? []);
    this.summary.set(r.summary ?? null);
    this.hasMore.set((r.rows?.length ?? 0) === PAGE_SIZE);
  }

  /** Re-fetch the current page after a filter/pager move (no full skeleton; pager-only busy). */
  private async repage(): Promise<void> {
    this.paging.set(true);
    this.errored.set(false);
    try {
      await this.fetch();
    } catch {
      this.toast.show("Couldn't load that page — try again", { tone: 'warn' });
    } finally {
      this.paging.set(false);
    }
  }

  setOutcome(key: string): void {
    if (key === this.outcome() || this.paging()) return;
    this.outcome.set(key);
    // A new filter resets to the newest page (the keyset cursors are filter-specific).
    this.cursors = [null];
    this.page.set(0);
    void this.repage();
  }

  nextPage(): void {
    if (!this.hasMore() || !this.rows().length || this.paging()) return;
    const lastId = this.rows()[this.rows().length - 1].id;
    const next = this.page() + 1;
    this.cursors[next] = lastId; // keyset cursor for the older page
    this.page.set(next);
    void this.repage().then(() => this.scrollTop());
  }

  prevPage(): void {
    if (this.page() === 0 || this.paging()) return;
    this.page.set(this.page() - 1);
    void this.repage().then(() => this.scrollTop());
  }

  private scrollTop(): void {
    document.querySelector('.au-scroll')?.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ─────────────── DETAIL ───────────────

  openDetail(r: AiUsageRow): void {
    this.selected.set(r);
    this.detailOpen.set(true);
  }

  rowAria(r: AiUsageRow): string {
    const who = r.userName ? `by ${r.userName}` : 'background';
    const tok = r.totalTokens != null ? `, ${r.totalTokens} tokens` : '';
    const cost = r.estimatedCostUsd != null ? `, ${this.fmtCost(r.estimatedCostUsd)}` : '';
    return `${r.feature}, ${this.outcomeLabel(r.outcome)} ${who}${tok}${cost}. Open details.`;
  }

  // ─────────────── outcome helpers (mirror the live page) ───────────────

  /** Tone band for an outcome: ok=ok, unavailable/rate-limited=warn, else danger. */
  outcomeTone(outcome: string): 'ok' | 'warn' | 'danger' {
    if (outcome === 'ok') return 'ok';
    if (outcome === 'unavailable' || outcome === 'rate-limited') return 'warn';
    return 'danger';
  }

  outcomeIcon(outcome: string): string {
    switch (this.outcomeTone(outcome)) {
      case 'ok': return 'check_circle';
      case 'warn': return 'schedule';
      default: return 'error';
    }
  }

  private readonly outcomeLabels: Record<string, string> = {
    '': 'All',
    ok: 'OK',
    unavailable: 'Unavailable',
    'rate-limited': 'Rate-limited',
    'parse-failed': 'Parse-failed',
    error: 'Error',
  };

  outcomeLabel(outcome: string): string {
    return this.outcomeLabels[outcome] ?? outcome;
  }

  // ─────────────── formatters (mirror the live page) ───────────────

  fmtNum(n: number | null | undefined): string {
    if (n == null) return '—';
    return n.toLocaleString();
  }

  /** Format an estimated USD cost. Null → "—" (never a fake $0). Sub-cent keeps 4 digits. */
  fmtCost(n: number | null | undefined): string {
    if (n == null) return '—';
    const digits = n !== 0 && Math.abs(n) < 0.01 ? 4 : 2;
    return n.toLocaleString(undefined, {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  }

  /** Compact a large token count for a tile numeral (e.g. 1_240_000 → "1.2M"). */
  private compact(n: number): string {
    if (n < 1000) return String(n);
    if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '') + 'K';
    return (n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0).replace(/\.0$/, '') + 'M';
  }

  fmtMs(ms: number): string {
    if (ms < 1000) return `${Math.round(ms)} ms`;
    return `${(ms / 1000).toFixed(2)} s`;
  }

  /** A short, locale-aware timestamp for the list/detail (the ISO is also shown raw in detail). */
  fmtTime(iso: string): string {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  }
}
