import { Component, computed, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { catchError, firstValueFrom, of } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatDialog } from '@angular/material/dialog';
import { MatMenuModule } from '@angular/material/menu';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';

import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { FormsModule } from '@angular/forms';

import { Api } from '../../core/api';
import {
  FamilyList,
  FamilyNote,
  FamilyShareTarget,
  Household,
  NoteActionItem,
} from '../../core/models';
import { renderMarkdown } from './markdown';
import { NoteEditorDialog, NoteEditorData, NoteEditorResult } from './note-editor-dialog';
import { FamilyShareDialog, ShareDialogData } from './share-dialog';
import { FamilyConfirmDialog, ConfirmData } from './confirm-dialog';

/** One action item in a note's summary card, with a per-item "checked to act on" flag. */
interface SummaryAction {
  text: string;
  duePhrase: string | null;
  keep: boolean;
}

/** One note the "✨ Ask your notes" answer drew on, resolved to a tappable title (to open that note). */
interface AnswerSource {
  id: number;
  title: string;
}

/** The read-only "✨ Ask your notes" answer card (the question is kept for context; sources link back). */
interface AskAnswer {
  question: string;
  answer: string;
  sources: AnswerSource[];
}

/** The "✨ Summarize" result shown inline under a note (read-only until the user picks an action). */
interface NoteSummary {
  noteId: number;
  summary: string;
  actions: SummaryAction[];
  /** True while "Add to a list" / "Make reminders" is running. */
  acting: boolean;
  /** A friendly status line for aria-live (errors, progress, or done). */
  status: string;
}

/**
 * Family Notes — a warm board of shared note cards. Pinned notes float to the top, then most-recently
 * updated. Each card shows the title, a markdown-rendered body, the author (name + initials avatar; never
 * an email), and who it's shared with. Members can create / edit (markdown editor + live preview), pin,
 * delete (with a gentle confirm), and share to a contact. A note the caller only has a view-only share to
 * renders read-only — no edit / pin / delete / share controls.
 *
 * All people are rendered by display name + initials avatar only; an email is never shown (email-privacy).
 */
@Component({
  selector: 'app-family-notes',
  imports: [
    RouterLink,
    FormsModule,
    MatIconModule,
    MatButtonModule,
    MatTooltipModule,
    MatProgressSpinnerModule,
    MatMenuModule,
    MatSnackBarModule,
    MatFormFieldModule,
    MatInputModule,
  ],
  templateUrl: './notes.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './family.scss',
})
export class FamilyNotes {
  private api = inject(Api);
  private dialog = inject(MatDialog);
  private snack = inject(MatSnackBar);
  private sanitizer = inject(DomSanitizer);
  private route = inject(ActivatedRoute);

  /** A pending #note-{id} fragment to scroll/flash once the board has loaded (deep-link from Search). */
  private pendingFragment: string | null = null;

  readonly notes = signal<FamilyNote[]>([]);
  readonly loading = signal(true);
  readonly error = signal(false);
  /** Per-note busy id (pin/delete spinner), or null. */
  readonly busyId = signal<number | null>(null);

  // ---- ✨ Ask your notes ----
  /** The question box at the top of the board. */
  readonly askText = signal('');
  readonly asking = signal(false);
  /** A friendly aria-live status line for the ask box (an error, or a hint). */
  readonly askStatus = signal('');
  /** The current read-only answer card, or null (cleared on a new ask / explicit close). */
  readonly answer = signal<AskAnswer | null>(null);

  /** The note id currently being summarized (spinner on its ✨ button), or null. */
  readonly summarizingId = signal<number | null>(null);
  /** The open summary card per note id (keyed), or absent. */
  readonly summaries = signal<Record<number, NoteSummary>>({});
  /** The household's editable lists (the "Add to a list" picker), loaded lazily. */
  readonly lists = signal<FamilyList[]>([]);

  /**
   * The caller's household member userIds — used to tell a household note (manageable: share/delete) from a
   * note merely shared IN from another household (a shared-in author is never one of my members). The
   * server enforces management regardless; this just keeps the menu honest.
   */
  private readonly memberIds = signal<Set<number>>(new Set());

