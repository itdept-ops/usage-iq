import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';

import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';

import { Api } from '../../core/api';
import { AuthService } from '../../core/auth';
import {
  ALL_DISCORD_CATEGORIES, DISCORD_CATEGORY_META, DisplayNameMode, LocationSettings, MyDiscord,
  MyDiscordCategories, NotificationPreferenceDto, PERM, ProfilePrefs, Settings,
} from '../../core/models';

/** One Tier-3 link-out card: route + label + icon, shown only if the caller holds (any of) `perms`. */
interface LinkOut {
  route: string;
  label: string;
  blurb: string;
  icon: string;
  /** Any-of these grants the card (empty = always). */
  perms: readonly string[];
}

/**
 * Settings hub — a sleek, sectioned aggregator over the caller's OWN preferences, reachable by ANY
 * authenticated user (authGuard). It does NOT replace the existing dedicated pages (/profile, /settings,
 * /locations, /family) — it reuses their EXISTING Api methods and links out to the full editors. Every
 * section is permission-aware (hidden when the caller can't use it). Quick toggles save OPTIMISTICALLY:
 * the UI flips immediately and reverts with a snackbar on error.
 *
 * Sections: (A) Notifications — surfaces + triggers + per-category Discord + the personal webhook builder;
 * (B) Presence & profile; (C) Activity; (D) Location; (E) Sync & time (settings.manage only); (F) Quick
 * links. The admin /settings page remains the canonical sync/notification-routing editor — here it is just
 * a link-out card.
 */
@Component({
  selector: 'app-preferences',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule, RouterLink, MatIconModule, MatButtonModule, MatSlideToggleModule,
    MatFormFieldModule, MatInputModule, MatSelectModule, MatSnackBarModule,
  ],
  templateUrl: './preferences.html',
  styleUrl: './preferences.scss',
})
export class Preferences {
  private api = inject(Api);
  private snack = inject(MatSnackBar);
  readonly auth = inject(AuthService);

  // ---- Permission gates (each section/card hides when the caller can't use it) --------------------
  readonly canChat = computed(() => this.auth.hasPermission(PERM.chatRead));
  readonly canLocation = computed(() => this.auth.hasPermission(PERM.locationSelf));
  readonly canManageSync = computed(() => this.auth.hasPermission(PERM.settingsManage));

  // ---- (A) Notifications: in-app prefs (surfaces + triggers) --------------------------------------
  /** The caller's notification delivery prefs; null until loaded (and only loaded when canChat). */
  readonly prefs = signal<NotificationPreferenceDto | null>(null);

  // ---- (A) Notifications: per-user Discord forwarding + per-category toggles + builder ------------
  readonly discord = signal<MyDiscord | null>(null);
  readonly webhookInput = signal('');
  readonly discordBusy = signal(false);
  readonly discordTesting = signal(false);
  readonly recapSending = signal(false);
  readonly categoryMeta = DISCORD_CATEGORY_META;

  // ---- (B) Presence & profile ---------------------------------------------------------------------
  readonly profile = signal<ProfilePrefs | null>(null);
  readonly nameModes: readonly { value: DisplayNameMode; label: string }[] = [
    { value: 'full', label: 'Full name' },
    { value: 'firstName', label: 'First name only' },
    { value: 'firstInitial', label: 'First name + last initial' },
    { value: 'nickname', label: 'Nickname' },
  ];

  // ---- (D) Location -------------------------------------------------------------------------------
  readonly location = signal<LocationSettings | null>(null);

  // ---- (E) Sync & time ----------------------------------------------------------------------------
  readonly sync = signal<Settings | null>(null);
  private readonly commonZones = [
    'America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles',
    'America/Anchorage', 'Pacific/Honolulu', 'UTC', 'Europe/London', 'Europe/Berlin', 'Europe/Madrid',
    'Asia/Kolkata', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney',
  ];
  /** Zone options, prepending the saved one when it's outside the common list (so it stays selectable). */
  readonly zones = computed(() => {
    const cur = this.sync()?.displayTimeZone;
    return cur && !this.commonZones.includes(cur) ? [cur, ...this.commonZones] : this.commonZones;
  });

