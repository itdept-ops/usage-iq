import {
  AfterViewInit, Component, ElementRef, OnInit, computed, input, output, signal, viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatIconModule } from '@angular/material/icon';

import { ActivityLevel, Sex, TrackerGoal, TrackerProfileDto, UnitSystem } from '../../core/models';
import {
  StatsInputs, ageFrom, cmToFtIn, computeStats, ftInToCm, kgToLb, lbToKg,
} from './units';

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
    FormsModule, MatFormFieldModule, MatInputModule, MatSelectModule,
    MatButtonModule, MatButtonToggleModule, MatIconModule,
  ],
  templateUrl: './onboarding-card.html',
  styleUrl: './onboarding-card.scss',
})
export class OnboardingCard implements OnInit, AfterViewInit {
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

  // ---- form state (seeded from the partial profile; sex left blank so it must be chosen) ----
  readonly goal = signal<string>('Maintain');
  readonly dailyCalorieGoal = signal<number | null>(null);
  readonly proteinGoalG = signal<number | null>(null);
  readonly carbGoalG = signal<number | null>(null);
  readonly fatGoalG = signal<number | null>(null);

  readonly dateOfBirth = signal<string | null>(null);
  readonly sex = signal<Sex | null>(null);
  readonly activityLevel = signal<ActivityLevel>('Sedentary');
  readonly unitSystem = signal<UnitSystem>('Imperial');

  readonly heightCm = signal<number | null>(null);
  readonly heightFt = signal<number | null>(null);
  readonly heightIn = signal<number | null>(null);
  readonly weightDisp = signal<number | null>(null);
  readonly goalWeightDisp = signal<number | null>(null);

  readonly imperial = computed(() => this.unitSystem() === 'Imperial');

  /** Today as `yyyy-MM-dd` (local) — upper bound for the DOB picker so future dates can't be chosen. */
  readonly todayIso = (() => {
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${mm}-${dd}`;
  })();

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
      if (p.unitSystem) this.unitSystem.set(p.unitSystem);
      this.heightCm.set(p.heightCm ?? null);
      if (p.heightCm != null) {
        const { ft, in: inches } = cmToFtIn(p.heightCm);
        this.heightFt.set(ft);
        this.heightIn.set(inches);
      }
      this.weightDisp.set(this.toDisp(p.weightKg));
      this.goalWeightDisp.set(this.toDisp(p.goalWeightKg));
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
    return this.unitSystem() === 'Imperial' ? Math.round(kgToLb(kg) * 10) / 10 : kg;
  }

  /** Switch units — convert the in-flight values so the user sees the same body in new units. */
  onUnitChange(sys: UnitSystem): void {
    if (sys === this.unitSystem()) return;
    const toImperial = sys === 'Imperial';

    const cm = this.currentHeightCm();
    const wKg = this.currentWeightKg(this.weightDisp());
    const gKg = this.currentWeightKg(this.goalWeightDisp());

    this.unitSystem.set(sys);

    if (cm != null) {
      if (toImperial) {
        const { ft, in: inches } = cmToFtIn(cm);
        this.heightFt.set(ft); this.heightIn.set(inches);
      } else {
        this.heightCm.set(Math.round(cm));
      }
    }
    this.weightDisp.set(toImperial ? (wKg != null ? Math.round(kgToLb(wKg) * 10) / 10 : null) : wKg);
    this.goalWeightDisp.set(toImperial ? (gKg != null ? Math.round(kgToLb(gKg) * 10) / 10 : null) : gKg);
  }

  /** The current height in cm from whichever unit fields are active. */
  private currentHeightCm(): number | null {
    if (this.imperial()) {
      const ft = this.heightFt(), inches = this.heightIn();
      if ((ft == null || ft <= 0) && (inches == null || inches <= 0)) return null;
      return ftInToCm(ft ?? 0, inches ?? 0);
    }
    const cm = this.heightCm();
    return cm != null && cm > 0 ? cm : null;
  }

  /** Convert a display weight value to metric kg (or null). */
  private currentWeightKg(disp: number | null): number | null {
    if (disp == null || disp <= 0) return null;
    return this.imperial() ? lbToKg(disp) : disp;
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
  }));

  readonly preview = computed(() => computeStats(this.statsInputs()));
  readonly hasSuggestion = computed(() => this.preview().suggestedCalorieGoal != null);

  /** Fill the daily calorie goal + macro targets from the live suggestion. */
  useSuggested(): void {
    const s = this.preview();
    if (s.suggestedCalorieGoal != null) this.dailyCalorieGoal.set(s.suggestedCalorieGoal);
    if (s.suggestedProteinG != null) this.proteinGoalG.set(s.suggestedProteinG);
    if (s.suggestedCarbG != null) this.carbGoalG.set(s.suggestedCarbG);
    if (s.suggestedFatG != null) this.fatGoalG.set(s.suggestedFatG);
  }

  /** The blocking baseline is complete: current weight, height, DOB, and an explicit sex. */
  readonly canSave = computed(() =>
    this.currentWeightKg(this.weightDisp()) != null
    && this.currentHeightCm() != null
    && !!this.dateOfBirth()
    && this.sex() != null,
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
    };

    this.completed.emit({ profile, weightKg: roundedWeight });
  }
}
