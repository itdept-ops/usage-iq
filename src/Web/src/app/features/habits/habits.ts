import {
  ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';

import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';

import { Api } from '../../core/api';
import { AuthService } from '../../core/auth';
import {
  CreateHabitRequest, HabitCadence, HabitCoachDto, HabitDayDto, HabitDto,
  HabitLeaderboardRowDto, PERM, UpdateHabitRequest,
} from '../../core/models';
import { BetaEmptyState, BetaErrorState } from '../beta-ui';

/** Cadence enum int values (mirror HabitCadence: Daily=0, Weekly=1, CustomDaysOfWeek=2, XTimesPerPeriod=3). */
const CADENCE_INT: Record<HabitCadence, number> = {
  Daily: 0, Weekly: 1, CustomDaysOfWeek: 2, XTimesPerPeriod: 3,
};
/** HardTaskAutoSource int values valid for a habit (None=0, Water=2, Workout=3). */
const AUTO_INT: Record<string, number> = { None: 0, Water: 2, Workout: 3 };
const AUTO_ICON: Record<string, string> = { None: 'task_alt', Water: 'local_drink', Workout: 'fitness_center' };

/** The create/edit habit draft (the sheet form). */
interface HabitDraft {
  id: number | null;            // null = create
  title: string;
  cadence: HabitCadence;
  daysOfWeek: Set<number>;      // 0=Sun .. 6=Sat
  timesPerPeriod: number;
  periodDays: number;
  measurable: boolean;
  targetValue: number | null;
  unit: string;
  partialCredit: boolean;
  autoSource: 'None' | 'Water' | 'Workout';
  color: string;
}

function emptyDraft(): HabitDraft {
  return {
    id: null, title: '', cadence: 'Daily', daysOfWeek: new Set([1, 2, 3, 4, 5]),
    timesPerPeriod: 3, periodDays: 7, measurable: false, targetValue: 10, unit: '',
    partialCredit: false, autoSource: 'None', color: '#4f46e5',
  };
}

/** One cell of the per-habit mini streak calendar. */
interface HabitCalCell { iso: string; dayNum: number; inMonth: boolean; isToday: boolean; complete: boolean; skip: boolean; }

/**
 * Habits (the desktop `/habits` page) — the generalised successor to 75 Hard (`/challenge`, which stays as-is).
 * Gated by the SAME `tracker.self` (NO dedicated permission) and OWNER-SCOPED. A grid of habit cards shows
 * each habit's today check/value, current-streak flame, cadence + a quick complete/skip; a create/edit sheet
 * configures cadence (daily / weekly / custom days / X-times-per-period), an optional measurable target, and
 * an optional tracker auto-source (water / workout). A per-habit streak calendar and a habits leaderboard
 * (the caller + sharing contacts ranked by streak, names only — NEVER email) round it out.
 *
 * Day-math is computed server-side by the shared scorer; the cadence-aware streak is the only net-new logic.
 * Crossing a day into complete emits `habit.dayComplete` server-side carrying the STREAK only — never the
 * private habit title.
 */
@Component({
  selector: 'app-habits',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule, MatIconModule, MatButtonModule, MatSnackBarModule, MatProgressSpinnerModule,
    BetaEmptyState, BetaErrorState,
  ],
  templateUrl: './habits.html',
  styleUrl: './habits.scss',
})
export class Habits {
  private api = inject(Api);
  private auth = inject(AuthService);
  private snack = inject(MatSnackBar);
  private destroyRef = inject(DestroyRef);

  readonly autoIcon = AUTO_ICON;

  // ---- page state ----
  readonly loading = signal(true);
  readonly errored = signal(false);
  readonly habits = signal<HabitDto[]>([]);
  readonly leaderboard = signal<HabitLeaderboardRowDto[]>([]);
  readonly coach = signal<HabitCoachDto | null>(null);

  readonly canCoach = computed(() => {
    this.auth.permissions();
    return this.auth.hasPermission(PERM.trackerAi);
  });

  // ---- create/edit sheet ----
  readonly sheetOpen = signal(false);
  readonly draft = signal<HabitDraft>(emptyDraft());
  readonly saving = signal(false);

