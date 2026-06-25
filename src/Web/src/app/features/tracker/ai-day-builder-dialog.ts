import { Component, computed, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { DecimalPipe, LowerCasePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';

import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSnackBar } from '@angular/material/snack-bar';
import { TextFieldModule } from '@angular/cdk/text-field';

import { Api } from '../../core/api';
import { AuthService } from '../../core/auth';
import {
  BuildDayResponse,
  ClarifyAnswer,
  ClarifyQuestion,
  DayDraft,
  DraftActivity,
  DraftDrink,
  DraftExercise,
  DraftFood,
  DraftWeight,
  ImageRequest,
  Meal,
  MealDraft,
  PERM,
  UnitSystem,
} from '../../core/models';
import { captureImage, pickImage, confirmPhotoNotice } from './ai-image';
import { UnitService } from '../../core/unit.service';

/**
 * Opened from the tracker with the active date + the user's unit preference, plus an optional compact brief
 * of what's already logged (so the review can warn "Lunch already logged" and the model fills gaps).
 */
export interface AiDayBuilderData {
  date: string;
  unitSystem: UnitSystem;
  /** A short one-line-per-entry brief of the already-logged day, or undefined when the day is empty. */
  existingDayBrief?: string;
}

/** What the dialog resolves with: the edited draft + the server `buildId` to commit. `undefined` = dismissed. */
export type AiDayBuilderResult = { draft: DayDraft; buildId: string } | undefined;

/** The dialog's lifecycle phases. */
type Phase = 'input' | 'loading' | 'questions' | 'review' | 'committing' | 'done';

/** A meal slot for the review groups, in dashboard order. */
interface ReviewMeal {
  meal: Meal;
  label: string;
  icon: string;
}

const REVIEW_MEALS: ReviewMeal[] = [
  { meal: 'breakfast', label: 'Breakfast', icon: 'bakery_dining' },
  { meal: 'lunch', label: 'Lunch', icon: 'lunch_dining' },
  { meal: 'dinner', label: 'Dinner', icon: 'dinner_dining' },
  { meal: 'snack', label: 'Snacks', icon: 'cookie' },
];

/** Loop cap — after this many build rounds we force the review phase regardless of remaining questions. */
const MAX_ROUNDS = 3;

/** Per-day structural caps mirrored client-side so the UI never lets the user exceed them. */
const MAX_PHOTOS = 4;
const MAX_FOODS_PER_MEAL = 25;
const MAX_EXERCISES = 20;
const MAX_DRINKS = 30;

/** The slot options for the weight picker (display label + wire value). */
const WEIGHT_SLOTS: { value: string; label: string }[] = [
  { value: 'unspecified', label: 'Unspecified' },
  { value: 'morning', label: 'Morning' },
  { value: 'afternoon', label: 'Afternoon' },
  { value: 'evening', label: 'Evening' },
];

/**
 * AI Day Builder dialog. The user describes their whole day in free text (+ optional meal photos); Gemini
 * reconstructs a COMPLETE structured day, asks clarifying questions when something is ambiguous, the user
 * answers (multi-turn) and edits the draft, then the dialog resolves the edited draft + buildId so the
 * page commits the ENTIRE day in one atomic, idempotent call.
 *
 * State machine: input → loading → (questions → loading)* → review → committing → done. Nothing is logged
 * until the page calls /commit. Every AI affordance degrades gracefully on 503/429 — a first-build failure
 * closes back to the manual tracker; a refine failure drops to review with whatever draft exists.
 */
@Component({
  selector: 'app-ai-day-builder-dialog',
  imports: [
    DecimalPipe,
    LowerCasePipe,
    FormsModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    MatIconModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
    TextFieldModule,
  ],
  templateUrl: './ai-day-builder-dialog.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './ai-day-builder-dialog.scss',
})
export class AiDayBuilderDialog {
  private ref = inject(MatDialogRef<AiDayBuilderDialog, AiDayBuilderResult>);
  private api = inject(Api);
  private snack = inject(MatSnackBar);
  private auth = inject(AuthService);
  readonly units = inject(UnitService);
  readonly data = inject<AiDayBuilderData>(MAT_DIALOG_DATA);

  /** Multimodal (image) AI is a SEPARATE, off-by-default permission from the tracker.ai group gate. The
   *  photo buttons are hidden unless held, so we never offer a vision action the build-day endpoint 403s. */
  readonly canUseVision = this.auth.hasPermission(PERM.aiVision);

  constructor() {
    // Seed the central UnitService from the unit preference the page passed in (already-loaded profile),
    // so every display/input boundary below honours it without re-fetching.
    this.units.setLocal(this.data.unitSystem);
  }

  readonly reviewMeals = REVIEW_MEALS;
  readonly weightSlots = WEIGHT_SLOTS;
  readonly maxPhotos = MAX_PHOTOS;

  // ---- phase + announcements ----
  readonly phase = signal<Phase>('input');
  /** sr-only live announcement of every phase transition + AI status. */
  readonly announce = signal('');

  /** A friendly heading for the day being built ("Today" / weekday). */
  readonly dateHeading = computed(() => {
    const d = new Date(this.data.date + 'T00:00:00');
    if (isNaN(d.getTime())) return this.data.date;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diff = Math.round((d.getTime() - today.getTime()) / 86_400_000);
    if (diff === 0) return 'Today';
    if (diff === -1) return 'Yesterday';
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  });

  /** The per-phase dialog title (also drives the sr heading). */
  readonly phaseTitle = computed(() => {
    switch (this.phase()) {
      case 'questions':
        return 'A few quick questions';
      case 'review':
        return 'Review your day';
      case 'committing':
        return 'Logging your day…';
      case 'done':
        return 'Logged';
      case 'loading':
        return 'Building your day…';
      default:
        return 'Tell me about your day';
    }
  });

  // ---- input phase ----
  readonly text = signal('');
  /** Chosen meal photos (raw base64 + mime), capped at MAX_PHOTOS. */
  readonly photos = signal<{ imageBase64: string; mimeType: string }[]>([]);
  readonly canBuild = computed(() => this.text().trim().length > 0 || this.photos().length > 0);

  // ---- build state ----
  readonly buildId = signal('');
  readonly round = signal(0);
  readonly draft = signal<DayDraft | null>(null);
  readonly questions = signal<ClarifyQuestion[]>([]);
  readonly notes = signal<string | null>(null);

  /** Per-question answers keyed by questionId (blank/absent = "skip — best-guess"). */
  readonly answers = signal<Record<string, string>>({});

  // ---- existing-day brief (gap-fill + "already logged" nudges) ----
  readonly existingBrief = this.data.existingDayBrief ?? '';

  // ─────────────────────────────────────────── input ───────────────────────────────────────────

  /** True once the photo slots are full (gates BOTH the camera + attach buttons). */
  readonly photosFull = computed(() => this.photos().length >= MAX_PHOTOS);

  /** 📷 Snap a meal photo (rear camera on mobile). Thin wrapper over {@link addPhoto} with the camera source. */
  snapPhoto(): Promise<void> {
    return this.addPhoto(captureImage);
  }

  /** 🖼️ Attach an existing image from the gallery/files (no `capture` hint). Sibling of {@link snapPhoto}. */
  attachPhoto(): Promise<void> {
    return this.addPhoto(pickImage);
  }

  /**
   * Add a meal photo through the shared one-time privacy-notice path, obtaining the image via `source`
   * (camera or gallery), and append it (caps at MAX_PHOTOS). Gated by {@link canUseVision} so we never
   * capture an image the server would 403. The image is read only to draft the day — it is never stored.
   */
  private async addPhoto(source: () => Promise<ImageRequest | null>): Promise<void> {
    if (!this.canUseVision || this.photosFull()) return;
    const ok = await confirmPhotoNotice();
    if (!ok) return;
    try {
      const img = await source();
      if (!img) return;
      this.photos.update((p) => (p.length >= MAX_PHOTOS ? p : [...p, img]));
    } catch (e) {
      this.snack.open(e instanceof Error ? e.message : 'Could not read the image.', 'OK', {
        duration: 4000,
      });
    }
  }

  removePhoto(index: number): void {
    this.photos.update((p) => p.filter((_, i) => i !== index));
  }

  /** A thumbnail data URL for a chosen photo chip. */
  photoUrl(p: { imageBase64: string; mimeType: string }): string {
    return `data:${p.mimeType};base64,${p.imageBase64}`;
  }

  /** Close back to the tracker's date nav so the user can change the active date. */
  changeDate(): void {
    this.ref.close();
  }

  /** First build: send the brain-dump + photos. On a 503/429 we STAY on the input screen with the
   *  user's text + photos intact so they can retry — never close the modal or discard what they typed. */
  async build(): Promise<void> {
    if (!this.canBuild() || this.phase() === 'loading') return;
    this.toLoading('Building your day with AI. This can take a few seconds.');
    try {
      const res = await firstValueFrom(
        this.api.buildDay({
          text: this.text().trim() || undefined,
          date: this.data.date,
          localTimeOfDay: this.localTimeOfDay(),
          images: this.photos().length ? this.photos() : undefined,
        }),
      );
      this.applyBuild(res);
    } catch {
      // AI unavailable / transient: return to the input screen WITHOUT closing — text() + photos() are
      // untouched, so nothing the user typed is lost and they can try again (or fill it in manually).
      this.phase.set('input');
      this.announce.set(
        'AI is unavailable right now — your summary is still here. Try again in a moment.',
      );
      this.snack.open('AI is unavailable right now — your summary is saved here, try again', 'OK', {
        duration: 6000,
      });
    }
  }

  // ───────────────────────────────────────── questions ─────────────────────────────────────────

  /** The current answer text for a question (empty string when unanswered). */
  answerFor(q: ClarifyQuestion): string {
    return this.answers()[q.questionId] ?? '';
  }

  setAnswer(questionId: string, value: string): void {
    this.answers.update((a) => ({ ...a, [questionId]: value }));
  }

  /** Clear a question's answer (the explicit "Skip" — server treats blank as best-guess). */
  skipQuestion(questionId: string): void {
    this.answers.update((a) => ({ ...a, [questionId]: '' }));
  }

  /** Refine: re-POST with the prior draft + the answers (TEXT-ONLY — photos are never resent). */
  async refine(): Promise<void> {
    const prior = this.draft();
    if (!prior || this.phase() === 'loading') return;
    const answers: ClarifyAnswer[] = this.questions().map((q) => ({
      questionId: q.questionId,
      questionText: q.text,
      answer: (this.answers()[q.questionId] ?? '').trim(),
    }));
    this.toLoading('Refining your day with AI…');
    try {
      const res = await firstValueFrom(
        this.api.buildDay({
          text: this.text().trim() || undefined,
          date: this.data.date,
          localTimeOfDay: this.localTimeOfDay(),
          images: [],
          priorDraft: prior,
          answers,
        }),
      );
      this.applyBuild(res);
    } catch {
      // Refine failure: never dead-end — drop straight to review with the draft we already have.
      this.snack.open('AI is busy — review and edit your day below', 'OK', { duration: 5000 });
      this.questions.set([]);
      this.toReview();
    }
  }

  /** Skip the question loop and go straight to editing the current draft. */
  useDraftAsIs(): void {
    this.questions.set([]);
    this.toReview();
  }

  // ─────────────────────────────────────────── review ──────────────────────────────────────────

  /** The draft's foods for one meal (empty when the meal isn't in the draft yet). */
  foodsFor(meal: Meal): DraftFood[] {
    return this.draft()?.meals.find((m) => m.meal === meal)?.items ?? [];
  }

  /** Mutate the draft immutably via a recipe over a shallow clone. */
  private patchDraft(recipe: (d: DayDraft) => void): void {
    const d = this.draft();
    if (!d) return;
    const clone: DayDraft = structuredClone(d);
    recipe(clone);
    this.draft.set(clone);
  }

  /** Ensure a meal group exists in the draft and return it (for adds). */
  private ensureMeal(d: DayDraft, meal: Meal): MealDraft {
    let m = d.meals.find((x) => x.meal === meal);
    if (!m) {
      m = { meal, items: [] };
      d.meals.push(m);
    }
    return m;
  }

  // -- food edits --
  setFood(meal: Meal, index: number, patch: Partial<DraftFood>): void {
    this.patchDraft((d) => {
      const m = d.meals.find((x) => x.meal === meal);
      if (m && m.items[index]) Object.assign(m.items[index], patch);
    });
  }

  addFood(meal: Meal): void {
    this.patchDraft((d) => {
      const m = this.ensureMeal(d, meal);
      if (m.items.length >= MAX_FOODS_PER_MEAL) return;
      m.items.push({
        description: '',
        calories: 0,
        proteinG: 0,
        carbG: 0,
        fatG: 0,
        confidence: 1,
        clamped: false,
      });
    });
  }

  removeFood(meal: Meal, index: number): void {
    this.patchDraft((d) => {
      const m = d.meals.find((x) => x.meal === meal);
      if (m) m.items.splice(index, 1);
    });
  }

  canAddFood(meal: Meal): boolean {
    return this.foodsFor(meal).length < MAX_FOODS_PER_MEAL;
  }

  /** Re-classify a food into a different meal slot — "move dinner → breakfast", i.e. when you actually
   *  ate it. Moves the item between the draft's meal groups; no-ops if the target slot is already full. */
  moveFood(fromMeal: Meal, index: number, toMeal: Meal): void {
    if (fromMeal === toMeal) return;
    this.patchDraft((d) => {
      const from = d.meals.find((x) => x.meal === fromMeal);
      const food = from?.items[index];
      if (!from || !food) return;
      const to = this.ensureMeal(d, toMeal);
      if (to.items.length >= MAX_FOODS_PER_MEAL) return;
      from.items.splice(index, 1);
      to.items.push(food);
    });
  }

  // -- exercise edits --
  readonly exercises = computed<DraftExercise[]>(() => this.draft()?.exercises ?? []);

  setExercise(index: number, patch: Partial<DraftExercise>): void {
    this.patchDraft((d) => {
      if (d.exercises[index]) Object.assign(d.exercises[index], patch);
    });
  }

  addExercise(): void {
    this.patchDraft((d) => {
      if (d.exercises.length >= MAX_EXERCISES) return;
      d.exercises.push({
        name: '',
        durationMin: null,
        caloriesBurned: 0,
        confidence: 1,
        clamped: false,
      });
    });
  }

  removeExercise(index: number): void {
    this.patchDraft((d) => {
      d.exercises.splice(index, 1);
    });
  }

  readonly canAddExercise = computed(() => this.exercises().length < MAX_EXERCISES);

  // -- hydration edits (amounts shown + edited in the user's unit) --
  readonly drinks = computed<DraftDrink[]>(() => this.draft()?.hydration ?? []);

  /** A drink's display amount (fl oz/ml) from its stored ml. */
  drinkDisp(d: DraftDrink): number {
    return Math.round(this.units.volumeToDisplay(d.ml));
  }

  /** Set a drink's amount from a display value (fl oz/ml), clamping to the server's 1..5000 ml range. */
  setDrinkAmount(index: number, disp: number | null): void {
    const ml = disp == null || disp <= 0 ? 0 : Math.round(this.units.volumeToCanonical(disp));
    this.patchDraft((d) => {
      if (d.hydration[index]) d.hydration[index].ml = Math.min(5000, Math.max(0, ml));
    });
  }

  setDrinkLabel(index: number, label: string): void {
    this.patchDraft((d) => {
      if (d.hydration[index]) d.hydration[index].label = label;
    });
  }

  addDrink(): void {
    this.patchDraft((d) => {
      if (d.hydration.length >= MAX_DRINKS) return;
      const ml = this.units.imperial() ? Math.round(this.units.volumeToCanonical(8)) : 250;
      d.hydration.push({ label: 'Water', ml });
    });
  }

  removeDrink(index: number): void {
    this.patchDraft((d) => {
      d.hydration.splice(index, 1);
    });
  }

  readonly canAddDrink = computed(() => this.drinks().length < MAX_DRINKS);

  // -- weight edits (shown + edited in the user's unit) --
  readonly weight = computed<DraftWeight | null>(() => this.draft()?.weight ?? null);

  /** The weight's display value (lb/kg) from its stored kg. */
  weightDisp(): number | null {
    const w = this.weight();
    if (!w) return null;
    return Math.round(this.units.weightToDisplay(w.weightKg) * 10) / 10;
  }

  setWeightDisp(disp: number | null): void {
    if (disp == null || disp <= 0) return;
    const kg = this.units.weightToCanonical(disp);
    this.patchDraft((d) => {
      const clamped = Math.min(1000, Math.max(1, Math.round(kg * 100) / 100));
      d.weight = { weightKg: clamped, slot: d.weight?.slot ?? 'unspecified' };
    });
  }

  setWeightSlot(slot: string): void {
    this.patchDraft((d) => {
      if (d.weight) d.weight.slot = slot;
    });
  }

  addWeight(): void {
    this.patchDraft((d) => {
      d.weight = {
        weightKg: this.units.imperial() ? Math.round(this.units.weightToCanonical(150) * 100) / 100 : 70,
        slot: 'unspecified',
      };
    });
  }

  removeWeight(): void {
    this.patchDraft((d) => {
      d.weight = null;
    });
  }

  // -- activity edits --
  readonly activity = computed<DraftActivity | null>(() => this.draft()?.activity ?? null);

  /** The activity distance as a display value (mi/km) from stored metres. */
  activityDistanceDisp(): number | null {
    const a = this.activity();
    if (!a || a.distanceMeters == null) return null;
    return Math.round(this.units.distanceToDisplay(a.distanceMeters / 1000) * 10) / 10;
  }

  setActivityField(patch: Partial<DraftActivity>): void {
    this.patchDraft((d) => {
      const base: DraftActivity = d.activity ?? {
        steps: null,
        distanceMeters: null,
        activeCalories: null,
        calorieMode: 'add',
      };
      d.activity = { ...base, ...patch };
    });
  }

  /** Set the activity distance from a display value (mi/km) → metres. */
  setActivityDistance(disp: number | null): void {
    const meters =
      disp == null || disp < 0
        ? null
        : Math.round(this.units.distanceToCanonical(disp) * 1000);
    this.setActivityField({ distanceMeters: meters });
  }

  addActivity(): void {
    this.patchDraft((d) => {
      d.activity = { steps: null, distanceMeters: null, activeCalories: null, calorieMode: 'add' };
    });
  }

  removeActivity(): void {
    this.patchDraft((d) => {
      d.activity = null;
    });
  }

  // ---- running tally (recomputed client-side on every edit) ----
  readonly tally = computed(() => {
    const d = this.draft();
    if (!d) return { calIn: 0, calOut: 0, protein: 0 };
    let calIn = 0,
      protein = 0;
    for (const m of d.meals)
      for (const f of m.items) {
        calIn += f.calories || 0;
        protein += f.proteinG || 0;
      }
    let calOut = 0;
    for (const e of d.exercises) calOut += e.caloriesBurned || 0;
    if (d.activity?.activeCalories != null) {
      calOut =
        d.activity.calorieMode === 'override'
          ? d.activity.activeCalories
          : calOut + d.activity.activeCalories;
    }
    return { calIn: Math.round(calIn), calOut: Math.round(calOut), protein: Math.round(protein) };
  });

  /** True once the draft has at least one loggable entry (gates the commit button). */
  readonly hasAnything = computed(() => {
    const d = this.draft();
    if (!d) return false;
    const foods = d.meals.some((m) => m.items.some((i) => i.description.trim().length > 0));
    const ex = d.exercises.some((e) => e.name.trim().length > 0);
    const drinks = d.hydration.some((h) => h.ml >= 1);
    const hasWeight = d.weight != null && d.weight.weightKg >= 1;
    const hasActivity =
      d.activity != null &&
      ((d.activity.steps ?? 0) > 0 ||
        (d.activity.distanceMeters ?? 0) > 0 ||
        (d.activity.activeCalories ?? 0) > 0);
    return foods || ex || drinks || hasWeight || hasActivity;
  });

  // ---- confidence/clamp chips ----

  /** A quiet confidence chip label for a 0..1 confidence (none ≥0.8, "estimated" 0.5..0.8, "guess" <0.5). */
  confidenceChip(conf: number): string | null {
    if (conf >= 0.8) return null;
    if (conf >= 0.5) return 'estimated';
    return 'guess';
  }

  /** Whether the user already logged a given meal today (drives the "Lunch already logged" nudge). */
  alreadyLogged(meal: Meal): boolean {
    const brief = this.existingBrief.toLowerCase();
    if (!brief) return false;
    return brief.includes(meal);
  }

  // ─────────────────────────────────────────── commit ──────────────────────────────────────────

  /** Resolve with the edited draft + buildId; the page makes ONE atomic /commit call. */
  commit(): void {
    const d = this.draft();
    if (!d || !this.hasAnything() || this.phase() === 'committing') return;
    this.phase.set('committing');
    this.announce.set('Logging your whole day…');
    this.ref.close({ draft: d, buildId: this.buildId() });
  }

  cancel(): void {
    this.ref.close();
  }

  // ─────────────────────────────────────────── helpers ─────────────────────────────────────────

  /** "HH:mm" local time so the model can resolve "this morning"/"after lunch"/"tonight". */
  private localTimeOfDay(): string {
    const now = new Date();
    return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  }

  private toLoading(message: string): void {
    this.phase.set('loading');
    this.announce.set(message);
  }

  private toReview(): void {
    this.phase.set('review');
    this.announce.set(
      'Your day is ready to review. Edit anything, then log it — nothing is logged yet.',
    );
  }

  /** Apply a build response: store its draft/questions/round, then route to questions or review. */
  private applyBuild(res: BuildDayResponse): void {
    this.buildId.set(res.buildId);
    this.draft.set(res.draft);
    this.round.set(res.round);
    this.notes.set(res.notes ?? null);

    const questions = res.questions ?? [];
    // Seed answer slots for any new questions (preserve prior answers by id).
    if (questions.length) {
      this.answers.update((a) => {
        const next = { ...a };
        for (const q of questions) if (!(q.questionId in next)) next[q.questionId] = '';
        return next;
      });
    }

    // Loop cap: once we hit MAX_ROUNDS, or there are no questions, force review.
    if (questions.length > 0 && res.round < MAX_ROUNDS) {
      this.questions.set(questions);
      this.phase.set('questions');
      this.announce.set(
        `AI has ${questions.length} quick question${questions.length === 1 ? '' : 's'}. Answer or skip, then refine.`,
      );
    } else {
      this.questions.set([]);
      this.toReview();
    }
  }
}
