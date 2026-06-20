import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { catchError, firstValueFrom, of } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';

import { Api } from '../../core/api';
import {
  FamilyChore, FamilyChoreRecurrence, FamilyChores as FamilyChoresDto, FamilyChoreTally, Household,
  HouseholdMember,
} from '../../core/models';
import { FamilyConfirmDialog, ConfirmData } from './confirm-dialog';
import { ChoreEditorDialog, ChoreEditorData, ChoreEditorResult } from './chore-editor-dialog';

/** Friendly labels for the recurrence chip. */
const RECURRENCE_LABEL: Record<FamilyChoreRecurrence, string> = {
  none: 'One-time',
  daily: 'Daily',
  weekly: 'Weekly',
};

/**
 * Family Chore Board — the household's shared chores: open chores (each with an assignee avatar, a star
 * value, a check-off control, and a recurrence chip) and a done section. A "stars" strip tallies each
 * member's earned points (the kid-reward foundation). Members can add/edit a chore (title, assignee by
 * household-member userId defaulting to unassigned, points, recurrence none/daily/weekly). Checking a chore
 * stars it for the doer.
 *
 * Everyone is rendered by display name + initials avatar only; an email is never shown (email-privacy).
 */
@Component({
  selector: 'app-family-chores',
  imports: [
    RouterLink, MatIconModule, MatButtonModule, MatTooltipModule, MatProgressSpinnerModule,
    MatCheckboxModule, MatSnackBarModule,
  ],
  templateUrl: './chores.html',
  styleUrls: ['./family.scss', './chores.scss'],
})
export class FamilyChores {
  private api = inject(Api);
  private dialog = inject(MatDialog);
  private snack = inject(MatSnackBar);

  readonly chores = signal<FamilyChore[]>([]);
  readonly tally = signal<FamilyChoreTally[]>([]);
  readonly members = signal<HouseholdMember[]>([]);
  readonly loading = signal(true);
  readonly error = signal(false);
  /** The chore whose check-off is in flight (locks its checkbox briefly). */
  readonly busyId = signal<number | null>(null);

  /** Open chores (server already orders open-first; we split by `done`). */
  readonly open = computed(() => this.chores().filter(c => !c.done));
  readonly done = computed(() => this.chores().filter(c => c.done));

  /** Total stars earned across the household (the strip's headline figure). */
  readonly totalStars = computed(() => this.tally().reduce((n, t) => n + t.points, 0));

  /** The top earner's points (for a subtle leader emphasis on the strip). */
  private readonly topPoints = computed(() => this.tally().reduce((m, t) => Math.max(m, t.points), 0));

  constructor() {
    this.reload(true);
    // Household members drive the assignee picker (display identity only).
    this.api.getHousehold()
      .pipe(catchError(() => of<Household | null>(null)), takeUntilDestroyed())
      .subscribe(h => { if (h) this.members.set(h.members); });
  }

  private reload(initial = false): void {
    if (initial) this.loading.set(true);
    this.api.familyChores()
      .pipe(catchError(() => { if (initial) this.error.set(true); return of<FamilyChoresDto | null>(null); }),
        takeUntilDestroyed())
      .subscribe(board => {
        if (board) { this.chores.set(board.chores); this.tally.set(board.tally); }
        this.loading.set(false);
      });
  }

  private apply(board: FamilyChoresDto): void {
    this.chores.set(board.chores);
    this.tally.set(board.tally);
  }

  recurrenceLabel(r: FamilyChoreRecurrence): string {
    return RECURRENCE_LABEL[r] ?? 'One-time';
  }

  /** True for the household's top star-earner (≥1 star) — a gentle "leader" emphasis on the strip. */
  isLeader(entry: FamilyChoreTally): boolean {
    return entry.points > 0 && entry.points === this.topPoints();
  }

  initials(name: string): string {
    const parts = (name || '').split(/\s+/).filter(Boolean);
    return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
  }

  /** A small array (1..5) to render the star pips on a chore card. */
  starPips(points: number): number[] {
    return Array.from({ length: Math.min(5, Math.max(1, points)) }, (_, i) => i);
  }

  // ---- Check off ----

  /** Toggle a chore done/not-done. Checking it stars the caller in the ledger (server-side). */
  async toggle(chore: FamilyChore): Promise<void> {
    if (this.busyId() != null) return;
    this.busyId.set(chore.id);
    const checking = !chore.done;
    try {
      const board = await firstValueFrom(this.api.patchFamilyChore(chore.id, { done: checking }));
      this.apply(board);
      if (checking && chore.points > 0) {
        const star = chore.points === 1 ? 'star' : 'stars';
        this.snack.open(`Nice! ${chore.points} ${star} earned ⭐`, undefined, { duration: 2200 });
      }
    } catch (e) {
      this.snack.open(this.messageOf(e, "Couldn't update that chore."), 'OK', { duration: 4000 });
    } finally {
      this.busyId.set(null);
    }
  }

  // ---- Add / edit / delete ----

  async create(): Promise<void> {
    const result = await this.openEditor(null);
    if (!result) return;
    try {
      const board = await firstValueFrom(this.api.createFamilyChore({
        title: result.title, assignedToUserId: result.assignedToUserId,
        points: result.points, recurrence: result.recurrence,
      }));
      this.apply(board);
    } catch (e) {
      this.snack.open(this.messageOf(e, "Couldn't save that chore. Please try again."), 'OK', { duration: 4000 });
    }
  }

  async edit(chore: FamilyChore): Promise<void> {
    const result = await this.openEditor(chore);
    if (!result) return;
    try {
      const board = await firstValueFrom(this.api.patchFamilyChore(chore.id, {
        title: result.title, assignedToUserId: result.assignedToUserId,
        points: result.points, recurrence: result.recurrence,
      }));
      this.apply(board);
    } catch (e) {
      this.snack.open(this.messageOf(e, "Couldn't save that chore. Please try again."), 'OK', { duration: 4000 });
    }
  }

  async remove(chore: FamilyChore): Promise<void> {
    const ok = await this.confirm({
      title: 'Delete this chore?',
      message: `“${chore.title}” will be removed from the board. Stars already earned are kept.`,
      destructive: true,
    });
    if (!ok) return;
    try {
      await firstValueFrom(this.api.deleteFamilyChore(chore.id));
      this.reload();
    } catch {
      this.snack.open("Couldn't delete that chore.", 'OK', { duration: 4000 });
    }
  }

  private openEditor(chore: FamilyChore | null): Promise<ChoreEditorResult | undefined> {
    const ref = this.dialog.open<ChoreEditorDialog, ChoreEditorData, ChoreEditorResult>(ChoreEditorDialog, {
      data: { chore, members: this.members() }, width: '460px', maxWidth: '94vw', autoFocus: false,
    });
    return firstValueFrom(ref.afterClosed());
  }

  private confirm(data: ConfirmData): Promise<boolean | undefined> {
    const ref = this.dialog.open<FamilyConfirmDialog, ConfirmData, boolean>(FamilyConfirmDialog, {
      data, width: '420px', maxWidth: '92vw',
    });
    return firstValueFrom(ref.afterClosed());
  }

  private messageOf(e: unknown, fallback: string): string {
    const msg = (e as { error?: { message?: string } })?.error?.message;
    return typeof msg === 'string' && msg ? msg : fallback;
  }
}
