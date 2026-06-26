import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal, viewChildren } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { catchError, of } from 'rxjs';

import { Api } from '../../core/api';
import { AuthService } from '../../core/auth';
import { ChallengeStore } from '../../core/challenge-store';
import { FamilyToday, PERM } from '../../core/models';
import { TrackerStore } from '../../core/tracker-store';
import { BetaPullRefresh } from '../beta-ui';

import { AtriumLayoutStore, AtriumWidgetId } from './widgets/layout-store';
import { RingsWidget } from './widgets/rings-widget';
import { HardWidget } from './widgets/hard-widget';
import { EventWidget } from './widgets/event-widget';
import { PresenceWidget } from './widgets/presence-widget';
import { SpendWidget } from './widgets/spend-widget';
import { ActivityWidget } from './widgets/activity-widget';

/**
 * Home "Atrium" — a NEW, beta-only cross-domain glance surface, rebuilt onto the shared beta-ui "Strata"
 * foundation (`@use '../beta-ui/beta-kit'`). One widget per domain the user actually has (rings, 75-Hard,
 * next event, who's online, spend, recent activity) on a single thumb-scroll column, each elevated from a
 * flat card to a DEPTH surface (glass/rise + lift + a gradient hairline edge + accent glow + spring
 * entrance). HOME owns its signature accent — a violet→blue gradient — overriding the kit default.
 *
 * The scroll column IS the kit `BetaPullRefresh` (a live accent ring tracks the pull, spins while a
 * refresh is in flight). An immersive page header (greeting + date + quick actions) replaces reliance on
 * the global app bar, respecting safe-area.
 *
 * HARD ISOLATION: this is additive + gated by `beta.access`. It reuses root stores
 * ({@link TrackerStore}/{@link ChallengeStore}) and {@link Api} READ-ONLY (+ the one existing
 * `addHydration` action). No live page or component is modified; the flagship tracker-beta is untouched.
 *
 * RESILIENCE: every widget loads best-effort in parallel — store-backed widgets fire `store.load()` in
 * their own constructors; Api-backed widgets own a `catchError(of(null))` subscription each. Each widget
 * renders its own skeleton/empty/failed state, and a widget AUTO-HIDES when its perm is missing (the
 * page's per-id gates below) so one dead domain never blanks the page. Pull-to-refresh re-runs all loads.
 */
