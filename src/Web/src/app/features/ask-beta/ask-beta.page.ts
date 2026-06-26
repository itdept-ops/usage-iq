import {
  ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, signal, viewChild,
} from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { firstValueFrom } from 'rxjs';

import { Api } from '../../core/api';
import { AskResponse } from '../../core/models';
import { BetaPullRefresh, BetaToaster, ToastController } from '../beta-ui';

import { AskComposer } from './composer/ask-composer';

/** One turn in the session-local Q&A thread (rendered as a question + answer bubble pair). */
interface AskTurn {
  /** Monotonic id — stable @for track + per-bubble spring stagger. */
  id: number;
  /** The question the user asked (already trimmed). */
  question: string;
  /** The grounded answer (or the deterministic plain floor when `aiUsed` is false). */
  answer: string;
  /** False ⇒ the plain floor was returned because AI is off/unavailable (we badge it). */
  aiUsed: boolean;
  /** Which domains the snapshot drew on — chips under the answer. */
  domains: string[];
}

/** A seed prompt chip on the empty state — label + the question it asks. */
interface SuggestionChip {
  icon: string;
  label: string;
  question: string;
}

/**
 * Contextual follow-up chips offered UNDER the newest answer (reuse `askMyLife`). Each entry maps a
 * domain the snapshot drew on to a short, natural next question — so the chips deepen whatever the user
 * just asked about. The 'default' set covers the no-domain case. Order is display order; we cap at 3.
 */
const FOLLOW_UPS: Record<string, string[]> = {
  tracker: ['What should I eat next?', 'How many calories do I have left today?', 'How is my protein looking?'],
  sleep: ['How can I sleep better?', 'What was my best night this week?'],
  hard75: ["What's left to finish today?", 'How many days until I finish?'],
  bills: ['What do I owe right now?', 'Who still owes me?'],
  family: ["What's next on the calendar?", 'Any reminders I should know about?'],
  usage: ['How does that compare to last week?', 'Which model cost me the most?'],
  default: ['Tell me more', 'What should I focus on today?', 'Anything I should watch out for?'],
};

/** Friendly labels for the domain chips the server reports it drew on (mirrors the live page). */
const DOMAIN_LABEL: Record<string, string> = {
  tracker: 'Food & fitness',
  sleep: 'Sleep',
  hard75: '75 Hard',
  bills: 'Bills',
  family: 'Family',
  usage: 'Token usage',
};

/**
 * ASK BETA — "Ask my life", rebuilt as a full-screen, native-feel conversational AI chat on the shared
 * beta-ui "Strata" kit (`@use '../beta-ui/beta-kit'`). One signature accent — INDIGO (#818cf8 → #6366f1)
 * — re-skins the whole screen via the per-page accent contract. A full-bleed thread of question/answer
 * BUBBLES (user right, AI left with an accent avatar), a sticky glass COMPOSER (send + on-device mic), a
 * row of SUGGESTION CHIPS to seed the box, a "thinking" indicator while awaiting, and graceful empty
 * ("Ask me anything about your life") + error states. Pull-to-refresh clears the thread; bubbles spring
 * in on a stagger.
 *
 * DATA PARITY: every answer comes from the SAME `Api.askMyLife` endpoint + `AskResponse` DTO the live
 * `/ask` page uses — the server assembles the perm-filtered, caller-scoped snapshot and answers strictly
 * from it (answer-only, never writes). The endpoint always returns 200 and floors to a deterministic plain
 * summary (`aiUsed:false`) when AI is off; we badge that plainly. A real network failure shows a gentle
 * inline error with retry — never a dead-end.
 *
 * ISOLATION: gated by `beta.access` + `tracker.ai`; consumes the kit + the SAME read-only ask endpoint.
 * No live page is imported or modified; the flagship tracker-beta + the kit are consumed, never changed.
 */
@Component({
  selector: 'app-ask-beta',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [ToastController],
  imports: [MatIconModule, BetaPullRefresh, BetaToaster, AskComposer],
  templateUrl: './ask-beta.page.html',
  styleUrl: './ask-beta.page.scss',
})
export class AskBetaPage {
  private api = inject(Api);
  private toast = inject(ToastController);

  /** Session-local thread (oldest first; newest renders at the bottom and we auto-scroll). */
  readonly turns = signal<AskTurn[]>([]);
  /** True while a question is in flight (drives the thinking indicator + composer busy state). */
  readonly loading = signal(false);
  /** A gentle inline error (network failure only — the endpoint itself never 503s). The failed question. */
  readonly error = signal('');
  private lastFailed = '';
  /** sr-only live-region announcement. */
  readonly announce = signal('');

  private seq = 0;
  private readonly scrollAnchor = viewChild<ElementRef<HTMLElement>>('anchor');

