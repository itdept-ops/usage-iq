import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { DecimalPipe } from '@angular/common';
import { timer, switchMap, catchError, of } from 'rxjs';

import { Api } from '../../core/api';
import { AuthService } from '../../core/auth';
import { ThemeService, ThemeMode } from '../../core/theme';
import { UnitService, UnitSystem } from '../../core/unit.service';
import {
  ALL_DISCORD_CATEGORIES, DISCORD_CATEGORY_META, DiscordRoute, DisplayNameMode, IngestionSource,
  LocationSettings, MyDiscord, MyDiscordCategories, NotificationPreferenceDto, NotificationSettings,
  NotificationUpdate, PERM, ProfilePrefs, Settings as SettingsModel, SyncResult, SyncStatus,
} from '../../core/models';
import { timeAgo, humanizeInterval } from '../../shared/format';

import {
  BetaEmptyState, BetaPullRefresh, BetaSectionHeader, BetaSegmentedControl,
  BetaSkeleton, BetaToaster, ToastController, Segment,
} from '../beta-ui';
import { BetaToggleRow } from './beta-toggle-row';
import { HomeOption, HOME_OPTIONS } from '../../core/home-options';

/**
 * Settings (beta) — the live Settings hub's QUICK TOGGLES reskinned onto the shared beta-ui "Strata"
 * foundation (`@use '../beta-ui/beta-kit'`) with a SLATE / cool-grey signature accent (a restrained
 * steel-blue pop). It reuses the EXACT same per-user Api methods (inbox-preferences, my-discord, profile,
 * location), the unit + theme services, and the same permission gates as the live hub — but as a premium,
 * phone-shaped settings surface: an immersive identity header (avatar + name + presence line), grouped
 * preference SECTIONS on kit depth surfaces (each with a {@link BetaSectionHeader}), polished native
 * {@link BetaToggleRow} switches, {@link BetaSegmentedControl} quick-settings (units / appearance / display
 * name / home page), pull-to-refresh, and a staggered spring entrance.
 *
 * Scope mirrors the live hub's quick toggles only — surfaces + triggers + per-category Discord + presence +
 * activity + location, PLUS the display-preference segmented controls the live hub exposes (units, theme,
 * display-name mode) and a self-service HOME-PAGE picker (PATCH /api/auth/home). The webhook BUILDER and the
 * admin Sync section stay on the full /preferences hub. Every change saves OPTIMISTICALLY (flip immediately,
 * revert + toast on error). ISOLATED + gated by platform.mobile (route guard); touches no live page, consumes
 * the kit (never modifies it), adds no npm deps.
 */
