import { Component, computed, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';

import { NewApplicationRequest } from '../../core/models';

/**
 * "New application" dialog: collects the target job (title, company, and the pasted job description). On
 * confirm it resolves with a {@link NewApplicationRequest}; the page does the actual AI tailor + cover-letter
 * call so it can own the progress/spinner state. The job description is required (the AI tailors to it).
 */
@Component({
  selector: 'app-new-application-dialog',
  imports: [
    FormsModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    MatIconModule,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 mat-dialog-title class="na-title">
      <mat-icon aria-hidden="true">work</mat-icon> Tailor for a job
    </h2>
    <mat-dialog-content class="na-body">
      <p class="na-lead">
        Paste the job description and the assistant will tailor a copy of your resume and draft a matching
        cover letter. Your master resume is never changed.
      </p>

      <div class="na-row">
        <mat-form-field appearance="outline" class="na-field">
          <mat-label>Job title</mat-label>
          <input matInput cdkFocusInitial [ngModel]="jobTitle()" (ngModelChange)="jobTitle.set($event)"
                 name="jobTitle" placeholder="e.g. Senior Software Engineer" />
        </mat-form-field>
        <mat-form-field appearance="outline" class="na-field">
          <mat-label>Company</mat-label>
          <input matInput [ngModel]="company()" (ngModelChange)="company.set($event)"
                 name="company" placeholder="e.g. Acme Corp" />
        </mat-form-field>
      </div>

      <mat-form-field appearance="outline" class="na-field na-field--full">
        <mat-label>Job description</mat-label>
        <textarea matInput rows="9" [ngModel]="jobDescription()"
                  (ngModelChange)="jobDescription.set($event)" name="jobDescription"
                  placeholder="Paste the full posting here…"></textarea>
        <mat-hint>Required — the assistant tailors to this text.</mat-hint>
      </mat-form-field>
    </mat-dialog-content>
    <mat-dialog-actions class="na-actions" align="end">
      <button mat-stroked-button type="button" (click)="cancel()">Cancel</button>
      <button mat-flat-button color="primary" type="button" [disabled]="!canSave()" (click)="save()">
        <mat-icon aria-hidden="true">auto_awesome</mat-icon> Create & tailor
      </button>
    </mat-dialog-actions>
  `,
  styles: `
    .na-title {
      display: flex; align-items: center; gap: 8px;
      font-family: var(--tech-font-ui); font-weight: 700; color: var(--tech-text);
      mat-icon { color: var(--tech-accent); }
    }
    .na-body {
      display: flex; flex-direction: column; gap: 4px;
      min-width: min(560px, 86vw); padding-top: 4px !important;
    }
    .na-lead { margin: 0 0 8px; font-size: 13px; color: var(--tech-text-secondary); }
    .na-row { display: flex; gap: 12px; flex-wrap: wrap; }
    .na-field { flex: 1 1 200px; }
    .na-field--full { width: 100%; }
    .na-actions {
      padding: var(--tech-space-3, 12px) var(--tech-space-4, 16px); gap: 8px;
      button { border-radius: var(--tech-r-control); font-weight: 600; min-height: 44px; }
    }
    @media (max-width: 520px) { .na-row { flex-direction: column; } }
  `,
})
export class NewApplicationDialog {
  private ref = inject(MatDialogRef<NewApplicationDialog, NewApplicationRequest>);

  readonly jobTitle = signal('');
  readonly company = signal('');
  readonly jobDescription = signal('');

  readonly canSave = computed(() => this.jobDescription().trim().length > 0);

  save(): void {
    if (!this.canSave()) return;
    this.ref.close({
      jobTitle: this.jobTitle().trim(),
      company: this.company().trim(),
      jobDescription: this.jobDescription().trim(),
    });
  }

  cancel(): void {
    this.ref.close();
  }
}
