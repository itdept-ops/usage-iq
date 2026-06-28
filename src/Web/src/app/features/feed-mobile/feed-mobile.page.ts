import {
  ChangeDetectionStrategy, Component, computed, inject, signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { catchError, firstValueFrom, of } from 'rxjs';

import { Api } from '../../core/api';
import { AuthService } from '../../core/auth';
import { FeedItem } from '../../core/models';
import { timeAgo } from '../../shared/format';
import { BetaPullRefresh, BetaSkeleton } from '../beta-ui';
import { FeedComments } from '../feed/feed-comments';

/** A feed row enriched with the derived bits the mobile template needs. */
interface FeedItemVm extends FeedItem {
  /** Two-letter avatar initials (from the display name — never an email). */
  initials: string;
  /** The humane verb phrase ("logged a workout", "completed 75-Hard day 12", "hit their water goal"). */
  verb: string;
  /** A Material icon glyph for the kind. */
  icon: string;
  /** A short, stable kind token used purely for the per-kind accent tint on the badge. */
  tone: string;
}

/** Feed rows grouped under a sticky day heading ("Today" / "Yesterday" / a date), newest day first. */
interface FeedDayGroup {
  /** A stable key for trackBy (the local date string). */
  key: string;
  /** The human heading ("Today", "Yesterday", or "Mon, Jun 23"). */
  label: string;
  items: FeedItemVm[];
}

/**
 * Feed "Pulse" — the MOBILE TWIN of the live circle activity feed (/feed), rebuilt on the shared beta-ui
 * "Strata" kit (`@use '../beta-ui/beta-kit'`). One signature accent — a warm CORAL → ORANGE — re-skins the
 * whole screen via the per-page accent contract. An immersive scroll column with an accent-bloom header,
 * pull-to-refresh, STICKY day headers, big-tap-target rows (actor avatar + humane verb + relative time),
 * the same one-tap cheer (👏) affordance, and a tappable "load older" footer.
 *
 * DATA PARITY: every row comes straight from {@link Api.feed} (`GET /api/feed`, keyset-paged) and the cheer
 * toggle hits {@link Api.reactFeed} (`POST /api/feed/{id}/react`) — the SAME endpoints + DTOs the live page
 * uses, so this twin agrees with /feed exactly. The verb/icon/grouping projection is copied (not imported)
 * from the live page; no new data path, no client re-aggregation, no writes beyond the existing cheer.
 *
 * PRIVACY: the server enforces all gating — events only appear for actors who opted to SHARE and are in the
 * caller's circle (plus the caller's own events always), and only when the caller opted to VIEW. Rows carry
 * an AppUser id + display name (never an email) and only a non-sensitive int/label payload.
 *
 * ISOLATION: gated by `platform.mobile` + the SAME `tracker.self` the live `/feed` route carries; it
 * consumes the kit + the SAME read-only-plus-cheer Api as the live counterpart. No live page is imported or
 * modified. Reduced-motion collapses the reveals via the kit a11y killswitch; layout is mobile-first.
 */
@Component({
  selector: 'app-feed-mobile',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './feed-mobile.page.scss',
  imports: [MatIconModule, RouterLink, BetaPullRefresh, BetaSkeleton, FeedComments],
  template: `
    <app-bs-pull-refresh class="fm-ptr" [busy]="refreshing()" (refresh)="reload()">
      <div class="fm-scroll" aria-live="polite">

        <!-- ─── IMMERSIVE HEADER: title + accent bloom + circle/self mode chip ─── -->
        <header class="fm-hero">
          <div class="fm-hero__bloom" aria-hidden="true"></div>
          <p class="fm-hero__eyebrow"><mat-icon aria-hidden="true">bolt</mat-icon> Activity</p>
          <h1 class="fm-hero__title">Pulse</h1>
          <p class="fm-hero__sub">
            @if (viewsCircle()) {
              What your circle's up to — workouts, challenge milestones &amp; goals hit.
            } @else {
              You're seeing only your own activity right now.
            }
          </p>
          <span class="fm-hero__chip" [class.is-circle]="viewsCircle()">
            <mat-icon aria-hidden="true">{{ viewsCircle() ? 'groups' : 'person' }}</mat-icon>
            {{ viewsCircle() ? 'Circle feed on' : 'Just you' }}
          </span>
        </header>

        @if (loading()) {
          <!-- skeleton rows -->
          <div class="fm-skel" aria-hidden="true">
            <app-bs-skeleton width="38%" height="14px" radius="var(--r-pill)" />
            @for (n of skeletonRows; track n) {
              <div class="fm-skel__row">
                <app-bs-skeleton width="44px" height="44px" [circle]="true" />
                <div class="fm-skel__lines">
                  <app-bs-skeleton width="72%" height="14px" radius="var(--r-pill)" />
                  <app-bs-skeleton width="40%" height="11px" radius="var(--r-pill)" />
                </div>
              </div>
            }
          </div>

        } @else if (errored()) {
          <div class="fm-state">
            <span class="fm-state__orb"><mat-icon aria-hidden="true">cloud_off</mat-icon></span>
            <h2 class="fm-state__title">Couldn't load your feed</h2>
            <p class="fm-state__body">Something went wrong fetching your circle's activity. Give it another go.</p>
            <button type="button" class="fm-state__cta" (click)="reload()">
              <mat-icon aria-hidden="true">refresh</mat-icon> Try again
            </button>
          </div>

        } @else if (isEmpty()) {
          <div class="fm-state">
            <span class="fm-state__orb"><mat-icon aria-hidden="true">bolt</mat-icon></span>
            @if (viewsCircle()) {
              <h2 class="fm-state__title">Quiet for now</h2>
              <p class="fm-state__body">
                As you and the people in your circle log workouts, complete challenge days, or hit goals,
                they'll show up here.
              </p>
            } @else {
              <h2 class="fm-state__title">Only seeing yourself</h2>
              <p class="fm-state__body">
                Turn on <strong>Show me my circle's feed</strong> in your profile to see what the people
                you're connected with are up to.
              </p>
              <a class="fm-state__cta" routerLink="/profile">
                <mat-icon aria-hidden="true">tune</mat-icon> Profile settings
              </a>
            }
          </div>

        } @else {
          <!-- ─── THE FEED: reverse-chron, grouped by day, sticky headers ─── -->
          <div class="fm-feed" role="feed" aria-label="Activity feed">
            @for (group of groups(); track group.key) {
              <section class="fm-day">
                <h2 class="fm-day__head">{{ group.label }}</h2>

                <ul class="fm-rows">
                  @for (item of group.items; track item.id; let i = $index) {
                    <li class="fm-row fm-reveal" role="article" [style.--ri]="i"
                        [attr.aria-label]="rowAria(item)">
                      <span class="fm-row__avatar" [attr.data-tone]="item.tone" aria-hidden="true">
                        <span class="fm-row__init">{{ item.initials }}</span>
                        <span class="fm-row__badge"><mat-icon>{{ item.icon }}</mat-icon></span>
                      </span>

                      <div class="fm-row__body">
                        <p class="fm-row__text">
                          <span class="fm-row__name">{{ item.actorName }}</span>
                          <span class="fm-row__verb">{{ item.verb }}</span>
                        </p>
                        <time class="fm-row__time" [attr.datetime]="item.createdUtc">
                          {{ timeAgo(item.createdUtc) }}
                        </time>
                      </div>

                      <button type="button" class="fm-cheer"
                              [class.is-on]="item.iReacted"
                              [attr.aria-pressed]="item.iReacted"
                              [attr.aria-label]="item.iReacted ? 'Cheered, tap to remove' : 'Cheer this'"
                              (click)="cheer(item)">
                        <span class="fm-cheer__emoji" aria-hidden="true">👏</span>
                        @if (item.clapCount > 0) {
                          <span class="fm-cheer__count">{{ item.clapCount }}</span>
                        }
                      </button>

                      <app-feed-comments class="fm-row__comments" [eventId]="item.id" [initialCount]="item.commentCount" />
                    </li>
                  }
                </ul>
              </section>
            }
          </div>

          <!-- ─── LOAD OLDER (keyset paging) ─── -->
          @if (hasMore()) {
            <div class="fm-more">
              @if (moreError()) {
                <p class="fm-more__error" role="alert">Couldn't load more — try again.</p>
              }
              <button type="button" class="fm-more__btn" [disabled]="loadingMore()" (click)="loadMore()">
                @if (loadingMore()) {
                  <span class="fm-more__spin" aria-hidden="true"></span> Loading…
                } @else {
                  <mat-icon aria-hidden="true">expand_more</mat-icon> Load older
                }
              </button>
            </div>
          } @else {
            <p class="fm-foot" aria-hidden="true">You're all caught up · only sharers in your circle appear</p>
          }
        }
      </div>
    </app-bs-pull-refresh>
  `,
})
export class FeedMobilePage {
  private api = inject(Api);
  readonly auth = inject(AuthService);

  readonly items = signal<FeedItem[]>([]);
  readonly loading = signal(true);
  readonly errored = signal(false);
  /** Pull-to-refresh spinner (a reload over an already-loaded feed). */
  readonly refreshing = signal(false);

  /** Keyset cursor for the next (older) page; null once we've reached the end. */
  readonly nextBefore = signal<number | null>(null);
  /** Whether a "load older" page is in flight (so the button can't double-fire). */
  readonly loadingMore = signal(false);
  /** Set when a "load older" fails, so the row can offer a retry without wiping the loaded feed. */
  readonly moreError = signal(false);

  private static readonly PAGE = 30;

  /** Stable rows for the loading skeleton. */
  readonly skeletonRows = Array.from({ length: 6 }, (_, i) => i);

  /** Whether the caller has opted into VIEWING the circle feed (else they only see their own events). */
  readonly viewsCircle = computed(() => this.auth.session()?.viewActivityFeed === true);

  /** Whether there's another page to load (drives the "load older" affordance). */
  readonly hasMore = computed(() => this.nextBefore() != null);

  /** Whether the feed is loaded but empty (drives the empty state). */
  readonly isEmpty = computed(() => !this.loading() && !this.errored() && this.items().length === 0);

  readonly timeAgo = timeAgo;

  constructor() {
    this.reload();
  }

  /**
   * Initial load + pull-to-refresh. Shows the full skeleton on the first load, the pull spinner on a
   * refresh over an already-loaded feed; resets the keyset cursor either way.
   */
  async reload(): Promise<void> {
    const wasLoaded = this.items().length > 0;
    if (wasLoaded) this.refreshing.set(true); else this.loading.set(true);
    this.errored.set(false);
    this.moreError.set(false);
    try {
      const page = await firstValueFrom(this.api.feed({ limit: FeedMobilePage.PAGE }));
      this.items.set(page?.items ?? []);
      this.nextBefore.set(page?.nextBefore ?? null);
    } catch {
      // Keep any already-loaded feed on a failed refresh; only surface the error state on a cold load.
      if (!wasLoaded) this.errored.set(true);
    } finally {
      this.loading.set(false);
      this.refreshing.set(false);
    }
  }

  /** Fetch the next (older) page and append it (keyset paging). No-op once the cursor is exhausted. */
  loadMore(): void {
    const before = this.nextBefore();
    if (before == null || this.loadingMore()) return;
    this.loadingMore.set(true);
    this.moreError.set(false);
    this.api
      .feed({ before, limit: FeedMobilePage.PAGE })
      .pipe(
        catchError(() => {
          this.moreError.set(true);
          return of(null);
        }),
      )
      .subscribe((page) => {
        if (page) {
          this.items.update((cur) => [...cur, ...(page.items ?? [])]);
          this.nextBefore.set(page.nextBefore ?? null);
        }
        this.loadingMore.set(false);
      });
  }

  /**
   * Toggle the caller's cheer (👏) on a row. Optimistically flips iReacted + clapCount immediately (the
   * groups computed re-derives), then reconciles with the server's authoritative count — or rolls back on
   * error. The server enforces that the caller may only cheer an event they can see. Guards re-entrancy per
   * row so a double-tap can't desync the count.
   */
  cheer(item: FeedItemVm): void {
    const id = item.id;
    if (this.cheering.has(id)) return;
    this.cheering.add(id);

    const before = this.items().find((i) => i.id === id);
    const wasReacted = before?.iReacted ?? false;
    const prevCount = before?.clapCount ?? 0;

    // Optimistic flip.
    this.patch(id, { iReacted: !wasReacted, clapCount: prevCount + (wasReacted ? -1 : 1) });

    this.api
      .reactFeed(id)
      .pipe(
        catchError(() => {
          // Roll back to the pre-tap state on failure.
          this.patch(id, { iReacted: wasReacted, clapCount: prevCount });
          return of(null);
        }),
      )
      .subscribe((res) => {
        if (res) this.patch(id, { iReacted: res.iReacted, clapCount: res.clapCount });
        this.cheering.delete(id);
      });
  }

  /** Rows whose cheer toggle is in flight (re-entrancy guard; not in a signal — it never affects render). */
  private readonly cheering = new Set<number>();

  /** Merge a partial update into the row with this id (the view/groups computeds re-derive from items). */
  private patch(id: number, change: Partial<FeedItem>): void {
    this.items.update((cur) => cur.map((i) => (i.id === id ? { ...i, ...change } : i)));
  }

  // ─────────────── DISPLAY PROJECTION (copied from the live feed.ts) ───────────────

  /** Two-letter initials for the avatar fallback (name only — no email is ever on the wire). */
  private static initialsOf(name: string): string {
    const parts = (name || '').split(/\s+/).filter(Boolean);
    return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || 'U';
  }

  /** A Material icon glyph for the kind (falls back to a generic activity glyph). */
  private static iconOf(kind: string): string {
    switch (kind) {
      case 'workout.logged':
        return 'fitness_center';
      case 'challenge.dayComplete':
        return 'military_tech';
      case 'challenge.started':
        return 'flag';
      case 'hydration.goalHit':
        return 'local_drink';
      default:
        return 'bolt';
    }
  }

  /** A short, stable tone token per kind, used purely for the per-kind badge tint. */
  private static toneOf(kind: string): string {
    switch (kind) {
      case 'workout.logged':
        return 'workout';
      case 'challenge.dayComplete':
      case 'challenge.started':
        return 'challenge';
      case 'hydration.goalHit':
        return 'hydration';
      default:
        return 'generic';
    }
  }

  /**
   * The humane verb phrase for a row. Counts/labels only — never raw private content. The third-person
   * possessive ("their water goal") keeps it natural regardless of who the actor is.
   */
  private static verbOf(item: FeedItem): string {
    switch (item.kind) {
      case 'workout.logged': {
        const name = (item.label ?? '').trim();
        const mins = item.intValue;
        if (name && mins) return `logged a ${mins}-minute ${name}`;
        if (name) return `logged a workout: ${name}`;
        if (mins) return `logged a ${mins}-minute workout`;
        return 'logged a workout';
      }
      case 'challenge.dayComplete':
        return item.intValue ? `completed 75-Hard day ${item.intValue}` : 'completed a 75-Hard day';
      case 'challenge.started':
        return 'started the 75-Hard challenge';
      case 'hydration.goalHit':
        return 'hit their water goal';
      default:
        return 'shared an activity';
    }
  }

  /** Items projected for the template (initials + verb + icon + tone). */
  private readonly view = computed<FeedItemVm[]>(() =>
    this.items().map((i) => ({
      ...i,
      initials: FeedMobilePage.initialsOf(i.actorName),
      verb: FeedMobilePage.verbOf(i),
      icon: FeedMobilePage.iconOf(i.kind),
      tone: FeedMobilePage.toneOf(i.kind),
    })),
  );

  /** A short, locale-aware "Today" / "Yesterday" / "Mon, Jun 23" heading for a day key. */
  private static dayLabel(date: Date, now: Date): string {
    const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const diffDays = Math.round((startOf(now) - startOf(date)) / 86_400_000);
    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    return date.toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric',
    });
  }

  /** The view grouped by local day, newest day first (rows within a day stay newest-first). */
  readonly groups = computed<FeedDayGroup[]>(() => {
    const now = new Date();
    const out: FeedDayGroup[] = [];
    let cur: FeedDayGroup | null = null;
    for (const item of this.view()) {
      const d = new Date(item.createdUtc);
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      if (!cur || cur.key !== key) {
        cur = { key, label: FeedMobilePage.dayLabel(d, now), items: [] };
        out.push(cur);
      }
      cur.items.push(item);
    }
    return out;
  });

  /** A full aria label for a row (the row is avatar-led, so it names itself for screen readers). */
  rowAria(item: FeedItemVm): string {
    const cheers = item.clapCount > 0 ? `, ${item.clapCount} cheer${item.clapCount === 1 ? '' : 's'}` : '';
    return `${item.actorName} ${item.verb}, ${this.timeAgo(item.createdUtc)}${cheers}`;
  }
}