@Component({
  selector: 'app-beta-home',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './beta-home.page.scss',
  imports: [
    RouterLink, MatIconModule, BetaPullRefresh,
    RingsWidget, HardWidget, EventWidget, PresenceWidget, SpendWidget, ActivityWidget,
  ],
  template: `
    <!-- The scroll column IS the kit pull-to-refresh (it owns overflow + the live accent spinner). -->
    <app-bs-pull-refresh class="atr-ptr" [busy]="refreshing()" (refresh)="refreshAll()">
      <div class="atr-scroll">

        <!-- Immersive page header — greeting + date + quick actions. Scrolls with the column (not the
             global app bar), with an accent bloom behind it; reserves safe-area at the top. -->
        <header class="hh">
          <div class="hh__bloom" aria-hidden="true"></div>
          <div class="hh__row">
            <div class="hh__text">
              @if (dateLabel(); as dl) { <span class="hh__date">{{ dl }}</span> }
              <h1 class="hh__greet">{{ greeting() || 'Welcome back' }}</h1>
            </div>
            <div class="hh__actions">
              @if (layout.reordering()) {
                <button type="button" class="hh__btn hh__btn--primary" (click)="layout.setReorder(false)">Done</button>
              } @else {
                <button type="button" class="hh__btn" (click)="layout.toggleReorder()"
                        aria-label="Customize tiles — reorder or hide">
                  <mat-icon aria-hidden="true">dashboard_customize</mat-icon>
                </button>
                <a class="hh__btn" routerLink="/settings" aria-label="Settings">
                  <mat-icon aria-hidden="true">settings</mat-icon>
                </a>
              }
            </div>
          </div>
          <!-- Quick actions — perm-gated chips deep-linking to the caller's common tasks. Only the chips
               whose feature perm the session holds render (recomputed on permission change). -->
          @if (quickActions(); as qa) {
            @if (qa.length) {
              <div class="hh__quick">
                @for (a of qa; track a.route) {
                  <a class="hh__chip" [routerLink]="a.route"><mat-icon aria-hidden="true">{{ a.icon }}</mat-icon> {{ a.label }}</a>
                }
              </div>
            }
          }

          <!-- "This week" mini-glance — reuses the 75-Hard data the hard widget already loaded into the
               shared ChallengeStore (no extra fetch). Hidden until a challenge exists. -->
          @if (weekGlance(); as wg) {
            <a class="hh__glance" routerLink="/challenge" aria-label="This week on 75 Hard">
              <mat-icon aria-hidden="true">local_fire_department</mat-icon>
              <span class="hh__glance-txt">{{ wg }}</span>
              <mat-icon class="hh__glance-go" aria-hidden="true">chevron_right</mat-icon>
            </a>
          }
        </header>

        @if (layout.reordering()) {
          <p class="atr-hint">
            <mat-icon aria-hidden="true">drag_indicator</mat-icon>
            Reorder mode — use the arrows to move cards, the eye to hide.
            @if (hiddenCount()) { <button type="button" class="atr-hint__reset" (click)="layout.reset()">Reset all</button> }
          </p>
        }

        <!-- Staggered spring entrance: each card animates in on a per-index delay (--i). -->
        @for (id of cards(); track id; let i = $index) {
          <div class="atr-card-in" [style.--i]="i" [class.atr-defer]="i >= 2">
            @switch (id) {
              @case ('rings') {
                <atr-rings-widget [reordering]="layout.reordering()"
                  (moveUp)="layout.moveUp('rings')" (moveDown)="layout.moveDown('rings')" (hide)="layout.toggle('rings')" />
              }
              @case ('hard') {
                <atr-hard-widget [reordering]="layout.reordering()"
                  (moveUp)="layout.moveUp('hard')" (moveDown)="layout.moveDown('hard')" (hide)="layout.toggle('hard')" />
              }
              @case ('event') {
                <atr-event-widget [reordering]="layout.reordering()"
                  (moveUp)="layout.moveUp('event')" (moveDown)="layout.moveDown('event')" (hide)="layout.toggle('event')" />
              }
              @case ('presence') {
                <atr-presence-widget [reordering]="layout.reordering()"
                  (moveUp)="layout.moveUp('presence')" (moveDown)="layout.moveDown('presence')" (hide)="layout.toggle('presence')" />
              }
              @case ('spend') {
                <atr-spend-widget [reordering]="layout.reordering()"
                  (moveUp)="layout.moveUp('spend')" (moveDown)="layout.moveDown('spend')" (hide)="layout.toggle('spend')" />
              }
              @case ('activity') {
                <atr-activity-widget [reordering]="layout.reordering()"
                  (moveUp)="layout.moveUp('activity')" (moveDown)="layout.moveDown('activity')" (hide)="layout.toggle('activity')" />
              }
            }
          </div>
        }

        @if (!anyVisible()) {
          <div class="atr-empty">
            <span class="atr-empty__ic" aria-hidden="true"><mat-icon>dashboard_customize</mat-icon></span>
            <p class="atr-empty__msg">No widgets to show. Open the rearrange menu to turn some back on, or
              grab more permissions to unlock domains.</p>
            <button type="button" class="atr-empty__btn" (click)="layout.toggleReorder()">Rearrange</button>
          </div>
        }
      </div>
    </app-bs-pull-refresh>
  `,
})
export class BetaHomePage {
  private readonly api = inject(Api);
  private readonly auth = inject(AuthService);
  private readonly tracker = inject(TrackerStore);
  private readonly challenge = inject(ChallengeStore);
  private readonly destroyRef = inject(DestroyRef);

