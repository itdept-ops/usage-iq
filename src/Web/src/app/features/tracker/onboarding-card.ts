import {
  AfterViewInit,
  Component,
  ElementRef,
  OnInit,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
  ChangeDetectionStrategy,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatSliderModule } from '@angular/material/slider';
import { MatIconModule } from '@angular/material/icon';

import { UnitService } from '../../core/unit.service';
import {
  ActivityLevel,
  DietPattern,
  EatingWindow,
  LifeStage,
  ProteinBasis,
  Sex,
  TrackerGoal,
  TrackerProfileDto,
  TrainingType,
  UnitSystem,
} from '../../core/models';
import { StatsInputs, ageFrom, computeStats } from './units';

/** Emitted when the user completes the baseline. Metric profile + the entered current weight (kg). */
export interface OnboardingResult {
  profile: TrackerProfileDto;
  weightKg: number;
}

const GOALS: { value: TrackerGoal; label: string }[] = [
  { value: 'LoseWeight', label: 'Lose weight' },
  { value: 'Maintain', label: 'Maintain' },
  { value: 'GainMuscle', label: 'Gain muscle' },
  { value: 'Endurance', label: 'Endurance' },
];

// Onboarding requires an explicit biological sex, so "Prefer not to say" is omitted here.
const SEXES: { value: Sex; label: string }[] = [
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

/** Friendlier one-line "how active are you?" prompts mapped onto the canonical ActivityLevel values. */
const ACTIVITY_CHIPS: { value: ActivityLevel; label: string; hint: string }[] = [
  { value: 'Sedentary', label: 'Desk job', hint: 'Little/no exercise' },
  { value: 'Light', label: 'Lightly active', hint: '1–3 days/week' },
  { value: 'Moderate', label: 'Active', hint: '3–5 days/week' },
  { value: 'Active', label: 'Very active', hint: '6–7 days/week' },
  { value: 'VeryActive', label: 'Athlete', hint: 'Hard daily / physical job' },
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

/** A few common restriction tags; toggled into the free-text `restrictions` CSV (AI constraint only). */
const RESTRICTION_TAGS = ['Gluten-free', 'Dairy-free', 'Nut-free', 'Shellfish-free', 'No pork', 'Halal', 'Kosher'];

/** Silhouette body-fat presets per sex (mid-band % used when a user picks a silhouette instead of a number). */
const BODYFAT_SILHOUETTES: { Male: { pct: number; label: string }[]; Female: { pct: number; label: string }[] } = {
  Male: [
    { pct: 10, label: 'Lean' },
    { pct: 15, label: 'Fit' },
    { pct: 20, label: 'Average' },
    { pct: 28, label: 'Higher' },
  ],
  Female: [
    { pct: 18, label: 'Lean' },
    { pct: 24, label: 'Fit' },
    { pct: 30, label: 'Average' },
    { pct: 38, label: 'Higher' },
  ],
};

/**
 * Blocking baseline onboarding for the caller's OWN tracker. Shown in place of the dashboard when the
 * profile baseline is incomplete (missing current weight, height, DOB, or an explicit biological sex).
 * Mirrors the profile dialog's body-profile form (units + height/weight conversion + the live BMI/BMR/
 * TDEE preview) but renders inline with no cancel/skip and gates the rest of the page until saved.
 *
 * On save it emits the metric {@link TrackerProfileDto} plus the entered current weight in kg, so the
 * page can persist the profile AND seed a day-one WeightEntry.
 */
@Component({
  selector: 'app-tracker-onboarding',
  imports: [
    FormsModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatButtonModule,
    MatButtonToggleModule,
    MatSlideToggleModule,
    MatSliderModule,
    MatIconModule,
  ],
  templateUrl: './onboarding-card.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './onboarding-card.scss',
})
export class OnboardingCard implements OnInit, AfterViewInit {
  private readonly units = inject(UnitService);

  /** Seed profile (existing defaults / partial profile) to prefill the form. */
  readonly profile = input<TrackerProfileDto | null>(null);

  /** Emitted once with the metric profile + current weight (kg) when the baseline is complete. */
  readonly completed = output<OnboardingResult>();

  /** Parent-driven: true while the result is being persisted (disables the button, shows progress). */
  readonly saving = input(false);

  private readonly card = viewChild<ElementRef<HTMLElement>>('cardEl');
  private readonly firstField = viewChild<ElementRef<HTMLElement>>('firstField');

  readonly goals = GOALS;
  readonly sexes = SEXES;
  readonly activityLevels = ACTIVITY_LEVELS;
  readonly activityChips = ACTIVITY_CHIPS;
  readonly dietPatterns = DIET_PATTERNS;
  readonly trainingTypes = TRAINING_TYPES;
  readonly eatingWindows = EATING_WINDOWS;
  readonly restrictionTags = RESTRICTION_TAGS;

  // ---- form state (seeded from the partial profile; sex left blank so it must be chosen) ----
  readonly goal = signal<string>('Maintain');
  readonly dailyCalorieGoal = signal<number | null>(null);
  readonly proteinGoalG = signal<number | null>(null);
  readonly carbGoalG = signal<number | null>(null);
  readonly fatGoalG = signal<number | null>(null);

  readonly dateOfBirth = signal<string | null>(null);
  readonly sex = signal<Sex | null>(null);
  readonly activityLevel = signal<ActivityLevel>('Sedentary');

  readonly heightCm = signal<number | null>(null);
  readonly heightFt = signal<number | null>(null);
  readonly heightIn = signal<number | null>(null);
  readonly weightDisp = signal<number | null>(null);
  readonly goalWeightDisp = signal<number | null>(null);

  // ---- Step 2 "Dial it in" — all OPTIONAL goal-builder refinements (each skippable) ----
  /** Whether the collapsible "Dial it in" section is expanded. */
  readonly dialOpen = signal(false);
  /** Whether the Advanced (body-fat) sub-panel inside "Dial it in" is expanded. */
  readonly advancedOpen = signal(false);

  /** Signed goal pace in kg/week (− lose / + gain). null ⇒ the moderate goal default is used. */
  readonly weeklyRateKg = signal<number | null>(null);

  /** Body-fat % (3..60) — drives Katch-McArdle + lean-mass protein when set. */
  readonly bodyFatPct = signal<number | null>(null);
  /** Which body-fat avenue the user is using: silhouette picker, exact %, or Navy tape. */
  readonly bodyFatMode = signal<'silhouette' | 'percent' | 'navy'>('silhouette');
  /** Navy-tape circumference inputs, held in the DISPLAYED unit (in or cm). */
  readonly neckDisp = signal<number | null>(null);
  readonly waistDisp = signal<number | null>(null);
  readonly hipDisp = signal<number | null>(null);

  readonly dietPattern = signal<DietPattern>('Balanced');
  readonly restrictions = signal<string[]>([]);
  readonly trainingType = signal<TrainingType>('None');
  readonly proteinBasis = signal<ProteinBasis>('PerBodyweight');
  readonly lifeStage = signal<LifeStage>('None');
  readonly mealsPerDay = signal<number | null>(null);
  readonly eatingWindow = signal<EatingWindow>('None');

  /** True once the smart-default seed has run, so we don't clobber user edits on every gate flip. */
  private seededDefaults = false;

  // Display preference is the app-wide UnitService signal (seeded from the profile / toggle below),
  // so the canonical-metric form values render in the user's chosen units everywhere consistently.
  readonly unitSystem = this.units.unitSystem;
  readonly imperial = this.units.imperial;

  /** Weight-field suffix ('lb'/'kg') from the central service for the current/goal weight inputs. */
  readonly weightUnit = computed(() => this.units.weightUnit());

  /** Circumference-field suffix ('in'/'cm') from the central service for the Navy-tape inputs. */
  readonly lengthUnit = computed(() => this.units.lengthUnit());

  /** Body-fat silhouette presets for the chosen sex (defaults to Male when sex unset). */
  readonly silhouettes = computed(() =>
    this.sex() === 'Female' ? BODYFAT_SILHOUETTES.Female : BODYFAT_SILHOUETTES.Male,
  );

  /** True only for Lose/Gain goals — the rate slider is meaningless for Maintain/Endurance. */
  readonly showRateSlider = computed(
    () => this.goal() === 'LoseWeight' || this.goal() === 'GainMuscle',
  );

  /** The signed slider bounds for the goal-pace control (kg/wk), narrower toward the goal direction. */
  readonly rateMin = computed(() => (this.goal() === 'LoseWeight' ? -1.0 : 0));
  readonly rateMax = computed(() => (this.goal() === 'GainMuscle' ? 0.5 : 0));

  /** A localized "≈ X lb/wk" / "≈ X kg/wk" label for the current rate (or the goal default). */
  readonly rateLabel = computed(() => {
    const r = this.effectiveWeeklyRateKg();
    if (r === 0) return 'Maintain';
    const disp = this.units.imperial() ? Math.abs(r) * 2.2046226 : Math.abs(r);
    const unit = this.units.weightUnit();
    const dir = r < 0 ? 'lose' : 'gain';
    return `${dir} ~${disp.toFixed(disp < 1 ? 2 : 1)} ${unit}/wk`;
  });

  /** Today as `yyyy-MM-dd` (local) — upper bound for the DOB picker so future dates can't be chosen. */
  readonly todayIso = (() => {
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${mm}-${dd}`;
  })();

  /** True while the calorie field still holds an auto-seeded value (clears when the user edits it). */
  readonly caloriesAutoTagged = signal(false);
  /** True while the macro fields still hold auto-seeded values (clears when the user edits them). */
  readonly macrosAutoTagged = signal(false);

  constructor() {
    // Smart-default: the MOMENT the 4-field gate is first met, seed the (still blank) calorie + macro
    // targets from the live preview and a moderate goal pace, so a user who saves immediately still leaves
    // with a usable stored target. Runs once; never overwrites a value the user has already typed.
    effect(() => {
      if (!this.canSave() || this.seededDefaults) return;
      this.seededDefaults = true;
      // Seed a moderate goal-pace for Lose/Gain so the stored target reflects an intentional rate.
      if (this.weeklyRateKg() == null) {
        const g = this.goal();
        if (g === 'LoseWeight') this.weeklyRateKg.set(-0.5);
        else if (g === 'GainMuscle') this.weeklyRateKg.set(0.25);
      }
      // Tag the calorie + macro fields from the preview (only the ones the user hasn't filled).
      const s = this.preview();
      if (this.dailyCalorieGoal() == null && s.suggestedCalorieGoal != null) {
        this.dailyCalorieGoal.set(s.suggestedCalorieGoal);
        this.caloriesAutoTagged.set(true);
      }
      if (this.proteinGoalG() == null && s.suggestedProteinG != null) {
        this.proteinGoalG.set(s.suggestedProteinG);
        this.macrosAutoTagged.set(true);
      }
      if (this.carbGoalG() == null && s.suggestedCarbG != null) {
        this.carbGoalG.set(s.suggestedCarbG);
        this.macrosAutoTagged.set(true);
      }
      if (this.fatGoalG() == null && s.suggestedFatG != null) {
        this.fatGoalG.set(s.suggestedFatG);
        this.macrosAutoTagged.set(true);
      }
    });
  }

  ngOnInit(): void {
    // Seed from the partial profile here, NOT in the constructor: the `profile` signal input is bound
    // after construction, so reading it in the constructor would always see the default `null`.
    const p = this.profile();
    if (p) {
      if (p.goal) this.goal.set(p.goal);
      this.dailyCalorieGoal.set(p.dailyCalorieGoal ?? null);
      this.proteinGoalG.set(p.proteinGoalG ?? null);
      this.carbGoalG.set(p.carbGoalG ?? null);
      this.fatGoalG.set(p.fatGoalG ?? null);
      this.dateOfBirth.set(p.dateOfBirth ?? null);
      // Only seed sex when it's an explicit choice; "Unspecified" must be re-picked.
      if (p.sex && p.sex !== 'Unspecified') this.sex.set(p.sex);
      if (p.activityLevel) this.activityLevel.set(p.activityLevel);
      // Seed the app-wide unit preference from the partial profile (display only; never persists here).
      if (p.unitSystem) this.units.setLocal(p.unitSystem);
      this.heightCm.set(p.heightCm ?? null);
      if (p.heightCm != null) {
        const { ft, in: inches } = this.units.heightToFtIn(p.heightCm);
        this.heightFt.set(ft);
        this.heightIn.set(inches);
      }
      this.weightDisp.set(this.toDisp(p.weightKg));
      this.goalWeightDisp.set(this.toDisp(p.goalWeightKg));

      // Seed the optional refinements when the partial profile already carries them.
      if (p.weeklyRateKg != null) this.weeklyRateKg.set(p.weeklyRateKg);
      if (p.bodyFatPct != null) {
        this.bodyFatPct.set(p.bodyFatPct);
        this.bodyFatMode.set('percent');
      }
      if (p.neckCm != null) this.neckDisp.set(this.toLenDisp(p.neckCm));
      if (p.waistCm != null) this.waistDisp.set(this.toLenDisp(p.waistCm));
      if (p.hipCm != null) this.hipDisp.set(this.toLenDisp(p.hipCm));
      if (p.dietPattern) this.dietPattern.set(p.dietPattern);
      if (p.restrictions) {
        this.restrictions.set(
          p.restrictions.split(',').map((t) => t.trim()).filter((t) => t.length > 0),
        );
      }
      if (p.trainingType) this.trainingType.set(p.trainingType);
      if (p.proteinBasis) this.proteinBasis.set(p.proteinBasis);
      if (p.lifeStage) this.lifeStage.set(p.lifeStage);
      if (p.mealsPerDay != null) this.mealsPerDay.set(p.mealsPerDay);
      if (p.eatingWindow) this.eatingWindow.set(p.eatingWindow);
    } else {
      // Brand-new user (no profile yet): this app/user base is US-based and historically defaulted to
      // Imperial, but the shared UnitService defaults to Metric. Seed Imperial explicitly so the
      // onboarding form opens in the expected units. Existing users seed from profile.unitSystem above.
      this.units.setLocal('Imperial');
    }
  }

  ngAfterViewInit(): void {
    // Move focus into the onboarding so the user can't tab out to the gated dashboard behind it.
    queueMicrotask(() => {
      const el = this.firstField()?.nativeElement;
      el?.focus();
    });
  }

  private toDisp(kg: number | null | undefined): number | null {
    if (kg == null) return null;
    // weightToDisplay returns kg as-is in metric and lb in imperial; round the editor value to 1 dp.
    return Math.round(this.units.weightToDisplay(kg) * 10) / 10;
  }

  /** A canonical cm circumference as a DISPLAY value (cm or in, 1dp) in the user's units. */
  private toLenDisp(cm: number | null | undefined): number | null {
    if (cm == null) return null;
    return Math.round(this.units.lengthToDisplay(cm) * 10) / 10;
  }

  /** Switch units — convert the in-flight values so the user sees the same body in new units. */
  onUnitChange(sys: UnitSystem): void {
    if (sys === this.unitSystem()) return;
    const toImperial = sys === 'Imperial';

    // Capture the canonical-metric values from the OLD unit before flipping the display preference.
    const cm = this.currentHeightCm();
    const wKg = this.currentWeightKg(this.weightDisp());
    const gKg = this.currentWeightKg(this.goalWeightDisp());
    const neckCm = this.toCm(this.neckDisp());
    const waistCm = this.toCm(this.waistDisp());
    const hipCm = this.toCm(this.hipDisp());

    // Drive the app-wide preference (display only here; persisted later on save via profile.unitSystem).
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
    // toDisp now reads the freshly-set preference, so it renders the captured kg in the new unit.
    this.weightDisp.set(this.toDisp(wKg));
    this.goalWeightDisp.set(this.toDisp(gKg));
    // Re-emit the Navy-tape circumferences in the new unit too.
    this.neckDisp.set(this.toLenDisp(neckCm));
    this.waistDisp.set(this.toLenDisp(waistCm));
    this.hipDisp.set(this.toLenDisp(hipCm));
  }

  /** The current height in cm from whichever unit fields are active. */
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

  /** Convert a display weight value (in the user's unit) to canonical metric kg (or null). */
  private currentWeightKg(disp: number | null): number | null {
    if (disp == null || disp <= 0) return null;
    return this.units.weightToCanonical(disp);
  }

  /** The effective signed pace (kg/wk): the slider value, else the moderate goal default. */
  effectiveWeeklyRateKg(): number {
    const r = this.weeklyRateKg();
    if (r != null) return r;
    const g = this.goal();
    if (g === 'LoseWeight') return -0.5;
    if (g === 'GainMuscle') return 0.25;
    return 0;
  }

  /**
   * Body-fat % from whichever advanced avenue is active: the typed % (silhouette or exact both write the
   * `bodyFatPct` signal directly), or the Navy-tape estimate from neck/waist/(hip) + height + sex. Returns
   * null when there isn't enough data — the calc then falls back to Mifflin + per-bodyweight macros.
   */
  effectiveBodyFatPct(): number | null {
    if (this.bodyFatMode() !== 'navy') {
      const bf = this.bodyFatPct();
      return bf != null && bf > 0 && bf < 100 ? bf : null;
    }
    return this.navyBodyFatPct();
  }

  /**
   * U.S. Navy body-fat estimate (log10 formula) from tape measurements + height. All inputs are converted
   * to canonical cm via the central UnitService. Null when the required fields for the user's sex are missing.
   */
  private navyBodyFatPct(): number | null {
    const heightCm = this.currentHeightCm();
    const sex = this.sex();
    if (heightCm == null || heightCm <= 0 || sex == null || sex === 'Unspecified') return null;
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
  }

  /** A display circumference value (in or cm) back to canonical cm (or null when empty/non-positive). */
  private toCm(disp: number | null): number | null {
    if (disp == null || disp <= 0) return null;
    return this.units.lengthToCanonical(disp);
  }

  /** Pick a body-fat silhouette → write its mid-band % into the bodyFatPct signal. */
  pickSilhouette(pct: number): void {
    this.bodyFatPct.set(pct);
  }

  // ---- live stats preview (mirrors the backend helper) ----
  readonly statsInputs = computed<StatsInputs>(() => ({
    weightKg: this.currentWeightKg(this.weightDisp()),
    heightCm: this.currentHeightCm(),
    age: ageFrom(this.dateOfBirth(), new Date()),
    sex: this.sex() ?? 'Unspecified',
    activityLevel: this.activityLevel(),
    goal: this.goal(),
    dailyCalorieGoal: this.dailyCalorieGoal(),
    weeklyRateKg: this.weeklyRateKg(),
    bodyFatPct: this.effectiveBodyFatPct(),
    dietPattern: this.dietPattern(),
    trainingType: this.trainingType(),
    proteinBasis: this.proteinBasis(),
    lifeStage: this.lifeStage(),
    trimester: this.profile()?.trimester ?? null,
  }));

  readonly preview = computed(() => computeStats(this.statsInputs()));
  readonly hasSuggestion = computed(() => this.preview().suggestedCalorieGoal != null);

  /**
   * Confidence in the estimate, by how much profile detail is present. "high" once body-fat is known (the
   * estimate no longer leans on the sex/age approximation); "med" with the full gate; "low" otherwise.
   */
  readonly confidence = computed<'low' | 'med' | 'high'>(() => {
    const s = this.preview();
    if (s.tdee == null) return 'low';
    if (this.effectiveBodyFatPct() != null) return 'high';
    return 'med';
  });

  readonly confidenceLabel = computed(() => {
    switch (this.confidence()) {
      case 'high': return 'High confidence';
      case 'med': return 'Good estimate';
      default: return 'Rough estimate';
    }
  });

  /** Fill the daily calorie goal + macro targets from the live suggestion (clears the auto-tag flags). */
  useSuggested(): void {
    const s = this.preview();
    if (s.suggestedCalorieGoal != null) this.dailyCalorieGoal.set(s.suggestedCalorieGoal);
    if (s.suggestedProteinG != null) this.proteinGoalG.set(s.suggestedProteinG);
    if (s.suggestedCarbG != null) this.carbGoalG.set(s.suggestedCarbG);
    if (s.suggestedFatG != null) this.fatGoalG.set(s.suggestedFatG);
    this.caloriesAutoTagged.set(false);
    this.macrosAutoTagged.set(false);
  }

  /** A restriction tag is currently selected. */
  hasRestriction(tag: string): boolean {
    return this.restrictions().includes(tag);
  }

  /** Toggle a restriction tag in/out of the selected set. */
  toggleRestriction(tag: string): void {
    const cur = this.restrictions();
    this.restrictions.set(cur.includes(tag) ? cur.filter((t) => t !== tag) : [...cur, tag]);
  }

  /** Clear the auto-tag flag for the calorie field once the user edits it by hand. */
  onCaloriesEdited(v: number | null): void {
    this.dailyCalorieGoal.set(v);
    this.caloriesAutoTagged.set(false);
  }

  /** Clear the auto-tag flag for the macro fields once the user edits one by hand. */
  onMacroEdited(which: 'protein' | 'carb' | 'fat', v: number | null): void {
    if (which === 'protein') this.proteinGoalG.set(v);
    else if (which === 'carb') this.carbGoalG.set(v);
    else this.fatGoalG.set(v);
    this.macrosAutoTagged.set(false);
  }

  /** The blocking baseline is complete: current weight, height, DOB, and an explicit sex. */
  readonly canSave = computed(
    () =>
      this.currentWeightKg(this.weightDisp()) != null &&
      this.currentHeightCm() != null &&
      !!this.dateOfBirth() &&
      this.sex() != null,
  );

  private num(v: number | null): number | undefined {
    return v != null && v >= 0 ? v : undefined;
  }

  save(): void {
    if (!this.canSave() || this.saving()) return;
    const heightCm = this.currentHeightCm();
    const weightKg = this.currentWeightKg(this.weightDisp());
    const goalWeightKg = this.currentWeightKg(this.goalWeightDisp());
    const sex = this.sex();
    if (heightCm == null || weightKg == null || sex == null) return;

    const roundedWeight = Math.round(weightKg * 100) / 100;
    // Optional refinements — only emit a value the user actually dialed in (else leave it neutral/undefined).
    const restrictions = this.restrictions();
    const bodyFat = this.effectiveBodyFatPct();
    const neckCm = this.toCm(this.neckDisp());
    const waistCm = this.toCm(this.waistDisp());
    const hipCm = this.toCm(this.hipDisp());

    const profile: TrackerProfileDto = {
      goal: this.goal(),
      weightKg: roundedWeight,
      dailyCalorieGoal: this.num(this.dailyCalorieGoal()),
      proteinGoalG: this.num(this.proteinGoalG()),
      carbGoalG: this.num(this.carbGoalG()),
      fatGoalG: this.num(this.fatGoalG()),
      shareWithContacts: this.profile()?.shareWithContacts ?? false,
      dateOfBirth: this.dateOfBirth() || null,
      heightCm: Math.round(heightCm * 10) / 10,
      sex,
      activityLevel: this.activityLevel(),
      goalWeightKg: goalWeightKg != null ? Math.round(goalWeightKg * 100) / 100 : undefined,
      unitSystem: this.unitSystem(),
      // ---- optional goal-builder refinements (all skippable) ----
      weeklyRateKg: this.weeklyRateKg() ?? undefined,
      bodyFatPct: bodyFat ?? undefined,
      neckCm: neckCm != null ? Math.round(neckCm * 10) / 10 : undefined,
      waistCm: waistCm != null ? Math.round(waistCm * 10) / 10 : undefined,
      hipCm: hipCm != null ? Math.round(hipCm * 10) / 10 : undefined,
      dietPattern: this.dietPattern(),
      restrictions: restrictions.length ? restrictions.join(', ') : null,
      trainingType: this.trainingType(),
      proteinBasis: this.proteinBasis(),
      lifeStage: this.lifeStage(),
      mealsPerDay: this.num(this.mealsPerDay()),
      eatingWindow: this.eatingWindow(),
      // Seed the check-in basis so the freshly-saved goal has a drift/staleness anchor.
      goalBasisWeightKg: roundedWeight,
      baselineReviewedUtc: new Date().toISOString(),
    };

    this.completed.emit({ profile, weightKg: roundedWeight });
  }
}
