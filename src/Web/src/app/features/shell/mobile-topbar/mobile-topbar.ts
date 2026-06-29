import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  input,
  output,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router } from '@angular/router';
import { filter, map } from 'rxjs';
import { MatIconModule } from '@angular/material/icon';

import { bottomTabs } from '../../../core/nav-model';

/**
 * MOBILE TOP BAR — the slim glass strip that REPLACES the full desktop toolbar on mobile, on EVERY
 * in-app route. It generalizes today's `.slimbar` immersive bar (app.html / app.ts immersiveBack)
 * from the beta surfaces to the whole app: a context-aware BACK affordance on the left, a minimal
 * brand+BETA mark, and a trailing slot for the account avatar/menu on the right.
 *
 * PRESENTATIONAL + ISOLATED. It owns the bar's structure, glass look (beta-ui kit tokens) and the
 * back-navigation logic ONLY. It deliberately does NOT mount the account menu itself — that menu
 * (`#userMenu`/`#homeMenu`) lives at the SHELL template root because Angular template refs can't
 * cross component boundaries. The shell wires the avatar one of two ways (see INTEGRATION below).
 *
 * ── BACK AFFORDANCE (context-aware) ─────────────────────────────────────────────────────────────
 * The back button shows on any route that is NOT one of the bottom-tab roots ('/', '/tracker',
 * '/chat', '/family') — those are top-level destinations, so a back arrow there would be noise.
 * Tapping it goes history.back() when there's somewhere to return to, else navigates to '/'. This
 * keeps the user inside the SPA shell and never strands them on a dead end. (Mirrors the spirit of
 * app.ts immersiveBack(), simplified to a generic app-wide rule — no /beta-specific routing here.)
 *
 * ── INTEGRATION (what the shell must bind) — selector: `app-mobile-topbar` ──────────────────────
 * Two avatar wiring options; pick ONE:
 *
 *  (A) PROJECTED avatar (RECOMMENDED — keeps the existing #userMenu binding intact). Project the
 *      shell's own menu-trigger button into the trailing slot with the `topbarTrailing` attribute:
 *
 *        <app-mobile-topbar>
 *          <button topbarTrailing mat-button class="user" [matMenuTriggerFor]="userMenu"
 *                  #t="matMenuTrigger" [class.user--open]="t.menuOpen"
 *                  aria-haspopup="menu" aria-label="Account menu">
 *            @if (auth.session()?.picture; as pic) {
 *              <img class="user__avatar" [src]="pic" alt="" referrerpolicy="no-referrer" />
 *            } @else {
 *              <span class="user__avatar user__avatar--init">{{ initials() }}</span>
 *            }
 *            <mat-icon class="user__chev" aria-hidden="true">expand_more</mat-icon>
 *          </button>
 *        </app-mobile-topbar>
 *
 *      Because the trigger is the SHELL's element, it binds the root-level `#userMenu` ref exactly
 *      as the desktop `.user` trigger and today's `.slimbar` trigger already do — account / profile /
 *      sign-out / home-route all keep working with ZERO new menu plumbing.
 *
 *  (B) BUILT-IN avatar (simplest — no projection). Bind the optional avatar inputs and listen for
 *      the (account) output, then open the menu however the shell prefers (e.g. programmatically):
 *
 *        <app-mobile-topbar
 *          [avatarUrl]="auth.session()?.picture ?? null"
 *          [initials]="initials()"
 *          (account)="onAccountTap()" />
 *
 *      When NOTHING is projected into the trailing slot AND the session is signed in, the component
 *      renders its own avatar button that emits (account) on tap. If a `topbarTrailing` element IS
 *      projected, the built-in avatar is suppressed (the projected one wins).
 *
 * INPUTS:
 *   authed     (boolean, default true)  — whether a session is signed in; gates the built-in avatar.
 *   avatarUrl  (string|null, default null) — built-in avatar image src (option B only).
 *   initials   (string, default 'U')    — built-in avatar fallback initials (option B only).
 *   showBeta   (boolean, default true)   — show the small "BETA" tag next to the brand mark.
 *   homePath   (string, default '/')     — fallback destination when there's no history to pop.
 *
 * OUTPUTS:
 *   account (void) — fired when the BUILT-IN avatar is tapped (option B). Not used in option A.
 *
 * The component reads the Router itself for the current path (so the back affordance is reactive
 * with no input needed). It does NOT edit app.ts/app.html.
 */
