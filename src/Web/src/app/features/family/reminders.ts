import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { DatePipe } from '@angular/common';
import { catchError, firstValueFrom, of } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatMenuModule } from '@angular/material/menu';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';

import { Api } from '../../core/api';
import {
  FamilyRecurrence, FamilyReminder, Household, HouseholdMember, ReminderAiProposal,
} from '../../core/models';
import { FamilyConfirmDialog, ConfirmData } from './confirm-dialog';
import {
  ReminderEditorDialog, ReminderEditorData, ReminderEditorResult,
} from './reminder-editor-dialog';

/** Friendly labels for the recurrence chip. */
const RECURRENCE_LABEL: Record<FamilyRecurrence, string> = {
  none: 'One-time',
  daily: 'Daily',
  weekdays: 'Weekdays',
  weekly: 'Weekly',
};

/** One AI-proposed reminder the family member can confirm/edit before it's created. */
interface ProposedReminder {
  ai: ReminderAiProposal;
  /** A friendly "Tue, Jun 23 · 3:00 PM" when-label in the viewer's local zone. */
  whenLabel: string;
  /** A short repeat label ("Daily") or '' for a one-off — drives the recurrence chip. */
  repeatLabel: string;
  /** True while THIS card's "Add" is creating the reminder. */
  saving: boolean;
}

/** Snooze options offered on the menu (minutes). */
const SNOOZE_OPTIONS = [
  { label: '10 minutes', minutes: 10 },
  { label: '1 hour', minutes: 60 },
  { label: 'Tomorrow (24h)', minutes: 24 * 60 },
];

/**
 * Family Reminders — the household's upcoming nudges, next-due first. Each row shows the text, when (in the
 * viewer's LOCAL time), a recurrence chip, and who it pings (target member avatar + name; never an email).
 * Members can create / edit (text, a local date+time converted to UTC, a recurrence, and a household-member
 * target), snooze, and delete. When a reminder fires it arrives through the existing notification bell/toast
 * — this page just reflects recurrence advancing (a light refresh on focus picks up the new due time).
 *
 * Everyone is rendered by display name + initials avatar only; an email is never shown (email-privacy).
 */
@Component({
  selector: 'app-family-reminders',
  imports: [
    FormsModule, RouterLink, DatePipe, MatIconModule, MatButtonModule, MatTooltipModule,
    MatProgressSpinnerModule, MatMenuModule, MatFormFieldModule, MatInputModule, MatSnackBarModule,
  ],
  templateUrl: './reminders.html',
  styleUrls: ['./family.scss', './reminders.scss'],
})
export class FamilyReminders {
  private api = inject(Api);
  private dialog = inject(MatDialog);
  private snack = inject(MatSnackBar);

  readonly snoozeOptions = SNOOZE_OPTIONS;

  readonly reminders = signal<FamilyReminder[]>([]);
  readonly members = signal<HouseholdMember[]>([]);
  readonly loading = signal(true);
  readonly error = signal(false);
  readonly busyId = signal<number | null>(null);

  // ---- Add with AI ----
  /** The free-text reminder box ("call the dentist next Tuesday at 3, every month"). */
  readonly aiText = signal('');
  readonly aiBusy = signal(false);
  /** A friendly status line for the AI box (aria-live), e.g. an error or "couldn't find a reminder". */
  readonly aiStatus = signal('');
  /** The AI-proposed reminders awaiting the user's confirmation. */
  readonly proposals = signal<ProposedReminder[]>([]);

  /** The caller's own userId (default target for a new reminder). */
  private readonly selfUserId = computed(() => this.members().find(m => m.isSelf)?.userId ?? 0);

  /** Active reminders, next-due first. */
  readonly upcoming = computed(() =>
    this.reminders().filter(r => r.active).sort((a, b) => a.dueUtc.localeCompare(b.dueUtc)));

  /** Fired one-time reminders that haven't been deleted yet (kept visible so they can be re-scheduled). */
  readonly past = computed(() =>
    this.reminders().filter(r => !r.active).sort((a, b) => b.dueUtc.localeCompare(a.dueUtc)));

  constructor() {
    this.reload(true);
    this.api.getHousehold()
      .pipe(catchError(() => of<Household | null>(null)), takeUntilDestroyed())
      .subscribe(h => { if (h) this.members.set(h.members); });
  }

