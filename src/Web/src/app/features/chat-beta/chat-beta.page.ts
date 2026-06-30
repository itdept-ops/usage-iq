import {
  ChangeDetectionStrategy, Component, DestroyRef, ElementRef, OnDestroy,
  computed, effect, inject, signal, viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';

import { firstValueFrom } from 'rxjs';

import { Api } from '../../core/api';
import { AuthService } from '../../core/auth';
import { ChatRealtime, TypingUser } from '../../core/chat-realtime';
import { ChatChannelDto, ChatMessageDto, Presence } from '../../core/models';

import {
  BetaPullRefresh, BetaBottomSheet, BetaToaster, ToastController, BetaSkeleton,
  BetaSwipeRow,
} from '../beta-ui';
import { ConversationRow } from './conversation-row';
import { MessageBubble } from './message-bubble';

/** A message paired with its rendering flags (run grouping + day separators), derived per thread. */
interface ThreadRow {
  msg: ChatMessageDto;
  mine: boolean;
  showAvatar: boolean;   // first bubble of a sender run -> show avatar + name
  showTail: boolean;     // last bubble of a sender run -> draw the tail
  daySep: string | null; // a day-separator label to render ABOVE this bubble, or null
}

/** The emoji set offered in the react sheet (kept small + universal). */
const REACTIONS = ['❤️', '👍', '😂', '🔥', '😮', '🙏', '😢', '🎉'] as const;

/**
 * Chat Beta — "Messenger". A NEW, beta-only mobile-first iMessage-feel chat experience rebuilt on the
 * shared beta-ui "Strata" kit (`@use '../beta-ui/beta-kit'`). Two stacked panes on one 390px surface:
 *
 *  • a conversations LIST — channels + DMs as {@link ConversationRow}s (avatar, last-message preview,
 *    relative time, unread pill, a recent-activity presence dot), pulled live from {@link ChatRealtime}
 *    and ordered newest-activity-first, with a staggered spring entrance, the kit {@link BetaPullRefresh}
 *    as the scroll column, and a tasteful empty state;
 *
 *  • a THREAD view that slides in when a conversation is opened — message {@link MessageBubble}s
 *    (mine right / theirs left, sender avatars + names on run starts, tap-to-reveal timestamps, day
 *    separators), a live typing indicator, reactions via long-press/tap that open the kit
 *    {@link BetaBottomSheet} emoji picker, and a composer bar (auto-grow input + send) that writes
 *    StartTyping/StopTyping + SendMessage over the realtime hub.
 *
 * SIGNATURE ACCENT: a TEAL → SKY gradient (#2dd4bf → #0ea5e9), overriding the kit default on :host, so
 * every kit component + bubble + chip reads it off the cascade and the whole screen re-skins.
 *
 * HARD ISOLATION: purely additive + gated by `platform.mobile` (+ `chat.read`). It consumes the EXISTING
 * {@link ChatRealtime} root service + the chat `Api` it wraps (channels / history / send / typing /
 * reactions / mark-read), imports NO live /chat internals, does NOT touch the flagship tracker-beta or
 * the kit itself, and adds no npm deps. The hub is started best-effort here (idempotent) so live
 * updates flow; everything degrades to REST-backed loads if the socket is down.
 */
@Component({
  selector: 'app-chat-beta',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './chat-beta.page.scss',
  providers: [ToastController],
  imports: [
    FormsModule, MatIconModule,
    BetaPullRefresh, BetaBottomSheet, BetaToaster, BetaSkeleton, BetaSwipeRow,
    ConversationRow, MessageBubble,
  ],
  template: `
    <!-- ══════════════════════ LIST PANE ══════════════════════ -->
    <section class="pane list" [class.is-hidden]="!!activeId()" aria-label="Conversations">
      <header class="lh">
        <div class="lh__row">
          <h1 class="lh__title">Messages</h1>
          @if (totalUnread() > 0) {
            <span class="lh__count" aria-label="total unread">{{ totalUnread() > 99 ? '99+' : totalUnread() }}</span>
          }
        </div>
        <p class="lh__sub">Channels &amp; direct messages</p>
        @if (connecting()) {
          <span class="lh__live lh__live--wait"><span class="lh__pulse" aria-hidden="true"></span> Connecting…</span>
        } @else if (live()) {
          <span class="lh__live"><span class="lh__pulse" aria-hidden="true"></span> Live</span>
        }

        <div class="lh__tools">
          <label class="lh__search">
            <mat-icon class="lh__search-i" aria-hidden="true">search</mat-icon>
            <input class="lh__search-in" type="search" [ngModel]="search()"
                   (ngModelChange)="search.set($event)" name="convSearch"
                   placeholder="Search conversations" aria-label="Search conversations"
                   autocomplete="off" enterkeyhint="search" />
            @if (search().trim()) {
              <button type="button" class="lh__search-x" (click)="search.set('')" aria-label="Clear search">
                <mat-icon aria-hidden="true">close</mat-icon>
              </button>
            }
          </label>
          <button type="button" class="lh__filter" [class.is-on]="unreadOnly()"
                  (click)="toggleUnreadOnly()"
                  [attr.aria-pressed]="unreadOnly()" aria-label="Show unread conversations only">
            <mat-icon aria-hidden="true">mark_chat_unread</mat-icon>
            <span>Unread</span>
          </button>
        </div>
      </header>

      <app-bs-pull-refresh class="list__ptr" [busy]="refreshing()" (refresh)="refreshList()">
        <div class="list__scroll">
          @if (loadingList()) {
            @for (s of [0,1,2,3,4,5]; track s) {
              <div class="skelrow">
                <app-bs-skeleton width="52px" height="52px" [circle]="true" />
                <div class="skelrow__c">
                  <app-bs-skeleton width="55%" height="14px" radius="6px" />
                  <app-bs-skeleton width="80%" height="12px" radius="6px" />
                </div>
              </div>
            }
          } @else if (conversations().length === 0) {
            <div class="empty">
              <div class="empty__art" aria-hidden="true">
                <mat-icon>forum</mat-icon>
              </div>
              <h2 class="empty__h">No conversations yet</h2>
              <p class="empty__p">Your channels and direct messages will appear here as soon as someone says hello.</p>
            </div>
          } @else if (visibleConversations().length === 0) {
            <div class="empty">
              <div class="empty__art" aria-hidden="true">
                <mat-icon>{{ unreadOnly() ? 'mark_chat_read' : 'search_off' }}</mat-icon>
              </div>
              <h2 class="empty__h">{{ unreadOnly() ? 'All caught up' : 'No matches' }}</h2>
              <p class="empty__p">
                {{ unreadOnly()
                  ? 'You have no unread conversations right now.'
                  : 'No conversations match “' + search().trim() + '”.' }}
              </p>
            </div>
          } @else {
            @for (c of visibleConversations(); track c.id; let i = $index) {
              <div class="rise" [style.--i]="i">
                <app-bs-swipe-row [rightLabel]="c.unreadCount > 0 ? 'Mark read' : ''"
                                  [leftDestructive]="false" [disabled]="c.unreadCount === 0"
                                  [label]="c.displayName" (swipe)="onRowSwipe(c, $event)">
                  <cb-conv-row [conv]="c" [meUserId]="meUserId()" [online]="peerOnline(c)" (open)="openConversation($event)" />
                </app-bs-swipe-row>
              </div>
            }
          }
          <div class="list__foot" aria-hidden="true"></div>
        </div>
      </app-bs-pull-refresh>
    </section>

    <!-- ══════════════════════ THREAD PANE ══════════════════════ -->
    @if (active(); as conv) {
      <section class="pane thread" aria-label="Conversation">
        <header class="th">
          <button type="button" class="th__back" (click)="closeConversation()" aria-label="Back to conversations">
            <mat-icon aria-hidden="true">arrow_back_ios_new</mat-icon>
          </button>
          <div class="th__id">
            <span class="th__ava" aria-hidden="true">
              @if (threadAvatar(); as url) {
                <img class="th__img" [src]="url" alt="" referrerpolicy="no-referrer" />
              } @else if (conv.kind === 'channel') {
                <span class="th__hash">#</span>
              } @else {
                <span class="th__mono" [style.--h]="threadHue()">{{ threadInitials() }}</span>
              }
            </span>
            <div class="th__text">
              <span class="th__name">{{ conv.displayName }}</span>
              <span class="th__sub">{{ threadSubtitle() }}</span>
            </div>
          </div>
        </header>

        <div #scroll class="th__scroll">
          @if (loadingThread()) {
            <div class="th__load">
              @for (s of [0,1,2,3]; track s) {
                <app-bs-skeleton class="th__load-b" [class.r]="s % 2 === 1"
                                 [width]="(s % 2 ? '52%' : '64%')" height="38px" radius="20px" />
              }
            </div>
          } @else if (rows().length === 0) {
            <div class="empty empty--thread">
              <div class="empty__art" aria-hidden="true"><mat-icon>waving_hand</mat-icon></div>
              <h2 class="empty__h">Say hi</h2>
              <p class="empty__p">This is the very beginning of your conversation.</p>
            </div>
          } @else {
            @for (r of rows(); track r.msg.id) {
              @if (r.daySep) { <div class="daysep"><span>{{ r.daySep }}</span></div> }
              <div class="bubrow" [class.run-start]="r.showAvatar">
                <cb-bubble [msg]="r.msg" [mine]="r.mine" [showAvatar]="r.showAvatar"
                           [showTail]="r.showTail" [meUserId]="meUserId()"
                           (react)="openReactSheet($event)"
                           (toggle)="toggleReaction($event.messageId, $event.emoji)" />
              </div>
            }
          }

          @if (typingLabel(); as tl) {
            <div class="typing" aria-live="polite">
              <span class="typing__dots" aria-hidden="true"><i></i><i></i><i></i></span>
              <span class="typing__t">{{ tl }}</span>
            </div>
          }
          <div class="th__foot" aria-hidden="true"></div>
        </div>

        <!-- Composer bar -->
        <form class="composer" (submit)="send($event)">
          <textarea #composer class="composer__in" [(ngModel)]="draft" name="draft"
                    rows="1" placeholder="Message…" aria-label="Message"
                    enterkeyhint="send" autocomplete="off"
                    (input)="onDraftInput()" (keydown)="onKeydown($event)"></textarea>
          <button type="submit" class="composer__send" [disabled]="!canSend()" aria-label="Send">
            <mat-icon aria-hidden="true">arrow_upward</mat-icon>
          </button>
        </form>
      </section>
    }

    <!-- React picker (kit bottom sheet) -->
    <app-bs-sheet [(open)]="reactOpen" detent="peek" label="Add a reaction">
      <div class="react">
        <h2 class="react__h">React</h2>
        <div class="react__grid">
          @for (e of EMOJI; track e) {
            <button type="button" class="react__e" (click)="pickReaction(e)" [attr.aria-label]="e">{{ e }}</button>
          }
        </div>
      </div>
    </app-bs-sheet>

    <app-bs-toaster />
  `,
})
export class ChatBetaPage implements OnDestroy {
  private readonly rt = inject(ChatRealtime);
  private readonly api = inject(Api);
  private readonly auth = inject(AuthService);
  private readonly toasts = inject(ToastController);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly EMOJI = REACTIONS;

  private readonly scrollEl = viewChild<ElementRef<HTMLDivElement>>('scroll');
  private readonly composerEl = viewChild<ElementRef<HTMLTextAreaElement>>('composer');

  // ── identity + connection state (from the shared realtime service) ──
  protected readonly meUserId = this.auth.userId;
  protected readonly live = this.rt.isConnected;
  protected readonly connecting = computed(() =>
    this.rt.connectionState() === 'connecting' && this.rt.channels().length === 0);
  protected readonly totalUnread = this.rt.totalUnreadMessages;
  protected readonly conversations = this.rt.channels;

  // ── list filters (client-side over the loaded conversation list) ──
  /** Live free-text filter over conversation display names (channel name / DM peer name). A signal so
   * the visibleConversations computed re-runs on every keystroke (a plain field wouldn't invalidate it). */
  protected readonly search = signal('');
  /** When on, the list shows only conversations with unread > 0. */
  protected readonly unreadOnly = signal(false);

  /** The conversations actually rendered: search-filtered, then (optionally) unread-only. */
  protected readonly visibleConversations = computed<ChatChannelDto[]>(() => {
    const q = this.search().trim().toLowerCase();
    const unreadOnly = this.unreadOnly();
    return this.conversations().filter(c => {
      if (unreadOnly && (c.unreadCount ?? 0) === 0) return false;
      if (q && !(c.displayName ?? '').toLowerCase().includes(q)) return false;
      return true;
    });
  });

  // ── live presence (cross-reference DM peer ids against GET /api/presence) ──
  /** AppUser id → last-seen epoch ms, refreshed on a light poll. Drives the TRUE DM presence dot. */
  private readonly presenceById = signal<Map<number, number>>(new Map());
  private presenceTimer: ReturnType<typeof setInterval> | null = null;
  /** A user counts as online if seen within this window. */
  private static readonly PRESENCE_WINDOW_MS = 5 * 60_000;

  // ── list / thread loading + selection ──
  protected readonly loadingList = signal(true);
  protected readonly refreshing = signal(false);
  protected readonly activeId = signal<number | null>(null);
  protected readonly loadingThread = signal(false);

  /** The currently-open conversation (or null on the list pane). */
  protected readonly active = computed<ChatChannelDto | null>(() => {
    const id = this.activeId();
    if (id == null) return null;
    return this.conversations().find(c => c.id === id) ?? null;
  });

  // ── composer ──
  draft = '';
  protected readonly canSend = computed(() => this.draft.trim().length > 0 && this.activeId() != null);
  private typingActive = false;
  private typingStopTimer: ReturnType<typeof setTimeout> | null = null;

  // ── react sheet ──
  readonly reactOpen = signal(false);
  private reactTarget: ChatMessageDto | null = null;

  // ── thread rows (grouped bubbles + day separators) ──
  protected readonly rows = computed<ThreadRow[]>(() => {
    const id = this.activeId();
    if (id == null) return [];
    const msgs = this.rt.messages()[id] ?? [];
    const me = this.meUserId();
    const out: ThreadRow[] = [];
    let lastDayKey = '';
    for (let i = 0; i < msgs.length; i++) {
      const msg = msgs[i];
      const prev = msgs[i - 1];
      const next = msgs[i + 1];
      const dayKey = dayKeyOf(msg.createdUtc);
      const daySep = dayKey !== lastDayKey ? dayLabel(msg.createdUtc) : null;
      lastDayKey = dayKey;
      // A run = consecutive messages from the same sender within ~4 minutes AND the same day.
      const sameAsPrev = !!prev && prev.senderUserId === msg.senderUserId
        && withinRun(prev.createdUtc, msg.createdUtc) && dayKeyOf(prev.createdUtc) === dayKey && !daySep;
      const sameAsNext = !!next && next.senderUserId === msg.senderUserId
        && withinRun(msg.createdUtc, next.createdUtc) && dayKeyOf(next.createdUtc) === dayKey;
      out.push({
        msg,
        mine: me != null && msg.senderUserId === me,
        showAvatar: !sameAsPrev,
        showTail: !sameAsNext,
        daySep,
      });
    }
    return out;
  });

  /** Who is typing in the open thread, as a friendly label. */
  protected readonly typingLabel = computed<string | null>(() => {
    const id = this.activeId();
    if (id == null) return null;
    const who: TypingUser[] = this.rt.typing()[id] ?? [];
    if (who.length === 0) return null;
    if (who.length === 1) return `${firstName(who[0].name)} is typing…`;
    if (who.length === 2) return `${firstName(who[0].name)} and ${firstName(who[1].name)} are typing…`;
    return 'Several people are typing…';
  });

  // ── thread header derivations ──
  private readonly threadPeer = computed(() => {
    const conv = this.active();
    if (!conv || conv.kind === 'channel') return null;
    const me = this.meUserId();
    return (conv.members ?? []).find(m => m.userId !== me) ?? conv.members?.[0] ?? null;
  });
  protected readonly threadAvatar = computed(() => this.threadPeer()?.picture || null);
  protected readonly threadInitials = computed(() => initialsOf(this.threadPeer()?.name || this.active()?.displayName || '?'));
  protected readonly threadHue = computed(() => ((this.threadPeer()?.userId ?? this.active()?.id ?? 0) * 47) % 360);
  protected readonly threadSubtitle = computed(() => {
    const conv = this.active();
    if (!conv) return '';
    if (conv.kind === 'channel') {
      const n = conv.members?.length ?? 0;
      return conv.topic?.trim() || (n ? `${n} member${n === 1 ? '' : 's'}` : 'Channel');
    }
    return this.isActive(conv) ? 'Active recently' : 'Direct message';
  });

  constructor() {
    // Start the hub best-effort (idempotent while connected) so live updates flow; if it's already up
    // (the app shell started it on login) this is a no-op. We also seed the list via REST immediately.
    void this.rt.start();
    void this.initialLoad();

    // Light presence poll so the DM presence dot reflects TRUE roster presence (last authenticated
    // request within ~5min) rather than just last-message recency. Best-effort + swallow errors.
    void this.refreshPresence();
    this.presenceTimer = setInterval(() => void this.refreshPresence(), 45_000);
    this.destroyRef.onDestroy(() => {
      if (this.presenceTimer) { clearInterval(this.presenceTimer); this.presenceTimer = null; }
    });

    // Auto-scroll the thread to the newest message whenever its row set changes (open, new message, send).
    effect(() => {
      this.rows();
      this.typingLabel();
      if (this.activeId() != null) queueMicrotask(() => this.scrollToBottom());
    });
  }

  ngOnDestroy(): void {
    if (this.typingStopTimer) clearTimeout(this.typingStopTimer);
    // If we left while "typing", tell the server we stopped.
    const id = this.activeId();
    if (id != null && this.typingActive) void this.rt.stopTyping(id);
  }

  // ── list ──
  private async initialLoad(): Promise<void> {
    this.loadingList.set(true);
    try {
      await this.rt.refreshChannels();
    } catch {
      this.toasts.show('Couldn’t load conversations', { tone: 'warn' });
    } finally {
      this.loadingList.set(false);
    }
  }

  async refreshList(): Promise<void> {
    this.refreshing.set(true);
    try {
      await this.rt.refreshChannels();
    } catch {
      this.toasts.show('Refresh failed', { tone: 'warn' });
    } finally {
      // A beat so the spinner reads as real work.
      await new Promise(r => setTimeout(r, 350));
      this.refreshing.set(false);
    }
  }

  /** A light recency heuristic: a DM/channel "active" if its last message arrived within ~5 minutes. */
  isActive(conv: ChatChannelDto): boolean {
    const iso = conv.lastMessage?.createdUtc;
    if (!iso) return false;
    const t = new Date(iso).getTime();
    return !Number.isNaN(t) && Date.now() - t < ChatBetaPage.PRESENCE_WINDOW_MS;
  }

  /**
   * TRUE presence for a DM row: the peer counts as online when GET /api/presence reports their last
   * authenticated request within the ~5min window. Falls back to the last-message recency heuristic
   * (the channel-level "active recently") when we have no presence row for the peer yet (or for a
   * group channel, which has no single peer). Self never shows a dot.
   */
  peerOnline(conv: ChatChannelDto): boolean {
    if (conv.kind !== 'direct') return false;
    const me = this.meUserId();
    const peer = (conv.members ?? []).find(m => m.userId !== me) ?? conv.members?.[0] ?? null;
    const lastSeen = peer ? this.presenceById().get(peer.userId) : undefined;
    if (lastSeen != null) return Date.now() - lastSeen < ChatBetaPage.PRESENCE_WINDOW_MS;
    return this.isActive(conv); // recency fallback when presence has no row for this peer yet
  }

  /** Refresh the presence map (AppUser id → last-seen ms). Best-effort; swallows its own error. */
  private async refreshPresence(): Promise<void> {
    try {
      const rows: Presence[] = await firstValueFrom(this.api.presence());
      const map = new Map<number, number>();
      for (const p of rows) {
        if (p.userId == null) continue;
        const t = Date.parse(p.lastSeenUtc);
        if (!Number.isNaN(t)) map.set(p.userId, t);
      }
      this.presenceById.set(map);
    } catch {
      /* keep the last-known presence map; rows just fall back to the recency heuristic */
    }
  }

  /** Header toggle: show only conversations with unread > 0 (over the loaded list). */
  toggleUnreadOnly(): void {
    this.unreadOnly.update(v => !v);
  }

  /**
   * Swipe-row action on a conversation: a RIGHT swipe commits "Mark read" — clears the unread badge
   * locally (optimistic) AND calls the server mark-read (POST /api/chat/channels/{id}/read via the hub)
   * up to the newest known message so it sticks. A LEFT swipe is unused here (no destructive action).
   */
  onRowSwipe(conv: ChatChannelDto, side: 'left' | 'right'): void {
    if (side !== 'right') return;
    if ((conv.unreadCount ?? 0) === 0) return;
    this.rt.clearUnreadLocal(conv.id);
    const list = this.rt.messages()[conv.id] ?? [];
    const newest = list[list.length - 1] ?? conv.lastMessage ?? null;
    if (newest) void this.rt.markRead(conv.id, newest.id);
    this.toasts.show('Marked read', { tone: 'success' });
  }

  // ── thread open/close ──
  async openConversation(conv: ChatChannelDto): Promise<void> {
    this.activeId.set(conv.id);
    this.draft = '';
    // Load history if we don't already have messages cached for this conversation.
    const cached = this.rt.messages()[conv.id] ?? [];
    if (cached.length === 0) {
      this.loadingThread.set(true);
      try {
        await this.rt.loadHistory(conv.id);
      } catch {
        this.toasts.show('Couldn’t load messages', { tone: 'warn' });
      } finally {
        this.loadingThread.set(false);
      }
    }
    // Mark read up to the newest message + clear the local badge.
    const list = this.rt.messages()[conv.id] ?? [];
    const newest = list[list.length - 1];
    if (newest && conv.unreadCount > 0) {
      this.rt.clearUnreadLocal(conv.id);
      void this.rt.markRead(conv.id, newest.id);
    }
    queueMicrotask(() => { this.scrollToBottom(); this.composerEl()?.nativeElement.focus(); });
  }

  closeConversation(): void {
    const id = this.activeId();
    if (id != null && this.typingActive) { this.typingActive = false; void this.rt.stopTyping(id); }
    this.activeId.set(null);
    this.draft = '';
  }

  // ── composer ──
  onDraftInput(): void {
    this.autoGrow();
    const id = this.activeId();
    if (id == null) return;
    if (this.draft.trim().length > 0) {
      if (!this.typingActive) { this.typingActive = true; void this.rt.startTyping(id); }
      // Debounce a StopTyping ~3s after the last keystroke.
      if (this.typingStopTimer) clearTimeout(this.typingStopTimer);
      this.typingStopTimer = setTimeout(() => this.flushStopTyping(), 3000);
    } else {
      this.flushStopTyping();
    }
  }

  onKeydown(ev: KeyboardEvent): void {
    // Enter sends; Shift+Enter inserts a newline (desktop affordance; mobile uses the send button).
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      void this.send(ev);
    }
  }

  async send(ev: Event): Promise<void> {
    ev.preventDefault();
    const id = this.activeId();
    const body = this.draft.trim();
    if (id == null || !body) return;
    this.draft = '';
    this.autoGrow();
    this.flushStopTyping();
    try {
      await this.rt.sendMessage(id, body);
      queueMicrotask(() => this.scrollToBottom());
    } catch {
      this.draft = body; // restore so the user doesn't lose it
      this.toasts.show('Message not sent', { tone: 'warn', actionLabel: 'Retry', onAction: () => void this.send(ev) });
    }
  }

  private flushStopTyping(): void {
    if (this.typingStopTimer) { clearTimeout(this.typingStopTimer); this.typingStopTimer = null; }
    const id = this.activeId();
    if (id != null && this.typingActive) { this.typingActive = false; void this.rt.stopTyping(id); }
  }

  private autoGrow(): void {
    const el = this.composerEl()?.nativeElement;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }

  // ── reactions ──
  openReactSheet(msg: ChatMessageDto): void {
    this.reactTarget = msg;
    this.reactOpen.set(true);
  }

  pickReaction(emoji: string): void {
    const msg = this.reactTarget;
    this.reactOpen.set(false);
    if (msg) void this.rt.toggleReaction(msg.id, emoji);
    this.reactTarget = null;
  }

  toggleReaction(messageId: number, emoji: string): void {
    void this.rt.toggleReaction(messageId, emoji);
  }

  // ── scrolling ──
  private scrollToBottom(): void {
    const el = this.scrollEl()?.nativeElement;
    if (el) el.scrollTop = el.scrollHeight;
  }
}

// ── pure helpers (no DI) ──

/** Local-day key "YYYY-MM-DD" for grouping into day separators. */
function dayKeyOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Friendly day-separator label: Today / Yesterday / weekday / full date. */
function dayLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOf(today) - startOf(d)) / 86_400_000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

/** Two messages belong to the same visual run if sent within 4 minutes of each other. */
function withinRun(aIso: string, bIso: string): boolean {
  const a = new Date(aIso).getTime();
  const b = new Date(bIso).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return false;
  return Math.abs(b - a) < 4 * 60_000;
}

function firstName(name: string): string {
  return (name || '').trim().split(/\s+/)[0] || name;
}

function initialsOf(name: string): string {
  const parts = (name || '?').trim().split(/\s+/).filter(Boolean);
  const a = parts[0]?.[0] ?? '?';
  const b = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (a + b).toUpperCase();
}
