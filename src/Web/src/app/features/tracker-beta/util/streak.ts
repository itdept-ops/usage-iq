// ============================================================================
// Tracker Beta — client-derived "days with logs" streak (GRAFT SURGE, DE-GAMIFIED).
//
// NO BACKEND. NO XP. NO LEVELS. The action-bar flame is purely encouragement: it counts
// consecutive days (ending today) on which the user logged *something*. The page already
// loads one day at a time, so the page component accumulates a small set of dates it has
// observed to have entries and passes that set here. Missing days simply break the streak;
// we never punish, never show a "you broke it" state — the number just is what it is.
// ============================================================================

import { toLocalDate } from '../../../core/tracker-store';

/** A day "has a log" if it has any food, exercise, hydration, coffee, supplement, or a weigh-in. */
export interface DayActivityFlags {
  hasAny: boolean;
}

/**
 * Compute the current streak: consecutive days ending at `today` (inclusive) that appear in `loggedDates`.
 * `loggedDates` is a set of `YYYY-MM-DD` strings the caller knows had at least one entry. Today is allowed
 * to be empty WITHOUT breaking the streak yet (you haven't necessarily logged today) — but it only counts
 * toward the number if it IS present. So:
 *   - if today is logged: streak = today + the unbroken run of prior logged days
 *   - if today is NOT logged: streak = the unbroken run of prior logged days (grace for "not yet today")
 *
 * Returns 0 when there is no qualifying run. Pure + side-effect free.
 */
export function currentStreak(loggedDates: ReadonlySet<string>, today: Date = new Date()): number {
  const todayKey = toLocalDate(today);
  let count = 0;
  // Walk backwards from today. Today is a grace day: if it's not logged we skip it (no break) and
  // start counting from yesterday; if it IS logged it counts.
  const cursor = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  let first = true;
  while (true) {
    const key = toLocalDate(cursor);
    if (loggedDates.has(key)) {
      count++;
    } else if (!(first && key === todayKey)) {
      // A gap on any day other than the grace (today) breaks the run.
      break;
    }
    first = false;
    cursor.setDate(cursor.getDate() - 1);
    // Safety bound: never scan more than ~2 years of history.
    if (count > 730) break;
  }
  return count;
}

/** True when a loaded {@link DayActivityFlags}-shaped day had any entry (for the caller to seed its set). */
export function dayHasAnyLog(flags: {
  foods?: unknown[]; exercises?: unknown[]; hydration?: unknown[];
  coffee?: unknown[]; supplements?: unknown[]; profileWeighedToday?: boolean;
}): boolean {
  return (
    (flags.foods?.length ?? 0) > 0 ||
    (flags.exercises?.length ?? 0) > 0 ||
    (flags.hydration?.length ?? 0) > 0 ||
    (flags.coffee?.length ?? 0) > 0 ||
    (flags.supplements?.length ?? 0) > 0 ||
    !!flags.profileWeighedToday
  );
}
