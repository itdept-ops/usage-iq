import {
  ChangeDetectionStrategy, Component, OnDestroy, computed, inject, signal,
} from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { MatIconModule } from '@angular/material/icon';

import { Api } from '../../core/api';
import { AdminUserLocation, LocationFix } from '../../core/models';
import { timeAgo } from '../../shared/format';
import { LocationMap, MapPin, MapTrail } from '../location/location-map';
import {
  BetaBottomSheet, BetaSkeleton, BetaToaster, ToastController,
} from '../beta-ui';

/**
 * Admin Locations — the MOBILE twin of the live `/admin/locations` oversight map, rebuilt on the shared
 * beta-ui "Strata" kit (`@use '../beta-ui/beta-kit'`) with a signature SKY → VIOLET accent. Where the live
 * desktop page is a side-by-side map + roster, the phone is a FULL-BLEED Leaflet map that owns the screen,
 * a slim floating glass header (title + a "showing everyone / one person" context chip with a back action),
 * and a draggable {@link BetaBottomSheet} that is the user PICKER: a roster of every user's latest pin
 * (tap to select), flipping to that user's recent HISTORY trail when one is chosen. A floating "People"
 * pill re-opens the sheet. Selecting from the sheet — or tapping a map pin — drives the same map filter the
 * live page uses.
 *
 * DATA PARITY + PRIVACY: it reads the SAME admin-gated `Api.adminLocations()` (GET /api/location/admin —
 * location.view-all, enforced server-side) and reuses the live page's pin/trail derivations VERBATIM.
 * Identity is userId + display name only — never an email, honouring the standing email-privacy rule even
 * on this admin surface. Precise coordinates are visible only because the endpoint is admin-gated. The
 * shared {@link LocationMap} (Leaflet via the shared lazy loader) and the machine-pin layer are reused
 * unchanged, so the fleet's IP-geo machine pins light up automatically once the backend surfaces them.
 *
 * ISOLATION: gated by `platform.mobile` on the SAME `/admin/locations` route + the SAME location.view-all.
 * It imports only the kit + the shared Api/models + the live page's LocationMap. No live page is imported
 * or modified. Deep-link `?user=123` (the link from the admin Users detail row) preselects, exactly as the
 * live page does.
 */
