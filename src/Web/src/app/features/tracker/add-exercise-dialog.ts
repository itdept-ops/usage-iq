import { Component, ElementRef, Injector, afterNextRender, computed, effect, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { Subject, catchError, debounceTime, distinctUntilChanged, firstValueFrom, of, switchMap } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatChipsModule } from '@angular/material/chips';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';

import { Api } from '../../core/api';
import { AddExerciseRequest, CustomExerciseDto, ExerciseLibraryDto, WorkoutXExerciseDto } from '../../core/models';

/** Curated WorkoutX filter values — the provider has no option-list endpoint, so these mirror the catalog. */
const WX_BODY_PARTS = ['Back', 'Cardio', 'Chest', 'Lower Arms', 'Lower Legs', 'Neck', 'Shoulders', 'Upper Arms', 'Upper Legs', 'Waist'];
const WX_EQUIPMENT = ['Body Weight', 'Barbell', 'Dumbbell', 'Cable', 'Leverage Machine', 'Kettlebell', 'Resistance Band', 'Smith Machine'];
const WX_TARGETS = ['Abs', 'Biceps', 'Triceps', 'Pectorals', 'Quads', 'Glutes', 'Hamstrings', 'Lats', 'Delts', 'Calves'];

/** Opens with the active day + whether the profile has a weight (so we can estimate from duration). */
export interface AddExerciseData {
  date: string;
  goal: string;
  /** True when the profile has a weight → duration alone yields a server-side calorie estimate. */
  hasWeight: boolean;
}

/**
 * Add-exercise dialog. Three ways in: pick from the exercise LIBRARY (default = your goal, with a toggle
 * to show all goals) then enter a duration — the server estimates calories from your profile weight, or
 * you can override with a manual figure; browse/search the WORKOUTX catalog (GIF demo, instructions,
 * muscles, recommended sets/reps) and log with a duration → live calorie estimate (override available);
 * OR log a fully MANUAL exercise (free-text name + calories). Resolves with the {@link AddExerciseRequest}
 * for the page to persist via the store.
 */
@Component({
  selector: 'app-add-exercise-dialog',
  imports: [
    FormsModule, MatDialogModule, MatFormFieldModule, MatInputModule, MatButtonModule,
    MatButtonToggleModule, MatCheckboxModule, MatChipsModule, MatIconModule, MatProgressBarModule,
  ],
  templateUrl: './add-exercise-dialog.html',
  styleUrl: './add-exercise-dialog.scss',
})
export class AddExerciseDialog {
  private api = inject(Api);
  private ref = inject(MatDialogRef<AddExerciseDialog, AddExerciseRequest>);
  private injector = inject(Injector);
  readonly data = inject<AddExerciseData>(MAT_DIALOG_DATA);

  readonly mode = signal<'library' | 'workoutx' | 'manual'>('library');

  // Curated filter lists for the WorkoutX tab (no option-list endpoint exists).
  readonly wxBodyPartOptions = WX_BODY_PARTS;
  readonly wxEquipmentOptions = WX_EQUIPMENT;
  readonly wxTargetOptions = WX_TARGETS;

  // ---- library ----
  readonly loading = signal(false);
  readonly library = signal<ExerciseLibraryDto[]>([]);
  readonly showAll = signal(false);
  readonly query = signal('');
  readonly selected = signal<ExerciseLibraryDto | null>(null);
  readonly durationMin = signal<number | null>(30);
  /** When true, the user overrides the server estimate with a typed calorie figure. */
  readonly overrideCals = signal(false);
  readonly manualCalsForLib = signal<number | null>(null);

