import {
  ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal, viewChild,
} from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { catchError, firstValueFrom, of } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { Api } from '../../core/api';
import { AuthService } from '../../core/auth';
import {
  FamilyMeal, FamilyMealDay, HouseholdMember, PERM, TrackerProfileDto,
} from '../../core/models';
import {
  BetaChip, BetaChipGroup, BetaFab, BetaPullRefresh, BetaSegmentedControl, BetaSkeleton, BetaSvgRing,
  BetaSwipeRow, BetaToaster, Segment, ToastController,
} from '../beta-ui';

import {
  DayCell, DayRollup, dateOnly, rollupOf, thisMonday, toIso,
} from './meals-beta.model';
import { ForageDayStrip } from './components/day-strip';
import { ForageMealCard } from './components/meal-card';
import { ForagePlanSheet } from './components/plan-sheet';
import { ForageEatSheet } from './components/eat-sheet';
import { ForageGrocerySheet } from './components/grocery-sheet';
import { ForageMealActionsSheet } from './components/meal-actions-sheet';
import { ForageMoveMealSheet } from './components/move-meal-sheet';
import { ForageEditMealSheet, EditMealResult } from './components/edit-meal-sheet';
import { ForageRefineMealSheet } from './components/refine-meal-sheet';
import { ForageAddToTrackerSheet, AddToTrackerResult } from './components/add-to-tracker-sheet';

/**
 * Meals "Forage" — the mobile-first meal-planning + grocery surface, built on the shared beta-ui "Strata"
 * kit (`@use '../beta-ui/beta-kit'`). One signature accent — a fresh GREEN (emerald → lime) — re-skins the
 * whole screen via the per-page contract. An immersive header (week range + a planned-meals + planned-kcal
 * glance), a SWIPEABLE week strip of day chips, then the selected day's meals as DEPTH cards with calorie
 * macro rings (BetaSvgRing) + per-serving info, each in a BetaSwipeRow (swipe left to remove, right to add
 * to grocery). A BetaFab opens "AI plan my week"; quick-action chips open "What can I eat?" and the
 * checkable grocery list; a one-tap "add this day to grocery" hand-off opens the grocery sheet. Pull-to-
 * refresh, spring stagger, tasteful empty/loading states, safe-area, 44px targets.
 *
 * DATA PARITY: every figure comes from the SAME endpoints the live /meal-planner uses — `Api.familyMeals`
 * (the week's planned meals + per-serving rollups), `Api.trackerProfile` (the calorie/protein goals when
 * the caller holds tracker.self), `Api.mealsToGrocery` (the day/meal → grocery hand-off), `Api.familyLists`
 * + `Api.patchFamilyListItem` (the checkable grocery list), `Api.deleteFamilyMeal` (remove), and the AI
 * `Api.planMeals`/`planMealsToPlan`/`whatToEat` endpoints. The server owns all the macro math; this page
 * never re-aggregates. It writes nothing the live page can't already write.
 *
 * ISOLATION: gated by `platform.mobile` + `meals.use`; consumes the kit + the SAME read/write Api as the live
 * planner. No live page is imported or modified; the flagship tracker-beta + the kit are consumed, never
 * changed. State lives in this page's signals; the only route-level provider is its own ToastController.
 */
