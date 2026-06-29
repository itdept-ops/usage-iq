import {
  ChangeDetectionStrategy, Component, computed, inject, signal,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { MatIconModule } from '@angular/material/icon';

import { Api } from '../../core/api';
import {
  FamilyMeal, FamilyMealDay, FamilyMealMacroSource, FamilyMealSlot,
} from '../../core/models';
import {
  BetaPullRefresh, BetaBottomSheet, BetaSwipeRow, BetaSkeleton, BetaFab,
  BetaToaster, BetaEmptyState, BetaErrorState, ToastController,
} from '../beta-ui';

/** A day's rendered cell: the ISO date, friendly labels, today flag, meals + a per-serving macro rollup. */
interface DayCell {
  localDate: string;
  weekday: string;
  shortWeekday: string;
  dateLabel: string;
  isToday: boolean;
  meals: FamilyMeal[];
  rollup: { hasMacros: boolean; calories: number; proteinG: number; carbG: number; fatG: number };
}

/** Pretty labels + icons for each slot (dinner is the primary slot at the table). */
const SLOT_META: Record<FamilyMealSlot, { label: string; icon: string }> = {
  dinner: { label: 'Dinner', icon: 'dinner_dining' },
  breakfast: { label: 'Breakfast', icon: 'free_breakfast' },
  lunch: { label: 'Lunch', icon: 'lunch_dining' },
  snack: { label: 'Snack', icon: 'bakery_dining' },
};

/** Slot order for the editor chooser + day grouping. */
const SLOT_ORDER: FamilyMealSlot[] = ['breakfast', 'lunch', 'dinner', 'snack'];

/**
 * Family Meals "Plan" — the mobile-first twin of the live /family/meals weekly meal planner, rebuilt on the
 * shared beta-ui "Strata" kit (`@use '../beta-ui/beta-kit'`). One signature accent — a warm AMBER → ROSE
 * ramp — re-skins the whole screen via the per-page accent contract.
 *
 * The desktop page lays seven day-cards side by side; the phone INVERTS that into a swipe-the-week day
 * picker (a horizontally-scrolling weekday strip with a "today" pip + a per-day meal-count dot) over a
 * single focused day's meal list. An immersive scrolling header carries an accent bloom, the week range
 * with prev/next/this-week navigation, and a tiny planned-macros stat strip for the whole week. Each meal
 * is a {@link BetaSwipeRow} (swipe left to remove, right to edit) showing its slot icon, title, ingredient
 * count, per-serving macros, and a one-tap "add ingredients to grocery list". A {@link BetaFab} adds a
 * meal to the focused day; the add/edit form is a {@link BetaBottomSheet} (slot chooser, title,
 * ingredients textarea one-per-line, optional manual macros). A prominent "Add this week to grocery list"
 * pours the week's ingredients into the household Groceries list. Pull-to-refresh, skeleton loaders, and
 * elevated empty/error states round it out.
 *
 * DATA PARITY: every read/write hits the SAME family meals endpoints the live page uses —
 * {@link Api.familyMeals} (the week's 7 days), {@link Api.createFamilyMeal} / {@link Api.patchFamilyMeal} /
 * {@link Api.deleteFamilyMeal}, and {@link Api.mealsToGrocery} (whole-week or a single meal) VERBATIM. The
 * manual-macro path mirrors the live editor: servings + the four dish TOTALS + `macroSource: 'manual'`.
 * Authors are never surfaced as emails. The AI affordances (Plan our week / What can I make / Refine /
 * tracker tie-in) are intentionally LEFT to the desktop page — this twin is the core plan-and-shop loop.
 *
 * ISOLATION: gated by `platform.mobile` + the SAME `family.use` the live route carries; it consumes the kit
 * + the SAME Api as the live counterpart. No live page is imported or modified. Mobile-first (44px targets,
 * safe-area insets, no 390px overflow); centers on desktop. The screenshot harness mocks the Api, so every
 * state renders cleanly with zero data.
 */
@Component({
  selector: 'app-family-meals-mobile',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [ToastController],
  imports: [
    DecimalPipe, FormsModule, MatIconModule,
    BetaPullRefresh, BetaBottomSheet, BetaSwipeRow, BetaSkeleton, BetaFab, BetaToaster,
    BetaEmptyState, BetaErrorState,
  ],
  template: `
    <!-- ─────────────── PULL-TO-REFRESH OWNS THE SCROLL ─────────────── -->
    <app-bs-pull-refresh class="fm-ptr" [busy]="refreshing()" (refresh)="reload()">
      <div class="fm-scroll" aria-live="polite">

        <!-- ─── IMMERSIVE HEADER: title + accent bloom + week nav + macro stats ─── -->
        <header class="fm-hero">
          <div class="fm-hero__bloom" aria-hidden="true"></div>
          <p class="fm-hero__kicker"><mat-icon aria-hidden="true">restaurant</mat-icon> Meal plan</p>

          <div class="fm-week">
            <button type="button" class="fm-week__nav" (click)="shiftWeek(-1)" aria-label="Previous week">
              <mat-icon aria-hidden="true">chevron_left</mat-icon>
            </button>
            <div class="fm-week__label">
              <span class="fm-week__range">{{ weekLabel() }}</span>
              @if (!isThisWeek()) {
                <button type="button" class="fm-week__today" (click)="goThisWeek()">Jump to this week</button>
              } @else {
                <span class="fm-week__cur">This week</span>
              }
            </div>
            <button type="button" class="fm-week__nav" (click)="shiftWeek(1)" aria-label="Next week">
              <mat-icon aria-hidden="true">chevron_right</mat-icon>
            </button>
          </div>

          @if (!loading() && !errored() && hasWeekMacros()) {
            <div class="fm-stats" aria-label="Planned macros this week">
              <div class="fm-stat">
                <span class="fm-stat__n mono-num">{{ weekRollup().calories | number }}</span>
                <span class="fm-stat__l">kcal</span>
              </div>
              <div class="fm-stat">
                <span class="fm-stat__n mono-num">{{ weekRollup().proteinG | number:'1.0-0' }}</span>
                <span class="fm-stat__l">protein</span>
              </div>
              <div class="fm-stat">
                <span class="fm-stat__n mono-num">{{ weekRollup().carbG | number:'1.0-0' }}</span>
                <span class="fm-stat__l">carbs</span>
              </div>
              <div class="fm-stat">
                <span class="fm-stat__n mono-num">{{ weekRollup().fatG | number:'1.0-0' }}</span>
                <span class="fm-stat__l">fat</span>
              </div>
            </div>
          }
        </header>

        @if (loading()) {
          <!-- skeletons: a weekday strip + a couple of meal rows -->
          <div class="fm-strip" aria-hidden="true">
            @for (n of skeletonDays; track n) {
              <app-bs-skeleton width="48px" height="64px" radius="var(--r-tile)" />
            }
          </div>
          <div class="fm-list" aria-hidden="true">
            @for (n of skeletonCells; track n) {
              <app-bs-skeleton height="84px" radius="var(--r-tile)" />
            }
          </div>

        } @else if (errored()) {
          <app-bs-error
            icon="cloud_off"
            title="Couldn't load the meal plan"
            body="Something went wrong fetching this week's meals. Give it another go."
            (retry)="reload()" />

        } @else {
          @if (cells().length === 0) {
            <!-- UNSEEDED week: no day cells came back — show a guidance card like the desktop twin
                 (the day-strip @for below would otherwise render nothing and leave the body blank). -->
            <app-bs-empty
              icon="restaurant_menu"
              title="No meals planned yet"
              body="Plan the week's meals here — each dish's ingredients can flow straight to your grocery list. Tap + to add your first meal."
              ctaLabel="Plan a meal" ctaIcon="add" (action)="openCreate()" />
          } @else {
          <!-- ─── WEEKDAY STRIP: swipe the week, tap a day to focus it ─── -->
          <div class="fm-strip" role="tablist" aria-label="Days this week">
            @for (c of cells(); track c.localDate) {
              <button type="button" class="fm-day" role="tab"
                      [class.is-active]="c.localDate === focusedDate()"
                      [class.is-today]="c.isToday"
                      [attr.aria-selected]="c.localDate === focusedDate()"
                      (click)="focusDate(c.localDate)">
                <span class="fm-day__wd">{{ c.shortWeekday }}</span>
                <span class="fm-day__d mono-num">{{ dayOfMonth(c.localDate) }}</span>
                <span class="fm-day__dot" aria-hidden="true">
                  @if (c.meals.length) { <span class="fm-day__pip" [attr.data-n]="c.meals.length"></span> }
                </span>
              </button>
            }
          </div>

          <!-- ─── FOCUSED DAY ─── -->
          @if (focusedCell(); as day) {
            <div class="fm-dayhead">
              <div class="fm-dayhead__when">
                <span class="fm-dayhead__wd">{{ day.weekday }}</span>
                <span class="fm-dayhead__date">{{ day.dateLabel }}@if (day.isToday) { · <b>Today</b> }</span>
              </div>
              @if (day.rollup.hasMacros) {
                <span class="fm-dayhead__kcal mono-num">{{ day.rollup.calories | number }} kcal</span>
              }
            </div>

            @if (day.meals.length) {
              <div class="fm-list">
                @for (m of day.meals; track m.id; let i = $index) {
                  <app-bs-swipe-row class="fm-swipe fm-reveal" [style.--ri]="i"
                    leftLabel="Remove" rightLabel="Edit" [disabled]="isBusy(m.id)"
                    [label]="m.title" (swipe)="onSwipe(day, m, $event)">
                    <div class="fm-card" [class.is-busy]="isBusy(m.id)">
                      <span class="fm-card__glyph" aria-hidden="true">
                        <mat-icon>{{ slotMeta(m.slot).icon }}</mat-icon>
                      </span>
                      <div class="fm-card__body">
                        <div class="fm-card__top">
                          <span class="fm-card__slot">{{ slotMeta(m.slot).label }}</span>
                          @if (hasMacros(m)) {
                            <span class="fm-card__macro mono-num">{{ m.perServing.calories | number }} kcal</span>
                          }
                        </div>
                        <span class="fm-card__title">{{ m.title }}</span>
                        <span class="fm-card__meta">
                          @if (ingredientCount(m); as ic) {
                            <mat-icon aria-hidden="true">list_alt</mat-icon>
                            <span class="mono-num">{{ ic }}</span> ingredient{{ ic === 1 ? '' : 's' }}
                          } @else {
                            <span class="fm-card__noing">No ingredients listed</span>
                          }
                          @if (m.createdByName) {
                            · <span class="fm-card__by">{{ m.createdByName }}</span>
                          }
                        </span>
                      </div>
                      @if (ingredientCount(m)) {
                        <button type="button" class="fm-card__cart" [disabled]="isBusy(m.id)"
                                (click)="addMealToGrocery(m); $event.stopPropagation()"
                                aria-label="Add this meal's ingredients to the grocery list">
                          <mat-icon aria-hidden="true">add_shopping_cart</mat-icon>
                        </button>
                      }
                    </div>
                  </app-bs-swipe-row>
                }
              </div>
              <p class="fm-foot" aria-hidden="true">Swipe a meal left to remove · right to edit</p>
            } @else {
              <!-- EMPTY day -->
              <app-bs-empty
                icon="restaurant_menu"
                [title]="'Nothing planned for ' + day.weekday"
                body="Tap the + to plan a meal — its ingredients can flow straight to your grocery list."
                ctaLabel="Plan a meal" ctaIcon="add" (action)="openCreate()" />
            }
          }

          <!-- ─── WHOLE-WEEK GROCERY ─── -->
          @if (mealCount() > 0) {
            <button type="button" class="fm-grocery" [disabled]="addingWeek()" (click)="addWeekToGrocery()">
              @if (addingWeek()) {
                <span class="fm-spin" aria-hidden="true"></span> Adding ingredients…
              } @else {
                <mat-icon aria-hidden="true">shopping_cart_checkout</mat-icon>
                Add this week's ingredients to grocery list
              }
            </button>
          }
          } <!-- /@if (cells().length === 0) … @else -->
        }
      </div>
    </app-bs-pull-refresh>

    <!-- ─── ADD A MEAL TO THE FOCUSED DAY ─── -->
    @if (!loading() && !errored()) {
      <app-bs-fab icon="add" label="Add meal" [extended]="true" [fixed]="true" (action)="openCreate()" />
    }

    <!-- ─────────────── ADD / EDIT FORM SHEET ─────────────── -->
    <app-bs-sheet [(open)]="formOpen" detent="full" [dismissable]="!saving()"
                  [label]="editing() ? 'Edit meal' : 'Add meal'">
      <form class="mf" (ngSubmit)="save()">
        <div class="mf__head">
          <h3 class="mf__title">{{ editing() ? 'Edit meal' : 'Add a meal' }}</h3>
          <button type="button" class="mf__close" (click)="closeForm()" aria-label="Cancel" [disabled]="saving()">
            <mat-icon aria-hidden="true">close</mat-icon>
          </button>
        </div>
        <p class="mf__when">{{ formDayLabel() }}</p>

        <!-- slot chooser -->
        <div class="mf__slots" role="radiogroup" aria-label="Meal slot">
          @for (s of slotOrder; track s) {
            <button type="button" class="mf__slot" role="radio"
                    [class.is-on]="fSlot() === s" [attr.aria-checked]="fSlot() === s"
                    (click)="fSlot.set(s)">
              <mat-icon aria-hidden="true">{{ slotMeta(s).icon }}</mat-icon>
              {{ slotMeta(s).label }}
            </button>
          }
        </div>

        <label class="mf__field">
          <span class="mf__label">Dish</span>
          <input class="mf__input" type="text" [ngModel]="fTitle()" (ngModelChange)="fTitle.set($event)"
                 name="title" placeholder="e.g. Sheet-pan chicken & veg" autocomplete="off"
                 maxlength="160" required />
        </label>

        <label class="mf__field">
          <span class="mf__label">
            <mat-icon class="mf__label-ic" aria-hidden="true">list_alt</mat-icon>
            Ingredients <i>(one per line)</i>
          </span>
          <textarea class="mf__input mf__area" rows="5" [ngModel]="fIngredients()"
                    (ngModelChange)="fIngredients.set($event)" name="ingredients"
                    placeholder="1 lb chicken thighs&#10;2 bell peppers&#10;Olive oil"></textarea>
        </label>

        <!-- optional manual macros -->
        <button type="button" class="mf__toggle" [class.is-on]="showMacros()"
                (click)="showMacros.set(!showMacros())" [attr.aria-expanded]="showMacros()">
          <mat-icon aria-hidden="true">{{ showMacros() ? 'expand_less' : 'expand_more' }}</mat-icon>
          Macros <i>(optional)</i>
        </button>
        @if (showMacros()) {
          <div class="mf__macros">
            <div class="mf__row">
              <label class="mf__field mf__field--sm">
                <span class="mf__label">Servings</span>
                <input class="mf__input mono-num" type="number" inputmode="numeric" min="1" step="1"
                       [ngModel]="fServings()" (ngModelChange)="fServings.set(+$event)" name="servings" />
              </label>
              <label class="mf__field mf__field--sm">
                <span class="mf__label">kcal <i>(total)</i></span>
                <input class="mf__input mono-num" type="number" inputmode="numeric" min="0" step="1"
                       [ngModel]="fCalories()" (ngModelChange)="fCalories.set(+$event)" name="calories" />
              </label>
            </div>
            <div class="mf__row">
              <label class="mf__field mf__field--sm">
                <span class="mf__label">Protein</span>
                <input class="mf__input mono-num" type="number" inputmode="decimal" min="0" step="0.1"
                       [ngModel]="fProtein()" (ngModelChange)="fProtein.set(+$event)" name="protein" />
              </label>
              <label class="mf__field mf__field--sm">
                <span class="mf__label">Carbs</span>
                <input class="mf__input mono-num" type="number" inputmode="decimal" min="0" step="0.1"
                       [ngModel]="fCarb()" (ngModelChange)="fCarb.set(+$event)" name="carb" />
              </label>
              <label class="mf__field mf__field--sm">
                <span class="mf__label">Fat</span>
                <input class="mf__input mono-num" type="number" inputmode="decimal" min="0" step="0.1"
                       [ngModel]="fFat()" (ngModelChange)="fFat.set(+$event)" name="fat" />
              </label>
            </div>
            <p class="mf__hint">Totals for the whole dish — per-serving is derived from servings.</p>
          </div>
        }

        <div class="mf__actions">
          <button type="button" class="mf__btn mf__btn--ghost" (click)="closeForm()" [disabled]="saving()">Cancel</button>
          <button type="submit" class="mf__btn mf__btn--save" [disabled]="!canSave()">
            @if (saving()) { <span class="fm-spin" aria-hidden="true"></span> Saving… }
            @else { <mat-icon aria-hidden="true">check</mat-icon> {{ editing() ? 'Save changes' : 'Add meal' }} }
          </button>
        </div>
      </form>
    </app-bs-sheet>

    <app-bs-toaster />
  `,
  styleUrl: './family-meals-mobile.page.scss',
})
export class FamilyMealsMobilePage {
  private api = inject(Api);
  private toast = inject(ToastController);
  private route = inject(ActivatedRoute);

  readonly days = signal<FamilyMealDay[]>([]);
  readonly loading = signal(true);
  readonly errored = signal(false);
  readonly refreshing = signal(false);
  /** True while the whole-week grocery add is in flight (locks that button). */
  readonly addingWeek = signal(false);

  /** Per-meal in-flight ids (delete / single grocery) so only that row's controls disable. */
  private readonly busyIds = signal<Set<number>>(new Set());

  /** The Monday (local) of the viewed week. */
  readonly weekStart = signal<Date>(this.thisMonday());
  /** The focused day's ISO date ("YYYY-MM-DD"); the strip taps move it, week shifts reset it. */
  readonly focusedDate = signal<string>(this.toIso(new Date()));

  // ---- form sheet ----
  readonly formOpen = signal(false);
  readonly editing = signal<FamilyMeal | null>(null);
  readonly saving = signal(false);
  readonly showMacros = signal(false);
  /** The ISO date the form is targeting (the focused day on create, the meal's day on edit). */
  private readonly formDate = signal<string>('');

  readonly fSlot = signal<FamilyMealSlot>('dinner');
  readonly fTitle = signal('');
  readonly fIngredients = signal('');
  readonly fServings = signal(1);
  readonly fCalories = signal(0);
  readonly fProtein = signal(0);
  readonly fCarb = signal(0);
  readonly fFat = signal(0);

  readonly slotOrder = SLOT_ORDER;
  readonly skeletonDays = Array.from({ length: 7 }, (_, i) => i);
  readonly skeletonCells = Array.from({ length: 3 }, (_, i) => i);

  private readonly weekStartIso = computed(() => this.toIso(this.weekStart()));

  readonly weekLabel = computed(() => {
    const start = this.weekStart();
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    const sameMonth = start.getMonth() === end.getMonth();
    const startLbl = start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const endLbl = end.toLocaleDateString(
      undefined, sameMonth ? { day: 'numeric' } : { month: 'short', day: 'numeric' },
    );
    return `${startLbl} – ${endLbl}`;
  });

  readonly isThisWeek = computed(
    () => this.toIso(this.weekStart()) === this.toIso(this.thisMonday()),
  );

  /** The 7 day cells with friendly labels + a today flag + a per-serving macro rollup. */
  readonly cells = computed<DayCell[]>(() => {
    const todayIso = this.toIso(new Date());
    return this.days().map((d) => {
      const local = this.dateOnly(d.localDate);
      const date = new Date(`${local}T00:00:00`);
      return {
        localDate: local,
        weekday: date.toLocaleDateString(undefined, { weekday: 'long' }),
        shortWeekday: date.toLocaleDateString(undefined, { weekday: 'short' }),
        dateLabel: date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
        isToday: local === todayIso,
        meals: d.meals,
        rollup: this.rollup(d.meals),
      };
    });
  });

  /** The currently-focused day cell (falls back to the first day of the loaded week). */
  readonly focusedCell = computed<DayCell | null>(() => {
    const cells = this.cells();
    if (cells.length === 0) return null;
    return cells.find((c) => c.localDate === this.focusedDate()) ?? cells[0];
  });

  readonly formDayLabel = computed<string>(() => {
    const iso = this.formDate();
    if (!iso) return '';
    const d = new Date(`${iso}T00:00:00`);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  });

  readonly mealCount = computed(() => this.cells().reduce((n, c) => n + c.meals.length, 0));

  readonly weekRollup = computed(() =>
    this.cells().reduce(
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

  readonly hasWeekMacros = computed(() => this.weekRollup().hasMacros);

  readonly canSave = computed(() => this.fTitle().trim().length > 0 && !this.saving());

  constructor() {
    // Deep-link from Search: ?date=yyyy-MM-dd jumps the displayed week to the one containing that date AND
    // focuses that day (parity with the desktop /family/meals consumer, which jumps the week to contain it).
    // An invalid/absent param leaves the default (this week, today focused), so a normal visit is unchanged.
    const dateParam = this.route.snapshot.queryParamMap.get('date');
    if (dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
      const d = new Date(`${dateParam}T00:00:00`);
      if (!Number.isNaN(d.getTime())) {
        this.weekStart.set(this.mondayOf(d));
        this.focusedDate.set(dateParam);
      }
    }
    void this.reload();
  }

  // ─────────────── LOAD ───────────────

  async reload(): Promise<void> {
    const wasLoaded = !this.loading();
    if (wasLoaded) this.refreshing.set(true); else this.loading.set(true);
    this.errored.set(false);
    try {
      const days = await firstValueFrom(this.api.familyMeals(this.weekStartIso()));
      this.days.set(days ?? []);
      // Keep the focused day inside the loaded week.
      const cells = this.cells();
      if (cells.length && !cells.some((c) => c.localDate === this.focusedDate())) {
        const todayIso = this.toIso(new Date());
        this.focusedDate.set(cells.find((c) => c.localDate === todayIso)?.localDate ?? cells[0].localDate);
      }
    } catch {
      this.errored.set(true);
    } finally {
      this.loading.set(false);
      if (wasLoaded) {
        this.refreshing.set(false);
        this.toast.show('Meal plan refreshed', { tone: 'success', durationMs: 1600 });
      }
    }
  }

  // ─────────────── WEEK / DAY NAV ───────────────

  shiftWeek(deltaWeeks: number): void {
    const next = new Date(this.weekStart());
    next.setDate(next.getDate() + deltaWeeks * 7);
    this.weekStart.set(next);
    // Focus the new week's Monday (or today if it's the current week).
    const todayIso = this.toIso(new Date());
    const mondayIso = this.toIso(next);
    this.focusedDate.set(this.isThisWeek() ? todayIso : mondayIso);
    void this.reload();
  }

  goThisWeek(): void {
    if (this.isThisWeek()) return;
    this.weekStart.set(this.thisMonday());
    this.focusedDate.set(this.toIso(new Date()));
    void this.reload();
  }

  focusDate(iso: string): void {
    this.focusedDate.set(iso);
  }

  // ─────────────── helpers ───────────────

  slotMeta(slot: FamilyMealSlot) {
    return SLOT_META[slot] ?? SLOT_META.dinner;
  }

  hasMacros(meal: FamilyMeal): boolean {
    return meal.macroSource !== 'none';
  }

  ingredientCount(meal: FamilyMeal): number {
    return meal.ingredients.split('\n').filter((s) => s.trim().length > 0).length;
  }

  dayOfMonth(iso: string): number {
    return Number(iso.slice(8, 10)) || new Date(`${iso}T00:00:00`).getDate();
  }

  isBusy(id: number): boolean {
    return this.busyIds().has(id);
  }

  private setBusy(id: number, on: boolean): void {
    this.busyIds.update((set) => {
      const next = new Set(set);
      if (on) next.add(id); else next.delete(id);
      return next;
    });
  }

  private rollup(meals: FamilyMeal[]) {
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
      proteinG: this.round1(proteinG),
      carbG: this.round1(carbG),
      fatG: this.round1(fatG),
    };
  }

  private round1(n: number): number {
    return Math.round((Number.isFinite(n) ? n : 0) * 10) / 10;
  }

  // ─────────────── SWIPE (delete / edit) ───────────────

  onSwipe(day: DayCell, meal: FamilyMeal, side: 'left' | 'right'): void {
    if (side === 'left') void this.remove(meal);
    else this.openEdit(day, meal);
  }

  async remove(meal: FamilyMeal): Promise<void> {
    if (this.isBusy(meal.id)) return;
    if (typeof confirm === 'function' &&
        !confirm(`Remove “${meal.title}” from the plan?`)) return;
    this.setBusy(meal.id, true);
    try {
      await firstValueFrom(this.api.deleteFamilyMeal(meal.id));
      this.days.update((ds) =>
        ds.map((d) => ({ ...d, meals: d.meals.filter((m) => m.id !== meal.id) })),
      );
      this.toast.show('Meal removed', { tone: 'success', durationMs: 1800 });
    } catch {
      this.toast.show("Couldn't remove that meal — try again", { tone: 'warn' });
    } finally {
      this.setBusy(meal.id, false);
    }
  }

  // ─────────────── ADD / EDIT FORM ───────────────

  openCreate(): void {
    const target = this.focusedCell();
    if (!target) return;
    this.editing.set(null);
    this.formDate.set(target.localDate);
    this.seedForm(null, 'dinner');
    this.formOpen.set(true);
  }

  openEdit(day: DayCell, meal: FamilyMeal): void {
    this.editing.set(meal);
    this.formDate.set(day.localDate);
    this.seedForm(meal, meal.slot);
    this.formOpen.set(true);
  }

  closeForm(): void {
    if (this.saving()) return;
    this.formOpen.set(false);
  }

  private seedForm(meal: FamilyMeal | null, slot: FamilyMealSlot): void {
    this.fSlot.set(slot);
    this.fTitle.set(meal?.title ?? '');
    this.fIngredients.set(meal?.ingredients ?? '');
    const hasMacros = !!meal && meal.macroSource !== 'none';
    this.showMacros.set(hasMacros);
    this.fServings.set(Math.max(1, meal?.servings ?? 1));
    this.fCalories.set(meal?.calories ?? 0);
    this.fProtein.set(meal?.proteinG ?? 0);
    this.fCarb.set(meal?.carbG ?? 0);
    this.fFat.set(meal?.fatG ?? 0);
  }

  /** Build the optional manual-macro fragment, mirroring the live editor's macroSource: 'manual'. */
  private macroFragment(): {
    servings?: number; calories?: number; proteinG?: number; carbG?: number; fatG?: number;
    macroSource?: FamilyMealMacroSource;
  } {
    if (!this.showMacros()) return {};
    const calories = Math.max(0, Math.round(this.fCalories() || 0));
    const proteinG = this.round1(Math.max(0, this.fProtein() || 0));
    const carbG = this.round1(Math.max(0, this.fCarb() || 0));
    const fatG = this.round1(Math.max(0, this.fFat() || 0));
    const anySet = calories > 0 || proteinG > 0 || carbG > 0 || fatG > 0;
    if (!anySet) return {};
    return {
      servings: Math.max(1, Math.round(this.fServings() || 1)),
      calories, proteinG, carbG, fatG,
      macroSource: 'manual',
    };
  }

  async save(): Promise<void> {
    if (!this.canSave()) {
      if (!this.fTitle().trim()) this.toast.show('Give the meal a title first.', { tone: 'warn' });
      return;
    }
    this.saving.set(true);
    const editRow = this.editing();
    const title = this.fTitle().trim();
    const ingredients = this.fIngredients().trim();
    const slot = this.fSlot();
    try {
      if (editRow) {
        const saved = await firstValueFrom(
          this.api.patchFamilyMeal(editRow.id, { slot, title, ingredients, ...this.macroFragment() }),
        );
        this.applySaved(saved, editRow.id);
        this.toast.show('Meal updated', { tone: 'success', durationMs: 1800 });
      } else {
        const saved = await firstValueFrom(
          this.api.createFamilyMeal({
            localDate: this.formDate(), slot, title, ingredients, ...this.macroFragment(),
          }),
        );
        this.applySaved(saved, null);
        this.focusDate(this.dateOnly(saved.localDate));
        this.toast.show(`Added “${saved.title}”`, { tone: 'success', durationMs: 2000 });
      }
      this.formOpen.set(false);
    } catch {
      this.toast.show("Couldn't save the meal — try again", { tone: 'warn' });
    } finally {
      this.saving.set(false);
    }
  }

  /** Patch the loaded week with a created/updated meal (drop the old, slot the new under its day). */
  private applySaved(saved: FamilyMeal, removeId: number | null): void {
    const day = this.dateOnly(saved.localDate);
    this.days.update((ds) =>
      ds.map((d) => {
        let meals = removeId != null ? d.meals.filter((m) => m.id !== removeId) : d.meals;
        if (this.dateOnly(d.localDate) === day) {
          meals = [...meals.filter((m) => m.id !== saved.id), saved]
            .sort((a, b) => SLOT_ORDER.indexOf(a.slot) - SLOT_ORDER.indexOf(b.slot));
        }
        return { ...d, meals };
      }),
    );
  }

  // ─────────────── GROCERY TIE-IN (reuse the live Api verbatim) ───────────────

  async addWeekToGrocery(): Promise<void> {
    if (this.addingWeek() || this.mealCount() === 0) return;
    this.addingWeek.set(true);
    try {
      const before = await this.groceryOpenCount();
      const list = await firstValueFrom(this.api.mealsToGrocery({ weekStart: this.weekStartIso() }));
      this.reportAdded(list.items.filter((i) => !i.done).length - before, list.name);
    } catch {
      this.toast.show("Couldn't add this week's ingredients — try again", { tone: 'warn' });
    } finally {
      this.addingWeek.set(false);
    }
  }

  async addMealToGrocery(meal: FamilyMeal): Promise<void> {
    if (this.isBusy(meal.id)) return;
    this.setBusy(meal.id, true);
    try {
      const before = await this.groceryOpenCount();
      const list = await firstValueFrom(this.api.mealsToGrocery({ mealIds: [meal.id] }));
      this.reportAdded(list.items.filter((i) => !i.done).length - before, list.name);
    } catch {
      this.toast.show("Couldn't add those ingredients — try again", { tone: 'warn' });
    } finally {
      this.setBusy(meal.id, false);
    }
  }

  /** The household Groceries list's current open-item count, so we can report how many NEW items landed. */
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
    const msg = n === 0
      ? `Everything was already on “${listName}.”`
      : `Added ${n} ${n === 1 ? 'ingredient' : 'ingredients'} to “${listName}.”`;
    this.toast.show(msg, { tone: 'success', durationMs: 2600 });
  }

  // ─────────────── DATE HELPERS (the household week starts Monday) ───────────────

  private thisMonday(): Date {
    return this.mondayOf(new Date());
  }

  /** The local Monday (at local midnight) of the week containing `date`. */
  private mondayOf(date: Date): Date {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    const offset = (d.getDay() + 6) % 7; // Sun=0..Sat=6 → Mon=0..Sun=6
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
}