  private reload(initial = false): void {
    if (initial) this.loading.set(true);
    this.api.familyReminders()
      .pipe(catchError(() => { if (initial) this.error.set(true); return of<FamilyReminder[]>([]); }),
        takeUntilDestroyed())
      .subscribe(list => { this.reminders.set(list); this.loading.set(false); });
  }

  recurrenceLabel(r: FamilyRecurrence): string {
    return RECURRENCE_LABEL[r] ?? 'One-time';
  }

  // ---- Add with AI ----

  /**
   * Send the free-text reminder request to Gemini and show the proposed reminder(s) as confirm cards. Creates
   * NOTHING — each card has its own "Add". Degrades gracefully: a 503 (AI unavailable / not configured) or any
   * error shows a friendly aria-live line; an empty result says so.
   */
  async addWithAi(): Promise<void> {
    const text = this.aiText().trim();
    if (text.length === 0 || this.aiBusy()) return;
    this.aiBusy.set(true);
    this.aiStatus.set('Reading your request…');
    this.proposals.set([]);
    try {
      const result = await firstValueFrom(this.api.parseReminderAi(text));
      const proposed = (result.reminders ?? []).map(ai => this.toProposed(ai));
      this.proposals.set(proposed);
      if (proposed.length === 0) {
        this.aiStatus.set(
          result.notes?.trim() || "I couldn't find a reminder in that. Try \"call mom tomorrow at 6pm\".");
      } else {
        const n = proposed.length;
        this.aiStatus.set(
          (result.notes?.trim() ? result.notes!.trim() + ' ' : '') +
          `Review ${n === 1 ? 'the reminder' : `these ${n} reminders`} below, then add ${n === 1 ? 'it' : 'them'}.`);
      }
    } catch (e) {
      const status = (e as { status?: number })?.status;
      this.aiStatus.set(status === 503
        ? 'AI reminders aren\'t available right now — you can add the reminder manually with New reminder.'
        : this.messageOf(e, "I couldn't reach the AI just now. Please try again, or add the reminder manually."));
    } finally {
      this.aiBusy.set(false);
    }
  }

  /** Add one AI-proposed reminder via the existing create endpoint (target stays self). Then drop the card. */
  async addProposal(p: ProposedReminder): Promise<void> {
    if (p.saving) return;
    this.setProposalSaving(p, true);
    try {
      const created = await firstValueFrom(this.api.createFamilyReminder({
        text: p.ai.text, dueUtc: p.ai.dueUtc, recurrence: p.ai.recurrence,
      }));
      this.upsert(created);
      this.dismissProposal(p);
      this.snack.open('Reminder added.', undefined, { duration: 2000 });
    } catch (e) {
      this.setProposalSaving(p, false);
      this.snack.open(this.messageOf(e, "Couldn't add that reminder. Please try again."), 'OK', { duration: 4000 });
    }
  }

  /** Open the normal reminder editor prefilled from a proposal so the user can tweak it before creating. */
  async editProposal(p: ProposedReminder): Promise<void> {
    const seed: FamilyReminder = {
      id: 0, text: p.ai.text, dueUtc: p.ai.dueUtc, recurrence: p.ai.recurrence, active: true,
      targetUserId: this.selfUserId(), targetName: '', createdByUserId: this.selfUserId(), createdByName: '',
    };
    const result = await this.openEditor(seed);
    if (!result) return;
    try {
      const created = await firstValueFrom(this.api.createFamilyReminder(result));
      this.upsert(created);
      this.dismissProposal(p);
    } catch (e) {
      this.snack.open(this.messageOf(e, "Couldn't save that reminder. Please try again."), 'OK', { duration: 4000 });
    }
  }

  /** Discard a proposed reminder card without creating it. */
  dismissProposal(p: ProposedReminder): void {
    this.proposals.set(this.proposals().filter(x => x !== p));
  }

  /** Clear the AI box + any pending proposals. */
  clearAi(): void {
    this.aiText.set('');
    this.aiStatus.set('');
    this.proposals.set([]);
  }

  private setProposalSaving(p: ProposedReminder, saving: boolean): void {
    this.proposals.set(this.proposals().map(x => x === p ? { ...x, saving } : x));
  }

