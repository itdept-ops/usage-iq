import {
  ChangeDetectionStrategy, Component, ElementRef, computed, inject, input, output, signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';

import {
  confirmVoiceNotice, recordTranscript, speechSupported, type VoiceRecording,
} from '../../tracker/voice-capture';

/**
 * ASK BETA composer — the sticky bottom glass bar of the "Ask my life" chat. A self-growing textarea
 * (Enter submits, Shift+Enter newlines), a gradient SEND button, and — only when the browser exposes
 * on-device speech-to-text — a MIC affordance that dictates into the box (audio never leaves the device;
 * we reuse the tracker's {@link recordTranscript} helper, one-time privacy notice and all).
 *
 * Dumb-ish: it owns only its own text + transient mic state; the parent owns the transcript, in-flight
 * state and the actual ask. Reads --accent-a/--accent-b + glass tokens off the beta-kit host cascade.
 *
 *   selector: app-ask-composer
 *   inputs:   busy (boolean — a question is in flight; disables the box + swaps send → spinner glyph)
 *   outputs:  send (string — a trimmed, non-empty question to ask)
 */
@Component({
  selector: 'app-ask-composer',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MatIconModule],
  template: `
    <form class="cmp" (submit)="$event.preventDefault(); fire()">
      @if (listening()) {
        <span class="cmp__live" aria-hidden="true">
          <span class="cmp__pulse"></span> Listening…
        </span>
      }

      <textarea
        #box
        class="cmp__input"
        [(ngModel)]="text"
        name="q"
        rows="1"
        [placeholder]="listening() ? 'Speak now…' : 'Ask about your life…'"
        aria-label="Ask a question about your life"
        maxlength="1000"
        [disabled]="busy()"
        (input)="autogrow()"
        (keydown)="onKeydown($event)"></textarea>

      <div class="cmp__actions">
        @if (micAvailable) {
          <button
            type="button"
            class="cmp__mic"
            [class.cmp__mic--on]="listening()"
            [disabled]="busy()"
            [attr.aria-pressed]="listening()"
            [attr.aria-label]="listening() ? 'Stop dictation' : 'Dictate your question'"
            (click)="toggleMic()">
            <mat-icon aria-hidden="true">{{ listening() ? 'stop' : 'mic' }}</mat-icon>
          </button>
        }

        <button
          type="submit"
          class="cmp__send"
          [disabled]="!canSend()"
          aria-label="Ask">
          @if (busy()) {
            <span class="cmp__send-spin" aria-hidden="true"></span>
          } @else {
            <mat-icon aria-hidden="true">arrow_upward</mat-icon>
          }
        </button>
      </div>
    </form>
  `,
  styleUrl: './ask-composer.scss',
})
export class AskComposer {
  /** True while a question is in flight: disable the box + show the send spinner. */
  readonly busy = input<boolean>(false);
  /** A trimmed, non-empty question to ask. */
  readonly send = output<string>();
  /** Dictation started (true) / stopped (false) — so the parent can announce it on the page live region. */
  readonly listeningChange = output<boolean>();

  private readonly box = viewChild.required<ElementRef<HTMLTextAreaElement>>('box');

  /** The composer text (two-way bound to the textarea). */
  readonly text = signal('');
  /** True while the mic is open and dictating into the box. */
  readonly listening = signal(false);

  /** Whether to render the mic at all — only when the browser can transcribe on-device. */
  readonly micAvailable = speechSupported();

  /** Can we fire? Non-empty + idle + not mid-dictation. */
  readonly canSend = computed(() => this.text().trim().length > 0 && !this.busy() && !this.listening());

  private recording: VoiceRecording | null = null;

  /** Fire the question (trims + guards empty/in-flight), then clears + resets the box height. */
  fire(): void {
    const q = this.text().trim();
    if (q.length === 0 || this.busy() || this.listening()) return;
    this.send.emit(q);
    this.text.set('');
    queueMicrotask(() => this.resetHeight());
  }

  /** Enter submits; Shift+Enter inserts a newline. */
  onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.fire();
    }
  }

  /** Grow the textarea to fit its content, capped by the CSS max-height. */
  autogrow(): void {
    const el = this.box().nativeElement;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }

  private resetHeight(): void {
    this.box().nativeElement.style.height = 'auto';
  }

  /** Toggle on-device dictation. First use shows the one-time privacy notice. */
  async toggleMic(): Promise<void> {
    if (this.busy()) return;
    if (this.listening()) {
      this.recording?.stop();
      return;
    }
    if (!(await confirmVoiceNotice())) return;
    if (!speechSupported()) return;

    let session: { recording: VoiceRecording; done: Promise<{ text: string } | null> };
    try {
      session = recordTranscript((interim) => this.text.set(interim));
    } catch {
      return;
    }
    this.recording = session.recording;
    this.listening.set(true);
    this.listeningChange.emit(true);
    try {
      const result = await session.done;
      if (result?.text) {
        this.text.set(result.text);
        queueMicrotask(() => this.autogrow());
      }
    } catch {
      // Permission/hardware error — the box keeps whatever interim text landed; user can type.
    } finally {
      this.listening.set(false);
      this.listeningChange.emit(false);
      this.recording = null;
    }
  }
}
