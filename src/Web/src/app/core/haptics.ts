import { Injectable } from '@angular/core';

/**
 * Haptics — a tiny, SUBTLE wrapper over the Vibration API (`navigator.vibrate(pattern)`) for
 * tasteful tactile feedback on DELIBERATE actions only (a FAB press, a sheet opening, a success
 * toast, a swipe-row commit). It is NOT a per-tap buzzer — callers opt in at meaningful moments.
 *
 * ROBUSTNESS: the Vibration API is feature-detected (`'vibrate' in navigator`) and every call is
 * wrapped in try/catch, so it NO-OPs silently where unsupported. iOS Safari has no Vibration API
 * (and ignores it inside web apps) — that is fine; these methods simply do nothing there. Older
 * browsers without it likewise no-op. We never throw and never block.
 *
 * Patterns are intentionally faint (single-digit / low-tens of ms) so feedback feels like a light
 * tick, never a jarring rumble. A number is a single buzz; an array alternates buzz/pause/buzz…
 *
 * Used app-wide via the beta-ui kit primitives (BetaFab, BetaBottomSheet, ToastController,
 * BetaSwipeRow), so the whole beta suite benefits without per-page wiring.
 */
@Injectable({ providedIn: 'root' })
export class Haptics {
  /** True when this browser exposes the Vibration API. Computed once; iOS / old browsers => false. */
  private readonly supported =
    typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';

  /** Fire a vibration pattern, guarded + feature-detected. Silently no-ops where unsupported. */
  private fire(pattern: number | number[]): void {
    if (!this.supported) return;
    try {
      navigator.vibrate(pattern);
    } catch {
      /* no-op (iOS / unsupported / blocked) */
    }
  }

  /** A light tick for a deliberate primary action (e.g. a FAB press). ~10ms. */
  tap(): void {
    this.fire(10);
  }

  /** A faint tick for a softer selection / open (e.g. a bottom sheet rising). ~5ms. */
  select(): void {
    this.fire(5);
  }

  /** A short, gentle double-tick to confirm a successful commit. */
  success(): void {
    this.fire([10, 40, 10]);
  }

  /** A slightly longer single buzz to flag a warning / destructive outcome. */
  warn(): void {
    this.fire(30);
  }
}
