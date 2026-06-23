import { CommonModule } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { catchError, of, timer } from 'rxjs';

import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatMenuModule } from '@angular/material/menu';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';

import { Api } from '../../core/api';
import { AuthService } from '../../core/auth';
import { PERM, PersonDto } from '../../core/models';
import { timeAgo } from '../../shared/format';

/** Which slice of the caller's people the grid shows. */
type PeopleFilter = 'all' | 'contacts' | 'family';

/** A person enriched with the derived bits the row template needs (initials + an away nuance). */
interface PersonVm extends PersonDto {
  initials: string;
  /** Derived AWAY state from a stale lastSeen (only meaningful when online) — mirrors the chat/roster heuristic. */
  away: boolean;
}

/**
 * The People hub — ONE screen of the caller's people (their mutual chat contacts ∪ their household members,
 * de-duplicated over the single AppUser spine; GET /api/people). Each row shows an avatar, the
 * DisplayName-formatted name, a live presence dot (online / away / offline), an opt-in status line,
 * relationship chips (Contact / family role), and one-tap quick actions (Message → the chat DM deep-link;
 * View on map when they share location; View profile). Filterable by Contacts vs Family.
 *
 * Purely additive + read-only: it reuses the server aggregation, the chat openDirect endpoint for the DM
 * deep-link, and the existing /family/locations map. Reachable by any-of chat.read | family.use (mirrors
 * the endpoint), so a chat-only caller sees just contacts and a family-only caller sees just their household.
 */
@Component({
  selector: 'app-people',
  imports: [
    CommonModule, FormsModule,
    MatButtonModule, MatButtonToggleModule, MatIconModule, MatTooltipModule, MatMenuModule,
    MatProgressSpinnerModule, MatSnackBarModule,
  ],
  templateUrl: './people.html',
  styleUrl: './people.scss',
})
export class People {
  private api = inject(Api);
  private router = inject(Router);
  private snack = inject(MatSnackBar);
  readonly auth = inject(AuthService);

  /** A teammate not seen for >60s (their presence stamps every ~20s) is treated as AWAY. */
  private static readonly AWAY_MS = 60_000;

  readonly people = signal<PersonDto[]>([]);
  readonly loading = signal(true);
  readonly error = signal(false);
  /** A clock tick so the relative "active …" labels + derived away states recompute between refreshes. */
  readonly now = signal(Date.now());

  /** Whether a "Message" action is in-flight (so the row's button can't double-fire). */
  readonly opening = signal<number | null>(null);

  readonly filter = signal<PeopleFilter>('all');
  setFilter(f: PeopleFilter): void { this.filter.set(f); }

  readonly timeAgo = timeAgo;

  /** Whether the caller can open DMs at all (chat.send) — the Message action no-ops without it. */
  readonly canMessage = computed(() => this.auth.hasPermission(PERM.chatSend));

  constructor() {
    this.load();

    // Refresh presence-bearing data + the clock on a light cadence (~25s) so dots/status stay live without
    // a manual reload, matching the app shell's presence poll rhythm. Errors keep the prior list.
    timer(25_000, 25_000).pipe(takeUntilDestroyed()).subscribe(() => {
      this.now.set(Date.now());
      this.refresh();
    });

    // A faster clock-only tick (~15s) keeps "active …" + away fresh between data polls (cheap).
    timer(15_000, 15_000).pipe(takeUntilDestroyed()).subscribe(() => this.now.set(Date.now()));
  }

  /** Initial load (shows the spinner). */
  private load(): void {
    this.loading.set(true);
    this.error.set(false);
    this.api.people().pipe(catchError(() => { this.error.set(true); return of<PersonDto[]>([]); }))
      .subscribe(list => { this.people.set(list); this.loading.set(false); });
  }

  /** Silent background refresh (no spinner flicker); keeps the prior list on error. */
  private refresh(): void {
    this.api.people().pipe(catchError(() => of<PersonDto[]>(null as unknown as PersonDto[])))
      .subscribe(list => { if (list) this.people.set(list); });
  }

  /** Two-letter initials for the avatar fallback (name only — no email is ever on the wire). */
  private static initialsOf(name: string): string {
    const parts = (name || '').split(/\s+/).filter(Boolean);
    return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || 'U';
  }

  /** The people projected for the template (initials + derived away), then sliced by the active filter. */
  readonly view = computed<PersonVm[]>(() => {
    const now = this.now();
    const f = this.filter();
    return this.people()
      .filter(p => f === 'all' || (f === 'contacts' ? p.isContact : p.isHousehold))
      .map(p => ({
        ...p,
        initials: People.initialsOf(p.name),
        away: p.online && !!p.lastSeenUtc
          && (now - new Date(p.lastSeenUtc).getTime() >= People.AWAY_MS),
      }));
  });

  /** Counts for the segmented filter (computed off the full list, not the filtered view). */
  readonly counts = computed(() => {
    const all = this.people();
    return {
      all: all.length,
      contacts: all.filter(p => p.isContact).length,
      family: all.filter(p => p.isHousehold).length,
    };
  });

  /** Whether the active filter currently yields zero people (drives the in-context empty state). */
  readonly isEmpty = computed(() => !this.loading() && this.view().length === 0);

  /** A human label for a household role chip ("Owner"/"Adult"/"Child"); falls back to the raw value. */
  roleLabel(role: string | null): string {
    if (!role) return '';
    return role.charAt(0).toUpperCase() + role.slice(1);
  }

  /** Presence state for the dot + label: 'online' | 'away' | 'offline'. */
  presence(p: PersonVm): 'online' | 'away' | 'offline' {
    if (!p.online) return 'offline';
    return p.away ? 'away' : 'online';
  }

  /**
   * Open (or fetch the existing) 1:1 DM with this person, then deep-link to the chat page at that channel —
   * reusing POST /api/chat/direct + the existing /chat?c={id} convention. The button is only rendered when
   * `canDm` (the server's DM gate mirror), so this should not 403; a transient failure just toasts.
   */
  message(p: PersonDto): void {
    if (!p.canDm || !this.canMessage() || this.opening() != null) return;
    this.opening.set(p.userId);
    this.api.openDirect(p.userId).pipe(catchError(() => of(null))).subscribe(ch => {
      this.opening.set(null);
      if (ch) this.router.navigate(['/chat'], { queryParams: { c: ch.id } });
      else this.snack.open('Could not open the conversation. Try again.', 'OK', { duration: 4000 });
    });
  }

  /** View a shared-household member on the family map (→ /family/locations). Only offered when sharesLocation. */
  viewOnMap(): void {
    this.router.navigate(['/family/locations']);
  }

  /** Stable trackBy for the grid (AppUser id is the dedup key). */
  trackPerson = (_: number, p: PersonVm) => p.userId;
}
