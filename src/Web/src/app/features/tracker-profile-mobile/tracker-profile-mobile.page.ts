import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { MatIconModule } from '@angular/material/icon';

import { Api } from '../../core/api';
import { AuthService } from '../../core/auth';
import { UnitService } from '../../core/unit.service';
import { TrackerStore } from '../../core/tracker-store';
import {
  ActivityLevel,
  DietPattern,
  GoalPlanDto,
  PERM,
  Sex,
  TrackerProfileDto,
  UnitSystem,
} from '../../core/models';
import { StatsInputs, ageFrom, computeStats } from '../tracker/units';
import { OnboardingCard, OnboardingResult } from '../tracker/onboarding-card';
import {
  BetaBottomSheet, BetaEmptyState, BetaPullRefresh, BetaSegmentedControl, BetaSkeleton,
  BetaStatTile, BetaToaster, ToastController, type Segment,
} from '../beta-ui';

const GOALS: { value: string; label: string; icon: string }[] = [
  { value: 'LoseWeight', label: 'Lose weight', icon: 'trending_down' },
  { value: 'Maintain', label: 'Maintain', icon: 'remove' },
  { value: 'GainMuscle', label: 'Gain muscle', icon: 'fitness_center' },
  { value: 'Endurance', label: 'Endurance', icon: 'directions_run' },
];

const SEXES: { value: Sex; label: string }[] = [
  { value: 'Unspecified', label: 'Prefer not to say' },
  { value: 'Male', label: 'Male' },
  { value: 'Female', label: 'Female' },
];

const ACTIVITY_LEVELS: { value: ActivityLevel; label: string }[] = [
  { value: 'Sedentary', label: 'Sedentary' },
  { value: 'Light', label: 'Light (1–3 days/wk)' },
  { value: 'Moderate', label: 'Moderate (3–5 days/wk)' },
  { value: 'Active', label: 'Active (6–7 days/wk)' },
  { value: 'VeryActive', label: 'Very active' },
];

const DIET_PATTERNS: { value: DietPattern; label: string }[] = [
  { value: 'Balanced', label: 'Balanced' },
  { value: 'HighProtein', label: 'High protein' },
  { value: 'LowCarb', label: 'Low carb' },
  { value: 'Keto', label: 'Keto' },
  { value: 'Vegetarian', label: 'Vegetarian' },
  { value: 'Vegan', label: 'Vegan' },
  { value: 'Mediterranean', label: 'Mediterranean' },
  { value: 'Paleo', label: 'Paleo' },
];

/**
 * Tracker Profile "My Plan" — the MOBILE twin of the live `/tracker/profile` page (route owned by the
 * platform split: phones with `platform.mobile` render this; desktop keeps {@link ProfilePage}). A goal-
 * focused, native-feel re-presentation of the SAME "My Profile & Goal" surface:
 *
 *  1. The VERBATIM first-run onboarding gate — when the baseline is incomplete (current weight, height,
 *     DOB, explicit sex) it renders the same blocking {@link OnboardingCard} the live page uses, persists
 *     through the {@link TrackerStore}, and seeds today's weigh-in. (Same predicate, same store calls.)
 *  2. A goal builder — goal chips + the body-profile fields (weight / height / DOB / sex / activity) +
 *     calorie + macro targets, with a LIVE Estimated-TDEE preview ({@link computeStats}, the exact TS twin
 *     of the backend TrackerStats.Compute the live page reads) surfaced as kit {@link BetaStatTile}s, and
 *     a one-tap "Use suggested" to fill the targets. Optional AI affordances are gated by `tracker.ai`.
 *  3. Dated PLAN HISTORY — the read-only newest-first {@link GoalPlanDto} list from `Api.goalPlans`, top
 *     row badged "Active today", each tap-expandable into a kit {@link BetaBottomSheet} of its snapshot.
 *
 * DATA PARITY + ISOLATION: every figure comes from the SAME endpoints the live page uses
 * (`Api.trackerProfile`, `Api.goalPlans`, the AI `Api.suggestGoal` / `Api.naturalGoal`) and saves through
 * the SAME `TrackerStore.saveProfile`; the preview reuses the SAME `computeStats` + `UnitService` rate/
 * weight seams, so the number agrees with the desktop page exactly. No live page is imported or modified;
 * the only shared imports are the kit + the tracker's own Api/models/store/units/onboarding card. Mobile-
 * first (44px targets, safe-area insets), degrades gracefully (skeletons, empty + error states) and
 * renders cleanly with zero data (the screenshot harness mocks the API).
 */
