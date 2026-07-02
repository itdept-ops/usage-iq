import {
  Component,
  ElementRef,
  NgZone,
  afterNextRender,
  inject,
  signal,
  viewChild,
  ChangeDetectionStrategy,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { MatIconModule } from '@angular/material/icon';
import { normalizeHome } from '../../core/nav-model';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../core/auth';
import { ensureGis } from '../../core/gis-loader';
import { MarketingNav } from '../marketing/marketing-nav';
import { MarketingFooter } from '../marketing/marketing-footer';
import { INTRO_SEEN_KEY } from '../intro/intro.page';

declare const google: any;

/** Focused Google sign-in surface for Usage IQ. Bare layout, marketing chrome. */
@Component({
  selector: 'app-signin',
  imports: [MatIconModule, MarketingNav, MarketingFooter],
  templateUrl: './signin.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './signin.scss',
})
export class SignIn {
  private auth = inject(AuthService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private zone = inject(NgZone);
  private btn = viewChild.required<ElementRef<HTMLDivElement>>('gbtn');

  readonly error = signal<string | null>(null);
  readonly busy = signal(false);

  constructor() {
    if (this.auth.isAuthenticated()) {
      this.router.navigateByUrl(this.returnUrl());
      return;
    }
    // First run: an unauthenticated visitor who has never seen the intro carousel is sent there
    // first. The intro sets the seen-flag then routes back to /login, so this fires at most once.
    if (this.introUnseen()) {
      this.router.navigateByUrl('/intro');
      return;
    }
    afterNextRender(() => void this.initGoogle());
  }

  /** True when the first-run intro flag is unset (and storage is readable). */
  private introUnseen(): boolean {
    try {
      return localStorage.getItem(INTRO_SEEN_KEY) !== '1';
    } catch {
      // Storage blocked (private mode / hardened settings) — don't loop into the intro; show sign-in.
      return false;
    }
  }

  private returnUrl(): string {
    // An explicit ?returnUrl is honoured only when it is a same-origin in-app path (a single leading "/",
    // not "//" which is protocol-relative) — otherwise an attacker-crafted link could bounce the user to
    // any deep link post-login. Anything else falls back to the normalized home route, so a saved legacy
    // /beta/* or /tracker-beta home lands on its canonical page (the device then picks desktop/mobile).
    const raw = this.route.snapshot.queryParamMap.get('returnUrl');
    if (raw && raw.startsWith('/') && !raw.startsWith('//')) {
      return raw;
    }
    return normalizeHome(this.auth.homeRoute());
  }

  private async initGoogle(): Promise<void> {
    try {
      const cfg = await firstValueFrom(this.auth.config());
      if (!cfg.googleClientId) {
        this.error.set('Google sign-in is not configured on the server.');
        return;
      }
      await ensureGis();

      google.accounts.id.initialize({
        client_id: cfg.googleClientId,
        callback: (resp: { credential: string }) =>
          this.zone.run(() => this.handleCredential(resp.credential)),
        auto_select: false,
        cancel_on_tap_outside: false,
        // FedCM is required for One Tap in current Chrome; without it prompt() is a no-op.
        use_fedcm_for_prompt: true,
        // iOS Safari (and other ITP browsers) don't support FedCM and block the default popup's
        // storage access — which left the Google sign-in window unable to take keyboard input on
        // iPhone. itp_support enables GIS's ITP-compatible upgraded flow so sign-in works on Safari.
        itp_support: true,
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

  private handleCredential(idToken: string): void {
    this.busy.set(true);
    this.error.set(null);
    this.auth.loginWithGoogle(idToken).subscribe({
      next: () => this.router.navigateByUrl(this.returnUrl()),
      error: (err: HttpErrorResponse) => {
        this.busy.set(false);
        this.error.set(
          err.status === 403
            ? (err.error?.message ?? 'This account is not authorized to access Usage IQ.')
            : 'Sign-in failed. Please try again.',
        );
      },
    });
  }
}
