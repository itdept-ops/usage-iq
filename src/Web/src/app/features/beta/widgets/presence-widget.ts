import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { catchError, of } from 'rxjs';

import { Api } from '../../../core/api';
import { Presence } from '../../../core/models';
import { AtriumWidgetShell, WidgetPhase } from './widget-shell';
import { ReorderableWidget } from './reorderable';

const ONLINE_WINDOW_MS = 5 * 60_000;
const MAX_AVATARS = 6;

/**
 * Atrium "Who's online" widget — an overlapping presence-avatar stack of teammates seen in the last 5
 * minutes, each with a live online dot, plus a "+N" overflow chip and a count line. Best-effort own
 * subscription to {@link Api.presence} (catch → null). Available to any signed-in user, so no perm gate
 * — but the call can still fail, hence the failed/retry state.
 *
 * `initials` is a small COPIED helper (no live import); presence rows carry only name + picture + a
 * privacy-safe lastSeen, never an email.
 */
@Component({
  selector: 'atr-presence-widget',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AtriumWidgetShell],
  template: `
    <atr-widget-shell
      title="Who's online" route="/beta/people"
      accentA="#34d399" accentB="#22d3ee"
      [phase]="phase()" emptyText="No one else is online right now." emptyIcon="groups"
      [reordering]="reordering()"
      (retry)="reload()" (moveUp)="moveUp.emit()" (moveDown)="moveDown.emit()" (hide)="hide.emit()">

      @if (online().length) {
        <div body class="pr">
          <div class="pr__stack">
            @for (p of shown(); track p.name; let i = $index) {
              <span class="pr__chip" [style.z-index]="shown().length - i"
                    [title]="p.name + (p.isSelf ? ' (you)' : '')">
                @if (p.picture) {
                  <img class="pr__img" [src]="p.picture" [alt]="p.name" referrerpolicy="no-referrer" />
                } @else {
                  <span class="pr__init" aria-hidden="true">{{ initials(p.name) }}</span>
                }
                <span class="pr__dot" aria-hidden="true"></span>
              </span>
            }
            @if (overflow() > 0) {
              <span class="pr__chip pr__more" [title]="overflow() + ' more online'">+{{ overflow() }}</span>
            }
          </div>
          <div class="pr__meta">
            <span class="pr__pulse" aria-hidden="true"></span>
            <span class="pr__count">{{ online().length }} online now</span>
          </div>
        </div>
      }
    </atr-widget-shell>
  `,
  styles: [`
    .pr { display: flex; flex-direction: column; gap: 12px; }
    .pr__stack { display: flex; align-items: center; }
    .pr__chip {
      position: relative; width: 42px; height: 42px; flex: 0 0 auto; margin-left: -10px;
      border-radius: 50%; box-shadow: 0 0 0 2px var(--bg-rise);
    }
    .pr__chip:first-child { margin-left: 0; }
    .pr__img, .pr__init {
      width: 42px; height: 42px; border-radius: 50%; object-fit: cover; display: grid; place-items: center;
    }
    .pr__init {
      background: linear-gradient(135deg, color-mix(in srgb, #34d399 26%, var(--bg-sink)), color-mix(in srgb, #22d3ee 26%, var(--bg-sink)));
      color: var(--ink); font-family: var(--font-ui); font-size: 14px; font-weight: 700;
    }
    .pr__more {
      display: grid; place-items: center;
      background: color-mix(in srgb, var(--ink) 8%, transparent); color: var(--ink-dim);
      font-size: 13px; font-weight: 700;
    }
    .pr__dot {
      position: absolute; right: 0; bottom: 0; width: 12px; height: 12px; border-radius: 50%;
      background: var(--signal); box-shadow: 0 0 0 2.5px var(--bg-rise);
    }
    .pr__meta { display: flex; align-items: center; gap: 7px; }
    .pr__pulse {
      width: 8px; height: 8px; border-radius: 50%; background: var(--signal);
      box-shadow: 0 0 0 0 color-mix(in srgb, var(--signal) 60%, transparent);
      animation: pr-pulse 2s var(--ease-out) infinite;
    }
    @keyframes pr-pulse {
      0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--signal) 55%, transparent); }
      70% { box-shadow: 0 0 0 7px transparent; }
      100% { box-shadow: 0 0 0 0 transparent; }
    }
    .pr__count { font-size: 12px; font-weight: 600; color: var(--ink-dim); }
    @media (prefers-reduced-motion: reduce) { .pr__pulse { animation: none; } }
  `],
})
export class PresenceWidget extends ReorderableWidget {
  private readonly api = inject(Api);
  private readonly destroyRef = inject(DestroyRef);

  private readonly people = signal<Presence[] | null>(null);
  private readonly failed = signal(false);
  private readonly loadingState = signal(true);

  /** No perm gate — but still auto-hidden by the page when loaded-and-empty (no one online). */
  readonly visible = computed(() => true);

  readonly online = computed<Presence[]>(() => {
    const now = Date.now();
    return (this.people() ?? []).filter(p => now - Date.parse(p.lastSeenUtc) < ONLINE_WINDOW_MS);
  });

  /** The first few avatars to render in the overlapping stack. */
  readonly shown = computed<Presence[]>(() => this.online().slice(0, MAX_AVATARS));
  /** How many online people don't fit in the stack (→ the "+N" chip). */
  readonly overflow = computed(() => Math.max(0, this.online().length - MAX_AVATARS));

  readonly phase = computed<WidgetPhase>(() => {
    if (this.loadingState()) return 'loading';
    if (this.failed()) return 'failed';
    return this.online().length ? 'ready' : 'empty';
  });

  /** COPIED helper — first letters of up to two name words. */
  initials(name: string): string {
    return name.trim().split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() ?? '').join('') || '?';
  }

  constructor() {
    super();
    this.reload();
  }

  reload(): void {
    this.loadingState.set(true);
    this.failed.set(false);
    this.api.presence()
      .pipe(catchError(() => { this.failed.set(true); return of<Presence[] | null>(null); }), takeUntilDestroyed(this.destroyRef))
      .subscribe(list => {
        if (list) this.people.set(list);
        this.loadingState.set(false);
      });
  }
}
