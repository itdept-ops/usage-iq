import { Component, computed, effect, HostListener, inject, signal } from '@angular/core';
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

import { Api } from './core/api';
import { AuthService } from './core/auth';
import { ChatRealtime } from './core/chat-realtime';
import { Presence, SyncStatus, PERM, QuickAddResult } from './core/models';
import { timeAgo, humanizeInterval } from './shared/format';
import { NotificationBell } from './features/notifications/notification-bell';

/** A teammate online, enriched with the initials + "you" flag the indicator needs to render. */
interface OnlineUser extends Presence {
  initials: string;
  isYou: boolean;
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
    RouterOutlet, RouterLink, RouterLinkActive,
    MatToolbarModule, MatButtonModule, MatIconModule, MatTooltipModule, MatMenuModule,
    NotificationBell,
  ],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  private api = inject(Api);
  private router = inject(Router);
  readonly auth = inject(AuthService);
  private chat = inject(ChatRealtime);
  private snack = inject(MatSnackBar);
  private dialog = inject(MatDialog);

  /** Whether the quick-add dialog is currently open (so the shortcut + FAB don't stack copies). */
  private quickAddOpen = false;

  /** Last session-revoke seq we acted on — so a re-login can't re-trigger a stale forced logout. */
  private lastRevokeSeq = 0;

  readonly status = signal<SyncStatus | null>(null);
  readonly online = signal<Presence[]>([]);
  readonly now = signal(Date.now());

  /** Total user count for the toolbar (null until first loaded / when the caller lacks users.view). */
  readonly userCount = signal<number | null>(null);

  /** Exposed for the template's "active …" presence lines. */
  readonly timeAgo = timeAgo;

  /** Mobile hamburger drawer open-state (only used below the nav breakpoint). */
  readonly mobileNavOpen = signal(false);
  toggleMobileNav(): void { this.mobileNavOpen.update(v => !v); }
  closeMobileNav(): void { this.mobileNavOpen.set(false); }

  /**
   * Widget pop-outs, public shared views, and the public marketing pages (landing / features /
   * how-it-works) render bare — they bring their own chrome, so the app toolbar is hidden.
   */
  readonly bareLayout = signal(App.isBare(this.router.url));
  private static readonly barePrefixes = ['/widget', '/share', '/login', '/features', '/how-it-works', '/technology', '/ai', '/signin', '/about'];
  private static isBare(url: string): boolean {
    const path = url.split('?')[0];
    return App.barePrefixes.some(p => path === p || path.startsWith(p + '/'));
  }

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
    '/family': 'family.use',
    '/users': 'users.view',
    '/activity': 'activity.view',
  };

  /** Routes whose required permission also gates every child path (e.g. /family/household). */
  private static readonly routePermSubtrees: readonly string[] = ['/family'];

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
    const auto = s.autoSyncEnabled ? `Auto-sync every ${humanizeInterval(s.intervalSeconds)}` : 'Auto-sync off';
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

  readonly initials = computed(() => App.initialsOf(this.auth.session()?.name, this.auth.session()?.email));

  /**
   * Online teammates projected for the indicator: each enriched with display initials and a "you"
   * flag taken straight from the server's `isSelf` (no client-side email comparison). The server
   * orders them, so we preserve that order and just tag the caller.
   */
  readonly onlineUsers = computed<OnlineUser[]>(() =>
    this.online().map(u => ({
      ...u,
      initials: App.initialsOf(u.name),
      isYou: u.isSelf,
    })));

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
  readonly showQuickAdd = computed(() =>
    this.auth.isAuthenticated() && !this.bareLayout() && this.auth.hasPermission(PERM.familyUse),
  );

  /** Account-menu shortcuts, filtered to the pages the current session is allowed to view. */
  private static readonly quickLinkDefs: readonly QuickLink[] = [
    { route: '/', label: 'Dashboard', icon: 'dashboard', perm: PERM.dashboardView },
    { route: '/settings', label: 'Settings', icon: 'tune', perm: PERM.settingsView },
    { route: '/users', label: 'Users', icon: 'group', perm: PERM.usersView },
  ];
  readonly quickLinks = computed<QuickLink[]>(() => {
    this.auth.permissions(); // re-run when permissions change
    return App.quickLinkDefs.filter(l => !l.perm || this.auth.hasPermission(l.perm));
  });

  constructor() {
    this.router.events
      .pipe(filter(e => e instanceof NavigationEnd), takeUntilDestroyed())
      .subscribe(() => {
        this.bareLayout.set(App.isBare(this.router.url));
        this.closeMobileNav(); // never leave the drawer open across a route change
      });

    // Poll sync status only when signed in; "now" keeps the relative label fresh.
    timer(0, 15000)
      .pipe(
        switchMap(() => this.auth.isAuthenticated()
          ? this.api.syncStatus().pipe(catchError(() => of(null)))
          : of(null)),
        takeUntilDestroyed(),
      )
      .subscribe(s => { this.now.set(Date.now()); if (s) this.status.set(s); });

    // Re-check identity + permissions; bounce to login if the account was disabled/removed.
    timer(800, 20000)
      .pipe(
        filter(() => this.auth.isAuthenticated()),
        switchMap(() => this.auth.me().pipe(catchError(err => { this.onMeError(err); return of(null); }))),
        takeUntilDestroyed(),
      )
      .subscribe(me => { if (me) { this.auth.applyMe(me); this.enforceCurrentRoute(); } });

    // Poll who's online (~20s) while signed in; errors collapse to an empty list.
    timer(400, 20000)
      .pipe(
        switchMap(() => this.auth.isAuthenticated()
          ? this.api.presence().pipe(catchError(() => of<Presence[]>([])))
          : of<Presence[]>([])),
        takeUntilDestroyed(),
      )
      .subscribe(list => this.online.set(list));

    // Poll the total user count (~60s) only while signed in AND holding users.view — it's a nav-bar
    // nicety, so it's cheap (just a number) and any error keeps the prior value rather than flickering.
    timer(600, 60000)
      .pipe(
        switchMap(() => this.auth.isAuthenticated() && this.auth.hasPermission(PERM.usersView)
          ? this.api.userCount().pipe(catchError(() => of(null)))
          : of(null)),
        takeUntilDestroyed(),
      )
      .subscribe(res => { if (res) this.userCount.set(res.total); });

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
   * If a live /me refresh shows the user has lost the view permission for the page they're currently
   * on (an admin revoked it mid-session), send them to their new home so the page can't keep 403ing.
   */
  private enforceCurrentRoute(): void {
    const path = this.router.url.split('?')[0];
    const subtree = App.routePermSubtrees.find(r => path === r || path.startsWith(r + '/'));
    const required = App.routePerm[subtree ?? path];
    if (required && !this.auth.hasPermission(required)) {
      this.router.navigateByUrl(this.auth.homeRoute());
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
    const bareQ = e.key === 'q' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey
      && !App.isTypingTarget(e.target);
    if (!chord && !bareQ) return;

    e.preventDefault();
    this.openQuickAdd();
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
        width: '460px',
        maxWidth: '94vw',
        autoFocus: 'first-tabbable',
        restoreFocus: true,
      })
      .afterClosed()
      .subscribe(result => {
        this.quickAddOpen = false;
        if (result) this.snack.open(result.summary, 'OK', { duration: 4000 });
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
