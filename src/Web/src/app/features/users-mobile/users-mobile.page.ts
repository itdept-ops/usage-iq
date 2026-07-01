import {
  ChangeDetectionStrategy, Component, computed, inject, signal,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { forkJoin } from 'rxjs';
import { firstValueFrom } from 'rxjs';
import { MatIconModule } from '@angular/material/icon';

import { Api } from '../../core/api';
import { AuthService } from '../../core/auth';
import {
  AccessPolicy, AuditEntry, ChatContactDto, LoginEvent, ManagedUser, PermissionItem, PermissionPreset,
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

/** How the list is filtered by capability axis. `perm` narrows to holders of a specific permission key. */
type CapFilter = 'all' | 'ai' | 'enabled' | 'disabled' | 'perm';

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

/** Lazy-loaded chat-contacts (circle) state for one user's detail. Only shown to contact managers. */
interface ContactsState {
  loading: boolean;
  loaded: boolean;
  error: boolean;
  /** That user's current contacts. */
  contacts: ChatContactDto[];
  /** Search box for the add-control (filters the directory). */
  query: string;
  /** AppUser id currently being added/removed (disables that control + shows progress). */
  busyUserId: number | null;
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
    DatePipe, RouterLink, FormsModule, MatIconModule,
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

          @if (auth.hasPermission(PERM.usersView)) {
            <button type="button" class="um-reveal-toggle" [class.is-on]="emailsRevealed()"
                    [disabled]="revealing()" [attr.aria-pressed]="emailsRevealed()"
                    [attr.aria-label]="emailsRevealed() ? 'Hide email addresses' : 'Show email addresses (requires a key)'"
                    (click)="toggleEmails()">
              @if (revealing()) { <mat-icon class="um-spin" aria-hidden="true">progress_activity</mat-icon> }
              @else { <mat-icon aria-hidden="true">{{ emailsRevealed() ? 'lock_open' : 'lock' }}</mat-icon> }
              {{ emailsRevealed() ? 'Hide emails' : 'Show emails' }}
            </button>
          }

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
                     [placeholder]="emailsRevealed() ? 'Search by name or email' : 'Search by name'"
                     autocomplete="off" aria-label="Search users" />
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
            <button type="button" class="um-chip um-chip--perm" [class.is-on]="capFilter() === 'perm'"
                    [attr.aria-pressed]="capFilter() === 'perm'" (click)="openPermPicker()">
              <mat-icon aria-hidden="true">tune</mat-icon>
              {{ capFilter() === 'perm' && filterPermLabel() ? 'Can do: ' + filterPermLabel() : 'Can do…' }}
            </button>
            <button type="button" class="um-chip um-chip--policy" (click)="openPolicy()">
              <mat-icon aria-hidden="true">policy</mat-icon> Policy
            </button>
          </div>

          <!-- ─── ROLE FILTER CHIPS (exact role-set match) ─── -->
          @if (presets().length) {
            <div class="um-chips um-chips--roles" role="group" aria-label="Filter by role">
              @for (p of presets(); track p.key) {
                <button type="button" class="um-chip um-chip--role" [class.is-on]="filterRole() === p.key"
                        [attr.aria-pressed]="filterRole() === p.key" (click)="toggleFilterRole(p.key)">
                  <mat-icon aria-hidden="true">badge</mat-icon> {{ p.label }}
                </button>
              }
            </div>
          }

          <!-- ─── BULK TOOLBAR (canManage) ─── -->
          @if (canManage() && bulkMode()) {
            <div class="um-bulkbar" role="toolbar" aria-label="Bulk actions">
              <button type="button" class="um-bulkbar__sel" (click)="toggleSelectAllVisible()">
                <mat-icon aria-hidden="true">{{ allVisibleSelected() ? 'check_box' : 'check_box_outline_blank' }}</mat-icon>
                {{ allVisibleSelected() ? 'None' : 'All' }}
              </button>
              <span class="um-bulkbar__count mono-num">{{ bulkCount() }} selected</span>
              <button type="button" class="um-bulkbar__go" [disabled]="!bulkCount() || bulkRunning()"
                      (click)="openBulkSheet()">
                @if (bulkRunning()) { <mat-icon class="um-spin" aria-hidden="true">progress_activity</mat-icon> {{ bulkDone() }}/{{ bulkTotal() }} }
                @else { <mat-icon aria-hidden="true">bolt</mat-icon> Actions }
              </button>
              <button type="button" class="um-bulkbar__x" (click)="exitBulkMode()" aria-label="Exit select mode">
                <mat-icon aria-hidden="true">close</mat-icon>
              </button>
            </div>
          }

          @if (filteredUsers(); as list) {
            @if (list.length) {
              <div class="um-list">
                @for (u of list; track u.id; let i = $index) {
                  <button type="button" class="um-card um-reveal" [style.--ri]="i"
                          [class.is-disabled]="!u.isEnabled" [class.is-picked]="isSelected(u.id)"
                          (click)="openDetail(u)"
                          (pointerdown)="onCardPressStart(u)" (pointerup)="onCardPressEnd()"
                          (pointerleave)="onCardPressEnd()" (pointercancel)="onCardPressEnd()"
                          (contextmenu)="$event.preventDefault()"
                          [attr.aria-label]="cardAria(u)">
                    @if (canManage() && bulkMode()) {
                      <span class="um-card__check" [class.on]="isSelected(u.id)" aria-hidden="true">
                        <mat-icon>{{ isSelected(u.id) ? 'check_circle' : 'radio_button_unchecked' }}</mat-icon>
                      </span>
                    }
                    <span class="um-card__avatar" [class.off]="!u.isEnabled" aria-hidden="true">{{ userInitial(u) }}</span>
                    <span class="um-card__body">
                      <span class="um-card__name">{{ u.name || 'Unnamed user' }}</span>
                      @if (emailsRevealed() && u.email) {
                        <span class="um-card__email">{{ u.email }}</span>
                      }
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

          <!-- ─── RECENT CHANGES (audit log) — gated canManage ─── -->
          @if (canManage() && audit().length) {
            <section class="um-audit" aria-label="Recent changes">
              <h2 class="um-audit__title"><mat-icon aria-hidden="true">history</mat-icon> Recent changes</h2>
              <ul class="um-audit__list">
                @for (a of audit().slice(0, 20); track a.id) {
                  <li class="um-audit__row">
                    <span class="um-audit__when mono-num">{{ a.whenUtc | date: 'MMM d, HH:mm' }}</span>
                    <span class="um-audit__action">{{ a.action }}</span>
                    @if (emailsRevealed() && (a.actorEmail || a.targetEmail)) {
                      <span class="um-audit__who">
                        @if (a.actorEmail) { {{ a.actorEmail }} }
                        @if (a.actorEmail && a.targetEmail) { → }
                        @if (a.targetEmail) { {{ a.targetEmail }} }
                      </span>
                    }
                    @if (a.detail) { <span class="um-audit__detail">{{ a.detail }}</span> }
                  </li>
                }
              </ul>
            </section>
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
              @if (emailsRevealed() && u.email) { <span class="ud__email">{{ u.email }}</span> }
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

          <!-- ADMIN LOCATION HISTORY LINK — gated location.view.all (mirrors the desktop page) -->
          @if (auth.hasPermission(PERM.locationViewAll)) {
            <div class="ud__block">
              <span class="ud__block-title"><mat-icon aria-hidden="true">map</mat-icon> Location history</span>
              <a class="ud__map-link" [routerLink]="['/admin/locations']" [queryParams]="{ user: u.id }"
                 (click)="detailOpen.set(false)"
                 [attr.aria-label]="'View ' + (u.name || 'this user') + ' on the admin map'">
                <mat-icon aria-hidden="true">location_on</mat-icon> View on map
                <mat-icon class="ud__map-go" aria-hidden="true">chevron_right</mat-icon>
              </a>
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
                  @for (e of visibleLogins(); track e.id) {
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
                @if (hasMoreLogins()) {
                  <button type="button" class="ud__logins-more" (click)="loginsExpanded.set(!loginsExpanded())">
                    <mat-icon aria-hidden="true">{{ loginsExpanded() ? 'expand_less' : 'expand_more' }}</mat-icon>
                    {{ loginsExpanded() ? 'Show fewer' : 'Show all (' + ls.events.length + ')' }}
                  </button>
                }
              }
            }
          </div>

          <!-- CHAT CONTACTS (the circle) — admin editor, gated chat.contacts.manage -->
          @if (canManageContacts()) {
            <div class="ud__block">
              <span class="ud__block-title"><mat-icon aria-hidden="true">group</mat-icon> Chat contacts</span>
              <p class="ud__block-sub">Who this person can message. Changes are mutual.</p>
              @if (contactsState(u.id); as cs) {
                @if (cs.loading) {
                  <div class="ud__logins" aria-hidden="true">
                    <app-bs-skeleton height="44px" radius="var(--r-tile)" />
                    <app-bs-skeleton height="44px" radius="var(--r-tile)" />
                  </div>
                } @else if (cs.error) {
                  <p class="ud__logins-empty">Couldn't load contacts.</p>
                } @else {
                  @if (cs.contacts.length) {
                    <ul class="ud__contacts">
                      @for (c of cs.contacts; track c.userId) {
                        <li class="ud__contact">
                          <span class="ud__contact-avatar" aria-hidden="true">{{ contactInitials(c) }}</span>
                          <span class="ud__contact-name">{{ c.name }}</span>
                          <button type="button" class="ud__contact-rm" [disabled]="cs.busyUserId === c.userId"
                                  (click)="removeContact(u, c.userId)" [attr.aria-label]="'Remove ' + c.name">
                            @if (cs.busyUserId === c.userId) { <mat-icon class="um-spin" aria-hidden="true">progress_activity</mat-icon> }
                            @else { <mat-icon aria-hidden="true">close</mat-icon> }
                          </button>
                        </li>
                      }
                    </ul>
                  } @else {
                    <p class="ud__logins-empty">No contacts yet.</p>
                  }

                  <label class="um-search um-search--sm">
                    <mat-icon class="um-search__ic" aria-hidden="true">person_add</mat-icon>
                    <input class="um-search__input" type="search" inputmode="search"
                           [ngModel]="cs.query" (ngModelChange)="setContactsQuery(u.id, $event)"
                           placeholder="Add a contact by name" autocomplete="off" aria-label="Search to add a contact" />
                  </label>
                  @if (addCandidates(u); as cands) {
                    @if (cands.length) {
                      <ul class="ud__contacts ud__contacts--add">
                        @for (c of cands.slice(0, 8); track c.userId) {
                          <li class="ud__contact">
                            <span class="ud__contact-avatar" aria-hidden="true">{{ contactInitials(c) }}</span>
                            <span class="ud__contact-name">{{ c.name }}</span>
                            <button type="button" class="ud__contact-add" [disabled]="cs.busyUserId === c.userId"
                                    (click)="addContact(u, c.userId)" [attr.aria-label]="'Add ' + c.name">
                              @if (cs.busyUserId === c.userId) { <mat-icon class="um-spin" aria-hidden="true">progress_activity</mat-icon> }
                              @else { <mat-icon aria-hidden="true">add</mat-icon> }
                            </button>
                          </li>
                        }
                      </ul>
                    } @else if (cs.query) {
                      <p class="ud__logins-empty">No one matches "{{ cs.query }}".</p>
                    }
                  }
                }
              }
            </div>
          }

          <!-- DANGER / SESSION ACTIONS — gated canManage -->
          @if (canManage()) {
            <div class="ud__danger">
              <button type="button" class="ud__danger-btn" (click)="forceLogout(u)">
                <mat-icon aria-hidden="true">logout</mat-icon> Sign out of all sessions
              </button>
              <button type="button" class="ud__danger-btn ud__danger-btn--rm" (click)="remove(u)">
                <mat-icon aria-hidden="true">person_remove</mat-icon> Remove user
              </button>
            </div>
          }

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

    <!-- ─────────────── "CAN DO" PERMISSION-FILTER PICKER SHEET ─────────────── -->
    <app-bs-sheet [(open)]="permPickerOpen" detent="full" label="Filter by capability">
      <div class="up">
        <div class="up__head">
          <h3 class="up__title"><mat-icon aria-hidden="true">tune</mat-icon> Can do…</h3>
          <button type="button" class="up__close" (click)="permPickerOpen.set(false)" aria-label="Close">
            <mat-icon aria-hidden="true">close</mat-icon>
          </button>
        </div>
        <p class="up__sub">Narrow the list to users who hold a specific capability.</p>

        <button type="button" class="ud__perm" role="option" [attr.aria-selected]="!filterPerm()"
                [class.is-on]="!filterPerm()" (click)="setFilterPerm('')">
          <span class="ud__perm-body">
            <span class="ud__perm-label">Any capability</span>
            <span class="ud__perm-desc">Clear the capability filter.</span>
          </span>
          @if (!filterPerm()) { <mat-icon aria-hidden="true">check</mat-icon> }
        </button>

        @for (g of groups(); track g.name) {
          <div class="up__group">
            <span class="up__group-name">{{ g.name }}</span>
            <div class="ud__perms">
              @for (perm of g.perms; track perm.key) {
                <button type="button" class="ud__perm" role="option"
                        [class.is-on]="filterPerm() === perm.key" [attr.aria-selected]="filterPerm() === perm.key"
                        (click)="setFilterPerm(perm.key)">
                  <span class="ud__perm-body">
                    <span class="ud__perm-label">{{ perm.label }}</span>
                    <span class="ud__perm-desc">{{ perm.description }}</span>
                  </span>
                  @if (filterPerm() === perm.key) { <mat-icon aria-hidden="true">check</mat-icon> }
                </button>
              }
            </div>
          </div>
        }
        <div class="ud__savebar-spacer" aria-hidden="true"></div>
      </div>
    </app-bs-sheet>

    <!-- ─────────────── REVEAL-KEY SHEET (email reveal) ─────────────── -->
    <app-bs-sheet [(open)]="revealOpen" detent="half" [dismissable]="!revealing()" label="Show emails">
      <div class="up">
        <div class="up__head">
          <h3 class="up__title"><mat-icon aria-hidden="true">lock</mat-icon> Show emails</h3>
          <button type="button" class="up__close" (click)="revealOpen.set(false)" aria-label="Close" [disabled]="revealing()">
            <mat-icon aria-hidden="true">close</mat-icon>
          </button>
        </div>
        <p class="up__sub">
          Enter the reveal key to show real email addresses on this page. The key is held in memory only
          for this session and is never saved.
        </p>
        <form (ngSubmit)="submitRevealKey()">
          <label class="ud__block">
            <span class="ud__block-title"><mat-icon aria-hidden="true">key</mat-icon> Reveal key</span>
            <input class="um-textfield" type="password" autocomplete="off" name="revealKey"
                   [ngModel]="revealKeyInput()" (ngModelChange)="revealKeyInput.set($event)"
                   placeholder="Reveal key" aria-label="Email reveal key" />
          </label>
        </form>
      </div>
      <div class="ud__savebar is-dirty">
        <span class="ud__savebar-hint">Emails stay masked until verified</span>
        <button type="button" class="ud__savebar-btn" [disabled]="revealing() || !revealKeyInput().trim()"
                (click)="submitRevealKey()">
          @if (revealing()) { <mat-icon class="um-spin" aria-hidden="true">progress_activity</mat-icon> Checking… }
          @else { <mat-icon aria-hidden="true">lock_open</mat-icon> Show emails }
        </button>
      </div>
    </app-bs-sheet>

    <!-- ─────────────── ADD-USER SHEET ─────────────── -->
    <app-bs-sheet [(open)]="addOpen" detent="full" [dismissable]="!adding()" label="Add user">
      <div class="up">
        <div class="up__head">
          <h3 class="up__title"><mat-icon aria-hidden="true">person_add</mat-icon> Add user</h3>
          <button type="button" class="up__close" (click)="addOpen.set(false)" aria-label="Close" [disabled]="adding()">
            <mat-icon aria-hidden="true">close</mat-icon>
          </button>
        </div>

        <label class="ud__block">
          <span class="ud__block-title"><mat-icon aria-hidden="true">mail</mat-icon> Email</span>
          <input class="um-textfield" type="email" inputmode="email" autocomplete="off"
                 [ngModel]="newEmail()" (ngModelChange)="newEmail.set($event)"
                 placeholder="name@example.com" aria-label="New user email" />
        </label>

        <button type="button" class="ud__enable" [class.is-on]="newEnabled()"
                role="switch" [attr.aria-checked]="newEnabled()" (click)="newEnabled.set(!newEnabled())">
          <mat-icon aria-hidden="true">{{ newEnabled() ? 'check_circle' : 'block' }}</mat-icon>
          <span class="ud__enable-txt">
            <b>{{ newEnabled() ? 'Enabled' : 'Disabled' }}</b>
            <i>{{ newEnabled() ? 'They can sign in immediately.' : 'They cannot sign in until enabled.' }}</i>
          </span>
          <span class="um-switch" [class.is-on]="newEnabled()" aria-hidden="true"><span class="um-switch__knob"></span></span>
        </button>

        <div class="ud__block">
          <span class="ud__block-title"><mat-icon aria-hidden="true">badge</mat-icon> Role preset</span>
          <p class="ud__block-sub">Seeds the grants below as a starting point.</p>
          <div class="ud__roles">
            @for (p of presets(); track p.key) {
              <button type="button" class="ud__role" [class.is-active]="newRole() === p.key"
                      (click)="applyRoleToNew(p.key)">{{ p.label }}</button>
            }
          </div>
        </div>

        @for (g of featureGroups(); track g.name) {
          <div class="up__group">
            <span class="up__group-name">{{ g.name }}</span>
            <div class="ud__perms">
              @for (perm of g.perms; track perm.key) {
                <button type="button" class="ud__perm" role="switch"
                        [class.is-on]="newHasPerm(perm.key)" [attr.aria-checked]="newHasPerm(perm.key)"
                        (click)="toggleNewPerm(perm.key, !newHasPerm(perm.key))">
                  <span class="ud__perm-body">
                    <span class="ud__perm-label">{{ perm.label }}</span>
                    <span class="ud__perm-desc">{{ perm.description }}</span>
                  </span>
                  <span class="um-switch um-switch--sm" [class.is-on]="newHasPerm(perm.key)" aria-hidden="true"><span class="um-switch__knob"></span></span>
                </button>
              }
            </div>
          </div>
        }

        @for (g of aiGroups(); track g.name) {
          <div class="ud__ai">
            <div class="ud__ai-head">
              <mat-icon aria-hidden="true">auto_awesome</mat-icon>
              <div class="ud__ai-titles">
                <span class="ud__ai-title">{{ g.name }}</span>
                <span class="ud__ai-sub">Token-spending capabilities — grant deliberately.</span>
              </div>
            </div>
            <div class="ud__perms">
              @for (perm of g.perms; track perm.key) {
                <button type="button" class="ud__perm ud__perm--ai" role="switch"
                        [class.is-on]="newHasPerm(perm.key)" [attr.aria-checked]="newHasPerm(perm.key)"
                        (click)="toggleNewPerm(perm.key, !newHasPerm(perm.key))">
                  <span class="ud__perm-body">
                    <span class="ud__perm-label">{{ perm.label }}</span>
                    <span class="ud__perm-desc">{{ perm.description }}</span>
                  </span>
                  <span class="um-switch um-switch--sm um-switch--ai" [class.is-on]="newHasPerm(perm.key)" aria-hidden="true"><span class="um-switch__knob"></span></span>
                </button>
              }
            </div>
          </div>
        }

        <div class="ud__savebar-spacer" aria-hidden="true"></div>
      </div>

      <div class="ud__savebar is-dirty">
        <span class="ud__savebar-hint">Creates the account</span>
        <button type="button" class="ud__savebar-btn" [disabled]="adding() || !newEmail().trim()" (click)="addUser()">
          @if (adding()) { <mat-icon class="um-spin" aria-hidden="true">progress_activity</mat-icon> Adding… }
          @else { <mat-icon aria-hidden="true">person_add</mat-icon> Add user }
        </button>
      </div>
    </app-bs-sheet>

    <!-- ─────────────── BULK-ACTIONS SHEET ─────────────── -->
    <app-bs-sheet [(open)]="bulkSheetOpen" detent="full" label="Bulk actions">
      <div class="up">
        <div class="up__head">
          <h3 class="up__title"><mat-icon aria-hidden="true">bolt</mat-icon> {{ bulkCount() }} selected</h3>
          <button type="button" class="up__close" (click)="bulkSheetOpen.set(false)" aria-label="Close">
            <mat-icon aria-hidden="true">close</mat-icon>
          </button>
        </div>

        <div class="ud__block">
          <span class="ud__block-title"><mat-icon aria-hidden="true">toggle_on</mat-icon> Account state</span>
          <div class="ud__roles">
            <button type="button" class="ud__role" (click)="bulkSetEnabled(true)">
              <mat-icon aria-hidden="true">check_circle</mat-icon> Enable all
            </button>
            <button type="button" class="ud__role" (click)="bulkSetEnabled(false)">
              <mat-icon aria-hidden="true">block</mat-icon> Disable all
            </button>
          </div>
        </div>

        <div class="ud__block">
          <span class="ud__block-title"><mat-icon aria-hidden="true">badge</mat-icon> Apply a role</span>
          <p class="ud__block-sub">Replaces each selected user's permissions with the role.</p>
          <div class="ud__roles">
            @for (p of presets(); track p.key) {
              <button type="button" class="ud__role" (click)="bulkApplyRole(p.key)">{{ p.label }}</button>
            }
          </div>
        </div>

        @for (g of featureGroups(); track g.name) {
          <div class="up__group">
            <span class="up__group-name">{{ g.name }}</span>
            <div class="ud__perms">
              @for (perm of g.perms; track perm.key) {
                <div class="ud__bulkperm">
                  <span class="ud__perm-body">
                    <span class="ud__perm-label">{{ perm.label }}</span>
                    <span class="ud__perm-desc">{{ perm.description }}</span>
                  </span>
                  <button type="button" class="ud__bulkperm-btn grant" (click)="bulkGrant(perm.key)" aria-label="Grant to selected">
                    <mat-icon aria-hidden="true">add</mat-icon>
                  </button>
                  <button type="button" class="ud__bulkperm-btn revoke" (click)="bulkRevoke(perm.key)" aria-label="Revoke from selected">
                    <mat-icon aria-hidden="true">remove</mat-icon>
                  </button>
                </div>
              }
            </div>
          </div>
        }

        @for (g of aiGroups(); track g.name) {
          <div class="ud__ai">
            <div class="ud__ai-head">
              <mat-icon aria-hidden="true">auto_awesome</mat-icon>
              <div class="ud__ai-titles">
                <span class="ud__ai-title">{{ g.name }}</span>
                <span class="ud__ai-sub">Token-spending — grants require a confirm.</span>
              </div>
            </div>
            <div class="ud__perms">
              @for (perm of g.perms; track perm.key) {
                <div class="ud__bulkperm ud__perm--ai">
                  <span class="ud__perm-body">
                    <span class="ud__perm-label">{{ perm.label }}</span>
                    <span class="ud__perm-desc">{{ perm.description }}</span>
                  </span>
                  <button type="button" class="ud__bulkperm-btn grant" (click)="bulkGrant(perm.key)" aria-label="Grant to selected">
                    <mat-icon aria-hidden="true">add</mat-icon>
                  </button>
                  <button type="button" class="ud__bulkperm-btn revoke" (click)="bulkRevoke(perm.key)" aria-label="Revoke from selected">
                    <mat-icon aria-hidden="true">remove</mat-icon>
                  </button>
                </div>
              }
            </div>
          </div>
        }

        <div class="ud__savebar-spacer" aria-hidden="true"></div>
      </div>
    </app-bs-sheet>

    <!-- ADD-USER FAB (canManage; hidden while any sheet or bulk mode is up) -->
    @if (canManage() && !loading() && !errored() && !detailOpen() && !policyOpen()
         && !addOpen() && !bulkSheetOpen() && !confirmOpen() && !permPickerOpen()
         && !revealOpen() && !bulkMode()) {
      <app-bs-fab icon="person_add" label="Add user" [fixed]="true" (action)="openAddUser()" />
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
  /** The permission key the `perm` capability filter narrows to ('' = none). */
  readonly filterPerm = signal('');
  /** The "Can do" per-permission picker sheet (chooses which key the `perm` filter narrows to). */
  readonly permPickerOpen = signal(false);

  readonly capChips: readonly { key: CapFilter; label: string; icon: string }[] = [
    { key: 'all', label: 'All', icon: 'groups' },
    { key: 'ai', label: 'Has AI', icon: 'auto_awesome' },
    { key: 'enabled', label: 'Enabled', icon: 'check_circle' },
    { key: 'disabled', label: 'Disabled', icon: 'block' },
  ];

  // ---- email reveal (key-gated; mirrors the desktop page) ----
  // The key lives in COMPONENT MEMORY ONLY — never localStorage, never a URL. Null => emails masked.
  private revealKey: string | null = null;
  /** True once a key has yielded real emails — drives the toggle label/icon + the reveal-key sheet. */
  readonly emailsRevealed = signal(false);
  /** In-flight guard for the reveal/hide re-fetch (disables the toggle, shows a spinner). */
  readonly revealing = signal(false);
  /** The reveal-key entry sheet + its bound input. */
  readonly revealOpen = signal(false);
  readonly revealKeyInput = signal('');

  /** The caller's own email (their own email is always returned real — used to detect a real reveal). */
  private get myEmail(): string | null {
    return this.auth.session()?.email?.toLowerCase() ?? null;
  }

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
  /** Collapsed by default: the sign-in list shows a preview until "show all" is tapped (per selected user). */
  readonly loginsExpanded = signal(false);
  /** Preview cap for the sign-in list before "show all" (desktop shows up to 200; we lazy-expand). */
  private static readonly LOGIN_PREVIEW = 6;

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

  // ---- admin management gate (mirrors the live page) ----
  readonly canManage = computed(() => this.auth.hasPermission(PERM.usersManage));
  readonly canManageContacts = computed(() => this.auth.hasPermission(PERM.chatContactsManage));

  // ---- role filter chip (exact role-set match, or '' for any) ----
  readonly filterRole = signal('');

  // ---- add user (FAB → sheet) ----
  readonly addOpen = signal(false);
  readonly newEmail = signal('');
  readonly newEnabled = signal(true);
  readonly newPerms = signal<Set<string>>(new Set([PERM.dashboardView]));
  readonly adding = signal(false);

  // ---- bulk selection + actions ----
  /** Whether long-press/checkbox multi-select mode is active. */
  readonly bulkMode = signal(false);
  readonly selectedIds = signal<Set<number>>(new Set());
  readonly bulkRunning = signal(false);
  readonly bulkDone = signal(0);
  readonly bulkTotal = signal(0);
  /** The bulk-actions sheet (apply role / grant / revoke / enable-all / disable-all). */
  readonly bulkSheetOpen = signal(false);

  // ---- chat contacts (circle) — admin editor in the detail (chat.contacts.manage) ----
  readonly contacts = signal<Map<number, ContactsState>>(new Map());
  readonly directory = signal<ChatContactDto[]>([]);
  private directoryLoaded = false;

  // ---- audit log ("Recent changes") ----
  readonly audit = signal<AuditEntry[]>([]);

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

  readonly isFiltering = computed(
    () => !!this.search().trim() || this.capFilter() !== 'all' || !!this.filterRole(),
  );

  /** Label of the permission the `perm` filter narrows to (for the active "Can do" chip). */
  readonly filterPermLabel = computed(
    () => this.permByKey().get(this.filterPerm())?.label ?? '',
  );

  readonly filteredUsers = computed<ManagedUser[]>(() => {
    const q = this.search().trim().toLowerCase();
    const cap = this.capFilter();
    const permKey = this.filterPerm();
    const ai = this.aiKeys();
    const role = this.presets().find((p) => p.key === this.filterRole());
    const roleSet = role ? new Set(role.permissions) : null;
    const emails = this.emailsRevealed();
    return this.users().filter((u) => {
      if (q) {
        // Match name always; match email only when revealed (mirrors the desktop search axis).
        const hay = emails ? `${u.name ?? ''} ${u.email ?? ''}`.toLowerCase() : (u.name ?? '').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (roleSet) {
        if (u.permissions.length !== roleSet.size) return false;
        if (!u.permissions.every((k) => roleSet.has(k))) return false;
      }
      switch (cap) {
        case 'ai': return u.permissions.some((k) => ai.has(k));
        case 'enabled': return u.isEnabled;
        case 'disabled': return !u.isEnabled;
        case 'perm': return !permKey || u.permissions.includes(permKey);
      }
      return true;
    });
  });

  // ─────────────── derived: bulk selection ───────────────

  readonly bulkCount = computed(() => this.selectedIds().size);
  readonly allVisibleSelected = computed(() => {
    const vis = this.filteredUsers();
    if (!vis.length) return false;
    const sel = this.selectedIds();
    return vis.every((u) => sel.has(u.id));
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

  /** The sign-in rows to render: capped to a preview until expanded, then up to the server's 200. */
  readonly visibleLogins = computed<LoginEvent[]>(() => {
    const events = this.loginState()?.events ?? [];
    return this.loginsExpanded() ? events.slice(0, 200) : events.slice(0, UsersMobilePage.LOGIN_PREVIEW);
  });

  /** True when the sign-in history has more rows than the collapsed preview shows. */
  readonly hasMoreLogins = computed(
    () => (this.loginState()?.events.length ?? 0) > UsersMobilePage.LOGIN_PREVIEW,
  );

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
        firstValueFrom(this.api.users(this.revealKey ?? undefined)), // pass the key when revealed
        firstValueFrom(this.api.permissionCatalog()),
        firstValueFrom(this.api.permissionPresets()),
      ]);
      this.users.set(users ?? []);
      this.perms.set(perms ?? []);
      this.presets.set(presets ?? []);
      this.pruneSelection();
      // keep an open detail in sync with the fresh row, or close it if it's gone
      const u = this.selected();
      if (u) {
        const next = (users ?? []).find((x) => x.id === u.id);
        if (next) this.seedDraft(next); else this.detailOpen.set(false);
      }
      this.loadPolicy();
      this.loadAudit();
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

  private loadAudit(): void {
    if (!this.canManage()) return;
    this.api.auditLog(this.revealKey ?? undefined).subscribe({ // pass the key when revealed
      next: (a) => this.audit.set(a),
      error: () => { /* non-critical — the Recent-changes section just hides */ },
    });
  }

  /** Drop any bulk-selected ids that no longer exist (e.g. after a reload/delete). */
  private pruneSelection(): void {
    const live = new Set(this.users().map((u) => u.id));
    this.selectedIds.update((s) => {
      const next = new Set([...s].filter((id) => live.has(id)));
      return next.size === s.size ? s : next;
    });
  }

  // ─────────────── list helpers ───────────────

  toggleCap(cap: CapFilter): void {
    this.capFilter.update((c) => (c === cap ? 'all' : cap));
    if (this.capFilter() !== 'perm') this.filterPerm.set('');
  }

  clearFilters(): void {
    this.search.set('');
    this.capFilter.set('all');
    this.filterPerm.set('');
    this.filterRole.set('');
  }

  // ─────────────── "Can do" per-permission filter ───────────────

  /** Open the permission-catalog picker that drives the `perm` capability filter. */
  openPermPicker(): void {
    this.permPickerOpen.set(true);
  }

  /** Narrow the list to holders of a permission key (or clear when key is ''). */
  setFilterPerm(key: string): void {
    this.filterPerm.set(key);
    this.capFilter.set(key ? 'perm' : 'all');
    this.permPickerOpen.set(false);
  }

  // ─────────────── EMAIL REVEAL (key-gated) ───────────────

  /** Toggle the reveal: hide immediately, or open the key-entry sheet. Mirrors the desktop page. */
  toggleEmails(): void {
    if (this.emailsRevealed()) { this.hideEmails(); return; }
    this.revealKeyInput.set('');
    this.revealOpen.set(true);
  }

  /** Submit the entered key: re-fetch users + audit WITH the key and reveal only if real emails came back. */
  submitRevealKey(): void {
    const key = this.revealKeyInput().trim();
    if (!key || this.revealing()) return;
    this.revealing.set(true);
    forkJoin({ users: this.api.users(key), audit: this.api.auditLog(key) }).subscribe({
      next: ({ users, audit }) => {
        this.revealing.set(false);
        if (this.didReveal(users, audit)) {
          this.revealKey = key;
          this.users.set(users ?? []);
          this.audit.set(audit ?? []);
          const u = this.selected();
          if (u) {
            const next = (users ?? []).find((x) => x.id === u.id);
            if (next) this.seedDraft(next);
          }
          this.emailsRevealed.set(true);
          this.revealOpen.set(false);
          this.toast.show('Emails revealed', { tone: 'success', durationMs: 2000 });
        } else {
          this.revealKey = null;
          this.toast.show('Incorrect key', { tone: 'warn', durationMs: 4000 });
        }
      },
      error: () => {
        this.revealing.set(false);
        this.revealKey = null;
        this.toast.show('Incorrect key', { tone: 'warn', durationMs: 4000 });
      },
    });
  }

  /** A reveal succeeded when any OTHER user's / audit entry's email came back real (mine is always real). */
  private didReveal(users: ManagedUser[], audit: AuditEntry[]): boolean {
    const mine = this.myEmail;
    const isOther = (e: string | null) => !!e && e.toLowerCase() !== mine;
    return (
      (users ?? []).some((u) => isOther(u.email)) ||
      (audit ?? []).some((a) => isOther(a.actorEmail) || isOther(a.targetEmail))
    );
  }

  /** Drop the key + re-fetch masked (the plain reload path already omits the key). */
  private hideEmails(): void {
    this.revealKey = null;
    this.emailsRevealed.set(false);
    void this.reload();
  }

  /** Toggle the exact-role filter chip (clicking the active one clears it). */
  toggleFilterRole(key: string): void {
    this.filterRole.update((r) => (r === key ? '' : key));
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
    // Swallow the click that immediately follows a long-press (which just entered bulk mode + picked u).
    if (this.suppressNextClick) { this.suppressNextClick = false; return; }
    // In bulk-select mode, tapping a card toggles its checkbox instead of drilling in.
    if (this.bulkMode()) {
      this.toggleSelect(u.id, !this.isSelected(u.id));
      return;
    }
    this.selectedId.set(u.id);
    this.seedDraft(u);
    this.loginsExpanded.set(false);
    this.detailOpen.set(true);
    if (!this.logins().has(u.id)) this.loadLogins(u.id);
    if (this.canManageContacts()) {
      if (!this.contacts().has(u.id)) this.loadContacts(u);
      this.ensureDirectory();
    }
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
        onConfirm: () => { this.confirmOpen.set(false); this.commitSave(u, /*announceUndo*/ false); },
      });
      this.confirmOpen.set(true);
      return;
    }
    // Routine (non-sensitive) save — offer an Undo that re-saves the prior grant set.
    this.commitSave(u, /*announceUndo*/ true);
  }

  /** The per-user PUT. On the routine path, offer an Undo toast that re-saves the PRIOR grant set. */
  private commitSave(u: ManagedUser, announceUndo: boolean): void {
    const prior = { permissions: [...u.permissions], isEnabled: u.isEnabled };
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
        this.loadAudit();
        if (announceUndo) {
          this.toast.undo(`Saved ${updated.name || 'user'}`, () => this.undoSave(u.id, prior));
        } else {
          this.toast.show(`Saved ${updated.name || 'user'}`, { tone: 'success', durationMs: 2000 });
        }
      },
      error: (err: HttpErrorResponse) => {
        this.saving.set(false);
        this.toast.show(err.error?.message ?? 'Save failed', { tone: 'warn' });
      },
    });
  }

  /** Re-save a user's prior grant set (the Undo action of a routine save). */
  private undoSave(id: number, prior: { permissions: string[]; isEnabled: boolean }): void {
    const u = this.users().find((x) => x.id === id);
    const name = u ? this.userLabel(u) : `user #${id}`;
    this.api
      .updateUser(id, { name: u?.name, isEnabled: prior.isEnabled, permissions: prior.permissions })
      .subscribe({
        next: (updated) => {
          this.users.update((list) => list.map((x) => (x.id === updated.id ? updated : x)));
          if (this.selectedId() === id) this.seedDraft(updated);
          this.loadAudit();
          this.toast.show(`Reverted ${name}`, { tone: 'success', durationMs: 2200 });
        },
        error: () => this.toast.show('Could not undo', { tone: 'warn', durationMs: 4000 }),
      });
  }

  /** Open the sensitive-confirm sheet with a named action button; runs `onConfirm` on accept. */
  private askConfirm(
    title: string, lines: string[], confirmLabel: string, danger: boolean, onConfirm: () => void,
  ): void {
    this.confirm.set({
      title, lines, confirmLabel, danger,
      onConfirm: () => { this.confirmOpen.set(false); onConfirm(); },
    });
    this.confirmOpen.set(true);
  }

  private userLabel(u: ManagedUser): string {
    return u.name || u.email || `user #${u.id}`;
  }

  // ─────────────── FORCE SIGN-OUT ───────────────

  /** Force-log a user out of every active session (invalidates their JWT). Non-destructive. */
  forceLogout(u: ManagedUser): void {
    this.askConfirm(
      'Sign out of all sessions?',
      [
        `${this.userLabel(u)} will be signed out of every active session.`,
        'Non-destructive — the account stays enabled and they can sign back in.',
      ],
      'Sign out', false,
      () => {
        this.api.forceLogout(u.id).subscribe({
          next: () => {
            this.loadAudit();
            this.toast.show(`Signed ${this.userLabel(u)} out`, { tone: 'success', durationMs: 2200 });
          },
          error: (err: HttpErrorResponse) =>
            this.toast.show(err.error?.message ?? 'Could not sign user out', { tone: 'warn' }),
        });
      },
    );
  }

  // ─────────────── REMOVE USER ───────────────

  remove(u: ManagedUser): void {
    this.askConfirm(
      'Remove user?',
      [`${this.userLabel(u)} will lose access immediately.`, 'This cannot be undone.'],
      'Remove user', true,
      () => {
        this.api.deleteUser(u.id).subscribe({
          next: () => {
            this.users.update((list) => list.filter((x) => x.id !== u.id));
            this.selectedIds.update((s) => {
              if (!s.has(u.id)) return s;
              const n = new Set(s); n.delete(u.id); return n;
            });
            if (this.selectedId() === u.id) { this.detailOpen.set(false); this.selectedId.set(null); }
            this.loadAudit();
            this.toast.show(`Removed ${this.userLabel(u)}`, { tone: 'success', durationMs: 2200 });
          },
          error: (err: HttpErrorResponse) =>
            this.toast.show(err.error?.message ?? 'Delete failed', { tone: 'warn' }),
        });
      },
    );
  }

  // ─────────────── ADD USER ───────────────

  openAddUser(): void {
    this.newEmail.set('');
    this.newEnabled.set(true);
    this.newPerms.set(new Set([PERM.dashboardView]));
    this.addOpen.set(true);
  }

  newHasPerm(key: string): boolean {
    return this.newPerms().has(key);
  }

  toggleNewPerm(key: string, checked: boolean): void {
    this.newPerms.update((s) => {
      const next = new Set(s);
      if (checked) next.add(key); else next.delete(key);
      return next;
    });
  }

  /** The role currently reflected by the new-user grant set ('' = custom). */
  readonly newRole = computed(() => this.matchRole(this.newPerms()));

  applyRoleToNew(roleKey: string): void {
    const role = this.presets().find((p) => p.key === roleKey);
    if (!role) return;
    this.newPerms.set(new Set(role.permissions));
  }

  addUser(): void {
    if (this.adding()) return;
    const email = this.newEmail().trim().toLowerCase();
    if (!email.includes('@')) {
      this.toast.show('Enter a valid email address', { tone: 'warn', durationMs: 2500 });
      return;
    }
    this.adding.set(true);
    this.api.createUser({ email, isEnabled: this.newEnabled(), permissions: [...this.newPerms()] }).subscribe({
      next: (u) => {
        this.adding.set(false);
        this.users.update((list) =>
          [...list, u].sort((a, b) => (a.name ?? a.email ?? '').localeCompare(b.name ?? b.email ?? '')),
        );
        this.addOpen.set(false);
        this.loadAudit();
        this.toast.show(`Added ${u.email || 'user'}`, { tone: 'success', durationMs: 2200 });
      },
      error: (err: HttpErrorResponse) => {
        this.adding.set(false);
        this.toast.show(err.error?.message ?? 'Could not add user', { tone: 'warn' });
      },
    });
  }

  // ─────────────── BULK SELECTION + ACTIONS ───────────────

  isSelected(id: number): boolean {
    return this.selectedIds().has(id);
  }

  private pressTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set true when a long-press fired, so the click that follows the press release is swallowed. */
  private suppressNextClick = false;

  /** Long-press a card (≈450ms) to enter multi-select mode (canManage only). */
  onCardPressStart(u: ManagedUser): void {
    if (!this.canManage() || this.bulkMode()) return;
    this.onCardPressEnd();
    this.pressTimer = setTimeout(() => {
      this.pressTimer = null;
      this.suppressNextClick = true;
      this.enterBulkMode(u);
    }, 450);
  }

  onCardPressEnd(): void {
    if (this.pressTimer) { clearTimeout(this.pressTimer); this.pressTimer = null; }
  }

  enterBulkMode(u?: ManagedUser): void {
    this.bulkMode.set(true);
    if (u) this.toggleSelect(u.id, true);
  }

  exitBulkMode(): void {
    this.bulkMode.set(false);
    this.selectedIds.set(new Set());
  }

  toggleSelect(id: number, checked: boolean): void {
    this.selectedIds.update((s) => {
      const next = new Set(s);
      if (checked) next.add(id); else next.delete(id);
      return next;
    });
  }

  toggleSelectAllVisible(): void {
    const all = this.allVisibleSelected();
    const vis = this.filteredUsers().map((u) => u.id);
    this.selectedIds.update((s) => {
      const next = new Set(s);
      for (const id of vis) { if (all) next.delete(id); else next.add(id); }
      return next;
    });
  }

  private selectedUsers(): ManagedUser[] {
    const sel = this.selectedIds();
    return this.users().filter((u) => sel.has(u.id));
  }

  private nameList(users: ManagedUser[], cap = 6): string {
    const names = users.map((u) => this.userLabel(u));
    if (names.length <= cap) return names.join(', ');
    return `${names.slice(0, cap).join(', ')} +${names.length - cap} more`;
  }

  openBulkSheet(): void {
    if (!this.bulkCount()) return;
    this.bulkSheetOpen.set(true);
  }

  bulkApplyRole(roleKey: string): void {
    const role = this.presets().find((p) => p.key === roleKey);
    const targets = this.selectedUsers();
    if (!role || !targets.length) return;
    this.bulkSheetOpen.set(false);
    this.askConfirm(
      `Apply "${role.label}" to ${targets.length} user(s)?`,
      [`Replaces each one's permissions with the role, then saves.`, this.nameList(targets)],
      'Apply role', this.hasAnyAi(role.permissions),
      () => this.runBulk(targets,
        (u) => ({ ...this.payload(u), permissions: [...role.permissions] }),
        `Applied "${role.label}" to`),
    );
  }

  bulkGrant(key: string): void {
    const targets = this.selectedUsers().filter((u) => !u.permissions.includes(key));
    const label = this.permByKey().get(key)?.label ?? key;
    if (!targets.length) {
      this.toast.show(`All selected already have "${label}"`, { tone: 'neutral', durationMs: 2200 });
      return;
    }
    this.bulkSheetOpen.set(false);
    const run = () => this.runBulk(targets,
      (u) => ({ ...this.payload(u), permissions: [...new Set([...u.permissions, key])] }),
      `Granted "${label}" to`);
    if (this.aiKeys().has(key)) {
      this.askConfirm(
        `Grant token-spending "${label}" to ${targets.length} user(s)?`,
        ['This is an AI capability that spends tokens.', this.nameList(targets)],
        `Grant ${label}`, true, run);
    } else {
      run();
    }
  }

  bulkRevoke(key: string): void {
    const targets = this.selectedUsers().filter((u) => u.permissions.includes(key));
    const label = this.permByKey().get(key)?.label ?? key;
    if (!targets.length) {
      this.toast.show(`No selected user has "${label}"`, { tone: 'neutral', durationMs: 2200 });
      return;
    }
    this.bulkSheetOpen.set(false);
    this.runBulk(targets,
      (u) => ({ ...this.payload(u), permissions: u.permissions.filter((k) => k !== key) }),
      `Revoked "${label}" from`);
  }

  bulkSetEnabled(enabled: boolean): void {
    const targets = this.selectedUsers().filter((u) => u.isEnabled !== enabled);
    if (!targets.length) {
      this.toast.show(`Selected users are already ${enabled ? 'enabled' : 'disabled'}`,
        { tone: 'neutral', durationMs: 2200 });
      return;
    }
    this.bulkSheetOpen.set(false);
    const run = () => this.runBulk(targets,
      (u) => ({ ...this.payload(u), isEnabled: enabled }),
      enabled ? 'Enabled' : 'Disabled');
    if (!enabled) {
      this.askConfirm(
        `Disable ${targets.length} user(s)?`,
        ['They can no longer sign in until re-enabled.', this.nameList(targets)],
        'Disable', true, run);
    } else {
      run();
    }
  }

  private payload(u: ManagedUser): { name?: string; isEnabled: boolean; permissions: string[] } {
    return { name: u.name, isEnabled: u.isEnabled, permissions: u.permissions };
  }

  /** Run a bulk mutation sequentially via the existing per-user updateUser endpoint. */
  private runBulk(
    targets: ManagedUser[],
    build: (u: ManagedUser) => { name?: string; isEnabled: boolean; permissions: string[] },
    verb: string,
  ): void {
    this.bulkRunning.set(true);
    this.bulkDone.set(0);
    this.bulkTotal.set(targets.length);
    let failures = 0;

    const step = (i: number): void => {
      if (i >= targets.length) {
        this.bulkRunning.set(false);
        this.loadAudit();
        const s = this.selected();
        if (s) {
          const next = this.users().find((x) => x.id === s.id);
          if (next) this.seedDraft(next);
        }
        const ok = targets.length - failures;
        const msg = failures ? `${verb} ${ok} user(s); ${failures} failed` : `${verb} ${ok} user(s)`;
        this.toast.show(msg, { tone: failures ? 'warn' : 'success', durationMs: 3000 });
        this.exitBulkMode();
        return;
      }
      const u = targets[i];
      this.api.updateUser(u.id, build(u)).subscribe({
        next: (updated) => {
          this.users.update((list) => list.map((x) => (x.id === updated.id ? updated : x)));
          this.bulkDone.set(i + 1);
          step(i + 1);
        },
        error: () => { failures++; this.bulkDone.set(i + 1); step(i + 1); },
      });
    };
    step(0);
  }

  // ─────────────── CHAT CONTACTS (the circle) — admin editor (chat.contacts.manage) ───────────────

  contactsState(id: number): ContactsState | undefined {
    return this.contacts().get(id);
  }

  private setContactsState(id: number, patch: Partial<ContactsState>): void {
    this.contacts.update((m) => {
      const prev = m.get(id) ?? {
        loading: false, loaded: false, error: false, contacts: [], query: '', busyUserId: null,
      };
      return new Map(m).set(id, { ...prev, ...patch });
    });
  }

  private loadContacts(u: ManagedUser): void {
    this.setContactsState(u.id, {
      loading: true, loaded: false, error: false, contacts: [], query: '', busyUserId: null,
    });
    this.api.userContacts(u.id).subscribe({
      next: (contacts) =>
        this.setContactsState(u.id, { loading: false, loaded: true, error: false, contacts }),
      error: () =>
        this.setContactsState(u.id, { loading: false, loaded: true, error: true, contacts: [] }),
    });
  }

  private ensureDirectory(): void {
    if (this.directoryLoaded) return;
    this.directoryLoaded = true;
    this.api.chatDirectory().subscribe({
      next: (dir) => this.directory.set(dir),
      error: () => { this.directoryLoaded = false; },
    });
  }

  setContactsQuery(id: number, q: string): void {
    this.setContactsState(id, { query: q });
  }

  /** Directory candidates for the add-control: everyone except the owner + those already in the circle. */
  addCandidates(u: ManagedUser): ChatContactDto[] {
    const state = this.contactsState(u.id);
    const have = new Set((state?.contacts ?? []).map((c) => c.userId));
    const q = (state?.query ?? '').trim().toLowerCase();
    return this.directory()
      .filter((c) => c.userId !== u.id && !have.has(c.userId))
      .filter((c) => !q || c.name.toLowerCase().includes(q));
  }

  addContact(u: ManagedUser, contactUserId: number): void {
    const added = this.directory().find((c) => c.userId === contactUserId);
    this.setContactsState(u.id, { busyUserId: contactUserId });
    this.api.addUserContact(u.id, contactUserId).subscribe({
      next: (contacts) => {
        this.setContactsState(u.id, { contacts, query: '', busyUserId: null });
        this.loadAudit();
        this.toast.show(`Added ${added?.name || 'contact'}`, { tone: 'success', durationMs: 1800 });
      },
      error: (err: HttpErrorResponse) => {
        this.setContactsState(u.id, { busyUserId: null });
        this.toast.show(err.error?.message ?? 'Could not add contact', { tone: 'warn' });
      },
    });
  }

  removeContact(u: ManagedUser, contactUserId: number): void {
    const removed = this.contactsState(u.id)?.contacts.find((c) => c.userId === contactUserId);
    this.setContactsState(u.id, { busyUserId: contactUserId });
    this.api.removeUserContact(u.id, contactUserId).subscribe({
      next: (contacts) => {
        this.setContactsState(u.id, { contacts, busyUserId: null });
        this.loadAudit();
        this.toast.show(`Removed ${removed?.name || 'contact'}`, { tone: 'success', durationMs: 1800 });
      },
      error: (err: HttpErrorResponse) => {
        this.setContactsState(u.id, { busyUserId: null });
        this.toast.show(err.error?.message ?? 'Could not remove contact', { tone: 'warn' });
      },
    });
  }

  contactInitials(c: ChatContactDto): string {
    const parts = (c.name || '').split(/[\s@.]+/).filter(Boolean);
    return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || 'U';
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
