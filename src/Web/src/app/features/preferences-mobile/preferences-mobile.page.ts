import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';

import { Api } from '../../core/api';
import { AuthService } from '../../core/auth';
import { ThemeService, ThemeMode } from '../../core/theme';
import { UnitService, UnitSystem } from '../../core/unit.service';
import { PushNotifications } from '../../core/push-notifications';
import { SwUpdateService, OFFLINE_DISABLED_KEY } from '../../core/sw-update';
import {
  ALL_DISCORD_CATEGORIES, DISCORD_CATEGORY_META, DisplayNameMode, LocationSettings, MyDiscord,
  MyDiscordCategories, NotificationPreferenceDto, PERM, ProfilePrefs, Settings,
} from '../../core/models';
import { HomeOption, HOME_OPTIONS } from '../../core/home-options';

import {
  BetaPullRefresh, BetaSectionHeader, BetaSegmentedControl, BetaBottomSheet, BetaToaster,
  BetaErrorState,
  ToastController, Segment,
} from '../beta-ui';
import { BetaToggleRow } from '../beta-settings/beta-toggle-row';

/** One Tier-3 link-out card: route + label + icon, shown only if the caller holds (any of) `perms`. */
interface LinkOut {
  route: string;
  label: string;
  blurb: string;
  icon: string;
  perms: readonly string[];
}

/**
 * Preferences (mobile twin) — the FULL settings hub from the live `/preferences` page, re-presented for the
 * phone on the shared beta-ui "Strata" foundation (`@use '../beta-ui/beta-kit'`) with a SLATE / steel-blue
 * signature accent (matching the live beta-settings twin). On a phone with the platform.mobile grant the
 * canonical `/preferences` URL renders THIS component; on desktop it renders the existing `Preferences`
 * page. It reuses the EXACT same per-domain Api methods + DTOs as the live page — never a new data path.
 *
 * Unlike the slim {@link BetaSettingsPage} (which deliberately punts the webhook builder + admin Sync to
 * the full hub), this twin covers EVERY section the live `/preferences` page exposes:
 *   (A) Notifications — surfaces + triggers (inbox prefs) + per-category Discord + the personal webhook
 *       BUILDER (save / test / send-recap / clear, in a bottom sheet);
 *   (B) Identity & presence (display-name mode + presence toggles);
 *   (C) Activity (share / view feed);
 *   (D) Location (capture + household share);
 *   (E) Sync & time (settings.manage — timezone, auto-sync, interval, projects path);
 *   (F) Display (theme + units) + Home-page picker;
 *   (G) Offline / installable mode (service-worker killswitch);
 *   (H) Quick links to the full editors.
 *
 * Every quick toggle saves OPTIMISTICALLY (flip immediately, revert + toast on error). ISOLATED + gated by
 * platform.mobile (route guard): imports only the kit + the shared Api/models/services the live page already
 * uses; touches no live page; adds no npm deps.
 */