  // ---- WorkoutX catalog ----
  private static readonly WX_PAGE = 24;
  readonly wxQuery = signal('');
  readonly wxBodyPart = signal('');
  readonly wxTarget = signal('');
  readonly wxEquipment = signal('');
  readonly wxLoading = signal(false);
  /** True once a request came back 503 — WorkoutX isn't configured; show a friendly steer. */
  readonly wxUnavailable = signal(false);
  readonly wxError = signal<string | null>(null);
  readonly wxResults = signal<WorkoutXExerciseDto[]>([]);
  readonly wxTotal = signal(0);
  readonly wxOffset = signal(0);
  readonly wxSelected = signal<WorkoutXExerciseDto | null>(null);
  readonly wxDuration = signal<number | null>(30);
  /** When true, the user overrides the live estimate with a typed calorie figure. */
  readonly wxOverride = signal(false);
  readonly wxManualCals = signal<number | null>(null);
  // GIF demo: object URL of the proxied blob, plus loading/error states. Revoked on change/destroy.
  readonly wxGifUrl = signal<string | null>(null);
  readonly wxGifLoading = signal(false);
  readonly wxGifError = signal(false);
  /** Detected once: when the user prefers reduced motion we don't auto-load the animated GIF. */
  readonly wxReducedMotion = signal(
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  /** Set true when a reduced-motion user explicitly asks to play the demo; reset on selection change. */
  readonly wxGifRequested = signal(false);

  /** Whether the loaded page has more results behind it. */
  readonly wxHasMore = computed(() => this.wxResults().length < this.wxTotal());

  /** Live estimate for the selected WorkoutX exercise: round(caloriesPerMinute * durationMin). */
  readonly wxEstimate = computed<number>(() => {
    const sel = this.wxSelected();
    const min = this.wxDuration() ?? 0;
    if (!sel || min <= 0) return 0;
    return Math.round(sel.caloriesPerMinute * min);
  });

  /** The calorie figure that will be logged for a WorkoutX pick (override beats the live estimate). */
  readonly wxEffectiveCals = computed<number>(() =>
    this.wxOverride() ? (this.wxManualCals() ?? 0) : this.wxEstimate());

  // ---- fully manual ----
  readonly mName = signal('');
  readonly mCalories = signal<number | null>(null);
  readonly mDuration = signal<number | null>(null);
  /** The manual name field — focused after a "My exercises" pick prefills the form below the list. */
  private readonly nameInput = viewChild<ElementRef<HTMLInputElement>>('nameInput');
  /** Brief sr-only announcement (e.g. "Loaded {name}") spoken after a saved pick prefills the form. */
  readonly pickAnnounce = signal('');

  // ---- "My exercises" quick-pick (per-user saved library, atop the Manual tab) ----
  readonly savedQuery = signal('');
  readonly savedLoading = signal(false);
  readonly saved = signal<CustomExerciseDto[]>([]);
  private readonly savedQueryStream = new Subject<string>();
  private savedLoadedOnce = false;
  /**
   * Id of the saved exercise the manual form was last prefilled from, or null for a freshly-typed
   * entry. Drives source="custom" (bump the saved row) vs no source (auto-save a new one). Cleared the
   * moment the user edits the name away from the picked one.
   */
  readonly pickedSavedId = signal<number | null>(null);

  readonly saving = signal(false);
  readonly error = signal<string | null>(null);

  /**
   * Show the subtle "saved to My exercises" hint while typing a fresh manual entry — i.e. a non-empty
   * name that wasn't re-picked from the saved library (those bump instead of creating a new row).
   */
  readonly mWillSave = computed(() =>
    this.pickedSavedId() === null && this.mName().trim().length > 0);

  /** Whether we can let the server estimate (profile weight + a chosen library item + a duration). */
  readonly canEstimate = computed(() =>
    this.data.hasWeight && !!this.selected() && (this.durationMin() ?? 0) > 0);

  readonly filtered = computed<ExerciseLibraryDto[]>(() => {
    const q = this.query().trim().toLowerCase();
    const list = this.library();
    if (!q) return list;
    return list.filter(e => e.name.toLowerCase().includes(q) || e.category.toLowerCase().includes(q));
  });

  readonly canSave = computed(() => {
    if (this.saving()) return false;
    if (this.mode() === 'manual') return this.mName().trim().length > 0 && (this.mCalories() ?? 0) > 0;
    if (this.mode() === 'workoutx') return !!this.wxSelected() && this.wxEffectiveCals() > 0;
    if (!this.selected()) return false;
    if (this.canEstimate() && !this.overrideCals()) return true; // server estimates
    return (this.effectiveCals() ?? 0) > 0; // need an explicit figure
  });

  /** The calorie figure that will be logged when we're NOT deferring to the server estimate. */
  readonly effectiveCals = computed<number | null>(() =>
    this.overrideCals() || !this.data.hasWeight ? this.manualCalsForLib() : null);

  constructor() {
    void this.loadLibrary();

    // Debounced "My exercises" filter — re-fetches the caller's saved library on each keystroke.
    this.savedQueryStream.pipe(
      debounceTime(250),
      distinctUntilChanged(),
      switchMap(q => {
        this.savedLoading.set(true);
        return this.api.savedExercises(q.trim() || undefined).pipe(
          catchError(() => of<CustomExerciseDto[]>([])),
        );
      }),
      takeUntilDestroyed(),
    ).subscribe(list => {
      this.savedLoading.set(false);
      this.saved.set(list);
    });

    effect(() => this.savedQueryStream.next(this.savedQuery()));

    // Load the demo GIF whenever the WorkoutX selection changes. The effect owns the object URL's whole
    // lifetime: its onCleanup (which Angular also runs on destroy) unsubscribes the in-flight request and
    // revokes the URL, so there's exactly one revoke per created URL — no leaks, no double-revoke.
    effect((onCleanup) => {
      const sel = this.wxSelected();
      const requested = this.wxGifRequested();
      this.wxGifUrl.set(null);
      this.wxGifError.set(false);
      this.wxGifLoading.set(false);
      if (!sel) return;
      // Reduced-motion users only get the animated GIF after an explicit "Show animated demo" click;
      // the static instructions/meta remain the alternative until then.
      if (this.wxReducedMotion() && !requested) return;

      let url: string | null = null;
      this.wxGifLoading.set(true);
      const sub = this.api.workoutxGif(sel.id).subscribe({
        next: (blob) => {
          url = URL.createObjectURL(blob);
          this.wxGifUrl.set(url);
          this.wxGifLoading.set(false);
        },
        error: () => {
          this.wxGifLoading.set(false);
          this.wxGifError.set(true);
        },
      });
      onCleanup(() => {
        sub.unsubscribe();
        if (url) URL.revokeObjectURL(url);
      });
    });
  }

  async loadLibrary(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const goal = this.showAll() ? undefined : this.data.goal || undefined;
      this.library.set(await firstValueFrom(this.api.exerciseLibrary(goal)));
    } catch {
      this.error.set('Could not load the exercise library.');
      this.library.set([]);
    } finally {
      this.loading.set(false);
    }
  }

