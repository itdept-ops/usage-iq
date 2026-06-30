import {
  ChangeDetectionStrategy, Component, computed, inject, signal,
} from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { firstValueFrom } from 'rxjs';

import { Api } from '../../core/api';
import { DayMoment, DayRecapResponse, DayStats } from '../../core/models';
import { BetaEmptyState, BetaErrorState } from '../beta-ui';

/** One headline stat chip resolved off the deterministic {@link DayStats} (null fields are skipped). */
interface StatChip {
  readonly icon: string;
  readonly label: string;
  readonly value: string;
  readonly domain: string;
}

/**
 * YOUR DAY — the DESKTOP `/today` "Day in the Life" surface. A showcase-grade recap of the caller's OWN single
 * day: an optional AI narrative banner up top (a tasteful "AI recap" affordance; hidden when `narrative` is
 * null), then the deterministic stat-highlight chips, then a vertical TIMELINE of the day's moments ordered by
 * time with a per-domain accent + icon, and PREV / NEXT / today day-navigation.
 *
 * DATA + PRIVACY (load-bearing): every figure comes from {@link Api.dayRecap} (`GET /api/ai/day-recap`),
 * computed server-side from the domains the caller has permission for and STRICTLY owner-scoped (the caller's
 * own day — no household, no other user). The endpoint NEVER 503s: the timeline + stats are the always-200
 * deterministic floor; the `narrative` is the optional tracker.ai-gated upgrade (null ⇒ the banner is hidden,
 * the timeline still renders). This page renders only the caller's own data, performs NO writes, carries NO
 * email / PII, and is framed NON-medically. A public PII-safe share is a deliberate follow-up (out of scope).
 *
 * STYLING: the app's own `--tech-*` design tokens with a per-domain accent palette pinned on `:host` (mirrors
 * the Insights command center). The timeline reveal honours prefers-reduced-motion (suppressed in the scss).
 */
@Component({
  selector: 'app-today',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, BetaEmptyState, BetaErrorState],
  styleUrl: './today.page.scss',
  template: `
    <div class="td">
      <!-- ─────────── HEADER + DAY NAV ─────────── -->
      <header class="td-head">
        <div class="td-head__lead">
          <p class="td-head__kicker">
            <mat-icon aria-hidden="true">wb_twilight</mat-icon> Day in the Life
          </p>
          <h1 class="td-head__title">Your day</h1>
          <p class="td-head__sub">
            <strong>Your</strong> day, every domain, one timeline.
          </p>
        </div>

        <nav class="td-nav" aria-label="Day navigation">
          <button type="button" class="td-nav__btn" [disabled]="loading()"
                  (click)="step(-1)" aria-label="Previous day">
            <mat-icon aria-hidden="true">chevron_left</mat-icon>
          </button>
          <div class="td-nav__label">
            <span class="td-nav__day">{{ dayLabel() }}</span>
            <span class="td-nav__date">{{ dateLabel() }}</span>
          </div>
          <button type="button" class="td-nav__btn" [disabled]="loading() || isToday()"
                  (click)="step(1)" aria-label="Next day">
            <mat-icon aria-hidden="true">chevron_right</mat-icon>
          </button>
          @if (!isToday()) {
            <button type="button" class="td-nav__today" [disabled]="loading()" (click)="goToday()">
              <mat-icon aria-hidden="true">today</mat-icon> Today
            </button>
          }
          <input type="date" class="td-nav__pick" [value]="date()" [max]="maxDate" [disabled]="loading()"
                 (change)="pickDate($event)" aria-label="Jump to a specific day" />
        </nav>
      </header>

      <!-- ─────────── BODY ─────────── -->
      @if (loading()) {
        <div class="td-skel" aria-hidden="true">
          <div class="td-skel__bar td-skel__bar--ai"></div>
          <div class="td-skel__chips">
            @for (s of [1,2,3,4]; track s) { <div class="td-skel__chip"></div> }
          </div>
          @for (s of [1,2,3,4,5]; track s) { <div class="td-skel__row"></div> }
        </div>

      } @else if (errored()) {
        <app-bs-error
          title="Couldn't load your day"
          body="Something went wrong gathering today's moments. Give it another go."
          (retry)="reload()" />

      } @else if (!hasAnything()) {
        <app-bs-empty
          icon="wb_twilight"
          title="Nothing logged for this day yet"
          body="Once you log food, a workout, sleep, water, a habit, a mood note or more, your day fills in here as a timeline. Start tracking and your recap appears."
          ctaLabel="Open the tracker"
          ctaLink="/tracker" />

      } @else {
        <!-- ─── AI NARRATIVE (tracker.ai only; hidden when narrative is null) ─── -->
        @if (narrative(); as nar) {
          <section class="td-ai" aria-label="AI recap of your day">
            <p class="td-ai__kicker">
              <mat-icon aria-hidden="true">auto_awesome</mat-icon> AI recap
            </p>
            <p class="td-ai__text">{{ nar }}</p>
            <p class="td-ai__foot">
              <mat-icon aria-hidden="true">verified_user</mat-icon>
              The AI narrates only the moments below — it never invents or diagnoses.
            </p>
          </section>
        }

        <!-- ─── STAT HIGHLIGHT CHIPS (deterministic) ─── -->
        @if (statChips().length) {
          <section class="td-stats" aria-label="Day highlights">
            @for (c of statChips(); track c.label) {
              <div class="td-stat" [style.--da]="accentA(c.domain)" [style.--db]="accentB(c.domain)">
                <span class="td-stat__ico"><mat-icon aria-hidden="true">{{ c.icon }}</mat-icon></span>
                <span class="td-stat__val">{{ c.value }}</span>
                <span class="td-stat__lab">{{ c.label }}</span>
              </div>
            }
          </section>
        }

        <!-- ─── TEXT HIGHLIGHTS (server-authored, factual) ─── -->
        @if (highlights().length) {
          <ul class="td-hl" aria-label="What stood out">
            @for (h of highlights(); track h) {
              <li><mat-icon aria-hidden="true">bolt</mat-icon>{{ h }}</li>
            }
          </ul>
        }

        <!-- ─── TIMELINE ─── -->
        @if (timeline().length) {
          <ol class="td-line" aria-label="Your day, hour by hour">
            @for (m of timeline(); track $index; let i = $index) {
              <li class="td-moment" [style.--da]="accentA(m.domain)" [style.--db]="accentB(m.domain)"
                  [style.--i]="i">
                <span class="td-moment__time">{{ m.time || 'All day' }}</span>
                <span class="td-moment__node" aria-hidden="true">
                  <mat-icon>{{ momentIcon(m) }}</mat-icon>
                </span>
                <div class="td-moment__body">
                  <span class="td-moment__domain">{{ m.domain }}</span>
                  <p class="td-moment__label">{{ m.label }}</p>
                </div>
              </li>
            }
          </ol>
        } @else {
          <app-bs-empty compact
            icon="schedule"
            title="No timed moments for this day"
            body="There are day-level highlights above, but nothing with a timestamp to plot on the timeline yet." />
        }

        <p class="td-foot">
          <mat-icon aria-hidden="true">lock</mat-icon>
          Only your own day — never household or other-user data. Health figures are informational, not medical
          advice. A shareable recap is coming soon.
        </p>
      }
    </div>
  `,
})
export class TodayPage {
  private api = inject(Api);

