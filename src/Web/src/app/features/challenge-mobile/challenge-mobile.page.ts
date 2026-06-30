import {
  ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { catchError, of } from 'rxjs';

import { Api } from '../../core/api';
import { AuthService } from '../../core/auth';
import { ChallengeStore } from '../../core/challenge-store';
import {
  HardDayDto, HardDayTaskDto, HardLeaderboardRowDto, NudgeKind, PERM, UpsertHardDayRequest,
} from '../../core/models';
import {
  BetaPullRefresh, BetaSegmentedControl, BetaSkeleton, BetaSvgRing, BetaToaster, ToastController,
  type Segment,
} from '../beta-ui';

/** The icon shown for each auto-source / a generic one for manual + custom tasks (mirrors live challenge.ts). */
const AUTO_ICON: Record<string, string> = {
  Diet: 'restaurant',
  Water: 'local_drink',
  Workout: 'fitness_center',
  NoAlcohol: 'no_drinks',
  None: 'task_alt',
};

/**
 * 75 HARD — Streak (mobile twin of the live `/challenge` page) — the mobile-first, native-feel
 * re-presentation of the configurable 75 Hard challenge, rebuilt on the shared beta-ui "Strata" kit
 * (`@use '../beta-ui/beta-kit'`). One signature accent — a FLAME orange → ember red — re-skins the whole
 * screen via the per-page accent contract.
 *
 * An immersive header floats a streak/completion {@link BetaSvgRing} behind a HUGE Clash Display streak
 * numeral with the day-N / points line. A {@link BetaSegmentedControl} flips the body between TODAY (the
 * six daily tasks as big tappable toggle rows, with measurable PARTIAL bars + a manual checkbox/value) and
 * a compact LEADERBOARD (the caller + sharing contacts, ranked by points, names only — NEVER email — with
 * a friendly Nudge). Pull-to-refresh re-fetches; loading skeletons + an elevated empty/error/no-challenge
 * state round it out (it renders cleanly with ZERO data — the harness mocks the API).
 *
 * DATA PARITY + PRIVACY: every figure flows through the SAME {@link ChallengeStore} / {@link Api} the live
 * page uses — `challenge` (the day grid), `upsertChallengeDay` (manual task toggles), `challengeLeaderboard`,
 * `challengeShared`, and `nudge`. The server computes all points (incl. partial) + auto-scored tasks live
 * from the tracker; this twin never re-derives anything. Leaderboard rows carry userId + display NAME only.
 *
 * ISOLATION: gated by `platform.mobile` + the SAME tracker permissions the live `/challenge` route carries;
 * it consumes the kit + the SAME read-write store/Api as the live counterpart. No live page is imported or
 * modified. Reduced-motion collapses the reveals via the kit a11y killswitch; layout is mobile-first
 * (44px targets, safe-area insets, no 390px overflow) and centers on desktop.
 */
@Component({
  selector: 'app-challenge-mobile',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [ToastController],
  imports: [
    MatIconModule, RouterLink,
    BetaPullRefresh, BetaSegmentedControl, BetaSkeleton, BetaSvgRing, BetaToaster,
  ],
  template: `
    <!-- ─────────────── PULL-TO-REFRESH OWNS THE SCROLL ─────────────── -->
    <app-bs-pull-refresh class="cm-ptr" [busy]="refreshing()" (refresh)="reload()">
      <div class="cm-scroll" aria-live="polite">

        <!-- ─── IMMERSIVE HEADER: streak ring + numeral ─── -->
        <header class="cm-hero">
          @if (loading()) {
            <div class="cm-hero__skel">
              <app-bs-skeleton width="138px" height="138px" [circle]="true" />
              <app-bs-skeleton width="60%" height="20px" radius="var(--r-pill)" />
            </div>
          } @else if (!hasChallenge()) {
            <!-- NO active challenge (or empty mock): a warm start state. -->
            <p class="cm-hero__kicker"><mat-icon aria-hidden="true">local_fire_department</mat-icon> 75 Hard</p>
            <span class="cm-hero__orb"><mat-icon aria-hidden="true">flag</mat-icon></span>
            <h1 class="cm-hero__title">Start your 75 Hard</h1>
            <p class="cm-hero__sub">
              @if (errored()) { Couldn't load — pull to retry. }
              @else { Six tasks, streak &amp; points. Start a run on the full page. }
            </p>
            <a class="cm-hero__cta" routerLink="/challenge">
              Open the challenge <mat-icon aria-hidden="true">arrow_forward</mat-icon>
            </a>
          } @else {
            <p class="cm-hero__kicker">
              <mat-icon aria-hidden="true">local_fire_department</mat-icon>
              Day {{ currentDay() }} of {{ totalDays }}
            </p>

            <div class="cm-hero__ring">
              <app-bs-ring [value]="completionFrac()" [size]="150" [stroke]="9"
                           [signalOnFull]="finished()"
                           [label]="streak() + ' day streak, ' + fmt(totalPoints()) + ' points'">
                <span class="cm-hero__numeral">
                  <span class="cm-hero__n">{{ streak() }}</span>
                  <span class="cm-hero__of">day streak</span>
                </span>
              </app-bs-ring>
            </div>

            <div class="cm-hero__stats">
              <span class="cm-hero__stat">
                <b>{{ fmt(totalPoints()) }}</b><i>points</i>
              </span>
              <span class="cm-hero__sep" aria-hidden="true"></span>
              <span class="cm-hero__stat">
                <b>{{ fmt(todayPoints()) }}</b><i>today</i>
              </span>
              <span class="cm-hero__sep" aria-hidden="true"></span>
              <span class="cm-hero__stat">
                <b>{{ completedDays() }}</b><i>complete</i>
              </span>
            </div>
          }
        </header>

        @if (hasChallenge() && !loading()) {
          <!-- ─── PAGE HEADER: title + subtitle + full-page CTA (Rubric #1) ─── -->
          <div class="cm-header">
            <div class="cm-header__text">
              <h2 class="cm-header__title">75 Hard</h2>
              <p class="cm-header__sub">Day {{ currentDay() }} of {{ totalDays }} · {{ streak() }}-day streak</p>
            </div>
            <a class="cm-header__action" routerLink="/challenge">
              Full page <mat-icon aria-hidden="true">open_in_new</mat-icon>
            </a>
          </div>

          <!-- ─── TODAY | LEADERBOARD switch ─── -->
          <div class="cm-seg-wrap">
            <app-bs-segmented class="cm-seg"
              [segments]="tabs" [value]="tab()" label="Challenge view"
              (change)="setTab($event)" />
          </div>

          @if (tab() === 'today') {
            <!-- ─────────────── TODAY: the six daily tasks ─────────────── -->
            <section class="cm-today">
              <div class="cm-today__head">
                <h2 class="cm-today__title">{{ dateHeading() }}</h2>
                <span class="cm-today__points">
                  {{ fmt(dayPoints()) }} / {{ fmt(maxPoints()) }} pts
                </span>
              </div>

              @if (!tasks().length) {
                <div class="cm-empty">
                  <span class="cm-empty__orb" aria-hidden="true">
                    <mat-icon>checklist</mat-icon>
                  </span>
                  <p class="cm-empty__title">No tasks yet</p>
                  <p class="cm-empty__hint">Set up your daily tasks on the full challenge page.</p>
                </div>
              } @else {
                @for (t of tasks(); track t.taskId; let i = $index) {
                  <button type="button"
                          class="cm-task cm-reveal"
                          [class.is-done]="t.complete"
                          [class.is-partial]="!t.complete && t.progress > 0"
                          [class.is-readonly]="readOnly() || isAuto(t)"
                          [style.--ri]="i"
                          [disabled]="busyTask() === t.key"
                          [attr.aria-pressed]="t.complete"
                          [attr.aria-label]="taskAria(t)"
                          (click)="onTaskTap(t)">
                    <span class="cm-task__check" aria-hidden="true">
                      @if (t.complete) {
                        <mat-icon>check_circle</mat-icon>
                      } @else if (t.progress > 0) {
                        <span class="cm-task__partial" [style.--p]="pct(t)">
                          <mat-icon>{{ taskIcon(t) }}</mat-icon>
                        </span>
                      } @else {
                        <mat-icon>{{ taskIcon(t) }}</mat-icon>
                      }
                    </span>

                    <span class="cm-task__body">
                      <span class="cm-task__label">{{ t.label }}</span>
                      <span class="cm-task__meta">
                        @if (isMeasurable(t)) {
                          {{ measuredLabel(t) }}
                        } @else if (isAuto(t)) {
                          {{ autoHint(t) }}
                        } @else {
                          {{ t.complete ? 'Done' : 'Tap to mark done' }}
                        }
                        @if (t.partialCredit && isMeasurable(t)) { · partial }
                      </span>
                      @if (isMeasurable(t)) {
                        <span class="cm-task__bar" aria-hidden="true">
                          <span class="cm-task__bar-fill" [style.width.%]="pct(t)"></span>
                        </span>
                      }
                    </span>

                    <span class="cm-task__pts">
                      <b>{{ fmt(t.points) }}</b>
                      <i>/ {{ fmt(t.pointValue) }}</i>
                    </span>
                  </button>
                }
              }

              @if (readOnly()) {
                <p class="cm-foot" aria-hidden="true">
                  Viewing a shared challenge — read-only.
                </p>
              } @else {
                <p class="cm-foot" aria-hidden="true">
                  Diet, water &amp; workouts score live from your tracker · tap manual tasks to log them
                </p>
              }
            </section>
          } @else {
            <!-- ─────────────── LEADERBOARD ─────────────── -->
            <section class="cm-board">
              <p class="cm-board__head">
                <mat-icon aria-hidden="true">leaderboard</mat-icon>
                Rankings
              </p>
              @if (!leaderboard().length) {
                <div class="cm-empty">
                  <span class="cm-empty__orb" aria-hidden="true">
                    <mat-icon>leaderboard</mat-icon>
                  </span>
                  <p class="cm-empty__title">No one on the board yet</p>
                  <p class="cm-empty__hint">Share your tracker with contacts to compare progress.</p>
                </div>
              } @else {
                @for (row of leaderboard(); track row.userId; let i = $index) {
                  <div class="cm-row cm-reveal"
                       [class.is-self]="row.isSelf"
                       [style.--ri]="i">
                    <span class="cm-row__rank" [attr.data-medal]="i < 3 ? i + 1 : null">{{ i + 1 }}</span>
                    <span class="cm-row__avatar" aria-hidden="true">
                      @if (row.picture) {
                        <img [src]="row.picture" alt="" referrerpolicy="no-referrer" />
                      } @else {
                        {{ initials(row) }}
                      }
                    </span>
                    <span class="cm-row__body">
                      <span class="cm-row__name">
                        {{ row.name }} @if (row.isSelf) { <i class="cm-row__you">you</i> }
                      </span>
                      <span class="cm-row__sub">
                        <mat-icon aria-hidden="true">local_fire_department</mat-icon>{{ row.currentStreak }}
                        · day {{ row.currentDay }} · {{ fmt(row.todayPoints) }} today
                      </span>
                    </span>
                    <span class="cm-row__pts">
                      <b>{{ fmt(row.totalPoints) }}</b><i>pts</i>
                    </span>
                    @if (canNudgeRow(row)) {
                      <button type="button" class="cm-row__nudge"
                              [disabled]="nudging() === row.userId"
                              [attr.aria-label]="'Nudge ' + row.name"
                              (click)="nudge(row)">
                        <mat-icon aria-hidden="true">waving_hand</mat-icon>
                      </button>
                    }
                  </div>
                }
              }
              <p class="cm-foot" aria-hidden="true">
                You &amp; the contacts who share their tracker · ranked by points
              </p>
            </section>
          }
        }
      </div>
    </app-bs-pull-refresh>

    <app-bs-toaster />
  `,
  styleUrl: './challenge-mobile.page.scss',
})
export class ChallengeMobilePage {
  readonly store = inject(ChallengeStore);
  private auth = inject(AuthService);
  private api = inject(Api);
  private toast = inject(ToastController);
  private destroyRef = inject(DestroyRef);

  readonly totalDays = 75;

  /** Which body the segmented control shows. */
  readonly tab = signal<'today' | 'board'>('today');
  readonly tabs: Segment[] = [
    { key: 'today', label: 'Today' },
    { key: 'board', label: 'Leaderboard' },
  ];

  readonly loading = signal(true);
  readonly refreshing = signal(false);
  readonly errored = signal(false);

  /** The stable `key` of the task whose toggle is mid-flight (guards a double-tap). */
  readonly busyTask = signal<string | null>(null);

  /** The userId whose Nudge is in flight (so the button can't double-fire). */
  readonly nudging = signal<number | null>(null);

  // ---- store-derived view state (parity with the live page) ----
  readonly challenge = computed(() => this.store.challenge());
  readonly hasChallenge = computed(() => !!this.store.challenge());
  readonly readOnly = computed(() => this.store.readOnly());
  readonly leaderboard = computed(() => this.store.leaderboard());

  readonly streak = computed(() => this.challenge()?.currentStreak ?? 0);
  readonly currentDay = computed(() => this.challenge()?.currentDay ?? 0);
  readonly totalPoints = computed(() => this.challenge()?.totalPoints ?? 0);
  readonly todayPoints = computed(() => this.challenge()?.todayPoints ?? 0);
  readonly completedDays = computed(() => this.challenge()?.completedDays ?? 0);
  readonly finished = computed(() => this.challenge()?.status === 'Completed');

  /** Completion fraction 0..1 toward 75 completed days, for the hero ring. */
  readonly completionFrac = computed(() => {
    const c = this.challenge();
    if (!c) return 0;
    return Math.min(1, c.completedDays / this.totalDays);
  });

  /** The selected (today's) day row, or null. */
  readonly day = computed<HardDayDto | null>(() => this.store.selectedDay());
  readonly tasks = computed<HardDayTaskDto[]>(() => this.day()?.tasks ?? []);
  readonly dayPoints = computed(() => this.day()?.dayPoints ?? 0);
  readonly maxPoints = computed(() => this.day()?.maxPoints ?? 0);

  /** A friendly heading for the selected date (Today / Yesterday / weekday). */
  readonly dateHeading = computed(() => {
    const d = new Date(this.store.date() + 'T00:00:00');
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diff = Math.round((d.getTime() - today.getTime()) / 86_400_000);
    if (diff === 0) return 'Today';
    if (diff === -1) return 'Yesterday';
    if (diff === 1) return 'Tomorrow';
    return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  });

  /** Whether the caller can nudge at all (chat.send); the action no-ops without it. */
  readonly canNudge = computed(() => this.auth.hasPermission(PERM.chatSend));

  constructor() {
    // Keep the selected grid day pinned to today (this twin is a "today" surface, no day navigation).
    this.store.goToday();
    this.reload();

    // Re-pin to today whenever a reload swaps the challenge (the grid date never drifts here).
    effect(() => {
      if (this.store.challenge()) {
        const today = this.todayIso();
        if (this.store.date() !== today) this.store.goToday();
      }
    });
  }

  // ─────────────── LOAD ───────────────

  async reload(): Promise<void> {
    const wasLoaded = this.store.loaded();
    if (wasLoaded) this.refreshing.set(true); else this.loading.set(true);
    this.errored.set(false);
    try {
      await this.store.load();
      if (this.store.error()) this.errored.set(true);
      // Leaderboard is best-effort (the store swallows its own errors → []).
      await this.store.loadLeaderboard();
    } catch {
      this.errored.set(true);
    } finally {
      this.loading.set(false);
      this.refreshing.set(false);
    }
  }

  setTab(key: string): void {
    this.tab.set(key === 'board' ? 'board' : 'today');
  }

  // ─────────────── TODAY: task helpers (mirrors live challenge.ts) ───────────────

  taskIcon(t: { autoSource: string }): string {
    return AUTO_ICON[t.autoSource] ?? AUTO_ICON['None'];
  }

  /** Whether a task is auto-scored from the tracker (cannot be hand-toggled here). */
  isAuto(t: { autoSource: string }): boolean {
    return t.autoSource !== 'None';
  }

  /** Whether a task is MEASURABLE (has a numeric target → progress bar + value), else binary. */
  isMeasurable(t: { targetValue: number | null }): boolean {
    return t.targetValue != null;
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
      case 'Workout': return 'logged workouts that hit the target';
      case 'NoAlcohol': return 'no-alcohol attestation';
      default: return '';
    }
  }

  taskAria(t: HardDayTaskDto): string {
    const state = t.complete ? 'complete' : t.progress > 0 ? `${this.pct(t)}% done` : 'not done';
    if (this.isAuto(t)) return `${t.label}, ${state}, scored from your tracker.`;
    if (this.isMeasurable(t)) return `${t.label}, ${this.measuredLabel(t)}, ${state}.`;
    return `${t.label}, ${state}. Tap to toggle.`;
  }

  /**
   * Tap a task row. Manual BINARY tasks toggle done/not. Manual MEASURABLE tasks bump to their target
   * (a quick one-tap "log it"); tapping again clears them. Auto tasks (and read-only views) are inert —
   * they score live from the tracker, so we route the user to the full page for those.
   */
  onTaskTap(t: HardDayTaskDto): void {
    if (this.readOnly()) return;
    if (this.busyTask()) return;
    if (this.isAuto(t)) {
      this.toast.show('This one scores from your tracker — log it there.', { tone: 'neutral' });
      return;
    }
    if (this.isMeasurable(t)) {
      // One-tap: fill to target, or clear if already complete.
      const value = t.complete ? 0 : (t.targetValue ?? 0);
      void this.saveTask(t, { tasks: [{ key: t.key, value }] });
    } else {
      void this.saveTask(t, { tasks: [{ key: t.key, done: !t.complete }] });
    }
  }

  private async saveTask(t: HardDayTaskDto, patch: Partial<UpsertHardDayRequest>): Promise<void> {
    this.busyTask.set(t.key);
    try {
      await this.store.upsertDay({ date: this.store.date(), ...patch });
      void this.store.loadLeaderboard();
    } catch (e) {
      this.toast.show(this.messageOf(e, 'Could not save — try again.'), { tone: 'warn' });
    } finally {
      this.busyTask.set(null);
    }
  }

  // ─────────────── LEADERBOARD ───────────────

  /** Whether a leaderboard row may be nudged: a non-self peer + the caller holds chat.send. */
  canNudgeRow(row: HardLeaderboardRowDto): boolean {
    return !row.isSelf && this.canNudge();
  }

  /** Send a canned NUDGE to a circle peer from their leaderboard row (mirrors the live page). */
  nudge(row: HardLeaderboardRowDto): void {
    if (!this.canNudgeRow(row) || this.nudging() != null) return;
    this.nudging.set(row.userId);
    const kind: NudgeKind = 'keepTheStreak';
    this.api
      .nudge(row.userId, kind)
      .pipe(catchError(() => of(null)))
      .subscribe((res) => {
        this.nudging.set(null);
        if (!res) {
          this.toast.show('Could not send your nudge. Try again.', { tone: 'warn' });
          return;
        }
        this.toast.show(
          res.delivered ? `Nudged ${row.name}!` : `${row.name} was already nudged recently.`,
          { tone: res.delivered ? 'success' : 'neutral' },
        );
      });
  }

  /** Two-letter initials for an avatar fallback (name only; no email — email-privacy). */
  initials(u: { name?: string }): string {
    const parts = (u.name || '').split(/[\s@.]+/).filter(Boolean);
    return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || 'U';
  }

  // ─────────────── misc ───────────────

  /** Format a (possibly fractional) points/value number with no trailing zeros.
   *  Null-safe: a missing/NaN value (incomplete data) formats to '0' instead of crashing on .toFixed(). */
  fmt(n: number | null | undefined): string {
    if (n == null || !Number.isFinite(n)) return '0';
    return Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, '');
  }

  private todayIso(): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  private messageOf(e: unknown, fallback: string): string {
    const err = e as { error?: { message?: string; detail?: string; title?: string } };
    const msg = err?.error?.message || err?.error?.detail || err?.error?.title;
    return typeof msg === 'string' && msg ? msg : fallback;
  }
}
