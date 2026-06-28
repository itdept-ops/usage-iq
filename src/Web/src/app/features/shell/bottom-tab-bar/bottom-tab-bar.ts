import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink, RouterLinkActive } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';

import { AuthService } from '../../../core/auth';
import { PlatformService } from '../../../core/platform';
import { SnapRouteService } from '../../../core/snap-route';
import { bottomTabs, navGroups, type NavItem } from '../../../core/nav-model';
import { BetaBottomSheet } from '../../beta-ui';

/**
 * The GLOBAL mobile BOTTOM TAB BAR — the app's primary navigation when on a phone (the shell mounts a
 * single `<app-bottom-tab-bar>` whenever {@link PlatformService.isMobile} is true). It replaces the desktop
 * toolbar's dropdowns with the native-feel pattern: up to FOUR fixed primary tabs along the bottom edge,
 * plus a fifth "More" affordance that opens a bottom sheet listing every remaining destination + the
 * account/session rows that live in the desktop account menu.
 *
 * NAV IS DERIVED, NOT HAND-WRITTEN: both the fixed tabs and the More sheet read from the single
 * {@link bottomTabs}/{@link navGroups} derivation over `PAGE_REGISTRY` (core/nav-model), gated by the
 * caller's permissions — so it can never drift from the desktop nav or the route table. The gating stays
 * reactive because we read {@link AuthService.permissions} (a signal) inside the computeds.
 *
 * LOOK: glass/Strata surface from the shared beta-kit ({@link BetaBottomSheet}'s own tokens too), fixed to
 * the bottom with safe-area padding, 44px+ touch targets, the active tab tinted to the bar accent via
 * `routerLinkActive` (exact for the home route so '/' isn't always-on). Presentational + fully isolated:
 * it injects only AuthService / PlatformService / Router and edits no live page.
 *
 * CONTRACT (the shell depends on this):
 *   selector:  app-bottom-tab-bar   — mount once, only when on mobile.
 */
