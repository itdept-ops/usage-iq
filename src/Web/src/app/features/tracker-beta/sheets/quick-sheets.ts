import {
  ChangeDetectionStrategy, Component, computed, effect, inject, model, signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';

import { Api } from '../../../core/api';
import { AuthService } from '../../../core/auth';
import {
  AddCoffeeRequest, AddExerciseRequest, AddSupplementRequest, CustomExerciseDto,
  ExerciseLibraryDto, PERM, SupplementKind,
} from '../../../core/models';
import { OptimisticTracker } from '../state/optimistic-tracker';
import { BottomSheet } from '../ui/bottom-sheet';

/*
 * sheets/quick-sheets.ts — the three "fast lane" per-domain add sheets for Tracker Beta ("Strata"):
 * Coffee, Exercise, and Supplement. Each is a tiny standalone component that wraps the shared
 * `app-bottom-sheet` primitive, reuses the existing pickers/AI endpoints (Api.savedExercises /
 * exerciseLibrary / parseExercise / estimateSupplement), and commits OPTIMISTICALLY through
 * OptimisticTracker so the hero ring + cards tick instantly with undo/retry handled by the wrapper.
 *
 * Each sheet is self-styled with the page-host Strata tokens (var(--*) only — no global --tech-*),
 * mobile-first with >=44px targets, aria labels, and a reduced-motion-friendly chrome (the sheet rise
 * itself is governed by the bottom-sheet primitive + the page killswitch).
 *
 * Contract (the page binds these VERBATIM):
 *   <app-coffee-sheet      [(open)]="coffeeOpen" />
 *   <app-exercise-sheet    [(open)]="exerciseOpen" />
 *   <app-supplement-sheet  [(open)]="supplementOpen" />
 * All three take a two-way `open` model and self-dismiss after a successful add. They read the active
 * date / readOnly straight off OptimisticTracker (route-provided) — no other inputs needed.
 */

// ── shared bits ───────────────────────────────────────────────────────────────

/** A usual-drink chip for the coffee sheet (cups + a sensible default caffeine). */
interface CoffeeUsual { label: string; cups: number; caffeineMg: number; }
const COFFEE_USUALS: readonly CoffeeUsual[] = [
  { label: 'Mug', cups: 1, caffeineMg: 95 },
  { label: 'Espresso', cups: 1, caffeineMg: 65 },
  { label: 'Cold brew', cups: 1, caffeineMg: 155 },
  { label: 'Large drip', cups: 2, caffeineMg: 190 },
];

interface KindOption { value: SupplementKind; label: string; }
const SUPP_KINDS: readonly KindOption[] = [
  { value: 'supplement', label: 'Supplement' },
  { value: 'vitamin', label: 'Vitamin' },
  { value: 'protein', label: 'Protein' },
  { value: 'preworkout', label: 'Pre-workout' },
  { value: 'medication', label: 'Medication' },
  { value: 'other', label: 'Other' },
];

/** Shared SCSS for the three sheets — Strata-token styled form chrome. Co-located, no global tokens. */
const SHEET_STYLES = `
  :host { display: contents; }

  .qs-head {
    display: flex; align-items: baseline; gap: 8px;
    padding: 4px 2px 12px;
  }
  .qs-title {
    margin: 0; font-family: var(--font-ui); font-weight: 700; font-size: 19px;
    color: var(--ink); letter-spacing: -.01em;
  }
  .qs-sub { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--ink-dim); }

  .qs-form { display: flex; flex-direction: column; gap: 14px; padding-bottom: 8px; }

  .qs-label {
    display: block; margin: 0 0 6px 2px;
    font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--ink-dim);
  }

  /* Text/number inputs — pressed-well field on the matte surface. */
  .qs-input, .qs-select {
    width: 100%; box-sizing: border-box; min-height: 48px;
    padding: 0 14px; font-family: var(--font-ui); font-size: 16px; color: var(--ink);
    background: var(--bg-sink); border: 1px solid var(--hairline); border-radius: var(--r-tile);
    box-shadow: var(--press);
    -webkit-appearance: none; appearance: none;
    transition: border-color 160ms var(--ease-out);
  }
  .qs-input::placeholder { color: var(--ink-faint); }
  .qs-input:focus-visible, .qs-select:focus-visible {
    outline: 2px solid var(--focus); outline-offset: 2px; border-color: var(--focus);
  }
  .qs-select { padding-right: 36px; cursor: pointer; }

  /* Numeric stepper (cups / minutes): [−] value [+]. */
  .qs-stepper {
    display: grid; grid-template-columns: 56px 1fr 56px; align-items: stretch; gap: 8px;
  }
  .qs-step-btn {
    display: flex; align-items: center; justify-content: center;
    min-height: 48px; min-width: 44px;
    font-size: 24px; line-height: 1; color: var(--ink);
    background: var(--bg-rise); border: 1px solid var(--hairline); border-radius: var(--r-tile);
    box-shadow: var(--lift-1);
    touch-action: manipulation; -webkit-tap-highlight-color: transparent; cursor: pointer;
    transition: transform 120ms var(--ease-out), box-shadow 120ms var(--ease-out);
  }
  .qs-step-btn:active:not(:disabled) { transform: translateY(1px) scale(.97); box-shadow: var(--press); }
  .qs-step-btn:disabled { opacity: .4; cursor: default; }
  .qs-step-btn:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
  .qs-step-val {
    display: flex; align-items: center; justify-content: center;
    font-family: var(--font-display); font-weight: 600; font-size: 26px;
    font-variant-numeric: tabular-nums; color: var(--ink);
    background: var(--bg-sink); border: 1px solid var(--hairline); border-radius: var(--r-tile);
    box-shadow: var(--press);
  }

  /* Chip rows (usual drinks, kinds, saved/library picks). */
  .qs-chips { display: flex; flex-wrap: wrap; gap: 8px; }
  .qs-chip {
    min-height: 44px; padding: 0 14px;
    display: inline-flex; align-items: center; gap: 6px;
    font-family: var(--font-ui); font-size: 13px; font-weight: 600; color: var(--ink-dim);
    background: var(--bg-rise); border: 1px solid var(--hairline); border-radius: var(--r-pill);
    box-shadow: var(--lift-1);
    touch-action: manipulation; -webkit-tap-highlight-color: transparent; cursor: pointer;
    transition: transform 120ms var(--ease-out), color 160ms var(--ease-out), border-color 160ms var(--ease-out);
  }
  .qs-chip:active { transform: translateY(1px) scale(.97); box-shadow: var(--press); }
  .qs-chip:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
  .qs-chip[aria-pressed="true"] { color: var(--ink); border-color: var(--accent-edge, var(--focus)); }
  .qs-chip-cal { color: var(--ink-faint); font-variant-numeric: tabular-nums; }

  /* AI estimate affordance. */
  .qs-ai {
    align-self: flex-start; min-height: 44px; padding: 0 14px;
    display: inline-flex; align-items: center; gap: 6px;
    font-family: var(--font-ui); font-size: 13px; font-weight: 600; color: var(--ink);
    background: transparent; border: 1px solid var(--glass-edge); border-radius: var(--r-pill);
    touch-action: manipulation; cursor: pointer;
  }
  .qs-ai:disabled { opacity: .5; cursor: default; }
  .qs-ai:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
  .qs-ai-note { display: flex; align-items: center; gap: 6px; margin: 0; font-size: 12px; color: var(--ink-dim); }

  .qs-macros { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }
  .qs-macro .qs-label { margin-bottom: 4px; }

  /* Primary commit action. */
  .qs-actions { display: flex; gap: 10px; padding-top: 4px; }
  .qs-cta {
    flex: 1 1 auto; min-height: 52px;
    font-family: var(--font-ui); font-size: 16px; font-weight: 700; letter-spacing: -.01em;
    color: #fff; background: linear-gradient(135deg, var(--cta-a, var(--cal-a)), var(--cta-b, var(--cal-b)));
    border: 0; border-radius: var(--r-pill); box-shadow: var(--lift-2);
    touch-action: manipulation; -webkit-tap-highlight-color: transparent; cursor: pointer;
    transition: transform 120ms var(--ease-out), box-shadow 120ms var(--ease-out), opacity 160ms var(--ease-out);
  }
  .qs-cta:active:not(:disabled) { transform: translateY(1px) scale(.99); box-shadow: var(--press); }
  .qs-cta:disabled { opacity: .45; cursor: default; }
  .qs-cta:focus-visible { outline: 2px solid var(--focus); outline-offset: 3px; }

  .qs-spin {
    width: 16px; height: 16px; border-radius: 50%;
    border: 2px solid rgba(255,255,255,.4); border-top-color: #fff;
    animation: qs-spin 700ms linear infinite;
  }
  @keyframes qs-spin { to { transform: rotate(360deg); } }

  .qs-sr {
    position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; border: 0;
    overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap;
  }

  @media (prefers-reduced-motion: reduce) {
    .qs-step-btn, .qs-chip, .qs-cta { transition: none; }
    .qs-spin { animation: none; }
  }
`;

// ── COFFEE ──────────────────────────────────────────────────────────────────

/**
 * Coffee add sheet — a one-or-two-tap log. Tap a "usual" chip to instantly log it (optimistic), or dial
 * cups with the stepper and optionally name the drink + caffeine, then Add. Commits via
 * OptimisticTracker.addCoffee so the Coffee card + caffeine total tick immediately.
 */
@Component({
  selector: 'app-coffee-sheet',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, BottomSheet],
  template: `
    <app-bottom-sheet [(open)]="open" detent="half" label="Log coffee">
      <div class="qs-head" style="--accent-edge: var(--coffee-b);">
        <h2 class="qs-title">Coffee</h2>
        <span class="qs-sub">{{ tracker.date() }}</span>
      </div>

      <div class="qs-form" style="--cta-a: var(--coffee-a); --cta-b: var(--coffee-b); --accent-edge: var(--coffee-b);">
        <div>
          <span class="qs-label" id="cf-usual-lbl">Usual drink</span>
          <div class="qs-chips" role="group" aria-labelledby="cf-usual-lbl">
            @for (u of usuals; track u.label) {
              <button type="button" class="qs-chip" (click)="logUsual(u)"
                      [disabled]="busy() || tracker.readOnly()"
                      [attr.aria-label]="'Log ' + u.label + ', ' + u.cups + ' cups, ' + u.caffeineMg + ' milligrams caffeine'">
                {{ u.label }} <span class="qs-chip-cal">{{ u.caffeineMg }}mg</span>
              </button>
            }
          </div>
        </div>

        <div>
          <span class="qs-label" id="cf-cups-lbl">Cups</span>
          <div class="qs-stepper" role="group" aria-labelledby="cf-cups-lbl">
            <button type="button" class="qs-step-btn" (click)="bump(-1)" [disabled]="cups() <= 1" aria-label="Fewer cups">−</button>
            <div class="qs-step-val" aria-live="polite">{{ cups() }}</div>
            <button type="button" class="qs-step-btn" (click)="bump(1)" [disabled]="cups() >= 20" aria-label="More cups">+</button>
          </div>
        </div>

        <div>
          <label class="qs-label" for="cf-name">Drink (optional)</label>
          <input id="cf-name" class="qs-input" type="text" maxlength="64" autocomplete="off"
                 enterkeyhint="done" placeholder="Mug, Espresso, Cold Brew…"
                 [ngModel]="label()" (ngModelChange)="label.set($event)" />
        </div>

        <div>
          <label class="qs-label" for="cf-caf">Caffeine (optional)</label>
          <input id="cf-caf" class="qs-input" type="number" min="0" max="2000" step="1"
                 inputmode="numeric" enterkeyhint="done" placeholder="mg"
                 [ngModel]="caffeineMg()" (ngModelChange)="caffeineMg.set($event)" />
        </div>

        <div class="qs-actions">
          <button type="button" class="qs-cta" (click)="add()" [disabled]="busy() || tracker.readOnly()">
            @if (busy()) { <span class="qs-spin" aria-hidden="true"></span> } @else { Add coffee }
          </button>
        </div>
        <span class="qs-sr" role="status" aria-live="polite">{{ announce() }}</span>
      </div>
    </app-bottom-sheet>
  `,
  styles: [SHEET_STYLES],
})
export class CoffeeSheet {
  protected readonly tracker = inject(OptimisticTracker);