@Component({
  selector: 'app-beta-settings',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [ToastController],
  styleUrl: './beta-settings.page.scss',
  imports: [
    RouterLink, DecimalPipe,
    BetaEmptyState, BetaPullRefresh, BetaSectionHeader, BetaSegmentedControl,
    BetaSkeleton, BetaToaster, BetaToggleRow,
  ],
  template: `
    <!-- The scroll column IS the kit pull-to-refresh (it owns overflow + the live accent spinner). -->
    <app-bs-pull-refresh class="bs-ptr" [busy]="refreshing()" (refresh)="refreshAll()">
      <div class="scroll">

        <!-- IMMERSIVE IDENTITY HEADER — avatar + name + a quick identity line. -->
        <header class="hh">
          <div class="hh__id">
            <span class="hh__avatar" [class.hh__avatar--img]="!!avatarUrl()">
              @if (avatarUrl(); as url) {
                <img class="hh__avimg" [src]="url" alt="" referrerpolicy="no-referrer" />
              } @else {
                <span class="hh__initials" aria-hidden="true">{{ initials() }}</span>
              }
              <span class="hh__dot" [class.hh__dot--off]="appearOffline()"
                    [attr.title]="appearOffline() ? 'Appearing offline' : 'Online'" aria-hidden="true"></span>
            </span>
            <div class="hh__who">
              <span class="hh__eyebrow">Settings · Beta</span>
              <h1 class="hh__name">{{ displayName() }}</h1>
              <span class="hh__line">{{ identityLine() }}</span>
            </div>
          </div>
        </header>

        <!-- ───────────── APPEARANCE & UNITS (always available — display prefs) ───────────── -->
        <section class="rise" [style.--i]="0">
          <app-bs-section-header title="Display" subtitle="How the app looks and measures" icon="tune" />
          <div class="card card--pad">
            <label class="qs">
              <span class="qs-label">Appearance</span>
              <app-bs-segmented [segments]="themeSegs" [value]="theme.mode()" label="Appearance"
                                (change)="setTheme($event)" />
            </label>
            <div class="qs-div" aria-hidden="true"></div>
            <label class="qs">
              <span class="qs-label">Units</span>
              <app-bs-segmented [segments]="unitSegs" [value]="units.unitSystem()" label="Units"
                                (change)="setUnits($event)" />
            </label>
          </div>
        </section>

        <!-- ───────────── HOME PAGE (self-service landing picker, PATCH /auth/home) ───────────── -->
        @if (homeOptions().length > 1) {
          <section class="rise" [style.--i]="1">
            <app-bs-section-header title="Home page" subtitle="Where the app opens" icon="home" />
            <div class="card card--list" role="radiogroup" aria-label="Home page">
              <button type="button" class="home-row" [class.is-active]="homeChoice() === 'auto'"
                      role="radio" [attr.aria-checked]="homeChoice() === 'auto'"
                      (click)="setHome(null)">
                <span class="home-ic" aria-hidden="true">✧</span>
                <span class="home-text">
                  <span class="home-title">Smart default</span>
                  <span class="home-sub">First page you can open</span>
                </span>
                @if (homeChoice() === 'auto') { <span class="home-check" aria-hidden="true">✓</span> }
              </button>
              @for (h of homeOptions(); track h.route) {
                <button type="button" class="home-row" [class.is-active]="homeChoice() === h.route"
                        role="radio" [attr.aria-checked]="homeChoice() === h.route"
                        (click)="setHome(h.route)">
                  <span class="home-ic" aria-hidden="true">{{ h.icon }}</span>
                  <span class="home-text"><span class="home-title">{{ h.label }}</span></span>
                  @if (homeChoice() === h.route) { <span class="home-check" aria-hidden="true">✓</span> }
                </button>
              }
            </div>
          </section>
        }

        <!-- ───────────── NOTIFICATIONS (chat-gated) ───────────── -->
        @if (canChat()) {
          <section class="rise" [style.--i]="2">
            <app-bs-section-header title="Notifications" subtitle="Where alerts surface" icon="notifications" />
            @if (prefs(); as p) {
              <div class="card card--list">
                @for (t of surfaceItems; track t.key) {
                  <app-beta-toggle-row [title]="t.label" [subtitle]="t.sub" [icon]="t.icon"
                                       [checked]="p[t.key]" (toggle)="setPref(t.key, $event)" />
                }
              </div>
              <p class="grp-cap">What pings you</p>
              <div class="card card--list">
                @for (t of triggerItems; track t.key) {
                  <app-beta-toggle-row [title]="t.label" [icon]="t.icon"
                                       [checked]="p[t.key]" (toggle)="setPref(t.key, $event)" />
                }
              </div>
            } @else {
              <!-- Loading skeleton while notification prefs are in-flight -->
              <div class="card card--list skel-list" aria-hidden="true">
                <app-bs-skeleton height="56px" radius="0" />
                <app-bs-skeleton height="56px" radius="0" />
              </div>
            }
          </section>

          @if (discord(); as d) {
            <section class="rise" [style.--i]="3">
              <app-bs-section-header title="Forward to Discord" subtitle="Mirror alerts to your server" icon="forum" />
              <div class="card card--list">
                <app-beta-toggle-row title="Mirror to Discord" subtitle="Send a copy to your webhook"
                                     icon="ios_share" [checked]="d.surfaceDiscord" [busy]="discordBusy()"
                                     (toggle)="surfaceDiscordChange($event)" />
                @if (d.categories; as cats) {
                <div class="subgroup" [class.subgroup--off]="!d.surfaceDiscord">
                  @for (c of categoryMeta; track c.key) {
                    <app-beta-toggle-row class="sub-row" [title]="c.label"
                                         [checked]="cats[c.key]"
                                         [disabled]="!d.surfaceDiscord" [busy]="discordBusy()"
                                         (toggle)="setCategory(c.key, $event)" />
                  }
                </div>
                }
                <app-beta-toggle-row title="Weekly recap" subtitle="A Sunday summary digest"
                                     icon="event_repeat" [checked]="d.weeklyRecapEnabled" [busy]="discordBusy()"
                                     (toggle)="weeklyRecapChange($event)" />
              </div>
              @if (!d.configured) {
                <div class="hint-row" role="note">
                  <span class="hint-ic" aria-hidden="true">link_off</span>
                  <span class="hint-text">Add a webhook on the full <a class="hint-link" routerLink="/preferences">Settings page</a> to start forwarding.</span>
                </div>
              }
            </section>
          }
        }

        <!-- ───────────── IDENTITY & PRESENCE ───────────── -->
        @if (profile(); as pf) {
          <section class="rise" [style.--i]="4">
            <app-bs-section-header title="How others see me" subtitle="Your name + presence" icon="badge" />
            <div class="card card--pad">
              <label class="qs">
                <span class="qs-label">Display name</span>
                <app-bs-segmented [segments]="nameSegs" [value]="pf.displayNameMode" label="Display name"
                                  (change)="setName($event)" />
              </label>
              <p class="qs-preview">Shown to others as <b>{{ namePreview() }}</b></p>
            </div>
            <div class="card card--list">
              <app-beta-toggle-row title="Appear offline" subtitle="Hide from the online roster"
                                   icon="visibility_off" [checked]="pf.appearOffline"
                                   (toggle)="setProfile('appearOffline', $event)" />
              <app-beta-toggle-row title="Share auto context" subtitle="Lightweight status alongside presence"
                                   icon="bubble_chart" [checked]="pf.shareAutoContext"
                                   (toggle)="setProfile('shareAutoContext', $event)" />
              <app-beta-toggle-row title="Allow nudges" subtitle="Let your circle send friendly pings"
                                   icon="waving_hand" [checked]="!pf.nudgesOptOut"
                                   (toggle)="setProfile('nudgesOptOut', !$event)" />
            </div>
          </section>

          <section class="rise" [style.--i]="5">
            <app-bs-section-header title="Activity" subtitle="What you share with your circle" icon="rss_feed" />
            <div class="card card--list">
              <app-beta-toggle-row title="Share my activity" subtitle="Workouts, streaks, goals hit"
                                   icon="local_fire_department" [checked]="pf.shareActivity"
                                   (toggle)="setProfile('shareActivity', $event)" />
              <app-beta-toggle-row title="View the circle feed" subtitle="See your contacts' activity"
                                   icon="diversity_3" [checked]="pf.viewActivityFeed"
                                   (toggle)="setProfile('viewActivityFeed', $event)" />
            </div>
          </section>
        } @else {
          <!-- Loading skeletons while profile is in-flight -->
          <section class="rise" [style.--i]="4" aria-hidden="true">
            <div class="card card--list skel-list">
              <app-bs-skeleton height="80px" radius="0" />
              <app-bs-skeleton height="56px" radius="0" />
              <app-bs-skeleton height="56px" radius="0" />
              <app-bs-skeleton height="56px" radius="0" />
            </div>
          </section>
        }

        <!-- ───────────── LOCATION (location-gated) ───────────── -->
        @if (canLocation() && location(); as loc) {
          <section class="rise" [style.--i]="6">
            <app-bs-section-header title="Location" subtitle="Private by default" icon="place" />
            <div class="card card--list">
              <app-beta-toggle-row title="Enable capture" subtitle="Record your location history"
                                   icon="my_location" [checked]="loc.locationEnabled"
                                   (toggle)="setLocation('locationEnabled', $event)" />
              <app-beta-toggle-row title="Share with household" subtitle="Coarse city on the family map"
                                   icon="groups" [checked]="loc.shareHousehold"
                                   [disabled]="!loc.locationEnabled"
                                   (toggle)="setLocation('shareHousehold', $event)" />
            </div>
          </section>
        }

        <!-- ═════════════════ ADMIN — INGESTION (timezone + auto-sync + run-now) ═════════════════ -->
        @if (isAdmin()) {
          @if (settings(); as m) {
            <section class="rise" [style.--i]="7">
              <app-bs-section-header title="Ingestion" subtitle="Timezone, auto-sync cadence & manual sync" icon="sync" />
              <div class="card card--pad">
                <div class="sync-pill" [attr.data-state]="syncState()" aria-live="polite">
                  <span class="sync-pill__dot"></span>
                  <span class="sync-pill__txt">Synced {{ lastSyncedLabel() }}</span>
                  @if (autoSyncLabel()) { <span class="sync-pill__sep">·</span><span class="sync-pill__txt">{{ autoSyncLabel() }}</span> }
                </div>

                <label class="fld">
                  <span class="fld__label">Display timezone (IANA)</span>
                  <select class="fld__input" [value]="m.displayTimeZone"
                          (change)="patchSettings('displayTimeZone', $any($event.target).value)"
                          aria-label="Display timezone">
                    @for (z of zones(); track z) { <option [value]="z">{{ z }}</option> }
                  </select>
                  <span class="fld__hint">Controls how events are bucketed into days & months.</span>
                </label>

                <label class="fld">
                  <span class="fld__label">Auto-sync interval (seconds)</span>
                  <input class="fld__input mono-num" type="number" inputmode="numeric" min="30" step="30"
                         [value]="m.autoSyncIntervalSeconds" [disabled]="!m.autoSyncEnabled"
                         (input)="patchSettings('autoSyncIntervalSeconds', +$any($event.target).value)"
                         aria-label="Auto-sync interval in seconds" />
                  <span class="fld__hint">Background re-sync cadence (minimum 30s).</span>
                </label>

                <div class="card card--list flush-list">
                  <app-beta-toggle-row title="Background auto-sync" subtitle="Re-scan logs on a timer"
                                       icon="autorenew" [checked]="m.autoSyncEnabled"
                                       (toggle)="patchSettings('autoSyncEnabled', $event)" />
                </div>

                <div class="act-row">
                  @if (auth.hasPermission(PERM.settingsManage)) {
                    <button type="button" class="btn btn--primary" [disabled]="savingSettings()" (click)="saveSettings()">
                      {{ savingSettings() ? 'Saving…' : 'Save settings' }}
                    </button>
                  }
                  @if (auth.hasPermission(PERM.syncRun)) {
                    <button type="button" class="btn btn--ghost" [disabled]="syncing()" (click)="runSync()">
                      {{ syncing() ? 'Syncing…' : 'Run sync now' }}
                    </button>
                  }
                </div>
              </div>
            </section>

            <!-- ── SOURCES (per-source enable + editable root path) ── -->
            <section class="rise" [style.--i]="8">
              <app-bs-section-header title="Sources" [subtitle]="sources().length + ' configured'" icon="folder" />
              @for (s of sources(); track s.id) {
                <div class="card card--pad src" [class.src--off]="!s.enabled">
                  <div class="card card--list flush-list">
                    <app-beta-toggle-row [title]="s.name"
                                         [subtitle]="s.kind + ' · ' + (s.records | number) + ' rows'"
                                         icon="storage" [checked]="s.enabled"
                                         (toggle)="setSourceEnabled(s, $event)" />
                  </div>
                  <label class="fld">
                    <span class="fld__label">Root path</span>
                    <input class="fld__input mono-num" type="text" autocomplete="off"
                           [value]="s.rootPath" (input)="s.rootPath = $any($event.target).value"
                           [attr.aria-label]="'Root path for ' + s.name" />
                  </label>
                  @if (auth.hasPermission(PERM.settingsManage)) {
                    <div class="act-row">
                      <button type="button" class="btn btn--ghost" [disabled]="savingSourceId() === s.id"
                              (click)="saveSource(s)">
                        {{ savingSourceId() === s.id ? 'Saving…' : 'Save source' }}
                      </button>
                    </div>
                  }
                </div>
              } @empty {
                <app-bs-empty icon="folder_open" title="No sources configured yet" compact
                              body="Ingestion paths appear here once the backend is configured." />
              }
            </section>
          }

          <!-- ── ADMIN DISCORD SYSTEM CONFIG (notificationsView/Manage) ── -->
          @if (canViewNotif()) {
            @if (notif(); as n) {
              <section class="rise" [style.--i]="9">
                <app-bs-section-header title="Discord notifications" subtitle="System digests & spend alerts" icon="notifications_active" />
                <div class="card card--list flush-list">
                  <app-beta-toggle-row title="Enabled" subtitle="Post system alerts to the channel"
                                       icon="power_settings_new" [checked]="n.enabled" [disabled]="!canManageNotif()"
                                       (toggle)="patchNotif('enabled', $event)" />
                </div>
                <div class="card card--pad">
                  <label class="fld">
                    <span class="fld__label">Discord webhook URL</span>
                    <input class="fld__input mono-num" type="password" autocomplete="off"
                           placeholder="https://discord.com/api/webhooks/…"
                           [value]="webhookInput()" (input)="webhookInput.set($any($event.target).value)"
                           [disabled]="!canManageNotif()" aria-label="Discord webhook URL" />
                    <span class="fld__hint">{{ n.webhookConfigured ? 'Configured (' + n.webhookMasked + ') — paste a new URL to replace.' : 'Paste your channel webhook URL.' }}</span>
                  </label>

                  <div class="fld-2col">
                    <label class="fld">
                      <span class="fld__label">Digest hour (local)</span>
                      <input class="fld__input mono-num" type="number" inputmode="numeric" min="0" max="23"
                             [value]="n.digestHourLocal" (input)="patchNotif('digestHourLocal', +$any($event.target).value)"
                             [disabled]="!canManageNotif()" aria-label="Digest hour local" />
                    </label>
                    <label class="fld">
                      <span class="fld__label">Weekly day</span>
                      <select class="fld__input" [value]="n.weeklyDay"
                              (change)="patchNotif('weeklyDay', +$any($event.target).value)"
                              [disabled]="!canManageNotif()" aria-label="Weekly digest day">
                        @for (d of weekdays; track $index) { <option [value]="$index">{{ d }}</option> }
                      </select>
                    </label>
                  </div>

                  <div class="fld-2col">
                    <label class="fld">
                      <span class="fld__label">Spend alert ($ / day)</span>
                      <input class="fld__input mono-num" type="number" inputmode="decimal" min="0" step="10"
                             [value]="n.thresholdUsd" (input)="patchNotif('thresholdUsd', +$any($event.target).value)"
                             [disabled]="!canManageNotif()" aria-label="Spend alert threshold" />
                    </label>
                    <label class="fld">
                      <span class="fld__label">Global mention</span>
                      <input class="fld__input mono-num" type="text" maxlength="64" placeholder="@here or <@&roleId>"
                             [value]="n.mentionOnAlert ?? ''" (input)="patchNotif('mentionOnAlert', $any($event.target).value)"
                             [disabled]="!canManageNotif()" aria-label="Global mention" />
                    </label>
                  </div>

                  @if (canManageNotif()) {
                    <div class="act-row act-row--wrap">
                      <button type="button" class="btn btn--primary" [disabled]="savingNotif()" (click)="saveNotif()">
                        {{ savingNotif() ? 'Saving…' : 'Save' }}
                      </button>
                      <button type="button" class="btn btn--ghost" [disabled]="testingNotif() || !n.webhookConfigured" (click)="testNotif()">
                        {{ testingNotif() ? 'Sending…' : 'Send test' }}
                      </button>
                      <button type="button" class="btn btn--ghost" [disabled]="sendingSnapshot() || !n.webhookConfigured" (click)="sendSnapshot()">
                        {{ sendingSnapshot() ? 'Sending…' : 'Send usage now' }}
                      </button>
                      @if (n.webhookConfigured) {
                        <button type="button" class="btn btn--danger" [disabled]="savingNotif()" (click)="removeWebhook()">Remove</button>
                      }
                    </div>
                  }
                </div>

                <!-- ── Event routing table ── -->
                <p class="grp-cap">Event routing</p>
                @if (routesLoading()) {
                  <div class="card card--list skel-list" aria-hidden="true">
                    <app-bs-skeleton height="56px" radius="0" />
                    <app-bs-skeleton height="56px" radius="0" />
                  </div>
                } @else if (routesError()) {
                  <app-bs-empty icon="cloud_off" title="Couldn’t load the routing table" compact
                                body="Check your connection and try again."
                                ctaLabel="Retry" ctaIcon="refresh" (action)="loadRoutes()" />
                } @else {
                  <div class="card card--list">
                    @for (r of routes(); track r.eventKey) {
                      <div class="route" [class.route--off]="!r.enabled" [class.route--saving]="savingRouteKey() === r.eventKey">
                        <app-beta-toggle-row [title]="r.label" [subtitle]="r.eventKey"
                                             [checked]="r.enabled" [busy]="savingRouteKey() === r.eventKey"
                                             [disabled]="!canManageNotif()"
                                             (toggle)="toggleRoute(r, $event)" />
                        <label class="fld route__mention">
                          <input class="fld__input mono-num" type="text" maxlength="64" placeholder="Mention (optional)"
                                 [value]="r.mention ?? ''"
                                 (blur)="saveRouteMention(r, $any($event.target).value)"
                                 [disabled]="!canManageNotif() || savingRouteKey() === r.eventKey"
                                 [attr.aria-label]="'Mention for ' + r.label" />
                        </label>
                      </div>
                    } @empty {
                      <app-bs-empty icon="alt_route" title="No routes configured" compact
                                    body="Event routes control which Discord notifications forward." />
                    }
                  </div>
                }
              </section>
            }
          }

          <!-- ── LAST SYNC RESULT (after a manual sync) ── -->
          @if (lastSync(); as r) {
            <section class="rise" [style.--i]="10">
              <app-bs-section-header title="Last sync"
                                     [subtitle]="(r.unpricedModels.length || r.sourceWarnings.length || r.warning) ? 'Completed with notes' : 'Completed'"
                                     icon="task_alt" />
              <div class="card card--pad result" [class.result--warn]="r.unpricedModels.length || r.sourceWarnings.length || r.warning">
                <div class="kv"><span>Files parsed / scanned</span><b class="mono-num">{{ r.filesParsed | number }} / {{ r.filesScanned | number }}</b></div>
                <div class="kv"><span>New rows</span><b class="mono-num kv--accent">{{ r.newRecords | number }}</b></div>
                @for (pair of lastSyncBySource(); track pair[0]) {
                  <div class="kv kv--sub"><span>↳ {{ pair[0] }}</span><b class="mono-num kv--accent">+{{ pair[1] | number }}</b></div>
                }
                <div class="kv"><span>Duration</span><b class="mono-num">{{ (r.durationMs / 1000).toFixed(1) }}s</b></div>
                @if (r.unpricedModels.length) {
                  <div class="kv kv--warn"><span>Unpriced models</span><b class="mono-num">{{ r.unpricedModels.join(', ') }}</b></div>
                }
                @for (w of r.sourceWarnings; track w) { <div class="kv kv--warn"><span>Source</span><b>{{ w }}</b></div> }
                @if (r.warning) { <div class="kv kv--warn"><span>Warning</span><b>{{ r.warning }}</b></div> }
              </div>
            </section>
          }
        }

        <p class="foot">Quick toggles — changes save automatically. The full editors live on the
          <a routerLink="/preferences">Settings hub</a>.</p>
        <div class="scroll__foot" aria-hidden="true"></div>
      </div>
    </app-bs-pull-refresh>

    <!-- One toaster host for optimistic-save failure toasts. -->
    <app-bs-toaster />
  `,
})
export class BetaSettingsPage {
  private api = inject(Api);
  private toasts = inject(ToastController);
  readonly theme = inject(ThemeService);
  readonly units = inject(UnitService);