@Component({
  selector: 'app-preferences-mobile',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [ToastController],
  styleUrl: './preferences-mobile.page.scss',
  imports: [
    FormsModule, RouterLink,
    BetaPullRefresh, BetaSectionHeader, BetaSegmentedControl, BetaBottomSheet, BetaToaster,
    BetaErrorState, BetaToggleRow,
  ],
  template: `
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
              <span class="hh__eyebrow">Settings</span>
              <h1 class="hh__name">{{ displayName() }}</h1>
              <span class="hh__line">{{ identityLine() }}</span>
            </div>
          </div>
        </header>

        <!-- ───────────── DISPLAY (appearance + units — always available) ───────────── -->
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
                      role="radio" [attr.aria-checked]="homeChoice() === 'auto'" (click)="setHome(null)">
                <span class="home-ic" aria-hidden="true">✧</span>
                <span class="home-text">
                  <span class="home-title">Smart default</span>
                  <span class="home-sub">First page you can open</span>
                </span>
                @if (homeChoice() === 'auto') { <span class="home-check" aria-hidden="true">✓</span> }
              </button>
              @for (h of homeOptions(); track h.route) {
                <button type="button" class="home-row" [class.is-active]="homeChoice() === h.route"
                        role="radio" [attr.aria-checked]="homeChoice() === h.route" (click)="setHome(h.route)">
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
                                       [checked]="p[t.key]"
                                       (toggle)="t.key === 'surfaceBrowser' ? setBrowserSurface($event) : setPref(t.key, $event)" />
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
              <app-bs-error compact icon="notifications_off"
                            title="Couldn't load notifications"
                            body="Pull down to retry."
                            ctaLabel="Retry" (retry)="refreshNotifications()" />
            }
          </section>

          @if (discord(); as d) {
            <section class="rise" [style.--i]="3">
              <app-bs-section-header title="Forward to Discord" subtitle="Mirror alerts to your server" icon="forum" />
              <div class="card card--list">
                <app-beta-toggle-row title="Mirror to Discord" subtitle="Send a copy to your webhook"
                                     icon="ios_share" [checked]="d.surfaceDiscord" [busy]="discordBusy()"
                                     (toggle)="surfaceDiscordChange($event)" />
                <div class="subgroup" [class.subgroup--off]="!d.surfaceDiscord">
                  @for (c of categoryMeta; track c.key) {
                    <app-beta-toggle-row class="sub-row" [title]="c.label"
                                         [checked]="d.categories?.[c.key] ?? false"
                                         [disabled]="!d.surfaceDiscord" [busy]="discordBusy()"
                                         (toggle)="setCategory(c.key, $event)" />
                  }
                </div>
                <app-beta-toggle-row title="Weekly recap" subtitle="A Sunday summary digest"
                                     icon="event_repeat" [checked]="d.weeklyRecapEnabled" [busy]="discordBusy()"
                                     (toggle)="weeklyRecapChange($event)" />
              </div>

              <!-- The personal WEBHOOK BUILDER — status row + a button that opens the editor sheet. -->
              <button type="button" class="link-row" (click)="webhookSheet.set(true)">
                <span class="link-ic" aria-hidden="true">🔗</span>
                <span class="link-text">
                  <span class="link-title">{{ d.configured ? 'Discord webhook' : 'Connect a webhook' }}</span>
                  <span class="link-sub">{{ d.configured ? (d.hint ?? 'Configured') : 'Not configured yet' }}</span>
                </span>
                <span class="link-chev" aria-hidden="true">›</span>
              </button>
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
              @if (pf.displayNameMode === 'nickname') {
                <input class="field" type="text" placeholder="Your nickname"
                       [value]="pf.nickname ?? ''" (change)="commitText('nickname', $any($event.target).value)"
                       aria-label="Nickname" />
              }
              <input class="field" type="text" placeholder="Set a short status…"
                     [value]="pf.presenceStatus ?? ''" (change)="commitText('presenceStatus', $any($event.target).value)"
                     aria-label="Presence status" />
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

        <!-- ───────────── SYNC & TIME (settings.manage) ───────────── -->
        @if (canManageSync() && sync(); as s) {
          <section class="rise" [style.--i]="7">
            <app-bs-section-header title="Sync & time" subtitle="Ingestion + display timezone" icon="sync" />
            <div class="card card--list">
              <app-beta-toggle-row title="Auto-sync" subtitle="Re-ingest on a schedule"
                                   icon="autorenew" [checked]="s.autoSyncEnabled"
                                   (toggle)="setSync('autoSyncEnabled', $event)" />
            </div>
            <div class="card card--pad">
              <label class="qf">
                <span class="qf-label">Display timezone</span>
                <select class="field field--select" [value]="s.displayTimeZone"
                        (change)="setSync('displayTimeZone', $any($event.target).value)"
                        aria-label="Display timezone">
                  @for (z of zones(); track z) { <option [value]="z">{{ z }}</option> }
                </select>
              </label>
              <div class="qs-div" aria-hidden="true"></div>
              <label class="qf">
                <span class="qf-label">Auto-sync interval (seconds)</span>
                <input class="field" type="number" min="30" step="10" [value]="s.autoSyncIntervalSeconds"
                       [disabled]="!s.autoSyncEnabled"
                       (change)="setSync('autoSyncIntervalSeconds', +$any($event.target).value)"
                       aria-label="Auto-sync interval in seconds" />
              </label>
              <div class="qs-div" aria-hidden="true"></div>
              <label class="qf">
                <span class="qf-label">Claude projects path</span>
                <input class="field" type="text" placeholder="~/.claude/projects" [value]="s.claudeProjectsPath"
                       (change)="setSync('claudeProjectsPath', $any($event.target).value)"
                       aria-label="Claude projects path" />
              </label>
            </div>
          </section>
        }

        <!-- ───────────── OFFLINE / INSTALLABLE MODE ───────────── -->
        @if (swSupported) {
          <section class="rise" [style.--i]="8">
            <app-bs-section-header title="Offline mode" subtitle="Installable + instantly available" icon="offline_bolt" />
            <div class="card card--list">
              <app-beta-toggle-row title="Offline & installable" subtitle="Cache the app shell; live data stays online"
                                   icon="cloud_off" [checked]="offlineEnabled()"
                                   (toggle)="setOfflineEnabled($event)" />
            </div>
            <p class="hint">Turning this off makes the app run online-only. Re-enabling takes effect after a reload.</p>
          </section>
        }

        <!-- ───────────── QUICK LINKS (Tier-3 link-outs to the full editors) ───────────── -->
        @if (links().length) {
          <section class="rise" [style.--i]="9">
            <app-bs-section-header title="More settings" subtitle="The full editors" icon="open_in_new" />
            <div class="card card--list">
              @for (l of links(); track l.route) {
                <a class="link-row" [routerLink]="l.route">
                  <span class="link-ic link-ic--sym material-symbols-outlined" aria-hidden="true">{{ l.icon }}</span>
                  <span class="link-text">
                    <span class="link-title">{{ l.label }}</span>
                    <span class="link-sub">{{ l.blurb }}</span>
                  </span>
                  <span class="link-chev" aria-hidden="true">›</span>
                </a>
              }
            </div>
          </section>
        }

        <p class="foot">Changes save automatically.</p>
        <div class="scroll__foot" aria-hidden="true"></div>
      </div>
    </app-bs-pull-refresh>

    <!-- WEBHOOK BUILDER SHEET — save / test / send-recap / clear the personal Discord webhook. -->
    <app-bs-sheet [(open)]="webhookSheet" detent="half" label="Discord webhook">
      <div class="sheet">
        <h2 class="sheet-title">Discord webhook</h2>
        <p class="sheet-sub">
          Paste your server's webhook URL to mirror alerts to Discord. The URL is encrypted server-side and
          never shown back.
        </p>
        @if (discord(); as d) {
          @if (d.configured) {
            <p class="sheet-status">Currently connected{{ d.hint ? ' · ' + d.hint : '' }}.</p>
          }
        }
        <input class="field" type="url" placeholder="https://discord.com/api/webhooks/…"
               [ngModel]="webhookInput()" (ngModelChange)="webhookInput.set($event)"
               autocomplete="off" aria-label="Discord webhook URL" />
        <div class="sheet-actions">
          <button type="button" class="btn btn--primary" [disabled]="discordBusy() || !webhookInput().trim()"
                  (click)="saveWebhook()">Save</button>
          <button type="button" class="btn" [disabled]="discordTesting()" (click)="testWebhook()">
            {{ discordTesting() ? 'Sending…' : 'Test' }}
          </button>
          <button type="button" class="btn" [disabled]="recapSending()" (click)="sendRecapNow()">
            {{ recapSending() ? 'Sending…' : 'Send recap' }}
          </button>
        </div>
        @if (discord()?.configured) {
          <button type="button" class="btn btn--danger" [disabled]="discordBusy()" (click)="clearWebhook()">
            Remove webhook
          </button>
        }
      </div>
    </app-bs-sheet>

    <app-bs-toaster />
  `,
})
export class PreferencesMobilePage {
  private api = inject(Api);
  private auth = inject(AuthService);
  private toasts = inject(ToastController);
  private push = inject(PushNotifications);
  private sw = inject(SwUpdateService);
  readonly theme = inject(ThemeService);
  readonly units = inject(UnitService);