@Component({
  selector: 'app-bottom-tab-bar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './bottom-tab-bar.scss',
  imports: [RouterLink, RouterLinkActive, MatIconModule, BetaBottomSheet],
  template: `
    <!-- The GLOBAL "+ Snap" capture FAB: a persistent raised circular rear-camera button anchored above the
         bar center (the primary capture affordance on mobile). It opens the OS rear camera via the shared
         Snap & Route orchestrator (captureImage → classify → route-review). Shown only when the caller can
         capture (ai.vision + at least one writable destination — see SnapRouteService.canCapture). -->
    @if (canSnap()) {
      <button type="button" class="snapfab" (click)="snap()" aria-label="Snap a photo and route it">
        <mat-icon aria-hidden="true">photo_camera</mat-icon>
      </button>
    }

    <nav class="tabbar" aria-label="Primary">
      @for (t of tabs(); track t.id) {
        <a class="tab" [routerLink]="t.path" routerLinkActive="active"
           #rlaTab="routerLinkActive"
           [routerLinkActiveOptions]="t.path === '/' ? exact : nonExact"
           [attr.aria-current]="rlaTab.isActive ? 'page' : null"
           [attr.aria-label]="t.label">
          <span class="tab__icon"><mat-icon aria-hidden="true">{{ t.icon }}</mat-icon></span>
          <span class="tab__label">{{ t.label }}</span>
        </a>
      }

      <!-- The 5th affordance: "More" opens the full-nav + account sheet. Never a route, so it never
           shows the active tint — it's a neutral utility control. -->
      <button type="button" class="tab" (click)="openMore()"
              [attr.aria-expanded]="moreOpen()" aria-haspopup="dialog" aria-label="More — all sections">
        <span class="tab__icon"><mat-icon aria-hidden="true">more_horiz</mat-icon></span>
        <span class="tab__label">More</span>
      </button>
    </nav>

    <app-bs-sheet [(open)]="moreOpen" detent="full" label="All sections">
      <div class="more">
        <header class="more__head">
          <h2 class="more__title">All sections</h2>
          <p class="more__hint">Tap to jump anywhere</p>
        </header>

        @for (g of groups(); track g.group) {
          <section class="more__group">
            <h3 class="more__group-label">{{ g.group }}</h3>
            @for (item of g.items; track item.id) {
              <a class="more__row" [routerLink]="item.path" routerLinkActive="active"
                 #rlaRow="routerLinkActive"
                 [routerLinkActiveOptions]="item.path === '/' ? exact : nonExact"
                 [attr.aria-current]="rlaRow.isActive ? 'page' : null"
                 (click)="closeMore()">
                <span class="more__row-icon"><mat-icon aria-hidden="true">{{ item.icon }}</mat-icon></span>
                <span class="more__row-label">{{ item.label }}</span>
                <mat-icon class="more__row-chev" aria-hidden="true">chevron_right</mat-icon>
              </a>
            }
          </section>
        }

        <hr class="more__rule" aria-hidden="true" />

        <!-- Account / session — the rows that live in the desktop account menu. -->
        <section class="more__group">
          <h3 class="more__group-label">Account</h3>

          <a class="more__row" routerLink="/preferences" (click)="closeMore()">
            <span class="more__row-icon"><mat-icon aria-hidden="true">tune</mat-icon></span>
            <span class="more__row-label">Settings &amp; preferences</span>
            <mat-icon class="more__row-chev" aria-hidden="true">chevron_right</mat-icon>
          </a>

          <a class="more__row" routerLink="/profile" (click)="closeMore()">
            <span class="more__row-icon"><mat-icon aria-hidden="true">account_circle</mat-icon></span>
            <span class="more__row-label">My profile</span>
            <mat-icon class="more__row-chev" aria-hidden="true">chevron_right</mat-icon>
          </a>

          <button type="button" class="more__row" (click)="switchToDesktop()">
            <span class="more__row-icon"><mat-icon aria-hidden="true">desktop_windows</mat-icon></span>
            <span class="more__row-label">Switch to desktop site</span>
          </button>

          <button type="button" class="more__row more__row--danger" (click)="signOut()">
            <span class="more__row-icon"><mat-icon aria-hidden="true">logout</mat-icon></span>
            <span class="more__row-label">Sign out</span>
          </button>
        </section>
      </div>
    </app-bs-sheet>
  `,
})
export class BottomTabBar {
  private readonly auth = inject(AuthService);
  private readonly platform = inject(PlatformService);
  private readonly router = inject(Router);
  private readonly snapRoute = inject(SnapRouteService);

  /** Whether to show the global "+ Snap" capture FAB (ai.vision + ≥1 writable destination; reactive to /me). */
  protected readonly canSnap = this.snapRoute.canCapture;

  /** Open the OS rear camera → classify → route-review via the shared Snap & Route orchestrator. */
  protected snap(): void {
    this.snapRoute.request();
  }

  /** routerLinkActiveOptions — '/' must match exactly (else it's active on every route); the rest prefix-match. */
  protected readonly exact = { exact: true } as const;
  protected readonly nonExact = { exact: false } as const;

  /** Whether the "More" sheet is open. Two-way bound to the kit sheet's `open` model. */
  protected readonly moreOpen = signal(false);

  /** A permission predicate wired to the auth session — passed to the nav-model derivations. */
  private readonly has = (p: string): boolean => this.auth.hasPermission(p);

  /** The (up to 4) accessible fixed tabs. Reads permissions() so it re-derives when the session changes. */
  protected readonly tabs = computed<NavItem[]>(() => {
    this.auth.permissions(); // reactive dependency
    return bottomTabs(this.has);
  });

  /** The FULL grouped nav for the More sheet — every accessible destination, by group. */
  protected readonly groups = computed(() => {
    this.auth.permissions(); // reactive dependency
    return navGroups(this.has);
  });

  protected openMore(): void { this.moreOpen.set(true); }
  protected closeMore(): void { this.moreOpen.set(false); }

  /** Force the desktop variant (re-renders the current URL in the desktop shell) and close the sheet. */
  protected switchToDesktop(): void {
    this.closeMore();
    this.platform.setOverride('desktop');
  }

  /** Sign out, close the sheet, and return to the login screen. */
  protected signOut(): void {
    this.closeMore();
    this.auth.logout();
    void this.router.navigateByUrl('/login');
  }
}
