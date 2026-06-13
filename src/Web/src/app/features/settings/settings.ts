import { CommonModule } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';

import { Api } from '../../core/api';
import { Settings as SettingsModel, SyncResult } from '../../core/models';

@Component({
  selector: 'app-settings',
  imports: [
    CommonModule, FormsModule, MatCardModule, MatFormFieldModule, MatInputModule, MatSelectModule,
    MatButtonModule, MatIconModule, MatProgressBarModule, MatSnackBarModule,
  ],
  templateUrl: './settings.html',
  styleUrl: './settings.scss',
})
export class Settings {
  private api = inject(Api);
  private snack = inject(MatSnackBar);

  readonly model = signal<SettingsModel | null>(null);
  readonly loading = signal(true);
  readonly saving = signal(false);
  readonly syncing = signal(false);
  readonly lastSync = signal<SyncResult | null>(null);

  private readonly commonZones = [
    'America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles',
    'America/Anchorage', 'Pacific/Honolulu', 'UTC', 'Europe/London', 'Europe/Berlin', 'Europe/Madrid',
    'Asia/Kolkata', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney',
  ];

  readonly zones = computed(() => {
    const cur = this.model()?.displayTimeZone;
    return cur && !this.commonZones.includes(cur) ? [cur, ...this.commonZones] : this.commonZones;
  });

  constructor() { this.load(); }

  private load(): void {
    this.loading.set(true);
    this.api.settings().subscribe({
      next: s => { this.model.set(s); this.loading.set(false); },
      error: () => { this.loading.set(false); this.snack.open('Failed to load settings', 'Dismiss', { duration: 4000 }); },
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
        this.snack.open(r.error ? `Sync error: ${r.error}` : `Synced +${r.newRecords.toLocaleString()} rows`, 'OK', { duration: 5000 });
      },
      error: () => { this.syncing.set(false); this.snack.open('Sync failed', 'Dismiss', { duration: 4000 }); },
    });
  }
}
