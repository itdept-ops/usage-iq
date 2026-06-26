import {
  ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal, viewChild,
} from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { catchError, firstValueFrom, of } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { Api } from '../../core/api';
import { AuthService } from '../../core/auth';
import {
  FamilyMeal, FamilyMealDay, PERM, TrackerProfileDto,
} from '../../core/models';
import {
  BetaFab, BetaPullRefresh, BetaSkeleton, BetaSvgRing, BetaSwipeRow, BetaToaster, ToastController,
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
 * ISOLATION: gated by `beta.access` + `meals.use`; consumes the kit + the SAME read/write Api as the live
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
    ForageDayStrip, ForageMealCard, ForagePlanSheet, ForageEatSheet, ForageGrocerySheet, ForageMealActionsSheet,
  ],
  template: `
    <app-bs-pull-refresh class="mb-ptr" [busy]="refreshing()" (refresh)="refreshAll()">
      <div class="mb-scroll">

        <!-- Immersive header: week range + a planned glance, accent bloom, week nav. -->
        <header class="hh">
          <div class="hh__bloom" aria-hidden="true"></div>
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

        <!-- Swipeable week strip of day chips. -->
        <app-forage-day-strip class="mb-strip"
          [cells]="cells()" [selected]="selectedDate()" (pick)="selectDay($event)" />

        <!-- The selected day's meals. -->
        <section class="mb-day" [attr.aria-label]="selectedCell()?.weekdayLong + ' meals'">
          <div class="mb-day-h">
            <div class="mb-day-h-txt">
              <h2 class="mb-day-title">{{ selectedCell()?.weekdayLong || 'Day' }}</h2>
              <span class="mb-day-sub">{{ selectedCell()?.dateLabel }}</span>
            </div>
            @if ((selectedCell()?.meals?.length ?? 0) > 0) {
              <button type="button" class="mb-day-gro" (click)="addDayToGrocery()" [disabled]="addingDay()"
                      aria-label="Add this day's ingredients to grocery list">
                @if (addingDay()) { <span class="mb-mini-spin" aria-hidden="true"></span> }
                @else { <mat-icon aria-hidden="true">add_shopping_cart</mat-icon> }
                <span>Add day</span>
              </button>
            }
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
              <button type="button" class="mb-state-btn" (click)="openPlan()">
                <mat-icon aria-hidden="true">auto_awesome</mat-icon> Plan with AI
              </button>
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
        </div>
      </div>
    </app-bs-pull-refresh>

    <!-- Primary action: AI plan the week. -->
    <app-bs-fab icon="auto_awesome" label="Plan my week" [extended]="true" [fixed]="true" (action)="openPlan()" />

    <!-- Sheets. -->
    <app-forage-plan-sheet #planSheet [weekStart]="weekStartIso()" (planned)="onPlanned($event)" />
    <app-forage-eat-sheet #eatSheet />
    <app-forage-grocery-sheet #grocerySheet (changed)="noop()" />
    <app-forage-meal-actions-sheet #mealSheet
      [meal]="activeMeal()" (grocery)="addActiveMealToGrocery()" (remove)="removeActiveMeal()" />

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

  /** The meal whose action sheet is open (drives the actions sheet's content). */
  readonly activeMeal = signal<FamilyMeal | null>(null);

  /** The caller's tracker goals (loaded when they hold tracker.self), for the calorie ring fractions. */
  private readonly trackerProfile = signal<TrackerProfileDto | null>(null);
  private readonly canTrack = computed(() => {
    this.auth.permissions();
    return this.auth.hasPermission(PERM.trackerSelf);
  });
  readonly calorieGoal = computed(() =>
    this.canTrack() ? (this.trackerProfile()?.dailyCalorieGoal ?? null) : null);

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

  constructor() {
    this.reload(true);
    if (this.canTrack()) {
      this.api.trackerProfile()
        .pipe(catchError(() => of<TrackerProfileDto | null>(null)), takeUntilDestroyed(this.destroyRef))
        .subscribe(p => this.trackerProfile.set(p));
    }
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
