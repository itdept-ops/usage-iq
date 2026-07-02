import {
  AfterViewInit,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  HostListener,
  inject,
  signal,
  viewChild,
  ChangeDetectionStrategy,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterOutlet, RouterLink, RouterLinkActive, Router, NavigationEnd } from '@angular/router';
import { timer, switchMap, catchError, of, filter } from 'rxjs';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatMenuModule } from '@angular/material/menu';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatDialog } from '@angular/material/dialog';

import { QuickAddDialog } from './features/family/quick-add-dialog';
import { CommandPalette } from './features/command-palette/command-palette';

import { Api } from './core/api';
import { AuthService } from './core/auth';
import { ThemeService, ThemeMode } from './core/theme';
import { CommandPaletteService } from './core/command-palette';
import { ChatRealtime } from './core/chat-realtime';
import { LocationCapture } from './core/location-capture';
import { ClientInfoCapture } from './core/client-info';
import { SwUpdateService } from './core/sw-update';
import { PwaService } from './core/pwa';
import { PlatformService } from './core/platform';
import { Presence, SyncStatus, PERM, QuickAddResult } from './core/models';
import { HomeOption, HOME_OPTIONS } from './core/home-options';
import { normalizeHome } from './core/nav-model';
import { timeAgo, humanizeInterval } from './shared/format';
import { NotificationBell } from './features/notifications/notification-bell';
import { BETA_EXPERIMENTS, BetaExperiment, canSeeExperiment } from './features/beta/beta-experiments';
import { MobileTopbar } from './features/shell/mobile-topbar/mobile-topbar';
import { BottomTabBar } from './features/shell/bottom-tab-bar/bottom-tab-bar';
import { ThemePicker } from './features/shell/theme-picker/theme-picker';
import { MobileSidebar } from './features/shell/mobile-sidebar/mobile-sidebar';
import { SnapRouteOrchestrator } from './features/snap-route/snap-route-orchestrator';
import { SnapRouteService } from './core/snap-route';
import { GuidedTour } from './features/tour/guided-tour';
import { TourService } from './core/tour';
import { tourForPlatform } from './features/tour/tour-config';

/** A teammate online, enriched with the initials + "you" flag the indicator needs to render. */
interface OnlineUser extends Presence {
  initials: string;
  isYou: boolean;
  /** Derived AWAY state: the caller's own idle flag for their row; for others, a stale-lastSeen threshold. */
  away: boolean;
}

/** A quick-link row in the account menu, shown only when the user holds `perm`. */
interface QuickLink {
  route: string;
  label: string;
  icon: string;
  perm: string | null;
}


@Component({
  selector: 'app-root',
  imports: [
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    MatToolbarModule,
    MatButtonModule,
    MatIconModule,
    MatTooltipModule,
    MatMenuModule,
    NotificationBell,
    CommandPalette,
    MobileTopbar,
    BottomTabBar,
    ThemePicker,
    MobileSidebar,
    SnapRouteOrchestrator,
    GuidedTour,
  ],
  templateUrl: './app.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './app.scss',
})
export class App implements AfterViewInit {
  private api = inject(Api);
  private router = inject(Router);