  readonly auth = inject(AuthService);
  readonly PERM = PERM;

  readonly canChat = computed(() => this.auth.hasPermission(PERM.chatRead));
  readonly canLocation = computed(() => this.auth.hasPermission(PERM.locationSelf));

  // ── ADMIN (ingestion / sources / system Discord) — perm-gated exactly like desktop ──
  /** Any admin ingestion capability the desktop exposes (mirrors the desktop's gates). */
  readonly isAdmin = computed(() =>
    this.auth.hasPermission(PERM.settingsManage) ||
    this.auth.hasPermission(PERM.syncRun) ||
    this.auth.hasPermission(PERM.notificationsView) ||
    this.auth.hasPermission(PERM.notificationsManage),
  );
  readonly canViewNotif = computed(() =>
    this.auth.hasPermission(PERM.notificationsView) || this.auth.hasPermission(PERM.notificationsManage),
  );
  readonly canManageNotif = computed(() => this.auth.hasPermission(PERM.notificationsManage));

  readonly settings = signal<SettingsModel | null>(null);
  readonly sources = signal<IngestionSource[]>([]);
  readonly savingSettings = signal(false);
  readonly savingSourceId = signal<number | null>(null);
  readonly syncing = signal(false);
  readonly lastSync = signal<SyncResult | null>(null);
  readonly status = signal<SyncStatus | null>(null);
  private readonly now = signal(Date.now());

