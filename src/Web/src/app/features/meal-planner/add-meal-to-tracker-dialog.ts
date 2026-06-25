import { Component, computed, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';

import { FamilyMeal, HouseholdMember } from '../../core/models';

/**
 * What the caller passes in: the planned meal to log + the household members for the "whose tracker?" picker.
 * `members` should already include a self row (`isSelf: true`); the dialog falls back to a Me-only list when
 * the list is empty (solo caller / no household). Identity is display name only — never an email.
 */
export interface AddMealToTrackerData {
  meal: FamilyMeal;
  members: HouseholdMember[];
}

/**
 * What the dialog resolves with on Add: the chosen servings, the chosen target's display name (for the
 * caller's success snackbar), and the `targetUserId` (undefined when logging onto the caller's own tracker).
 * Resolves `undefined` when cancelled.
 */
export interface AddMealToTrackerResult {
  servings: number;
  targetUserId?: number;
  targetName: string;
}

/** The default servings to log (one portion), mirroring the backend's historical "log ONE serving". */
const DEFAULT_SERVINGS = 1;
/** Clamp bounds for the servings input — must match the backend clamp (0.1..99). */
const MIN_SERVINGS = 0.1;
const MAX_SERVINGS = 99;

/**
 * "Add to tracker" dialog — opened from a single planned meal card (gated tracker.self on the page). The user
 * picks how many SERVINGS to log (default 1, min 0.1, max 99) and WHOSE tracker to log onto (themselves or a
 * household co-member, by display name), with a LIVE macro preview = the meal's per-serving macros × servings,
 * rounded exactly as the server rounds (calories to int, P/C/F to 0.1) so the preview matches what gets logged.
 * On Add the dialog resolves with `{ servings, targetUserId, targetName }`; the caller performs the API write
 * (so the page keeps its `loggingMealId` busy-lock + snackbar). Mirrors the tracker dialog conventions
 * (tracker-dialog panel, the refine-meal-dialog header/macro look, the family member-picker row).
 */
@Component({
  selector: 'app-add-meal-to-tracker-dialog',
  imports: [
    DecimalPipe,
    FormsModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatButtonModule,
    MatIconModule,
  ],
  templateUrl: './add-meal-to-tracker-dialog.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './add-meal-to-tracker-dialog.scss',
})
export class AddMealToTrackerDialog {
  private ref = inject(MatDialogRef<AddMealToTrackerDialog, AddMealToTrackerResult>);
  readonly data = inject<AddMealToTrackerData>(MAT_DIALOG_DATA);

  /** The meal being logged (its per-serving macros drive the live preview). */
  readonly meal = this.data.meal;

  /**
   * The "whose tracker?" options: the self row first (so Me is the default), then the other members by name.
   * Falls back to a single synthetic Me row when no household members were supplied (solo caller).
   */
  readonly members: HouseholdMember[] = this.orderedMembers();

  /** The chosen target's userId (the self row's id, or -1 for the synthetic Me fallback). */
  readonly targetUserId = signal<number>(this.members[0]?.userId ?? -1);

  /** The servings to log, bound to the number input (clamped to [0.1, 99] on Add). */
  readonly servings = signal<number>(DEFAULT_SERVINGS);

  readonly minServings = MIN_SERVINGS;
  readonly maxServings = MAX_SERVINGS;

  /** The clamped, finite servings used for both the live preview and the resolved result. */
  private readonly safeServings = computed(() => {
    const s = this.servings();
    if (!Number.isFinite(s) || s <= 0) return DEFAULT_SERVINGS;
    return Math.min(Math.max(s, MIN_SERVINGS), MAX_SERVINGS);
  });

  /** Add is disabled until the meal has macros (the page already gates this, but belt-and-suspenders). */
  readonly canAdd = computed(() => this.meal.macroSource !== 'none');

  /**
   * Live macro preview = per-serving × servings, rounded the SAME way the server rounds the logged portion:
   * calories to an integer (away-from-zero), P/C/F to one decimal, floored at 0. So the preview is exactly
   * what lands on the tracker.
   */
  readonly preview = computed(() => {
    const s = this.safeServings();
    const p = this.meal.perServing;
    return {
      calories: Math.max(0, Math.round(p.calories * s)),
      proteinG: this.round1(p.proteinG * s),
      carbG: this.round1(p.carbG * s),
      fatG: this.round1(p.fatG * s),
    };
  });

  /** The selected member's row (drives the success-snackbar name + the self-vs-co-member target id). */
  private readonly target = computed(
    () => this.members.find((m) => m.userId === this.targetUserId()) ?? this.members[0],
  );

  add(): void {
    if (!this.canAdd()) return;
    const t = this.target();
    // Self (or the synthetic Me fallback) → omit targetUserId so the server keeps the byte-for-byte self path.
    const targetUserId = t && !t.isSelf ? t.userId : undefined;
    this.ref.close({
      servings: this.safeServings(),
      targetUserId,
      targetName: t?.isSelf ? 'your' : `${t?.name}'s`,
    });
  }

  close(): void {
    this.ref.close(undefined);
  }

  initials(name: string): string {
    const parts = (name || '').split(/\s+/).filter(Boolean);
    return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
  }

  private round1(n: number): number {
    return Math.max(0, Math.round((Number.isFinite(n) ? n : 0) * 10) / 10);
  }

  /** Self first (so it's the default), then the others; a synthetic Me row when there are no members. */
  private orderedMembers(): HouseholdMember[] {
    const list = this.data.members ?? [];
    if (list.length === 0) {
      return [{ userId: -1, name: 'Me', picture: null, role: 'self', isSelf: true }];
    }
    const self = list.filter((m) => m.isSelf);
    const others = list.filter((m) => !m.isSelf);
    return [...self, ...others];
  }
}
