import { Component, computed, effect, inject, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';

import { AuthService } from '../../core/auth';
import { TrackerStore } from '../../core/tracker-store';
import {
  AddExerciseRequest, AddFoodRequest, ExerciseEntryDto, FoodEntryDto, Meal, SharedUserDto, TrackerProfileDto,
} from '../../core/models';
import { CalorieRing } from './calorie-ring';
import { AddFoodDialog, AddFoodData } from './add-food-dialog';
import { AddExerciseDialog, AddExerciseData } from './add-exercise-dialog';
import { ProfileDialog, ProfileData } from './profile-dialog';

interface MealSection { meal: Meal; label: string; icon: string }

const MEAL_SECTIONS: MealSection[] = [
  { meal: 'breakfast', label: 'Breakfast', icon: 'bakery_dining' },
  { meal: 'lunch', label: 'Lunch', icon: 'lunch_dining' },
  { meal: 'dinner', label: 'Dinner', icon: 'dinner_dining' },
  { meal: 'snack', label: 'Snacks', icon: 'cookie' },
];

/**
 * Food & fitness tracker dashboard. Renders the active {@link TrackerDayDto} from {@link TrackerStore}:
 * a date navigator, the headline calorie ring + macro bars, the four meal sections (with add/delete),
 * the exercise section, and a read-only shared-view selector. All add/delete controls are hidden when
 * viewing someone else's tracker (store.readOnly). Dialogs resolve with request bodies that the page
 * persists through the store, which then refreshes the day.
 */
@Component({
  selector: 'app-tracker',
  imports: [
    DecimalPipe, FormsModule, MatIconModule, MatButtonModule, MatProgressBarModule, MatMenuModule,
    MatTooltipModule, MatDialogModule, MatSnackBarModule, CalorieRing,
  ],
  templateUrl: './tracker.html',
  styleUrl: './tracker.scss',
})
export class Tracker {
  readonly store = inject(TrackerStore);
  readonly auth = inject(AuthService);
  private dialog = inject(MatDialog);
  private snack = inject(MatSnackBar);

  readonly mealSections = MEAL_SECTIONS;

  /** Screen-reader-only live status: announces day reloads and entry deletions. */
  readonly statusMsg = signal('');

  constructor() {
    void this.store.load();
    void this.store.loadShared();

    // Announce day reloads (date change / viewing another user) to assistive tech.
    effect(() => {
      const day = this.store.day();
      if (!day) return;
      this.statusMsg.set(`Showing ${this.dateHeading()}, ${Math.round(day.netCalories)} net calories`);
    });
  }

  // ---- date navigation ----
  prevDay(): void { void this.store.shiftDate(-1); }
  nextDay(): void { void this.store.shiftDate(1); }
  today(): void { void this.store.goToday(); }
  onDateInput(value: string): void { if (value) void this.store.setDate(value); }

  /** A friendly heading for the viewed date (Today / Yesterday / weekday). */
  readonly dateHeading = computed(() => {
    const iso = this.store.date();
    const d = new Date(iso + 'T00:00:00');
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const diff = Math.round((d.getTime() - today.getTime()) / 86_400_000);
    if (diff === 0) return 'Today';
    if (diff === -1) return 'Yesterday';
    if (diff === 1) return 'Tomorrow';
    return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  });

  /** True before any data exists for the OWN tracker and no goal is set — show the setup prompt. */
  readonly needsSetup = computed(() => {
    const day = this.store.day();
    if (!day || day.readOnly) return false;
    const p = day.profile;
    const empty = day.foods.length === 0 && day.exercises.length === 0;
    return empty && !p.dailyCalorieGoal && (!p.goal || p.goal === 'Maintain') && !p.weightKg && !p.shareWithContacts;
  });

  // ---- macro helpers ----
  foodsFor(meal: Meal): FoodEntryDto[] {
    return this.store.day()?.foods.filter(f => f.meal === meal) ?? [];
  }

  caloriesFor(meal: Meal): number {
    return this.foodsFor(meal).reduce((s, f) => s + f.calories, 0);
  }

  /** Width % for a macro bar against its (optional) target; falls back to a soft scale when no target. */
  macroPct(value: number, target?: number): number {
    if (target && target > 0) return Math.min(100, (value / target) * 100);
    // No target: scale against a nominal 200 g so the bar still reads as "more/less".
    return Math.min(100, (value / 200) * 100);
  }

  // ---- shared view ----
  get viewingUser(): SharedUserDto | null {
    const email = this.store.viewUser();
    if (!email) return null;
    return this.store.shared().find(s => s.email === email) ?? { email, name: email };
  }

  viewSelf(): void { void this.store.viewUserTracker(null); }
  viewOther(email: string): void { void this.store.viewUserTracker(email); }

  // ---- dialogs ----
  openAddFood(meal: Meal): void {
    if (this.store.readOnly()) return;
    const data: AddFoodData = { date: this.store.date(), meal };
    this.dialog.open(AddFoodDialog, { data, width: '500px', maxWidth: '95vw', autoFocus: false })
      .afterClosed().subscribe((req: AddFoodRequest | undefined) => {
        if (!req) return;
        this.store.addFood(req)
          .then(() => this.snack.open(`Added ${req.description}`, 'OK', { duration: 2000 }))
          .catch(() => this.snack.open('Could not add food', 'Dismiss', { duration: 4000 }));
      });
  }

  openAddExercise(): void {
    if (this.store.readOnly()) return;
    const p = this.store.profile();
    const data: AddExerciseData = {
      date: this.store.date(),
      goal: p?.goal ?? '',
      hasWeight: (p?.weightKg ?? 0) > 0,
    };
    this.dialog.open(AddExerciseDialog, { data, width: '480px', maxWidth: '95vw', autoFocus: false })
      .afterClosed().subscribe((req: AddExerciseRequest | undefined) => {
        if (!req) return;
        this.store.addExercise(req)
          .then(() => this.snack.open('Exercise logged', 'OK', { duration: 2000 }))
          .catch(() => this.snack.open('Could not log exercise', 'Dismiss', { duration: 4000 }));
      });
  }

  openProfile(): void {
    if (this.store.readOnly()) return;
    const profile: TrackerProfileDto = this.store.profile()
      ?? { goal: 'Maintain', shareWithContacts: false };
    const data: ProfileData = { profile };
    this.dialog.open(ProfileDialog, { data, width: '460px', maxWidth: '95vw', autoFocus: false })
      .afterClosed().subscribe((req: TrackerProfileDto | undefined) => {
        if (!req) return;
        this.store.saveProfile(req)
          .then(() => this.snack.open('Goals saved', 'OK', { duration: 2000 }))
          .catch(() => this.snack.open('Could not save goals', 'Dismiss', { duration: 4000 }));
      });
  }

  removeFood(f: FoodEntryDto): void {
    if (this.store.readOnly()) return;
    this.store.deleteFood(f.id)
      .then(() => this.statusMsg.set(`Removed ${f.description}`))
      .catch(() => this.snack.open('Could not remove entry', 'Dismiss', { duration: 4000 }));
  }

  removeExercise(e: ExerciseEntryDto): void {
    if (this.store.readOnly()) return;
    this.store.deleteExercise(e.id)
      .then(() => this.statusMsg.set(`Removed ${e.name}`))
      .catch(() => this.snack.open('Could not remove entry', 'Dismiss', { duration: 4000 }));
  }

  /** Two-letter initials for the shared-user avatar fallback. */
  initials(u: { name?: string; email: string }): string {
    const parts = (u.name || u.email).split(/[\s@.]+/).filter(Boolean);
    return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || 'U';
  }
}
