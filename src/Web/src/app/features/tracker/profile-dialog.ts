import { Component, computed, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';

import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar } from '@angular/material/snack-bar';

import { Api } from '../../core/api';
import { AuthService } from '../../core/auth';
import { UnitService } from '../../core/unit.service';
import {
  ActivityLevel,
  PERM,
  Sex,
  TrackerGoal,
  TrackerProfileDto,
  UnitSystem,
} from '../../core/models';
import { StatsInputs, ageFrom, computeStats } from './units';

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
    FormsModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatButtonModule,
    MatButtonToggleModule,
    MatCheckboxModule,
    MatIconModule,
    MatProgressSpinnerModule,
  ],
  templateUrl: './profile-dialog.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './profile-dialog.scss',
})
export class ProfileDialog {
  private ref = inject(MatDialogRef<ProfileDialog, TrackerProfileDto>);
  private api = inject(Api);
  private snack = inject(MatSnackBar);
  private auth = inject(AuthService);
  private units = inject(UnitService);
  readonly data = inject<ProfileData>(MAT_DIALOG_DATA);

  /** Master gate: every AI affordance in this dialog is hidden unless the user holds tracker.ai. */
  readonly showAi = this.auth.hasPermission(PERM.trackerAi);

  readonly goals = GOALS;
  readonly sexes = SEXES;
  readonly activityLevels = ACTIVITY_LEVELS;

  // ---- core goal/macro fields (unchanged from before) ----
  readonly goal = signal<string>(this.data.profile.goal || 'Maintain');
  readonly dailyCalorieGoal = signal<number | null>(this.data.profile.dailyCalorieGoal ?? null);
  readonly proteinGoalG = signal<number | null>(this.data.profile.proteinGoalG ?? null);
  readonly carbGoalG = signal<number | null>(this.data.profile.carbGoalG ?? null);
  readonly fatGoalG = signal<number | null>(this.data.profile.fatGoalG ?? null);
  readonly stepGoal = signal<number | null>(this.data.profile.stepGoal ?? null);
  /** Daily coffee cap (cups). null = use the default; the tracker ring warns when the day exceeds it. */
  readonly coffeeGoalCups = signal<number | null>(this.data.profile.coffeeGoalCups ?? null);
  readonly shareWithContacts = signal<boolean>(this.data.profile.shareWithContacts ?? false);

  // ---- body profile ----
  readonly dateOfBirth = signal<string | null>(this.data.profile.dateOfBirth ?? null);
  readonly sex = signal<Sex>(this.data.profile.sex ?? 'Unspecified');
  readonly activityLevel = signal<ActivityLevel>(this.data.profile.activityLevel ?? 'Sedentary');

  // The dialog's Metric|Imperial toggle edits the central UnitService signal in-flight (seeded below
  // from the loaded profile; converted to canonical metric on save — the store never changes). All unit
  // display/parse below reads this one signal so kg/cm/ml render + parse in the user's chosen unit.
  private readonly _seed = this.units.setLocal(this.data.profile.unitSystem ?? 'Imperial');
  readonly unitSystem = this.units.unitSystem;
  readonly imperial = this.units.imperial;

  /** Weight suffix for the current/goal weight fields ('lb' | 'kg'). */
  get weightUnit(): string {
    return this.units.weightUnit();
  }

  /** Volume suffix for the hydration-goal field ('fl oz' | 'ml'). */
  get volumeUnit(): string {
    return this.units.volumeUnit();
  }

  /** Localized hydration-goal default for the hint, e.g. "~64 fl oz" / "~2000 ml" (canonical 2000 ml). */
  get hydrationDefaultHint(): string {
    return `~${this.units.formatVolume(2000)}`;
  }

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
  // Hydration goal as a DISPLAY value (oz or ml). Optional — null uses the server's 2000 ml default.
  readonly hydrationGoalDisp = signal<number | null>(
    this.toVolDisp(this.data.profile.hydrationGoalMl),
  );

  constructor() {
    // Seed the imperial height fields from the stored cm.
    if (this.data.profile.heightCm != null) {
      const { ft, in: inches } = this.units.heightToFtIn(this.data.profile.heightCm);
      this.heightFt.set(ft);
      this.heightIn.set(inches);
    }
  }

  /** A canonical kg weight as a DISPLAY value (kg or lb, 1dp) in the user's units. */
  private toDisp(kg: number | null | undefined): number | null {
    if (kg == null) return null;
    return Math.round(this.units.weightToDisplay(kg) * 10) / 10;
  }

  /** A metric volume (ml) as a whole DISPLAY value in the current units (fl oz for Imperial, ml for Metric). */
  private toVolDisp(ml: number | null | undefined): number | null {
    if (ml == null) return null;
    return Math.round(this.units.volumeToDisplay(ml));
  }

  /** Convert the display hydration-goal value back to metric ml (or null when empty/non-positive). */
  private currentHydrationGoalMl(disp: number | null): number | null {
    if (disp == null || disp <= 0) return null;
    return Math.round(this.units.volumeToCanonical(disp));
  }

