import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { catchError, firstValueFrom, of } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';

import { Api } from '../../core/api';
import {
  ChoreSummaryAiResult, FamilyChore, FamilyChoreRecurrence, FamilyChores as FamilyChoresDto,
  FamilyChoreTally, Household, HouseholdMember,
} from '../../core/models';
import { FamilyConfirmDialog, ConfirmData } from './confirm-dialog';
import { ChoreEditorDialog, ChoreEditorData, ChoreEditorResult } from './chore-editor-dialog';

/** Friendly labels for the recurrence chip. */
const RECURRENCE_LABEL: Record<FamilyChoreRecurrence, string> = {
  none: 'One-time',
  daily: 'Daily',
  weekly: 'Weekly',
};

/** The recurrence options offered in the suggest-review per-row picker. */
const RECURRENCE_OPTIONS: FamilyChoreRecurrence[] = ['none', 'daily', 'weekly'];

/** Which ✨ assist sheet is open (only one at a time), or none. */
type AiPanel = 'suggest' | 'balance' | 'values' | null;

/** One editable "✨ Suggest chores" review row (the AI list has no ids; `key` tracks the row). */
interface SuggestRow {
  key: number;
  title: string;
  points: number;
  recurrence: FamilyChoreRecurrence;
  ageHint?: string | null;
}

/** One "✨ Balance" review row: a chore + its proposed assignee, with a per-row accept toggle. */
interface BalanceRow {
  choreId: number;
  title: string;
  assignedToUserId: number;
  assignedToName: string;
  /** The chore's current assignee name (so the row can show "Leo → Mia"); null when unassigned. */
  currentName: string | null;
  /** True once the user has chosen to apply this row (defaults true; "skip" clears it). */
  accept: boolean;
}

/** One "✨ Suggest stars" review row: a chore + its proposed points, with a per-row accept toggle. */
interface ValueRow {
  choreId: number;
  title: string;
  current: number;
  points: number;
  accept: boolean;
}

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
    FormsModule, RouterLink, MatIconModule, MatButtonModule, MatTooltipModule, MatProgressSpinnerModule,
    MatCheckboxModule, MatFormFieldModule, MatInputModule, MatSnackBarModule,
  ],
  templateUrl: './chores.html',
  styleUrls: ['./family.scss', './chores.scss'],
})
export class FamilyChores {
  private api = inject(Api);
  private dialog = inject(MatDialog);
  private snack = inject(MatSnackBar);
  private destroyRef = inject(DestroyRef);

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

  // ---- ✨ AI assists (suggest / balance / values) — each reviews then applies via the existing writes ----

  /** Which assist sheet is open (only one at a time). */
  readonly aiPanel = signal<AiPanel>(null);
  /** True while a suggest/balance/values request is in flight. */
  readonly aiBusy = signal(false);
  /** A friendly aria-live status line for the open sheet (a hint, an error, or progress). */
  readonly aiStatus = signal('');
  /** True while an "apply" fan-out (create or patch per row) is running. */
  readonly aiApplying = signal(false);

  // Suggest: the kids' ages (prefilled 8 + 5, editable) + the editable review rows.
  readonly suggestAges = signal('8, 5');
  readonly suggestRows = signal<SuggestRow[]>([]);
  private suggestKey = 0;
  /** Recurrence options for the per-row picker. */
  readonly recurrenceOptions = RECURRENCE_OPTIONS;

  // Balance + values review rows (each row carries a per-row accept toggle).
  readonly balanceRows = signal<BalanceRow[]>([]);
  readonly valueRows = signal<ValueRow[]>([]);

  // ---- "Good job" weekly summary card (read-only; never 503 — a plain floor is guaranteed) ----
  readonly summary = signal<ChoreSummaryAiResult | null>(null);

  constructor() {
    this.reload(true);
    this.loadSummary();
    // Household members drive the assignee picker (display identity only).
    this.api.getHousehold()
      .pipe(catchError(() => of<Household | null>(null)), takeUntilDestroyed())
      .subscribe(h => { if (h) this.members.set(h.members); });
  }

