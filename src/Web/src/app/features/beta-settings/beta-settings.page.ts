import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';

import { Api } from '../../core/api';
import { AuthService } from '../../core/auth';
import {
  ALL_DISCORD_CATEGORIES, DISCORD_CATEGORY_META, LocationSettings, MyDiscord, MyDiscordCategories,
  NotificationPreferenceDto, PERM, ProfilePrefs,
} from '../../core/models';

/**
 * Settings (beta) — a sleek, mobile-first likeness of the live Settings hub's QUICK TOGGLES. It reuses the
 * EXACT same per-user Api methods (inbox-preferences, my-discord, profile, location) and the same
 * permission gates, but in a phone-shaped single-column layout with isolated `--bset-*` tokens (it does
 * not depend on the app's `--tech-*` design system, and imports no live page — fully ISOLATED).
 *
 * Scope: the quick toggles only — surfaces + triggers + per-category Discord + presence + activity +
 * location. The webhook BUILDER and the admin Sync section live on the full /preferences hub. Every toggle
 * saves OPTIMISTICALLY (flip immediately, revert + snackbar on error). Gated by beta.access (route guard).
 */
@Component({
  selector: 'app-beta-settings',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MatSlideToggleModule, MatSnackBarModule],
  template: `
    <div class="bset">
      <header class="bset__top">
        <h1 class="bset__title">Settings</h1>
        <span class="bset__tag">beta</span>
      </header>
      <p class="bset__note">Quick toggles. Changes save automatically.</p>

      @if (canChat()) {
        <section class="bset__sec">
          <h2 class="bset__h2">Notifications</h2>
          @if (prefs(); as p) {
            <div class="bset__list">
              @for (t of surfaceItems; track t.key) {
                <label class="bset__row">
                  <span class="bset__rtext">{{ t.label }}</span>
                  <mat-slide-toggle [ngModel]="p[t.key]" (ngModelChange)="setPref(t.key, $event)"
                                    [attr.aria-label]="t.label" />
                </label>
              }
              @for (t of triggerItems; track t.key) {
                <label class="bset__row">
                  <span class="bset__rtext">{{ t.label }}</span>
                  <mat-slide-toggle [ngModel]="p[t.key]" (ngModelChange)="setPref(t.key, $event)"
                                    [attr.aria-label]="t.label" />
                </label>
              }
            </div>
          } @else {
            <p class="bset__empty">Couldn't load notifications.</p>
          }
        </section>

        @if (discord(); as d) {
          <section class="bset__sec">
            <h2 class="bset__h2">Forward to Discord</h2>
            <div class="bset__list">
              <label class="bset__row">
                <span class="bset__rtext">Mirror to Discord</span>
                <mat-slide-toggle [ngModel]="d.surfaceDiscord" (ngModelChange)="surfaceDiscordChange($event)"
                                  [disabled]="discordBusy()" aria-label="Mirror to Discord" />
              </label>
              <div class="bset__sub" [class.bset__sub--off]="!d.surfaceDiscord">
                @for (c of categoryMeta; track c.key) {
                  <label class="bset__row bset__row--sub">
                    <span class="bset__rtext">{{ c.label }}</span>
                    <mat-slide-toggle [ngModel]="d.categories[c.key]" (ngModelChange)="setCategory(c.key, $event)"
                                      [disabled]="discordBusy() || !d.surfaceDiscord"
                                      [attr.aria-label]="c.label" />
                  </label>
                }
              </div>
              <label class="bset__row">
                <span class="bset__rtext">Weekly recap</span>
                <mat-slide-toggle [ngModel]="d.weeklyRecapEnabled" (ngModelChange)="weeklyRecapChange($event)"
                                  [disabled]="discordBusy()" aria-label="Weekly recap" />
              </label>
            </div>
            @if (!d.configured) {
              <p class="bset__empty">Add a webhook on the full Settings page to start forwarding.</p>
            }
          </section>
        }
      }

      @if (profile(); as pf) {
        <section class="bset__sec">
          <h2 class="bset__h2">Presence</h2>
          <div class="bset__list">
            <label class="bset__row">
              <span class="bset__rtext">Appear offline</span>
              <mat-slide-toggle [ngModel]="pf.appearOffline" (ngModelChange)="setProfile('appearOffline', $event)"
                                aria-label="Appear offline" />
            </label>
            <label class="bset__row">
              <span class="bset__rtext">Share auto context</span>
              <mat-slide-toggle [ngModel]="pf.shareAutoContext" (ngModelChange)="setProfile('shareAutoContext', $event)"
                                aria-label="Share auto context" />
            </label>
            <label class="bset__row">
              <span class="bset__rtext">Allow nudges</span>
              <mat-slide-toggle [ngModel]="!pf.nudgesOptOut" (ngModelChange)="setProfile('nudgesOptOut', !$event)"
                                aria-label="Allow nudges" />
            </label>
          </div>
        </section>

        <section class="bset__sec">
          <h2 class="bset__h2">Activity</h2>
          <div class="bset__list">
            <label class="bset__row">
              <span class="bset__rtext">Share my activity</span>
              <mat-slide-toggle [ngModel]="pf.shareActivity" (ngModelChange)="setProfile('shareActivity', $event)"
                                aria-label="Share my activity" />
            </label>
            <label class="bset__row">
              <span class="bset__rtext">View the circle feed</span>
              <mat-slide-toggle [ngModel]="pf.viewActivityFeed" (ngModelChange)="setProfile('viewActivityFeed', $event)"
                                aria-label="View the circle feed" />
            </label>
          </div>
        </section>
      }

      @if (canLocation() && location(); as loc) {
        <section class="bset__sec">
          <h2 class="bset__h2">Location</h2>
          <div class="bset__list">
            <label class="bset__row">
              <span class="bset__rtext">Enable capture</span>
              <mat-slide-toggle [ngModel]="loc.locationEnabled" (ngModelChange)="setLocation('locationEnabled', $event)"
                                aria-label="Enable location capture" />
            </label>
            <label class="bset__row">
              <span class="bset__rtext">Share with household</span>
              <mat-slide-toggle [ngModel]="loc.shareHousehold" (ngModelChange)="setLocation('shareHousehold', $event)"
                                [disabled]="!loc.locationEnabled" aria-label="Share with household" />
            </label>
          </div>
        </section>
      }
    </div>
  `,
  styleUrl: './beta-settings.page.scss',
})
export class BetaSettingsPage {
  private api = inject(Api);
  private snack = inject(MatSnackBar);
  private auth = inject(AuthService);

