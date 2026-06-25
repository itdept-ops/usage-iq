import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { Api } from './api';
import { TrackerProfileDto } from './models';
import {
  UnitSystem, isImperial,
  kgToLb, lbToKg, cmToFtIn, ftInToCm,
  kmToMi, miToKm, metersToFeet, mlToFloz, flozToMl, litersToGallons, gallonsToLiters,
} from './units';

export type { UnitSystem } from './units';

/** Height as whole feet + inches (imperial display value). */
export interface FtIn { ft: number; in: number; }

/**
 * The single, app-wide source of truth for the user's metric/imperial DISPLAY preference, plus the
 * format/parse helpers every surface uses to render canonical-metric values and to read user-entered
 * values back into metric for the wire.
 *
 * CANONICAL STORE IS METRIC and never changes: weight = kg, height = cm, distance = m/km, volume = ml/L.
 * `unitSystem` is a display preference only. The raw conversion math lives in the pure, tree-shakeable
 * core/units.ts; this service holds the reactive `unitSystem` signal and exposes unit-aware methods so
 * callers stop threading an `imperial` boolean around.
 *
 * Persistence reuses the EXISTING tracker-profile surface (no new backend): {@link load} reads
 * GET /api/tracker/profile and {@link setUnitSystem} optimistically flips the signal then PUTs the
 * profile. Both are gated by the tracker permission; callers without it still get the default ('Metric')
 * and live conversions — they simply can't persist a change (setUnitSystem swallows the error and keeps
 * the optimistic value for the session).
 */
@Injectable({ providedIn: 'root' })
export class UnitService {
  private api = inject(Api);

  /** Backend default for an un-set profile (TrackerProfile.UnitSystem defaults to Metric). */
  private static readonly DEFAULT: UnitSystem = 'Metric';

  private readonly _unitSystem = signal<UnitSystem>(UnitService.DEFAULT);

  /** The user's current display unit system. Reactive — read this everywhere instead of a local flag. */
  readonly unitSystem = this._unitSystem.asReadonly();

  /** True when the user prefers Imperial. */
  readonly imperial = computed(() => isImperial(this._unitSystem()));

  /** True once {@link load} has completed at least once (so callers can avoid a default-flash). */
  readonly loaded = signal(false);

  // ── load / persist ──────────────────────────────────────────────────────────

  /**
   * Load the user's unit preference once (typically at bootstrap) from the existing tracker-profile
   * endpoint. Safe to call when the caller lacks the tracker permission — it just leaves the default in
   * place. Idempotent; never throws.
   */
  async load(): Promise<void> {
    try {
      const profile = await firstValueFrom(this.api.trackerProfile());
      if (profile?.unitSystem) this._unitSystem.set(profile.unitSystem);
    } catch {
      /* no tracker permission / not signed in / offline — keep the default */
    } finally {
      this.loaded.set(true);
    }
  }

  /** Set the signal directly WITHOUT persisting (e.g. seeding from an already-loaded TrackerDayDto). */
  setLocal(system: UnitSystem): void {
    this._unitSystem.set(system);
    this.loaded.set(true);
  }

  /**
   * Switch the user's unit system: optimistically updates the signal, then persists by PUTting the
   * current tracker profile with the new unitSystem (reuses GET-then-PUT so we don't clobber other
   * profile fields). On persist failure the OPTIMISTIC value is kept for the session (so the UI stays
   * consistent) and the error is returned to the caller to surface if it wants. Returns true if persisted.
   */
  async setUnitSystem(system: UnitSystem): Promise<boolean> {
    if (system === this._unitSystem()) return true;
    this._unitSystem.set(system);
    try {
      const profile = await firstValueFrom(this.api.trackerProfile());
      const next: TrackerProfileDto = { ...profile, unitSystem: system };
      await firstValueFrom(this.api.saveTrackerProfile(next));
      return true;
    } catch {
      // Keep the optimistic signal — the preference still applies for this session.
      return false;
    }
  }

  // ── weight: canonical kg ────────────────────────────────────────────────────

  /** Weight unit label for the active system. */
  weightUnit(): string { return this.imperial() ? 'lb' : 'kg'; }

  /** A canonical kg weight as the numeric value in the user's unit (no suffix). */
  weightToDisplay(kg: number): number {
    return this.imperial() ? kgToLb(kg) : kg;
  }

  /** A user-entered weight (in the user's unit) back to canonical kg for storage. */
  weightToCanonical(value: number): number {
    return this.imperial() ? lbToKg(value) : value;
  }