  /**
   * Load the warm "Good job" weekly summary. It NEVER 503s server-side (a deterministic plain floor with
   * fellBackToPlain=true is the guarantee), so a network blip is the only failure — leave the card hidden then.
   */
  private loadSummary(): void {
    this.api.choreSummaryAi()
      .pipe(catchError(() => of<ChoreSummaryAiResult | null>(null)), takeUntilDestroyed(this.destroyRef))
      .subscribe(s => this.summary.set(s));
  }

  private reload(initial = false): void {
    if (initial) this.loading.set(true);
    this.api.familyChores()
      .pipe(catchError(() => { if (initial) this.error.set(true); return of<FamilyChoresDto | null>(null); }),
        takeUntilDestroyed(this.destroyRef))
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

  // =====================================================================================
  // ✨ AI assists — suggest / balance / values. Each is a separate, explicit apply: nothing
  // changes until the user confirms, and every apply is partial-failure aware.
  // =====================================================================================

  /** Open a given assist sheet (toggles closed if already open). Switching sheets clears the prior review. */
  togglePanel(panel: Exclude<AiPanel, null>): void {
    if (this.aiBusy() || this.aiApplying()) return;
    if (this.aiPanel() === panel) { this.aiPanel.set(null); return; }
    this.aiPanel.set(panel);
    this.aiStatus.set('');
    // Don't carry one sheet's staged rows into another.
    this.suggestRows.set([]);
    this.balanceRows.set([]);
    this.valueRows.set([]);
  }

  // ---- ✨ Suggest chores (ages → editable review list → "Add chores" fans out POST /chores) ----

  /** Ask Gemini for age-appropriate chore ideas and stage them as EDITABLE review rows (creates nothing). */
  async suggest(): Promise<void> {
    if (this.aiBusy()) return;
    this.aiBusy.set(true);
    this.aiStatus.set('Thinking up some chores…');
    this.suggestRows.set([]);
    try {
      const result = await firstValueFrom(this.api.suggestChoresAi({ ages: this.parseAges() }));
      const rows = (result.suggestions ?? []).map(s => ({
        key: ++this.suggestKey,
        title: s.title,
        points: s.points,
        recurrence: s.recurrence,
        ageHint: s.ageHint,
      }));
      this.suggestRows.set(rows);
      this.aiStatus.set(rows.length === 0
        ? "I couldn't think of new chores just now. Please try again."
        : `Review ${rows.length === 1 ? 'this chore' : `these ${rows.length} chores`}, tweak anything, then add them.`);
    } catch (e) {
      this.aiStatus.set(this.aiError(e, "I couldn't reach the AI just now. Please try again, or add chores manually."));
    } finally {
      this.aiBusy.set(false);
    }
  }

  /** Re-run "Suggest chores" with the same ages (replaces the staged rows). */
  regenerateSuggest(): void {
    void this.suggest();
  }

  /** Parse the editable "8, 5" ages field into a clamped int list (drops blanks / out-of-range). */
  private parseAges(): number[] {
    return this.suggestAges()
      .split(/[,\s]+/)
      .map(s => parseInt(s, 10))
      .filter(n => Number.isFinite(n) && n >= 0 && n <= 120);
  }

  setSuggestTitle(row: SuggestRow, title: string): void {
    this.suggestRows.set(this.suggestRows().map(r => r.key === row.key ? { ...r, title } : r));
  }
  setSuggestPoints(row: SuggestRow, points: number): void {
    const p = Math.max(0, Math.min(1000, Math.round(points || 0)));
    this.suggestRows.set(this.suggestRows().map(r => r.key === row.key ? { ...r, points: p } : r));
  }
  setSuggestRecurrence(row: SuggestRow, recurrence: FamilyChoreRecurrence): void {
    this.suggestRows.set(this.suggestRows().map(r => r.key === row.key ? { ...r, recurrence } : r));
  }
  removeSuggestRow(row: SuggestRow): void {
    this.suggestRows.set(this.suggestRows().filter(r => r.key !== row.key));
  }
  clearSuggest(): void {
    this.suggestRows.set([]);
    this.aiStatus.set('');
  }

  /**
   * "Add chores" — fan out a POST /chores per staged row. Partial-failure aware: a row that saves drops off;
   * rows that fail (or are blank) stay so the user can retry. The last successful response refreshes the board.
   */
  async addSuggested(): Promise<void> {
    const rows = this.suggestRows();
    if (this.aiApplying() || rows.length === 0) return;
    this.aiApplying.set(true);
    this.aiStatus.set('Adding your chores…');

    let added = 0;
    let lastBoard: FamilyChoresDto | null = null;
    const failed: SuggestRow[] = [];
    for (const row of rows) {
      const title = row.title.trim();
      if (!title) { failed.push(row); continue; }
      try {
        lastBoard = await firstValueFrom(this.api.createFamilyChore({
          title, points: row.points, recurrence: row.recurrence,
        }));
        added++;
      } catch {
        failed.push(row);
      }
    }

    this.suggestRows.set(failed);
    this.aiApplying.set(false);
    if (lastBoard) this.apply(lastBoard);
    this.finishApply(added, failed.length, 'chore', 'added');
  }

  // ---- ✨ Balance (propose an assignee per chore → accept/skip per row → "Apply" PATCHes each) ----

  /** Ask Gemini to fairly assign the household's chores and stage them as accept/skip review rows. */
  async balance(): Promise<void> {
    if (this.aiBusy()) return;
    this.aiBusy.set(true);
    this.aiStatus.set('Balancing the load…');
    this.balanceRows.set([]);
    try {
      const result = await firstValueFrom(this.api.balanceChoresAi());
      const byId = new Map(this.chores().map(c => [c.id, c]));
      const rows: BalanceRow[] = (result.assignments ?? []).map(a => {
        const chore = byId.get(a.choreId);
        return {
          choreId: a.choreId,
          title: chore?.title ?? 'Chore',
          assignedToUserId: a.assignedToUserId,
          assignedToName: a.assignedToName,
          currentName: chore?.assignedToName ?? null,
          accept: true,
        };
      // Only show rows where the assignee actually changes (no-op proposals add nothing).
      }).filter(r => byId.get(r.choreId)?.assignedToUserId !== r.assignedToUserId);
      this.balanceRows.set(rows);
      this.aiStatus.set(rows.length === 0
        ? 'Looks balanced already — no changes to suggest.'
        : `Review ${rows.length === 1 ? 'this assignment' : `these ${rows.length} assignments`}, then apply the ones you like.`);
    } catch (e) {
      this.aiStatus.set(this.aiError(e, "I couldn't reach the AI just now. Please try again, or assign chores manually."));
    } finally {
      this.aiBusy.set(false);
    }
  }

  toggleBalanceRow(row: BalanceRow): void {
    this.balanceRows.set(this.balanceRows().map(r => r.choreId === row.choreId ? { ...r, accept: !r.accept } : r));
  }
  clearBalance(): void {
    this.balanceRows.set([]);
    this.aiStatus.set('');
  }
  /** Count of accepted balance rows (drives the Apply button's label/disabled state). */
  readonly balanceAcceptedCount = computed(() => this.balanceRows().filter(r => r.accept).length);

  /** "Apply" — PATCH each accepted assignment. Partial-failure aware (failed rows stay, accepted). */
  async applyBalance(): Promise<void> {
    const rows = this.balanceRows().filter(r => r.accept);
    if (this.aiApplying() || rows.length === 0) return;
    this.aiApplying.set(true);
    this.aiStatus.set('Applying assignments…');

    let applied = 0;
    let lastBoard: FamilyChoresDto | null = null;
    const failed: BalanceRow[] = [];
    for (const row of rows) {
      try {
        lastBoard = await firstValueFrom(this.api.patchFamilyChore(row.choreId, {
          assignedToUserId: row.assignedToUserId,
        }));
        applied++;
      } catch {
        failed.push(row);
      }
    }

    // Keep the skipped rows (accept=false) plus any that failed, so the user can retry the failures.
    const skipped = this.balanceRows().filter(r => !r.accept);
    this.balanceRows.set([...failed, ...skipped]);
    this.aiApplying.set(false);
    if (lastBoard) this.apply(lastBoard);
    this.finishApply(applied, failed.length, 'assignment', 'applied');
  }

  // ---- ✨ Suggest stars (propose a points value per chore → accept/skip → "Apply" PATCHes each) ----

  /** Ask Gemini for fair point values and stage them as accept/skip review rows. */
  async suggestValues(): Promise<void> {
    if (this.aiBusy()) return;
    this.aiBusy.set(true);
    this.aiStatus.set('Weighing up the chores…');
    this.valueRows.set([]);
    try {
      const result = await firstValueFrom(this.api.suggestChoreValuesAi());
      const byId = new Map(this.chores().map(c => [c.id, c]));
      const rows: ValueRow[] = (result.values ?? []).map(v => ({
        choreId: v.choreId,
        title: byId.get(v.choreId)?.title ?? 'Chore',
        current: byId.get(v.choreId)?.points ?? 0,
        points: v.points,
        accept: true,
      // Only show rows where the value actually changes.
      })).filter(r => r.current !== r.points);
      this.valueRows.set(rows);
      this.aiStatus.set(rows.length === 0
        ? 'These star values look about right — nothing to change.'
        : `Review ${rows.length === 1 ? 'this value' : `these ${rows.length} values`}, then apply the ones you like.`);
    } catch (e) {
      this.aiStatus.set(this.aiError(e, "I couldn't reach the AI just now. Please try again, or set stars manually."));
    } finally {
      this.aiBusy.set(false);
    }
  }

  toggleValueRow(row: ValueRow): void {
    this.valueRows.set(this.valueRows().map(r => r.choreId === row.choreId ? { ...r, accept: !r.accept } : r));
  }
  clearValues(): void {
    this.valueRows.set([]);
    this.aiStatus.set('');
  }
  /** Count of accepted value rows (drives the Apply button). */
  readonly valuesAcceptedCount = computed(() => this.valueRows().filter(r => r.accept).length);

  /** "Apply" — PATCH each accepted point value. Partial-failure aware. */
  async applyValues(): Promise<void> {
    const rows = this.valueRows().filter(r => r.accept);
    if (this.aiApplying() || rows.length === 0) return;
    this.aiApplying.set(true);
    this.aiStatus.set('Updating stars…');

    let applied = 0;
    let lastBoard: FamilyChoresDto | null = null;
    const failed: ValueRow[] = [];
    for (const row of rows) {
      try {
        lastBoard = await firstValueFrom(this.api.patchFamilyChore(row.choreId, { points: row.points }));
        applied++;
      } catch {
        failed.push(row);
      }
    }

    const skipped = this.valueRows().filter(r => !r.accept);
    this.valueRows.set([...failed, ...skipped]);
    this.aiApplying.set(false);
    if (lastBoard) this.apply(lastBoard);
    this.finishApply(applied, failed.length, 'value', 'updated');
  }

  recurrenceShort(r: FamilyChoreRecurrence): string {
    return RECURRENCE_LABEL[r] ?? 'One-time';
  }

  /**
   * Shared "after an apply fan-out" status + snackbar: a full success closes the sheet quietly (and refreshes
   * the summary); a full failure or partial keeps the remaining rows on screen with a clear message.
   */
  private finishApply(done: number, failed: number, noun: string, verb: string): void {
    if (failed === 0) {
      this.aiStatus.set('');
      this.aiPanel.set(null);
      if (done > 0) {
        this.snack.open(`${done} ${done === 1 ? noun : noun + 's'} ${verb} ✨`, undefined, { duration: 2600 });
        this.loadSummary();
      }
    } else if (done === 0) {
      this.aiStatus.set(`Couldn't ${verb === 'added' ? 'add' : 'apply'} those just now. Please try again.`);
    } else {
      this.aiStatus.set(
        `${verb === 'added' ? 'Added' : 'Applied'} ${done}. ${failed} couldn't be ${verb} — review the remaining ${failed === 1 ? 'one' : 'rows'} and try again.`);
    }
  }

  /** A 503 from any assist means "AI unavailable" — show a gentle, do-it-manually line; else a fallback. */
  private aiError(e: unknown, fallback: string): string {
    return (e as { status?: number })?.status === 503
      ? 'AI unavailable, do it manually.'
      : this.messageOf(e, fallback);
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