  /** Layout (order + on/off + reorder mode) is provided at the route — beta-only, never global. */
  readonly layout = inject(AtriumLayoutStore);

  /** True while a pull-to-refresh is in flight — drives the kit pull-refresh spinner. */
  readonly refreshing = signal(false);

  /** The Api-backed children that own their own fetch; pull-to-refresh re-runs their `reload()`. */
  private readonly eventWidgets = viewChildren(EventWidget);
  private readonly presenceWidgets = viewChildren(PresenceWidget);
  private readonly spendWidgets = viewChildren(SpendWidget);
  private readonly activityWidgets = viewChildren(ActivityWidget);

  private readonly today = signal<FamilyToday | null>(null);

  /**
   * Time-aware greeting computed CLIENT-SIDE from the local hour + the caller's own display name, so it
   * works the instant the page paints (no dependency on the best-effort family/today fetch, which the old
   * `today()?.greeting` relied on — that left "Welcome back" showing whenever that endpoint was slow/down
   * or the caller lacked family access). Falls back to a name-less greeting, then to "Welcome back".
   */
  readonly greeting = computed(() => {
    this.auth.session(); // re-run if the display name changes
    const part = this.dayPart();
    const name = this.firstName();
    return name ? `Good ${part}, ${name}` : `Good ${part}`;
  });

  /** "morning" | "afternoon" | "evening" from the device's local hour. */
  private dayPart(): 'morning' | 'afternoon' | 'evening' {
    const h = new Date().getHours();
    if (h < 12) return 'morning';
    if (h < 18) return 'afternoon';
    return 'evening';
  }

  /** The caller's own first name for the greeting — nickname (if chosen) else the first token of `name`. */
  private firstName(): string {
    const s = this.auth.session();
    if (!s) return '';
    const raw = (s.displayNameMode === 'nickname' && s.nickname) ? s.nickname : (s.name || '');
    const first = raw.trim().split(/\s+/)[0] ?? '';
    return first;
  }

  /** Friendly "Thursday, June 23" — COPIED from family-home.ts:127 (not imported). */
  readonly dateLabel = computed<string>(() => {
    const iso = this.today()?.dateLocal;
    if (!iso) return '';
    const d = new Date(`${iso}T00:00:00`);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  });

  /** Per-widget permission gate (the page's auto-hide). Re-runs on permission change. The data-null
   *  auto-hide (e.g. no challenge, no one online) is handled inside each widget's own phase/visible. */
  gate(id: AtriumWidgetId): boolean {
    this.auth.permissions(); // re-run on change
    switch (id) {
      case 'rings': return this.auth.hasPermission(PERM.trackerSelf);
      case 'hard': return this.auth.hasPermission(PERM.trackerSelf);
      case 'event': return true;     // family/today is broadly readable; widget self-empties otherwise
      case 'presence': return true;  // presence is available to any signed-in user
      case 'spend': return this.auth.hasPermission(PERM.familyFinance);
      case 'activity': return this.auth.hasPermission(PERM.activityView);
      default: return false;
    }
  }

  readonly hiddenCount = computed(() => this.layout.hidden().size);

  /** True if at least one ordered+enabled widget also passes its perm gate. */
  readonly anyVisible = computed(() => {
    this.auth.permissions();
    return this.layout.visibleOrder().some(id => this.gate(id));
  });

  /** The ordered, gated, enabled widget ids the page should render (drives @for + the entrance stagger). */
  readonly cards = computed<AtriumWidgetId[]>(() => {
    this.auth.permissions();
    return this.layout.visibleOrder().filter(id => this.gate(id));
  });

