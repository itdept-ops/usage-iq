import {
  AfterViewChecked, Component, ElementRef, OnDestroy, computed, effect, inject, signal, viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TextFieldModule } from '@angular/cdk/text-field';
import { ActivatedRoute } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { timer, switchMap, catchError, of } from 'rxjs';

import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatMenuModule } from '@angular/material/menu';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';

import { Api } from '../../core/api';
import { AuthService } from '../../core/auth';
import { ChatRealtime } from '../../core/chat-realtime';
import { ChatChannelDto, ChatComposeAction, ChatContactDto, ChatLocationShareDto, ChatMember, ChatMessageDto, PERM, Presence, ReactionGroupDto } from '../../core/models';
import { timeAgo } from '../../shared/format';
import { ChatCreateData, ChatCreateDialog, ChatPickPerson } from './chat-create-dialog';
import { LiveLocationCard } from './live-location-card';

/** A run of consecutive messages from the same sender, rendered as one grouped block. */
interface MessageGroup {
  senderUserId: number;
  senderName: string;
  senderPicture?: string;
  firstUtc: string;
  isMine: boolean;
  messages: ChatMessageDto[];
}

/** One @mention autocomplete candidate (a channel member matching the active token). */
interface MentionCandidate extends ChatMember {
  initials: string;
}

const PRESENCE_STALE_MS = 2 * 60 * 1000; // a presence row older than this is "offline"
const TYPING_STOP_MS = 3500;             // stop broadcasting typing after this idle gap

/**
 * A curated set of common reaction emotes for the picker (no external emoji dependency). The first
 * row of eight are the quick favourites; the rest round out reactions for most everyday needs.
 */
const REACTION_EMOJIS: readonly string[] = [
  '👍', '❤️', '😂', '🎉', '😮', '😢', '🙏', '🔥',
  '👏', '😀', '😅', '😉', '😍', '🤔', '🙄', '😎',
  '😴', '😱', '🤯', '🥳', '😭', '😡', '👀', '💯',
  '✅', '❌', '⚡', '🚀', '💡', '⭐', '✨', '💪',
  '🤝', '👋', '🙌', '🤷', '👌', '🤞', '☕', '🐛',
];

/**
 * The full Chat page: a two-pane workspace (conversation sidebar + active conversation) rendered
 * entirely from the shared {@link ChatRealtime} signals. It owns only view concerns — selection,
 * scroll anchoring, mark-read on view, the composer (Enter-to-send + @mention autocomplete), and the
 * create/DM dialog — never the connection itself.
 */
@Component({
  selector: 'app-chat',
  imports: [
    FormsModule, TextFieldModule, MatIconModule, MatButtonModule, MatTooltipModule, MatMenuModule,
    MatDialogModule, MatSnackBarModule, LiveLocationCard,
  ],
  templateUrl: './chat.html',
  styleUrl: './chat.scss',
})
export class Chat implements AfterViewChecked, OnDestroy {
  private api = inject(Api);
  private dialog = inject(MatDialog);
  private snack = inject(MatSnackBar);
  private route = inject(ActivatedRoute);
  private host = inject<ElementRef<HTMLElement>>(ElementRef);
  readonly auth = inject(AuthService);
  readonly chat = inject(ChatRealtime);

  readonly timeAgo = timeAgo;

  // ---- permissions ----
  readonly canSend = computed(() => this.auth.hasPermission(PERM.chatSend));
  readonly canModerate = computed(() => this.auth.hasPermission(PERM.chatModerate));
  /** Admins (chat.contacts.manage) pick from the full directory so they're never boxed in by a circle. */
  readonly canManageContacts = computed(() => this.auth.hasPermission(PERM.chatContactsManage));
  /** Live-location share needs BOTH chat.send (write into the conversation) AND location.self (use my GPS). */
  readonly canShareLocation = computed(() => this.canSend() && this.auth.hasPermission(PERM.locationSelf));

  /** The signed-in user's own AppUser id, for "mine"/self-by-id checks (null until /me populates it). */
  private readonly myUserId = computed(() => this.auth.userId());

  // ---- selection ----
  readonly selectedId = signal<number | null>(null);
  readonly selectedChannel = computed<ChatChannelDto | null>(() => {
    const id = this.selectedId();
    return id == null ? null : this.chat.channels().find(c => c.id === id) ?? null;
  });

  // ---- picker candidate source (the caller's curated contacts, or the full directory for admins) ----
  // NOT the presence roster anymore — presence below is used ONLY for the online dot + online-first sort.
  private readonly contacts = signal<ChatContactDto[]>([]);

  // ---- presence (reuse the existing /api/presence feed for online dots) ----
  private readonly presence = signal<Presence[]>([]);
  /** Heartbeat for relative timestamps + presence staleness; refreshed on every presence poll. */
  readonly now = signal(Date.now());
  /**
   * Set of AppUser ids seen as online within the staleness window. Presence rows now carry `userId` and
   * chat members carry `userId`, so the online dot is cross-referenced by id (the temporary name-based
   * join from the presence slice is retired). Rows with no AppUser id are skipped.
   */
  private readonly onlineUserIds = computed(() => {
    const cutoff = this.now() - PRESENCE_STALE_MS;
    const set = new Set<number>();
    for (const p of this.presence()) {
      if (p.userId != null && new Date(p.lastSeenUtc).getTime() >= cutoff) set.add(p.userId);
    }
    return set;
  });

  // ---- sidebar lists (split channels vs DMs; order already activity-sorted by the service) ----
  readonly channelList = computed(() => this.chat.channels().filter(c => c.kind === 'channel'));
  readonly directList = computed(() => this.chat.channels().filter(c => c.kind === 'direct'));
  readonly hasConversations = computed(() => this.chat.channels().length > 0);

