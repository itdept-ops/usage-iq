import {
  ChangeDetectionStrategy, Component, computed, inject, signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { MatIconModule } from '@angular/material/icon';

import { Api } from '../../core/api';
import { AuthService } from '../../core/auth';
import {
  CreateHabitRequest, HabitCadence, HabitDto, HabitLeaderboardRowDto, PERM, UpdateHabitRequest,
} from '../../core/models';
import {
  BetaPullRefresh, BetaSegmentedControl, BetaBottomSheet, BetaSkeleton, BetaFab,
  BetaToaster, ToastController, BetaEmptyState, BetaErrorState, type Segment,
} from '../beta-ui';

const CADENCE_INT: Record<HabitCadence, number> = { Daily: 0, Weekly: 1, CustomDaysOfWeek: 2, XTimesPerPeriod: 3 };
const AUTO_INT: Record<string, number> = { None: 0, Water: 2, Workout: 3 };
const AUTO_ICON: Record<string, string> = { None: 'task_alt', Water: 'local_drink', Workout: 'fitness_center' };

interface HabitDraft {
  id: number | null;
  title: string;
  cadence: HabitCadence;
  daysOfWeek: Set<number>;
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
    partialCredit: false, autoSource: 'None', color: '#10b981',
  };
}

/**
 * Habits — the mobile-first twin of the live `/habits` page (the generalised successor to /challenge),
 * rebuilt on the shared beta-ui "Strata" kit. One signature accent (an EMERALD → LIME ramp) re-skins the
 * screen via the per-page accent contract. A {@link BetaSegmentedControl} flips between HABITS (big tappable
 * habit cards with today's check/value, a current-streak flame, cadence + a quick complete/skip) and a
 * LEADERBOARD (the caller + sharing contacts ranked by best streak, names only — NEVER email). A FAB opens a
 * {@link BetaBottomSheet} create/edit sheet (cadence, optional measurable target, optional tracker auto-source).
 * Pull-to-refresh re-fetches; skeletons + elevated empty/error states round it out.
 *
 * DATA PARITY + PRIVACY: every figure flows through the SAME owner-scoped, tracker.self-gated `/api/habits`
 * endpoints the live page uses — {@link Api.habits}, {@link Api.upsertHabitDay}, {@link Api.createHabit} /
 * {@link Api.updateHabit} / {@link Api.deleteHabit}, and {@link Api.habitsLeaderboard}. The server computes
 * all day-math + the cadence-aware streak; this twin never re-derives anything. Crossing a day into complete
 * emits habit.dayComplete server-side carrying the STREAK only — never the private habit title.
 *
 * ISOLATION: gated by `platform.mobile` + the SAME tracker permissions the live `/habits` route carries; it
 * imports only the kit + the shared Api/models. No live page is imported or modified.
 */