  /**
   * Quick-action chips deep-linking to the caller's common tasks. Each entry declares the perm it needs;
   * a chip renders ONLY when the session holds it (recomputed on permission change). This replaces the
   * three static chips that linked to pages a given user might not even have access to.
   */
  readonly quickActions = computed<{ label: string; icon: string; route: string }[]>(() => {
    this.auth.permissions();
    const has = (p: string) => this.auth.hasPermission(p);
    const out: { label: string; icon: string; route: string }[] = [];
    if (has(PERM.trackerSelf)) out.push({ label: 'Log food', icon: 'add', route: '/tracker' });
    if (has(PERM.mealsUse)) out.push({ label: 'Meals', icon: 'restaurant_menu', route: '/beta/meals' });
    if (has(PERM.billsUse)) out.push({ label: 'Add bill', icon: 'receipt_long', route: '/beta/bills' });
    if (has(PERM.automationsUse)) out.push({ label: 'Automate', icon: 'bolt', route: '/beta/automations' });
    if (has(PERM.trackerAi)) out.push({ label: 'Ask', icon: 'auto_awesome', route: '/beta/ask' });
    if (has(PERM.trackerSelf)) out.push({ label: '75 Hard', icon: 'local_fire_department', route: '/challenge' });
    return out;
  });

  /**
   * A "this week" mini-glance built from the 75-Hard data the hard widget already loaded into the shared
   * {@link ChallengeStore} — NO extra fetch. Null (and so hidden) until a challenge is loaded and the
   * caller can see it; otherwise a compact streak + completed-days line.
   */
  readonly weekGlance = computed<string | null>(() => {
    this.auth.permissions();
    if (!this.auth.hasPermission(PERM.trackerSelf)) return null;
    const c = this.challenge.challenge();
    if (!c || c.currentDay <= 0) return null;
    const streak = c.currentStreak > 0
      ? `${c.currentStreak}-day streak`
      : 'Streak reset — back on it today';
    // `completedDays`/`totalDays` are required on the DTO, but guard anyway so a partial payload can never
    // render a literal "undefined" in the glance — fall back to just the streak line.
    const perfect = Number.isFinite(c.completedDays) && Number.isFinite(c.totalDays)
      ? ` · ${c.completedDays} of ${c.totalDays} days perfect`
      : '';
    return `${streak}${perfect}`;
  });

  constructor() {
    // Top-bar greeting/date — best-effort, never blocks the column.
    this.loadToday();
    // Drive the shared ChallengeStore so the header "this week" glance is populated even if the user has
    // reordered the 75-Hard widget off (the widget would otherwise be the only loader). Same read-only
    // load() the widget makes; gated on the same perm; best-effort.
    if (this.auth.hasPermission(PERM.trackerSelf)) {
      void this.challenge.load();
    }
    // Store-backed widgets each call load() in their own constructor; nothing else to kick off here.
  }

  private loadToday(): void {
    this.api.familyToday()
      .pipe(catchError(() => of<FamilyToday | null>(null)), takeUntilDestroyed(this.destroyRef))
      .subscribe(t => { if (t) this.today.set(t); });
  }

  /**
   * Pull-to-refresh: re-run the store loads (rings/hard read the shared signals) and re-fetch the
   * top-bar. Api-backed widgets re-subscribe via their own retry; here we refresh the shared sources and
   * the greeting. Best-effort and parallel — a failure in one source never aborts the others. Flips the
   * `refreshing` signal so the kit pull-refresh spinner shows until everything settles.
   */
  async refreshAll(): Promise<void> {
    this.refreshing.set(true);
    try {
      this.loadToday();
      // Api-backed children re-fetch via their own reload (each catches its own error).
      this.eventWidgets().forEach(w => w.reload());
      this.presenceWidgets().forEach(w => w.reload());
      this.spendWidgets().forEach(w => w.reload());
      this.activityWidgets().forEach(w => w.reload());
      // Store-backed widgets read the shared signals these refresh.
      await Promise.allSettled([
        this.tracker.load(),
        this.challenge.load(),
      ]);
    } finally {
      this.refreshing.set(false);
    }
  }
}