  // ---- active-conversation messages, grouped by sender ----
  readonly groups = computed<MessageGroup[]>(() => {
    const id = this.selectedId();
    if (id == null) return [];
    const msgs = this.chat.messages()[id] ?? [];
    const me = this.myUserId();
    const out: MessageGroup[] = [];
    for (const m of msgs) {
      const prev = out[out.length - 1];
      const sameRun = prev
        && prev.senderUserId === m.senderUserId
        && new Date(m.createdUtc).getTime() - new Date(prev.firstUtc).getTime() < 5 * 60 * 1000;
      if (sameRun) {
        prev.messages.push(m);
      } else {
        out.push({
          senderUserId: m.senderUserId,
          senderName: m.senderName,
          senderPicture: m.senderPicture,
          firstUtc: m.createdUtc,
          isMine: me != null && m.senderUserId === me,
          messages: [m],
        });
      }
    }
    return out;
  });

  readonly typingUsers = computed(() => {
    const id = this.selectedId();
    return id == null ? [] : this.chat.typing()[id] ?? [];
  });
  readonly typingLabel = computed(() => {
    const t = this.typingUsers();
    if (t.length === 0) return '';
    if (t.length === 1) return `${t[0].name} is typing…`;
    if (t.length === 2) return `${t[0].name} and ${t[1].name} are typing…`;
    return `${t[0].name} and ${t.length - 1} others are typing…`;
  });

  // ---- history paging ----
  readonly loadingHistory = signal(false);
  /** Channels that have no more older history (loadHistory returned 0). */
  private readonly exhausted = signal<Set<number>>(new Set());

  // ---- composer ----
  readonly draft = signal('');
  private typingActive = false;
  private typingTimer: ReturnType<typeof setTimeout> | null = null;

  // ---- @mention autocomplete ----
  readonly mentionOpen = signal(false);
  readonly mentionCandidates = signal<MentionCandidate[]>([]);
  readonly mentionIndex = signal(0);
  private mentionStart = -1; // index in draft where the active "@token" begins

  // ---- inline edit ----
  readonly editingId = signal<number | null>(null);
  readonly editDraft = signal('');

  // =========================================================================
  // ✨ Chat AI assists (Gemini-backed; graceful, aria-live, NEVER auto-sends)
  // =========================================================================

  // ---- "Catch me up": a dismissible recap card at the top of the thread ----
  readonly catchUpLoading = signal(false);
  /** The recap text for the active channel (null = no card shown). */
  readonly catchUpSummary = signal<string | null>(null);
  /** True when the recap fell back to the deterministic plain floor (calmer, no AI flourish). */
  readonly catchUpPlain = signal(false);
  /** A gentle inline notice when catch-up couldn't be reached (network blip only — it never 503s). */
  readonly catchUpError = signal<string | null>(null);

  // ---- "Suggest replies": 2-4 reply chips above the composer ----
  readonly repliesLoading = signal(false);
  readonly replySuggestions = signal<string[]>([]);
  /** A gentle inline notice when replies are unavailable (e.g. Gemini off → 503). */
  readonly repliesError = signal<string | null>(null);

  // ---- "✨" compose menu: draft from a prompt / rewrite / shorten / friendlier / formal ----
  readonly composeBusy = signal(false);
  /** A gentle inline notice when compose is unavailable / the prompt was empty. */
  readonly composeError = signal<string | null>(null);
  /** The "draft from a prompt" sub-input is open (the other actions reshape the existing draft in place). */
  readonly composePromptOpen = signal(false);
  readonly composePrompt = signal('');

  // ---- emoji reactions ----
  /** The curated emoji set the react picker offers (no external dependency). */
  readonly reactionEmojis = REACTION_EMOJIS;

  // =========================================================================
  // Live-location share (temporary, scoped to the active conversation)
  // =========================================================================

  /** The duration choices the "Share live location" sheet offers (the 15-minute default leads). */
  readonly shareDurations: readonly { minutes: number; label: string }[] = [
    { minutes: 15, label: '15 minutes' },
    { minutes: 60, label: '1 hour' },
    { minutes: 480, label: '8 hours' },
  ];

  /** True while the duration sheet is open in the composer. */
  readonly shareSheetOpen = signal(false);
  /** True while a start-share request (incl. the geolocation prompt) is in flight. */
  readonly shareStarting = signal(false);
  /** A friendly inline notice when the browser blocks/cannot provide geolocation. */
  readonly shareError = signal<string | null>(null);

  /** Heartbeat that re-evaluates the active-share list as shares cross their expiry (1s). */
  private readonly shareNow = signal(Date.now());

  /**
   * The conversation's CURRENTLY-ACTIVE shares (not stopped AND before expiry by the local clock), newest
   * first. Ended rows linger in the cache (so a just-ended card can show "ended"), but the map list filters
   * to active; an ended card is shown briefly via {@link recentlyEndedShares}.
   */
  readonly activeShares = computed<ChatLocationShareDto[]>(() => {
    const id = this.selectedId();
    if (id == null) return [];
    const now = this.shareNow();
    return this.chat.locationSharesFor(id)
      .filter(s => !s.stopped && now < new Date(s.expiresUtc).getTime())
      .sort((a, b) => new Date(b.startUtc).getTime() - new Date(a.startUtc).getTime());
  });

  /** The shares to render as cards: active ones, plus any of MINE that ended in the last ~20s (so I see it end). */
  readonly visibleShares = computed<ChatLocationShareDto[]>(() => {
    const id = this.selectedId();
    if (id == null) return [];
    const now = this.shareNow();
    const me = this.myUserId();
    return this.chat.locationSharesFor(id)
      .filter(s => {
        const ended = s.stopped || now >= new Date(s.expiresUtc).getTime();
        if (!ended) return true;
        // Keep a just-ended card visible briefly so the user sees it wind down (mine, or one already on screen).
        const since = now - new Date(s.lastUpdateUtc).getTime();
        return me != null && s.sharerUserId === me && since < 20000;
      })
      .sort((a, b) => new Date(b.startUtc).getTime() - new Date(a.startUtc).getTime());
  });

