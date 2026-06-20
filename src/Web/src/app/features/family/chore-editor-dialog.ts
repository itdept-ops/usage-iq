import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';

import { FamilyChore, FamilyChoreRecurrence, HouseholdMember } from '../../core/models';

/** Sentinel for the "Anyone" (unassigned) option in the assignee select. */
export const UNASSIGNED = 0;

/** Data passed into the chore editor: the chore being edited (null = create) + the assignee pool. */
export interface ChoreEditorData {
  chore: FamilyChore | null;
  members: HouseholdMember[];
}

/** The result the editor returns. `assignedToUserId` is null when "Anyone" (unassigned) is chosen. */
export interface ChoreEditorResult {
  title: string;
  assignedToUserId: number | null;
  points: number;
  recurrence: FamilyChoreRecurrence;
}

/** Recurrence choices (chores repeat none/daily/weekly — no "weekdays"). */
const RECURRENCES: { value: FamilyChoreRecurrence; label: string }[] = [
  { value: 'none', label: 'One-time' },
  { value: 'daily', label: 'Every day' },
  { value: 'weekly', label: 'Every week' },
];

/** Quick star presets for the points stepper. */
const POINT_PRESETS = [1, 2, 3, 5, 10];

/**
 * Create / edit a household chore. A chore has a title, an optional assignee (a household member by userId,
 * or "Anyone" when unassigned), a star value (points earned each completion), and a recurrence. The assignee
 * is rendered by name + avatar only — never an email (email-privacy).
 */
@Component({
  selector: 'app-chore-editor-dialog',
  imports: [
    FormsModule, MatDialogModule, MatButtonModule, MatIconModule,
    MatFormFieldModule, MatInputModule, MatSelectModule,
  ],
  templateUrl: './chore-editor-dialog.html',
})
export class ChoreEditorDialog {
  readonly ref = inject(MatDialogRef<ChoreEditorDialog, ChoreEditorResult>);
  readonly data = inject<ChoreEditorData>(MAT_DIALOG_DATA);

  readonly recurrences = RECURRENCES;
  readonly pointPresets = POINT_PRESETS;
  readonly unassigned = UNASSIGNED;
  readonly isEdit = !!this.data.chore;

  readonly title = signal(this.data.chore?.title ?? '');
  /** Bound to the assignee select; UNASSIGNED (0) represents "Anyone". */
  readonly assignee = signal<number>(this.data.chore?.assignedToUserId ?? UNASSIGNED);
  readonly points = signal<number>(this.data.chore?.points ?? 1);
  readonly recurrence = signal<FamilyChoreRecurrence>(this.data.chore?.recurrence ?? 'none');

  readonly canSave = computed(() => this.title().trim().length > 0);

  initials(name: string): string {
    const parts = (name || '').split(/\s+/).filter(Boolean);
    return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
  }

  setPoints(p: number): void {
    this.points.set(this.clampPoints(p));
  }

  /** Nudge the points stepper by ±1 (kept in 0..1000, matching the server). */
  stepPoints(delta: number): void {
    this.points.set(this.clampPoints(this.points() + delta));
  }

  private clampPoints(p: number): number {
    if (!Number.isFinite(p)) return 1;
    return Math.min(1000, Math.max(0, Math.round(p)));
  }

  save(): void {
    if (!this.canSave()) return;
    const assignee = this.assignee();
    this.ref.close({
      title: this.title().trim(),
      assignedToUserId: assignee === UNASSIGNED ? null : assignee,
      points: this.clampPoints(this.points()),
      recurrence: this.recurrence(),
    });
  }
}
