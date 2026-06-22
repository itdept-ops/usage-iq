import { Injectable, inject, signal } from '@angular/core';
import { catchError, firstValueFrom, of } from 'rxjs';

import { Api } from './api';
import { AuthService } from './auth';
import { LocationSettings, LocationSource, PERM } from './models';

/**
 * Browser-geolocation capture, PRIVACY-FIRST.
 *
 * Hard rules (all enforced here, with the server as the backstop):
 *  - NEVER touches navigator.geolocation, and never POSTs a fix, unless the caller holds `location.self`
 *    AND has explicitly enabled capture (LocationSettings.locationEnabled). Capture is OPT-IN; disabled
 *    is the default and the silent state.
 *  - A permission-DENIED from the browser flips `permissionDenied` and STOPS — we never re-prompt in a
 *    loop. The Location settings UI surfaces the hint and leaves the toggle for the user to retry.
 *  - The periodic timer only runs while a tab is open and only while still enabled; it self-cancels on
 *    sign-out / disable.
 *
 * The one-shot path (manual "share now" + login + each periodic tick) calls the browser once with a
 * sensible timeout, then POSTs source-tagged coordinates. All failures are swallowed (location is a
 * best-effort nicety, never blocking).
 */
@Injectable({ providedIn: 'root' })
export class LocationCapture {
  private api = inject(Api);
  private auth = inject(AuthService);

  /** Last-known opt-in settings (null until first read). Exposed so the settings page can share state. */
  readonly settings = signal<LocationSettings | null>(null);

  /** True once the browser refused the Geolocation permission — the UI shows a hint and stops capturing. */
  readonly permissionDenied = signal(false);

  /** True while a one-shot fix is in flight (so the "share now" button can show progress). */
  readonly capturing = signal(false);

  private periodicTimer: ReturnType<typeof setInterval> | null = null;

  /** Capture cadence while a tab stays open. Five minutes balances freshness against battery/privacy. */
  private static readonly PERIODIC_MS = 5 * 60 * 1000;

  /** Browser geolocation options: a single fix, moderate timeout, accept a cached fix up to a minute old. */
  private static readonly GEO_OPTS: PositionOptions = {
    enableHighAccuracy: false,
    timeout: 15000,
    maximumAge: 60000,
  };

  /**
   * Begin the capture lifecycle for a signed-in session. Two parts, deliberately separated:
   *
   *  1. The PASSIVE on-login grab ({@link captureOnLoginPassive}) — toggle-INDEPENDENT. It records a
   *     `login` fix whenever the browser already permits geolocation, REGARDLESS of the in-app
   *     LocationEnabled toggle. It NEVER prompts (it consults navigator.permissions and only reads a
   *     position the user has already granted). location.self is the only gate.
   *  2. The PERIODIC heartbeat — still toggle-GATED. It runs only while the user has explicitly enabled
   *     capture (LocationSettings.locationEnabled).
   *
   * No-op (and silent) when the caller lacks `location.self` — so unprivileged users never even probe the
   * browser. Safe to call repeatedly (idempotent).
   */
  async start(): Promise<void> {
    this.stopPeriodic();
    if (!this.auth.hasPermission(PERM.locationSelf)) return;
    if (typeof navigator === 'undefined' || !navigator.geolocation) return;

    // Passive login grab first — toggle-independent, no-prompt, granted-only.
    await this.captureOnLoginPassive();

    // Periodic heartbeat stays opt-in: only run it while the user has enabled capture.
    const s = await this.refreshSettings();
    if (!s?.locationEnabled) return;
    this.startPeriodic();
  }

  /**
   * PASSIVE on-login location grab — privacy-first and toggle-INDEPENDENT.
   *
   * Records a `login` fix ONLY when the browser already permits geolocation (Permissions API state is
   * "granted"). If the Geolocation/Permissions APIs are missing, the caller lacks `location.self`, the
   * permission state is "prompt"/"denied", or anything errors → it does NOTHING and silently returns. It
   * NEVER calls getCurrentPosition in a way that could surface a permission prompt, and it does NOT consult
   * (or require) the in-app LocationEnabled toggle. This is independent of the opt-in capture flow.
   */
  async captureOnLoginPassive(): Promise<void> {
    try {
      if (!this.auth.hasPermission(PERM.locationSelf)) return;
      if (typeof navigator === 'undefined' || !navigator.geolocation || !navigator.permissions) return;

      // Only proceed if the user has ALREADY granted geolocation to this site — never prompt.
      const status = await navigator.permissions.query({ name: 'geolocation' as PermissionName });
      if (status.state !== 'granted') return;

      const pos = await this.getCurrentPosition();
      if (!pos) return;
      const { latitude, longitude, accuracy } = pos.coords;
      await firstValueFrom(
        this.api.recordLocation({
          lat: latitude,
          lng: longitude,
          accuracyM: Number.isFinite(accuracy) ? accuracy : null,
          source: 'login',
        }).pipe(catchError(() => of(null))),
      );
    } catch {
      // Best-effort: the Permissions API may reject for some name values, or anything else may throw.
      // Location is a nicety, never blocking — swallow and move on.
    }
  }

