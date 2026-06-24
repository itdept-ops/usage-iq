import { Component, computed, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';

import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSnackBar } from '@angular/material/snack-bar';

import { Api } from '../../core/api';
import { AuthService } from '../../core/auth';
import {
  EatIngredient,
  FamilyMealSlot,
  ImageRequest,
  PERM,
  PlanMealDay,
  PlanMealSlot,
  PlanMealToWrite,
  PlanMealsResult,
} from '../../core/models';
import { captureImage, pickImage, confirmPhotoNotice } from './ai-image';

/**
 * Opened from the Meal Planner (or tracker) with the caller's local "today" + an anchor week start. Nothing
 * private is passed — the server reads the caller's OWN context (remaining macros, recent foods, saved
 * recipes, on-hand groceries, planned meals) from the JWT. `canPlan` gates the "Add to plan" write
 * (meals.use, checked server-side too); when false the dialog still shows the plan + grocery actions.
 */
export interface PlanMealsData {
  /** The caller's local "today" (yyyy-MM-dd) — the plan anchor + the default single-day target. */
  today: string;
  /** The Monday (yyyy-MM-dd) of the viewed week, so a "week" plan lands on the visible grid. */
  weekStart: string;
  /** Whether the caller holds meals.use — gates the add-to-plan writes (else only the grocery action shows). */
  canPlan: boolean;
}

/** The dialog's lifecycle phases. */
type Phase = 'form' | 'loading' | 'plan' | 'empty' | 'error';

/** How many days the planner should cover: today only, or the whole visible week. */
type Scope = 'today' | 'week';

/** The four meal slots, with friendly labels + icons (display order). */
const SLOT_META: readonly { slot: FamilyMealSlot; label: string; icon: string }[] = [
  { slot: 'breakfast', label: 'Breakfast', icon: 'free_breakfast' },
  { slot: 'lunch', label: 'Lunch', icon: 'lunch_dining' },
  { slot: 'dinner', label: 'Dinner', icon: 'dinner_dining' },
  { slot: 'snack', label: 'Snack', icon: 'bakery_dining' },
];

/**
 * "✨ Plan my day / week" dialog — the robust, macro-aware planner. The user picks a scope (today / the week)
 * + which slots to fill + an optional refine, then ✨ generates a plan that fits their REMAINING macros. The
 * result renders per day, per slot: a dish title, a one-line why, the per-dish macros, and the FULL ingredient
 * list with each item badged "On your list" (with qty) vs "Need" — deterministically labelled server-side.
 *
 * From there it offers one-click ADD-TO-PLAN (writes the meals into the household Meal Planner via
 * /api/ai/plan-meals/to-plan — meals.use-gated) at the per-day or whole-plan level, and ADD-INGREDIENTS-TO-
 * GROCERY (qty-aware) at the per-item, per-day, or whole-plan level. The single-idea "What should I eat?" path
 * is untouched — this is its day/week sibling. Always-200 server floor: AI-off yields a deterministic fallback
 * plan labelled plainly. Mobile-robust (~95vw, one scroll region) like the other tracker dialogs.
 */
@Component({
  selector: 'app-plan-meals-dialog',
  imports: [
    DecimalPipe,
    FormsModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    MatButtonToggleModule,
    MatIconModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
  ],
  templateUrl: './plan-meals-dialog.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './plan-meals-dialog.scss',
})
export class PlanMealsDialog {
  private ref = inject(MatDialogRef<PlanMealsDialog, PlanMealsDialogResult>);
  private api = inject(Api);
  private snack = inject(MatSnackBar);
  private auth = inject(AuthService);
  readonly data = inject<PlanMealsData>(MAT_DIALOG_DATA);

  readonly slotMeta = SLOT_META;

  /**
   * Multimodal AI (the pantry-scan photo path) is gated by ai.vision — the SAME permission the server enforces
   * on /api/ai/scan-pantry — so we never show a vision action the server will 403. When false the whole
   * "What's in your pantry?" affordance is hidden and the planner simply runs without an on-hand list.
   */
  readonly canUseVision = this.auth.hasPermission(PERM.aiVision);

  // ---- form ----
  readonly scope = signal<Scope>('today');
  /** Which slots to fill (defaults to the three main meals; snack off). */
  private readonly slots = signal<Set<FamilyMealSlot>>(
    new Set<FamilyMealSlot>(['breakfast', 'lunch', 'dinner']),
  );
  readonly constraints = signal('');