  readonly notif = signal<NotificationSettings | null>(null);
  readonly webhookInput = signal('');
  readonly savingNotif = signal(false);
  readonly testingNotif = signal(false);
  readonly sendingSnapshot = signal(false);
  readonly weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  readonly routes = signal<DiscordRoute[]>([]);
  readonly routesLoading = signal(false);
  readonly routesError = signal(false);
  readonly savingRouteKey = signal<string | null>(null);

  readonly lastSyncBySource = computed(() => Object.entries(this.lastSync()?.newRecordsBySource ?? {}));

  readonly lastSyncedLabel = computed(() => {
    const s = this.status();
    const n = this.now();
    if (!s) return '—';
    if (s.isRunning) return 'syncing now…';
    return s.lastSyncUtc
      ? `${timeAgo(s.lastSyncUtc, n)} · +${s.lastNewRecords.toLocaleString()} rows`
      : 'never';
  });
  readonly autoSyncLabel = computed(() => {
    const s = this.status();
    if (!s) return '';
    return s.autoSyncEnabled ? `Auto-sync every ${humanizeInterval(s.intervalSeconds)}` : 'Auto-sync off';
  });
  readonly syncState = computed(() => {
    const s = this.status();
    if (!s) return 'idle';
    if (s.isRunning) return 'running';
    if (s.lastError) return 'error';
    return s.lastSyncUtc ? 'ok' : 'idle';
  });

