import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { Api } from './api';
import {
  AddCoffeeRequest, AddExerciseRequest, AddFoodRequest, UpdateFoodRequest, AddHydrationRequest, AddSleepRequest, AddSupplementRequest, CoffeeEntryDto, HydrationEntryDto, LogWeightRequest,
  SharedUserDto, SleepEntryDto, TrackerDayDto, TrackerProfileDto, UpsertActivityRequest, WeightPointDto, WeightStatsDto,
} from './models';

/** Format a Date as a local `YYYY-MM-DD` string (matches the dashboard/fleet date convention). */
export function toLocalDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * The single source of truth for the food & fitness tracker page. Owns the currently-viewed day
 * (date + optional "view someone else" target), loads {@link TrackerDayDto} from the API, and exposes
 * coarse add/delete/profile actions that mutate the server then refresh the day.
 *
 * Phase 2-CORE: this is the shared foundation. The full dashboard component (next phase) injects this
 * service and renders from its signals; it never calls {@link Api} directly for tracker data.
 */
@Injectable({ providedIn: 'root' })
export class TrackerStore {
  private api = inject(Api);

  /** The day being viewed, as a local `YYYY-MM-DD` string. Defaults to today. */
  readonly date = signal<string>(toLocalDate(new Date()));

  /**
   * Whose tracker is being viewed: null = the caller's own (editable), otherwise another user's AppUser
   * id (read-only). The client holds no other-user emails (email-privacy). Pairs with {@link readOnly}
   * which the server confirms on each load.
   */
  readonly viewUser = signal<number | null>(null);

  /** The loaded day, or null before the first load. */
  readonly day = signal<TrackerDayDto | null>(null);

  /** People whose tracker the caller may view read-only (for the shared-view selector). */
  readonly shared = signal<SharedUserDto[]>([]);

  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  /**
   * Monotonic request counter for {@link load}. Each load captures the current value before its await;
   * only the latest-issued load may mutate the visible signals, so a slow response for a superseded
   * date/view-user can never overwrite a freshly-loaded day (latest-wins).
   */
  private loadSeq = 0;

  /** True while viewing someone else's tracker (no add/delete controls). */
  readonly readOnly = computed(() => this.day()?.readOnly ?? this.viewUser() !== null);

  /** The active profile/goals for the loaded day. */
  readonly profile = computed<TrackerProfileDto | null>(() => this.day()?.profile ?? null);

  /** The day's hydration entries (oldest-first), or empty before the first load. */
  readonly hydration = computed<HydrationEntryDto[]>(() => this.day()?.hydration ?? []);

  /** The day's coffee entries (oldest-first), or empty before the first load. */
  readonly coffee = computed<CoffeeEntryDto[]>(() => this.day()?.coffee ?? []);

  /** The day's sleep entries (oldest-first), or empty. OWNER-ONLY (empty when viewing someone else). */
  readonly sleep = computed<SleepEntryDto[]>(() => this.day()?.sleep ?? []);

  /** Load (or reload) the current day for the current date + view target. */
  async load(): Promise<void> {
    const seq = ++this.loadSeq;
    this.loading.set(true);
    this.error.set(null);
    try {
      const day = await firstValueFrom(this.api.trackerDay(this.date(), this.viewUser() ?? undefined));
      // Latest-wins: a newer load has superseded this one; discard its result so it can't
      // overwrite the freshly-requested date/view-user (another person's day/PII).
      if (seq !== this.loadSeq) return;
      this.day.set(day);
    } catch (e: unknown) {
      if (seq !== this.loadSeq) return;
      this.error.set(this.messageOf(e));
    } finally {
      // Only the latest load clears the spinner; a stale load resolving first must not.
      if (seq === this.loadSeq) this.loading.set(false);
    }
  }

  /** Load the people whose trackers the caller may view (for the shared-view selector). */
  async loadShared(): Promise<void> {
    try {
      this.shared.set(await firstValueFrom(this.api.trackerShared()));
    } catch {
      this.shared.set([]);
    }
  }

  /** Switch to a specific local date and reload. */
  async setDate(date: string): Promise<void> {
    this.date.set(date);
    await this.load();
  }

  /** Step the viewed date by `days` (negative = earlier) and reload. */
  async shiftDate(days: number): Promise<void> {
    const d = new Date(this.date() + 'T00:00:00');
    d.setDate(d.getDate() + days);
    await this.setDate(toLocalDate(d));
  }

  /** Jump to today and reload. */
  async goToday(): Promise<void> {
    await this.setDate(toLocalDate(new Date()));
  }

  /** Switch the view target (null = own tracker, else the target's AppUser id) and reload. */
  async viewUserTracker(userId: number | null): Promise<void> {
    this.viewUser.set(userId);
    await this.load();
  }

  /** Log a food entry, then refresh the day. The caller supplies the date-bound request. */
  async addFood(body: AddFoodRequest): Promise<void> {
    await firstValueFrom(this.api.addFood(body));
    await this.load();
  }

