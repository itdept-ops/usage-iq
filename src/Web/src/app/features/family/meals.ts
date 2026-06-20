import { Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { catchError, firstValueFrom, of } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';

import { Api } from '../../core/api';
import { FamilyMeal, FamilyMealDay, FamilyMealSlot } from '../../core/models';
import { FamilyConfirmDialog, ConfirmData } from './confirm-dialog';
import { MealEditorDialog, MealEditorData, MealEditorResult } from './meal-editor-dialog';

/** A day cell as rendered: the ISO date, friendly labels, today flag, and its meals. */
interface DayCell {
  localDate: string;
  weekday: string;
  dateLabel: string;
  isToday: boolean;
  meals: FamilyMeal[];
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
    RouterLink, MatIconModule, MatButtonModule, MatTooltipModule, MatProgressSpinnerModule,
    MatSnackBarModule,
  ],
  templateUrl: './meals.html',
  styleUrls: ['./family.scss', './meals.scss'],
})
export class FamilyMeals {
  private api = inject(Api);
  private dialog = inject(MatDialog);
  private snack = inject(MatSnackBar);
  private router = inject(Router);

  readonly days = signal<FamilyMealDay[]>([]);
  readonly loading = signal(true);
  readonly error = signal(false);
  /** True while the whole-week "add to grocery" call is in flight (locks the button). */
  readonly addingWeek = signal(false);

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
    const endLbl = end.toLocaleDateString(undefined,
      sameMonth ? { day: 'numeric' } : { month: 'short', day: 'numeric' });
    return `${startLbl} – ${endLbl}`;
  });

  /** True when the viewed week contains today (so we can offer a "This week" reset). */
  readonly isThisWeek = computed(() => this.toIso(this.weekStart()) === this.toIso(this.thisMonday()));

  /** The 7 day cells with friendly labels + a today flag, derived from the loaded days. */
  readonly cells = computed<DayCell[]>(() => {
    const todayIso = this.toIso(new Date());
    return this.days().map(d => {
      const date = new Date(`${this.dateOnly(d.localDate)}T00:00:00`);
      return {
        localDate: this.dateOnly(d.localDate),
        weekday: date.toLocaleDateString(undefined, { weekday: 'long' }),
        dateLabel: date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
        isToday: this.dateOnly(d.localDate) === todayIso,
        meals: d.meals,
      };
    });
  });

  /** Total meals planned across the visible week (drives the empty-week hint + the grocery button). */
  readonly mealCount = computed(() => this.cells().reduce((n, c) => n + c.meals.length, 0));

  constructor() {
    this.reload(true);
  }

  private reload(initial = false): void {
    if (initial) this.loading.set(true);
    this.api.familyMeals(this.weekStartIso())
      .pipe(catchError(() => { if (initial) this.error.set(true); return of<FamilyMealDay[]>([]); }),
        takeUntilDestroyed())
      .subscribe(days => { this.days.set(days); this.loading.set(false); });
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

  // ---- Meals (add / edit / delete) ----

  /** Add a meal to a specific day (default slot = dinner). */
  async addMeal(cell: DayCell, slot: FamilyMealSlot = 'dinner'): Promise<void> {
    const result = await this.openEditor(null, cell.localDate, `${cell.weekday}, ${cell.dateLabel}`, slot);
    if (!result) return;
    try {
      await firstValueFrom(this.api.createFamilyMeal({
        localDate: cell.localDate, slot: result.slot, title: result.title, ingredients: result.ingredients,
      }));
      this.reload();
    } catch (e) {
      this.snack.open(this.messageOf(e, "Couldn't save that meal. Please try again."), 'OK', { duration: 4000 });
    }
  }

  /** Edit an existing meal on a day. */
  async editMeal(cell: DayCell, meal: FamilyMeal): Promise<void> {
    const result = await this.openEditor(meal, cell.localDate, `${cell.weekday}, ${cell.dateLabel}`);
    if (!result) return;
    try {
      await firstValueFrom(this.api.updateFamilyMeal(meal.id, {
        slot: result.slot, title: result.title, ingredients: result.ingredients,
      }));
      this.reload();
    } catch (e) {
      this.snack.open(this.messageOf(e, "Couldn't save that meal. Please try again."), 'OK', { duration: 4000 });
    }
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
    meal: FamilyMeal | null, localDate: string, dayLabel: string, defaultSlot?: FamilyMealSlot,
  ): Promise<MealEditorResult | undefined> {
    const ref = this.dialog.open<MealEditorDialog, MealEditorData, MealEditorResult>(MealEditorDialog, {
      data: { meal, localDate, dayLabel, defaultSlot }, width: '460px', maxWidth: '94vw', autoFocus: false,
    });
    return firstValueFrom(ref.afterClosed());
  }

  // ---- Grocery-list tie-in ----

  /** True when a meal carries at least one ingredient line (so the per-meal add button shows). */
  hasIngredients(meal: FamilyMeal): boolean {
    return meal.ingredients.split('\n').some(s => s.trim().length > 0);
  }

  /** Pour the whole visible week's ingredients into the household's grocery list. */
  async addWeekToGrocery(): Promise<void> {
    if (this.addingWeek() || this.mealCount() === 0) return;
    this.addingWeek.set(true);
    try {
      const before = await this.groceryOpenCount();
      const list = await firstValueFrom(this.api.mealsToGrocery({ weekStart: this.weekStartIso() }));
      this.reportAdded(list.items.filter(i => !i.done).length - before, list.name);
    } catch {
      this.snack.open("Couldn't add this week's ingredients. Please try again.", 'OK', { duration: 4000 });
    } finally {
      this.addingWeek.set(false);
    }
  }

  /** Pour a single meal's ingredients into the household's grocery list. */
  async addMealToGrocery(meal: FamilyMeal): Promise<void> {
    try {
      const before = await this.groceryOpenCount();
      const list = await firstValueFrom(this.api.mealsToGrocery({ mealIds: [meal.id] }));
      this.reportAdded(list.items.filter(i => !i.done).length - before, list.name);
    } catch {
      this.snack.open("Couldn't add those ingredients. Please try again.", 'OK', { duration: 4000 });
    }
  }

  /**
   * The current open-item count of the household's Groceries list (best-effort) so we can report exactly
   * how many NEW items the add produced — the server skips blanks + duplicates already on the list.
   */
  private async groceryOpenCount(): Promise<number> {
    try {
      const lists = await firstValueFrom(this.api.familyLists());
      const groceries = lists.find(l => l.kind === 'shopping' && /groceries/i.test(l.name))
        ?? lists.find(l => l.kind === 'shopping');
      return groceries ? groceries.items.filter(i => !i.done).length : 0;
    } catch {
      return 0;
    }
  }

  /** A warm snackbar: how many items were added (and a quick link to the Lists page). */
  private reportAdded(added: number, listName: string): void {
    const n = Math.max(0, added);
    const msg = n === 0
      ? `Everything was already on “${listName}.”`
      : `Added ${n} ${n === 1 ? 'ingredient' : 'ingredients'} to “${listName}.”`;
    const ref = this.snack.open(msg, 'View list', { duration: 5000 });
    ref.onAction().subscribe(() => { this.router.navigateByUrl('/family/lists'); });
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
      data, width: '420px', maxWidth: '92vw',
    });
    return firstValueFrom(ref.afterClosed());
  }

  private messageOf(e: unknown, fallback: string): string {
    const msg = (e as { error?: { message?: string } })?.error?.message;
    return typeof msg === 'string' && msg ? msg : fallback;
  }
}
