import { CommonModule } from '@angular/common';
import { Component, OnDestroy, computed, inject, signal } from '@angular/core';

import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatDialog } from '@angular/material/dialog';
import { firstValueFrom } from 'rxjs';

import { Api } from '../../core/api';
import { LocationCapture } from '../../core/location-capture';
import { LocationFix } from '../../core/models';
import { timeAgo } from '../../shared/format';
import { FamilyConfirmDialog, ConfirmData } from '../family/confirm-dialog';
import { LocationMap, MapPin, MapTrail } from './location-map';

/**
 * "My locations" — the caller's OWN location history (gated location.self): a Leaflet/OSM map with their
 * history pins + trail, and a timeline list (city + time). PRIVATE to the caller; the precise lat/lng is
 * theirs alone here. Capture is opt-in (managed in Settings → Location); this page also offers a one-shot
 * "Share current location now" and a destructive "Clear my history".
 */
@Component({
  selector: 'app-my-locations',
  standalone: true,
  imports: [
    CommonModule, MatButtonModule, MatIconModule, MatTooltipModule, MatProgressBarModule,
    MatSlideToggleModule, MatSnackBarModule, LocationMap,
  ],
  templateUrl: './my-locations.html',
  styleUrl: './my-locations.scss',
})
export class MyLocations implements OnDestroy {
  private api = inject(Api);
  private snack = inject(MatSnackBar);
  private dialog = inject(MatDialog);
  readonly capture = inject(LocationCapture);

  readonly history = signal<LocationFix[]>([]);
  readonly loading = signal(true);
  readonly savingSettings = signal(false);
  readonly now = signal(Date.now());
  readonly timeAgo = timeAgo;

  /** Refresh relative-time labels (~every minute) so "2m ago" never freezes while the page stays open. */
  private readonly tick = setInterval(() => this.now.set(Date.now()), 60_000);

  /** The opt-in settings (so the page can hint when capture is off). */
  readonly settings = this.capture.settings;

  /** Map pins from the history (each fix is one pin; the newest is emphasised). */
  readonly pins = computed<MapPin[]>(() =>
    this.history().map((f, i) => ({
      id: String(f.id),
      lat: f.lat,
      lng: f.lng,
      title: this.placeLabel(f),
      subtitle: `${this.sourceLabel(f.source)} · ${timeAgo(f.capturedUtc, this.now())}`,
      kind: 'user' as const,
      emphasis: i === 0,
    })));

  /** A single trail connecting the history points newest→oldest. */
  readonly trails = computed<MapTrail[]>(() => {
    const pts = this.history().map(f => [f.lat, f.lng] as [number, number]);
    return pts.length > 1 ? [{ points: pts }] : [];
  });

  constructor() {
    this.capture.refreshSettings();
    this.load();
  }

  private load(): void {
    this.loading.set(true);
    this.now.set(Date.now());
    this.api.myLocations(200).subscribe({
      next: rows => { this.history.set(rows); this.loading.set(false); },
      error: () => { this.loading.set(false); this.snack.open('Could not load your locations', 'Dismiss', { duration: 4000 }); },
    });
  }

  /** One-shot "Share current location now" — asks the browser once and records a manual fix, then reloads. */
  async shareNow(): Promise<void> {
    if (!this.settings()?.locationEnabled) {
      this.snack.open('Enable location in Settings → Location first.', 'OK', { duration: 5000 });
      return;
    }
    const city = await this.capture.captureOnce('manual');
    if (this.capture.permissionDenied()) {
      this.snack.open('Location permission was denied by your browser.', 'Dismiss', { duration: 5000 });
      return;
    }
    this.snack.open(city ? `Recorded — ${city}` : 'Location recorded.', 'OK', { duration: 3500 });
    this.load();
  }

  /**
   * Flip the "Enable location" opt-in. Enabling is the explicit gesture that prompts the browser for the
   * Geolocation permission (via the capture service) — a denial is surfaced as a hint and leaves the row
   * recorded as enabled server-side but with no fixes (the user can retry once they allow it).
   */
  async toggleEnabled(enabled: boolean): Promise<void> {
    this.savingSettings.set(true);
    const saved = await this.capture.applySettings({ locationEnabled: enabled });
    this.savingSettings.set(false);
    if (!saved) { this.snack.open('Could not update location setting', 'Dismiss', { duration: 4000 }); return; }
    if (enabled && this.capture.permissionDenied()) {
      this.snack.open('Enabled, but your browser denied the location permission. Allow it and try “Share current location”.', 'OK', { duration: 6000 });
    } else {
      this.snack.open(enabled ? 'Location enabled.' : 'Location disabled (your history is kept).', 'OK', { duration: 3000 });
    }
    if (enabled) this.load();
  }

  /** Flip the "Share with my household" opt-in (only meaningful while capture is enabled). */
  async toggleShare(share: boolean): Promise<void> {
    this.savingSettings.set(true);
    const saved = await this.capture.applySettings({ shareHousehold: share });
    this.savingSettings.set(false);
    if (!saved) { this.snack.open('Could not update sharing setting', 'Dismiss', { duration: 4000 }); return; }
    this.snack.open(share ? 'Sharing your city with household.' : 'Stopped sharing your city.', 'OK', { duration: 3000 });
  }

  /** Destructive: permanently clear the caller's own history (confirm via the on-brand dialog first). */
  async clearHistory(): Promise<void> {
    if (!this.history().length) return;
    const ref = this.dialog.open<FamilyConfirmDialog, ConfirmData, boolean>(FamilyConfirmDialog, {
      data: {
        title: 'Clear my history?',
        message: 'Permanently delete all of your recorded locations? This cannot be undone.',
        confirmLabel: 'Delete history',
        destructive: true,
      },
      width: '420px', maxWidth: '92vw',
    });
    const ok = await firstValueFrom(ref.afterClosed());
    if (!ok) return;
    this.api.clearMyLocations().subscribe({
      next: r => { this.history.set([]); this.snack.open(`Cleared ${r.deleted} location(s).`, 'OK', { duration: 3500 }); },
      error: () => this.snack.open('Could not clear history', 'Dismiss', { duration: 4000 }),
    });
  }

  ngOnDestroy(): void {
    clearInterval(this.tick);
  }

  placeLabel(f: LocationFix): string {
    const parts = [f.city, f.region, f.country].filter(Boolean);
    return parts.length ? parts.join(', ') : `${f.lat.toFixed(3)}, ${f.lng.toFixed(3)}`;
  }

  sourceLabel(source: string): string {
    switch (source) {
      case 'login': return 'on sign-in';
      case 'periodic': return 'auto';
      case 'manual': return 'shared';
      case 'agent': return 'agent';
      default: return source;
    }
  }
}