  private readonly commonZones = [
    'America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix',
    'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu', 'UTC',
    'Europe/London', 'Europe/Berlin', 'Europe/Madrid', 'Asia/Kolkata',
    'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney',
  ];
  readonly zones = computed(() => {
    const cur = this.settings()?.displayTimeZone;
    return cur && !this.commonZones.includes(cur) ? [cur, ...this.commonZones] : this.commonZones;
  });

  readonly prefs = signal<NotificationPreferenceDto | null>(null);
  readonly discord = signal<MyDiscord | null>(null);
  readonly discordBusy = signal(false);
  readonly profile = signal<ProfilePrefs | null>(null);
  readonly location = signal<LocationSettings | null>(null);
  readonly refreshing = signal(false);

  // ── immersive header identity (off the session) ──
  private readonly session = computed(() => this.auth.session());
  readonly avatarUrl = computed(() => this.session()?.picture ?? null);
  readonly appearOffline = computed(() => this.profile()?.appearOffline ?? this.session()?.appearOffline ?? false);
  readonly displayName = computed(() => this.session()?.name?.trim() || 'You');
  readonly initials = computed(() => {
    const n = this.displayName();
    const parts = n.split(/\s+/).filter(Boolean);
    if (parts.length === 0) return 'U';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  });
  /** A quick identity line: nickname/status when set, else a permission-count summary. */
  readonly identityLine = computed(() => {
    const pf = this.profile();
    if (pf?.presenceStatus?.trim()) return pf.presenceStatus.trim();
    if (pf?.displayNameMode === 'nickname' && pf.nickname?.trim()) return `“${pf.nickname.trim()}”`;
    const n = this.auth.permissions().length;
    return n ? `${n} permission${n === 1 ? '' : 's'} · tap to tune` : 'Tune your experience';
  });