  /** Stop all capture (sign-out / disable). Clears the periodic timer; settings are left as last read. */
  stop(): void {
    this.stopPeriodic();
  }

  /** Re-read the caller's opt-in settings from the server and cache them. Returns null on failure/no-perm. */
  async refreshSettings(): Promise<LocationSettings | null> {
    if (!this.auth.hasPermission(PERM.locationSelf)) return null;
    const s = await firstValueFrom(this.api.locationSettings().pipe(catchError(() => of(null))));
    if (s) this.settings.set(s);
    return s;
  }

  /**
   * Apply a settings change locally and react to it: enabling (re)starts capture (which also requests the
   * browser permission via the first one-shot); disabling stops the periodic timer at once. Returns the
   * saved settings (or null on failure).
   */
  async applySettings(next: { locationEnabled?: boolean; shareHousehold?: boolean }): Promise<LocationSettings | null> {
    const saved = await firstValueFrom(this.api.patchLocationSettings(next).pipe(catchError(() => of(null))));
    if (!saved) return null;
    this.settings.set(saved);

    if (saved.locationEnabled) {
      // Turning capture ON: this is the explicit user gesture, so it's the right moment to prompt the
      // browser for the Geolocation permission (via a first fix) and start the heartbeat.
      this.permissionDenied.set(false);
      await this.captureOnce('login');
      this.startPeriodic();
    } else {
      this.stopPeriodic();
    }
    return saved;
  }

  /**
   * One-shot: ask the browser for the current position once and POST it with the given source. Returns the
   * resolved city (or null). Honours the opt-in gate and the permission-denied latch; all failures are
   * swallowed. `manual` is the "share current location now" button.
   */
  async captureOnce(source: LocationSource): Promise<string | null> {
    if (!this.auth.hasPermission(PERM.locationSelf)) return null;
    if (typeof navigator === 'undefined' || !navigator.geolocation) return null;
    if (this.permissionDenied()) return null;
    // For automatic sources, require the opt-in; `manual` is itself an explicit gesture but we still
    // require the server-side enable (the POST 409s otherwise), so gate it the same way for a clean UX.
    if (!this.settings()?.locationEnabled && source !== 'manual') return null;

    this.capturing.set(true);
    try {
      const pos = await this.getCurrentPosition();
      if (!pos) return null;
      const { latitude, longitude, accuracy } = pos.coords;
      const fix = await firstValueFrom(
        this.api.recordLocation({
          lat: latitude,
          lng: longitude,
          accuracyM: Number.isFinite(accuracy) ? accuracy : null,
          source,
        }).pipe(catchError(() => of(null))),
      );
      return fix?.city ?? null;
    } finally {
      this.capturing.set(false);
    }
  }

  /** Promise wrapper around navigator.geolocation.getCurrentPosition; resolves null on any error. */
  private getCurrentPosition(): Promise<GeolocationPosition | null> {
    return new Promise(resolve => {
      navigator.geolocation.getCurrentPosition(
        pos => resolve(pos),
        err => {
          // PERMISSION_DENIED (1) latches off all future capture until the user re-enables explicitly.
          if (err.code === err.PERMISSION_DENIED) this.permissionDenied.set(true);
          resolve(null);
        },
        LocationCapture.GEO_OPTS,
      );
    });
  }

  private startPeriodic(): void {
    this.stopPeriodic();
    this.periodicTimer = setInterval(() => {
      // Stop firing if the user disabled capture or the browser revoked permission since we started.
      if (!this.settings()?.locationEnabled || this.permissionDenied()) {
        this.stopPeriodic();
        return;
      }
      void this.captureOnce('periodic');
    }, LocationCapture.PERIODIC_MS);
  }

  private stopPeriodic(): void {
    if (this.periodicTimer !== null) {
      clearInterval(this.periodicTimer);
      this.periodicTimer = null;
    }
  }
}
