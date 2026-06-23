import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';

import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';

import { Api } from '../../core/api';
import { ChatRealtime } from '../../core/chat-realtime';
import { ALL_DISCORD_CATEGORIES, MyDiscord, NotificationPreferenceDto } from '../../core/models';

/** Whether the browser exposes the Notification API at all (false in unsupported/older contexts). */
function browserNotificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

/**
 * Notification delivery preferences dialog (opened from the bell). Two groups of toggles:
 *   • Triggers  — server-side gate for whether a notification row is created at all.
 *   • Surfaces  — client-side gate for popping an in-app toast / OS notification when one arrives live.
 *
 * Loads the current prefs from {@link ChatRealtime.preferences} (already fetched on connect), edits a
 * local working copy, and persists via {@link ChatRealtime.updatePreferences} (PUT) on Save. Enabling
 * "Browser notifications" calls Notification.requestPermission() inline (a real user gesture); if the
 * browser blocks it the stored preference is kept but a hint explains it won't fire. Available to anyone
 * with chat.read — NOT gated behind settings.* perms.
 */
@Component({
  selector: 'app-notification-preferences-dialog',
  imports: [
    FormsModule, MatDialogModule, MatButtonModule, MatSlideToggleModule, MatIconModule,
    MatFormFieldModule, MatInputModule, MatSnackBarModule,
  ],
  templateUrl: './notification-preferences-dialog.html',
  styleUrl: './notification-preferences-dialog.scss',
})
export class NotificationPreferencesDialog {
  private chat = inject(ChatRealtime);
  private api = inject(Api);
  private snack = inject(MatSnackBar);
  private ref = inject(MatDialogRef<NotificationPreferencesDialog, NotificationPreferenceDto>);

  /** Editable working copy, seeded from the live preferences signal. */
  readonly model = signal<NotificationPreferenceDto>({ ...this.chat.preferences() });

  readonly busy = signal(false);
  readonly error = signal<string | null>(null);

  /** True when the platform can't deliver OS notifications at all (API missing). */
  readonly browserSupported = browserNotificationsSupported();

  /** Live browser permission state ('granted' | 'denied' | 'default'); drives the hint under the toggle. */
  readonly permission = signal<NotificationPermission | null>(
    this.browserSupported ? Notification.permission : null,
  );

  /**
   * Hint shown beneath the "Browser notifications" toggle. Only relevant once the user has turned the
   * surface on: explains when the OS won't actually pop a notification despite the saved preference.
   */
  readonly browserHint = computed<string | null>(() => {
    if (!this.model().surfaceBrowser) return null;
    if (!this.browserSupported) return 'This browser does not support desktop notifications.';
    const p = this.permission();
    if (p === 'denied') {
      return 'Your browser is blocking notifications for this site — enable them in site settings to receive them.';
    }
    if (p === 'default') {
      return 'Allow notifications when your browser asks, so alerts can appear while this tab is in the background.';
    }
    return 'Desktop notifications appear only when this tab is in the background.';
  });

  /** Flip a trigger/surface boolean on the working copy. */
  patch<K extends keyof NotificationPreferenceDto>(key: K, value: boolean): void {
    this.model.update(m => ({ ...m, [key]: value }));
  }

  // =========================================================================
  // "Forward to my Discord" — a SEPARATE per-user endpoint (/api/notifications/me/discord).
  // The webhook URL is never returned by the server: we only know { configured, hint, surfaceDiscord }.
  // The text input is for ENTERING a new/replacement URL; a saved one shows only the masked hint + Clear.
  // =========================================================================

  /** Server-side state (configured/hint/surfaceDiscord). null until the GET resolves. */
  readonly discord = signal<MyDiscord | null>(null);
  /** Working value of the webhook URL input (only ever holds what the user just typed, never the saved URL). */
  readonly webhookInput = signal('');
  readonly discordBusy = signal(false);
  readonly discordTesting = signal(false);
  readonly recapSending = signal(false);

  constructor() {
    // Load the caller's own Discord state. Swallows errors (the section just stays in its default empty state).
    this.api.myDiscord().subscribe({
      next: d => this.discord.set(d),
      error: () => { /* leave null — section renders as "not configured" */ },
    });
  }

