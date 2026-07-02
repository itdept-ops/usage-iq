import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { Api } from './api';
import {
  CheatDaysRequest, CreateHardTaskRequest, HardChallengeDto, HardCoachDto, HardDayDto,
  HardLeaderboardRowDto, HardSharedPersonDto, HardTaskDto, StartChallengeRequest,
  UpdateHardTaskRequest, UpsertHardDayRequest,
} from './models';
import { toLocalDate } from './tracker-store';

/**
 * The single source of truth for the 75 Hard challenge page. Mirrors {@link TrackerStore}: it owns the
 * currently-viewed day (a date + an optional "view someone else" target), loads the active
 * {@link HardChallengeDto} from the API, and exposes coarse start / upsert-day / cheat-day actions that
 * mutate the server then refresh the challenge.
 *
 * The auto-scored task bits (diet/water/workouts) come straight off the server, recomputed live from the
 * tracker on each read — the store never computes them. The client holds no other-user emails
 * (email-privacy): a viewer is identified by their AppUser id and the server confirms {@link readOnly}.
 */
@Injectable({ providedIn: 'root' })
export class ChallengeStore {
  private api = inject(Api);

  /** The day being viewed inside the grid, as a local `YYYY-MM-DD` string. Defaults to today. */
  readonly date = signal<string>(toLocalDate(new Date()));

  /**
   * Whose challenge is being viewed: null = the caller's own (editable), otherwise another user's
   * AppUser id (read-only). Pairs with {@link readOnly}, which the server confirms on each load.
   */
  readonly viewUser = signal<number | null>(null);

  /** The loaded challenge, or null when there's no active challenge / before the first load. */
  readonly challenge = signal<HardChallengeDto | null>(null);

  /** People whose challenge the caller may view read-only (for the shared-view selector). */
  readonly shared = signal<HardSharedPersonDto[]>([]);

  /** The points leaderboard (the caller + sharing contacts), ranked by totalPoints desc — names only. */
  readonly leaderboard = signal<HardLeaderboardRowDto[]>([]);

  /** The AI coach recap (always present once loaded; floored to a deterministic plain recap when AI is absent). */
  readonly coach = signal<HardCoachDto | null>(null);
  readonly coachLoading = signal(false);

  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  /**
   * Monotonic request counter for {@link load}. Each load captures the current value before its await;
   * only the latest-issued load may mutate the visible signals, so a slow response for a superseded
   * view-user can never overwrite a freshly-loaded challenge (latest-wins).
   */
  private loadSeq = 0;

  /** True while viewing someone else's challenge (no edit controls). */
  readonly readOnly = computed(() => this.challenge()?.readOnly ?? this.viewUser() !== null);

  /** True once a load has completed (so the empty state can distinguish "no challenge" from "not yet loaded"). */
  readonly loaded = signal(false);

  /** The day-grid rows for the loaded challenge (oldest-first), or empty. */
  readonly days = computed<HardDayDto[]>(() => this.challenge()?.days ?? []);

  /** The grid row for the currently-viewed {@link date}, or null. */
  readonly selectedDay = computed<HardDayDto | null>(() => {
    const iso = this.date();
    return this.days().find(d => d.date === iso) ?? null;
  });

  /** The configurable task set for the loaded challenge (ordered), or empty. */
  readonly tasks = computed<HardTaskDto[]>(() => this.challenge()?.tasks ?? []);

  /** Load (or reload) the active challenge for the current view target. */
  async load(): Promise<void> {
    const seq = ++this.loadSeq;
    this.loading.set(true);
    this.error.set(null);
    try {
      const c = await firstValueFrom(this.api.challenge(this.viewUser() ?? undefined));
      // Latest-wins: a newer load has superseded this one; discard its result so it can't
      // overwrite the freshly-requested view-user (another person's challenge/PII).
      if (seq !== this.loadSeq) return;
      this.challenge.set(c);
    } catch (e: unknown) {
      if (seq !== this.loadSeq) return;
      this.error.set(this.messageOf(e));
      this.challenge.set(null);
    } finally {
      // Only the latest load flips loaded / clears the spinner; a stale load resolving first must not.
      if (seq === this.loadSeq) {
        this.loaded.set(true);
        this.loading.set(false);
      }
    }
  }

