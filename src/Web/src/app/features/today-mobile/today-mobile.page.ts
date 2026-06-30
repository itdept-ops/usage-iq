import {
  ChangeDetectionStrategy, Component, computed, inject, signal,
} from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { firstValueFrom } from 'rxjs';

import { Api } from '../../core/api';
import { DayMoment, DayRecapResponse, DayStats } from '../../core/models';
import {
  BetaPullRefresh, BetaSkeleton, BetaEmptyState, BetaErrorState,
} from '../beta-ui';

/** One headline stat chip resolved off the deterministic {@link DayStats} (null fields are skipped). */
interface StatChip {
  readonly icon: string;
  readonly label: string;
  readonly value: string;
  readonly domain: string;
}

/**
 * YOUR DAY — the MOBILE `/today` twin of the live "Day in the Life" surface, rebuilt on the shared beta-ui
 * "Strata" kit (`@use '../beta-ui/beta-kit'`). One signature accent — an INDIGO → VIOLET dusk ramp — re-skins
 * the whole screen via the per-page accent contract. An immersive hero with prev/next/today day-nav, an
 * optional AI-recap banner (hidden when `narrative` is null), deterministic stat chips, and a vertical
 * TIMELINE of the day's moments with a per-domain accent + icon. Pull-to-refresh + skeleton/empty/error.
 *
 * DATA PARITY + PRIVACY: every figure reuses the SAME owner-scoped, tracker.self-gated `GET /api/ai/day-recap`
 * the desktop page uses (the timeline + stats are the always-200 deterministic floor; the narrative is the
 * optional tracker.ai upgrade). STRICTLY owner-scoped — the caller's own day only; carries NO email / PII;
 * NON-medical framing. This page renders only the caller's own data and performs NO writes.
 *
 * ISOLATION: gated by `platform.mobile` + the SAME `tracker.self`; imports only the kit + the shared Api/models.
 * No live page is imported or modified. Reduced-motion is honoured by the kit + the scss.
 */
