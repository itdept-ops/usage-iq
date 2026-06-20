import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { catchError, firstValueFrom, of } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';

import { Api } from '../../core/api';
import { FamilySettings } from '../../core/models';

/** A pickable IANA timezone for the household-timezone select. `label` is a friendly city name. */
interface TzOption {
  id: string;
  label: string;
}

/**
 * A reasonable, curated IANA timezone list (the server validates the chosen id regardless). Covers the
 * common US zones plus a spread of major world cities so most households find their own.
 */
const TIMEZONES: TzOption[] = [
  { id: 'Pacific/Honolulu', label: 'Honolulu (HST)' },
  { id: 'America/Anchorage', label: 'Anchorage (AKT)' },
  { id: 'America/Los_Angeles', label: 'Los Angeles · Pacific' },
  { id: 'America/Denver', label: 'Denver · Mountain' },
  { id: 'America/Phoenix', label: 'Phoenix (no DST)' },
  { id: 'America/Chicago', label: 'Chicago · Central' },
  { id: 'America/New_York', label: 'New York · Eastern' },
  { id: 'America/Halifax', label: 'Halifax · Atlantic' },
  { id: 'America/Sao_Paulo', label: 'São Paulo' },
  { id: 'Etc/UTC', label: 'UTC' },
  { id: 'Europe/London', label: 'London' },
  { id: 'Europe/Paris', label: 'Paris · Berlin · Madrid' },
  { id: 'Europe/Athens', label: 'Athens · Helsinki' },
  { id: 'Africa/Johannesburg', label: 'Johannesburg' },
  { id: 'Asia/Dubai', label: 'Dubai' },
  { id: 'Asia/Kolkata', label: 'India (IST)' },
  { id: 'Asia/Singapore', label: 'Singapore' },
  { id: 'Asia/Tokyo', label: 'Tokyo' },
  { id: 'Australia/Sydney', label: 'Sydney' },
  { id: 'Pacific/Auckland', label: 'Auckland' },
];

/** The 24 briefing-hour choices, pre-labelled in friendly 12-hour form. */
const HOURS: { value: number; label: string }[] = Array.from({ length: 24 }, (_, h) => {
  const ampm = h < 12 ? 'AM' : 'PM';
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return { value: h, label: `${twelve}:00 ${ampm}` };
});

/**
 * Family settings — the household's "how the hub behaves" room. The OWNER may toggle the morning briefing,
 * pick the briefing hour, choose the household timezone (used for all "today" math + the briefing), and set
 * the weather location (free text like "Tampa,FL,US"; weather only appears once an OpenWeather key is
 * configured server-side). Non-owners see every setting read-only — the controls disable and a hint explains
 * why (the server enforces owner-only writes regardless). No email is ever shown here.
 */
@Component({
  selector: 'app-family-settings',
  imports: [
    RouterLink, FormsModule, MatIconModule, MatButtonModule, MatFormFieldModule, MatInputModule,
    MatSelectModule, MatSlideToggleModule, MatTooltipModule, MatProgressSpinnerModule, MatSnackBarModule,
  ],
  templateUrl: './family-settings.html',
  styleUrl: './family.scss',
})
export class FamilySettingsPanel {
  private api = inject(Api);
  private snack = inject(MatSnackBar);

  readonly timezones = TIMEZONES;
  readonly hours = HOURS;

  readonly settings = signal<FamilySettings | null>(null);
  readonly loading = signal(true);
  readonly error = signal(false);
  readonly saving = signal(false);

  // ── Draft form state (seeded from the loaded settings) ──
  readonly briefingEnabled = signal(false);
  readonly briefingHour = signal(7);
  readonly timeZone = signal('Etc/UTC');
  readonly weatherLocation = signal('');

  /** True when the caller is the household owner — gates every control (mirrors the server). */
  readonly canEdit = computed(() => this.settings()?.canEdit ?? false);
  readonly weatherConfigured = computed(() => this.settings()?.weatherConfigured ?? false);

  /** If the loaded timezone isn't in the curated list, surface it so the select still shows the real value. */
  readonly tzOptions = computed<TzOption[]>(() => {
    const tz = this.timeZone();
    if (tz && !TIMEZONES.some(o => o.id === tz)) return [{ id: tz, label: tz }, ...TIMEZONES];
    return TIMEZONES;
  });

  /** True once any draft field differs from the saved settings (enables the Save button). */
  readonly dirty = computed(() => {
    const s = this.settings();
    if (!s) return false;
    return this.briefingEnabled() !== s.briefingEnabled
      || this.briefingHour() !== s.briefingHourLocal
      || this.timeZone() !== s.timeZone
      || this.weatherLocation().trim() !== (s.weatherLocation ?? '');
  });

  constructor() {
    this.api.familySettings()
      .pipe(catchError(() => { this.error.set(true); return of(null); }), takeUntilDestroyed())
      .subscribe(s => { if (s) this.apply(s); this.loading.set(false); });
  }

  private apply(s: FamilySettings): void {
    this.settings.set(s);
    this.briefingEnabled.set(s.briefingEnabled);
    this.briefingHour.set(s.briefingHourLocal);
    this.timeZone.set(s.timeZone);
    this.weatherLocation.set(s.weatherLocation ?? '');
  }

  /** Persist the draft (owner only). Sends only what changed; resets the form to the saved result. */
  async save(): Promise<void> {
    if (!this.canEdit() || !this.dirty() || this.saving()) return;
    const s = this.settings();
    if (!s) return;
    this.saving.set(true);
    try {
      const loc = this.weatherLocation().trim();
      const saved = await firstValueFrom(this.api.updateFamilySettings({
        briefingEnabled: this.briefingEnabled(),
        briefingHourLocal: this.briefingHour(),
        timeZone: this.timeZone(),
        weatherLocation: loc.length ? loc : null,
      }));
      this.apply(saved);
      this.snack.open('Family settings saved.', 'OK', { duration: 3000 });
    } catch (e) {
      this.snack.open(this.messageOf(e, "Couldn't save settings. Please try again."), 'OK', { duration: 4000 });
    } finally {
      this.saving.set(false);
    }
  }

  /** Reset the draft back to the saved settings. */
  reset(): void {
    const s = this.settings();
    if (s) this.apply(s);
  }

  /** Pull the server's friendly `message` from an HttpErrorResponse, falling back to a default. */
  private messageOf(e: unknown, fallback: string): string {
    const msg = (e as { error?: { message?: string } })?.error?.message;
    return typeof msg === 'string' && msg ? msg : fallback;
  }
}