  readonly open = model<boolean>(false);

  protected readonly usuals = COFFEE_USUALS;
  protected readonly cups = signal(1);
  protected readonly label = signal('');
  protected readonly caffeineMg = signal<number | null>(null);
  protected readonly busy = signal(false);
  protected readonly announce = signal('');

  constructor() {
    // Reset the form each time the sheet opens (fresh entry, no stale values).
    effect(() => {
      if (this.open()) {
        this.cups.set(1);
        this.label.set('');
        this.caffeineMg.set(null);
        this.announce.set('');
      }
    });
  }

  protected bump(delta: number): void {
    this.cups.update(c => Math.min(20, Math.max(1, c + delta)));
  }

  /** One-tap log of a usual drink, then dismiss. */
  protected async logUsual(u: CoffeeUsual): Promise<void> {
    if (this.busy() || this.tracker.readOnly()) return;
    await this.commit({ date: this.tracker.date(), cups: u.cups, caffeineMg: u.caffeineMg, label: u.label });
  }

  protected async add(): Promise<void> {
    if (this.busy() || this.tracker.readOnly()) return;
    const mg = this.caffeineMg();
    const label = this.label().trim();
    await this.commit({
      date: this.tracker.date(),
      cups: this.cups(),
      caffeineMg: mg != null && mg > 0 ? Math.round(mg) : undefined,
      label: label || undefined,
    });
  }

