import { Injectable, computed, inject, signal } from '@angular/core';
import {
  HubConnection,
  HubConnectionBuilder,
  HubConnectionState,
  JsonHubProtocol,
  LogLevel,
} from '@microsoft/signalr';

import { Api } from './api';
import { AuthService } from './auth';
import { ChatChannelDto, ChatLocationShareDto, ChatMessageDto, NotificationDto, NotificationPreferenceDto, ReactionGroupDto, StartLocationShareRequest, UpdateLocationShareRequest } from './models';
import { firstValueFrom } from 'rxjs';

/** Sensible defaults until the real preferences are loaded from the server (everything on). */
const DEFAULT_PREFERENCES: NotificationPreferenceDto = {
  notifyDirectMessages: true,
  notifyMentions: true,
  notifyChannelMessages: true,
  notifySystemEvents: true,
  surfaceToasts: true,
  surfaceBrowser: false,
};

/** SignalR hub endpoint (JWT is appended by the client as ?access_token=...). */
const HUB_URL = '/api/hubs/chat';

/** Coarse connection state surfaced to the UI for the reconnecting indicator. */
export type ChatConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

/** One person currently typing in a channel (keyed by AppUser id). */
export interface TypingUser {
  userId: number;
  name: string;
}

/**
 * The single source of truth for live chat + notification state. Owns the SignalR connection
 * lifecycle (start/stop, JWT via accessTokenFactory from {@link AuthService}, automatic reconnect),
 * wires every hub client-event into a signal, exposes the hub server-method calls, and keeps a
 * per-channel message/typing/unread cache that the chat page renders from.
 *
 * Phase 2a-CORE: this is the shared foundation. The chat page component (next phase) injects this
 * service and reads its signals; it never touches the HubConnection directly.
 */
@Injectable({ providedIn: 'root' })
export class ChatRealtime {
  private api = inject(Api);
  private auth = inject(AuthService);

  private connection: HubConnection | null = null;

  /** Per-(channel,user) safety timers that auto-clear a stuck "is typing…" if no StopTyping arrives. */
  private readonly typingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** How long a remote typing flag survives without a refresh before we auto-clear it. */
  private static readonly TYPING_SAFETY_MS = 6000;

  // ---- connection state ----
  private readonly _connection = signal<ChatConnectionState>('disconnected');
  /** Coarse connection state for the reconnecting indicator. */
  readonly connectionState = this._connection.asReadonly();
  /** True while live (fully connected). */
  readonly isConnected = computed(() => this._connection() === 'connected');
  /** True while connecting or reconnecting (show a small "reconnecting" indicator). */
  readonly isReconnecting = computed(() =>
    this._connection() === 'reconnecting' || this._connection() === 'connecting',
  );

  // ---- channels ----
  private readonly _channels = signal<ChatChannelDto[]>([]);
  /** All visible channels + DMs, ordered by most-recent activity (newest last-message first). */
  readonly channels = computed(() => {
    const list = [...this._channels()];
    return list.sort((a, b) => activityTime(b) - activityTime(a));
  });

  // ---- messages, keyed by channelId (oldest-first within each channel) ----
  private readonly _messages = signal<Record<number, ChatMessageDto[]>>({});
  /** All loaded messages for a channel, oldest-first (newest at the bottom). */
  messagesFor(channelId: number): ChatMessageDto[] {
    return this._messages()[channelId] ?? [];
  }
  /** Reactive read of the whole message map (for the chat page to derive a per-channel computed). */
  readonly messages = this._messages.asReadonly();

  // ---- typing, keyed by channelId (excludes the caller) ----
  private readonly _typing = signal<Record<number, TypingUser[]>>({});
  /** Reactive read of who is typing, keyed by channelId. */
  readonly typing = this._typing.asReadonly();
  typingFor(channelId: number): TypingUser[] {
    return this._typing()[channelId] ?? [];
  }

