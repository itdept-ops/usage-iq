import { Component, ElementRef, NgZone, afterNextRender, inject, signal, viewChild } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { MatIconModule } from '@angular/material/icon';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../core/auth';
import { MarketingNav } from '../marketing/marketing-nav';
import { MarketingFooter } from '../marketing/marketing-footer';

declare const google: any;

interface Feature { icon: string; title: string; text: string; }
interface Stat { value: string; label: string; }
interface Source { name: string; tag: string; }
interface Step { n: string; title: string; text: string; }

@Component({
  selector: 'app-login',
  imports: [MatIconModule, RouterLink, MarketingNav, MarketingFooter],
  templateUrl: './login.html',
  styleUrl: './login.scss',
})
export class Login {
  private auth = inject(AuthService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private zone = inject(NgZone);
  private btn = viewChild.required<ElementRef<HTMLDivElement>>('gbtn');

  readonly error = signal<string | null>(null);
  readonly busy = signal(false);

  readonly sources: Source[] = [
    { name: 'Claude Code', tag: 'Anthropic' },
    { name: 'OpenAI Codex', tag: 'Codex CLI' },
    { name: 'Self-hosted', tag: 'Your infra' },
    { name: 'PostgreSQL', tag: 'Your data' },
  ];

  readonly stats: Stat[] = [
    { value: '2', label: 'Agents unified' },
    { value: '1', label: 'Command center' },
    { value: '6', label: 'Token tiers tracked' },
    { value: '100%', label: 'Self-hosted' },
  ];

  readonly features: Feature[] = [
    { icon: 'hub', title: 'Multi-source', text: 'Claude Code and OpenAI Codex usage, de-duplicated and unified into one view.' },
    { icon: 'insights', title: 'Cost & tokens', text: 'Break spend down by day, project, model, or session — with an editable pricing table.' },
    { icon: 'calendar_month', title: 'Activity calendar', text: 'A GitHub-style heatmap of every active hour, with session-level drill-down.' },
    { icon: 'shield_person', title: 'Role-based access', text: 'Google sign-in with per-user permissions, re-checked on every request.' },
    { icon: 'ios_share', title: 'Shareable views', text: 'Public, time-limited links to a read-only dashboard — revoke them anytime.' },
    { icon: 'sync', title: 'Always fresh', text: 'A background reporter posts new usage on a timer; the bar shows when it last ran.' },
  ];

  readonly steps: Step[] = [
    { n: '01', title: 'Run the reporter', text: 'A tiny agent on your machine reads Claude Code & Codex logs and posts new usage to your server.' },
    { n: '02', title: 'It lands in Postgres', text: 'Records are de-duplicated, priced from your editable rate table, and bucketed by your timezone.' },
    { n: '03', title: 'You see everything', text: 'Filter by date, project, model or session. Cost, tokens, cache tiers — all on one screen.' },
  ];

  readonly terminal: string[] = [
    '$ usage-iq reporter --watch',
    '  scanning ~/.claude/projects … 2,264 files',
    '  + 318 new records  (412 deduped)',
    '  posting → https://usageiq.online/api/ingest',
    '  ✓ synced 14.15M tokens · $182.4',
    '  next run in 30:00 …',
  ];

  constructor() {
    if (this.auth.isAuthenticated()) {
      this.router.navigateByUrl(this.returnUrl());
      return;
    }
    afterNextRender(() => void this.initGoogle());
  }

  private returnUrl(): string {
    return this.route.snapshot.queryParamMap.get('returnUrl') || '/';
  }

  scrollTop(ev: Event): void {
    ev.preventDefault();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  private async initGoogle(): Promise<void> {
    try {
      const cfg = await firstValueFrom(this.auth.config());
      if (!cfg.googleClientId) {
        this.error.set('Google sign-in is not configured on the server.');
        return;
      }
      await this.waitForGis();

      google.accounts.id.initialize({
        client_id: cfg.googleClientId,
        callback: (resp: { credential: string }) => this.zone.run(() => this.handleCredential(resp.credential)),
        auto_select: false,
        cancel_on_tap_outside: false,
      });

      // filled_black is Google's official dark button — it matches the dark theme (no clashing white
      // card) and still personalizes to "Continue as <name>" for returning users.
      google.accounts.id.renderButton(this.btn().nativeElement, {
        theme: 'filled_black',
        size: 'large',
        shape: 'pill',
        text: 'continue_with',
        logo_alignment: 'left',
        width: 280,
      });

      // No One Tap prompt() — its "Continue as" card is a cross-origin Google iframe with a white
      // background we can't recolor; the dark button above gives the same one-click sign-in.
    } catch {
      this.error.set('Could not load Google sign-in. Check your connection and try again.');
    }
  }

  private waitForGis(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let tries = 0;
      const timer = setInterval(() => {
        if ((window as unknown as { google?: any }).google?.accounts?.id) {
          clearInterval(timer);
          resolve();
        } else if (++tries > 60) {
          clearInterval(timer);
          reject(new Error('Google Identity Services failed to load'));
        }
      }, 100);
    });
  }

  private handleCredential(idToken: string): void {
    this.busy.set(true);
    this.error.set(null);
    this.auth.loginWithGoogle(idToken).subscribe({
      next: () => this.router.navigateByUrl(this.returnUrl()),
      error: (err: HttpErrorResponse) => {
        this.busy.set(false);
        this.error.set(err.status === 403
          ? (err.error?.message ?? 'This account is not authorized to access Usage IQ.')
          : 'Sign-in failed. Please try again.');
      },
    });
  }
}