  private async commit(body: AddCoffeeRequest): Promise<void> {
    this.busy.set(true);
    this.announce.set('Logging coffee…');
    try {
      await this.tracker.addCoffee(body);
      this.announce.set(`Logged ${body.cups} ${body.cups === 1 ? 'cup' : 'cups'} of coffee.`);
      this.open.set(false);
    } finally {
      this.busy.set(false);
    }
  }
}

// ── EXERCISE ────────────────────────────────────────────────────────────────

/** A unified pick row for the exercise sheet (from "My exercises" or the goal library). */
interface ExercisePick {
  name: string;
  /** library row id (server estimates burn from duration) — absent for a saved/manual pick. */
  exerciseId?: number;
  defaultDurationMin?: number;
  defaultCaloriesBurned?: number;
  source: 'custom' | 'library';
}

/**
 * Exercise add sheet — reuses the saved "My exercises" library (Api.savedExercises) and the goal exercise
 * library (Api.exerciseLibrary) as one-tap picks, plus a manual name+duration+calories entry, plus an AI
 * "describe it" parse (Api.parseExercise, gated on tracker.ai, 503-graceful). Commits via
 * OptimisticTracker.addExercise (server estimates calories from duration when an exerciseId is supplied).
 */
@Component({
  selector: 'app-exercise-sheet',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, BottomSheet],
  template: `
    <app-bottom-sheet [(open)]="open" detent="full" label="Log exercise">
      <div class="qs-head" style="--accent-edge: var(--move-a);">
        <h2 class="qs-title">Exercise</h2>
        <span class="qs-sub">{{ tracker.date() }}</span>
      </div>

      <div class="qs-form" style="--cta-a: var(--move-a); --cta-b: var(--move-b); --accent-edge: var(--move-a);">
        @if (picks().length) {
          <div>
            <span class="qs-label" id="ex-pick-lbl">{{ savedCount() ? 'Recent & library' : 'Library' }}</span>
            <div class="qs-chips" role="group" aria-labelledby="ex-pick-lbl">
              @for (p of picks(); track p.source + ':' + (p.exerciseId ?? p.name)) {
                <button type="button" class="qs-chip"
                        [attr.aria-pressed]="isPicked(p)"
                        (click)="choose(p)"
                        [attr.aria-label]="'Pick ' + p.name">
                  {{ p.name }}
                  @if (p.defaultCaloriesBurned) { <span class="qs-chip-cal">{{ p.defaultCaloriesBurned }} kcal</span> }
                </button>
              }
            </div>
          </div>
        }

        <div>
          <label class="qs-label" for="ex-name">Exercise</label>
          <input id="ex-name" class="qs-input" type="text" maxlength="120" autocomplete="off"
                 enterkeyhint="done" placeholder="Running, Push-ups, Yoga…"
                 [ngModel]="name()" (ngModelChange)="onNameChange($event)" />
        </div>

        @if (showAi()) {
          <button type="button" class="qs-ai" (click)="parseWithAi()" [disabled]="aiBusy() || !name().trim()"
                  aria-label="Estimate this exercise with AI">
            @if (aiBusy()) { <span class="qs-spin" aria-hidden="true"></span> Estimating… }
            @else { ✨ Estimate with AI }
          </button>
          @if (aiNote(); as n) { <p class="qs-ai-note">✨ {{ n }}</p> }
        }

        <div class="qs-macros">
          <div class="qs-macro">
            <label class="qs-label" for="ex-dur">Minutes</label>
            <input id="ex-dur" class="qs-input" type="number" min="0" max="1440" step="1"
                   inputmode="numeric" enterkeyhint="done" placeholder="optional"
                   [ngModel]="durationMin()" (ngModelChange)="durationMin.set($event)" />
          </div>
          <div class="qs-macro">
            <label class="qs-label" for="ex-cal">Calories</label>
            <input id="ex-cal" class="qs-input" type="number" min="0" max="10000" step="1"
                   inputmode="numeric" enterkeyhint="done" [placeholder]="calPlaceholder()"
                   [ngModel]="caloriesBurned()" (ngModelChange)="caloriesBurned.set($event)" />
          </div>
        </div>

        <div class="qs-actions">
          <button type="button" class="qs-cta" (click)="add()" [disabled]="busy() || !canSave() || tracker.readOnly()">
            @if (busy()) { <span class="qs-spin" aria-hidden="true"></span> } @else { Log exercise }
          </button>
        </div>
        <span class="qs-sr" role="status" aria-live="polite">{{ announce() }}</span>
      </div>
    </app-bottom-sheet>
  `,
  styles: [SHEET_STYLES],
})
export class ExerciseSheet {
  protected readonly tracker = inject(OptimisticTracker);
  private readonly api = inject(Api);
  private readonly auth = inject(AuthService);

