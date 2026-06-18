import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatIconModule } from '@angular/material/icon';

import { TrackerGoal, TrackerProfileDto } from '../../core/models';

/** Opens with the current profile (or sensible defaults for a first-time user). */
export interface ProfileData {
  profile: TrackerProfileDto;
}

const GOALS: { value: TrackerGoal; label: string }[] = [
  { value: 'LoseWeight', label: 'Lose weight' },
  { value: 'Maintain', label: 'Maintain' },
  { value: 'GainMuscle', label: 'Gain muscle' },
  { value: 'Endurance', label: 'Endurance' },
];

/**
 * Profile / goal dialog. Sets the training goal, body weight (drives the exercise calorie estimate),
 * an optional daily calorie goal + optional macro targets, and the "share my tracker with my contacts"
 * toggle. Resolves with the {@link TrackerProfileDto} for the page to persist via the store.
 */
@Component({
  selector: 'app-tracker-profile-dialog',
  imports: [
    FormsModule, MatDialogModule, MatFormFieldModule, MatInputModule, MatSelectModule,
    MatButtonModule, MatCheckboxModule, MatIconModule,
  ],
  templateUrl: './profile-dialog.html',
  styleUrl: './profile-dialog.scss',
})
export class ProfileDialog {
  private ref = inject(MatDialogRef<ProfileDialog, TrackerProfileDto>);
  readonly data = inject<ProfileData>(MAT_DIALOG_DATA);

  readonly goals = GOALS;

  readonly goal = signal<string>(this.data.profile.goal || 'Maintain');
  readonly weightKg = signal<number | null>(this.data.profile.weightKg ?? null);
  readonly dailyCalorieGoal = signal<number | null>(this.data.profile.dailyCalorieGoal ?? null);
  readonly proteinGoalG = signal<number | null>(this.data.profile.proteinGoalG ?? null);
  readonly carbGoalG = signal<number | null>(this.data.profile.carbGoalG ?? null);
  readonly fatGoalG = signal<number | null>(this.data.profile.fatGoalG ?? null);
  readonly shareWithContacts = signal<boolean>(this.data.profile.shareWithContacts ?? false);

  private num(v: number | null): number | undefined {
    return v != null && v >= 0 ? v : undefined;
  }

  save(): void {
    const body: TrackerProfileDto = {
      goal: this.goal(),
      weightKg: this.num(this.weightKg()),
      dailyCalorieGoal: this.num(this.dailyCalorieGoal()),
      proteinGoalG: this.num(this.proteinGoalG()),
      carbGoalG: this.num(this.carbGoalG()),
      fatGoalG: this.num(this.fatGoalG()),
      shareWithContacts: this.shareWithContacts(),
    };
    this.ref.close(body);
  }

  cancel(): void {
    this.ref.close();
  }
}