  // ---- per-channel live-location shares (keyed by channelId), mirroring the locationShare* hub events ----
  // A share lives here while !stopped; the chat page derives an ACTIVE list (also respecting expiresUtc via a
  // local countdown). A stopped/ended share is kept (flagged) just long enough for the card to render "ended",
  // then pruned when a fresh active set replaces it.
  private readonly _locationShares = signal<Record<number, ChatLocationShareDto[]>>({});
  /** Reactive read of the live-location shares, keyed by channelId. */
  readonly locationShares = this._locationShares.asReadonly();
  locationSharesFor(channelId: number): ChatLocationShareDto[] {
    return this._locationShares()[channelId] ?? [];
  }

  // ---- per-channel unread MESSAGE counts (mirrors UnreadChanged) ----
  private readonly _unread = signal<Record<number, number>>({});
  readonly unread = this._unread.asReadonly();
  unreadFor(channelId: number): number {
    return this._unread()[channelId] ?? 0;
  }
  /** Total unread messages across all channels. */
  readonly totalUnreadMessages = computed(() =>
    Object.values(this._unread()).reduce((a, b) => a + b, 0),
  );

  // ---- notifications (inbox) ----
  private readonly _notifications = signal<NotificationDto[]>([]);
  /** Recent notifications for the bell dropdown, newest-first. */
  readonly notifications = this._notifications.asReadonly();

  private readonly _inboxUnread = signal(0);
  /** Global unread NOTIFICATION count (mirrors InboxUnreadChanged). */
  readonly inboxUnread = this._inboxUnread.asReadonly();

  // ---- notification delivery preferences ----
  private readonly _preferences = signal<NotificationPreferenceDto>({ ...DEFAULT_PREFERENCES });
  /** The caller's delivery preferences (TRIGGER + SURFACE prefs). Defaults until loaded. */
  readonly preferences = this._preferences.asReadonly();

  /**
   * The most recent LIVE notification (set ONLY in the ReceiveNotification hub handler, never on the
   * initial inbox load or a reconnect re-fetch). The bell reads this in an effect to decide whether to
   * pop a toast / browser notification — so history is never replayed. Each live arrival publishes a
   * fresh wrapper object (new `seq`) so consecutive notifications with the same id still re-fire the
   * effect, and consumers can dedupe on `notification.id`.
   */
  private readonly _liveNotification = signal<{ seq: number; notification: NotificationDto } | null>(null);
  readonly liveNotification = this._liveNotification.asReadonly();
  private liveSeq = 0;

  /**
   * One-shot session-revocation counter. Bumped by the `SessionRevoked` hub event an admin triggers via
   * force-logout (POST /api/users/{id}/logout). The app shell watches this in an effect and signs the user
   * out the instant it arrives — real-time, instead of waiting for the next request / ~20s /me poll to 401.
   * It only ever counts up; consumers track the last value they acted on so a re-login can't re-trigger.
   */
  private readonly _sessionRevoked = signal(0);
  readonly sessionRevoked = this._sessionRevoked.asReadonly();

  // =========================================================================
  // Connection lifecycle
  // =========================================================================

  /**
   * Start the hub connection (idempotent while connected). Pulls the JWT lazily from
   * {@link AuthService} on every (re)negotiation so a refreshed token is always used. No-op if a
   * connection already exists or the user is unauthenticated. After a {@link stop} (e.g. logout)
   * this.connection is null, so the next call builds a FRESH connection bound to the current user's
   * token — the prior user's connection is never reused.
   */
  async start(): Promise<void> {
    if (this.connection || !this.auth.isAuthenticated()) return;

    const connection = new HubConnectionBuilder()
      .withUrl(HUB_URL, {
        accessTokenFactory: () => this.auth.token ?? '',
      })
      .withAutomaticReconnect()
      .withHubProtocol(new JsonHubProtocol())
      .configureLogging(LogLevel.Warning)
      .build();

    this.connection = connection;
    this.registerHandlers(connection);

    connection.onreconnecting(() => this._connection.set('reconnecting'));
    connection.onreconnected(() => {
      this._connection.set('connected');
      // After a reconnect the server replays nothing — re-pull channel list to resync. Also re-pull
      // the inbox so the badge/list catch up on anything missed during the gap; refreshInbox never
      // touches _liveNotification, so this can't replay history as toasts.
      void this.refreshChannels();
      void this.refreshInbox();
    });
    connection.onclose(() => this._connection.set('disconnected'));

    this._connection.set('connecting');
    try {
      await connection.start();
      this._connection.set('connected');
      await this.refreshChannels();
    } catch {
      this._connection.set('disconnected');
      this.connection = null;
      return;
    }

    // Initial inbox + preferences load. These populate the dropdown/badge/prefs but must NOT surface
    // toasts — they never touch _liveNotification (only ReceiveNotification does). They run OUTSIDE
    // the connection try/catch above and each swallows its own error, so a transient REST failure can
    // never tear down a healthy hub connection. Preferences additionally fall back to DEFAULT_PREFERENCES.
    void this.refreshInbox().catch(() => { /* keep the live hub; badge/list stay as-is */ });
    void this.loadPreferences().catch(() => { /* keep DEFAULT_PREFERENCES */ });
  }