@Component({
  selector: 'app-meals-beta',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [ToastController],
  imports: [
    MatIconModule, BetaPullRefresh, BetaFab, BetaToaster, BetaSkeleton, BetaSvgRing, BetaSwipeRow,
    BetaSegmentedControl, BetaChip, BetaChipGroup,
    ForageDayStrip, ForageMealCard, ForagePlanSheet, ForageEatSheet, ForageGrocerySheet, ForageMealActionsSheet,
    ForageMoveMealSheet, ForageEditMealSheet, ForageRefineMealSheet, ForageAddToTrackerSheet,
  ],
  template: `
    <app-bs-pull-refresh class="mb-ptr" [busy]="refreshing()" (refresh)="refreshAll()">
      <div class="mb-scroll">

        <!-- Immersive header: week range + a planned glance, week nav. -->
        <header class="hh">
          <div class="hh__row">
            <div class="hh__text">
              <span class="hh__eyebrow"><span class="hh__spark" aria-hidden="true"></span> Meal plan</span>
              <h1 class="hh__title">Forage</h1>
            </div>
            <div class="hh__nav" role="group" aria-label="Week">
              <button type="button" class="hh__navbtn" (click)="shiftWeek(-1)" aria-label="Previous week">
                <mat-icon aria-hidden="true">chevron_left</mat-icon>
              </button>
              <button type="button" class="hh__week" (click)="goThisWeek()"
                      [attr.aria-label]="'Week of ' + weekLabel() + (isThisWeek() ? '' : ', tap for this week')">
                {{ weekLabel() }}
                @if (!isThisWeek()) { <span class="hh__today-hint">Today</span> }
              </button>
              <button type="button" class="hh__navbtn" (click)="shiftWeek(1)" aria-label="Next week">
                <mat-icon aria-hidden="true">chevron_right</mat-icon>
              </button>
            </div>
          </div>

          <!-- Week glance: planned meals + planned kcal (Clash Display numerals). -->
          <div class="hh__glance">
            <div class="hh__stat">
              <span class="hh__stat-n">{{ mealCount() }}</span>
              <span class="hh__stat-l">{{ mealCount() === 1 ? 'meal' : 'meals' }} planned</span>
            </div>
            <span class="hh__div" aria-hidden="true"></span>
            <div class="hh__stat">
              @if (hasWeekMacros()) {
                <span class="hh__stat-n">{{ weekKcal() }}</span>
                <span class="hh__stat-l">kcal this week</span>
              } @else {
                <span class="hh__stat-n hh__stat-n--mute">—</span>
                <span class="hh__stat-l">no macros yet</span>
              }
            </div>
            @if (dayGoalFrac() !== null) {
              <app-bs-ring class="hh__ring" [value]="dayGoalFrac()!" [size]="52" [stroke]="7"
                           [signalOnFull]="true" [label]="dayRingLabel()">
                <span class="hh__ring-num">{{ dayGoalPct() }}<i>%</i></span>
              </app-bs-ring>
            }
          </div>
        </header>

        <!-- On-hand pantry chips (from a Snap & Route hand-off) — bias the AI plan. -->
        @if (onHand().length) {
          <section class="mb-onhand" aria-label="On-hand ingredients from your pantry snap">
            <span class="mb-onhand-lbl">
              <mat-icon aria-hidden="true">kitchen</mat-icon>
              On hand — your plan will lean on these
            </span>
            <app-bs-chip-group class="mb-onhand-chips" [scroll]="true" label="On-hand ingredients">
              @for (ing of onHand(); track ing) {
                <app-bs-chip [label]="ing" variant="soft" removable (removed)="removeOnHand(ing)" />
              }
            </app-bs-chip-group>
          </section>
        }

        <!-- Day | Week view toggle. -->
        <app-bs-segmented class="mb-view" [segments]="viewSegments" [(value)]="viewMode" label="View" />

        @if (viewMode() === 'week') {
          <!-- WEEK MODE: a 7-up grid of per-day calorie-goal rings (tap a ring → that day, Day view). -->
          <section class="mb-week" aria-label="Planned week at a glance">
            <div class="mb-week-grid">
              @for (cell of cells(); track cell.localDate) {
                <button type="button" class="mb-wcell"
                        [class.is-today]="cell.isToday" [class.is-selected]="cell.localDate === selectedDate()"
                        (click)="pickFromWeek(cell.localDate)"
                        [attr.aria-label]="weekRingLabel(cell)">
                  <app-bs-ring class="mb-wring"
                    [value]="weekRingFrac(cell)" [size]="58" [stroke]="7"
                    [signalOnFull]="weekDayFull(cell)"
                    [track]="cell.rollup.hasMacros ? 'var(--hairline)' : 'var(--bg-sink)'">
                    <span class="mb-wring-wd">{{ cell.weekdayShort }}</span>
                  </app-bs-ring>
                  <span class="mb-wcell-kcal" [class.is-mute]="!cell.rollup.hasMacros">
                    @if (cell.rollup.hasMacros) { {{ weekDayKcal(cell) }} } @else { — }
                  </span>
                </button>
              }
            </div>
            <p class="mb-week-summary">{{ weekSummary() }}</p>
          </section>
        } @else {
          <!-- Swipeable week strip of day chips. -->
          <app-forage-day-strip class="mb-strip"
            [cells]="cells()" [selected]="selectedDate()" (pick)="selectDay($event)" />
        }

        <!-- The selected day's meals. -->
        @if (viewMode() === 'day') {
        <section class="mb-day" [attr.aria-label]="selectedCell()?.weekdayLong + ' meals'">
          <div class="mb-day-h">
            <div class="mb-day-h-txt">
              <h2 class="mb-day-title">{{ selectedCell()?.weekdayLong || 'Day' }}</h2>
              <span class="mb-day-sub">{{ selectedCell()?.dateLabel }}</span>
              @if (selectedCell()?.rollup?.hasMacros) {
                <span class="mb-day-roll" aria-label="Planned macros for the day">
                  <span class="mb-day-roll-cal">
                    <b>{{ dayRollCal() }}</b>@if (showGoals()) {<span class="mb-day-roll-goal"> / {{ calorieGoal() }}</span>} kcal
                  </span>
                  <span class="mb-day-roll-p">
                    @if (showGoals() && proteinGoal() != null) {
                      {{ selectedCell()!.rollup.proteinG }}/{{ proteinGoal() }}g P
                    } @else {
                      {{ selectedCell()!.rollup.proteinG }}g P
                    }
                  </span>
                </span>
              }
            </div>
            <div class="mb-day-h-btns">
              <button type="button" class="mb-day-gro" (click)="addMeal()"
                      aria-label="Add a meal to this day">
                <mat-icon aria-hidden="true">add</mat-icon>
                <span>Add meal</span>
              </button>
              @if ((selectedCell()?.meals?.length ?? 0) > 0) {
                <button type="button" class="mb-day-gro" (click)="addDayToGrocery()" [disabled]="addingDay()"
                        aria-label="Add this day's ingredients to grocery list">
                  @if (addingDay()) { <span class="mb-mini-spin" aria-hidden="true"></span> }
                  @else { <mat-icon aria-hidden="true">add_shopping_cart</mat-icon> }
                  <span>Add day</span>
                </button>
              }
            </div>
          </div>

          @if (loading()) {
            <div class="mb-skel">
              @for (s of [0,1,2]; track s) { <app-bs-skeleton height="82px" radius="var(--r-tile)" /> }
            </div>
          } @else if (error()) {
            <div class="mb-state">
              <span class="mb-state-ic" aria-hidden="true"><mat-icon>cloud_off</mat-icon></span>
              <p class="mb-state-msg">Couldn't load your meal plan.</p>
              <button type="button" class="mb-state-btn" (click)="reload(true)">Try again</button>
            </div>
          } @else if ((selectedCell()?.meals?.length ?? 0) === 0) {
            <div class="mb-state">
              <span class="mb-state-ic" aria-hidden="true"><mat-icon>restaurant_menu</mat-icon></span>
              <p class="mb-state-msg">Nothing planned for {{ selectedCell()?.weekdayLong }} yet.</p>
              <div class="mb-state-btns">
                <button type="button" class="mb-state-btn" (click)="openPlan()">
                  <mat-icon aria-hidden="true">auto_awesome</mat-icon> Plan with AI
                </button>
                <button type="button" class="mb-state-btn mb-state-btn--ghost" (click)="addMeal()">
                  <mat-icon aria-hidden="true">add</mat-icon> Add manually
                </button>
              </div>
            </div>
          } @else {
            <div class="mb-meals">
              @for (m of selectedCell()!.meals; track m.id; let i = $index) {
                <div class="mb-meal-in" [style.--i]="i">
                  <app-bs-swipe-row
                    leftLabel="Remove" rightLabel="Grocery"
                    [label]="m.title"
                    (swipe)="onMealSwipe(m, $event)">
                    <app-forage-meal-card
                      [meal]="m" [calorieGoal]="calorieGoal()"
                      (open)="openMeal(m)" (grocery)="addMealToGrocery(m)" />
                  </app-bs-swipe-row>
                </div>
              }
            </div>
          }
        </section>
        }

        <!-- Week-total macro rollup (sum of the visible week vs 7× the daily goal). -->
        @if (hasWeekMacros()) {
          <section class="mb-weekroll" aria-label="Planned macros for the week">
            <span class="mb-weekroll-lbl">
              <mat-icon aria-hidden="true">insights</mat-icon> This week (planned)
            </span>
            <span class="mb-weekroll-cal">
              <b>{{ weekRollCal() }}</b>@if (showGoals()) {<span class="mb-weekroll-goal"> / {{ weekCalorieGoal() }}</span>} kcal
            </span>
            <span class="mb-weekroll-pcf">
              @if (showGoals() && proteinGoal() != null) {
                {{ weekRollProtein() }}/{{ weekProteinGoal() }}g P
              } @else {
                {{ weekRollProtein() }}g P
              }
              · {{ weekRollCarb() }}g C · {{ weekRollFat() }}g F
            </span>
            <span class="mb-weekroll-note">
              @if (showGoals()) {
                Per-serving totals vs your daily goal ×7
              } @else {
                Sum of each meal's per-serving macros
              }
            </span>
          </section>
        }

        <!-- Quick actions row. -->
        <div class="mb-quick">
          <button type="button" class="mb-q" (click)="openEat()">
            <span class="mb-q-ic" aria-hidden="true"><mat-icon>restaurant</mat-icon></span>
            <span class="mb-q-txt"><b>What can I eat?</b><i>Ideas for what's left today</i></span>
          </button>
          <button type="button" class="mb-q" (click)="openGrocery()">
            <span class="mb-q-ic" aria-hidden="true"><mat-icon>shopping_cart</mat-icon></span>
            <span class="mb-q-txt"><b>Grocery list</b><i>Check off what you've got</i></span>
          </button>
          @if (mealCount() > 0) {
            <button type="button" class="mb-q" (click)="addWeekToGrocery()" [disabled]="addingWeek()">
              <span class="mb-q-ic" aria-hidden="true">
                @if (addingWeek()) { <span class="mb-mini-spin" aria-hidden="true"></span> }
                @else { <mat-icon>add_shopping_cart</mat-icon> }
              </span>
              <span class="mb-q-txt"><b>Add week to grocery</b><i>Every planned ingredient this week</i></span>
            </button>
          }
        </div>
      </div>
    </app-bs-pull-refresh>

    <!-- Primary action: AI plan the week. -->
    <app-bs-fab icon="auto_awesome" label="Plan my week" [extended]="true" [fixed]="true" (action)="openPlan()" />

    <!-- Sheets. -->
    <app-forage-plan-sheet #planSheet [weekStart]="weekStartIso()" [ingredientsOnHand]="onHand()"
      (planned)="onPlanned($event)" />
    <app-forage-eat-sheet #eatSheet />
    <app-forage-grocery-sheet #grocerySheet (changed)="noop()" />
    <app-forage-meal-actions-sheet #mealSheet
      [meal]="activeMeal()" [canRefine]="canTrackerAi()" [canTrack]="canTrack()"
      (grocery)="addActiveMealToGrocery()" (edit)="editActiveMeal()" (refine)="refineActiveMeal()"
      (track)="trackActiveMeal()" (move)="openMoveActiveMeal()" (remove)="removeActiveMeal()" />
    <app-forage-move-meal-sheet #moveSheet
      [meal]="activeMeal()" [cells]="cells()" (move)="moveActiveMeal($event)" />
    <app-forage-edit-meal-sheet #editSheet
      [meal]="editingMeal()" [localDate]="editDate()" [dayLabel]="editDayLabel()"
      [canAi]="canTrackerAi()" (saved)="onMealSaved($event)" />
    <app-forage-refine-meal-sheet #refineSheet
      [meal]="activeMeal()" (wrote)="onRefined($event)" />
    <app-forage-add-to-tracker-sheet #trackSheet
      [meal]="activeMeal()" [householdMembers]="householdMembers()" (add_)="onTrackConfirmed($event)" />

    <app-bs-toaster />
  `,
  styleUrl: './meals-beta.page.scss',
})
export class MealsBetaPage {
  private readonly api = inject(Api);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastController);
  private readonly destroyRef = inject(DestroyRef);

  private readonly planSheet = viewChild.required(ForagePlanSheet);
  private readonly eatSheet = viewChild.required(ForageEatSheet);
  private readonly grocerySheet = viewChild.required(ForageGrocerySheet);
  private readonly mealSheet = viewChild.required(ForageMealActionsSheet);
  private readonly moveSheet = viewChild.required(ForageMoveMealSheet);
  private readonly editSheet = viewChild.required(ForageEditMealSheet);
  private readonly refineSheet = viewChild.required(ForageRefineMealSheet);
  private readonly trackSheet = viewChild.required(ForageAddToTrackerSheet);

  // ---- week + data state ----
  readonly weekStart = signal<Date>(thisMonday());
  readonly weekStartIso = computed(() => toIso(this.weekStart()));
  readonly days = signal<FamilyMealDay[]>([]);
  readonly loading = signal(true);
  readonly error = signal(false);
  readonly refreshing = signal(false);
  readonly addingDay = signal(false);

  /** The selected day's "YYYY-MM-DD" — defaults to today (or the week's Monday off-week). */
  readonly selectedDate = signal<string>(toIso(new Date()));

  /** Day-at-a-time vs. the planned-week macro-ring grid. Persisted in a signal (default Day). */
  readonly viewMode = signal<'day' | 'week'>('day');
  readonly viewSegments: Segment[] = [
    { key: 'day', label: 'Day' },
    { key: 'week', label: 'Week' },
  ];

  /** The meal whose action sheet is open (drives the actions sheet's content). */
  readonly activeMeal = signal<FamilyMeal | null>(null);

  /** The caller's tracker goals (loaded when they hold tracker.self), for the calorie ring fractions. */
  private readonly trackerProfile = signal<TrackerProfileDto | null>(null);
  readonly canTrack = computed(() => {
    this.auth.permissions();
    return this.auth.hasPermission(PERM.trackerSelf);
  });
  /** tracker.ai gates "Refine with AI" + the editor's "Estimate with AI" assist (server floors too). */
  readonly canTrackerAi = computed(() => {
    this.auth.permissions();
    return this.auth.hasPermission(PERM.trackerAi);
  });
  readonly calorieGoal = computed(() =>
    this.canTrack() ? (this.trackerProfile()?.dailyCalorieGoal ?? null) : null);
  readonly proteinGoal = computed(() =>
    this.canTrack() ? (this.trackerProfile()?.proteinGoalG ?? null) : null);
  /** Show goal comparisons only when the caller holds tracker.self AND has a daily calorie goal set. */
  readonly showGoals = computed(() => this.canTrack() && this.calorieGoal() != null);

  /**
   * "On hand" ingredients handed off from the Snap & Route pantry capture (sessionStorage, read + cleared on
   * init — same `usage_iq_pantry_on_hand` key the live planner uses). When present they show as removable
   * chips and bias the "Plan my week" AI plan toward what the caller already has (passed to the plan sheet).
   */
  readonly onHand = signal<string[]>([]);

  /** True while the whole-week "add to grocery" call is in flight (locks the quick action). */
  readonly addingWeek = signal(false);

  /** The household members for the "whose tracker?" picker, loaded once (cached) on first tracker use. */
  readonly householdMembers = signal<HouseholdMember[]>([]);
  private householdLoaded = false;

  /** Edit-sheet state: the meal being edited (null = create) + the target day for a new meal. */
  readonly editingMeal = signal<FamilyMeal | null>(null);
  readonly editDate = signal<string>('');
  readonly editDayLabel = signal<string>('');

  // ---- derived view model ----
  readonly weekLabel = computed(() => {
    const start = this.weekStart();
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    const sameMonth = start.getMonth() === end.getMonth();
    const startLbl = start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const endLbl = end.toLocaleDateString(undefined, sameMonth ? { day: 'numeric' } : { month: 'short', day: 'numeric' });
    return `${startLbl} – ${endLbl}`;
  });

  readonly isThisWeek = computed(() => toIso(this.weekStart()) === toIso(thisMonday()));

  /** The 7 day cells with labels + today flags + per-day rollups, from the loaded week. */
  readonly cells = computed<DayCell[]>(() => {
    const todayIso = toIso(new Date());
    return this.days().map(d => {
      const iso = dateOnly(d.localDate);
      const date = new Date(`${iso}T00:00:00`);
      return {
        localDate: iso,
        weekdayShort: date.toLocaleDateString(undefined, { weekday: 'short' }),
        weekdayLong: date.toLocaleDateString(undefined, { weekday: 'long' }),
        dayNum: String(date.getDate()),
        dateLabel: date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
        isToday: iso === todayIso,
        meals: d.meals,
        rollup: rollupOf(d.meals),
      };
    });
  });

  /** The selected day's cell (falls back to the first cell when the selection isn't in this week). */
  readonly selectedCell = computed<DayCell | null>(() => {
    const cells = this.cells();
    if (cells.length === 0) return null;
    return cells.find(c => c.localDate === this.selectedDate()) ?? cells[0];
  });

  readonly mealCount = computed(() => this.cells().reduce((n, c) => n + c.meals.length, 0));

  readonly weekRollup = computed<DayRollup>(() =>
    this.cells().reduce<DayRollup>((acc, c) => ({
      hasMacros: acc.hasMacros || c.rollup.hasMacros,
      calories: acc.calories + c.rollup.calories,
      proteinG: acc.proteinG + c.rollup.proteinG,
      carbG: acc.carbG + c.rollup.carbG,
      fatG: acc.fatG + c.rollup.fatG,
    }), { hasMacros: false, calories: 0, proteinG: 0, carbG: 0, fatG: 0 }));

  readonly hasWeekMacros = computed(() => this.weekRollup().hasMacros);
  readonly weekKcal = computed(() => Math.round(this.weekRollup().calories).toLocaleString());

  // ---- macro-rollup display (mirrors the live planner's per-day + per-week rollup rows) ----
  /** The selected day's planned kcal numeral (e.g. "1,850"). */
  readonly dayRollCal = computed(() =>
    Math.round(this.selectedCell()?.rollup.calories ?? 0).toLocaleString());
  /** Whole-week planned macro numerals (kcal + P/C/F), pre-formatted for the week-total row. */
  readonly weekRollCal = computed(() => Math.round(this.weekRollup().calories).toLocaleString());
  readonly weekRollProtein = computed(() => this.weekRollup().proteinG.toLocaleString());
  readonly weekRollCarb = computed(() => this.weekRollup().carbG.toLocaleString());
  readonly weekRollFat = computed(() => this.weekRollup().fatG.toLocaleString());
  /** 7× the daily goals for the week-total comparison (null-safe; only read when showGoals()). */
  readonly weekCalorieGoal = computed(() => {
    const g = this.calorieGoal();
    return g != null ? (g * 7).toLocaleString() : '';
  });
  readonly weekProteinGoal = computed(() => {
    const g = this.proteinGoal();
    return g != null ? (g * 7).toLocaleString() : '';
  });

  /** The selected day's planned kcal as a fraction of the daily goal (null without a goal or macros). */
  readonly dayGoalFrac = computed<number | null>(() => {
    const goal = this.calorieGoal();
    const cell = this.selectedCell();
    if (!goal || goal <= 0 || !cell || !cell.rollup.hasMacros) return null;
    return Math.max(0, Math.min(1, cell.rollup.calories / goal));
  });
  readonly dayGoalPct = computed(() => Math.round((this.dayGoalFrac() ?? 0) * 100));
  readonly dayRingLabel = computed(() => {
    const cell = this.selectedCell();
    return `${Math.round(cell?.rollup.calories ?? 0)} planned kcal, ${this.dayGoalPct()}% of daily goal`;
  });

  // ---- WEEK-MODE ring grid (mirrors dayGoalFrac()/dayRingLabel() per cell) ----
  /** One day's planned kcal as a clamped 0..1 fraction of the daily goal (0 without a goal or macros). */
  weekRingFrac(cell: DayCell): number {
    const goal = this.calorieGoal();
    if (!goal || goal <= 0 || !cell.rollup.hasMacros) return 0;
    return Math.max(0, Math.min(1, cell.rollup.calories / goal));
  }
  /** Whether a day hit (or passed) the calorie goal — drives [signalOnFull]. */
  weekDayFull(cell: DayCell): boolean {
    const goal = this.calorieGoal();
    return !!goal && goal > 0 && cell.rollup.hasMacros && cell.rollup.calories >= goal;
  }
  /** A day's planned-kcal numeral under its ring (e.g. "1,850"). */
  weekDayKcal(cell: DayCell): string {
    return Math.round(cell.rollup.calories).toLocaleString();
  }
  /** aria text for a week-grid ring cell. */
  weekRingLabel(cell: DayCell): string {
    if (!cell.rollup.hasMacros) return `${cell.weekdayLong}, nothing planned`;
    const pct = Math.round(this.weekRingFrac(cell) * 100);
    const goal = this.calorieGoal();
    const goalNote = goal && goal > 0 ? `, ${pct}% of daily goal` : '';
    return `${cell.weekdayLong}, ${Math.round(cell.rollup.calories)} planned kcal${goalNote}`;
  }

  /** "4 of 7 days planned · avg 1,850 kcal" — the week-summary line. */
  readonly weekSummary = computed(() => {
    const cells = this.cells();
    if (cells.length === 0) return 'No days in this week';
    const planned = cells.filter(c => c.meals.length > 0);
    const withMacros = cells.filter(c => c.rollup.hasMacros);
    const head = `${planned.length} of ${cells.length} days planned`;
    if (withMacros.length === 0) return head;
    const avg = Math.round(
      withMacros.reduce((sum, c) => sum + c.rollup.calories, 0) / withMacros.length);
    return `${head} · avg ${avg.toLocaleString()} kcal`;
  });

  /** Tapping a week ring selects that day AND drops back to Day view so they land on it. */
  pickFromWeek(iso: string): void {
    this.selectDay(iso);
    this.viewMode.set('day');
  }

  constructor() {
    this.reload(true);
    this.consumePantryHandoff();
    if (this.canTrack()) {
      this.api.trackerProfile()
        .pipe(catchError(() => of<TrackerProfileDto | null>(null)), takeUntilDestroyed(this.destroyRef))
        .subscribe(p => this.trackerProfile.set(p));
    }
  }

  /**
   * Read (and immediately CLEAR) the Snap & Route pantry hand-off from sessionStorage — the SAME
   * `usage_iq_pantry_on_hand` key + read-once semantics the live planner uses. Clearing on consume means the
   * chips only appear on the visit right after a pantry snap; a later normal visit won't re-apply stale chips.
   * Malformed JSON / non-array / unavailable storage all degrade silently to no chips.
   */
  private consumePantryHandoff(): void {
    try {
      const raw = sessionStorage.getItem('usage_iq_pantry_on_hand');
      if (!raw) return;
      sessionStorage.removeItem('usage_iq_pantry_on_hand');
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      const items = Array.from(new Set(
        parsed
          .filter((x): x is string => typeof x === 'string')
          .map(x => x.trim())
          .filter(x => x.length > 0),
      ));
      if (items.length) this.onHand.set(items);
    } catch {
      /* malformed JSON or sessionStorage unavailable → no on-hand chips, non-fatal. */
    }
  }

  /** Remove one on-hand chip (it then drops from the next "Plan my week" request's bias). */
  removeOnHand(ingredient: string): void {
    this.onHand.update(list => list.filter(x => x !== ingredient));
  }

  // ---- week navigation ----
  shiftWeek(deltaWeeks: number): void {
    const next = new Date(this.weekStart());
    next.setDate(next.getDate() + deltaWeeks * 7);
    this.weekStart.set(next);
    // Keep a sensible selection: today if it's in the new week, else its Monday.
    this.reselectForWeek();
    this.reload(true);
  }

  goThisWeek(): void {
    if (this.isThisWeek()) return;
    this.weekStart.set(thisMonday());
    this.selectedDate.set(toIso(new Date()));
    this.reload(true);
  }

  selectDay(iso: string): void { this.selectedDate.set(iso); }

  private reselectForWeek(): void {
    const monday = this.weekStart();
    const sunday = new Date(monday);
    sunday.setDate(sunday.getDate() + 6);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    this.selectedDate.set(today >= monday && today <= sunday ? toIso(today) : toIso(monday));
  }

  // ---- data load ----
  reload(initial = false): void {
    if (initial) { this.loading.set(true); this.error.set(false); }
    this.api.familyMeals(this.weekStartIso())
      .pipe(catchError(() => { if (initial) this.error.set(true); return of<FamilyMealDay[]>([]); }),
        takeUntilDestroyed(this.destroyRef))
      .subscribe(days => { this.days.set(days); this.loading.set(false); });
  }

  async refreshAll(): Promise<void> {
    this.refreshing.set(true);
    try {
      const days = await firstValueFrom(
        this.api.familyMeals(this.weekStartIso()).pipe(catchError(() => of<FamilyMealDay[]>([]))));
      this.days.set(days);
      this.error.set(false);
      this.toast.show('Plan refreshed', { tone: 'success', durationMs: 1600 });
    } catch {
      this.toast.show('Couldn’t refresh — pull again', { tone: 'warn' });
    } finally {
      this.refreshing.set(false);
    }
  }

  // ---- meal action sheet ----
  openMeal(meal: FamilyMeal): void {
    this.activeMeal.set(meal);
    this.mealSheet().open.set(true);
  }

  onMealSwipe(meal: FamilyMeal, side: 'left' | 'right'): void {
    if (side === 'left') this.removeMeal(meal);
    else this.addMealToGrocery(meal);
  }

  // ---- add / edit meal (reuse createFamilyMeal / patchFamilyMeal via the editor sheet) ----
  /**
   * Open the editor sheet to ADD a meal to the selected day (defaults to the dinner slot). The sheet emits
   * `saved` → onMealSaved does the create write + reload. Falls back to the week's Monday if no day is selected.
   */
  addMeal(): void {
    const cell = this.selectedCell();
    const date = cell?.localDate ?? this.weekStartIso();
    const label = cell ? `${cell.weekdayLong}, ${cell.dateLabel}` : this.weekLabel();
    this.editingMeal.set(null);
    this.editDate.set(date);
    this.editDayLabel.set(label);
    const sheet = this.editSheet();
    sheet.reset();
    sheet.open.set(true);
  }

  /** Open the editor sheet to EDIT the active meal (from the actions sheet). */
  editActiveMeal(): void {
    const meal = this.activeMeal();
    if (!meal) return;
    this.mealSheet().open.set(false);
    const cell = this.cells().find(c => c.localDate === dateOnly(meal.localDate));
    this.editingMeal.set(meal);
    this.editDate.set(dateOnly(meal.localDate));
    this.editDayLabel.set(cell ? `${cell.weekdayLong}, ${cell.dateLabel}` : dateOnly(meal.localDate));
    const sheet = this.editSheet();
    sheet.reset();
    sheet.open.set(true);
  }

  /** Persist the editor result: PATCH an existing meal, else create a new one on the target day. Then reload. */
  async onMealSaved(result: EditMealResult): Promise<void> {
    const meal = this.editingMeal();
    const macro = {
      servings: result.servings,
      calories: result.calories,
      proteinG: result.proteinG,
      carbG: result.carbG,
      fatG: result.fatG,
      macroSource: result.macroSource,
    };
    try {
      if (meal) {
        await firstValueFrom(this.api.patchFamilyMeal(meal.id, {
          slot: result.slot, title: result.title, ingredients: result.ingredients, ...macro,
        }));
        this.toast.show(`Saved “${result.title}”`, { tone: 'success', durationMs: 2400 });
      } else {
        await firstValueFrom(this.api.createFamilyMeal({
          localDate: this.editDate(), slot: result.slot, title: result.title,
          ingredients: result.ingredients, ...macro,
        }));
        this.toast.show(`Added “${result.title}”`, { tone: 'success', durationMs: 2400 });
      }
      this.reload();
    } catch {
      this.toast.show('Couldn’t save that meal — please try again', { tone: 'warn' });
    }
  }

  // ---- refine with AI (reuse refineMeal preview → patchFamilyMeal, gated tracker.ai) ----
  refineActiveMeal(): void {
    if (!this.canTrackerAi() || !this.activeMeal()) return;
    this.mealSheet().open.set(false);
    const sheet = this.refineSheet();
    sheet.reset();
    sheet.open.set(true);
  }

  onRefined(title: string): void {
    this.reload();
    this.toast.show(`Refined “${title}”`, { tone: 'success', durationMs: 2600 });
  }

  // ---- add planned meal to tracker (reuse addMealToTracker, gated tracker.self + macros) ----
  async trackActiveMeal(): Promise<void> {
    const meal = this.activeMeal();
    if (!meal || !this.canTrack() || meal.macroSource === 'none') return;
    this.mealSheet().open.set(false);
    await this.ensureHouseholdMembers();
    const sheet = this.trackSheet();
    sheet.reset();
    sheet.open.set(true);
  }

  async onTrackConfirmed(choice: AddToTrackerResult): Promise<void> {
    const meal = this.activeMeal();
    if (!meal) return;
    try {
      await firstValueFrom(this.api.addMealToTracker(meal.id, {
        localDate: dateOnly(meal.localDate),
        servings: choice.servings,
        targetUserId: choice.targetUserId,
      }));
      const n = choice.servings;
      const serving = n === 1 ? 'serving' : 'servings';
      this.toast.show(`Added ${n} ${serving} of “${meal.title}” to ${choice.targetName} tracker`, {
        tone: 'success', durationMs: 4000,
      });
    } catch {
      this.toast.show('Couldn’t add this meal to the tracker', { tone: 'warn' });
    }
  }

  /**
   * Load the household members for the "whose tracker?" picker once, cached. Without family.use (or on any
   * error) we leave the list empty — the sheet then offers a Me-only choice, so self-logging always works.
   */
  private async ensureHouseholdMembers(): Promise<void> {
    if (this.householdLoaded) return;
    this.householdLoaded = true;
    if (!this.auth.hasPermission(PERM.familyUse)) return;
    try {
      const household = await firstValueFrom(this.api.getHousehold());
      this.householdMembers.set(household.members ?? []);
    } catch {
      this.householdMembers.set([]);
    }
  }

  // ---- grocery hand-offs (reuse mealsToGrocery + the grocery sheet) ----
  async addMealToGrocery(meal: FamilyMeal): Promise<void> {
    try {
      const before = await this.groceryOpenCount();
      const list = await firstValueFrom(this.api.mealsToGrocery({ mealIds: [meal.id] }));
      const added = Math.max(0, list.items.filter(i => !i.done).length - before);
      this.toastAdded(added);
    } catch {
      this.toast.show('Couldn’t add those ingredients', { tone: 'warn' });
    }
  }

  addActiveMealToGrocery(): void {
    const meal = this.activeMeal();
    if (meal) { this.mealSheet().open.set(false); void this.addMealToGrocery(meal); }
  }

  async addDayToGrocery(): Promise<void> {
    const cell = this.selectedCell();
    if (this.addingDay() || !cell || cell.meals.length === 0) return;
    this.addingDay.set(true);
    try {
      const before = await this.groceryOpenCount();
      const list = await firstValueFrom(this.api.mealsToGrocery({ mealIds: cell.meals.map(m => m.id) }));
      const added = Math.max(0, list.items.filter(i => !i.done).length - before);
      this.toastAdded(added);
    } catch {
      this.toast.show('Couldn’t add this day’s ingredients', { tone: 'warn' });
    } finally {
      this.addingDay.set(false);
    }
  }

  /** Pour the WHOLE visible week's ingredients into the household grocery list (reuse mealsToGrocery). */
  async addWeekToGrocery(): Promise<void> {
    if (this.addingWeek() || this.mealCount() === 0) return;
    this.addingWeek.set(true);
    try {
      const before = await this.groceryOpenCount();
      const list = await firstValueFrom(this.api.mealsToGrocery({ weekStart: this.weekStartIso() }));
      const added = Math.max(0, list.items.filter(i => !i.done).length - before);
      this.toastAdded(added);
    } catch {
      this.toast.show('Couldn’t add this week’s ingredients', { tone: 'warn' });
    } finally {
      this.addingWeek.set(false);
    }
  }

  /** The household Groceries list's current open-item count (best-effort) for an accurate "added N". */
  private async groceryOpenCount(): Promise<number> {
    try {
      const lists = await firstValueFrom(this.api.familyLists());
      const groceries =
        lists.find(l => l.kind === 'shopping' && /groceries/i.test(l.name)) ??
        lists.find(l => l.kind === 'shopping');
      return groceries ? groceries.items.filter(i => !i.done).length : 0;
    } catch {
      return 0;
    }
  }

  private toastAdded(added: number): void {
    const msg = added === 0
      ? 'Already on your grocery list'
      : `Added ${added} ${added === 1 ? 'ingredient' : 'ingredients'} to groceries`;
    this.toast.show(msg, {
      tone: 'success', actionLabel: 'View list', durationMs: 5000,
      onAction: () => this.openGrocery(),
    });
  }

  // ---- remove (reuse deleteFamilyMeal, optimistic + undo) ----
  async removeMeal(meal: FamilyMeal): Promise<void> {
    // Optimistic remove from the loaded week.
    const prev = this.days();
    this.days.set(prev.map(d => ({ ...d, meals: d.meals.filter(m => m.id !== meal.id) })));
    try {
      await firstValueFrom(this.api.deleteFamilyMeal(meal.id));
      this.toast.show(`Removed “${meal.title}”`, { tone: 'neutral', durationMs: 2600 });
    } catch {
      this.days.set(prev); // revert
      this.toast.show('Couldn’t remove that meal', { tone: 'warn' });
    }
  }

  removeActiveMeal(): void {
    const meal = this.activeMeal();
    if (meal) { this.mealSheet().open.set(false); void this.removeMeal(meal); }
  }

  // ---- move to another day (reuse patchFamilyMeal, optimistic + revert) ----
  /** Hand off from the actions sheet to the day-picker sheet (same active meal). */
  openMoveActiveMeal(): void {
    if (this.activeMeal()) { this.mealSheet().open.set(false); this.moveSheet().open.set(true); }
  }

  moveActiveMeal(targetIso: string): void {
    const meal = this.activeMeal();
    if (meal) { this.moveSheet().open.set(false); void this.moveMeal(meal, targetIso); }
  }

  /** Reschedule one meal to `targetIso` (same slot): optimistically shuffle the day buckets, then PATCH. */
  async moveMeal(meal: FamilyMeal, targetIso: string): Promise<void> {
    const fromIso = dateOnly(meal.localDate);
    if (targetIso === fromIso) return;

    // Optimistic move: drop the meal from its old day, add the re-dated copy to the new day.
    const prev = this.days();
    const moved: FamilyMeal = { ...meal, localDate: targetIso };
    this.days.set(prev.map(d => {
      const iso = dateOnly(d.localDate);
      if (iso === fromIso) return { ...d, meals: d.meals.filter(m => m.id !== meal.id) };
      if (iso === targetIso) return { ...d, meals: [...d.meals, moved] };
      return d;
    }));

    const dayLabel = this.cells().find(c => c.localDate === targetIso)?.weekdayLong ?? 'that day';
    try {
      await firstValueFrom(this.api.patchFamilyMeal(meal.id, { localDate: targetIso }));
      // Reconcile with the server's truth (mirrors the post-write reload the other paths use).
      this.reload();
      this.toast.show(`Moved to ${dayLabel}`, { tone: 'success', durationMs: 2600 });
    } catch {
      this.days.set(prev); // revert
      this.toast.show('Couldn’t move that meal', { tone: 'warn' });
    }
  }

  // ---- sheets ----
  openPlan(): void {
    const sheet = this.planSheet();
    sheet.reset();
    sheet.open.set(true);
  }

  onPlanned(added: number): void {
    this.reload();
    const msg = added === 0 ? 'No meals were added' : `Added ${added} ${added === 1 ? 'meal' : 'meals'} to your plan`;
    this.toast.show(msg, { tone: added === 0 ? 'neutral' : 'success', durationMs: 2800 });
  }

  openEat(): void {
    const sheet = this.eatSheet();
    sheet.reset();
    sheet.open.set(true);
  }

  openGrocery(): void {
    const sheet = this.grocerySheet();
    void sheet.loadList();
    sheet.open.set(true);
  }

  noop(): void { /* the grocery sheet manages its own optimistic state */ }
}