  // ---- pantry (on-hand ingredients) ----
  /** The on-hand ingredients (from a pantry scan and/or manual entry), threaded into the plan request. */
  readonly pantry = signal<string[]>([]);
  /** True while a pantry-scan photo is being read by AI (drives the scan button's spinner/disabled state). */
  readonly pantryScanning = signal(false);

  // ---- result ----
  readonly phase = signal<Phase>('form');
  /** sr-only live announcement of fetch status / results. */
  readonly announce = signal('');
  /** The generated plan, per day. */
  readonly days = signal<PlanMealDay[]>([]);
  /** True on the friendly NON-AI fallback plan (Gemini off/unavailable) — drives the plain-label banner. */
  readonly fallback = signal(false);

  /** True while a generate is in flight (guards double-submit independent of the days length). */
  private inFlight = false;

  /** Whether any committed-to-plan write happened (so the caller reloads the grid on close). */
  private wrote = false;

  // ---- per-action busy state, keyed by a stable string while in flight ----
  private readonly busyKeys = signal<Set<string>>(new Set());

  /** At least one slot must be chosen to generate. */
  readonly hasSlots = computed(() => this.slots().size > 0);

  /** Total proposed meals across the plan (drives the whole-plan action labels). */
  readonly totalMeals = computed(() => this.days().reduce((n, d) => n + d.slots.length, 0));

  isSlotOn(slot: FamilyMealSlot): boolean {
    return this.slots().has(slot);
  }

  toggleSlot(slot: FamilyMealSlot): void {
    this.slots.update((set) => {
      const next = new Set(set);
      if (next.has(slot)) next.delete(slot);
      else next.add(slot);
      return next;
    });
  }

  setScope(scope: Scope): void {
    this.scope.set(scope);
  }

  // ─────────────────────────────────────────── pantry scan ─────────────────────────────────────

  /** Scan the pantry/fridge with the rear camera (mobile) / file picker (desktop) → detected ingredients. */
  scanPantry(): Promise<void> {
    return this.runPantryScan(captureImage);
  }

  /** Attach an existing photo from the gallery/files → detected ingredients (the sibling of scanPantry). */
  attachPantry(): Promise<void> {
    return this.runPantryScan(pickImage);
  }

  /**
   * Shared pantry-scan flow (mirrors add-food-dialog.runPhoto): one-time privacy notice, obtain the
   * (downscaled, in-memory) image, POST it to /api/ai/scan-pantry, and merge the detected ingredients into
   * the editable chip row (deduped). The image is only read to list ingredients — never stored. AI off /
   * empty (always-200 floor) snacks a friendly "nothing found"; an error snacks gracefully. Never throws.
   */
  private async runPantryScan(source: () => Promise<ImageRequest | null>): Promise<void> {
    if (!this.canUseVision || this.pantryScanning()) return;
    if (!(await confirmPhotoNotice())) return; // declined the privacy notice → abort, nothing sent.
    let image: ImageRequest | null;
    try {
      image = await source();
    } catch {
      this.snack.open('Could not read that image — try another photo', 'OK', { duration: 4000 });
      return;
    }
    if (!image) return; // picker cancelled.
    this.pantryScanning.set(true);
    this.announce.set('Scanning your pantry with AI…');
    try {
      const res = await firstValueFrom(this.api.scanPantry(image));
      const found = (res.ingredients ?? []).map((s) => s.trim()).filter(Boolean);
      if (found.length === 0) {
        this.snack.open(
          res.aiUsed
            ? "I couldn't spot any ingredients in that photo — try a clearer shot, or add them by hand"
            : 'AI is unavailable right now — add your ingredients by hand',
          'OK',
          { duration: 4000 },
        );
        return;
      }
      const added = this.mergePantry(found);
      this.announce.set(`Added ${added} ingredient${added === 1 ? '' : 's'} from your pantry photo.`);
    } catch {
      this.snack.open("Couldn't scan that photo — try again, or add ingredients by hand", 'Dismiss', {
        duration: 4000,
      });
    } finally {
      this.pantryScanning.set(false);
    }
  }

  // ─────────────────────────────────────────── pantry chips ────────────────────────────────────

  /** Append a manually-typed ingredient to the chip row (deduped, case-insensitive). No-op when blank. */
  addPantryItem(name: string): void {
    const clean = name.trim();
    if (!clean) return;
    this.mergePantry([clean]);
  }

  /** Remove the chip at `index` from the on-hand list. */
  removePantryItem(index: number): void {
    this.pantry.update((list) => list.filter((_, i) => i !== index));
  }

