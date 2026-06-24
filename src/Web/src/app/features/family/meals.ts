import {
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
  ChangeDetectionStrategy,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { catchError, firstValueFrom, of } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';

import { Api } from '../../core/api';
import { AuthService } from '../../core/auth';
import {
  FamilyMeal,
  FamilyMealDay,
  FamilyMealSlot,
  MealIdea,
  PERM,
  PlanWeekMeal,
  RecipeBreakdownResult,
  RecipeFromBreakdownRequest,
  RecipeIngredient,
  TrackerProfileDto,
} from '../../core/models';
import { FamilyConfirmDialog, ConfirmData } from './confirm-dialog';
import { MealEditorDialog, MealEditorData, MealEditorResult } from './meal-editor-dialog';
import { WhatToEatDialog, WhatToEatData } from '../tracker/what-to-eat-dialog';
import {
  RefineMealDialog,
  RefineMealData,
  RefineMealDialogResult,
} from '../tracker/refine-meal-dialog';

/** A day's planned-macro rollup (sum of each meal's per-serving macros), with optional goal comparisons. */
interface DayRollup {
  /** True when at least one meal on the day has macros set (else we hide the rollup). */
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
  /** Sum of each meal's PER-SERVING macros for the day (planned, one-portion). */
  rollup: DayRollup;
}

/** Which dinners "Plan our week" should propose: only the empty slots, or all seven. */
type FillSlots = 'emptyDinners' | 'allDinners';

/** One AI-proposed dinner the family can edit/remove before adding it to the plan. */
interface ProposedMeal {
  /** Stable key for @for tracking (the AI list has no ids). */
  key: number;
  localDate: string;
  /** A friendly "Monday, Jun 23" label for the row, in the viewer's local zone. */
  dayLabel: string;
  title: string;
  /** Raw newline-separated ingredient text (editable in the row). */
  ingredients: string;
}

/** One editable ingredient row in the recipe-breakdown review (a name + a free-text quantity). */
interface RecipeRow {
  /** Stable key for @for tracking (the AI list has no ids). */
  key: number;
  name: string;
  quantity: string;
}

/** Pretty labels + icons for each slot (dinner is the primary slot at the table). */
const SLOT_META: Record<FamilyMealSlot, { label: string; icon: string }> = {
  dinner: { label: 'Dinner', icon: 'dinner_dining' },
  breakfast: { label: 'Breakfast', icon: 'free_breakfast' },
  lunch: { label: 'Lunch', icon: 'lunch_dining' },
  snack: { label: 'Snack', icon: 'bakery_dining' },
};

/**
 * Family Meal Planner — a warm weekly view of what's for dinner (and the other slots). Each day is a card
 * showing its planned meals; members can add/edit a dish (title + an ingredients textarea, one per line)
 * and prev/next-week navigate. A prominent "Add this week's ingredients to grocery list" button (and a
 * per-meal add) pours the ingredient lines into the household's Groceries list (reusing the F1 list model)
 * and confirms how many items were added — then the Lists page shows them.
 *
 * Authors are rendered by display name only; an email is never shown (email-privacy). Mobile-friendly.
 */
@Component({
  selector: 'app-family-meals',
  imports: [
    FormsModule,
    RouterLink,
    MatIconModule,
    MatButtonModule,
    MatButtonToggleModule,
    MatTooltipModule,
    MatProgressSpinnerModule,
    MatFormFieldModule,
    MatInputModule,
    MatSnackBarModule,
  ],
  templateUrl: './meals.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrls: ['./family.scss', './meals.scss'],
})
export class FamilyMeals {
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
   * AI gating: the generative family-AI affordances (Plan our week / What can I make / Recipe breakdown) need
   * family.ai — the server 403s without it, so we hide the buttons too. Read auth.permissions() so this
   * recomputes when permissions load.
   */
  readonly canFamilyAi = computed(() => {
    this.auth.permissions();
    return this.auth.hasPermission(PERM.familyAi);
  });

  /**
   * "What should I eat?" is tracker-AI (macro/goal-aware), gated by tracker.ai — a SEPARATE permission from
   * the family-AI buttons. Show it here too since the meal planner is a natural home for it. Read
   * auth.permissions() so this recomputes when permissions load.
   */
  readonly canTrackerAi = computed(() => {
    this.auth.permissions();
    return this.auth.hasPermission(PERM.trackerAi);
  });

  /** Whether the "Save as recipe" affordance (on a recipe breakdown) may render — gated on recipes.use. */
  readonly canRecipes = computed(() => {
    this.auth.permissions();
    return this.auth.hasPermission(PERM.recipesUse);
  });
  /** True while a breakdown is being saved to "My Recipes" (locks that button). */
  readonly savingBreakdownRecipe = signal(false);
  /** True once the staged breakdown has been saved as a recipe this session (flips the button to saved). */
  readonly savedBreakdownRecipe = signal(false);

  // ---- Tracker tie-in (Slice 2): "✨ Add to my tracker" + the goal-aware planner rollups ----
  /** True when the caller holds tracker.self (gates the "Add to my tracker" button + goal comparisons). */
  readonly canTrack = computed(() => this.auth.hasPermission('tracker.self'));
  /** The caller's own tracker profile/goals (loaded once when they hold tracker.self), or null. */
  readonly trackerProfile = signal<TrackerProfileDto | null>(null);
  /** The meal id currently being logged to the tracker (locks just that card's button), or null. */
  readonly loggingMealId = signal<number | null>(null);

  // ---- ✨ Plan our week ----
  /** Whether the "Plan our week" sheet is open. */
  readonly planOpen = signal(false);
  /** Free-text constraints ("kid-friendly, budget, no nuts…"). */
  readonly planConstraints = signal('');
  /** Fill only the empty dinners (default) or all seven. */
  readonly planFill = signal<FillSlots>('emptyDinners');
  readonly planBusy = signal(false);
  /** A friendly aria-live status line for the plan sheet (a hint, an error, or progress). */
  readonly planStatus = signal('');
  /** The AI-proposed dinners awaiting review (editable rows), or empty when none are staged. */
  readonly proposals = signal<ProposedMeal[]>([]);
  /** True while "Add to plan" is creating the accepted meals (locks the actions). */
  readonly addingPlan = signal(false);
  /** Monotonic key source for proposal rows (the AI list has no ids). */
  private proposalKey = 0;

  // ---- ✨ What can I make? ----
  /** Whether the "What can I make?" sheet is open. */
  readonly makeOpen = signal(false);
  /** On-hand ingredients free text ("chicken, rice, broccoli, soy sauce"). */
  readonly makeIngredients = signal('');
  /** Optional free-text constraints ("kid-friendly, vegetarian, quick…"). */
  readonly makeConstraints = signal('');
  readonly makeBusy = signal(false);
  /** A friendly aria-live status line for the make sheet (a hint, an error, or progress). */
  readonly makeStatus = signal('');
  /** The dinner ideas awaiting review; picking one prefills the meal editor. */
  readonly ideas = signal<MealIdea[]>([]);

  // ---- ✨ Recipe idea → breakdown ----
  /** Whether the "Recipe idea" sheet is open. */
  readonly recipeOpen = signal(false);
  /** The recipe idea text: a dish name ("chicken alfredo") OR a pasted recipe. */
  readonly recipeText = signal('');
  /** True while "Break it down" is in flight (locks the button). */
  readonly recipeBusy = signal(false);
  /** A friendly aria-live status line for the recipe sheet (a hint or an error). */
  readonly recipeStatus = signal('');
  /** The EDITABLE breakdown under review (title/servings/ingredient rows/macros/steps), or null when none. */
  readonly breakdownTitle = signal('');
  readonly breakdownServings = signal(1);
  readonly breakdownRows = signal<RecipeRow[]>([]);
  readonly breakdownCalories = signal(0);
  readonly breakdownProtein = signal(0);
  readonly breakdownCarb = signal(0);
  readonly breakdownFat = signal(0);
  /** Optional recipe steps (read-only display). */
  readonly breakdownSteps = signal<string[]>([]);
  /** True once a breakdown has been staged for review (drives showing the review block). */
  readonly hasBreakdown = signal(false);
  /** True while "Add to grocery list" is appending the breakdown's ingredients. */
  readonly addingBreakdownGrocery = signal(false);
  /** True while "Save as meal" is creating the planned meal. */
  readonly savingBreakdown = signal(false);
  /** Monotonic key source for ingredient rows (the AI list has no ids). */
  private recipeRowKey = 0;

  /** The Monday (local) of the week being viewed. */
  readonly weekStart = signal<Date>(this.thisMonday());

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

  /** The caller's daily calorie goal (only when they hold tracker.self AND a goal is set), else null. */
  readonly calorieGoal = computed(() =>
    this.canTrack() ? (this.trackerProfile()?.dailyCalorieGoal ?? null) : null,
  );
  readonly proteinGoal = computed(() =>
    this.canTrack() ? (this.trackerProfile()?.proteinGoalG ?? null) : null,
  );
  /** True when we can show the goal comparison (tracker.self + at least a calorie goal set). */
  readonly showGoals = computed(() => this.canTrack() && this.calorieGoal() != null);

  /** True when the week has any macro-bearing meal (so the rollup strip shows at all). */
  readonly hasWeekMacros = computed(() => this.weekRollup().hasMacros);

  constructor() {
    this.reload(true);
    // Load the caller's tracker goals once, for the goal-aware rollups (best-effort; silent on failure).
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

  initials(name: string): string {
    const parts = (name || '').split(/\s+/).filter(Boolean);
    return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
  }

  // ---- Macros (per-meal display + "✨ Add to my tracker") ----

  /** True when a meal has macros set (any source other than "none"). */
  hasMacros(meal: FamilyMeal): boolean {
    return meal.macroSource !== 'none';
  }

  /** The short macro-source tag shown on a card ("AI estimate" / "from food DB" / "manual" / "not set"). */
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

  /** Show the "✨ Add to my tracker" button only when the meal has macros AND the caller holds tracker.self. */
  canAddToTracker(meal: FamilyMeal): boolean {
    return this.canTrack() && this.hasMacros(meal);
  }

  /**
   * Log ONE serving of a planned meal's per-serving macros onto the caller's OWN tracker (POST
   * /tracker/food/from-meal, defaulting to the meal's planned date). Confirms with a snackbar; degrades
   * gracefully on any error (a 400 means macros aren't set; a 404 means it's not the caller's household).
   */
  async addToTracker(meal: FamilyMeal): Promise<void> {
    if (this.loggingMealId() !== null || !this.canAddToTracker(meal)) return;
    this.loggingMealId.set(meal.id);
    try {
      await firstValueFrom(this.api.addMealToTracker(meal.id, this.dateOnly(meal.localDate)));
      const ref = this.snack.open('Logged 1 serving to your tracker.', 'Open tracker', {
        duration: 5000,
      });
      ref.onAction().subscribe(() => {
        this.router.navigateByUrl('/tracker');
      });
    } catch (e) {
      this.snack.open(
        this.messageOf(e, "Couldn't add this meal to your tracker. Please try again."),
        'OK',
        { duration: 4000 },
      );
    } finally {
      this.loggingMealId.set(null);
    }
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

  /** Edit an existing meal on a day. PATCHes the plain fields + the macros (servings + totals + source). */
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

  /** The macro fields of an editor result, as a create/patch payload fragment. */
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
    prefill?: { title?: string; ingredients?: string },
  ): Promise<MealEditorResult | undefined> {
    const ref = this.dialog.open<MealEditorDialog, MealEditorData, MealEditorResult>(
      MealEditorDialog,
      {
        data: {
          meal,
          localDate,
          dayLabel,
          defaultSlot,
          prefillTitle: prefill?.title,
          prefillIngredients: prefill?.ingredients,
        },
        width: '460px',
        maxWidth: '94vw',
        autoFocus: false,
        panelClass: 'family-dialog',
      },
    );
    return firstValueFrom(ref.afterClosed());
  }

  // ---- ✨ Plan our week (AI proposes dinners → editable review → add to plan) ----

  /** Open/close the plan sheet. Closing while proposals are staged keeps them (they live below the sheet). */
  togglePlan(): void {
    this.planOpen.update((o) => !o);
  }

  setFill(fill: FillSlots): void {
    this.planFill.set(fill);
  }

  /**
   * Ask Gemini to propose dinners for the visible week's empty (or all) slots and stage them as EDITABLE
   * review rows. Creates NOTHING — the user edits/removes, then "Add to plan" POSTs each to /meals. Degrades
   * gracefully: a 503 (AI unavailable / not configured) or any error shows a friendly aria-live line; an
   * empty result (every dinner already planned, or nothing came back) says so.
   */
  async planWeek(): Promise<void> {
    if (this.planBusy()) return;
    this.planBusy.set(true);
    this.planStatus.set('Thinking up some dinners…');
    this.proposals.set([]);
    try {
      const result = await firstValueFrom(
        this.api.planWeekAi({
          weekStart: this.weekStartIso(),
          constraints: this.planConstraints().trim() || null,
          fillSlots: this.planFill(),
        }),
      );
      const proposed = (result.meals ?? []).map((m) => this.toProposed(m));
      this.proposals.set(proposed);
      if (proposed.length === 0) {
        this.planStatus.set(
          result.notes?.trim() ||
            (this.planFill() === 'emptyDinners'
              ? 'Every dinner this week is already planned — switch to “All dinners” to get fresh ideas.'
              : "I couldn't come up with dinners just now. Please try again."),
        );
      } else {
        const n = proposed.length;
        this.planStatus.set(
          (result.notes?.trim() ? result.notes!.trim() + ' ' : '') +
            `Review ${n === 1 ? 'this dinner' : `these ${n} dinners`} below, tweak anything, then add to your plan.`,
        );
      }
    } catch (e) {
      const status = (e as { status?: number })?.status;
      this.planStatus.set(
        status === 503
          ? 'AI unavailable, add meals manually.'
          : this.messageOf(
              e,
              "I couldn't reach the AI just now. Please try again, or add meals manually.",
            ),
      );
    } finally {
      this.planBusy.set(false);
    }
  }

  /** Re-run the proposal with the same constraints/scope (replaces the staged rows). */
  regeneratePlan(): void {
    void this.planWeek();
  }

  /** Drop one proposed dinner from the review list. */
  removeProposal(p: ProposedMeal): void {
    this.proposals.set(this.proposals().filter((x) => x.key !== p.key));
  }

  /** Discard the whole proposal list + status (e.g. after a regenerate the user no longer wants). */
  clearProposals(): void {
    this.proposals.set([]);
    this.planStatus.set('');
  }

  /**
   * Add every staged proposal to the plan by POSTing each to the existing /meals — partial-failure aware: a
   * row that saves drops off the list; rows that fail stay so the user can retry. On full success, offer a
   * one-tap "Add ingredients to grocery list" for the week.
   */
  async addPlanToPlan(): Promise<void> {
    const rows = this.proposals();
    if (this.addingPlan() || rows.length === 0) return;
    this.addingPlan.set(true);
    this.planStatus.set('Adding your dinners…');

    let added = 0;
    const failed: ProposedMeal[] = [];
    for (const p of rows) {
      const title = p.title.trim();
      if (!title) {
        failed.push(p);
        continue;
      }
      try {
        await firstValueFrom(
          this.api.createFamilyMeal({
            localDate: p.localDate,
            slot: 'dinner',
            title,
            ingredients: p.ingredients.trim(),
          }),
        );
        added++;
      } catch {
        failed.push(p);
      }
    }

    this.proposals.set(failed); // keep only the ones that didn't make it
    this.addingPlan.set(false);

    if (added > 0) this.reload();

    if (failed.length === 0) {
      this.planStatus.set('');
      this.planOpen.set(false);
      this.offerWeekToGrocery(added);
    } else if (added === 0) {
      this.planStatus.set("Couldn't add those dinners just now. Please try again.");
    } else {
      this.planStatus.set(
        `Added ${added}. ${failed.length} couldn't be added — review the remaining ${failed.length === 1 ? 'one' : 'rows'} and try again.`,
      );
    }
  }

  /** After a successful add, a warm snackbar with a one-tap "Add ingredients to grocery list". */
  private offerWeekToGrocery(added: number): void {
    const msg = `Added ${added} ${added === 1 ? 'dinner' : 'dinners'} to your plan.`;
    const ref = this.snack.open(msg, 'Add ingredients to grocery list', { duration: 7000 });
    ref.onAction().subscribe(() => {
      void this.addWeekToGrocery();
    });
  }

  /** Build an editable review row from a raw AI proposal (its day labelled in the viewer's local zone). */
  private toProposed(m: PlanWeekMeal): ProposedMeal {
    const localDate = this.dateOnly(m.localDate);
    const date = new Date(`${localDate}T00:00:00`);
    const dayLabel = Number.isNaN(date.getTime())
      ? localDate
      : `${date.toLocaleDateString(undefined, { weekday: 'long' })}, ${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
    return {
      key: ++this.proposalKey,
      localDate,
      dayLabel,
      title: m.title,
      ingredients: m.ingredients,
    };
  }

  /** Edit a proposal's title inline (bound from the row input). */
  setProposalTitle(p: ProposedMeal, title: string): void {
    this.proposals.set(this.proposals().map((x) => (x.key === p.key ? { ...x, title } : x)));
  }

  /** Edit a proposal's ingredients inline (bound from the row textarea). */
  setProposalIngredients(p: ProposedMeal, ingredients: string): void {
    this.proposals.set(this.proposals().map((x) => (x.key === p.key ? { ...x, ingredients } : x)));
  }

  // ---- ✨ What should I eat? (tracker-AI: macro/goal-aware options → add to tracker/plan/grocery) ----

  /**
   * Open the "What should I eat?" modal (tracker-AI; gated tracker.ai). It auto-fetches meal/snack options
   * that fit the caller's remaining macros today (read server-side) and offers add-to-tracker / meal-plan /
   * grocery right from each card. We target today (the dinner slot as the planner default) and pass null
   * remaining — the meals page doesn't hold the day's consumed totals, so the per-card "fits" hint hides;
   * the server still tailors options to the real remaining macros.
   */
  openWhatToEat(): void {
    if (!this.canTrackerAi()) return;
    const data: WhatToEatData = {
      date: this.toIso(new Date()),
      meal: 'dinner',
      remaining: null,
      // This is the family meals page, so the caller has family.use — the plan/grocery actions are valid.
      canFamily: this.auth.hasPermission(PERM.familyUse),
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

  // ---- ✨ What can I make? (AI proposes dinners from on-hand ingredients → prefill the editor) ----

  /** Open/close the "What can I make?" sheet. Closing keeps staged ideas (they live below the sheet). */
  toggleMake(): void {
    this.makeOpen.update((o) => !o);
  }

  /**
   * Ask Gemini for dinner ideas from the on-hand ingredients (+ optional constraints) and stage them as
   * review cards. Creates NOTHING — picking an idea PREFILLS the meal editor, and a meal is only created on
   * the user's Save. Degrades gracefully: a 503 (AI unavailable / not configured) or any error shows a
   * friendly aria-live line; an empty result says so.
   */
  async whatCanIMake(): Promise<void> {
    const ingredients = this.makeIngredients().trim();
    if (!ingredients || this.makeBusy()) return;
    this.makeBusy.set(true);
    this.makeStatus.set('Looking at what you’ve got…');
    this.ideas.set([]);
    try {
      const result = await firstValueFrom(
        this.api.whatCanIMakeAi(ingredients, this.makeConstraints().trim() || null),
      );
      const ideas = result.ideas ?? [];
      this.ideas.set(ideas);
      if (ideas.length === 0) {
        this.makeStatus.set(
          "I couldn't think of a dinner from those just now. Try adding a couple more ingredients.",
        );
      } else {
        const n = ideas.length;
        this.makeStatus.set(
          `Here ${n === 1 ? 'is 1 idea' : `are ${n} ideas`} — tap one to start a meal from it.`,
        );
      }
    } catch (e) {
      const status = (e as { status?: number })?.status;
      this.makeStatus.set(
        status === 503
          ? 'AI unavailable, add a meal manually.'
          : this.messageOf(
              e,
              "I couldn't reach the AI just now. Please try again, or add a meal manually.",
            ),
      );
    } finally {
      this.makeBusy.set(false);
    }
  }

  /** Re-run with the same ingredients/constraints (replaces the staged ideas). */
  regenerateIdeas(): void {
    void this.whatCanIMake();
  }

  /** Discard the staged ideas + status. */
  clearIdeas(): void {
    this.ideas.set([]);
    this.makeStatus.set('');
  }

  /** The whole missing-items line for an idea ("plus: soy sauce, scallions"), or '' when nothing's missing. */
  missingLine(idea: MealIdea): string {
    const missing = (idea.missing ?? []).filter((s) => s.trim().length > 0);
    return missing.length ? `Plus: ${missing.join(', ')}` : '';
  }

  /**
   * Pick a dinner idea: open the meal editor PREFILLED with its title + ingredients (the idea's ingredients,
   * with any missing items appended so the cook can keep or drop them). Creating the meal still goes through
   * the existing /meals on Save. The day defaults to today when the viewed week contains it, else the first
   * day of the viewed week.
   */
  async useIdea(idea: MealIdea): Promise<void> {
    const cells = this.cells();
    if (cells.length === 0) return;
    const todayIso = this.toIso(new Date());
    const target = cells.find((c) => c.localDate === todayIso) ?? cells[0];

    // Seed the ingredients with what it uses; append the small "missing" items as their own lines.
    const lines = [
      ...idea.ingredients
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
      ...(idea.missing ?? []).map((s) => s.trim()).filter(Boolean),
    ];
    const prefill = { title: idea.title, ingredients: lines.join('\n') };

    const result = await this.openEditor(
      null,
      target.localDate,
      `${target.weekday}, ${target.dateLabel}`,
      'dinner',
      prefill,
    );
    if (!result) return;
    try {
      await firstValueFrom(
        this.api.createFamilyMeal({
          localDate: target.localDate,
          slot: result.slot,
          title: result.title,
          ingredients: result.ingredients,
        }),
      );
      this.reload();
      this.makeOpen.set(false);
      this.clearIdeas();
      this.snack.open(`Added “${result.title}” to ${target.weekday}.`, undefined, {
        duration: 2500,
      });
    } catch (e) {
      this.snack.open(this.messageOf(e, "Couldn't save that meal. Please try again."), 'OK', {
        duration: 4000,
      });
    }
  }

  // ---- ✨ Recipe idea → breakdown (AI structures a recipe → editable review → grocery + save-as-meal) ----

  /** Open/close the "Recipe idea" sheet. Closing keeps any staged breakdown (it lives below the sheet). */
  toggleRecipe(): void {
    this.recipeOpen.update((o) => !o);
  }

  /**
   * Send the recipe idea (a dish name OR pasted recipe) to the breakdown endpoint and stage an EDITABLE
   * review (title, servings, ingredient rows, per-serving macros, optional steps). Creates NOTHING. Degrades
   * gracefully: a 503 (AI unavailable / not configured) or any error shows a friendly aria-live line and
   * leaves the field usable; an empty/blank input is a no-op.
   */
  async breakItDown(): Promise<void> {
    const text = this.recipeText().trim();
    if (!text || this.recipeBusy()) return;
    this.recipeBusy.set(true);
    this.recipeStatus.set('Breaking down your recipe…');
    try {
      const result = await firstValueFrom(this.api.recipeBreakdown(text));
      this.stageBreakdown(result);
      this.recipeStatus.set(
        'Review and tweak anything below, then add it to your grocery list or save it as a meal.',
      );
    } catch (e) {
      const status = (e as { status?: number })?.status;
      this.recipeStatus.set(
        status === 503
          ? 'AI unavailable, add a meal manually.'
          : this.messageOf(
              e,
              "I couldn't reach the AI just now. Please try again, or add a meal manually.",
            ),
      );
    } finally {
      this.recipeBusy.set(false);
    }
  }

  /** Re-run the breakdown with the same recipe text (replaces the staged review). */
  regenerateBreakdown(): void {
    void this.breakItDown();
  }

  /** Fan a breakdown result out into the editable review signals. */
  private stageBreakdown(r: RecipeBreakdownResult): void {
    this.breakdownTitle.set(r.title ?? '');
    this.breakdownServings.set(Math.max(1, Math.round(r.servings || 1)));
    this.breakdownRows.set((r.ingredients ?? []).map((i) => this.toRow(i)));
    const m = r.macrosPerServing;
    this.breakdownCalories.set(Math.max(0, Math.round(m?.calories ?? 0)));
    this.breakdownProtein.set(this.round1(Math.max(0, m?.protein ?? 0)));
    this.breakdownCarb.set(this.round1(Math.max(0, m?.carb ?? 0)));
    this.breakdownFat.set(this.round1(Math.max(0, m?.fat ?? 0)));
    this.breakdownSteps.set((r.steps ?? []).map((s) => (s ?? '').trim()).filter(Boolean));
    this.savedBreakdownRecipe.set(false); // a fresh/regenerated breakdown hasn't been saved as a recipe yet
    this.hasBreakdown.set(true);
  }

  private toRow(i: RecipeIngredient): RecipeRow {
    return { key: ++this.recipeRowKey, name: i.name ?? '', quantity: i.quantity ?? '' };
  }

  /** Discard the staged breakdown + status (keeps the recipe text so the user can tweak + re-run). */
  clearBreakdown(): void {
    this.hasBreakdown.set(false);
    this.breakdownRows.set([]);
    this.breakdownSteps.set([]);
    this.recipeStatus.set('');
  }

  /** Edit an ingredient row's name inline. */
  setRowName(row: RecipeRow, name: string): void {
    this.breakdownRows.set(
      this.breakdownRows().map((x) => (x.key === row.key ? { ...x, name } : x)),
    );
  }

  /** Edit an ingredient row's quantity inline. */
  setRowQuantity(row: RecipeRow, quantity: string): void {
    this.breakdownRows.set(
      this.breakdownRows().map((x) => (x.key === row.key ? { ...x, quantity } : x)),
    );
  }

  /** Drop one ingredient row from the review. */
  removeRow(row: RecipeRow): void {
    this.breakdownRows.set(this.breakdownRows().filter((x) => x.key !== row.key));
  }

  /** The grocery-bound ingredient names (quantity prefixed when present), blanks dropped. */
  private breakdownGroceryItems(): string[] {
    return this.breakdownRows()
      .map((r) => {
        const name = r.name.trim();
        if (!name) return '';
        const qty = r.quantity.trim();
        return qty ? `${qty} ${name}` : name;
      })
      .filter(Boolean);
  }

  /** The breakdown's ingredients as newline-separated text for the saved meal (reuses the existing field). */
  private breakdownIngredientsText(): string {
    return this.breakdownGroceryItems().join('\n');
  }

  /**
   * One tap: append the reviewed breakdown's ingredient names to the household's grocery list (reuses the
   * shared add path; the server de-dupes against the list's open items). Reports how many NEW items landed.
   */
  async addBreakdownToGrocery(): Promise<void> {
    const items = this.breakdownGroceryItems();
    if (this.addingBreakdownGrocery() || items.length === 0) return;
    this.addingBreakdownGrocery.set(true);
    try {
      const before = await this.groceryOpenCount();
      const list = await firstValueFrom(this.api.recipeBreakdownToGrocery(items));
      this.reportAdded(list.items.filter((i) => !i.done).length - before, list.name);
    } catch {
      this.snack.open("Couldn't add those ingredients. Please try again.", 'OK', {
        duration: 4000,
      });
    } finally {
      this.addingBreakdownGrocery.set(false);
    }
  }

  /**
   * Save the reviewed breakdown as a planned meal (reuses createFamilyMeal + the macro-save path). The
   * per-serving macros × servings become the dish TOTALS with source "ai"; the meal lands on today when the
   * viewed week contains it, else the first day of the viewed week. Degrades gracefully on any error.
   */
  async saveBreakdownAsMeal(): Promise<void> {
    const title = this.breakdownTitle().trim();
    if (this.savingBreakdown() || !title) {
      if (!title)
        this.snack.open('Give the recipe a title before saving it.', 'OK', { duration: 4000 });
      return;
    }
    const cells = this.cells();
    if (cells.length === 0) return;
    const todayIso = this.toIso(new Date());
    const target = cells.find((c) => c.localDate === todayIso) ?? cells[0];

    const servings = Math.max(1, Math.round(this.breakdownServings() || 1));
    this.savingBreakdown.set(true);
    try {
      await firstValueFrom(
        this.api.createFamilyMeal({
          localDate: target.localDate,
          slot: 'dinner',
          title,
          ingredients: this.breakdownIngredientsText(),
          servings,
          calories: Math.round(this.breakdownCalories() * servings),
          proteinG: this.round1(this.breakdownProtein() * servings),
          carbG: this.round1(this.breakdownCarb() * servings),
          fatG: this.round1(this.breakdownFat() * servings),
          macroSource: 'ai',
        }),
      );
      this.reload();
      this.snack.open(`Saved “${title}” to ${target.weekday}.`, 'View plan', { duration: 5000 });
    } catch (e) {
      this.snack.open(this.messageOf(e, "Couldn't save that meal. Please try again."), 'OK', {
        duration: 4000,
      });
    } finally {
      this.savingBreakdown.set(false);
    }
  }

  /**
   * Save the reviewed breakdown to the caller's OWN "My Recipes" (POST /api/recipes/from-breakdown via
   * api.saveRecipeFromBreakdown, gated recipes.use). Reuses the same edited title/servings/ingredient rows/
   * per-serving macros/steps. Distinct from "Save as meal" (the household plan) — this is a private,
   * reusable recipe. Degrades gracefully; flips the button to a saved state on success.
   */
  async saveBreakdownAsRecipe(): Promise<void> {
    const title = this.breakdownTitle().trim();
    if (this.savingBreakdownRecipe() || this.savedBreakdownRecipe()) return;
    if (!title) {
      this.snack.open('Give the recipe a title before saving it.', 'OK', { duration: 4000 });
      return;
    }

    const req: RecipeFromBreakdownRequest = {
      title,
      servings: Math.max(1, Math.round(this.breakdownServings() || 1)),
      macros: {
        calories: Math.max(0, Math.round(this.breakdownCalories())),
        protein: this.round1(Math.max(0, this.breakdownProtein())),
        carb: this.round1(Math.max(0, this.breakdownCarb())),
        fat: this.round1(Math.max(0, this.breakdownFat())),
      },
      ingredients: this.breakdownRows()
        .map((r) => ({ name: r.name.trim(), quantity: r.quantity.trim() }))
        .filter((i) => i.name.length > 0),
      steps: this.breakdownSteps(),
    };
    this.savingBreakdownRecipe.set(true);
    try {
      await firstValueFrom(this.api.saveRecipeFromBreakdown(req));
      this.savedBreakdownRecipe.set(true);
      this.snack.open(`Saved “${title}” to My Recipes.`, 'OK', { duration: 4000 });
    } catch (e) {
      this.snack.open(this.messageOf(e, "Couldn't save that recipe. Please try again."), 'OK', {
        duration: 4000,
      });
    } finally {
      this.savingBreakdownRecipe.set(false);
    }
  }

  // ---- Grocery-list tie-in ----

  /** True when a meal carries at least one ingredient line (so the per-meal add button shows). */
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

  /**
   * The current open-item count of the household's Groceries list (best-effort) so we can report exactly
   * how many NEW items the add produced — the server skips blanks + duplicates already on the list.
   */
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

  /** A warm snackbar: how many items were added (and a quick link to the Lists page). */
  private reportAdded(added: number, listName: string): void {
    const n = Math.max(0, added);
    const msg =
      n === 0
        ? `Everything was already on “${listName}.”`
        : `Added ${n} ${n === 1 ? 'ingredient' : 'ingredients'} to “${listName}.”`;
    const ref = this.snack.open(msg, 'View list', { duration: 5000 });
    ref.onAction().subscribe(() => {
      this.router.navigateByUrl('/family/lists');
    });
  }

  // ---- Date helpers (the household's week starts Monday, like the backend) ----

  /** Today's local Monday, at local midnight. */
  private thisMonday(): Date {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    const offset = (d.getDay() + 6) % 7; // Sun=0..Sat=6 → Mon=0..Sun=6
    d.setDate(d.getDate() - offset);
    return d;
  }

  /** A Date → local "YYYY-MM-DD". */
  private toIso(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  /** Trim a possibly date-time ISO ("2026-06-23T00:00:00...") down to the plain date. */
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