  toggleShowAll(on: boolean): void {
    this.showAll.set(on);
    void this.loadLibrary();
  }

  pick(e: ExerciseLibraryDto): void {
    this.selected.set(this.selected()?.id === e.id ? null : e);
  }

  setMode(m: 'library' | 'workoutx' | 'manual'): void {
    this.mode.set(m);
    this.error.set(null);
    // First time into the WorkoutX tab with nothing loaded yet → fetch the opening page.
    if (m === 'workoutx' && this.wxResults().length === 0 && !this.wxLoading() && !this.wxUnavailable()) {
      void this.searchWorkoutx();
    }
    // Lazy-load the saved "My exercises" library the first time the Manual tab is opened.
    if (m === 'manual' && !this.savedLoadedOnce) {
      this.savedLoadedOnce = true;
      this.savedQueryStream.next(this.savedQuery());
    }
  }

  /** Pick a saved "My exercises" entry → prefill the manual form (name + calories + duration). */
  pickSaved(ex: CustomExerciseDto): void {
    this.mName.set(ex.name);
    this.mCalories.set(ex.defaultCaloriesBurned ?? null);
    this.mDuration.set(ex.defaultDurationMin ?? null);
    // Remember it was a saved pick so save() sends source="custom" (bump, not duplicate).
    this.pickedSavedId.set(ex.id);
    // The prefilled fields render below the list, so move focus there (and announce) — otherwise
    // keyboard/SR users don't realise the form filled. Focus after the DOM reflects the model update.
    this.pickAnnounce.set(`Loaded ${ex.name}`);
    afterNextRender(() => this.nameInput()?.nativeElement.focus(), { injector: this.injector });
  }

  /** Remove a saved exercise from the caller's library (× on a "My exercises" row). Optimistic. */
  deleteSaved(ex: CustomExerciseDto, event: Event): void {
    event.stopPropagation();
    const prev = this.saved();
    this.saved.update(list => list.filter(e => e.id !== ex.id));
    if (this.pickedSavedId() === ex.id) this.pickedSavedId.set(null);
    this.api.deleteSavedExercise(ex.id).subscribe({ error: () => this.saved.set(prev) });
  }

  /** Run a fresh WorkoutX search (resets pagination + selection). */
  async searchWorkoutx(): Promise<void> {
    this.wxOffset.set(0);
    this.wxSelected.set(null);
    await this.fetchWorkoutx(false);
  }

