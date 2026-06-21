import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';

import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';

import { Api } from '../../core/api';
import { FamilyPollCreate, FamilyPollKind, FamilyPollOptionInput, PollOptionProposal } from '../../core/models';

/** One draft TIME slot: local "YYYY-MM-DD" date + "HH:mm" start/end. */
interface TimeDraft {
  id: number;
  date: string;
  start: string;
  end: string;
}

/** One draft TEXT option (e.g. "Zoo"). */
interface TextDraft {
  id: number;
  label: string;
}

/**
 * Family Hub F6b — CREATE A POLL. Choose a kind: a TIME poll (add several candidate start/end slots via
 * date + time pickers) or a TEXT poll (add labelled options like "Zoo" / "Beach"). On save we emit a
 * FamilyPollCreate with the local times converted to ISO UTC. Warm + mobile-friendly; no identity here.
 */
@Component({
  selector: 'app-poll-create-dialog',
  imports: [
    FormsModule, MatDialogModule, MatButtonModule, MatIconModule, MatFormFieldModule,
    MatInputModule, MatButtonToggleModule, MatProgressSpinnerModule,
  ],
  templateUrl: './poll-create-dialog.html',
  styleUrls: ['./family.scss', './polls.scss'],
})
export class PollCreateDialog {
  private api = inject(Api);
  readonly ref = inject(MatDialogRef<PollCreateDialog, FamilyPollCreate>);

  private seq = 0;

  readonly title = signal('');
  readonly kind = signal<FamilyPollKind>('time');

  readonly timeDrafts = signal<TimeDraft[]>([this.newTime(), this.newTime()]);
  readonly textDrafts = signal<TextDraft[]>([this.newText(), this.newText()]);

  // ---- ✨ Suggest options (AI fills the editable rows; nothing is created until the user submits) ----
  /** The free-text prompt ("plan a Saturday family outing" / "best dinner spot"). */
  readonly aiPrompt = signal('');
  readonly aiBusy = signal(false);
  /** A friendly aria-live status line for the AI box (an error, or "filled N options"). */
  readonly aiStatus = signal('');

  /** How many valid options the current kind has (a poll needs at least two). */
  readonly validCount = computed(() => {
    if (this.kind() === 'time') return this.timeDrafts().filter(t => this.timeOk(t)).length;
    return this.textDrafts().filter(t => t.label.trim().length > 0).length;
  });

  readonly canSave = computed(() => this.title().trim().length > 0 && this.validCount() >= 2);

  // ---- TIME drafts ----

  private newTime(): TimeDraft {
    const date = this.localDate(new Date());
    return { id: ++this.seq, date, start: '18:00', end: '19:00' };
  }

  addTime(): void {
    if (this.timeDrafts().length >= 30) return;
    this.timeDrafts.update(list => [...list, this.newTime()]);
  }

  removeTime(id: number): void {
    this.timeDrafts.update(list => list.length > 1 ? list.filter(t => t.id !== id) : list);
  }

  setTime(id: number, field: 'date' | 'start' | 'end', value: string): void {
    this.timeDrafts.update(list => list.map(t => t.id === id ? { ...t, [field]: value } : t));
  }