@Component({
  selector: 'app-habits-mobile',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [ToastController],
  imports: [
    FormsModule, MatIconModule,
    BetaPullRefresh, BetaSegmentedControl, BetaBottomSheet, BetaSkeleton, BetaFab, BetaToaster,
    BetaEmptyState, BetaErrorState,
  ],
  template: `
    <app-bs-pull-refresh class="hm-ptr" [busy]="refreshing()" (refresh)="reload()">
      <div class="hm-scroll" aria-live="polite">

        <header class="hm-hero">
          <div class="hm-hero__bloom" aria-hidden="true"></div>
          <p class="hm-hero__kicker"><mat-icon aria-hidden="true">checklist</mat-icon> Habits</p>
          <h1 class="hm-hero__title">Build your streaks</h1>
          <p class="hm-hero__sub">Daily, weekly, certain days, or X times a period — at your own pace.</p>
          @if (!loading() && !errored() && habits().length) {
            <div class="hm-hero__stats">
              <span class="hm-hero__stat"><b class="mono-num">{{ bestStreak() }}</b><i>best streak</i></span>
              <span class="hm-hero__sep" aria-hidden="true"></span>
              <span class="hm-hero__stat"><b class="mono-num">{{ habits().length }}</b><i>habits</i></span>
              <span class="hm-hero__sep" aria-hidden="true"></span>
              <span class="hm-hero__stat"><b class="mono-num">{{ doneToday() }}</b><i>done today</i></span>
            </div>
          }
        </header>

        @if (loading()) {
          <div class="hm-card" aria-hidden="true"><app-bs-skeleton height="140px" radius="var(--r-tile)" /></div>
          <div class="hm-card" aria-hidden="true"><app-bs-skeleton height="140px" radius="var(--r-tile)" /></div>

        } @else if (errored()) {
          <app-bs-error
            icon="cloud_off"
            title="Couldn't load your habits"
            body="Pull to retry."
            (retry)="reload()" />

        } @else {
          <div class="hm-seg-wrap">
            <app-bs-segmented class="hm-seg" [segments]="tabs" [value]="tab()" label="Habits view" (change)="setTab($event)" />
          </div>

          @if (tab() === 'habits') {
            @if (habits().length) {
              <section class="hm-list">
                @for (h of habits(); track h.id; let i = $index) {
                  <article class="hm-hcard hm-reveal" [style.--hc-accent]="h.color || '#10b981'" [style.--ri]="i"
                           [class.is-paused]="h.status === 'Paused'">
                    <div class="hm-hcard__top">
                      <span class="hm-hcard__ic" aria-hidden="true"><mat-icon>{{ autoIcon[h.autoSource] || 'task_alt' }}</mat-icon></span>
                      <div class="hm-hcard__id">
                        <span class="hm-hcard__title">{{ h.title }}</span>
                        <span class="hm-hcard__cadence">{{ cadenceLabel(h) }}</span>
                      </div>
                      <button type="button" class="hm-hcard__edit" (click)="openEdit(h)" aria-label="Edit habit"><mat-icon aria-hidden="true">edit</mat-icon></button>
                    </div>

                    <div class="hm-hcard__streak">
                      <mat-icon class="hm-hcard__flame" aria-hidden="true">local_fire_department</mat-icon>
                      <span class="hm-hcard__n mono-num">{{ h.currentStreak }}</span>
                      <span class="hm-hcard__l">day streak · best {{ h.longestStreak }}</span>
                    </div>

                    @if (isMeasurable(h)) {
                      <div class="hm-hcard__bar" aria-hidden="true"><span class="hm-hcard__bar-fill" [style.width.%]="progressPct(h)"></span></div>
                      <span class="hm-hcard__measured">{{ measurableLabel(h) }}</span>
                    }

                    <div class="hm-hcard__actions">
                      <button type="button" class="hm-hcard__check" [class.is-on]="h.today.complete" (click)="toggleToday(h)"
                              [attr.aria-pressed]="h.today.complete">
                        <mat-icon aria-hidden="true">{{ h.today.complete ? 'check_circle' : 'radio_button_unchecked' }}</mat-icon>
                        {{ h.today.complete ? 'Done today' : 'Mark done' }}
                      </button>
                      <button type="button" class="hm-hcard__skip" [class.is-on]="h.today.skip" (click)="toggleSkip(h)">
                        {{ h.today.skip ? 'Skipped' : 'Skip' }}
                      </button>
                    </div>
                  </article>
                }
              </section>
            } @else {
              <app-bs-empty
                icon="checklist"
                title="No habits yet"
                body="Tap + to create your first one." />
            }
          } @else {
            <section class="hm-board">
              @if (leaderboard().length <= 1) {
                <app-bs-empty
                  icon="leaderboard"
                  title="No one on the board yet"
                  body="Share your tracker with contacts to compare." />
              } @else {
                @for (row of leaderboard(); track row.userId; let i = $index) {
                  <div class="hm-row hm-reveal" [class.is-self]="row.isSelf" [style.--ri]="i">
                    <span class="hm-row__rank" [attr.data-medal]="i < 3 ? i + 1 : null">{{ i + 1 }}</span>
                    <span class="hm-row__avatar" aria-hidden="true">
                      @if (row.picture) { <img [src]="row.picture" alt="" referrerpolicy="no-referrer" /> }
                      @else { {{ initials(row.name) }} }
                    </span>
                    <span class="hm-row__body">
                      <span class="hm-row__name">{{ row.name }} @if (row.isSelf) { <i class="hm-row__you">you</i> }</span>
                      <span class="hm-row__sub">{{ row.totalCompletions }} done · {{ row.activeHabits }} habits</span>
                    </span>
                    <span class="hm-row__pts"><mat-icon aria-hidden="true">local_fire_department</mat-icon><b class="mono-num">{{ row.bestStreak }}</b></span>
                  </div>
                }
              }
              <p class="hm-foot" aria-hidden="true">You &amp; the contacts who share their tracker · ranked by best streak</p>
            </section>
          }
        }
      </div>
    </app-bs-pull-refresh>

    @if (!loading() && !errored() && tab() === 'habits') {
      <app-bs-fab icon="add" label="New habit" [extended]="true" [fixed]="true" (action)="openCreate()" />
    }

    <!-- CREATE / EDIT SHEET -->
    <app-bs-sheet [(open)]="sheetOpen" detent="full" [dismissable]="!saving()" label="Habit editor">
      <div class="hs">
        <div class="hs__head">
          <h3 class="hs__title">{{ draft().id == null ? 'New habit' : 'Edit habit' }}</h3>
          <button type="button" class="hs__close" (click)="sheetOpen.set(false)" aria-label="Close" [disabled]="saving()"><mat-icon aria-hidden="true">close</mat-icon></button>
        </div>

        <label class="hs__field">
          <span class="hs__label">Title</span>
          <input class="hs__input" [ngModel]="draft().title" (ngModelChange)="patchDraft({ title: $event })" name="htitle" maxlength="120" placeholder="e.g. Read 20 minutes" />
        </label>

        <span class="hs__sub">Cadence</span>
        <div class="hs__chips">
          @for (c of cadenceOptions; track c.value) {
            <button type="button" class="hs__chip" [class.is-on]="draft().cadence === c.value" (click)="patchDraft({ cadence: c.value })">{{ c.label }}</button>
          }
        </div>

        @if (draft().cadence === 'CustomDaysOfWeek') {
          <span class="hs__sub">On which days?</span>
          <div class="hs__dows">
            @for (d of weekdayLabels; track $index) {
              <button type="button" class="hs__dow" [class.is-on]="isDraftDayOn($index)" (click)="toggleDraftDay($index)">{{ d }}</button>
            }
          </div>
        }
        @if (draft().cadence === 'XTimesPerPeriod') {
          <div class="hs__row">
            <label class="hs__field"><span class="hs__label">Times</span><input class="hs__input" type="number" min="1" [ngModel]="draft().timesPerPeriod" (ngModelChange)="patchDraft({ timesPerPeriod: $event })" name="htimes" /></label>
            <label class="hs__field"><span class="hs__label">Per (days)</span><input class="hs__input" type="number" min="1" [ngModel]="draft().periodDays" (ngModelChange)="patchDraft({ periodDays: $event })" name="hperiod" /></label>
          </div>
        }

        <span class="hs__sub">Track from</span>
        <div class="hs__chips">
          @for (a of autoOptions; track a.value) {
            <button type="button" class="hs__chip" [class.is-on]="draft().autoSource === a.value" (click)="patchDraft({ autoSource: a.value })">{{ a.label }}</button>
          }
        </div>

        @if (draft().autoSource === 'None') {
          <button type="button" class="hs__toggle" [class.is-on]="draft().measurable" (click)="patchDraft({ measurable: !draft().measurable })">
            <mat-icon aria-hidden="true">{{ draft().measurable ? 'check_box' : 'check_box_outline_blank' }}</mat-icon>
            <span class="hs__toggle-txt">Measurable (a number, not just done/not)</span>
          </button>
        }
        @if (draft().measurable || draft().autoSource !== 'None') {
          <div class="hs__row">
            <label class="hs__field"><span class="hs__label">Target</span><input class="hs__input" type="number" min="0.01" [ngModel]="draft().targetValue" (ngModelChange)="patchDraft({ targetValue: $event })" name="htarget" /></label>
            <label class="hs__field"><span class="hs__label">Unit</span><input class="hs__input" [ngModel]="draft().unit" (ngModelChange)="patchDraft({ unit: $event })" name="hunit" maxlength="32" placeholder="min / ml" /></label>
          </div>
        }

        <span class="hs__sub">Colour</span>
        <div class="hs__colors">
          @for (col of colorOptions; track col) {
            <button type="button" class="hs__color" [class.is-on]="draft().color === col" [style.background]="col" (click)="patchDraft({ color: col })" [attr.aria-label]="'Colour ' + col"></button>
          }
        </div>

        <button type="button" class="hs__save" [disabled]="saving()" (click)="saveDraft()">
          @if (saving()) { <span class="hs__spin" aria-hidden="true"></span> Saving… }
          @else { <mat-icon aria-hidden="true">check</mat-icon> {{ draft().id == null ? 'Create habit' : 'Save changes' }} }
        </button>
        @if (draft().id != null) {
          <button type="button" class="hs__archive" (click)="archiveHabit()"><mat-icon aria-hidden="true">archive</mat-icon> Archive habit</button>
        }
      </div>
    </app-bs-sheet>

    <app-bs-toaster />
  `,
  styleUrl: './habits-mobile.page.scss',
})
export class HabitsMobilePage {
  private api = inject(Api);
  private auth = inject(AuthService);
  private toast = inject(ToastController);