  // ── segmented options ──
  readonly themeSegs: Segment[] = [
    { key: 'system', label: 'System' }, { key: 'light', label: 'Light' }, { key: 'dark', label: 'Dark' },
  ];
  readonly unitSegs: Segment[] = [{ key: 'Metric', label: 'Metric' }, { key: 'Imperial', label: 'Imperial' }];
  readonly nameSegs: Segment[] = [
    { key: 'full', label: 'Full' }, { key: 'firstName', label: 'First' },
    { key: 'firstInitial', label: 'First L.' }, { key: 'nickname', label: 'Nick' },
  ];

  readonly categoryMeta = DISCORD_CATEGORY_META;
  readonly surfaceItems: readonly { key: keyof NotificationPreferenceDto; label: string; sub: string; icon: string }[] = [
    { key: 'surfaceToasts', label: 'In-app toasts', sub: 'Pop a toast while you’re here', icon: 'web_asset' },
    { key: 'surfaceBrowser', label: 'Browser notifications', sub: 'OS-level alerts when away', icon: 'desktop_windows' },
  ];
  readonly triggerItems: readonly { key: keyof NotificationPreferenceDto; label: string; icon: string }[] = [
    { key: 'notifyDirectMessages', label: 'Direct messages', icon: 'mail' },
    { key: 'notifyMentions', label: 'Mentions', icon: 'alternate_email' },
    { key: 'notifyChannelMessages', label: 'Channel messages', icon: 'tag' },
    { key: 'notifySystemEvents', label: 'System events', icon: 'campaign' },
  ];

  // Home-page picker — the SHARED HOME_OPTIONS (the SAME list the profile-dropdown picker + canAccessHome
  // use), so this mobile picker offers exactly what the dropdown does, with the same selection, and the two
  // can never diverge. Previously this was a separate hand-kept list of only 6 live routes — that mismatch
  // (no beta routes, fewer live ones) is the "beta settings doesn't connect to the dropdown" oddness.
  readonly homeOptions = computed<HomeOption[]>(() => {
    this.auth.permissions(); // re-run on permission change
    return HOME_OPTIONS.filter(h => this.auth.hasAnyPermission(...h.perms));
  });
  /** The current home choice: a route the user can still access, or 'auto' for the smart default. */
  readonly homeChoice = computed<string>(() => {
    const saved = this.session()?.homeRoute;
    if (saved && this.auth.canAccessHome(saved)) return saved;
    return 'auto';
  });

  /** Live preview of how the display name renders to others (mirrors the server's name-mode logic). */
  readonly namePreview = computed<string>(() => {
    const pf = this.profile();
    const full = this.displayName();
    const parts = full.split(/\s+/).filter(Boolean);
    const first = parts[0] ?? full;
    const last = parts.length > 1 ? parts[parts.length - 1] : '';
    switch (pf?.displayNameMode) {
      case 'firstName': return first;
      case 'firstInitial': return last ? `${first} ${last[0]}.` : first;
      case 'nickname': return pf.nickname?.trim() || first;
      default: return full;
    }
  });

  constructor() {
    if (this.canChat()) {
      this.api.getNotificationPreferences().subscribe({ next: p => this.prefs.set(p), error: () => {} });
      this.api.myDiscord().subscribe({ next: d => this.discord.set(d), error: () => {} });
    }
    this.loadProfile();
    if (this.canLocation()) {
      this.api.locationSettings().subscribe({ next: l => this.location.set(l), error: () => {} });
    }
    // Ensure the unit signal reflects the persisted preference when this page is the entry point.
    void this.units.load();

    // ── ADMIN ingestion sections (perm-gated exactly like desktop) ──
    if (this.isAdmin()) {
      this.loadAdmin();
      // Poll sync status every 15s (also fed by the API's background auto-sync); "now" keeps the label fresh.
      timer(0, 15000)
        .pipe(
          switchMap(() => this.api.syncStatus().pipe(catchError(() => of(null)))),
          takeUntilDestroyed(),
        )
        .subscribe(s => { this.now.set(Date.now()); if (s) this.status.set(s); });
    }
  }

  private loadAdmin(): void {
    this.api.settings().subscribe({ next: s => this.settings.set(s), error: () => {} });
    this.api.sources().subscribe({ next: s => this.sources.set(s), error: () => {} });
    if (this.canViewNotif()) {
      this.api.notifications().subscribe({ next: n => this.notif.set(n), error: () => {} });
      this.loadRoutes();
    }
  }

  loadRoutes(): void {
    this.routesLoading.set(true);
    this.routesError.set(false);
    this.api.discordRoutes().subscribe({
      next: r => { this.routes.set([...r].sort((a, b) => a.sortOrder - b.sortOrder)); this.routesLoading.set(false); },
      error: () => { this.routesLoading.set(false); this.routesError.set(true); },
    });
  }

