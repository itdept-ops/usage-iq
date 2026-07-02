import { MatSnackBar } from '@angular/material/snack-bar';

/**
 * The shared bump-then-reconcile core behind the beta optimistic wrappers
 * ({@link import('../features/tracker-beta/state/optimistic-tracker').OptimisticTracker} and
 * {@link import('../features/family-beta/state/optimistic-family').OptimisticFamily}).
 *
 * The caller has ALREADY applied its optimistic local patch (bumped the count / inserted the provisional
 * row) before calling this. This helper only owns the write's tail: await the API, hand the authoritative
 * result to `onSuccess` to reconcile, and on failure run `rollback` + pop a non-blocking snackbar whose
 * "Retry" action re-runs the whole mutation.
 *
 * Returns the API result on success, or `null` on failure (already rolled back). Callers that need to
 * distinguish failure from a null payload can inspect that.
 */
export async function runOptimistic<T>(opts: {
  /** The snackbar instance to surface failures on. */
  snack: MatSnackBar;
  /** Fire the underlying write and resolve with the authoritative result. */
  apiCall: () => Promise<T>;
  /** Reconcile local state from the authoritative result (e.g. swap the provisional row for the real one). */
  onSuccess?: (result: T) => void;
  /** Undo the caller's optimistic patch. Runs before the failure snackbar. */
  rollback: () => void;
  /** Re-run the whole mutation when the user taps Retry. */
  retry: () => void;
  /** Message shown in the failure snackbar. */
  failMessage: string;
}): Promise<T | null> {
  try {
    const result = await opts.apiCall();
    opts.onSuccess?.(result);
    return result;
  } catch {
    opts.rollback();
    opts.snack.open(opts.failMessage, 'Retry', { duration: 5000, politeness: 'polite' })
      .onAction().subscribe(() => opts.retry());
    return null;
  }
}