  /**
   * Edit the chip at `index` in place to `value`. Blank clears the chip (removes it); a value that would
   * duplicate another chip (case-insensitive) is dropped so the row stays deduped.
   */
  editPantryItem(index: number, value: string): void {
    const clean = value.trim();
    this.pantry.update((list) => {
      if (index < 0 || index >= list.length) return list;
      if (!clean) return list.filter((_, i) => i !== index);
      const dupe = list.some((p, i) => i !== index && p.toLowerCase() === clean.toLowerCase());
      if (dupe) return list.filter((_, i) => i !== index);
      return list.map((p, i) => (i === index ? clean : p));
    });
  }

  /**
   * Merge new ingredient names into the chip row, skipping case-insensitive duplicates of what's already
   * there (and within the batch). Returns how many were actually added (for the live announcement).
   */
  private mergePantry(names: string[]): number {
    let added = 0;
    this.pantry.update((list) => {
      const next = [...list];
      const seen = new Set(next.map((p) => p.toLowerCase()));
      for (const raw of names) {
        const clean = raw.trim();
        if (!clean) continue;
        const key = clean.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        next.push(clean);
        added++;
      }
      return next;
    });
    return added;
  }

  // ─────────────────────────────────────────── generate ────────────────────────────────────────

  /**
   * Generate the plan for the chosen scope/slots/refine. ALWAYS 200 server-side (a deterministic fallback
   * covers AI-off), but ANY error/empty degrades gracefully to the error/empty phase — never a dead-end.
   * Re-runs replace the prior plan.
   */
  async generate(): Promise<void> {
    if (this.inFlight || !this.hasSlots()) return;
    this.inFlight = true;
    this.phase.set('loading');
    this.announce.set('Building a plan that fits your remaining macros…');
    try {
      const res: PlanMealsResult = await firstValueFrom(
        this.api.planMeals({
          days: this.scope() === 'week' ? 7 : 1,
          slots: SLOT_META.map((m) => m.slot).filter((s) => this.slots().has(s)),
          constraints: this.constraints().trim() || null,
          weekStart: this.data.weekStart,
          ingredientsOnHand: this.pantry().length ? this.pantry() : null,
        }),
      );
      const days = (res.days ?? []).filter((d) => d.slots?.length);
      this.days.set(days);
      this.fallback.set(res.aiUsed === false);
      if (days.length === 0) {
        this.phase.set('empty');
        this.announce.set(
          res.aiUsed === false
            ? 'AI suggestions are off and there was nothing to plan from yet.'
            : "I couldn't put a plan together just now. Try a refine, or add meals manually.",
        );
      } else {
        this.phase.set('plan');
        const n = this.totalMeals();
        this.announce.set(
          res.aiUsed === false
            ? `Showing a ${days.length === 1 ? 'day' : days.length + '-day'} plan from your recent foods, recipes and groceries.`
            : `Here's a ${days.length === 1 ? 'day' : days.length + '-day'} plan — ${n} meal${n === 1 ? '' : 's'} that fit your remaining macros.`,
        );
      }
    } catch {
      this.days.set([]);
      this.phase.set('error');
      this.announce.set(
        "I couldn't reach the planner just now. Please try again, or add meals manually.",
      );
    } finally {
      this.inFlight = false;
    }
  }

  /** Back to the form to tweak scope/slots/refine and re-generate (keeps the current choices). */
  backToForm(): void {
    if (this.phase() === 'loading') return;
    this.phase.set('form');
  }

  // ─────────────────────────────────────────── helpers ─────────────────────────────────────────

  /** Whether add-to-plan affordances render — gated on meals.use (the server re-checks). */
  readonly canPlan = computed(() => this.data.canPlan);

  /** A friendly "Monday, Jun 23" label for a plan day, in the viewer's local zone. */
  dayLabel(localDate: string): string {
    const date = new Date(`${localDate}T00:00:00`);
    if (Number.isNaN(date.getTime())) return localDate;
    return (
      `${date.toLocaleDateString(undefined, { weekday: 'long' })}, ` +
      date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    );
  }

  slotLabel(slot: FamilyMealSlot): string {
    return SLOT_META.find((m) => m.slot === slot)?.label ?? slot;
  }

  slotIcon(slot: FamilyMealSlot): string {
    return SLOT_META.find((m) => m.slot === slot)?.icon ?? 'restaurant';
  }

  /** The slot's ingredients NOT yet on the household grocery list (drives the per-slot "Add needed" count). */
  missingCount(s: PlanMealSlot): number {
    return (s.ingredients ?? []).filter((i) => !i.onList && i.name?.trim()).length;
  }

  isBusy(key: string): boolean {
    return this.busyKeys().has(key);
  }