  // ---- per-habit streak calendar ----
  readonly calHabit = signal<HabitDto | null>(null);
  readonly calMonth = signal<Date>(this.firstOfMonth(new Date()));
  readonly calDays = signal<Map<string, HabitDayDto>>(new Map());
  readonly calLoading = signal(false);

  readonly weekdayLabels: readonly string[] = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  readonly cadenceOptions: readonly { value: HabitCadence; label: string }[] = [
    { value: 'Daily', label: 'Every day' },
    { value: 'CustomDaysOfWeek', label: 'Certain days' },
    { value: 'Weekly', label: 'Weekly' },
    { value: 'XTimesPerPeriod', label: 'X times / period' },
  ];
  readonly autoOptions: readonly { value: 'None' | 'Water' | 'Workout'; label: string }[] = [
    { value: 'None', label: 'Manual' },
    { value: 'Water', label: 'Water (tracker)' },
    { value: 'Workout', label: 'Workout (tracker)' },
  ];
  readonly colorOptions: readonly string[] = ['#4f46e5', '#0d9488', '#ef5b34', '#d946ef', '#0ea5e9', '#f59e0b'];

  readonly today = this.todayIso();

  readonly calCells = computed<HabitCalCell[]>(() => {
    const first = this.calMonth();
    const month = first.getMonth();
    const gridStart = this.sundayOf(first);
    const days = this.calDays();
    const out: HabitCalCell[] = [];
    for (let i = 0; i < 42; i++) {
      const date = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
      const iso = this.toLocalDate(date);
      const d = days.get(iso);
      out.push({
        iso, dayNum: date.getDate(), inMonth: date.getMonth() === month,
        isToday: iso === this.today, complete: d?.complete ?? false, skip: d?.skip ?? false,
      });
    }
    return out;
  });

  readonly calMonthLabel = computed(() =>
    this.calMonth().toLocaleDateString(undefined, { month: 'long', year: 'numeric' }));

  constructor() {
    void this.reload();
  }

  // ============================================================== loading

  async reload(): Promise<void> {
    this.loading.set(true);
    this.errored.set(false);
    try {
      this.habits.set(await firstValueFrom(this.api.habits()));
    } catch {
      this.errored.set(true);
    } finally {
      this.loading.set(false);
    }
    void this.loadLeaderboard();
    if (this.habits().length) void this.loadCoach();
  }

  async loadLeaderboard(): Promise<void> {
    try {
      this.leaderboard.set(await firstValueFrom(this.api.habitsLeaderboard()));
    } catch { /* leaderboard is best-effort */ }
  }

  async loadCoach(): Promise<void> {
    try {
      this.coach.set(await firstValueFrom(this.api.habitsCoach()));
    } catch { this.coach.set(null); }
  }

  // ============================================================== today check / skip

  /** Toggle a binary habit's today done, or for a measurable one toggle full/zero. */
  async toggleToday(h: HabitDto): Promise<void> {
    const measurable = h.targetValue != null;
    const body = measurable
      ? { date: this.today, value: h.today.complete ? 0 : Number(h.targetValue) }
      : { date: this.today, done: !h.today.done };
    await this.commitDay(h, body);
  }

  async toggleSkip(h: HabitDto): Promise<void> {
    await this.commitDay(h, { date: this.today, skip: !h.today.skip });
  }

  /** Commit a measurable manual value from the inline input. */
  async setTodayValue(h: HabitDto, raw: number | null): Promise<void> {
    const value = raw == null || isNaN(raw) ? 0 : Math.max(0, raw);
    await this.commitDay(h, { date: this.today, value });
  }

  private async commitDay(h: HabitDto, body: { date: string; value?: number; done?: boolean; skip?: boolean }): Promise<void> {
    try {
      await firstValueFrom(this.api.upsertHabitDay(h.id, body));
      // Re-fetch the whole list so the cached streak/today reflect the server's recompute.
      this.habits.set(await firstValueFrom(this.api.habits()));
      void this.loadLeaderboard();
      if (this.calHabit()?.id === h.id) void this.loadCalendar(this.calHabit()!);
    } catch (e) {
      this.snack.open(this.messageOf(e, 'Could not save — try again.'), 'OK', { duration: 4000 });
    }
  }

  // ============================================================== create / edit sheet

