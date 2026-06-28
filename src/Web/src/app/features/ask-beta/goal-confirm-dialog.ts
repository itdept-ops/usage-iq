import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';

import { ActivityLevel, TrackerGoal, TrackerProfileDto } from '../../core/models';
import { isImperial, kgToLb } from '../../core/units';

/**
 * The data the goal-confirm dialog needs: the caller's CURRENT profile (for the "before" side + the unit
 * preference) and the PROPOSED change ("Ask that Acts" goal_tweak). Any of the three proposed fields may be
 * null = unchanged. Only non-null fields are shown as a change; at least one is non-null (the caller guards).
 */
export interface GoalConfirmData {
  current: TrackerProfileDto;
  proposedGoal: TrackerGoal | null;
  proposedActivity: ActivityLevel | null;
  proposedGoalWeightKg: number | null;
}

/** The dialog result: the user confirmed the change (save) or dismissed (handled as a cancel by the caller). */
export type GoalConfirmResult = { kind: 'save' } | { kind: 'cancel' };

/** Friendly labels for the goal-direction enum. */
const GOAL_LABEL: Readonly<Record<TrackerGoal, string>> = {
  LoseWeight: 'Lose weight',
  Maintain: 'Maintain',
  GainMuscle: 'Gain muscle',
  Endurance: 'Endurance',
};

/** Friendly labels for the activity-level enum. */
const ACTIVITY_LABEL: Readonly<Record<ActivityLevel, string>> = {
  Sedentary: 'Sedentary',
  Light: 'Lightly active',
  Moderate: 'Moderately active',
  Active: 'Active',
  VeryActive: 'Very active',
};

/**
 * A small PREFILLED review dialog the "Ask that Acts" goal_tweak action opens BEFORE writing — a goal change
 * is consequential, so it is never silent. It shows the current → proposed for each field the AI suggested
 * (goal direction, activity level, target weight in the caller's own units) and writes only on "Update goal".
 * Dismissing it leaves the chip idle (the caller treats a non-save result as a cancel). It NEVER itself
 * writes — the caller PUTs the merged profile via the existing tracker-profile endpoint on confirm.
 */
@Component({
  selector: 'app-goal-confirm-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatDialogModule, MatButtonModule, MatIconModule],
  template: `
    <h2 mat-dialog-title class="gc-title">
      <mat-icon aria-hidden="true">flag</mat-icon>
      Update your goal?
    </h2>

    <mat-dialog-content class="gc-body">
      <p class="gc-lead">Review the change before it's saved to your tracker profile.</p>

      <ul class="gc-rows">
        @if (data.proposedGoal !== null) {
          <li class="gc-row">
            <span class="gc-label">Goal</span>
            <span class="gc-change">
              <span class="gc-from">{{ goalLabel(data.current.goal) }}</span>
              <mat-icon aria-hidden="true">arrow_forward</mat-icon>
              <span class="gc-to">{{ goalLabel(data.proposedGoal) }}</span>
            </span>
          </li>
        }
        @if (data.proposedActivity !== null) {
          <li class="gc-row">
            <span class="gc-label">Activity</span>
            <span class="gc-change">
              <span class="gc-from">{{ activityLabel(data.current.activityLevel) }}</span>
              <mat-icon aria-hidden="true">arrow_forward</mat-icon>
              <span class="gc-to">{{ activityLabel(data.proposedActivity) }}</span>
            </span>
          </li>
        }
        @if (data.proposedGoalWeightKg !== null) {
          <li class="gc-row">
            <span class="gc-label">Target weight</span>
            <span class="gc-change">
              @if (currentTargetDisplay()) {
                <span class="gc-from">{{ currentTargetDisplay() }}</span>
                <mat-icon aria-hidden="true">arrow_forward</mat-icon>
              }
              <span class="gc-to">{{ proposedTargetDisplay() }}</span>
            </span>
          </li>
        }
      </ul>
    </mat-dialog-content>

    <mat-dialog-actions align="end" class="gc-actions">
      <button mat-button (click)="cancel()">Cancel</button>
      <button mat-flat-button color="primary" (click)="save()">
        <mat-icon aria-hidden="true">check</mat-icon>
        Update goal
      </button>
    </mat-dialog-actions>
  `,
  styles: [`
    .gc-title { display: flex; align-items: center; gap: 8px; }
    .gc-title mat-icon { width: 22px; height: 22px; font-size: 22px; }
    .gc-lead { margin: 0 0 12px; opacity: .8; font-size: .9rem; }
    .gc-rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
    .gc-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
    .gc-label { font-weight: 600; opacity: .85; }
    .gc-change { display: inline-flex; align-items: center; gap: 8px; }
    .gc-change mat-icon { width: 18px; height: 18px; font-size: 18px; opacity: .6; }
    .gc-from { opacity: .65; }
    .gc-to { font-weight: 700; }
    .gc-actions mat-icon { width: 18px; height: 18px; font-size: 18px; }
  `],
})
export class GoalConfirmDialog {
  readonly ref = inject(MatDialogRef<GoalConfirmDialog, GoalConfirmResult>);
  readonly data = inject<GoalConfirmData>(MAT_DIALOG_DATA);

  private readonly imperial = isImperial(this.data.current.unitSystem);

  readonly currentTargetDisplay = computed(() => this.weightDisplay(this.data.current.goalWeightKg ?? null));
  readonly proposedTargetDisplay = computed(() => this.weightDisplay(this.data.proposedGoalWeightKg));

  goalLabel(goal: TrackerGoal | string): string {
    return GOAL_LABEL[goal as TrackerGoal] ?? String(goal);
  }

  activityLabel(level: ActivityLevel | string): string {
    return ACTIVITY_LABEL[level as ActivityLevel] ?? String(level);
  }

  private weightDisplay(kg: number | null): string {
    if (kg == null || kg <= 0) return '';
    if (this.imperial) return `${Math.round(kgToLb(kg))} lb`;
    return `${Math.round(kg * 10) / 10} kg`;
  }

  save(): void { this.ref.close({ kind: 'save' }); }
  cancel(): void { this.ref.close({ kind: 'cancel' }); }
}
