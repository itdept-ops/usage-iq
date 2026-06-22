import { Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';

import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';

import { Api } from '../../core/api';
import { AuthService } from '../../core/auth';
import {
  CycleData, CycleNote, CyclePeriod, CyclePrediction, CycleSettings, PERM,
} from '../../core/models';
import { ConfirmData, FamilyConfirmDialog } from './confirm-dialog';

/** The phase a single calendar day belongs to (drives the soft colour layer). 'none' = an ordinary day. */
type DayPhase = 'logged' | 'period' | 'fertile' | 'none';

/** One cell of the mini month grid: its date + whether it's logged/predicted + today/in-month flags. */
interface CycleCell {
  /** Local "YYYY-MM-DD" for the day. */
  iso: string;
  dayNum: number;
  isToday: boolean;
  /** True for days inside the visible month; false for leading/trailing days from adjacent months. */
  inMonth: boolean;
  /** The strongest phase the day falls in (logged beats predicted-period beats fertile). */
  phase: DayPhase;
  /** True for a day inside a PREDICTED span (period or fertile) — the UI marks it "predicted". */
  predicted: boolean;
}

/**
 * Family Hub — the Cycle page (features/family/cycle, a child of /family gated by cycle.track). A warm,
 * PRIVATE, NON-MEDICAL cycle calendar for its owner: log a period, see logged + predicted period days +
 * the fertile window on a mini month grid (predicted spans are softly shaded and clearly marked
 * "predicted"), read the deterministic predictions (next period, fertile window, average cycle length),
 * opt in/out of overlaying ONLY predicted phases onto the family calendar, and read an optional gentle AI
 * note.
 *
 * PRIVACY-FIRST: every read/write here is owner-scoped server-side (cycle.track). Nobody else ever sees raw
 * entries — the family overlay (a separate opt-in) only ever exposes PREDICTED day-spans. The framing is
 * informational and gentle: this is NOT medical advice and never diagnoses. The AI note degrades to the
 * deterministic plain floor when family.ai / Gemini is absent, and cycle content is never logged as content.
 */
@Component({
  selector: 'app-family-cycle',
  standalone: true,
  imports: [
    FormsModule, MatIconModule, MatButtonModule, MatTooltipModule, MatProgressSpinnerModule,
    MatSlideToggleModule, MatFormFieldModule, MatInputModule, MatSnackBarModule,
  ],
  templateUrl: './cycle.html',
  styleUrls: ['./family.scss', './cycle.scss'],
})
export class FamilyCycle implements OnDestroy {
  private api = inject(Api);
  private dialog = inject(MatDialog);
  private snack = inject(MatSnackBar);
  private auth = inject(AuthService);

  // ---- page state ----
  readonly loading = signal(true);
  readonly error = signal(false);

  readonly periods = signal<CyclePeriod[]>([]);
  readonly prediction = signal<CyclePrediction | null>(null);
  readonly settings = signal<CycleSettings | null>(null);

  /** The gentle AI note (best-effort; null when unavailable or the caller lacks family.ai). */
  readonly note = signal<CycleNote | null>(null);

  // ---- "Log period" form ----
  /** The start date for a new log entry (ISO "YYYY-MM-DD"); defaults to today. */
  readonly logStart = signal<string>(this.todayIso());
  /** The optional end date for a new log entry (ISO "YYYY-MM-DD"); '' = ongoing / not recorded yet. */
  readonly logEnd = signal<string>('');
  readonly logging = signal(false);

  /** True while the family-overlay opt-in PATCH is in flight (disables the toggle). */
  readonly overlayBusy = signal(false);

  /** Whether the caller holds family.ai — drives whether we even try the gentle AI note. */
  private readonly hasAi = computed(() => {
    this.auth.permissions();
    return this.auth.hasPermission(PERM.familyAi);
  });

  /** The first-of-month (local midnight) anchoring the visible mini-calendar grid. */
  readonly monthStart = signal<Date>(this.firstOfMonth(new Date()));

  /** Today as ISO, recomputed once on construction (the page is short-lived). */
  private readonly today = this.todayIso();

  /** Whether the family-overlay opt-in is on (mirrors settings.overlayToFamily). */
  readonly overlayOn = computed<boolean>(() => this.settings()?.overlayToFamily === true);

  /** A friendly "June 2026" label for the visible month. */
  readonly monthLabel = computed<string>(() =>
    this.monthStart().toLocaleDateString(undefined, { month: 'long', year: 'numeric' }));

  /** Sun..Sat weekday header labels (browser locale). */
  readonly weekdayHeaders = computed<string[]>(() => {
    const labels: string[] = [];
    const sunday = new Date(2026, 0, 4); // a known Sunday
    for (let i = 0; i < 7; i++) {
      const d = new Date(sunday.getFullYear(), sunday.getMonth(), sunday.getDate() + i);
      labels.push(d.toLocaleDateString(undefined, { weekday: 'short' }));
    }
    return labels;
  });

  /**
   * The 42 cells (6 rows × 7 columns, Sun→Sat) of the visible month. Each day is tagged with its strongest
   * phase: a LOGGED period day (from the owner's own entries) wins, then a PREDICTED period day, then the
   * PREDICTED fertile window. Predicted spans come straight from the deterministic prediction block.
   */
  readonly cells = computed<CycleCell[]>(() => {
    const first = this.monthStart();
    const month = first.getMonth();
    const gridStart = this.sundayOf(first);

    const logged = this.loggedDays();          // Set<iso> of logged period days
    const p = this.prediction();
    const predPeriod = this.predictedPeriodDays(p);   // Set<iso>
    const fertile = this.fertileDays(p);              // Set<iso>

    const out: CycleCell[] = [];
    for (let i = 0; i < 42; i++) {
      const date = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
      const iso = this.toLocalDate(date);
      let phase: DayPhase = 'none';
      let predicted = false;
      if (logged.has(iso)) {
        phase = 'logged';
      } else if (predPeriod.has(iso)) {
        phase = 'period';
        predicted = true;
      } else if (fertile.has(iso)) {
        phase = 'fertile';
        predicted = true;
      }
      out.push({
        iso,
        dayNum: date.getDate(),
        isToday: iso === this.today,
        inMonth: date.getMonth() === month,
        phase,
        predicted,
      });
    }
    return out;
  });

  /** Friendly "next period" label, or '' until there's a prediction. */
  readonly nextPeriodLabel = computed<string>(() => {
    const next = this.prediction()?.nextPredictedStart;
    return next ? this.friendlyDate(next) : '';
  });

  /** Friendly fertile-window label ("Jun 12 – 17"), or '' until there's a prediction. */
  readonly fertileLabel = computed<string>(() => {
    const w = this.prediction()?.fertileWindow;
    if (!w) return '';
    return `${this.shortDate(w.start)} – ${this.shortDate(w.end)}`;
  });

  /** The recent logged periods, newest first, with friendly labels for the history list. */
  readonly recentPeriods = computed(() =>
    this.periods().map(pr => ({
      raw: pr,
      label: pr.endDate
        ? `${this.friendlyDate(pr.startDate)} – ${this.friendlyDate(pr.endDate)}`
        : `${this.friendlyDate(pr.startDate)} (start)`,
    })));

  constructor() {
    void this.load();
  }

  ngOnDestroy(): void { /* no timers to clean up */ }

  // ============================================================== loading

  private async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(false);
    try {
      const data: CycleData = await firstValueFrom(this.api.cycleData());
      this.periods.set(data.periods);
      this.prediction.set(data.prediction);
      this.settings.set(data.settings);
    } catch {
      this.error.set(true);
    } finally {
      this.loading.set(false);
    }
    // The gentle AI note is best-effort and only attempted when the caller holds family.ai (the endpoint
    // 403s otherwise). A failure / 403 just leaves the note hidden — the deterministic predictions stand.
    if (this.hasAi()) void this.loadNote();
  }

  private async loadNote(): Promise<void> {
    try {
      this.note.set(await firstValueFrom(this.api.cycleNote()));
    } catch {
      this.note.set(null);
    }
  }

  /** Re-fetch everything (after logging or deleting a period). */
  private async reload(): Promise<void> {
    try {
      const data = await firstValueFrom(this.api.cycleData());
      this.periods.set(data.periods);
      this.prediction.set(data.prediction);
      this.settings.set(data.settings);
    } catch {
      this.snack.open("Couldn't refresh just now. Please try again.", 'OK', { duration: 4000 });
    }
    if (this.hasAi()) void this.loadNote();
  }

  // ============================================================== month stepper

  prevMonth(): void {
    const s = this.monthStart();
    this.monthStart.set(new Date(s.getFullYear(), s.getMonth() - 1, 1));
  }

  nextMonth(): void {
    const s = this.monthStart();
    this.monthStart.set(new Date(s.getFullYear(), s.getMonth() + 1, 1));
  }

  thisMonth(): void {
    this.monthStart.set(this.firstOfMonth(new Date()));
  }

  // ============================================================== log a period

  /** Log the period from the form. Validates start ≤ end client-side for a friendly message before POST. */
  async logPeriod(): Promise<void> {
    if (this.logging()) return;
    const start = this.logStart();
    if (!start) {
      this.snack.open('Please choose a start date.', 'OK', { duration: 3500 });
      return;
    }
    const end = this.logEnd().trim();
    if (end && end < start) {
      this.snack.open('The end date must be on or after the start date.', 'OK', { duration: 4000 });
      return;
    }
    this.logging.set(true);
    try {
      await firstValueFrom(this.api.logPeriod(start, end || null));
      this.snack.open('Logged. Your predictions are updated.', undefined, { duration: 2200 });
      this.logEnd.set('');
      await this.reload();
    } catch (e) {
      this.snack.open(this.messageOf(e, "Couldn't log that just now. Please try again."), 'OK', { duration: 4000 });
    } finally {
      this.logging.set(false);
    }
  }

  /** Delete one of the owner's own logged periods (with a gentle confirm). */
  async deletePeriod(pr: CyclePeriod): Promise<void> {
    const ok = await this.confirm({
      title: 'Remove this entry?',
      message: 'This deletes the logged period from your private cycle calendar. Your predictions will update.',
      destructive: true,
      confirmLabel: 'Remove',
    });
    if (!ok) return;
    try {
      await firstValueFrom(this.api.deletePeriod(pr.id));
      await this.reload();
    } catch {
      this.snack.open("Couldn't remove that entry just now. Please try again.", 'OK', { duration: 4000 });
    }
  }

  // ============================================================== family-overlay opt-in

  /**
   * Toggle the "share predictions with my family calendar" opt-in. Only PREDICTED period/fertile day-spans
   * are ever overlaid (never raw entries). Optimistic on success; a friendly snackbar + no change on failure.
   */
  async toggleOverlay(): Promise<void> {
    if (this.overlayBusy()) return;
    const next = !this.overlayOn();
    this.overlayBusy.set(true);
    try {
      const updated = await firstValueFrom(this.api.patchCycleSettings({ overlayToFamily: next }));
      this.settings.set(updated);
      this.snack.open(
        updated.overlayToFamily
          ? 'Your predicted phases will show on the family calendar.'
          : 'Sharing turned off — your predictions are private again.',
        undefined, { duration: 2600 });
    } catch (e) {
      this.snack.open(this.messageOf(e, "Couldn't update sharing just now. Please try again."), 'OK',
        { duration: 4000 });
    } finally {
      this.overlayBusy.set(false);
    }
  }

  // ============================================================== phase-day derivation

  /** The set of local-ISO days covered by the owner's LOGGED periods (start→end inclusive; start-only = 1 day). */
  private loggedDays(): Set<string> {
    const out = new Set<string>();
    for (const p of this.periods()) {
      for (const iso of this.daysBetween(p.startDate, p.endDate ?? p.startDate)) out.add(iso);
    }
    return out;
  }

  /**
   * The PREDICTED upcoming period days. Anchored on the deterministic `nextPredictedStart` and running for
   * the owner's average period length (from settings). Empty until there's a prediction. These never overlap
   * logged days in the grid (logged wins) — this is purely the soft "predicted" layer.
   */
  private predictedPeriodDays(p: CyclePrediction | null): Set<string> {
    const out = new Set<string>();
    if (!p?.nextPredictedStart) return out;
    const lengthDays = Math.max(1, this.settings()?.avgPeriodLengthDays ?? 5);
    const start = this.parseIso(p.nextPredictedStart);
    if (!start) return out;
    for (let i = 0; i < lengthDays; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      out.add(this.toLocalDate(d));
    }
    return out;
  }

  /** The PREDICTED fertile window days (inclusive), or empty until there's a prediction. */
  private fertileDays(p: CyclePrediction | null): Set<string> {
    const out = new Set<string>();
    const w = p?.fertileWindow;
    if (!w) return out;
    for (const iso of this.daysBetween(w.start, w.end)) out.add(iso);
    return out;
  }

  // ============================================================== date helpers (browser local zone)

  /** Inclusive list of local-ISO days from `startIso` to `endIso` (guarded against pathological ranges). */
  private daysBetween(startIso: string, endIso: string): string[] {
    const start = this.parseIso(startIso);
    const end = this.parseIso(endIso);
    if (!start || !end) return [];
    const out: string[] = [];
    const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    const last = new Date(end.getFullYear(), end.getMonth(), end.getDate());
    let guard = 0;
    while (cursor.getTime() <= last.getTime() && guard++ < 400) {
      out.push(this.toLocalDate(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
    return out;
  }

  /** Parse a plain ISO date ("YYYY-MM-DD") as LOCAL midnight (avoids a UTC day shift). */
  private parseIso(iso: string): Date | null {
    if (!iso) return null;
    const d = new Date(`${iso}T00:00:00`);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  private toLocalDate(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  private todayIso(): string {
    return this.toLocalDate(new Date());
  }

  private sundayOf(d: Date): Date {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay());
  }

  private firstOfMonth(d: Date): Date {
    return new Date(d.getFullYear(), d.getMonth(), 1);
  }

  /** "Mon, Jun 22" friendly label from a plain ISO date. */
  friendlyDate(iso: string): string {
    const d = this.parseIso(iso);
    return d ? d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) : iso;
  }

  /** "Jun 22" short label from a plain ISO date. */
  shortDate(iso: string): string {
    const d = this.parseIso(iso);
    return d ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : iso;
  }

  // ============================================================== misc

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