@Component({
  selector: 'app-admin-locations-mobile',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [ToastController],
  imports: [
    MatIconModule,
    LocationMap, BetaBottomSheet, BetaSkeleton, BetaToaster,
  ],
  template: `
    <!-- ─────────────── FULL-BLEED MAP OWNS THE SCREEN ─────────────── -->
    <div class="al-stage">
      <!-- The shared Leaflet map (lazy-loaded). Same pins/trails the live page computes. -->
      <app-location-map class="al-map" [pins]="pins()" [trails]="trails()"
                        (pinClick)="onPinClick($event)" />

      @if (loading()) {
        <!-- A soft cover while the first fetch + map tiles settle. -->
        <div class="al-cover" aria-hidden="true">
          <app-bs-skeleton width="180px" height="14px" radius="var(--r-pill)" />
        </div>
      }

      <!-- ─── SLIM FLOATING HEADER (title + context chip) ─── -->
      <header class="al-head">
        <div class="al-head__row">
          <div class="al-head__titles">
            <p class="al-head__kicker">
              <mat-icon aria-hidden="true">travel_explore</mat-icon> Oversight
            </p>
            <h1 class="al-head__title">Locations</h1>
          </div>
          @if (selected(); as sel) {
            <button type="button" class="al-back" (click)="clearSelection()"
                    aria-label="Show everyone">
              <mat-icon aria-hidden="true">arrow_back</mat-icon>
              <span>Everyone</span>
            </button>
          }
        </div>

        <!-- A live context line: who the map is currently showing. -->
        @if (!loading() && !errored()) {
          <p class="al-context">
            @if (selected(); as sel) {
              <mat-icon aria-hidden="true">person_pin_circle</mat-icon>
              Tracing <b>{{ sel.name }}</b> ·
              <span class="mono-num">{{ sel.recent.length }}</span>
              recent {{ sel.recent.length === 1 ? 'fix' : 'fixes' }}
            } @else {
              <mat-icon aria-hidden="true">groups</mat-icon>
              <span class="mono-num">{{ users().length }}</span>
              {{ users().length === 1 ? 'person' : 'people' }} ·
              latest location each
            }
          </p>
        }
      </header>

      <!-- ─── OSM attribution (mandatory) ─── -->
      <div class="al-osm" aria-hidden="false">
        <mat-icon aria-hidden="true">public</mat-icon>
        <span>Powered by
          <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a></span>
      </div>

      <!-- ─── FLOATING "People" PILL — re-opens the picker sheet ─── -->
      @if (!loading()) {
        <button type="button" class="al-fab" (click)="openSheet()"
                [attr.aria-label]="selected() ? 'Open history and people' : 'Open people'">
          <mat-icon aria-hidden="true">{{ selected() ? 'timeline' : 'people' }}</mat-icon>
          <span class="al-fab__txt">
            @if (selected(); as sel) { History }
            @else { People <span class="al-fab__n mono-num">{{ users().length }}</span> }
          </span>
        </button>
      }
    </div>

    <!-- ─────────────── PICKER / HISTORY BOTTOM SHEET ─────────────── -->
    <app-bs-sheet [(open)]="sheetOpen" detent="half"
                  [label]="selected()?.name ? selected()!.name + ' — recent history' : 'People'">
      <div class="ap">
        @if (errored()) {
          <div class="ap-state">
            <span class="ap-state__orb"><mat-icon aria-hidden="true">cloud_off</mat-icon></span>
            <h2 class="ap-state__title">Couldn't load locations</h2>
            <p class="ap-state__body">Something went wrong reaching the oversight map. Try again.</p>
            <button type="button" class="ap-state__cta" (click)="reload()">
              <mat-icon aria-hidden="true">refresh</mat-icon> Try again
            </button>
          </div>

        } @else if (loading()) {
          <div class="ap-list" aria-hidden="true">
            @for (n of skeletonCells; track n) {
              <app-bs-skeleton height="64px" radius="var(--r-tile)" />
            }
          </div>

        } @else if (selected(); as sel) {
          <!-- SELECTED USER: their recent history trail -->
          <div class="ap-head">
            <button type="button" class="ap-head__back" (click)="clearSelection()"
                    aria-label="Back to everyone">
              <mat-icon aria-hidden="true">arrow_back</mat-icon>
            </button>
            <div class="ap-head__titles">
              <h2 class="ap-head__title">{{ sel.name }}</h2>
              <span class="ap-head__sub">recent history</span>
            </div>
            <span class="ap-head__count mono-num">{{ sel.recent.length }}</span>
          </div>

          @if (sel.recent.length) {
            <ol class="ap-hist">
              @for (f of sel.recent; track f.id; let first = $first) {
                <li class="ap-hist__item" [class.is-latest]="first">
                  <span class="ap-hist__rail" aria-hidden="true">
                    <span class="ap-hist__dot"></span>
                  </span>
                  <div class="ap-hist__body">
                    <span class="ap-hist__place">{{ placeLabel(f) }}</span>
                    <span class="ap-hist__when">
                      @if (first) { <span class="ap-hist__tag">latest</span> }
                      {{ timeAgo(f.capturedUtc, now()) }}
                    </span>
                  </div>
                </li>
              }
            </ol>
          } @else {
            <div class="ap-empty">
              <span class="ap-empty__orb" aria-hidden="true">
                <mat-icon aria-hidden="true">location_off</mat-icon>
              </span>
              <p>No history for this person yet.</p>
            </div>
          }

        } @else {
          <!-- ROSTER: every user with a latest pin -->
          <div class="ap-head ap-head--roster">
            <div class="ap-head__titles">
              <h2 class="ap-head__title">People</h2>
              <span class="ap-head__sub">tap to trace someone's history</span>
            </div>
            <span class="ap-head__count mono-num">{{ users().length }}</span>
          </div>

          @if (users().length) {
            <ul class="ap-list">
              @for (u of users(); track u.userId ?? u.name) {
                <li>
                  <button type="button" class="ap-row" (click)="select(u.userId)">
                    <span class="ap-row__glyph" aria-hidden="true">
                      <mat-icon>person_pin_circle</mat-icon>
                    </span>
                    <span class="ap-row__body">
                      <span class="ap-row__name">{{ u.name }}</span>
                      <span class="ap-row__place">{{ placeLabel(u.latest) }}</span>
                    </span>
                    @if (u.latest) {
                      <span class="ap-row__when mono-num">{{ timeAgo(u.latest.capturedUtc, now()) }}</span>
                    }
                    <mat-icon class="ap-row__go" aria-hidden="true">chevron_right</mat-icon>
                  </button>
                </li>
              }
            </ul>
          } @else {
            <div class="ap-empty">
              <span class="ap-empty__orb" aria-hidden="true">
                <mat-icon aria-hidden="true">person_off</mat-icon>
              </span>
              <p>No users have recorded a location yet.</p>
            </div>
          }
        }
      </div>
    </app-bs-sheet>

    <app-bs-toaster />
  `,
  styleUrl: './admin-locations-mobile.page.scss',
})
export class AdminLocationsMobilePage implements OnDestroy {
  private api = inject(Api);
  private toast = inject(ToastController);
  private route = inject(ActivatedRoute);

