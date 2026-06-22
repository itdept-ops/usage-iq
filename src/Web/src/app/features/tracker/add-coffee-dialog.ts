import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';

import { AddCoffeeRequest } from '../../core/models';

/** Opens with the active date. */
export interface AddCoffeeData {
  date: string;
}

/** What the dialog resolves with so the page can refresh + announce: the coffee request(s) to POST. */
export interface AddCoffeeResult {
  requests: AddCoffeeRequest[];
}

/**
 * Quick "add a custom coffee" dialog — the slimmed, classic single-entry twin of the (AI-enabled)
 * add-hydration dialog, with the AI blocks dropped. Enters a number of cups plus an optional drink
 * label and optional caffeine (mg). Resolves with an {@link AddCoffeeResult} for the page to log.
 */
@Component({
  selector: 'app-add-coffee-dialog',
  imports: [
    FormsModule, MatDialogModule, MatFormFieldModule, MatInputModule, MatButtonModule,
  ],
  template: `
    <h2 mat-dialog-title class="cf-title">Add coffee</h2>
    <mat-dialog-content class="cf-body">
      <mat-form-field appearance="outline" class="cf-field">
        <mat-label>Cups</mat-label>
        <input matInput type="number" min="1" max="20" step="1" inputmode="numeric" cdkFocusInitial
               [ngModel]="cups()" (ngModelChange)="cups.set($event)" />
        <mat-hint>Logged for {{ data.date }}.</mat-hint>
      </mat-form-field>

      <mat-form-field appearance="outline" class="cf-field">
        <mat-label>Drink (optional)</mat-label>
        <input matInput type="text" maxlength="64" placeholder="Mug, Espresso, Cold Brew…"
               [ngModel]="label()" (ngModelChange)="label.set($event)" />
      </mat-form-field>

      <mat-form-field appearance="outline" class="cf-field">
        <mat-label>Caffeine (optional)</mat-label>
        <input matInput type="number" min="0" max="2000" step="1" inputmode="numeric"
               [ngModel]="caffeineMg()" (ngModelChange)="caffeineMg.set($event)" />
        <span matTextSuffix>mg</span>
      </mat-form-field>
    </mat-dialog-content>
    <mat-dialog-actions class="cf-actions" align="end">
      <button mat-stroked-button type="button" (click)="cancel()">Cancel</button>
      <button mat-flat-button type="button" color="primary" [disabled]="!canSave()" (click)="save()">Add</button>
    </mat-dialog-actions>
  `,
  styles: `
    .cf-title { font-family: var(--tech-font-ui); font-weight: 700; color: var(--tech-text); }
    .cf-body { min-width: min(360px, 82vw); padding-top: 4px !important;
      display: flex; flex-direction: column; gap: var(--tech-space-2); }
    .cf-field { width: 100%; }
    .cf-actions { padding: var(--tech-space-3) var(--tech-space-4); gap: 8px;
      button { border-radius: var(--tech-r-control); font-weight: 600; min-height: 44px; } }
  `,
})
export class AddCoffeeDialog {
  private ref = inject(MatDialogRef<AddCoffeeDialog, AddCoffeeResult>);
  readonly data = inject<AddCoffeeData>(MAT_DIALOG_DATA);

  readonly cups = signal<number | null>(1);
  readonly label = signal<string>('');
  readonly caffeineMg = signal<number | null>(null);

  /** Cups clamped to the server's 1..20 range, else null. */
  private readonly validCups = computed<number | null>(() => {
    const c = this.cups();
    if (c == null) return null;
    const n = Math.round(c);
    return n >= 1 && n <= 20 ? n : null;
  });

  readonly canSave = computed(() => this.validCups() != null);

  /** Optional caffeine (mg) — a non-negative integer, else undefined (omitted). */
  private caffeineOf(): number | undefined {
    const mg = this.caffeineMg();
    if (mg == null || mg <= 0) return undefined;
    return Math.round(mg);
  }

  save(): void {
    const cups = this.validCups();
    if (cups == null) return;
    const label = this.label().trim();
    this.ref.close({
      requests: [{
        date: this.data.date,
        cups,
        caffeineMg: this.caffeineOf(),
        label: label || undefined,
      }],
    });
  }

  cancel(): void {
    this.ref.close();
  }
}