  /** True when I have an active share in the selected conversation (so the composer offers Stop, not Start). */
  readonly myActiveShare = computed<ChatLocationShareDto | null>(() => {
    const me = this.myUserId();
    if (me == null) return null;
    return this.activeShares().find(s => s.sharerUserId === me) ?? null;
  });

  /** True for a share authored by the signed-in user (drives the per-card Extend/Stop controls). */
  shareIsMine(s: ChatLocationShareDto): boolean {
    const me = this.myUserId();
    return me != null && s.sharerUserId === me;
  }

  /** The id under which the periodic position-update timer was started (so we don't double-run it). */
  private positionShareId: number | null = null;
  private positionTimer: ReturnType<typeof setInterval> | null = null;
  /** How often the sharer's tab re-reads + pushes the position while active + visible. */
  private static readonly POSITION_PUSH_MS = 20000;

  // ---- view refs for scroll handling ----
  private readonly scroller = viewChild<ElementRef<HTMLElement>>('scroller');
  private readonly composerEl = viewChild<ElementRef<HTMLTextAreaElement>>('composer');

  /** When set, the next afterViewChecked pins the scroll to the bottom (own send / initial open). */
  private pendingScrollBottom = false;
  /** Preserved scroll offset-from-bottom while prepending older history (keeps the view anchored). */
  private preserveFromBottom: number | null = null;
  private lastRenderedCount = 0;
  private lastChannelId: number | null = null;

  /** Channel id requested via the ?c= deep link (notification click); null when none is pending. */
  private deepLinkChannel: number | null = null;
  /** Optional ?m= message id to scroll to once the linked channel's history has loaded. */
  private pendingScrollToMessage: number | null = null;
  /** Guard so an in-flight refreshChannels() for a deep link isn't kicked off twice. */
  private resolvingDeepLink = false;

  constructor() {
    // The app shell owns the hub lifecycle (start on auth+chat.read, stop on logout), so the page
    // no longer bootstraps the connection itself — avoiding a double-start race.

    // Poll presence (~20s) for the sidebar online dots; keep "now" fresh for staleness + timestamps.
    timer(0, 20000)
      .pipe(
        switchMap(() => this.auth.isAuthenticated()
          ? this.api.presence().pipe(catchError(() => of<Presence[]>([])))
          : of<Presence[]>([])),
        takeUntilDestroyed(),
      )
      .subscribe(list => { this.now.set(Date.now()); this.presence.set(list); });

    // Honor notification deep links: /chat?c={channelId}&m={messageId}. The component is NOT
    // recreated when the user clicks a different notification while already on /chat, so we react to
    // the live queryParamMap stream (not just the initial snapshot) and re-resolve on every change.
    this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe(params => {
      const c = Number(params.get('c'));
      if (!c || Number.isNaN(c)) {
        // No (or invalid) ?c=: clear any pending deep-link so the auto-select-newest default applies.
        this.deepLinkChannel = null;
        this.pendingScrollToMessage = null;
        return;
      }
      const m = Number(params.get('m'));
      this.deepLinkChannel = c;
      this.pendingScrollToMessage = m && !Number.isNaN(m) ? m : null;
      this.resolveDeepLink(c);
    });

    // Auto-select the most-recent conversation once channels arrive (nice default, not forced).
    // Suppressed while a ?c= deep link is pending so it can't win the race against the linked channel.
    effect(() => {
      const list = this.chat.channels();
      if (this.deepLinkChannel == null && this.selectedId() == null && list.length > 0) {
        this.select(list[0]);
      }
    });

    // When the active conversation gains messages and we're pinned to the bottom, mark it read.
    effect(() => {
      const id = this.selectedId();
      const msgs = id == null ? [] : this.chat.messages()[id] ?? [];
      if (id != null && msgs.length > 0 && this.isNearBottom()) {
        this.markReadLatest(id, msgs);
      }
    });

    // A 1s heartbeat so live-location cards count down + cross their expiry without input churn.
    timer(0, 1000).pipe(takeUntilDestroyed()).subscribe(() => this.shareNow.set(Date.now()));

    // Drive the sharer's periodic position push: while I hold an ACTIVE share in the open conversation,
    // (re)start a timer that re-reads the browser position + updates it; tear it down when the share ends
    // or the selection changes. The timer itself respects tab visibility (see startPositionPush).
    effect(() => {
      const mine = this.myActiveShare();
      if (mine && mine.id !== this.positionShareId) this.startPositionPush(mine.id);
      else if (!mine && this.positionShareId != null) this.stopPositionPush();
    });
  }

  // =========================================================================
  // Selection + history
  // =========================================================================

  /** Online by AppUser id (presence rows + chat members are both keyed on userId now). */
  isOnline(userId: number): boolean {
    return userId > 0 && this.onlineUserIds().has(userId);
  }

  /** A DM's online state = the OTHER member online (DMs have exactly two members). */
  dmOnline(ch: ChatChannelDto): boolean {
    const me = this.myUserId();
    if (me == null) return false; // can't tell the OTHER member apart from self until our own id is known
    return ch.members.some(m => m.userId !== me && this.isOnline(m.userId));
  }

  unread(id: number): number {
    return this.chat.unreadFor(id);
  }

