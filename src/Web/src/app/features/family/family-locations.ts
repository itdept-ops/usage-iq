import { CommonModule } from '@angular/common';
import {
  Component,
  computed,
  inject,
  OnDestroy,
  signal,
  ChangeDetectionStrategy,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';

import { Api } from '../../core/api';
import { FamilyMemberHistory, FamilyMemberLocation } from '../../core/models';
import { timeAgo } from '../../shared/format';
import { LocationMap, MapPin } from '../location/location-map';
import { ReplayEngine } from './replay-engine';

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
    CommonModule,
    FormsModule,
    RouterLink,
    MatButtonModule,
    MatIconModule,
    MatTooltipModule,
    MatProgressBarModule,
    MatSnackBarModule,
    LocationMap,
  ],
  templateUrl: './family-locations.html',
  changeDetection: ChangeDetectionStrategy.Eager,
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
    '#3fd8d0',
    '#8b7cff',
    '#f0a020',
    '#ef5d8f',
    '#5b8def',
    '#5bbf6a',
    '#d98b3f',
    '#b06be0',
  ];

  /** The currently-focused member id (clicking a list row or a pin highlights it). null = show all. */
  readonly selectedId = signal<number | null>(null);

  /** One map pin per member; the caller (and any selected member) is emphasised. */
  readonly livePins = computed<MapPin[]>(() => {
    const sel = this.selectedId();
    return this.members().map((m) => ({
      id: `u:${m.userId}`,
      lat: m.lat,
      lng: m.lng,
      title: m.isSelf ? `${m.name} (you)` : m.name,
      subtitle: `${this.placeLabel(m)} · ${timeAgo(m.capturedUtc, this.now())}`,
      kind: 'user' as const,
      emphasis: m.isSelf || m.userId === sel,
    }));
  });

  // ───────────────────────── REPLAY ─────────────────────────
  /** Which mode the map is in. `live` (default) = current positions; `replay` = the time-scrubber. */
  readonly mode = signal<'live' | 'replay'>('live');
  /** The shared engine that turns the bounded history into interpolated pins + fading trails. */
  readonly replay = new ReplayEngine();
  /** Replay fetch lifecycle (separate from the live load above). */
  readonly replayLoading = signal(false);
  readonly replayError = signal(false);
  /** The chosen window length in hours (within the server's 48h cap). Default = last 24h. */
  readonly windowHours = signal(24);
  /** Speed multiplier options for playback (× real time). */
  readonly speedOptions = [30, 60, 120, 300];
  /** True when the user/OS prefers reduced motion — disables auto-play; scrubber + step stay available. */
  readonly reducedMotion = signal(
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches,
  );

  /** What the map actually draws: live pins, or the replay's interpolated pins. */
  readonly mapPins = computed<MapPin[]>(() =>
    this.mode() === 'replay' ? this.replay.pins() : this.livePins(),
  );

  /** rAF handle + last frame timestamp for the playback loop (host-owned so cleanup is guaranteed). */
  private rafId: number | null = null;
  private lastFrame = 0;

  constructor() {
    this.load();
    this.clockTimer = setInterval(() => this.now.set(Date.now()), FamilyLocations.CLOCK_MS);
  }

  ngOnDestroy(): void {
    if (this.clockTimer) {
      clearInterval(this.clockTimer);
      this.clockTimer = null;
    }
    this.stopLoop();
  }

  /** Switch between the live finder and the replay scrubber (lazily fetching history the first time). */
  setMode(mode: 'live' | 'replay'): void {
    if (mode === this.mode()) return;
    this.mode.set(mode);
    if (mode === 'replay') {
      this.loadReplay();
    } else {
      this.replay.pause();
      this.stopLoop();
    }
  }

  /** Fetch the bounded history for the chosen window and hand it to the engine. */
  loadReplay(): void {
    this.replayLoading.set(true);
    this.replayError.set(false);
    this.replay.pause();
    this.stopLoop();
    const to = new Date();
    const from = new Date(to.getTime() - this.windowHours() * 60 * 60 * 1000);
    this.api.familyLocationHistory(from.toISOString(), to.toISOString()).subscribe({
      next: (rows: FamilyMemberHistory[]) => {
        this.replay.setHistory(rows ?? []);
        this.replayLoading.set(false);
      },
      error: () => {
        this.replayLoading.set(false);
        this.replayError.set(true);
        this.snack.open('Could not load location history', 'Dismiss', { duration: 4000 });
      },
    });
  }

  /** Change the replay window length and refetch. */
  setWindowHours(hours: number): void {
    this.windowHours.set(hours);
    this.loadReplay();
  }

  /** Play/pause toggle (drives the rAF loop). */
  togglePlay(): void {
    this.replay.toggle();
    if (this.replay.playing()) this.startLoop();
    else this.stopLoop();
  }

  /** Slider input handler: scrub to a 0..1 fraction (pauses playback while dragging). */
  onScrub(fraction: number): void {
    this.replay.pause();
    this.stopLoop();
    this.replay.seekFraction(fraction);
  }

  /** Step the scrub time by a signed number of minutes (the reduced-motion / fine-control buttons). */
  stepMinutes(minutes: number): void {
    this.stopLoop();
    this.replay.step(minutes);
  }

  setSpeed(mult: number): void {
    this.replay.setSpeed(mult);
  }

  /** Start the single rAF loop that advances the engine by real elapsed time. */
  private startLoop(): void {
    if (this.rafId != null) return;
    this.lastFrame = performance.now();
    const tick = (ts: number) => {
      const dt = ts - this.lastFrame;
      this.lastFrame = ts;
      this.replay.advance(dt);
      if (this.replay.playing()) {
        this.rafId = requestAnimationFrame(tick);
      } else {
        this.rafId = null; // engine auto-paused at the end
      }
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private stopLoop(): void {
    if (this.rafId != null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private load(): void {
    this.loading.set(true);
    this.error.set(false);
    this.now.set(Date.now());
    this.api.familyLocations().subscribe({
      next: (rows) => {
        this.members.set(rows);
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
        this.error.set(true);
        this.snack.open('Could not load family locations', 'Dismiss', { duration: 4000 });
      },
    });
  }

  /** Re-fetch (and refresh the "as of" clock). */
  refresh(): void {
    this.load();
  }

  /** Focus a member from the side list or a pin click; clicking the focused one again clears it. */
  select(userId: number): void {
    this.selectedId.update((cur) => (cur === userId ? null : userId));
  }

  /** Map pin-click handler: pin ids are "u:<userId>". */
  onPinClick(id: string): void {
    if (id.startsWith('u:')) this.select(+id.slice(2));
  }

  /** A stable accent colour for a member's list swatch. */
  colorFor(m: FamilyMemberLocation): string {
    const i =
      ((m.userId % FamilyLocations.PALETTE.length) + FamilyLocations.PALETTE.length) %
      FamilyLocations.PALETTE.length;
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
