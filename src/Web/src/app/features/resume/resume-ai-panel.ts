import {
  Component,
  ChangeDetectionStrategy,
  inject,
  input,
  signal,
  ViewChild,
  ElementRef,
  AfterViewChecked,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';

import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';

import { Api } from '../../core/api';
import { ResumeData, ResumeChatMessage } from '../../core/models';

/**
 * The resume AI assistant — a chat panel that interviews the user section-by-section and answers questions,
 * grounded in the live master resume data (passed in via `data`) and an optional job context. Posts the full
 * history to POST /api/resume/ai/chat. 503-graceful: a friendly inline notice, the conversation is preserved.
 */
@Component({
  selector: 'app-resume-ai-panel',
  imports: [FormsModule, MatIconModule, MatButtonModule, MatProgressSpinnerModule, MatTooltipModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './resume-ai-panel.html',
  styleUrl: './resume-ai-panel.scss',
})
export class ResumeAiPanel implements AfterViewChecked {
  private api = inject(Api);

  /** Live master resume data, used as grounding context for every turn. */
  readonly data = input<ResumeData | null>(null);
  /** Optional job context (e.g. a target job description) to focus the assistant. */
  readonly jobContext = input<string | null>(null);

  readonly messages = signal<ResumeChatMessage[]>([]);
  readonly draft = signal('');
  readonly sending = signal(false);
  readonly unavailable = signal(false);

  @ViewChild('scroller') private scroller?: ElementRef<HTMLDivElement>;
  private shouldScroll = false;

  /** A few starter prompts to make the blank state useful. */
  readonly suggestions = [
    'Interview me to build my resume from scratch',
    'How can I make my summary stronger?',
    'What is missing from my experience section?',
    'Suggest skills for my target role',
  ];

  ngAfterViewChecked(): void {
    if (this.shouldScroll && this.scroller) {
      this.scroller.nativeElement.scrollTop = this.scroller.nativeElement.scrollHeight;
      this.shouldScroll = false;
    }
  }

  use(suggestion: string): void {
    this.draft.set(suggestion);
    void this.send();
  }

  async send(): Promise<void> {
    const text = this.draft().trim();
    if (!text || this.sending()) return;

    const history = [...this.messages(), { role: 'user', content: text } as ResumeChatMessage];
    this.messages.set(history);
    this.draft.set('');
    this.sending.set(true);
    this.unavailable.set(false);
    this.shouldScroll = true;

    try {
      const res = await firstValueFrom(
        this.api.resumeChat({
          messages: history,
          data: this.data(),
          jobContext: this.jobContext() ?? null,
        }),
      );
      this.messages.update((m) => [...m, { role: 'assistant', content: res.reply }]);
      this.shouldScroll = true;
    } catch (err: unknown) {
      const status = (err as { status?: number })?.status;
      this.unavailable.set(status === 503);
      this.messages.update((m) => [
        ...m,
        {
          role: 'assistant',
          content:
            status === 503
              ? 'The AI assistant is not configured right now. You can still edit every section by hand.'
              : "Something went wrong reaching the assistant — please try again.",
        },
      ]);
      this.shouldScroll = true;
    } finally {
      this.sending.set(false);
    }
  }

  clear(): void {
    this.messages.set([]);
    this.unavailable.set(false);
  }
}
