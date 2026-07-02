import { ActivityLevel, Sex, TrackerStatsDto } from '../../core/models';
import {
  LB_PER_KG,
  ML_PER_FLOZ,
  M_PER_KM,
  kgToLb,
  lbToKg,
  cmToFtIn,
  ftInToCm,
  mlToFloz,
  flozToMl,
  metersToMiles,
  milesToMeters,
  MI_PER_KM,
} from '../../core/units';

// ── conversion primitives ────────────────────────────────────────────────────
// These re-export the SINGLE canonical factor table (core/units.ts) so this module
// and every UnitService-driven surface share one source of truth — the two tables can
// no longer drift. Only the tracker-specific goal math (computeStats) lives locally.

export {
  LB_PER_KG,
  kgToLb,
  lbToKg,
  cmToFtIn,
  ftInToCm,
  metersToMiles,
  milesToMeters,
};

/** 1 US fluid ounce expressed in millilitres (canonical: 1 / FLOZ_PER_ML). */
export const ML_PER_OZ = ML_PER_FLOZ;

/** 1 mile expressed in metres (canonical: derived from MI_PER_KM). */
export const M_PER_MI = M_PER_KM / MI_PER_KM;

/** A "glass" of water in ml (~8 fl oz) — the unit the glasses subtitle counts in. */
export const ML_PER_GLASS = 250;

/** Millilitres → US fluid ounces. */
export function mlToOz(ml: number): number {
  return mlToFloz(ml);
}

/** US fluid ounces → millilitres. */
export function ozToMl(oz: number): number {
  return flozToMl(oz);
}

/** A whole-glass count for a volume (ml / 250), used in the "x of y glasses" subtitle. */
export function glasses(ml: number): number {
  return Math.round(ml / ML_PER_GLASS);
}

/**
 * Format a metric volume (ml) for display in the chosen unit system, with the unit suffix.
 * Imperial → fl oz (e.g. "24 oz"); Metric → ml (e.g. "750 ml"). Rounded to whole units.
 */
export function formatVolume(ml: number | null | undefined, imperial: boolean): string | null {
  if (ml == null) return null;
  if (imperial) return `${Math.round(mlToOz(ml))} oz`;
  return `${Math.round(ml)} ml`;
}

// ── distance: m <-> mi/km ───────────────────────────────────────────────────
// metersToMiles / milesToMeters / M_PER_MI are re-exported from core/units.ts above.

/**
 * Format a metric distance (metres) for display in the chosen unit system, with the unit suffix.
 * Imperial → miles (e.g. "3.2 mi"); Metric → kilometres (e.g. "5.1 km"). Rounded to 1 decimal.
 */
export function formatDistance(meters: number | null | undefined, imperial: boolean): string | null {
  if (meters == null) return null;
  if (imperial) return `${metersToMiles(meters).toFixed(1)} mi`;
  return `${(meters / 1000).toFixed(1)} km`;
}

// ── display formatting ────────────────────────────────────────────────────────

/** Format a metric weight (kg) for display in the chosen unit system, with the unit suffix. */
export function formatWeight(kg: number | null | undefined, imperial: boolean, dp = 1): string | null {
  if (kg == null) return null;
  if (imperial) return `${kgToLb(kg).toFixed(dp)} lb`;
  return `${kg.toFixed(dp)} kg`;
}

/** The weight unit label for the chosen system. */
export function weightUnit(imperial: boolean): string {
  return imperial ? 'lb' : 'kg';
}

// ── live stats preview (mirror of the backend TrackerStats.Compute formulas) ──

const ACTIVITY_FACTOR: Record<ActivityLevel, number> = {
  Sedentary: 1.2,
  Light: 1.375,
  Moderate: 1.55,
  Active: 1.725,
  VeryActive: 1.9,
};

/** Whole years from a `yyyy-MM-dd` DOB to `today` (birthday-aware); null if missing/future. */
export function ageFrom(dob: string | null | undefined, today: Date): number | null {
  if (!dob) return null;
  const d = new Date(dob + 'T00:00:00');
  if (isNaN(d.getTime()) || d.getTime() > today.getTime()) return null;
  let age = today.getFullYear() - d.getFullYear();
  const m = today.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < d.getDate())) age--;
  return age < 0 ? null : age;
}

/** BMI category for a BMI value (mirrors the backend thresholds). */
export function bmiCategory(bmi: number): string {
  if (bmi < 18.5) return 'Underweight';
  if (bmi < 25) return 'Normal';
  if (bmi < 30) return 'Overweight';
  return 'Obese';
}