  readonly open = model<boolean>(false);

  protected readonly showAi = signal(this.auth.hasPermission(PERM.trackerAi));

  protected readonly name = signal('');
  protected readonly exerciseId = signal<number | null>(null);
  protected readonly durationMin = signal<number | null>(null);
  protected readonly caloriesBurned = signal<number | null>(null);

  private readonly saved = signal<CustomExerciseDto[]>([]);
  private readonly library = signal<ExerciseLibraryDto[]>([]);
  protected readonly savedCount = computed(() => this.saved().length);

  protected readonly busy = signal(false);
  protected readonly aiBusy = signal(false);
  protected readonly aiNote = signal<string | null>(null);
  protected readonly announce = signal('');

  /** Saved "My exercises" first (newest-used), then the goal library; capped so the chip row stays light. */
  protected readonly picks = computed<ExercisePick[]>(() => {
    const fromSaved = this.saved().map<ExercisePick>(s => ({
      name: s.name, defaultDurationMin: s.defaultDurationMin,
      defaultCaloriesBurned: s.defaultCaloriesBurned, source: 'custom',
    }));
    const seen = new Set(fromSaved.map(p => p.name.toLowerCase()));
    const fromLib = this.library()
      .filter(l => !seen.has(l.name.toLowerCase()))
      .map<ExercisePick>(l => ({ name: l.name, exerciseId: l.id, source: 'library' }));
    return [...fromSaved, ...fromLib].slice(0, 16);
  });

