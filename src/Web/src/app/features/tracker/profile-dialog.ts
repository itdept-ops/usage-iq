import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatIconModule } from '@angular/material/icon';

import { ActivityLevel, Sex, TrackerGoal, TrackerProfileDto, UnitSystem } from '../../core/models';
import {
  StatsInputs, ageFrom, cmToFtIn, computeStats, ftInToCm, kgToLb, lbToKg,
} from './units';

/** Opens with the current profile (or sensible defaults for a first-time user). */
export interface ProfileData {
  profile: TrackerProfileDto;
}

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

/**
 * Profile / goal dialog. Sets the training goal, full body profile (DOB, height, current + goal weight,
 * biological sex, activity level), an optional daily calorie goal + macro targets, a unit toggle
 * (Metric kg/cm vs Imperial lb + ft/in — converted to metric on save), and the share toggle. Shows a
 * LIVE stats preview (BMI/BMR/TDEE/suggested calories) using the same formulas as the backend, with a
 * "Use suggested" button. Resolves with the {@link TrackerProfileDto} (metric) for the page to persist.
 */
@Component({
  selector: 'app-tracker-profile-dialog',
  imports: [
    FormsModule, MatDialogModule, MatFormFieldModule, MatInputModule, MatSelectModule,
    MatButtonModule, MatButtonToggleModule, MatCheckboxModule, MatIconModule,
  ],
  templateUrl: './profile-dialog.html',
  styleUrl: './profile-dialog.scss',
})
export class ProfileDialog {
  private ref = inject(MatDialogRef<ProfileDialog, TrackerProfileDto>);
  readonly data = inject<ProfileData>(MAT_DIALOG_DATA);

  readonly goals = GOALS;
  readonly sexes = SEXES;
  readonly activityLevels = ACTIVITY_LEVELS;

  // ---- core goal/macro fields (unchanged from before) ----
  readonly goal = signal<string>(this.data.profile.goal || 'Maintain');
  readonly dailyCalorieGoal = signal<number | null>(this.data.profile.dailyCalorieGoal ?? null);
  readonly proteinGoalG = signal<number | null>(this.data.profile.proteinGoalG ?? null);
  readonly carbGoalG = signal<number | null>(this.data.profile.carbGoalG ?? null);
  readonly fatGoalG = signal<number | null>(this.data.profile.fatGoalG ?? null);
  readonly shareWithContacts = signal<boolean>(this.data.profile.shareWithContacts ?? false);

  // ---- body profile ----
  readonly dateOfBirth = signal<string | null>(this.data.profile.dateOfBirth ?? null);
  readonly sex = signal<Sex>(this.data.profile.sex ?? 'Unspecified');
  readonly activityLevel = signal<ActivityLevel>(this.data.profile.activityLevel ?? 'Sedentary');
  readonly unitSystem = signal<UnitSystem>(this.data.profile.unitSystem ?? 'Imperial');

  readonly imperial = computed(() => this.unitSystem() === 'Imperial');

  /** Today as `yyyy-MM-dd` (local) — upper bound for the DOB picker so future dates can't be chosen. */
  readonly todayIso = (() => {
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${mm}-${dd}`;
  })();

  // ---- unit-aware body inputs (held in the DISPLAYED units, converted to metric on save) ----
  // Metric: heightCm; Imperial: heightFt + heightIn.
  readonly heightCm = signal<number | null>(this.data.profile.heightCm ?? null);
  readonly heightFt = signal<number | null>(null);
  readonly heightIn = signal<number | null>(null);
  // Weights stored as DISPLAY values (kg or lb) so editing in imperial keeps precision.
  readonly weightDisp = signal<number | null>(this.toDisp(this.data.profile.weightKg));
  readonly goalWeightDisp = signal<number | null>(this.toDisp(this.data.profile.goalWeightKg));

  constructor() {
    // Seed the imperial height fields from the stored cm.
    if (this.data.profile.heightCm != null) {
      const { ft, in: inches } = cmToFtIn(this.data.profile.heightCm);
      this.heightFt.set(ft);
      this.heightIn.set(inches);
    }
  }

  private toDisp(kg: number | null | undefined): number | null {
    if (kg == null) return null;
    return this.unitSystem() === 'Imperial'
      ? Math.round(kgToLb(kg) * 10) / 10
      : kg;
  }

  /** Switch units — convert the in-flight display values so the user sees the same body in new units. */
  onUnitChange(sys: UnitSystem): void {
    if (sys === this.unitSystem()) return;
    const toImperial = sys === 'Imperial';

    // height
    const cm = this.currentHeightCm();
    // weights: read metric first, then re-emit in the new units
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
    sex: this.sex(),
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

  private num(v: number | null): number | undefined {
    return v != null && v >= 0 ? v : undefined;
  }

  save(): void {
    const heightCm = this.currentHeightCm();
    const weightKg = this.currentWeightKg(this.weightDisp());
    const goalWeightKg = this.currentWeightKg(this.goalWeightDisp());

    const body: TrackerProfileDto = {
      goal: this.goal(),
      weightKg: weightKg != null ? Math.round(weightKg * 100) / 100 : undefined,
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
    };
    this.ref.close(body);
  }

  cancel(): void {
    this.ref.close();
  }
}