  readonly autoIcon = AUTO_ICON;

  readonly loading = signal(true);
  readonly errored = signal(false);
  readonly refreshing = signal(false);

  readonly habits = signal<HabitDto[]>([]);
  readonly leaderboard = signal<HabitLeaderboardRowDto[]>([]);

  readonly tabs: Segment[] = [
    { key: 'habits', label: 'Habits' },
    { key: 'board', label: 'Leaders' },
  ];
  readonly tab = signal<'habits' | 'board'>('habits');

  readonly sheetOpen = signal(false);
  readonly draft = signal<HabitDraft>(emptyDraft());
  readonly saving = signal(false);

  readonly weekdayLabels: readonly string[] = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  readonly cadenceOptions: readonly { value: HabitCadence; label: string }[] = [
    { value: 'Daily', label: 'Every day' },
    { value: 'CustomDaysOfWeek', label: 'Certain days' },
    { value: 'Weekly', label: 'Weekly' },
    { value: 'XTimesPerPeriod', label: 'X / period' },
  ];
  readonly autoOptions: readonly { value: 'None' | 'Water' | 'Workout'; label: string }[] = [
    { value: 'None', label: 'Manual' },
    { value: 'Water', label: 'Water' },
    { value: 'Workout', label: 'Workout' },
  ];
  readonly colorOptions: readonly string[] = ['#10b981', '#6366f1', '#ef5b34', '#d946ef', '#0ea5e9', '#f59e0b'];

