import { Component, computed, inject, input, signal, ChangeDetectionStrategy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';

import { MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';

import { Api } from '../../core/api';
import {
  CalendarEventInput,
  FamilyAssistantAction,
  FamilyAssistantResult,
  FamilyList,
  Household,
} from '../../core/models';
import { EventEditorData, EventEditorDialog, EventEditorResult } from './event-editor-dialog';

/** The execution status of a single proposed action card. */
type ActionStatus = 'idle' | 'running' | 'done' | 'error';

/** One proposed action plus its live UI state (status + a short result/error line). */
interface ActionCard {
  action: FamilyAssistantAction;
  status: ActionStatus;
  /** A short success/error line shown under the button once it has been clicked. */
  note: string;
}

/** One turn in the visible (session-only, not persisted) exchange history. */
interface Exchange {
  id: number;
  /** The user's question for this turn. */
  question: string;
  /** The warm answer (aria-live announces the latest). */
  answer: string;
  /** The proposed action cards for this turn (each independently executable). */
  cards: ActionCard[];
}

/**
 * The "✨ Family Assistant" panel on the Family home. One ask-anything box over the whole household: the user
 * types ("what's for dinner and what chores does Lily have? add milk to groceries and remind me to call the
 * dentist Tuesday"), we POST /api/family/assistant, then render the warm ANSWER (announced via aria-live) and
 * 0..6 proposed ACTION cards. Nothing writes until the user clicks an action — and then via the EXISTING
 * write endpoint (list_add / reminder / timer / calendar_event / chore / meal), never the assistant. A short
 * visible history of the exchange is kept in the session (no persistence). Graceful on a 503 (assistant
 * unavailable → the user can act manually) and per-card on a write failure (inline error, retryable).
 *
 * The household is passed in so list_add / chore can resolve a list name / assignee NAME against real data.
 */
@Component({
  selector: 'app-family-assistant-panel',
  imports: [
    FormsModule,
    MatIconModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatProgressSpinnerModule,
  ],
  templateUrl: './family-assistant-panel.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrls: ['./family.scss', './family-assistant-panel.scss'],
})
export class FamilyAssistantPanel {
  private api = inject(Api);
  private dialog = inject(MatDialog);

  /** The household (for resolving the chore assignee NAME to a member userId). Bound by the parent: `[home]`. */
  readonly household = input<Household | null>(null, { alias: 'home' });

  readonly draft = signal('');
  readonly asking = signal(false);
  /** A panel-level error (e.g. the assistant is unavailable / a network blip). Per-card errors live on the card. */
  readonly error = signal<string | null>(null);

  /** The session-only exchange history, newest LAST (rendered top-to-bottom, the latest answer announced). */
  readonly history = signal<Exchange[]>([]);

  private nextId = 1;

  readonly canAsk = computed(() => this.draft().trim().length > 0 && !this.asking());

  /** The most recent answer text — bound to the aria-live region so screen readers announce it. */
  readonly latestAnswer = computed(() => {
    const h = this.history();
    return h.length ? h[h.length - 1].answer : '';
  });

  /** Ask the assistant. Appends a new exchange on success; surfaces a graceful message on failure. */
  async ask(): Promise<void> {
    if (!this.canAsk()) return;
    const question = this.draft().trim();
    this.asking.set(true);
    this.error.set(null);
    try {
      const res: FamilyAssistantResult = await firstValueFrom(this.api.familyAssistant(question));
      const cards: ActionCard[] = (res.actions ?? []).map((action) => ({
        action,
        status: 'idle',
        note: '',
      }));
      this.history.update((h) => [
        ...h,
        {
          id: this.nextId++,
          question,
          answer: res.answer ?? '',
          cards,
        },
      ]);
      this.draft.set('');
    } catch (e) {
      this.error.set(this.messageOf(e));
    } finally {
      this.asking.set(false);
    }
  }

  /** Ctrl/Cmd+Enter submits from the textarea (Enter alone makes a newline, so multi-line asks are easy). */
  onKeydown(ev: KeyboardEvent): void {
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      void this.ask();
    }
  }

  /** Execute one proposed action card via the matching EXISTING write flow. Only runs on the user's click. */
  async run(card: ActionCard): Promise<void> {
    if (card.status === 'running' || card.status === 'done') return;
    this.patchCard(card, { status: 'running', note: '' });
    try {
      const note = await this.execute(card.action);
      this.patchCard(card, { status: 'done', note });
    } catch (e) {
      if (e instanceof EventEditorDismissed) {
        // The user closed the calendar editor without saving — return the card to actionable, no error shown.
        this.patchCard(card, { status: 'idle', note: '' });
        return;
      }
      this.patchCard(card, {
        status: 'error',
        note: this.messageOf(e, "Couldn't do that just now — please try again."),
      });
    }
  }

  // ---- Action execution: each maps to an EXISTING write endpoint (the assistant created nothing) ----

  private async execute(action: FamilyAssistantAction): Promise<string> {
    switch (action.type) {
      case 'list_add':
        return this.execListAdd(action.params.listName, action.params.items);
      case 'reminder':
        return this.execReminder(action.params.text, action.params.whenLocal);
      case 'timer':
        return this.execTimer(action.params.label, action.params.durationSeconds);
      case 'calendar_event':
        return this.execCalendarEvent(action.params);
      case 'chore':
        return this.execChore(
          action.params.title,
          action.params.points,
          action.params.recurrence,
          action.params.assigneeName,
        );
      case 'meal':
        return this.execMeal(
          action.params.title,
          action.params.ingredients,
          action.params.mealDateLocal,
        );
    }
  }

  /** list_add: find the list by name (case-insensitive), creating a shopping list if missing, then add items. */
  private async execListAdd(listName: string, items: string[]): Promise<string> {
    const name = (listName || '').trim();
    const toAdd = (items ?? []).map((i) => i.trim()).filter(Boolean);
    if (!name || toAdd.length === 0) throw new Error('Nothing to add.');

    const lists = await firstValueFrom(this.api.familyLists());
    let list: FamilyList | undefined = lists.find(
      (l) => l.name.trim().toLowerCase() === name.toLowerCase(),
    );
    if (!list) {
      // No list by that name — create one. A "groceries/shopping" name nudges a shopping list; else a to-do.
      const kind = /shop|grocer|market|store/i.test(name) ? 'shopping' : 'todo';
      list = await firstValueFrom(this.api.createFamilyList(name, kind));
    }
    for (const text of toAdd) {
      await firstValueFrom(this.api.addFamilyListItem(list.id, text));
    }
    const n = toAdd.length;
    return `Added ${n} ${n === 1 ? 'item' : 'items'} to ${list.name}.`;
  }

  /** reminder: createFamilyReminder. An empty whenLocal defaults to one hour from now (so it's still useful). */
  private async execReminder(text: string, whenLocal: string): Promise<string> {
    const t = (text || '').trim();
    if (!t) throw new Error('No reminder text.');
    const due =
      this.localToUtcIso(whenLocal) ?? new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await firstValueFrom(
      this.api.createFamilyReminder({ text: t, dueUtc: due, recurrence: 'none' }),
    );
    return 'Reminder set.';
  }

  /** timer: createFamilyTimer (durationSeconds already clamped server-side). */
  private async execTimer(label: string, durationSeconds: number): Promise<string> {
    const seconds = Math.max(5, Math.min(86400, Math.round(durationSeconds || 0)));
    await firstValueFrom(
      this.api.createFamilyTimer({ label: (label || 'Timer').trim(), durationSeconds: seconds }),
    );
    return 'Timer started.';
  }

  /**
   * calendar_event: open the event editor PREFILLED so the user reviews + saves (calendar writes go to the
   * user's real Google Calendar, so we never create silently). On save we POST via the existing createEvent.
   */
  private async execCalendarEvent(p: {
    title: string;
    startLocal: string;
    endLocal: string;
    allDay: boolean;
    location: string;
    notes: string;
  }): Promise<string> {
    const data: EventEditorData = {
      event: null,
      seedTitle: p.title,
      seedAllDay: p.allDay,
      seedLocation: p.location || null,
      seedDescription: p.notes || null,
    };
    // Seed the timing: a bare date → seedDate (the editor defaults a sensible time); a datetime → seedStart/EndUtc.
    if (p.startLocal) {
      if (p.startLocal.length <= 10) {
        data.seedDate = p.startLocal;
      } else {
        data.seedStartUtc = this.localToUtcIso(p.startLocal) ?? undefined;
        const endUtc = p.endLocal ? this.localToUtcIso(p.endLocal) : null;
        if (endUtc) data.seedEndUtc = endUtc;
      }
    }

    const ref = this.dialog.open<EventEditorDialog, EventEditorData, EventEditorResult>(
      EventEditorDialog,
      { data, width: '460px', maxWidth: '94vw', autoFocus: false, panelClass: 'family-dialog' },
    );
    const result = await firstValueFrom(ref.afterClosed());
    if (!result || result.kind !== 'save') {
      // The user dismissed the editor — leave the card actionable (idle) rather than "done".
      throw new EventEditorDismissed();
    }
    const input: CalendarEventInput = result.input;
    await firstValueFrom(this.api.createEvent(input));
    return 'Added to your calendar.';
  }

  /** chore: createFamilyChore. Resolve the assignee NAME to a household member; unknown/blank → unassigned. */
  private async execChore(
    title: string,
    points: number,
    recurrence: 'none' | 'daily' | 'weekly',
    assigneeName: string,
  ): Promise<string> {
    const t = (title || '').trim();
    if (!t) throw new Error('No chore title.');
    const assignedToUserId = this.resolveMemberId(assigneeName);
    await firstValueFrom(
      this.api.createFamilyChore({
        title: t,
        points: Math.max(0, Math.round(points || 0)),
        recurrence: recurrence || 'none',
        assignedToUserId,
      }),
    );
    const who = assignedToUserId != null ? this.memberName(assignedToUserId) : null;
    return who ? `Chore added for ${who}.` : 'Chore added.';
  }

  /** meal: createFamilyMeal. A bare local date (or today) + dinner slot (the assistant doesn't pick a slot). */
  private async execMeal(
    title: string,
    ingredients: string,
    mealDateLocal: string,
  ): Promise<string> {
    const t = (title || '').trim();
    if (!t) throw new Error('No meal title.');
    const localDate =
      (mealDateLocal && mealDateLocal.length >= 8 ? mealDateLocal.slice(0, 10) : '') ||
      this.todayLocalDate();
    await firstValueFrom(
      this.api.createFamilyMeal({
        localDate,
        slot: 'dinner',
        title: t,
        ingredients: (ingredients || '').trim() || undefined,
      }),
    );
    return 'Added to the meal plan.';
  }

  // ---- Helpers ----

  /** Resolve a display name to a household member's userId (case-insensitive); null when blank/unknown. */
  private resolveMemberId(name: string): number | null {
    const n = (name || '').trim().toLowerCase();
    if (!n) return null;
    const members = this.household()?.members ?? [];
    const exact = members.find((m) => m.name.trim().toLowerCase() === n);
    if (exact) return exact.userId;
    // A first-name match ("Lily" against "Lily Fortunato") so the assistant's short name still lands.
    const partial = members.find((m) => m.name.trim().toLowerCase().split(/\s+/)[0] === n);
    return partial?.userId ?? null;
  }

  private memberName(userId: number): string | null {
    return this.household()?.members.find((m) => m.userId === userId)?.name ?? null;
  }

  /** Convert an offset-less LOCAL ISO string ("2026-06-23T15:00:00" or "2026-06-23") to a UTC ISO instant, or null. */
  private localToUtcIso(local: string): string | null {
    const s = (local || '').trim();
    if (!s) return null;
    // A bare date → local midnight; a datetime is parsed in the browser's local zone (no offset = local).
    const d = new Date(s.length <= 10 ? `${s}T00:00:00` : s);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  /** Today's local "YYYY-MM-DD" (browser zone). */
  private todayLocalDate(): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  /** A friendly icon for each action type (the confirm card glyph). */
  iconFor(type: FamilyAssistantAction['type']): string {
    switch (type) {
      case 'list_add':
        return 'add_shopping_cart';
      case 'reminder':
        return 'notifications_active';
      case 'timer':
        return 'timer';
      case 'calendar_event':
        return 'event';
      case 'chore':
        return 'cleaning_services';
      case 'meal':
        return 'restaurant';
    }
  }

  /** The primary button label per action type (the verb the click performs). */
  buttonLabel(type: FamilyAssistantAction['type']): string {
    switch (type) {
      case 'list_add':
        return 'Add to list';
      case 'reminder':
        return 'Set reminder';
      case 'timer':
        return 'Start timer';
      case 'calendar_event':
        return 'Add to calendar';
      case 'chore':
        return 'Add chore';
      case 'meal':
        return 'Add meal';
    }
  }

  /**
   * Update a card's live state. We mutate the SAME card object (so a follow-up click on the same reference
   * reads fresh status) and re-emit the history as a new array reference so the signal-driven template
   * re-renders. Card identity is preserved across updates — `run()` holds the very object that's in the array.
   */
  private patchCard(card: ActionCard, patch: Partial<ActionCard>): void {
    Object.assign(card, patch);
    this.history.update((h) => [...h]);
  }

  /** Best-effort friendly message from an HttpErrorResponse (503 = assistant unavailable), else a fallback. */
  private messageOf(
    e: unknown,
    fallback = "The assistant isn't available right now. You can do this manually.",
  ): string {
    if (e instanceof EventEditorDismissed) return '';
    const err = e as { status?: number; error?: { message?: string; detail?: string } };
    if (err?.status === 403)
      // Permanently unavailable for this user (no family.ai.assistant) — never leak the raw ProblemDetails.
      return "The family assistant isn't available on your account.";
    if (err?.status === 503)
      return "The assistant isn't available right now. You can do this manually.";
    if (err?.status === 400)
      return err.error?.message ?? 'Type a message for your family assistant.';
    return err?.error?.detail ?? err?.error?.message ?? fallback;
  }
}

/** Sentinel: the user dismissed the calendar editor — not a failure, just "not done yet" (card stays idle). */
class EventEditorDismissed extends Error {}
