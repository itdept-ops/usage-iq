import { Injectable, Signal, computed, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { MatSnackBar } from '@angular/material/snack-bar';

import { Api } from '../../../core/api';
import { TrackerStore } from '../../../core/tracker-store';
import {
  AddCoffeeRequest, AddExerciseRequest, AddFoodRequest, AddHydrationRequest, AddSupplementRequest,
  CoffeeEntryDto, ExerciseEntryDto, FoodEntryDto, HydrationEntryDto, LogWeightRequest,
  SupplementEntryDto, TrackerDayDto, TrackerProfileDto,
} from '../../../core/models';

/**
 * THE perf fix. A thin optimistic wrapper over {@link TrackerStore}'s mutators that closes the
 * mutate-then-await-load() latency gap: every mutation patches the local `day()` signal FIRST (so the
 * hero ring + counts move sub-second), THEN fires the API, reconciles the provisional row with the
 * server's real entity on settle, and on FAILURE rolls back and offers a MatSnackBar undo.
 *
 * It deliberately bypasses the store's coarse add/delete (which each `await this.load()` and flicker the
 * rings) and talks to {@link Api} directly, recomputing the day's derived totals locally so the patched
 * `day()` stays fully consistent without a round-trip. The store's `load()` is kept ONLY as a failure
 * fallback (re-sync to the authoritative server state).
 *
 * Read surface: the wrapper re-exposes the store's read signals so a component can inject ONLY this
 * service. Write surface mirrors the store mutators the cards/sheets need.
 *
 * PUBLIC CONTRACT (component agents depend on these signatures VERBATIM):
 *   reads (signals):
 *     day:        Signal<TrackerDayDto | null>
 *     profile:    Signal<TrackerProfileDto | null>
 *     loading:    Signal<boolean>
 *     readOnly:   Signal<boolean>
 *     date:       Signal<string>           // YYYY-MM-DD
 *     imperial:   Signal<boolean>          // derived from profile.unitSystem
 *   writes (all return Promise<void>; optimistic + undo built in):
 *     addFood(body: AddFoodRequest): Promise<void>
 *     addFoods(bodies: AddFoodRequest[]): Promise<{ added: number; failed: number }>
 *     deleteFood(id: number): Promise<void>
 *     addHydration(body: AddHydrationRequest): Promise<void>
 *     deleteHydration(id: number): Promise<void>
 *     addCoffee(body: AddCoffeeRequest): Promise<void>
 *     deleteCoffee(id: number): Promise<void>
 *     addSupplement(body: AddSupplementRequest): Promise<void>
 *     deleteSupplement(id: number): Promise<void>
 *     addExercise(body: AddExerciseRequest): Promise<void>
 *     deleteExercise(id: number): Promise<void>
 *     logWeight(body: LogWeightRequest): Promise<TrackerProfileDto>
 *
 * Provide this at the route/page level (it injects the root TrackerStore + Api + MatSnackBar).
 */
@Injectable()
export class OptimisticTracker {
  private store = inject(TrackerStore);
  private api = inject(Api);
  private snack = inject(MatSnackBar);

  // ---- read signals (re-exposed from the store) ----
  readonly day: Signal<TrackerDayDto | null> = this.store.day;
  readonly profile: Signal<TrackerProfileDto | null> = this.store.profile;
  readonly loading: Signal<boolean> = this.store.loading;
  readonly readOnly: Signal<boolean> = this.store.readOnly;
  readonly date: Signal<string> = this.store.date;
  /** True when the active profile prefers imperial units (kg/ml/m still travel the wire). */
  readonly imperial = computed(() => this.store.profile()?.unitSystem === 'Imperial');

  /** Monotonic source of provisional ids — negative so they never collide with real server ids. */
  private tempSeq = -1;

  // ── FOOD ────────────────────────────────────────────────────────────────────

  async addFood(body: AddFoodRequest): Promise<void> {
    const tempId = this.tempSeq--;
    const provisional: FoodEntryDto = {
      id: tempId, meal: body.meal as FoodEntryDto['meal'], fdcId: body.fdcId, description: body.description,
      brand: body.brand, quantity: body.quantity, servingDesc: body.servingDesc,
      calories: body.calories, proteinG: body.proteinG, carbG: body.carbG, fatG: body.fatG,
    };
    this.patch(d => this.recompute({ ...d, foods: [...d.foods, provisional] }));
    try {
      const real = await firstValueFrom(this.api.addFood(body));
      this.patch(d => this.recompute({
        ...d, foods: d.foods.map(f => (f.id === tempId ? real : f)),
      }));
    } catch {
      this.rollback(d => this.recompute({ ...d, foods: d.foods.filter(f => f.id !== tempId) }),
        'Couldn’t add food', () => this.addFood(body));
    }
  }

  /** Batch food add (AI photo / describe-a-meal). Patches all provisionally, then commits each. */
  async addFoods(bodies: AddFoodRequest[]): Promise<{ added: number; failed: number }> {
    const temps = bodies.map(b => {
      const id = this.tempSeq--;
      return {
        id, body: b, dto: {
          id, meal: b.meal as FoodEntryDto['meal'], fdcId: b.fdcId, description: b.description, brand: b.brand,
          quantity: b.quantity, servingDesc: b.servingDesc, calories: b.calories, proteinG: b.proteinG,
          carbG: b.carbG, fatG: b.fatG,
        } as FoodEntryDto,
      };
    });
    this.patch(d => this.recompute({ ...d, foods: [...d.foods, ...temps.map(t => t.dto)] }));
    const results = await Promise.allSettled(temps.map(t => firstValueFrom(this.api.addFood(t.body))));
    let added = 0;
    results.forEach((r, i) => {
      const tempId = temps[i].id;
      if (r.status === 'fulfilled') {
        added++;
        this.patch(d => this.recompute({ ...d, foods: d.foods.map(f => (f.id === tempId ? r.value : f)) }));
      } else {
        this.patch(d => this.recompute({ ...d, foods: d.foods.filter(f => f.id !== tempId) }));
      }
    });
    const failed = results.length - added;
    if (failed > 0) this.snack.open(`Added ${added} of ${results.length}`, 'OK', { duration: 4000, politeness: 'polite' });
    return { added, failed };
  }

  async deleteFood(id: number): Promise<void> {
    const removed = this.day()?.foods.find(f => f.id === id);
    if (!removed) return;
    this.patch(d => this.recompute({ ...d, foods: d.foods.filter(f => f.id !== id) }));
    this.commitDelete(
      () => firstValueFrom(this.api.deleteFood(id)),
      d => this.recompute({ ...d, foods: [...d.foods, removed].sort((a, b) => a.id - b.id) }),
      `Deleted ${removed.description}`,
    );
  }

  // ── HYDRATION ────────────────────────────────────────────────────────────────

  async addHydration(body: AddHydrationRequest): Promise<void> {
    const tempId = this.tempSeq--;
    const provisional: HydrationEntryDto = {
      id: tempId, amountMl: body.amountMl, label: body.label, createdUtc: new Date().toISOString(),
    };
    this.patch(d => this.recompute({ ...d, hydration: [...d.hydration, provisional] }));
    try {
      const real = await firstValueFrom(this.api.addHydration(body));
      this.patch(d => this.recompute({ ...d, hydration: d.hydration.map(h => (h.id === tempId ? real : h)) }));
    } catch {
      this.rollback(d => this.recompute({ ...d, hydration: d.hydration.filter(h => h.id !== tempId) }),
        'Couldn’t log water', () => this.addHydration(body));
    }
  }

  async deleteHydration(id: number): Promise<void> {
    const removed = this.day()?.hydration.find(h => h.id === id);
    if (!removed) return;
    this.patch(d => this.recompute({ ...d, hydration: d.hydration.filter(h => h.id !== id) }));
    this.commitDelete(
      () => firstValueFrom(this.api.deleteHydration(id)),
      d => this.recompute({ ...d, hydration: [...d.hydration, removed].sort((a, b) => a.id - b.id) }),
      'Deleted drink',
    );
  }

  // ── COFFEE ───────────────────────────────────────────────────────────────────

  async addCoffee(body: AddCoffeeRequest): Promise<void> {
    const tempId = this.tempSeq--;
    const provisional: CoffeeEntryDto = {
      id: tempId, cups: body.cups, caffeineMg: body.caffeineMg, label: body.label, createdUtc: new Date().toISOString(),
    };
    this.patch(d => this.recompute({ ...d, coffee: [...d.coffee, provisional] }));
    try {
      const real = await firstValueFrom(this.api.addCoffee(body));
      this.patch(d => this.recompute({ ...d, coffee: d.coffee.map(c => (c.id === tempId ? real : c)) }));
    } catch {
      this.rollback(d => this.recompute({ ...d, coffee: d.coffee.filter(c => c.id !== tempId) }),
        'Couldn’t log coffee', () => this.addCoffee(body));
    }
  }

  async deleteCoffee(id: number): Promise<void> {
    const removed = this.day()?.coffee.find(c => c.id === id);
    if (!removed) return;
    this.patch(d => this.recompute({ ...d, coffee: d.coffee.filter(c => c.id !== id) }));
    this.commitDelete(
      () => firstValueFrom(this.api.deleteCoffee(id)),
      d => this.recompute({ ...d, coffee: [...d.coffee, removed].sort((a, b) => a.id - b.id) }),
      'Deleted coffee',
    );
  }

  // ── SUPPLEMENT ───────────────────────────────────────────────────────────────

  async addSupplement(body: AddSupplementRequest): Promise<void> {
    const tempId = this.tempSeq--;
    const provisional: SupplementEntryDto = {
      id: tempId, name: body.name, dose: body.dose, kind: body.kind ?? 'supplement',
      calories: body.calories ?? 0, proteinG: body.protein ?? 0, carbG: body.carb ?? 0, fatG: body.fat ?? 0,
      createdUtc: new Date().toISOString(),
    } as SupplementEntryDto;
    this.patch(d => this.recompute({ ...d, supplements: [...d.supplements, provisional] }));
    try {
      const real = await firstValueFrom(this.api.addSupplement(body));
      this.patch(d => this.recompute({ ...d, supplements: d.supplements.map(s => (s.id === tempId ? real : s)) }));
    } catch {
      this.rollback(d => this.recompute({ ...d, supplements: d.supplements.filter(s => s.id !== tempId) }),
        'Couldn’t add supplement', () => this.addSupplement(body));
    }
  }

  async deleteSupplement(id: number): Promise<void> {
    const removed = this.day()?.supplements.find(s => s.id === id);
    if (!removed) return;
    this.patch(d => this.recompute({ ...d, supplements: d.supplements.filter(s => s.id !== id) }));
    this.commitDelete(
      () => firstValueFrom(this.api.deleteSupplement(id)),
      d => this.recompute({ ...d, supplements: [...d.supplements, removed].sort((a, b) => a.id - b.id) }),
      `Deleted ${removed.name}`,
    );
  }

  // ── EXERCISE ─────────────────────────────────────────────────────────────────

  async addExercise(body: AddExerciseRequest): Promise<void> {
    const tempId = this.tempSeq--;
    const provisional: ExerciseEntryDto = {
      id: tempId, exerciseId: body.exerciseId, name: body.name ?? 'Exercise',
      durationMin: body.durationMin, caloriesBurned: body.caloriesBurned ?? 0,
    };
    this.patch(d => this.recompute({ ...d, exercises: [...d.exercises, provisional] }));
    try {
      const real = await firstValueFrom(this.api.addExercise(body));
      this.patch(d => this.recompute({ ...d, exercises: d.exercises.map(e => (e.id === tempId ? real : e)) }));
    } catch {
      this.rollback(d => this.recompute({ ...d, exercises: d.exercises.filter(e => e.id !== tempId) }),
        'Couldn’t add exercise', () => this.addExercise(body));
    }
  }

  async deleteExercise(id: number): Promise<void> {
    const removed = this.day()?.exercises.find(e => e.id === id);
    if (!removed) return;
    this.patch(d => this.recompute({ ...d, exercises: d.exercises.filter(e => e.id !== id) }));
    this.commitDelete(
      () => firstValueFrom(this.api.deleteExercise(id)),
      d => this.recompute({ ...d, exercises: [...d.exercises, removed].sort((a, b) => a.id - b.id) }),
      `Deleted ${removed.name}`,
    );
  }

  // ── WEIGHT ───────────────────────────────────────────────────────────────────

  /**
   * Log a weigh-in. Weight feeds the profile + sparkline (server-derived stats), so this one DOES await
   * the server (returns the updated profile) and patches the profile.weightKg into the day immediately;
   * the weight card pulls fresh history itself. Rolls back via the store's load() on failure.
   */
  async logWeight(body: LogWeightRequest): Promise<TrackerProfileDto> {
    const prev = this.day()?.profile?.weightKg;
    this.patch(d => (d.profile ? { ...d, profile: { ...d.profile, weightKg: body.weightKg } } : d));
    try {
      const saved = await firstValueFrom(this.api.logWeight(body));
      this.patch(d => (d.profile ? { ...d, profile: { ...d.profile, ...saved } } : d));
      return saved;
    } catch {
      this.patch(d => (d.profile ? { ...d, profile: { ...d.profile, weightKg: prev } } : d));
      this.snack.open('Couldn’t log weight', 'Retry', { duration: 5000, politeness: 'polite' })
        .onAction().subscribe(() => void this.logWeight(body));
      throw new Error('logWeight failed');
    }
  }

  // ── internals ────────────────────────────────────────────────────────────────

  /** Apply a pure transform to the current day() signal (no-op when no day is loaded). */
  private patch(fn: (d: TrackerDayDto) => TrackerDayDto): void {
    const d = this.store.day();
    if (d) this.store.day.set(fn(d));
  }

  /**
   * Roll a failed ADD back to a prior state, then offer a Retry. (Adds use "Retry" rather than "Undo".)
   */
  private rollback(undo: (d: TrackerDayDto) => TrackerDayDto, message: string, retry: () => void): void {
    this.patch(undo);
    this.snack.open(message, 'Retry', { duration: 5000, politeness: 'polite' })
      .onAction().subscribe(() => retry());
  }

  /**
   * Commit an optimistic DELETE: the row is already gone locally. Fire the API; show a 5s Undo snackbar
   * that restores the row (and re-runs the original mutation chain) if tapped before the server confirms.
   * If the API itself fails, restore the row and re-sync from the server as a safety net.
   */
  private commitDelete(
    fire: () => Promise<unknown>,
    restore: (d: TrackerDayDto) => TrackerDayDto,
    message: string,
  ): void {
    let undone = false;
    const ref = this.snack.open(message, 'Undo', { duration: 5000, politeness: 'polite' });
    ref.onAction().subscribe(() => {
      undone = true;
      this.patch(restore); // bring the row back; the network delete is deferred + will be skipped below
    });
    // DEFER the network delete until the undo window closes. The row is already removed locally
    // (optimistic); if the user hits Undo in time we restore it and never fire the delete, so the row
    // was genuinely never touched server-side. Only when the snackbar dismisses without an undo do we
    // commit the real delete; on failure we roll the row back and re-sync.
    ref.afterDismissed().subscribe(() => {
      if (undone) return;
      fire().catch(() => {
        this.patch(restore);
        this.snack.open('Couldn’t delete', '', { duration: 3000, politeness: 'polite' });
        void this.store.load();
      });
    });
  }

  /**
   * Recompute the day's derived roll-ups after a local entry mutation so the patched day() is fully
   * self-consistent (hero ring, remaining, hydrationMl, coffeeCups, caloriesOut) WITHOUT a server round
   * trip. Mirrors the backend's summation: caloriesIn = foods + supplements; caloriesOut combines logged
   * exercise with the watch active-calories per calorieMode; net = in - out.
   */
  private recompute(d: TrackerDayDto): TrackerDayDto {
    const sum = <T>(xs: T[], pick: (x: T) => number) => xs.reduce((a, x) => a + (pick(x) || 0), 0);

    const foodCal = sum(d.foods, f => f.calories);
    const foodPro = sum(d.foods, f => f.proteinG);
    const foodCarb = sum(d.foods, f => f.carbG);
    const foodFat = sum(d.foods, f => f.fatG);

    const supCal = sum(d.supplements, s => s.calories);
    const supPro = sum(d.supplements, s => s.proteinG);
    const supCarb = sum(d.supplements, s => s.carbG);
    const supFat = sum(d.supplements, s => s.fatG);

    const caloriesIn = foodCal + supCal;
    const proteinG = foodPro + supPro;
    const carbG = foodCarb + supCarb;
    const fatG = foodFat + supFat;

    const exerciseCalories = sum(d.exercises, e => e.caloriesBurned);
    // Resolve burn with the watch row per calorieMode ('override' => active replaces exercise sum).
    const active = d.activity?.activeCalories ?? null;
    const mode = d.activity?.calorieMode ?? null;
    const caloriesOut = active != null
      ? (mode === 'override' ? active : exerciseCalories + active)
      : exerciseCalories;

    const hydrationMl = sum(d.hydration, h => h.amountMl);
    const coffeeCups = sum(d.coffee, c => c.cups);
    const caffeineMg = sum(d.coffee, c => c.caffeineMg ?? 0);

    const calorieGoal = d.calorieGoal;
    const remaining = calorieGoal != null ? calorieGoal - caloriesIn : d.remaining;

    return {
      ...d,
      caloriesIn, proteinG, carbG, fatG,
      supplementCalories: supCal, supplementProteinG: supPro, supplementCarbG: supCarb, supplementFatG: supFat,
      exerciseCalories, caloriesOut, netCalories: caloriesIn - caloriesOut,
      hydrationMl, coffeeCups, caffeineMg,
      remaining,
    };
  }
}
