// ============================================================================
// Tracker Beta — small display helpers.
//
// Unit-aware DISPLAY/INPUT (weight / volume / distance, metric<->imperial) now
// routes through the central injectable UnitService (core/unit.service.ts), which
// reads the user's unitSystem signal so callers no longer thread an `imperial`
// boolean. This file keeps only the unit-AGNOSTIC bits the Strata cards still need:
// the thousands-grouping numeral, the "X left" abundance figure, and the fixed
// 250 ml "glass" (a glass is 250 ml regardless of the display unit system).
//
// THE WIRE STAYS METRIC everywhere: kg / ml / m on every request/response.
// ============================================================================

/** A "glass" of water in ml (~8 fl oz) — the fixed wire amount the glass stepper sends. */
export const ML_PER_GLASS = 250;

/** A whole-glass count for a volume (ml / 250), used in the "x of y glasses" subtitle. */
export function glasses(ml: number): number {
  return Math.round(ml / ML_PER_GLASS);
}

/**
 * Compact integer with a thousands separator for the hero numeral and big counts (e.g. 1240 -> "1,240").
 * Tabular numerals are applied in CSS (font-variant-numeric) — this only groups.
 */
export function group(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/**
 * The "X left" abundance figure (GRAFT Daylight): goal minus current, floored at 0. Returns null when
 * there is no goal so the caption can hide the clause.
 */
export function remaining(current: number, goal: number | null | undefined): number | null {
  if (goal == null) return null;
  return Math.max(0, Math.round(goal - current));
}