  /** Load the people whose challenges the caller may view (for the shared-view selector). */
  async loadShared(): Promise<void> {
    try {
      this.shared.set((await firstValueFrom(this.api.challengeShared())) ?? []);
    } catch {
      this.shared.set([]);
    }
  }

  /** Switch the selected grid day to a specific local date (no reload — the grid is already loaded). */
  setDate(date: string): void {
    this.date.set(date);
  }

  /** Step the selected grid day by `days` (negative = earlier), clamped to the loaded window. */
  shiftDate(days: number): void {
    const d = new Date(this.date() + 'T00:00:00');
    d.setDate(d.getDate() + days);
    this.setDate(toLocalDate(d));
  }

  /** Jump the selected grid day to today. */
  goToday(): void {
    this.setDate(toLocalDate(new Date()));
  }

  /** Switch the view target (null = own challenge, else the target's AppUser id) and reload. */
  async viewUserTracker(userId: number | null): Promise<void> {
    this.viewUser.set(userId);
    await this.load();
  }

  /** Start a new challenge (owner), then refresh. The caller supplies an optional start date. */
  async start(body: StartChallengeRequest = {}): Promise<void> {
    const c = await firstValueFrom(this.api.startChallenge(body));
    this.challenge.set(c);
  }

  /**
   * Upsert the manual portion of a day (owner), then refresh the whole challenge so the streak +
   * completed-day aggregates re-derive. Returns the rebuilt day for an optimistic snackbar.
   */
  async upsertDay(body: UpsertHardDayRequest): Promise<HardDayDto> {
    const day = await firstValueFrom(this.api.upsertChallengeDay(body));
    await this.load();
    return day;
  }

  /** Pre-declare / clear future cheat dates (owner). Returns the rebuilt challenge straight from the API. */
  async setCheatDays(body: CheatDaysRequest): Promise<void> {
    const c = await firstValueFrom(this.api.setChallengeCheatDays(body));
    this.challenge.set(c);
  }

  // ---- task config (owner) ----

  /** Add a CUSTOM manual task, then reload so day points + the grid re-derive against the new set. */
  async createTask(body: CreateHardTaskRequest): Promise<void> {
    await firstValueFrom(this.api.createChallengeTask(body));
    await this.load();
  }

  /** Edit a task's target/points/enable/etc, then reload so all day scores re-derive. */
  async updateTask(id: number, body: UpdateHardTaskRequest): Promise<void> {
    await firstValueFrom(this.api.updateChallengeTask(id, body));
    await this.load();
  }

  /** Delete a CUSTOM task (auto tasks can only be disabled), then reload. */
  async deleteTask(id: number): Promise<void> {
    await firstValueFrom(this.api.deleteChallengeTask(id));
    await this.load();
  }

  // ---- leaderboard + coach ----

  /** Load the points leaderboard (caller + sharing contacts). Silent on failure (empty). */
  async loadLeaderboard(): Promise<void> {
    try {
      this.leaderboard.set((await firstValueFrom(this.api.challengeLeaderboard())) ?? []);
    } catch {
      this.leaderboard.set([]);
    }
  }

  /**
   * Load the AI coach recap (own challenge only). ALWAYS resolves to a recap — the server floors to a
   * deterministic plain narrative (fellBackToPlain) when tracker.ai/Gemini is absent. Silent on failure.
   */
  async loadCoach(): Promise<void> {
    this.coachLoading.set(true);
    try {
      this.coach.set(await firstValueFrom(this.api.challengeCoach()));
    } catch {
      this.coach.set(null);
    } finally {
      this.coachLoading.set(false);
    }
  }

  private messageOf(e: unknown): string {
    const err = e as { error?: { detail?: string; title?: string; message?: string }; message?: string };
    return err?.error?.detail || err?.error?.title || err?.error?.message || err?.message
      || 'Failed to load your challenge.';
  }
}
