import {
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
  ChangeDetectionStrategy,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { catchError, firstValueFrom, of } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';

import { Api } from '../../core/api';
import { AuthService } from '../../core/auth';
import {
  FamilyMeal,
  FamilyMealDay,
  FamilyMealSlot,
  HouseholdMember,
  PERM,
  TrackerProfileDto,
} from '../../core/models';
import { FamilyConfirmDialog, ConfirmData } from '../family/confirm-dialog';
import {
  AddMealToTrackerDialog,
  AddMealToTrackerData,
  AddMealToTrackerResult,
} from './add-meal-to-tracker-dialog';
import { MealEditorDialog, MealEditorData, MealEditorResult } from '../family/meal-editor-dialog';
import { WhatToEatDialog, WhatToEatData } from '../tracker/what-to-eat-dialog';
import {
  PlanMealsDialog,
  PlanMealsData,
  PlanMealsDialogResult,
} from '../tracker/plan-meals-dialog';
import {
  RefineMealDialog,
  RefineMealData,
  RefineMealDialogResult,
} from '../tracker/refine-meal-dialog';

/** A day's planned-macro rollup (sum of each meal's per-serving macros), with optional goal comparisons. */
interface DayRollup {
  hasMacros: boolean;
  calories: number;
  proteinG: number;
  carbG: number;
  fatG: number;
}

/** A day cell as rendered: the ISO date, friendly labels, today flag, its meals, and its macro rollup. */
interface DayCell {
  localDate: string;
  weekday: string;
  dateLabel: string;
  isToday: boolean;
  meals: FamilyMeal[];
  rollup: DayRollup;
}

/** Pretty labels + icons for each slot (dinner is the primary slot at the table). */
const SLOT_META: Record<FamilyMealSlot, { label: string; icon: string }> = {
  dinner: { label: 'Dinner', icon: 'dinner_dining' },
  breakfast: { label: 'Breakfast', icon: 'free_breakfast' },
  lunch: { label: 'Lunch', icon: 'lunch_dining' },
  snack: { label: 'Snack', icon: 'bakery_dining' },
};

/**
 * Meal Planner Tool — the standalone /meal-planner page (gated meals.use), pulled out of the Family Hub into
 * the Tools nav. A warm weekly grid of what's planned across all four slots: each day is a card with its meals
 * (add/edit/delete), a per-serving daily macro rollup (vs the caller's goals when set), week navigation, and a
 * one-tap "Add this week's ingredients to grocery list". It reuses the existing household-scoped FamilyMeals
 * endpoints (/api/family/meals) directly — solo users auto-get a household server-side, exactly like the
 * Grocery tool — so the family meal↔grocery↔macros interconnect is untouched.
 *
 * The ROBUST what-to-eat lives here as "✨ Plan my day & week" (tracker.ai): a macro-aware multi-day planner
 * (PlanMealsDialog) that shows on-list/need ingredient labels and offers one-click add-to-plan + qty-aware
 * add-to-grocery. The single-idea "What should I eat?" stays available too. Authors are rendered by display
 * name only; an email is never shown (email-privacy). Mobile-friendly.
 */
@Component({
  selector: 'app-meal-planner',
  imports: [
    FormsModule,
    MatIconModule,
    MatButtonModule,
    MatTooltipModule,
    MatProgressSpinnerModule,
    MatSnackBarModule,
  ],
  templateUrl: './meal-planner.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrls: ['../family/family.scss', '../family/meals.scss', './meal-planner.scss'],
})
export class MealPlanner {
  private api = inject(Api);
  private auth = inject(AuthService);
  private dialog = inject(MatDialog);
  private snack = inject(MatSnackBar);
  private router = inject(Router);
  private destroyRef = inject(DestroyRef);

  readonly days = signal<FamilyMealDay[]>([]);
  readonly loading = signal(true);
  readonly error = signal(false);
  /** True while the whole-week "add to grocery" call is in flight (locks the button). */
  readonly addingWeek = signal(false);

  /**
   * "✨ Plan my day & week" + "What should I eat?" are tracker-AI (macro/goal-aware), gated tracker.ai — the
   * server floors gracefully, but we hide the buttons without it. Read auth.permissions() so this recomputes
   * when permissions load.
   */
  readonly canTrackerAi = computed(() => {
    this.auth.permissions();
    return this.auth.hasPermission(PERM.trackerAi);
  });

  /** Whether the caller holds tracker.self (gates the per-meal "Add to my tracker" + goal comparisons). */
  readonly canTrack = computed(() => {
    this.auth.permissions();
    return this.auth.hasPermission(PERM.trackerSelf);
  });
  /** The caller's own tracker profile/goals (loaded once when they hold tracker.self), or null. */
  readonly trackerProfile = signal<TrackerProfileDto | null>(null);
  /** The meal id currently being logged to the tracker (locks just that card's button), or null. */
  readonly loggingMealId = signal<number | null>(null);
  /**
   * The household members for the "whose tracker?" picker, loaded once on first use (cached). Null until the
   * first load; on failure or without family.use we fall back to a Me-only list inside the dialog.
   */
  private householdMembers: HouseholdMember[] | null = null;

  /** The Monday (local) of the week being viewed. */
  readonly weekStart = signal<Date>(this.thisMonday());

  /**
   * "On hand" ingredients handed off from the Snap & Route pantry capture (sessionStorage, read + cleared on
   * init). When present they show as removable chips and bias the "Plan my day & week" AI plan toward what the
   * caller already has — see the constructor for the read/clear + openPlanMyWeek for the handoff into the dialog.
   */
  readonly onHand = signal<string[]>([]);

  /** "YYYY-MM-DD" for the API, derived from the viewed week's Monday. */
  private readonly weekStartIso = computed(() => this.toIso(this.weekStart()));

  /** A friendly "Jun 23 – 29" range label for the week header. */
  readonly weekLabel = computed(() => {
    const start = this.weekStart();
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    const sameMonth = start.getMonth() === end.getMonth();
    const startLbl = start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const endLbl = end.toLocaleDateString(
      undefined,
      sameMonth ? { day: 'numeric' } : { month: 'short', day: 'numeric' },
    );
    return `${startLbl} – ${endLbl}`;
  });

  /** True when the viewed week contains today (so we can offer a "This week" reset). */
  readonly isThisWeek = computed(
    () => this.toIso(this.weekStart()) === this.toIso(this.thisMonday()),
  );

  /** The 7 day cells with friendly labels + a today flag + a planned-macro rollup, from the loaded days. */
  readonly cells = computed<DayCell[]>(() => {
    const todayIso = this.toIso(new Date());
    return this.days().map((d) => {
      const date = new Date(`${this.dateOnly(d.localDate)}T00:00:00`);
      return {
        localDate: this.dateOnly(d.localDate),
        weekday: date.toLocaleDateString(undefined, { weekday: 'long' }),
        dateLabel: date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
        isToday: this.dateOnly(d.localDate) === todayIso,
        meals: d.meals,
        rollup: this.rollup(d.meals),
      };
    });
  });

  /** Total meals planned across the visible week (drives the empty-week hint + the grocery button). */
  readonly mealCount = computed(() => this.cells().reduce((n, c) => n + c.meals.length, 0));

  /** The whole-week planned-macro total (sum of every day's per-serving rollup). */
  readonly weekRollup = computed<DayRollup>(() =>
    this.cells().reduce<DayRollup>(
      (acc, c) => ({
        hasMacros: acc.hasMacros || c.rollup.hasMacros,
        calories: acc.calories + c.rollup.calories,
        proteinG: this.round1(acc.proteinG + c.rollup.proteinG),
        carbG: this.round1(acc.carbG + c.rollup.carbG),
        fatG: this.round1(acc.fatG + c.rollup.fatG),
      }),
      { hasMacros: false, calories: 0, proteinG: 0, carbG: 0, fatG: 0 },
    ),
  );

  readonly calorieGoal = computed(() =>
    this.canTrack() ? (this.trackerProfile()?.dailyCalorieGoal ?? null) : null,
  );
  readonly proteinGoal = computed(() =>
    this.canTrack() ? (this.trackerProfile()?.proteinGoalG ?? null) : null,
  );
  readonly showGoals = computed(() => this.canTrack() && this.calorieGoal() != null);
  readonly hasWeekMacros = computed(() => this.weekRollup().hasMacros);

  constructor() {
    this.reload(true);
    this.consumePantryHandoff();
    if (this.canTrack()) {
      this.api
        .trackerProfile()
        .pipe(
          catchError(() => of<TrackerProfileDto | null>(null)),
          takeUntilDestroyed(this.destroyRef),
        )
        .subscribe((p) => this.trackerProfile.set(p));
    }
  }

  /**
   * Read (and immediately CLEAR) the Snap & Route pantry handoff from sessionStorage. Clearing on consume means
   * the on-hand chips only appear on the visit right after a pantry snap — a later normal visit won't re-apply
   * stale chips. Malformed JSON / non-array / unavailable storage all degrade silently to no chips.
   */
  private consumePantryHandoff(): void {
    try {
      const raw = sessionStorage.getItem('usage_iq_pantry_on_hand');
      if (!raw) return;
      sessionStorage.removeItem('usage_iq_pantry_on_hand');
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      const items = Array.from(
        new Set(
          parsed
            .filter((x): x is string => typeof x === 'string')
            .map((x) => x.trim())
            .filter((x) => x.length > 0),
        ),
      );
      if (items.length) this.onHand.set(items);
    } catch {
      /* malformed JSON or sessionStorage unavailable → no on-hand chips, non-fatal. */
    }
  }

  /** Remove one on-hand chip (it then drops from the next "Plan my day & week" request's bias). */
  removeOnHand(ingredient: string): void {
    this.onHand.update((list) => list.filter((x) => x !== ingredient));
  }

  /** Sum a day's meals' PER-SERVING macros (one planned portion each); flags whether any had macros set. */
  private rollup(meals: FamilyMeal[]): DayRollup {
    let calories = 0,
      proteinG = 0,
      carbG = 0,
      fatG = 0,
      hasMacros = false;
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
      proteinG: this.round1(proteinG),
      carbG: this.round1(carbG),
      fatG: this.round1(fatG),
    };
  }

  private round1(n: number): number {
    return Math.round((Number.isFinite(n) ? n : 0) * 10) / 10;
  }

  private reload(initial = false): void {
    if (initial) this.loading.set(true);
    this.api
      .familyMeals(this.weekStartIso())
      .pipe(
        catchError(() => {
          if (initial) this.error.set(true);
          return of<FamilyMealDay[]>([]);
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((days) => {
        this.days.set(days);
        this.loading.set(false);
      });
  }

  /** Step the viewed week by ±1 and reload. */
  shiftWeek(deltaWeeks: number): void {
    const next = new Date(this.weekStart());
    next.setDate(next.getDate() + deltaWeeks * 7);
    this.weekStart.set(next);
    this.reload();
  }

  /** Jump back to the current week. */
  goThisWeek(): void {
    if (this.isThisWeek()) return;
    this.weekStart.set(this.thisMonday());
    this.reload();
  }

  slotMeta(slot: FamilyMealSlot) {
    return SLOT_META[slot] ?? SLOT_META.dinner;
  }

  // ---- Macros (per-meal display + "✨ Add to my tracker") ----

  hasMacros(meal: FamilyMeal): boolean {
    return meal.macroSource !== 'none';
  }

  macroTag(meal: FamilyMeal): string {
    switch (meal.macroSource) {
      case 'ai':
        return 'AI estimate';
      case 'database':
        return 'from food DB';
      case 'manual':
        return 'manual';
      default:
        return 'not set';
    }
  }

  canAddToTracker(meal: FamilyMeal): boolean {
    return this.canTrack() && this.hasMacros(meal);
  }

  /**
   * Open the small "Add to tracker" dialog for a planned meal: pick how many servings (default 1) and whose
   * tracker (Me + household co-members), with a live macro preview. On Add, log per-serving × servings onto the
   * chosen tracker day (dinner, on the meal's planned date). Keeps the per-card busy-lock (`loggingMealId`) +
   * graceful snackbars. Hidden/disabled under exactly the same conditions as before (`canAddToTracker`).
   */
  async addToTracker(meal: FamilyMeal): Promise<void> {
    if (this.loggingMealId() !== null || !this.canAddToTracker(meal)) return;

    const members = await this.loadHouseholdMembers();
    const data: AddMealToTrackerData = { meal, members };
    const choice = await firstValueFrom(
      this.dialog
        .open<AddMealToTrackerDialog, AddMealToTrackerData, AddMealToTrackerResult>(
          AddMealToTrackerDialog,
          {
            data,
            width: '460px',
            maxWidth: '94vw',
            maxHeight: '92dvh',
            panelClass: 'tracker-dialog',
            autoFocus: false,
          },
        )
        .afterClosed(),
    );
    if (!choice) return;

    this.loggingMealId.set(meal.id);
    try {
      await firstValueFrom(
        this.api.addMealToTracker(meal.id, {
          localDate: this.dateOnly(meal.localDate),
          servings: choice.servings,
          targetUserId: choice.targetUserId,
        }),
      );
      const n = choice.servings;
      const serving = n === 1 ? 'serving' : 'servings';
      const ref = this.snack.open(
        `Added ${n} ${serving} of “${meal.title}” to ${choice.targetName} tracker.`,
        'Open tracker',
        { duration: 5000 },
      );
      ref.onAction().subscribe(() => {
        this.router.navigateByUrl('/tracker');
      });
    } catch (e) {
      this.snack.open(
        this.messageOf(e, "Couldn't add this meal to the tracker. Please try again."),
        'OK',
        { duration: 4000 },
      );
    } finally {
      this.loggingMealId.set(null);
    }
  }

  /**
   * The household members for the "whose tracker?" picker, loaded once and cached. Without family.use (or on
   * any error) we fall back to an empty list — the dialog then offers a Me-only choice, so self-logging always
   * works. Identity is display name only (never an email).
   */
  private async loadHouseholdMembers(): Promise<HouseholdMember[]> {
    if (this.householdMembers) return this.householdMembers;
    if (!this.auth.hasPermission(PERM.familyUse)) {
      this.householdMembers = [];
      return this.householdMembers;
    }
    try {
      const household = await firstValueFrom(this.api.getHousehold());
      this.householdMembers = household.members ?? [];
    } catch {
      this.householdMembers = [];
    }
    return this.householdMembers;
  }

  // ---- Meals (add / edit / delete) ----

  /** Add a meal to a specific day (default slot = dinner). Macros (if entered manually) ride along. */
  async addMeal(cell: DayCell, slot: FamilyMealSlot = 'dinner'): Promise<void> {
    const result = await this.openEditor(
      null,
      cell.localDate,
      `${cell.weekday}, ${cell.dateLabel}`,
      slot,
    );
    if (!result) return;
    try {
      await firstValueFrom(
        this.api.createFamilyMeal({
          localDate: cell.localDate,
          slot: result.slot,
          title: result.title,
          ingredients: result.ingredients,
          ...this.macroPayload(result),
        }),
      );
      this.reload();
    } catch (e) {
      this.snack.open(this.messageOf(e, "Couldn't save that meal. Please try again."), 'OK', {
        duration: 4000,
      });
    }
  }

  /** Edit an existing meal on a day. PATCHes the plain fields + the macros. */
  async editMeal(cell: DayCell, meal: FamilyMeal): Promise<void> {
    const result = await this.openEditor(
      meal,
      cell.localDate,
      `${cell.weekday}, ${cell.dateLabel}`,
    );
    if (!result) return;
    try {
      await firstValueFrom(
        this.api.patchFamilyMeal(meal.id, {
          slot: result.slot,
          title: result.title,
          ingredients: result.ingredients,
          ...this.macroPayload(result),
        }),
      );
      this.reload();
    } catch (e) {
      this.snack.open(this.messageOf(e, "Couldn't save that meal. Please try again."), 'OK', {
        duration: 4000,
      });
    }
  }

  private macroPayload(r: MealEditorResult) {
    return {
      servings: r.servings,
      calories: r.calories,
      proteinG: r.proteinG,
      carbG: r.carbG,
      fatG: r.fatG,
      macroSource: r.macroSource,
    };
  }

  async removeMeal(meal: FamilyMeal): Promise<void> {
    const ok = await this.confirm({
      title: 'Remove this meal?',
      message: `“${meal.title}” will be taken off the plan.`,
      destructive: true,
    });
    if (!ok) return;
    try {
      await firstValueFrom(this.api.deleteFamilyMeal(meal.id));
      this.reload();
    } catch {
      this.snack.open("Couldn't remove that meal.", 'OK', { duration: 4000 });
    }
  }

  private openEditor(
    meal: FamilyMeal | null,
    localDate: string,
    dayLabel: string,
    defaultSlot?: FamilyMealSlot,
  ): Promise<MealEditorResult | undefined> {
    const ref = this.dialog.open<MealEditorDialog, MealEditorData, MealEditorResult>(
      MealEditorDialog,
      {
        data: { meal, localDate, dayLabel, defaultSlot },
        width: '460px',
        maxWidth: '94vw',
        autoFocus: false,
        panelClass: 'family-dialog',
      },
    );
    return firstValueFrom(ref.afterClosed());
  }

  // ---- ✨ Plan my day & week (robust macro-aware planner) ----

  /**
   * Open the robust "Plan my day & week" dialog (tracker.ai). It generates a macro-aware multi-day plan that
   * fits the caller's remaining budget, labels each ingredient on-list/need against the grocery list, and
   * offers one-click add-to-plan (meals.use; the caller has it to be on this page) + qty-aware add-to-grocery.
   * On close, if anything was written to the plan we reload the grid.
   */
  openPlanMyWeek(): void {
    if (!this.canTrackerAi()) return;
    const data: PlanMealsData = {
      today: this.toIso(new Date()),
      weekStart: this.weekStartIso(),
      canPlan: this.auth.hasPermission(PERM.mealsUse),
      ingredientsOnHand: this.onHand().length ? this.onHand() : null,
    };
    this.dialog
      .open<PlanMealsDialog, PlanMealsData, PlanMealsDialogResult>(PlanMealsDialog, {
        data,
        width: '680px',
        maxWidth: '95vw',
        maxHeight: '92dvh',
        panelClass: 'tracker-dialog',
        autoFocus: false,
      })
      .afterClosed()
      .subscribe((result) => {
        if (result === 'wrote') this.reload();
      });
  }

  // ---- ✨ Refine with AI (rewrite one planned meal to honour a free-text preference) ----

  /**
   * Open the "Refine with AI" dialog for a single planned meal (tracker.ai). The user gives a free-text
   * preference, previews the AI rewrite, and on Apply the dialog PATCHes the meal (per-serving → dish-total
   * macros, source "ai"). On a `'wrote'` close we reload the grid. Hidden without tracker.ai.
   */
  refineMeal(cell: DayCell, meal: FamilyMeal): void {
    if (!this.canTrackerAi()) return;
    void cell; // the dialog edits the meal directly; the cell is only for caller symmetry with editMeal.
    const data: RefineMealData = { meal };
    this.dialog
      .open<RefineMealDialog, RefineMealData, RefineMealDialogResult>(RefineMealDialog, {
        data,
        width: '560px',
        maxWidth: '95vw',
        maxHeight: '92dvh',
        panelClass: 'tracker-dialog',
        autoFocus: false,
      })
      .afterClosed()
      .subscribe((result) => {
        if (result === 'wrote') this.reload();
      });
  }

  // ---- ✨ What should I eat? (single-idea tracker-AI; unchanged) ----

  /** Open the single-idea "What should I eat?" modal (tracker-AI; gated tracker.ai). */
  openWhatToEat(): void {
    if (!this.canTrackerAi()) return;
    const data: WhatToEatData = {
      date: this.toIso(new Date()),
      meal: 'dinner',
      remaining: null,
      // This is the Meal Planner tool; the caller has meals.use → the plan/grocery actions are valid.
      canFamily: this.auth.hasPermission(PERM.mealsUse) || this.auth.hasPermission(PERM.familyUse),
      canRecipes: this.auth.hasPermission(PERM.recipesUse),
    };
    this.dialog
      .open(WhatToEatDialog, {
        data,
        width: '640px',
        maxWidth: '95vw',
        maxHeight: '92dvh',
        panelClass: 'tracker-dialog',
        autoFocus: false,
      })
      .afterClosed()
      .subscribe(() => this.reload());
  }

  // ---- Grocery-list tie-in ----

  hasIngredients(meal: FamilyMeal): boolean {
    return meal.ingredients.split('\n').some((s) => s.trim().length > 0);
  }

  /** Pour the whole visible week's ingredients into the household's grocery list. */
  async addWeekToGrocery(): Promise<void> {
    if (this.addingWeek() || this.mealCount() === 0) return;
    this.addingWeek.set(true);
    try {
      const before = await this.groceryOpenCount();
      const list = await firstValueFrom(
        this.api.mealsToGrocery({ weekStart: this.weekStartIso() }),
      );
      this.reportAdded(list.items.filter((i) => !i.done).length - before, list.name);
    } catch {
      this.snack.open("Couldn't add this week's ingredients. Please try again.", 'OK', {
        duration: 4000,
      });
    } finally {
      this.addingWeek.set(false);
    }
  }

  /** Pour a single meal's ingredients into the household's grocery list. */
  async addMealToGrocery(meal: FamilyMeal): Promise<void> {
    try {
      const before = await this.groceryOpenCount();
      const list = await firstValueFrom(this.api.mealsToGrocery({ mealIds: [meal.id] }));
      this.reportAdded(list.items.filter((i) => !i.done).length - before, list.name);
    } catch {
      this.snack.open("Couldn't add those ingredients. Please try again.", 'OK', {
        duration: 4000,
      });
    }
  }

  /** The current open-item count of the household's Groceries list (best-effort) for an accurate "added N". */
  private async groceryOpenCount(): Promise<number> {
    try {
      const lists = await firstValueFrom(this.api.familyLists());
      const groceries =
        lists.find((l) => l.kind === 'shopping' && /groceries/i.test(l.name)) ??
        lists.find((l) => l.kind === 'shopping');
      return groceries ? groceries.items.filter((i) => !i.done).length : 0;
    } catch {
      return 0;
    }
  }

  private reportAdded(added: number, listName: string): void {
    const n = Math.max(0, added);
    const msg =
      n === 0
        ? `Everything was already on “${listName}.”`
        : `Added ${n} ${n === 1 ? 'ingredient' : 'ingredients'} to “${listName}.”`;
    const ref = this.snack.open(msg, 'View grocery list', { duration: 5000 });
    ref.onAction().subscribe(() => {
      this.router.navigateByUrl('/grocery');
    });
  }

  // ---- Date helpers (the household's week starts Monday, like the backend) ----

  private thisMonday(): Date {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    const offset = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - offset);
    return d;
  }

  private toIso(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  private dateOnly(iso: string): string {
    return iso.length >= 10 ? iso.slice(0, 10) : iso;
  }

  private confirm(data: ConfirmData): Promise<boolean | undefined> {
    const ref = this.dialog.open<FamilyConfirmDialog, ConfirmData, boolean>(FamilyConfirmDialog, {
      data,
      width: '420px',
      maxWidth: '92vw',
      panelClass: 'family-dialog',
    });
    return firstValueFrom(ref.afterClosed());
  }

  private messageOf(e: unknown, fallback: string): string {
    const msg = (e as { error?: { message?: string } })?.error?.message;
    return typeof msg === 'string' && msg ? msg : fallback;
  }
}
