import { ChangeDetectionStrategy, Component, inject, input, signal } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatDialog } from '@angular/material/dialog';
import { firstValueFrom } from 'rxjs';

import { Api } from '../../core/api';
import {
  AskActAction,
  CalendarEventInput,
  TrackerProfileDto,
  TrackerGoal,
  ActivityLevel,
} from '../../core/models';
import {
  EventEditorData,
  EventEditorDialog,
  EventEditorResult,
} from '../family/event-editor-dialog';
import { GoalConfirmData, GoalConfirmDialog, GoalConfirmResult } from './goal-confirm-dialog';

/** The execution status of a single proposed action card (idle → running → done | error). */
type ActionStatus = 'idle' | 'running' | 'done' | 'error';

/** One proposed action plus its live UI state (status + a short result/error line). */
interface ActionCard {
  action: AskActAction;
  status: ActionStatus;
  /** A short success/error line shown under the chip once it has been clicked. */
  note: string;
}

/**
 * "ASK THAT ACTS" — the confirm-chip ACTION stack shown UNDER each Ask answer bubble. A CLONE of the Family
 * Assistant panel's per-card lifecycle: the parent passes the answer's `actions` (server-issued, clamped),
 * we render one idle CARD per action, and NOTHING is written on propose. A card writes ONLY on its own click,
 * via the matching EXISTING owner/household-scoped Api.* write ({@link Api.executeAskAction} re-validates the
 * type against the frozen allow-list first). Two types open a PREFILLED REVIEW DIALOG before writing and are
 * never silent: `calendar_event` (the EventEditorDialog → the user's real Google Calendar) and `goal_tweak`
 * (a prefilled goal-confirm → the tracker profile). A dismissed dialog returns the card to idle (no error).
 * Per-card running/done/error + retry; the parent already degraded to answer-only when `actions` is empty.
 */
@Component({
  selector: 'app-ask-actions',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule],
  templateUrl: './ask-actions.html',
  styleUrl: './ask-actions.scss',
})
export class AskActions {
  private api = inject(Api);
  private dialog = inject(MatDialog);

  /** The answer's proposed actions (bound by the parent: `[actions]`). Empty ⇒ this renders nothing. */
  readonly actions = input<AskActAction[]>([]);

  /** The per-card live state, seeded once from the input and mutated in place on click. */
  readonly cards = signal<ActionCard[]>([]);

  constructor() {
    // Seed the cards from the (immutable) input exactly once — actions never change after the answer lands.
    queueMicrotask(() => {
      this.cards.set((this.actions() ?? []).map(action => ({ action, status: 'idle' as const, note: '' })));
    });
  }

  /** Execute one proposed action card via the matching EXISTING write flow. Only runs on the user's click. */
  async run(card: ActionCard): Promise<void> {
    if (card.status === 'running' || card.status === 'done') return;
    this.patchCard(card, { status: 'running', note: '' });
    try {
      const note = await this.execute(card.action);
      this.patchCard(card, { status: 'done', note });
    } catch (e) {
      if (e instanceof DialogDismissed) {
        // The user closed the review dialog without saving — return the card to actionable, no error shown.
        this.patchCard(card, { status: 'idle', note: '' });
        return;
      }
      this.patchCard(card, {
        status: 'error',
        note: this.messageOf(e, "Couldn't do that just now — please try again."),
      });
    }
  }

  // ---- Action execution: each maps to an EXISTING write (the AI created nothing) ----

  private async execute(action: AskActAction): Promise<string> {
    // The two dialog types open a PREFILLED review FIRST (never silent), then write on confirm. Every other
    // type is delegated to Api.executeAskAction, which re-validates the type against the frozen allow-list.
    if (action.type === 'calendar_event') return this.execCalendarEvent(action);
    if (action.type === 'goal_tweak') return this.execGoalTweak(action);
    await firstValueFrom(this.api.executeAskAction(action));
    return this.successNote(action.type);
  }

  /**
   * calendar_event: open the event editor PREFILLED so the user reviews + saves (calendar writes go to the
   * user's real Google Calendar, so we never create silently). On save we POST via the existing createEvent.
   */
  private async execCalendarEvent(action: AskActAction): Promise<string> {
    const p = action.params ?? {};
    const startLocal = this.str(p['startLocal']);
    const data: EventEditorData = {
      event: null,
      seedTitle: this.str(p['title']),
      seedAllDay: this.bool(p['allDay']),
      seedLocation: this.str(p['location']) || null,
      seedDescription: this.str(p['notes']) || null,
    };
    // A bare date → seedDate (the editor defaults a sensible time); a datetime → seedStart/EndUtc.
    if (startLocal) {
      if (startLocal.length <= 10) {
        data.seedDate = startLocal;
      } else {
        data.seedStartUtc = this.localToUtcIso(startLocal) ?? undefined;
        const endUtc = this.localToUtcIso(this.str(p['endLocal']));
        if (endUtc) data.seedEndUtc = endUtc;
      }
    }

    const ref = this.dialog.open<EventEditorDialog, EventEditorData, EventEditorResult>(
      EventEditorDialog,
      { data, width: '460px', maxWidth: '94vw', autoFocus: false, panelClass: 'family-dialog' },
    );
    const result = await firstValueFrom(ref.afterClosed());
    if (!result || result.kind !== 'save') throw new DialogDismissed();
    const input: CalendarEventInput = result.input;
    await firstValueFrom(this.api.createEvent(input));
    return 'Added to your calendar.';
  }

