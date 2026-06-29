import { computed, signal, Signal } from '@angular/core';

import { FamilyMemberHistory, LocationHistoryPoint } from '../../core/models';
import { MapPin, MapTrail } from '../location/location-map';

/**
 * The interpolated state of one member at the current replay instant: their marker position (linearly
 * interpolated between the two bracketing fixes) and the slice of their track up to "now" (the fading
 * trail). `present` is false before a member's first fix in the window — we then hide the marker rather
 * than pinning it to a stale start.
 */
export interface ReplayMemberState {
  userId: number;
  name: string;
  isSelf: boolean;
  color: string;
  /** True once the scrub time has reached this member's first fix in the window. */
  present: boolean;
  /** Interpolated position at the scrub time (only meaningful when `present`). */
  lat: number;
  lng: number;
  /** The member's fixes from window-start up to the scrub time (oldest→newest) — the trail so far. */
  trail: [number, number][];
}

/**
 * A framework-light, signal-based engine that drives the family-map REPLAY for BOTH the desktop page and
 * its mobile twin (one implementation, identical behaviour). It owns NO Leaflet/DOM and makes NO HTTP
 * calls — the page fetches {@link FamilyMemberHistory} via the existing `familyLocationHistory()` API and
 * hands the rows in via {@link setHistory}; the page renders the derived {@link pins}/{@link trails}.
 *
 * What it computes from the rows:
 *  - the window span (min→max captured time across all members' downsampled points);
 *  - per-member INTERPOLATED position at the current scrub time `t` (linear between the two bracketing
 *    fixes), plus the fading trail (each member's fixes from window-start up to `t`);
 *  - a deterministic per-member colour (matches the live finder's palette by userId).
 *
 * Playback: {@link play}/{@link pause}/{@link toggle}, a {@link speed} multiplier, and {@link seek}/
 * {@link seekFraction}/{@link step}. The engine does NOT own a timer — the host page drives it from a
 * single requestAnimationFrame loop by calling {@link advance}(dtMs), so the host fully controls
 * start/stop and cleanup (and can decline to auto-advance under prefers-reduced-motion: the scrubber +
 * step buttons still work). Playing past the end auto-pauses at the end.
 *
 * PRIVACY: it only ever sees what the server already scoped + opt-in-gated + name-only — it surfaces
 * `name` (never an email) and trusts the server's household/opt-in filtering; it adds no data.
 */
export class ReplayEngine {
  /** The live finder's palette (kept identical so a member reads the same colour in both modes). */
  static readonly PALETTE = [
    '#3fd8d0', '#8b7cff', '#f0a020', '#ef5d8f',
    '#5b8def', '#5bbf6a', '#d98b3f', '#b06be0',
  ];

  /** How much of the recent track to keep visible as the fading trail (ms behind the scrub time). */
  private static readonly TRAIL_TAIL_MS = 90 * 60 * 1000; // 90 minutes

  private readonly _history = signal<FamilyMemberHistory[]>([]);
  /** Current scrub time (epoch ms). Clamped to [start, end]. */
  private readonly _t = signal(0);
  private readonly _playing = signal(false);
  private readonly _speed = signal(60); // 60× real time by default (1 min of history per playback second)

  /** The members in this replay (only those with ≥1 point in the window), with their colour. */
  readonly members = computed(() =>
    this._history()
      .filter((m) => m.points.length > 0)
      .map((m) => ({ userId: m.userId, name: m.name, isSelf: m.isSelf, color: ReplayEngine.colorFor(m.userId) })),
  );

  /** Whether there's anything to replay (≥1 member with ≥1 fix in the window). */
  readonly hasData = computed(() => this.members().length > 0);

  /** Window start (epoch ms) — the earliest fix across all members; 0 when empty. */
  readonly start = computed(() => this.span().start);
  /** Window end (epoch ms) — the latest fix across all members; 0 when empty. */
  readonly end = computed(() => this.span().end);

  /** Current scrub time (epoch ms). */
  readonly t: Signal<number> = this._t.asReadonly();
  readonly playing: Signal<boolean> = this._playing.asReadonly();
  readonly speed: Signal<number> = this._speed.asReadonly();

  /** Scrub position as a 0..1 fraction of the window (drives the slider). */
  readonly fraction = computed(() => {
    const { start, end } = this.span();
    if (end <= start) return 0;
    return (this._t() - start) / (end - start);
  });

  /** True when the scrub time is at (or past) the window end. */
  readonly atEnd = computed(() => this._t() >= this.span().end);

  /** Per-member interpolated state at the current scrub time. */
  readonly states = computed<ReplayMemberState[]>(() => {
    const t = this._t();
    return this._history()
      .filter((m) => m.points.length > 0)
      .map((m) => this.stateAt(m, t));
  });

  /** One map pin per PRESENT member at the scrub time (absent members are dropped, not pinned to a stale start). */
  readonly pins = computed<MapPin[]>(() =>
    this.states()
      .filter((s) => s.present)
      .map((s) => ({
        id: `u:${s.userId}`,
        lat: s.lat,
        lng: s.lng,
        title: s.isSelf ? `${s.name} (you)` : s.name,
        kind: 'user' as const,
        emphasis: s.isSelf,
      })),
  );