  private setBusy(key: string, on: boolean): void {
    this.busyKeys.update((set) => {
      const next = new Set(set);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  /**
   * Locally mark a slot's ingredient as now on the grocery list (each grocery write returns the WHOLE list,
   * not this DTO), bumping its listedQty so the badge flips without a re-fetch.
   */
  private markOnList(
    dayIndex: number,
    slotIndex: number,
    ingIndex: number,
    addedQty: number,
  ): void {
    this.days.update((days) =>
      days.map((d, di) => {
        if (di !== dayIndex) return d;
        const slots = d.slots.map((s, si) => {
          if (si !== slotIndex) return s;
          const ingredients = s.ingredients.map((ing, ii) => {
            if (ii !== ingIndex) return ing;
            const prior = ing.onList ? (ing.listedQty ?? 1) : 0;
            return { ...ing, onList: true, listedQty: prior + addedQty } as EatIngredient;
          });
          return { ...s, ingredients };
        });
        return { ...d, slots };
      }),
    );
  }

  /** A plan slot → the write payload for /api/ai/plan-meals/to-plan (macros ride along, source "ai"). */
  private toWrite(localDate: string, s: PlanMealSlot): PlanMealToWrite {
    const ingredients = (s.ingredients ?? [])
      .map((i) => (i.quantity?.trim() ? `${i.name.trim()} (${i.quantity.trim()})` : i.name.trim()))
      .filter(Boolean)
      .join('\n');
    return {
      localDate,
      slot: s.slot,
      title: s.title,
      ingredients: ingredients || null,
      servings: 1,
      calories: Math.max(0, Math.round(s.macros.calories)),
      proteinG: Math.max(0, s.macros.proteinG),
      carbG: Math.max(0, s.macros.carbsG),
      fatG: Math.max(0, s.macros.fatG),
      macroSource: 'ai',
    };
  }

  // ─────────────────────────────────────────── add to plan ─────────────────────────────────────

  /** Write a single proposed slot into the household Meal Planner (meals.use-gated). */
  async addSlotToPlan(
    dayIndex: number,
    slotIndex: number,
    localDate: string,
    s: PlanMealSlot,
  ): Promise<void> {
    const key = `plan:${dayIndex}:${slotIndex}`;
    if (!this.canPlan() || this.isBusy(key)) return;
    this.setBusy(key, true);
    try {
      const res = await firstValueFrom(this.api.planMealsToPlan([this.toWrite(localDate, s)]));
      if (res.added > 0) this.wrote = true;
      this.snack.open(`Added “${s.title}” to your plan`, 'OK', { duration: 3000 });
    } catch {
      this.snack.open("Couldn't add that to the plan — try again", 'Dismiss', { duration: 4000 });
    } finally {
      this.setBusy(key, false);
    }
  }

  /** Write a whole day's proposed slots into the plan in one call. */
  async addDayToPlan(dayIndex: number, day: PlanMealDay): Promise<void> {
    const key = `planDay:${dayIndex}`;
    if (!this.canPlan() || this.isBusy(key) || day.slots.length === 0) return;
    this.setBusy(key, true);
    try {
      const res = await firstValueFrom(
        this.api.planMealsToPlan(day.slots.map((s) => this.toWrite(day.localDate, s))),
      );
      if (res.added > 0) this.wrote = true;
      this.snack.open(`Added ${res.added} meal${res.added === 1 ? '' : 's'} to your plan`, 'OK', {
        duration: 3000,
      });
    } catch {
      this.snack.open("Couldn't add that day to the plan — try again", 'Dismiss', {
        duration: 4000,
      });
    } finally {
      this.setBusy(key, false);
    }
  }

  /** Write the WHOLE plan into the Meal Planner, then offer to send its ingredients to grocery. */
  async addAllToPlan(): Promise<void> {
    const key = 'planAll';
    if (!this.canPlan() || this.isBusy(key) || this.totalMeals() === 0) return;
    this.setBusy(key, true);
    const meals: PlanMealToWrite[] = [];
    for (const d of this.days()) for (const s of d.slots) meals.push(this.toWrite(d.localDate, s));
    try {
      const res = await firstValueFrom(this.api.planMealsToPlan(meals));
      if (res.added > 0) this.wrote = true;
      const n = res.added;
      const r = this.snack.open(
        `Added ${n} meal${n === 1 ? '' : 's'} to your plan`,
        'Add ingredients to grocery',
        { duration: 6000 },
      );
      r.onAction().subscribe(() => {
        void this.addAllToGrocery();
      });
    } catch {
      this.snack.open("Couldn't add the plan — try again", 'Dismiss', { duration: 4000 });
    } finally {
      this.setBusy(key, false);
    }
  }

  // ─────────────────────────────────────────── add to grocery ──────────────────────────────────

  /** Quantity-aware add of a single ingredient onto the household Groceries list (bumps "xN" if present). */
  async addIngredientToGrocery(
    dayIndex: number,
    slotIndex: number,
    ingIndex: number,
    ing: EatIngredient,
  ): Promise<void> {
    const name = ing.name?.trim();
    const key = `ing:${dayIndex}:${slotIndex}:${ingIndex}`;
    if (!name || this.isBusy(key)) return;
    this.setBusy(key, true);
    try {
      await firstValueFrom(this.api.groceryAddQuantity(name, 1));
      this.markOnList(dayIndex, slotIndex, ingIndex, 1);
      this.snack.open(`Added “${name}” to your grocery list`, 'OK', { duration: 2500 });
    } catch {
      this.snack.open("Couldn't add that to the grocery list — try again", 'Dismiss', {
        duration: 4000,
      });
    } finally {
      this.setBusy(key, false);
    }
  }

  /** Add a slot's NEEDED items (those not already on the list) to the household Groceries list. */
  async addSlotNeededToGrocery(
    dayIndex: number,
    slotIndex: number,
    s: PlanMealSlot,
  ): Promise<void> {
    const key = `grocery:${dayIndex}:${slotIndex}`;
    if (this.isBusy(key)) return;
    const needed = (s.ingredients ?? [])
      .map((i, ii) => ({ i, ii }))
      .filter(({ i }) => !i.onList && i.name?.trim());
    if (needed.length === 0) {
      this.snack.open('Nothing needed — it’s all on your list', 'OK', { duration: 2500 });
      return;
    }
    this.setBusy(key, true);
    try {
      await firstValueFrom(this.api.recipeBreakdownToGrocery(needed.map(({ i }) => i.name.trim())));
      for (const { ii } of needed) this.markOnList(dayIndex, slotIndex, ii, 1);
      const n = needed.length;
      this.snack.open(`Added ${n} item${n === 1 ? '' : 's'} to your grocery list`, 'OK', {
        duration: 3000,
      });
    } catch {
      this.snack.open("Couldn't add to the grocery list — try again", 'Dismiss', {
        duration: 4000,
      });
    } finally {
      this.setBusy(key, false);
    }
  }

  /** Add EVERY needed ingredient across the whole plan to the household Groceries list (de-duped server-side). */
  async addAllToGrocery(): Promise<void> {
    const key = 'groceryAll';
    if (this.isBusy(key)) return;
    const names: string[] = [];
    this.days().forEach((d, di) =>
      d.slots.forEach((s, si) => {
        (s.ingredients ?? []).forEach((ing, ii) => {
          if (!ing.onList && ing.name?.trim()) names.push(ing.name.trim());
          void di;
          void si;
          void ii;
        });
      }),
    );
    if (names.length === 0) {
      this.snack.open('Nothing needed — it’s all on your list', 'OK', { duration: 2500 });
      return;
    }
    this.setBusy(key, true);
    try {
      await firstValueFrom(this.api.recipeBreakdownToGrocery(names));
      // Reflect locally: flip every not-on-list ingredient to on-list.
      this.days.update((days) =>
        days.map((d) => ({
          ...d,
          slots: d.slots.map((s) => ({
            ...s,
            ingredients: s.ingredients.map((ing) =>
              ing.name?.trim() && !ing.onList
                ? ({ ...ing, onList: true, listedQty: (ing.listedQty ?? 0) + 1 } as EatIngredient)
                : ing,
            ),
          })),
        })),
      );
      const n = names.length;
      this.snack.open(`Added ${n} ingredient${n === 1 ? '' : 's'} to your grocery list`, 'OK', {
        duration: 3000,
      });
    } catch {
      this.snack.open("Couldn't add to the grocery list — try again", 'Dismiss', {
        duration: 4000,
      });
    } finally {
      this.setBusy(key, false);
    }
  }

  /** Whether the whole plan still has any needed (not-on-list) ingredient — gates the whole-plan grocery button. */
  readonly hasAnyNeeded = computed(() =>
    this.days().some((d) =>
      d.slots.some((s) => s.ingredients.some((i) => !i.onList && i.name?.trim())),
    ),
  );

  // ─────────────────────────────────────────── close ───────────────────────────────────────────

  /** Close, telling the caller whether anything was written to the plan (so it can reload the grid). */
  close(): void {
    this.ref.close(this.wrote ? 'wrote' : undefined);
  }
}

/** The dialog resolves with `'wrote'` when at least one meal was committed to the plan (else undefined). */
export type PlanMealsDialogResult = 'wrote' | undefined;
