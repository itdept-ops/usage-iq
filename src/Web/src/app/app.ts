import { Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterOutlet, RouterLink, RouterLinkActive, Router, NavigationEnd } from '@angular/router';
import { timer, switchMap, catchError, of, filter } from 'rxjs';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatMenuModule } from '@angular/material/menu';

import { Api } from './core/api';
import { AuthService } from './core/auth';
import { SyncStatus } from './core/models';
import { timeAgo, humanizeInterval } from './shared/format';

@Component({
  selector: 'app-root',
  imports: [
    RouterOutlet, RouterLink, RouterLinkActive,
    MatToolbarModule, MatButtonModule, MatIconModule, MatTooltipModule, MatMenuModule,
  ],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  private api = inject(Api);
  private router = inject(Router);
  readonly auth = inject(AuthService);

  readonly status = signal<SyncStatus | null>(null);
  private readonly now = signal(Date.now());

  /**
   * Widget pop-outs, public shared views, and the public marketing pages (landing / features /
   * how-it-works) render bare — they bring their own chrome, so the app toolbar is hidden.
   */
  readonly bareLayout = signal(App.isBare(this.router.url));
  private static readonly barePrefixes = ['/widget', '/share', '/login', '/features', '/how-it-works'];
  private static isBare(url: string): boolean {
    const path = url.split('?')[0];
    return App.barePrefixes.some(p => path === p || path.startsWith(p + '/'));
  }

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

  readonly initials = computed(() => {
    const s = this.auth.session();
    const name = s?.name || s?.email || '';
    const parts = name.split(/[\s@.]+/).filter(Boolean);
    return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || 'U';
  });

  constructor() {
    this.router.events
      .pipe(filter(e => e instanceof NavigationEnd), takeUntilDestroyed())
      .subscribe(() => this.bareLayout.set(App.isBare(this.router.url)));

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
      .subscribe(me => { if (me) this.auth.applyMe(me); });
  }

  private onMeError(err: { status?: number }): void {
    if (err?.status === 401 || err?.status === 403) {
      this.auth.logout();
      this.status.set(null);
      this.router.navigate(['/login']);
    }
  }

  logout(): void {
    this.auth.logout();
    this.status.set(null);
    this.router.navigate(['/login']);
  }
}