  /**
   * Fully tear down the connection and clear all cached state (call on logout, including the forced
   * 401/403 logout path). After this returns this.connection is null so a subsequent {@link start}
   * builds a fresh connection with the next user's token — the prior user's connection/token is never
   * reused, preventing cross-user identity/data leakage.
   */
  async stop(): Promise<void> {
    const c = this.connection;
    this.connection = null;
    this._connection.set('disconnected');
    if (c) {
      try { await c.stop(); } catch { /* ignore */ }
    }
    for (const t of this.typingTimers.values()) clearTimeout(t);
    this.typingTimers.clear();
    this._channels.set([]);
    this._messages.set({});
    this._typing.set({});
    this._locationShares.set({});
    this._unread.set({});
    this._notifications.set([]);
    this._inboxUnread.set(0);
    this._preferences.set({ ...DEFAULT_PREFERENCES });
    this._liveNotification.set(null);
    this.liveSeq = 0;
  }

  // =========================================================================
  // Hub client-event handlers -> signals
  // =========================================================================

  private registerHandlers(c: HubConnection): void {
    c.on('ReceiveMessage', (msg: ChatMessageDto) => this.onReceiveMessage(msg));
    c.on('MessageEdited', (msg: ChatMessageDto) => this.onMessageEdited(msg));
    c.on('MessageDeleted', (channelId: number, messageId: number) => this.onMessageDeleted(channelId, messageId));
    c.on('TypingChanged', (channelId: number, userId: number, userName: string, isTyping: boolean) =>
      this.onTypingChanged(channelId, userId, userName, isTyping));
    c.on('ReceiveNotification', (n: NotificationDto) => this.onReceiveNotification(n));
    c.on('UnreadChanged', (channelId: number, unreadCount: number) => this.onUnreadChanged(channelId, unreadCount));
    c.on('InboxUnreadChanged', (totalUnread: number) => this._inboxUnread.set(totalUnread));
    c.on('ChannelAdded', (channel: ChatChannelDto) => this.onChannelAdded(channel));
    c.on('ReactionChanged', (channelId: number, messageId: number, reactions: ReactionGroupDto[]) =>
      this.onReactionChanged(channelId, messageId, reactions));
    // Live-location share lifecycle (scoped to the conversation group every member's connection joins).
    c.on('locationShareStarted', (share: ChatLocationShareDto) => this.onLocationShareUpsert(share));
    c.on('locationShareUpdated', (share: ChatLocationShareDto) => this.onLocationShareUpsert(share));
    c.on('locationShareExtended', (share: ChatLocationShareDto) => this.onLocationShareUpsert(share));
    c.on('locationShareStopped', (share: ChatLocationShareDto) => this.onLocationShareUpsert(share));
    c.on('SessionRevoked', () => this._sessionRevoked.update(n => n + 1));
  }

  private onReceiveMessage(msg: ChatMessageDto): void {
    this.appendMessage(msg);
    this.patchChannel(msg.channelId, ch => ({ ...ch, lastMessage: msg }));
  }

