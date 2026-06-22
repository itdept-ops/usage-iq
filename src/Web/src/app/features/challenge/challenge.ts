import { Component, DestroyRef, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { RouterLink } from '@angular/router';

import { ChallengeStore } from '../../core/challenge-store';
import { AuthService } from '../../core/auth';
import {
  CreateHardTaskRequest, HardDayDto, HardDayTaskDto, HardSharedPersonDto, HardTaskDto,
  PERM, UpdateHardTaskRequest, UpsertHardDayRequest,
} from '../../core/models';

/** Max future cheat days the backend accepts (kept in sync with HardChallengeEndpoints.MaxCheatDays). */
const MAX_CHEAT_DAYS = 10;

/** The icon shown for each auto-source / a generic one for manual + custom tasks. */
const AUTO_ICON: Record<string, string> = {
  Diet: 'restaurant',
  Water: 'local_drink',
  Workout: 'fitness_center',
  NoAlcohol: 'no_drinks',
  None: 'task_alt',
};

/** The draft for a new custom task (the add-task form). */
interface NewTaskDraft {
  label: string;
  measurable: boolean;
  targetValue: number | null;
  unit: string;
  pointValue: number;
  partialCredit: boolean;
}

function emptyDraft(): NewTaskDraft {
  return { label: '', measurable: false, targetValue: 10, unit: '', pointValue: 10, partialCredit: false };
}

/**
 * 75 Hard v2 challenge page (the Relaxed ruleset) — a CONFIGURABLE daily-task challenge layered on the
 * food/fitness tracker. Renders the active challenge from {@link ChallengeStore}:
 *
 * 1. a CONFIG panel to customize the task set (edit target/points/partial/enable, add/remove custom tasks);
 * 2. the day view with PER-TASK partial progress (bars for measurable: water X/target, workouts X/N,
 *    reading X/pages with a pages input), points earned, the day points total + the challenge total;
 * 3. a LEADERBOARD card ranking the caller + sharing contacts by points (names only — NEVER email);
 * 4. an AI coach card (tracker.ai, floored to a deterministic plain recap via fellBackToPlain).
 *
 * Auto tasks (diet/water/workout) score LIVE from the tracker against their OWN custom targets — never
 * computed here. All edit controls are hidden when viewing someone else (store.readOnly). The progress
 * photo concept is GONE entirely.
 */
@Component({
  selector: 'app-challenge',
  standalone: true,
  imports: [
    FormsModule, RouterLink, MatIconModule, MatButtonModule, MatMenuModule, MatTooltipModule,
    MatProgressBarModule, MatProgressSpinnerModule, MatCheckboxModule, MatSlideToggleModule,
    MatFormFieldModule, MatInputModule, MatButtonToggleModule, MatExpansionModule, MatSnackBarModule,
  ],
  templateUrl: './challenge.html',
  styleUrl: './challenge.scss',
})
export class Challenge {
  readonly store = inject(ChallengeStore);
  readonly auth = inject(AuthService);
  private snack = inject(MatSnackBar);
  private destroyRef = inject(DestroyRef);

  readonly totalDays = 75;
  readonly maxCheatDays = MAX_CHEAT_DAYS;

  /** Whether the caller may see/request the AI coach upgrade (the card itself always renders the floor). */
  readonly canCoach = computed(() => this.auth.hasPermission(PERM.trackerAi));

  /** True while a start-challenge POST is in flight (guards a double submit). */
  readonly starting = signal(false);

  /** The chosen start date for a new challenge (ISO "YYYY-MM-DD"); defaults to today. */
  readonly startDate = signal<string>(this.todayIso());

  /** The confession draft for the selected day (bound to the textarea); resynced when the day changes. */
  readonly confessionDraft = signal<string>('');

  /** A future date to add as a cheat day (ISO "YYYY-MM-DD"); '' until picked. */
  readonly cheatPick = signal<string>('');

  /** Per-task pages/value draft for MANUAL measurable tasks, keyed by task id (debounced commit on blur). */
  readonly manualDrafts = signal<Record<number, number | null>>({});

  /** True while a read-only auto-refresh is in flight (subtle spinner). */
  readonly refreshing = signal(false);

  /** Whether the task-config panel is expanded (owner only). */
  readonly configOpen = signal(false);

  /** The add-custom-task draft (owner). */
  readonly newTask = signal<NewTaskDraft>(emptyDraft());

  /** True while an add-task POST is in flight. */
  readonly addingTask = signal(false);

  /** The active read-only auto-refresh interval handle, or null when not running. */
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  /** Screen-reader-only polite status line. */
  readonly statusMsg = signal('');

  /** The selected day's grid row (per-task progress live from the server), or null. */
  readonly day = computed<HardDayDto | null>(() => this.store.selectedDay());

  /** Whether the loaded challenge is finished (day 75 complete). Drives the finisher state. */
  readonly finished = computed(() => this.store.challenge()?.status === 'Completed');

  /** Completion progress (0..100) toward 75 completed days, for the hero meter. */
  readonly completionPct = computed(() => {
    const c = this.store.challenge();
    if (!c) return 0;
    return Math.min(100, Math.round((c.completedDays / this.totalDays) * 100));
  });

  /** The future cheat days already declared (within the loaded window), oldest-first, for the chip list. */
  readonly cheatDays = computed<HardDayDto[]>(() => {
    const today = this.todayIso();
    return this.store.days().filter(d => d.isCheatDay && d.date > today);
  });

  constructor() {
    void this.store.load().then(() => {
      void this.store.loadLeaderboard();
      if (!this.store.readOnly() && this.store.challenge()) void this.store.loadCoach();
    });
    void this.store.loadShared();

    // Keep the confession textarea + manual task drafts in sync with whichever day is selected (own view
    // only — a viewer never sees confessions, so the draft stays empty there).
    effect(() => {
      const d = this.day();
      this.confessionDraft.set(this.store.readOnly() ? '' : (d?.confession ?? ''));
      const drafts: Record<number, number | null> = {};
      for (const t of d?.tasks ?? []) {
        if (t.autoSource === 'None' && t.targetValue != null) drafts[t.taskId] = t.value ?? null;
      }
      this.manualDrafts.set(drafts);
    });

    // Announce day/challenge reloads to assistive tech.
    effect(() => {
      const c = this.store.challenge();
      if (!c) return;
      this.statusMsg.set(
        `Day ${c.currentDay} of ${this.totalDays}, current streak ${c.currentStreak}, ${this.fmt(c.totalPoints)} points`);
    });

    // Read-only auto-refresh: a gentle 30s re-fetch ONLY while viewing someone else's challenge.
    effect(() => {
      const target = this.store.viewUser();
      this.stopAutoRefresh();
      if (target !== null) {
        this.refreshTimer = setInterval(() => void this.refreshReadOnly(), 30_000);
      }
    });

    this.destroyRef.onDestroy(() => this.stopAutoRefresh());
  }

  private stopAutoRefresh(): void {
    if (this.refreshTimer !== null) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  async refreshReadOnly(): Promise<void> {
    if (this.store.viewUser() === null) return;
    this.refreshing.set(true);
    try {
      await this.store.load();
      await this.store.loadLeaderboard();
    } finally {
      this.refreshing.set(false);
    }
  }

  // ---- start ----

  /** Start a 75 Hard run (own; one active at a time). A 409 (already active) reloads to show it. */
  async start(): Promise<void> {
    if (this.starting()) return;
    this.starting.set(true);
    try {
      await this.store.start({ startDate: this.startDate() || undefined });
      this.snack.open('Your 75 Hard has begun — day 1!', 'OK', { duration: 2600 });
      this.store.goToday();
      void this.store.loadLeaderboard();
      void this.store.loadCoach();
    } catch (e) {
      const msg = this.messageOf(e, 'Could not start your challenge.');
      this.snack.open(msg, 'OK', { duration: 4000 });
      await this.store.load();
    } finally {
      this.starting.set(false);
    }
  }

  // ---- day navigation (in-grid; no reload — the whole grid is loaded) ----

  prevDay(): void { this.store.shiftDate(-1); }
  nextDay(): void { this.store.shiftDate(1); }
  goToday(): void { this.store.goToday(); }
  onDateInput(value: string): void { if (value) this.store.setDate(value); }

  /** A friendly heading for the selected date (Today / Yesterday / weekday). */
  readonly dateHeading = computed(() => {
    const d = new Date(this.store.date() + 'T00:00:00');
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const diff = Math.round((d.getTime() - today.getTime()) / 86_400_000);
    if (diff === 0) return 'Today';
    if (diff === -1) return 'Yesterday';
    if (diff === 1) return 'Tomorrow';
    return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  });

  // ---- per-task day helpers ----

  /** The icon for a task (by auto-source). */
  taskIcon(t: { autoSource: string }): string {
    return AUTO_ICON[t.autoSource] ?? AUTO_ICON['None'];
  }

  /** Whether a task is auto-scored from the tracker (cannot be hand-edited; only diet has an override). */
  isAuto(t: { autoSource: string }): boolean {
    return t.autoSource !== 'None';
  }

  /** Whether a task is MEASURABLE (has a numeric target → progress bar + value), else binary. */
  isMeasurable(t: { targetValue: number | null }): boolean {
    return t.targetValue != null;
  }

  /** Whether a MANUAL measurable task takes a value input (reading pages / custom). */
  isManualMeasurable(t: HardDayTaskDto): boolean {
    return t.autoSource === 'None' && t.targetValue != null;
  }

  /** Whether a MANUAL binary task takes a checkbox (custom done/not). */
  isManualBinary(t: HardDayTaskDto): boolean {
    return t.autoSource === 'None' && t.targetValue == null;
  }

  /** Progress as a 0..100 percent for a task's bar. */
  pct(t: { progress: number }): number {
    return Math.round(Math.min(1, Math.max(0, t.progress)) * 100);
  }

  /** A short "X / target unit" measured label for a measurable task. */
  measuredLabel(t: HardDayTaskDto): string {
    const value = this.fmt(t.value ?? 0);
    const target = this.fmt(t.targetValue ?? 0);
    return `${value} / ${target}${t.unit ? ' ' + t.unit : ''}`;
  }

  /** A short scoring hint for an auto task (how it derives from the tracker). */
  autoHint(t: HardDayTaskDto): string {
    switch (t.autoSource) {
      case 'Diet': return 'within your tracker goals';
      case 'Water': return 'from your hydration log';
      case 'Workout': return 'logged workouts that hit the minutes target';
      case 'NoAlcohol': return 'from the no-alcohol attestation';
      default: return '';
    }
  }

  // ---- manual edits (owner only) ----

  /** Update the in-progress draft for a manual measurable task (committed on blur). */
  setManualDraft(taskId: number, value: number | null): void {
    this.manualDrafts.update(d => ({ ...d, [taskId]: value }));
  }

  /** Commit a manual measurable task's value (reading pages / custom) for the selected day. */
  saveManualValue(t: HardDayTaskDto): void {
    if (this.store.readOnly()) return;
    const raw = this.manualDrafts()[t.taskId];
    const value = raw == null || isNaN(raw) ? 0 : Math.max(0, raw);
    void this.saveDay({ tasks: [{ key: t.key, value }] });
  }

  /** Toggle a manual binary task (custom done/not) for the selected day. */
  toggleManualDone(t: HardDayTaskDto, checked: boolean): void {
    if (this.store.readOnly()) return;
    void this.saveDay({ tasks: [{ key: t.key, done: checked }] });
  }

  /** Toggle the no-alcohol rule for the day (drives the seeded no-alcohol task). */
  toggleNoAlcohol(checked: boolean): void {
    void this.saveDay({ noAlcohol: checked });
  }

  /** Whether the diet override is forcing a result (true/false), or null when using the auto value. */
  dietOverride(): boolean | null {
    return this.day()?.dietOverride ?? null;
  }

  /** Set the diet override (On plan / Off plan). The backend persists true/false; it WINS over the auto value. */
  setDietOverride(mode: 'pass' | 'fail'): void {
    if (this.store.readOnly()) return;
    void this.saveDay({ dietOverride: mode === 'pass' });
  }

  /** Save the confession draft for the selected day (owner). */
  saveConfession(): void {
    if (this.store.readOnly()) return;
    void this.saveDay({ confession: this.confessionDraft().trim() });
  }

  /** Upsert the manual portion of the selected day, then a gentle error path. */
  private async saveDay(patch: Partial<UpsertHardDayRequest>): Promise<void> {
    if (this.store.readOnly()) return;
    try {
      await this.store.upsertDay({ date: this.store.date(), ...patch });
      void this.store.loadLeaderboard();
    } catch (e) {
      this.snack.open(this.messageOf(e, 'Could not save — please try again.'), 'OK', { duration: 4000 });
    }
  }

  // ---- task config (owner) ----

  /** The diet task in the loaded set, if enabled (the day-view diet override only matters when it exists). */
  readonly dietTaskEnabled = computed(() =>
    this.store.tasks().some(t => t.autoSource === 'Diet' && t.enabled));

  /** The no-alcohol task in the loaded set, if enabled. */
  readonly noAlcoholEnabled = computed(() =>
    this.store.tasks().some(t => t.autoSource === 'NoAlcohol' && t.enabled));

  /** Toggle a task on/off (owner). */
  async toggleTaskEnabled(t: HardTaskDto, enabled: boolean): Promise<void> {
    await this.patchTask(t.id, { enabled });
  }

  /** Toggle a task's partial-credit flag (owner). */
  async toggleTaskPartial(t: HardTaskDto, partialCredit: boolean): Promise<void> {
    await this.patchTask(t.id, { partialCredit });
  }

  /** Commit an edited target value for a measurable task (owner). */
  async saveTaskTarget(t: HardTaskDto, value: number | null): Promise<void> {
    if (value == null || isNaN(value) || value <= 0) return;
    await this.patchTask(t.id, { targetValue: value });
  }

  /** Commit an edited workout min-minutes (owner; workout tasks only). */
  async saveTaskMinMinutes(t: HardTaskDto, value: number | null): Promise<void> {
    if (value == null || isNaN(value) || value <= 0) return;
    await this.patchTask(t.id, { minMinutes: Math.round(value) });
  }

  /** Commit an edited point value for a task (owner). */
  async saveTaskPoints(t: HardTaskDto, value: number | null): Promise<void> {
    if (value == null || isNaN(value)) return;
    await this.patchTask(t.id, { pointValue: Math.max(0, Math.round(value)) });
  }

  /** Commit an edited label for a task (owner). */
  async saveTaskLabel(t: HardTaskDto, label: string): Promise<void> {
    const clean = label.trim();
    if (!clean || clean === t.label) return;
    await this.patchTask(t.id, { label: clean });
  }

  /** Commit an edited unit for a measurable task (owner). */
  async saveTaskUnit(t: HardTaskDto, unit: string): Promise<void> {
    if (unit.trim() === t.unit) return;
    await this.patchTask(t.id, { unit: unit.trim() });
  }

  private async patchTask(id: number, body: UpdateHardTaskRequest): Promise<void> {
    if (this.store.readOnly()) return;
    try {
      await this.store.updateTask(id, body);
      void this.store.loadLeaderboard();
    } catch (e) {
      this.snack.open(this.messageOf(e, 'Could not update that task.'), 'OK', { duration: 4000 });
    }
  }

  /** Delete a CUSTOM task (auto tasks can only be disabled). */
  async deleteTask(t: HardTaskDto): Promise<void> {
    if (this.store.readOnly() || this.isAuto(t)) return;
    try {
      await this.store.deleteTask(t.id);
      this.snack.open('Task removed.', 'OK', { duration: 2000 });
      void this.store.loadLeaderboard();
    } catch (e) {
      this.snack.open(this.messageOf(e, 'Could not remove that task.'), 'OK', { duration: 4000 });
    }
  }

  /** Patch a field on the new-task draft. */
  patchDraft(patch: Partial<NewTaskDraft>): void {
    this.newTask.update(d => ({ ...d, ...patch }));
  }

  /** Add the custom manual task from the draft (owner). */
  async addCustomTask(): Promise<void> {
    if (this.store.readOnly() || this.addingTask()) return;
    const d = this.newTask();
    const label = d.label.trim();
    if (!label) {
      this.snack.open('Give your task a name first.', 'OK', { duration: 3000 });
      return;
    }
    const body: CreateHardTaskRequest = {
      label,
      pointValue: Math.max(0, Math.round(d.pointValue || 0)),
      targetValue: d.measurable ? Math.max(0.01, d.targetValue ?? 1) : null,
      unit: d.measurable ? (d.unit.trim() || null) : null,
      partialCredit: d.measurable ? d.partialCredit : false,
    };
    this.addingTask.set(true);
    try {
      await this.store.createTask(body);
      this.newTask.set(emptyDraft());
      this.snack.open('Custom task added.', 'OK', { duration: 2000 });
      void this.store.loadLeaderboard();
    } catch (e) {
      this.snack.open(this.messageOf(e, 'Could not add that task.'), 'OK', { duration: 4000 });
    } finally {
      this.addingTask.set(false);
    }
  }

  // ---- cheat days (future-only, owner) ----

  async addCheatDay(): Promise<void> {
    const date = this.cheatPick();
    if (this.store.readOnly() || !date) return;
    if (date <= this.todayIso()) {
      this.snack.open('Cheat days must be in the future.', 'OK', { duration: 3500 });
      return;
    }
    if (this.cheatDays().length >= MAX_CHEAT_DAYS) {
      this.snack.open(`You can declare at most ${MAX_CHEAT_DAYS} cheat days.`, 'OK', { duration: 3500 });
      return;
    }
    try {
      await this.store.setCheatDays({ add: [date] });
      this.cheatPick.set('');
      this.snack.open('Cheat day added.', 'OK', { duration: 2000 });
    } catch (e) {
      this.snack.open(this.messageOf(e, 'Could not add that cheat day.'), 'OK', { duration: 4000 });
    }
  }

  async removeCheatDay(d: HardDayDto): Promise<void> {
    if (this.store.readOnly()) return;
    try {
      await this.store.setCheatDays({ remove: [d.date] });
      this.snack.open('Cheat day cleared.', 'OK', { duration: 2000 });
    } catch (e) {
      this.snack.open(this.messageOf(e, 'Could not clear that cheat day.'), 'OK', { duration: 4000 });
    }
  }

  /** The earliest a cheat day may be (tomorrow), for the date input's min. */
  readonly minCheatDate = computed(() => {
    const d = new Date(); d.setDate(d.getDate() + 1);
    return this.toLocalDate(d);
  });

  /** The challenge window end (start + 74 days), for the cheat-day input's max. */
  readonly maxChallengeDate = computed(() => {
    const c = this.store.challenge();
    if (!c) return null;
    const d = new Date(c.startDate + 'T00:00:00');
    d.setDate(d.getDate() + this.totalDays - 1);
    return this.toLocalDate(d);
  });

  // ---- shared view + leaderboard ----

  get viewingUser(): HardSharedPersonDto | null {
    const userId = this.store.viewUser();
    if (userId == null) return null;
    return this.store.shared().find(s => s.userId === userId)
      ?? { userId, name: this.store.challenge()?.userName ?? 'Unknown user' };
  }

  viewSelf(): void {
    void this.store.viewUserTracker(null).then(() => {
      void this.store.loadLeaderboard();
      if (this.store.challenge()) void this.store.loadCoach();
    });
  }
  viewOther(userId: number): void {
    void this.store.viewUserTracker(userId).then(() => void this.store.loadLeaderboard());
  }

  /** Two-letter initials for an avatar fallback (name only; no email — email-privacy). */
  initials(u: { name?: string }): string {
    const parts = (u.name || '').split(/[\s@.]+/).filter(Boolean);
    return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || 'U';
  }

  /** "Mon, Jun 22" friendly label from a plain ISO date. */
  friendlyDate(iso: string): string {
    const d = new Date(iso + 'T00:00:00');
    return isNaN(d.getTime())
      ? iso : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  }

  // ---- misc ----

  /** Format a (possibly fractional) points/value number with no trailing zeros. */
  fmt(n: number): string {
    return Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, '');
  }

  private toLocalDate(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  private todayIso(): string {
    return this.toLocalDate(new Date());
  }

  private messageOf(e: unknown, fallback: string): string {
    const err = e as { error?: { message?: string; detail?: string; title?: string } };
    const msg = err?.error?.message || err?.error?.detail || err?.error?.title;
    return typeof msg === 'string' && msg ? msg : fallback;
  }
}
