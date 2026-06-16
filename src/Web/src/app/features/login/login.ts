import { Component, ElementRef, NgZone, afterNextRender, inject, signal, viewChild } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { MatIconModule } from '@angular/material/icon';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../core/auth';

declare const google: any;

interface Feature { icon: string; title: string; text: string; }

@Component({
  selector: 'app-login',
  imports: [MatIconModule],
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

  readonly features: Feature[] = [
    { icon: 'hub', title: 'Multi-source', text: 'Claude Code and OpenAI Codex usage, de-duplicated and unified into one view.' },
    { icon: 'insights', title: 'Cost & tokens', text: 'Break spend down by day, project, model, or session — with an editable pricing table.' },
    { icon: 'shield_person', title: 'Role-based access', text: 'Google sign-in with per-user permissions, re-checked on every request.' },
    { icon: 'sync', title: 'Always fresh', text: 'A background timer keeps usage in sync — the bar shows when it last ran.' },
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
