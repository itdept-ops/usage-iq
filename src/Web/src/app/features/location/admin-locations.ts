import { CommonModule } from '@angular/common';
import { Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';

import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';

import { Api } from '../../core/api';
import { AdminUserLocation, LocationFix } from '../../core/models';
import { timeAgo } from '../../shared/format';
import { LocationMap, MapPin, MapTrail } from './location-map';

/**
 * Admin Locations (gated location.view-all) — admin oversight of WHERE users have been. A Leaflet/OSM map
 * shows every user's LATEST pin; selecting a user (from the map or the side list) reveals their recent
 * history trail + per-fix list. Identity is userId+name (never email), honouring the standing
 * email-privacy rule even on this admin-gated page.
 *
 * FLEET MACHINE PINS: the design also calls for the fleet's IP-geo'd machines on this map (a distinct
 * marker), since desktops have no GPS and their "location" is the city of their public IP. The backend
 * MachineInfo entity already stores Lat/Lng (IP-geo of PublicIp), but the current GET /api/location/admin
 * contract returns USER locations only — there is no machine-geo field on the wire yet. The map + side
 * list below are already wired to render machine pins (see `machinePins`); they light up automatically
 * once the admin endpoint (or a sibling machines-geo endpoint) surfaces those coordinates. Until then the
 * machine layer is simply empty (graceful-null) rather than calling an endpoint that doesn't exist.
 */
@Component({
  selector: 'app-admin-locations',
  standalone: true,
  imports: [
    CommonModule, MatButtonModule, MatIconModule, MatProgressBarModule,
    MatSnackBarModule, LocationMap,
  ],
  templateUrl: './admin-locations.html',
  styleUrl: './admin-locations.scss',
})
export class AdminLocations implements OnDestroy {
  private api = inject(Api);
  private snack = inject(MatSnackBar);
  private route = inject(ActivatedRoute);

  readonly users = signal<AdminUserLocation[]>([]);
  readonly loading = signal(true);
  readonly now = signal(Date.now());
  readonly timeAgo = timeAgo;

  /** Refresh relative-time labels (~every minute) so roster "when" labels never freeze on this oversight page. */
  private readonly tick = setInterval(() => this.now.set(Date.now()), 60_000);

  /** The currently-selected user id (shows their trail + history). null = show everyone's latest. */
  readonly selectedId = signal<number | null>(null);

  readonly selected = computed<AdminUserLocation | null>(() => {
    const id = this.selectedId();
    return id == null ? null : this.users().find(u => u.userId === id) ?? null;
  });

  /** Machine IP-geo pins — empty until the backend surfaces machine coordinates (see class comment). */
  readonly machinePins = signal<MapPin[]>([]);

  /**
   * Map pins. With no user selected: every user's latest pin (plus the machine pins). With a user
   * selected: that user's recent trail of pins, emphasising the newest. Machine pins always show.
   */
  readonly pins = computed<MapPin[]>(() => {
    const sel = this.selected();
    const machine = this.machinePins();
    if (sel) {
      const userPins = sel.recent
        .filter(f => f != null)
        .map((f, i) => this.fixToPin(sel, f, i === 0));
      return [...userPins, ...machine];
    }
    const latest = this.users()
      .map(u => u.latest ? this.fixToPin(u, u.latest, false) : null)
      .filter((p): p is MapPin => p != null);
    return [...latest, ...machine];
  });

  /** A trail for the selected user's recent history (oldest→newest). */
  readonly trails = computed<MapTrail[]>(() => {
    const sel = this.selected();
    if (!sel) return [];
    const pts = sel.recent.filter(f => f != null).map(f => [f.lat, f.lng] as [number, number]);
    return pts.length > 1 ? [{ points: pts }] : [];
  });

  constructor() {
    this.load();
    // Deep-link support: /admin/locations?user=123 (the link from the Users detail row) preselects.
    const q = this.route.snapshot.queryParamMap.get('user');
    if (q && !Number.isNaN(+q)) this.selectedId.set(+q);
  }

  private load(): void {
    this.loading.set(true);
    this.now.set(Date.now());
    this.api.adminLocations().subscribe({
      next: rows => { this.users.set(rows); this.loading.set(false); },
      error: () => { this.loading.set(false); this.snack.open('Could not load locations', 'Dismiss', { duration: 4000 }); },
    });
  }

  /** Select a user (from the side list or a map pin). Clicking the selected one again clears the filter. */
  select(id: number | null | undefined): void {
    if (id == null || Number.isNaN(id)) return;
    this.selectedId.update(cur => (cur === id ? null : id));
  }

  /** Map pin-click handler: pin ids are "u:<userId>" (user) or "m:<name>" (machine). */
  onPinClick(id: string): void {
    if (!id.startsWith('u:')) return;
    const rest = id.slice(2);
    if (rest === '') return;
    this.select(+rest);
  }

  clearSelection(): void { this.selectedId.set(null); }

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