/** Half-to-even rounding to match .NET Math.Round (banker's rounding) used by the backend. */
function roundHalfEven(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * Inputs to the live preview — metric, as the backend stores them. The first seven are the original gate;
 * everything below is an OPTIONAL goal-builder refinement (nullable / neutral-default) that mirrors a
 * column on TrackerProfile. Leaving them unset collapses to the same goal-based defaults the server uses.
 */
export interface StatsInputs {
  weightKg: number | null;
  heightCm: number | null;
  age: number | null;
  sex: Sex;
  activityLevel: ActivityLevel;
  goal: string;
  dailyCalorieGoal: number | null;
  // ---- optional refinements (mirror TrackerProfile; default to neutral when omitted) ----
  weeklyRateKg?: number | null;
  bodyFatPct?: number | null;
  dietPattern?: string;
  trainingType?: string;
  proteinBasis?: string;
  lifeStage?: string;
  trimester?: number | null;
}

/**
 * Deterministically reshape a (protein, fat, carb) gram split for a DietPattern — the TS twin of
 * TrackerStats.ReshapeForDiet. Protein is preserved; carbs are clamped to a pattern-specific cap (Keto
 * pins them at a ~25 g hard floor) and any freed carb calories are moved to fat (4 → 9 kcal/g). All other
 * patterns pass through unchanged.
 */
function reshapeForDiet(
  pattern: string | undefined,
  protein: number,
  fat: number,
  carbs: number,
): { protein: number; fat: number; carbs: number } {
  let carbCap: number | null;
  switch (pattern) {
    case 'Keto': carbCap = 25; break; // hard ketogenic floor/cap
    case 'LowCarb': carbCap = 100; break; // a reduced carb cap
    default: carbCap = null;
  }
  if (carbCap == null || carbs <= carbCap) return { protein, fat, carbs };

  const freedCarbGrams = carbs - carbCap;
  carbs = carbCap;
  fat += roundHalfEven((freedCarbGrams * 4) / 9);
  if (carbs < 0) carbs = 0;
  return { protein, fat, carbs };
}

/**
 * Pure client mirror of the backend stats helper for the LIVE dialog preview. Any field whose inputs
 * are missing stays null (partial stats are fine). The dashboard panel reads day.stats from the server;
 * this exists only so the profile dialog can preview as the user types.
 *
 * This MUST stay numerically identical to TrackerStats.Compute (src/Api/Services/TrackerStats.cs):
 * same constants (7700 kcal/kg, −0.5/+0.25 goal-default pace, −25%/−1100 deficit cap, lean-mass + fat-floor
 * macros, DietPattern reshape), the same guardrail ORDER, and banker's rounding everywhere a .NET
 * Math.Round runs.
 */
export function computeStats(i: StatsInputs): TrackerStatsDto {
  const out: TrackerStatsDto = {
    age: i.age ?? null,
    bmi: null, bmiCategory: null, bmr: null, tdee: null,
    suggestedCalorieGoal: null, suggestedProteinG: null, suggestedCarbG: null, suggestedFatG: null,
  };

  const w = i.weightKg, h = i.heightCm;
  const bf = i.bodyFatPct;
  const endurance = i.trainingType === 'Endurance' || i.goal === 'Endurance';

  // BMI (weight + height).
  if (w != null && w > 0 && h != null && h > 0) {
    const m = h / 100;
    const bmi = roundHalfEven((w / (m * m)) * 10) / 10;
    out.bmi = bmi;
    out.bmiCategory = bmiCategory(bmi);
  }

  // BMR — Katch-McArdle when body-fat % is known, else Mifflin-St Jeor.
  let bmr: number | null = null;
  if (w != null && w > 0 && bf != null && bf > 0 && bf < 100) {
    // Katch-McArdle: BMR = 370 + 21.6·LBM, LBM = kg·(1 − bf/100). Needs only weight + body-fat.
    const lbm = w * (1 - bf / 100);
    bmr = roundHalfEven(370 + 21.6 * lbm);
    out.bmr = bmr;
  } else if (
    w != null && w > 0 && h != null && h > 0 && i.age != null && i.sex !== 'Unspecified'
  ) {
    // Mifflin-St Jeor: needs weight + height + age + a known sex.
    const base = 10 * w + 6.25 * h - 5 * i.age;
    bmr = roundHalfEven(i.sex === 'Male' ? base + 5 : base - 161);
    out.bmr = bmr;
  }

  // TDEE (BMR * activity factor).
  let tdee: number | null = null;
  if (bmr != null) {
    tdee = roundHalfEven(bmr * ACTIVITY_FACTOR[i.activityLevel]);
    out.tdee = tdee;
  }

  // Suggested calorie goal (rate-based; needs TDEE + BMR).
  let suggested: number | null = null;
  if (tdee != null && bmr != null) {
    // Effective signed pace: the user's weeklyRateKg, else a goal-based default.
    let goalDefault: number;
    switch (i.goal) {
      case 'LoseWeight': goalDefault = -0.5; break;
      case 'GainMuscle': goalDefault = 0.25; break;
      default: goalDefault = 0; // Maintain + Endurance
    }
    const weeklyRateKg = i.weeklyRateKg ?? goalDefault;

    // ~7700 kcal per kg of body mass; daily delta from the weekly pace.
    let dailyDelta = (weeklyRateKg * 7700) / 7;

    // (a) Pregnant / Breastfeeding: never a deficit; add the standard maintenance increment.
    if (i.lifeStage === 'Pregnant') {
      if (dailyDelta < 0) dailyDelta = 0;
      // T1 ≈ +0; T2 ≈ +340; T3 ≈ +450. Unknown trimester ⇒ the 2nd-trimester figure.
      let increment: number;
      switch (i.trimester) {
        case 1: increment = 0; break;
        case 3: increment = 450; break;
        default: increment = 340;
      }
      dailyDelta += increment;
    } else if (i.lifeStage === 'Breastfeeding') {
      if (dailyDelta < 0) dailyDelta = 0;
      dailyDelta += 400;
    } else if (dailyDelta < 0) {
      // (b) Deficit cap: the more conservative (smaller magnitude) of −25%·TDEE and −1.0 kg/wk.
      const capByPct = -0.25 * tdee;
      const capByRate = -1100; // ≈ −1.0 kg/wk
      const floorDelta = Math.max(capByPct, capByRate); // the less-negative of the two
      if (dailyDelta < floorDelta) dailyDelta = floorDelta;
    }

    const raw = roundHalfEven(tdee + dailyDelta);
    // (c) Never below BMR.
    suggested = Math.max(raw, bmr);
    out.suggestedCalorieGoal = suggested;
  }

  // Suggested macros (needs weight + a calorie target: the suggestion, else the set goal).
  const calTarget = suggested ?? i.dailyCalorieGoal ?? null;
  if (w != null && w > 0 && calTarget != null && calTarget > 0) {
    // PROTEIN: lean-mass-anchored when body-fat is known or PerLeanMass is requested; else per-bodyweight.
    const hasBf = bf != null && bf > 0 && bf < 100;
    const useLeanMass = hasBf || i.proteinBasis === 'PerLeanMass';
    let proteinG: number;
    if (useLeanMass && hasBf) {
      const lbm = w * (1 - (bf as number) / 100);
      // ~2.2 g/kg LBM on a cut, ~1.8 to gain, ~1.6 maintain; endurance trims to ~1.5.
      let perLbm: number;
      if (endurance) perLbm = 1.5;
      else if (i.goal === 'LoseWeight') perLbm = 2.2;
      else if (i.goal === 'GainMuscle') perLbm = 1.8;
      else perLbm = 1.6;
      proteinG = perLbm * lbm;
    } else {
      // Goal-varying per-bodyweight; endurance leans lowest.
      let perKg: number;
      if (endurance) perKg = 1.4;
      else if (i.goal === 'LoseWeight') perKg = 2.0;
      else if (i.goal === 'GainMuscle') perKg = 1.8;
      else perKg = 1.6;
      proteinG = perKg * w;
    }
    const protein = roundHalfEven(proteinG);

    // FAT FLOOR (computed BEFORE carbs): the larger of 0.6 g/kg and 20% of calories.
    const fatFloor = Math.max(0.6 * w, (0.2 * calTarget) / 9);
    let fat = roundHalfEven(fatFloor);

    // CARBS = remainder, never negative.
    let carbs = roundHalfEven((calTarget - protein * 4 - fat * 9) / 4);
    if (carbs < 0) carbs = 0;

    // DietPattern reshaping (deterministic).
    const shaped = reshapeForDiet(i.dietPattern, protein, fat, carbs);
    fat = shaped.fat;
    carbs = shaped.carbs;

    out.suggestedProteinG = shaped.protein;
    out.suggestedFatG = fat;
    out.suggestedCarbG = Math.max(0, carbs);
  }

  return out;
}
