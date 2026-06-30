import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { Api } from '../../core/api';
import { AuthService } from '../../core/auth';
import { ThemeService, ThemeMode } from '../../core/theme';
import { UnitService, UnitSystem } from '../../core/unit.service';
import {
  ALL_DISCORD_CATEGORIES, DISCORD_CATEGORY_META, DisplayNameMode, LocationSettings, MyDiscord,
  MyDiscordCategories, NotificationPreferenceDto, PERM, ProfilePrefs,
} from '../../core/models';

import {
  BetaPullRefresh, BetaSectionHeader, BetaSegmentedControl,
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
    RouterLink,
    BetaPullRefresh, BetaSectionHeader, BetaSegmentedControl,
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
  private auth = inject(AuthService);
  private toasts = inject(ToastController);
  readonly theme = inject(ThemeService);
  readonly units = inject(UnitService);

  readonly canChat = computed(() => this.auth.hasPermission(PERM.chatRead));
  readonly canLocation = computed(() => this.auth.hasPermission(PERM.locationSelf));

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

  private fail(what: string): void {
    this.toasts.show(`Couldn’t update ${what}.`, { tone: 'warn' });
  }
}