@Component({
  selector: 'app-today-mobile',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './today-mobile.page.scss',
  imports: [MatIconModule, BetaPullRefresh, BetaSkeleton, BetaEmptyState, BetaErrorState],
  template: `
    <app-bs-pull-refresh class="td-ptr" [busy]="refreshing()" (refresh)="reload()">
      <div class="td-scroll" aria-live="polite">

        <!-- ─── HERO + DAY NAV ─── -->
        <header class="td-hero">
          <p class="td-hero__kicker"><mat-icon aria-hidden="true">wb_twilight</mat-icon> Day in the Life</p>
          <h1 class="td-hero__title">Your day</h1>
          <p class="td-hero__sub">A moment-by-moment look at what you tracked.</p>

          <nav class="td-nav" aria-label="Day navigation">
            <button type="button" class="td-nav__btn" [disabled]="busy()" (click)="step(-1)" aria-label="Previous day">
              <mat-icon aria-hidden="true">chevron_left</mat-icon>
            </button>
            <div class="td-nav__label">
              <span class="td-nav__day">{{ dayLabel() }}</span>
              <span class="td-nav__date">{{ dateLabel() }}</span>
            </div>
            <button type="button" class="td-nav__btn" [disabled]="busy() || isToday()" (click)="step(1)" aria-label="Next day">
              <mat-icon aria-hidden="true">chevron_right</mat-icon>
            </button>
          </nav>
          <div class="td-nav__jump">
            @if (!isToday()) {
              <button type="button" class="td-nav__today" [disabled]="busy()" (click)="goToday()">
                <mat-icon aria-hidden="true">today</mat-icon> Back to today
              </button>
            }
            <input type="date" class="td-nav__pick" [value]="date()" [max]="maxDate" [disabled]="busy()"
                   (change)="pickDate($event)" aria-label="Jump to a specific day" />
          </div>
        </header>

        @if (loading()) {
          <app-bs-skeleton height="92px" radius="var(--r-tile)" />
          <app-bs-skeleton height="120px" radius="var(--r-tile)" />
          <app-bs-skeleton height="200px" radius="var(--r-tile)" />

        } @else if (errored()) {
          <app-bs-error
            icon="cloud_off"
            title="Couldn't load your day"
            body="Something went wrong gathering today's moments. Give it another go."
            (retry)="reload()" />

        } @else if (!hasAnything()) {
          <app-bs-empty
            icon="wb_twilight"
            title="Nothing logged yet"
            body="Log food, a workout, sleep, water, a habit or a mood note and your day fills in here as a timeline."
            ctaLabel="Open the tracker"
            ctaLink="/tracker" />

        } @else {
          <!-- ─── AI RECAP (tracker.ai only; hidden when null) ─── -->
          @if (narrative(); as nar) {
            <section class="td-ai" aria-label="AI recap of your day">
              <p class="td-ai__kicker"><mat-icon aria-hidden="true">auto_awesome</mat-icon> AI recap</p>
              <p class="td-ai__text">{{ nar }}</p>
              <p class="td-ai__foot">Narrates only the moments below — never invents or diagnoses.</p>
            </section>
          }

          <!-- ─── STAT CHIPS ─── -->
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

          <!-- ─── TEXT HIGHLIGHTS ─── -->
          @if (highlights().length) {
            <ul class="td-hl" aria-label="What stood out">
              @for (h of highlights(); track h) {
                <li>
                  <span class="td-hl__orb" aria-hidden="true"><mat-icon>bolt</mat-icon></span>
                  <span>{{ h }}</span>
                </li>
              }
            </ul>
          }

          <!-- ─── TIMELINE ─── -->
          @if (timeline().length) {
            <ol class="td-line" aria-label="Your day, hour by hour">
              @for (m of timeline(); track $index; let i = $index) {
                <li class="td-moment" [style.--da]="accentA(m.domain)" [style.--db]="accentB(m.domain)" [style.--i]="i">
                  <span class="td-moment__time">{{ m.time || 'All day' }}</span>
                  <span class="td-moment__node" aria-hidden="true"><mat-icon>{{ momentIcon(m) }}</mat-icon></span>
                  <div class="td-moment__body">
                    <span class="td-moment__domain">{{ m.domain }}</span>
                    <p class="td-moment__label">{{ m.label }}</p>
                  </div>
                </li>
              }
            </ol>
          } @else {
            <app-bs-empty compact icon="schedule"
              title="No timed moments"
              body="There are day-level highlights above, but nothing with a timestamp to plot yet." />
          }

          <p class="td-foot">
            <mat-icon aria-hidden="true">lock</mat-icon>
            Only your own day. Health figures are informational, not medical advice.
          </p>
        }
      </div>
    </app-bs-pull-refresh>
  `,
})
export class TodayMobilePage {
  private api = inject(Api);

  readonly date = signal<string>(TodayMobilePage.todayStr());
  /** Upper bound for the date picker — today (the recap never looks into the future). */
  readonly maxDate = TodayMobilePage.todayStr();
  readonly data = signal<DayRecapResponse | null>(null);
  readonly loading = signal(true);
  readonly refreshing = signal(false);
  readonly errored = signal(false);

  readonly busy = computed(() => this.loading() || this.refreshing());
  readonly timeline = computed<DayMoment[]>(() => this.data()?.timeline ?? []);
  readonly highlights = computed<string[]>(() => this.data()?.highlights ?? []);
  readonly narrative = computed<string | null>(() => this.data()?.narrative ?? null);

  readonly hasAnything = computed(() => {
    const d = this.data();
    if (!d) return false;
    if (d.timeline.length || d.highlights.length) return true;
    return Object.values(d.stats).some(v => v !== null && v !== undefined);
  });

  readonly isToday = computed(() => this.date() === TodayMobilePage.todayStr());

  readonly dayLabel = computed(() => {
    const d = this.date();
    const today = TodayMobilePage.todayStr();
    if (d === today) return 'Today';
    if (d === TodayMobilePage.shift(today, -1)) return 'Yesterday';
    return TodayMobilePage.parseLocal(d).toLocaleDateString(undefined, { weekday: 'long' });
  });

