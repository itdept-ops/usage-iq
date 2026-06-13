import { Component, ElementRef, NgZone, afterNextRender, inject, signal, viewChild } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../core/auth';

declare const google: any;

@Component({
  selector: 'app-login',
  imports: [],
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

  constructor() {
    // Already signed in? Skip the login page.
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

      google.accounts.id.renderButton(this.btn().nativeElement, {
        theme: 'filled_blue',
        size: 'large',
        shape: 'pill',
        text: 'continue_with',
        logo_alignment: 'left',
        width: 280,
      });

      // One Tap — shows the "Continue as <name>" prompt for returning Google users.
      google.accounts.id.prompt();
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