  /** The board, ordered pinned-first then most-recently-updated (the server already sorts, we keep it stable). */
  readonly board = computed(() => this.notes());

  constructor() {
    // Deep-link from Search: #note-{id} scrolls + flashes that note once the board is loaded.
    this.route.fragment.pipe(takeUntilDestroyed()).subscribe((frag) => {
      this.pendingFragment = frag;
      if (frag && !this.loading()) this.scrollToFragment(frag);
    });
    this.reload(true);
    this.api
      .getHousehold()
      .pipe(
        catchError(() => of<Household | null>(null)),
        takeUntilDestroyed(),
      )
      .subscribe((h) => {
        if (h) this.memberIds.set(new Set(h.members.map((m) => m.userId)));
      });
    // Lists power the "Add to a list" picker on summary cards; failure is non-fatal (picker just stays empty).
    this.api
      .familyLists()
      .pipe(
        catchError(() => of<FamilyList[]>([])),
        takeUntilDestroyed(),
      )
      .subscribe((list) => this.lists.set(list));
  }

  /**
   * True when the caller may MANAGE this note (share / delete) — i.e. they're a household member of the
   * note's household. A note authored by one of my household members is a household note; a shared-in note
   * (author in another household) is not. Mirrors the server's "creator or household member" rule.
   */
  canManage(note: FamilyNote): boolean {
    return note.isMine || this.memberIds().has(note.createdByUserId);
  }

  private reload(initial = false): void {
    if (initial) this.loading.set(true);
    this.api
      .familyNotes()
      .pipe(
        catchError(() => {
          this.error.set(true);
          return of<FamilyNote[]>([]);
        }),
        takeUntilDestroyed(),
      )
      .subscribe((list) => {
        this.notes.set(list);
        this.loading.set(false);
        if (this.pendingFragment) this.scrollToFragment(this.pendingFragment);
      });
  }

  /** Scroll a #note-{id} target into view and flash it (shared by openSource + the deep-link fragment). */
  private scrollToFragment(frag: string): void {
    setTimeout(() => {
      const el = document.getElementById(frag);
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('note-card--flash');
      setTimeout(() => el.classList.remove('note-card--flash'), 1600);
    });
  }

  /** Render a note body to safe HTML (renderMarkdown escapes the source first). */
  bodyHtml(body: string): SafeHtml {
    return this.sanitizer.bypassSecurityTrustHtml(renderMarkdown(body));
  }

  initials(name: string): string {
    const parts = (name || '').split(/\s+/).filter(Boolean);
    return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
  }

  /** Replace one note in the board with its fresh copy (after edit/pin/share). */
  private upsert(note: FamilyNote): void {
    this.notes.update((list) => {
      const next = list.some((n) => n.id === note.id)
        ? list.map((n) => (n.id === note.id ? note : n))
        : [...list, note];
      return this.sort(next);
    });
  }

