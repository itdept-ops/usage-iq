import { CommonModule } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { timer, switchMap, catchError, of } from 'rxjs';

import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';

import { MatSlideToggleModule } from '@angular/material/slide-toggle';

import { HttpErrorResponse } from '@angular/common/http';

import { Api } from '../../core/api';
import { AuthService } from '../../core/auth';
import {
  IngestionSource, NotificationSettings, NotificationUpdate,
  Settings as SettingsModel, SyncResult, SyncStatus, PERM,
} from '../../core/models';
import { timeAgo, humanizeInterval } from '../../shared/format';

@Component({
  selector: 'app-settings',
  imports: [
    CommonModule, FormsModule, MatCardModule, MatFormFieldModule, MatInputModule, MatSelectModule,
    MatButtonModule, MatIconModule, MatProgressBarModule, MatSnackBarModule, MatSlideToggleModule,
  ],
  templateUrl: './settings.html',
  styleUrl: './settings.scss',
})
export class Settings {
  private api = inject(Api);
  private snack = inject(MatSnackBar);
  readonly auth = inject(AuthService);
  readonly PERM = PERM;

  readonly model = signal<SettingsModel | null>(null);
  readonly sources = signal<IngestionSource[]>([]);
  readonly loading = signal(true);
  readonly saving = signal(false);
  readonly savingSourceId = signal<number | null>(null);
  readonly syncing = signal(false);
  readonly lastSync = signal<SyncResult | null>(null);

  readonly status = signal<SyncStatus | null>(null);
  private readonly now = signal(Date.now());

  // ---- Discord notifications ----
  readonly notif = signal<NotificationSettings | null>(null);
  readonly webhookInput = signal('');
  readonly savingNotif = signal(false);
  readonly testingNotif = signal(false);
  readonly sendingSnapshot = signal(false);
  readonly weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  /** newRecordsBySource as [name, count] pairs for the template. */
  readonly lastSyncBySource = computed(() => Object.entries(this.lastSync()?.newRecordsBySource ?? {}));

