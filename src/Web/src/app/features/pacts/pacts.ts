import {
  ChangeDetectionStrategy, Component, computed, inject, signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { catchError, forkJoin, of } from 'rxjs';

import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';

import { Api } from '../../core/api';
import { AuthService } from '../../core/auth';
import {
  ChatContactDto, CreatePactRequest, PactDto, PactKind, PactProgressRowDto,
} from '../../core/models';
import { BetaEmptyState, BetaErrorState } from '../beta-ui';

/** The three pact kinds, with the humane label + glyph the create form + cards use. */
const KINDS: readonly { key: PactKind; label: string; icon: string; unit: string }[] = [
  { key: 'workout.logged', label: 'Workouts', icon: 'fitness_center', unit: 'workouts' },
  { key: 'challenge.dayComplete', label: '75-Hard days', icon: 'military_tech', unit: 'days' },
  { key: 'hydration.goalHit', label: 'Water goals', icon: 'local_drink', unit: 'days' },
];

/**
 * Habit pacts (/pacts) — shared accountability goals. An owner creates a pact over one shareable activity
 * kind (workouts / 75-Hard days / water goals), invites their MUTUAL chat contacts, and everyone races to hit
 * a target count over a period. Each card shows the live per-member progress (a count of already-shareable
 * ActivityEvents in the window) + whether each member met target.
 *
 * PRIVACY / ANTI-SPAM (all server-enforced; mirrored in the UI): invites are constrained to the owner's mutual
 * contacts (the picker draws ONLY from {@link Api.myContacts}); members + owners are shown as DisplayName only
 * (never an email); progress is a COUNT of shareable events, never a private tracker amount. Gated tracker.self
 * (no new permission). Mutations are minimal-optimistic — they re-fetch the authoritative pact list on success.
 */
@Component({
  selector: 'app-pacts',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MatButtonModule, MatIconModule, MatProgressSpinnerModule, MatTooltipModule, BetaEmptyState, BetaErrorState],
  templateUrl: './pacts.html',
  styleUrl: './pacts.scss',
})
export class Pacts {
  private api = inject(Api);
  readonly auth = inject(AuthService);

  readonly kinds = KINDS;

  readonly pacts = signal<PactDto[]>([]);
  readonly contacts = signal<ChatContactDto[]>([]);
  readonly loading = signal(true);
  readonly error = signal(false);

  /** Per-pact progress rows, keyed by pact id (lazily fetched when a card is expanded). */
  readonly progress = signal<Record<number, PactProgressRowDto[]>>({});
  /** Which pact card is expanded to show member progress. */
  readonly expanded = signal<number | null>(null);

  // ---- Create form state ----
  readonly showCreate = signal(false);
  draftTitle = '';
  draftKind: PactKind = 'workout.logged';
  draftTarget = 5;
  draftPeriod = 7;
  /** Selected invitee AppUser ids (a subset of the mutual-contact picker). */
  readonly draftInvitees = signal<Set<number>>(new Set());
  readonly creating = signal(false);
  readonly createError = signal<string | null>(null);

  readonly myId = computed(() => this.auth.session()?.userId ?? 0);

  /** Whether the create form can submit (a non-empty title; rate/clamps are server-side). */
  readonly canCreate = computed(() => this.draftTitle.trim().length > 0 && !this.creating());

  constructor() {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.error.set(false);
    forkJoin({
      pacts: this.api.pacts().pipe(catchError(() => of<PactDto[] | null>(null))),
      contacts: this.api.myContacts().pipe(catchError(() => of<ChatContactDto[]>([]))),
    }).subscribe(({ pacts, contacts }) => {
      if (pacts) this.pacts.set(pacts);
      else this.error.set(true);
      this.contacts.set(contacts ?? []);
      this.loading.set(false);
    });
  }

  /** Refresh just the pact list (after a mutation), preserving the contacts + UI state. */
  private refresh(): void {
    this.api.pacts().pipe(catchError(() => of<PactDto[] | null>(null))).subscribe((p) => {
      if (p) this.pacts.set(p);
    });
  }

