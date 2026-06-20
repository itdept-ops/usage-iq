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
   * The first page route the user can actually view, in nav order. Used as the post-login
   * landing target and the "home" of the app. Falls back to '/welcome' for a user with no
   * page-view permissions (e.g. a freshly auto-provisioned account awaiting approval).
   */
  homeRoute(): string {
    const order: [string, string][] = [
      [PERM.dashboardView, '/'],
      [PERM.calendarView, '/calendar'],
      [PERM.pricingView, '/pricing'],
      [PERM.settingsView, '/settings'],
      [PERM.reporterView, '/reporter'],
      [PERM.reporterManage, '/reporter'],
      [PERM.reporterSelf, '/reporter'],
      [PERM.usersView, '/users'],
      [PERM.activityView, '/activity'],
    ];
    for (const [perm, route] of order) {
      if (this.hasPermission(perm)) return route;
    }
    return '/welcome';
  }

  /** Live identity + permissions from the server (403 when the account is disabled/removed). */
  me(): Observable<{ email: string; name: string; permissions: string[]; isEnabled: boolean }> {
    return this.http.get<{ email: string; name: string; permissions: string[]; isEnabled: boolean }>('/api/auth/me');
  }

  /** Merge a fresh /me result into the stored session so the UI reflects permission changes. */
  applyMe(me: { name: string; permissions: string[] }): void {
    const s = this._session();
    if (!s) return;
    const updated: AuthSession = { ...s, name: me.name || s.name, permissions: me.permissions ?? [] };
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