  private loadProfile(): void {
    this.auth.me().subscribe({
      next: me => { this.profile.set(me); this.auth.applyMe(me); },
      error: () => {
        const s = this.auth.session();
        if (s?.displayNameMode) {
          this.profile.set({
            displayNameMode: s.displayNameMode, nickname: s.nickname ?? null,
            appearOffline: s.appearOffline ?? false, presenceStatus: s.presenceStatus ?? null,
            shareAutoContext: s.shareAutoContext ?? false, shareActivity: s.shareActivity ?? false,
            viewActivityFeed: s.viewActivityFeed ?? false, nudgesOptOut: s.nudgesOptOut ?? false,
          });
        }
      },
    });
  }

  /** Pull-to-refresh: re-pull every best-effort source. */
  async refreshAll(): Promise<void> {
    this.refreshing.set(true);
    try {
      if (this.canChat()) {
        this.api.getNotificationPreferences().subscribe({ next: p => this.prefs.set(p), error: () => {} });
        this.api.myDiscord().subscribe({ next: d => this.discord.set(d), error: () => {} });
      }
      this.loadProfile();
      if (this.canLocation()) {
        this.api.locationSettings().subscribe({ next: l => this.location.set(l), error: () => {} });
      }
      if (this.isAdmin()) this.loadAdmin();
      await Promise.allSettled([this.units.load()]);
      await new Promise(r => setTimeout(r, 350));
    } finally {
      this.refreshing.set(false);
    }
  }

  // ── notification prefs ──
  setPref<K extends keyof NotificationPreferenceDto>(key: K, value: boolean): void {
    const prev = this.prefs();
    if (!prev) return;
    const next = { ...prev, [key]: value };
    this.prefs.set(next);
    this.api.updateNotificationPreferences(next).subscribe({
      next: saved => this.prefs.set(saved),
      error: () => { this.prefs.set(prev); this.fail('notification preference'); },
    });
  }

  // ── Discord ──
  private saveDiscord(patch: Partial<MyDiscord>, what: string): void {
    const prev = this.discord();
    const base: MyDiscord = prev ?? {
      configured: false, hint: null, surfaceDiscord: false,
      weeklyRecapEnabled: false, categories: { ...ALL_DISCORD_CATEGORIES },
    };
    const next: MyDiscord = { ...base, ...patch };
    this.discord.set(next);
    this.discordBusy.set(true);
    this.api.saveMyDiscord({
      webhookUrl: null, surfaceDiscord: next.surfaceDiscord,
      weeklyRecapEnabled: next.weeklyRecapEnabled, categories: next.categories,
    }).subscribe({
      next: d => { this.discord.set(d); this.discordBusy.set(false); },
      error: () => { this.discord.set(prev); this.discordBusy.set(false); this.fail(what); },
    });
  }

  surfaceDiscordChange(value: boolean): void { this.saveDiscord({ surfaceDiscord: value }, 'Discord forwarding'); }
  weeklyRecapChange(value: boolean): void { this.saveDiscord({ weeklyRecapEnabled: value }, 'the weekly recap setting'); }
  setCategory(key: keyof MyDiscordCategories, value: boolean): void {
    const cur = this.discord()?.categories ?? ALL_DISCORD_CATEGORIES;
    this.saveDiscord({ categories: { ...cur, [key]: value } }, 'a Discord category');
  }

  // ── profile / presence ──
  setProfile<K extends keyof ProfilePrefs>(key: K, value: ProfilePrefs[K]): void {
    const prev = this.profile();
    if (!prev) return;
    const next = { ...prev, [key]: value };
    this.profile.set(next);
    this.api.setProfile({ [key]: value }).subscribe({
      next: saved => { this.profile.set(saved); this.auth.applyProfilePrefs(saved); },
      error: () => { this.profile.set(prev); this.fail('your profile'); },
    });
  }

  setName(mode: string): void { this.setProfile('displayNameMode', mode as DisplayNameMode); }

  // ── location ──
  setLocation<K extends keyof LocationSettings>(key: K, value: boolean): void {
    const prev = this.location();
    if (!prev) return;
    const next = { ...prev, [key]: value };
    this.location.set(next);
    this.api.patchLocationSettings({ [key]: value }).subscribe({
      next: saved => this.location.set(saved),
      error: () => { this.location.set(prev); this.fail('your location setting'); },
    });
  }

  // ── appearance / units (services flip their own signals optimistically) ──
  setTheme(mode: string): void { this.theme.setMode(mode as ThemeMode); }

  async setUnits(system: string): Promise<void> {
    const sys = system as UnitSystem;
    if (sys === this.units.unitSystem()) return;
    const persisted = await this.units.setUnitSystem(sys);
    if (!persisted) this.toasts.show('Units updated for this session (couldn’t save to your profile).', { tone: 'warn' });
  }

  // ── home-page preference (PATCH /api/auth/home), optimistic ──
  setHome(route: string | null): void {
    const prev = this.session()?.homeRoute ?? null;
    if (prev === route) return;
    this.auth.applyHomeRoute(route);
    this.api.setHomeRoute(route).subscribe({
      next: res => this.auth.applyHomeRoute(res.homeRoute),
      error: () => { this.auth.applyHomeRoute(prev); this.fail('your home page'); },
    });
  }

  // ══════════════════ ADMIN — INGESTION SETTINGS ══════════════════
  patchSettings<K extends keyof SettingsModel>(key: K, value: SettingsModel[K]): void {
    this.settings.update(m => (m ? { ...m, [key]: value } : m));
  }