  readonly lastSyncedLabel = computed(() => {
    const s = this.status();
    const n = this.now();
    if (!s) return '—';
    if (s.isRunning) return 'syncing now…';
    return s.lastSyncUtc ? `${timeAgo(s.lastSyncUtc, n)} · +${s.lastNewRecords.toLocaleString()} rows` : 'never';
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
    'America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles',
    'America/Anchorage', 'Pacific/Honolulu', 'UTC', 'Europe/London', 'Europe/Berlin', 'Europe/Madrid',
    'Asia/Kolkata', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney',
  ];

  readonly zones = computed(() => {
    const cur = this.model()?.displayTimeZone;
    return cur && !this.commonZones.includes(cur) ? [cur, ...this.commonZones] : this.commonZones;
  });

  constructor() {
    this.load();
    // Poll sync status (also fed by the API's background auto-sync); "now" keeps the relative label fresh.
    timer(0, 15000)
      .pipe(
        switchMap(() => this.api.syncStatus().pipe(catchError(() => of(null)))),
        takeUntilDestroyed(),
      )
      .subscribe(s => { this.now.set(Date.now()); if (s) this.status.set(s); });
  }

  private load(): void {
    this.loading.set(true);
    this.api.settings().subscribe({
      next: s => { this.model.set(s); this.loading.set(false); },
      error: () => { this.loading.set(false); this.snack.open('Failed to load settings', 'Dismiss', { duration: 4000 }); },
    });
    this.api.sources().subscribe({
      next: s => this.sources.set(s),
      error: () => this.snack.open('Failed to load sources', 'Dismiss', { duration: 4000 }),
    });
    if (this.auth.hasPermission(PERM.settingsManage)) {
      this.api.notifications().subscribe({ next: n => this.notif.set(n), error: () => { /* non-critical */ } });
    }
  }

  patchNotif<K extends keyof NotificationSettings>(key: K, value: NotificationSettings[K]): void {
    this.notif.update(n => n ? { ...n, [key]: value } : n);
  }

  private notifBody(over: Partial<NotificationUpdate> = {}): NotificationUpdate {
    const n = this.notif()!;
    return {
      enabled: n.enabled, digestHourLocal: n.digestHourLocal, dailyDigest: n.dailyDigest,
      weeklyDigest: n.weeklyDigest, weeklyDay: n.weeklyDay,
      thresholdEnabled: n.thresholdEnabled, thresholdUsd: n.thresholdUsd,
      securityAlerts: n.securityAlerts, mentionOnAlert: n.mentionOnAlert, ...over,
    };
  }

  saveNotif(): void {
    if (!this.notif()) return;
    this.savingNotif.set(true);
    const url = this.webhookInput().trim();
    this.api.saveNotifications(this.notifBody(url ? { discordWebhookUrl: url } : {})).subscribe({
      next: n => {
        this.notif.set(n); this.webhookInput.set(''); this.savingNotif.set(false);
        this.snack.open('Notification settings saved', 'OK', { duration: 2500 });
      },
      error: (e: HttpErrorResponse) => {
        this.savingNotif.set(false);
        this.snack.open(e.error?.message ?? 'Save failed', 'Dismiss', { duration: 5000 });
      },
    });
  }

  removeWebhook(): void {
    if (!this.notif()) return;
    this.savingNotif.set(true);
    this.api.saveNotifications(this.notifBody({ discordWebhookUrl: '' })).subscribe({
      next: n => { this.notif.set(n); this.savingNotif.set(false); this.snack.open('Webhook removed', 'OK', { duration: 2500 }); },
      error: () => { this.savingNotif.set(false); this.snack.open('Could not remove webhook', 'Dismiss', { duration: 4000 }); },
    });
  }

  testNotif(): void {
    this.testingNotif.set(true);
    this.api.testNotification().subscribe({
      next: r => { this.testingNotif.set(false); this.snack.open(r.message, 'OK', { duration: 4000 }); },
      error: (e: HttpErrorResponse) => {
        this.testingNotif.set(false);
        this.snack.open(e.error?.message ?? 'Test failed', 'Dismiss', { duration: 5000 });
      },
    });
  }

  sendSnapshot(): void {
    this.sendingSnapshot.set(true);
    this.api.sendUsageSnapshot().subscribe({
      next: r => { this.sendingSnapshot.set(false); this.snack.open(r.message, 'OK', { duration: 4000 }); },
      error: (e: HttpErrorResponse) => {
        this.sendingSnapshot.set(false);
        this.snack.open(e.error?.message ?? 'Could not send snapshot', 'Dismiss', { duration: 5000 });
      },
    });
  }

  saveSource(s: IngestionSource): void {
    this.savingSourceId.set(s.id);
    this.api.updateSource(s.id, s).subscribe({
      next: () => { this.savingSourceId.set(null); this.snack.open(`Saved source "${s.name}"`, 'OK', { duration: 2500 }); },
      error: () => { this.savingSourceId.set(null); this.snack.open('Save failed', 'Dismiss', { duration: 4000 }); },
    });
  }

  save(): void {
    const m = this.model();
    if (!m) return;
    this.saving.set(true);
    this.api.saveSettings(m).subscribe({
      next: () => { this.saving.set(false); this.snack.open('Settings saved (local dates re-bucketed if timezone changed)', 'OK', { duration: 5000 }); },
      error: () => { this.saving.set(false); this.snack.open('Save failed (check the timezone is a valid IANA id)', 'Dismiss', { duration: 5000 }); },
    });
  }

  sync(): void {
    this.syncing.set(true);
    this.api.sync().subscribe({
      next: r => {
        this.syncing.set(false);
        this.lastSync.set(r);
        this.now.set(Date.now());
        this.api.sources().subscribe({ next: s => this.sources.set(s), error: () => { /* refreshed by next sync */ } });
        this.api.syncStatus().subscribe({ next: st => this.status.set(st), error: () => { /* recovered by 15s poll */ } });
        this.snack.open(r.error ? `Sync error: ${r.error}` : `Synced +${r.newRecords.toLocaleString()} rows`, 'OK', { duration: 5000 });
      },
      error: () => { this.syncing.set(false); this.snack.open('Sync failed', 'Dismiss', { duration: 4000 }); },
    });
  }
}
