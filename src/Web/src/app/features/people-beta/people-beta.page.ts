import {
  ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { catchError, firstValueFrom, of, timer } from 'rxjs';

import { Api } from '../../core/api';
import { AuthService } from '../../core/auth';
import { NudgeKind, PERM, PersonDto } from '../../core/models';
import {
  BetaPullRefresh, BetaSegmentedControl, BetaSkeleton, BetaSwipeRow, BetaToaster, ToastController,
  type Segment,
} from '../beta-ui';

import { PersonVm, alphaSort, matchesQuery, rosterSort, toVm } from './people-beta.model';
import { CircleRow } from './components/person-row';
import { CircleSheet } from './components/person-sheet';

/** Which slice of the caller's people the roster shows. */
type Filter = 'all' | 'contacts' | 'family';

/** How the roster is ordered: ONLINE-FIRST (grouped) or strict A–Z (one flat list). */
type SortMode = 'online' | 'az';

/**
 * People "Circle" — the mobile-first SOCIAL roster, built on the shared beta-ui "Strata" kit
 * (`@use '../beta-ui/beta-kit'`). One signature accent — a warm ROSE (rose → red) — re-skins the whole
 * screen via the per-page contract. An immersive header carries a "who's online" hero count + a stack
 * of overlapping online avatars; the kit BetaSegmentedControl flips All / Contacts / Family. Below, the
 * roster is ONLINE-FIRST: an "Online now" group, then "Everyone", each a list of rich BetaSwipeRow
 * rows (colored ringed avatar, DisplayName — NEVER an email, live presence dot + "active Xm ago", a
 * coarse city when shared, relationship chips). A row TAP opens the quick-action sheet (Message / Nudge
 * / On map); a row SWIPE reveals the same Message (right) / Nudge (left) shortcuts. Pull-to-refresh,
 * spring-stagger entrance, BetaSkeleton loaders, a tasteful empty state.
 *
 * DATA PARITY: every figure comes from the SAME endpoint the live `/people` uses — `Api.people` (the
 * contacts ∪ household aggregation, de-duplicated over the single AppUser spine + live presence),
 * `Api.openDirect` (the DM deep-link → /chat?c=), and `Api.nudge` (the four canned, injection-safe
 * templates). The server owns all aggregation + the DM/circle/cooldown gates; this page only reads them
 * (canDm/sharesLocation/isContact/isHousehold) so it never offers an action that 403s/404s.
 *
 * ISOLATION: gated by `beta.access` + any-of `chat.read | family.use` (mirrors GET /api/people exactly,
 * plus the Beta section gate). It consumes the kit + the SAME read/light-write Api as the live page; no
 * live page is imported or modified, and it defines its OWN rose accent on `:host`. State lives in this
 * page's signals; the only route-level provider is its own ToastController. A light presence poll (~25s)
 * + a clock-only tick (~15s) keep the dots + "active …" labels live, matching the live page's rhythm.
 */
@Component({
  selector: 'app-people-beta',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [ToastController],
  imports: [
    MatIconModule, BetaPullRefresh, BetaSegmentedControl, BetaSkeleton, BetaSwipeRow, BetaToaster,
    CircleRow, CircleSheet,
  ],
  template: `
    <app-bs-pull-refresh class="pl-ptr" [busy]="refreshing()" (refresh)="refreshAll()">
      <div class="pl-scroll">

        <!-- Immersive header: who's-online hero count + overlapping avatars + accent bloom. -->
        <header class="hh">
          <div class="hh__bloom" aria-hidden="true"></div>
          <div class="hh__row">
            <div class="hh__text">
              <span class="hh__eyebrow"><span class="hh__spark" aria-hidden="true"></span> Your circle</span>
              <h1 class="hh__title">Circle</h1>
            </div>
            <div class="hh__count" [class.hh__count--zero]="onlineCount() === 0">
              <span class="hh__count-n">{{ onlineCount() }}</span>
              <span class="hh__count-l">online</span>
            </div>
          </div>

          <!-- Overlapping live avatars + a one-line glance. -->
          <div class="hh__hero">
            @if (onlineStack().length > 0) {
              <div class="hh__stack" aria-hidden="true">
                @for (p of onlineStack(); track p.userId; let i = $index) {
                  <span class="hh__face" [style.--i]="i" [style.--hue]="p.hue">
                    @if (p.picture) { <img [src]="p.picture" alt="" referrerpolicy="no-referrer" /> }
                    @else { <span class="hh__face-init">{{ p.initials }}</span> }
                  </span>
                }
                @if (onlineOverflow() > 0) { <span class="hh__face hh__face--more" [style.--i]="onlineStack().length">+{{ onlineOverflow() }}</span> }
              </div>
              <p class="hh__hero-msg">{{ heroMsg() }}</p>
            } @else if (!loading()) {
              <p class="hh__hero-msg hh__hero-msg--quiet">
                <mat-icon aria-hidden="true">nights_stay</mat-icon> No one's around right now — it's quiet.
              </p>
            }
          </div>

          <!-- Compact stat strip — online · contacts · family, from the loaded roster. -->
          @if (!loading() && !error()) {
            <p class="hh__stats" role="status" aria-live="polite">
              <span class="hh__stat"><strong>{{ stats().online }}</strong> online</span>
              <span class="hh__stat-sep" aria-hidden="true">·</span>
              <span class="hh__stat"><strong>{{ stats().contacts }}</strong> contacts</span>
              <span class="hh__stat-sep" aria-hidden="true">·</span>
              <span class="hh__stat"><strong>{{ stats().family }}</strong> family</span>
            </p>
          }

          <!-- All / Contacts / Family. -->
          <app-bs-segmented class="hh__seg" [segments]="segments()" [value]="filter()"
                            label="Filter people" (change)="setFilter($event)" />

          <!-- Live name search + order toggle. -->
          <div class="hh__tools">
            <div class="hh__search" [class.hh__search--filled]="query().length > 0">
              <mat-icon class="hh__search-ic" aria-hidden="true">search</mat-icon>
              <input class="hh__search-in" type="search" inputmode="search" autocomplete="off"
                     placeholder="Search your circle" aria-label="Search your circle by name"
                     [value]="query()" (input)="onSearch($any($event.target).value)" />
              @if (query().length > 0) {
                <button type="button" class="hh__search-x" aria-label="Clear search" (click)="clearQuery()">
                  <mat-icon aria-hidden="true">close</mat-icon>
                </button>
              }
            </div>
            <app-bs-segmented class="hh__sort" [segments]="sortSegments" [value]="sortMode()"
                              label="Sort order" (change)="setSort($event)" />
          </div>
        </header>

        <!-- Loading skeletons. -->
        @if (loading()) {
          <div class="pl-skel">
            @for (s of [0,1,2,3,4]; track s) {
              <div class="pl-skel-row">
                <app-bs-skeleton width="48px" height="48px" [circle]="true" />
                <div class="pl-skel-lines">
                  <app-bs-skeleton width="55%" height="14px" />
                  <app-bs-skeleton width="38%" height="11px" />
                </div>
              </div>
            }
          </div>
        } @else if (error()) {
          <div class="pl-state">
            <span class="pl-state-ic" aria-hidden="true"><mat-icon>cloud_off</mat-icon></span>
            <p class="pl-state-msg">We couldn't load your people just now.</p>
            <button type="button" class="pl-state-btn" (click)="reload(true)">
              <mat-icon aria-hidden="true">refresh</mat-icon> Try again
            </button>
          </div>
        } @else if (noMatches()) {
          <div class="pl-state">
            <span class="pl-state-ic" aria-hidden="true"><mat-icon>person_search</mat-icon></span>
            <p class="pl-state-msg">No one matches “{{ query().trim() }}”.</p>
            <button type="button" class="pl-state-btn" (click)="clearQuery()">
              <mat-icon aria-hidden="true">close</mat-icon> Clear search
            </button>
          </div>
        } @else if (isEmpty()) {
          <div class="pl-state">
            <span class="pl-state-ic" aria-hidden="true"><mat-icon>groups</mat-icon></span>
            @switch (filter()) {
              @case ('contacts') { <p class="pl-state-msg">No contacts yet. Once you're connected with someone, they'll show up here.</p> }
              @case ('family') { <p class="pl-state-msg">No household members yet. Set up your household in the Family hub to see everyone here.</p> }
              @default { <p class="pl-state-msg">No people yet. Once you have contacts or a household, your circle appears here.</p> }
            }
          </div>
        } @else {
          <!-- Live "N online now" pulse line — from the already-loaded presence fields, no new endpoint. -->
          @if (sortMode() === 'online' && onlineCount() > 0) {
            <p class="pl-livecount" role="status" aria-live="polite">
              <span class="pl-livecount-pulse" aria-hidden="true"></span>
              <strong>{{ onlineCount() }}</strong> online now
            </p>
          }

          <!-- A–Z mode: one flat alphabetical list. -->
          @if (sortMode() === 'az' && azGroup().length > 0) {
            <section class="pl-group" aria-label="All people A to Z">
              <div class="pl-group-h">
                <span class="pl-group-dot" aria-hidden="true"></span>
                <h2 class="pl-group-t">A–Z</h2>
                <span class="pl-group-c">{{ azGroup().length }}</span>
              </div>
              <div class="pl-rows">
                @for (p of azGroup(); track p.userId; let i = $index) {
                  <div class="pl-row-in" [style.--i]="i">
                    <app-bs-swipe-row [label]="p.name + ' actions'"
                      [leftLabel]="canSwipeNudge(p) ? 'Nudge' : ''" [leftDestructive]="false"
                      [rightLabel]="canSwipeMessage(p) ? 'Message' : ''"
                      [disabled]="!canSwipeNudge(p) && !canSwipeMessage(p)"
                      (swipe)="onSwipe(p, $event)">
                      <app-circle-row [p]="p" [now]="now()" (open)="openSheet(p)" />
                    </app-bs-swipe-row>
                  </div>
                }
              </div>
            </section>
          }

          <!-- ONLINE-FIRST roster: Online now, then Everyone. -->
          @if (onlineGroup().length > 0) {
            <section class="pl-group" aria-label="Online now">
              <div class="pl-group-h">
                <span class="pl-group-pulse" aria-hidden="true"></span>
                <h2 class="pl-group-t">Online now</h2>
                <span class="pl-group-c">{{ onlineGroup().length }}</span>
              </div>
              <div class="pl-rows">
                @for (p of onlineGroup(); track p.userId; let i = $index) {
                  <div class="pl-row-in" [style.--i]="i">
                    <app-bs-swipe-row [label]="p.name + ' actions'"
                      [leftLabel]="canSwipeNudge(p) ? 'Nudge' : ''" [leftDestructive]="false"
                      [rightLabel]="canSwipeMessage(p) ? 'Message' : ''"
                      [disabled]="!canSwipeNudge(p) && !canSwipeMessage(p)"
                      (swipe)="onSwipe(p, $event)">
                      <app-circle-row [p]="p" [now]="now()" (open)="openSheet(p)" />
                    </app-bs-swipe-row>
                  </div>
                }
              </div>
            </section>
          }

          @if (everyoneGroup().length > 0) {
            <section class="pl-group" aria-label="Everyone">
              <div class="pl-group-h">
                <span class="pl-group-dot" aria-hidden="true"></span>
                <h2 class="pl-group-t">{{ onlineGroup().length > 0 ? 'Everyone else' : 'Everyone' }}</h2>
                <span class="pl-group-c">{{ everyoneGroup().length }}</span>
              </div>
              <div class="pl-rows">
                @for (p of everyoneGroup(); track p.userId; let i = $index) {
                  <div class="pl-row-in" [style.--i]="i + onlineGroup().length">
                    <app-bs-swipe-row [label]="p.name + ' actions'"
                      [leftLabel]="canSwipeNudge(p) ? 'Nudge' : ''" [leftDestructive]="false"
                      [rightLabel]="canSwipeMessage(p) ? 'Message' : ''"
                      [disabled]="!canSwipeNudge(p) && !canSwipeMessage(p)"
                      (swipe)="onSwipe(p, $event)">
                      <app-circle-row [p]="p" [now]="now()" (open)="openSheet(p)" />
                    </app-bs-swipe-row>
                  </div>
                }
              </div>
            </section>
          }
        }
      </div>
    </app-bs-pull-refresh>

    <!-- Row tap-sheet: the quick actions for the active person. -->
    <app-circle-sheet [(open)]="sheetOpen" [p]="activePerson()" [now]="now()"
      [canMessage]="canMessage()" [canNudge]="canNudge()"
      [messaging]="opening() !== null" [nudging]="nudging() !== null"
      (message)="messageActive()" (nudge)="nudgeActive($event)" (map)="viewActiveOnMap()"
      (copyName)="copyActiveName()" />

    <app-bs-toaster />
  `,
  styleUrl: './people-beta.page.scss',
})
export class PeopleBetaPage {
  private readonly api = inject(Api);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastController);
  private readonly destroyRef = inject(DestroyRef);

  /** Max overlapping faces shown in the hero stack before the +N overflow chip. */
  private static readonly STACK_MAX = 5;

  // ---- data state ----
  readonly people = signal<PersonDto[]>([]);
  readonly loading = signal(true);
  readonly error = signal(false);
  readonly refreshing = signal(false);
  /** A clock tick so the relative "active …" labels + derived away states recompute between refreshes. */
  readonly now = signal(Date.now());

  readonly filter = signal<Filter>('all');
  /** Live name search (case-insensitive substring over the DisplayName); '' = no filter. */
  readonly query = signal('');
  /** Roster ordering: online-first (grouped) vs strict A–Z (one flat list). */
  readonly sortMode = signal<SortMode>('online');

  // ---- action state ----
  /** The person whose tap-sheet is open. */
  readonly activePerson = signal<PersonVm | null>(null);
  readonly sheetOpen = signal(false);
  /** AppUser id of an in-flight Message (so a button can't double-fire). */
  readonly opening = signal<number | null>(null);
  /** AppUser id of an in-flight Nudge. */
  readonly nudging = signal<number | null>(null);

  readonly segments = computed<Segment[]>(() => {
    const c = this.counts();
    return [
      { key: 'all', label: `All ${c.all}` },
      { key: 'contacts', label: `Contacts ${c.contacts}` },
      { key: 'family', label: `Family ${c.family}` },
    ];
  });

  /** The order toggle: online-first (default) vs A–Z. */
  readonly sortSegments: Segment[] = [
    { key: 'online', label: 'Online first' },
    { key: 'az', label: 'A–Z' },
  ];

  /** Caller can open DMs at all (chat.send) — re-runs on permission change. */
  readonly canMessage = computed(() => { this.auth.permissions(); return this.auth.hasPermission(PERM.chatSend); });
  /** Caller can nudge at all (chat.send). */
  readonly canNudge = computed(() => { this.auth.permissions(); return this.auth.hasPermission(PERM.chatSend); });

  /** The full roster as view-models at the current tick (self first, online, away, by name). */
  private readonly roster = computed<PersonVm[]>(() => {
    const now = this.now();
    return this.people().map(p => toVm(p, now)).sort(rosterSort);
  });

  /** The active relationship filter + the live name search applied to the roster. */
  private readonly filtered = computed<PersonVm[]>(() => {
    const f = this.filter();
    const q = this.query().trim().toLowerCase();
    return this.roster()
      .filter(p => f === 'all' || (f === 'contacts' ? p.isContact : p.isHousehold))
      .filter(p => matchesQuery(p, q));
  });

  /** True when a search is active and no one in the current filter matches (drives the "no matches" state). */
  readonly noMatches = computed(() =>
    !this.loading() && !this.error() && this.query().trim().length > 0 && this.filtered().length === 0);

  /** In A–Z mode the roster is ONE flat alphabetical list (online grouping suppressed). */
  readonly azGroup = computed(() =>
    this.sortMode() === 'az' ? [...this.filtered()].sort(alphaSort) : []);

  /** The "Online now" group (online OR away) — only in online-first mode. */
  readonly onlineGroup = computed(() =>
    this.sortMode() === 'online' ? this.filtered().filter(p => p.presence !== 'offline') : []);
  /** The "Everyone (else)" group — the offline remainder; only in online-first mode. */
  readonly everyoneGroup = computed(() =>
    this.sortMode() === 'online' ? this.filtered().filter(p => p.presence === 'offline') : []);

  /** Live online count across the WHOLE circle (the hero stat — not filter-scoped, excludes self). */
  readonly onlineCount = computed(() => this.roster().filter(p => !p.isSelf && p.presence !== 'offline').length);
  /** The faces shown overlapping in the hero (online others, capped). */
  readonly onlineStack = computed(() =>
    this.roster().filter(p => !p.isSelf && p.presence !== 'offline').slice(0, PeopleBetaPage.STACK_MAX));
  readonly onlineOverflow = computed(() => Math.max(0, this.onlineCount() - PeopleBetaPage.STACK_MAX));

  /** A friendly one-liner under the hero stack. */
  readonly heroMsg = computed(() => {
    const n = this.onlineCount();
    if (n === 0) return '';
    const names = this.onlineStack().map(p => p.name.split(/\s+/)[0]);
    if (n === 1) return `${names[0]} is around right now.`;
    if (n === 2) return `${names[0]} and ${names[1]} are around.`;
    return `${names[0]}, ${names[1]} and ${n - 2} more are around.`;
  });

  /** Per-filter counts (computed off the full roster, not the filtered view). */
  readonly counts = computed(() => {
    const all = this.roster();
    return {
      all: all.length,
      contacts: all.filter(p => p.isContact).length,
      family: all.filter(p => p.isHousehold).length,
    };
  });

  /** Whether the active filter (with NO search) yields zero people (drives the empty state). */
  readonly isEmpty = computed(() =>
    !this.loading() && !this.error() && this.query().trim().length === 0 && this.filtered().length === 0);

  /** Stat strip under the header: online · contacts · family, all from the loaded roster. */
  readonly stats = computed(() => {
    const all = this.roster();
    return {
      online: all.filter(p => !p.isSelf && p.presence !== 'offline').length,
      contacts: all.filter(p => p.isContact).length,
      family: all.filter(p => p.isHousehold).length,
    };
  });

  constructor() {
    this.reload(true);

    // Refresh presence-bearing data + the clock on a light cadence (~25s) so dots/status stay live without
    // a manual reload, matching the live page's presence poll rhythm. Errors keep the prior list.
    timer(25_000, 25_000).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      this.now.set(Date.now());
      this.silentRefresh();
    });
    // A faster clock-only tick (~15s) keeps "active …" + away fresh between data polls (cheap).
    timer(15_000, 15_000).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.now.set(Date.now()));
  }

  setFilter(f: string): void { this.filter.set(f as Filter); }
  setSort(s: string): void { this.sortMode.set(s as SortMode); }

  /** Bind the search box (native input → signal). */
  onSearch(value: string): void { this.query.set(value); }
  /** Clear the search box (the inline ✕). */
  clearQuery(): void { this.query.set(''); }

  // ---- data load ----
  /** Initial / explicit load (shows the skeletons). */
  reload(initial = false): void {
    if (initial) { this.loading.set(true); this.error.set(false); }
    this.api.people()
      .pipe(catchError(() => { if (initial) this.error.set(true); return of<PersonDto[]>([]); }),
        takeUntilDestroyed(this.destroyRef))
      .subscribe(list => { this.people.set(list); this.loading.set(false); });
  }

  /** Silent background refresh (no skeleton flicker); keeps the prior list on error. */
  private silentRefresh(): void {
    this.api.people()
      .pipe(catchError(() => of<PersonDto[] | null>(null)), takeUntilDestroyed(this.destroyRef))
      .subscribe(list => { if (list) this.people.set(list); });
  }

  /** Pull-to-refresh: re-fetch the roster, flip the spinner, confirm with a toast. */
  async refreshAll(): Promise<void> {
    this.refreshing.set(true);
    this.now.set(Date.now());
    try {
      const list = await firstValueFrom(this.api.people().pipe(catchError(() => of<PersonDto[] | null>(null))));
      if (list) { this.people.set(list); this.error.set(false); }
      this.toast.show('Circle refreshed', { tone: 'success', durationMs: 1600 });
    } catch {
      this.toast.show('Couldn’t refresh — pull again', { tone: 'warn' });
    } finally {
      this.refreshing.set(false);
    }
  }

  // ---- tap-sheet ----
  openSheet(p: PersonVm): void {
    this.activePerson.set(p);
    this.sheetOpen.set(true);
  }

  // ---- swipe shortcuts (mirror the sheet's gates so a swipe never offers a 403/404) ----
  /** Whether a RIGHT swipe (Message) is offered for this person. */
  canSwipeMessage(p: PersonVm): boolean { return p.canDm && this.canMessage(); }
  /** Whether a LEFT swipe (Nudge → "check in") is offered for this person. */
  canSwipeNudge(p: PersonVm): boolean {
    return !p.isSelf && (p.isContact || p.isHousehold) && this.canNudge();
  }

  onSwipe(p: PersonVm, side: 'left' | 'right'): void {
    if (side === 'right') { if (this.canSwipeMessage(p)) this.message(p); }
    else { if (this.canSwipeNudge(p)) this.nudge(p, 'checkIn'); }
  }

  // ---- sheet action proxies ----
  messageActive(): void { const p = this.activePerson(); if (p) this.message(p); }
  nudgeActive(kind: NudgeKind): void { const p = this.activePerson(); if (p) this.nudge(p, kind); }
  viewActiveOnMap(): void { this.sheetOpen.set(false); this.router.navigate(['/family/locations']); }

  /** Copy the active person's DisplayName to the clipboard (no email is ever held client-side). */
  async copyActiveName(): Promise<void> {
    const p = this.activePerson();
    if (!p) return;
    try {
      await navigator.clipboard?.writeText(p.name);
      this.toast.show(`Copied “${p.name}”`, { tone: 'success', durationMs: 1600 });
    } catch {
      this.toast.show('Couldn’t copy the name', { tone: 'warn' });
    }
  }

  /**
   * Open (or fetch the existing) 1:1 DM, then deep-link to /chat?c={id} — reusing POST /api/chat/direct +
   * the existing /chat?c= convention (exactly as the live page does). Only called for a `canDm` person.
   */
  message(p: PersonVm): void {
    if (!p.canDm || !this.canMessage() || this.opening() !== null) return;
    this.opening.set(p.userId);
    this.api.openDirect(p.userId).pipe(catchError(() => of(null))).subscribe(ch => {
      this.opening.set(null);
      if (ch) { this.sheetOpen.set(false); this.router.navigate(['/chat'], { queryParams: { c: ch.id } }); }
      else this.toast.show('Couldn’t open the conversation. Try again.', { tone: 'warn' });
    });
  }

  /**
   * Send a canned NUDGE to a circle peer (POST /api/nudge). The server enforces the circle check, a
   * per-pair cooldown, and the target's opt-out — surfaced here as a friendly toast (`delivered:false`
   * is a no-op, NOT an error). Only called for a non-self circle member.
   */
  nudge(p: PersonVm, kind: NudgeKind): void {
    if (p.isSelf || !(p.isContact || p.isHousehold) || !this.canNudge() || this.nudging() !== null) return;
    this.nudging.set(p.userId);
    this.api.nudge(p.userId, kind).pipe(catchError(() => of(null))).subscribe(res => {
      this.nudging.set(null);
      if (!res) { this.toast.show('Couldn’t send your nudge. Try again.', { tone: 'warn' }); return; }
      this.sheetOpen.set(false);
      this.toast.show(
        res.delivered ? `Nudge sent to ${p.name.split(/\s+/)[0]}.` : `${p.name.split(/\s+/)[0]} was already nudged recently.`,
        { tone: res.delivered ? 'success' : 'neutral', durationMs: 2600 },
      );
    });
  }
}
