import {
  ChangeDetectionStrategy, Component, computed, effect, inject, output, signal,
} from '@angular/core';
import { MatIconModule } from '@angular/material/icon';

import { Api } from '../../../core/api';
import { AuthService } from '../../../core/auth';
import {
  DailyCoachResponse, DaySummaryResponse, PERM, TrackerRecapResult, WeeklyReviewResponse,
} from '../../../core/models';
import { OptimisticTracker } from '../state/optimistic-tracker';
import { firstValueFrom } from 'rxjs';

/**
 * Strata AI COACH card — the mobile home for the tracker's AI narration panels, the twin of the desktop
 * tracker's AI assists (features/tracker/tracker.ts loadCoach / loadWeekly / loadDaySummary + loadRecap).
 *
 * Four lazy panels, each reusing an EXISTING endpoint and 503-graceful:
 *   • Daily Coach   — GET /ai/daily-coach   (insight + tips; cached per day)
 *   • Weekly Review — GET /ai/weekly-review (summary + one suggestion; cached)
 *   • Day Summary   — POST /ai/day-summary  (end-of-day recap of the LOGGED day)
 *   • ✨ This week   — GET /ai/tracker-recap (read-only weekly narration; ALWAYS 200, auto-loads)
 *
 * Coach/Weekly/Summary are FETCHED ON DEMAND (buttons) so we never spam the rate-limited key on load; a
 * 503/error flips each to a quiet "unavailable" steer, never an error. "This week" auto-loads (it never
 * 503s) and re-loads at most once per local week. Gated exactly like desktop: the whole card renders only
 * when trackerAi is held AND the tracker is the caller's OWN, writable one (hidden in read-only views).
 *
 * Self-styled with the page-host Strata tokens (var(--*) only — NO global --tech-*). Matte sediment card.
 */
