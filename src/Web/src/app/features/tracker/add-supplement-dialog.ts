import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';

import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar } from '@angular/material/snack-bar';

import { Api } from '../../core/api';
import { AuthService } from '../../core/auth';
import { AddSupplementRequest, PERM, SupplementKind } from '../../core/models';

/** Opens with the active date and an optional preset name (from a quick-add tile). */
export interface AddSupplementData {
  date: string;
  /** Pre-fill the name field (e.g. "Whey protein" from a tile); blank for the Custom button. */
  presetName?: string;
}

/** What the dialog resolves with so the page can log it + refresh. */
export interface AddSupplementResult {
  request: AddSupplementRequest;
}

interface KindOption { value: SupplementKind; label: string }

/** The Kind picker options (Medication included, per the spec). */
const KINDS: KindOption[] = [
  { value: 'supplement', label: 'Supplement' },
  { value: 'vitamin', label: 'Vitamin' },
  { value: 'protein', label: 'Protein' },
  { value: 'preworkout', label: 'Pre-workout' },
  { value: 'medication', label: 'Medication' },
  { value: 'other', label: 'Other' },
];

/**
 * Add-a-supplement dialog (mirrors the add-food AI-estimate pattern). The user types a Name + optional
 * Dose and picks a Kind. For `tracker.ai` users an ✨ "Estimate with AI" button calls supplement-macros
 * and PREFILLS the editable kind/calories/macros (a suggestion, not authoritative). Manual entry is
 * ALWAYS available; a 503/error just shows a snackbar and leaves every field editable. Most supplements
 * carry 0 macros — protein powders carry real ones. Resolves with an {@link AddSupplementResult}.
 */
@Component({
  selector: 'app-add-supplement-dialog',
  imports: [
    FormsModule, MatDialogModule, MatFormFieldModule, MatInputModule, MatSelectModule,
    MatButtonModule, MatIconModule, MatProgressSpinnerModule,
  ],
  template: `
    <h2 mat-dialog-title class="sp-title">Add supplement</h2>
    <mat-dialog-content class="sp-body">
      <mat-form-field appearance="outline" class="sp-field">
        <mat-label>Name</mat-label>
        <input matInput type="text" maxlength="120" cdkFocusInitial
               placeholder="Whey protein, Creatine, Vitamin D…"
               [ngModel]="name()" (ngModelChange)="onNameChange($event)" />
        <mat-hint>Logged for {{ data.date }}.</mat-hint>
      </mat-form-field>

      <mat-form-field appearance="outline" class="sp-field">
        <mat-label>Dose (optional)</mat-label>
        <input matInput type="text" maxlength="60" placeholder="1 scoop, 5 g, 1 tablet…"
               [ngModel]="dose()" (ngModelChange)="dose.set($event)" />
      </mat-form-field>

      @if (showAi) {
        <!-- ✨ Estimate with AI: supplement-macros → prefilled editable kind + macros. -->
        <button mat-stroked-button type="button" class="sp-ai-btn"
                [disabled]="!canEstimate()" (click)="estimateWithAi()"
                aria-label="Estimate this supplement's macros with AI">
          @if (aiLoading()) {
            <mat-progress-spinner mode="indeterminate" diameter="18" aria-hidden="true" />
            Estimating…
          } @else {
            <span class="sp-ai-btn-label"><mat-icon aria-hidden="true">auto_awesome</mat-icon> Estimate with AI</span>
          }
        </button>
        @if (aiEstimated()) {
          <p class="sp-ai-chip" role="status">
            <mat-icon aria-hidden="true">auto_awesome</mat-icon>
            AI estimate — adjust anything below.@if (aiNote(); as n) { <span class="sp-ai-note">{{ n }}</span> }
          </p>
        }
        <span class="sp-sr-status" role="status" aria-live="polite">{{ aiAnnounce() }}</span>
      }

      <mat-form-field appearance="outline" class="sp-field">
        <mat-label>Kind</mat-label>
        <mat-select [ngModel]="kind()" (ngModelChange)="kind.set($event)">
          @for (k of kinds; track k.value) {
            <mat-option [value]="k.value">{{ k.label }}</mat-option>
          }
        </mat-select>
      </mat-form-field>

      <p class="micro-label sp-macro-hint">
        Macros count toward your day total. Most supplements are 0 — protein powders carry real values.
      </p>

      <div class="sp-macros" role="group" aria-label="Supplement macros">
        <mat-form-field appearance="outline" class="sp-macro">
          <mat-label>Calories</mat-label>
          <input matInput type="number" min="0" max="5000" step="1" inputmode="numeric"
                 [ngModel]="calories()" (ngModelChange)="calories.set($event)" />
          <span matTextSuffix>kcal</span>
        </mat-form-field>
        <mat-form-field appearance="outline" class="sp-macro">
          <mat-label>Protein</mat-label>
          <input matInput type="number" min="0" max="500" step="1" inputmode="decimal"
                 [ngModel]="protein()" (ngModelChange)="protein.set($event)" />
          <span matTextSuffix>g</span>
        </mat-form-field>
        <mat-form-field appearance="outline" class="sp-macro">
          <mat-label>Carbs</mat-label>
          <input matInput type="number" min="0" max="500" step="1" inputmode="decimal"
                 [ngModel]="carb()" (ngModelChange)="carb.set($event)" />
          <span matTextSuffix>g</span>
        </mat-form-field>
        <mat-form-field appearance="outline" class="sp-macro">
          <mat-label>Fat</mat-label>
          <input matInput type="number" min="0" max="500" step="1" inputmode="decimal"
                 [ngModel]="fat()" (ngModelChange)="fat.set($event)" />
          <span matTextSuffix>g</span>
        </mat-form-field>
      </div>
    </mat-dialog-content>
    <mat-dialog-actions class="sp-actions" align="end">
      <button mat-stroked-button type="button" (click)="cancel()">Cancel</button>
      <button mat-flat-button type="button" color="primary" [disabled]="!canSave()" (click)="save()">Add</button>
    </mat-dialog-actions>
  `,
  styles: `
    .sp-title { font-family: var(--tech-font-ui); font-weight: 700; color: var(--tech-text); }
    .sp-body { min-width: min(380px, 84vw); padding-top: 4px !important;
      display: flex; flex-direction: column; gap: var(--tech-space-2); }
    .sp-field { width: 100%; }
    .sp-actions { padding: var(--tech-space-3) var(--tech-space-4); gap: 8px;
      button { border-radius: var(--tech-r-control); font-weight: 600; min-height: 44px; } }

    .sp-ai-btn {
      align-self: flex-start; min-height: 44px; border-radius: var(--tech-r-control); font-weight: 600;
      display: inline-flex; align-items: center; gap: 6px;
      mat-icon { color: var(--tech-accent); font-size: 18px; width: 18px; height: 18px; }
      mat-progress-spinner { display: inline-block; }
      .sp-ai-btn-label { display: inline-flex; align-items: center; gap: 6px; }
    }
    .sp-ai-chip {
      display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin: 0;
      font-size: var(--tech-fs-label); color: var(--tech-text-secondary);
      mat-icon { color: var(--tech-accent); font-size: 16px; width: 16px; height: 16px; }
    }
    .sp-ai-note { color: var(--tech-text-tertiary); }
    .sp-macro-hint { margin: 0; color: var(--tech-text-secondary); }

    .sp-macros { display: grid; grid-template-columns: repeat(2, 1fr); gap: var(--tech-space-2); }
    .sp-macro { width: 100%; }

    .sp-sr-status {
      position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; border: 0;
      overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap;
    }
  `,
})
export class AddSupplementDialog {
  private ref = inject(MatDialogRef<AddSupplementDialog, AddSupplementResult>);
  private api = inject(Api);
  private auth = inject(AuthService);
  private snack = inject(MatSnackBar);
  readonly data = inject<AddSupplementData>(MAT_DIALOG_DATA);

