import {
  ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { catchError, of } from 'rxjs';

import { Api } from '../../../core/api';
import { Household, HouseholdMember, Presence } from '../../../core/models';
import { HearthCard, HearthPhase } from './hearth-card';

const ONLINE_WINDOW_MS = 5 * 60_000;

/** A household member decorated with a derived online flag (from presence last-seen). */
interface MemberChip {
  userId: number;
  name: string;
  picture?: string | null;
  isSelf: boolean;
  online: boolean;
}

/**
 * Hearth "Who's home" glance card — the household's members as an avatar row, each with a live online dot
 * derived by matching {@link Api.presence} last-seen (within 5 min) to the member by userId. BOTH streams
 * load best-effort and INDEPENDENTLY (each its own `catchError(of(null))`): if presence fails we still
 * render the members with no dots; if the household fails the card shows its failed/retry state. Identity
 * is name + picture only — NEVER an email (the DTOs carry none). Deep-links to the family-finder map.
 *
 * `initials` is a small COPIED helper (no live import).
 */
@Component({
  selector: 'fb-household-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HearthCard],
  template: `
    <fb-hearth-card
      title="Who's home" route="/family/locations" accentVar="--online"
      [phase]="phase()" emptyText="No household members yet."
      (retry)="reload()">

      @if (phase() === 'ready') {
        <div body class="who">
          @for (m of chips(); track m.userId) {
            <span class="chip" [class.chip--self]="m.isSelf" [title]="m.name + (m.isSelf ? ' (you)' : '')">
              @if (m.picture) {
                <img class="chip__img" [src]="m.picture" [alt]="m.name" referrerpolicy="no-referrer" />
              } @else {
                <span class="chip__init" aria-hidden="true">{{ initials(m.name) }}</span>
              }
              @if (m.online) { <span class="chip__dot" [attr.aria-label]="m.name + ' online'"></span> }
            </span>
          }
          @if (onlineCount()) { <span class="who__count">{{ onlineCount() }} online</span> }
        </div>
      }
    </fb-hearth-card>
  `,
  styles: [`
    .who { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .chip { position: relative; width: 40px; height: 40px; flex: 0 0 auto; }
    .chip__img, .chip__init {
      width: 40px; height: 40px; border-radius: 999px; object-fit: cover; display: grid; place-items: center;
      border: 1px solid var(--glass-edge);
    }
    .chip--self .chip__img, .chip--self .chip__init { border-color: var(--hearth-a); }
    .chip__init { background: rgba(255,255,255,.08); color: var(--ink); font-size: 14px; font-weight: 700; }
    .chip__dot {
      position: absolute; right: -1px; bottom: -1px; width: 12px; height: 12px; border-radius: 999px;
      background: var(--online); border: 2px solid var(--bg-rise);
    }
    .who__count { font-size: 12px; color: var(--ink-dim); margin-left: 2px; }
  `],
})
export class HouseholdCard {
  private readonly api = inject(Api);
  private readonly destroyRef = inject(DestroyRef);

  private readonly household = signal<Household | null>(null);
  private readonly presence = signal<Presence[] | null>(null);
  private readonly failed = signal(false);
  private readonly loadingState = signal(true);

  private readonly members = computed<HouseholdMember[]>(() => this.household()?.members ?? []);

  /** Member ids seen online (presence within the window, matched by userId). */
  private readonly onlineIds = computed<ReadonlySet<number>>(() => {
    const now = Date.now();
    const ids = new Set<number>();
    for (const p of this.presence() ?? []) {
      if (p.userId != null && now - Date.parse(p.lastSeenUtc) < ONLINE_WINDOW_MS) ids.add(p.userId);
    }
    return ids;
  });

  readonly chips = computed<MemberChip[]>(() => {
    const online = this.onlineIds();
    return this.members().map(m => ({
      userId: m.userId, name: m.name, picture: m.picture, isSelf: m.isSelf,
      online: online.has(m.userId),
    }));
  });

  readonly onlineCount = computed(() => this.chips().filter(c => c.online).length);

  readonly phase = computed<HearthPhase>(() => {
    if (this.loadingState()) return 'loading';
    if (this.failed()) return 'failed';
    return this.members().length ? 'ready' : 'empty';
  });

  /** COPIED helper — first letters of up to two name words. */
  initials(name: string): string {
    return name.trim().split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() ?? '').join('') || '?';
  }

  constructor() {
    this.reload();
  }

  reload(): void {
    this.loadingState.set(true);
    this.failed.set(false);
    // Household drives the card's lifecycle (failed/retry hinges on it).
    this.api.getHousehold()
      .pipe(catchError(() => { this.failed.set(true); return of<Household | null>(null); }), takeUntilDestroyed(this.destroyRef))
      .subscribe(h => {
        if (h) this.household.set(h);
        this.loadingState.set(false);
      });
    // Presence is purely decorative — a failure just means no dots, never blanks the card.
    this.api.presence()
      .pipe(catchError(() => of<Presence[] | null>(null)), takeUntilDestroyed(this.destroyRef))
      .subscribe(list => { if (list) this.presence.set(list); });
  }
}