  /** Switch units — convert the in-flight display values so the user sees the same body in new units. */
  onUnitChange(sys: UnitSystem): void {
    if (sys === this.unitSystem()) return;
    const toImperial = sys === 'Imperial';

    // Read every in-flight value back to canonical metric WHILE the service still reflects the OLD unit…
    const cm = this.currentHeightCm();
    const wKg = this.currentWeightKg(this.weightDisp());
    const gKg = this.currentWeightKg(this.goalWeightDisp());
    const hydMl = this.currentHydrationGoalMl(this.hydrationGoalDisp());

    // …flip the central unit signal, then re-emit each value as a DISPLAY value in the NEW unit.
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

  /** Convert a display weight value to metric kg (or null). */
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

  // ---- AI goal suggestion (Gemini-backed; reads the caller's own profile server-side) ----
  /** True while suggest-goal is in flight. */
  readonly aiLoading = signal(false);
  /** The model's one-sentence rationale, shown as helper text under the goal fields. */
  readonly aiRationale = signal<string | null>(null);
  /** Polite sr-only announcement of the AI suggestion (or its unavailability). */
  readonly aiAnnounce = signal('');

  /**
   * Ask Gemini to suggest a daily calorie + macro goal (it reads the caller's saved profile server-side,
   * NOT the unsaved in-dialog edits), then PREFILL the editable goal fields. The rationale renders as
   * helper text. A 503/unavailable leaves the fields untouched + editable and shows a snackbar.
   */
  async suggestWithAi(): Promise<void> {
    if (this.aiLoading()) return;
    this.aiLoading.set(true);
    this.aiAnnounce.set('Suggesting a goal with AI…');
    try {
      const res = await firstValueFrom(this.api.suggestGoal());
      // Prefill the editable fields — a suggestion the user can adjust before saving.
      this.dailyCalorieGoal.set(res.calorieTarget);
      this.proteinGoalG.set(res.proteinG);
      this.carbGoalG.set(res.carbsG);
      this.fatGoalG.set(res.fatG);
      this.aiRationale.set(res.rationale ?? null);
      this.aiAnnounce.set(
        `AI suggested ${res.calorieTarget} calories per day: ${res.proteinG} grams protein, ` +
          `${res.carbsG} grams carbs, ${res.fatG} grams fat.` +
          (res.rationale ? ` ${res.rationale}` : ''),
      );
    } catch {
      this.aiRationale.set(null);
      this.aiAnnounce.set('AI suggestion unavailable. Set your goal manually.');
      this.snack.open('AI suggestion unavailable — set your goal manually', 'OK', {
        duration: 4000,
      });
    } finally {
      this.aiLoading.set(false);
    }
  }

  // ---- AI natural-goal ("Describe your goal" → structured plan; Gemini-backed) ----
  /** The free-text goal the user types ("lose 10 lbs in 3 months"). */
  readonly goalText = signal('');
  /** True while natural-goal is in flight. */
  readonly goalLoading = signal(false);
  /** The parsed plan's timeline (e.g. "~0.8 lb/week over 12 weeks"), shown as helper text. Null when none. */
  readonly goalTimeline = signal<string | null>(null);
  /** The model's "is this realistic?" verdict for the parsed plan; null until a parse runs. */
  readonly goalRealistic = signal<boolean | null>(null);
  /** The model's one-line rationale for the parsed plan, shown as helper text. */
  readonly goalRationale = signal<string | null>(null);

  readonly canDescribeGoal = computed(
    () => this.goalText().trim().length > 0 && !this.goalLoading(),
  );

  /**
   * Turn the free-text goal into a structured plan (POST /api/ai/natural-goal) and PREFILL the editable
   * calorie + macro goal fields — never auto-committed; the user adjusts then Saves. The timeline and a
   * "realistic" check render as helper text. A 503/unavailable leaves the fields untouched + editable and
   * shows a snackbar so the user can set the goal manually.
   */
  async describeGoalWithAi(): Promise<void> {
    const text = this.goalText().trim();
    if (!text || this.goalLoading()) return;
    this.goalLoading.set(true);
    this.aiAnnounce.set('Reading your goal with AI…');
    try {
      const res = await firstValueFrom(this.api.naturalGoal({ text }));
      // Prefill the editable fields — a suggestion the user can adjust before saving.
      this.dailyCalorieGoal.set(res.calorieTarget);
      this.proteinGoalG.set(res.proteinG);
      this.carbGoalG.set(res.carbsG);
      this.fatGoalG.set(res.fatG);
      this.goalTimeline.set(res.timeline ?? null);
      this.goalRealistic.set(res.realistic);
      this.goalRationale.set(res.rationale ?? null);
      const verdict = res.realistic
        ? 'This timeline looks realistic.'
        : 'This timeline may be aggressive.';
      this.aiAnnounce.set(
        `AI set a goal of ${res.calorieTarget} calories per day: ${res.proteinG} grams protein, ` +
          `${res.carbsG} grams carbs, ${res.fatG} grams fat.` +
          (res.timeline ? ` Timeline: ${res.timeline}.` : '') +
          ` ${verdict}` +
          (res.rationale ? ` ${res.rationale}` : ''),
      );
    } catch {
      this.goalTimeline.set(null);
      this.goalRealistic.set(null);
      this.goalRationale.set(null);
      this.aiAnnounce.set('AI could not read your goal. Set your goal manually.');
      this.snack.open('AI unavailable — set your goal manually', 'OK', { duration: 4000 });
    } finally {
      this.goalLoading.set(false);
    }
  }

  private num(v: number | null): number | undefined {
    return v != null && v >= 0 ? v : undefined;
  }

  save(): void {
    const heightCm = this.currentHeightCm();
    const weightKg = this.currentWeightKg(this.weightDisp());
    const goalWeightKg = this.currentWeightKg(this.goalWeightDisp());
    const hydrationGoalMl = this.currentHydrationGoalMl(this.hydrationGoalDisp());

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
      hydrationGoalMl: hydrationGoalMl ?? undefined,
      stepGoal: this.num(this.stepGoal()),
      coffeeGoalCups: this.num(this.coffeeGoalCups()),
    };
    this.ref.close(body);
  }

  cancel(): void {
    this.ref.close();
  }
}
