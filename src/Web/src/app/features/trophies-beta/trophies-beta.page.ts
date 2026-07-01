import {
  ChangeDetectionStrategy, Component, computed, inject, signal,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';

import { Api } from '../../core/api';
import { TrophiesResponse, TrophyBadgeDto, TrophyTierDto } from '../../core/models';
import {
  BetaBottomSheet, BetaPullRefresh, BetaSegmentedControl, BetaSkeleton, BetaSvgRing,
  type Segment,
} from '../beta-ui';

/**
 * Map a badge's catalog icon token (a lucide-ish name from the API) to a Material Symbols glyph.
 * COPIED from the live trophies.ts ICON map (not imported — the live page is never touched), extended
 * with a couple of extra fall-throughs the catalog may emit.
 */
const ICON: Record<string, string> = {
  dumbbell: 'fitness_center',
  'calendar-check': 'event_available',
  droplet: 'water_drop',
  waves: 'waves',
  scale: 'monitor_weight',
  coffee: 'coffee',
  pill: 'medication',
  flame: 'local_fire_department',
  'check-circle': 'check_circle',
  star: 'star',
  trophy: 'emoji_events',
  receipt: 'receipt_long',
  medal: 'military_tech',
  footprints: 'directions_walk',
};

/** The known tier rungs, lowest → highest, with a display label + the gold-leaning hue ramp. */
const TIER_ORDER = ['bronze', 'silver', 'gold', 'complete'] as const;
type TierName = (typeof TIER_ORDER)[number];

/** A grouped slice of the wall (a category like "Tracker", or a tier like "Gold"). */
interface BadgeGroup {
  readonly key: string;
  readonly name: string;
  readonly badges: readonly TrophyBadgeDto[];
  readonly earned: number;
}

/**
 * Beta Trophies — the SHOWPIECE "Achievements" surface: a premium, mobile-first wall of the caller's OWN
 * milestone badges, rebuilt on the shared beta-ui "Strata" kit (`@use '../beta-ui/beta-kit'`) with a
 * signature GOLD accent (amber → deep-amber) that re-skins the whole screen via the per-page accent
 * contract.
 *
 * An immersive header floats an earned/total progress {@link BetaSvgRing} behind a HUGE Clash Display
 * "N of M" numeral, with an accent bloom + the caller's name. A {@link BetaSegmentedControl} flips the
 * grid between grouping by CATEGORY (the server `group`) and by TIER (bronze → gold → complete). The grid
 * is a spring-staggered reveal of trophy tiles: EARNED ones gleam (a gradient medallion, an accent glow,
 * a sheen sweep + the earned-tier ribbon), LOCKED ones sit subtle/greyed with their unlock criterion.
 * Tapping any tile opens a {@link BetaBottomSheet} detail (description, how-it's-earned, the tier ladder,
 * the measured value + progress to next). Pull-to-refresh re-fetches; a tasteful loading skeleton + an
 * elevated empty/error state round it out.
 *
 * DATA PARITY + PRIVACY: every badge comes straight from {@link Api.trophies} (`GET /api/trophies`), which
 * DERIVES each metric server-side at read time from the existing tracker / 75 Hard / bills data (no new
 * tracking, no migration) — so this wall agrees with the live `/trophies` page exactly. The response
 * carries the caller's display NAME + userId only — never an email, never a secret. This page renders only
 * the caller's own data, performs NO writes, and re-derives nothing client-side.
 *
 * ISOLATION: gated by `platform.mobile` + the SAME `tracker.self` the live `/trophies` route carries; it
 * consumes the kit + the SAME read-only Api as the live counterpart. No live page is imported or modified.
 * Reduced-motion collapses the reveals/sheen via the kit a11y killswitch; layout is mobile-first (44px
 * targets, safe-area insets, no 390px overflow) and centers on desktop.
 */
@Component({
  selector: 'app-trophies-beta',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './trophies-beta.page.scss',
  imports: [
    MatIconModule, RouterLink,
    BetaPullRefresh, BetaSegmentedControl, BetaSvgRing, BetaBottomSheet, BetaSkeleton,
  ],
  template: `
    <!-- ─────────────── PULL-TO-REFRESH OWNS THE SCROLL ─────────────── -->
    <app-bs-pull-refresh class="tr-ptr" [busy]="refreshing()" (refresh)="reload()">
      <div class="tr-scroll" aria-live="polite">

        <!-- ─── PAGE HEADER: display-font title + tracker action aligned end ─── -->
        <div class="tr-page-header">
          <div class="tr-page-header__text">
            <h1 class="tr-page-header__title">Achievements</h1>
            <p class="tr-page-header__sub">Your milestone trophy wall</p>
          </div>
          <a class="tr-page-header__action" routerLink="/tracker-beta"
             aria-label="Open tracker">
            <mat-icon aria-hidden="true">fitness_center</mat-icon> Tracker
          </a>
        </div>

        <!-- ─── IMMERSIVE HEADER: ring + "N of M" + name ─── -->
        <header class="tr-hero">
          @if (loading()) {
            <div class="tr-hero__skel">
              <app-bs-skeleton width="132px" height="132px" [circle]="true" />
              <app-bs-skeleton width="58%" height="20px" radius="var(--r-pill)" />
            </div>
          } @else {
            <p class="tr-hero__kicker">
              <mat-icon aria-hidden="true">emoji_events</mat-icon> Trophy Wall
            </p>

            <div class="tr-hero__ring">
              <app-bs-ring [value]="earnedFrac()" [size]="148" [stroke]="9"
                           [signalOnFull]="allEarned()"
                           [label]="earnedCount() + ' of ' + totalCount() + ' trophies earned'">
                <span class="tr-hero__numeral">
                  <span class="tr-hero__n">{{ earnedCount() }}</span>
                  <span class="tr-hero__of">of {{ totalCount() }}</span>
                </span>
              </app-bs-ring>
            </div>

            <p class="tr-hero__title">
              @if (allEarned() && totalCount() > 0) { Every trophy, earned }
              @else { {{ earnedCount() }} unlocked }
            </p>
            <p class="tr-hero__sub">
              {{ subline() }}
            </p>

            @if (!badges().length && !errored()) {
              <a class="tr-hero__cta" routerLink="/tracker-beta">
                Start earning <mat-icon aria-hidden="true">arrow_forward</mat-icon> Open the tracker
              </a>
            }
          }
        </header>

        @if (loading()) {
          <!-- skeleton grid -->
          <div class="tr-grid" aria-hidden="true">
            @for (n of skeletonCells; track n) {
              <app-bs-skeleton height="116px" radius="var(--r-tile)" />
            }
          </div>

        } @else if (errored()) {
          <div class="tr-state">
            <span class="tr-state__orb"><mat-icon aria-hidden="true">error_outline</mat-icon></span>
            <h2 class="tr-state__title">Couldn't load your trophies</h2>
            <p class="tr-state__body">Something went wrong fetching your wall. Give it another go.</p>
            <button type="button" class="tr-state__cta" (click)="reload()">
              <mat-icon aria-hidden="true">refresh</mat-icon> Try again
            </button>
          </div>

        } @else if (!badges().length) {
          <!-- empty wall: the hero already carries the encouragement + the single CTA -->
        } @else {
          <!-- ─── "NEXT UP" HINT: the closest locked trophy + its criterion ─── -->
          @if (nextUp(); as nu) {
            <button type="button" class="tr-nextup" (click)="openDetail(nu)"
                    [attr.aria-label]="'Next up: ' + nu.label + '. ' + caption(nu) + '. Open details.'">
              <span class="tr-nextup__bloom" aria-hidden="true"></span>
              <span class="tr-nextup__medal" aria-hidden="true"><mat-icon>{{ icon(nu) }}</mat-icon></span>
              <span class="tr-nextup__body">
                <span class="tr-nextup__kicker"><mat-icon aria-hidden="true">my_location</mat-icon> Next up</span>
                <span class="tr-nextup__name">{{ nu.label }}</span>
                <span class="tr-nextup__crit">{{ unlockCriterion(nu) }}</span>
                <span class="tr-nextup__bar" aria-hidden="true">
                  <span class="tr-nextup__bar-fill" [style.width.%]="pct(nu)"></span>
                </span>
              </span>
              <mat-icon class="tr-nextup__go" aria-hidden="true">chevron_right</mat-icon>
            </button>
          }

          <!-- ─── CONTROLS: status filter + group-by, each with a labelled kicker ─── -->
          <div class="tr-controls">
            <div class="tr-control-row">
              <span class="tr-control-label">Show</span>
              <div class="tr-seg-wrap">
                <app-bs-segmented class="tr-seg"
                  [segments]="statusSegments" [value]="statusFilter()" label="Filter trophies by status"
                  (change)="setStatusFilter($event)" />
              </div>
            </div>

            <div class="tr-control-row">
              <span class="tr-control-label">Group by</span>
              <div class="tr-seg-wrap">
                <app-bs-segmented class="tr-seg"
                  [segments]="groupSegments" [value]="groupBy()" label="Group trophies by"
                  (change)="setGroupBy($event)" />
              </div>
            </div>
          </div>

          @if (!visibleBadges().length) {
            <div class="tr-filter-empty" role="status">
              <span class="tr-filter-empty__orb" aria-hidden="true">
                <mat-icon>{{ statusFilter() === 'earned' ? 'lock_open' : 'emoji_events' }}</mat-icon>
              </span>
              <h2 class="tr-filter-empty__title">
                {{ statusFilter() === 'earned' ? 'None earned yet' : 'Wall cleared!' }}
              </h2>
              <p class="tr-filter-empty__hint">
                {{ statusFilter() === 'earned'
                  ? 'Keep logging to light up the wall — your first trophy is closer than you think.'
                  : 'Every trophy is earned. Nothing left locked — you\'ve maxed the wall.' }}
              </p>
            </div>
          }

          <!-- ─── THE WALL: grouped, spring-staggered tiles ─── -->
          @for (g of groups(); track g.key) {
            <section class="tr-group">
              <div class="tr-group__head">
                <span class="tr-group__dot" aria-hidden="true"
                      [attr.data-tier]="groupBy() === 'tier' ? g.key : null"></span>
                <h2 class="tr-group__title" [attr.data-tier]="groupBy() === 'tier' ? g.key : null">{{ g.name }}</h2>
                <span class="tr-group__count">{{ g.earned }}/{{ g.badges.length }}</span>
              </div>

              <div class="tr-grid">
                @for (b of g.badges; track b.id; let i = $index) {
                  <button type="button"
                          class="tr-tile tr-reveal"
                          [class.is-earned]="b.earned"
                          [class.is-locked]="!b.earned"
                          [attr.data-tier]="b.earned ? b.tier : null"
                          [style.--ri]="i"
                          [attr.aria-label]="tileAria(b)"
                          (click)="openDetail(b)">
                    <span class="tr-tile__sheen" aria-hidden="true"></span>
                    <span class="tr-tile__medal" [attr.data-tier]="b.earned ? b.tier : 'none'">
                      <mat-icon aria-hidden="true">{{ b.earned ? icon(b) : 'lock' }}</mat-icon>
                    </span>
                    <span class="tr-tile__label">{{ b.label }}</span>
                    <span class="tr-tile__meta">
                      @if (b.earned) {
                        <mat-icon class="tr-tile__meta-ic" aria-hidden="true">check_circle</mat-icon>
                        {{ tierLabel(b.tier) }}
                      } @else {
                        {{ caption(b) }}
                      }
                    </span>
                    <!-- Inline tier ladder: every rung, earned-lit, with its threshold visible (no tap-in). -->
                    @if (b.tiers.length > 1) {
                      <span class="tr-tile__tiers" [attr.aria-label]="tiersAria(b)">
                        @for (t of b.tiers; track t.name) {
                          <span class="tr-tile__tier"
                                [class.is-earned]="t.earned"
                                [attr.data-tier]="t.name">
                            <span class="tr-tile__tier-dot" aria-hidden="true"></span>
                            <span class="tr-tile__tier-thr">{{ fmt(t.threshold) }}</span>
                          </span>
                        }
                      </span>
                    }
                    @if (!b.earned) {
                      <span class="tr-tile__bar" aria-hidden="true">
                        <span class="tr-tile__bar-fill" [style.width.%]="pct(b)"></span>
                      </span>
                    }
                  </button>
                }
              </div>
            </section>
          }

          <p class="tr-foot" aria-hidden="true">
            Derived from your tracker, 75 Hard &amp; bills · keep logging to climb each tier
          </p>
        }
      </div>
    </app-bs-pull-refresh>

    <!-- ─────────────── DETAIL BOTTOM SHEET ─────────────── -->
    <app-bs-sheet [(open)]="sheetOpen" detent="half" [label]="selected()?.label || 'Trophy detail'">
      @if (selected(); as b) {
        <div class="trd" [class.is-earned]="b.earned" [attr.data-tier]="b.earned ? b.tier : 'none'">
          <div class="trd__head">
            <span class="trd__medal" [attr.data-tier]="b.earned ? b.tier : 'none'">
              <mat-icon aria-hidden="true">{{ b.earned ? icon(b) : 'lock' }}</mat-icon>
            </span>
            <div class="trd__titles">
              <h3 class="trd__title">{{ b.label }}</h3>
              <span class="trd__status" [class.is-earned]="b.earned">
                @if (b.earned) {
                  <mat-icon aria-hidden="true">check_circle</mat-icon> {{ tierLabel(b.tier) }} · earned
                } @else {
                  <mat-icon aria-hidden="true">lock</mat-icon> Locked
                }
              </span>
            </div>
          </div>

          <p class="trd__desc">{{ b.description }}</p>

          <!-- How to earn it / the unlock criterion (or the earned confirmation). -->
          <div class="trd__how" [class.is-earned]="b.earned">
            <mat-icon aria-hidden="true">{{ b.earned ? 'check_circle' : 'flag' }}</mat-icon>
            <span class="trd__how-txt">
              <i class="trd__how-kicker">{{ b.earned ? 'Earned' : 'How to earn it' }}</i>
              <b class="trd__how-line">
                @if (b.earned) {
                  {{ tierLabel(b.tier) }} tier unlocked
                  @if (b.nextTier) { · {{ unlockCriterion(b) }} for {{ tierLabel(b.nextTier.name) }} }
                } @else {
                  {{ unlockCriterion(b) }}
                }
              </b>
            </span>
          </div>

          <!-- the tier ladder: how it's earned, rung by rung -->
          <div class="trd__ladder" role="list" aria-label="Tier ladder">
            @for (t of b.tiers; track t.name) {
              <div class="trd__rung" role="listitem"
                   [class.is-earned]="t.earned"
                   [class.is-next]="isNext(b, t)"
                   [attr.data-tier]="t.name">
                <span class="trd__rung-dot" aria-hidden="true">
                  @if (t.earned) { <mat-icon>check</mat-icon> }
                </span>
                <span class="trd__rung-name">{{ tierLabel(t.name) }}</span>
                <span class="trd__rung-thr">{{ fmt(t.threshold) }}</span>
              </div>
            }
          </div>

          <!-- progress toward the next rung (or a maxed-out banner) -->
          @if (b.nextTier; as nt) {
            <div class="trd__progress">
              <div class="trd__progress-row">
                <span>{{ fmt(b.value) }} / {{ fmt(nt.threshold) }}</span>
                <span class="trd__progress-to">{{ fmt(remaining(b)) }} to {{ tierLabel(nt.name) }}</span>
              </div>
              <span class="trd__progress-bar" aria-hidden="true">
                <span class="trd__progress-fill" [style.width.%]="pct(b)"></span>
              </span>
            </div>
          } @else {
            <div class="trd__maxed">
              <mat-icon aria-hidden="true">verified</mat-icon>
              {{ b.earned ? 'Maxed out — every tier earned' : 'Complete this to earn it' }}
            </div>
          }
        </div>
      }
    </app-bs-sheet>
  `,
})
export class TrophiesBetaPage {
  private api = inject(Api);

  readonly data = signal<TrophiesResponse | null>(null);
  readonly loading = signal(true);
  readonly errored = signal(false);
  readonly refreshing = signal(false);

  /** Bottom-sheet state + the badge it's showing. */
  readonly sheetOpen = signal(false);
  readonly selected = signal<TrophyBadgeDto | null>(null);

  /** How the grid is grouped: by the server category, or by earned tier. */
  readonly groupBy = signal<'category' | 'tier'>('category');

  /** Which trophies the grid shows: all, only earned, or only locked. */
  readonly statusFilter = signal<'all' | 'earned' | 'locked'>('all');

  readonly groupSegments: Segment[] = [
    { key: 'category', label: 'Category' },
    { key: 'tier', label: 'Tier' },
  ];

  readonly statusSegments: Segment[] = [
    { key: 'all', label: 'All' },
    { key: 'earned', label: 'Earned' },
    { key: 'locked', label: 'Locked' },
  ];

  /** Stable cells for the loading skeleton grid. */
  readonly skeletonCells = Array.from({ length: 6 }, (_, i) => i);

  readonly badges = computed<TrophyBadgeDto[]>(() => this.data()?.badges ?? []);
  readonly earnedCount = computed(() => this.data()?.earnedCount ?? 0);
  readonly totalCount = computed(() => this.data()?.totalCount ?? 0);

  /** Earned fraction 0..1 for the hero ring (0 when the wall is empty). */
  readonly earnedFrac = computed(() => {
    const total = this.totalCount();
    return total > 0 ? this.earnedCount() / total : 0;
  });

  readonly allEarned = computed(() => this.totalCount() > 0 && this.earnedCount() >= this.totalCount());

  /** A warm one-liner under the hero numeral. */
  readonly subline = computed(() => {
    const e = this.earnedCount();
    const t = this.totalCount();
    const name = this.data()?.userName?.trim();
    if (t === 0) return 'No trophies on the board yet — start logging to fill the wall.';
    if (e >= t) return name ? `${name}, you've cleared the whole wall.` : "You've cleared the whole wall.";
    const left = t - e;
    return `${left} more ${left === 1 ? 'trophy' : 'trophies'} to chase` + (name ? `, ${name}.` : '.');
  });

  /** Badges after the All/Earned/Locked status filter — drives the grid (catalog order preserved). */
  readonly visibleBadges = computed<TrophyBadgeDto[]>(() => {
    const all = this.badges();
    const f = this.statusFilter();
    if (f === 'earned') return all.filter(b => b.earned);
    if (f === 'locked') return all.filter(b => !b.earned);
    return all;
  });

  /** The grouped wall — by the server `group` (catalog order preserved) or by earned tier. */
  readonly groups = computed<BadgeGroup[]>(() => {
    const visible = this.visibleBadges();
    if (!visible.length) return [];
    return this.groupBy() === 'tier' ? this.groupByTier(visible) : this.groupByCategory(visible);
  });

  /**
   * The "next up" hint: the FIRST locked badge in catalog order — the closest thing to earn next.
   * Independent of the status filter so the nudge is always present while anything is locked.
   */
  readonly nextUp = computed<TrophyBadgeDto | null>(() => this.badges().find(b => !b.earned) ?? null);

  constructor() {
    this.reload();
  }

  // ─────────────── LOAD ───────────────

  async reload(): Promise<void> {
    const wasLoaded = !!this.data();
    if (wasLoaded) this.refreshing.set(true); else this.loading.set(true);
    this.errored.set(false);
    try {
      const res = await firstValueFrom(this.api.trophies());
      this.data.set(res);
    } catch {
      this.errored.set(true);
    } finally {
      this.loading.set(false);
      this.refreshing.set(false);
    }
  }

  setGroupBy(key: string): void {
    this.groupBy.set(key === 'tier' ? 'tier' : 'category');
  }

  setStatusFilter(key: string): void {
    this.statusFilter.set(key === 'earned' ? 'earned' : key === 'locked' ? 'locked' : 'all');
  }

  /**
   * A full-sentence unlock criterion for a badge's NEXT rung ("Reach 50 workouts to unlock Gold"),
   * or a maxed-out line. Used in the detail sheet's how-to-earn block + the next-up card.
   */
  unlockCriterion(b: TrophyBadgeDto): string {
    if (!b.nextTier) return b.earned ? 'Every tier earned — maxed out.' : 'Complete this to earn it.';
    const remaining = Math.max(0, b.nextTier.threshold - b.value);
    if (remaining <= 0) return `Reach ${this.fmt(b.nextTier.threshold)} to unlock ${this.tierLabel(b.nextTier.name)}.`;
    return `${this.fmt(remaining)} more to unlock ${this.tierLabel(b.nextTier.name)} (${this.fmt(b.value)} / ${this.fmt(b.nextTier.threshold)}).`;
  }

  // ─────────────── DETAIL SHEET ───────────────

  openDetail(b: TrophyBadgeDto): void {
    this.selected.set(b);
    this.sheetOpen.set(true);
  }

  /** True when this tier is the badge's NEXT unearned rung (highlighted in the ladder). */
  isNext(b: TrophyBadgeDto, t: TrophyTierDto): boolean {
    return !!b.nextTier && b.nextTier.name === t.name;
  }

  // ─────────────── GROUPING ───────────────

  /** Group by the server `group` field, preserving catalog order within + across groups. */
  private groupByCategory(all: readonly TrophyBadgeDto[]): BadgeGroup[] {
    const order: string[] = [];
    const byGroup = new Map<string, TrophyBadgeDto[]>();
    for (const b of all) {
      if (!byGroup.has(b.group)) { byGroup.set(b.group, []); order.push(b.group); }
      byGroup.get(b.group)!.push(b);
    }
    return order.map(name => {
      const badges = byGroup.get(name)!;
      return { key: name, name, badges, earned: badges.filter(b => b.earned).length };
    });
  }

  /**
   * Group by the highest earned tier — gold → silver → bronze → complete → not-yet-earned ("Locked").
   * Earned tiers lead (gold first, the most prestigious) so the wall reads as a podium.
   */
  private groupByTier(all: readonly TrophyBadgeDto[]): BadgeGroup[] {
    const buckets: Record<string, TrophyBadgeDto[]> = {};
    for (const b of all) {
      const k = b.earned ? b.tier : 'locked';
      (buckets[k] ??= []).push(b);
    }
    const tierBuckets: { key: string; name: string }[] = [
      { key: 'gold', name: 'Gold' },
      { key: 'silver', name: 'Silver' },
      { key: 'bronze', name: 'Bronze' },
      { key: 'complete', name: 'Completed' },
      { key: 'locked', name: 'Still locked' },
    ];
    return tierBuckets
      .filter(tb => buckets[tb.key]?.length)
      .map(tb => {
        const badges = buckets[tb.key];
        return { key: tb.key, name: tb.name, badges, earned: badges.filter(b => b.earned).length };
      });
  }

  // ─────────────── DISPLAY HELPERS (copied from live trophies.ts) ───────────────

  icon(badge: TrophyBadgeDto): string {
    return ICON[badge.icon] ?? 'emoji_events';
  }

  /** Title-case a tier token for display ("gold" → "Gold", "complete" → "Complete"). */
  tierLabel(tier: string): string {
    if (!tier || tier === 'none') return 'Locked';
    return tier.charAt(0).toUpperCase() + tier.slice(1);
  }

  /** A short caption for a LOCKED badge's standing: the path to its next tier. */
  caption(b: TrophyBadgeDto): string {
    if (b.nextTier === null) return 'Complete';
    const remaining = Math.max(0, b.nextTier.threshold - b.value);
    return `${this.fmt(remaining)} to ${this.tierLabel(b.nextTier.name)}`;
  }

  /** Remaining metric to the next tier (0 when maxed). */
  remaining(b: TrophyBadgeDto): number {
    return b.nextTier ? Math.max(0, b.nextTier.threshold - b.value) : 0;
  }

  /** Whole numbers render without a decimal; fractional points keep one place. */
  fmt(n: number): string {
    return Number.isInteger(n) ? String(n) : n.toFixed(1);
  }

  /** Progress 0..100 for a tile/sheet bar. */
  pct(b: TrophyBadgeDto): number {
    return Math.round(Math.max(0, Math.min(1, b.progressToNext)) * 100);
  }

  /** A spoken summary of the inline tier ladder ("Bronze 5 earned, Silver 25, Gold 50"). */
  tiersAria(b: TrophyBadgeDto): string {
    const rungs = b.tiers.map(t =>
      `${this.tierLabel(t.name)} ${this.fmt(t.threshold)}${t.earned ? ' earned' : ''}`,
    );
    return `Tiers: ${rungs.join(', ')}.`;
  }

  /** A full aria label for a tile (the tile is icon-led, so it names itself). */
  tileAria(b: TrophyBadgeDto): string {
    if (b.earned) return `${b.label}, earned, ${this.tierLabel(b.tier)} tier. Open details.`;
    return `${b.label}, locked. ${this.caption(b)}. Open details.`;
  }

  /** Silences "unused" lint on the imported tier constants kept for documentation. */
  protected readonly TIER_ORDER = TIER_ORDER;
}

// Keep the TierName type referenced so a future tier-typed refactor stays honest.
export type { TierName };
