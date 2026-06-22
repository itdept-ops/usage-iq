import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { Observable, tap } from 'rxjs';
import { AuthSession, PERM } from './models';

const STORAGE_KEY = 'usage_iq_session';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private http = inject(HttpClient);
  private readonly _session = signal<AuthSession | null>(this.restore());

  readonly session = this._session.asReadonly();
  readonly isAuthenticated = computed(() => {
    const s = this._session();
    return !!s && new Date(s.expiresAtUtc).getTime() > Date.now();
  });
  readonly permissions = computed(() => this._session()?.permissions ?? []);
  /** The caller's own AppUser id (for chat "mine"/self-by-id checks), or null until /me populates it. */
  readonly userId = computed(() => this._session()?.userId ?? null);

  /** True if the (non-expired) session grants the given permission. */
  hasPermission(key: string): boolean {
    return this.isAuthenticated() && (this._session()?.permissions?.includes(key) ?? false);
  }

  /** True if the (non-expired) session grants ANY of the given permissions (logical OR). */
  hasAnyPermission(...keys: string[]): boolean {
    if (!this.isAuthenticated()) return false;
    const perms = this._session()?.permissions ?? [];
    return keys.some(k => perms.includes(k));
  }

  /**
   * route -> the permission key(s) that grant access; the caller needs ANY one. Mirrors the route
   * guards in app.routes.ts (and the backend HomeRoutes.Map) EXACTLY, so a saved home preference is
   * honoured only while the caller still holds that route's permission.
   */
  private static readonly homePerms: Readonly<Record<string, readonly string[]>> = {
    '/': [PERM.dashboardView],
    '/calendar': [PERM.calendarView],
    '/pricing': [PERM.pricingView],
    '/settings': [PERM.settingsView],
    '/reporter': [PERM.reporterView, PERM.reporterManage, PERM.reporterSelf],
    '/fleet': [PERM.fleetView, PERM.reporterManage],
    '/chat': [PERM.chatRead],
    '/tracker': [PERM.trackerSelf],
    '/family': [PERM.familyUse],
    '/locations': [PERM.locationSelf],
    '/users': [PERM.usersView],
    '/activity': [PERM.activityView],
  };

  /** Whether the caller currently holds (one of) the permission(s) that the given home route requires. */
  canAccessHome(route: string): boolean {
    const required = AuthService.homePerms[route];
    return !!required && this.hasAnyPermission(...required);
  }

  /**
   * The route the app should land the user on. If they've saved a home preference (from /me) AND still
   * hold that route's permission, that wins; otherwise fall back to the first page they can actually
   * view, in nav order. Falls back to '/welcome' for a user with no page-view permissions (e.g. a
   * freshly auto-provisioned account awaiting approval).
   */
  homeRoute(): string {
    const saved = this._session()?.homeRoute;
    if (saved && this.canAccessHome(saved)) return saved;

    // First accessible page in NAV order — Usage group, then Tracker, Family, Chat, Admin group.
    // Uses canAccessHome (ANY-of) so the any-of routes (/reporter, /fleet) are covered, and it stays
    // in lock-step with homePerms + the nav grouping (every route is represented — no dead landings).
    const order = [
      '/', '/calendar', '/pricing', '/reporter', '/fleet',
      '/tracker', '/family', '/chat', '/locations',
      '/users', '/activity', '/settings',
    ];
    for (const route of order) {
      if (this.canAccessHome(route)) return route;
    }
    return '/welcome';
  }

  /** Live identity + permissions from the server (403 when the account is disabled/removed). */
  me(): Observable<{ userId: number; email: string; name: string; permissions: string[]; isEnabled: boolean; homeRoute: string | null }> {
    return this.http.get<{ userId: number; email: string; name: string; permissions: string[]; isEnabled: boolean; homeRoute: string | null }>('/api/auth/me');
  }

  /** Merge a fresh /me result into the stored session so the UI reflects permission/identity changes. */
  applyMe(me: { name: string; permissions: string[]; userId?: number; homeRoute?: string | null }): void {
    const s = this._session();
    if (!s) return;
    const updated: AuthSession = {
      ...s,
      name: me.name || s.name,
      permissions: me.permissions ?? [],
      // Carry the caller's own id so chat self-by-id checks work. Existing pre-3A sessions pick it up
      // here on their next /me poll; keep the prior value if a response somehow omits it.
      userId: me.userId ?? s.userId,
      // The login response doesn't carry the home preference, so /me is where it lands. The field is
      // always present on the MeDto (null = no preference), so take it verbatim.
      homeRoute: me.homeRoute ?? null,
    };
    this._session.set(updated);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(updated)); } catch { /* ignore */ }
  }

  /** Update the stored home-page preference locally after a successful PATCH /api/auth/home. */
  applyHomeRoute(route: string | null): void {
    const s = this._session();
    if (!s) return;
    const updated: AuthSession = { ...s, homeRoute: route };
    this._session.set(updated);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(updated)); } catch { /* ignore */ }
  }

  /** Valid bearer token, or null if missing/expired. */
  get token(): string | null {
    const s = this._session();
    return s && new Date(s.expiresAtUtc).getTime() > Date.now() ? s.token : null;
  }

  config(): Observable<{ googleClientId: string }> {
    return this.http.get<{ googleClientId: string }>('/api/auth/config');
  }

  loginWithGoogle(idToken: string): Observable<AuthSession> {
    return this.http.post<AuthSession>('/api/auth/google', { idToken }).pipe(
      tap(s => {
        this._session.set(s);
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch { /* ignore */ }
      }),
    );
  }

  logout(): void {
    // Best-effort sign-out ping so the server drops us from presence immediately rather than waiting
    // for our tracker entry to age out. Fire BEFORE clearing the session (we need the token), with
    // keepalive so it survives the navigation that follows logout. Raw fetch on purpose: injecting
    // HttpClient here would create a circular dep through the auth interceptor.
    const token = this.token;
    if (token) {
      try {
        fetch('/api/presence/offline', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token },
          keepalive: true,
        }).catch(() => { /* ignore */ });
      } catch { /* ignore */ }
    }
    this._session.set(null);
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    try { (window as unknown as { google?: any }).google?.accounts?.id?.disableAutoSelect?.(); } catch { /* ignore */ }
  }

  private restore(): AuthSession | null {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? (JSON.parse(raw) as AuthSession) : null;
    } catch {
      return null;
    }
  }
}