@Component({
  selector: 'app-mobile-topbar',
  standalone: true,
  imports: [MatIconModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="mtb">
      @if (showBack()) {
        <button type="button" class="mtb__back" (click)="back()" aria-label="Go back">
          <mat-icon aria-hidden="true">arrow_back_ios_new</mat-icon>
        </button>
      } @else {
        <!-- Keep the brand optically left-aligned on the tab roots where there's no back arrow. -->
        <span class="mtb__back-spacer" aria-hidden="true"></span>
      }

      <span class="mtb__brand" aria-hidden="true">
        <svg
          class="mtb__logo"
          width="20"
          height="20"
          viewBox="0 0 64 64"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <defs>
            <radialGradient id="ic_core-mtb" cx="50%" cy="36%" r="68%">
              <stop offset="0%" stop-color="#fbf3ff" />
              <stop offset="34%" stop-color="#c79bff" />
              <stop offset="68%" stop-color="#7e63f4" />
              <stop offset="100%" stop-color="#4a37c4" />
            </radialGradient>
            <linearGradient id="ic_sq-mtb" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stop-color="#241c52" />
              <stop offset="100%" stop-color="#0a081e" />
            </linearGradient>
          </defs>
          <rect
            x="4"
            y="4"
            width="56"
            height="56"
            rx="16"
            fill="url(#ic_sq-mtb)"
            stroke="rgba(176,107,255,.42)"
            stroke-width="1.2"
          />
          <ellipse cx="32" cy="32" rx="19" ry="19" fill="none" stroke="rgba(176,107,255,.28)" stroke-width="1.4" />
          <ellipse cx="32" cy="32" rx="12.5" ry="12.5" fill="none" stroke="rgba(52,227,232,.20)" stroke-width="1.1" />
          <circle cx="32" cy="32" r="8.5" fill="url(#ic_core-mtb)" />
          <circle cx="45.5" cy="18.5" r="2.7" fill="#34e3e8" />
        </svg>
        @if (showBeta()) {
          <span class="mtb__beta">BETA</span>
        }
      </span>

      <span class="mtb__spacer"></span>

      <!-- Trailing slot: the shell projects its own #userMenu trigger here (option A). -->
      <span class="mtb__trailing">
        <ng-content select="[topbarTrailing]"></ng-content>

        <!-- Built-in fallback avatar (option B): only when nothing is projected AND signed in. -->
        @if (authed() && !hasProjectedTrailing()) {
          <button
            type="button"
            class="mtb__avatar-btn"
            aria-haspopup="menu"
            aria-label="Account menu"
            (click)="account.emit()"
          >
            @if (avatarUrl()) {
              <img class="mtb__avatar" [src]="avatarUrl()" alt="" referrerpolicy="no-referrer" />
            } @else {
              <span class="mtb__avatar mtb__avatar--init">{{ initials() }}</span>
            }
          </button>
        }
      </span>
    </header>
  `,
  styles: [
    `
      /* Slim glass strip — generalizes the shell's .slimbar to all mobile routes. The token names
         intentionally mirror app.scss .slimbar (sticky, ~52px + safe-area-top, dark translucent
         glass, hairline) so it reads identically; the beta-ui kit's blur/ink language frames it. */
      :host {
        display: block;
      }
      .mtb {
        position: sticky;
        top: 0;
        z-index: 50;
        height: calc(52px + env(safe-area-inset-top, 0px));
        min-height: calc(52px + env(safe-area-inset-top, 0px));
        padding: env(safe-area-inset-top, 0px) max(8px, env(safe-area-inset-left, 0px)) 0
          max(8px, env(safe-area-inset-right, 0px));
        display: flex;
        align-items: center;
        gap: 4px;

        /* Dark immersive glass (matches .slimbar.glass) so the bar blends on every surface. */
        background: rgba(10, 11, 18, 0.72);
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        -webkit-backdrop-filter: blur(12px);
        backdrop-filter: blur(12px);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05);
      }

      /* Back affordance — a quiet icon button pinned light so it reads on the dark bar. */
      .mtb__back {
        flex: 0 0 auto;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 40px;
        height: 40px;
        padding: 0;
        border: none;
        border-radius: var(--r-pill, 999px);
        background: transparent;
        color: rgba(255, 255, 255, 0.72);
        cursor: pointer;
        -webkit-tap-highlight-color: transparent;
        touch-action: manipulation;
        transition: color 140ms var(--ease-out, cubic-bezier(0.22, 1, 0.36, 1));
      }
      .mtb__back mat-icon {
        font-size: 19px;
        width: 19px;
        height: 19px;
      }
      .mtb__back:hover {
        color: #fff;
      }
      .mtb__back:active {
        opacity: 0.7;
      }
      .mtb__back:focus-visible {
        outline: 2px solid var(--focus, #3d8bff);
        outline-offset: 2px;
      }
      /* Reserve the back button's footprint on tab roots so the brand never shifts horizontally. */
      .mtb__back-spacer {
        flex: 0 0 auto;
        width: 40px;
        height: 40px;
      }

      /* Minimal brand mark: the logo glyph + an optional small "BETA" tag. */
      .mtb__brand {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        margin-left: 2px;
      }
      .mtb__logo {
        display: block;
        width: 20px;
        height: 20px;
        flex: 0 0 auto;
        filter: drop-shadow(0 0 6px rgba(61, 139, 255, 0.4));
      }
      .mtb__beta {
        font-family: var(--font-ui, "Plus Jakarta Sans", system-ui, sans-serif);
        font-size: 10.5px;
        font-weight: 700;
        letter-spacing: 0.14em;
        line-height: 1;
        padding: 2px 6px;
        border-radius: var(--r-pill, 999px);
        color: var(--accent-b, #3fd8d0);
        border: 1px solid color-mix(in srgb, var(--accent-b, #3fd8d0) 35%, transparent);
        background: color-mix(in srgb, var(--accent-b, #3fd8d0) 10%, transparent);
      }

      .mtb__spacer {
        flex: 1 1 auto;
      }

      .mtb__trailing {
        flex: 0 0 auto;
        display: inline-flex;
        align-items: center;
      }

      /* Built-in fallback avatar (option B). The projected (option A) trigger carries its own .user
         styles from the shell, so this only paints when nothing is projected. */
      .mtb__avatar-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 40px;
        height: 40px;
        padding: 0;
        border: none;
        background: transparent;
        cursor: pointer;
        border-radius: var(--r-pill, 999px);
        -webkit-tap-highlight-color: transparent;
        touch-action: manipulation;
      }
      .mtb__avatar-btn:active {
        opacity: 0.8;
      }
      .mtb__avatar-btn:focus-visible {
        outline: 2px solid var(--focus, #3d8bff);
        outline-offset: 2px;
      }
      .mtb__avatar {
        width: 30px;
        height: 30px;
        border-radius: 50%;
        object-fit: cover;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }
      .mtb__avatar--init {
        font-family: var(--font-ui, "Plus Jakarta Sans", system-ui, sans-serif);
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.02em;
        color: #fff;
        background: linear-gradient(135deg, var(--accent-a, #3d8bff), var(--accent-b, #8b7cff));
      }

      /* Reduced-motion: collapse the transitions (decorative only). */
      @media (prefers-reduced-motion: reduce) {
        .mtb__back {
          transition: none;
        }
      }
    `,
  ],
})
export class MobileTopbar {
  private readonly router = inject(Router);

  /** Whether a session is signed in — gates the built-in fallback avatar (option B). */
  readonly authed = input<boolean>(true);
  /** Built-in avatar image src (option B). Null falls back to initials. */
  readonly avatarUrl = input<string | null>(null);
  /** Built-in avatar fallback initials (option B). */
  readonly initials = input<string>('U');
  /** Show the small "BETA" tag beside the brand mark. */
  readonly showBeta = input<boolean>(true);
  /** Fallback destination when the back affordance has no history to pop. */
  readonly homePath = input<string>('/');

  /** Fired when the BUILT-IN avatar is tapped (option B); unused when the shell projects its own. */
  readonly account = output<void>();

  /**
   * The bottom-tab ROOTS. On these the back arrow is hidden (they're top-level destinations); on
   * everything else it shows. Matched exactly for '/', else exact-or-child for the rest.
   *
   * DERIVED from the SAME source as the bottom tab bar ({@link bottomTabs} over PAGE_REGISTRY) so the
   * "is this a tab root?" check can never drift from the actual tabs. We pass `() => true` to include
   * every tab page regardless of perms — for the "is a top-level tab route" test we want the full set.
   */
  private static readonly TAB_ROUTES = bottomTabs(() => true).map((t) => t.path);

  /** The current route path (no query), kept reactive off NavigationEnd; seeds from the live url. */
  private readonly currentPath = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map((e) => e.urlAfterRedirects.split('?')[0]),
    ),
    { initialValue: this.router.url.split('?')[0] },
  );

  /** Show the back affordance whenever the current path is NOT a bottom-tab root. */
  readonly showBack = computed(() => {
    const path = this.currentPath();
    return !MobileTopbar.TAB_ROUTES.some((r) =>
      r === '/' ? path === '/' : path === r || path.startsWith(r + '/'),
    );
  });

  /**
   * Whether the shell projected a `[topbarTrailing]` element into the trailing slot. When it did,
   * the built-in fallback avatar is suppressed (the projected #userMenu trigger wins). Read from
   * the host so it's evaluated against the *actual* projected light-DOM, not an input flag.
   */
  protected hasProjectedTrailing(): boolean {
    return this.hostEl.nativeElement.querySelector('[topbarTrailing]') !== null;
  }
  private readonly hostEl = inject<ElementRef<HTMLElement>>(ElementRef);

  /**
   * Context-aware back: pop history when there's somewhere to return to, else go to the home path.
   * Keeps the user inside the SPA shell (never a dead end). Mirrors immersiveBack()'s safety net.
   */
  back(): void {
    if (typeof history !== 'undefined' && history.length > 1) {
      history.back();
      return;
    }
    void this.router.navigateByUrl(this.homePath());
  }
}
