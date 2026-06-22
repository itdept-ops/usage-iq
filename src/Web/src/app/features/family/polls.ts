import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';

import { Api } from '../../core/api';
import { AuthService } from '../../core/auth';
import {
  CalendarStatus, FamilyPoll, FamilyPollCreate, FamilyPollOption, FamilyPollVoter, PollSummaryAiResult,
} from '../../core/models';
import { FamilyConfirmDialog, ConfirmData } from './confirm-dialog';
import { PollCreateDialog } from './poll-create-dialog';

/**
 * Family Hub F6b — PLAN POLLS (Doodle-style). The household's polls, newest first: each shows its options
 * with live vote counts + voter avatars (name/initials only — NEVER an email), the caller's own selections
 * (multi-select: every option that works for them), a Close control (picks the most-voted winner), the
 * winning option highlighted once closed, and — for a CLOSED time-poll when the caller has a connected
 * calendar — an "Add to calendar" button that books the slot. Create a Time or Choices poll from the header.
 * Warm + mobile-friendly; everything degrades gracefully.
 */
@Component({
  selector: 'app-family-polls',
  imports: [
    RouterLink, MatIconModule, MatButtonModule, MatTooltipModule, MatProgressSpinnerModule, MatSnackBarModule,
  ],
  templateUrl: './polls.html',
  styleUrls: ['./family.scss', './polls.scss'],
})
export class FamilyPolls {
  private api = inject(Api);
  private auth = inject(AuthService);
  private dialog = inject(MatDialog);
  private snack = inject(MatSnackBar);

  readonly polls = signal<FamilyPoll[]>([]);
  readonly loading = signal(true);
  readonly error = signal(false);

  /** Whether the caller has a connected calendar — gates the "Add to calendar" book button on closed time polls. */
  readonly calendarConnected = signal(false);

  /** Per-poll busy flag (booking/closing in flight) keyed by poll id, so buttons disable individually. */
  readonly busy = signal<Set<number>>(new Set());

  // ---- ✨ Summarize (read-only result card; NEVER 503 — a plain floor is the guarantee) ----
  /** The poll ids whose "Summarize" is in flight, so the button shows a spinner individually. */
  readonly summarizing = signal<Set<number>>(new Set());
  /** The fetched summary per poll id (the read-only card). Absent until the user asks. */
  readonly summaries = signal<Map<number, PollSummaryAiResult>>(new Map());

  readonly myUserId = computed(() => this.auth.userId());