  openCreate(): void {
    this.draft.set(emptyDraft());
    this.sheetOpen.set(true);
  }

  openEdit(h: HabitDto): void {
    this.draft.set({
      id: h.id, title: h.title, cadence: h.cadence,
      daysOfWeek: this.maskToDays(h.daysOfWeekMask),
      timesPerPeriod: h.timesPerPeriod, periodDays: h.periodDays,
      measurable: h.targetValue != null, targetValue: h.targetValue ?? 10, unit: h.unit,
      partialCredit: h.partialCredit, autoSource: h.autoSource, color: h.color || '#4f46e5',
    });
    this.sheetOpen.set(true);
  }

  closeSheet(): void { this.sheetOpen.set(false); }

  patchDraft(patch: Partial<HabitDraft>): void {
    this.draft.update((d) => ({ ...d, ...patch }));
  }

  toggleDraftDay(day: number): void {
    this.draft.update((d) => {
      const next = new Set(d.daysOfWeek);
      if (next.has(day)) next.delete(day); else next.add(day);
      return { ...d, daysOfWeek: next };
    });
  }

  isDraftDayOn(day: number): boolean { return this.draft().daysOfWeek.has(day); }

  async saveDraft(): Promise<void> {
    if (this.saving()) return;
    const d = this.draft();
    const title = d.title.trim();
    if (!title) {
      this.snack.open('Give your habit a name first.', 'OK', { duration: 3000 });
      return;
    }
    this.saving.set(true);
    try {
      if (d.id == null) {
        const body: CreateHabitRequest = {
          title,
          cadence: CADENCE_INT[d.cadence],
          daysOfWeekMask: this.daysToMask(d.daysOfWeek),
          timesPerPeriod: Math.max(1, Math.round(d.timesPerPeriod || 1)),
          periodDays: Math.max(1, Math.round(d.periodDays || 7)),
          targetValue: d.measurable ? Math.max(0.01, d.targetValue ?? 1) : null,
          unit: d.measurable ? d.unit.trim() || null : null,
          partialCredit: d.measurable ? d.partialCredit : false,
          autoSource: AUTO_INT[d.autoSource],
          color: d.color,
        };
        await firstValueFrom(this.api.createHabit(body));
        this.snack.open('Habit created.', 'OK', { duration: 2000 });
      } else {
        const body: UpdateHabitRequest = {
          title,
          cadence: CADENCE_INT[d.cadence],
          daysOfWeekMask: this.daysToMask(d.daysOfWeek),
          timesPerPeriod: Math.max(1, Math.round(d.timesPerPeriod || 1)),
          periodDays: Math.max(1, Math.round(d.periodDays || 7)),
          targetValue: d.measurable ? Math.max(0.01, d.targetValue ?? 1) : null,
          unit: d.measurable ? d.unit.trim() || null : null,
          partialCredit: d.measurable ? d.partialCredit : false,
          autoSource: AUTO_INT[d.autoSource],
          color: d.color,
        };
        await firstValueFrom(this.api.updateHabit(d.id, body));
        this.snack.open('Habit updated.', 'OK', { duration: 2000 });
      }
      this.sheetOpen.set(false);
      await this.reload();
    } catch (e) {
      this.snack.open(this.messageOf(e, 'Could not save that habit.'), 'OK', { duration: 4000 });
    } finally {
      this.saving.set(false);
    }
  }

  async pauseHabit(h: HabitDto): Promise<void> {
    const next = h.status === 'Paused' ? 0 : 1; // Active=0 / Paused=1
    try {
      await firstValueFrom(this.api.updateHabit(h.id, { status: next }));
      await this.reload();
    } catch (e) {
      this.snack.open(this.messageOf(e, 'Could not update that habit.'), 'OK', { duration: 4000 });
    }
  }

  async archiveHabit(h: HabitDto): Promise<void> {
    if (typeof confirm === 'function' && !confirm(`Archive "${h.title}"? It leaves your active grid.`)) return;
    try {
      await firstValueFrom(this.api.deleteHabit(h.id));
      this.snack.open('Habit archived.', 'OK', { duration: 2000 });
      if (this.calHabit()?.id === h.id) this.calHabit.set(null);
      await this.reload();
    } catch (e) {
      this.snack.open(this.messageOf(e, 'Could not archive that habit.'), 'OK', { duration: 4000 });
    }
  }

