import {
  ChangeDetectionStrategy, Component, computed, inject, signal,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { MatIconModule } from '@angular/material/icon';

import { Api } from '../../core/api';
import { AuthService } from '../../core/auth';
import {
  AccessPolicy, LoginEvent, ManagedUser, PermissionItem, PermissionPreset,
  PERM, PERM_GROUP_ORDER,
} from '../../core/models';
import {
  BetaPullRefresh, BetaBottomSheet, BetaSkeleton,
  BetaFab, BetaToaster, ToastController,
} from '../beta-ui';

/** A catalog group with its ordered items — drives the grouped grant accordions + the AI panel. */
interface PermGroup {
  name: string;
  perms: PermissionItem[];
  /** True for the AI (token-spending) group — rendered as a visually distinct, tinted section. */
  isAi: boolean;
}

/** How the list is filtered by capability axis. */
type CapFilter = 'all' | 'ai' | 'enabled' | 'disabled';

/** A landing-page option for the "Lands on" picker (route + label), offered only when reachable. */
interface HomeOption {
  route: string;
  label: string;
}

/** Lazy-loaded login-history state for one user's detail. */
interface LoginHistory {
  loading: boolean;
  loaded: boolean;
  error: boolean;
  events: LoginEvent[];
}

/**
 * Users "Access control" — the MOBILE twin of the live `/users` admin page, rebuilt on the shared
 * beta-ui "Strata" kit (`@use '../beta-ui/beta-kit'`) with a signature STEEL → CYAN admin accent. It is a
 * native-feel master-detail: an immersive header with a tiny user/AI/disabled stat strip, a search box +
 * capability filter chips (All / Has AI / Enabled / Disabled), then a list of glassy user cards (each with
 * its role badge, an AI/disabled pill, and a one-line plain-language "what they can do" summary). Tapping a
 * card opens a full-height {@link BetaBottomSheet} DETAIL editor: an enable/disable switch, a role-preset
 * {@link BetaSegmentedControl}-style picker that SEEDS the grants, the grouped permission toggles in
 * PERM_GROUP_ORDER with the AI section rendered as its own tinted panel, the "Lands on" landing-page picker,
 * lazy-loaded login history, and a sticky save bar. Sensitive saves (granting token-spending AI / disabling
 * an account) require a deliberate confirm sheet. A secondary ACCESS-POLICY sheet (open sign-up + default
 * permissions) is reachable from a header action. Pull-to-refresh, skeletons + empty/error states round it.
 *
 * DATA PARITY: every row + write goes through the SAME `users.manage`-gated endpoints the live page uses —
 * {@link Api.users} (masked emails by default — this twin never reveals them), {@link Api.permissionCatalog}
 * / {@link Api.permissionPresets} for the grant matrix + role presets, {@link Api.updateUser} (the per-user
 * PUT) for grant/enabled saves, {@link Api.adminSetHomeRoute} for the landing page, {@link Api.userLogins}
 * for history, and {@link Api.getAccessPolicy} / {@link Api.updateAccessPolicy} for the policy panel. The
 * upsert body is built EXACTLY like the live editor. The server enforces all authorization + defaultability;
 * the UI mirrors the live page's nonDefaultable set so the policy picker only offers server-defaultable keys.
 *
 * PRIVACY: emails are NEVER revealed here (the live page's key-gated reveal is desktop-only); other users'
 * rows show name + masked identity only, in line with the app's email-privacy rule.
 *
 * ISOLATION: gated by `platform.mobile` + the SAME `users.manage` the live `/users` route carries. Imports
 * only the kit + the shared Api/auth/models the live page already uses. No live page is imported or modified.
 */
@Component({
  selector: 'app-users-mobile',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [ToastController],
  imports: [
    DatePipe, FormsModule, MatIconModule,
    BetaPullRefresh, BetaBottomSheet, BetaSkeleton,
    BetaFab, BetaToaster,
  ],
  template: `
    <app-bs-pull-refresh class="um-ptr" [busy]="refreshing()" (refresh)="reload()">
      <div class="um-scroll" aria-live="polite">

        <!-- ─── IMMERSIVE HEADER: title + stat strip ─── -->
        <header class="um-hero">
          <p class="um-hero__kicker"><mat-icon aria-hidden="true">admin_panel_settings</mat-icon> Access control</p>
          <h1 class="um-hero__title">Users</h1>
          <p class="um-hero__sub">Manage who can sign in and exactly what each person can do.</p>

          @if (!loading() && !errored()) {
            <div class="um-stats">
              <div class="um-stat">
                <span class="um-stat__n mono-num">{{ users().length }}</span>
                <span class="um-stat__l">{{ users().length === 1 ? 'user' : 'users' }}</span>
              </div>
              <div class="um-stat">
                <span class="um-stat__n mono-num">{{ aiUserCount() }}</span>
                <span class="um-stat__l">use AI</span>
              </div>
              <div class="um-stat">
                <span class="um-stat__n mono-num">{{ disabledCount() }}</span>
                <span class="um-stat__l">disabled</span>
              </div>
            </div>
          }
        </header>

        @if (loading()) {
          <div class="um-search-wrap" aria-hidden="true">
            <app-bs-skeleton width="100%" height="46px" radius="var(--r-pill)" />
          </div>
          <div class="um-list" aria-hidden="true">
            @for (n of skeletonCells; track n) {
              <app-bs-skeleton height="84px" radius="var(--r-tile)" />
            }
          </div>

        } @else if (errored()) {
          <div class="um-state">
            <span class="um-state__orb"><mat-icon aria-hidden="true">cloud_off</mat-icon></span>
            <h2 class="um-state__title">Couldn't load users</h2>
            <p class="um-state__body">Something went wrong reaching the directory. Give it another go.</p>
            <button type="button" class="um-state__cta" (click)="reload()">
              <mat-icon aria-hidden="true">refresh</mat-icon> Try again
            </button>
          </div>

        } @else {
          <!-- ─── SEARCH ─── -->
          <div class="um-search-wrap">
            <label class="um-search">
              <mat-icon class="um-search__ic" aria-hidden="true">search</mat-icon>
              <input class="um-search__input" type="search" inputmode="search"
                     [ngModel]="search()" (ngModelChange)="search.set($event)"
                     placeholder="Search by name" autocomplete="off" aria-label="Search users" />
              @if (search()) {
                <button type="button" class="um-search__clear" (click)="search.set('')" aria-label="Clear search">
                  <mat-icon aria-hidden="true">close</mat-icon>
                </button>
              }
            </label>
          </div>

          <!-- ─── CAPABILITY FILTER CHIPS ─── -->
          <div class="um-chips" role="group" aria-label="Filter users">
            @for (c of capChips; track c.key) {
              <button type="button" class="um-chip" [class.is-on]="capFilter() === c.key"
                      [attr.aria-pressed]="capFilter() === c.key" (click)="toggleCap(c.key)">
                <mat-icon aria-hidden="true">{{ c.icon }}</mat-icon> {{ c.label }}
              </button>
            }
            <button type="button" class="um-chip um-chip--policy" (click)="openPolicy()">
              <mat-icon aria-hidden="true">policy</mat-icon> Policy
            </button>
          </div>

          @if (filteredUsers(); as list) {
            @if (list.length) {
              <div class="um-list">
                @for (u of list; track u.id; let i = $index) {
                  <button type="button" class="um-card um-reveal" [style.--ri]="i"
                          [class.is-disabled]="!u.isEnabled" (click)="openDetail(u)"
                          [attr.aria-label]="cardAria(u)">
                    <span class="um-card__avatar" [class.off]="!u.isEnabled" aria-hidden="true">{{ userInitial(u) }}</span>
                    <span class="um-card__body">
                      <span class="um-card__name">{{ u.name || 'Unnamed user' }}</span>
                      <span class="um-card__summary">{{ oneLineSummary(u) }}</span>
                      <span class="um-card__tags">
                        <span class="um-tag um-tag--role">{{ roleLabel(u) }}</span>
                        @if (hasAnyAi(u.permissions)) {
                          <span class="um-tag um-tag--ai"><mat-icon aria-hidden="true">auto_awesome</mat-icon> AI</span>
                        }
                        @if (!u.isEnabled) {
                          <span class="um-tag um-tag--off"><mat-icon aria-hidden="true">block</mat-icon> Disabled</span>
                        }
                      </span>
                    </span>
                    <mat-icon class="um-card__go" aria-hidden="true">chevron_right</mat-icon>
                  </button>
                }
              </div>
            } @else {
              <div class="um-empty">
                <span class="um-empty__orb"><mat-icon aria-hidden="true">person_search</mat-icon></span>
                <h2 class="um-empty__title">No matching users</h2>
                <p class="um-empty__body">
                  @if (isFiltering()) { Nothing matches your search or filter. }
                  @else { There are no users to manage yet. }
                </p>
                @if (isFiltering()) {
                  <button type="button" class="um-empty__cta" (click)="clearFilters()">
                    <mat-icon aria-hidden="true">filter_alt_off</mat-icon> Clear filters
                  </button>
                }
              </div>
            }
          }
        }
      </div>
    </app-bs-pull-refresh>

    <!-- ─────────────── DETAIL EDITOR SHEET ─────────────── -->
    <app-bs-sheet [(open)]="detailOpen" detent="full" [dismissable]="!saving()"
                  [label]="selected()?.name || 'User detail'">
      @if (selected(); as u) {
        <div class="ud">
          <!-- head -->
          <div class="ud__head">
            <span class="ud__avatar" [class.off]="!draftEnabled()" aria-hidden="true">{{ userInitial(u) }}</span>
            <div class="ud__titles">
              <h3 class="ud__name">{{ u.name || 'Unnamed user' }}</h3>
              <span class="ud__sub">
                <span class="ud__role-badge">{{ draftRoleLabel() }}</span>
                @if (u.lastLoginUtc) {
                  · last in {{ u.lastLoginUtc | date:'mediumDate' }}
                } @else {
                  · never signed in
                }
              </span>
            </div>
          </div>

          <!-- live access summary echo -->
          <p class="ud__summary"><mat-icon aria-hidden="true">badge</mat-icon> {{ draftSummary() }}</p>

          <!-- ENABLE / DISABLE -->
          <button type="button" class="ud__enable" [class.is-on]="draftEnabled()"
                  role="switch" [attr.aria-checked]="draftEnabled()"
                  (click)="draftEnabled.set(!draftEnabled())">
            <mat-icon aria-hidden="true">{{ draftEnabled() ? 'check_circle' : 'block' }}</mat-icon>
            <span class="ud__enable-txt">
              <b>{{ draftEnabled() ? 'Account enabled' : 'Account disabled' }}</b>
              <i>{{ draftEnabled() ? 'They can sign in.' : 'They cannot sign in until re-enabled.' }}</i>
            </span>
            <span class="um-switch" [class.is-on]="draftEnabled()" aria-hidden="true"><span class="um-switch__knob"></span></span>
          </button>

          <!-- ROLE PRESET PICKER -->
          <div class="ud__block">
            <span class="ud__block-title"><mat-icon aria-hidden="true">badge</mat-icon> Role preset</span>
            <p class="ud__block-sub">Applying a role replaces the grants below as a starting point.</p>
            <div class="ud__roles">
              @for (p of presets(); track p.key) {
                <button type="button" class="ud__role" [class.is-active]="draftRole() === p.key"
                        (click)="applyRole(p.key)">{{ p.label }}</button>
              }
            </div>
            @if (appliedRole() && roleDelta(); as d) {
              @if (d.added.length || d.removed.length) {
                <p class="ud__delta">
                  Customised from <b>{{ appliedRoleLabel() }}</b>:
                  @if (d.added.length) { <span class="ud__delta-add">+{{ d.added.length }}</span> }
                  @if (d.removed.length) { <span class="ud__delta-rm">−{{ d.removed.length }}</span> }
                  <button type="button" class="ud__delta-reset" (click)="resetToRole()">Reset to role</button>
                </p>
              }
            }
          </div>

          <!-- FEATURE-ACCESS GRANT GROUPS (accordions) -->
          @for (g of featureGroups(); track g.name) {
            <div class="ud__group" [class.is-collapsed]="isGroupCollapsed(g.name)">
              <button type="button" class="ud__group-head" (click)="toggleGroup(g.name)"
                      [attr.aria-expanded]="!isGroupCollapsed(g.name)">
                <span class="ud__group-name">{{ g.name }}</span>
                <span class="ud__group-count mono-num">{{ groupOnCount(g) }}/{{ g.perms.length }}</span>
                <mat-icon class="ud__group-caret" aria-hidden="true">expand_more</mat-icon>
              </button>
              @if (!isGroupCollapsed(g.name)) {
                <div class="ud__perms">
                  @for (p of g.perms; track p.key) {
                    <button type="button" class="ud__perm" role="switch"
                            [class.is-on]="draftHas(p.key)" [attr.aria-checked]="draftHas(p.key)"
                            (click)="toggleDraftPerm(p.key, !draftHas(p.key))">
                      <span class="ud__perm-body">
                        <span class="ud__perm-label">{{ p.label }}</span>
                        <span class="ud__perm-desc">{{ p.description }}</span>
                      </span>
                      <span class="um-switch um-switch--sm" [class.is-on]="draftHas(p.key)" aria-hidden="true"><span class="um-switch__knob"></span></span>
                    </button>
                  }
                </div>
              }
            </div>
          }

          <!-- AI PANEL — distinct, tinted, token-spending -->
          @for (g of aiGroups(); track g.name) {
            <div class="ud__ai">
              <div class="ud__ai-head">
                <mat-icon aria-hidden="true">auto_awesome</mat-icon>
                <div class="ud__ai-titles">
                  <span class="ud__ai-title">{{ g.name }}</span>
                  <span class="ud__ai-sub">Token-spending capabilities — grant deliberately.</span>
                </div>
                <span class="ud__ai-count mono-num">{{ groupOnCount(g) }}/{{ g.perms.length }}</span>
              </div>
              <div class="ud__perms">
                @for (p of g.perms; track p.key) {
                  <button type="button" class="ud__perm ud__perm--ai" role="switch"
                          [class.is-on]="draftHas(p.key)" [attr.aria-checked]="draftHas(p.key)"
                          (click)="toggleDraftPerm(p.key, !draftHas(p.key))">
                    <span class="ud__perm-body">
                      <span class="ud__perm-label">{{ p.label }}</span>
                      <span class="ud__perm-desc">{{ p.description }}</span>
                    </span>
                    <span class="um-switch um-switch--sm um-switch--ai" [class.is-on]="draftHas(p.key)" aria-hidden="true"><span class="um-switch__knob"></span></span>
                  </button>
                }
              </div>
            </div>
          }

          <!-- LANDS ON (home route) -->
          @if (homeOptions().length) {
            <div class="ud__block">
              <span class="ud__block-title"><mat-icon aria-hidden="true">home</mat-icon> Lands on</span>
              <p class="ud__block-sub">The page they open after signing in.</p>
              <div class="ud__home">
                <button type="button" class="ud__home-opt" [class.is-active]="!u.homeRoute"
                        [disabled]="homeSaving()" (click)="setHomeRoute(null)">Default</button>
                @for (o of homeOptions(); track o.route) {
                  <button type="button" class="ud__home-opt" [class.is-active]="u.homeRoute === o.route"
                          [disabled]="homeSaving()" (click)="setHomeRoute(o.route)">{{ o.label }}</button>
                }
              </div>
            </div>
          }

          <!-- LOGIN HISTORY (lazy) -->
          <div class="ud__block">
            <span class="ud__block-title"><mat-icon aria-hidden="true">history</mat-icon> Recent sign-ins</span>
            @if (loginState(); as ls) {
              @if (ls.loading) {
                <div class="ud__logins" aria-hidden="true">
                  <app-bs-skeleton height="40px" radius="var(--r-tile)" />
                  <app-bs-skeleton height="40px" radius="var(--r-tile)" />
                </div>
              } @else if (ls.error) {
                <p class="ud__logins-empty">Couldn't load sign-in history.</p>
              } @else if (!ls.events.length) {
                <p class="ud__logins-empty">No recorded sign-ins yet.</p>
              } @else {
                <ul class="ud__logins">
                  @for (e of ls.events.slice(0, 6); track e.id) {
                    <li class="ud__login" [class.failed]="!e.success">
                      <mat-icon class="ud__login-ic" aria-hidden="true">{{ e.success ? 'login' : 'gpp_bad' }}</mat-icon>
                      <span class="ud__login-body">
                        <span class="ud__login-when">{{ e.whenUtc | date:'medium' }}</span>
                        <span class="ud__login-meta">
                          {{ e.success ? 'Signed in' : e.reason }}
                          @if (deviceSummary(e); as d) { · {{ d }} }
                        </span>
                      </span>
                    </li>
                  }
                </ul>
              }
            }
          </div>

          <div class="ud__savebar-spacer" aria-hidden="true"></div>
        </div>

        <!-- STICKY SAVE BAR inside the sheet -->
        <div class="ud__savebar" [class.is-dirty]="dirty()">
          <span class="ud__savebar-hint">
            @if (dirty()) { {{ saveCount() }} change{{ saveCount() === 1 ? '' : 's' }} }
            @else { All saved }
          </span>
          <button type="button" class="ud__savebar-btn"
                  [disabled]="!dirty() || saving()" (click)="save()">
            @if (saving()) { <mat-icon class="um-spin" aria-hidden="true">progress_activity</mat-icon> Saving… }
            @else { <mat-icon aria-hidden="true">check</mat-icon> Save }
          </button>
        </div>
      }
    </app-bs-sheet>

    <!-- ─────────────── SENSITIVE-CONFIRM SHEET ─────────────── -->
    <app-bs-sheet [(open)]="confirmOpen" detent="half" label="Confirm changes">
      @if (confirm(); as c) {
        <div class="uc">
          <span class="uc__orb" [class.danger]="c.danger" aria-hidden="true">
            <mat-icon>{{ c.danger ? 'warning' : 'verified_user' }}</mat-icon>
          </span>
          <h3 class="uc__title">{{ c.title }}</h3>
          @for (l of c.lines; track $index) { <p class="uc__line">{{ l }}</p> }
          <div class="uc__actions">
            <button type="button" class="uc__btn uc__btn--ghost" (click)="confirmOpen.set(false)">Cancel</button>
            <button type="button" class="uc__btn" [class.danger]="c.danger" (click)="c.onConfirm()">{{ c.confirmLabel }}</button>
          </div>
        </div>
      }
    </app-bs-sheet>

    <!-- ─────────────── ACCESS-POLICY SHEET ─────────────── -->
    <app-bs-sheet [(open)]="policyOpen" detent="full" [dismissable]="!savingPolicy()" label="Access policy">
      <div class="up">
        <div class="up__head">
          <h3 class="up__title"><mat-icon aria-hidden="true">policy</mat-icon> Access policy</h3>
          <button type="button" class="up__close" (click)="policyOpen.set(false)" aria-label="Close" [disabled]="savingPolicy()">
            <mat-icon aria-hidden="true">close</mat-icon>
          </button>
        </div>

        @if (policy(); as p) {
          <button type="button" class="up__signup" [class.is-on]="p.openSignupEnabled"
                  role="switch" [attr.aria-checked]="p.openSignupEnabled" (click)="setOpenSignup(!p.openSignupEnabled)">
            <mat-icon aria-hidden="true">{{ p.openSignupEnabled ? 'lock_open' : 'lock' }}</mat-icon>
            <span class="ud__enable-txt">
              <b>{{ p.openSignupEnabled ? 'Open sign-up on' : 'Open sign-up off' }}</b>
              <i>{{ p.openSignupEnabled ? 'Anyone with a Google account can join.' : 'Only invited users can sign in.' }}</i>
            </span>
            <span class="um-switch" [class.is-on]="p.openSignupEnabled" aria-hidden="true"><span class="um-switch__knob"></span></span>
          </button>

          <p class="up__sub">Default permissions granted to every NEW account on first sign-in.</p>
          @for (g of policyGroups(); track g.name) {
            <div class="up__group">
              <span class="up__group-name">{{ g.name }}</span>
              <div class="ud__perms">
                @for (perm of g.perms; track perm.key) {
                  <button type="button" class="ud__perm" role="switch"
                          [class.is-on]="policyHasPerm(perm.key)" [attr.aria-checked]="policyHasPerm(perm.key)"
                          (click)="togglePolicyPerm(perm.key, !policyHasPerm(perm.key))">
                    <span class="ud__perm-body">
                      <span class="ud__perm-label">{{ perm.label }}</span>
                      <span class="ud__perm-desc">{{ perm.description }}</span>
                    </span>
                    <span class="um-switch um-switch--sm" [class.is-on]="policyHasPerm(perm.key)" aria-hidden="true"><span class="um-switch__knob"></span></span>
                  </button>
                }
              </div>
            </div>
          }
          <div class="ud__savebar-spacer" aria-hidden="true"></div>
        } @else {
          <div class="um-state">
            <span class="um-state__orb"><mat-icon aria-hidden="true">policy</mat-icon></span>
            <h2 class="um-state__title">Policy unavailable</h2>
            <p class="um-state__body">The access policy couldn't be loaded.</p>
          </div>
        }
      </div>

      @if (policy()) {
        <div class="ud__savebar is-dirty">
          <span class="ud__savebar-hint">Open sign-up + defaults</span>
          <button type="button" class="ud__savebar-btn" [disabled]="savingPolicy()" (click)="savePolicy()">
            @if (savingPolicy()) { <mat-icon class="um-spin" aria-hidden="true">progress_activity</mat-icon> Saving… }
            @else { <mat-icon aria-hidden="true">check</mat-icon> Save policy }
          </button>
        </div>
      }
    </app-bs-sheet>

    <!-- POLICY FAB (only when a policy loaded + list is up) -->
    @if (!loading() && !errored() && !detailOpen() && !policyOpen() && policy()) {
      <app-bs-fab icon="policy" label="Access policy" [fixed]="true" (action)="openPolicy()" />
    }

    <app-bs-toaster />
  `,
  styleUrl: './users-mobile.page.scss',
})
export class UsersMobilePage {
  private api = inject(Api);
  private toast = inject(ToastController);
  readonly auth = inject(AuthService);
  readonly PERM = PERM;

  // ---- data ----
  readonly users = signal<ManagedUser[]>([]);
  readonly perms = signal<PermissionItem[]>([]);
  readonly presets = signal<PermissionPreset[]>([]);

  readonly loading = signal(true);
  readonly errored = signal(false);
  readonly refreshing = signal(false);

  // ---- list search + filter ----
  readonly search = signal('');
  readonly capFilter = signal<CapFilter>('all');

  readonly capChips: readonly { key: CapFilter; label: string; icon: string }[] = [
    { key: 'all', label: 'All', icon: 'groups' },
    { key: 'ai', label: 'Has AI', icon: 'auto_awesome' },
    { key: 'enabled', label: 'Enabled', icon: 'check_circle' },
    { key: 'disabled', label: 'Disabled', icon: 'block' },
  ];

  // ---- master-detail ----
  readonly detailOpen = signal(false);
  readonly selectedId = signal<number | null>(null);
  readonly saving = signal(false);
  readonly homeSaving = signal(false);

  // staged edit
  readonly draftPerms = signal<Set<string>>(new Set());
  readonly draftEnabled = signal(true);
  /** The role key last APPLIED to the draft (drives the delta badge), or '' if none. */
  readonly appliedRole = signal('');
  readonly collapsedGroups = signal<Set<string>>(new Set());

  // login history (lazy, per user)
  readonly logins = signal<Map<number, LoginHistory>>(new Map());

  // sensitive-confirm sheet
  readonly confirmOpen = signal(false);
  readonly confirm = signal<{
    title: string; lines: string[]; confirmLabel: string; danger: boolean; onConfirm: () => void;
  } | null>(null);

  // access policy
  readonly policyOpen = signal(false);
  readonly policy = signal<AccessPolicy | null>(null);
  readonly policyPerms = signal<Set<string>>(new Set());
  readonly savingPolicy = signal(false);

  readonly skeletonCells = Array.from({ length: 5 }, (_, i) => i);

  /** Permission keys the server refuses as open-sign-up defaults (mirrors the live nonDefaultable set). */
  private readonly nonDefaultable = new Set<string>([
    PERM.usersManage, PERM.chatModerate, PERM.chatContactsManage, PERM.trackerViewAll,
    PERM.familyUse, PERM.familyFinance, PERM.locationSelf, PERM.locationShare,
    PERM.trackerAi, PERM.familyAi, PERM.familyAiAssistant, PERM.financeAi, PERM.chatAi, PERM.aiVision,
  ]);

  /** route -> permission key(s) granting access (ANY one) — mirrors the live page's homePerms. */
  private static readonly homePerms: Readonly<Record<string, readonly string[]>> = {
    '/': [PERM.dashboardView],
    '/calendar': [PERM.calendarView],
    '/pricing': [PERM.pricingView],
    '/reporter': [PERM.reporterView, PERM.reporterManage, PERM.reporterSelf],
    '/fleet': [PERM.fleetView, PERM.reporterManage],
    '/tracker': [PERM.trackerSelf],
    '/family': [PERM.familyUse],
    '/chat': [PERM.chatRead],
    '/locations': [PERM.locationSelf],
    '/users': [PERM.usersView],
    '/activity': [PERM.activityView],
    '/settings': [PERM.settingsView],
  };

  private static readonly homeOptionDefs: readonly HomeOption[] = [
    { route: '/', label: 'Dashboard' },
    { route: '/calendar', label: 'Calendar' },
    { route: '/pricing', label: 'Pricing' },
    { route: '/reporter', label: 'Reporter' },
    { route: '/fleet', label: 'Fleet' },
    { route: '/tracker', label: 'Tracker' },
    { route: '/family', label: 'Family' },
    { route: '/chat', label: 'Chat' },
    { route: '/locations', label: 'My locations' },
    { route: '/users', label: 'Users' },
    { route: '/activity', label: 'Activity' },
    { route: '/settings', label: 'Settings' },
  ];

  // ─────────────── derived: catalog groups ───────────────

  readonly groups = computed<PermGroup[]>(() => {
    const byGroup = new Map<string, PermissionItem[]>();
    for (const p of this.perms()) {
      (byGroup.get(p.group) ?? byGroup.set(p.group, []).get(p.group)!).push(p);
    }
    const ordered: PermGroup[] = [];
    const mk = (name: string, perms: PermissionItem[]): PermGroup => ({
      name, perms, isAi: perms.some((p) => p.isAi),
    });
    for (const name of PERM_GROUP_ORDER) {
      const perms = byGroup.get(name);
      if (perms?.length) { ordered.push(mk(name, perms)); byGroup.delete(name); }
    }
    for (const [name, perms] of byGroup) if (perms.length) ordered.push(mk(name, perms));
    return ordered;
  });

  readonly featureGroups = computed(() => this.groups().filter((g) => !g.isAi));
  readonly aiGroups = computed(() => this.groups().filter((g) => g.isAi));
  readonly aiKeys = computed(() => new Set(this.aiGroups().flatMap((g) => g.perms.map((p) => p.key))));

  readonly permByKey = computed(() => {
    const m = new Map<string, PermissionItem>();
    for (const p of this.perms()) m.set(p.key, p);
    return m;
  });

  /** Default-permissions picker groups, filtered to server-defaultable keys (mirrors the live page). */
  readonly policyGroups = computed<PermGroup[]>(() =>
    this.groups()
      .map((g) => ({ ...g, perms: g.perms.filter((p) => !this.nonDefaultable.has(p.key)) }))
      .filter((g) => g.perms.length),
  );

  // ─────────────── derived: stats + filter ───────────────

  readonly aiUserCount = computed(() => {
    const ai = this.aiKeys();
    return this.users().filter((u) => u.permissions.some((k) => ai.has(k))).length;
  });
  readonly disabledCount = computed(() => this.users().filter((u) => !u.isEnabled).length);

  readonly isFiltering = computed(() => !!this.search().trim() || this.capFilter() !== 'all');

  readonly filteredUsers = computed<ManagedUser[]>(() => {
    const q = this.search().trim().toLowerCase();
    const cap = this.capFilter();
    const ai = this.aiKeys();
    return this.users().filter((u) => {
      if (q && !(u.name ?? '').toLowerCase().includes(q)) return false;
      switch (cap) {
        case 'ai': return u.permissions.some((k) => ai.has(k));
        case 'enabled': return u.isEnabled;
        case 'disabled': return !u.isEnabled;
      }
      return true;
    });
  });

  // ─────────────── derived: selected + draft ───────────────

  readonly selected = computed<ManagedUser | null>(() => {
    const id = this.selectedId();
    return id == null ? null : (this.users().find((u) => u.id === id) ?? null);
  });

  readonly draftRole = computed(() => this.matchRole(this.draftPerms()));
  readonly draftRoleLabel = computed(() => {
    const key = this.draftRole();
    if (key) return this.presets().find((p) => p.key === key)?.label ?? 'Custom';
    return this.draftPerms().size ? 'Custom role' : 'No access';
  });
  readonly appliedRoleLabel = computed(
    () => this.presets().find((p) => p.key === this.appliedRole())?.label ?? '',
  );

  readonly roleDelta = computed<{ added: string[]; removed: string[] }>(() => {
    const role = this.presets().find((p) => p.key === this.appliedRole());
    if (!role) return { added: [], removed: [] };
    const roleSet = new Set(role.permissions);
    const draft = this.draftPerms();
    return {
      added: [...draft].filter((k) => !roleSet.has(k)),
      removed: role.permissions.filter((k) => !draft.has(k)),
    };
  });

  readonly dirty = computed(() => {
    const u = this.selected();
    if (!u) return false;
    if (this.draftEnabled() !== u.isEnabled) return true;
    const saved = new Set(u.permissions);
    const draft = this.draftPerms();
    if (saved.size !== draft.size) return true;
    for (const k of draft) if (!saved.has(k)) return true;
    return false;
  });

  readonly saveDiff = computed<{ added: string[]; removed: string[] }>(() => {
    const u = this.selected();
    if (!u) return { added: [], removed: [] };
    const saved = new Set(u.permissions);
    const draft = this.draftPerms();
    return {
      added: [...draft].filter((k) => !saved.has(k)),
      removed: u.permissions.filter((k) => !draft.has(k)),
    };
  });

  readonly saveCount = computed(() => {
    const d = this.saveDiff();
    const u = this.selected();
    const enabledFlip = u && this.draftEnabled() !== u.isEnabled ? 1 : 0;
    return d.added.length + d.removed.length + enabledFlip;
  });

  /** A live plain-language summary of the STAGED grants. */
  readonly draftSummary = computed(() => this.summaryFor(this.draftPerms()));

  readonly homeOptions = computed<HomeOption[]>(() => {
    const u = this.selected();
    if (!u) return [];
    const held = new Set(u.permissions);
    return UsersMobilePage.homeOptionDefs.filter((o) => {
      const req = UsersMobilePage.homePerms[o.route];
      return req && req.some((k) => held.has(k));
    });
  });

  readonly loginState = computed(() => {
    const id = this.selectedId();
    return id == null ? undefined : this.logins().get(id);
  });

  constructor() {
    void this.reload();
  }

  // ─────────────── LOAD ───────────────

  async reload(): Promise<void> {
    const wasLoaded = !this.loading();
    if (wasLoaded) this.refreshing.set(true); else this.loading.set(true);
    this.errored.set(false);
    try {
      const [users, perms, presets] = await Promise.all([
        firstValueFrom(this.api.users()),          // masked emails — this twin never reveals them
        firstValueFrom(this.api.permissionCatalog()),
        firstValueFrom(this.api.permissionPresets()),
      ]);
      this.users.set(users ?? []);
      this.perms.set(perms ?? []);
      this.presets.set(presets ?? []);
      // keep an open detail in sync with the fresh row, or close it if it's gone
      const u = this.selected();
      if (u) {
        const next = (users ?? []).find((x) => x.id === u.id);
        if (next) this.seedDraft(next); else this.detailOpen.set(false);
      }
      this.loadPolicy();
    } catch {
      this.errored.set(true);
    } finally {
      this.loading.set(false);
      if (wasLoaded) {
        this.refreshing.set(false);
        this.toast.show('Users refreshed', { tone: 'success', durationMs: 1500 });
      }
    }
  }

  private loadPolicy(): void {
    this.api.getAccessPolicy().subscribe({
      next: (p) => {
        this.policy.set(p);
        this.policyPerms.set(new Set(p.defaultPermissions));
      },
      error: () => { /* non-critical — the policy FAB/sheet just won't show */ },
    });
  }

  // ─────────────── list helpers ───────────────

  toggleCap(cap: CapFilter): void {
    this.capFilter.update((c) => (c === cap ? 'all' : cap));
  }

  clearFilters(): void {
    this.search.set('');
    this.capFilter.set('all');
  }

  userInitial(u: ManagedUser): string {
    return ((u.name || '?').charAt(0) || '?').toUpperCase();
  }

  cardAria(u: ManagedUser): string {
    const bits = [u.name || 'Unnamed user', this.roleLabel(u)];
    if (hasAi(u.permissions, this.aiKeys())) bits.push('uses AI');
    if (!u.isEnabled) bits.push('disabled');
    return `${bits.join(', ')}. Open to edit.`;
  }

  // ─────────────── role / summary ───────────────

  matchRole(permKeys: string[] | Set<string>): string {
    const have = permKeys instanceof Set ? permKeys : new Set(permKeys);
    for (const p of this.presets()) {
      if (p.permissions.length !== have.size) continue;
      if (p.permissions.every((k) => have.has(k))) return p.key;
    }
    return '';
  }

  roleLabel(u: ManagedUser): string {
    const key = this.matchRole(u.permissions);
    if (key) return this.presets().find((p) => p.key === key)?.label ?? 'Custom';
    return u.permissions.length ? 'Custom' : 'No role';
  }

  hasAnyAi(permKeys: string[] | Set<string>): boolean {
    return hasAi(permKeys, this.aiKeys());
  }

  oneLineSummary(u: ManagedUser): string {
    return this.summaryFor(new Set(u.permissions));
  }

  /** Plain-language summary of a grant set (mirrors the live page's summaryFor). */
  summaryFor(held: Set<string>): string {
    const has = (k: string) => held.has(k);
    const parts: string[] = [];
    if (has(PERM.usersManage)) parts.push('Administers users');
    else if (has(PERM.usersView)) parts.push('Views users');
    if (has(PERM.familyUse)) parts.push(has(PERM.familyFinance) ? 'manages the family incl. finance' : 'manages the family');
    if (has(PERM.trackerSelf)) parts.push('tracks fitness');
    if (has(PERM.chatRead)) parts.push('uses chat');
    if (has(PERM.dashboardView)) parts.push('sees usage');
    if (has(PERM.locationSelf)) parts.push('shares location');

    const ai = this.aiGroups().flatMap((g) => g.perms).filter((p) => held.has(p.key));
    let sentence = parts.length ? parts.join(', ').replace(/^./, (c) => c.toUpperCase()) : 'No access yet';
    sentence += ai.length ? `; uses AI (${ai.length})` : '; no AI';
    return sentence;
  }

  // ─────────────── DETAIL ───────────────

  openDetail(u: ManagedUser): void {
    this.selectedId.set(u.id);
    this.seedDraft(u);
    this.detailOpen.set(true);
    if (!this.logins().has(u.id)) this.loadLogins(u.id);
  }

  private seedDraft(u: ManagedUser): void {
    this.draftPerms.set(new Set(u.permissions));
    this.draftEnabled.set(u.isEnabled);
    this.appliedRole.set(this.matchRole(u.permissions));
    this.collapsedGroups.set(new Set());
  }

  draftHas(key: string): boolean {
    return this.draftPerms().has(key);
  }

  toggleDraftPerm(key: string, checked: boolean): void {
    this.draftPerms.update((s) => {
      const next = new Set(s);
      if (checked) next.add(key); else next.delete(key);
      return next;
    });
  }

  applyRole(roleKey: string): void {
    const role = this.presets().find((p) => p.key === roleKey);
    if (!role) return;
    this.draftPerms.set(new Set(role.permissions));
    this.appliedRole.set(roleKey);
    this.toast.show(`Seeded "${role.label}" — review and save.`, { tone: 'neutral', durationMs: 2000 });
  }

  resetToRole(): void {
    const role = this.presets().find((p) => p.key === this.appliedRole());
    if (role) this.draftPerms.set(new Set(role.permissions));
  }

  groupOnCount(g: PermGroup): number {
    const draft = this.draftPerms();
    return g.perms.filter((p) => draft.has(p.key)).length;
  }

  isGroupCollapsed(name: string): boolean {
    return this.collapsedGroups().has(name);
  }

  toggleGroup(name: string): void {
    this.collapsedGroups.update((s) => {
      const next = new Set(s);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  }

  // ─────────────── login history ───────────────

  private loadLogins(id: number): void {
    this.setLogins(id, { loading: true, loaded: false, error: false, events: [] });
    this.api.userLogins(id).subscribe({
      next: (events) => this.setLogins(id, { loading: false, loaded: true, error: false, events }),
      error: () => this.setLogins(id, { loading: false, loaded: true, error: true, events: [] }),
    });
  }

  private setLogins(id: number, state: LoginHistory): void {
    this.logins.update((m) => new Map(m).set(id, state));
  }

  /** A compact device summary for a login row (only the fields present). Mirrors the live page. */
  deviceSummary(e: LoginEvent): string {
    const parts: string[] = [];
    if (e.platform) parts.push(e.platform);
    if (e.screenWidth != null && e.screenHeight != null) {
      const dpr = e.devicePixelRatio != null && e.devicePixelRatio !== 1 ? `@${e.devicePixelRatio}x` : '';
      parts.push(`${e.screenWidth}×${e.screenHeight}${dpr}`);
    }
    if (e.timeZone) parts.push(e.timeZone);
    return parts.join(' · ');
  }

  // ─────────────── HOME ROUTE ───────────────

  setHomeRoute(route: string | null): void {
    const u = this.selected();
    if (!u || this.homeSaving()) return;
    this.homeSaving.set(true);
    this.api.adminSetHomeRoute(u.id, route).subscribe({
      next: (updated) => {
        this.homeSaving.set(false);
        this.users.update((list) => list.map((x) => (x.id === updated.id ? updated : x)));
        this.toast.show('Landing page updated', { tone: 'success', durationMs: 1800 });
      },
      error: (err: HttpErrorResponse) => {
        this.homeSaving.set(false);
        this.toast.show(err.error?.message ?? 'Could not set landing page', { tone: 'warn' });
      },
    });
  }

  // ─────────────── SAVE ───────────────

  save(): void {
    const u = this.selected();
    if (!u || !this.dirty() || this.saving()) return;

    const ai = this.aiKeys();
    const aiAdds = this.saveDiff().added.filter((k) => ai.has(k));
    const disabling = u.isEnabled && !this.draftEnabled();

    if (aiAdds.length || disabling) {
      const lines = [`User: ${u.name || 'this user'}.`];
      if (aiAdds.length) {
        const labels = aiAdds.map((k) => this.permByKey().get(k)?.label ?? k);
        lines.push(`Grants token-spending AI: ${labels.join(', ')}.`);
      }
      if (disabling) lines.push('Disables the account — they can no longer sign in.');
      this.confirm.set({
        title: 'Confirm sensitive changes',
        lines,
        confirmLabel: 'Save changes',
        danger: disabling,
        onConfirm: () => { this.confirmOpen.set(false); this.commitSave(u); },
      });
      this.confirmOpen.set(true);
      return;
    }
    this.commitSave(u);
  }

  private commitSave(u: ManagedUser): void {
    this.saving.set(true);
    const body = {
      name: u.name,
      isEnabled: this.draftEnabled(),
      permissions: [...this.draftPerms()],
    };
    this.api.updateUser(u.id, body).subscribe({
      next: (updated) => {
        this.saving.set(false);
        this.users.update((list) => list.map((x) => (x.id === updated.id ? updated : x)));
        this.seedDraft(updated);
        this.toast.show(`Saved ${updated.name || 'user'}`, { tone: 'success', durationMs: 2000 });
      },
      error: (err: HttpErrorResponse) => {
        this.saving.set(false);
        this.toast.show(err.error?.message ?? 'Save failed', { tone: 'warn' });
      },
    });
  }

  // ─────────────── ACCESS POLICY ───────────────

  openPolicy(): void {
    this.policyOpen.set(true);
  }

  setOpenSignup(enabled: boolean): void {
    this.policy.update((p) => (p ? { ...p, openSignupEnabled: enabled } : p));
  }

  policyHasPerm(key: string): boolean {
    return this.policyPerms().has(key);
  }

  togglePolicyPerm(key: string, checked: boolean): void {
    this.policyPerms.update((s) => {
      const next = new Set(s);
      if (checked) next.add(key); else next.delete(key);
      return next;
    });
  }

  savePolicy(): void {
    const p = this.policy();
    if (!p || this.savingPolicy()) return;
    this.savingPolicy.set(true);
    const body: AccessPolicy = {
      openSignupEnabled: p.openSignupEnabled,
      defaultPermissions: [...this.policyPerms()],
    };
    this.api.updateAccessPolicy(body).subscribe({
      next: (saved) => {
        this.savingPolicy.set(false);
        this.policy.set(saved);
        this.policyPerms.set(new Set(saved.defaultPermissions));
        this.toast.show('Access policy saved', { tone: 'success', durationMs: 2000 });
      },
      error: (err: HttpErrorResponse) => {
        this.savingPolicy.set(false);
        this.toast.show(err.error?.message ?? 'Could not save access policy', { tone: 'warn' });
      },
    });
  }
}

/** Shared AI-membership test (a free function so it can be used from cardAria + hasAnyAi). */
function hasAi(permKeys: string[] | Set<string>, ai: Set<string>): boolean {
  const it = permKeys instanceof Set ? permKeys : new Set(permKeys);
  for (const k of it) if (ai.has(k)) return true;
  return false;
}
