import { Component, computed, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSnackBar } from '@angular/material/snack-bar';

import { Api } from '../../core/api';
import { AuthService } from '../../core/auth';
import { UnitService } from '../../core/unit.service';
import { TrackerStore } from '../../core/tracker-store';
import {
  ActivityLevel,
  DietPattern,
  EatingWindow,
  GoalPlanDto,
  LifeStage,
  PERM,
  ProteinBasis,
  Sex,
  TrackerGoal,
  TrackerProfileDto,
  TrainingType,
  UnitSystem,
} from '../../core/models';
import { StatsInputs, ageFrom, computeStats } from './units';
import { OnboardingCard, OnboardingResult } from './onboarding-card';

const GOALS: { value: TrackerGoal; label: string }[] = [
  { value: 'LoseWeight', label: 'Lose weight' },
  { value: 'Maintain', label: 'Maintain' },
  { value: 'GainMuscle', label: 'Gain muscle' },
  { value: 'Endurance', label: 'Endurance' },
];

const SEXES: { value: Sex; label: string }[] = [
  { value: 'Unspecified', label: 'Prefer not to say' },
  { value: 'Male', label: 'Male' },
  { value: 'Female', label: 'Female' },
];

const ACTIVITY_LEVELS: { value: ActivityLevel; label: string }[] = [
  { value: 'Sedentary', label: 'Sedentary (little/no exercise)' },
  { value: 'Light', label: 'Light (1–3 days/week)' },
  { value: 'Moderate', label: 'Moderate (3–5 days/week)' },
  { value: 'Active', label: 'Active (6–7 days/week)' },
  { value: 'VeryActive', label: 'Very active (hard daily / physical job)' },
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

const TRAINING_TYPES: { value: TrainingType; label: string }[] = [
  { value: 'None', label: 'None' },
  { value: 'Strength', label: 'Strength' },
  { value: 'Endurance', label: 'Endurance' },
  { value: 'Hybrid', label: 'Hybrid' },
];

const EATING_WINDOWS: { value: EatingWindow; label: string }[] = [
  { value: 'None', label: 'No fasting' },
  { value: 'W16x8', label: '16:8' },
  { value: 'W18x6', label: '18:6' },
  { value: 'OMAD', label: 'OMAD' },
];

/** Weight drift (kg) past which the check-in banner suggests a recompute. */
const CHECKIN_DRIFT_KG = 1.5;
/** Baseline staleness (days) past which the check-in banner suggests a recompute. */
const CHECKIN_STALE_DAYS = 90;

/**
 * Unified "My Profile & Goal" page (route: tracker/profile). The CANONICAL surface for editing the
 * caller's tracker profile + goal, folding three things into one screen:
 *
 *  1. First-run ONBOARDING gate — when the baseline is incomplete (current weight, height, DOB, explicit
 *     sex) the page renders the same blocking {@link OnboardingCard} the tracker uses inline. Same
 *     verbatim 4-field gate (OnboardingCard.canSave); on save it persists + seeds today's weigh-in.
 *  2. Full profile + all optional goal-builder fields — the entire {@link ProfileDialog} field set
 *     (goal, body profile, calorie + macro targets, hydration/step/coffee, the Fine-tune panel) with the
 *     live Estimated-TDEE preview (the same {@link computeStats}) and the AI affordances (gated by
 *     tracker.ai), all unit-aware through the central {@link UnitService} (weight/height/length/volume +
 *     the new weekly-rate seam).
 *  3. PLAN HISTORY — the dated, read-only list of past {@link GoalPlanDto}s (newest-first, the top one
 *     badged "Active today") from GET /api/tracker/goal-plans, rendered through the unit-aware rate seam.
 *
 * The existing {@link ProfileDialog} stays as a quick-edit (it deep-links here via a "Full editor" link).
 */
@Component({
  selector: 'app-tracker-profile-page',
  imports: [
    FormsModule,
    RouterLink,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatButtonModule,
    MatButtonToggleModule,
    MatCheckboxModule,
    MatIconModule,
    MatProgressSpinnerModule,
    MatProgressBarModule,
    OnboardingCard,
  ],
  templateUrl: './profile-page.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrls: ['./profile-dialog.scss', './profile-page.scss'],
})
export class ProfilePage {
  private api = inject(Api);
  private snack = inject(MatSnackBar);
  private auth = inject(AuthService);
  private units = inject(UnitService);
  private router = inject(Router);
  private store = inject(TrackerStore);

  /** Master gate: every AI affordance is hidden unless the user holds tracker.ai. */
  readonly showAi = this.auth.hasPermission(PERM.trackerAi);

  readonly goals = GOALS;
  readonly sexes = SEXES;
  readonly activityLevels = ACTIVITY_LEVELS;
  readonly dietPatterns = DIET_PATTERNS;
  readonly trainingTypes = TRAINING_TYPES;
  readonly eatingWindows = EATING_WINDOWS;

  /** The loaded profile, or null until the first load. Drives the onboarding gate + form seeding. */
  private readonly profile = signal<TrackerProfileDto | null>(null);
  readonly loading = signal(true);
  readonly saving = signal(false);
  /** True while the blocking onboarding result is being persisted (own onboarding host). */
  readonly savingBaseline = signal(false);

  /** Plan history (newest-first), or empty before/without history. */
  readonly plans = signal<GoalPlanDto[]>([]);
  readonly plansLoading = signal(false);

  // ---- core goal/macro fields ----
  readonly goal = signal<string>('Maintain');
  readonly dailyCalorieGoal = signal<number | null>(null);
  readonly proteinGoalG = signal<number | null>(null);
  readonly carbGoalG = signal<number | null>(null);
  readonly fatGoalG = signal<number | null>(null);
  readonly stepGoal = signal<number | null>(null);
  readonly coffeeGoalCups = signal<number | null>(null);
  readonly shareWithContacts = signal<boolean>(false);

  // ---- body profile ----
  readonly dateOfBirth = signal<string | null>(null);
  readonly sex = signal<Sex>('Unspecified');
  readonly activityLevel = signal<ActivityLevel>('Sedentary');

  // ---- optional goal-builder refinements ----
  /** Weekly pace held in the DISPLAYED rate unit (lb/wk or kg/wk); converted to canonical kg/wk on save. */
  readonly weeklyRateDisp = signal<number | null>(null);
  readonly bodyFatPct = signal<number | null>(null);
  readonly dietPattern = signal<DietPattern>('Balanced');
  readonly trainingType = signal<TrainingType>('None');
  readonly proteinBasis = signal<ProteinBasis>('PerBodyweight');
  readonly lifeStage = signal<LifeStage>('None');
  readonly trimester = signal<number | null>(null);
  readonly mealsPerDay = signal<number | null>(null);
  readonly eatingWindow = signal<EatingWindow>('None');
  readonly restrictions = signal<string | null>(null);

  // ---- Navy-tape circumferences, held in the DISPLAYED unit (in or cm) ----
  readonly neckDisp = signal<number | null>(null);
  readonly waistDisp = signal<number | null>(null);
  readonly hipDisp = signal<number | null>(null);
  /** Whether the optional "Fine-tune" panel is expanded. */
  readonly refineOpen = signal(false);

  readonly unitSystem = this.units.unitSystem;
  readonly imperial = this.units.imperial;

  // ---- unit-aware body inputs (display units; converted to metric on save) ----
  readonly heightCm = signal<number | null>(null);
  readonly heightFt = signal<number | null>(null);
  readonly heightIn = signal<number | null>(null);
  readonly weightDisp = signal<number | null>(null);
  readonly goalWeightDisp = signal<number | null>(null);
  readonly hydrationGoalDisp = signal<number | null>(null);

  constructor() {
    void this.reload();
  }

  /** Load the profile, seed the form + unit preference, and (when the baseline is set) the plan history. */
  async reload(): Promise<void> {
    this.loading.set(true);
    try {
      const p = await firstValueFrom(this.api.trackerProfile());
      this.applyProfile(p);
    } catch {
      // No tracker permission / offline — leave the gate to show a fresh baseline form.
      this.applyProfile(null);
    } finally {
      this.loading.set(false);
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
    // Seed the unit preference (display only): existing users from profile.unitSystem, new users Imperial.
    this.units.setLocal(p?.unitSystem ?? 'Imperial');

    this.goal.set(p?.goal || 'Maintain');
    this.dailyCalorieGoal.set(p?.dailyCalorieGoal ?? null);
    this.proteinGoalG.set(p?.proteinGoalG ?? null);
    this.carbGoalG.set(p?.carbGoalG ?? null);
    this.fatGoalG.set(p?.fatGoalG ?? null);
    this.stepGoal.set(p?.stepGoal ?? null);
    this.coffeeGoalCups.set(p?.coffeeGoalCups ?? null);
    this.shareWithContacts.set(p?.shareWithContacts ?? false);

    this.dateOfBirth.set(p?.dateOfBirth ?? null);
    this.sex.set(p?.sex ?? 'Unspecified');
    this.activityLevel.set(p?.activityLevel ?? 'Sedentary');

    this.weeklyRateDisp.set(this.toRateDisp(p?.weeklyRateKg));
    this.bodyFatPct.set(p?.bodyFatPct ?? null);
    this.dietPattern.set(p?.dietPattern ?? 'Balanced');
    this.trainingType.set(p?.trainingType ?? 'None');
    this.proteinBasis.set(p?.proteinBasis ?? 'PerBodyweight');
    this.lifeStage.set(p?.lifeStage ?? 'None');
    this.trimester.set(p?.trimester ?? null);
    this.mealsPerDay.set(p?.mealsPerDay ?? null);
    this.eatingWindow.set(p?.eatingWindow ?? 'None');
    this.restrictions.set(p?.restrictions ?? null);

    this.neckDisp.set(this.toLenDisp(p?.neckCm));
    this.waistDisp.set(this.toLenDisp(p?.waistCm));
    this.hipDisp.set(this.toLenDisp(p?.hipCm));

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
    this.goalWeightDisp.set(this.toDisp(p?.goalWeightKg));
    this.hydrationGoalDisp.set(this.toVolDisp(p?.hydrationGoalMl));
  }

  // ---- onboarding gate (the VERBATIM 4-field predicate from tracker.ts:638-643) ----
  /**
   * True when the caller's OWN baseline is incomplete: any of current weight, height, date of birth, or an
   * explicit biological sex is missing. Renders the blocking onboarding card in place of the full editor.
   */
  readonly needsBaseline = computed(() => {
    const p = this.profile();
    return p == null || p.weightKg == null || p.heightCm == null || !p.dateOfBirth || p.sex === 'Unspecified';
  });

  /** The seed profile for the onboarding card (partial profile prefill). */
  readonly onboardingSeed = computed<TrackerProfileDto | null>(() => this.profile());

  /**
   * Complete the blocking baseline onboarding: persist the profile and (when today has no weigh-in yet)
   * seed today's WeightEntry. Then reload so the gate clears and the full editor renders. Mirrors
   * Tracker.onBaselineComplete.
   */
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
      this.snack.open('Baseline saved', 'OK', { duration: 2000 });
    } catch {
      this.snack.open('Could not save your baseline', 'Dismiss', { duration: 4000 });
    } finally {
      this.savingBaseline.set(false);
    }
  }

  // ── suffixes ──────────────────────────────────────────────────────────────
  get weightUnit(): string {
    return this.units.weightUnit();
  }
  get volumeUnit(): string {
    return this.units.volumeUnit();
  }
  get lengthUnit(): string {
    return this.units.lengthUnit();
  }
  /** Weekly-pace suffix ('lb/wk' | 'kg/wk'). */
  get rateUnit(): string {
    return this.units.rateUnit();
  }
  /** Sensible step for the weekly-pace input in the active unit (0.1 lb/wk, 0.05 kg/wk). */
  get rateStep(): number {
    return this.units.imperial() ? 0.1 : 0.05;
  }
  get hydrationDefaultHint(): string {
    return `~${this.units.formatVolume(2000)}`;
  }

  readonly todayIso = (() => {
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${mm}-${dd}`;
  })();

  // ── display ↔ canonical helpers (mirror ProfileDialog) ──────────────────────
  private toDisp(kg: number | null | undefined): number | null {
    if (kg == null) return null;
    return Math.round(this.units.weightToDisplay(kg) * 10) / 10;
  }
  private toVolDisp(ml: number | null | undefined): number | null {
    if (ml == null) return null;
    return Math.round(this.units.volumeToDisplay(ml));
  }
  private toLenDisp(cm: number | null | undefined): number | null {
    if (cm == null) return null;
    return Math.round(this.units.lengthToDisplay(cm) * 10) / 10;
  }
  /** A canonical kg/wk pace as a DISPLAY value (lb/wk or kg/wk); null passes through. */
  private toRateDisp(kgPerWk: number | null | undefined): number | null {
    if (kgPerWk == null) return null;
    return Math.round(this.units.rateToDisplay(kgPerWk) * 100) / 100;
  }
  private toCm(disp: number | null): number | null {
    if (disp == null || disp <= 0) return null;
    return this.units.lengthToCanonical(disp);
  }
  private currentHydrationGoalMl(disp: number | null): number | null {
    if (disp == null || disp <= 0) return null;
    return Math.round(this.units.volumeToCanonical(disp));
  }
  /** A display pace (lb/wk or kg/wk) back to canonical kg/wk; null passes through (0 = no preference). */
  private currentWeeklyRateKg(disp: number | null): number | null {
    if (disp == null) return null;
    return Math.round(this.units.rateToCanonical(disp) * 1000) / 1000;
  }

  /** The canonical kg/wk pace from the in-flight display value — what the calc + save consume. */
  readonly weeklyRateKg = computed<number | null>(() => this.currentWeeklyRateKg(this.weeklyRateDisp()));

  /** Switch units — convert the in-flight display values so the user sees the same body in new units. */
  onUnitChange(sys: UnitSystem): void {
    if (sys === this.unitSystem()) return;
    const toImperial = sys === 'Imperial';

    const cm = this.currentHeightCm();
    const wKg = this.currentWeightKg(this.weightDisp());
    const gKg = this.currentWeightKg(this.goalWeightDisp());
    const hydMl = this.currentHydrationGoalMl(this.hydrationGoalDisp());
    const neckCm = this.toCm(this.neckDisp());
    const waistCm = this.toCm(this.waistDisp());
    const hipCm = this.toCm(this.hipDisp());
    const rateKg = this.currentWeeklyRateKg(this.weeklyRateDisp());

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
    this.goalWeightDisp.set(this.toDisp(gKg));
    this.hydrationGoalDisp.set(this.toVolDisp(hydMl));
    this.neckDisp.set(this.toLenDisp(neckCm));
    this.waistDisp.set(this.toLenDisp(waistCm));
    this.hipDisp.set(this.toLenDisp(hipCm));
    this.weeklyRateDisp.set(this.toRateDisp(rateKg));
  }

  private currentHeightCm(): number | null {
    if (this.imperial()) {
      const ft = this.heightFt(),
        inches = this.heightIn();
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

  // ---- live stats preview (mirrors the backend helper) ----
  readonly statsInputs = computed<StatsInputs>(() => ({
    weightKg: this.currentWeightKg(this.weightDisp()),
    heightCm: this.currentHeightCm(),
    age: ageFrom(this.dateOfBirth(), new Date()),
    sex: this.sex(),
    activityLevel: this.activityLevel(),
    goal: this.goal(),
    dailyCalorieGoal: this.dailyCalorieGoal(),
    weeklyRateKg: this.weeklyRateKg(),
    bodyFatPct: this.bodyFatPct(),
    dietPattern: this.dietPattern(),
    trainingType: this.trainingType(),
    proteinBasis: this.proteinBasis(),
    lifeStage: this.lifeStage(),
    trimester: this.lifeStage() === 'Pregnant' ? this.trimester() : null,
  }));

  readonly preview = computed(() => computeStats(this.statsInputs()));
  readonly hasSuggestion = computed(() => this.preview().suggestedCalorieGoal != null);
  readonly showTrimester = computed(() => this.lifeStage() === 'Pregnant');

  /** Estimate confidence (mirrors OnboardingCard): "high" once body-fat is known, "med" with TDEE, else "low". */
  readonly confidence = computed<'low' | 'med' | 'high'>(() => {
    const s = this.preview();
    if (s.tdee == null) return 'low';
    if (this.bodyFatPct() != null) return 'high';
    return 'med';
  });
  readonly confidenceLabel = computed(() => {
    switch (this.confidence()) {
      case 'high':
        return 'High confidence';
      case 'med':
        return 'Good estimate';
      default:
        return 'Rough estimate';
    }
  });

  readonly navyBodyFatPct = computed<number | null>(() => {
    const heightCm = this.currentHeightCm();
    const sex = this.sex();
    if (heightCm == null || heightCm <= 0 || sex === 'Unspecified') return null;
    const neck = this.toCm(this.neckDisp());
    const waist = this.toCm(this.waistDisp());
    if (neck == null || waist == null) return null;

    let pct: number;
    if (sex === 'Female') {
      const hip = this.toCm(this.hipDisp());
      if (hip == null) return null;
      const v = waist + hip - neck;
      if (v <= 0) return null;
      pct = 163.205 * Math.log10(v) - 97.684 * Math.log10(heightCm) - 78.387;
    } else {
      const v = waist - neck;
      if (v <= 0) return null;
      pct = 86.01 * Math.log10(v) - 70.041 * Math.log10(heightCm) + 36.76;
    }
    if (!Number.isFinite(pct)) return null;
    pct = Math.round(pct * 10) / 10;
    return pct > 0 && pct < 100 ? pct : null;
  });

  applyNavyBodyFat(): void {
    const bf = this.navyBodyFatPct();
    if (bf != null) this.bodyFatPct.set(bf);
  }

  /** A compact read-only digest of what the AI meal recommenders are told (eating style · restrictions · pace). */
  readonly dietSummary = computed<string[]>(() => {
    const parts: string[] = [];
    const pat = this.dietPattern();
    if (pat && pat !== 'Balanced') parts.push(DIET_PATTERNS.find((d) => d.value === pat)?.label ?? pat);

    const raw = (this.restrictions() ?? '').trim();
    if (raw) {
      raw
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
        .forEach((t) => parts.push(`no ${t.toLowerCase()}`));
    }

    const rate = this.weeklyRateKg();
    if (rate != null && rate !== 0) {
      const dir = rate < 0 ? 'cutting' : 'gaining';
      const disp = this.units.formatWeight(Math.abs(rate), Math.abs(rate) < 1 ? 2 : 1);
      if (disp) parts.push(`${dir} ${disp}/wk`);
    }

    const win = this.eatingWindow();
    if (win && win !== 'None') parts.push(win === 'OMAD' ? 'OMAD' : win.replace('W', '').replace('x', ':'));
    return parts;
  });

  // ---- non-blocking check-in banner ----
  readonly checkInDismissed = signal(false);
  readonly checkIn = computed<{ reason: string } | null>(() => {
    if (this.checkInDismissed()) return null;
    const p = this.profile();
    if (!p) return null;
    const latestKg = p.weightKg;

    if (p.goalBasisWeightKg != null && latestKg != null) {
      const drift = Math.abs(latestKg - p.goalBasisWeightKg);
      if (drift >= CHECKIN_DRIFT_KG) {
        return { reason: `Your weight has moved ${this.units.formatWeight(drift, 1)} since your last target.` };
      }
    }
    if (p.baselineReviewedUtc) {
      const reviewed = new Date(p.baselineReviewedUtc).getTime();
      if (Number.isFinite(reviewed)) {
        const days = (Date.now() - reviewed) / 86_400_000;
        if (days >= CHECKIN_STALE_DAYS) {
          return { reason: `It's been over ${Math.round(days)} days since you last reviewed your target.` };
        }
      }
    }
    return null;
  });

  recomputeFromCheckIn(): void {
    this.useSuggested();
    this.checkInDismissed.set(true);
    this.snack.open('Targets recomputed — review and Save to keep them.', 'OK', { duration: 4000 });
  }

  useSuggested(): void {
    const s = this.preview();
    if (s.suggestedCalorieGoal != null) this.dailyCalorieGoal.set(s.suggestedCalorieGoal);
    if (s.suggestedProteinG != null) this.proteinGoalG.set(s.suggestedProteinG);
    if (s.suggestedCarbG != null) this.carbGoalG.set(s.suggestedCarbG);
    if (s.suggestedFatG != null) this.fatGoalG.set(s.suggestedFatG);
  }

  // ---- AI goal suggestion ----
  readonly aiLoading = signal(false);
  readonly aiRationale = signal<string | null>(null);
  readonly aiAnnounce = signal('');
  readonly aiSource = signal<'ai' | 'formula' | null>(null);
  readonly aiConfidence = signal<string | null>(null);
  readonly aiBand = signal<{ min: number; max: number } | null>(null);
  readonly aiSafety = signal<string | null>(null);

  readonly aiSourceLabel = computed(() => {
    const src = this.aiSource();
    if (src === 'ai') return 'AI-tailored';
    if (src === 'formula') return 'Calculated default';
    return null;
  });

  async suggestWithAi(): Promise<void> {
    if (this.aiLoading()) return;
    this.aiLoading.set(true);
    this.aiAnnounce.set('Suggesting a goal with AI…');
    try {
      const res = await firstValueFrom(this.api.suggestGoal());
      this.dailyCalorieGoal.set(res.calorieTarget);
      this.proteinGoalG.set(res.proteinG);
      this.carbGoalG.set(res.carbsG);
      this.fatGoalG.set(res.fatG);
      this.aiRationale.set(res.rationale ?? null);
      this.aiSource.set(res.source === 'ai' ? 'ai' : 'formula');
      this.aiConfidence.set(res.confidence ?? null);
      this.aiBand.set(res.calorieMin && res.calorieMax ? { min: res.calorieMin, max: res.calorieMax } : null);
      this.aiSafety.set(res.safetyNote ?? null);
      const lead = res.source === 'ai' ? 'AI suggested' : 'Calculated a';
      this.aiAnnounce.set(
        `${lead} ${res.calorieTarget} calories per day: ${res.proteinG} grams protein, ` +
          `${res.carbsG} grams carbs, ${res.fatG} grams fat.` +
          (res.safetyNote ? ` ${res.safetyNote}` : '') +
          (res.rationale ? ` ${res.rationale}` : ''),
      );
    } catch {
      this.useSuggested();
      this.aiRationale.set(null);
      this.aiSource.set('formula');
      this.aiConfidence.set(null);
      this.aiBand.set(null);
      this.aiSafety.set(null);
      this.aiAnnounce.set('Used a calculated estimate (AI offline). Adjust as you like.');
      this.snack.open('AI offline — filled a calculated estimate you can adjust', 'OK', { duration: 4000 });
    } finally {
      this.aiLoading.set(false);
    }
  }

  // ---- AI natural-goal ----
  readonly goalText = signal('');
  readonly goalLoading = signal(false);
  readonly goalTimeline = signal<string | null>(null);
  readonly goalRealistic = signal<boolean | null>(null);
  readonly goalRationale = signal<string | null>(null);

  readonly canDescribeGoal = computed(() => this.goalText().trim().length > 0 && !this.goalLoading());

  async describeGoalWithAi(): Promise<void> {
    const text = this.goalText().trim();
    if (!text || this.goalLoading()) return;
    this.goalLoading.set(true);
    this.aiAnnounce.set('Reading your goal with AI…');
    try {
      const res = await firstValueFrom(this.api.naturalGoal({ text }));
      this.dailyCalorieGoal.set(res.calorieTarget);
      this.proteinGoalG.set(res.proteinG);
      this.carbGoalG.set(res.carbsG);
      this.fatGoalG.set(res.fatG);
      this.goalTimeline.set(res.timeline ?? null);
      this.goalRealistic.set(res.realistic);
      this.goalRationale.set(res.rationale ?? null);
      this.aiSource.set(res.source === 'ai' ? 'ai' : 'formula');
      this.aiConfidence.set(res.confidence ?? null);
      this.aiBand.set(res.calorieMin && res.calorieMax ? { min: res.calorieMin, max: res.calorieMax } : null);
      this.aiSafety.set(res.safetyNote ?? null);
      const verdict = res.realistic ? 'This timeline looks realistic.' : 'This timeline may be aggressive.';
      const lead = res.source === 'ai' ? 'AI set a goal of' : 'Calculated a goal of';
      this.aiAnnounce.set(
        `${lead} ${res.calorieTarget} calories per day: ${res.proteinG} grams protein, ` +
          `${res.carbsG} grams carbs, ${res.fatG} grams fat.` +
          (res.timeline ? ` Timeline: ${res.timeline}.` : '') +
          ` ${verdict}` +
          (res.safetyNote ? ` ${res.safetyNote}` : '') +
          (res.rationale ? ` ${res.rationale}` : ''),
      );
    } catch {
      this.useSuggested();
      this.goalTimeline.set(null);
      this.goalRealistic.set(null);
      this.goalRationale.set(null);
      this.aiSource.set('formula');
      this.aiConfidence.set(null);
      this.aiBand.set(null);
      this.aiSafety.set(null);
      this.aiAnnounce.set('Used a calculated estimate (AI offline). Adjust as you like.');
      this.snack.open('AI offline — filled a calculated estimate you can adjust', 'OK', { duration: 4000 });
    } finally {
      this.goalLoading.set(false);
    }
  }

  // ---- plan-history rendering helpers (unit-aware) ----
  readonly goalLabel = (g: string): string => GOALS.find((x) => x.value === g)?.label ?? g;
  readonly activityLabel = (a: string | undefined): string =>
    a ? (ACTIVITY_LEVELS.find((x) => x.value === a)?.label ?? a) : '';
  readonly dietLabel = (d: string | undefined): string =>
    d ? (DIET_PATTERNS.find((x) => x.value === d)?.label ?? d) : '';

  /** Format a plan's signed pace via the unit-aware rate seam, e.g. "−1.1 lb/wk" / "+0.25 kg/wk". */
  planRate(kgPerWk: number | null | undefined): string | null {
    if (kgPerWk == null || kgPerWk === 0) return null;
    const disp = this.units.rateToDisplay(Math.abs(kgPerWk));
    const sign = kgPerWk < 0 ? '−' : '+';
    return `${sign}${disp.toFixed(disp < 1 ? 2 : 1)} ${this.units.rateUnit()}`;
  }

  /** Format a plan's snapshot weight (kg) via the unit-aware seam, e.g. "165.3 lb". */
  planWeight(kg: number | null | undefined): string | null {
    return this.units.formatWeight(kg, 1);
  }

  /** Friendly effective-from label; the sentinel "0001-01-01" reads as the initial plan. */
  planEffectiveFrom(date: string): string {
    if (!date || date.startsWith('0001-01-01')) return 'Initial plan';
    const d = new Date(date + 'T00:00:00');
    if (!Number.isFinite(d.getTime())) return date;
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  private num(v: number | null): number | undefined {
    return v != null && v >= 0 ? v : undefined;
  }

  /** Persist the full profile (versioning a GoalPlan server-side when targets change), then reload. */
  async save(): Promise<void> {
    if (this.saving()) return;
    this.saving.set(true);

    const heightCm = this.currentHeightCm();
    const weightKg = this.currentWeightKg(this.weightDisp());
    const goalWeightKg = this.currentWeightKg(this.goalWeightDisp());
    const hydrationGoalMl = this.currentHydrationGoalMl(this.hydrationGoalDisp());
    const roundedWeight = weightKg != null ? Math.round(weightKg * 100) / 100 : undefined;
    const reAnchor = this.checkInDismissed();

    const neckCm = this.toCm(this.neckDisp());
    const waistCm = this.toCm(this.waistDisp());
    const hipCm = this.toCm(this.hipDisp());
    const restrictionsCsv =
      (this.restrictions() ?? '')
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
        .join(', ') || null;
    const trimester = this.lifeStage() === 'Pregnant' ? this.num(this.trimester()) : undefined;
    const prev = this.profile();

    const body: TrackerProfileDto = {
      goal: this.goal(),
      weightKg: roundedWeight,
      dailyCalorieGoal: this.num(this.dailyCalorieGoal()),
      proteinGoalG: this.num(this.proteinGoalG()),
      carbGoalG: this.num(this.carbGoalG()),
      fatGoalG: this.num(this.fatGoalG()),
      shareWithContacts: this.shareWithContacts(),
      dateOfBirth: this.dateOfBirth() || null,
      heightCm: heightCm != null ? Math.round(heightCm * 10) / 10 : undefined,
      sex: this.sex(),
      activityLevel: this.activityLevel(),
      goalWeightKg: goalWeightKg != null ? Math.round(goalWeightKg * 100) / 100 : undefined,
      unitSystem: this.unitSystem(),
      hydrationGoalMl: hydrationGoalMl ?? undefined,
      stepGoal: this.num(this.stepGoal()),
      coffeeGoalCups: this.num(this.coffeeGoalCups()),
      weeklyRateKg: this.weeklyRateKg() ?? undefined,
      bodyFatPct: this.num(this.bodyFatPct()),
      neckCm: neckCm != null ? Math.round(neckCm * 10) / 10 : undefined,
      waistCm: waistCm != null ? Math.round(waistCm * 10) / 10 : undefined,
      hipCm: hipCm != null ? Math.round(hipCm * 10) / 10 : undefined,
      dietPattern: this.dietPattern(),
      restrictions: restrictionsCsv,
      trainingType: this.trainingType(),
      proteinBasis: this.proteinBasis(),
      lifeStage: this.lifeStage(),
      trimester,
      mealsPerDay: this.num(this.mealsPerDay()),
      eatingWindow: this.eatingWindow(),
      goalBasisWeightKg: reAnchor ? roundedWeight : (prev?.goalBasisWeightKg ?? undefined),
      baselineReviewedUtc: reAnchor ? new Date().toISOString() : (prev?.baselineReviewedUtc ?? undefined),
    };

    try {
      // Save through the store so the tracker day/totals also refresh; then reload the page form + history.
      await this.store.saveProfile(body);
      await this.reload();
      this.snack.open('Profile saved', 'OK', { duration: 2000 });
    } catch {
      this.snack.open('Could not save your profile', 'Dismiss', { duration: 4000 });
    } finally {
      this.saving.set(false);
    }
  }

  /** Back to the tracker dashboard. */
  backToTracker(): void {
    void this.router.navigate(['/tracker']);
  }
}