  private onMessageEdited(msg: ChatMessageDto): void {
    this.replaceMessage(msg);
    this.patchChannel(msg.channelId, ch =>
      ch.lastMessage?.id === msg.id ? { ...ch, lastMessage: msg } : ch);
  }

  private onMessageDeleted(channelId: number, messageId: number): void {
    this._messages.update(map => {
      const list = map[channelId];
      if (!list) return map;
      return {
        ...map,
        [channelId]: list.map(m => m.id === messageId ? { ...m, deleted: true, body: null } : m),
      };
    });
  }

  private onTypingChanged(channelId: number, userId: number, userName: string, isTyping: boolean): void {
    const me = this.auth.userId();
    if (me != null && userId === me) return; // never show yourself typing
    this.setTyping(channelId, userId, userName, isTyping);

    // Safety net: a dropped StopTyping (e.g. the sender navigated away mid-typing) would otherwise
    // leave a stuck "is typing…". Auto-clear ~6s after the last true, refreshing the timer on each true.
    const timerKey = `${channelId}|${userId}`;
    const existing = this.typingTimers.get(timerKey);
    if (existing) clearTimeout(existing);
    if (isTyping) {
      this.typingTimers.set(timerKey, setTimeout(() => {
        this.typingTimers.delete(timerKey);
        this.setTyping(channelId, userId, userName, false);
      }, ChatRealtime.TYPING_SAFETY_MS));
    } else {
      this.typingTimers.delete(timerKey);
    }
  }

  /** Add/remove a single (channel,user) typing entry, keyed by AppUser id. */
  private setTyping(channelId: number, userId: number, userName: string, isTyping: boolean): void {
    this._typing.update(map => {
      const current = (map[channelId] ?? []).filter(u => u.userId !== userId);
      const next = isTyping ? [...current, { userId, name: userName }] : current;
      return { ...map, [channelId]: next };
    });
  }

  private onReceiveNotification(n: NotificationDto): void {
    this._notifications.update(list => [n, ...list.filter(x => x.id !== n.id)]);
    // Publish to the LIVE surface so the bell can toast / browser-notify. This is the ONLY place
    // _liveNotification is set — the initial load and reconnect re-fetch go through refreshInbox(),
    // which never touches it, so backlog/history is never replayed as toasts.
    this._liveNotification.set({ seq: ++this.liveSeq, notification: n });
  }

  private onUnreadChanged(channelId: number, unreadCount: number): void {
    this._unread.update(map => ({ ...map, [channelId]: unreadCount }));
    this.patchChannel(channelId, ch => ({ ...ch, unreadCount }));
  }

  private onChannelAdded(channel: ChatChannelDto): void {
    this._channels.update(list =>
      list.some(c => c.id === channel.id) ? list : [...list, channel]);
    this._unread.update(map => ({ ...map, [channel.id]: channel.unreadCount }));
    // Critical: join so the live connection starts receiving this channel/DM's broadcasts.
    void this.joinChannel(channel.id);
  }

  /** Replace the reaction groups for a single message in the cache (find by channelId + messageId). */
  private onReactionChanged(channelId: number, messageId: number, reactions: ReactionGroupDto[]): void {
    this._messages.update(map => {
      const list = map[channelId];
      if (!list) return map;
      return {
        ...map,
        [channelId]: list.map(m => m.id === messageId ? { ...m, reactions: reactions ?? [] } : m),
      };
    });
  }

  /**
   * Fold a live-location share (from any of the started/updated/extended/stopped events, or a REST call)
   * into the per-channel cache: upsert by share id. We KEEP a stopped/ended share in the list so the card
   * can render its "ended" state — the chat page filters to currently-active for the map, and a fresh
   * {@link refreshLocationShares} prunes ended rows when it replaces the channel's set.
   */
  private onLocationShareUpsert(share: ChatLocationShareDto): void {
    if (!share || share.channelId == null) return;
    this._locationShares.update(map => {
      const list = map[share.channelId] ?? [];
      const next = list.some(s => s.id === share.id)
        ? list.map(s => (s.id === share.id ? share : s))
        : [...list, share];
      return { ...map, [share.channelId]: next };
    });
  }