  // ---- (F) Quick links (Tier-3 link-outs to the existing full pages) ------------------------------
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
    return Preferences.linkDefs.filter(l => l.perms.length === 0 || this.auth.hasAnyPermission(...l.perms));
  });

  constructor() {
    this.load();
  }

  private load(): void {
    if (this.canChat()) {
      this.api.getNotificationPreferences().subscribe({
        next: p => this.prefs.set(p),
        error: () => { /* leave null — section shows a load hint */ },
      });
      this.api.myDiscord().subscribe({
        next: d => this.discord.set(d),
        error: () => { /* leave null — renders as "not configured" */ },
      });
    }
    // Presence & profile is reachable by everyone (no gate) — mirror /me.
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
    if (this.canLocation()) {
      this.api.locationSettings().subscribe({
        next: l => this.location.set(l),
        error: () => { /* leave null */ },
      });
    }
    if (this.canManageSync()) {
      this.api.settings().subscribe({
        next: s => this.sync.set(s),
        error: () => { /* leave null */ },
      });
    }
  }

  // =================================================================================================
  // (A) Notifications — surfaces + triggers (PUT /api/inbox/preferences), optimistic.
  // =================================================================================================

  /** Flip one in-app notification pref optimistically; revert + snackbar on error. */
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

  // =================================================================================================
  // (A) Notifications — per-user Discord (master surface, weekly recap, per-category, builder).
  // The webhook URL is NEVER returned: we only know { configured, hint, surfaceDiscord, recap, categories }.
  // =================================================================================================

  /** Persist a Discord field set onto a fresh optimistic copy; revert + snackbar on error. */
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
      webhookUrl: null,
      surfaceDiscord: next.surfaceDiscord,
      weeklyRecapEnabled: next.weeklyRecapEnabled,
      categories: next.categories,
    }).subscribe({
      next: d => { this.discord.set(d); this.discordBusy.set(false); },
      error: () => { this.discord.set(prev); this.discordBusy.set(false); this.fail(what); },
    });
  }

  surfaceDiscordChange(value: boolean): void {
    this.saveDiscord({ surfaceDiscord: value }, 'Discord forwarding');
  }

  weeklyRecapChange(value: boolean): void {
    this.saveDiscord({ weeklyRecapEnabled: value }, 'the weekly recap setting');
  }

  /** Flip one per-category forward toggle (independent of the in-app trigger gates). */
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
        this.snack.open('Discord webhook saved', 'OK', { duration: 2500 });
      },
      error: (e: HttpErrorResponse) => {
        this.discordBusy.set(false);
        const msg = e.status === 400
          ? (e.error?.message ?? 'That does not look like a Discord webhook URL.')
          : 'Could not save your Discord webhook.';
        this.snack.open(msg, 'Dismiss', { duration: 5000 });
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
        this.snack.open('Discord webhook removed', 'OK', { duration: 2500 });
      },
      error: () => { this.discordBusy.set(false); this.fail('your Discord webhook'); },
    });
  }

  /** Send a test message to the saved webhook. 404 = none saved · 502 = Discord rejected. */
  testWebhook(): void {
    if (this.discordTesting()) return;
    this.discordTesting.set(true);
    this.api.testMyDiscord().subscribe({
      next: r => { this.discordTesting.set(false); this.snack.open(r.message ?? 'Test sent', 'OK', { duration: 4000 }); },
      error: (e: HttpErrorResponse) => {
        this.discordTesting.set(false);
        const fallback = e.status === 404
          ? 'Save a webhook first, then send a test.'
          : e.status === 502 ? 'Discord rejected the test message.' : 'Could not send the test.';
        this.snack.open(e.error?.message ?? fallback, 'Dismiss', { duration: 5000 });
      },
    });
  }

  /** Send this week's recap to the saved webhook right now. 404 = none saved · 502 = rejected. */
  sendRecapNow(): void {
    if (this.recapSending()) return;
    this.recapSending.set(true);
    this.api.sendMyDiscordRecap().subscribe({
      next: r => { this.recapSending.set(false); this.snack.open(r.message ?? 'Recap sent', 'OK', { duration: 4000 }); },
      error: (e: HttpErrorResponse) => {
        this.recapSending.set(false);
        const fallback = e.status === 404
          ? 'Save a webhook first, then send your recap.'
          : e.status === 502 ? 'Discord rejected the recap.' : 'Could not send the recap.';
        this.snack.open(e.error?.message ?? fallback, 'Dismiss', { duration: 5000 });
      },
    });
  }

  // =================================================================================================
  // (B) Presence & profile — PATCH /api/auth/profile, optimistic.
  // =================================================================================================

  /** Flip/set one profile pref optimistically; revert + snackbar on error; mirror into the session. */
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

  /** Commit a free-text field (nickname/status) on blur — trims; '' clears it server-side. */
  commitText(key: 'nickname' | 'presenceStatus', value: string): void {
    this.setProfile(key, value.trim() as ProfilePrefs[typeof key]);
  }

  // =================================================================================================
  // (D) Location — PATCH /api/location/settings, optimistic.
  // =================================================================================================

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

  // =================================================================================================
  // (E) Sync & time — PUT /api/settings (settings.manage), optimistic.
  // =================================================================================================

  setSync<K extends keyof Settings>(key: K, value: Settings[K]): void {
    const prev = this.sync();
    if (!prev) return;
    const next = { ...prev, [key]: value };
    this.sync.set(next);
    this.api.saveSettings(next).subscribe({
      error: () => { this.sync.set(prev); this.fail('your sync settings'); },
    });
  }

  private fail(what: string): void {
    this.snack.open(`Could not update ${what}.`, 'Dismiss', { duration: 4000 });
  }
}