  readonly dateLabel = computed(() =>
    TodayMobilePage.parseLocal(this.date()).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }),
  );

  readonly statChips = computed<StatChip[]>(() => {
    const s = this.data()?.stats;
    if (!s) return [];
    const chips: StatChip[] = [];
    if (s.caloriesIn != null) {
      const goal = s.calorieGoal != null ? ` / ${Math.round(s.calorieGoal)}` : '';
      chips.push({ icon: 'restaurant', domain: 'food', label: 'Calories', value: `${Math.round(s.caloriesIn)}${goal}` });
    }
    if (s.exerciseCalories != null || s.exerciseCount != null) {
      const kcal = s.exerciseCalories != null ? `${Math.round(s.exerciseCalories)} kcal` : '';
      const cnt = s.exerciseCount != null ? `${s.exerciseCount}×` : '';
      chips.push({ icon: 'directions_run', domain: 'exercise', label: 'Exercise', value: [cnt, kcal].filter(Boolean).join(' · ') || '—' });
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

  step(delta: number): void {
    const next = TodayMobilePage.shift(this.date(), delta);
    if (delta > 0 && next > TodayMobilePage.todayStr()) return;
    this.date.set(next);
    this.reload();
  }

  goToday(): void {
    if (this.isToday()) return;
    this.date.set(TodayMobilePage.todayStr());
    this.reload();
  }

  /** Jump straight to any past day via the date picker (capped at today; future + no-op selections ignored). */
  pickDate(e: Event): void {
    const v = (e.target as HTMLInputElement).value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || v > TodayMobilePage.todayStr() || v === this.date()) return;
    this.date.set(v);
    this.reload();
  }

  async reload(): Promise<void> {
    const wasLoaded = !!this.data();
    if (wasLoaded) this.refreshing.set(true); else this.loading.set(true);
    this.errored.set(false);
    const d = this.date();
    try {
      const res = await firstValueFrom(this.api.dayRecap(d));
      if (this.date() === d) this.data.set(res);
    } catch {
      this.errored.set(true);
    } finally {
      this.loading.set(false);
      this.refreshing.set(false);
    }
  }

  // ─────────────── ACCENT + ICON MAPPING ───────────────

  private static readonly DOMAIN_KEYS = new Set([
    'food', 'exercise', 'sleep', 'hydration', 'coffee', 'journal', 'habits',
    'meds', 'activity', 'family', 'location', 'finance', 'primary',
  ]);
  private domainKey(d: string | null | undefined): string {
    return d && TodayMobilePage.DOMAIN_KEYS.has(d) ? d : 'primary';
  }
  accentA(d: string): string { return `var(--da-${this.domainKey(d)})`; }
  accentB(d: string): string { return `var(--db-${this.domainKey(d)})`; }

  private static readonly DOMAIN_ICONS: Record<string, string> = {
    food: 'restaurant', exercise: 'directions_run', sleep: 'bedtime', hydration: 'water_drop',
    coffee: 'local_cafe', journal: 'mood', habits: 'checklist', meds: 'medication',
    activity: 'dynamic_feed', family: 'cottage', location: 'location_on', finance: 'payments',
    primary: 'schedule',
  };
  momentIcon(m: DayMoment): string {
    const fromDomain = TodayMobilePage.DOMAIN_ICONS[this.domainKey(m.domain)] ?? 'schedule';
    return m.icon && /^[a-z_]+$/.test(m.icon) ? m.icon : fromDomain;
  }

  // ─────────────── LOCAL-DATE HELPERS ───────────────

  private static todayStr(): string { return TodayMobilePage.fmt(new Date()); }
  private static fmt(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  private static parseLocal(s: string): Date {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  private static shift(s: string, days: number): string {
    const d = TodayMobilePage.parseLocal(s);
    d.setDate(d.getDate() + days);
    return TodayMobilePage.fmt(d);
  }
}