  readonly users = signal<AdminUserLocation[]>([]);
  readonly loading = signal(true);
  readonly errored = signal(false);
  readonly now = signal(Date.now());
  readonly timeAgo = timeAgo;

  /** The picker / history bottom sheet open state. */
  readonly sheetOpen = signal(false);

  readonly skeletonCells = Array.from({ length: 5 }, (_, i) => i);

  /** Refresh relative-time labels (~every minute) so "when" labels never freeze on this oversight page. */
  private readonly tick = setInterval(() => this.now.set(Date.now()), 60_000);

  /** The currently-selected user id (shows their trail + history). null = show everyone's latest. */
  readonly selectedId = signal<number | null>(null);

  readonly selected = computed<AdminUserLocation | null>(() => {
    const id = this.selectedId();
    return id == null ? null : (this.users().find((u) => u.userId === id) ?? null);
  });

  /** Machine IP-geo pins — empty until the backend surfaces machine coordinates (mirrors the live page). */
  readonly machinePins = signal<MapPin[]>([]);

  /**
   * Map pins. With no user selected: every user's latest pin (plus the machine pins). With a user
   * selected: that user's recent trail of pins, emphasising the newest. Machine pins always show.
   * (Reused VERBATIM from the live admin-locations page.)
   */
  readonly pins = computed<MapPin[]>(() => {
    const sel = this.selected();
    const machine = this.machinePins();
    if (sel) {
      const userPins = sel.recent
        .filter((f) => f != null)
        .map((f, i) => this.fixToPin(sel, f, i === 0));
      return [...userPins, ...machine];
    }
    const latest = this.users()
      .map((u) => (u.latest ? this.fixToPin(u, u.latest, false) : null))
      .filter((p): p is MapPin => p != null);
    return [...latest, ...machine];
  });

  /** A trail for the selected user's recent history (oldest→newest). */
  readonly trails = computed<MapTrail[]>(() => {
    const sel = this.selected();
    if (!sel) return [];
    const pts = sel.recent.filter((f) => f != null).map((f) => [f.lat, f.lng] as [number, number]);
    return pts.length > 1 ? [{ points: pts }] : [];
  });

  constructor() {
    void this.reload();
    // Deep-link support: /admin/locations?user=123 (the link from the Users detail row) preselects.
    const q = this.route.snapshot.queryParamMap.get('user');
    if (q && !Number.isNaN(+q)) this.selectedId.set(+q);
  }

  // ─────────────── LOAD ───────────────

  async reload(): Promise<void> {
    this.loading.set(true);
    this.errored.set(false);
    this.now.set(Date.now());
    try {
      const rows = await firstValueFrom(this.api.adminLocations());
      this.users.set(rows ?? []);
    } catch {
      this.errored.set(true);
      this.toast.show('Could not load locations', { tone: 'warn' });
    } finally {
      this.loading.set(false);
    }
  }

  // ─────────────── SELECTION ───────────────

  openSheet(): void {
    this.sheetOpen.set(true);
  }

  /** Select a user (from the picker or a map pin). Clicking the selected one again clears the filter. */
  select(id: number | null | undefined): void {
    if (id == null || Number.isNaN(id)) return;
    this.selectedId.update((cur) => (cur === id ? null : id));
  }

  /** Map pin-click handler: pin ids are "u:<userId>" (user) or "m:<name>" (machine). Opens the sheet. */
  onPinClick(id: string): void {
    if (!id.startsWith('u:')) return;
    const rest = id.slice(2);
    if (rest === '') return;
    this.selectedId.set(+rest);
    this.sheetOpen.set(true);
  }

  clearSelection(): void {
    this.selectedId.set(null);
  }

  // ─────────────── helpers (mirror the live page) ───────────────

  private fixToPin(u: AdminUserLocation, f: LocationFix, emphasis: boolean): MapPin {
    return {
      id: `u:${u.userId ?? ''}`,
      lat: f.lat,
      lng: f.lng,
      title: u.name,
      subtitle: `${this.placeLabel(f)} · ${timeAgo(f.capturedUtc, this.now())}`,
      kind: 'user',
      emphasis,
    };
  }

  placeLabel(f: LocationFix | null | undefined): string {
    if (!f) return '—';
    const parts = [f.city, f.region, f.country].filter(Boolean);
    return parts.length ? parts.join(', ') : `${f.lat.toFixed(3)}, ${f.lng.toFixed(3)}`;
  }

  ngOnDestroy(): void {
    clearInterval(this.tick);
  }
}