  // ── permission gates ──
  readonly canChat = computed(() => this.auth.hasPermission(PERM.chatRead));
  readonly canLocation = computed(() => this.auth.hasPermission(PERM.locationSelf));
  readonly canManageSync = computed(() => this.auth.hasPermission(PERM.settingsManage));

  // ── data ──
  readonly prefs = signal<NotificationPreferenceDto | null>(null);
  readonly discord = signal<MyDiscord | null>(null);
  readonly profile = signal<ProfilePrefs | null>(null);
  readonly location = signal<LocationSettings | null>(null);
  readonly sync = signal<Settings | null>(null);
  readonly refreshing = signal(false);

  // ── Discord builder state ──
  readonly webhookSheet = signal(false);
  readonly webhookInput = signal('');
  readonly discordBusy = signal(false);
  readonly discordTesting = signal(false);
  readonly recapSending = signal(false);

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

  // ── sync timezone options (prepend the saved one when outside the common list) ──
  private readonly commonZones = [
    'America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles',
    'America/Anchorage', 'Pacific/Honolulu', 'UTC', 'Europe/London', 'Europe/Berlin', 'Europe/Madrid',
    'Asia/Kolkata', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney',
  ];
  readonly zones = computed(() => {
    const cur = this.sync()?.displayTimeZone;
    return cur && !this.commonZones.includes(cur) ? [cur, ...this.commonZones] : this.commonZones;
  });