  readonly today = this.todayIso();

  readonly bestStreak = computed(() => this.habits().reduce((m, h) => Math.max(m, h.currentStreak), 0));
  readonly doneToday = computed(() => this.habits().filter((h) => h.today.complete).length);

  constructor() {
    void this.reload();
  }

  setTab(v: string): void {
    this.tab.set(v === 'board' ? 'board' : 'habits');
  }

  async reload(): Promise<void> {
    const wasLoaded = !this.loading();
    if (wasLoaded) this.refreshing.set(true); else this.loading.set(true);
    this.errored.set(false);
    try {
      this.habits.set(await firstValueFrom(this.api.habits()));
    } catch {
      this.errored.set(true);
    } finally {
      this.loading.set(false);
      if (wasLoaded) {
        this.refreshing.set(false);
        if (!this.errored()) this.toast.show('Habits refreshed', { tone: 'success', durationMs: 1600 });
      }
    }
    if (!this.errored()) void this.loadLeaderboard();
  }

  private async loadLeaderboard(): Promise<void> {
    try { this.leaderboard.set(await firstValueFrom(this.api.habitsLeaderboard())); } catch { /* best-effort */ }
  }

  // ---- today check / skip ----

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

  private async commitDay(h: HabitDto, body: { date: string; value?: number; done?: boolean; skip?: boolean }): Promise<void> {
    try {
      await firstValueFrom(this.api.upsertHabitDay(h.id, body));
      this.habits.set(await firstValueFrom(this.api.habits()));
      void this.loadLeaderboard();
    } catch {
      this.toast.show("Couldn't save — try again.", { tone: 'warn' });
    }
  }