  /** Pinned-first, then most-recently-updated (mirrors the server's order so it stays stable on local upserts). */
  private sort(list: FamilyNote[]): FamilyNote[] {
    return [...list].sort(
      (a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedUtc.localeCompare(a.updatedUtc),
    );
  }

  /** Open the editor to create a new note. */
  async create(): Promise<void> {
    const result = await this.openEditor(null);
    if (!result) return;
    try {
      const note = await firstValueFrom(this.api.createFamilyNote(result));
      this.upsert(note);
    } catch {
      this.snack.open("Couldn't save that note. Please try again.", 'OK', { duration: 4000 });
    }
  }

  /** Open the editor to edit an existing note (members / canEdit-shares only). */
  async edit(note: FamilyNote): Promise<void> {
    if (!note.canEdit) return;
    const result = await this.openEditor(note);
    if (!result) return;
    try {
      const updated = await firstValueFrom(this.api.updateFamilyNote(note.id, result));
      this.upsert(updated);
    } catch {
      this.snack.open("Couldn't save that note. Please try again.", 'OK', { duration: 4000 });
    }
  }

  private openEditor(note: FamilyNote | null): Promise<NoteEditorResult | undefined> {
    const ref = this.dialog.open<NoteEditorDialog, NoteEditorData, NoteEditorResult>(
      NoteEditorDialog,
      {
        data: { note },
        width: '720px',
        maxWidth: '94vw',
        autoFocus: false,
        panelClass: 'family-dialog',
      },
    );
    return firstValueFrom(ref.afterClosed());
  }

  /** Toggle a note's pinned state (members / canEdit-shares). */
  async togglePin(note: FamilyNote): Promise<void> {
    if (!note.canEdit || this.busyId() != null) return;
    this.busyId.set(note.id);
    try {
      const updated = await firstValueFrom(
        this.api.updateFamilyNote(note.id, {
          title: note.title,
          body: note.body,
          pinned: !note.pinned,
        }),
      );
      this.upsert(updated);
    } catch {
      this.snack.open("Couldn't update that note.", 'OK', { duration: 4000 });
    } finally {
      this.busyId.set(null);
    }
  }

  /** Delete a note with a warm confirm (creator or any household member). */
  async remove(note: FamilyNote): Promise<void> {
    const ok = await this.confirm({
      title: 'Delete this note?',
      message: note.title
        ? `“${note.title}” will be removed for everyone it’s shared with.`
        : 'This note will be removed for everyone it’s shared with.',
      destructive: true,
    });
    if (!ok || this.busyId() != null) return;
    this.busyId.set(note.id);
    try {
      await firstValueFrom(this.api.deleteFamilyNote(note.id));
      this.notes.update((list) => list.filter((n) => n.id !== note.id));
    } catch (e) {
      this.snack.open(this.messageOf(e, "Couldn't delete that note."), 'OK', { duration: 4000 });
    } finally {
      this.busyId.set(null);
    }
  }

  /** Open the share dialog for a note (only the manager — a household member — gets here). */
  async share(note: FamilyNote): Promise<void> {
    const data: ShareDialogData = {
      itemLabel: note.title || 'Untitled note',
      shares: note.sharedWith,
      onShare: async (userId, canEdit) => {
        const updated = await firstValueFrom(this.api.shareFamilyNote(note.id, userId, canEdit));
        this.upsert(updated);
        return updated.sharedWith;
      },
      onUnshare: async (userId) => {
        const updated = await firstValueFrom(this.api.unshareFamilyNote(note.id, userId));
        this.upsert(updated);
        return updated.sharedWith;
      },
    };
    const ref = this.dialog.open<FamilyShareDialog, ShareDialogData, boolean>(FamilyShareDialog, {
      data,
      width: '460px',
      maxWidth: '94vw',
      autoFocus: false,
      panelClass: 'family-dialog',
    });
    await firstValueFrom(ref.afterClosed());
  }

  // ---- ✨ Ask your notes (read-only Q&A over the household's notes) ----

  /**
   * Ask Gemini a question answered STRICTLY from the household's notes and show a read-only answer card. The
   * server reads the notes (nothing trusted from the client) and returns the note ids it used, which we
   * resolve to titles the user can tap to open. Creates NOTHING. Degrades gracefully: a 503 (AI unavailable /
   * not configured) or any error shows a friendly aria-live line; the board still works.
   */
  async ask(): Promise<void> {
    const question = this.askText().trim();
    if (!question || this.asking()) return;
    this.asking.set(true);
    this.askStatus.set('Reading your notes…');
    this.answer.set(null);
    try {
      const result = await firstValueFrom(this.api.askFamilyNotesAi(question));
      // Resolve the used note ids to titles in the loaded board (skip any the caller can't see locally).
      const byId = new Map(this.notes().map((n) => [n.id, n]));
      const sources: AnswerSource[] = (result.usedNoteIds ?? [])
        .map((id) => byId.get(id))
        .filter((n): n is FamilyNote => !!n)
        .map((n) => ({ id: n.id, title: n.title?.trim() || 'Untitled note' }));
      this.answer.set({ question, answer: result.answer, sources });
      this.askStatus.set('');
    } catch (e) {
      const status = (e as { status?: number })?.status;
      this.askStatus.set(
        status === 503
          ? "AI isn't available right now — you can still open your notes below."
          : this.messageOf(e, "I couldn't reach the AI just now. Please try again."),
      );
    } finally {
      this.asking.set(false);
    }
  }

  /** Dismiss the answer card (keeps the question text so the user can tweak + re-ask). */
  closeAnswer(): void {
    this.answer.set(null);
    this.askStatus.set('');
  }

  /** Open a note the answer drew on (scroll it into view + flash it via the editor when editable). */
  openSource(noteId: number): void {
    const note = this.notes().find((n) => n.id === noteId);
    if (!note) return;
    const el = document.getElementById(`note-${noteId}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('note-card--flash');
      setTimeout(() => el.classList.remove('note-card--flash'), 1600);
    } else if (note.canEdit) {
      void this.edit(note);
    }
  }

  // ---- ✨ Summarize → action items ----

  /** The open summary card for a note, or undefined. */
  summaryFor(noteId: number): NoteSummary | undefined {
    return this.summaries()[noteId];
  }

  /** Editable lists the user can add action items into (the "Add to a list" picker). */
  readonly editableLists = computed(() => this.lists().filter((l) => l.canEdit));

  private patchSummary(noteId: number, patch: Partial<NoteSummary>): void {
    const cur = this.summaries()[noteId];
    if (!cur) return;
    this.summaries.update((s) => ({ ...s, [noteId]: { ...cur, ...patch } }));
  }

  /** Close the summary card for a note. */
  closeSummary(noteId: number): void {
    this.summaries.update((s) => {
      const next = { ...s };
      delete next[noteId];
      return next;
    });
  }

  /**
   * Summarize a note into a short summary + action-item checklist (read-only — creates nothing). Degrades
   * gracefully: a 503 (AI unavailable) or any error shows a snackbar; a note with no actions still shows the
   * summary. Re-running re-opens the card with fresh content.
   */
  async summarize(note: FamilyNote): Promise<void> {
    if (this.summarizingId() != null) return;
    this.summarizingId.set(note.id);
    try {
      const result = await firstValueFrom(this.api.summarizeFamilyNoteAi(note.id));
      const actions: SummaryAction[] = (result.actionItems ?? []).map((a: NoteActionItem) => ({
        text: a.text,
        duePhrase: a.duePhrase,
        keep: true,
      }));
      this.summaries.update((s) => ({
        ...s,
        [note.id]: { noteId: note.id, summary: result.summary, actions, acting: false, status: '' },
      }));
    } catch (e) {
      const status = (e as { status?: number })?.status;
      this.snack.open(
        status === 503
          ? "AI summaries aren't available right now. Please try again later."
          : this.messageOf(e, "Couldn't summarize that note. Please try again."),
        'OK',
        { duration: 4000 },
      );
    } finally {
      this.summarizingId.set(null);
    }
  }

  /** Toggle whether an action item is included in "Add to a list" / "Make reminders". */
  toggleAction(noteId: number, index: number): void {
    const s = this.summaries()[noteId];
    if (!s) return;
    this.patchSummary(noteId, {
      actions: s.actions.map((a, i) => (i === index ? { ...a, keep: !a.keep } : a)),
    });
  }

  /** How many action items are currently checked. */
  keptActions(noteId: number): SummaryAction[] {
    return (this.summaries()[noteId]?.actions ?? []).filter((a) => a.keep);
  }

  /**
   * Add the checked action items to a chosen list via the existing add-item endpoint (one call per item).
   * Updates the picked list locally so a later "Add to a list" reflects it. Degrades to a status line.
   */
  async addActionsToList(note: FamilyNote, list: FamilyList): Promise<void> {
    const s = this.summaries()[note.id];
    if (!s || s.acting) return;
    const chosen = s.actions.filter((a) => a.keep);
    if (chosen.length === 0) return;
    this.patchSummary(note.id, {
      acting: true,
      status: `Adding ${chosen.length} to “${list.name}”…`,
    });

    let updated: FamilyList | null = null;
    let added = 0,
      failed = 0;
    for (const a of chosen) {
      try {
        updated = await firstValueFrom(this.api.addFamilyListItem(list.id, a.text));
        added++;
      } catch {
        failed++;
      }
    }
    if (updated) {
      const fresh = updated;
      this.lists.update((all) => all.map((l) => (l.id === fresh.id ? fresh : l)));
    }
    this.patchSummary(note.id, {
      acting: false,
      status:
        failed === 0
          ? `Added ${added} to “${list.name}”.`
          : `Added ${added} to “${list.name}”; ${failed} couldn't be added.`,
    });
    if (added > 0)
      this.snack.open(`Added ${added} item${added === 1 ? '' : 's'} to ${list.name}.`, undefined, {
        duration: 2500,
      });
  }