  // =========================================================================
  // Hub server-method calls
  // =========================================================================

  /** Send a message over the hub. mentionedUserIds is null when there are no @mentions (sent by AppUser id). */
  async sendMessage(channelId: number, body: string, mentionedUserIds: number[] | null = null): Promise<void> {
    await this.invoke('SendMessage', channelId, body, mentionedUserIds);
  }

  async startTyping(channelId: number): Promise<void> {
    await this.invoke('StartTyping', channelId);
  }

  async stopTyping(channelId: number): Promise<void> {
    await this.invoke('StopTyping', channelId);
  }

  /**
   * Mark a channel read up to a message on the server. The local unread badge is cleared by the
   * caller (the user action in the chat page) via {@link clearUnreadLocal}, not here — so this method
   * does not mutate unread state that an effect may also read.
   */
  async markRead(channelId: number, messageId: number): Promise<void> {
    await this.invoke('MarkRead', channelId, messageId);
  }

  /** Optimistically clear the local unread badge for a channel (call from the originating user action). */
  clearUnreadLocal(channelId: number): void {
    this.onUnreadChanged(channelId, 0);
  }

  /** Join a channel group so the live connection receives its broadcasts. */
  async joinChannel(channelId: number): Promise<void> {
    await this.invoke('JoinChannel', channelId);
  }

  /**
   * Toggle an emoji reaction on a message (add if absent, remove if present). Prefers the hub when
   * connected; otherwise falls back to REST and folds the returned groups into the cache directly.
   * The hub path relies on the server's ReactionChanged broadcast (handled by {@link onReactionChanged})
   * to update every client — including this one — so it doesn't fold the result itself.
   */
  async toggleReaction(messageId: number, emoji: string): Promise<void> {
    const c = this.connection;
    if (c && c.state === HubConnectionState.Connected) {
      try {
        await c.invoke('ToggleReaction', messageId, emoji);
        return;
      } catch {
        /* fall through to REST below */
      }
    }
    // REST fallback (offline/reconnecting, or a failed hub invoke). We still get a ReactionChanged
    // broadcast if joined, but fold the response in directly so the chip updates even when we're not.
    const channelId = this.channelIdOfMessage(messageId);
    try {
      const groups = await firstValueFrom(this.api.toggleReaction(messageId, emoji));
      if (channelId != null) this.onReactionChanged(channelId, messageId, groups);
    } catch {
      /* swallow — the UI surfaces connection state separately */
    }
  }

  /** Locate which channel a loaded message belongs to (for folding a REST reaction toggle back in). */
  private channelIdOfMessage(messageId: number): number | null {
    const map = this._messages();
    for (const key of Object.keys(map)) {
      const channelId = Number(key);
      if (map[channelId].some(m => m.id === messageId)) return channelId;
    }
    return null;
  }

  /** Safe invoke: no-ops (does not throw) when the connection isn't live. */
  private async invoke(method: string, ...args: unknown[]): Promise<void> {
    const c = this.connection;
    if (!c || c.state !== HubConnectionState.Connected) return;
    try {
      await c.invoke(method, ...args);
    } catch {
      /* swallow — the UI surfaces connection state separately */
    }
  }

  // =========================================================================
  // REST-backed helpers (channel list, history) — fold results into the cache
  // =========================================================================

  /** (Re)load the channel list and join every channel so live broadcasts arrive. */
  async refreshChannels(): Promise<ChatChannelDto[]> {
    // Guard the array off the async response: a null/undefined body must not make _channels non-iterable
    // (the always-mounted shell chrome — bell/presence — derives off these signals on every page).
    const list = (await firstValueFrom(this.api.chatChannels())) ?? [];
    this._channels.set(list);
    this._unread.update(map => {
      const next = { ...map };
      for (const ch of list) next[ch.id] = ch.unreadCount;
      return next;
    });
    // Join each so the connection receives broadcasts for already-known channels.
    for (const ch of list) void this.joinChannel(ch.id);
    return list;
  }

