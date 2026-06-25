// ============================================================================
// Core unit conversions — pure, framework-light, tree-shakeable.
//
// THE CANONICAL STORE IS METRIC. Every persisted measure on the wire (core/models.ts)
// is metric: weight = kilograms, height = centimetres, distance = metres, volume =
// millilitres. `unitSystem` is a DISPLAY preference only — it NEVER changes storage.
//
// These are the single source of truth for metric<->imperial math. The injectable
// {@link UnitService} (core/unit.service.ts) wraps these with the user's unitSystem
// signal so callers don't pass an `imperial` boolean around. NOTE: the older tracker
// helpers (features/tracker/units.ts) are INDEPENDENT — they keep their own factor
// table (e.g. their own LB_PER_KG=2.20462) and do NOT re-export from here, so the two
// factor tables can drift. Keep them in sync by hand if you change a factor.
//
// Exact conversion factors (per the unit-system spec):
//   lb   = kg * 2.2046226
//   in   = cm / 2.54
//   mi   = km * 0.6213712
//   floz = ml * 0.0338140
//   gal  = L  * 0.2641720  (US gallon; derived as 1 / 3.785411784)
// ============================================================================

/** Display unit preference. The backend always stores/returns metric regardless. */
export type UnitSystem = 'Metric' | 'Imperial';

// ── exact factors ───────────────────────────────────────────────────────────

/** 1 kilogram in pounds. */
export const LB_PER_KG = 2.2046226;
/** 1 inch in centimetres. */
export const CM_PER_IN = 2.54;
/** 1 metre in feet (for small metre-scale distances like GPS accuracy). */
export const FT_PER_M = 3.28084;
/** 1 kilometre in miles. */
export const MI_PER_KM = 0.6213712;
/** 1 millilitre in US fluid ounces. */
export const FLOZ_PER_ML = 0.0338140;
/** 1 US fluid ounce in millilitres (1 / FLOZ_PER_ML). */
export const ML_PER_FLOZ = 1 / FLOZ_PER_ML;
/** 1 litre in US gallons. */
export const GAL_PER_L = 0.2641720;
/** 1 US gallon in litres (1 / GAL_PER_L). */
export const L_PER_GAL = 1 / GAL_PER_L;
/** Millilitres per litre / metres per kilometre — base-ten scale constants. */
export const ML_PER_L = 1000;
export const M_PER_KM = 1000;

/** True when the system is Imperial. Centralizes the string compare. */
export function isImperial(system: UnitSystem | string | null | undefined): boolean {
  return system === 'Imperial';
}

// ── weight: kg <-> lb ────────────────────────────────────────────────────────

export function kgToLb(kg: number): number { return kg * LB_PER_KG; }
export function lbToKg(lb: number): number { return lb / LB_PER_KG; }

// ── height: cm <-> ft + in ─────────────────────────────────────────────────────

/** Centimetres → whole feet + remaining inches (inches rounded, carrying to feet at 12). */
export function cmToFtIn(cm: number): { ft: number; in: number } {
  const totalIn = cm / CM_PER_IN;
  let ft = Math.floor(totalIn / 12);
  let inches = Math.round(totalIn - ft * 12);
  if (inches === 12) { ft += 1; inches = 0; }
  return { ft, in: inches };
}

/** Feet + inches → centimetres. */
export function ftInToCm(ft: number, inches: number): number {
  return (ft * 12 + inches) * CM_PER_IN;
}

// ── distance: m <-> mi, km <-> mi ──────────────────────────────────────────────

export function kmToMi(km: number): number { return km * MI_PER_KM; }
export function miToKm(mi: number): number { return mi / MI_PER_KM; }
/** Metres → miles. */
export function metersToMiles(m: number): number { return kmToMi(m / M_PER_KM); }
/** Miles → metres. */
export function milesToMeters(mi: number): number { return miToKm(mi) * M_PER_KM; }
/** Metres → feet (for small metre-scale distances like GPS accuracy). */
export function metersToFeet(m: number): number { return m * FT_PER_M; }

// ── volume: ml <-> fl oz, L <-> gal ────────────────────────────────────────────

export function mlToFloz(ml: number): number { return ml * FLOZ_PER_ML; }
export function flozToMl(floz: number): number { return floz / FLOZ_PER_ML; }
export function litersToGallons(l: number): number { return l * GAL_PER_L; }
export function gallonsToLiters(gal: number): number { return gal * L_PER_GAL; }
