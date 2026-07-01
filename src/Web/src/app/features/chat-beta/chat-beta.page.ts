import {
  ChangeDetectionStrategy, Component, DestroyRef, ElementRef, OnDestroy,
  computed, effect, inject, signal, viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { ActivatedRoute } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { firstValueFrom, catchError, of } from 'rxjs';

import { Api } from '../../core/api';
import { AuthService } from '../../core/auth';
import { ChatRealtime, TypingUser } from '../../core/chat-realtime';
import {
  ChatChannelDto, ChatComposeAction, ChatContactDto, ChatMember, ChatMessageDto, PERM, Presence,
} from '../../core/models';

import {
  BetaPullRefresh, BetaBottomSheet, BetaToaster, ToastController, BetaSkeleton,
  BetaSwipeRow, BetaFab, BetaSegmentedControl, BetaChip, type Segment,
} from '../beta-ui';
import { ConversationRow } from './conversation-row';
import { MessageBubble } from './message-bubble';

/** One pickable teammate in the create-channel / DM picker (contacts, or the directory for an admin). */
interface PickPerson {
  userId: number;
  name: string;
  picture?: string | null;
  online: boolean;
}

/** One @mention autocomplete candidate (a channel member matching the active token). */
interface MentionCandidate extends ChatMember {
  initials: string;
}

/** The compose-assist actions offered in the composer ✨ sheet (drives the reshape buttons). */
const COMPOSE_ACTIONS: readonly { action: Exclude<ChatComposeAction, 'draft'>; label: string; icon: string }[] = [
  { action: 'rewrite', label: 'Rewrite', icon: 'autorenew' },
  { action: 'shorten', label: 'Shorten', icon: 'compress' },
  { action: 'friendlier', label: 'Friendlier', icon: 'sentiment_satisfied' },
  { action: 'formal', label: 'More formal', icon: 'business_center' },
];

/** A message paired with its rendering flags (run grouping + day separators), derived per thread. */
interface ThreadRow {
  msg: ChatMessageDto;
  mine: boolean;
  showAvatar: boolean;   // first bubble of a sender run -> show avatar + name
  showTail: boolean;     // last bubble of a sender run -> draw the tail
  daySep: string | null; // a day-separator label to render ABOVE this bubble, or null
}

/**
 * The curated reaction set offered in the react sheet — the same 40 emotes the desktop /chat picker
 * offers (chat.ts REACTION_EMOJIS). The first eight are the quick favourites; the rest round out
 * reactions for everyday needs. No external emoji dependency.
 */
const REACTIONS = [
  '👍', '❤️', '😂', '🎉', '😮', '😢', '🙏', '🔥',
  '👏', '😀', '😅', '😉', '😍', '🤔', '🙄', '😎',
  '😴', '😱', '🤯', '🥳', '😭', '😡', '👀', '💯',
  '✅', '❌', '⚡', '🚀', '💡', '⭐', '✨', '💪',
  '🤝', '👋', '🙌', '🤷', '👌', '🤞', '☕', '🐛',
] as const;

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
    BetaFab, BetaSegmentedControl, BetaChip,
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

      @if (canSendPerm()) {
        <app-bs-fab icon="add" label="New conversation" [fixed]="true" (action)="openCreate('channel')" />
      }
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
          <button type="button" class="th__ai" (click)="catchMeUp()"
                  [disabled]="catchUpLoading()" aria-label="Catch me up">
            <mat-icon aria-hidden="true">auto_awesome</mat-icon>
          </button>
        </header>

        <div #scroll class="th__scroll" (scroll)="onThreadScroll()">
          @if (loadingOlder()) {
            <div class="th__older" aria-live="polite">
              <span class="th__older-dot" aria-hidden="true"></span> Loading earlier messages…
            </div>
          }

          <!-- ✨ Catch me up recap card (dismissible) -->
          @if (catchUpLoading()) {
            <div class="recap recap--wait" aria-live="polite">
              <mat-icon class="recap__i" aria-hidden="true">auto_awesome</mat-icon>
              <span class="recap__body">Catching you up…</span>
            </div>
          } @else if (catchUpSummary(); as sum) {
            <div class="recap" [class.recap--plain]="catchUpPlain()" aria-live="polite">
              <mat-icon class="recap__i" aria-hidden="true">auto_awesome</mat-icon>
              <div class="recap__col">
                <span class="recap__t">Caught up</span>
                <p class="recap__body">{{ sum }}</p>
              </div>
              <button type="button" class="recap__x" (click)="dismissCatchUp()" aria-label="Dismiss recap">
                <mat-icon aria-hidden="true">close</mat-icon>
              </button>
            </div>
          } @else if (catchUpError(); as err) {
            <div class="recap recap--err" aria-live="polite">
              <span class="recap__body">{{ err }}</span>
              <button type="button" class="recap__x" (click)="dismissCatchUp()" aria-label="Dismiss">
                <mat-icon aria-hidden="true">close</mat-icon>
              </button>
            </div>
          }

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
              <div class="bubrow" [class.run-start]="r.showAvatar" [attr.data-msg-id]="r.msg.id">
                <cb-bubble [msg]="r.msg" [mine]="r.mine" [showAvatar]="r.showAvatar"
                           [showTail]="r.showTail" [meUserId]="meUserId()"
                           (react)="openReactSheet($event)"
                           (toggle)="toggleReaction($event.messageId, $event.emoji)" />
              </div>
            }
          }

          @if (typingLabel(); as tl) {
            <div class="typing" aria-live="polite">
              <span class="typing__stack" aria-hidden="true">
                @for (p of typingPeople(); track p.userId) {
                  @if (p.picture) {
                    <img class="typing__ava" [src]="p.picture" alt="" referrerpolicy="no-referrer" loading="lazy" />
                  } @else {
                    <span class="typing__ava typing__mono" [style.--h]="p.hue">{{ p.initials }}</span>
                  }
                }
              </span>
              <span class="typing__dots" aria-hidden="true"><i></i><i></i><i></i></span>
              <app-bs-chip class="typing__chip" [label]="tl" [badge]="false" variant="soft" />
            </div>
          }
          <div class="th__foot" aria-hidden="true"></div>
        </div>

        <!-- Reply suggestion chips (✨) — tapping fills the composer, never sends -->
        @if (replySuggestions().length || repliesLoading() || repliesError()) {
          <div class="rsug" aria-live="polite">
            @if (repliesLoading()) {
              <span class="rsug__wait"><span class="rsug__dot" aria-hidden="true"></span> Thinking of replies…</span>
            } @else if (repliesError(); as e) {
              <span class="rsug__err">{{ e }}</span>
              <button type="button" class="rsug__x" (click)="dismissReplies()" aria-label="Dismiss">
                <mat-icon aria-hidden="true">close</mat-icon>
              </button>
            } @else {
              @for (r of replySuggestions(); track r) {
                <button type="button" class="rsug__chip" (click)="useReply(r)">{{ r }}</button>
              }
              <button type="button" class="rsug__x" (click)="dismissReplies()" aria-label="Dismiss suggestions">
                <mat-icon aria-hidden="true">close</mat-icon>
              </button>
            }
          </div>
        }

        <!-- Composer bar -->
        <div class="composer-wrap">
          <!-- @mention autocomplete popover -->
          @if (mentionOpen()) {
            <ul class="ment" role="listbox" aria-label="Mention a member">
              @for (c of mentionCandidates(); track c.userId; let i = $index) {
                <li>
                  <button type="button" class="ment__row" [class.is-active]="i === mentionIndex()"
                          role="option" [attr.aria-selected]="i === mentionIndex()"
                          (click)="applyMention(c)">
                    <span class="ment__ava" aria-hidden="true">
                      @if (c.picture) {
                        <img class="ment__img" [src]="c.picture" alt="" referrerpolicy="no-referrer" />
                      } @else { <span class="ment__mono">{{ c.initials }}</span> }
                    </span>
                    <span class="ment__name">{{ c.name }}</span>
                  </button>
                </li>
              }
            </ul>
          }

          @if (canSendPerm()) {
            <form class="composer" (submit)="send($event)">
              <button type="button" class="composer__ai" (click)="composeOpen.set(true)"
                      [disabled]="composeBusy()" aria-label="AI compose assist">
                <mat-icon aria-hidden="true">auto_awesome</mat-icon>
              </button>
              <textarea #composer class="composer__in" [(ngModel)]="draft" name="draft"
                        rows="1" placeholder="Message…" aria-label="Message"
                        enterkeyhint="send" autocomplete="off"
                        (input)="onDraftInput()" (keydown)="onKeydown($event)"
                        (blur)="closeMentionsSoon()"></textarea>
              <button type="submit" class="composer__send" [disabled]="!canSend()" aria-label="Send">
                <mat-icon aria-hidden="true">arrow_upward</mat-icon>
              </button>
            </form>
          } @else {
            <!-- Read-only access (no chat.send perm): mirror desktop's inline notice. -->
            <div class="composer-ro" role="status">
              <mat-icon aria-hidden="true">visibility</mat-icon>
              <span>You have read-only access to this conversation.</span>
            </div>
          }
        </div>
      </section>
    }

    <!-- ══════════════ Create channel / DM (kit bottom sheet) ══════════════ -->
    <app-bs-sheet [(open)]="createOpen" detent="full" label="New conversation">
      <div class="mk">
        <h2 class="mk__h">New conversation</h2>
        <app-bs-segmented class="mk__seg" [segments]="createSegments" [value]="createMode()"
                          (change)="setCreateMode($any($event))" label="Conversation type" />

        @if (createMode() === 'channel') {
          <label class="mk__field">
            <span class="mk__lbl">Channel name</span>
            <input class="mk__in" type="text" [ngModel]="mkName()" (ngModelChange)="mkName.set($event)"
                   name="mkName" placeholder="e.g. weekend-plans" maxlength="80" autocomplete="off" />
          </label>
          <label class="mk__field">
            <span class="mk__lbl">Topic <em>(optional)</em></span>
            <input class="mk__in" type="text" [ngModel]="mkTopic()" (ngModelChange)="mkTopic.set($event)"
                   name="mkTopic" placeholder="What's this channel about?" maxlength="200" autocomplete="off" />
          </label>
          <button type="button" class="mk__toggle" (click)="mkPrivate.set(!mkPrivate())"
                  [attr.aria-pressed]="mkPrivate()">
            <mat-icon aria-hidden="true">{{ mkPrivate() ? 'lock' : 'public' }}</mat-icon>
            <span class="mk__toggle-t">
              <span class="mk__toggle-h">{{ mkPrivate() ? 'Private channel' : 'Open channel' }}</span>
              <span class="mk__toggle-s">{{ mkPrivate() ? 'Only invited members can find and join.' : 'Anyone can be added.' }}</span>
            </span>
            <span class="mk__switch" [class.is-on]="mkPrivate()" aria-hidden="true"><span></span></span>
          </button>
        }

        <div class="mk__pick">
          <span class="mk__lbl">
            {{ createMode() === 'direct' ? 'Choose a person' : 'Add members' }}
            @if (createMode() === 'channel' && mkSelected().size) { <em>· {{ mkSelected().size }} selected</em> }
          </span>
          <label class="mk__search">
            <mat-icon aria-hidden="true">search</mat-icon>
            <input class="mk__search-in" type="search" [ngModel]="mkQuery()" (ngModelChange)="mkQuery.set($event)"
                   name="mkQuery" placeholder="Search people" aria-label="Search people" autocomplete="off" />
          </label>
          @if (mkPeople().length === 0) {
            <p class="mk__empty">{{ mkEmptyCopy() }}</p>
          } @else if (mkFilteredPeople().length === 0) {
            <p class="mk__empty">No people match your search.</p>
          } @else {
            <ul class="mk__list">
              @for (p of mkFilteredPeople(); track p.userId) {
                <li>
                  <button type="button" class="mk__person" [class.is-sel]="mkIsSelected(p.userId)"
                          (click)="mkToggle(p.userId)" [attr.aria-pressed]="mkIsSelected(p.userId)">
                    <span class="mk__ava" aria-hidden="true">
                      @if (p.picture) {
                        <img class="mk__img" [src]="p.picture" alt="" referrerpolicy="no-referrer" />
                      } @else { <span class="mk__mono">{{ mkInitials(p) }}</span> }
                      @if (p.online) { <span class="mk__dot"></span> }
                    </span>
                    <span class="mk__pname">{{ p.name }}</span>
                    @if (mkIsSelected(p.userId)) { <mat-icon class="mk__check" aria-hidden="true">check_circle</mat-icon> }
                  </button>
                </li>
              }
            </ul>
          }
        </div>

        @if (mkError(); as e) { <p class="mk__err">{{ e }}</p> }

        <div class="mk__actions">
          <button type="button" class="mk__btn mk__btn--ghost" (click)="createOpen.set(false)">Cancel</button>
          <button type="button" class="mk__btn mk__btn--go" [disabled]="!mkCanSubmit()" (click)="submitCreate()">
            {{ mkBusy() ? 'Creating…' : (createMode() === 'direct' ? 'Start chat' : 'Create channel') }}
          </button>
        </div>
      </div>
    </app-bs-sheet>

    <!-- ══════════════ Message actions (long-press) ══════════════ -->
    <app-bs-sheet [(open)]="actionOpen" detent="peek" label="Message actions">
      <div class="macts">
        <button type="button" class="macts__row" (click)="reactFromAction()">
          <mat-icon aria-hidden="true">add_reaction</mat-icon> Add reaction
        </button>
        @if (actionCanManage()) {
          <button type="button" class="macts__row" (click)="startEditFromAction()">
            <mat-icon aria-hidden="true">edit</mat-icon> Edit message
          </button>
          <button type="button" class="macts__row macts__row--danger" (click)="deleteFromAction()">
            <mat-icon aria-hidden="true">delete</mat-icon> Delete message
          </button>
        }
      </div>
    </app-bs-sheet>

    <!-- ══════════════ Edit message ══════════════ -->
    <app-bs-sheet [(open)]="editOpen" detent="peek" label="Edit message">
      <div class="edit">
        <h2 class="edit__h">Edit message</h2>
        <textarea class="edit__in" [ngModel]="editDraft()" (ngModelChange)="editDraft.set($event)"
                  name="editDraft" rows="3" aria-label="Edit message"></textarea>
        <div class="edit__actions">
          <button type="button" class="mk__btn mk__btn--ghost" (click)="editOpen.set(false)">Cancel</button>
          <button type="button" class="mk__btn mk__btn--go" [disabled]="!editDraft().trim()" (click)="saveEdit()">Save</button>
        </div>
      </div>
    </app-bs-sheet>

    <!-- ══════════════ ✨ Compose assist ══════════════ -->
    <app-bs-sheet [(open)]="composeOpen" detent="half" label="AI compose assist">
      <div class="ai">
        <h2 class="ai__h"><mat-icon aria-hidden="true">auto_awesome</mat-icon> Compose assist</h2>

        <button type="button" class="ai__row" (click)="suggestReplies()" [disabled]="composeBusy()">
          <mat-icon aria-hidden="true">quickreply</mat-icon>
          <span class="ai__row-t"><span class="ai__row-h">Suggest replies</span>
            <span class="ai__row-s">A few short replies you can tap to use.</span></span>
        </button>

        <div class="ai__prompt">
          <span class="ai__lbl">Draft from a prompt</span>
          <textarea class="ai__in" [ngModel]="composePrompt()" (ngModelChange)="composePrompt.set($event)"
                    name="composePrompt" rows="2" placeholder="e.g. Ask if they're free Saturday afternoon"
                    aria-label="Draft prompt"></textarea>
          <button type="button" class="mk__btn mk__btn--go ai__draft" [disabled]="composeBusy() || !composePrompt().trim()"
                  (click)="runDraftFromPrompt()">Draft it</button>
        </div>

        <span class="ai__lbl">Refine your draft</span>
        <div class="ai__grid">
          @for (a of COMPOSE_ACTIONS; track a.action) {
            <button type="button" class="ai__chip" (click)="composeFromDraft(a.action)" [disabled]="composeBusy()">
              <mat-icon aria-hidden="true">{{ a.icon }}</mat-icon> {{ a.label }}
            </button>
          }
        </div>

        @if (composeBusy()) { <p class="ai__note ai__note--wait">Working…</p> }
        @if (composeError(); as e) { <p class="ai__note ai__note--err">{{ e }}</p> }
      </div>
    </app-bs-sheet>

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
  private readonly route = inject(ActivatedRoute);

  protected readonly EMOJI = REACTIONS;
  protected readonly COMPOSE_ACTIONS = COMPOSE_ACTIONS;
  protected readonly createSegments: Segment[] = [
    { key: 'channel', label: 'Channel' },
    { key: 'direct', label: 'Direct' },
  ];

  // ── permissions (guarded exactly like the desktop page) ──
  /** May write into a conversation (create/DM, send, edit own, react, AI compose). */
  protected readonly canSendPerm = computed(() => this.auth.hasPermission(PERM.chatSend));
  protected readonly canModerate = computed(() => this.auth.hasPermission(PERM.chatModerate));
  /** Admins pick from the full directory; regular users pick from their curated contacts circle. */
  private readonly canManageContacts = computed(() => this.auth.hasPermission(PERM.chatContactsManage));

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

  // ── message-action sheet (long-press) + inline edit ──
  readonly actionOpen = signal(false);
  private actionTarget: ChatMessageDto | null = null;
  protected readonly actionCanManage = signal(false);
  readonly editOpen = signal(false);
  readonly editDraft = signal('');
  private editTarget: ChatMessageDto | null = null;

  // ── create channel / DM sheet ──
  readonly createOpen = signal(false);
  protected readonly createMode = signal<'channel' | 'direct'>('channel');
  private readonly contacts = signal<ChatContactDto[]>([]);
  protected readonly mkName = signal('');
  protected readonly mkTopic = signal('');
  protected readonly mkPrivate = signal(false);
  protected readonly mkQuery = signal('');
  protected readonly mkSelected = signal<Set<number>>(new Set());
  protected readonly mkBusy = signal(false);
  protected readonly mkError = signal<string | null>(null);

  // ── @mention autocomplete (over the active channel's members) ──
  protected readonly mentionOpen = signal(false);
  protected readonly mentionCandidates = signal<MentionCandidate[]>([]);
  protected readonly mentionIndex = signal(0);
  private mentionStart = -1;

  // ── ✨ AI assists ──
  readonly composeOpen = signal(false);
  protected readonly composeBusy = signal(false);
  protected readonly composeError = signal<string | null>(null);
  protected readonly composePrompt = signal('');
  protected readonly repliesLoading = signal(false);
  protected readonly replySuggestions = signal<string[]>([]);
  protected readonly repliesError = signal<string | null>(null);
  protected readonly catchUpLoading = signal(false);
  protected readonly catchUpSummary = signal<string | null>(null);
  protected readonly catchUpPlain = signal(false);
  protected readonly catchUpError = signal<string | null>(null);

  // ── older-history paging ──
  protected readonly loadingOlder = signal(false);
  private readonly exhausted = signal<Set<number>>(new Set());
  private preserveFromBottom: number | null = null;

  // ── notification deep link (?c= channel, ?m= message) ──
  private deepLinkChannel: number | null = null;
  private pendingScrollToMessage: number | null = null;
  private resolvingDeepLink = false;

  // ── create-picker derived lists ──
  private readonly mkCandidates = computed<PickPerson[]>(() => {
    const me = this.meUserId();
    const online = this.presenceById();
    const now = Date.now();
    return this.contacts()
      .filter(c => c.userId !== me)
      .map(c => {
        const seen = online.get(c.userId);
        return {
          userId: c.userId, name: c.name, picture: c.picture,
          online: seen != null && now - seen < ChatBetaPage.PRESENCE_WINDOW_MS,
        };
      })
      .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  });
  protected readonly mkPeople = this.mkCandidates;
  protected readonly mkFilteredPeople = computed<PickPerson[]>(() => {
    const q = this.mkQuery().trim().toLowerCase();
    const list = this.mkCandidates();
    return q ? list.filter(p => p.name.toLowerCase().includes(q)) : list;
  });
  protected readonly mkEmptyCopy = computed(() =>
    this.canManageContacts()
      ? 'No other teammates available yet.'
      : 'No contacts yet — ask an admin to add some to your circle.');
  protected readonly mkCanSubmit = computed(() => {
    if (this.mkBusy()) return false;
    if (this.createMode() === 'direct') return this.mkSelected().size === 1;
    return this.mkName().trim().length > 0;
  });

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

  /**
   * The typing users of the open thread, resolved to avatar data (photo from the channel roster when
   * known, else a monogram + stable hue — mirrors the message bubble). Drives the avatar bubble beside
   * the typing dots. Capped at 3 so a busy channel doesn't overflow the row.
   */
  protected readonly typingPeople = computed<{ userId: number; name: string; picture: string | null; initials: string; hue: number }[]>(() => {
    const id = this.activeId();
    if (id == null) return [];
    const who: TypingUser[] = this.rt.typing()[id] ?? [];
    const members = this.active()?.members ?? [];
    return who.slice(0, 3).map(u => {
      const name = u.name || members.find(m => m.userId === u.userId)?.name || '?';
      return {
        userId: u.userId,
        name,
        picture: members.find(m => m.userId === u.userId)?.picture || null,
        initials: initialsOf(name),
        hue: (u.userId * 47) % 360,
      };
    });
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
    // Suppressed while we're anchoring a just-prepended older-history page (preserveFromBottom set).
    effect(() => {
      this.rows();
      this.typingLabel();
      if (this.activeId() == null) return;
      if (this.preserveFromBottom != null) {
        queueMicrotask(() => this.restoreScrollAfterPrepend());
      } else {
        queueMicrotask(() => this.scrollToBottom());
      }
    });

    // Honor notification deep links: /beta/chat?c={channelId}&m={messageId}. React to the live
    // queryParamMap stream (the component isn't recreated when a different notification is clicked).
    this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe(params => {
      const c = Number(params.get('c'));
      if (!c || Number.isNaN(c)) {
        this.deepLinkChannel = null;
        this.pendingScrollToMessage = null;
        return;
      }
      const m = Number(params.get('m'));
      this.deepLinkChannel = c;
      this.pendingScrollToMessage = m && !Number.isNaN(m) ? m : null;
      void this.resolveDeepLink(c);
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
    this.closeMentions();
    this.resetAiAssists(); // AI recap / reply chips / compose are per-channel — clear on switch
    this.preserveFromBottom = null;
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
    this.closeMentions();
    this.resetAiAssists();
  }

  // ── composer ──
  onDraftInput(): void {
    this.autoGrow();
    this.updateMentionState();
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
    // @mention navigation takes precedence while the popup is open.
    if (this.mentionOpen()) {
      if (ev.key === 'ArrowDown') { ev.preventDefault(); this.moveMention(1); return; }
      if (ev.key === 'ArrowUp') { ev.preventDefault(); this.moveMention(-1); return; }
      if (ev.key === 'Enter' || ev.key === 'Tab') {
        ev.preventDefault();
        this.applyMention(this.mentionCandidates()[this.mentionIndex()]);
        return;
      }
      if (ev.key === 'Escape') { ev.preventDefault(); this.closeMentions(); return; }
    }
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
    const mentions = this.extractMentions(body);
    this.draft = '';
    this.closeMentions();
    this.autoGrow();
    this.flushStopTyping();
    try {
      await this.rt.sendMessage(id, body, mentions.length ? mentions : null);
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
  pickReaction(emoji: string): void {
    const msg = this.reactTarget;
    this.reactOpen.set(false);
    if (msg) void this.rt.toggleReaction(msg.id, emoji);
    this.reactTarget = null;
  }

  toggleReaction(messageId: number, emoji: string): void {
    void this.rt.toggleReaction(messageId, emoji);
  }

  // ══════════════════════════════════════════════════════════════════════
  // Long-press message actions (edit / delete / react), inline edit
  // ══════════════════════════════════════════════════════════════════════

  /** True when the signed-in user may edit/delete this message (own message, or chat.moderate). */
  private canManageMessage(m: ChatMessageDto): boolean {
    const me = this.meUserId();
    return !m.deleted && (this.canModerate() || (me != null && m.senderUserId === me));
  }

  /**
   * The bubble's long-press bubbles a `react` intent. Route it: if the message is mine (or I moderate)
   * open the ACTION sheet (edit / delete / add reaction); otherwise go straight to the react picker.
   */
  openReactSheet(msg: ChatMessageDto): void {
    if (this.canSendPerm() && this.canManageMessage(msg)) {
      this.actionTarget = msg;
      this.actionCanManage.set(true);
      this.actionOpen.set(true);
      return;
    }
    this.reactTarget = msg;
    this.reactOpen.set(true);
  }

  /** From the action sheet: switch to the emoji react picker for the same message. */
  reactFromAction(): void {
    const msg = this.actionTarget;
    this.actionOpen.set(false);
    if (msg) { this.reactTarget = msg; this.reactOpen.set(true); }
  }

  startEditFromAction(): void {
    const msg = this.actionTarget;
    this.actionOpen.set(false);
    if (!msg) return;
    this.editTarget = msg;
    this.editDraft.set(msg.body ?? '');
    this.editOpen.set(true);
  }

  deleteFromAction(): void {
    const msg = this.actionTarget;
    this.actionOpen.set(false);
    this.actionTarget = null;
    if (!msg) return;
    this.api.deleteChatMessage(msg.id).subscribe({
      error: () => this.toasts.show('Couldn’t delete the message', { tone: 'warn' }),
    });
  }

  saveEdit(): void {
    const msg = this.editTarget;
    if (!msg) { this.editOpen.set(false); return; }
    const body = this.editDraft().trim();
    if (!body) { this.editOpen.set(false); this.deleteMessageDirect(msg); return; }
    if (body === (msg.body ?? '')) { this.editOpen.set(false); this.editTarget = null; return; }
    this.api.editChatMessage(msg.id, body).subscribe({
      next: () => { this.editOpen.set(false); this.editTarget = null; },
      error: () => this.toasts.show('Couldn’t edit the message', { tone: 'warn' }),
    });
  }

  private deleteMessageDirect(m: ChatMessageDto): void {
    this.api.deleteChatMessage(m.id).subscribe({
      error: () => this.toasts.show('Couldn’t delete the message', { tone: 'warn' }),
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  // Create channel / start DM
  // ══════════════════════════════════════════════════════════════════════

  openCreate(mode: 'channel' | 'direct'): void {
    if (!this.canSendPerm()) return;
    this.createMode.set(mode);
    this.mkName.set(''); this.mkTopic.set(''); this.mkPrivate.set(false);
    this.mkQuery.set(''); this.mkSelected.set(new Set());
    this.mkError.set(null); this.mkBusy.set(false);
    // Refresh the candidate source (admins → full directory, everyone else → their circle).
    const source$ = this.canManageContacts() ? this.api.chatDirectory() : this.api.myContacts();
    source$.pipe(catchError(() => of<ChatContactDto[]>([]))).subscribe(list => this.contacts.set(list));
    void this.refreshPresence();
    this.createOpen.set(true);
  }

  setCreateMode(m: 'channel' | 'direct'): void {
    if (m === this.createMode()) return;
    this.createMode.set(m);
    this.mkSelected.set(new Set()); // selection semantics differ between modes
    this.mkError.set(null);
  }

  mkIsSelected(userId: number): boolean {
    return this.mkSelected().has(userId);
  }

  mkToggle(userId: number): void {
    if (this.createMode() === 'direct') {
      this.mkSelected.set(this.mkIsSelected(userId) ? new Set() : new Set([userId]));
      return;
    }
    const next = new Set(this.mkSelected());
    next.has(userId) ? next.delete(userId) : next.add(userId);
    this.mkSelected.set(next);
  }

  mkInitials(p: PickPerson): string {
    const parts = (p.name || '').split(/[\s@.]+/).filter(Boolean);
    return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || 'U';
  }

  submitCreate(): void {
    if (!this.mkCanSubmit()) return;
    this.mkBusy.set(true);
    this.mkError.set(null);
    const fail = (e: unknown) => {
      this.mkBusy.set(false);
      const err = e as { error?: { message?: string } };
      this.mkError.set(err?.error?.message ?? 'Could not create the conversation. Please try again.');
    };
    const opened = (ch: ChatChannelDto) => {
      this.mkBusy.set(false);
      this.createOpen.set(false);
      void this.openConversation(ch);
    };

    if (this.createMode() === 'direct') {
      const userId = [...this.mkSelected()][0];
      this.rt.openDirect(userId).then(opened).catch(fail);
      return;
    }
    const members = [...this.mkSelected()];
    this.rt
      .createChannel(this.mkName().trim(), members, {
        topic: this.mkTopic().trim() || undefined,
        isPrivate: this.mkPrivate(),
      })
      .then(opened).catch(fail);
  }

  // ══════════════════════════════════════════════════════════════════════
  // @mention autocomplete
  // ══════════════════════════════════════════════════════════════════════

  private updateMentionState(): void {
    const el = this.composerEl()?.nativeElement;
    const ch = this.active();
    if (!el || !ch) { this.closeMentions(); return; }
    const caret = el.selectionStart ?? this.draft.length;
    const upto = this.draft.slice(0, caret);
    const match = /(?:^|\s)@([\w.\-]*)$/.exec(upto);
    if (!match) { this.closeMentions(); return; }
    this.mentionStart = caret - match[1].length - 1;
    const token = match[1].toLowerCase();
    const me = this.meUserId();
    const candidates = (ch.members ?? [])
      .filter(m => m.userId !== me)
      .filter(m => !token || m.name.toLowerCase().includes(token))
      .slice(0, 6)
      .map(m => ({ ...m, initials: initialsOf(m.name) }));
    if (candidates.length === 0) { this.closeMentions(); return; }
    this.mentionCandidates.set(candidates);
    this.mentionIndex.set(0);
    this.mentionOpen.set(true);
  }

  private moveMention(delta: number): void {
    const n = this.mentionCandidates().length;
    if (n === 0) return;
    this.mentionIndex.update(i => (i + delta + n) % n);
  }

  applyMention(c: MentionCandidate | undefined): void {
    const el = this.composerEl()?.nativeElement;
    if (!c || this.mentionStart < 0) { this.closeMentions(); return; }
    const caret = el?.selectionStart ?? this.draft.length;
    const before = this.draft.slice(0, this.mentionStart);
    const after = this.draft.slice(caret);
    const token = `@${c.name} `;
    this.draft = before + token + after;
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

  /** Resolve "@Name" tokens in the body to mentioned members' AppUser ids (mirrors the desktop contract). */
  private extractMentions(body: string): number[] {
    const ch = this.active();
    if (!ch) return [];
    const me = this.meUserId();
    const lower = body.toLowerCase();
    const ids = new Set<number>();
    for (const m of ch.members ?? []) {
      if (m.userId === me || !m.name) continue;
      const needle = `@${m.name.toLowerCase()}`;
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

  // ══════════════════════════════════════════════════════════════════════
  // ✨ AI assists — catch-up / suggest-replies / compose. Graceful; never auto-sends.
  // ══════════════════════════════════════════════════════════════════════

  private resetAiAssists(): void {
    this.catchUpLoading.set(false); this.catchUpSummary.set(null);
    this.catchUpPlain.set(false); this.catchUpError.set(null);
    this.repliesLoading.set(false); this.replySuggestions.set([]); this.repliesError.set(null);
    this.composeBusy.set(false); this.composeError.set(null); this.composePrompt.set('');
    this.composeOpen.set(false);
  }

  catchMeUp(): void {
    const id = this.activeId();
    if (id == null || this.catchUpLoading()) return;
    this.catchUpError.set(null);
    this.catchUpLoading.set(true);
    this.api.chatCatchUp(id).subscribe({
      next: res => {
        if (this.activeId() !== id) return;
        this.catchUpSummary.set(res.summary?.trim() || 'Nothing new to catch up on.');
        this.catchUpPlain.set(!!res.fellBackToPlain);
        this.catchUpLoading.set(false);
      },
      error: () => {
        if (this.activeId() !== id) return;
        this.catchUpError.set('Couldn’t reach the recap just now. Please try again in a moment.');
        this.catchUpLoading.set(false);
      },
    });
  }

  dismissCatchUp(): void {
    this.catchUpSummary.set(null); this.catchUpPlain.set(false); this.catchUpError.set(null);
  }

  suggestReplies(): void {
    const id = this.activeId();
    if (id == null || !this.canSendPerm() || this.repliesLoading()) return;
    this.composeOpen.set(false); // let the chips show above the composer
    this.repliesError.set(null);
    this.repliesLoading.set(true);
    this.api.chatSuggestReplies(id).subscribe({
      next: res => {
        if (this.activeId() !== id) return;
        const list = (res.replies ?? []).map(r => r.trim()).filter(Boolean);
        this.replySuggestions.set(list);
        if (list.length === 0) this.repliesError.set('No suggestions right now — just type a reply.');
        this.repliesLoading.set(false);
      },
      error: (e: unknown) => {
        if (this.activeId() !== id) return;
        this.replySuggestions.set([]);
        this.repliesError.set(this.aiMessage(e, 'replies'));
        this.repliesLoading.set(false);
      },
    });
  }

  useReply(text: string): void {
    if (!this.canSendPerm()) return;
    this.draft = text;
    this.replySuggestions.set([]);
    this.repliesError.set(null);
    queueMicrotask(() => {
      const node = this.composerEl()?.nativeElement;
      if (node) { node.focus(); const end = text.length; node.setSelectionRange(end, end); this.autoGrow(); }
    });
  }

  dismissReplies(): void {
    this.replySuggestions.set([]); this.repliesError.set(null);
  }

  runDraftFromPrompt(): void {
    const prompt = this.composePrompt().trim();
    if (!prompt) { this.composeError.set('Type a prompt to draft from.'); return; }
    this.compose('draft', { prompt });
  }

  composeFromDraft(action: Exclude<ChatComposeAction, 'draft'>): void {
    const currentDraft = this.draft.trim();
    if (!currentDraft) { this.composeError.set('Type a draft first, then I can refine it.'); return; }
    this.compose(action, { currentDraft });
  }

  private compose(action: ChatComposeAction, opts: { prompt?: string; currentDraft?: string }): void {
    if (!this.canSendPerm() || this.composeBusy()) return;
    this.composeError.set(null);
    this.composeBusy.set(true);
    this.api.chatCompose(action, opts).subscribe({
      next: res => {
        const body = res.body?.trim();
        if (body) {
          this.draft = body;
          this.composePrompt.set('');
          this.composeOpen.set(false);
          queueMicrotask(() => { this.focusComposerEnd(); this.autoGrow(); });
        } else {
          this.composeError.set('Couldn’t compose that just now. Please try again.');
        }
        this.composeBusy.set(false);
      },
      error: (e: unknown) => {
        this.composeError.set(this.aiMessage(e, 'compose'));
        this.composeBusy.set(false);
      },
    });
  }

  private focusComposerEnd(): void {
    const node = this.composerEl()?.nativeElement;
    if (!node) return;
    node.focus();
    const end = this.draft.length;
    node.setSelectionRange(end, end);
  }

  private aiMessage(e: unknown, kind: 'replies' | 'compose'): string {
    const err = e as { status?: number; error?: { message?: string; detail?: string } };
    if (err?.status === 503) {
      return kind === 'replies'
        ? 'Reply suggestions are unavailable right now — just type a reply.'
        : 'The compose assist is unavailable right now. You can write your message yourself.';
    }
    if (err?.status === 400) return err.error?.message ?? 'Type a message to work from.';
    return err?.error?.detail ?? err?.error?.message ?? 'Couldn’t do that just now — please try again.';
  }

  // ══════════════════════════════════════════════════════════════════════
  // Older-history paging + deep-link resolution
  // ══════════════════════════════════════════════════════════════════════

  /** Load older messages when the user scrolls near the top of the thread. */
  onThreadScroll(): void {
    const el = this.scrollEl()?.nativeElement;
    const id = this.activeId();
    if (!el || id == null) return;
    if (el.scrollTop > 48 || this.loadingOlder() || this.exhausted().has(id)) return;
    const list = this.rt.messages()[id] ?? [];
    const oldest = list[0]?.id;
    if (oldest == null) return;
    this.loadingOlder.set(true);
    this.preserveFromBottom = el.scrollHeight - el.scrollTop; // anchor distance-from-bottom
    this.rt.loadHistory(id, oldest)
      .then(count => { if (count === 0) this.exhausted.update(s => new Set(s).add(id)); })
      .catch(() => {
        this.preserveFromBottom = null;
        this.toasts.show('Couldn’t load older messages', { tone: 'warn' });
      })
      .finally(() => this.loadingOlder.set(false));
  }

  private restoreScrollAfterPrepend(): void {
    const el = this.scrollEl()?.nativeElement;
    if (el && this.preserveFromBottom != null) el.scrollTop = el.scrollHeight - this.preserveFromBottom;
    this.preserveFromBottom = null;
  }

  /** Resolve a ?c= notification deep link to an open conversation (refresh once if not yet loaded). */
  private async resolveDeepLink(channelId: number): Promise<void> {
    const existing = this.conversations().find(c => c.id === channelId);
    if (existing) { this.deepLinkChannel = null; void this.openConversation(existing); this.scrollToPending(); return; }
    if (this.resolvingDeepLink) return;
    this.resolvingDeepLink = true;
    try {
      const list = await this.rt.refreshChannels();
      if (this.deepLinkChannel !== channelId) return;
      const found = list.find(c => c.id === channelId);
      if (found) { this.deepLinkChannel = null; await this.openConversation(found); this.scrollToPending(); }
    } catch {
      /* not visible to this user, or a transient error — leave the list pane as-is */
    } finally {
      this.resolvingDeepLink = false;
      const pending = this.deepLinkChannel;
      if (pending != null && pending !== channelId) void this.resolveDeepLink(pending);
    }
  }

  /** Best-effort scroll to a ?m= deep-linked message once the thread has rendered. */
  private scrollToPending(): void {
    const target = this.pendingScrollToMessage;
    if (target == null) return;
    // Give the rows a couple frames to render, then scroll the matching bubble into view.
    setTimeout(() => {
      const el = this.scrollEl()?.nativeElement;
      const node = el?.querySelector<HTMLElement>(`[data-msg-id="${target}"]`);
      if (node) node.scrollIntoView({ block: 'center' });
      this.pendingScrollToMessage = null;
    }, 200);
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