  /** Calories input placeholder hints the server-estimate path when a library pick + duration is set. */
  protected readonly calPlaceholder = computed(() =>
    this.exerciseId() != null && this.durationMin() ? 'auto' : 'optional');

  /** Save is allowed once there's a name AND either a library-estimate path (id + duration) or a calorie figure. */
  protected readonly canSave = computed(() => {
    const hasName = this.name().trim().length > 0;
    const cal = this.caloriesBurned();
    const canEstimate = this.exerciseId() != null && (this.durationMin() ?? 0) > 0;
    return hasName && (canEstimate || (cal != null && cal > 0));
  });

  constructor() {
    effect(() => {
      if (this.open()) {
        this.reset();
        void this.loadPickers();
      }
    });
  }

  private reset(): void {
    this.name.set('');
    this.exerciseId.set(null);
    this.durationMin.set(null);
    this.caloriesBurned.set(null);
    this.aiNote.set(null);
    this.announce.set('');
  }

  private async loadPickers(): Promise<void> {
    // Both are best-effort; an empty/failed picker just hides its chips.
    const [saved, lib] = await Promise.allSettled([
      firstValueFrom(this.api.savedExercises()),
      firstValueFrom(this.api.exerciseLibrary()),
    ]);
    if (saved.status === 'fulfilled') this.saved.set(saved.value);
    if (lib.status === 'fulfilled') this.library.set(lib.value);
  }