  // ============================================================== per-habit streak calendar

  openCalendar(h: HabitDto): void {
    this.calHabit.set(h);
    this.calMonth.set(this.firstOfMonth(new Date()));
    void this.loadCalendar(h);
  }

  closeCalendar(): void { this.calHabit.set(null); }

  prevCalMonth(): void {
    const s = this.calMonth();
    this.calMonth.set(new Date(s.getFullYear(), s.getMonth() - 1, 1));
    if (this.calHabit()) void this.loadCalendar(this.calHabit()!);
  }
  nextCalMonth(): void {
    const s = this.calMonth();
    this.calMonth.set(new Date(s.getFullYear(), s.getMonth() + 1, 1));
    if (this.calHabit()) void this.loadCalendar(this.calHabit()!);
  }

  private async loadCalendar(h: HabitDto): Promise<void> {
    this.calLoading.set(true);
    const first = this.calMonth();
    const gridStart = this.sundayOf(first);
    const map = new Map<string, HabitDayDto>();
    try {
      // The visible grid is 42 days; fetch each day's state. (Cheap + owner-scoped; mirrors the cycle grid feel.)
      const promises: Promise<HabitDayDto>[] = [];
      const isos: string[] = [];
      for (let i = 0; i < 42; i++) {
        const date = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
        const iso = this.toLocalDate(date);
        if (iso > this.today) continue; // no future days
        isos.push(iso);
        promises.push(firstValueFrom(this.api.habitDay(h.id, iso)));
      }
      const results = await Promise.all(promises);
      results.forEach((d, idx) => map.set(isos[idx], d));
      this.calDays.set(map);
    } catch {
      this.calDays.set(new Map());
    } finally {
      this.calLoading.set(false);
    }
  }

  // ============================================================== card helpers

  cadenceLabel(h: HabitDto): string {
    switch (h.cadence) {
      case 'Daily': return 'Every day';
      case 'Weekly': return 'Weekly';
      case 'CustomDaysOfWeek': return this.maskLabel(h.daysOfWeekMask);
      case 'XTimesPerPeriod': return `${h.timesPerPeriod}× / ${h.periodDays}d`;
      default: return h.cadence;
    }
  }

  progressPct(d: HabitDayDto): number {
    return Math.round(Math.min(1, Math.max(0, d.progress)) * 100);
  }

  measurableLabel(h: HabitDto): string {
    if (h.targetValue == null) return '';
    const value = this.fmt(h.today.value ?? 0);
    return `${value} / ${this.fmt(h.targetValue)}${h.unit ? ' ' + h.unit : ''}`;
  }

  isMeasurable(h: HabitDto): boolean { return h.targetValue != null; }
  isManual(h: HabitDto): boolean { return h.autoSource === 'None'; }

  initials(name: string): string {
    const parts = (name || '').split(/[\s@.]+/).filter(Boolean);
    return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || 'U';
  }

  fmt(n: number): string {
    return Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, '');
  }

  // ---- weekday mask <-> set ----
  private maskToDays(mask: number): Set<number> {
    const s = new Set<number>();
    for (let i = 0; i < 7; i++) if (mask & (1 << i)) s.add(i);
    return s.size ? s : new Set([1, 2, 3, 4, 5]);
  }
  private daysToMask(days: Set<number>): number {
    let mask = 0;
    for (const d of days) mask |= (1 << d);
    return mask & 0x7f;
  }
  private maskLabel(mask: number): string {
    const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const out: string[] = [];
    for (let i = 0; i < 7; i++) if (mask & (1 << i)) out.push(names[i]);
    return out.length ? out.join(', ') : 'No days set';
  }

  // ---- date helpers ----
  private toLocalDate(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  private todayIso(): string { return this.toLocalDate(new Date()); }
  private sundayOf(d: Date): Date { return new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay()); }
  private firstOfMonth(d: Date): Date { return new Date(d.getFullYear(), d.getMonth(), 1); }

  private messageOf(e: unknown, fallback: string): string {
    const msg = (e as { error?: { message?: string } })?.error?.message;
    return typeof msg === 'string' && msg ? msg : fallback;
  }
}