  /**
   * goal_tweak: PREFILL a goal-confirm dialog from the current profile + the proposed change, then PUT the
   * merged profile only on confirm (a goal change is consequential, so it's never silent). A dismiss leaves
   * the card idle. The proposed values are the lowercased forms; we map them onto the profile enums.
   */
  private async execGoalTweak(action: AskActAction): Promise<string> {
    const p = action.params ?? {};
    const current = await firstValueFrom(this.api.trackerProfile());

    const goal = MAP_GOAL[this.str(p['goal']).toLowerCase()] ?? null;
    const activity = MAP_ACTIVITY[this.str(p['activityLevel']).toLowerCase()] ?? null;
    const targetKg = this.num(p['targetWeightKg']);
    const goalWeightKg = targetKg > 0 ? Math.round(Math.min(500, targetKg) * 10) / 10 : null;

    if (goal == null && activity == null && goalWeightKg == null) {
      throw new Error('Nothing to change.');
    }

    const ref = this.dialog.open<GoalConfirmDialog, GoalConfirmData, GoalConfirmResult>(
      GoalConfirmDialog,
      {
        data: { current, proposedGoal: goal, proposedActivity: activity, proposedGoalWeightKg: goalWeightKg },
        width: '440px',
        maxWidth: '94vw',
        autoFocus: false,
        panelClass: 'family-dialog',
      },
    );
    const result = await firstValueFrom(ref.afterClosed());
    if (!result || result.kind !== 'save') throw new DialogDismissed();

    // Build the saved profile from the CURRENT one + only the confirmed deltas (everything else unchanged).
    const next: TrackerProfileDto = { ...current };
    if (goal != null) next.goal = goal;
    if (activity != null) next.activityLevel = activity;
    if (goalWeightKg != null) next.goalWeightKg = goalWeightKg;
    await firstValueFrom(this.api.saveTrackerProfile(next));
    return 'Goal updated.';
  }

  // ---- Helpers ----

  /** A friendly icon for each action type (the confirm-card glyph). */
  iconFor(type: AskActAction['type']): string {
    switch (type) {
      case 'calendar_event': return 'event';
      case 'grocery_add': return 'add_shopping_cart';
      case 'meal': return 'restaurant';
      case 'goal_tweak': return 'flag';
      case 'tracker_log': return 'check_circle';
      case 'reminder': return 'notifications_active';
      case 'timer': return 'timer';
      case 'note': return 'sticky_note_2';
    }
  }

  /** The primary button label per action type (the verb the click performs). */
  buttonLabel(type: AskActAction['type']): string {
    switch (type) {
      case 'calendar_event': return 'Add to calendar';
      case 'grocery_add': return 'Add to groceries';
      case 'meal': return 'Add meal';
      case 'goal_tweak': return 'Update goal';
      case 'tracker_log': return 'Log it';
      case 'reminder': return 'Set reminder';
      case 'timer': return 'Start timer';
      case 'note': return 'Save note';
    }
  }

  /** The success line shown on a card once a non-dialog write lands (the dialog types return their own). */
  private successNote(type: AskActAction['type']): string {
    switch (type) {
      case 'grocery_add': return 'Added to your groceries.';
      case 'meal': return 'Added to the meal plan.';
      case 'tracker_log': return 'Logged.';
      case 'reminder': return 'Reminder set.';
      case 'timer': return 'Timer started.';
      case 'note': return 'Note saved.';
      default: return 'Done.';
    }
  }

  private str(v: unknown): string {
    return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
  }

  private num(v: unknown): number {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  private bool(v: unknown): boolean {
    return v === true || v === 'true';
  }

  /** Convert an offset-less LOCAL ISO string ("2026-06-23T15:00:00" or "2026-06-23") to a UTC ISO instant, or null. */
  private localToUtcIso(local: string): string | null {
    const s = (local || '').trim();
    if (!s) return null;
    const d = new Date(s.length <= 10 ? `${s}T00:00:00` : s);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  /**
   * Update a card's live state. We mutate the SAME card object (so a follow-up click on the same reference
   * reads fresh status) and re-emit the array as a new reference so the OnPush template re-renders.
   */
  private patchCard(card: ActionCard, patch: Partial<ActionCard>): void {
    Object.assign(card, patch);
    this.cards.update(c => [...c]);
  }

  /** Best-effort friendly message from an HttpErrorResponse, else a fallback. */
  private messageOf(e: unknown, fallback: string): string {
    if (e instanceof DialogDismissed) return '';
    const err = e as { status?: number; error?: { message?: string; detail?: string } };
    if (err?.status === 503) return "The assistant isn't available right now. You can do this manually.";
    if (err?.status === 400) return err.error?.message ?? 'That input needs a tweak.';
    return err?.error?.detail ?? err?.error?.message ?? (e instanceof Error ? e.message : fallback);
  }
}

/** Sentinel: the user dismissed a review dialog — not a failure, just "not done yet" (card stays idle). */
class DialogDismissed extends Error {}

/** Map the model's lowercased goal token → the profile's TrackerGoal enum name. */
const MAP_GOAL: Readonly<Record<string, TrackerGoal>> = {
  lose: 'LoseWeight',
  maintain: 'Maintain',
  gain: 'GainMuscle',
};

/** Map the model's lowercased activity token → the profile's ActivityLevel enum name. */
const MAP_ACTIVITY: Readonly<Record<string, ActivityLevel>> = {
  sedentary: 'Sedentary',
  light: 'Light',
  moderate: 'Moderate',
  active: 'Active',
  very_active: 'VeryActive',
};
