import {
  ChangeDetectionStrategy, Component, computed, inject, signal,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { MatIconModule } from '@angular/material/icon';

import { Api } from '../../core/api';
import { AiUsageRow, AiUsageSummary } from '../../core/models';
import {
  BetaPullRefresh, BetaSegmentedControl, BetaBottomSheet, BetaStatTile, BetaSkeleton,
  BetaSectionHeader, BetaToaster, BetaDonut, BetaTooltip, ToastController,
  type Segment, type DonutSegment,
} from '../beta-ui';

const PAGE_SIZE = 100;

/** A {value,label} option for the user/feature filter selects, derived from the window summary. */
interface FilterOption {
  value: string;
  label: string;
}

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
    DecimalPipe, FormsModule, MatIconModule,
    BetaPullRefresh, BetaSegmentedControl, BetaBottomSheet, BetaStatTile, BetaSkeleton,
    BetaSectionHeader, BetaToaster, BetaDonut, BetaTooltip,
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

            <!-- ─── SPEND-BY-MODEL COMPOSITION (donut) ─── -->
            @if (modelSegments().length) {
              <section class="au-donut-card" aria-label="Spend by model">
                <div class="au-donut-card__head">
                  <span class="au-donut-card__title">
                    <mat-icon aria-hidden="true">donut_small</mat-icon>
                    {{ modelByCost() ? 'Spend by model' : 'Tokens by model' }}
                  </span>
                  <app-bs-tooltip
                    [text]="modelByCost()
                      ? 'Estimated USD cost on this page, split across the models that produced it. Unpriced models are excluded.'
                      : 'Total tokens on this page, split across the models that produced them (no priced cost was available).'"
                    label="How is spend by model calculated?" />
                </div>
                <app-bs-donut
                  [segments]="modelSegments()"
                  [headline]="modelHeadline()"
                  [caption]="modelCaption()"
                  [legend]="true"
                  [showPercent]="true"
                  [size]="176" />
              </section>
            }

            @if (s.hasUnpricedModels) {
              <p class="au-note" aria-hidden="true">
                <mat-icon aria-hidden="true">info</mat-icon>
                Some calls use a model with no price — their cost shows as “—”.
              </p>
            }
          }

          <!-- ─── OUTCOME FILTER + MORE-FILTERS TRIGGER ─── -->
          <div class="au-seg-wrap">
            <app-bs-segmented class="au-seg"
              [segments]="outcomeSegments" [value]="outcome()" label="Filter by outcome"
              (change)="setOutcome($event)" />
            <button type="button" class="au-filter-btn" [class.is-active]="extraFilterCount() > 0"
                    (click)="openFilters()" aria-label="More filters">
              <mat-icon aria-hidden="true">tune</mat-icon>
              @if (extraFilterCount() > 0) {
                <span class="au-filter-btn__count mono-num">{{ extraFilterCount() }}</span>
              }
            </button>
          </div>

          @if (extraFilterCount() > 0) {
            <div class="au-chips" aria-label="Active filters">
              @if (userLabel(); as ul) {
                <button type="button" class="au-chip" (click)="clearUser()">
                  <mat-icon aria-hidden="true">person</mat-icon>{{ ul }}
                  <mat-icon class="au-chip__x" aria-hidden="true">close</mat-icon>
                </button>
              }
              @if (feature()) {
                <button type="button" class="au-chip" (click)="clearFeature()">
                  <mat-icon aria-hidden="true">bolt</mat-icon>{{ feature() }}
                  <mat-icon class="au-chip__x" aria-hidden="true">close</mat-icon>
                </button>
              }
              @if (dateLabel(); as dl) {
                <button type="button" class="au-chip" (click)="clearDates()">
                  <mat-icon aria-hidden="true">event</mat-icon>{{ dl }}
                  <mat-icon class="au-chip__x" aria-hidden="true">close</mat-icon>
                </button>
              }
            </div>
          }

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
                    @if (r.errorHint && outcomeTone(r.outcome) !== 'ok') {
                      <span class="au-row__hint">
                        <mat-icon class="au-row__hint-ic" aria-hidden="true">warning_amber</mat-icon>{{ r.errorHint }}
                      </span>
                    }
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
                <app-bs-tooltip
                  text="Outcome: OK = the model answered; Unavailable / Rate-limited = a transient upstream refusal; Parse-failed / Error = the response couldn't be used."
                  label="What does the outcome mean?" />
                · {{ fmtTime(r.whenUtc) }}
              </span>
            </div>
          </div>

          <!-- token + cost breakdown -->
          <div class="ad__macros-head">
            <span class="ad__macros-title">Tokens &amp; cost</span>
            <app-bs-tooltip
              text="Prompt + output tokens the call consumed, and the estimated USD cost (model rates × tokens). Cost shows “—” for a model with no price."
              label="What do tokens and cost mean?" />
          </div>
          <div class="ad__macros">
            <div class="ad__macro"><span class="ad__macro-n mono-num">{{ fmtNum(r.promptTokens) }}</span><span class="ad__macro-l">prompt</span></div>
            <div class="ad__macro"><span class="ad__macro-n mono-num">{{ fmtNum(r.outputTokens) }}</span><span class="ad__macro-l">output</span></div>
            <div class="ad__macro"><span class="ad__macro-n mono-num">{{ fmtNum(r.totalTokens) }}</span><span class="ad__macro-l">total tok</span></div>
            <div class="ad__macro"><span class="ad__macro-n mono-num">{{ fmtCost(r.estimatedCostUsd) }}</span><span class="ad__macro-l">est. cost</span></div>
          </div>

          @if (r.errorHint && outcomeTone(r.outcome) !== 'ok') {
            <div class="ad__hint" [class]="'oc-' + outcomeTone(r.outcome)">
              <mat-icon aria-hidden="true">{{ outcomeIcon(r.outcome) }}</mat-icon>
              <span>{{ r.errorHint }}</span>
            </div>
          }

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

    <!-- ─────────────── FILTER BOTTOM SHEET ─────────────── -->
    <app-bs-sheet [(open)]="filtersOpen" detent="full" label="Filter AI usage">
      <div class="af">
        <div class="af__head">
          <h3 class="af__title">Filters</h3>
          <p class="af__sub">Scope the call log by user, feature and date. Applies on the newest page.</p>
        </div>

        <!-- USER -->
        <div class="af__group">
          <span class="af__label"><mat-icon aria-hidden="true">person</mat-icon> User</span>
          @if (userSegments().length > 1) {
            <app-bs-segmented [segments]="userSegments()" [value]="draftUser()"
              label="Filter by user" (change)="draftUser.set($event)" />
          } @else {
            <p class="af__none">No users in this window.</p>
          }
        </div>

        <!-- FEATURE -->
        <div class="af__group">
          <span class="af__label"><mat-icon aria-hidden="true">bolt</mat-icon> Feature</span>
          @if (featureSegments().length > 1) {
            <app-bs-segmented [segments]="featureSegments()" [value]="draftFeature()"
              label="Filter by feature" (change)="draftFeature.set($event)" />
          } @else {
            <p class="af__none">No features in this window.</p>
          }
        </div>

        <!-- DATE RANGE -->
        <div class="af__group">
          <span class="af__label"><mat-icon aria-hidden="true">event</mat-icon> Date range</span>
          <div class="af__dates">
            <label class="af__date">
              <span class="af__date-l">From</span>
              <input type="date" class="af__date-i" [ngModel]="draftFrom()"
                (ngModelChange)="draftFrom.set($event)" [max]="draftTo() || null" />
            </label>
            <label class="af__date">
              <span class="af__date-l">To</span>
              <input type="date" class="af__date-i" [ngModel]="draftTo()"
                (ngModelChange)="draftTo.set($event)" [min]="draftFrom() || null" />
            </label>
          </div>
        </div>

        <div class="af__actions">
          <button type="button" class="af__clear" (click)="clearDraftFilters()"
                  [disabled]="!draftDirty()">
            <mat-icon aria-hidden="true">filter_alt_off</mat-icon> Clear
          </button>
          <button type="button" class="af__apply" (click)="applyFilters()">
            <mat-icon aria-hidden="true">check</mat-icon> Apply
          </button>
        </div>
      </div>
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

  // ---- Extra server filters (mirror the live page; sent to getAiUsage) ----
  /** AppUser id as a string ('' = all users). */
  readonly user = signal('');
  /** Feature label ('' = all features). */
  readonly feature = signal('');
  /** yyyy-MM-dd lower bound, inclusive ('' = none). */
  readonly from = signal('');
  /** yyyy-MM-dd upper bound, inclusive ('' = none). */
  readonly to = signal('');

  /** Detail sheet state + the row it's showing. */
  readonly detailOpen = signal(false);
  readonly selected = signal<AiUsageRow | null>(null);

  // ---- Filter sheet (edited via drafts; committed only on Apply) ----
  readonly filtersOpen = signal(false);
  readonly draftUser = signal('');
  readonly draftFeature = signal('');
  readonly draftFrom = signal('');
  readonly draftTo = signal('');

  /** Keyset cursor stack: the `before` id used to fetch each page (index 0 = newest, no cursor). */
  private cursors: (number | null)[] = [null];

  readonly skeletonCells = Array.from({ length: 6 }, (_, i) => i);

  /** Outcome segments (mirrors the live page's outcome options, terse mobile labels). */
  readonly outcomeSegments: Segment[] = [
    { key: '', label: 'All' },
    { key: 'ok', label: 'OK' },
    { key: 'unavailable', label: 'N/A' },
    { key: 'rate-limited', label: 'Limited' },
    { key: 'parse-failed', label: 'Parse' },
    { key: 'error', label: 'Errors' },
  ];

  /** Top users from the window summary, as filter options (userId -> display name). Background
   *  ticks carry no id and are dropped (they can't be filtered by user). */
  readonly userOptions = computed<FilterOption[]>(() =>
    (this.summary()?.topUsers ?? [])
      .filter((u) => u.userId != null)
      .map((u) => ({ value: String(u.userId), label: u.key })),
  );

  /** Top features from the window summary, as filter options. */
  readonly featureOptions = computed<FilterOption[]>(() =>
    (this.summary()?.topFeatures ?? []).map((f) => ({ value: f.key, label: f.key })),
  );

  /** User options as segmented-control segments, with a leading "All" (labels truncated for the pill). */
  readonly userSegments = computed<Segment[]>(() => [
    { key: '', label: 'All' },
    ...this.userOptions().map((o) => ({ key: o.value, label: o.label })),
  ]);

  /** Feature options as segmented-control segments, with a leading "All". */
  readonly featureSegments = computed<Segment[]>(() => [
    { key: '', label: 'All' },
    ...this.featureOptions().map((o) => ({ key: o.value, label: o.label })),
  ]);

  /** Count of the EXTRA (non-outcome) filters currently applied — drives the trigger badge. */
  readonly extraFilterCount = computed(() =>
    (this.user() ? 1 : 0) + (this.feature() ? 1 : 0) + (this.from() || this.to() ? 1 : 0),
  );

  /** Display name for the active user filter (from the options, falling back to the raw id). */
  readonly userLabel = computed(() => {
    if (!this.user()) return '';
    return this.userOptions().find((o) => o.value === this.user())?.label ?? `User ${this.user()}`;
  });

  /** Human label for the active date range (e.g. "Jun 1 – Jun 30", "from Jun 1", "to Jun 30"). */
  readonly dateLabel = computed(() => {
    const f = this.from();
    const t = this.to();
    if (f && t) return `${this.fmtDay(f)} – ${this.fmtDay(t)}`;
    if (f) return `from ${this.fmtDay(f)}`;
    if (t) return `to ${this.fmtDay(t)}`;
    return '';
  });

  /** True when the filter-sheet drafts differ from "no extra filters" (enables Clear). */
  readonly draftDirty = computed(() =>
    !!(this.draftUser() || this.draftFeature() || this.draftFrom() || this.draftTo()),
  );

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

  // ─────────────── SPEND-BY-MODEL (donut, derived from the loaded page rows) ───────────────

  /** A small, fixed hue ramp for the model slices (accent-led, then distinct kit-friendly hues). */
  private readonly modelColors = [
    'var(--accent-a)', 'var(--accent-b)', '#a78bfa', '#f59e0b', '#34d399', '#f472b6',
  ];

  /**
   * Composition of this page's spend across models, derived ENTIRELY from the already-loaded
   * {@link rows} (model + est. cost). Rows are grouped by model and summed by priced cost; if no row
   * on the page carried a priced cost we fall back to grouping by TOTAL TOKENS (so the ring is never
   * empty when there's data), which {@link modelByCost} reflects in the labels. Top 5 models keep their
   * own slice; the remainder rolls into an "Other" slice. Reuses `rows()` — no new API call.
   */
  private readonly modelGroups = computed(() => {
    const rows = this.rows();
    const byCost = new Map<string, number>();
    const byTok = new Map<string, number>();
    let costTotal = 0;
    let tokTotal = 0;
    for (const r of rows) {
      const m = r.model || 'unknown';
      if (r.estimatedCostUsd != null && r.estimatedCostUsd > 0) {
        byCost.set(m, (byCost.get(m) ?? 0) + r.estimatedCostUsd);
        costTotal += r.estimatedCostUsd;
      }
      if (r.totalTokens != null && r.totalTokens > 0) {
        byTok.set(m, (byTok.get(m) ?? 0) + r.totalTokens);
        tokTotal += r.totalTokens;
      }
    }
    const byCostMode = costTotal > 0;
    const src = byCostMode ? byCost : byTok;
    const total = byCostMode ? costTotal : tokTotal;
    return { src, total, byCostMode };
  });

  /** True when the donut splits by priced USD cost; false when it fell back to token share. */
  readonly modelByCost = computed(() => this.modelGroups().byCostMode);

  /** The donut segments: top 5 models by share + an "Other" rollup, colored from {@link modelColors}. */
  readonly modelSegments = computed<DonutSegment[]>(() => {
    const { src } = this.modelGroups();
    const entries = [...src.entries()].sort((a, b) => b[1] - a[1]);
    if (!entries.length) return [];
    const TOP = 5;
    const head = entries.slice(0, TOP);
    const rest = entries.slice(TOP);
    const segs: DonutSegment[] = head.map(([label, value], i) => ({
      label, value, color: this.modelColors[i % this.modelColors.length],
    }));
    if (rest.length) {
      const otherVal = rest.reduce((s, [, v]) => s + v, 0);
      segs.push({ label: `Other (${rest.length})`, value: otherVal, color: 'var(--ink-faint, #64748b)' });
    }
    return segs;
  });

  /** The centered headline: total priced spend, or the compacted token total when in fall-back mode. */
  readonly modelHeadline = computed(() => {
    const { total, byCostMode } = this.modelGroups();
    return byCostMode ? this.fmtCost(total) : this.compact(total);
  });

  /** The muted caption under the headline: what the ring is splitting. */
  readonly modelCaption = computed(() =>
    this.modelByCost() ? 'est. spend · this page' : 'tokens · this page');

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

  /** Fetch the current page (cursor at `page`) with the active filters; throws on failure. */
  private async fetch(): Promise<void> {
    const before = this.cursors[this.page()];
    const r = await firstValueFrom(
      this.api.getAiUsage({
        before,
        limit: PAGE_SIZE,
        outcome: this.outcome(),
        user: this.user() ? Number(this.user()) : null,
        feature: this.feature(),
        from: this.from() ? new Date(this.from() + 'T00:00:00').toISOString() : undefined,
        to: this.to() ? new Date(this.to() + 'T23:59:59').toISOString() : undefined,
      }),
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

  // ─────────────── EXTRA FILTERS (user / feature / date range) ───────────────

  /** Open the filter sheet, seeding the drafts from the currently-applied filters. */
  openFilters(): void {
    this.draftUser.set(this.user());
    this.draftFeature.set(this.feature());
    this.draftFrom.set(this.from());
    this.draftTo.set(this.to());
    this.filtersOpen.set(true);
  }

  /** Commit the drafts, reset the keyset cursors (filter-specific) and repage from newest. */
  applyFilters(): void {
    this.user.set(this.draftUser());
    this.feature.set(this.draftFeature());
    this.from.set(this.draftFrom());
    this.to.set(this.draftTo());
    this.filtersOpen.set(false);
    this.cursors = [null];
    this.page.set(0);
    void this.repage();
  }

  /** Reset the sheet drafts (does NOT apply until Apply is tapped). */
  clearDraftFilters(): void {
    this.draftUser.set('');
    this.draftFeature.set('');
    this.draftFrom.set('');
    this.draftTo.set('');
  }

  /** Remove one applied filter from a chip and repage immediately. */
  private applyOne(mutate: () => void): void {
    if (this.paging()) return;
    mutate();
    this.cursors = [null];
    this.page.set(0);
    void this.repage();
  }

  clearUser(): void { this.applyOne(() => this.user.set('')); }
  clearFeature(): void { this.applyOne(() => this.feature.set('')); }
  clearDates(): void { this.applyOne(() => { this.from.set(''); this.to.set(''); }); }

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

  /** A short month/day label for a yyyy-MM-dd filter value (used in the date chip). */
  fmtDay(ymd: string): string {
    const d = new Date(ymd + 'T00:00:00');
    if (isNaN(d.getTime())) return ymd;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
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