  /**
   * Create a channel, fold it into the cache, and join it. ChannelAdded may also arrive over the
   * hub; both paths dedupe by id.
   */
  async createChannel(name: string, memberUserIds: number[], opts: { topic?: string; isPrivate?: boolean } = {}): Promise<ChatChannelDto> {
    const ch = await firstValueFrom(this.api.createChannel({
      name, memberUserIds, topic: opts.topic, isPrivate: opts.isPrivate ?? false,
    }));
    this.onChannelAdded(ch);
    return ch;
  }

  /** Open (or fetch the existing) DM with a user by AppUser id; folds it into the cache and joins it. */
  async openDirect(userId: number): Promise<ChatChannelDto> {
    const ch = await firstValueFrom(this.api.openDirect(userId));
    this.onChannelAdded(ch);
    return ch;
  }

  /**
   * Load a page of history into the cache. With no `before`, replaces the channel's message list
   * (initial open); with `before`, prepends older messages (scroll-to-top). Server returns
   * newest-first; we store oldest-first. Returns the number of messages fetched (0 = no more).
   */
  async loadHistory(channelId: number, before?: number, limit = 50): Promise<number> {
    const page = await firstValueFrom(this.api.chatMessages(channelId, { before, limit }));
    const ascending = [...page].reverse(); // newest-first -> oldest-first
    this._messages.update(map => {
      const existing = map[channelId] ?? [];
      const merged = before == null
        ? mergeById(ascending, existing)          // initial load (still dedupe against any live msgs)
        : mergeById(ascending, existing);         // prepend older; mergeById keeps order + dedupes
      return { ...map, [channelId]: merged };
    });
    return page.length;
  }

  // =========================================================================
  // Live-location shares (REST-backed; the hub broadcasts the lifecycle events back to every participant,
  // INCLUDING the caller, so each call also folds its own result in for immediate feedback / offline use)
  // =========================================================================

  /**
   * Replace a channel's known shares with the server's currently-ACTIVE set (so a late-joiner / a freshly
   * opened conversation sees an in-progress share, and ended rows are pruned). Swallows its own error.
   */
  async refreshLocationShares(channelId: number): Promise<ChatLocationShareDto[]> {
    try {
      const list = await firstValueFrom(this.api.activeLocationShares(channelId));
      this._locationShares.update(map => ({ ...map, [channelId]: list }));
      return list;
    } catch {
      return this.locationSharesFor(channelId);
    }
  }

  /** Start a live-location share in a conversation (first fix + duration); folds the result in. */
  async startLocationShare(channelId: number, req: StartLocationShareRequest): Promise<ChatLocationShareDto> {
    const share = await firstValueFrom(this.api.startLocationShare(channelId, req));
    this.onLocationShareUpsert(share);
    return share;
  }

  /** Push the sharer's latest position on a share they own; folds the result in (null when ended/not owned). */
  async updateLocationShare(shareId: number, req: UpdateLocationShareRequest): Promise<ChatLocationShareDto | null> {
    try {
      const share = await firstValueFrom(this.api.updateLocationShare(shareId, req));
      this.onLocationShareUpsert(share);
      return share;
    } catch {
      return null; // 404 (ended/not owned) — the caller stops updating; the card ends on its own countdown
    }
  }

  /** Extend a share the caller owns by N minutes; folds the result in. */
  async extendLocationShare(shareId: number, addMinutes: number): Promise<ChatLocationShareDto | null> {
    try {
      const share = await firstValueFrom(this.api.extendLocationShare(shareId, { addMinutes }));
      this.onLocationShareUpsert(share);
      return share;
    } catch {
      return null;
    }
  }

  /** Stop a share the caller owns (idempotent); folds the ended state in. */
  async stopLocationShare(shareId: number): Promise<ChatLocationShareDto | null> {
    try {
      const share = await firstValueFrom(this.api.stopLocationShare(shareId));
      this.onLocationShareUpsert(share);
      return share;
    } catch {
      return null;
    }
  }

  // =========================================================================
  // Inbox / notifications (REST-backed) — bell UI reads these signals
  // =========================================================================

