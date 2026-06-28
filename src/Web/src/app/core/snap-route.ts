import { Injectable, computed, inject, signal } from '@angular/core';

import { AuthService } from './auth';
import { PERM, type PhotoKind } from './models';

/**
 * SNAP & ROUTE — the app-scoped trigger + policy hub for the "+ Snap" photo-anything capture surface.
 *
 * This service is the seam between the *triggers* (the mobile bottom-tab camera FAB, the desktop top-bar
 * button / ⌘K palette action) and the single {@link SnapRouteOrchestrator} component mounted once in the
 * shell. A trigger calls {@link request} (incrementing a signal); the orchestrator reacts to that signal,
 * runs the capture → downscale → classify → route-review flow, and writes via the EXISTING destination
 * endpoints. Keeping the trigger decoupled from the heavy orchestrator keeps the FAB/palette dependency-free.
 *
 * It ALSO owns the per-route WRITE-permission policy (mirrors calendar.ts canUseSchedule): each {@link PhotoKind}
 * maps to the permission the caller must hold to COMMIT that route. The orchestrator hides/disables any route
 * the caller can't write, so the confirm step never 403s confusingly — and because the classifier output is a
 * HINT and every write re-gates downstream, a misclassification can never bypass a gate.
 */
@Injectable({ providedIn: 'root' })
export class SnapRouteService {
  private readonly auth = inject(AuthService);

  /** Monotonic counter: each {@link request} bumps it; the orchestrator's effect reacts to the change. */
  private readonly _requested = signal(0);
  readonly requested = this._requested.asReadonly();

  /**
   * The WRITE permission each route's CONFIRM step needs (mirrors the destination endpoint's own gate):
   *   meal/label/pantry → tracker.self (writes via /api/tracker/food or biases the planner)
   *   receipt           → bills.use    (creates a draft bill + saves the breakdown)
   *   schedule          → family.use   (creates calendar events; the read additionally needs family.ai + ai.vision)
   *   note              → family.use   (posts to /api/family/notes)
   * `unknown` has no destination (the manual picker is shown). Kept here so the FAB visibility + the
   * route-review picker share ONE source of truth.
   */
  private static readonly WRITE_PERM: Record<Exclude<PhotoKind, 'unknown'>, string> = {
    meal: PERM.trackerSelf,
    label: PERM.trackerSelf,
    pantry: PERM.trackerSelf,
    receipt: PERM.billsUse,
    schedule: PERM.familyUse,
    note: PERM.familyUse,
  };

  /** Can the caller WRITE this route (so the orchestrator may offer it)? `unknown` is never writable. */
  canWrite(kind: PhotoKind): boolean {
    if (kind === 'unknown') return false;
    return this.auth.hasPermission(SnapRouteService.WRITE_PERM[kind]);
  }

  /**
   * The set of routes the caller can write, in the manual-picker display order. Reactive to a live /me
   * permission change (reads permissions()). Empty when the caller can write none (the capture affordance
   * itself is then hidden — see {@link canCapture}).
   */
  readonly writableRoutes = computed<Exclude<PhotoKind, 'unknown'>[]>(() => {
    this.auth.permissions(); // reactive dependency
    return (['receipt', 'label', 'meal', 'pantry', 'schedule', 'note'] as const).filter((k) =>
      this.canWrite(k),
    );
  });

  /**
   * Whether to surface the "+ Snap" capture affordance at all: the multimodal classify gate (ai.vision) is
   * required, AND the caller must be able to write at least one destination route (else every route would be
   * hidden and the sheet would be a dead end). Reactive to /me.
   */
  readonly canCapture = computed<boolean>(() => {
    this.auth.permissions(); // reactive dependency
    return this.auth.hasPermission(PERM.aiVision) && this.writableRoutes().length > 0;
  });

  /** A trigger (FAB / palette / top bar) asks the orchestrator to start a capture. */
  request(): void {
    this._requested.update((n) => n + 1);
  }
}
