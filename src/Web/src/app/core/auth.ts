import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { Observable, tap } from 'rxjs';
import { AuthSession } from './models';

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
