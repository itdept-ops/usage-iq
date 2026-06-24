import { Component, computed, inject, signal, ChangeDetectionStrategy } from '@angular/core';
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
import { FamilyMeal, RefineMealResponse } from '../../core/models';

/** What the caller passes in: the planned meal to refine. */
export interface RefineMealData {
  meal: FamilyMeal;
}

/**
 * The dialog resolves with `'wrote'` when the refined meal was applied (PATCHed onto the plan), so the caller
 * reloads the week; otherwise undefined (cancelled / nothing changed).
 */
export type RefineMealDialogResult = 'wrote' | undefined;

/** The dialog's lifecycle phases: edit the preference → previewing a proposal → applying the PATCH. */
type Phase = 'form' | 'loading' | 'preview' | 'applying';

/** Quick-pick refine prompts the user can tap to seed the textarea. */
const EXAMPLE_CHIPS: readonly string[] = [
  'make it vegetarian',
  'lower the carbs',
  'higher protein',
  'swap a main ingredient',
];

/**
 * "Refine with AI" dialog — opened from a single planned meal card (gated tracker.ai). The user writes a free-text
 * preference ("make it vegetarian", "lower the carbs"), ✨ Refine asks Gemini for a rewrite of THIS one dish, and
 * the proposal (new title / ingredients / per-serving macros + dish total) is PREVIEWED. "Apply" persists it onto
 * the plan via the existing patchFamilyMeal (per-serving → dish-total macro conversion, exactly like the planner's
 * other AI flows) then closes `'wrote'`; "Try a different request" returns to the form. ALWAYS-200 server floor:
 * when AI is off/unavailable the response echoes the original (aiUsed:false) and we snack a friendly note —
 * nothing changes. Mirrors the tracker dialog conventions (tracker-dialog panel, busy guards, graceful snackbars).
 */
@Component({
  selector: 'app-refine-meal-dialog',
  imports: [
    DecimalPipe,
    FormsModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    MatIconModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
  ],
  templateUrl: './refine-meal-dialog.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './refine-meal-dialog.scss',
})
export class RefineMealDialog {
  private ref = inject(MatDialogRef<RefineMealDialog, RefineMealDialogResult>);
  private api = inject(Api);
  private snack = inject(MatSnackBar);
  readonly data = inject<RefineMealData>(MAT_DIALOG_DATA);

  readonly exampleChips = EXAMPLE_CHIPS;

  /** The meal being refined (its title + per-serving macros drive the "current" summary + the request). */
  readonly meal = this.data.meal;

  // ---- form ----
  /** The free-text preference the user is typing (maxlength 300, submit disabled when blank). */
  readonly preference = signal('');

  // ---- result ----
  readonly phase = signal<Phase>('form');
  /** sr-only live announcement of refine status / results. */
  readonly announce = signal('');
  /** The AI's proposed rewrite (only meaningful while phase is 'preview'). */
  readonly proposal = signal<RefineMealResponse | null>(null);

  /** Guards double-submit independent of phase. */
  private inFlight = false;

  /** Trimmed preference; the submit button is disabled when this is empty. */
  readonly canRefine = computed(() => this.preference().trim().length > 0);

  /** Append an example chip to the textarea (replacing it when still empty, else appending on a new clause). */
  useExample(text: string): void {
    const current = this.preference().trim();
    this.preference.set(current ? `${current}, ${text}` : text);
  }

  // ─────────────────────────────────────────── refine ──────────────────────────────────────────

  /**
   * Ask the AI to rewrite this meal to honour the preference. ALWAYS 200 server-side; `aiUsed === false` means
   * the AI is off/unavailable and the response echoes the original — we keep the user on the form with a friendly
   * note. ANY error degrades gracefully (stay on the form). Re-runs replace the prior proposal.
   */
  async refine(): Promise<void> {
    if (this.inFlight || !this.canRefine()) return;
    this.inFlight = true;
    this.phase.set('loading');
    this.announce.set('Refining your meal with AI…');
    try {
      const res = await firstValueFrom(
        this.api.refineMeal({
          title: this.meal.title,
          ingredients: this.meal.ingredients,
          servings: this.meal.servings,
          calories: this.meal.calories,
          proteinG: this.meal.perServing.proteinG,
          carbG: this.meal.perServing.carbG,
          fatG: this.meal.perServing.fatG,
          preference: this.preference().trim(),
        }),
      );
      if (!res.aiUsed) {
        // The server echoed the original (AI off/unavailable). Nothing changed — stay on the form.
        this.phase.set('form');
        this.announce.set('AI is unavailable right now — nothing changed.');
        this.snack.open('AI is unavailable right now — nothing changed.', 'OK', { duration: 4000 });
        return;
      }
      this.proposal.set(res);
      this.phase.set('preview');
      this.announce.set(`Here's a refined version: ${res.title}.`);
    } catch {
      this.phase.set('form');
      this.snack.open("Couldn't refine that meal — please try again.", 'Dismiss', {
        duration: 4000,
      });
    } finally {
      this.inFlight = false;
    }
  }

  /** Back to the form to tweak the preference and re-refine (keeps the typed text). */
  backToForm(): void {
    if (this.phase() === 'applying') return;
    this.proposal.set(null);
    this.phase.set('form');
  }

  // ─────────────────────────────────────────── apply ───────────────────────────────────────────

  /**
   * Persist the proposed rewrite onto the plan via the EXISTING meal PATCH. The response gives PER-SERVING macros
   * but the store keeps dish TOTALS, so multiply by servings (round to 1dp) exactly like saveBreakdownAsMeal does.
   * `slot`/`localDate` are omitted so PATCH leaves them unchanged. On success close `'wrote'` so the caller
   * reloads the week; on error snack gracefully and stay on the preview.
   */
  async apply(): Promise<void> {
    const res = this.proposal();
    if (!res || this.inFlight) return;
    this.inFlight = true;
    this.phase.set('applying');
    try {
      await firstValueFrom(
        this.api.patchFamilyMeal(this.meal.id, {
          title: res.title,
          ingredients: res.ingredients,
          servings: res.servings,
          calories: res.calories,
          proteinG: this.round1(res.proteinG * res.servings),
          carbG: this.round1(res.carbG * res.servings),
          fatG: this.round1(res.fatG * res.servings),
          macroSource: 'ai',
        }),
      );
      this.snack.open(`Refined “${res.title}”.`, 'OK', { duration: 3000 });
      this.ref.close('wrote');
    } catch {
      this.phase.set('preview');
      this.snack.open("Couldn't apply that refine — please try again.", 'Dismiss', {
        duration: 4000,
      });
    } finally {
      this.inFlight = false;
    }
  }

  /** Close without writing anything. */
  close(): void {
    if (this.phase() === 'applying') return;
    this.ref.close(undefined);
  }

  private round1(n: number): number {
    return Math.round((Number.isFinite(n) ? n : 0) * 10) / 10;
  }
}