  /** Build a confirm-card view-model from a raw AI-proposed reminder. */
  private toProposed(ai: ReminderAiProposal): ProposedReminder {
    return {
      ai,
      whenLabel: this.proposalWhenLabel(ai.dueUtc),
      repeatLabel: ai.recurrence === 'none' ? '' : this.recurrenceLabel(ai.recurrence),
      saving: false,
    };
  }

  /** "Tue, Jun 23 · 3:00 PM" in the viewer's local zone, or '' for an unparseable instant. */
  private proposalWhenLabel(dueUtc: string): string {
    const d = new Date(dueUtc);
    if (Number.isNaN(d.getTime())) return '';
    const day = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    return `${day} · ${time}`;
  }

  /** True when the reminder's next fire is in the past (a recurring one mid-advance, or a not-yet-fired late one). */
  isOverdue(r: FamilyReminder): boolean {
    return r.active && Date.parse(r.dueUtc) < Date.now();
  }

  initials(name: string): string {
    const parts = (name || '').split(/\s+/).filter(Boolean);
    return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
  }

  private upsert(reminder: FamilyReminder): void {
    this.reminders.update(list =>
      list.some(r => r.id === reminder.id)
        ? list.map(r => (r.id === reminder.id ? reminder : r))
        : [...list, reminder]);
  }

  /** Open the editor to create a new reminder. */
  async create(): Promise<void> {
    const result = await this.openEditor(null);
    if (!result) return;
    try {
      const created = await firstValueFrom(this.api.createFamilyReminder(result));
      this.upsert(created);
    } catch (e) {
      this.snack.open(this.messageOf(e, "Couldn't save that reminder. Please try again."), 'OK', { duration: 4000 });
    }
  }

  /** Open the editor to edit an existing reminder. */
  async edit(reminder: FamilyReminder): Promise<void> {
    const result = await this.openEditor(reminder);
    if (!result) return;
    try {
      const updated = await firstValueFrom(this.api.updateFamilyReminder(reminder.id, result));
      this.upsert(updated);
    } catch (e) {
      this.snack.open(this.messageOf(e, "Couldn't save that reminder. Please try again."), 'OK', { duration: 4000 });
    }
  }

  private openEditor(reminder: FamilyReminder | null): Promise<ReminderEditorResult | undefined> {
    const ref = this.dialog.open<ReminderEditorDialog, ReminderEditorData, ReminderEditorResult>(
      ReminderEditorDialog, {
        data: { reminder, members: this.members(), selfUserId: this.selfUserId() },
        width: '460px', maxWidth: '94vw', autoFocus: false, panelClass: 'family-dialog',
      });
    return firstValueFrom(ref.afterClosed());
  }

  /** Snooze a reminder out by N minutes from now. */
  async snooze(reminder: FamilyReminder, minutes: number): Promise<void> {
    if (this.busyId() != null) return;
    this.busyId.set(reminder.id);
    try {
      const updated = await firstValueFrom(this.api.snoozeFamilyReminder(reminder.id, minutes));
      this.upsert(updated);
      this.snack.open('Snoozed.', undefined, { duration: 1800 });
    } catch {
      this.snack.open("Couldn't snooze that reminder.", 'OK', { duration: 4000 });
    } finally {
      this.busyId.set(null);
    }
  }

  /** Delete a reminder with a warm confirm. */
  async remove(reminder: FamilyReminder): Promise<void> {
    const ok = await this.confirm({
      title: 'Delete this reminder?',
      message: `“${reminder.text}” will stop nudging ${reminder.targetName}.`,
      destructive: true,
    });
    if (!ok || this.busyId() != null) return;
    this.busyId.set(reminder.id);
    try {
      await firstValueFrom(this.api.deleteFamilyReminder(reminder.id));
      this.reminders.update(list => list.filter(r => r.id !== reminder.id));
    } catch {
      this.snack.open("Couldn't delete that reminder.", 'OK', { duration: 4000 });
    } finally {
      this.busyId.set(null);
    }
  }

  private confirm(data: ConfirmData): Promise<boolean | undefined> {
    const ref = this.dialog.open<FamilyConfirmDialog, ConfirmData, boolean>(FamilyConfirmDialog, {
      data, width: '420px', maxWidth: '92vw', panelClass: 'family-dialog',
    });
    return firstValueFrom(ref.afterClosed());
  }

  private messageOf(e: unknown, fallback: string): string {
    const msg = (e as { error?: { message?: string } })?.error?.message;
    return typeof msg === 'string' && msg ? msg : fallback;
  }
}