@Component({
  selector: 'app-tracker-profile-mobile',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [ToastController],
  imports: [
    FormsModule, MatIconModule,
    BetaPullRefresh, BetaSegmentedControl, BetaSkeleton, BetaStatTile, BetaBottomSheet, BetaToaster,
    BetaEmptyState,
    OnboardingCard,
  ],
  template: `
    <app-bs-pull-refresh class="pm-ptr" [busy]="refreshing()" [disabled]="needsBaseline()" (refresh)="reload()">
      <div class="pm-scroll" aria-live="polite">

        <!-- ─── IMMERSIVE HEADER ─── -->
        <header class="pm-hero">
          <p class="pm-hero__kicker"><mat-icon aria-hidden="true">flag</mat-icon> My Plan</p>
          <h1 class="pm-hero__title">Profile &amp; Goal</h1>
          @if (!loading()) {
            <p class="pm-hero__sub">{{ heroSub() }}</p>
          }
        </header>

        @if (loading()) {
          <!-- SKELETON -->
          <div class="pm-skel">
            <app-bs-skeleton height="132px" radius="var(--r-card)" />
            <app-bs-skeleton height="180px" radius="var(--r-card)" />
            <app-bs-skeleton height="120px" radius="var(--r-card)" />
          </div>

        } @else if (needsBaseline()) {
          <!-- BLOCKING ONBOARDING GATE (same card the live page uses) -->
          <div class="pm-onboard">
            <app-tracker-onboarding
              [profile]="onboardingSeed()" [saving]="savingBaseline()"
              (completed)="onBaselineComplete($event)" />
          </div>

        } @else {

          <!-- ─── LIVE TDEE PREVIEW ─── -->
          <section class="pm-card pm-preview">
            <div class="pm-card__head">
              <span class="pm-card__title"><mat-icon aria-hidden="true">local_fire_department</mat-icon> Estimate</span>
              <span class="pm-conf" [attr.data-c]="confidence()">{{ confidenceLabel() }}</span>
            </div>
            <div class="pm-tiles">
              <app-bs-stat-tile label="Est. TDEE" unit="kcal/day" [value]="fmtNum(preview().tdee)" />
              <app-bs-stat-tile label="BMR" unit="kcal" [value]="fmtNum(preview().bmr)" />
              <app-bs-stat-tile label="BMI" [value]="fmtNum(preview().bmi)" [unit]="preview().bmiCategory || ''" />
              <app-bs-stat-tile label="Suggested" unit="kcal/day" [value]="fmtNum(preview().suggestedCalorieGoal)" />
            </div>
            @if (preview().tdee == null) {
              <p class="pm-preview__hint">Fill in your weight, height, age &amp; sex below to see your estimate.</p>
            }
          </section>

          <!-- ─── GOAL CHIPS ─── -->
          <section class="pm-card">
            <div class="pm-card__head"><span class="pm-card__title"><mat-icon aria-hidden="true">my_location</mat-icon> Goal</span></div>
            <div class="pm-goals" role="radiogroup" aria-label="Goal">
              @for (g of goals; track g.value) {
                <button type="button" class="pm-goal" role="radio"
                        [class.is-on]="goal() === g.value" [attr.aria-checked]="goal() === g.value"
                        (click)="goal.set(g.value)">
                  <mat-icon aria-hidden="true">{{ g.icon }}</mat-icon>
                  <span>{{ g.label }}</span>
                </button>
              }
            </div>
          </section>

          <!-- ─── BODY PROFILE ─── -->
          <section class="pm-card">
            <div class="pm-card__head">
              <span class="pm-card__title"><mat-icon aria-hidden="true">accessibility_new</mat-icon> About you</span>
              <app-bs-segmented class="pm-units" [segments]="unitSegments" [value]="unitSystem()"
                                label="Units" (change)="onUnitChange($any($event))" />
            </div>

            <div class="pm-fields">
              <!-- weight -->
              <label class="pm-field">
                <span class="pm-field__lbl">Current weight</span>
                <span class="pm-field__in">
                  <input type="number" inputmode="decimal" [ngModel]="weightDisp()" (ngModelChange)="weightDisp.set($event)" placeholder="—" />
                  <span class="pm-field__suf">{{ weightUnit }}</span>
                </span>
              </label>

              <!-- height -->
              @if (imperial()) {
                <div class="pm-field pm-field--split">
                  <span class="pm-field__lbl">Height</span>
                  <span class="pm-field__pair">
                    <span class="pm-field__in">
                      <input type="number" inputmode="numeric" [ngModel]="heightFt()" (ngModelChange)="heightFt.set($event)" placeholder="—" />
                      <span class="pm-field__suf">ft</span>
                    </span>
                    <span class="pm-field__in">
                      <input type="number" inputmode="numeric" [ngModel]="heightIn()" (ngModelChange)="heightIn.set($event)" placeholder="—" />
                      <span class="pm-field__suf">in</span>
                    </span>
                  </span>
                </div>
              } @else {
                <label class="pm-field">
                  <span class="pm-field__lbl">Height</span>
                  <span class="pm-field__in">
                    <input type="number" inputmode="numeric" [ngModel]="heightCm()" (ngModelChange)="heightCm.set($event)" placeholder="—" />
                    <span class="pm-field__suf">cm</span>
                  </span>
                </label>
              }

              <!-- DOB -->
              <label class="pm-field">
                <span class="pm-field__lbl">Date of birth</span>
                <span class="pm-field__in">
                  <input type="date" [max]="todayIso" [ngModel]="dateOfBirth()" (ngModelChange)="dateOfBirth.set($event || null)" />
                </span>
              </label>

              <!-- sex -->
              <label class="pm-field">
                <span class="pm-field__lbl">Sex</span>
                <span class="pm-field__in pm-field__in--select">
                  <select [ngModel]="sex()" (ngModelChange)="sex.set($event)">
                    @for (s of sexes; track s.value) { <option [value]="s.value">{{ s.label }}</option> }
                  </select>
                </span>
              </label>

              <!-- activity -->
              <label class="pm-field">
                <span class="pm-field__lbl">Activity level</span>
                <span class="pm-field__in pm-field__in--select">
                  <select [ngModel]="activityLevel()" (ngModelChange)="activityLevel.set($event)">
                    @for (a of activityLevels; track a.value) { <option [value]="a.value">{{ a.label }}</option> }
                  </select>
                </span>
              </label>
            </div>
          </section>

          <!-- ─── TARGETS ─── -->
          <section class="pm-card">
            <div class="pm-card__head">
              <span class="pm-card__title"><mat-icon aria-hidden="true">restaurant</mat-icon> Daily targets</span>
              @if (hasSuggestion()) {
                <button type="button" class="pm-mini" (click)="useSuggested()">
                  <mat-icon aria-hidden="true">auto_awesome</mat-icon> Use suggested
                </button>
              }
            </div>

            <div class="pm-fields">
              <label class="pm-field">
                <span class="pm-field__lbl">Calories</span>
                <span class="pm-field__in">
                  <input type="number" inputmode="numeric" [ngModel]="dailyCalorieGoal()" (ngModelChange)="dailyCalorieGoal.set($event)" placeholder="—" />
                  <span class="pm-field__suf">kcal</span>
                </span>
              </label>
              <div class="pm-macros">
                <label class="pm-field pm-field--macro">
                  <span class="pm-field__lbl">Protein</span>
                  <span class="pm-field__in">
                    <input type="number" inputmode="numeric" [ngModel]="proteinGoalG()" (ngModelChange)="proteinGoalG.set($event)" placeholder="—" />
                    <span class="pm-field__suf">g</span>
                  </span>
                </label>
                <label class="pm-field pm-field--macro">
                  <span class="pm-field__lbl">Carbs</span>
                  <span class="pm-field__in">
                    <input type="number" inputmode="numeric" [ngModel]="carbGoalG()" (ngModelChange)="carbGoalG.set($event)" placeholder="—" />
                    <span class="pm-field__suf">g</span>
                  </span>
                </label>
                <label class="pm-field pm-field--macro">
                  <span class="pm-field__lbl">Fat</span>
                  <span class="pm-field__in">
                    <input type="number" inputmode="numeric" [ngModel]="fatGoalG()" (ngModelChange)="fatGoalG.set($event)" placeholder="—" />
                    <span class="pm-field__suf">g</span>
                  </span>
                </label>
              </div>
            </div>

            @if (showAi()) {
              <div class="pm-ai">
                <button type="button" class="pm-ai__btn" [disabled]="aiLoading()" (click)="suggestWithAi()">
                  @if (aiLoading()) { <mat-icon class="pm-spin" aria-hidden="true">progress_activity</mat-icon> Thinking… }
                  @else { <mat-icon aria-hidden="true">auto_awesome</mat-icon> Suggest with AI }
                </button>
                @if (aiRationale(); as r) { <p class="pm-ai__why">{{ r }}</p> }
                @if (aiSafety(); as s) { <p class="pm-ai__safety"><mat-icon aria-hidden="true">info</mat-icon> {{ s }}</p> }
              </div>
            }
          </section>

          <!-- ─── PLAN HISTORY ─── -->
          <section class="pm-card pm-history">
            <div class="pm-card__head"><span class="pm-card__title"><mat-icon aria-hidden="true">history</mat-icon> Plan history</span></div>

            @if (plansLoading()) {
              <div class="pm-skel"><app-bs-skeleton height="64px" radius="var(--r-tile)" /><app-bs-skeleton height="64px" radius="var(--r-tile)" /></div>
            } @else if (!plans().length) {
              <app-bs-empty compact icon="event_note"
                title="No plan history yet"
                body="Your saved targets will appear here each time you update your plan." />
            } @else {
              <ul class="pm-plans">
                @for (p of plans(); track p.effectiveFrom; let i = $index) {
                  <li>
                    <button type="button" class="pm-plan" (click)="openPlan(p)">
                      <span class="pm-plan__orb" aria-hidden="true">
                        <mat-icon>{{ i === 0 ? 'flag' : 'history' }}</mat-icon>
                      </span>
                      <span class="pm-plan__main">
                        <span class="pm-plan__when">
                          {{ planEffectiveFrom(p.effectiveFrom) }}
                          @if (i === 0) { <span class="pm-plan__active">Active today</span> }
                        </span>
                        <span class="pm-plan__sub">
                          {{ goalLabel(p.goal) }}
                          @if (planRate(p.weeklyRateKg); as r) { · {{ r }} }
                          @if (p.dailyCalorieGoal != null) { · {{ p.dailyCalorieGoal }} kcal }
                        </span>
                      </span>
                      <mat-icon class="pm-plan__go" aria-hidden="true">chevron_right</mat-icon>
                    </button>
                  </li>
                }
              </ul>
            }
          </section>

          <p class="pm-foot" aria-hidden="true">Estimate mirrors your tracker · Save to version a new plan</p>
        }
      </div>
    </app-bs-pull-refresh>

    <!-- ─── STICKY SAVE BAR (hidden during the onboarding gate) ─── -->
    @if (!loading() && !needsBaseline()) {
      <div class="pm-savebar">
        <button type="button" class="pm-back" (click)="backToTracker()" aria-label="Back to tracker">
          <mat-icon aria-hidden="true">arrow_back</mat-icon>
        </button>
        <button type="button" class="pm-save" [disabled]="saving()" (click)="save()">
          @if (saving()) { <mat-icon class="pm-spin" aria-hidden="true">progress_activity</mat-icon> Saving… }
          @else { <mat-icon aria-hidden="true">check</mat-icon> Save plan }
        </button>
      </div>
    }

    <!-- ─── PLAN DETAIL SHEET ─── -->
    <app-bs-sheet [(open)]="sheetOpen" detent="half" [label]="'Plan detail'">
      @if (selectedPlan(); as p) {
        <div class="pmd">
          <div class="pmd__head">
            <span class="pmd__when">{{ planEffectiveFrom(p.effectiveFrom) }}</span>
            <span class="pmd__goal">{{ goalLabel(p.goal) }}</span>
          </div>
          <div class="pmd__grid">
            @if (planRate(p.weeklyRateKg); as r) { <div class="pmd__cell"><i>Pace</i><b>{{ r }}</b></div> }
            @if (p.dailyCalorieGoal != null) { <div class="pmd__cell"><i>Calories</i><b>{{ p.dailyCalorieGoal }} kcal</b></div> }
            @if (p.proteinGoalG != null) { <div class="pmd__cell"><i>Protein</i><b>{{ p.proteinGoalG }} g</b></div> }
            @if (p.carbGoalG != null) { <div class="pmd__cell"><i>Carbs</i><b>{{ p.carbGoalG }} g</b></div> }
            @if (p.fatGoalG != null) { <div class="pmd__cell"><i>Fat</i><b>{{ p.fatGoalG }} g</b></div> }
            @if (planWeight(p.weightKg); as w) { <div class="pmd__cell"><i>Weight</i><b>{{ w }}</b></div> }
            @if (p.bodyFatPct != null) { <div class="pmd__cell"><i>Body fat</i><b>{{ p.bodyFatPct }}%</b></div> }
            @if (activityLabel(p.activityLevel); as a) { <div class="pmd__cell"><i>Activity</i><b>{{ a }}</b></div> }
            @if (dietLabel(p.dietPattern); as d) { <div class="pmd__cell"><i>Diet</i><b>{{ d }}</b></div> }
          </div>
        </div>
      }
    </app-bs-sheet>

    <app-bs-toaster />
  `,
  styleUrl: './tracker-profile-mobile.page.scss',
})
export class TrackerProfileMobilePage {
  private api = inject(Api);
  private auth = inject(AuthService);
  private units = inject(UnitService);
  private router = inject(Router);
  private store = inject(TrackerStore);
  private toast = inject(ToastController);

