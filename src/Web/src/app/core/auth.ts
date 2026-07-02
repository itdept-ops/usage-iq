import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { Observable, tap } from 'rxjs';
import { AuthSession, MeResponse, ProfilePrefs } from './models';
import { HOME_OPTIONS, HOME_PERMS } from './home-options';

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
   * Whether the caller currently holds (one of) the permission(s) that the given home route requires.
   * The route -> any-of-perms map is {@link HOME_PERMS} — the SINGLE source of truth shared with both home
   * pickers (the profile dropdown + beta Settings) and the backend allowlist HomeRoutes.cs. This previously
   * listed only ~13 live routes, so a saved BETA home (or /ask, /trophies, …) silently failed the check and
   * fell back to another page. Now every selectable route is covered because the same list drives both.
   */
  canAccessHome(route: string): boolean {
    const required = HOME_PERMS[route];
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

    // First accessible page in declaration order, iterating HOME_OPTIONS directly so this fallback can
    // NEVER drift from the picker (a hand-curated subset previously stranded users whose only permission
    // was on an omitted route — e.g. /grocery, /recipes, /bills — on /welcome). Uses canAccessHome
    // (ANY-of) so any-of routes (/reporter, /fleet) are covered. Only '/welcome' when the caller truly
    // holds no page-view permission.
    for (const opt of HOME_OPTIONS) {
      if (this.canAccessHome(opt.route)) return opt.route;
    }
    return '/welcome';
  }

  /** Live identity + permissions + the caller's own display/presence prefs (403 when disabled/removed). */
  me(): Observable<MeResponse> {
    return this.http.get<MeResponse>('/api/auth/me');
  }

  /** Merge a fresh /me result into the stored session so the UI reflects permission/identity changes. */
  applyMe(me: MeResponse): void {
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
      // Mirror the caller's own display/presence prefs so the shell (and the Profile editor) read them
      // straight off the session without a second fetch. /me always carries these, so take them verbatim.
      displayNameMode: me.displayNameMode,
      nickname: me.nickname ?? null,
      appearOffline: me.appearOffline,
      presenceStatus: me.presenceStatus ?? null,
      shareAutoContext: me.shareAutoContext,
      shareActivity: me.shareActivity,
      viewActivityFeed: me.viewActivityFeed,
      nudgesOptOut: me.nudgesOptOut,
    };
    this._session.set(updated);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(updated)); } catch { /* ignore */ }
  }

  /**
   * Merge the caller's own profile/presence prefs into the session after a successful PATCH
   * /api/auth/profile, so the shell (appear-offline hint, name preview) reflects them immediately —
   * without waiting for the next /me poll.
   */
  applyProfilePrefs(p: ProfilePrefs): void {
    const s = this._session();
    if (!s) return;
    const updated: AuthSession = {
      ...s,
      displayNameMode: p.displayNameMode,
      nickname: p.nickname ?? null,
      appearOffline: p.appearOffline,
      presenceStatus: p.presenceStatus ?? null,
      shareAutoContext: p.shareAutoContext,
      shareActivity: p.shareActivity,
      viewActivityFeed: p.viewActivityFeed,
      nudgesOptOut: p.nudgesOptOut,
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
      if (!raw) return null;
      const parsed = JSON.parse(raw) as unknown;
      return this.isValidSession(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  /**
   * Treat the persisted blob as UNTRUSTED input (localStorage is writable by any XSS foothold or on a
   * shared/kiosk device) rather than an as-cast AuthSession: a tampered object with a far-future
   * expiresAtUtc + a full permissions array would otherwise make the client render permission-gated UI
   * and route to admin homes. The forged token still fails server RequirePermission checks, but this
   * keeps the client from trusting a malformed/forged shape. Require the load-bearing fields to be
   * present and correctly typed (non-empty string token, a parseable ISO expiry, an all-string
   * permissions array); anything else is discarded so the user is treated as unauthenticated.
   */
  private isValidSession(v: unknown): v is AuthSession {
    if (!v || typeof v !== 'object') return false;
    const s = v as Record<string, unknown>;
    if (typeof s['token'] !== 'string' || s['token'].length === 0) return false;
    if (typeof s['expiresAtUtc'] !== 'string' || Number.isNaN(new Date(s['expiresAtUtc']).getTime())) return false;
    if (!Array.isArray(s['permissions']) || !s['permissions'].every((p) => typeof p === 'string')) return false;
    return true;
  }
}
