import {
  ChangeDetectionStrategy, Component, computed, input, output,
} from '@angular/core';

import { ChatChannelDto } from '../../core/models';

/**
 * One row in the conversations LIST — a channel or DM rendered Messenger-style: a leading avatar
 * (the other participant's picture for a DM, a gradient monogram for a channel/fallback) with an
 * optional presence dot, the conversation title, the last-message preview line (sender prefix for
 * channels), a right-side relative timestamp, and an unread pill. Unread rows read bolder. Pure
 * presentational + tree-shakeable; the page owns selection + data.
 *
 *   selector: cb-conv-row
 *   inputs:   conv (ChatChannelDto), meUserId (number | null), online (boolean — DM peer presence)
 *   outputs:  open (ChatChannelDto) — row tapped
 */
@Component({
  selector: 'cb-conv-row',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button type="button" class="cr" [class.is-unread]="unread() > 0" (click)="open.emit(conv())">
      <span class="cr__ava" aria-hidden="true">
        @if (avatarUrl(); as url) {
          <img class="cr__img" [src]="url" alt="" loading="lazy" referrerpolicy="no-referrer" />
        } @else if (isChannel()) {
          <span class="cr__hash">#</span>
        } @else {
          <span class="cr__mono" [style.--h]="hue()">{{ initials() }}</span>
        }
        @if (online()) { <span class="cr__dot" [attr.aria-label]="'online'"></span> }
      </span>

      <span class="cr__body">
        <span class="cr__top">
          <span class="cr__name">{{ conv().displayName }}</span>
          @if (timeLabel(); as t) { <span class="cr__time">{{ t }}</span> }
        </span>
        <span class="cr__bottom">
          <span class="cr__preview">{{ preview() }}</span>
          @if (unread() > 0) {
            <span class="cr__badge" [attr.aria-label]="unread() + ' unread'">{{ unread() > 99 ? '99+' : unread() }}</span>
          }
        </span>
      </span>
    </button>
  `,
  styleUrl: './conversation-row.scss',
})
export class ConversationRow {
  readonly conv = input.required<ChatChannelDto>();
  readonly meUserId = input<number | null>(null);
  readonly online = input<boolean>(false);

  readonly open = output<ChatChannelDto>();

  protected readonly isChannel = computed(() => this.conv().kind === 'channel');
  protected readonly unread = computed(() => this.conv().unreadCount ?? 0);

  /** The other member of a DM (used for avatar + presence). */
  private readonly peer = computed(() => {
    if (this.isChannel()) return null;
    const me = this.meUserId();
    const members = this.conv().members ?? [];
    return members.find(m => m.userId !== me) ?? members[0] ?? null;
  });

  protected readonly avatarUrl = computed(() => this.peer()?.picture || null);

  protected readonly initials = computed(() => {
    const name = this.peer()?.name || this.conv().displayName || '?';
    const parts = name.trim().split(/\s+/).filter(Boolean);
    const a = parts[0]?.[0] ?? '?';
    const b = parts.length > 1 ? parts[parts.length - 1][0] : '';
    return (a + b).toUpperCase();
  });

  protected readonly hue = computed(() => {
    const id = this.peer()?.userId ?? this.conv().id;
    return (id * 47) % 360;
  });

  /** Last-message preview: "Sender: body" for channels, bare body for DMs; placeholder when empty. */
  protected readonly preview = computed(() => {
    const last = this.conv().lastMessage;
    if (!last) return 'No messages yet';
    if (last.deleted) return 'Message deleted';
    const body = (last.body ?? '').replace(/\s+/g, ' ').trim() || 'Sent a message';
    if (this.isChannel()) {
      const me = this.meUserId();
      const who = last.senderUserId === me ? 'You' : (last.senderName?.split(/\s+/)[0] ?? '');
      return who ? `${who}: ${body}` : body;
    }
    return body;
  });

  /** Compact relative time (now / 5m / 3h / Tue / Jun 4). */
  protected readonly timeLabel = computed(() => {
    const iso = this.conv().lastMessage?.createdUtc;
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const diff = Date.now() - d.getTime();
    const min = Math.floor(diff / 60000);
    if (min < 1) return 'now';
    if (min < 60) return `${min}m`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h`;
    const day = Math.floor(hr / 24);
    if (day < 7) return d.toLocaleDateString(undefined, { weekday: 'short' });
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  });
}