  /** One fading trail polyline per member (their fixes up to the scrub time), in the member's colour. */
  readonly trails = computed<MapTrail[]>(() =>
    this.states()
      .filter((s) => s.trail.length > 1)
      .map((s) => ({ points: s.trail, color: s.color, opacity: 0.55, weight: 3 })),
  );

  /** A short clock label for the current scrub time (local time; or em-dash when empty). */
  readonly clockLabel = computed(() => {
    if (!this.hasData()) return '—';
    return new Date(this._t()).toLocaleString(undefined, {
      weekday: 'short', hour: '2-digit', minute: '2-digit',
    });
  });

  /** The deterministic per-member colour (same mapping as the live finder). */
  static colorFor(userId: number): string {
    const len = ReplayEngine.PALETTE.length;
    return ReplayEngine.PALETTE[((userId % len) + len) % len];
  }

  /** Load a fresh history payload; resets the scrub to the window start. */
  setHistory(rows: FamilyMemberHistory[]): void {
    this._playing.set(false);
    this._history.set(rows ?? []);
    this._t.set(this.span().start);
  }

  /** Window span across all members' points (memoised via computed below). */
  private readonly span = computed(() => {
    let start = Number.POSITIVE_INFINITY;
    let end = Number.NEGATIVE_INFINITY;
    for (const m of this._history()) {
      for (const p of m.points) {
        const ms = new Date(p.capturedUtc).getTime();
        if (ms < start) start = ms;
        if (ms > end) end = ms;
      }
    }
    if (!Number.isFinite(start) || !Number.isFinite(end)) return { start: 0, end: 0 };
    return { start, end };
  });

  setSpeed(mult: number): void {
    this._speed.set(Math.max(1, mult));
  }

  play(): void {
    if (!this.hasData()) return;
    // Restart from the beginning if we're sitting at the end.
    if (this.atEnd()) this._t.set(this.span().start);
    this._playing.set(true);
  }

  pause(): void {
    this._playing.set(false);
  }

  toggle(): void {
    this._playing() ? this.pause() : this.play();
  }

  /** Seek to an absolute epoch-ms time (clamped to the window). Pauses-implicitly is the caller's choice. */
  seek(ms: number): void {
    const { start, end } = this.span();
    this._t.set(Math.min(end, Math.max(start, ms)));
  }

  /** Seek to a 0..1 fraction of the window (the slider handler). */
  seekFraction(frac: number): void {
    const { start, end } = this.span();
    this._t.set(start + Math.min(1, Math.max(0, frac)) * (end - start));
  }

  /** Nudge the scrub time by a signed number of minutes (the step buttons; also used under reduced-motion). */
  step(minutes: number): void {
    this.pause();
    this.seek(this._t() + minutes * 60 * 1000);
  }

  /**
   * Advance playback by `dtMs` of REAL time (called from the host's rAF loop). Applies the speed
   * multiplier; auto-pauses on reaching the end. No-op when paused or empty.
   */
  advance(dtMs: number): void {
    if (!this._playing() || !this.hasData()) return;
    const { end } = this.span();
    const next = this._t() + dtMs * this._speed();
    if (next >= end) {
      this._t.set(end);
      this._playing.set(false);
    } else {
      this._t.set(next);
    }
  }

  /** Interpolate one member's position + trail at time `t`. */
  private stateAt(m: FamilyMemberHistory, t: number): ReplayMemberState {
    const pts = m.points;
    const base: ReplayMemberState = {
      userId: m.userId, name: m.name, isSelf: m.isSelf,
      color: ReplayEngine.colorFor(m.userId), present: false, lat: 0, lng: 0, trail: [],
    };
    const first = new Date(pts[0].capturedUtc).getTime();
    if (t < first) return base; // not present yet

    // Find the bracketing pair [a,b] with a.time <= t <= b.time (linear scan; ≤300 pts/member).
    let a: LocationHistoryPoint = pts[0];
    let b: LocationHistoryPoint = pts[0];
    for (let i = 0; i < pts.length; i++) {
      const ms = new Date(pts[i].capturedUtc).getTime();
      if (ms <= t) {
        a = pts[i];
        b = pts[i];
      } else {
        b = pts[i];
        break;
      }
    }
    const aMs = new Date(a.capturedUtc).getTime();
    const bMs = new Date(b.capturedUtc).getTime();
    let lat = a.lat;
    let lng = a.lng;
    if (bMs > aMs && t > aMs) {
      const f = Math.min(1, (t - aMs) / (bMs - aMs));
      lat = a.lat + (b.lat - a.lat) * f;
      lng = a.lng + (b.lng - a.lng) * f;
    }

    // Trail: fixes from (t - tail) up to t, plus the live interpolated head.
    const tailStart = t - ReplayEngine.TRAIL_TAIL_MS;
    const trail: [number, number][] = [];
    for (const p of pts) {
      const ms = new Date(p.capturedUtc).getTime();
      if (ms > t) break;
      if (ms >= tailStart) trail.push([p.lat, p.lng]);
    }
    trail.push([lat, lng]);

    return { ...base, present: true, lat, lng, trail };
  }
}