  /** Toggle "also forward my notifications to Discord" and persist it (keeps the stored webhook). */
  surfaceDiscordChange(value: boolean): void {
    const prev = this.discord();
    this.discord.set({
      configured: prev?.configured ?? false, hint: prev?.hint ?? null,
      surfaceDiscord: value, weeklyRecapEnabled: prev?.weeklyRecapEnabled ?? false,
      categories: prev?.categories ?? ALL_DISCORD_CATEGORIES,
    });
    this.discordBusy.set(true);
    this.api.saveMyDiscord({
      webhookUrl: null, surfaceDiscord: value, weeklyRecapEnabled: prev?.weeklyRecapEnabled ?? false,
    }).subscribe({
      next: d => { this.discord.set(d); this.discordBusy.set(false); },
      error: () => {
        this.discord.set(prev); // revert the optimistic flip
        this.discordBusy.set(false);
        this.snack.open('Could not update Discord forwarding', 'Dismiss', { duration: 4000 });
      },
    });
  }

  /** Toggle the weekly personal recap opt-in (Sunday summary of your own week) and persist it. */
  weeklyRecapChange(value: boolean): void {
    const prev = this.discord();
    this.discord.set({
      configured: prev?.configured ?? false, hint: prev?.hint ?? null,
      surfaceDiscord: prev?.surfaceDiscord ?? false, weeklyRecapEnabled: value,
      categories: prev?.categories ?? ALL_DISCORD_CATEGORIES,
    });
    this.discordBusy.set(true);
    this.api.saveMyDiscord({
      webhookUrl: null, surfaceDiscord: prev?.surfaceDiscord ?? false, weeklyRecapEnabled: value,
    }).subscribe({
      next: d => { this.discord.set(d); this.discordBusy.set(false); },
      error: () => {
        this.discord.set(prev); // revert the optimistic flip
        this.discordBusy.set(false);
        this.snack.open('Could not update the weekly recap setting', 'Dismiss', { duration: 4000 });
      },
    });
  }

  /** Send this week's recap to the saved webhook right now (preview/test). 404 = none saved · 502 = rejected. */
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

  /** Save the typed webhook URL (validated + encrypted server-side). Graceful 400 on a non-Discord URL. */
  saveWebhook(): void {
    const url = this.webhookInput().trim();
    if (!url || this.discordBusy()) return;
    this.discordBusy.set(true);
    this.api.saveMyDiscord({
      webhookUrl: url,
      surfaceDiscord: this.discord()?.surfaceDiscord ?? false,
      weeklyRecapEnabled: this.discord()?.weeklyRecapEnabled ?? false,
    }).subscribe({
      next: d => {
        this.discord.set(d);
        this.webhookInput.set('');
        this.discordBusy.set(false);
        this.snack.open('Discord webhook saved', 'OK', { duration: 2500 });
      },
      error: (e: HttpErrorResponse) => {
        this.discordBusy.set(false);
        const msg = e.status === 400
          ? (e.error?.message ?? 'That doesn’t look like a Discord webhook URL.')
          : 'Could not save your Discord webhook.';
        this.snack.open(msg, 'Dismiss', { duration: 5000 });
      },
    });
  }

  /** Clear the stored webhook ("" = clear). Leaves the surface toggle as-is. */
  clearWebhook(): void {
    if (this.discordBusy()) return;
    this.discordBusy.set(true);
    this.api.saveMyDiscord({
      webhookUrl: '',
      surfaceDiscord: this.discord()?.surfaceDiscord ?? false,
      weeklyRecapEnabled: this.discord()?.weeklyRecapEnabled ?? false,
    }).subscribe({
      next: d => { this.discord.set(d); this.webhookInput.set(''); this.discordBusy.set(false); this.snack.open('Discord webhook removed', 'OK', { duration: 2500 }); },
      error: () => { this.discordBusy.set(false); this.snack.open('Could not remove your Discord webhook', 'Dismiss', { duration: 4000 }); },
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

  /**
   * Toggle the in-app toast surface. Plain boolean — no permission needed.
   */
  onToastsChange(value: boolean): void {
    this.patch('surfaceToasts', value);
  }

  /**
   * Toggle the browser/OS notification surface. Turning it ON requests OS permission inline (the
   * change handler runs in the user's click gesture). The stored preference follows the toggle either
   * way; {@link browserHint} explains when the browser will actually deliver it.
   */
  async onBrowserChange(value: boolean): Promise<void> {
    this.patch('surfaceBrowser', value);
    if (value && this.browserSupported && Notification.permission === 'default') {
      try {
        const result = await Notification.requestPermission();
        this.permission.set(result);
      } catch {
        // Some browsers reject the promise instead of resolving 'denied'; reflect current state.
        this.permission.set(Notification.permission);
      }
    }
  }

  save(): void {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    this.chat.updatePreferences(this.model())
      .then(saved => this.ref.close(saved))
      .catch(() => {
        this.busy.set(false);
        this.error.set('Could not save your notification preferences. Please try again.');
      });
  }

  cancel(): void {
    this.ref.close();
  }
}
