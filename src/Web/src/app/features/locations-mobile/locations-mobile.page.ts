import {
  ChangeDetectionStrategy, Component, OnDestroy, computed, inject, signal,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { firstValueFrom } from 'rxjs';
import { MatIconModule } from '@angular/material/icon';

import { Api } from '../../core/api';
import { LocationCapture } from '../../core/location-capture';
import { LocationFix } from '../../core/models';
import { timeAgo } from '../../shared/format';
import { LocationMap, MapPin, MapTrail } from '../location/location-map';
import {
  BetaSkeleton, BetaFab, BetaToaster, BetaBottomSheet, ToastController,
} from '../beta-ui';

/**
 * Locations — the MOBILE twin of the live `/location` "My locations" page, rebuilt on the shared beta-ui
 * "Strata" kit (`@use '../beta-ui/beta-kit'`) with a signature TEAL → SKY accent (a "wayfinding" hue). It
 * is a full-bleed, native-feel MAP screen: a {@link LocationMap} (Leaflet/OSM, lazy-loaded via the shared
 * loader) fills the viewport with the caller's history pins (newest emphasised) + a faint trail connecting
 * them, an immersive title overlay with a live "last seen" stat, a floating {@link BetaFab} to share the
 * current location, and a {@link BetaBottomSheet} TIMELINE listing every fix (place + source + relative
 * time) with an opt-in capture toggle and a destructive "Clear my history". Tapping a row recentres the
 * map on that pin; tapping a map marker selects its timeline row.
 *
 * DATA PARITY + PRIVACY: the history comes straight from the SAME self-scoped {@link Api.myLocations}
 * (GET /api/location/me) the live page uses, and the precise lat/lng is the CALLER's alone (never anyone
 * else's, never an email). The opt-in toggle + one-shot "share now" go through the SAME
 * {@link LocationCapture} service (which wraps {@link Api.patchLocationSettings} + the browser geolocation
 * permission flow VERBATIM), and "Clear my history" calls {@link Api.clearMyLocations}. The server enforces
 * the gate (`location.self`) and the destructive delete; this is purely a mobile re-presentation.
 *
 * ISOLATION: gated by `platform.mobile` on the SAME `/location` route. It imports only the kit + the
 * shared map component, the shared Api/models, and the LocationCapture service the live page already uses.
 * No live page is imported or modified. The harness mocks the API, so a zero-data load renders a clean
 * empty state over a world map.
 */
@Component({
  selector: 'app-locations-mobile',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [ToastController],
  imports: [
    DecimalPipe, MatIconModule,
    LocationMap, BetaSkeleton, BetaFab, BetaToaster, BetaBottomSheet,
  ],
  template: `
    <div class="lm">
      <!-- ─────────────── FULL-BLEED MAP ─────────────── -->
      <div class="lm-map">
        <app-location-map [pins]="pins()" [trails]="trails()" (pinClick)="selectFix($event)" />

        @if (loading()) {
          <div class="lm-map__veil" aria-hidden="true">
            <span class="lm-spin"></span>
          </div>
        }
      </div>

      <!-- ─── TITLE OVERLAY (top), floating over the map ─── -->
      <header class="lm-hero">
        <p class="lm-hero__kicker"><mat-icon aria-hidden="true">my_location</mat-icon> Wayfinding</p>
        <h1 class="lm-hero__title">My locations</h1>
        @if (!loading()) {
          <p class="lm-hero__sub">
            @if (history().length) {
              <mat-icon aria-hidden="true">place</mat-icon>
              {{ latestLabel() }} · last seen {{ timeAgo(history()[0].capturedUtc, now()) }}
            } @else if (errored()) {
              <mat-icon aria-hidden="true">cloud_off</mat-icon> Couldn't load your history
            } @else {
              <mat-icon aria-hidden="true">explore_off</mat-icon> No recorded locations yet
            }
          </p>
        }
      </header>

      <!-- ─── ENABLE HINT (only when capture is off) — a tappable pill over the map ─── -->
      @if (!loading() && !captureOn()) {
        <button type="button" class="lm-enable" [disabled]="savingSettings()" (click)="toggleEnabled(true)">
          @if (savingSettings()) {
            <mat-icon class="lm-spin-ic" aria-hidden="true">progress_activity</mat-icon> Enabling…
          } @else {
            <mat-icon aria-hidden="true">location_on</mat-icon>
            <span>Location is off — tap to enable capture</span>
          }
        </button>
      }

      <!-- ─── DOCKED TIMELINE PANEL (absolute bottom, non-modal so the map stays interactive) ─── -->
      <section class="lm-sheet" aria-label="Location history">
        <div class="lm-sheet__grip" aria-hidden="true"></div>
        <div class="lt">
          <div class="lt__head">
            <div class="lt__titles">
              <h2 class="lt__title">History</h2>
              <p class="lt__sub">
                @if (loading()) { Loading your timeline… }
                @else {
                  <span class="mono-num">{{ history().length }}</span>
                  recorded {{ history().length === 1 ? 'place' : 'places' }}
                }
              </p>
            </div>
            @if (history().length) {
              <button type="button" class="lt__clear" [disabled]="clearing()" (click)="clearHistory()">
                <mat-icon aria-hidden="true">delete_sweep</mat-icon> Clear
              </button>
            }
          </div>

          <!-- capture toggle row (mirrors the live opt-in) -->
          <button type="button" class="lt__toggle" role="switch"
                  [class.is-on]="captureOn()"
                  [attr.aria-checked]="captureOn()"
                  [disabled]="savingSettings()"
                  (click)="toggleEnabled(!captureOn())">
            <span class="lt__toggle-ic" aria-hidden="true">
              <mat-icon>{{ captureOn() ? 'location_on' : 'location_off' }}</mat-icon>
            </span>
            <span class="lt__toggle-body">
              <span class="lt__toggle-title">{{ captureOn() ? 'Capture is on' : 'Capture is off' }}</span>
              <span class="lt__toggle-blurb">
                {{ captureOn()
                  ? 'Your location is recorded periodically while the app is open.'
                  : 'Turn on to start recording your location history.' }}
              </span>
            </span>
            <span class="lt__switch" aria-hidden="true"><span class="lt__switch-knob"></span></span>
          </button>

          <!-- share-with-household row (mirrors the live "Share with my household" opt-in; only
               meaningful while capture is on, so it's disabled + muted when capture is off) -->
          <button type="button" class="lt__toggle lt__toggle--share" role="switch"
                  [class.is-on]="shareOn()"
                  [class.is-muted]="!captureOn()"
                  [attr.aria-checked]="shareOn()"
                  [disabled]="savingSettings() || !captureOn()"
                  (click)="toggleShare(!shareOn())">
            <span class="lt__toggle-ic" aria-hidden="true">
              <mat-icon>{{ shareOn() ? 'group' : 'group_off' }}</mat-icon>
            </span>
            <span class="lt__toggle-body">
              <span class="lt__toggle-title">Share with my household</span>
              <span class="lt__toggle-blurb">
                Let household members see your approximate city (never your precise location) next to your name.
              </span>
            </span>
            <span class="lt__switch" aria-hidden="true"><span class="lt__switch-knob"></span></span>
          </button>

          <!-- persistent permission-denied warning (not just a transient toast) -->
          @if (capture.permissionDenied()) {
            <div class="lt__warn" role="status">
              <mat-icon aria-hidden="true">gpp_bad</mat-icon>
              <span>Your browser denied the location permission. Allow it in your site settings, then try sharing again.</span>
            </div>
          }

          @if (loading()) {
            <div class="lt__list" aria-hidden="true">
              @for (n of skeletonCells; track n) {
                <app-bs-skeleton height="64px" radius="var(--r-tile)" />
              }
            </div>

          } @else if (errored()) {
            <div class="lt__state">
              <span class="lt__state-orb"><mat-icon aria-hidden="true">cloud_off</mat-icon></span>
              <h3 class="lt__state-title">Couldn't load your locations</h3>
              <p class="lt__state-body">Something went wrong fetching your history. Give it another go.</p>
              <button type="button" class="lt__state-cta" (click)="load()">
                <mat-icon aria-hidden="true">refresh</mat-icon> Try again
              </button>
            </div>

          } @else if (!history().length) {
            <div class="lt__empty">
              <span class="lt__empty-orb"><mat-icon aria-hidden="true">explore</mat-icon></span>
              <h3 class="lt__empty-title">No places yet</h3>
              <p class="lt__empty-body">
                @if (captureOn()) {
                  Tap the locate button to share where you are right now.
                } @else {
                  Enable capture above, then share your first location.
                }
              </p>
            </div>

          } @else {
            <ul class="lt__list" role="list">
              @for (f of history(); track f.id; let i = $index) {
                <li>
                  <button type="button" class="lt__row" [class.is-sel]="selectedId() === rowId(f)"
                          (click)="selectFix(rowId(f))" [attr.aria-label]="rowAria(f, i)">
                    <span class="lt__dot" [class.is-latest]="i === 0" aria-hidden="true"></span>
                    <span class="lt__row-body">
                      <span class="lt__row-place">{{ placeLabel(f) }}</span>
                      <span class="lt__row-meta">
                        {{ sourceLabel(f.source) }} · {{ timeAgo(f.capturedUtc, now()) }}
                        @if (f.accuracyM) { · ±<span class="mono-num">{{ f.accuracyM | number:'1.0-0' }}</span>m }
                      </span>
                    </span>
                    @if (i === 0) { <span class="lt__row-badge">Latest</span> }
                    <mat-icon class="lt__row-go" aria-hidden="true">north_east</mat-icon>
                  </button>
                </li>
              }
            </ul>
            <p class="lt__foot" aria-hidden="true">
              <mat-icon aria-hidden="true">layers</mat-icon> Powered by OpenStreetMap
            </p>
          }
        </div>
      </section>

      <!-- ─── SHARE-NOW FAB (docked above the sheet's peek edge via .lm-fab) ─── -->
      @if (!loading() && !errored()) {
        <app-bs-fab icon="near_me" label="Share my location" class="lm-fab"
                    [disabled]="capturing() || !captureOn()" (action)="shareNow()" />
      }
    </div>

    <!-- ─── BRANDED CLEAR-HISTORY CONFIRM SHEET (replaces the native confirm()) ─── -->
    <app-bs-sheet [(open)]="confirmOpen" detent="half" label="Clear location history">
      <div class="lc">
        <span class="lc__orb" aria-hidden="true"><mat-icon>delete_sweep</mat-icon></span>
        <h3 class="lc__title">Clear my history?</h3>
        <p class="lc__line">Permanently delete all of your recorded locations? This cannot be undone.</p>
        <div class="lc__actions">
          <button type="button" class="lc__btn lc__btn--ghost" (click)="confirmOpen.set(false)">Cancel</button>
          <button type="button" class="lc__btn lc__btn--danger" [disabled]="clearing()"
                  (click)="confirmClear()">Delete history</button>
        </div>
      </div>
    </app-bs-sheet>

    <app-bs-toaster />
  `,
  styleUrl: './locations-mobile.page.scss',
})
export class LocationsMobilePage implements OnDestroy {
  private api = inject(Api);
  private toast = inject(ToastController);
  readonly capture = inject(LocationCapture);

  readonly history = signal<LocationFix[]>([]);
  readonly loading = signal(true);
  readonly errored = signal(false);
  readonly savingSettings = signal(false);
  readonly clearing = signal(false);

  /** Which timeline row / pin is selected (recentre + highlight). Stored as the pin id (= String(fix.id)). */
  readonly selectedId = signal<string | null>(null);

  readonly now = signal(Date.now());
  readonly timeAgo = timeAgo;
  readonly skeletonCells = Array.from({ length: 4 }, (_, i) => i);

  /** Refresh relative-time labels (~every minute) so "2m ago" never freezes while the page stays open. */
  private readonly tick = setInterval(() => this.now.set(Date.now()), 60_000);

  /** The opt-in capture state (the live page's gate). */
  readonly captureOn = computed(() => !!this.capture.settings()?.locationEnabled);
  /** The "share approximate city with household" opt-in (only meaningful while capture is on). */
  readonly shareOn = computed(() => !!this.capture.settings()?.shareHousehold);
  /** Two-way open state for the branded clear-history confirm sheet. */
  readonly confirmOpen = signal(false);
  /** One-shot "share now" in-flight (from the capture service). */
  readonly capturing = this.capture.capturing;

  /** The newest fix's place label, for the hero subtitle. */
  readonly latestLabel = computed(() => {
    const f = this.history()[0];
    return f ? this.placeLabel(f) : '';
  });

  /** Map pins from the history (each fix is one pin; the newest is emphasised; the selected one too). */
  readonly pins = computed<MapPin[]>(() =>
    this.history().map((f, i) => ({
      id: String(f.id),
      lat: f.lat,
      lng: f.lng,
      title: this.placeLabel(f),
      subtitle: `${this.sourceLabel(f.source)} · ${timeAgo(f.capturedUtc, this.now())}`,
      kind: 'user' as const,
      emphasis: i === 0 || String(f.id) === this.selectedId(),
    })),
  );

  /** A single trail connecting the history points newest→oldest. */
  readonly trails = computed<MapTrail[]>(() => {
    const pts = this.history().map((f) => [f.lat, f.lng] as [number, number]);
    return pts.length > 1 ? [{ points: pts }] : [];
  });

  constructor() {
    void this.capture.refreshSettings();
    this.load();
  }

  ngOnDestroy(): void {
    clearInterval(this.tick);
  }

  // ─────────────── LOAD ───────────────

  load(): void {
    this.loading.set(true);
    this.errored.set(false);
    this.now.set(Date.now());
    this.api.myLocations(200).subscribe({
      next: (rows) => {
        this.history.set(Array.isArray(rows) ? rows : []);
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
        this.errored.set(true);
      },
    });
  }

  // ─────────────── SELECTION (timeline ↔ map) ───────────────

  /** The pin id for a fix (kept in one place so the row click + marker click agree). */
  rowId(f: LocationFix): string {
    return String(f.id);
  }

  /** Select a fix by pin id — highlights its row + emphasises its marker (the map refits on the changed set). */
  selectFix(id: string): void {
    this.selectedId.set(id);
  }

  // ─────────────── ACTIONS (reuse the live Api / capture service verbatim) ───────────────

  /** One-shot "Share current location now" — asks the browser once and records a manual fix, then reloads. */
  async shareNow(): Promise<void> {
    if (!this.captureOn()) {
      this.toast.show('Enable capture first to share your location.', { tone: 'warn' });
      return;
    }
    const city = await this.capture.captureOnce('manual');
    if (this.capture.permissionDenied()) {
      this.toast.show('Location permission was denied by your browser.', { tone: 'warn', durationMs: 4000 });
      return;
    }
    this.toast.show(city ? `Recorded — ${city}` : 'Location recorded.', { tone: 'success', durationMs: 2400 });
    this.load();
  }

  /**
   * Flip the "enable capture" opt-in. Enabling is the explicit gesture that prompts the browser for the
   * Geolocation permission (via the capture service); a denial is surfaced as a hint.
   */
  async toggleEnabled(enabled: boolean): Promise<void> {
    this.savingSettings.set(true);
    const saved = await this.capture.applySettings({ locationEnabled: enabled });
    this.savingSettings.set(false);
    if (!saved) {
      this.toast.show('Could not update the location setting.', { tone: 'warn' });
      return;
    }
    if (enabled && this.capture.permissionDenied()) {
      this.toast.show('Enabled, but your browser denied the location permission. Allow it, then tap the locate button.',
        { tone: 'warn', durationMs: 5000 });
    } else {
      this.toast.show(enabled ? 'Location enabled.' : 'Location disabled (your history is kept).',
        { tone: 'success', durationMs: 2400 });
    }
    if (enabled) this.load();
  }

  /** Flip the "share with my household" opt-in (only meaningful while capture is enabled). */
  async toggleShare(share: boolean): Promise<void> {
    if (!this.captureOn()) return;
    this.savingSettings.set(true);
    const saved = await this.capture.applySettings({ shareHousehold: share });
    this.savingSettings.set(false);
    if (!saved) {
      this.toast.show('Could not update the sharing setting.', { tone: 'warn' });
      return;
    }
    this.toast.show(share ? 'Sharing your city with household.' : 'Stopped sharing your city.',
      { tone: 'success', durationMs: 2400 });
  }

  /** Destructive: open the branded confirm sheet before clearing the caller's own history. */
  clearHistory(): void {
    if (!this.history().length || this.clearing()) return;
    this.confirmOpen.set(true);
  }

  /** Confirmed from the sheet: permanently clear the caller's own history. */
  async confirmClear(): Promise<void> {
    if (!this.history().length || this.clearing()) return;
    this.confirmOpen.set(false);
    this.clearing.set(true);
    try {
      const res = await firstValueFrom(this.api.clearMyLocations());
      this.history.set([]);
      this.selectedId.set(null);
      this.toast.show(`Cleared ${res.deleted} location${res.deleted === 1 ? '' : 's'}.`,
        { tone: 'success', durationMs: 2400 });
    } catch {
      this.toast.show('Could not clear your history.', { tone: 'warn' });
    } finally {
      this.clearing.set(false);
    }
  }

  // ─────────────── LABELS (copied from the live page) ───────────────

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

  rowAria(f: LocationFix, i: number): string {
    const when = timeAgo(f.capturedUtc, this.now());
    return `${this.placeLabel(f)}, ${this.sourceLabel(f.source)}, ${when}${i === 0 ? ', latest' : ''}. Show on map.`;
  }
}