@Component({
  selector: 'app-tracker-beta-ai-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule],
  host: { class: 'tb-card tb-ai-card' },
  template: `
    <header class="tb-ai__head">
      <span class="tb-ai__spark" aria-hidden="true">✨</span>
      <h3 class="tb-ai__title">Coach</h3>
    </header>

    <!-- ✨ This week (auto-loaded weekly recap) -->
    @if (recap(); as r) {
      <section class="tb-ai__panel tb-ai__recap">
        <p class="tb-ai__narrative">{{ r.narrative }}</p>
        @if (r.insights.length) {
          <ul class="tb-ai__tips">
            @for (i of r.insights; track i) { <li>{{ i }}</li> }
          </ul>
        }
      </section>
    }

    <!-- Daily coach -->
    <section class="tb-ai__panel">
      @if (coach(); as c) {
        <p class="tb-ai__insight">{{ c.insight }}</p>
        @if (c.tips.length) {
          <ul class="tb-ai__tips">
            @for (t of c.tips; track t) { <li>{{ t }}</li> }
          </ul>
        }
      } @else if (coachUnavailable()) {
        <p class="tb-ai__steer">Coaching is unavailable right now.</p>
      } @else {
        <button type="button" class="tb-ai__btn" (click)="loadCoach()" [disabled]="coachLoading()">
          @if (coachLoading()) { <span class="tb-ai__spin" aria-hidden="true"></span> Getting coaching… }
          @else { Get today's coaching }
        </button>
      }
    </section>

    <!-- Weekly review -->
    <section class="tb-ai__panel">
      @if (weekly(); as w) {
        <p class="tb-ai__insight">{{ w.summary }}</p>
        <p class="tb-ai__steer">{{ w.suggestion }}</p>
      } @else if (weeklyUnavailable()) {
        <p class="tb-ai__steer">The weekly review is unavailable right now.</p>
      } @else {
        <button type="button" class="tb-ai__btn" (click)="loadWeekly()" [disabled]="weeklyLoading()">
          @if (weeklyLoading()) { <span class="tb-ai__spin" aria-hidden="true"></span> Reviewing week… }
          @else { Review my week }
        </button>
      }
    </section>

    <!-- Day summary -->
    <section class="tb-ai__panel">
      @if (daySummary(); as s) {
        <p class="tb-ai__insight">{{ s.headline }}</p>
        @if (s.highlights.length) {
          <ul class="tb-ai__tips">
            @for (h of s.highlights; track h) { <li>{{ h }}</li> }
          </ul>
        }
        @if (s.tomorrow) { <p class="tb-ai__steer">{{ s.tomorrow }}</p> }
      } @else if (daySummaryUnavailable()) {
        <p class="tb-ai__steer">The day summary is unavailable right now.</p>
      } @else {
        <button type="button" class="tb-ai__btn" (click)="loadDaySummary()" [disabled]="daySummaryLoading()">
          @if (daySummaryLoading()) { <span class="tb-ai__spin" aria-hidden="true"></span> Summarizing… }
          @else { Summarize this day }
        </button>
      }
    </section>

    <!-- What should I eat? — opens the sheet (page owns it) -->
    <button type="button" class="tb-ai__btn tb-ai__btn--primary" (click)="whatToEat.emit()">
      What should I eat?
    </button>

    <span class="tb-ai__sr" role="status" aria-live="polite">{{ announce() }}</span>
  `,
  styles: [`
    :host { display: block; }

    .tb-ai__head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
    .tb-ai__spark { font-size: 16px; }
    .tb-ai__title {
      margin: 0; font-size: 11px; font-weight: 600; letter-spacing: .04em;
      text-transform: uppercase; color: var(--ink-dim);
    }

    .tb-ai__panel { padding: 10px 0; }
    .tb-ai__panel + .tb-ai__panel, .tb-ai__recap + .tb-ai__panel { border-top: 1px solid var(--hairline); }
    .tb-ai__recap { padding-top: 4px; }

    .tb-ai__narrative { margin: 0; font-size: 15px; line-height: 1.45; color: var(--ink); }
    .tb-ai__insight { margin: 0; font-size: 15px; line-height: 1.45; color: var(--ink); }
    .tb-ai__steer { margin: 6px 0 0; font-size: 13px; line-height: 1.4; color: var(--ink-dim); }

    .tb-ai__tips { margin: 8px 0 0; padding: 0 0 0 18px; display: flex; flex-direction: column; gap: 4px; }
    .tb-ai__tips li { font-size: 13px; line-height: 1.4; color: var(--ink-dim); }

    .tb-ai__btn {
      min-height: 44px; padding: 0 16px;
      display: inline-flex; align-items: center; gap: 8px;
      font-family: var(--font-ui); font-size: 14px; font-weight: 600; color: var(--ink);
      background: var(--bg-rise); border: 1px solid var(--glass-edge); border-radius: var(--r-pill);
      box-shadow: var(--lift-1);
      touch-action: manipulation; -webkit-tap-highlight-color: transparent; cursor: pointer;
      transition: transform 120ms var(--ease-out), box-shadow 120ms var(--ease-out);
    }
    .tb-ai__btn:active:not(:disabled) { transform: translateY(1px) scale(.98); box-shadow: var(--press); }
    .tb-ai__btn:disabled { opacity: .55; cursor: default; }
    .tb-ai__btn:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
    .tb-ai__btn--primary {
      margin-top: 12px; width: 100%; justify-content: center; color: #fff; border: 0;
      background: linear-gradient(135deg, var(--tech-accent, var(--cal-a)), var(--tech-accent-2, var(--cal-b)));
      box-shadow: var(--lift-2);
    }

    .tb-ai__spin {
      width: 15px; height: 15px; border-radius: 50%;
      border: 2px solid var(--hairline); border-top-color: var(--ink);
      animation: tb-ai-spin 700ms linear infinite;
    }
    @keyframes tb-ai-spin { to { transform: rotate(360deg); } }

    .tb-ai__sr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; border: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

    @media (prefers-reduced-motion: reduce) { .tb-ai__btn { transition: none; } .tb-ai__spin { animation: none; } }
  `],
})
export class AiCard {
  private readonly opt = inject(OptimisticTracker);
  private readonly api = inject(Api);
  private readonly auth = inject(AuthService);

  /** Emitted when the user taps "What should I eat?" — the page opens the WhatToEatSheet. */
  readonly whatToEat = output<void>();

