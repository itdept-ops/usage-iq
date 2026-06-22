import { CommonModule } from '@angular/common';
import { Component, computed, inject, OnDestroy, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';

import { Api } from '../../core/api';
import { FamilyMemberLocation } from '../../core/models';
import { timeAgo } from '../../shared/format';
import { LocationMap, MapPin } from '../location/location-map';

/**
 * "Where is everyone" — the family-finder map (gated family.use via the /family route group). A Leaflet/OSM
 * map (the shared app-location-map) drops one pin per opted-in household member, plus a side LIST: name,
 * city, "as of <relative time>", and a muted "stale" badge when the pin is older than a few hours. The
 * caller's own pin is always present and visually distinguished ("You").
 *
 * PRIVACY: this never addresses another household — the server (GET /api/family/locations) resolves the
 * caller's own household and only surfaces members who opted into household sharing AND have a recent fix.
 * Identity on the wire is userId + display name only; no email is ever rendered. When nobody has shared
 * yet, a friendly empty state points members at their My-locations page to opt in.
 */
@Component({
  selector: 'app-family-locations',
  standalone: true,
  imports: [
    CommonModule, RouterLink, MatButtonModule, MatIconModule, MatTooltipModule, MatProgressBarModule,
    MatSnackBarModule, LocationMap,
  ],
  templateUrl: './family-locations.html',
  styleUrls: ['./family.scss', './family-locations.scss'],
})
export class FamilyLocations implements OnDestroy {
  private api = inject(Api);
  private snack = inject(MatSnackBar);

  /** Advances now() while the view is alive so "as of" times and the stale badge don't freeze. */
  private clockTimer: ReturnType<typeof setInterval> | null = null;
  /** How often the relative-time clock ticks (60s is plenty for "Xm ago" granularity). */
  private static readonly CLOCK_MS = 60_000;

  readonly members = signal<FamilyMemberLocation[]>([]);
  readonly loading = signal(true);
  readonly error = signal(false);
  readonly now = signal(Date.now());
  readonly timeAgo = timeAgo;

  /** How old a pin may be before we flag it muted-"stale" in the list (a few hours). */
  private static readonly STALE_MS = 3 * 60 * 60 * 1000;

  /** A small palette so each member reads apart in the list (deterministic by userId). */
  private static readonly PALETTE = [
    '#3fd8d0', '#8b7cff', '#f0a020', '#ef5d8f', '#5b8def', '#5bbf6a', '#d98b3f', '#b06be0',
  ];

  /** The currently-focused member id (clicking a list row or a pin highlights it). null = show all. */
  readonly selectedId = signal<number | null>(null);

  /** One map pin per member; the caller (and any selected member) is emphasised. */
  readonly pins = computed<MapPin[]>(() => {
    const sel = this.selectedId();
    return this.members().map(m => ({
      id: `u:${m.userId}`,
      lat: m.lat,
      lng: m.lng,
      title: m.isSelf ? `${m.name} (you)` : m.name,
      subtitle: `${this.placeLabel(m)} · ${timeAgo(m.capturedUtc, this.now())}`,
      kind: 'user' as const,
      emphasis: m.isSelf || m.userId === sel,
    }));
  });

  constructor() {
    this.load();
    this.clockTimer = setInterval(() => this.now.set(Date.now()), FamilyLocations.CLOCK_MS);
  }

  ngOnDestroy(): void {
    if (this.clockTimer) { clearInterval(this.clockTimer); this.clockTimer = null; }
  }

  private load(): void {
    this.loading.set(true);
    this.error.set(false);
    this.now.set(Date.now());
    this.api.familyLocations().subscribe({
      next: rows => { this.members.set(rows); this.loading.set(false); },
      error: () => {
        this.loading.set(false);
        this.error.set(true);
        this.snack.open('Could not load family locations', 'Dismiss', { duration: 4000 });
      },
    });
  }

  /** Re-fetch (and refresh the "as of" clock). */
  refresh(): void { this.load(); }

  /** Focus a member from the side list or a pin click; clicking the focused one again clears it. */
  select(userId: number): void {
    this.selectedId.update(cur => (cur === userId ? null : userId));
  }

  /** Map pin-click handler: pin ids are "u:<userId>". */
  onPinClick(id: string): void {
    if (id.startsWith('u:')) this.select(+id.slice(2));
  }

  /** A stable accent colour for a member's list swatch. */
  colorFor(m: FamilyMemberLocation): string {
    const i = ((m.userId % FamilyLocations.PALETTE.length) + FamilyLocations.PALETTE.length)
      % FamilyLocations.PALETTE.length;
    return FamilyLocations.PALETTE[i];
  }

  /** Two-letter initials for the swatch label (display name only; never an email). */
  initials(name: string): string {
    const parts = (name || '').split(/\s+/).filter(Boolean);
    return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
  }

  /** City-first place label, falling back to coarse coords if the fix wasn't reverse-geocoded. */
  placeLabel(m: FamilyMemberLocation): string {
    const parts = [m.city, m.region, m.country].filter(Boolean);
    return parts.length ? parts.join(', ') : `${m.lat.toFixed(3)}, ${m.lng.toFixed(3)}`;
  }

  /** True when a member's latest fix is older than the stale window (drives the muted "stale" hint). */
  isStale(m: FamilyMemberLocation): boolean {
    return this.now() - new Date(m.capturedUtc).getTime() > FamilyLocations.STALE_MS;
  }
}