  /**
   * Make reminders from the checked action items: feed each item's text (+ its natural due phrase, when the
   * note implied one) through the slice-1 reminder parser, then create the proposed reminder(s) via the
   * existing create endpoint. Nothing is created until parsing succeeds. Degrades gracefully to a status line.
   */
  async makeReminders(note: FamilyNote): Promise<void> {
    const s = this.summaries()[note.id];
    if (!s || s.acting) return;
    const chosen = s.actions.filter((a) => a.keep);
    if (chosen.length === 0) return;
    this.patchSummary(note.id, {
      acting: true,
      status: `Scheduling ${chosen.length} reminder${chosen.length === 1 ? '' : 's'}…`,
    });

    let created = 0,
      failed = 0;
    for (const a of chosen) {
      // Combine the action with its due phrase so the slice-1 parser resolves the time in the household zone.
      const phrase = a.duePhrase ? `${a.text} ${a.duePhrase}` : a.text;
      try {
        const parsed = await firstValueFrom(this.api.parseReminderAi(phrase));
        const proposals = parsed.reminders ?? [];
        if (proposals.length === 0) {
          failed++;
          continue;
        }
        for (const p of proposals) {
          await firstValueFrom(
            this.api.createFamilyReminder({
              text: p.text,
              dueUtc: p.dueUtc,
              recurrence: p.recurrence,
            }),
          );
          created++;
        }
      } catch (e) {
        // A 503 from the parser means AI is down — stop early with a clear message rather than hammering it.
        if ((e as { status?: number })?.status === 503) {
          this.patchSummary(note.id, {
            acting: false,
            status:
              "Reminders aren't available right now — try again later, or add them on the Reminders page.",
          });
          return;
        }
        failed++;
      }
    }
    this.patchSummary(note.id, {
      acting: false,
      status:
        failed === 0
          ? `Created ${created} reminder${created === 1 ? '' : 's'} — they'll arrive in your notifications.`
          : `Created ${created}; ${failed} couldn't be scheduled.`,
    });
    if (created > 0)
      this.snack.open(`Added ${created} reminder${created === 1 ? '' : 's'}.`, undefined, {
        duration: 2500,
      });
  }

  private confirm(data: ConfirmData): Promise<boolean | undefined> {
    const ref = this.dialog.open<FamilyConfirmDialog, ConfirmData, boolean>(FamilyConfirmDialog, {
      data,
      width: '420px',
      maxWidth: '92vw',
      panelClass: 'family-dialog',
    });
    return firstValueFrom(ref.afterClosed());
  }

  private messageOf(e: unknown, fallback: string): string {
    const msg = (e as { error?: { message?: string } })?.error?.message;
    return typeof msg === 'string' && msg ? msg : fallback;
  }

  /** First three share targets for the avatar stack; the rest collapse into a "+N". */
  visibleShares(shares: FamilyShareTarget[]): FamilyShareTarget[] {
    return shares.slice(0, 3);
  }
  extraShares(shares: FamilyShareTarget[]): number {
    return Math.max(0, shares.length - 3);
  }
}
