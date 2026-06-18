import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { Api } from './api';
import {
  AddExerciseRequest, AddFoodRequest, SharedUserDto, TrackerDayDto, TrackerProfileDto,
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
   * Whose tracker is being viewed: null = the caller's own (editable), otherwise another user's email
   * (read-only). Pairs with {@link readOnly} which the server confirms on each load.
   */
  readonly viewUser = signal<string | null>(null);

  /** The loaded day, or null before the first load. */
  readonly day = signal<TrackerDayDto | null>(null);

  /** People whose tracker the caller may view read-only (for the shared-view selector). */
  readonly shared = signal<SharedUserDto[]>([]);

  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  /** True while viewing someone else's tracker (no add/delete controls). */
  readonly readOnly = computed(() => this.day()?.readOnly ?? this.viewUser() !== null);

  /** The active profile/goals for the loaded day. */
  readonly profile = computed<TrackerProfileDto | null>(() => this.day()?.profile ?? null);

  /** Load (or reload) the current day for the current date + view target. */
  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const day = await firstValueFrom(this.api.trackerDay(this.date(), this.viewUser() ?? undefined));
      this.day.set(day);
    } catch (e: unknown) {
      this.error.set(this.messageOf(e));
    } finally {
      this.loading.set(false);
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

  /** Switch the view target (null = own tracker) and reload. */
  async viewUserTracker(email: string | null): Promise<void> {
    this.viewUser.set(email);
    await this.load();
  }

  /** Log a food entry, then refresh the day. The caller supplies the date-bound request. */
  async addFood(body: AddFoodRequest): Promise<void> {
    await firstValueFrom(this.api.addFood(body));
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

  /** Persist the caller's profile/goals, then refresh the day so totals/targets reflect the change. */
  async saveProfile(body: TrackerProfileDto): Promise<TrackerProfileDto> {
    const saved = await firstValueFrom(this.api.saveTrackerProfile(body));
    await this.load();
    return saved;
  }

  private messageOf(e: unknown): string {
    const err = e as { error?: { detail?: string; title?: string }; message?: string };
    return err?.error?.detail || err?.error?.title || err?.message || 'Failed to load tracker.';
  }
}
