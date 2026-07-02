import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive } from '@angular/router';
import { filter, map } from 'rxjs';
import { MatIconModule } from '@angular/material/icon';

import { AuthService } from '../../../core/auth';
import { PlatformService } from '../../../core/platform';
import { MobileNavService } from '../../../core/mobile-nav';
import { navGroups, type NavGroupModel } from '../../../core/nav-model';
import { DialogA11yDirective } from '../../../core/dialog-a11y.directive';

/**
 * MOBILE LEFT SIDEBAR — the FiMobile `.sidebar-wrap` offcanvas drawer. Replaces the old bottom-tab
 * "More" sheet: slides in from the LEFT with a scrim, carries the profile header, the FULL grouped
 * nav (every accessible destination, by section), and the account/session rows (Settings, Profile,
 * Switch to desktop, Sign out). Opened by the hamburger in {@link MobileTopbar} via {@link MobileNavService}.
 *
 * Mounted once at the shell root (mobile shell only). Presentational + isolated; derives its nav from
 * the same {@link navGroups} over PAGE_REGISTRY the desktop nav uses, so it never drifts.
 */
@Component({
  selector: 'app-mobile-sidebar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, RouterLinkActive, MatIconModule, DialogA11yDirective],
  template: `
    @if (nav.sidebarOpen()) {
    <div class="scrim open" (click)="nav.close()" aria-hidden="true"></div>

    <aside class="drawer open" role="dialog" aria-modal="true"
           aria-label="Navigation menu" dialogA11y (dismiss)="nav.close()">
      <!-- Profile header card -->
      @if (auth.session(); as s) {
        <header class="prof">
          @if (s.picture) {
            <img class="prof__avatar" [src]="s.picture" alt="" width="46" height="46"
                 referrerpolicy="no-referrer" />
          } @else {
            <span class="prof__avatar prof__avatar--init">{{ initials() }}</span>
          }
          <div class="prof__id">
            <p class="prof__name">{{ s.name }}</p>
            <p class="prof__email" [title]="s.email">{{ s.email }}</p>
          </div>
          <button type="button" class="prof__out" (click)="signOut()" aria-label="Sign out"
                  title="Sign out">
            <mat-icon aria-hidden="true">logout</mat-icon>
          </button>
        </header>
      }

      <nav class="snav" aria-label="All sections">
        @for (g of groups(); track g.group) {
          <div class="snav__group">
            <!-- Collapsible section header (FiMobile sidebar dropdown). The section containing the
                 current route starts expanded; others collapse to keep the list scannable. -->
            <button type="button" class="snav__head" (click)="toggle(g.group)"
                    [attr.aria-expanded]="isOpen(g.group)">
              <span class="snav__label">{{ g.group }}</span>
              <span class="snav__count">{{ g.items.length }}</span>
              <mat-icon class="snav__caret" [class.open]="isOpen(g.group)" aria-hidden="true">expand_more</mat-icon>
            </button>
            @if (isOpen(g.group)) {
              @for (item of g.items; track item.id) {
                <a class="srow" [routerLink]="item.path" routerLinkActive="active"
                   [routerLinkActiveOptions]="item.path === '/' ? exact : nonExact"
                   (click)="nav.close()">
                  <span class="srow__ic"><mat-icon aria-hidden="true">{{ item.icon }}</mat-icon></span>
                  <span class="srow__label">{{ item.label }}</span>
                  <mat-icon class="srow__chev" aria-hidden="true">chevron_right</mat-icon>
                </a>
              }
            }
          </div>
        }

        <hr class="snav__rule" aria-hidden="true" />

        <div class="snav__group">
          <h3 class="snav__label">Account</h3>
          <a class="srow" routerLink="/preferences" (click)="nav.close()">
            <span class="srow__ic"><mat-icon aria-hidden="true">tune</mat-icon></span>
            <span class="srow__label">Settings &amp; preferences</span>
            <mat-icon class="srow__chev" aria-hidden="true">chevron_right</mat-icon>
          </a>
          <a class="srow" routerLink="/profile" (click)="nav.close()">
            <span class="srow__ic"><mat-icon aria-hidden="true">account_circle</mat-icon></span>
            <span class="srow__label">My profile</span>
            <mat-icon class="srow__chev" aria-hidden="true">chevron_right</mat-icon>
          </a>
          <a class="srow" routerLink="/help" (click)="nav.close()">
            <span class="srow__ic"><mat-icon aria-hidden="true">help_outline</mat-icon></span>
            <span class="srow__label">Help &amp; FAQ</span>
            <mat-icon class="srow__chev" aria-hidden="true">chevron_right</mat-icon>
          </a>
          <button type="button" class="srow" (click)="switchToDesktop()">
            <span class="srow__ic"><mat-icon aria-hidden="true">desktop_windows</mat-icon></span>
            <span class="srow__label">Switch to desktop site</span>
          </button>
          <button type="button" class="srow srow--danger" (click)="signOut()">
            <span class="srow__ic"><mat-icon aria-hidden="true">logout</mat-icon></span>
            <span class="srow__label">Sign out</span>
          </button>
        </div>
      </nav>
    </aside>
    }
  `,
  styles: [
    `
      :host {
        display: contents;
      }
      .scrim {
        position: fixed;
        inset: 0;
        z-index: 60;
        background: var(--tech-bg-overlay, rgba(0, 0, 0, 0.55));
        opacity: 0;
        visibility: hidden;
        transition: opacity 240ms var(--tech-ease, ease), visibility 240ms;
        -webkit-backdrop-filter: blur(2px);
        backdrop-filter: blur(2px);
      }
      .scrim.open {
        opacity: 1;
        visibility: visible;
      }

      .drawer {
        position: fixed;
        top: 0;
        left: 0;
        bottom: 0;
        z-index: 61;
        width: min(86vw, 320px);
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: calc(env(safe-area-inset-top, 0px) + 14px) 12px calc(env(safe-area-inset-bottom, 0px) + 14px);
        background: var(--tech-panel);
        border-right: 1px solid var(--tech-border);
        box-shadow: var(--tech-shadow-popover);
        overflow-y: auto;
        overscroll-behavior: contain;
        transform: translateX(-104%);
        transition: transform 280ms var(--tech-ease, cubic-bezier(0.22, 1, 0.36, 1));
      }
      .drawer.open {
        transform: translateX(0);
      }

      /* Profile header — a gradient hero card carrying the scheme accent. */
      .prof {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 14px;
        border-radius: var(--tech-radius);
        background: var(--tech-gradient-accent);
        color: var(--tech-text-on-accent);
        margin-bottom: 8px;
      }
      .prof__avatar {
        flex: 0 0 auto;
        width: 46px;
        height: 46px;
        border-radius: var(--tech-r-control);
        object-fit: cover;
        display: grid;
        place-items: center;
      }
      .prof__avatar--init {
        font-family: var(--tech-font-display);
        font-weight: 700;
        font-size: 17px;
        background: color-mix(in srgb, var(--tech-text-on-accent) 22%, transparent);
        color: var(--tech-text-on-accent);
      }
      .prof__id {
        min-width: 0;
        flex: 1 1 auto;
      }
      .prof__name {
        margin: 0;
        font-family: var(--tech-font-display);
        font-weight: 700;
        font-size: 15px;
        line-height: 1.2;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .prof__email {
        margin: 2px 0 0;
        font-size: 11.5px;
        line-height: 1.2;
        color: color-mix(in srgb, var(--tech-text-on-accent) 78%, transparent);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .prof__out {
        flex: 0 0 auto;
        display: inline-grid;
        place-items: center;
        width: 38px;
        height: 38px;
        border: 0;
        border-radius: var(--tech-r-control);
        background: color-mix(in srgb, var(--tech-text-on-accent) 16%, transparent);
        color: var(--tech-text-on-accent);
        cursor: pointer;
      }
      .prof__out mat-icon {
        font-size: 19px;
        width: 19px;
        height: 19px;
      }

      .snav {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .snav__group {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .snav__head {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        padding: 8px 10px 4px;
        border: 0;
        background: transparent;
        cursor: pointer;
        text-align: left;
      }
      .snav__head:hover .snav__label {
        color: var(--tech-text-secondary);
      }
      .snav__head:focus-visible {
        outline: none;
        box-shadow: var(--tech-focus-ring);
        border-radius: var(--tech-r-control);
      }
      .snav__label {
        flex: 1 1 auto;
        font-family: var(--tech-font-ui);
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.07em;
        text-transform: uppercase;
        color: var(--tech-text-tertiary);
      }
      .snav__count {
        flex: 0 0 auto;
        min-width: 18px;
        height: 18px;
        padding: 0 5px;
        display: grid;
        place-items: center;
        border-radius: var(--tech-r-pill);
        background: color-mix(in srgb, var(--tech-accent) 12%, transparent);
        color: var(--tech-accent);
        font-size: 10.5px;
        font-weight: 700;
      }
      .snav__caret {
        flex: 0 0 auto;
        font-size: 18px;
        width: 18px;
        height: 18px;
        color: var(--tech-text-tertiary);
        transition: transform var(--tech-t-control, 140ms) var(--tech-ease, ease);
      }
      .snav__caret.open {
        transform: rotate(180deg);
        color: var(--tech-accent);
      }
      .snav__rule {
        height: 1px;
        border: 0;
        margin: 4px 6px;
        background: var(--tech-border-subtle);
      }

      .srow {
        display: flex;
        align-items: center;
        gap: 12px;
        width: 100%;
        min-height: 48px;
        padding: 8px 10px;
        border: 0;
        border-radius: var(--tech-r-control);
        background: transparent;
        color: var(--tech-text);
        font: inherit;
        font-family: var(--tech-font-ui);
        font-size: 14px;
        font-weight: 600;
        text-align: left;
        text-decoration: none;
        cursor: pointer;
        transition: background var(--tech-t-control, 140ms) ease;
      }
      .srow:hover {
        background: var(--tech-bg-sunken);
      }
      .srow.active {
        background: color-mix(in srgb, var(--tech-accent) 14%, transparent);
        color: var(--tech-text);
      }
      .srow__ic {
        flex: 0 0 auto;
        display: grid;
        place-items: center;
        width: 34px;
        height: 34px;
        border-radius: var(--tech-r-control);
        background: color-mix(in srgb, var(--tech-accent) 12%, transparent);
        color: var(--tech-accent);
      }
      .srow.active .srow__ic {
        background: var(--tech-accent);
        color: var(--tech-text-on-accent);
      }
      .srow__ic mat-icon {
        font-size: 19px;
        width: 19px;
        height: 19px;
      }
      .srow__label {
        flex: 1 1 auto;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .srow__chev {
        flex: 0 0 auto;
        font-size: 18px;
        width: 18px;
        height: 18px;
        color: var(--tech-text-tertiary);
      }
      .srow--danger {
        color: var(--tech-error);
      }
      .srow--danger .srow__ic {
        background: var(--tech-error-tint);
        color: var(--tech-error);
      }
      .srow:focus-visible {
        outline: none;
        box-shadow: var(--tech-focus-ring);
      }

      @media (prefers-reduced-motion: reduce) {
        .drawer,
        .scrim {
          transition: none;
        }
      }
    `,
  ],
})
export class MobileSidebar {
  protected readonly nav = inject(MobileNavService);
  protected readonly auth = inject(AuthService);
  private readonly platform = inject(PlatformService);
  private readonly router = inject(Router);