  readonly kinds = KINDS;

  /** Gate: the AI affordance is hidden unless the user holds tracker.ai. */
  readonly showAi = this.auth.hasPermission(PERM.trackerAi);

  readonly name = signal<string>(this.data.presetName?.trim() ?? '');
  readonly dose = signal<string>('');
  readonly kind = signal<SupplementKind>('supplement');
  readonly calories = signal<number | null>(null);
  readonly protein = signal<number | null>(null);
  readonly carb = signal<number | null>(null);
  readonly fat = signal<number | null>(null);

  readonly canSave = computed(() => this.name().trim().length > 0);

  // ---- ✨ Estimate with AI (supplement-macros) ----
  readonly aiLoading = signal(false);
  readonly aiEstimated = signal(false);
  readonly aiNote = signal<string | null>(null);
  readonly aiAnnounce = signal('');

  readonly canEstimate = computed(() => !this.aiLoading() && this.name().trim().length > 0);

  /** Editing the name invalidates a prior AI estimate chip (the numbers may no longer match). */
  onNameChange(value: string): void {
    this.name.set(value);
    if (this.aiEstimated()) {
      this.aiEstimated.set(false);
      this.aiNote.set(null);
    }
  }

  /**
   * Ask Gemini to estimate the supplement's kind + macros, then PREFILL the editable fields. A
   * 503/unavailable leaves every field editable and steers to manual entry (a snackbar, no data lost).
   */
  async estimateWithAi(): Promise<void> {
    if (!this.canEstimate()) return;
    this.aiLoading.set(true);
    this.aiAnnounce.set('Estimating supplement macros with AI…');
    try {
      const dose = this.dose().trim();
      const res = await firstValueFrom(this.api.estimateSupplement({
        name: this.name().trim(),
        dose: dose || undefined,
      }));
      this.kind.set(res.kind);
      this.calories.set(res.calories);
      this.protein.set(res.proteinG);
      this.carb.set(res.carbsG);
      this.fat.set(res.fatG);
      this.aiNote.set(res.note ?? null);
      this.aiEstimated.set(true);
      this.aiAnnounce.set(
        `AI estimate: ${res.calories} calories, ${res.proteinG} grams protein, ` +
        `${res.carbsG} grams carbs, ${res.fatG} grams fat.` + (res.note ? ` ${res.note}` : ''));
    } catch {
      this.aiEstimated.set(false);
      this.aiNote.set(null);
      this.aiAnnounce.set('AI estimate unavailable. Enter the values manually.');
      this.snack.open('AI estimate unavailable — enter manually', 'OK', { duration: 4000 });
    } finally {
      this.aiLoading.set(false);
    }
  }

  /** A macro field as a clamped non-negative number, or undefined (omitted → server defaults to 0). */
  private macroOf(value: number | null, max: number): number | undefined {
    if (value == null || value <= 0) return undefined;
    return Math.min(Math.round(value), max);
  }

  save(): void {
    const name = this.name().trim();
    if (!name) return;
    const dose = this.dose().trim();
    this.ref.close({
      request: {
        date: this.data.date,
        name,
        dose: dose || undefined,
        kind: this.kind(),
        calories: this.macroOf(this.calories(), 5000),
        protein: this.macroOf(this.protein(), 500),
        carb: this.macroOf(this.carb(), 500),
        fat: this.macroOf(this.fat(), 500),
      },
    });
  }

  cancel(): void {
    this.ref.close();
  }
}