  select(ch: ChatChannelDto): void {
    if (this.selectedId() === ch.id) return;
    this.stopTypingNow(); // flush typing for the OLD channel so it doesn't leak into the new one
    this.cancelEdit();
    this.closeMentions();
    this.resetAiAssists(); // AI recap / reply chips / compose prompt are per-channel — clear on switch
    this.selectedId.set(ch.id);
    this.lastChannelId = ch.id;
    this.pendingScrollBottom = true;
    this.preserveFromBottom = null;

    // Opening a conversation is a read action — clear its unread badge optimistically (the server
    // call happens in markReadLatest). Done here, at the user action, not inside the mark-read effect.
    this.chat.clearUnreadLocal(ch.id);

    // Load history if we haven't yet (initial page); then mark read at the bottom.
    const have = this.chat.messages()[ch.id] ?? [];
    if (have.length === 0) {
      this.loadingHistory.set(true);
      this.chat.loadHistory(ch.id)
        .then(() => { this.pendingScrollBottom = true; })
        .catch(() => this.snack.open('Could not load messages. Please try again.', 'Dismiss', { duration: 4000 }))
        .finally(() => this.loadingHistory.set(false));
    }
    this.markReadLatest(ch.id, have);

    // A late-joiner / a freshly opened conversation should see any in-progress live-location share — pull
    // the active set (the SignalR events keep it fresh afterward). Close any open duration sheet on switch.
    this.shareSheetOpen.set(false);
    this.shareError.set(null);
    void this.chat.refreshLocationShares(ch.id);

    queueMicrotask(() => this.focusComposer());
  }

  /**
   * Resolve a ?c= notification deep link to a selected channel. If the channel is already in the
   * loaded list, select it immediately. Otherwise (channels not yet fetched, or a brand-new
   * channel/DM) refresh the list once and select it; if it is still missing the channel isn't visible
   * to this user, so we skip gracefully and leave the current selection untouched.
   */
  private resolveDeepLink(channelId: number): void {
    const existing = this.chat.channels().find(c => c.id === channelId);
    if (existing) {
      this.deepLinkChannel = null;
      this.select(existing);
      return;
    }
    // A refresh is already in flight; let it finish — its finally re-resolves whatever is pending now,
    // so a rapid click on a second still-unloaded channel isn't dropped.
    if (this.resolvingDeepLink) return;
    this.resolvingDeepLink = true;
    this.chat.refreshChannels()
      .then(list => {
        // The user may have clicked a different notification while this was in flight; only act if this
        // channel is still the one being requested.
        if (this.deepLinkChannel !== channelId) return;
        const found = list.find(c => c.id === channelId);
        if (found) {
          this.deepLinkChannel = null;
          this.select(found);
        }
        // Still missing: not visible to this user — leave selection as-is (skip).
      })
      .catch(() => {})
      .finally(() => {
        this.resolvingDeepLink = false;
        // If a still-unresolved deep link is pending (e.g. the user clicked a second link mid-refresh),
        // resolve it now against the freshly loaded list.
        const pending = this.deepLinkChannel;
        if (pending != null && pending !== channelId) this.resolveDeepLink(pending);
      });
  }

  /** Load older messages when the user scrolls to the top. */
  onScroll(): void {
    const el = this.scroller()?.nativeElement;
    const id = this.selectedId();
    if (!el || id == null) return;
    // Scrolling to the bottom is a read action: clear the local unread badge here (the user action),
    // not inside the mark-read effect. The effect still issues the server-side MarkRead.
    if (this.isNearBottom(el) && this.chat.unreadFor(id) > 0) {
      this.chat.clearUnreadLocal(id);
    }
    if (el.scrollTop <= 48 && !this.loadingHistory() && !this.exhausted().has(id)) {
      const list = this.chat.messages()[id] ?? [];
      const oldest = list[0]?.id;
      if (oldest == null) return;
      this.loadingHistory.set(true);
      // Anchor: remember distance-from-bottom so the viewport stays put after we prepend.
      this.preserveFromBottom = el.scrollHeight - el.scrollTop;
      this.chat.loadHistory(id, oldest)
        .then(count => {
          if (count === 0) this.exhausted.update(s => new Set(s).add(id));
        })
        .catch(() => {
          this.preserveFromBottom = null;
          this.snack.open('Could not load older messages. Please try again.', 'Dismiss', { duration: 4000 });
        })
        .finally(() => this.loadingHistory.set(false));
    }
  }

  /** Navigating away must flush our own typing state so other clients don't see a stuck "is typing…". */
  ngOnDestroy(): void {
    this.stopTypingNow();
    this.stopPositionPush();
  }

  // =========================================================================
  // Scroll anchoring (post-render)
  // =========================================================================

  ngAfterViewChecked(): void {
    const el = this.scroller()?.nativeElement;
    if (!el) return;
    const id = this.selectedId();
    const count = id == null ? 0 : (this.chat.messages()[id] ?? []).length;

    if (this.pendingScrollBottom) {
      el.scrollTop = el.scrollHeight;
      this.pendingScrollBottom = false;
    } else if (this.preserveFromBottom != null && count !== this.lastRenderedCount) {
      // We just prepended older history — restore the prior distance-from-bottom.
      el.scrollTop = el.scrollHeight - this.preserveFromBottom;
      this.preserveFromBottom = null;
    } else if (count > this.lastRenderedCount && this.lastChannelId === id && this.isNearBottom(el)) {
      // A new message arrived while we were already at the bottom — follow it.
      el.scrollTop = el.scrollHeight;
    }
    this.lastRenderedCount = count;
    this.lastChannelId = id;

    // Best-effort scroll to a deep-linked message (?m=) once its channel's messages have rendered.
    if (this.pendingScrollToMessage != null && id != null && count > 0) {
      const target = el.querySelector<HTMLElement>(`[data-msg-id="${this.pendingScrollToMessage}"]`);
      if (target) {
        target.scrollIntoView({ block: 'center' });
        this.pendingScrollToMessage = null;
      }
    }
  }

  /** True when the message list is scrolled near its bottom (or not yet scrollable). */
  private isNearBottom(el?: HTMLElement): boolean {
    const node = el ?? this.scroller()?.nativeElement;
    if (!node) return true;
    return node.scrollHeight - node.scrollTop - node.clientHeight < 120;
  }

  private markReadLatest(channelId: number, msgs: ChatMessageDto[]): void {
    const newest = msgs[msgs.length - 1];
    if (newest && this.chat.unreadFor(channelId) > 0) {
      void this.chat.markRead(channelId, newest.id);
    }
  }

  // =========================================================================
  // Composer + typing
  // =========================================================================