  constructor() {
    void this.load();
    // Best-effort: know if the caller can book a closed time poll onto their calendar.
    void this.loadCalendarStatus();
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(false);
    try {
      const list = await firstValueFrom(this.api.familyPolls());
      this.polls.set(list);
    } catch {
      this.error.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  private async loadCalendarStatus(): Promise<void> {
    try {
      const s: CalendarStatus = await firstValueFrom(this.api.calendarStatus());
      this.calendarConnected.set(s.connected);
    } catch {
      this.calendarConnected.set(false);
    }
  }

  // ---- Create ----

  async create(): Promise<void> {
    const ref = this.dialog.open<PollCreateDialog, undefined, FamilyPollCreate>(
      PollCreateDialog, { width: '560px', maxWidth: '94vw', autoFocus: false, panelClass: 'family-dialog' });
    const payload = await firstValueFrom(ref.afterClosed());
    if (!payload) return;
    try {
      const created = await firstValueFrom(this.api.createFamilyPoll(payload));
      this.polls.update(list => [created, ...list]);
    } catch (e) {
      this.snack.open(this.messageOf(e, "Couldn't create that poll. Please try again."), 'OK', { duration: 4000 });
    }
  }

  // ---- Vote (toggle: re-vote replaces the caller's prior selections) ----

  async toggleVote(poll: FamilyPoll, option: FamilyPollOption): Promise<void> {
    if (poll.closed) return;
    const current = new Set(poll.myVotes);
    if (current.has(option.id)) current.delete(option.id); else current.add(option.id);
    try {
      const updated = await firstValueFrom(this.api.voteFamilyPoll(poll.id, [...current]));
      this.replace(updated);
    } catch (e) {
      this.snack.open(this.messageOf(e, "Couldn't save your vote. Please try again."), 'OK', { duration: 4000 });
    }
  }

  // ---- Close ----

  async close(poll: FamilyPoll): Promise<void> {
    const ok = await this.confirm({
      title: 'Close this poll?',
      message: 'We\'ll lock in the most-voted option as the winner. No more votes after that.',
      confirmLabel: 'Close poll',
    });
    if (!ok) return;
    this.setBusy(poll.id, true);
    try {
      const updated = await firstValueFrom(this.api.closeFamilyPoll(poll.id));
      this.replace(updated);
    } catch (e) {
      this.snack.open(this.messageOf(e, "Couldn't close the poll. Please try again."), 'OK', { duration: 4000 });
    } finally {
      this.setBusy(poll.id, false);
    }
  }

  // ---- Book (closed time poll → caller's calendar) ----

  async book(poll: FamilyPoll, option: FamilyPollOption): Promise<void> {
    this.setBusy(poll.id, true);
    try {
      await firstValueFrom(this.api.bookFamilyPoll(poll.id, option.id));
      this.snack.open('Added to your calendar.', undefined, { duration: 2500 });
    } catch (e) {
      const msg = this.messageOf(e, "Couldn't add that to your calendar. Please try again.");
      this.snack.open(msg, 'OK', { duration: 4500 });
      // If the calendar isn't connected after all, reflect that so the button hides.
      if ((e as { error?: { connected?: boolean } })?.error?.connected === false) this.calendarConnected.set(false);
    } finally {
      this.setBusy(poll.id, false);
    }
  }

  // ---- ✨ Summarize (read-only narrative of where the poll stands) ----

  /**
   * Fetch a short read-only AI summary for a poll and show it as a result card. This endpoint NEVER 503s — a
   * deterministic plain summary is the guaranteed floor (fellBackToPlain=true), so the card always has content;
   * it just renders plainly (no AI flourish) when it fell back. A network blip is the only failure path.
   */
  async summarize(poll: FamilyPoll): Promise<void> {
    if (this.isSummarizing(poll.id)) return;
    this.setSummarizing(poll.id, true);
    try {
      const result = await firstValueFrom(this.api.pollSummaryAi(poll.id));
      this.summaries.update(map => new Map(map).set(poll.id, result));
    } catch (e) {
      this.snack.open(this.messageOf(e, "Couldn't summarize that poll just now. Please try again."),
        'OK', { duration: 4000 });
    } finally {
      this.setSummarizing(poll.id, false);
    }
  }

  /** Dismiss a poll's summary card. */
  clearSummary(pollId: number): void {
    this.summaries.update(map => {
      if (!map.has(pollId)) return map;
      const next = new Map(map);
      next.delete(pollId);
      return next;
    });
  }

  isSummarizing(pollId: number): boolean {
    return this.summarizing().has(pollId);
  }

  summaryOf(pollId: number): PollSummaryAiResult | undefined {
    return this.summaries().get(pollId);
  }

  private setSummarizing(pollId: number, on: boolean): void {
    const next = new Set(this.summarizing());
    if (on) next.add(pollId); else next.delete(pollId);
    this.summarizing.set(next);
  }

  // ---- Delete ----

  async remove(poll: FamilyPoll): Promise<void> {
    const ok = await this.confirm({
      title: 'Delete this poll?',
      message: `“${poll.title}” and its votes will be removed for everyone.`,
      destructive: true,
    });
    if (!ok) return;
    try {
      await firstValueFrom(this.api.deleteFamilyPoll(poll.id));
      this.polls.update(list => list.filter(p => p.id !== poll.id));
      this.clearSummary(poll.id);
    } catch {
      this.snack.open("Couldn't delete that poll.", 'OK', { duration: 4000 });
    }
  }

  // ---- View helpers ----

  isBusy(pollId: number): boolean {
    return this.busy().has(pollId);
  }

  isMine(poll: FamilyPoll): boolean {
    return this.myUserId() != null && poll.createdByUserId === this.myUserId();
  }

  isWinner(poll: FamilyPoll, option: FamilyPollOption): boolean {
    return poll.closed && poll.winningOptionId === option.id;
  }

  /** Whether a closed TIME poll's winning slot can be booked by this caller. */
  canBook(poll: FamilyPoll, option: FamilyPollOption): boolean {
    return poll.closed && poll.kind === 'time' && this.calendarConnected()
      && this.isWinner(poll, option) && !!option.startUtc && !!option.endUtc;
  }

  /** The label for a poll option: a local time range for TIME polls, the text label for TEXT polls. */
  optionLabel(poll: FamilyPoll, option: FamilyPollOption): string {
    if (poll.kind === 'text') return option.label ?? '';
    if (!option.startUtc) return option.label ?? '';
    const date = new Date(option.startUtc).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    const opts: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };
    const start = new Date(option.startUtc).toLocaleTimeString(undefined, opts);
    const end = option.endUtc ? new Date(option.endUtc).toLocaleTimeString(undefined, opts) : '';
    return end ? `${date} · ${start} – ${end}` : `${date} · ${start}`;
  }

  /** Two-letter initials for a voter avatar fallback (from the name; never an email). */
  initials(name: string): string {
    const parts = (name || '').split(/\s+/).filter(Boolean);
    return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
  }

  /** A short "you + 2 others" style summary used for the voter aria-label. */
  votersLabel(voters: FamilyPollVoter[]): string {
    if (!voters.length) return 'No votes yet';
    return voters.map(v => v.name).join(', ');
  }

  createdLabel(poll: FamilyPoll): string {
    return new Date(poll.createdUtc).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  // ---- internals ----

  private replace(poll: FamilyPoll): void {
    this.polls.update(list => list.map(p => p.id === poll.id ? poll : p));
    // The tally changed (a vote or a close) — drop any stale summary so it isn't out of date.
    this.clearSummary(poll.id);
  }

  private setBusy(pollId: number, on: boolean): void {
    const next = new Set(this.busy());
    if (on) next.add(pollId); else next.delete(pollId);
    this.busy.set(next);
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
