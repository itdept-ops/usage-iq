import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';

/** Small name-input dialog for saving the current dashboard filters as a named view. */
@Component({
  selector: 'app-save-view-dialog',
  imports: [FormsModule, MatDialogModule, MatFormFieldModule, MatInputModule, MatButtonModule],
  template: `
    <h2 mat-dialog-title class="sv__title">Save current filters</h2>
    <mat-dialog-content class="sv__body">
      <mat-form-field appearance="outline" class="sv__field">
        <mat-label>View name</mat-label>
        <input matInput [ngModel]="name()" (ngModelChange)="name.set($event)"
               (keydown.enter)="save()" placeholder="e.g. Last 30 days — Claude" cdkFocusInitial />
      </mat-form-field>
    </mat-dialog-content>
    <mat-dialog-actions align="end" class="sv__actions">
      <button mat-stroked-button type="button" (click)="ref.close()">Cancel</button>
      <button mat-flat-button type="button" color="primary" [disabled]="!name().trim()" (click)="save()">Save view</button>
    </mat-dialog-actions>
  `,
  styles: `
    .sv__title { font-family: var(--tech-font-ui); font-weight: 700; color: var(--tech-text); }
    .sv__body { min-width: min(360px, 80vw); color: var(--tech-text-secondary); }
    .sv__field { width: 100%; }
    .sv__actions { padding: var(--tech-space-3, 12px) var(--tech-space-4, 16px); gap: 8px;
      button { border-radius: var(--tech-r-control); font-weight: 600; min-height: 42px; } }
  `,
})
export class SaveViewDialog {
  readonly ref = inject(MatDialogRef<SaveViewDialog, string>);
  readonly name = signal('');

  save(): void {
    const name = this.name().trim();
    if (name) this.ref.close(name);
  }
}