  readonly canChat = computed(() => this.auth.hasPermission(PERM.chatRead));
  readonly canLocation = computed(() => this.auth.hasPermission(PERM.locationSelf));

  readonly prefs = signal<NotificationPreferenceDto | null>(null);
  readonly discord = signal<MyDiscord | null>(null);
  readonly discordBusy = signal(false);
  readonly profile = signal<ProfilePrefs | null>(null);
  readonly location = signal<LocationSettings | null>(null);

  readonly categoryMeta = DISCORD_CATEGORY_META;
  readonly surfaceItems: readonly { key: keyof NotificationPreferenceDto; label: string }[] = [
    { key: 'surfaceToasts', label: 'In-app toasts' },
    { key: 'surfaceBrowser', label: 'Browser notifications' },
  ];
  readonly triggerItems: readonly { key: keyof NotificationPreferenceDto; label: string }[] = [
    { key: 'notifyDirectMessages', label: 'Direct messages' },
    { key: 'notifyMentions', label: 'Mentions' },
    { key: 'notifyChannelMessages', label: 'Channel messages' },
    { key: 'notifySystemEvents', label: 'System events' },
  ];

  constructor() {
    if (this.canChat()) {
      this.api.getNotificationPreferences().subscribe({ next: p => this.prefs.set(p), error: () => {} });
      this.api.myDiscord().subscribe({ next: d => this.discord.set(d), error: () => {} });
    }
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
      this.api.locationSettings().subscribe({ next: l => this.location.set(l), error: () => {} });
    }
  }

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

  private fail(what: string): void {
    this.snack.open(`Could not update ${what}.`, 'Dismiss', { duration: 4000 });
  }
}