  onDraftChange(value: string): void {
    this.draft.set(value);
    this.signalTyping();
    this.updateMentionState();
  }

  onComposerKeydown(event: KeyboardEvent): void {
    // Mention navigation takes precedence while the popup is open.
    if (this.mentionOpen()) {
      if (event.key === 'ArrowDown') { event.preventDefault(); this.moveMention(1); return; }
      if (event.key === 'ArrowUp') { event.preventDefault(); this.moveMention(-1); return; }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        this.applyMention(this.mentionCandidates()[this.mentionIndex()]);
        return;
      }
      if (event.key === 'Escape') { event.preventDefault(); this.closeMentions(); return; }
    }
    // Enter sends; Shift+Enter inserts a newline.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.send();
    }
  }

  send(): void {
    const id = this.selectedId();
    const body = this.draft().trim();
    if (id == null || !body || !this.canSend()) return;

    const mentions = this.extractMentions(body, this.selectedChannel());
    void this.chat.sendMessage(id, body, mentions.length ? mentions : null);
    this.draft.set('');
    this.closeMentions();
    this.stopTypingNow();
    this.pendingScrollBottom = true;
    queueMicrotask(() => this.focusComposer());
  }

  private signalTyping(): void {
    const id = this.selectedId();
    if (id == null || !this.canSend()) return;
    if (!this.typingActive) {
      this.typingActive = true;
      void this.chat.startTyping(id);
    }
    if (this.typingTimer) clearTimeout(this.typingTimer);
    this.typingTimer = setTimeout(() => this.stopTypingNow(), TYPING_STOP_MS);
  }

  private stopTypingNow(): void {
    if (this.typingTimer) { clearTimeout(this.typingTimer); this.typingTimer = null; }
    if (this.typingActive) {
      this.typingActive = false;
      const id = this.selectedId();
      if (id != null) void this.chat.stopTyping(id);
    }
  }

  // =========================================================================
  // @mention autocomplete (over the active channel's members)
  // =========================================================================

  /** Recompute the mention popup from the caret position after each keystroke. */
  private updateMentionState(): void {
    const el = this.composerEl()?.nativeElement;
    const ch = this.selectedChannel();
    if (!el || !ch) { this.closeMentions(); return; }
    const caret = el.selectionStart ?? this.draft().length;
    const upto = this.draft().slice(0, caret);
    // Find the last "@" that starts a token (preceded by whitespace or start-of-text).
    const match = /(?:^|\s)@([\w.\-]*)$/.exec(upto);
    if (!match) { this.closeMentions(); return; }
    this.mentionStart = caret - match[1].length - 1; // position of the "@"
    const token = match[1].toLowerCase();
    const me = this.myUserId();
    const candidates = ch.members
      .filter(m => m.userId !== me)
      .filter(m => !token || m.name.toLowerCase().includes(token))
      .slice(0, 6)
      .map(m => ({ ...m, initials: this.initialsOf(m.name) }));
    if (candidates.length === 0) { this.closeMentions(); return; }
    this.mentionCandidates.set(candidates);
    this.mentionIndex.set(0);
    this.mentionOpen.set(true);
  }

  moveMention(delta: number): void {
    const n = this.mentionCandidates().length;
    if (n === 0) return;
    this.mentionIndex.update(i => (i + delta + n) % n);
  }

  applyMention(c: MentionCandidate | undefined): void {
    const el = this.composerEl()?.nativeElement;
    if (!c || this.mentionStart < 0) { this.closeMentions(); return; }
    const caret = el?.selectionStart ?? this.draft().length;
    const before = this.draft().slice(0, this.mentionStart);
    const after = this.draft().slice(caret);
    const token = `@${c.name} `;
    const next = before + token + after;
    this.draft.set(next);
    this.closeMentions();
    queueMicrotask(() => {
      const node = this.composerEl()?.nativeElement;
      if (node) {
        const pos = (before + token).length;
        node.focus();
        node.setSelectionRange(pos, pos);
      }
    });
  }

  private closeMentions(): void {
    this.mentionOpen.set(false);
    this.mentionCandidates.set([]);
    this.mentionStart = -1;
  }

  /** Close the mention popup on composer blur, deferred so a click on a candidate still lands. */
  closeMentionsSoon(): void {
    setTimeout(() => this.closeMentions(), 120);
  }

  /**
   * Resolve "@Name" tokens in the body to the mentioned members' AppUser ids (the backend's
   * mentionedUserIds contract — email-privacy slice 3B). Members carry `userId` + `name`, so we match
   * each member by their display name appearing as an "@Name" token in the body (case-insensitive,
   * preceded by whitespace or start-of-text; multi-word names are matched whole). The caller is excluded
   * (you can't mention yourself). Returns the de-duplicated ids; the server intersects with membership
   * and fires the "you were mentioned" notification for them.
   */
  private extractMentions(body: string, ch: ChatChannelDto | null): number[] {
    if (!ch) return [];
    const me = this.myUserId();
    const lower = body.toLowerCase();
    const ids = new Set<number>();
    for (const m of ch.members) {
      if (m.userId === me || !m.name) continue;
      const needle = `@${m.name.toLowerCase()}`;
      // Match "@Name" only at a token boundary: start-of-text or preceded by whitespace.
      let from = 0;
      while (true) {
        const at = lower.indexOf(needle, from);
        if (at < 0) break;
        const prev = at === 0 ? '' : lower[at - 1];
        if (at === 0 || /\s/.test(prev)) { ids.add(m.userId); break; }
        from = at + 1;
      }
    }
    return [...ids];
  }

  // =========================================================================
  // Edit / delete own (or any, with chat.moderate) messages
  // =========================================================================

  canManageMessage(m: ChatMessageDto): boolean {
    const me = this.myUserId();
    return !m.deleted && (this.canModerate() || (me != null && m.senderUserId === me));
  }

  startEdit(m: ChatMessageDto): void {
    this.closeMentions();
    this.editingId.set(m.id);
    this.editDraft.set(m.body ?? '');
  }

  cancelEdit(): void {
    this.editingId.set(null);
    this.editDraft.set('');
  }

  onEditKeydown(event: KeyboardEvent, m: ChatMessageDto): void {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); this.saveEdit(m); }
    else if (event.key === 'Escape') { event.preventDefault(); this.cancelEdit(); }
  }

  saveEdit(m: ChatMessageDto): void {
    const body = this.editDraft().trim();
    if (!body) { this.deleteMessage(m); return; }
    if (body === (m.body ?? '')) { this.cancelEdit(); return; }
    this.api.editChatMessage(m.id, body).subscribe({
      next: () => this.cancelEdit(),
      error: () => this.snack.open('Could not edit the message.', 'Dismiss', { duration: 4000 }),
    });
  }

  deleteMessage(m: ChatMessageDto): void {
    this.cancelEdit();
    this.api.deleteChatMessage(m.id).subscribe({
      error: () => this.snack.open('Could not delete the message.', 'Dismiss', { duration: 4000 }),
    });
  }

  // =========================================================================
  // Emoji reactions
  // =========================================================================

  /** True when the signed-in user has reacted with this group's emoji (mine = reactedByUserIds ∋ my id). */
  reactionMine(r: ReactionGroupDto): boolean {
    const me = this.myUserId();
    return me != null && r.reactedByUserIds.includes(me);
  }

  /** aria-label for a reaction chip, e.g. "React with 👍, 3 reactions". */
  reactionLabel(r: ReactionGroupDto): string {
    return `React with ${r.emoji}, ${r.count} reaction${r.count === 1 ? '' : 's'}`;
  }

  /**
   * Human-readable tooltip listing who reacted (display names resolved from the active channel's
   * members by AppUser id, falling back to "Someone"), e.g. "Ada, Grace and Linus reacted with 👍".
   */
  reactionTooltip(r: ReactionGroupDto): string {
    const ch = this.selectedChannel();
    const byUserId = new Map<number, string>();
    if (ch) for (const m of ch.members) byUserId.set(m.userId, m.name);
    const me = this.myUserId();
    const names = r.reactedByUserIds.map(uid => {
      if (me != null && uid === me) return 'You';
      return byUserId.get(uid) ?? 'Someone';
    });
    const who = names.length <= 1
      ? (names[0] ?? '')
      : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
    return `${who} reacted with ${r.emoji}`;
  }

  /** Toggle my reaction with this emoji on a message (gated on chat.send). */
  toggleReaction(m: ChatMessageDto, emoji: string): void {
    if (!this.canSend() || m.deleted) return;
    void this.chat.toggleReaction(m.id, emoji);
  }

  /** Pick an emoji from the curated picker: toggle it (the menu closes itself). */
  pickReaction(m: ChatMessageDto, emoji: string): void {
    this.toggleReaction(m, emoji);
  }

  // =========================================================================
  // ✨ Chat AI assists — catch-up / suggest-replies / compose. All graceful on
  // failure; none of them ever sends — the user acts via the existing Send path.
  // =========================================================================

  /** Clear every AI-assist surface (called on channel switch + when a card is dismissed). */
  private resetAiAssists(): void {
    this.catchUpLoading.set(false);
    this.catchUpSummary.set(null);
    this.catchUpPlain.set(false);
    this.catchUpError.set(null);
    this.repliesLoading.set(false);
    this.replySuggestions.set([]);
    this.repliesError.set(null);
    this.composeBusy.set(false);
    this.composeError.set(null);
    this.composePromptOpen.set(false);
    this.composePrompt.set('');
  }

  /**
   * "✨ Catch me up" — fetch a recap of the active channel and show it in a dismissible card at the top
   * of the thread. The endpoint always 200s (a deterministic plain floor covers an unavailable Gemini),
   * so the only failure is a network blip, surfaced as a gentle inline notice.
   */
  catchMeUp(): void {
    const id = this.selectedId();
    if (id == null || this.catchUpLoading()) return;
    this.catchUpError.set(null);
    this.catchUpLoading.set(true);
    this.api.chatCatchUp(id).subscribe({
      next: res => {
        // Guard against a late response after the user switched channels.
        if (this.selectedId() !== id) return;
        this.catchUpSummary.set(res.summary?.trim() || 'Nothing new to catch up on.');
        this.catchUpPlain.set(!!res.fellBackToPlain);
        this.catchUpLoading.set(false);
      },
      error: () => {
        if (this.selectedId() !== id) return;
        this.catchUpError.set("Couldn't reach the recap just now. Please try again in a moment.");
        this.catchUpLoading.set(false);
      },
    });
  }

  /** Dismiss the catch-up card. */
  dismissCatchUp(): void {
    this.catchUpSummary.set(null);
    this.catchUpPlain.set(false);
    this.catchUpError.set(null);
  }

  /**
   * "✨ Suggest replies" — fetch 2-4 reply suggestions for the active channel. Gemini-gated, so a 503
   * (assist unavailable) steps aside gracefully with a gentle notice. Tapping a chip fills the composer
   * (it never sends — see {@link useReply}).
   */
  suggestReplies(): void {
    const id = this.selectedId();
    if (id == null || !this.canSend() || this.repliesLoading()) return;
    this.repliesError.set(null);
    this.repliesLoading.set(true);
    this.api.chatSuggestReplies(id).subscribe({
      next: res => {
        if (this.selectedId() !== id) return;
        const list = (res.replies ?? []).map(r => r.trim()).filter(Boolean);
        this.replySuggestions.set(list);
        if (list.length === 0) this.repliesError.set('No suggestions right now — just type a reply.');
        this.repliesLoading.set(false);
      },
      error: (e: unknown) => {
        if (this.selectedId() !== id) return;
        this.replySuggestions.set([]);
        this.repliesError.set(this.aiMessage(e, 'replies'));
        this.repliesLoading.set(false);
      },
    });
  }

  /**
   * Use a suggested reply: drop it into the composer (REPLACING the current draft — the chips are a
   * starting point the user reviews) and focus. NEVER auto-sends; the user reviews + hits Send.
   */
  useReply(text: string): void {
    if (!this.canSend()) return;
    this.draft.set(text);
    this.replySuggestions.set([]); // a pick consumes the suggestions; re-ask for a fresh set
    this.repliesError.set(null);
    queueMicrotask(() => {
      const node = this.composerEl()?.nativeElement;
      if (node) {
        node.focus();
        const end = text.length;
        node.setSelectionRange(end, end);
      }
    });
  }

  /** Dismiss the reply chips without picking one. */
  dismissReplies(): void {
    this.replySuggestions.set([]);
    this.repliesError.set(null);
  }

  /** Toggle the "draft from a prompt" sub-input in the compose menu. */
  toggleComposePrompt(): void {
    this.composeError.set(null);
    this.composePromptOpen.update(v => !v);
    if (this.composePromptOpen()) {
      queueMicrotask(() => {
        const el = this.host.nativeElement.querySelector<HTMLTextAreaElement>('.cx-compose__prompt-input');
        el?.focus();
      });
    }
  }

  /** Enter submits the draft prompt; Shift+Enter inserts a newline; Escape closes the sub-input. */
  onComposePromptKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); this.runDraftFromPrompt(); }
    else if (event.key === 'Escape') { event.preventDefault(); this.composePromptOpen.set(false); }
  }

  /** "Draft from a prompt": compose a fresh message from the prompt and place it in the composer. */
  runDraftFromPrompt(): void {
    const prompt = this.composePrompt().trim();
    if (!prompt) { this.composeError.set('Type a prompt to draft from.'); return; }
    this.compose('draft', { prompt });
  }

  /** Rewrite / shorten / friendlier / formal: reshape the CURRENT composer draft in place. */
  composeFromDraft(action: Exclude<ChatComposeAction, 'draft'>): void {
    const currentDraft = this.draft().trim();
    if (!currentDraft) { this.composeError.set('Type a draft first, then I can refine it.'); return; }
    this.compose(action, { currentDraft });
  }

  /**
   * Run a compose-assist action and fill the composer with the result. NEVER sends. On a 503 (Gemini
   * off) or 400 (nothing to work from) we surface a gentle inline notice and leave the draft untouched.
   */
  private compose(action: ChatComposeAction, opts: { prompt?: string; currentDraft?: string }): void {
    if (!this.canSend() || this.composeBusy()) return;
    this.composeError.set(null);
    this.composeBusy.set(true);
    this.api.chatCompose(action, opts).subscribe({
      next: res => {
        const body = res.body?.trim();
        if (body) {
          this.draft.set(body);
          this.composePromptOpen.set(false);
          this.composePrompt.set('');
          queueMicrotask(() => this.focusComposerEnd());
        } else {
          this.composeError.set("Couldn't compose that just now. Please try again.");
        }
        this.composeBusy.set(false);
      },
      error: (e: unknown) => {
        this.composeError.set(this.aiMessage(e, 'compose'));
        this.composeBusy.set(false);
      },
    });
  }

  /** Focus the composer and place the caret at the end of the current draft. */
  private focusComposerEnd(): void {
    const node = this.composerEl()?.nativeElement;
    if (!node) return;
    node.focus();
    const end = this.draft().length;
    node.setSelectionRange(end, end);
  }

  /** A gentle, on-brand message from an AI-assist HttpErrorResponse (503 = unavailable; 400 = empty). */
  private aiMessage(e: unknown, kind: 'replies' | 'compose'): string {
    const err = e as { status?: number; error?: { message?: string; detail?: string } };
    if (err?.status === 503) {
      return kind === 'replies'
        ? 'Reply suggestions are unavailable right now — just type a reply.'
        : 'The compose assist is unavailable right now. You can write your message yourself.';
    }
    if (err?.status === 400) return err.error?.message ?? 'Type a message to work from.';
    return err?.error?.detail ?? err?.error?.message
      ?? "Couldn't do that just now — please try again.";
  }

  // =========================================================================
  // Create channel / start DM
  // =========================================================================

  openCreate(mode: 'channel' | 'direct'): void {
    if (!this.canSend()) return;
    const isAdmin = this.canManageContacts();
    // Refresh the candidate source on open (cheap, and keeps an admin's directory / a user's circle
    // current after the backend changes it). Then open the picker — presence only colours the dots.
    const source$ = isAdmin ? this.api.chatDirectory() : this.api.myContacts();
    source$.pipe(catchError(() => of<ChatContactDto[]>([]))).subscribe(list => {
      this.contacts.set(list);
      const data: ChatCreateData = { people: this.pickablePeople(), mode, isAdmin };
      this.dialog.open(ChatCreateDialog, { data, width: '480px', maxWidth: '95vw', autoFocus: false })
        .afterClosed().subscribe((ch: ChatChannelDto | undefined) => {
          if (ch) this.select(ch);
        });
    });
  }

  /**
   * The picker's candidate list: the caller's curated contacts (or, for an admin, the full directory),
   * minus the caller, with presence cross-referenced by AppUser id ONLY to set the online dot and sort
   * online-first. Contacts now carry `userId` (slice 3B), so the picker keys on id — the picker's old
   * name-based presence join is retired. Presence is not the candidate source.
   */
  private pickablePeople(): ChatPickPerson[] {
    const me = this.myUserId();
    return this.contacts()
      .filter(c => c.userId !== me)
      .map(c => ({
        userId: c.userId,
        name: c.name,
        picture: c.picture,
        online: this.isOnline(c.userId),
      }))
      .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  }

  // =========================================================================
  // Live-location share — start (with a duration) / extend / stop, + periodic position push
  // =========================================================================

  /** Toggle the "Share live location" duration sheet in the composer (a no-op while a start is in flight). */
  toggleShareSheet(): void {
    if (this.shareStarting()) return;
    this.shareError.set(null);
    this.shareSheetOpen.update(v => !v);
  }

  /**
   * Start a live-location share in the open conversation for the chosen duration. Grabs a single browser fix
   * first; if the browser blocks or can't provide one, surface a friendly notice and DON'T start. The hub
   * broadcasts the share back to every participant (including us), so the card appears via the realtime cache.
   */
  async startShare(minutes: number): Promise<void> {
    const id = this.selectedId();
    if (id == null || !this.canShareLocation() || this.shareStarting()) return;
    if (this.myActiveShare()) { this.shareSheetOpen.set(false); return; } // already sharing here
    this.shareError.set(null);
    this.shareStarting.set(true);
    try {
      const pos = await this.getBrowserPosition();
      if (!pos) {
        this.shareError.set(this.geoBlockedMessage());
        return;
      }
      const { latitude, longitude, accuracy } = pos.coords;
      await this.chat.startLocationShare(id, {
        lat: latitude,
        lng: longitude,
        accuracyM: Number.isFinite(accuracy) ? accuracy : null,
        durationMinutes: minutes,
      });
      this.shareSheetOpen.set(false);
    } catch {
      this.shareError.set("Couldn't start the live share just now. Please try again.");
    } finally {
      this.shareStarting.set(false);
    }
  }

  /** Extend a share I own by N minutes (e.g. +15 / +60). The card emits this; the hub pushes the new expiry. */
  async extendShare(share: ChatLocationShareDto, minutes: number): Promise<void> {
    const res = await this.chat.extendLocationShare(share.id, minutes);
    if (!res) this.snack.open("Couldn't extend the share — it may have ended.", 'Dismiss', { duration: 4000 });
  }

  /** Stop a share I own. The card emits this; the hub broadcasts the ended state to viewers. */
  async stopShare(share: ChatLocationShareDto): Promise<void> {
    if (share.id === this.positionShareId) this.stopPositionPush();
    const res = await this.chat.stopLocationShare(share.id);
    if (!res) this.snack.open("Couldn't stop the share just now.", 'Dismiss', { duration: 4000 });
  }

  /**
   * While I own an active share AND my tab is visible, re-read the browser position every ~20s and push it
   * so viewers' pins move in real time. Visibility is checked each tick (a backgrounded tab pauses pushing,
   * resuming when it returns). A geolocation failure mid-share is swallowed — the next tick retries.
   */
  private startPositionPush(shareId: number): void {
    this.stopPositionPush();
    this.positionShareId = shareId;
    this.positionTimer = setInterval(() => void this.pushPositionTick(shareId), Chat.POSITION_PUSH_MS);
  }

  private async pushPositionTick(shareId: number): Promise<void> {
    if (this.positionShareId !== shareId) return;
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return; // tab hidden: skip
    const pos = await this.getBrowserPosition();
    if (!pos || this.positionShareId !== shareId) return;
    const { latitude, longitude, accuracy } = pos.coords;
    const res = await this.chat.updateLocationShare(shareId, {
      lat: latitude,
      lng: longitude,
      accuracyM: Number.isFinite(accuracy) ? accuracy : null,
    });
    // A null result means the share ended server-side (expired/stopped) — stop pushing.
    if (!res) this.stopPositionPush();
  }

  private stopPositionPush(): void {
    if (this.positionTimer) { clearInterval(this.positionTimer); this.positionTimer = null; }
    this.positionShareId = null;
  }

  /** One-shot browser position; resolves null on any error (blocked, timeout, unsupported). */
  private getBrowserPosition(): Promise<GeolocationPosition | null> {
    if (typeof navigator === 'undefined' || !navigator.geolocation) return Promise.resolve(null);
    return new Promise(resolve => {
      navigator.geolocation.getCurrentPosition(
        pos => resolve(pos),
        () => resolve(null),
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 },
      );
    });
  }

  /** A friendly notice when the browser won't give us a position (blocked permission or unsupported). */
  private geoBlockedMessage(): string {
    if (typeof navigator !== 'undefined' && !navigator.geolocation) {
      return "This browser can't share location. Try a different browser.";
    }
    return 'Location is blocked. Allow location access in your browser to share, then try again.';
  }

  // =========================================================================
  // small view helpers
  // =========================================================================

  /** Local time-of-day for a message timestamp, e.g. "3:07 PM". */
  msgTime(iso: string): string {
    return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  channelInitial(ch: ChatChannelDto): string {
    if (ch.kind === 'direct') return this.initialsOf(ch.displayName);
    return (ch.displayName?.[0] ?? '#').toUpperCase();
  }

  private initialsOf(name: string | null | undefined): string {
    const parts = (name || '').split(/\s+/).filter(Boolean);
    return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || 'U';
  }

  groupInitials(g: MessageGroup): string {
    return this.initialsOf(g.senderName);
  }

  /**
   * Focus the composer — but only on a desktop-width viewport. On phones the panes overlay and the
   * composer is brought into view on open; auto-focusing there would immediately pop the on-screen
   * keyboard over the freshly opened conversation, so we skip it.
   */
  private focusComposer(): void {
    if (typeof window === 'undefined' || !window.matchMedia('(min-width: 761px)').matches) return;
    this.composerEl()?.nativeElement?.focus();
  }

  /**
   * Mobile Back: deselect the conversation and move focus to the sidebar New-conversation button (or
   * its header) so focus isn't lost to <body> when the Back button gets display:none. On desktop both
   * panes are visible, so this is just a deselect.
   */
  back(): void {
    this.selectedId.set(null);
    queueMicrotask(() => {
      const root = this.host.nativeElement;
      const target = root.querySelector<HTMLElement>('.cx-add')
        ?? root.querySelector<HTMLElement>('.cx-side__head .panel-header')
        ?? root.querySelector<HTMLElement>('.cx-side__head');
      target?.focus();
    });
  }
}
