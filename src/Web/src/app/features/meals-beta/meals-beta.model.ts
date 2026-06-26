import { FamilyMeal, FamilyMealSlot } from '../../core/models';

/**
 * Shared view-model types + pure helpers for the Meals "Forage" beta surface. Kept dependency-light so the
 * page and its subcomponents (day strip, meal card, sheets) all read ONE contract. Mirrors the live
 * meal-planner's DayRollup/DayCell shapes (per-serving macro rollups, Monday-anchored weeks) so the numbers
 * match the live page exactly — this is a new VIEW, not new data.
 */

/** A day's planned-macro rollup: the sum of each meal's per-serving macros, with a "any macros set?" flag. */
export interface DayRollup {
  hasMacros: boolean;
  calories: number;
  proteinG: number;
  carbG: number;
  fatG: number;
}

/** One day in the swipeable week strip + the planned-day view: ISO date, friendly labels, its meals + rollup. */
export interface DayCell {
  /** "YYYY-MM-DD" (household-local). */
  localDate: string;
  /** "Mon" — the short weekday for the day chip. */
  weekdayShort: string;
  /** "Monday" — the long weekday for the day header. */
  weekdayLong: string;
  /** Day-of-month number for the chip ("23"). */
  dayNum: string;
  /** "Jun 23" — a friendly date for the header subtitle. */
  dateLabel: string;
  isToday: boolean;
  meals: FamilyMeal[];
  rollup: DayRollup;
}

/** Pretty labels + Material icons per slot (dinner is the primary slot at the table). */
export const SLOT_META: Record<FamilyMealSlot, { label: string; icon: string; order: number }> = {
  breakfast: { label: 'Breakfast', icon: 'free_breakfast', order: 0 },
  lunch: { label: 'Lunch', icon: 'lunch_dining', order: 1 },
  dinner: { label: 'Dinner', icon: 'dinner_dining', order: 2 },
  snack: { label: 'Snack', icon: 'bakery_dining', order: 3 },
};

/** The slot order the planner offers when adding a meal (breakfast → snack). */
export const SLOT_ORDER: FamilyMealSlot[] = ['breakfast', 'lunch', 'dinner', 'snack'];

export function slotMeta(slot: FamilyMealSlot) {
  return SLOT_META[slot] ?? SLOT_META.dinner;
}

/** Round to 1 decimal place, treating non-finite as 0 (matches the live planner). */
export function round1(n: number): number {
  return Math.round((Number.isFinite(n) ? n : 0) * 10) / 10;
}

/**
 * Sum a day's meals' PER-SERVING macros (one planned portion each); flags whether any meal had macros set.
 * Mirrors the live MealPlanner.rollup() so the per-day + per-week totals match the live page.
 */
export function rollupOf(meals: FamilyMeal[]): DayRollup {
  let calories = 0, proteinG = 0, carbG = 0, fatG = 0, hasMacros = false;
  for (const m of meals) {
    if (m.macroSource === 'none') continue;
    hasMacros = true;
    calories += m.perServing.calories;
    proteinG += m.perServing.proteinG;
    carbG += m.perServing.carbG;
    fatG += m.perServing.fatG;
  }
  return {
    hasMacros,
    calories: Math.round(calories),
    proteinG: round1(proteinG),
    carbG: round1(carbG),
    fatG: round1(fatG),
  };
}

/** This week's Monday (local, midnight) — the household's week starts Monday, like the backend. */
export function thisMonday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const offset = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - offset);
  return d;
}

/** Local "YYYY-MM-DD" (never toISOString — that would shift the boundary across timezones). */
export function toIso(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The bare "YYYY-MM-DD" of a possibly-timestamped ISO string. */
export function dateOnly(iso: string): string {
  return iso.length >= 10 ? iso.slice(0, 10) : iso;
}

/** Whether a meal has any non-blank ingredient lines (gates the "add to grocery" affordance). */
export function hasIngredients(meal: FamilyMeal): boolean {
  return meal.ingredients.split('\n').some(s => s.trim().length > 0);
}

/** A short macro tag for a meal's source ("AI estimate" / "from food DB" / "manual" / "not set"). */
export function macroTag(meal: FamilyMeal): string {
  switch (meal.macroSource) {
    case 'ai': return 'AI estimate';
    case 'database': return 'food DB';
    case 'manual': return 'manual';
    default: return 'no macros';
  }
}