  protected readonly exact = { exact: true } as const;
  protected readonly nonExact = { exact: false } as const;

  private readonly has = (p: string): boolean => this.auth.hasPermission(p);

  /** The full grouped nav (reactive to the session permissions). */
  protected readonly groups = computed<NavGroupModel[]>(() => {
    this.auth.permissions();
    return navGroups(this.has);
  });

  /** Current route path (no query), reactive — drives which section is "active"/auto-expanded. */
  private readonly currentPath = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map((e) => e.urlAfterRedirects.split('?')[0]),
    ),
    { initialValue: this.router.url.split('?')[0] },
  );

  /** The nav group containing the current route (expanded by default; others collapse). */
  private readonly activeGroup = computed<string | null>(() => {
    const path = this.currentPath();
    for (const g of this.groups()) {
      for (const it of g.items) {
        const match = it.path === '/' ? path === '/' : path === it.path || path.startsWith(it.path + '/');
        if (match) return g.group;
      }
    }
    return null;
  });

  /** Explicit per-group open overrides; absent groups fall back to "open iff it's the active group". */
  private readonly expanded = signal<Record<string, boolean>>({});

  protected isOpen(group: string): boolean {
    return this.expanded()[group] ?? group === this.activeGroup();
  }
  protected toggle(group: string): void {
    const open = this.isOpen(group);
    this.expanded.update((e) => ({ ...e, [group]: !open }));
  }

  /** Initials fallback for the profile avatar. */
  protected readonly initials = computed(() => {
    const s = this.auth.session();
    const name = s?.name?.trim() || s?.email || '';
    const parts = name.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return (name.slice(0, 2) || 'U').toUpperCase();
  });

  protected switchToDesktop(): void {
    this.nav.close();
    this.platform.setOverride('desktop');
  }

  protected signOut(): void {
    this.nav.close();
    this.auth.logout();
    void this.router.navigateByUrl('/login');
  }
}