  /** Master gate: every AI affordance is hidden unless the user holds tracker.ai. */
  readonly showAi = signal(this.auth.hasPermission(PERM.trackerAi));

  readonly goals = GOALS;
  readonly sexes = SEXES;
  readonly activityLevels = ACTIVITY_LEVELS;
  readonly unitSegments: Segment[] = [
    { key: 'Imperial', label: 'lb / ft' },
    { key: 'Metric', label: 'kg / cm' },
  ];

  private readonly profile = signal<TrackerProfileDto | null>(null);
  readonly loading = signal(true);
  readonly refreshing = signal(false);
  readonly saving = signal(false);
  readonly savingBaseline = signal(false);

  readonly plans = signal<GoalPlanDto[]>([]);
  readonly plansLoading = signal(false);

  // ---- plan detail sheet ----
  readonly sheetOpen = signal(false);
  readonly selectedPlan = signal<GoalPlanDto | null>(null);

  // ---- core goal/macro fields ----
  readonly goal = signal<string>('Maintain');
  readonly dailyCalorieGoal = signal<number | null>(null);
  readonly proteinGoalG = signal<number | null>(null);
  readonly carbGoalG = signal<number | null>(null);
  readonly fatGoalG = signal<number | null>(null);

  // ---- body profile ----
  readonly dateOfBirth = signal<string | null>(null);
  readonly sex = signal<Sex>('Unspecified');
  readonly activityLevel = signal<ActivityLevel>('Sedentary');