  /** Format a canonical kg weight for display, e.g. "75.0 kg" / "165.3 lb". */
  formatWeight(kg: number | null | undefined, dp = 1): string | null {
    if (kg == null) return null;
    return `${this.weightToDisplay(kg).toFixed(dp)} ${this.weightUnit()}`;
  }

  // ── height: canonical cm ────────────────────────────────────────────────────

  /** A canonical cm height as feet+inches (for the imperial editor). */
  heightToFtIn(cm: number): FtIn { return cmToFtIn(cm); }

  /** Feet+inches back to canonical cm for storage. */
  heightFromFtIn(ft: number, inches: number): number { return ftInToCm(ft, inches); }

  /** Format a canonical cm height, e.g. "180 cm" / "5'11"". */
  formatHeight(cm: number | null | undefined): string | null {
    if (cm == null) return null;
    if (this.imperial()) {
      const { ft, in: inches } = cmToFtIn(cm);
      return `${ft}'${inches}"`;
    }
    return `${Math.round(cm)} cm`;
  }

  // ── distance: canonical km (use *Meters helpers for metre-based fields) ──────

  /** Distance unit label for the active system. */
  distanceUnit(): string { return this.imperial() ? 'mi' : 'km'; }

  /** A canonical km distance as the numeric value in the user's unit (mi or km). */
  distanceToDisplay(km: number): number {
    return this.imperial() ? kmToMi(km) : km;
  }

  /** A user-entered distance (mi or km) back to canonical km for storage. */
  distanceToCanonical(value: number): number {
    return this.imperial() ? miToKm(value) : value;
  }

  /** Format a canonical km distance, e.g. "5.1 km" / "3.2 mi". */
  formatDistance(km: number | null | undefined, dp = 1): string | null {
    if (km == null) return null;
    return `${this.distanceToDisplay(km).toFixed(dp)} ${this.distanceUnit()}`;
  }

  /**
   * Format a canonical METRES distance (the wire uses metres on watch-activity rows), e.g.
   * "5.1 km" / "3.2 mi". Convenience wrapper over {@link formatDistance}.
   */
  formatDistanceMeters(meters: number | null | undefined, dp = 1): string | null {
    if (meters == null) return null;
    return this.formatDistance(meters / 1000, dp);
  }

  /**
   * Format a SMALL metre-scale distance at metre/foot resolution (e.g. GPS accuracy of a few metres),
   * where the km/mi scale of {@link formatDistanceMeters} would collapse to "0.0 km". Metric rounds to
   * whole metres ("8 m"); imperial converts to whole feet ("26 ft"). No "±" prefix — callers add it.
   * Returns null for null/undefined/non-finite input.
   */
  formatSmallDistance(meters: number | null | undefined): string | null {
    if (meters == null || !Number.isFinite(meters)) return null;
    return this.imperial()
      ? `${Math.round(metersToFeet(meters))} ft`
      : `${Math.round(meters)} m`;
  }

  // ── volume: canonical ml (small) / L (large) ────────────────────────────────

  /** Small-volume (hydration) unit label for the active system. */
  volumeUnit(): string { return this.imperial() ? 'fl oz' : 'ml'; }

  /** Large-volume unit label for the active system. */
  largeVolumeUnit(): string { return this.imperial() ? 'gal' : 'L'; }

  /** A canonical ml volume as the numeric value in the user's small-volume unit (fl oz or ml). */
  volumeToDisplay(ml: number): number {
    return this.imperial() ? mlToFloz(ml) : ml;
  }

  /** A user-entered small volume (fl oz or ml) back to canonical ml for storage. */
  volumeToCanonical(value: number): number {
    return this.imperial() ? flozToMl(value) : value;
  }

  /** A canonical litre volume as the numeric value in the user's large-volume unit (gal or L). */
  largeVolumeToDisplay(liters: number): number {
    return this.imperial() ? litersToGallons(liters) : liters;
  }

  /** A user-entered large volume (gal or L) back to canonical litres for storage. */
  largeVolumeToCanonical(value: number): number {
    return this.imperial() ? gallonsToLiters(value) : value;
  }

  /** Format a canonical ml volume, e.g. "750 ml" / "25 fl oz". */
  formatVolume(ml: number | null | undefined): string | null {
    if (ml == null) return null;
    return this.imperial()
      ? `${Math.round(mlToFloz(ml))} fl oz`
      : `${Math.round(ml)} ml`;
  }

  /** Format a canonical litre volume, e.g. "3.8 L" / "1.0 gal". */
  formatLargeVolume(liters: number | null | undefined, dp = 1): string | null {
    if (liters == null) return null;
    return this.imperial()
      ? `${litersToGallons(liters).toFixed(dp)} gal`
      : `${liters.toFixed(dp)} L`;
  }
}