  /** Gate: trackerAi + own writable tracker (the page also hides the card, but re-check here). */
  readonly aiEnabled = computed(() => this.auth.hasPermission(PERM.trackerAi) && !this.opt.readOnly());

  protected readonly coach = signal<DailyCoachResponse | null>(null);
  protected readonly coachLoading = signal(false);
  protected readonly coachUnavailable = signal(false);

  protected readonly weekly = signal<WeeklyReviewResponse | null>(null);
  protected readonly weeklyLoading = signal(false);
  protected readonly weeklyUnavailable = signal(false);

  protected readonly daySummary = signal<DaySummaryResponse | null>(null);
  protected readonly daySummaryLoading = signal(false);
  protected readonly daySummaryUnavailable = signal(false);

  protected readonly recap = signal<TrackerRecapResult | null>(null);
  private recapWeek = '';

  protected readonly announce = signal('');

  constructor() {
    // Auto-load the read-only weekly recap (never 503s) once per local week. Reset the on-demand panels
    // whenever the viewed date changes so a coach/summary from another day never lingers on the new day.
    effect(() => {
      const date = this.opt.date();
      void date; // track the date so a day change re-runs this
      this.coach.set(null); this.coachUnavailable.set(false);
      this.daySummary.set(null); this.daySummaryUnavailable.set(false);
      if (this.aiEnabled()) void this.loadRecap();
    });
  }

  /** The yyyy-MM-dd start (6 days back) of the current recap window — the once-per-week cache key. */
  private currentWeekStart(): string {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - 6);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  protected async loadRecap(): Promise<void> {
    const week = this.currentWeekStart();
    if (week === this.recapWeek && this.recap()) return;
    this.recapWeek = week;
    try {
      const recap = await firstValueFrom(this.api.trackerRecapAi());
      this.recap.set(recap ? { ...recap, insights: recap.insights ?? [] } : recap);
    } catch {
      this.recap.set(null);
      this.recapWeek = '';
    }
  }

  protected async loadCoach(): Promise<void> {
    if (!this.aiEnabled() || this.coachLoading()) return;
    this.coachLoading.set(true);
    this.coachUnavailable.set(false);
    this.announce.set('Getting your daily coaching…');
    try {
      const res = await firstValueFrom(this.api.dailyCoach());
      this.coach.set(res);
      this.announce.set(`Coach: ${res.insight}`);
    } catch {
      this.coach.set(null);
      this.coachUnavailable.set(true);
      this.announce.set('AI coaching is unavailable right now.');
    } finally {
      this.coachLoading.set(false);
    }
  }

  protected async loadWeekly(): Promise<void> {
    if (!this.aiEnabled() || this.weeklyLoading()) return;
    this.weeklyLoading.set(true);
    this.weeklyUnavailable.set(false);
    this.announce.set('Reviewing your week…');
    try {
      const res = await firstValueFrom(this.api.weeklyReview());
      this.weekly.set(res);
      this.announce.set(`This week: ${res.summary} ${res.suggestion}`);
    } catch {
      this.weekly.set(null);
      this.weeklyUnavailable.set(true);
      this.announce.set('The weekly review is unavailable right now.');
    } finally {
      this.weeklyLoading.set(false);
    }
  }

  protected async loadDaySummary(): Promise<void> {
    if (!this.aiEnabled() || this.daySummaryLoading()) return;
    this.daySummaryLoading.set(true);
    this.daySummaryUnavailable.set(false);
    this.announce.set('Summarizing your day…');
    try {
      const raw = await firstValueFrom(this.api.daySummary({ date: this.opt.date() }));
      const res: DaySummaryResponse = { ...raw, headline: raw?.headline ?? '', highlights: raw?.highlights ?? [] };
      this.daySummary.set(res);
      this.announce.set(`Day summary: ${res.headline}`);
    } catch {
      this.daySummary.set(null);
      this.daySummaryUnavailable.set(true);
      this.announce.set('The day summary is unavailable right now.');
    } finally {
      this.daySummaryLoading.set(false);
    }
  }
}