  /** Append the next page of WorkoutX results. */
  async loadMoreWorkoutx(): Promise<void> {
    if (this.wxLoading() || !this.wxHasMore()) return;
    this.wxOffset.set(this.wxResults().length);
    await this.fetchWorkoutx(true);
  }

  private async fetchWorkoutx(append: boolean): Promise<void> {
    this.wxLoading.set(true);
    this.wxError.set(null);
    try {
      const res = await firstValueFrom(this.api.workoutxExercises({
        q: this.wxQuery().trim() || undefined,
        bodyPart: this.wxBodyPart() || undefined,
        target: this.wxTarget() || undefined,
        equipment: this.wxEquipment() || undefined,
        limit: AddExerciseDialog.WX_PAGE,
        offset: this.wxOffset(),
      }));
      this.wxResults.set(append ? [...this.wxResults(), ...res.data] : res.data);
      this.wxTotal.set(res.total);
    } catch (e) {
      if (e instanceof HttpErrorResponse && e.status === 503) {
        this.wxUnavailable.set(true);
      } else {
        this.wxError.set('WorkoutX search failed. Try again.');
      }
      if (!append) { this.wxResults.set([]); this.wxTotal.set(0); }
    } finally {
      this.wxLoading.set(false);
    }
  }

  /**
   * Apply a body-part / equipment / target filter from its chip-listbox (change) then re-search.
   * The listbox is single-select and bound via [value], so it emits the newly selected value (or
   * null/empty when the active chip is toggled off) and owns the toggle — keyboard (Space/Enter) and
   * click route through here identically, giving focus + roving tabindex for free.
   */
  setWxFilter(kind: 'bodyPart' | 'target' | 'equipment', value: string | null | undefined): void {
    const sig = kind === 'bodyPart' ? this.wxBodyPart : kind === 'target' ? this.wxTarget : this.wxEquipment;
    const next = value ?? '';
    if (sig() === next) return; // already in sync with the listbox → avoid a redundant search
    sig.set(next);
    void this.searchWorkoutx();
  }

  /** Reduced-motion users: load the animated demo on explicit request. */
  showWxGif(): void {
    this.wxGifRequested.set(true);
  }

  pickWorkoutx(e: WorkoutXExerciseDto): void {
    this.wxGifRequested.set(false);
    this.wxSelected.set(this.wxSelected()?.id === e.id ? null : e);
  }

  /** Manual-name edit: drop any saved-pick association the moment the name diverges. */
  setManualName(name: string): void {
    this.mName.set(name);
    this.pickedSavedId.set(null);
  }

  save(): void {
    if (!this.canSave()) return;
    let body: AddExerciseRequest;
    if (this.mode() === 'manual') {
      // A re-picked "My exercises" entry bumps the saved row (source="custom"); a freshly-typed entry
      // sends NO source so the backend auto-saves it to the library.
      const fromSaved = this.pickedSavedId() !== null;
      body = {
        date: this.data.date,
        name: this.mName().trim(),
        durationMin: (this.mDuration() ?? 0) > 0 ? this.mDuration()! : undefined,
        caloriesBurned: this.mCalories() ?? 0,
        source: fromSaved ? 'custom' : undefined,
      };
    } else if (this.mode() === 'workoutx') {
      // WorkoutX exercises aren't in the local library, so log by name + a concrete calorie figure
      // (the live caloriesPerMinute estimate, or the manual override) — no server-side MET estimate.
      const e = this.wxSelected()!;
      body = {
        date: this.data.date,
        name: e.name,
        durationMin: this.wxDuration() ?? undefined,
        caloriesBurned: this.wxEffectiveCals(),
        // Tag the source so the backend never auto-saves a WorkoutX log to "My exercises".
        source: 'workoutx',
      };
    } else {
      const e = this.selected()!;
      const deferToServer = this.canEstimate() && !this.overrideCals();
      body = {
        date: this.data.date,
        exerciseId: e.id,
        name: e.name,
        durationMin: this.durationMin() ?? undefined,
        // Omit caloriesBurned so the server estimates from weight + duration + MET; otherwise send it.
        caloriesBurned: deferToServer ? undefined : (this.effectiveCals() ?? undefined),
        // Library logs aren't auto-saved (the ExerciseId already classifies it; source is belt-and-braces).
        source: 'library',
      };
    }
    this.ref.close(body);
  }

  cancel(): void {
    this.ref.close();
  }
}