  /** Seed prompts; tapping one asks it immediately. */
  readonly suggestions: SuggestionChip[] = [
    { icon: 'flag', label: "How am I doing on my goal?", question: "How am I doing on my goals?" },
    { icon: 'payments', label: 'What did I spend on AI this week?', question: 'How much have I spent on AI this week?' },
    { icon: 'restaurant', label: 'What should I eat?', question: 'What should I eat next to hit my goals today?' },
    { icon: 'bedtime', label: 'How has my sleep been?', question: 'How has my sleep been lately?' },
    { icon: 'fitness_center', label: "How's my 75 Hard going?", question: 'How is my 75 Hard challenge going?' },
    { icon: 'event', label: "What's on the calendar today?", question: "What's on the family calendar today?" },
  ];

  /** Whether the thread has any turns yet (drives the empty vs. thread layout). */
  readonly hasTurns = computed(() => this.turns().length > 0);

  /**
   * Up to 3 contextual follow-up questions shown under the NEWEST answer only — derived from the domains
   * that answer drew on (so they deepen the same topic), or a sensible default set. Empty while loading or
   * when there are no turns, so the chips never compete with the thinking indicator.
   */
  readonly followUps = computed<string[]>(() => {
    if (this.loading()) return [];
    const turns = this.turns();
    const last = turns[turns.length - 1];
    if (!last) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    const pools = last.domains.length ? last.domains.map(d => FOLLOW_UPS[d]).filter(Boolean) : [FOLLOW_UPS['default']];
    if (pools.length === 0) pools.push(FOLLOW_UPS['default']);
    // Round-robin one from each domain pool so a multi-domain answer gets a varied set.
    for (let i = 0; out.length < 3; i++) {
      let advanced = false;
      for (const pool of pools) {
        const q = pool[i];
        if (q && !seen.has(q)) { seen.add(q); out.push(q); advanced = true; if (out.length >= 3) break; }
      }
      if (!advanced) break;
    }
    return out;
  });

  constructor() {
    // Keep the newest bubble / thinking indicator in view as the thread grows.
    effect(() => {
      this.turns();
      this.loading();
      queueMicrotask(() =>
        this.scrollAnchor()?.nativeElement.scrollIntoView({ behavior: 'smooth', block: 'end' }),
      );
    });
  }

  /** Tap a suggestion chip → ask it. */
  askSuggestion(s: SuggestionChip): void {
    if (this.loading()) return;
    void this.ask(s.question);
  }

  /** Tap a contextual follow-up chip → ask it (same path as a typed question). */
  askFollowUp(question: string): void {
    if (this.loading()) return;
    void this.ask(question);
  }

  /** Copy an answer's text to the clipboard (best-effort; confirms via toast). */
  async copyAnswer(answer: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(answer);
      this.toast.show('Answer copied', { tone: 'success', durationMs: 1600 });
      this.announce.set('Answer copied to clipboard.');
    } catch {
      this.toast.show("Couldn't copy", { tone: 'neutral', durationMs: 1600 });
    }
  }

  /** Composer (send) → ask the typed question. */
  onSend(question: string): void {
    void this.ask(question);
  }

  /** Composer dictation toggled → announce it on the page's polite live region. */
  onListeningChange(listening: boolean): void {
    this.announce.set(listening ? 'Listening…' : 'Stopped listening.');
  }

  /**
   * Ask a question. Trims + guards empty/in-flight. On success appends the turn (grounded answer or plain
   * floor); on a network failure shows the inline error + remembers the question so "Try again" can retry.
   */
  async ask(raw: string): Promise<void> {
    const q = raw.trim();
    if (q.length === 0 || this.loading()) return;
    this.loading.set(true);
    this.error.set('');
    this.lastFailed = '';
    this.announce.set('Asking…');
    try {
      const res: AskResponse = await firstValueFrom(this.api.askMyLife(q));
      this.turns.update(t => [
        ...t,
        { id: ++this.seq, question: q, answer: res.answer, aiUsed: res.aiUsed, domains: res.domains ?? [] },
      ]);
      this.announce.set('Answer ready.');
    } catch {
      this.lastFailed = q;
      this.error.set("I couldn't reach the assistant just now.");
      this.announce.set('Something went wrong. Try again.');
    } finally {
      this.loading.set(false);
    }
  }

  /** Retry the last failed question. */
  retry(): void {
    if (this.lastFailed) void this.ask(this.lastFailed);
  }

  /** Pull-to-refresh: clear the thread back to the empty state (a fresh conversation). */
  clearThread(): void {
    if (this.turns().length === 0 && !this.error()) {
      this.toast.show('Nothing to clear', { tone: 'neutral', durationMs: 1400 });
      return;
    }
    this.turns.set([]);
    this.error.set('');
    this.lastFailed = '';
    this.announce.set('Conversation cleared.');
    this.toast.show('Conversation cleared', { tone: 'success', durationMs: 1800 });
  }

  /** Friendly label for a domain key (falls back to the raw key). */
  domainLabel(key: string): string {
    return DOMAIN_LABEL[key] ?? key;
  }
}