  protected isPicked(p: ExercisePick): boolean {
    return this.name().trim().toLowerCase() === p.name.toLowerCase()
      && (p.exerciseId ?? null) === this.exerciseId();
  }

  /** Prefill from a saved/library pick. Library picks carry an exerciseId so the server estimates burn. */
  protected choose(p: ExercisePick): void {
    this.name.set(p.name);
    this.exerciseId.set(p.exerciseId ?? null);
    if (p.defaultDurationMin != null) this.durationMin.set(p.defaultDurationMin);
    if (p.defaultCaloriesBurned != null && p.exerciseId == null) this.caloriesBurned.set(p.defaultCaloriesBurned);
    this.aiNote.set(null);
  }

  /** Typing a name detaches any picked library id (so it logs as the new manual name). */
  protected onNameChange(value: string): void {
    this.name.set(value);
    this.exerciseId.set(null);
    this.aiNote.set(null);
  }

  /** AI parse of the typed name into name + calories (+ duration). 503-graceful → silent steer to manual. */
  protected async parseWithAi(): Promise<void> {
    const text = this.name().trim();
    if (!text || this.aiBusy()) return;
    this.aiBusy.set(true);
    this.announce.set('Estimating exercise with AI…');
    try {
      const res = await firstValueFrom(this.api.parseExercise({ text }));
      this.name.set(res.name);
      this.exerciseId.set(null);
      this.caloriesBurned.set(res.calories);
      if (res.durationMin != null) this.durationMin.set(res.durationMin);
      this.aiNote.set(res.note ?? null);
      this.announce.set(`AI estimate: ${res.calories} calories${res.durationMin ? `, ${res.durationMin} minutes` : ''}.`);
    } catch {
      this.aiNote.set(null);
      this.announce.set('AI estimate unavailable. Enter the values manually.');
    } finally {
      this.aiBusy.set(false);
    }
  }

  protected async add(): Promise<void> {
    if (this.busy() || !this.canSave() || this.tracker.readOnly()) return;
    const name = this.name().trim();
    const dur = this.durationMin();
    const cal = this.caloriesBurned();
    const id = this.exerciseId();
    const body: AddExerciseRequest = {
      date: this.tracker.date(),
      name,
      exerciseId: id ?? undefined,
      durationMin: dur != null && dur > 0 ? Math.round(dur) : undefined,
      caloriesBurned: cal != null && cal > 0 ? Math.round(cal) : undefined,
      source: id != null ? 'library' : 'custom',
    };
    this.busy.set(true);
    this.announce.set('Logging exercise…');
    try {
      await this.tracker.addExercise(body);
      this.announce.set(`Logged ${name}.`);
      this.open.set(false);
    } finally {
      this.busy.set(false);
    }
  }
}