  /** The day being viewed, as a local yyyy-MM-dd string (defaults to today). */
  readonly date = signal<string>(TodayPage.todayStr());
  /** Upper bound for the date picker — today (the recap never looks into the future). */
  readonly maxDate = TodayPage.todayStr();
  readonly data = signal<DayRecapResponse | null>(null);
  readonly loading = signal(true);
  readonly errored = signal(false);

  readonly timeline = computed<DayMoment[]>(() => this.data()?.timeline ?? []);
  readonly highlights = computed<string[]>(() => this.data()?.highlights ?? []);
  readonly narrative = computed<string | null>(() => this.data()?.narrative ?? null);

  /** True once at least one moment, highlight, or non-null stat exists for the day. */
  readonly hasAnything = computed(() => {
    const d = this.data();
    if (!d) return false;
    if (d.timeline.length || d.highlights.length) return true;
    return Object.values(d.stats).some(v => v !== null && v !== undefined);
  });

  readonly isToday = computed(() => this.date() === TodayPage.todayStr());

  /** "Today" / "Yesterday" / weekday for the viewed date (display-local, no timezone shift). */
  readonly dayLabel = computed(() => {
    const d = this.date();
    const today = TodayPage.todayStr();
    if (d === today) return 'Today';
    if (d === TodayPage.shift(today, -1)) return 'Yesterday';
    return TodayPage.parseLocal(d).toLocaleDateString(undefined, { weekday: 'long' });
  });

  readonly dateLabel = computed(() =>
    TodayPage.parseLocal(this.date()).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' }),
  );

