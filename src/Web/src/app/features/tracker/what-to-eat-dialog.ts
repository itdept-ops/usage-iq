import { Component, computed, inject, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
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

import { Api } from '../../core/api';
import { AddFoodRequest, EatOption, FamilyMealSlot, Meal, WhatToEatResult } from '../../core/models';

/**
 * Opened from the tracker (or meals page) with the active date + a sensible default meal slot, plus the
 * caller's REMAINING macros today so each option can show a "fits your remaining: X" hint. Nothing else is
 * passed — the server reads the caller's own context (logged foods, goal, recent foods, on-hand groceries,
 * planned meals). No identity is sent in the body.
 */
export interface WhatToEatData {
  /** Active tracker date (yyyy-MM-dd) — the add-to-tracker / add-to-meal-plan target. */
  date: string;
  /** Default meal slot, time-of-day derived. Used as the add-to-tracker meal + the slot hint sent to the AI. */
  meal: Meal;
  /** The caller's remaining macros today (already floored at 0 server-side) — drives the per-option "fits" hint. */
  remaining: { calories: number; proteinG: number; carbG: number; fatG: number } | null;
  /**
   * Whether the caller has family.use. The "Add to meal plan" (POST /family/meals) and "Add missing to
   * grocery" (POST /family/meals/recipe-breakdown/to-grocery) actions are family.use-gated server-side, so
   * a tracker-only caller (this dialog opens behind tracker.ai) would hit a 403. When false those two
   * actions are hidden — only "Add to tracker" (tracker.self-aligned) is offered.
   */
  canFamily: boolean;
}

/** The dialog's lifecycle phases. */
type Phase = 'loading' | 'options' | 'empty' | 'error';

/** Which per-card action is currently in flight (so only that card's buttons spin/disable). */
type ActionKind = 'tracker' | 'plan' | 'grocery';

/**
 * "✨ What should I eat?" dialog. On open it AUTO-FETCHES options (no prompt needed) that fit the caller's
 * remaining macros, showing a loading skeleton then option cards: title, why-it-fits, macros (kcal/P/C/F)
 * with a "fits your remaining" hint, and HAVE vs MISSING ingredients (missing visually distinct). Each card
 * has three actions — Add to tracker · Add to meal plan · Add missing to grocery — each with a snackbar +
 * an in-flight spinner. A refine box ("high protein", "quick", a craving) re-queries. When AI is off the
 * server returns the friendly fallback list (`aiUsed:false`), which the dialog labels plainly.
 *
 * Mobile-robust like the other tracker dialogs: ~95vw with the single mat-dialog-content scroll region.
 * The dialog mutates nothing itself except via the three reused write endpoints; it resolves with nothing.
 */
@Component({
  selector: 'app-what-to-eat-dialog',
  imports: [
    DecimalPipe, FormsModule, MatDialogModule, MatFormFieldModule, MatInputModule,
    MatButtonModule, MatIconModule, MatProgressSpinnerModule, MatTooltipModule,
  ],
  templateUrl: './what-to-eat-dialog.html',
  styleUrl: './what-to-eat-dialog.scss',
})
export class WhatToEatDialog {
  private ref = inject(MatDialogRef<WhatToEatDialog>);
  private api = inject(Api);
  private snack = inject(MatSnackBar);
  readonly data = inject<WhatToEatData>(MAT_DIALOG_DATA);

  // ---- phase + result ----
  readonly phase = signal<Phase>('loading');
  /** sr-only live announcement of fetch status / results. */
  readonly announce = signal('');
  /** The fetched options. */
  readonly options = signal<EatOption[]>([]);
  /** True on the friendly NON-AI fallback list (Gemini off/unavailable) — drives the "from your plan" banner. */
  readonly fallback = signal(false);

  // ---- refine box ----
  readonly refineText = signal('');

  /**
   * True while a fetch is in flight. The double-submit guard hangs off this (not the options length) so a
   * fast "Try again" / Refine during the very FIRST load — when options is still empty — can't double-fire.
   */
  private inFlight = false;

  // ---- per-card action state: keyed "<index>:<kind>" while that action is in flight ----
  private readonly busyKeys = signal<Set<string>>(new Set());

  /** Skeleton placeholders shown while the first fetch is loading. */
  readonly skeletons = [0, 1, 2];

  constructor() {
    // Auto-fetch on open — no prompt needed.
    void this.fetch();
  }

  // ─────────────────────────────────────────── fetch ───────────────────────────────────────────

  /**
   * Fetch options for the remaining macros (optionally refined by the free-text box). On open this runs with
   * no refine text. A 503 shouldn't happen (the server floors to the friendly list), but ANY error/empty
   * degrades gracefully to the error/empty phase — never a dead-end. Re-runs replace the prior options.
   */
  async fetch(): Promise<void> {
    if (this.inFlight) return; // guard double-submit (independent of options length, so the first load is covered)
    this.inFlight = true;
    this.phase.set('loading');
    this.announce.set('Finding options that fit your remaining macros…');
    const refine = this.refineText().trim();
    try {
      const res: WhatToEatResult = await firstValueFrom(this.api.whatToEat({
        // The box is a single free-text refine; send it as `craving` (the server treats craving/constraints
        // the same — both are Clean-capped free text fed to the model as DATA).
        craving: refine || null,
        meal: this.data.meal,
      }));
      const options = res.options ?? [];
      this.options.set(options);
      this.fallback.set(res.aiUsed === false);
      if (options.length === 0) {
        this.phase.set('empty');
        this.announce.set("I couldn't find an option that fits right now. Try a refine, or add food manually.");
      } else {
        this.phase.set('options');
        const n = options.length;
        this.announce.set(res.aiUsed === false
          ? `Showing ${n} idea${n === 1 ? '' : 's'} from your planned meals and groceries.`
          : `Here ${n === 1 ? 'is 1 option' : `are ${n} options`} that fit your remaining macros.`);
      }
    } catch {
      this.options.set([]);
      this.phase.set('error');
      this.announce.set("I couldn't reach the AI just now. Please try again, or add food manually.");
    } finally {
      this.inFlight = false;
    }
  }

  /** Re-run with the current refine text (replaces the staged options). Bound to the box's submit/button. */
  refine(): void {
    if (this.phase() === 'loading') return;
    void this.fetch();
  }

  // ─────────────────────────────────────────── helpers ─────────────────────────────────────────

  /** The slot label for the header ("breakfast"/…); also the add-to-tracker + meal-plan slot. */
  readonly slotLabel = computed(() => this.data.meal);

  /** Whether the family-scoped actions (meal plan / grocery) may render — gated on the caller's family.use. */
  readonly canFamily = computed(() => this.data.canFamily);

  /** Whether a specific card action is in flight (so only that button spins/disables). */
  isBusy(index: number, kind: ActionKind): boolean {
    return this.busyKeys().has(`${index}:${kind}`);
  }

  /** Whether ANY action on a card is in flight (to disable its sibling actions). */
  cardBusy(index: number): boolean {
    const keys = this.busyKeys();
    return keys.has(`${index}:tracker`) || keys.has(`${index}:plan`) || keys.has(`${index}:grocery`);
  }

  private setBusy(index: number, kind: ActionKind, on: boolean): void {
    this.busyKeys.update(set => {
      const next = new Set(set);
      const key = `${index}:${kind}`;
      if (on) next.add(key); else next.delete(key);
      return next;
    });
  }

  /**
   * A one-line "fits your remaining: X" hint for an option, computed client-side from the remaining macros
   * passed in. Returns '' when we have no remaining data (e.g. no goal set) so the template can hide it.
   */
  fitsHint(o: EatOption): string {
    const rem = this.data.remaining;
    if (!rem) return '';
    const cal = Math.max(0, Math.round(o.macros.calories));
    const afterCal = rem.calories - cal;
    const afterP = Math.max(0, Math.round(rem.proteinG - o.macros.proteinG));
    if (afterCal < 0) {
      return `${Math.abs(Math.round(afterCal))} kcal over your remaining`;
    }
    return `leaves ${Math.round(afterCal)} kcal · ${afterP}g protein to go`;
  }

  // ─────────────────────────────────────────── actions ─────────────────────────────────────────

  /**
   * Add to tracker: log the option as a manual food on the active date + slot, with the option's own macros
   * (no second AI round-trip). Reuses POST /tracker/food via api.addFood. A manual log (no source) auto-saves
   * to "My foods". Snackbar on success; the option stays so the user can also plan/shop it.
   */
  async addToTracker(index: number, o: EatOption): Promise<void> {
    if (this.cardBusy(index)) return;
    this.setBusy(index, 'tracker', true);
    const body: AddFoodRequest = {
      date: this.data.date,
      meal: this.data.meal,
      description: o.title,
      quantity: 1,
      calories: Math.max(0, Math.round(o.macros.calories)),
      proteinG: Math.max(0, Math.round(o.macros.proteinG)),
      carbG: Math.max(0, Math.round(o.macros.carbsG)),
      fatG: Math.max(0, Math.round(o.macros.fatG)),
    };
    try {
      await firstValueFrom(this.api.addFood(body));
      this.snack.open(`Added “${o.title}” to ${this.data.meal}`, 'OK', { duration: 3000 });
    } catch {
      this.snack.open("Couldn't add to tracker — try again", 'Dismiss', { duration: 4000 });
    } finally {
      this.setBusy(index, 'tracker', false);
    }
  }

  /**
   * Add to meal plan: create a FamilyMeal on the active date + slot, seeding ingredients from HAVE + MISSING.
   * Reuses POST /family/meals via api.createFamilyMeal (gated family.use). Snackbar on success.
   */
  async addToPlan(index: number, o: EatOption): Promise<void> {
    if (this.cardBusy(index)) return;
    this.setBusy(index, 'plan', true);
    const ingredients = [...(o.have ?? []), ...(o.missing ?? [])]
      .map(s => s.trim()).filter(Boolean).join('\n');
    try {
      await firstValueFrom(this.api.createFamilyMeal({
        localDate: this.data.date,
        slot: this.data.meal as FamilyMealSlot,
        title: o.title,
        ingredients: ingredients || undefined,
      }));
      this.snack.open(`Added “${o.title}” to your meal plan`, 'OK', { duration: 3000 });
    } catch {
      this.snack.open("Couldn't add to the meal plan — try again", 'Dismiss', { duration: 4000 });
    } finally {
      this.setBusy(index, 'plan', false);
    }
  }

  /**
   * Add missing → grocery: append the option's MISSING items to the household's Groceries list (find-or-create,
   * de-duped server-side). Reuses POST /family/meals/recipe-breakdown/to-grocery via api.recipeBreakdownToGrocery
   * (gated family.use). No-op + quiet snackbar when there's nothing missing.
   */
  async addMissingToGrocery(index: number, o: EatOption): Promise<void> {
    if (this.cardBusy(index)) return;
    const missing = (o.missing ?? []).map(s => s.trim()).filter(Boolean);
    if (missing.length === 0) {
      this.snack.open('Nothing missing — you have it all', 'OK', { duration: 2500 });
      return;
    }
    this.setBusy(index, 'grocery', true);
    try {
      await firstValueFrom(this.api.recipeBreakdownToGrocery(missing));
      const n = missing.length;
      this.snack.open(`Added ${n} item${n === 1 ? '' : 's'} to your grocery list`, 'OK', { duration: 3000 });
    } catch {
      this.snack.open("Couldn't add to the grocery list — try again", 'Dismiss', { duration: 4000 });
    } finally {
      this.setBusy(index, 'grocery', false);
    }
  }

  close(): void {
    this.ref.close();
  }
}
