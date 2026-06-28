import { Component, computed, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { catchError, of } from 'rxjs';

import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';

import { Api } from '../../core/api';
import { AuthService } from '../../core/auth';
import { FeedItem } from '../../core/models';
import { timeAgo } from '../../shared/format';
import { FeedComments } from './feed-comments';
import { BetaEmptyState, BetaErrorState } from '../beta-ui';

/** A feed item enriched with the derived bits the row template needs. */
interface FeedItemVm extends FeedItem {
  /** Two-letter avatar initials (from the display name — never an email). */
  initials: string;
  /** The humane verb phrase ("logged a workout", "completed 75-Hard day 12", "hit their water goal"). */
  verb: string;
  /** A Material icon glyph for the kind. */
  icon: string;
}

/** Feed items grouped under a day heading ("Today" / "Yesterday" / a date), newest day first. */
interface FeedDayGroup {
  /** A stable key for trackBy (the local date string). */
  key: string;
  /** The human heading ("Today", "Yesterday", or "Mon, Jun 23"). */
  label: string;
  items: FeedItemVm[];
}

/**
 * The circle ACTIVITY FEED (/feed) — a reverse-chron, day-grouped feed of the caller's circle activity
 * (GET /api/feed). DISTINCT from the admin audit page at /activity (the RequestLog trail). Each row is an
 * actor avatar + DisplayName-formatted name + a humane verb phrase + relative time.
 *
 * PRIVACY: the server enforces all gating — events only appear for actors who opted to SHARE and are in
 * the caller's circle (plus the caller's own events always), and only when the caller opted to VIEW.
 * Rows carry an AppUser id + display name (never an email) and only the non-sensitive int/label payload
 * (a duration, a day number, an exercise name) — never raw private content, amounts, or health detail.
 *
 * Purely additive + read-only: it reuses the tracker.self permission and the existing keyset-paging shape.
 */
@Component({
  selector: 'app-feed',
  imports: [MatButtonModule, MatIconModule, MatProgressSpinnerModule, FeedComments, BetaEmptyState, BetaErrorState],
  templateUrl: './feed.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './feed.scss',
})
export class Feed {
  private api = inject(Api);
  readonly auth = inject(AuthService);

  readonly items = signal<FeedItem[]>([]);
  readonly loading = signal(true);
  readonly error = signal(false);
  /** Keyset cursor for the next (older) page; null once we've reached the end. */
  readonly nextBefore = signal<number | null>(null);
  /** Whether a "load more" page is in flight (so the button can't double-fire). */
  readonly loadingMore = signal(false);
  /** Set when a "load more" fails, so the row can offer a retry without wiping the loaded feed. */
  readonly moreError = signal(false);

  private static readonly PAGE = 30;

  /** Whether the caller has opted into VIEWING the circle feed (else they only see their own events). */
  readonly viewsCircle = computed(() => this.auth.session()?.viewActivityFeed === true);

  constructor() {
    this.load();
  }

  /** Initial load (shows the spinner). */
  load(): void {
    this.loading.set(true);
    this.error.set(false);
    this.moreError.set(false);
    this.api
      .feed({ limit: Feed.PAGE })
      .pipe(
        catchError(() => {
          this.error.set(true);
          return of(null);
        }),
      )
      .subscribe((page) => {
        if (page) {
          this.items.set(page.items);
          this.nextBefore.set(page.nextBefore);
        }
        this.loading.set(false);
      });
  }

  /** Fetch the next (older) page and append it (keyset paging). No-op once the cursor is exhausted. */
  loadMore(): void {
    const before = this.nextBefore();
    if (before == null || this.loadingMore()) return;
    this.loadingMore.set(true);
    this.moreError.set(false);
    this.api
      .feed({ before, limit: Feed.PAGE })
      .pipe(
        catchError(() => {
          this.moreError.set(true);
          return of(null);
        }),
      )
      .subscribe((page) => {
        if (page) {
          this.items.update((cur) => [...cur, ...page.items]);
          this.nextBefore.set(page.nextBefore);
        }
        this.loadingMore.set(false);
      });
  }

  /**
   * Toggle the caller's cheer (👏) on a row. Optimistically flips iReacted + clapCount immediately (the
   * view/groups computeds re-derive), then reconciles with the server's authoritative count — or rolls back
   * on error. The server enforces that the caller may only cheer an event they can see; a failure leaves the
   * row as it was. Guards re-entrancy per row so a double-tap can't desync the count.
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

  /** Whether there's another page to load (drives the "load more" affordance). */
  readonly hasMore = computed(() => this.nextBefore() != null);

  /** Whether the feed is loaded but empty (drives the empty state). */
  readonly isEmpty = computed(() => !this.loading() && !this.error() && this.items().length === 0);

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

  /** Items projected for the template (initials + verb + icon). */
  private readonly view = computed<FeedItemVm[]>(() =>
    this.items().map((i) => ({
      ...i,
      initials: Feed.initialsOf(i.actorName),
      verb: Feed.verbOf(i),
      icon: Feed.iconOf(i.kind),
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
        cur = { key, label: Feed.dayLabel(d, now), items: [] };
        out.push(cur);
      }
      cur.items.push(item);
    }
    return out;
  });

  readonly timeAgo = timeAgo;

  /** Stable trackBys. */
  trackGroup = (_: number, g: FeedDayGroup) => g.key;
  trackItem = (_: number, i: FeedItemVm) => i.id;
}