  // ---- create / edit sheet ----

  openCreate(): void { this.draft.set(emptyDraft()); this.sheetOpen.set(true); }
  openEdit(h: HabitDto): void {
    this.draft.set({
      id: h.id, title: h.title, cadence: h.cadence, daysOfWeek: this.maskToDays(h.daysOfWeekMask),
      timesPerPeriod: h.timesPerPeriod, periodDays: h.periodDays, measurable: h.targetValue != null,
      targetValue: h.targetValue ?? 10, unit: h.unit, partialCredit: h.partialCredit,
      autoSource: h.autoSource, color: h.color || '#10b981',
    });
    this.sheetOpen.set(true);
  }

  patchDraft(patch: Partial<HabitDraft>): void { this.draft.update((d) => ({ ...d, ...patch })); }
  toggleDraftDay(day: number): void {
    this.draft.update((d) => { const n = new Set(d.daysOfWeek); n.has(day) ? n.delete(day) : n.add(day); return { ...d, daysOfWeek: n }; });
  }
  isDraftDayOn(day: number): boolean { return this.draft().daysOfWeek.has(day); }

  async saveDraft(): Promise<void> {
    if (this.saving()) return;
    const d = this.draft();
    const title = d.title.trim();
    if (!title) { this.toast.show('Give your habit a name first.', { tone: 'warn' }); return; }
    this.saving.set(true);
    try {
      const base = {
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
      if (d.id == null) {
        await firstValueFrom(this.api.createHabit(base as CreateHabitRequest));
        this.toast.show('Habit created.', { tone: 'success', durationMs: 1800 });
      } else {
        await firstValueFrom(this.api.updateHabit(d.id, base as UpdateHabitRequest));
        this.toast.show('Habit updated.', { tone: 'success', durationMs: 1800 });
      }
      this.sheetOpen.set(false);
      this.habits.set(await firstValueFrom(this.api.habits()));
      void this.loadLeaderboard();
    } catch (e) {
      this.toast.show(this.messageOf(e, 'Could not save that habit.'), { tone: 'warn' });
    } finally {
      this.saving.set(false);
    }
  }

  async archiveHabit(): Promise<void> {
    const id = this.draft().id;
    if (id == null) return;
    if (typeof confirm === 'function' && !confirm('Archive this habit? It leaves your active grid.')) return;
    try {
      await firstValueFrom(this.api.deleteHabit(id));
      this.sheetOpen.set(false);
      this.toast.show('Habit archived.', { tone: 'success', durationMs: 1800 });
      this.habits.set(await firstValueFrom(this.api.habits()));
      void this.loadLeaderboard();
    } catch {
      this.toast.show("Couldn't archive that habit.", { tone: 'warn' });
    }
  }

  // ---- helpers ----

  cadenceLabel(h: HabitDto): string {
    switch (h.cadence) {
      case 'Daily': return 'Every day';
      case 'Weekly': return 'Weekly';
      case 'CustomDaysOfWeek': return this.maskLabel(h.daysOfWeekMask);
      case 'XTimesPerPeriod': return `${h.timesPerPeriod}× / ${h.periodDays}d`;
      default: return h.cadence;
    }
  }
  isMeasurable(h: HabitDto): boolean { return h.targetValue != null; }
  progressPct(h: HabitDto): number { return Math.round(Math.min(1, Math.max(0, h.today.progress)) * 100); }
  measurableLabel(h: HabitDto): string {
    if (h.targetValue == null) return '';
    return `${this.fmt(h.today.value ?? 0)} / ${this.fmt(h.targetValue)}${h.unit ? ' ' + h.unit : ''}`;
  }
  initials(name: string): string {
    const parts = (name || '').split(/[\s@.]+/).filter(Boolean);
    return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || 'U';
  }
  fmt(n: number): string { return Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, ''); }

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
    return out.length ? out.join(', ') : 'No days';
  }
  private toLocalDate(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  private todayIso(): string { return this.toLocalDate(new Date()); }
  private messageOf(e: unknown, fallback: string): string {
    const msg = (e as { error?: { message?: string } })?.error?.message;
    return typeof msg === 'string' && msg ? msg : fallback;
  }
}