  /** Captured ONCE at construction (before any navigation can strip the query): did the app open from the
   *  PWA manifest `start_url` ("/?source=pwa")? An installed-app launch reuses the existing session with no
   *  fresh login, so the post-login home redirect never runs — this lets us still honour the saved home. */
  private readonly launchedFromPwa =
    typeof location !== 'undefined' && new URLSearchParams(location.search).get('source') === 'pwa';
  /** Guard so the PWA-launch home redirect fires at most once per app instance. */
  private pwaHomeApplied = false;
  /** Guard so the first-run tour auto-start is attempted at most once per app instance. */
  private tourAutoStartTried = false;
  readonly auth = inject(AuthService);
  private chat = inject(ChatRealtime);
  private locationCapture = inject(LocationCapture);
  private clientInfoCapture = inject(ClientInfoCapture);
  private swUpdate = inject(SwUpdateService);
  readonly pwa = inject(PwaService);
  private snack = inject(MatSnackBar);
  private dialog = inject(MatDialog);
  private host = inject(ElementRef<HTMLElement>);
  /** Observes the live mobile top bar + tab bar so the content frame is sized to their REAL heights
   *  (see {@link measureBars}) instead of hardcoded px — robust across safe-area, font scale, camera-pod
   *  on/off, and rotation. Null where ResizeObserver is unavailable (SSR); the CSS calc is the fallback. */
  private readonly barRO =
    typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => this.measureBars()) : null;
  readonly palette = inject(CommandPaletteService);
  readonly theme = inject(ThemeService);
  readonly platform = inject(PlatformService);
  readonly snapRoute = inject(SnapRouteService);
  private readonly tour = inject(TourService);

  /**
   * Replay the first-run guided tour from the account menu ("Take the tour"). Clears the seen flag and
   * starts the platform-appropriate tour. The mobile tour anchors the bottom-tab bar (present on every
   * in-app route) so it runs anywhere; the desktop tour's first step spotlights the dashboard KPI cards,
   * so a desktop replay from another route lands on '/' first (after a beat for the anchors to mount).
   */
  replayTour(): void {
    const mobile = this.shellMode() === 'mobile';
    if (!mobile && this.currentPath() !== '/') {
      void this.router.navigateByUrl('/').then(() => setTimeout(() => this.tour.replay(tourForPlatform(false)), 600));
      return;
    }
    this.tour.replay(tourForPlatform(mobile));
  }

  /** Whether to show the desktop "+ Snap" top-bar capture entry (ai.vision + ≥1 writable destination; reactive). */
  readonly showSnap = computed(() => !this.bareLayout() && this.snapRoute.canCapture());

  /** Open the Snap & Route capture surface (desktop top-bar button / ⌘K palette action). */
  openSnap(): void {
    this.snapRoute.request();
  }

  /** Quick theme picker shown in the account menu (mirrors /preferences). */
  readonly themeModes: readonly { value: ThemeMode; label: string; icon: string }[] = [
    { value: 'system', label: 'System', icon: 'brightness_auto' },
    { value: 'light', label: 'Light', icon: 'light_mode' },
    { value: 'dark', label: 'Dark', icon: 'dark_mode' },
  ];

  /** The mounted palette overlay, so the shell can wire its Quick-Add / Sign-out action handlers once. */
  private readonly commandPalette = viewChild(CommandPalette);

  /** Whether the quick-add dialog is currently open (so the shortcut + FAB don't stack copies). */
  private quickAddOpen = false;

  /** Last session-revoke seq we acted on — so a re-login can't re-trigger a stale forced logout. */
  private lastRevokeSeq = 0;

  readonly status = signal<SyncStatus | null>(null);
  readonly online = signal<Presence[]>([]);
  readonly now = signal(Date.now());

  /**
   * Client-side IDLE detection. We stamp the last time the user touched the page (pointer/key/scroll, or
   * the tab becoming visible). If that's older than IDLE_MS the caller is treated as AWAY on the roster.
   * Others' away is derived purely from how stale their server `lastSeenUtc` is (AWAY_MS) — no client hack.
   */
  private static readonly IDLE_MS = 5 * 60_000; // ~5 min of no interaction → self is away
  private static readonly AWAY_MS = 60_000; // another user not seen in >60s (their polls are ~20s) → away
  /** Coalesce window for the reactive idle stamp: hot events (pointermove/scroll/wheel fire at ~60-120Hz)
   *  must not each write a signal, since that schedules a full change-detection pass in this zoneless app.
   *  We only advance {@link lastActivity} once every this-many ms — ample for a ~5-minute idle threshold. */
  private static readonly ACTIVITY_THROTTLE_MS = 5_000;
  private readonly lastActivity = signal(Date.now());
  /** Wall-clock of the last reactive {@link lastActivity} WRITE, used to throttle the hot-event stamp. */
  private lastActivityWrite = Date.now();
  /**
   * OS-level idle/away reported by the PWA IdleDetector (user idle ~60s OR screen locked), fed by
   * {@link PwaService}. Pure best-effort: stays false on every browser that lacks the API or hasn't granted
   * idle-detection, so it can only ever ADD to the local-interaction away derivation, never mask it.
   */
  private readonly pwaIdle = signal(false);
  /** Whether the caller is currently idle (no interaction for ~5 min, OR the OS reports idle/screen-locked). */
  readonly selfAway = computed(
    () => this.pwaIdle() || this.now() - this.lastActivity() >= App.IDLE_MS,
  );

  /** Total user count for the toolbar (null until first loaded / when the caller lacks users.view). */
  readonly userCount = signal<number | null>(null);

  /** Exposed for the template's "active …" presence lines. */
  readonly timeAgo = timeAgo;

  /** Mobile hamburger drawer open-state (only used below the nav breakpoint). */
  readonly mobileNavOpen = signal(false);
  toggleMobileNav(): void {
    this.mobileNavOpen() ? this.closeMobileNav() : this.openMobileNav();
  }

  /**
   * Open the drawer and move focus into it (dialog-like contract): focus the first link so a
   * keyboard / screen-reader user lands inside the drawer rather than behind it. Tab is trapped
   * while open (see {@link onMobileNavKeydown}) and Escape returns focus to the burger.
   */
  openMobileNav(): void {
    this.mobileNavOpen.set(true);
    // Wait a frame for the drawer's *ngIf-gated content to be focusable, then focus the first item.
    requestAnimationFrame(() => {
      const root = this.host.nativeElement as HTMLElement;
      const first = root.querySelector<HTMLElement>('#mobile-nav .mobile-nav__item');
      first?.focus();
    });
  }

  /** Close the drawer; restore focus to the burger so keyboard focus isn't lost to the page top. */
  closeMobileNav(): void {
    const wasOpen = this.mobileNavOpen();
    this.mobileNavOpen.set(false);
    if (wasOpen) {
      const burger = (this.host.nativeElement as HTMLElement).querySelector<HTMLElement>(
        '.navburger',
      );
      burger?.focus();
    }
  }

  /**
   * Widget pop-outs, public shared views, and the public marketing pages (landing / features /
   * how-it-works) render bare — they bring their own chrome, so the app toolbar is hidden.
   */
  readonly bareLayout = signal(App.isBare(this.router.url));
  private static readonly barePrefixes = [
    '/widget',
    '/share',
    '/bill',
    '/login',
    '/features',
    '/how-it-works',
    '/technology',
    '/ai',
    '/signin',
    '/about',
  ];
  private static isBare(url: string): boolean {
    const path = url.split('?')[0];
    return App.barePrefixes.some((p) => path === p || path.startsWith(p + '/'));
  }

  /**
   * The shell chrome to render around the page, derived from {@link bareLayout} + the resolved platform:
   *   • 'bare'    — the bare/public allowlist (widget pop-outs, share/bill views, the marketing pages):
   *                 NO app chrome at all (the page brings its own). Same prefix set as before.
   *   • 'mobile'  — a phone (device OR forced via {@link PlatformService}): the slim <app-mobile-topbar>
   *                 + a single <app-bottom-tab-bar>, with the page framed between them.
   *   • 'desktop' — everything else: the full desktop toolbar (grouped dropdowns + right cluster), unchanged.
   * `bareLayout` is the existing NavigationEnd-tracked signal; `platform.isMobile()` is reactive, so this
   * recomputes on both a route change AND a live desktop/mobile override flip.
   */
  readonly shellMode = computed<'bare' | 'mobile' | 'desktop'>(() => {
    if (this.bareLayout()) return 'bare';
    // The mobile shell tracks the SAME gate as the per-page mobile twins (isMobileGated): a phone WITHOUT
    // the platform.mobile grant keeps the full desktop experience (today's responsive behavior), so we never
    // wrap a desktop-laid-out page in mobile chrome for un-opted-in users. Reading permissions() keeps it
    // reactive to a grant change; platform.isMobile() is already reactive to the viewport + override.
    this.auth.permissions();
    return (this.platform.isMobile() && this.auth.hasPermission('platform.mobile')) ? 'mobile' : 'desktop';
  });

  /** The current route path (no query), kept fresh on each navigation — drives the group-active flags. */
  readonly currentPath = signal(this.router.url.split('?')[0]);

  /**
   * Whether any child of a grouped dropdown is the active route — so the "Usage ▾" / "Admin ▾" trigger
   * can flag itself active (routerLinkActive can't, since the trigger isn't a link). Each member matches
   * the same exact/prefix shape its routerLinkActive uses ('/' is exact; the rest match the route or a
   * child path).
   */
  private pathInGroup(routes: readonly string[]): boolean {
    const path = this.currentPath();
    return routes.some((r) => (r === '/' ? path === '/' : path === r || path.startsWith(r + '/')));
  }
  readonly usageGroupActive = computed(() =>
    this.pathInGroup(['/', '/calendar', '/pricing', '/reporter', '/fleet']),
  );
  readonly fitnessGroupActive = computed(() =>
    this.pathInGroup(['/tracker', '/challenge', '/trophies', '/feed']),
  );
  readonly toolsGroupActive = computed(() =>
    this.pathInGroup(['/ask', '/automations', '/bills', '/grocery', '/recipes', '/meal-planner', '/resume']),
  );
  readonly socialGroupActive = computed(() => this.pathInGroup(['/chat', '/people']));
  readonly betaGroupActive = computed(() => this.pathInGroup(['/beta', '/tracker-beta']));

  /**
   * The Beta dropdown's page list (the SAME registry the Beta hub grid uses, so nav + hub never drift).
   * The template prepends a "Beta home" (/beta) link, then iterates these; each entry's optional `perm`
   * is an ADDITIONAL gate layered on the platform.mobile trigger gate. Exposed for the nav template.
   */
  readonly betaExperiments = BETA_EXPERIMENTS;
  /** Nav-template predicate: may the caller SEE this beta entry (its `perm` + any-of `anyPerm` gate). */
  readonly canSeeBeta = (x: BetaExperiment): boolean =>
    canSeeExperiment(x, p => this.auth.hasPermission(p));
  readonly adminGroupActive = computed(() =>
    this.pathInGroup(['/users', '/admin/locations', '/activity', '/ai-usage', '/settings']),
  );

  /**
   * Page routes that require a single view permission (for live-revocation enforcement). Keyed by the
   * exact path, except entries flagged below as subtree roots which also cover their child routes.
   * `/reporter` and `/fleet` are any-of guarded, so they can't be expressed here and are left to the
   * page's own 403 — only clean single-permission routes belong in this map.
   */
  private static readonly routePerm: Record<string, string> = {
    '/': 'dashboard.view',
    '/calendar': 'calendar.view',
    '/pricing': 'pricing.view',
    '/settings': 'settings.view',
    '/chat': 'chat.read',
    '/tracker': 'tracker.self',
    '/tracker-beta': 'platform.mobile',
    '/challenge': 'tracker.self',
    '/feed': 'tracker.self',
    '/automations': 'automations.use',
    '/bills': 'bills.use',
    '/grocery': 'grocery.use',
    '/recipes': 'recipes.use',
    '/meal-planner': 'meals.use',
    '/resume': 'resume.use',
    '/beta': 'platform.mobile',
    '/family': 'family.use',
    '/locations': 'location.self',
    '/admin/locations': 'location.view-all',
    '/users': 'users.view',
    '/activity': 'activity.view',
    '/ai-usage': 'ai.usage.view',
  };

  /** Routes whose required permission also gates every child path (e.g. /family/household, /tracker/profile). */
  private static readonly routePermSubtrees: readonly string[] = ['/family', '/tracker'];

  readonly state = computed(() => {
    const s = this.status();
    if (!s) return 'idle';
    if (s.isRunning) return 'running';
    if (s.lastError) return 'error';
    if (!s.lastSyncUtc) return 'idle';
    return 'ok';
  });

  readonly label = computed(() => {
    const s = this.status();
    const now = this.now();
    if (!s) return 'CONNECTING';
    if (s.isRunning) return 'SYNCING…';
    if (!s.lastSyncUtc) return 'NEVER SYNCED';
    return `SYNCED ${timeAgo(s.lastSyncUtc, now)}`;
  });

  readonly tooltip = computed(() => {
    const s = this.status();
    if (!s) return 'Connecting to API…';
    const auto = s.autoSyncEnabled
      ? `Auto-sync every ${humanizeInterval(s.intervalSeconds)}`
      : 'Auto-sync off';
    const last = s.lastSyncUtc
      ? `Last sync ${new Date(s.lastSyncUtc).toLocaleString()} · +${s.lastNewRecords.toLocaleString()} rows`
      : 'No sync yet';
    return `${last}\n${auto}`;
  });

  /** Two-letter initials from a name (falls back to email), used by the avatar fallbacks. */
  private static initialsOf(name: string | null | undefined, email?: string | null): string {
    const src = name || email || '';
    const parts = src.split(/[\s@.]+/).filter(Boolean);
    return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || 'U';
  }

  readonly initials = computed(() =>
    App.initialsOf(this.auth.session()?.name, this.auth.session()?.email),
  );

  /**
   * Online teammates projected for the indicator: each enriched with display initials and a "you"
   * flag taken straight from the server's `isSelf` (no client-side email comparison). The server
   * orders them, so we preserve that order and just tag the caller.
   */
  readonly onlineUsers = computed<OnlineUser[]>(() => {
    const now = this.now();
    const selfAway = this.selfAway();
    return this.online().map((u) => ({
      ...u,
      initials: App.initialsOf(u.name),
      isYou: u.isSelf,
      // The caller's own away comes from local idle detection; everyone else's from a stale-lastSeen
      // threshold (the server stamps lastSeenUtc on every authenticated request).
      away: u.isSelf ? selfAway : now - new Date(u.lastSeenUtc).getTime() >= App.AWAY_MS,
    }));
  });

  /**
   * Whether the caller has chosen to "appear offline" (mirrored from /me into the session). When true the
   * roster others see excludes them server-side, so we surface a hint in their own roster that they're hidden.
   */
  readonly selfHidden = computed(() => this.auth.session()?.appearOffline === true);

  /** How many teammates are online right now. */
  readonly onlineCount = computed(() => this.onlineUsers().length);

  /** The first ~4 avatars to stack in the cluster; the rest collapse into a "+N" chip. */
  readonly onlineAvatars = computed(() => this.onlineUsers().slice(0, 4));

  /** Overflow beyond the stacked avatars (0 when everyone fits). */
  readonly onlineOverflow = computed(() => Math.max(0, this.onlineCount() - 4));

  /**
   * A coarse access tier shown in the account menu header. Anyone who can manage users is an
   * "Administrator"; everyone else is a "Member". Recomputes live as /me refreshes permissions.
   */
  readonly roleLabel = computed(() =>
    this.auth.permissions().includes(PERM.usersManage) ? 'Administrator' : 'Member',
  );

  /**
   * Whether to show the global family Quick-Add affordance (FAB + keyboard shortcut). Gated on a signed-in
   * session holding family.use, and hidden on the bare/public chrome where the toolbar isn't shown.
   */
  readonly showQuickAdd = computed(
    () =>
      this.auth.isAuthenticated() && !this.bareLayout() && this.auth.hasPermission(PERM.familyUse),
  );

  /** Account-menu shortcuts, filtered to the pages the current session is allowed to view. */
  private static readonly quickLinkDefs: readonly QuickLink[] = [
    { route: '/', label: 'Dashboard', icon: 'dashboard', perm: PERM.dashboardView },
    { route: '/locations', label: 'My locations', icon: 'place', perm: PERM.locationSelf },
    { route: '/settings', label: 'Admin settings', icon: 'tune', perm: PERM.settingsView },
    { route: '/users', label: 'Users', icon: 'group', perm: PERM.usersView },
  ];
  readonly quickLinks = computed<QuickLink[]>(() => {
    this.auth.permissions(); // re-run when permissions change
    return App.quickLinkDefs.filter((l) => !l.perm || this.auth.hasPermission(l.perm));
  });

  /** Home-page picker options filtered to the pages the current session can actually land on. The list is
   * the shared {@link HOME_OPTIONS} (one source of truth for BOTH this dropdown picker and the beta Settings
   * picker, and the same set AuthService.canAccessHome honours) — so the two pickers can never drift. */
  readonly homeOptions = computed<HomeOption[]>(() => {
    this.auth.permissions(); // re-run when permissions change
    return HOME_OPTIONS.filter((o) => this.auth.hasAnyPermission(...o.perms));
  });

  /** The brand-link destination: the saved home route, normalized so a legacy /beta/* or /tracker-beta
   *  preference resolves to its canonical page (see {@link normalizeHome}). Reactive off the session. */
  readonly brandHome = computed(() => normalizeHome(this.auth.homeRoute()));

  constructor() {
    // Wire the service-worker update prompt (prod-only; no-ops when the SW is disabled). Snackbar on a
    // new deployed version — "New version available — Reload" — reloads only if the user clicks.
    this.swUpdate.init();

    // Lock the installed app to PORTRAIT. The manifest `orientation: "portrait"` is the real fix, but most
    // browsers BAKE a PWA's orientation at install time, so an already-installed home-screen app won't pick
    // up the manifest change without a reinstall. As a belt-and-suspenders, when running standalone ask the
    // Screen Orientation API to lock portrait too — best-effort, silently ignored where unsupported (iOS,
    // browser tabs, or when the platform disallows the lock).
    try {
      const so = (screen as unknown as { orientation?: { lock?: (o: string) => Promise<void> } })?.orientation;
      const standalone =
        window.matchMedia?.('(display-mode: standalone)').matches ||
        (navigator as unknown as { standalone?: boolean }).standalone === true;
      if (so?.lock && standalone) void so.lock('portrait').catch(() => { /* unsupported / not allowed */ });
    } catch { /* Screen Orientation API absent */ }

    // Initialize the client-side PWA capability bundle once (app-badge, persistent-storage, idle→presence,
    // online/offline, notification-click routing). Everything inside is feature-detected + guarded, so this
    // is a silent no-op on browsers (iOS Safari, older) that lack the underlying APIs. We hand it the OS-idle
    // sink so a granted IdleDetector can mark the caller AWAY (folded into selfAway above).
    this.pwa.init((idle) => this.pwaIdle.set(idle));

    // Drive the installed-app badge from the live UNREAD CHAT count: set it while >0, clear it at 0. The
    // Badging API itself no-ops where unsupported (handled inside PwaService).
    effect(() => {
      const unread = this.chat.totalUnreadMessages();
      if (unread > 0) this.pwa.setBadge(unread);
      else this.pwa.clearBadge();
    });

    // Re-attach the bar observer whenever the shell mode flips (the mobile top/tab bars mount + unmount).
    // queueMicrotask defers to AFTER the @switch re-renders so the bars are in the DOM to measure.
    effect(() => {
      this.shellMode(); // dependency: re-run on shell change
      queueMicrotask(() => this.reobserveBars());
    });
    inject(DestroyRef).onDestroy(() => this.barRO?.disconnect());

    this.router.events
      .pipe(
        filter((e) => e instanceof NavigationEnd),
        takeUntilDestroyed(),
      )
      .subscribe(() => {
        this.bareLayout.set(App.isBare(this.router.url));
        this.currentPath.set(this.router.url.split('?')[0]);
        this.closeMobileNav(); // never leave the drawer open across a route change
        this.maybeApplyPwaHome(); // installed-app launch → saved home (once the router has settled)
        this.maybeStartTour(); // first dashboard visit → auto-start the guided tour (once)
        this.focusMainContent(); // SPA route-change focus management (WCAG 2.4.3) — announce the new page
      });

    // Lightweight clock tick (~15s) so the relative "active …" labels AND the derived away/idle states
    // recompute even between data polls. Cheap: it only advances the `now` signal.
    timer(15000, 15000)
      .pipe(takeUntilDestroyed())
      .subscribe(() => this.now.set(Date.now()));

    // Poll sync status only when signed in; "now" keeps the relative label fresh.
    timer(0, 15000)
      .pipe(
        switchMap(() =>
          this.auth.isAuthenticated()
            ? this.api.syncStatus().pipe(catchError(() => of(null)))
            : of(null),
        ),
        takeUntilDestroyed(),
      )
      .subscribe((s) => {
        this.now.set(Date.now());
        if (s) this.status.set(s);
      });

    // Re-check identity + permissions; bounce to login if the account was disabled/removed.
    timer(800, 20000)
      .pipe(
        filter(() => this.auth.isAuthenticated()),
        switchMap(() =>
          this.auth.me().pipe(
            catchError((err) => {
              this.onMeError(err);
              return of(null);
            }),
          ),
        ),
        takeUntilDestroyed(),
      )
      .subscribe((me) => {
        if (me) {
          this.auth.applyMe(me);
          this.enforceCurrentRoute();
        }
      });

    // Poll who's online (~20s) while signed in; errors collapse to an empty list.
    timer(400, 20000)
      .pipe(
        switchMap(() =>
          this.auth.isAuthenticated()
            ? this.api.presence().pipe(catchError(() => of<Presence[]>([])))
            : of<Presence[]>([]),
        ),
        takeUntilDestroyed(),
      )
      // Coalesce to [] so a null/empty presence body can never make `online` non-array — the toolbar's
      // onlineCount()/onlineUsers() read .length/.map off it on every authenticated page (presence chrome).
      .subscribe((list) => this.online.set(list ?? []));

    // Poll the total user count (~60s) only while signed in AND holding users.view — it's a nav-bar
    // nicety, so it's cheap (just a number) and any error keeps the prior value rather than flickering.
    timer(600, 60000)
      .pipe(
        switchMap(() =>
          this.auth.isAuthenticated() && this.auth.hasPermission(PERM.usersView)
            ? this.api.userCount().pipe(catchError(() => of(null)))
            : of(null),
        ),
        takeUntilDestroyed(),
      )
      .subscribe((res) => {
        if (res) this.userCount.set(res.total);
      });

    // Own the realtime chat hub lifecycle at the app shell so live notifications work app-wide (not
    // just on /chat) and the connection is bound to the CURRENT user. Start when signed in AND the
    // session grants chat.read; otherwise tear it down. Making the effect symmetric ties teardown to
    // the gating signals, so it covers not just sign-out (logout/onMeError also call stop()) but a
    // LIVE chat.read revocation that arrives via the /me poll without a full logout — the connection
    // never lingers on a now-unauthorized session, and the next valid session builds a fresh one.
    effect(() => {
      if (this.auth.isAuthenticated() && this.auth.hasPermission(PERM.chatRead)) {
        void this.chat.start();
      } else {
        void this.chat.stop();
      }
    });

    // Location capture lifecycle (PRIVACY: opt-in + permission-gated). Symmetric with the chat effect so
    // teardown tracks the gating signals: start the capture lifecycle when signed in AND holding
    // location.self (start() itself no-ops unless the user has ALSO enabled capture in settings, and never
    // touches the browser otherwise); stop it on sign-out or a live location.self revocation. start() is
    // idempotent, so the periodic poll re-entrancy is harmless.
    effect(() => {
      if (this.auth.isAuthenticated() && this.auth.hasPermission(PERM.locationSelf)) {
        void this.locationCapture.start();
      } else {
        this.locationCapture.stop();
      }
    });

    // Web client-info capture (best-effort, privacy-respecting; NO geolocation, NO prompt). On the first
    // authenticated render it POSTs the caller's device/agent characteristics onto their latest login
    // event (one-shot per session via the service's own latch); on sign-out it resets the latch so the
    // next session re-captures. Gated by authentication only — it's about the caller's OWN session.
    effect(() => {
      if (this.auth.isAuthenticated()) {
        void this.clientInfoCapture.capture();
      } else {
        this.clientInfoCapture.reset();
      }
    });

    // Real-time force-logout: when an admin invalidates this user's session (a SessionRevoked event over
    // the hub), sign out the INSTANT it arrives rather than waiting for the next request / /me poll to 401.
    // The counter only climbs; acting solely on increments past the last one we handled keeps a later
    // re-login from re-firing on the stale value.
    effect(() => {
      const seq = this.chat.sessionRevoked();
      if (seq > this.lastRevokeSeq) {
        this.lastRevokeSeq = seq;
        this.onForcedLogout();
      }
    });

  }

  /**
   * PWA cold-launch home redirect. The manifest `start_url` is "/?source=pwa", so launching the INSTALLED
   * app always opens "/" with the existing (already-authenticated) session and NO fresh login — meaning the
   * post-login home redirect never runs and the app ignored the user's saved landing page. Run from the
   * FIRST settled NavigationEnd (so `router.url` is the real launch URL, not the pre-nav value), once the
   * session is ready: send the launch to the saved home route, once. The `source=pwa` marker only ever
   * appears on the launch URL, so a normal in-app visit to "/" is never hijacked, and a deep-linked launch
   * (a different path) is left alone (the `=== '/'` guard).
   */
  private maybeApplyPwaHome(): void {
    if (this.pwaHomeApplied || !this.launchedFromPwa) return;
    if (!this.auth.isAuthenticated()) return; // session not ready yet — a later NavigationEnd retries
    this.pwaHomeApplied = true;
    const home = normalizeHome(this.auth.homeRoute());
    if (home && home !== '/' && this.router.url.split('?')[0] === '/') {
      void this.router.navigateByUrl(home);
    }
  }

  /**
   * First-run guided tour. Auto-starts ONCE per app instance, the first time an authenticated user lands
   * on the dashboard ("/"), and only if they haven't seen it before (TourService persists the seen flag).
   * Anchored on the dashboard + persistent nav, so it never navigates mid-tour. We pick the desktop vs
   * mobile tour from the resolved shell, and defer one tick so the KPI cards + nav/tab anchors have mounted
   * (a not-yet-present anchor is skipped gracefully by the overlay, so the delay is just for polish).
   * Bare/public chrome is excluded (no nav to point at).
   */
  private maybeStartTour(): void {
    if (this.tourAutoStartTried) return;
    if (!this.auth.isAuthenticated() || this.bareLayout()) return;
    if (this.router.url.split('?')[0] !== '/') return;
    const def = tourForPlatform(this.shellMode() === 'mobile');
    if (this.tour.hasSeen(def.id)) {
      this.tourAutoStartTried = true; // already seen — don't keep re-checking every navigation
      return;
    }
    this.tourAutoStartTried = true;
    setTimeout(() => {
      // Re-guard at fire time: still authed, still on the dashboard, nothing else opened a tour.
      if (this.auth.isAuthenticated() && this.router.url.split('?')[0] === '/') {
        this.tour.maybeAutoStart(def);
      }
    }, 600);
  }

  /**
   * Wire the palette's two shell-owned actions (Quick-Add + Sign out) once the overlay is mounted. The
   * palette stays decoupled from `App` — it just invokes these thin callbacks — so the only coupling is
   * these two assignments. Navigation commands are self-contained in the palette (it has Router).
   */
  ngAfterViewInit(): void {
    this.reobserveBars();
    const p = this.commandPalette();
    if (!p) return;
    p.setQuickAddHandler(() => this.openQuickAdd());
    p.setLogoutHandler(() => this.logout());
    p.setSnapHandler(() => this.openSnap());
  }

  /** (Re)point the ResizeObserver at the currently-mounted mobile top bar + tab bar, then take a reading.
   *  Called on first render + on every shell-mode change (the bars are conditional). */
  private reobserveBars(): void {
    if (!this.barRO || typeof document === 'undefined') return;
    this.barRO.disconnect();
    const root = this.host.nativeElement;
    const topbar = root.querySelector('app-mobile-topbar');
    const tabbar = root.querySelector('app-bottom-tab-bar');
    if (topbar) this.barRO.observe(topbar);
    if (tabbar) this.barRO.observe(tabbar);
    this.measureBars();
  }

  /**
   * Publish the REAL rendered heights of the mobile top bar + tab bar as --mobile-bar-h / --mobile-tabbar-h
   * on the content frame, so it fills exactly the viewport gap between them on ANY device — no hardcoded
   * px. The >20px guard skips a bar that's momentarily display:none (the tab bar hides while a sheet is
   * open), keeping the last good size so the frame doesn't jump. The CSS calc remains the pre-JS fallback.
   */
  private measureBars(): void {
    if (typeof document === 'undefined') return;
    const root = this.host.nativeElement;
    const frame = root.querySelector('main.content--mobile') as HTMLElement | null;
    if (!frame) return;
    const th = (root.querySelector('app-mobile-topbar') as HTMLElement | null)?.offsetHeight ?? 0;
    const bh = (root.querySelector('app-bottom-tab-bar') as HTMLElement | null)?.offsetHeight ?? 0;
    if (th > 20) frame.style.setProperty('--mobile-bar-h', `${th}px`);
    if (bh > 20) frame.style.setProperty('--mobile-tabbar-h', `${bh}px`);
  }

  /**
   * Global command-palette opener: ⌘K / Ctrl-K anywhere, OR a bare "/" when NOT typing in a field. We
   * reuse {@link App.isTypingTarget} (the same guard the bare-"q" Quick-Add handler uses) so "/" stays a
   * normal character in inputs and never collides with that convention. ⌘K/Ctrl-K is preventDefault'd so
   * the browser doesn't hijack it for the address bar. No-op on the bare/public chrome or while the mobile
   * drawer is open. The palette itself owns Escape/Arrow/Enter once it's visible (see CommandPalette).
   */
  @HostListener('document:keydown', ['$event'])
  onPaletteKeydown(e: KeyboardEvent): void {
    if (!this.auth.isAuthenticated() || this.bareLayout() || this.mobileNavOpen()) return;

    const cmdk =
      (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.key === 'k' || e.key === 'K');
    const slash =
      e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !App.isTypingTarget(e.target);
    if (!cmdk && !slash) return;

    e.preventDefault();
    this.palette.toggle();
  }

  /**
   * SPA route-change focus management (WCAG 2.4.3 / SPA-focus). On each settled NavigationEnd we move
   * keyboard focus to the always-present <main id="main-content" tabindex="-1"> landmark, so keyboard +
   * screen-reader users aren't stranded on the just-clicked nav link (or lost to <body> when the old
   * component is destroyed) and AT re-announces the new page instead of reading the stale context. The
   * focus move is deferred a frame so the router has swapped in the new component, and skipped for in-page
   * fragment navigations so anchor links keep working. Bare/public chrome renders its own <main>-less
   * layout, so the query simply no-ops there.
   */
  private focusMainContent(): void {
    if (typeof document === 'undefined') return;
    if (this.router.url.includes('#')) return; // in-page anchor nav — leave focus on the fragment target
    requestAnimationFrame(() => {
      const main = (this.host.nativeElement as HTMLElement).querySelector<HTMLElement>('#main-content');
      main?.focus();
    });
  }

  /**
   * If a live /me refresh shows the user has lost the view permission for the page they're currently
   * on (an admin revoked it mid-session), send them to their new home so the page can't keep 403ing.
   */
  private enforceCurrentRoute(): void {
    const path = this.router.url.split('?')[0];
    const subtree = App.routePermSubtrees.find((r) => path === r || path.startsWith(r + '/'));
    const required = App.routePerm[subtree ?? path];
    if (required && !this.auth.hasPermission(required)) {
      this.router.navigateByUrl(normalizeHome(this.auth.homeRoute()));
    }
  }

  private onMeError(err: { status?: number }): void {
    if (err?.status === 401 || err?.status === 403) {
      this.auth.logout();
      void this.chat.stop(); // tear down the prior user's hub on a forced 401/403 logout
      this.status.set(null);
      this.online.set([]);
      this.userCount.set(null);
      this.router.navigate(['/login']);
    }
  }

  /** An admin force-logged this session out (real-time SessionRevoked push). Sign out immediately. */
  private onForcedLogout(): void {
    if (!this.auth.isAuthenticated()) return; // already signed out (e.g. raced the /me-poll 401)
    this.auth.logout();
    void this.chat.stop();
    this.status.set(null);
    this.online.set([]);
    this.userCount.set(null);
    this.snack.open('You were signed out by an administrator.', 'OK', { duration: 6000 });
    this.router.navigate(['/login']);
  }

  /**
   * Global Quick-Add shortcut for family.use holders: a bare "q" OR Ctrl/Cmd-Shift-A opens the capture
   * dialog. We ignore the keystroke while the user is typing in a field (input/textarea/select or any
   * contenteditable) so "q" stays a normal letter there; the chord still works everywhere. No-op for users
   * without family.use or on the bare/public chrome.
   */
  @HostListener('document:keydown', ['$event'])
  onGlobalKeydown(e: KeyboardEvent): void {
    if (!this.showQuickAdd() || this.quickAddOpen) return;

    const chord = (e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'A' || e.key === 'a');
    const bareQ =
      e.key === 'q' &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      !e.shiftKey &&
      !App.isTypingTarget(e.target);
    if (!chord && !bareQ) return;

    e.preventDefault();
    this.openQuickAdd();
  }

  /**
   * Keyboard contract for the open mobile drawer: Escape closes it (focus returns to the burger), and
   * Tab is trapped within the drawer so focus can't slip to the page underneath (which is still in the
   * DOM, just visually covered by the fixed drawer + scrim). No-op while the drawer is closed.
   */
  @HostListener('document:keydown', ['$event'])
  onMobileNavKeydown(e: KeyboardEvent): void {
    if (!this.mobileNavOpen()) return;

    if (e.key === 'Escape') {
      e.preventDefault();
      this.closeMobileNav();
      return;
    }

    if (e.key !== 'Tab') return;

    const root = (this.host.nativeElement as HTMLElement).querySelector<HTMLElement>('#mobile-nav');
    if (!root) return;
    const items = Array.from(root.querySelectorAll<HTMLElement>('.mobile-nav__item'));
    if (items.length === 0) return;

    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement as HTMLElement | null;

    // Wrap at the ends; if focus is somehow outside the drawer, pull it back to an edge.
    if (e.shiftKey) {
      if (active === first || !root.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last || !root.contains(active)) {
      e.preventDefault();
      first.focus();
    }
  }

  /**
   * IDLE tracking: any real interaction (pointer move/down, key, scroll, wheel, touch) refreshes the
   * activity stamp, so the caller's own roster "away" badge clears the instant they're back. Passive +
   * lightweight. Because the app is ZONELESS, a signal write schedules a full change-detection pass, so we
   * THROTTLE the reactive {@link lastActivity} write to at most once per {@link ACTIVITY_THROTTLE_MS} — the
   * hot events (pointermove/scroll/wheel fire at ~60-120Hz during a drag/scroll) then cost almost nothing,
   * yet the ~5-minute idle threshold is still refreshed with plenty of margin.
   */
  @HostListener('document:pointerdown')
  @HostListener('document:pointermove')
  @HostListener('document:keydown')
  @HostListener('document:wheel')
  @HostListener('document:touchstart')
  @HostListener('document:scroll')
  onUserActivity(): void {
    const now = Date.now();
    if (now - this.lastActivityWrite < App.ACTIVITY_THROTTLE_MS) return;
    this.lastActivityWrite = now;
    this.lastActivity.set(now);
  }

  /** Returning to the tab counts as activity (and refreshes "now" so stale-away derivations recompute). */
  @HostListener('document:visibilitychange')
  onVisibilityChange(): void {
    if (document.visibilityState === 'visible') {
      const now = Date.now();
      this.lastActivityWrite = now; // keep the hot-event throttle window in sync with this direct write
      this.lastActivity.set(now);
      this.now.set(now);
    }
  }

  /**
   * Focusing the window means the user is looking at the app, so the unread chat is effectively "seen" —
   * clear the installed-app badge (the effect re-sets it the next time totalUnreadMessages climbs above 0).
   */
  @HostListener('window:focus')
  onWindowFocus(): void {
    this.pwa.clearBadge();
  }

  /** True when the event target is a text field / editable element where a bare "q" should type normally. */
  private static isTypingTarget(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
  }

  /** Open the compact family Quick-Add dialog; on success, toast the warm summary the server returned. */
  openQuickAdd(): void {
    if (!this.showQuickAdd() || this.quickAddOpen) return;
    this.quickAddOpen = true;
    this.closeMobileNav();
    this.dialog
      .open<QuickAddDialog, void, QuickAddResult>(QuickAddDialog, {
        width: 'min(96vw, 460px)',
        maxWidth: '96vw',
        panelClass: 'family-dialog',
        autoFocus: 'first-tabbable',
        restoreFocus: true,
      })
      .afterClosed()
      .subscribe((result) => {
        this.quickAddOpen = false;
        if (result) this.snack.open(result.summary, 'OK', { duration: 4000 });
      });
  }

  /**
   * Set (or clear) the caller's landing page from the account-menu picker. `null` clears it (the brand
   * link / post-login redirect fall back to the first-accessible page). PATCHes the backend, then updates
   * local session state so {@link AuthService.homeRoute} reflects the choice immediately. On error the
   * prior value stands and we toast — we never optimistically flip local state ahead of the server.
   */
  setHomeRoute(route: string | null): void {
    if ((this.auth.session()?.homeRoute ?? null) === route) return; // no-op: already the chosen home
    this.api.setHomeRoute(route).subscribe({
      next: (res) => {
        this.auth.applyHomeRoute(res.homeRoute ?? null);
        this.snack.open(
          res.homeRoute ? 'Home page updated.' : 'Home page reset to default.',
          'OK',
          { duration: 3000 },
        );
      },
      error: () => this.snack.open('Could not update your home page.', 'OK', { duration: 4000 }),
    });
  }

  logout(): void {
    this.auth.logout();
    void this.chat.stop(); // tear down the hub so the next user never reuses this connection/token
    this.status.set(null);
    this.userCount.set(null);
    this.router.navigate(['/login']);
  }
}
