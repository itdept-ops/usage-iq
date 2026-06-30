import {
  ChangeDetectionStrategy, Component, computed, inject, signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { MatIconModule } from '@angular/material/icon';

import { Api } from '../../core/api';
import { FamilySettings, FamilySettingsUpdate } from '../../core/models';
import {
  BetaPullRefresh, BetaBottomSheet, BetaSkeleton, BetaToaster, ToastController,
} from '../beta-ui';

/** A pickable IANA timezone for the household-timezone sheet. `label` is a friendly city name. */
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

/** Lead-time choices for the event heads-up (mirrors the server's 1–120 minute range). */
const LEAD_MINUTES: { value: number; label: string }[] = [
  { value: 5, label: '5 minutes before' },
  { value: 10, label: '10 minutes before' },
  { value: 15, label: '15 minutes before' },
  { value: 30, label: '30 minutes before' },
  { value: 45, label: '45 minutes before' },
  { value: 60, label: '1 hour before' },
  { value: 90, label: '90 minutes before' },
  { value: 120, label: '2 hours before' },
];

/** Which value the picker sheet is currently choosing — drives the option list + the commit. */
type PickerKind = 'tz' | 'hour' | 'lead' | null;

/**
 * Family Settings — the mobile-first twin of the live /family settings panel ({@link FamilySettingsPanel}),
 * rebuilt on the shared beta-ui "Strata" kit (`@use '../beta-ui/beta-kit'`). One signature accent — a calm
 * SLATE → INDIGO — re-skins the whole screen via the per-page accent contract. An immersive scrolling
 * header, then a SECTIONED settings list: big tap-target toggle rows (morning briefing, event heads-up) and
 * value rows that open a {@link BetaBottomSheet} radio picker (briefing hour, household timezone, heads-up
 * lead time) plus a weather-location text row. A position:absolute (NOT viewport-fixed) save bar appears
 * inside the host when the draft is dirty, clearing the global tab bar. Pull-to-refresh, skeleton loaders,
 * and an elevated error state round it out.
 *
 * DATA PARITY + PRIVACY: every value comes straight from the SAME owner-scoped endpoint the live page uses —
 * {@link Api.familySettings} (GET /family/settings). Writes go through {@link Api.updateFamilySettings}
 * (PUT, owner-only) VERBATIM, sending the full draft exactly like the live panel's Save. The server enforces
 * owner-only writes regardless; non-owners see every control read-only (`canEdit === false`) with a hint. No
 * email is ever shown here.
 *
 * ISOLATION: gated by `platform.mobile` + the SAME family route guard the live /family settings carries; it
 * consumes the kit + the SAME Api/DTOs as the live counterpart. No live page is imported or modified. Layout
 * is mobile-first (44px+ targets, safe-area insets, no 390px overflow) and centers on desktop; reduced
 * motion collapses the kit animations via the a11y killswitch.
 */
@Component({
  selector: 'app-family-settings-mobile',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [ToastController],
  imports: [
    FormsModule, MatIconModule,
    BetaPullRefresh, BetaBottomSheet, BetaSkeleton, BetaToaster,
  ],
  template: `
    <!-- ─────────────── PULL-TO-REFRESH OWNS THE SCROLL ─────────────── -->
    <app-bs-pull-refresh class="fs-ptr" [busy]="refreshing()" [disabled]="loading()" (refresh)="reload()">
      <div class="fs-scroll" aria-live="polite">

        <!-- ─── IMMERSIVE HEADER ─── -->
        <header class="fs-hero">
          <p class="fs-hero__kicker"><mat-icon aria-hidden="true">tune</mat-icon> Household</p>
          <h1 class="fs-hero__title">Family Settings</h1>
          <p class="fs-hero__sub">Briefing time, timezone, weather location and event heads-up.</p>

          @if (!loading() && !errored() && !canEdit()) {
            <p class="fs-hero__note">
              <mat-icon aria-hidden="true">lock</mat-icon>
              Only the household owner can change these. You're viewing them read-only.
            </p>
          }
        </header>

        @if (loading()) {
          <!-- skeleton sections -->
          <div class="fs-list" aria-hidden="true">
            @for (n of skeletonCells; track n) {
              <app-bs-skeleton height="72px" radius="var(--r-tile)" />
            }
          </div>

        } @else if (errored()) {
          <div class="fs-state">
            <span class="fs-state__orb"><mat-icon aria-hidden="true">cloud_off</mat-icon></span>
            <h2 class="fs-state__title">Couldn't load settings</h2>
            <p class="fs-state__body">Something went wrong fetching your household settings. Give it another go.</p>
            <button type="button" class="fs-state__cta" (click)="reload()">
              <mat-icon aria-hidden="true">refresh</mat-icon> Try again
            </button>
          </div>

        } @else {
          <!-- ═══ MORNING BRIEFING ═══ -->
          <section class="fs-section">
            <h2 class="fs-section__title"><mat-icon aria-hidden="true">wb_sunny</mat-icon> Morning briefing</h2>
            <div class="fs-card">
              <!-- toggle row -->
              <button type="button" class="fs-row fs-row--toggle" [disabled]="!canEdit()"
                      [attr.aria-pressed]="briefingEnabled()" (click)="canEdit() && toggleBriefing()">
                <span class="fs-row__ic" aria-hidden="true"><mat-icon>notifications_active</mat-icon></span>
                <span class="fs-row__body">
                  <span class="fs-row__label">Daily briefing</span>
                  <span class="fs-row__hint">A morning rundown of today's events, lists and weather.</span>
                </span>
                <span class="fs-switch" [class.is-on]="briefingEnabled()" aria-hidden="true">
                  <span class="fs-switch__knob"></span>
                </span>
              </button>

              <!-- briefing hour value row (only when enabled) -->
              @if (briefingEnabled()) {
                <button type="button" class="fs-row fs-row--value" [disabled]="!canEdit()"
                        (click)="canEdit() && openPicker('hour')">
                  <span class="fs-row__ic" aria-hidden="true"><mat-icon>schedule</mat-icon></span>
                  <span class="fs-row__body">
                    <span class="fs-row__label">Send at</span>
                    <span class="fs-row__hint">When the briefing arrives, in your household timezone.</span>
                  </span>
                  <span class="fs-row__value">{{ hourLabel() }}</span>
                  @if (canEdit()) { <mat-icon class="fs-row__go" aria-hidden="true">chevron_right</mat-icon> }
                </button>
              }
            </div>
          </section>

          <!-- ═══ TIMEZONE & WEATHER ═══ -->
          <section class="fs-section">
            <h2 class="fs-section__title"><mat-icon aria-hidden="true">public</mat-icon> Location</h2>
            <div class="fs-card">
              <!-- timezone -->
              <button type="button" class="fs-row fs-row--value" [disabled]="!canEdit()"
                      (click)="canEdit() && openPicker('tz')">
                <span class="fs-row__ic" aria-hidden="true"><mat-icon>schedule</mat-icon></span>
                <span class="fs-row__body">
                  <span class="fs-row__label">Timezone</span>
                  <span class="fs-row__hint">Used for every "today" and the briefing time.</span>
                </span>
                <span class="fs-row__value fs-row__value--clip">{{ tzLabel() }}</span>
                @if (canEdit()) { <mat-icon class="fs-row__go" aria-hidden="true">chevron_right</mat-icon> }
              </button>

              <!-- weather location (free text) -->
              <label class="fs-row fs-row--input" [class.is-readonly]="!canEdit()">
                <span class="fs-row__ic" aria-hidden="true"><mat-icon>partly_cloudy_day</mat-icon></span>
                <span class="fs-row__body">
                  <span class="fs-row__label">Weather location</span>
                  <input class="fs-input" type="text" [ngModel]="weatherLocation()"
                         (ngModelChange)="weatherLocation.set($event)" name="weatherLocation"
                         placeholder="e.g. Tampa,FL,US" autocomplete="off" maxlength="120"
                         [disabled]="!canEdit()" />
                  @if (!weatherConfigured()) {
                    <span class="fs-row__hint fs-row__hint--warn">
                      <mat-icon aria-hidden="true">info</mat-icon>
                      Weather appears once an OpenWeather key is set up server-side.
                    </span>
                  }
                </span>
              </label>
            </div>
          </section>

          <!-- ═══ EVENT HEADS-UP ═══ -->
          <section class="fs-section">
            <h2 class="fs-section__title"><mat-icon aria-hidden="true">event_upcoming</mat-icon> Event heads-up</h2>
            <div class="fs-card">
              <button type="button" class="fs-row fs-row--toggle" [disabled]="!canEdit()"
                      [attr.aria-pressed]="headsUpEnabled()" (click)="canEdit() && toggleHeadsUp()">
                <span class="fs-row__ic" aria-hidden="true"><mat-icon>alarm</mat-icon></span>
                <span class="fs-row__body">
                  <span class="fs-row__label">Remind before events</span>
                  <span class="fs-row__hint">A nudge ahead of calendar events that start soon.</span>
                </span>
                <span class="fs-switch" [class.is-on]="headsUpEnabled()" aria-hidden="true">
                  <span class="fs-switch__knob"></span>
                </span>
              </button>

              @if (headsUpEnabled()) {
                <button type="button" class="fs-row fs-row--value" [disabled]="!canEdit()"
                        (click)="canEdit() && openPicker('lead')">
                  <span class="fs-row__ic" aria-hidden="true"><mat-icon>timer</mat-icon></span>
                  <span class="fs-row__body">
                    <span class="fs-row__label">Lead time</span>
                    <span class="fs-row__hint">How far ahead of an event to remind you.</span>
                  </span>
                  <span class="fs-row__value">{{ leadLabel() }}</span>
                  @if (canEdit()) { <mat-icon class="fs-row__go" aria-hidden="true">chevron_right</mat-icon> }
                </button>
              }
            </div>
          </section>

          <!-- spacer so the absolute save bar never overlaps the last card -->
          @if (canEdit() && dirty()) { <div class="fs-savebar-spacer" aria-hidden="true"></div> }
        }
      </div>
    </app-bs-pull-refresh>

    <!-- ─── SAVE BAR (absolute, inside host — clears the global tab bar) ─── -->
    @if (!loading() && !errored() && canEdit() && dirty()) {
      <div class="fs-savebar" role="region" aria-label="Unsaved changes">
        <button type="button" class="fs-savebar__btn fs-savebar__btn--ghost" (click)="reset()" [disabled]="saving()">
          Discard
        </button>
        <button type="button" class="fs-savebar__btn fs-savebar__btn--save" (click)="save()" [disabled]="saving()">
          @if (saving()) { <span class="fs-spin" aria-hidden="true"></span> Saving… }
          @else { <mat-icon aria-hidden="true">check</mat-icon> Save changes }
        </button>
      </div>
    }

    <!-- ─────────────── PICKER BOTTOM SHEET ─────────────── -->
    <app-bs-sheet [(open)]="pickerOpen" detent="half" [label]="pickerTitle()">
      <div class="fs-picker">
        <h3 class="fs-picker__title">{{ pickerTitle() }}</h3>
        <ul class="fs-picker__list" role="radiogroup" [attr.aria-label]="pickerTitle()">
          @for (opt of pickerOptions(); track opt.id) {
            <li>
              <button type="button" class="fs-opt" role="radio" [attr.aria-checked]="opt.selected"
                      [class.is-sel]="opt.selected" (click)="choose(opt.id)">
                <span class="fs-opt__label">{{ opt.label }}</span>
                @if (opt.selected) { <mat-icon class="fs-opt__check" aria-hidden="true">check</mat-icon> }
              </button>
            </li>
          }
        </ul>
      </div>
    </app-bs-sheet>

    <app-bs-toaster />
  `,
  styleUrl: './family-settings-mobile.page.scss',
})
export class FamilySettingsMobilePage {
  private api = inject(Api);
  private toast = inject(ToastController);

  readonly settings = signal<FamilySettings | null>(null);
  readonly loading = signal(true);
  readonly errored = signal(false);
  readonly refreshing = signal(false);
  readonly saving = signal(false);

  // ── Draft form state (seeded from the loaded settings) ──
  readonly briefingEnabled = signal(false);
  readonly briefingHour = signal(7);
  readonly timeZone = signal('Etc/UTC');
  readonly weatherLocation = signal('');
  readonly headsUpEnabled = signal(false);
  readonly headsUpLead = signal(15);

  // ── Picker sheet state ──
  readonly pickerOpen = signal(false);
  readonly pickerKind = signal<PickerKind>(null);

  readonly skeletonCells = Array.from({ length: 4 }, (_, i) => i);

  /** True when the caller is the household owner — gates every control (mirrors the server). */
  readonly canEdit = computed(() => this.settings()?.canEdit ?? false);
  readonly weatherConfigured = computed(() => this.settings()?.weatherConfigured ?? false);

  /** If the loaded timezone isn't in the curated list, surface it so the picker still shows the real value. */
  readonly tzOptions = computed<TzOption[]>(() => {
    const tz = this.timeZone();
    if (tz && !TIMEZONES.some((o) => o.id === tz)) return [{ id: tz, label: tz }, ...TIMEZONES];
    return TIMEZONES;
  });

  /** If the saved lead time isn't one of the presets, surface it so the picker still shows the real value. */
  readonly leadOptions = computed<{ value: number; label: string }[]>(() => {
    const lead = this.headsUpLead();
    if (LEAD_MINUTES.some((o) => o.value === lead)) return LEAD_MINUTES;
    return [...LEAD_MINUTES, { value: lead, label: `${lead} minutes before` }].sort(
      (a, b) => a.value - b.value,
    );
  });

  readonly hourLabel = computed(
    () => HOURS.find((h) => h.value === this.briefingHour())?.label ?? `${this.briefingHour()}:00`,
  );
  readonly tzLabel = computed(
    () => this.tzOptions().find((o) => o.id === this.timeZone())?.label ?? this.timeZone(),
  );
  readonly leadLabel = computed(
    () => this.leadOptions().find((o) => o.value === this.headsUpLead())?.label ?? `${this.headsUpLead()} min`,
  );

  /** True once any draft field differs from the saved settings (shows the save bar). */
  readonly dirty = computed(() => {
    const s = this.settings();
    if (!s) return false;
    return (
      this.briefingEnabled() !== s.briefingEnabled ||
      this.briefingHour() !== s.briefingHourLocal ||
      this.timeZone() !== s.timeZone ||
      this.weatherLocation().trim() !== (s.weatherLocation ?? '') ||
      this.headsUpEnabled() !== s.eventHeadsUpEnabled ||
      this.headsUpLead() !== s.eventHeadsUpLeadMinutes
    );
  });

  // ── Picker derived view ──
  readonly pickerTitle = computed(() => {
    switch (this.pickerKind()) {
      case 'tz': return 'Household timezone';
      case 'hour': return 'Briefing time';
      case 'lead': return 'Heads-up lead time';
      default: return '';
    }
  });

  readonly pickerOptions = computed<{ id: string; label: string; selected: boolean }[]>(() => {
    switch (this.pickerKind()) {
      case 'tz':
        return this.tzOptions().map((o) => ({ id: o.id, label: o.label, selected: o.id === this.timeZone() }));
      case 'hour':
        return HOURS.map((h) => ({ id: String(h.value), label: h.label, selected: h.value === this.briefingHour() }));
      case 'lead':
        return this.leadOptions().map((l) => ({ id: String(l.value), label: l.label, selected: l.value === this.headsUpLead() }));
      default:
        return [];
    }
  });

  constructor() {
    void this.reload();
  }

  // ─────────────── LOAD ───────────────

  async reload(): Promise<void> {
    const wasLoaded = !this.loading();
    if (wasLoaded) this.refreshing.set(true); else this.loading.set(true);
    this.errored.set(false);
    try {
      const s = await firstValueFrom(this.api.familySettings());
      this.apply(s);
    } catch {
      this.errored.set(true);
    } finally {
      this.loading.set(false);
      if (wasLoaded) {
        this.refreshing.set(false);
        if (!this.errored()) this.toast.show('Settings refreshed', { tone: 'success', durationMs: 1600 });
      }
    }
  }

  private apply(s: FamilySettings): void {
    this.settings.set(s);
    this.briefingEnabled.set(s.briefingEnabled);
    this.briefingHour.set(s.briefingHourLocal);
    this.timeZone.set(s.timeZone);
    this.weatherLocation.set(s.weatherLocation ?? '');
    this.headsUpEnabled.set(s.eventHeadsUpEnabled);
    this.headsUpLead.set(s.eventHeadsUpLeadMinutes);
  }

  // ─────────────── TOGGLES ───────────────

  toggleBriefing(): void {
    if (!this.canEdit()) return;
    this.briefingEnabled.update((v) => !v);
  }

  toggleHeadsUp(): void {
    if (!this.canEdit()) return;
    this.headsUpEnabled.update((v) => !v);
  }

  // ─────────────── PICKER ───────────────

  openPicker(kind: Exclude<PickerKind, null>): void {
    if (!this.canEdit()) return;
    this.pickerKind.set(kind);
    this.pickerOpen.set(true);
  }

  choose(id: string): void {
    switch (this.pickerKind()) {
      case 'tz': this.timeZone.set(id); break;
      case 'hour': this.briefingHour.set(+id); break;
      case 'lead': this.headsUpLead.set(+id); break;
    }
    this.pickerOpen.set(false);
  }

  // ─────────────── SAVE / RESET ───────────────

  /** Persist the draft (owner only). Sends the full draft, exactly like the live panel's Save. */
  async save(): Promise<void> {
    if (!this.canEdit() || !this.dirty() || this.saving()) return;
    const s = this.settings();
    if (!s) return;
    this.saving.set(true);
    try {
      const loc = this.weatherLocation().trim();
      const body: FamilySettingsUpdate = {
        briefingEnabled: this.briefingEnabled(),
        briefingHourLocal: this.briefingHour(),
        timeZone: this.timeZone(),
        weatherLocation: loc.length ? loc : null,
        eventHeadsUpEnabled: this.headsUpEnabled(),
        eventHeadsUpLeadMinutes: this.headsUpLead(),
      };
      const saved = await firstValueFrom(this.api.updateFamilySettings(body));
      this.apply(saved);
      this.toast.show('Family settings saved', { tone: 'success', durationMs: 2000 });
    } catch (e) {
      this.toast.show(this.messageOf(e, "Couldn't save settings — try again"), { tone: 'warn' });
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
