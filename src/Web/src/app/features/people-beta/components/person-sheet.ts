import {
  ChangeDetectionStrategy, Component, computed, input, model, output,
} from '@angular/core';
import { MatIconModule } from '@angular/material/icon';

import { NudgeKind } from '../../../core/models';
import { timeAgo } from '../../../shared/format';
import { BetaBottomSheet } from '../../beta-ui';
import { PersonVm, roleLabel } from '../people-beta.model';

/** The fixed, safe nudge templates offered in the sheet (label → server-side kind). Mirrors the live page. */
const NUDGE_KINDS: { kind: NudgeKind; icon: string; label: string }[] = [
  { kind: 'logYourDay', icon: 'edit_calendar', label: 'Log your day' },
  { kind: 'closeYourRings', icon: 'track_changes', label: 'Close your rings' },
  { kind: 'keepTheStreak', icon: 'local_fire_department', label: 'Keep the streak' },
  { kind: 'checkIn', icon: 'waving_hand', label: 'Just checking in' },
];

/**
 * Circle person ACTION SHEET — the row tap-sheet of quick actions for one person, built on the kit
 * {@link BetaBottomSheet}. A big avatar + identity header (name, presence, chips), then the actions
 * the caller is actually allowed to take: Message (opens/deep-links the 1:1 DM), a Nudge picker (the
 * four canned, injection-safe templates), and View on map (a shared-household member). Each action is
 * gated by the same flags the live page uses (canDm/canMessage, the circle gate + canNudge,
 * sharesLocation), so the sheet never offers something that 403s/404s.
 *
 * Pure UI: it takes the active person + the caller capability flags and emits intent events; the page
 * owns the Api calls, the in-flight signals, and the toasts.
 */
@Component({
  selector: 'app-circle-sheet',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, BetaBottomSheet],
  template: `
    <app-bs-sheet [(open)]="open" detent="peek" [label]="p() ? p()!.name + ' actions' : 'Person actions'">
      @if (p(); as person) {
        <div class="cs">
          <div class="cs__head">
            <span class="cs__avatar-wrap" [style.--hue]="person.hue">
              @if (person.picture) {
                <img class="cs__avatar" [src]="person.picture" alt="" referrerpolicy="no-referrer" />
              } @else {
                <span class="cs__avatar cs__avatar--init" aria-hidden="true">{{ person.initials }}</span>
              }
              <span class="cs__dot" [attr.data-presence]="person.presence" aria-hidden="true"></span>
            </span>
            <div class="cs__id">
              <div class="cs__name">{{ person.name }}@if (person.isSelf) { <span class="cs__you">you</span> }</div>
              <div class="cs__presence" [attr.data-presence]="person.presence">
                @switch (person.presence) {
                  @case ('online') { Active now }
                  @case ('away') { Away · active {{ timeAgo(person.lastSeenUtc, now()) }} }
                  @default { Offline }
                }
              </div>
              <div class="cs__chips">
                @if (person.isContact) { <span class="cs__chip cs__chip--contact"><mat-icon aria-hidden="true">person</mat-icon>Contact</span> }
                @if (person.isHousehold) {
                  <span class="cs__chip cs__chip--family"><mat-icon aria-hidden="true">cottage</mat-icon>{{ person.role ? roleLabel(person.role) : 'Family' }}</span>
                }
                @if (person.city) { <span class="cs__chip"><mat-icon aria-hidden="true">place</mat-icon>{{ person.city }}</span> }
              </div>
            </div>
          </div>

          @if (person.status) {
            <p class="cs__status"><mat-icon aria-hidden="true">format_quote</mat-icon>{{ person.status }}</p>
          }

          <!-- Primary actions -->
          <div class="cs__actions">
            @if (person.canDm && canMessage()) {
              <button type="button" class="cs__act cs__act--primary" [disabled]="messaging()"
                      (click)="message.emit()">
                <mat-icon aria-hidden="true">{{ messaging() ? 'hourglass_empty' : 'chat_bubble' }}</mat-icon>
                <span>Message</span>
              </button>
            }
            @if (person.sharesLocation) {
              <button type="button" class="cs__act" (click)="map.emit()">
                <mat-icon aria-hidden="true">map</mat-icon>
                <span>On map</span>
              </button>
            }
            <button type="button" class="cs__act" (click)="copyName.emit()">
              <mat-icon aria-hidden="true">content_copy</mat-icon>
              <span>Copy name</span>
            </button>
          </div>

          <!-- Nudge picker -->
          @if (canNudgePerson() && canNudge()) {
            <div class="cs__nudge">
              <span class="cs__nudge-h">Send a nudge</span>
              <div class="cs__nudge-grid">
                @for (n of nudgeKinds; track n.kind) {
                  <button type="button" class="cs__nudge-btn" [disabled]="nudging()" (click)="nudge.emit(n.kind)">
                    <mat-icon aria-hidden="true">{{ n.icon }}</mat-icon>
                    <span>{{ n.label }}</span>
                  </button>
                }
              </div>
            </div>
          }

          @if (!hasAnyAction()) {
            <p class="cs__none">No quick actions available for {{ person.name }}.</p>
          }
        </div>
      }
    </app-bs-sheet>
  `,
  styleUrl: './person-sheet.scss',
})
export class CircleSheet {
  /** Two-way open state (the page sets the person then flips this true). */
  readonly open = model<boolean>(false);
  /** The person whose actions are shown (null while closed). */
  readonly p = input<PersonVm | null>(null);
  /** Current clock tick for the presence label. */
  readonly now = input<number>(Date.now());

  /** Caller can open DMs at all (chat.send) — the page mirror of the live `canMessage`. */
  readonly canMessage = input<boolean>(false);
  /** Caller can nudge at all (chat.send). */
  readonly canNudge = input<boolean>(false);
  /** A Message is in-flight (disables the button). */
  readonly messaging = input<boolean>(false);
  /** A Nudge is in-flight (disables the grid). */
  readonly nudging = input<boolean>(false);

  /** Open/deep-link the 1:1 DM. */
  readonly message = output<void>();
  /** Send a canned nudge of the chosen kind. */
  readonly nudge = output<NudgeKind>();
  /** View this shared-household member on the family map. */
  readonly map = output<void>();
  /** Copy this person's DisplayName to the clipboard. */
  readonly copyName = output<void>();

  protected readonly nudgeKinds = NUDGE_KINDS;
  protected readonly timeAgo = timeAgo;
  protected readonly roleLabel = roleLabel;

  /** Whether a Nudge may be offered: a non-self circle member (mirrors the server circle gate). */
  protected readonly canNudgePerson = computed(() => {
    const p = this.p();
    return !!p && !p.isSelf && (p.isContact || p.isHousehold);
  });

  /**
   * Whether ANY action is offered. Copy-name is ALWAYS available (a safe, identity-only action), so this
   * is effectively always true now — the empty hint is retained only as a defensive fallback.
   */
  protected readonly hasAnyAction = computed(() => !!this.p());
}