  iconFor(kind: string): string {
    return this.kinds.find((k) => k.key === kind)?.icon ?? 'flag';
  }
  labelFor(kind: string): string {
    return this.kinds.find((k) => k.key === kind)?.label ?? 'Activity';
  }
  unitFor(kind: string): string {
    return this.kinds.find((k) => k.key === kind)?.unit ?? 'logs';
  }

  /** Active (non-Left) member names for the card's member chips. */
  activeMembers(p: PactDto): { userId: number; name: string }[] {
    return p.members.filter((m) => m.status !== 'Left');
  }

  // ---- Create flow ----

  toggleCreate(): void {
    this.showCreate.update((v) => !v);
    this.createError.set(null);
  }

  toggleInvitee(userId: number): void {
    this.draftInvitees.update((cur) => {
      const next = new Set(cur);
      if (next.has(userId)) next.delete(userId); else next.add(userId);
      return next;
    });
  }

  isInvited(userId: number): boolean {
    return this.draftInvitees().has(userId);
  }

  create(): void {
    if (!this.canCreate()) return;
    this.creating.set(true);
    this.createError.set(null);
    const body: CreatePactRequest = {
      title: this.draftTitle.trim(),
      kind: this.draftKind,
      targetIntValue: this.draftTarget,
      periodDays: this.draftPeriod,
      memberUserIds: [...this.draftInvitees()],
    };
    this.api
      .createPact(body)
      .pipe(catchError(() => { this.createError.set('Could not create the pact. Try again.'); return of(null); }))
      .subscribe((p) => {
        if (p) {
          this.pacts.update((cur) => [p, ...cur]);
          this.resetDraft();
          this.showCreate.set(false);
        }
        this.creating.set(false);
      });
  }

  private resetDraft(): void {
    this.draftTitle = '';
    this.draftKind = 'workout.logged';
    this.draftTarget = 5;
    this.draftPeriod = 7;
    this.draftInvitees.set(new Set());
  }

  // ---- Per-card actions ----

  /** Expand/collapse a card; fetch its progress the first time it's opened. */
  toggleExpand(p: PactDto): void {
    const open = this.expanded() === p.id;
    this.expanded.set(open ? null : p.id);
    if (!open && !this.progress()[p.id]) this.loadProgress(p.id);
  }

  private loadProgress(id: number): void {
    this.api
      .pactProgress(id)
      .pipe(catchError(() => of<PactProgressRowDto[]>([])))
      .subscribe((rows) => this.progress.update((cur) => ({ ...cur, [id]: rows })));
  }

  archive(p: PactDto): void {
    this.api.archivePact(p.id).pipe(catchError(() => of(null))).subscribe(() => this.refresh());
  }

  join(p: PactDto): void {
    this.api.joinPact(p.id).pipe(catchError(() => of(null))).subscribe(() => this.refresh());
  }

  leave(p: PactDto): void {
    this.api.leavePact(p.id).pipe(catchError(() => of(null))).subscribe(() => this.refresh());
  }

  /** Whether the caller is an Invited (not yet Active) member of this pact (drives the Join CTA). */
  isInvitedTo(p: PactDto): boolean {
    const me = this.myId();
    return p.members.some((m) => m.userId === me && m.status === 'Invited');
  }

  /** Whether the caller is an Active member (non-owner) — drives the Leave CTA. */
  isActiveMember(p: PactDto): boolean {
    const me = this.myId();
    return !p.mine && p.members.some((m) => m.userId === me && m.status === 'Active');
  }

  initials(name: string): string {
    const parts = (name || '').split(/\s+/).filter(Boolean);
    return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || 'U';
  }

  /** Days left in a pact's window (0 when ended/undated). */
  daysLeft(p: PactDto): number {
    const end = p.endUtc ? Date.parse(p.endUtc) : NaN;
    if (Number.isNaN(end)) return 0;
    return Math.max(0, Math.ceil((end - Date.now()) / 86_400_000));
  }
}
