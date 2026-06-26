import {
  ChangeDetectionStrategy, Component, computed, input, output, signal,
} from '@angular/core';

import { ChatMessageDto, ReactionGroupDto } from '../../core/models';

/**
 * One chat message rendered as an iMessage-feel BUBBLE. Mine = right-aligned accent-gradient bubble;
 * theirs = left-aligned glass bubble with a small sender avatar. Shows the body (or a muted
 * "deleted" placeholder), an edited tag, a clock-side timestamp on tap-reveal, and any emoji
 * reaction chips beneath. Long-press / context-menu / a dedicated react button bubbles a `react`
 * intent up to the page (which opens the kit BottomSheet emoji picker); tapping an existing chip
 * toggles that emoji directly. Pure presentational + tree-shakeable — it owns no data, no realtime.
 *
 *   selector: cb-bubble
 *   inputs:   msg (ChatMessageDto), mine (boolean), showAvatar (boolean — first in a run),
 *             showTail (boolean — last in a run, draws the tail), meUserId (number | null)
 *   outputs:  react (ChatMessageDto) — request the emoji picker for this message
 *             toggle ({ messageId, emoji }) — toggle an existing reaction chip
 */
@Component({
  selector: 'cb-bubble',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class.mine]': 'mine()',
    '[class.theirs]': '!mine()',
    '[class.tail]': 'showTail()',
  },
  template: `
    <!-- Their small avatar (only on the first bubble of a run, left side) -->
    @if (!mine()) {
      <div class="cb-ava" aria-hidden="true">
        @if (showAvatar()) {
          @if (msg().senderPicture; as pic) {
            <img class="cb-ava__img" [src]="pic" alt="" loading="lazy" referrerpolicy="no-referrer" />
          } @else {
            <span class="cb-ava__mono" [style.--h]="hue()">{{ initials() }}</span>
          }
        }
      </div>
    }

    <div class="cb-col">
      <!-- Their sender name above the first bubble in a run (channels feel; harmless in DMs) -->
      @if (!mine() && showAvatar()) { <span class="cb-name">{{ msg().senderName }}</span> }

      <button type="button" class="cb-bubble"
              [class.is-deleted]="msg().deleted"
              (contextmenu)="onLongPress($event)"
              (pointerdown)="armLongPress()"
              (pointerup)="cancelLongPress()"
              (pointerleave)="cancelLongPress()"
              (click)="toggleMeta()"
              [attr.aria-label]="ariaLabel()">
        @if (msg().deleted) {
          <span class="cb-deleted"><span class="cb-deleted__i" aria-hidden="true">🚫</span> Message deleted</span>
        } @else {
          <span class="cb-text">{{ msg().body }}</span>
        }
      </button>

      <!-- Reaction chips — tap to toggle that emoji; "mine" chips read accent -->
      @if (reactions().length) {
        <div class="cb-reacts" [class.mine]="mine()">
          @for (r of reactions(); track r.emoji) {
            <button type="button" class="cb-chip" [class.is-mine]="reactedByMe(r)"
                    (click)="toggle.emit({ messageId: msg().id, emoji: r.emoji })"
                    [attr.aria-label]="r.emoji + ' ' + r.count">
              <span class="cb-chip__e" aria-hidden="true">{{ r.emoji }}</span>
              @if (r.count > 1) { <span class="cb-chip__n">{{ r.count }}</span> }
            </button>
          }
          <button type="button" class="cb-chip cb-chip--add" (click)="react.emit(msg())" aria-label="Add reaction">
            <span aria-hidden="true">+</span>
          </button>
        </div>
      }

      <!-- Tap-revealed timestamp / edited tag (per-bubble meta line) -->
      @if (metaOpen()) {
        <span class="cb-meta" aria-live="polite">
          {{ time() }}@if (msg().editedUtc && !msg().deleted) {<span class="cb-edited"> · Edited</span>}
        </span>
      }
    </div>
  `,
  styleUrl: './message-bubble.scss',
})
export class MessageBubble {
  readonly msg = input.required<ChatMessageDto>();
  readonly mine = input<boolean>(false);
  readonly showAvatar = input<boolean>(true);
  readonly showTail = input<boolean>(true);
  readonly meUserId = input<number | null>(null);

  readonly react = output<ChatMessageDto>();
  readonly toggle = output<{ messageId: number; emoji: string }>();

  /** Tap-to-reveal per-bubble timestamp / edited tag. */
  protected readonly metaOpen = signal(false);

  protected readonly reactions = computed<ReactionGroupDto[]>(() => this.msg().reactions ?? []);

  /** Two-letter monogram for the avatar fallback. */
  protected readonly initials = computed(() => {
    const parts = (this.msg().senderName || '?').trim().split(/\s+/).filter(Boolean);
    const a = parts[0]?.[0] ?? '?';
    const b = parts.length > 1 ? parts[parts.length - 1][0] : '';
    return (a + b).toUpperCase();
  });

  /** Stable hue from the sender id so each person gets a consistent fallback color. */
  protected readonly hue = computed(() => (this.msg().senderUserId * 47) % 360);

  protected readonly time = computed(() => {
    const d = new Date(this.msg().createdUtc);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  });

  protected readonly ariaLabel = computed(() => {
    const m = this.msg();
    if (m.deleted) return `Deleted message from ${m.senderName}`;
    return `${this.mine() ? 'You' : m.senderName}: ${m.body ?? ''}`;
  });

  reactedByMe(r: ReactionGroupDto): boolean {
    const me = this.meUserId();
    return me != null && r.reactedByUserIds.includes(me);
  }

  // ---- long-press to react (550ms) ----
  private pressTimer: ReturnType<typeof setTimeout> | null = null;

  protected armLongPress(): void {
    if (this.msg().deleted) return;
    this.cancelLongPress();
    this.pressTimer = setTimeout(() => {
      this.pressTimer = null;
      try { navigator.vibrate?.(8); } catch { /* unsupported */ }
      this.react.emit(this.msg());
    }, 550);
  }

  protected cancelLongPress(): void {
    if (this.pressTimer) { clearTimeout(this.pressTimer); this.pressTimer = null; }
  }

  protected onLongPress(ev: Event): void {
    ev.preventDefault();
    if (!this.msg().deleted) this.react.emit(this.msg());
  }

  protected toggleMeta(): void {
    this.metaOpen.update(v => !v);
  }
}
