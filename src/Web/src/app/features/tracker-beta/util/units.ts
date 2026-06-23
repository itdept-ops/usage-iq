// ============================================================================
// Tracker Beta — UI-edge metric<->imperial conversion.
//
// The WIRE STAYS METRIC: every request/response in core/models.ts is kg / ml / m.
// These helpers exist ONLY to render and to read user-entered imperial values back
// into metric before a mutation. They re-export the proven conversions from the
// existing tracker so the two surfaces never drift, and add a couple of beta-only
// display formatters (compact, unit-aware) the Strata cards need.
// ============================================================================

import {
  LB_PER_KG, ML_PER_OZ, ML_PER_GLASS, M_PER_MI,
  kgToLb, lbToKg, mlToOz, ozToMl, metersToMiles, milesToMeters,
  cmToFtIn, ftInToCm, glasses, formatVolume, formatDistance, formatWeight, weightUnit,
} from '../../tracker/units';

// Re-export the canonical conversions so beta code imports from one place.
export {
  LB_PER_KG, ML_PER_OZ, ML_PER_GLASS, M_PER_MI,
  kgToLb, lbToKg, mlToOz, ozToMl, metersToMiles, milesToMeters,
  cmToFtIn, ftInToCm, glasses, formatVolume, formatDistance, formatWeight, weightUnit,
};

/** True when the profile's unitSystem is imperial. Centralizes the string compare. */
export function isImperial(unitSystem: string | null | undefined): boolean {
  return unitSystem === 'Imperial';
}

/**
 * The hydration quick-add step expressed in the user's unit. We always SEND metric ml (250/500), but the
 * tile LABEL reads "+8 oz" / "+250 ml" depending on the unit system. Returns both the wire ml and the label.
 */
export function hydrationStep(ml: number, imperial: boolean): { ml: number; label: string } {
  return { ml, label: imperial ? `+${Math.round(mlToOz(ml))} oz` : `+${ml} ml` };
}

/** Volume unit label for the active system ("oz" | "ml"). */
export function volumeUnit(imperial: boolean): string {
  return imperial ? 'oz' : 'ml';
}

/** Distance unit label for the active system ("mi" | "km"). */
export function distanceUnit(imperial: boolean): string {
  return imperial ? 'mi' : 'km';
}

/**
 * Convert a user-entered weight (in the displayed unit) back to METRIC kg for the wire. The weight wheel
 * shows lb in Imperial; logWeight() always wants kg.
 */
export function weightToKg(value: number, imperial: boolean): number {
  return imperial ? lbToKg(value) : value;
}

/** Convert a metric kg weight into the displayed unit's numeric value (no suffix) — for the wheel. */
export function weightFromKg(kg: number, imperial: boolean): number {
  return imperial ? kgToLb(kg) : kg;
}

/**
 * Convert a user-entered volume (in the displayed unit) back to METRIC ml for the wire. The adjust-amount
 * sheet shows oz in Imperial; addHydration() always wants ml.
 */
export function volumeToMl(value: number, imperial: boolean): number {
  return imperial ? ozToMl(value) : value;
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