// ── SUPPLEMENT ──────────────────────────────────────────────────────────────

/**
 * Supplement add sheet — name + optional dose + kind, with macros (most are 0; protein powders carry
 * real values). For tracker.ai users an AI "estimate" (Api.estimateSupplement) prefills the editable
 * kind + macros (503-graceful). Commits via OptimisticTracker.addSupplement.
 */
@Component({
  selector: 'app-supplement-sheet',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, BottomSheet],
  template: `
    <app-bottom-sheet [(open)]="open" detent="half" label="Log supplement">
      <div class="qs-head" style="--accent-edge: var(--pro-a);">
        <h2 class="qs-title">Supplement</h2>
        <span class="qs-sub">{{ tracker.date() }}</span>
      </div>

      <div class="qs-form" style="--cta-a: var(--pro-a); --cta-b: var(--pro-b); --accent-edge: var(--pro-a);">
        <div>
          <label class="qs-label" for="sp-name">Name</label>
          <input id="sp-name" class="qs-input" type="text" maxlength="120" autocomplete="off"
                 enterkeyhint="done" placeholder="Whey protein, Creatine, Vitamin D…"
                 [ngModel]="name()" (ngModelChange)="onNameChange($event)" />
        </div>

        <div>
          <label class="qs-label" for="sp-dose">Dose (optional)</label>
          <input id="sp-dose" class="qs-input" type="text" maxlength="60" autocomplete="off"
                 enterkeyhint="done" placeholder="1 scoop, 5 g, 1 tablet…"
                 [ngModel]="dose()" (ngModelChange)="dose.set($event)" />
        </div>

        @if (showAi()) {
          <button type="button" class="qs-ai" (click)="estimateWithAi()" [disabled]="aiBusy() || !name().trim()"
                  aria-label="Estimate this supplement's macros with AI">
            @if (aiBusy()) { <span class="qs-spin" aria-hidden="true"></span> Estimating… }
            @else { ✨ Estimate with AI }
          </button>
          @if (aiEstimated()) { <p class="qs-ai-note">✨ AI estimate — adjust anything below.@if (aiNote(); as n) { <span> {{ n }}</span> }</p> }
        }

        <div>
          <label class="qs-label" for="sp-kind">Kind</label>
          <select id="sp-kind" class="qs-select" [ngModel]="kind()" (ngModelChange)="kind.set($event)">
            @for (k of kinds; track k.value) { <option [value]="k.value">{{ k.label }}</option> }
          </select>
        </div>

        <div class="qs-macros" role="group" aria-label="Supplement macros">
          <div class="qs-macro">
            <label class="qs-label" for="sp-cal">Calories</label>
            <input id="sp-cal" class="qs-input" type="number" min="0" max="5000" step="1"
                   inputmode="numeric" placeholder="0"
                   [ngModel]="calories()" (ngModelChange)="calories.set($event)" />
          </div>
          <div class="qs-macro">
            <label class="qs-label" for="sp-pro">Protein (g)</label>
            <input id="sp-pro" class="qs-input" type="number" min="0" max="500" step="1"
                   inputmode="decimal" placeholder="0"
                   [ngModel]="protein()" (ngModelChange)="protein.set($event)" />
          </div>
          <div class="qs-macro">
            <label class="qs-label" for="sp-carb">Carbs (g)</label>
            <input id="sp-carb" class="qs-input" type="number" min="0" max="500" step="1"
                   inputmode="decimal" placeholder="0"
                   [ngModel]="carb()" (ngModelChange)="carb.set($event)" />
          </div>
          <div class="qs-macro">
            <label class="qs-label" for="sp-fat">Fat (g)</label>
            <input id="sp-fat" class="qs-input" type="number" min="0" max="500" step="1"
                   inputmode="decimal" placeholder="0"
                   [ngModel]="fat()" (ngModelChange)="fat.set($event)" />
          </div>
        </div>

        <div class="qs-actions">
          <button type="button" class="qs-cta" (click)="add()" [disabled]="busy() || !canSave() || tracker.readOnly()">
            @if (busy()) { <span class="qs-spin" aria-hidden="true"></span> } @else { Add supplement }
          </button>
        </div>
        <span class="qs-sr" role="status" aria-live="polite">{{ announce() }}</span>
      </div>
    </app-bottom-sheet>
  `,
  styles: [SHEET_STYLES],
})
export class SupplementSheet {
  protected readonly tracker = inject(OptimisticTracker);
  private readonly api = inject(Api);
  private readonly auth = inject(AuthService);

