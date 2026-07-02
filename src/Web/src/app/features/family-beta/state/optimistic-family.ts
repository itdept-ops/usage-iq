import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { MatSnackBar } from '@angular/material/snack-bar';

import { Api } from '../../../core/api';
import { FamilyChores, FamilyList } from '../../../core/models';
import { runOptimistic } from '../../../shared/optimistic-mutation';

/**
 * A thin OPTIMISTIC wrapper over the family fast-action write endpoints, used only by the Hearth beta
 * cards. It mirrors the bump-then-reconcile shape of tracker-beta's `OptimisticTracker` (patch the local
 * signal first so the count moves sub-second, fire the API, reconcile from the server response, roll back
 * + offer Retry on failure) but is a SELF-CONTAINED copy — it injects only the root {@link Api} and
 * MatSnackBar and imports NO live-page internals.
 *
 * Provide at the route level (see family-beta.routes.ts) so every card shares one instance.
 *
 * It is deliberately stateless about the board/list snapshots themselves: the caller owns the signals and
 * passes a `patch`/`rollback` pair, so this service stays decoupled from any particular card's state.
 */
@Injectable()
export class OptimisticFamily {
  private readonly api = inject(Api);
  private readonly snack = inject(MatSnackBar);

  /**
   * A CHILD submits their claimed/assigned chore as done (awaiting parent approval). The caller has
   * already bumped its local board optimistically; we fire the API, hand back the authoritative board on
   * success (so the caller can reconcile), and on failure run `rollback` + offer a Retry that re-runs the
   * whole action. Returns the reconciled board or null when it failed (already rolled back).
   */
  async submitChore(id: number, rollback: () => void, retry: () => void): Promise<FamilyChores | null> {
    return runOptimistic({
      snack: this.snack, rollback, retry, failMessage: 'Couldn’t update chore',
      apiCall: () => firstValueFrom(this.api.submitFamilyChore(id)),
    });
  }

  /**
   * A PARENT toggles the legacy `done` flag on a chore. Same optimistic contract as {@link submitChore}:
   * the caller has already flipped the local state; we fire, reconcile from the response, or roll back +
   * Retry on failure.
   */
  async toggleChore(id: number, done: boolean, rollback: () => void, retry: () => void): Promise<FamilyChores | null> {
    return runOptimistic({
      snack: this.snack, rollback, retry, failMessage: 'Couldn’t update chore',
      apiCall: () => firstValueFrom(this.api.patchFamilyChore(id, { done })),
    });
  }

  /**
   * Add an item to a list via the existing fast-action endpoint. The caller has already shown a
   * provisional row; we fire, return the full updated list to reconcile from, or roll back + Retry.
   */
  async addListItem(listId: number, text: string, rollback: () => void, retry: () => void): Promise<FamilyList | null> {
    return runOptimistic({
      snack: this.snack, rollback, retry, failMessage: 'Couldn’t add item',
      apiCall: () => firstValueFrom(this.api.addFamilyListItem(listId, text)),
    });
  }

  /**
   * Tick / untick a list item via the existing fast-action endpoint. Optimistic: the caller flipped the
   * checkbox already; we fire, reconcile from the response, or roll back + Retry.
   */
  async tickListItem(listId: number, itemId: number, done: boolean, rollback: () => void, retry: () => void): Promise<FamilyList | null> {
    return runOptimistic({
      snack: this.snack, rollback, retry, failMessage: 'Couldn’t update item',
      apiCall: () => firstValueFrom(this.api.patchFamilyListItem(listId, itemId, { done })),
    });
  }
}