  saveSettings(): void {
    const m = this.settings();
    if (!m) return;
    this.savingSettings.set(true);
    this.api.saveSettings(m).subscribe({
      next: () => { this.savingSettings.set(false); this.toasts.show('Settings saved (local dates re-bucketed if timezone changed).', { tone: 'success' }); },
      error: () => { this.savingSettings.set(false); this.toasts.show('Save failed (check the timezone is a valid IANA id).', { tone: 'warn' }); },
    });
  }

  runSync(): void {
    this.syncing.set(true);
    this.api.sync().subscribe({
      next: r => {
        this.syncing.set(false);
        this.lastSync.set(r);
        this.now.set(Date.now());
        this.api.sources().subscribe({ next: s => this.sources.set(s), error: () => {} });
        this.api.syncStatus().subscribe({ next: st => this.status.set(st), error: () => {} });
        this.toasts.show(
          r.error ? `Sync error: ${r.error}` : `Synced +${r.newRecords.toLocaleString()} rows`,
          { tone: r.error ? 'warn' : 'success' },
        );
      },
      error: () => { this.syncing.set(false); this.toasts.show('Sync failed.', { tone: 'warn' }); },
    });
  }

  // ══════════════════ ADMIN — SOURCES ══════════════════
  setSourceEnabled(s: IngestionSource, enabled: boolean): void {
    this.sources.update(list => list.map(x => (x.id === s.id ? { ...x, enabled } : x)));
  }

  saveSource(s: IngestionSource): void {
    this.savingSourceId.set(s.id);
    this.api.updateSource(s.id, s).subscribe({
      next: () => { this.savingSourceId.set(null); this.toasts.show(`Saved source “${s.name}”.`, { tone: 'success' }); },
      error: () => { this.savingSourceId.set(null); this.toasts.show('Save failed.', { tone: 'warn' }); },
    });
  }

  // ══════════════════ ADMIN — DISCORD SYSTEM CONFIG ══════════════════
  patchNotif<K extends keyof NotificationSettings>(key: K, value: NotificationSettings[K]): void {
    this.notif.update(n => (n ? { ...n, [key]: value } : n));
  }

  private notifBody(over: Partial<NotificationUpdate> = {}): NotificationUpdate {
    const n = this.notif()!;
    return {
      enabled: n.enabled, digestHourLocal: n.digestHourLocal, weeklyDay: n.weeklyDay,
      thresholdUsd: n.thresholdUsd, mentionOnAlert: n.mentionOnAlert, ...over,
    };
  }

  saveNotif(): void {
    if (!this.notif()) return;
    this.savingNotif.set(true);
    const url = this.webhookInput().trim();
    this.api.saveNotifications(this.notifBody(url ? { discordWebhookUrl: url } : {})).subscribe({
      next: n => { this.notif.set(n); this.webhookInput.set(''); this.savingNotif.set(false); this.toasts.show('Notification settings saved.', { tone: 'success' }); },
      error: (e: HttpErrorResponse) => { this.savingNotif.set(false); this.toasts.show(e.error?.message ?? 'Save failed.', { tone: 'warn' }); },
    });
  }

  removeWebhook(): void {
    if (!this.notif()) return;
    this.savingNotif.set(true);
    this.api.saveNotifications(this.notifBody({ discordWebhookUrl: '' })).subscribe({
      next: n => { this.notif.set(n); this.savingNotif.set(false); this.toasts.show('Webhook removed.', { tone: 'success' }); },
      error: () => { this.savingNotif.set(false); this.toasts.show('Could not remove webhook.', { tone: 'warn' }); },
    });
  }

  testNotif(): void {
    this.testingNotif.set(true);
    this.api.testNotification().subscribe({
      next: r => { this.testingNotif.set(false); this.toasts.show(r.message, { tone: 'success' }); },
      error: (e: HttpErrorResponse) => { this.testingNotif.set(false); this.toasts.show(e.error?.message ?? 'Test failed.', { tone: 'warn' }); },
    });
  }

  sendSnapshot(): void {
    this.sendingSnapshot.set(true);
    this.api.sendUsageSnapshot().subscribe({
      next: r => { this.sendingSnapshot.set(false); this.toasts.show(r.message, { tone: 'success' }); },
      error: (e: HttpErrorResponse) => { this.sendingSnapshot.set(false); this.toasts.show(e.error?.message ?? 'Could not send snapshot.', { tone: 'warn' }); },
    });
  }

  // ══════════════════ ADMIN — DISCORD EVENT ROUTING ══════════════════
  toggleRoute(route: DiscordRoute, enabled: boolean): void {
    this.saveRoute(route, { enabled, mention: route.mention });
  }

  saveRouteMention(route: DiscordRoute, mention: string): void {
    const trimmed = mention.trim();
    if ((trimmed || null) === (route.mention || null)) return; // no change
    this.saveRoute(route, { enabled: route.enabled, mention: trimmed || null });
  }

  private saveRoute(route: DiscordRoute, body: { enabled: boolean; mention: string | null }): void {
    this.savingRouteKey.set(route.eventKey);
    this.api.updateDiscordRoute(route.eventKey, body).subscribe({
      next: saved => { this.routes.update(list => list.map(r => (r.eventKey === saved.eventKey ? saved : r))); this.savingRouteKey.set(null); },
      error: (e: HttpErrorResponse) => { this.savingRouteKey.set(null); this.loadRoutes(); this.toasts.show(e.error?.message ?? 'Could not update route.', { tone: 'warn' }); },
    });
  }

  private fail(what: string): void {
    this.toasts.show(`Couldn’t update ${what}.`, { tone: 'warn' });
  }
}
