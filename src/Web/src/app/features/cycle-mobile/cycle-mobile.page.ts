import {
  ChangeDetectionStrategy, Component, OnDestroy, computed, inject, signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { MatIconModule } from '@angular/material/icon';

import { Api } from '../../core/api';
import { AuthService } from '../../core/auth';
import {
  CycleData, CycleDayLog, CycleDayLogPatch, CycleFlowLevel, CycleNote,
  CyclePeriod, CyclePrediction, CycleSettings, PERM,
} from '../../core/models';
import {
  BetaPullRefresh, BetaBottomSheet, BetaSwipeRow, BetaSkeleton,
  BetaFab, BetaToaster, ToastController,
} from '../beta-ui';

/** The strongest phase a calendar day belongs to (drives its soft colour layer). */
type DayPhase = 'logged' | 'period' | 'fertile' | 'none';

/** One cell of the mini month grid. */
interface CycleCell {
  iso: string;
  dayNum: number;
  isToday: boolean;
  inMonth: boolean;
  phase: DayPhase;
  predicted: boolean;
  hasLog: boolean;
}

interface MoodChoice { value: string; label: string; emoji: string; }
interface FlowChoice { value: CycleFlowLevel; label: string; }

/**
 * Cycle — the mobile-first twin of the live Family Hub /family/cycle page, rebuilt on the shared beta-ui
 * "Strata" kit (`@use '../beta-ui/beta-kit'`). One signature accent (a soft ROSE → PLUM ramp) re-skins the
 * whole screen via the per-page accent contract. PRIVATE, NON-MEDICAL: a current-phase summary at the top
 * (today's phase + next period + fertile window), a {@link BetaBottomSheet} LOG-ENTRY editor (a period
 * range + the discreet daily self-log: mood / symptoms / flow / energy / intimacy / notes), and a compact
 * scrollable mini-calendar that doubles as the day picker, plus a swipeable recent-period history and the
 * family-overlay opt-in. Pull-to-refresh, skeletons, and elevated empty/error states round it out.
 *
 * DATA PARITY + PRIVACY: every read/write reuses the SAME owner-scoped, cycle.track-gated `/family/cycle`
 * endpoints the live page uses — {@link Api.cycleData} (own periods + deterministic predictions + settings
 * + private day-logs), {@link Api.logPeriod} / {@link Api.deletePeriod}, the partial day-log upsert
 * {@link Api.upsertCycleDayLog} / {@link Api.deleteCycleDayLog}, the {@link Api.patchCycleSettings}
 * overlay opt-in, and the gentle {@link Api.cycleNote} (best-effort, only when the caller holds family.ai).
 * Predictions are pure deterministic math; the family overlay only ever exposes PREDICTED day-spans (the
 * raw private log NEVER leaves the owner). This is informational, gentle, and NEVER diagnostic.
 *
 * ISOLATION: gated by `platform.mobile` + the SAME `cycle.track` the live route carries; it imports only
 * the kit + the shared Api/models. No live page is imported or modified.
 */
@Component({
  selector: 'app-cycle-mobile',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [ToastController],
  imports: [
    FormsModule, MatIconModule,
    BetaPullRefresh, BetaBottomSheet, BetaSwipeRow, BetaSkeleton, BetaFab, BetaToaster,
  ],
  template: `
    <!-- ─────────────── PULL-TO-REFRESH OWNS THE SCROLL ─────────────── -->
    <app-bs-pull-refresh class="cy-ptr" [busy]="refreshing()" (refresh)="reload()">
      <div class="cy-scroll" aria-live="polite">

        <!-- ─── HERO: title + the current-phase summary ─── -->
        <header class="cy-hero">
          <p class="cy-hero__kicker"><mat-icon aria-hidden="true">favorite</mat-icon> Cycle</p>
          <h1 class="cy-hero__title">Your private calendar</h1>
          <p class="cy-hero__sub">A gentle, non-medical companion — only you ever see your log.</p>
        </header>

        @if (loading()) {
          <div class="cy-summary" aria-hidden="true">
            <app-bs-skeleton height="120px" radius="var(--r-tile)" />
          </div>
          <div class="cy-cal-card" aria-hidden="true">
            <app-bs-skeleton height="280px" radius="var(--r-tile)" />
          </div>

        } @else if (errored()) {
          <div class="cy-state">
            <span class="cy-state__orb"><mat-icon aria-hidden="true">cloud_off</mat-icon></span>
            <h2 class="cy-state__title">Couldn't load your calendar</h2>
            <p class="cy-state__body">Something went wrong fetching your cycle. Give it another go.</p>
            <button type="button" class="cy-state__cta" (click)="reload()">
              <mat-icon aria-hidden="true">refresh</mat-icon> Try again
            </button>
          </div>

        } @else {
          <!-- ─── CURRENT-PHASE SUMMARY ─── -->
          <section class="cy-summary" aria-label="Current phase summary">
            <div class="cy-summary__phase">
              <span class="cy-summary__dot" [attr.data-phase]="phaseTone()" aria-hidden="true"></span>
              <div class="cy-summary__phase-txt">
                <span class="cy-summary__phase-l">Today</span>
                <span class="cy-summary__phase-n">{{ currentPhaseLabel() }}</span>
              </div>
            </div>

            <div class="cy-summary__facts">
              <div class="cy-fact">
                <mat-icon class="cy-fact__ic" aria-hidden="true">event</mat-icon>
                <span class="cy-fact__l">Next period</span>
                <span class="cy-fact__v">{{ nextPeriodLabel() || 'Log to predict' }}</span>
              </div>
              <div class="cy-fact">
                <mat-icon class="cy-fact__ic" aria-hidden="true">spa</mat-icon>
                <span class="cy-fact__l">Fertile window</span>
                <span class="cy-fact__v">{{ fertileLabel() || '—' }}</span>
              </div>
              <div class="cy-fact">
                <mat-icon class="cy-fact__ic" aria-hidden="true">timeline</mat-icon>
                <span class="cy-fact__l">Avg cycle</span>
                <span class="cy-fact__v"><span class="mono-num">{{ avgCycle() }}</span> days</span>
              </div>
            </div>

            @if (note(); as n) {
              <p class="cy-summary__note">
                <mat-icon aria-hidden="true">auto_awesome</mat-icon> {{ n.note }}
              </p>
            }
          </section>

          <!-- ─── MINI CALENDAR (also the day picker) ─── -->
          <section class="cy-cal-card" aria-label="Cycle calendar">
            <div class="cy-cal__bar">
              <button type="button" class="cy-cal__nav" (click)="prevMonth()" aria-label="Previous month">
                <mat-icon aria-hidden="true">chevron_left</mat-icon>
              </button>
              <button type="button" class="cy-cal__month" (click)="thisMonth()">{{ monthLabel() }}</button>
              <button type="button" class="cy-cal__nav" (click)="nextMonth()" aria-label="Next month">
                <mat-icon aria-hidden="true">chevron_right</mat-icon>
              </button>
            </div>

            <div class="cy-cal__dow" aria-hidden="true">
              @for (d of weekdayHeaders(); track $index) { <span>{{ d }}</span> }
            </div>

            <div class="cy-cal__grid" role="grid">
              @for (c of cells(); track c.iso) {
                <button type="button" class="cy-day"
                        [class.is-out]="!c.inMonth"
                        [class.is-today]="c.isToday"
                        [class.is-sel]="c.iso === logDate()"
                        [attr.data-phase]="c.phase"
                        [class.is-pred]="c.predicted"
                        (click)="pickCalendarDay(c.iso)"
                        [attr.aria-label]="dayAria(c)">
                  <span class="cy-day__n mono-num">{{ c.dayNum }}</span>
                  @if (c.hasLog) { <span class="cy-day__log" aria-hidden="true"></span> }
                </button>
              }
            </div>

            <div class="cy-legend" aria-hidden="true">
              <span class="cy-legend__i"><i data-phase="logged"></i> Logged</span>
              <span class="cy-legend__i"><i data-phase="period"></i> Predicted period</span>
              <span class="cy-legend__i"><i data-phase="fertile"></i> Fertile</span>
              <span class="cy-legend__i"><b></b> Daily log</span>
            </div>
          </section>

          <!-- ─── RECENT PERIODS (swipe left to remove) ─── -->
          <section class="cy-hist" aria-label="Recent periods">
            <h2 class="cy-hist__h"><mat-icon aria-hidden="true">history</mat-icon> Recent periods</h2>
            @if (recentPeriods().length) {
              <div class="cy-hist__list">
                @for (p of recentPeriods(); track p.raw.id) {
                  <app-bs-swipe-row class="cy-swipe" leftLabel="Remove" [rightLabel]="''"
                    [label]="p.label" (swipe)="onPeriodSwipe(p.raw, $event)">
                    <div class="cy-period">
                      <span class="cy-period__glyph" aria-hidden="true"><mat-icon>water_drop</mat-icon></span>
                      <span class="cy-period__label">{{ p.label }}</span>
                    </div>
                  </app-bs-swipe-row>
                }
              </div>
              <p class="cy-hist__foot" aria-hidden="true">Swipe a period left to remove it</p>
            } @else {
              <div class="cy-empty">
                <span class="cy-empty__orb"><mat-icon aria-hidden="true">water_drop</mat-icon></span>
                <p class="cy-empty__body">No periods logged yet. Tap the + to log one and unlock predictions.</p>
              </div>
            }
          </section>

          <!-- ─── FAMILY-OVERLAY OPT-IN ─── -->
          <button type="button" class="cy-overlay" [class.is-on]="overlayOn()"
                  [disabled]="overlayBusy()" (click)="toggleOverlay()">
            <mat-icon aria-hidden="true">{{ overlayOn() ? 'group' : 'lock' }}</mat-icon>
            <span class="cy-overlay__txt">
              <b>{{ overlayOn() ? 'Sharing predicted phases' : 'Private to you' }}</b>
              <i>Only PREDICTED phases ever show on the family calendar — never your log.</i>
            </span>
            <span class="cy-switch" [class.is-on]="overlayOn()" aria-hidden="true">
              <span class="cy-switch__knob"></span>
            </span>
          </button>
        }
      </div>
    </app-bs-pull-refresh>

    <!-- ─── LOG FAB ─── -->
    @if (!loading() && !errored()) {
      <app-bs-fab icon="add" label="Log entry" [extended]="true" [fixed]="true" (action)="openLog()" />
    }

    <!-- ─────────────── LOG-ENTRY BOTTOM SHEET ─────────────── -->
    <app-bs-sheet [(open)]="logOpen" detent="full" [dismissable]="!logging()" label="Log entry">
      <div class="ls">
        <div class="ls__head">
          <h3 class="ls__title">Log entry</h3>
          <button type="button" class="ls__close" (click)="logOpen.set(false)" aria-label="Close"
                  [disabled]="logging()">
            <mat-icon aria-hidden="true">close</mat-icon>
          </button>
        </div>

        <!-- the day being edited (calendar + day stepper drive this) -->
        <div class="ls__daybar">
          <button type="button" class="ls__day-nav" (click)="prevDay()" aria-label="Previous day">
            <mat-icon aria-hidden="true">chevron_left</mat-icon>
          </button>
          <div class="ls__day-now">
            <span class="ls__day-l">Editing</span>
            <span class="ls__day-v">{{ logDateLabel() }}</span>
          </div>
          <button type="button" class="ls__day-nav" (click)="nextDay()" aria-label="Next day">
            <mat-icon aria-hidden="true">chevron_right</mat-icon>
          </button>
        </div>
        @if (logDate() !== today) {
          <button type="button" class="ls__today" (click)="logToday()">
            <mat-icon aria-hidden="true">today</mat-icon> Jump to today
          </button>
        }

        <!-- ── LOG A PERIOD RANGE ── -->
        <div class="ls__block">
          <span class="ls__block-h"><mat-icon aria-hidden="true">water_drop</mat-icon> Log a period</span>
          <div class="ls__row">
            <label class="ls__field">
              <span class="ls__label">Start</span>
              <input class="ls__input" type="date" [ngModel]="logStart()" (ngModelChange)="logStart.set($event)"
                     name="pstart" [max]="today" />
            </label>
            <label class="ls__field">
              <span class="ls__label">End <i>(optional)</i></span>
              <input class="ls__input" type="date" [ngModel]="logEnd()" (ngModelChange)="logEnd.set($event)"
                     name="pend" [min]="logStart()" [max]="today" />
            </label>
          </div>
          <button type="button" class="ls__logbtn" [disabled]="logging()" (click)="logPeriod()">
            @if (logging()) { <span class="ls__spin" aria-hidden="true"></span> Logging… }
            @else { <mat-icon aria-hidden="true">check</mat-icon> Log this period }
          </button>
        </div>

        <!-- ── DAILY SELF-LOG (private) ── -->
        <div class="ls__block">
          <span class="ls__block-h">
            <mat-icon aria-hidden="true">edit_note</mat-icon> How are you, {{ logDateLabel().toLowerCase() }}?
            @if (daySaving()) { <em class="ls__save">Saving…</em> }
            @else if (daySaved()) { <em class="ls__save is-ok">Saved</em> }
          </span>

          <!-- mood -->
          <span class="ls__sub">Mood</span>
          <div class="ls__chips">
            @for (m of moodChoices; track m.value) {
              <button type="button" class="ls__chip" [class.is-on]="editMood() === m.value"
                      (click)="toggleMood(m.value)">
                <span aria-hidden="true">{{ m.emoji }}</span> {{ m.label }}
              </button>
            }
          </div>

          <!-- flow -->
          <span class="ls__sub">Flow</span>
          <div class="ls__seg">
            @for (f of flowChoices; track f.value) {
              <button type="button" class="ls__seg-b" [class.is-on]="editFlow() === f.value"
                      (click)="selectFlow(f.value)">{{ f.label }}</button>
            }
          </div>

          <!-- symptoms -->
          <span class="ls__sub">Symptoms</span>
          <div class="ls__chips">
            @for (s of symptomChoices; track s) {
              <button type="button" class="ls__chip" [class.is-on]="isSymptomOn(s)"
                      (click)="toggleSymptom(s)">{{ s }}</button>
            }
          </div>

          <!-- energy -->
          <span class="ls__sub">Energy</span>
          <div class="ls__energy">
            @for (e of energyLevels; track e) {
              <button type="button" class="ls__dot" [class.is-on]="(editEnergy() ?? 0) >= e"
                      (click)="selectEnergy(e)" [attr.aria-label]="'Energy ' + e + ' of 5'"></button>
            }
          </div>

          <!-- intimacy (discreet) -->
          <button type="button" class="ls__toggle" [class.is-on]="editIntimacy()" (click)="toggleIntimacy()">
            <mat-icon aria-hidden="true">{{ editIntimacy() ? 'favorite' : 'favorite_border' }}</mat-icon>
            <span class="ls__toggle-txt">Intimacy</span>
            <span class="cy-switch" [class.is-on]="editIntimacy()" aria-hidden="true">
              <span class="cy-switch__knob"></span>
            </span>
          </button>
          @if (editIntimacy()) {
            <button type="button" class="ls__toggle ls__toggle--sub" [class.is-on]="editProtected() === true"
                    (click)="toggleProtected()">
              <mat-icon aria-hidden="true">shield</mat-icon>
              <span class="ls__toggle-txt">Protected</span>
              <span class="cy-switch" [class.is-on]="editProtected() === true" aria-hidden="true">
                <span class="cy-switch__knob"></span>
              </span>
            </button>
          }

          <!-- notes -->
          <label class="ls__field">
            <span class="ls__label">Notes</span>
            <textarea class="ls__input ls__area" rows="2" [ngModel]="editNotes()"
                      (ngModelChange)="onNotesChange($event)" name="dnotes"
                      placeholder="Anything to remember (private)"></textarea>
          </label>

          @if (hasDayLog()) {
            <button type="button" class="ls__clear" (click)="clearDay()">
              <mat-icon aria-hidden="true">delete_outline</mat-icon> Clear this day
            </button>
          }
        </div>

        <p class="ls__foot">
          <mat-icon aria-hidden="true">lock</mat-icon>
          Informational only — not medical advice. Your daily log is private to you.
        </p>
      </div>
    </app-bs-sheet>

    <app-bs-toaster />
  `,
  styleUrl: './cycle-mobile.page.scss',
})
export class CycleMobilePage implements OnDestroy {
  private api = inject(Api);
  private auth = inject(AuthService);
  private toast = inject(ToastController);

  // ---- page state ----
  readonly loading = signal(true);
  readonly errored = signal(false);
  readonly refreshing = signal(false);

  readonly periods = signal<CyclePeriod[]>([]);
  readonly prediction = signal<CyclePrediction | null>(null);
  readonly settings = signal<CycleSettings | null>(null);
  readonly dayLogsByDate = signal<Map<string, CycleDayLog>>(new Map());
  readonly note = signal<CycleNote | null>(null);

  // ---- log-entry sheet ----
  readonly logOpen = signal(false);

  // ---- "log a period" form ----
  readonly logStart = signal<string>(this.todayIso());
  readonly logEnd = signal<string>('');
  readonly logging = signal(false);

  // ---- family overlay opt-in ----
  readonly overlayBusy = signal(false);

  private readonly hasAi = computed(() => {
    this.auth.permissions();
    return this.auth.hasPermission(PERM.familyAi);
  });

  readonly monthStart = signal<Date>(this.firstOfMonth(new Date()));
  readonly today = this.todayIso();

  readonly overlayOn = computed<boolean>(() => this.settings()?.overlayToFamily === true);
  readonly avgCycle = computed<number>(() => this.prediction()?.avgCycleLengthDays ?? this.settings()?.avgCycleLengthDays ?? 28);

  /** A friendly phase label for the summary (deterministic; falls back gently). */
  readonly currentPhaseLabel = computed<string>(() => {
    const p = this.prediction()?.currentPhase?.trim();
    if (!p) return this.periods().length ? 'Tracking' : 'Not started yet';
    return p.charAt(0).toUpperCase() + p.slice(1);
  });

  /** A coarse tone key for the summary dot, derived from the phase label. */
  readonly phaseTone = computed<DayPhase>(() => {
    const p = (this.prediction()?.currentPhase ?? '').toLowerCase();
    if (p.includes('period') || p.includes('menstr')) return 'period';
    if (p.includes('fertile') || p.includes('ovul')) return 'fertile';
    return 'none';
  });

  readonly monthLabel = computed<string>(() =>
    this.monthStart().toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
  );

  readonly weekdayHeaders = computed<string[]>(() => {
    const labels: string[] = [];
    const sunday = new Date(2026, 0, 4); // a known Sunday
    for (let i = 0; i < 7; i++) {
      const d = new Date(sunday.getFullYear(), sunday.getMonth(), sunday.getDate() + i);
      labels.push(d.toLocaleDateString(undefined, { weekday: 'narrow' }));
    }
    return labels;
  });

  readonly cells = computed<CycleCell[]>(() => {
    const first = this.monthStart();
    const month = first.getMonth();
    const gridStart = this.sundayOf(first);

    const logged = this.loggedDays();
    const p = this.prediction();
    const predPeriod = this.predictedPeriodDays(p);
    const fertile = this.fertileDays(p);
    const logs = this.dayLogsByDate();

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
        hasLog: logs.has(iso),
      });
    }
    return out;
  });

  readonly nextPeriodLabel = computed<string>(() => {
    const next = this.prediction()?.nextPredictedStart;
    return next ? this.friendlyDate(next) : '';
  });

  readonly fertileLabel = computed<string>(() => {
    const w = this.prediction()?.fertileWindow;
    if (!w) return '';
    return `${this.shortDate(w.start)} – ${this.shortDate(w.end)}`;
  });

  readonly recentPeriods = computed(() =>
    this.periods().map((pr) => ({
      raw: pr,
      label: pr.endDate
        ? `${this.friendlyDate(pr.startDate)} – ${this.friendlyDate(pr.endDate)}`
        : `${this.friendlyDate(pr.startDate)} (start)`,
    })),
  );

  // ============================================================== daily log vocab

  readonly moodChoices: readonly MoodChoice[] = [
    { value: 'happy', label: 'Happy', emoji: '🙂' },
    { value: 'calm', label: 'Calm', emoji: '😌' },
    { value: 'energized', label: 'Energized', emoji: '⚡' },
    { value: 'irritable', label: 'Irritable', emoji: '😤' },
    { value: 'anxious', label: 'Anxious', emoji: '😟' },
    { value: 'sad', label: 'Sad', emoji: '😔' },
  ];

  readonly symptomChoices: readonly string[] = [
    'cramps', 'headache', 'bloating', 'fatigue', 'tender', 'acne', 'nausea', 'backache',
  ];

  readonly flowChoices: readonly FlowChoice[] = [
    { value: 0, label: 'None' },
    { value: 1, label: 'Spotting' },
    { value: 2, label: 'Light' },
    { value: 3, label: 'Medium' },
    { value: 4, label: 'Heavy' },
  ];

  readonly energyLevels: readonly number[] = [1, 2, 3, 4, 5];

  readonly logDate = signal<string>(this.todayIso());

  // ---- the live editor model (mirrors a CycleDayLog) ----
  readonly editMood = signal<string | null>(null);
  readonly editSymptoms = signal<Set<string>>(new Set());
  readonly editFlow = signal<CycleFlowLevel>(0);
  readonly editIntimacy = signal<boolean>(false);
  readonly editProtected = signal<boolean | null>(null);
  readonly editEnergy = signal<number | null>(null);
  readonly editNotes = signal<string>('');

  readonly daySaving = signal(false);
  readonly daySaved = signal(false);

  readonly hasDayLog = computed<boolean>(() => this.dayLogsByDate().has(this.logDate()));

  readonly logDateLabel = computed<string>(() =>
    this.logDate() === this.today ? 'Today' : this.friendlyDate(this.logDate()),
  );

  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private savedFlagTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    void this.reload();
  }

  ngOnDestroy(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    if (this.savedFlagTimer) clearTimeout(this.savedFlagTimer);
  }

  // ============================================================== loading

  async reload(): Promise<void> {
    const wasLoaded = !this.loading();
    if (wasLoaded) this.refreshing.set(true); else this.loading.set(true);
    this.errored.set(false);
    try {
      const data: CycleData = await firstValueFrom(this.api.cycleData());
      this.periods.set(data.periods);
      this.prediction.set(data.prediction);
      this.settings.set(data.settings);
      this.setDayLogs(data.dayLogs);
      this.loadDayIntoEditor(this.logDate());
    } catch {
      this.errored.set(true);
    } finally {
      this.loading.set(false);
      if (wasLoaded) {
        this.refreshing.set(false);
        if (!this.errored()) this.toast.show('Cycle refreshed', { tone: 'success', durationMs: 1600 });
      }
    }
    if (!this.errored() && this.hasAi()) void this.loadNote();
  }

  private async loadNote(): Promise<void> {
    try {
      this.note.set(await firstValueFrom(this.api.cycleNote()));
    } catch {
      this.note.set(null);
    }
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

  // ============================================================== log-entry sheet

  openLog(): void {
    this.selectLogDate(this.today);
    this.logOpen.set(true);
  }

  // ============================================================== log a period

  async logPeriod(): Promise<void> {
    if (this.logging()) return;
    const start = this.logStart();
    if (!start) {
      this.toast.show('Please choose a start date.', { tone: 'warn' });
      return;
    }
    const end = this.logEnd().trim();
    if (end && end < start) {
      this.toast.show('The end date must be on or after the start date.', { tone: 'warn' });
      return;
    }
    this.logging.set(true);
    try {
      await firstValueFrom(this.api.logPeriod(start, end || null));
      this.toast.show('Logged — predictions updated.', { tone: 'success', durationMs: 2000 });
      this.logEnd.set('');
      await this.refreshData();
    } catch (e) {
      this.toast.show(this.messageOf(e, "Couldn't log that — try again."), { tone: 'warn' });
    } finally {
      this.logging.set(false);
    }
  }

  /** Quietly re-fetch data after a mutation (no full-page spinner, no toast). */
  private async refreshData(): Promise<void> {
    try {
      const data = await firstValueFrom(this.api.cycleData());
      this.periods.set(data.periods);
      this.prediction.set(data.prediction);
      this.settings.set(data.settings);
      this.setDayLogs(data.dayLogs);
    } catch {
      this.toast.show("Couldn't refresh just now. Please try again.", { tone: 'warn' });
    }
    if (this.hasAi()) void this.loadNote();
  }

  /** A swipe-row commit on a recent period: left = remove. */
  onPeriodSwipe(pr: CyclePeriod, side: 'left' | 'right'): void {
    if (side === 'left') void this.deletePeriod(pr);
  }

  async deletePeriod(pr: CyclePeriod): Promise<void> {
    if (typeof confirm === 'function' &&
        !confirm('Remove this logged period? Your predictions will update.')) return;
    try {
      await firstValueFrom(this.api.deletePeriod(pr.id));
      await this.refreshData();
      this.toast.show('Period removed', { tone: 'success', durationMs: 1800 });
    } catch {
      this.toast.show("Couldn't remove that entry — try again.", { tone: 'warn' });
    }
  }

  // ============================================================== family-overlay opt-in

  async toggleOverlay(): Promise<void> {
    if (this.overlayBusy()) return;
    const next = !this.overlayOn();
    this.overlayBusy.set(true);
    try {
      const updated = await firstValueFrom(this.api.patchCycleSettings({ overlayToFamily: next }));
      this.settings.set(updated);
      this.toast.show(
        updated.overlayToFamily
          ? 'Your predicted phases will show on the family calendar.'
          : 'Sharing turned off — your predictions are private again.',
        { tone: 'success', durationMs: 2400 },
      );
    } catch (e) {
      this.toast.show(this.messageOf(e, "Couldn't update sharing — try again."), { tone: 'warn' });
    } finally {
      this.overlayBusy.set(false);
    }
  }

  // ============================================================== daily log handlers

  private setDayLogs(logs: CycleDayLog[]): void {
    const map = new Map<string, CycleDayLog>();
    for (const d of logs) map.set(d.date, d);
    this.dayLogsByDate.set(map);
  }

  prevDay(): void { this.shiftLogDate(-1); }
  nextDay(): void { this.shiftLogDate(1); }
  logToday(): void { this.selectLogDate(this.today); }

  private shiftLogDate(delta: number): void {
    const d = this.parseIso(this.logDate());
    if (!d) return;
    const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + delta);
    this.selectLogDate(this.toLocalDate(next));
  }

  selectLogDate(iso: string): void {
    if (iso === this.logDate()) return;
    this.flushPendingSave();
    this.logDate.set(iso);
    this.loadDayIntoEditor(iso);
  }

  /** Tap a calendar day → focus the editor on it and open the log sheet. */
  pickCalendarDay(iso: string): void {
    this.selectLogDate(iso);
    this.logOpen.set(true);
  }

  private loadDayIntoEditor(iso: string): void {
    const log = this.dayLogsByDate().get(iso);
    this.editMood.set(log?.mood ?? null);
    this.editSymptoms.set(new Set(log?.symptoms ?? []));
    this.editFlow.set(log?.flowLevel ?? 0);
    this.editIntimacy.set(log?.intimacy ?? false);
    this.editProtected.set(log?.intimacy ? (log.protected ?? null) : null);
    this.editEnergy.set(log?.energy ?? null);
    this.editNotes.set(log?.notes ?? '');
  }

  // ---- editor mutations (each schedules a debounced autosave) ----

  toggleMood(value: string): void {
    this.editMood.update((m) => (m === value ? null : value));
    this.scheduleSave();
  }

  toggleSymptom(value: string): void {
    this.editSymptoms.update((set) => {
      const next = new Set(set);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
    this.scheduleSave();
  }

  isSymptomOn(value: string): boolean {
    return this.editSymptoms().has(value);
  }

  selectFlow(value: CycleFlowLevel): void {
    this.editFlow.update((f) => (f === value ? 0 : value));
    this.scheduleSave();
  }

  toggleIntimacy(): void {
    this.editIntimacy.update((v) => !v);
    if (!this.editIntimacy()) this.editProtected.set(null);
    this.scheduleSave();
  }

  toggleProtected(): void {
    if (!this.editIntimacy()) return;
    this.editProtected.update((v) => (v === true ? false : true));
    this.scheduleSave();
  }

  selectEnergy(value: number): void {
    this.editEnergy.update((e) => (e === value ? null : value));
    this.scheduleSave();
  }

  onNotesChange(value: string): void {
    this.editNotes.set(value);
    this.scheduleSave();
  }

  private scheduleSave(): void {
    this.daySaved.set(false);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      void this.saveDay();
    }, 700);
  }

  private flushPendingSave(): void {
    if (!this.saveTimer) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    void this.saveDay();
  }

  private async saveDay(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const date = this.logDate();
    const intimacy = this.editIntimacy();
    const patch: CycleDayLogPatch = {
      date,
      mood: this.editMood(),
      symptoms: [...this.editSymptoms()],
      flowLevel: this.editFlow(),
      intimacy,
      protected: intimacy ? this.editProtected() : null,
      energy: this.editEnergy(),
      notes: this.editNotes().trim() || null,
    };
    this.daySaving.set(true);
    try {
      const saved = await firstValueFrom(this.api.upsertCycleDayLog(patch));
      this.dayLogsByDate.update((prev) => {
        const next = new Map(prev);
        next.set(saved.date, saved);
        return next;
      });
      this.daySaved.set(true);
      if (this.savedFlagTimer) clearTimeout(this.savedFlagTimer);
      this.savedFlagTimer = setTimeout(() => this.daySaved.set(false), 2200);
    } catch {
      this.toast.show("Couldn't save your log — try again.", { tone: 'warn' });
    } finally {
      this.daySaving.set(false);
    }
  }

  async clearDay(): Promise<void> {
    const date = this.logDate();
    if (!this.dayLogsByDate().has(date)) {
      this.loadDayIntoEditor(date);
      return;
    }
    if (typeof confirm === 'function' &&
        !confirm('Clear everything logged for this day? It only affects this one day.')) return;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    try {
      await firstValueFrom(this.api.deleteCycleDayLog(date));
      this.dayLogsByDate.update((prev) => {
        const next = new Map(prev);
        next.delete(date);
        return next;
      });
      this.loadDayIntoEditor(date);
      this.daySaved.set(false);
      this.toast.show('Day cleared', { tone: 'success', durationMs: 1600 });
    } catch {
      this.toast.show("Couldn't clear that day — try again.", { tone: 'warn' });
    }
  }

  // ============================================================== phase-day derivation

  private loggedDays(): Set<string> {
    const out = new Set<string>();
    for (const p of this.periods()) {
      for (const iso of this.daysBetween(p.startDate, p.endDate ?? p.startDate)) out.add(iso);
    }
    return out;
  }

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

  private fertileDays(p: CyclePrediction | null): Set<string> {
    const out = new Set<string>();
    const w = p?.fertileWindow;
    if (!w) return out;
    for (const iso of this.daysBetween(w.start, w.end)) out.add(iso);
    return out;
  }

  // ============================================================== date helpers (browser local zone)

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

  friendlyDate(iso: string): string {
    const d = this.parseIso(iso);
    return d
      ? d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
      : iso;
  }

  shortDate(iso: string): string {
    const d = this.parseIso(iso);
    return d ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : iso;
  }

  dayAria(c: CycleCell): string {
    const phase =
      c.phase === 'logged' ? ', logged period' :
      c.phase === 'period' ? ', predicted period' :
      c.phase === 'fertile' ? ', fertile window' : '';
    return `${this.friendlyDate(c.iso)}${phase}${c.hasLog ? ', has a daily log' : ''}. Tap to log.`;
  }

  private messageOf(e: unknown, fallback: string): string {
    const msg = (e as { error?: { message?: string } })?.error?.message;
    return typeof msg === 'string' && msg ? msg : fallback;
  }
}