  /** The deterministic stat chips — only the fields the caller's permitted domains actually populated. */
  readonly statChips = computed<StatChip[]>(() => {
    const s = this.data()?.stats;
    if (!s) return [];
    const chips: StatChip[] = [];
    const cal = this.fmtCalories(s);
    if (cal) chips.push(cal);
    if (s.exerciseCalories != null || s.exerciseCount != null) {
      const kcal = s.exerciseCalories != null ? `${Math.round(s.exerciseCalories)} kcal` : '';
      const cnt = s.exerciseCount != null ? `${s.exerciseCount}×` : '';
      chips.push({ icon: 'directions_run', domain: 'exercise', label: 'Exercise',
        value: [cnt, kcal].filter(Boolean).join(' · ') || '—' });
    }
    if (s.proteinG != null) chips.push({ icon: 'egg_alt', domain: 'food', label: 'Protein', value: `${Math.round(s.proteinG)} g` });
    if (s.sleepHours != null) chips.push({ icon: 'bedtime', domain: 'sleep', label: 'Sleep', value: `${s.sleepHours.toFixed(1)} h` });
    if (s.recoveryScore != null) chips.push({ icon: 'monitor_heart', domain: 'sleep', label: 'Recovery', value: `${Math.round(s.recoveryScore)}` });
    if (s.hydrationMl != null) chips.push({ icon: 'water_drop', domain: 'hydration', label: 'Water', value: `${(s.hydrationMl / 1000).toFixed(1)} L` });
    if (s.caffeineMg != null) chips.push({ icon: 'local_cafe', domain: 'coffee', label: 'Caffeine', value: `${Math.round(s.caffeineMg)} mg` });
    if (s.habitsExpected != null) chips.push({ icon: 'checklist', domain: 'habits', label: 'Habits', value: `${s.habitsDone ?? 0}/${s.habitsExpected}` });
    if (s.medsExpected != null) chips.push({ icon: 'medication', domain: 'meds', label: 'Meds', value: `${s.medsTaken ?? 0}/${s.medsExpected}` });
    if (s.mood) chips.push({ icon: 'mood', domain: 'journal', label: 'Mood', value: s.mood });
    if (s.placesVisited != null) chips.push({ icon: 'location_on', domain: 'location', label: 'Places', value: `${s.placesVisited}` });
    if (s.spendUsd != null) chips.push({ icon: 'payments', domain: 'finance', label: 'Spend', value: `$${s.spendUsd.toFixed(0)}` });
    return chips;
  });

  constructor() {
    this.reload();
  }

  // ─────────────── NAVIGATION ───────────────

  step(delta: number): void {
    const next = TodayPage.shift(this.date(), delta);
    if (delta > 0 && next > TodayPage.todayStr()) return; // never navigate into the future
    this.date.set(next);
    this.reload();
  }

  goToday(): void {
    if (this.isToday()) return;
    this.date.set(TodayPage.todayStr());
    this.reload();
  }

  /** Jump straight to any past day via the date picker (capped at today; future + no-op selections ignored). */
  pickDate(e: Event): void {
    const v = (e.target as HTMLInputElement).value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || v > TodayPage.todayStr() || v === this.date()) return;
    this.date.set(v);
    this.reload();
  }

  async reload(): Promise<void> {
    this.loading.set(true);
    this.errored.set(false);
    const d = this.date();
    try {
      const res = await firstValueFrom(this.api.dayRecap(d));
      if (this.date() === d) this.data.set(res);
    } catch {
      this.errored.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  // ─────────────── STAT FORMATTING ───────────────

  private fmtCalories(s: DayStats): StatChip | null {
    if (s.caloriesIn == null) return null;
    const kcal = Math.round(s.caloriesIn);
    const goal = s.calorieGoal != null ? ` / ${Math.round(s.calorieGoal)}` : '';
    return { icon: 'restaurant', domain: 'food', label: 'Calories', value: `${kcal}${goal}` };
  }

  // ─────────────── ACCENT + ICON MAPPING ───────────────

  private static readonly DOMAIN_KEYS = new Set([
    'food', 'exercise', 'sleep', 'hydration', 'coffee', 'journal', 'habits',
    'meds', 'activity', 'family', 'location', 'finance', 'primary',
  ]);
  private domainKey(d: string | null | undefined): string {
    return d && TodayPage.DOMAIN_KEYS.has(d) ? d : 'primary';
  }
  accentA(d: string): string { return `var(--da-${this.domainKey(d)})`; }
  accentB(d: string): string { return `var(--db-${this.domainKey(d)})`; }

  private static readonly DOMAIN_ICONS: Record<string, string> = {
    food: 'restaurant',
    exercise: 'directions_run',
    sleep: 'bedtime',
    hydration: 'water_drop',
    coffee: 'local_cafe',
    journal: 'mood',
    habits: 'checklist',
    meds: 'medication',
    activity: 'dynamic_feed',
    family: 'cottage',
    location: 'location_on',
    finance: 'payments',
    primary: 'schedule',
  };
  /** Prefer the server-provided icon token if it's a known Material ligature, else map the domain. */
  momentIcon(m: DayMoment): string {
    const fromDomain = TodayPage.DOMAIN_ICONS[this.domainKey(m.domain)] ?? 'schedule';
    // The wire `icon` is a short hint; fall back to the domain map for a guaranteed-rendering glyph.
    return m.icon && /^[a-z_]+$/.test(m.icon) ? m.icon : fromDomain;
  }

  // ─────────────── LOCAL-DATE HELPERS (no timezone shift) ───────────────

  /** Today as a local yyyy-MM-dd (NOT toISOString, which is UTC and can roll the date). */
  private static todayStr(): string {
    return TodayPage.fmt(new Date());
  }
  private static fmt(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  /** Parse a yyyy-MM-dd string as a LOCAL date (component-wise, never `new Date(str)` which is UTC). */
  private static parseLocal(s: string): Date {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  /** Shift a yyyy-MM-dd string by N days, staying in local time. */
  private static shift(s: string, days: number): string {
    const d = TodayPage.parseLocal(s);
    d.setDate(d.getDate() + days);
    return TodayPage.fmt(d);
  }
}