  readonly unitSystem = this.units.unitSystem;
  readonly imperial = this.units.imperial;

  // ---- unit-aware body inputs (display units; converted to metric on save) ----
  readonly heightCm = signal<number | null>(null);
  readonly heightFt = signal<number | null>(null);
  readonly heightIn = signal<number | null>(null);
  readonly weightDisp = signal<number | null>(null);

  // ---- AI suggestion ----
  readonly aiLoading = signal(false);
  readonly aiRationale = signal<string | null>(null);
  readonly aiSafety = signal<string | null>(null);

  constructor() {
    void this.reload();
  }

  // ─────────────── LOAD ───────────────

  async reload(): Promise<void> {
    const wasLoaded = !!this.profile();
    if (wasLoaded) this.refreshing.set(true); else this.loading.set(true);
    try {
      const p = await firstValueFrom(this.api.trackerProfile());
      this.applyProfile(p);
    } catch {
      this.applyProfile(null);
    } finally {
      this.loading.set(false);
      this.refreshing.set(false);
    }
    if (!this.needsBaseline()) void this.loadPlans();
  }

  private async loadPlans(): Promise<void> {
    this.plansLoading.set(true);
    try {
      this.plans.set(await firstValueFrom(this.api.goalPlans()));
    } catch {
      this.plans.set([]);
    } finally {
      this.plansLoading.set(false);
    }
  }

