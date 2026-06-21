import { Component, DestroyRef, ElementRef, NgZone, afterNextRender, inject, signal, viewChild } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { MatIconModule } from '@angular/material/icon';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../core/auth';
import { MarketingNav } from '../marketing/marketing-nav';
import { MarketingFooter } from '../marketing/marketing-footer';

declare const google: any;

/** Focused Google sign-in surface for Usage IQ. Bare layout, marketing chrome. */
@Component({
  selector: 'app-signin',
  imports: [MatIconModule, MarketingNav, MarketingFooter],
  templateUrl: './signin.html',
  styleUrl: './signin.scss',
})
export class SignIn {
  private auth = inject(AuthService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private zone = inject(NgZone);
  private destroyRef = inject(DestroyRef);
  private btn = viewChild.required<ElementRef<HTMLDivElement>>('gbtn');

  /** GIS poll handle, cleared on destroy if the user leaves /signin mid-load. */
  private gisTimer?: ReturnType<typeof setInterval>;

  readonly error = signal<string | null>(null);
  readonly busy = signal(false);

  constructor() {
    if (this.auth.isAuthenticated()) {
      this.router.navigateByUrl(this.returnUrl());
      return;
    }
    afterNextRender(() => void this.initGoogle());
    this.destroyRef.onDestroy(() => {
      if (this.gisTimer !== undefined) clearInterval(this.gisTimer);
    });
  }

  private returnUrl(): string {
    return this.route.snapshot.queryParamMap.get('returnUrl') || this.auth.homeRoute();
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
        // FedCM is required for One Tap in current Chrome; without it prompt() is a no-op.
        use_fedcm_for_prompt: true,
      });

      // Inline dark button. Its white backing (a cross-origin GIS iframe) is removed in CSS via
      // `iframe[src*="accounts.google.com"] { color-scheme: normal }` in styles.scss.
      google.accounts.id.renderButton(this.btn().nativeElement, {
        theme: 'filled_black',
        size: 'large',
        shape: 'pill',
        text: 'continue_with',
        logo_alignment: 'left',
        width: 280,
      });

      // Top-right One Tap "Continue as <name>" card for returning users.
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
      this.gisTimer = timer;
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