  private timeOk(t: TimeDraft): boolean {
    if (!t.date || !t.start || !t.end) return false;
    const start = new Date(`${t.date}T${t.start}`);
    const end = new Date(`${t.date}T${t.end}`);
    return !Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime()) && end.getTime() > start.getTime();
  }

  // ---- TEXT drafts ----

  private newText(): TextDraft {
    return { id: ++this.seq, label: '' };
  }

  addText(): void {
    if (this.textDrafts().length >= 30) return;
    this.textDrafts.update(list => [...list, this.newText()]);
  }

  removeText(id: number): void {
    this.textDrafts.update(list => list.length > 1 ? list.filter(t => t.id !== id) : list);
  }

  setText(id: number, value: string): void {
    this.textDrafts.update(list => list.map(t => t.id === id ? { ...t, label: value } : t));
  }

  // ---- Save ----

  save(): void {
    if (!this.canSave()) return;
    const kind = this.kind();
    let options: FamilyPollOptionInput[];
    if (kind === 'time') {
      options = this.timeDrafts()
        .filter(t => this.timeOk(t))
        .map(t => ({
          startUtc: new Date(`${t.date}T${t.start}`).toISOString(),
          endUtc: new Date(`${t.date}T${t.end}`).toISOString(),
        }));
    } else {
      options = this.textDrafts()
        .filter(t => t.label.trim().length > 0)
        .map(t => ({ label: t.label.trim() }));
    }
    const payload: FamilyPollCreate = { title: this.title().trim(), kind, options };
    this.ref.close(payload);
  }

  // ---- ✨ Suggest options ----

  /**
   * Ask Gemini to propose poll options from the free-text prompt and FILL the editable option rows with them
   * (creates NOTHING — the user reviews/edits before the normal Create). We pass the current kind to keep the
   * dialog's shape, but the response kind is authoritative: if the model chose the other shape, switch to it so
   * the proposed rows render. Degrades gracefully: a 503 (AI unavailable / not configured) or any error shows a
   * friendly aria-live line; an empty prompt is a no-op.
   */
  async suggestOptions(): Promise<void> {
    const prompt = this.aiPrompt().trim();
    if (prompt.length === 0 || this.aiBusy()) return;
    this.aiBusy.set(true);
    this.aiStatus.set('Thinking up some options…');
    try {
      const result = await firstValueFrom(this.api.pollOptionsAi(prompt, this.kind()));
      const proposals = result.options ?? [];
      if (proposals.length === 0) {
        this.aiStatus.set("I couldn't come up with options for that. Try rephrasing, or add them by hand.");
        return;
      }
      // The response kind wins — align the dialog so the filled rows render in the right shape.
      this.kind.set(result.kind);
      if (result.kind === 'time') this.fillTimeDrafts(proposals);
      else this.fillTextDrafts(proposals);

      // If the title is still blank, seed it from the prompt so Create is one step closer.
      if (this.title().trim().length === 0) this.title.set(prompt.slice(0, 200));

      const n = result.kind === 'time'
        ? this.timeDrafts().length
        : this.textDrafts().length;
      this.aiStatus.set(`Filled ${n} ${n === 1 ? 'option' : 'options'} below — tweak anything, then Create poll.`);
    } catch (e) {
      const status = (e as { status?: number })?.status;
      this.aiStatus.set(status === 503
        ? "AI suggestions aren't available right now. You can add the options manually."
        : this.messageOf(e, "I couldn't reach the AI just now. Please try again, or add options manually."));
    } finally {
      this.aiBusy.set(false);
    }
  }

  /** Replace the TIME draft rows from AI time proposals (local date + HH:mm), keeping at least two rows. */
  private fillTimeDrafts(proposals: PollOptionProposal[]): void {
    const drafts = proposals
      .filter(p => p.startUtc)
      .slice(0, 30)
      .map(p => this.timeDraftFromUtc(p.startUtc!, p.endUtc));
    while (drafts.length < 2) drafts.push(this.newTime());
    this.timeDrafts.set(drafts);
  }

  /** Replace the TEXT draft rows from AI label proposals, keeping at least two rows. */
  private fillTextDrafts(proposals: PollOptionProposal[]): void {
    const drafts = proposals
      .map(p => (p.label ?? '').trim())
      .filter(label => label.length > 0)
      .slice(0, 30)
      .map(label => ({ id: ++this.seq, label: label.slice(0, 200) }));
    while (drafts.length < 2) drafts.push(this.newText());
    this.textDrafts.set(drafts);
  }

  /** Build a TIME draft (local date + "HH:mm" start/end) from ISO UTC instants the AI proposed. */
  private timeDraftFromUtc(startUtc: string, endUtc?: string | null): TimeDraft {
    const start = new Date(startUtc);
    const end = endUtc ? new Date(endUtc) : new Date(start.getTime() + 60 * 60 * 1000);
    const valid = !Number.isNaN(start.getTime());
    const e = !Number.isNaN(end.getTime()) && end.getTime() > start.getTime()
      ? end : new Date(start.getTime() + 60 * 60 * 1000);
    return valid
      ? { id: ++this.seq, date: this.localDate(start), start: this.localTime(start), end: this.localTime(e) }
      : this.newTime();
  }

  private localTime(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  private messageOf(e: unknown, fallback: string): string {
    const msg = (e as { error?: { message?: string } })?.error?.message;
    return typeof msg === 'string' && msg ? msg : fallback;
  }

  private localDate(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
}