  /** Seed every form signal + the app-wide unit preference from a loaded profile (or sensible defaults). */
  private applyProfile(p: TrackerProfileDto | null): void {
    this.profile.set(p);
    this.units.setLocal(p?.unitSystem ?? 'Imperial');

    this.goal.set(p?.goal || 'Maintain');
    this.dailyCalorieGoal.set(p?.dailyCalorieGoal ?? null);
    this.proteinGoalG.set(p?.proteinGoalG ?? null);
    this.carbGoalG.set(p?.carbGoalG ?? null);
    this.fatGoalG.set(p?.fatGoalG ?? null);

    this.dateOfBirth.set(p?.dateOfBirth ?? null);
    this.sex.set(p?.sex ?? 'Unspecified');
    this.activityLevel.set(p?.activityLevel ?? 'Sedentary');

    this.heightCm.set(p?.heightCm ?? null);
    if (p?.heightCm != null) {
      const { ft, in: inches } = this.units.heightToFtIn(p.heightCm);
      this.heightFt.set(ft);
      this.heightIn.set(inches);
    } else {
      this.heightFt.set(null);
      this.heightIn.set(null);
    }
    this.weightDisp.set(this.toDisp(p?.weightKg));
  }

  // ─────────────── ONBOARDING GATE (verbatim predicate from the live page) ───────────────