  /**
   * (Re)load the notification list + unread count from REST. Used on initial start() and safe to call
   * after a reconnect — it replaces the dropdown list and badge from the server's source of truth but
   * NEVER fires the live surface, so it can't replay history as toasts.
   */
  async refreshInbox(limit = 50): Promise<void> {
    const [list, unread] = await Promise.all([
      firstValueFrom(this.api.inboxNotifications({ limit })),
      firstValueFrom(this.api.inboxUnreadCount()),
    ]);
    // Guard the array off the async response so the bell's notifications() read can never see a non-array
    // (it renders in the shell on every authenticated page); coalesce the count likewise.
    this._notifications.set(list ?? []);
    this._inboxUnread.set(unread?.count ?? 0);
  }

  /** Load the caller's delivery preferences into the {@link preferences} signal. */
  async loadPreferences(): Promise<NotificationPreferenceDto> {
    const pref = await firstValueFrom(this.api.getNotificationPreferences());
    this._preferences.set(pref);
    return pref;
  }

  /**
   * Mark one or more notifications read. Calls POST /api/inbox/read with the ids, then folds the
   * server's authoritative unread total back into state and flips the affected rows to read locally so
   * the dropdown updates immediately. No-op for an empty id list.
   */
  async markNotificationsRead(ids: number[]): Promise<void> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return;
    const idSet = new Set(unique);
    const res = await firstValueFrom(this.api.markNotificationsRead(unique));
    this._notifications.update(list =>
      list.map(n => (idSet.has(n.id) && !n.isRead ? { ...n, isRead: true } : n)));
    this._inboxUnread.set(res.unreadCount);
  }

  /** Mark every notification read (POST /api/inbox/read-all); clears the badge and flips all rows. */
  async markAllNotificationsRead(): Promise<void> {
    const res = await firstValueFrom(this.api.markAllNotificationsRead());
    this._notifications.update(list => list.map(n => (n.isRead ? n : { ...n, isRead: true })));
    this._inboxUnread.set(res.unreadCount);
  }

  /** Persist delivery preferences (PUT /api/inbox/preferences) and update the {@link preferences} signal. */
  async updatePreferences(dto: NotificationPreferenceDto): Promise<NotificationPreferenceDto> {
    const saved = await firstValueFrom(this.api.updateNotificationPreferences(dto));
    this._preferences.set(saved);
    return saved;
  }

  // =========================================================================
  // private cache mutators
  // =========================================================================

  private appendMessage(msg: ChatMessageDto): void {
    this._messages.update(map => {
      const list = map[msg.channelId] ?? [];
      if (list.some(m => m.id === msg.id)) return map; // dedupe (e.g. own echo)
      return { ...map, [msg.channelId]: [...list, msg] };
    });
  }

  private replaceMessage(msg: ChatMessageDto): void {
    this._messages.update(map => {
      const list = map[msg.channelId];
      if (!list) return map;
      return {
        ...map,
        [msg.channelId]: list.map(m => {
          if (m.id !== msg.id) return m;
          // Edited-message broadcasts carry empty reactions (reactions flow via ReactionChanged), so
          // keep the existing reaction groups rather than wiping the chips on an edit.
          const reactions = msg.reactions?.length ? msg.reactions : (m.reactions ?? []);
          return { ...msg, reactions };
        }),
      };
    });
  }

  private patchChannel(channelId: number, fn: (ch: ChatChannelDto) => ChatChannelDto): void {
    this._channels.update(list => list.map(ch => ch.id === channelId ? fn(ch) : ch));
  }
}

/** Sort key for channel ordering: last-message time, else 0 (newest activity first). */
function activityTime(ch: ChatChannelDto): number {
  const t = ch.lastMessage?.createdUtc;
  return t ? new Date(t).getTime() : 0;
}

/** Merge two oldest-first message lists by id, preserving ascending order and deduping. */
function mergeById(a: ChatMessageDto[], b: ChatMessageDto[]): ChatMessageDto[] {
  const byId = new Map<number, ChatMessageDto>();
  for (const m of a) byId.set(m.id, m);
  for (const m of b) byId.set(m.id, m);
  return [...byId.values()].sort((x, y) => x.id - y.id);
}