  readonly open = model<boolean>(false);

  protected readonly kinds = SUPP_KINDS;
  protected readonly showAi = signal(this.auth.hasPermission(PERM.trackerAi));

  protected readonly name = signal('');
  protected readonly dose = signal('');
  protected readonly kind = signal<SupplementKind>('supplement');
  protected readonly calories = signal<number | null>(null);
  protected readonly protein = signal<number | null>(null);
  protected readonly carb = signal<number | null>(null);
  protected readonly fat = signal<number | null>(null);

  protected readonly busy = signal(false);
  protected readonly aiBusy = signal(false);
  protected readonly aiEstimated = signal(false);
  protected readonly aiNote = signal<string | null>(null);
  protected readonly announce = signal('');

  protected readonly canSave = computed(() => this.name().trim().length > 0);

  constructor() {
    effect(() => {
      if (this.open()) {
        this.name.set('');
        this.dose.set('');
        this.kind.set('supplement');
        this.calories.set(null);
        this.protein.set(null);
        this.carb.set(null);
        this.fat.set(null);
        this.aiEstimated.set(false);
        this.aiNote.set(null);
        this.announce.set('');
      }
    });
  }

  /** Editing the name invalidates a prior AI estimate (numbers may no longer match). */
  protected onNameChange(value: string): void {
    this.name.set(value);
    if (this.aiEstimated()) {
      this.aiEstimated.set(false);
      this.aiNote.set(null);
    }
  }

  protected async estimateWithAi(): Promise<void> {
    const name = this.name().trim();
    if (!name || this.aiBusy()) return;
    this.aiBusy.set(true);
    this.announce.set('Estimating supplement macros with AI…');
    try {
      const dose = this.dose().trim();
      const res = await firstValueFrom(this.api.estimateSupplement({ name, dose: dose || undefined }));
      this.kind.set(res.kind);
      this.calories.set(res.calories);
      this.protein.set(res.proteinG);
      this.carb.set(res.carbsG);
      this.fat.set(res.fatG);
      this.aiNote.set(res.note ?? null);
      this.aiEstimated.set(true);
      this.announce.set(
        `AI estimate: ${res.calories} calories, ${res.proteinG} grams protein, ` +
        `${res.carbsG} grams carbs, ${res.fatG} grams fat.` + (res.note ? ` ${res.note}` : ''));
    } catch {
      this.aiEstimated.set(false);
      this.aiNote.set(null);
      this.announce.set('AI estimate unavailable. Enter the values manually.');
    } finally {
      this.aiBusy.set(false);
    }
  }

  /** A macro field as a clamped non-negative integer, or undefined (omitted → server defaults to 0). */
  private macroOf(value: number | null, max: number): number | undefined {
    if (value == null || value <= 0) return undefined;
    return Math.min(Math.round(value), max);
  }

  protected async add(): Promise<void> {
    if (this.busy() || !this.canSave() || this.tracker.readOnly()) return;
    const name = this.name().trim();
    const dose = this.dose().trim();
    const body: AddSupplementRequest = {
      date: this.tracker.date(),
      name,
      dose: dose || undefined,
      kind: this.kind(),
      calories: this.macroOf(this.calories(), 5000),
      protein: this.macroOf(this.protein(), 500),
      carb: this.macroOf(this.carb(), 500),
      fat: this.macroOf(this.fat(), 500),
    };
    this.busy.set(true);
    this.announce.set('Logging supplement…');
    try {
      await this.tracker.addSupplement(body);
      this.announce.set(`Logged ${name}.`);
      this.open.set(false);
    } finally {
      this.busy.set(false);
    }
  }
}