  // ── quick links ──
  private static readonly linkDefs: readonly LinkOut[] = [
    { route: '/profile', label: 'How others see me', blurb: 'Identity + presence, the full editor', icon: 'badge', perms: [] },
    { route: '/locations', label: 'My locations', blurb: 'Your private location history map', icon: 'place', perms: [PERM.locationSelf] },
    { route: '/automations', label: 'Automations', blurb: 'Your own event → channel rules', icon: 'bolt', perms: [PERM.automationsUse] },
    { route: '/family/settings', label: 'Family settings', blurb: 'Household-wide preferences', icon: 'cottage', perms: [PERM.familyUse] },
    { route: '/settings', label: 'Admin settings', blurb: 'Sync, pricing, Discord routing', icon: 'tune', perms: [PERM.settingsView] },
    { route: '/users', label: 'Users', blurb: 'Manage accounts + access', icon: 'group', perms: [PERM.usersView] },
  ];
  readonly links = computed<LinkOut[]>(() => {
    this.auth.permissions(); // re-run on permission change
    return PreferencesMobilePage.linkDefs.filter(l => l.perms.length === 0 || this.auth.hasAnyPermission(...l.perms));
  });

  // ── home-page picker (shared HOME_OPTIONS, matching the profile dropdown) ──
  readonly homeOptions = computed<HomeOption[]>(() => {
    this.auth.permissions();
    return HOME_OPTIONS.filter(h => this.auth.hasAnyPermission(...h.perms));
  });
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
    this.loadAll();
    void this.units.load();
  }

  private loadAll(): void {
    if (this.canChat()) {
      this.api.getNotificationPreferences().subscribe({ next: p => this.prefs.set(p), error: () => {} });
      this.api.myDiscord().subscribe({ next: d => this.discord.set(d), error: () => {} });
    }
    this.loadProfile();
    if (this.canLocation()) {
      this.api.locationSettings().subscribe({ next: l => this.location.set(l), error: () => {} });
    }
    if (this.canManageSync()) {
      this.api.settings().subscribe({ next: s => this.sync.set(s), error: () => {} });
    }
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

  refreshNotifications(): void {
    if (!this.canChat()) return;
    this.api.getNotificationPreferences().subscribe({ next: p => this.prefs.set(p), error: () => {} });
    this.api.myDiscord().subscribe({ next: d => this.discord.set(d), error: () => {} });
  }

  async refreshAll(): Promise<void> {
    this.refreshing.set(true);
    try {
      this.loadAll();
      await Promise.allSettled([this.units.load()]);
      await new Promise(r => setTimeout(r, 350));
    } finally {
      this.refreshing.set(false);
    }
  }

  // ── (A) notification prefs ──
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

  /** Browser-notifications surface: save the pref, then bridge to web push (request perm + subscribe/unsub). */
  async setBrowserSurface(value: boolean): Promise<void> {
    this.setPref('surfaceBrowser', value);
    if (value && typeof Notification !== 'undefined' && Notification.permission === 'default') {
      try { await Notification.requestPermission(); } catch { /* harmless reject in some browsers */ }
    }
    if (value && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      void this.push.subscribe();
    } else if (!value) {
      void this.push.unsubscribe();
    }
  }

  // ── (A) Discord ──
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

  /** Save the typed webhook URL (validated + encrypted server-side). 400 on a non-Discord URL. */
  saveWebhook(): void {
    const url = this.webhookInput().trim();
    if (!url || this.discordBusy()) return;
    const d = this.discord();
    this.discordBusy.set(true);
    this.api.saveMyDiscord({
      webhookUrl: url,
      surfaceDiscord: d?.surfaceDiscord ?? true,
      weeklyRecapEnabled: d?.weeklyRecapEnabled ?? false,
      categories: d?.categories ?? { ...ALL_DISCORD_CATEGORIES },
    }).subscribe({
      next: saved => {
        this.discord.set(saved); this.webhookInput.set(''); this.discordBusy.set(false);
        this.webhookSheet.set(false);
        this.toasts.show('Discord webhook saved.', { tone: 'success' });
      },
      error: (e: HttpErrorResponse) => {
        this.discordBusy.set(false);
        const msg = e.status === 400
          ? (e.error?.message ?? 'That does not look like a Discord webhook URL.')
          : 'Could not save your Discord webhook.';
        this.toasts.show(msg, { tone: 'warn' });
      },
    });
  }

  /** Clear the stored webhook ("" = clear); leaves the toggles as-is. */
  clearWebhook(): void {
    if (this.discordBusy()) return;
    const d = this.discord();
    this.discordBusy.set(true);
    this.api.saveMyDiscord({
      webhookUrl: '',
      surfaceDiscord: d?.surfaceDiscord ?? false,
      weeklyRecapEnabled: d?.weeklyRecapEnabled ?? false,
      categories: d?.categories ?? { ...ALL_DISCORD_CATEGORIES },
    }).subscribe({
      next: saved => {
        this.discord.set(saved); this.webhookInput.set(''); this.discordBusy.set(false);
        this.webhookSheet.set(false);
        this.toasts.show('Discord webhook removed.', { tone: 'success' });
      },
      error: () => { this.discordBusy.set(false); this.fail('your Discord webhook'); },
    });
  }

  /** Send a test message to the saved webhook. 404 = none saved · 502 = Discord rejected. */
  testWebhook(): void {
    if (this.discordTesting()) return;
    this.discordTesting.set(true);
    this.api.testMyDiscord().subscribe({
      next: r => { this.discordTesting.set(false); this.toasts.show(r.message ?? 'Test sent.', { tone: 'success' }); },
      error: (e: HttpErrorResponse) => {
        this.discordTesting.set(false);
        const fallback = e.status === 404
          ? 'Save a webhook first, then send a test.'
          : e.status === 502 ? 'Discord rejected the test message.' : 'Could not send the test.';
        this.toasts.show(e.error?.message ?? fallback, { tone: 'warn' });
      },
    });
  }

  /** Send this week's recap to the saved webhook right now. 404 = none saved · 502 = rejected. */
  sendRecapNow(): void {
    if (this.recapSending()) return;
    this.recapSending.set(true);
    this.api.sendMyDiscordRecap().subscribe({
      next: r => { this.recapSending.set(false); this.toasts.show(r.message ?? 'Recap sent.', { tone: 'success' }); },
      error: (e: HttpErrorResponse) => {
        this.recapSending.set(false);
        const fallback = e.status === 404
          ? 'Save a webhook first, then send your recap.'
          : e.status === 502 ? 'Discord rejected the recap.' : 'Could not send the recap.';
        this.toasts.show(e.error?.message ?? fallback, { tone: 'warn' });
      },
    });
  }

  // ── (B) profile / presence ──
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

  /** Commit a free-text field (nickname/status) on change — trims; '' clears it server-side. */
  commitText(key: 'nickname' | 'presenceStatus', value: string): void {
    this.setProfile(key, value.trim() as ProfilePrefs[typeof key]);
  }

  // ── (D) location ──
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

  // ── (E) sync & time ──
  setSync<K extends keyof Settings>(key: K, value: Settings[K]): void {
    const prev = this.sync();
    if (!prev) return;
    const next = { ...prev, [key]: value };
    this.sync.set(next);
    this.api.saveSettings(next).subscribe({
      error: () => { this.sync.set(prev); this.fail('your sync settings'); },
    });
  }

  // ── (F) appearance / units / home ──
  setTheme(mode: string): void { this.theme.setMode(mode as ThemeMode); }

  async setUnits(system: string): Promise<void> {
    const sys = system as UnitSystem;
    if (sys === this.units.unitSystem()) return;
    const persisted = await this.units.setUnitSystem(sys);
    if (!persisted) this.toasts.show('Units updated for this session (couldn’t save to your profile).', { tone: 'warn' });
  }

  setHome(route: string | null): void {
    const prev = this.session()?.homeRoute ?? null;
    if (prev === route) return;
    this.auth.applyHomeRoute(route);
    this.api.setHomeRoute(route).subscribe({
      next: res => this.auth.applyHomeRoute(res.homeRoute),
      error: () => { this.auth.applyHomeRoute(prev); this.fail('your home page'); },
    });
  }

  // ── (G) offline / installable mode ──
  readonly swSupported = typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
  readonly offlineEnabled = signal<boolean>(this.readOfflineEnabled());

  private readOfflineEnabled(): boolean {
    try { return localStorage.getItem(OFFLINE_DISABLED_KEY) !== 'true'; } catch { return true; }
  }

  async setOfflineEnabled(value: boolean): Promise<void> {
    this.offlineEnabled.set(value);
    try {
      if (value) {
        localStorage.removeItem(OFFLINE_DISABLED_KEY);
        this.toasts.show('Offline mode will turn on after you reload.', {
          tone: 'neutral', actionLabel: 'Reload', onAction: () => document.location.reload(),
        });
      } else {
        localStorage.setItem(OFFLINE_DISABLED_KEY, 'true');
        await this.sw.disable();
        void this.push.unsubscribe();
        this.toasts.show('Offline mode disabled. The app now runs online-only.', { tone: 'neutral' });
      }
    } catch {
      this.offlineEnabled.set(!value);
      this.fail('offline mode');
    }
  }

  private fail(what: string): void {
    this.toasts.show(`Couldn’t update ${what}.`, { tone: 'warn' });
  }
}