  /**
   * Log a BATCH of food entries (the AI multi-item flows: photo / describe-a-meal), then refresh the
   * day EXACTLY ONCE — vs N serial POST+reload round trips, which flickered the rings and dragged on a
   * phone. Each item still hits the single `/food` endpoint, so the server-side "My foods" auto-save
   * applies to every committed item just like a manual log.
   *
   * Resilient to partial failure: each insert is independent (Promise.allSettled), so one bad row never
   * drops the others. Returns how many succeeded/failed so the caller can surface the real outcome
   * (e.g. "Added 4 of 5") instead of a wholesale "couldn't add" when most landed.
   */
  async addFoods(bodies: AddFoodRequest[]): Promise<{ added: number; failed: number }> {
    const results = await Promise.allSettled(bodies.map(b => firstValueFrom(this.api.addFood(b))));
    const added = results.filter(r => r.status === 'fulfilled').length;
    // Refresh once if anything landed (or if nothing did but we still want fresh state after errors).
    await this.load();
    return { added, failed: results.length - added };
  }

  /**
   * Edit a logged food entry, then refresh the day (mirrors `addFood`: mutate then full reload, so the
   * day roll-up reflects the edit). The server recomputes macros for a priced row from the new quantity;
   * a manual row takes the sent description/macros directly. Owner-only (a read-only view never calls this).
   */
  async updateFood(id: number, body: UpdateFoodRequest): Promise<void> {
    await firstValueFrom(this.api.updateFood(id, body));
    await this.load();
  }

  /** Delete a logged food entry, then refresh the day. */
  async deleteFood(id: number): Promise<void> {
    await firstValueFrom(this.api.deleteFood(id));
    await this.load();
  }

  /** Log an exercise entry, then refresh the day. */
  async addExercise(body: AddExerciseRequest): Promise<void> {
    await firstValueFrom(this.api.addExercise(body));
    await this.load();
  }

  /** Delete a logged exercise entry, then refresh the day. */
  async deleteExercise(id: number): Promise<void> {
    await firstValueFrom(this.api.deleteExercise(id));
    await this.load();
  }

  /** Log a drink toward the day's hydration goal, then refresh the day. */
  async addHydration(body: AddHydrationRequest): Promise<void> {
    await firstValueFrom(this.api.addHydration(body));
    await this.load();
  }

  /** Delete a logged hydration entry, then refresh the day. */
  async deleteHydration(id: number): Promise<void> {
    await firstValueFrom(this.api.deleteHydration(id));
    await this.load();
  }

  /** Log coffee toward the day's coffee cap, then refresh the day. */
  async addCoffee(body: AddCoffeeRequest): Promise<void> {
    await firstValueFrom(this.api.addCoffee(body));
    await this.load();
  }

  /** Delete a logged coffee entry, then refresh the day. */
  async deleteCoffee(id: number): Promise<void> {
    await firstValueFrom(this.api.deleteCoffee(id));
    await this.load();
  }

  /** Log a supplement onto the day (macros sum into the day total), then refresh the day. */
  async addSupplement(body: AddSupplementRequest): Promise<void> {
    await firstValueFrom(this.api.addSupplement(body));
    await this.load();
  }

  /** Delete a logged supplement entry, then refresh the day. */
  async deleteSupplement(id: number): Promise<void> {
    await firstValueFrom(this.api.deleteSupplement(id));
    await this.load();
  }

  /** Log a night of sleep (the wake date), then refresh the day so totals/averages update. */
  async addSleep(body: AddSleepRequest): Promise<void> {
    await firstValueFrom(this.api.addSleep(body));
    await this.load();
  }

  /** Delete a logged sleep entry, then refresh the day. */
  async deleteSleep(id: number): Promise<void> {
    await firstValueFrom(this.api.deleteSleep(id));
    await this.load();
  }

  /**
   * Upsert the caller's watch stats (steps/distance/active calories + calorie mode) for a date, then
   * refresh the day so the resolved burn (calorie ring / burned figure) updates.
   */
  async upsertActivity(body: UpsertActivityRequest): Promise<void> {
    await firstValueFrom(this.api.upsertActivity(body));
    await this.load();
  }

  /** Clear the caller's watch stats for a date, then refresh the day. */
  async clearActivity(date: string): Promise<void> {
    await firstValueFrom(this.api.clearActivity(date));
    await this.load();
  }

  /** Persist the caller's profile/goals, then refresh the day so totals/targets reflect the change. */
  async saveProfile(body: TrackerProfileDto): Promise<TrackerProfileDto> {
    const saved = await firstValueFrom(this.api.saveTrackerProfile(body));
    await this.load();
    return saved;
  }

  /** Log (upsert) the caller's weight for a date, then refresh the day so current weight + stats update. */
  async logWeight(body: LogWeightRequest): Promise<TrackerProfileDto> {
    const saved = await firstValueFrom(this.api.logWeight(body));
    await this.load();
    return saved;
  }

  /** Fetch the caller's OWN weight history (oldest-first) for the trend chart. */
  async weightHistory(days = 90): Promise<WeightPointDto[]> {
    return firstValueFrom(this.api.weightHistory(days));
  }

  /** Fetch the caller's OWN per-slot weight statistics (averages, latest, morning→evening delta). */
  async weightStats(days = 90): Promise<WeightStatsDto> {
    return firstValueFrom(this.api.weightStats(days));
  }

  private messageOf(e: unknown): string {
    const err = e as { error?: { detail?: string; title?: string }; message?: string };
    return err?.error?.detail || err?.error?.title || err?.message || 'Failed to load tracker.';
  }
}