  readonly needsBaseline = computed(() => {
    const p = this.profile();
    return p == null || p.weightKg == null || p.heightCm == null || !p.dateOfBirth || p.sex === 'Unspecified';
  });

  readonly onboardingSeed = computed<TrackerProfileDto | null>(() => this.profile());

  async onBaselineComplete(result: OnboardingResult): Promise<void> {
    if (this.savingBaseline()) return;
    this.savingBaseline.set(true);
    try {
      await this.store.saveProfile(result.profile);
      const today = this.store.date();
      const history = await this.store.weightHistory(7).catch(() => []);
      if (!history.some((w) => w.date === today)) {
        await this.store.logWeight({ date: today, weightKg: result.weightKg });
      }
      await this.reload();
      this.toast.show('Baseline saved', { tone: 'success', durationMs: 1800 });
    } catch {
      this.toast.show('Could not save your baseline', { tone: 'warn' });
    } finally {
      this.savingBaseline.set(false);
    }
  }

  // ─────────────── UNIT-AWARE HELPERS (mirror the live page) ───────────────

  get weightUnit(): string { return this.units.weightUnit(); }

  readonly todayIso = (() => {
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${mm}-${dd}`;
  })();

  private toDisp(kg: number | null | undefined): number | null {
    if (kg == null) return null;
    return Math.round(this.units.weightToDisplay(kg) * 10) / 10;
  }

  private currentHeightCm(): number | null {
    if (this.imperial()) {
      const ft = this.heightFt(), inches = this.heightIn();
      if ((ft == null || ft <= 0) && (inches == null || inches <= 0)) return null;
      return this.units.heightFromFtIn(ft ?? 0, inches ?? 0);
    }
    const cm = this.heightCm();
    return cm != null && cm > 0 ? cm : null;
  }

  private currentWeightKg(disp: number | null): number | null {
    if (disp == null || disp <= 0) return null;
    return this.units.weightToCanonical(disp);
  }

  /** Switch units — convert the in-flight display values so the body reads the same in new units. */
  onUnitChange(sys: UnitSystem): void {
    if (sys === this.unitSystem()) return;
    const toImperial = sys === 'Imperial';
    const cm = this.currentHeightCm();
    const wKg = this.currentWeightKg(this.weightDisp());

    this.units.setLocal(sys);

    if (cm != null) {
      if (toImperial) {
        const { ft, in: inches } = this.units.heightToFtIn(cm);
        this.heightFt.set(ft);
        this.heightIn.set(inches);
      } else {
        this.heightCm.set(Math.round(cm));
      }
    }
    this.weightDisp.set(this.toDisp(wKg));
  }

  // ─────────────── LIVE PREVIEW (same computeStats the live page reads) ───────────────

  readonly statsInputs = computed<StatsInputs>(() => ({
    weightKg: this.currentWeightKg(this.weightDisp()),
    heightCm: this.currentHeightCm(),
    age: ageFrom(this.dateOfBirth(), new Date()),
    sex: this.sex(),
    activityLevel: this.activityLevel(),
    goal: this.goal(),
    dailyCalorieGoal: this.dailyCalorieGoal(),
  }));

  readonly preview = computed(() => computeStats(this.statsInputs()));
  readonly hasSuggestion = computed(() => this.preview().suggestedCalorieGoal != null);

  readonly confidence = computed<'low' | 'med' | 'high'>(() => {
    const s = this.preview();
    return s.tdee == null ? 'low' : 'med';
  });
  readonly confidenceLabel = computed(() => {
    switch (this.confidence()) {
      case 'high': return 'High confidence';
      case 'med': return 'Good estimate';
      default: return 'Rough estimate';
    }
  });

  readonly heroSub = computed(() => {
    if (this.needsBaseline()) return 'Set up your baseline to unlock your plan.';
    const tdee = this.preview().tdee;
    if (tdee != null) return `Burning ~${tdee.toLocaleString()} kcal/day at your activity level.`;
    return 'Dial in your goal and daily targets.';
  });

  /** A preview number for a tile, "—" when null. */
  fmtNum(n: number | null | undefined): string {
    return n == null ? '—' : String(n);
  }

  useSuggested(): void {
    const s = this.preview();
    if (s.suggestedCalorieGoal != null) this.dailyCalorieGoal.set(s.suggestedCalorieGoal);
    if (s.suggestedProteinG != null) this.proteinGoalG.set(s.suggestedProteinG);
    if (s.suggestedCarbG != null) this.carbGoalG.set(s.suggestedCarbG);
    if (s.suggestedFatG != null) this.fatGoalG.set(s.suggestedFatG);
  }

  // ─────────────── AI SUGGESTION (gated; same endpoint as the live page) ───────────────

  async suggestWithAi(): Promise<void> {
    if (this.aiLoading()) return;
    this.aiLoading.set(true);
    try {
      const res = await firstValueFrom(this.api.suggestGoal());
      this.dailyCalorieGoal.set(res.calorieTarget);
      this.proteinGoalG.set(res.proteinG);
      this.carbGoalG.set(res.carbsG);
      this.fatGoalG.set(res.fatG);
      this.aiRationale.set(res.rationale ?? null);
      this.aiSafety.set(res.safetyNote ?? null);
    } catch {
      this.useSuggested();
      this.aiRationale.set(null);
      this.aiSafety.set(null);
      this.toast.show('AI offline — filled a calculated estimate you can adjust', { tone: 'warn' });
    } finally {
      this.aiLoading.set(false);
    }
  }

  // ─────────────── PLAN HISTORY RENDERING (unit-aware, copied from the live page) ───────────────

  readonly goalLabel = (g: string): string => GOALS.find((x) => x.value === g)?.label ?? g;
  readonly activityLabel = (a: string | undefined): string =>
    a ? (ACTIVITY_LEVELS.find((x) => x.value === a)?.label ?? a) : '';
  readonly dietLabel = (d: string | undefined): string =>
    d ? (DIET_PATTERNS.find((x) => x.value === d)?.label ?? d) : '';

  planRate(kgPerWk: number | null | undefined): string | null {
    if (kgPerWk == null || kgPerWk === 0) return null;
    const disp = this.units.rateToDisplay(Math.abs(kgPerWk));
    const sign = kgPerWk < 0 ? '−' : '+';
    return `${sign}${disp.toFixed(disp < 1 ? 2 : 1)} ${this.units.rateUnit()}`;
  }

  planWeight(kg: number | null | undefined): string | null {
    return this.units.formatWeight(kg, 1);
  }

  planEffectiveFrom(date: string): string {
    if (!date || date.startsWith('0001-01-01')) return 'Initial plan';
    const d = new Date(date + 'T00:00:00');
    if (!Number.isFinite(d.getTime())) return date;
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  openPlan(p: GoalPlanDto): void {
    this.selectedPlan.set(p);
    this.sheetOpen.set(true);
  }

  // ─────────────── SAVE ───────────────

  private num(v: number | null): number | undefined {
    return v != null && v >= 0 ? v : undefined;
  }

  /** Persist the profile through the store (versioning a GoalPlan server-side when targets change), then reload. */
  async save(): Promise<void> {
    if (this.saving()) return;
    this.saving.set(true);

    const heightCm = this.currentHeightCm();
    const weightKg = this.currentWeightKg(this.weightDisp());
    const roundedWeight = weightKg != null ? Math.round(weightKg * 100) / 100 : undefined;
    const prev = this.profile();

    const body: TrackerProfileDto = {
      ...(prev ?? { shareWithContacts: false, sex: 'Unspecified', activityLevel: 'Sedentary' }),
      goal: this.goal(),
      weightKg: roundedWeight,
      dailyCalorieGoal: this.num(this.dailyCalorieGoal()),
      proteinGoalG: this.num(this.proteinGoalG()),
      carbGoalG: this.num(this.carbGoalG()),
      fatGoalG: this.num(this.fatGoalG()),
      dateOfBirth: this.dateOfBirth() || null,
      heightCm: heightCm != null ? Math.round(heightCm * 10) / 10 : undefined,
      sex: this.sex(),
      activityLevel: this.activityLevel(),
      unitSystem: this.unitSystem(),
    };

    try {
      await this.store.saveProfile(body);
      await this.reload();
      this.toast.show('Plan saved', { tone: 'success', durationMs: 1800 });
    } catch {
      this.toast.show('Could not save your plan', { tone: 'warn' });
    } finally {
      this.saving.set(false);
    }
  }

  backToTracker(): void {
    void this.router.navigate(['/tracker']);
  }
}
