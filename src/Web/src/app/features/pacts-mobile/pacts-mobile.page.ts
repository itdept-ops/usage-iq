import {
  ChangeDetectionStrategy, Component, computed, inject, signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { catchError, firstValueFrom, forkJoin, of } from 'rxjs';

import { Api } from '../../core/api';
import { AuthService } from '../../core/auth';
import {
  ChatContactDto, CreatePactRequest, PactDto, PactKind, PactProgressRowDto,
} from '../../core/models';
import { BetaPullRefresh, BetaSkeleton } from '../beta-ui';

const KINDS: readonly { key: PactKind; label: string; icon: string; unit: string }[] = [
  { key: 'workout.logged', label: 'Workouts', icon: 'fitness_center', unit: 'workouts' },
  { key: 'challenge.dayComplete', label: '75 Hard', icon: 'military_tech', unit: 'days' },
  { key: 'hydration.goalHit', label: 'Water', icon: 'local_drink', unit: 'days' },
];

/**
 * Pacts "Pact" — the MOBILE TWIN of habit pacts (/pacts), rebuilt on the shared beta-ui "Strata" kit. A signature
 * INDIGO → VIOLET accent re-skins the screen. An immersive scroll column with an accent-bloom header,
 * pull-to-refresh, a slide-in create sheet, and big-tap-target pact cards with inline standings.
 *
 * DATA PARITY: every card + mutation hits the SAME {@link Api} pact endpoints the live page uses (pacts /
 * createPact / archive / join / leave / progress), gated by the SAME tracker.self the live route carries. The
 * invite picker draws ONLY from {@link Api.myContacts} (mutual contacts) — the server rejects a non-contact.
 *
 * PRIVACY: members + owners are DisplayName only (never an email); progress is a COUNT of shareable activity
 * events, never a private tracker amount. ISOLATION: gated platform.mobile + tracker.self; consumes the kit +
 * the SAME Api as the live counterpart. No live page is imported or modified.
 */
@Component({
  selector: 'app-pacts-mobile',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './pacts-mobile.page.scss',
  imports: [FormsModule, MatIconModule, BetaPullRefresh, BetaSkeleton],
  template: `
    <app-bs-pull-refresh class="pm-ptr" [busy]="refreshing()" (refresh)="reload()">
      <div class="pm-scroll" aria-live="polite">

        <header class="pm-hero">
          <p class="pm-hero__eyebrow"><mat-icon aria-hidden="true">handshake</mat-icon> Accountability</p>
          <h1 class="pm-hero__title">Pacts</h1>
          <p class="pm-hero__sub">Shared goals with your circle.</p>
          <button type="button" class="pm-hero__cta" (click)="toggleCreate()">
            <mat-icon aria-hidden="true">{{ showCreate() ? 'close' : 'add' }}</mat-icon>
            {{ showCreate() ? 'Cancel' : 'New pact' }}
          </button>
        </header>

        @if (showCreate()) {
          <section class="pm-create" aria-label="Create a pact">
            <label class="pm-field">
              <span class="pm-field__label">Title</span>
              <input class="pm-field__input" type="text" [ngModel]="draftTitle()" (ngModelChange)="draftTitle.set($event)" maxlength="120"
                     placeholder="e.g. June workout streak" aria-label="Pact title" />
            </label>

            <div class="pm-field">
              <span class="pm-field__label">Activity</span>
              <div class="pm-pills" role="radiogroup" aria-label="Activity kind">
                @for (k of kinds; track k.key) {
                  <button type="button" class="pm-pill" [class.is-on]="draftKind === k.key"
                          role="radio" [attr.aria-checked]="draftKind === k.key" (click)="draftKind = k.key">
                    <mat-icon aria-hidden="true">{{ k.icon }}</mat-icon> {{ k.label }}
                  </button>
                }
              </div>
            </div>

            <div class="pm-field-row">
              <label class="pm-field">
                <span class="pm-field__label">Target</span>
                <input class="pm-field__input" type="number" min="1" max="100000" [(ngModel)]="draftTarget"
                       aria-label="Target count" />
              </label>
              <label class="pm-field">
                <span class="pm-field__label">Days</span>
                <input class="pm-field__input" type="number" min="1" max="366" [(ngModel)]="draftPeriod"
                       aria-label="Period in days" />
              </label>
            </div>

            @if (contacts().length) {
              <div class="pm-field">
                <span class="pm-field__label">Invite mutual contacts</span>
                <div class="pm-invitees">
                  @for (c of contacts(); track c.userId) {
                    <button type="button" class="pm-invitee" [class.is-on]="isInvited(c.userId)"
                            [attr.aria-pressed]="isInvited(c.userId)" (click)="toggleInvitee(c.userId)">
                      <span class="pm-invitee__avatar" aria-hidden="true">{{ initials(c.name) }}</span>
                      {{ c.name }}
                      @if (isInvited(c.userId)) { <mat-icon class="pm-invitee__check" aria-hidden="true">check</mat-icon> }
                    </button>
                  }
                </div>
              </div>
            } @else {
              <p class="pm-create__hint">No mutual contacts yet — create a solo pact and invite people later.</p>
            }

            @if (createError()) { <p class="pm-create__err" role="alert">{{ createError() }}</p> }

            <button type="button" class="pm-create__go" [disabled]="!canCreate()" (click)="create()">
              <mat-icon aria-hidden="true">handshake</mat-icon>
              {{ creating() ? 'Creating…' : 'Create pact' }}
            </button>
          </section>
        }

        @if (loading()) {
          <div class="pm-skel" aria-hidden="true">
            @for (n of skeletonRows; track n) {
              <div class="pm-skel__card">
                <app-bs-skeleton width="44px" height="44px" radius="12px" />
                <div class="pm-skel__lines">
                  <app-bs-skeleton width="64%" height="14px" radius="var(--r-pill)" />
                  <app-bs-skeleton width="40%" height="11px" radius="var(--r-pill)" />
                </div>
              </div>
            }
          </div>

        } @else if (errored()) {
          <div class="pm-state">
            <span class="pm-state__orb"><mat-icon aria-hidden="true">cloud_off</mat-icon></span>
            <h2 class="pm-state__title">Couldn't load your pacts</h2>
            <button type="button" class="pm-state__cta" (click)="reload()">
              <mat-icon aria-hidden="true">refresh</mat-icon> Try again
            </button>
          </div>

        } @else if (pacts().length === 0) {
          <div class="pm-state">
            <span class="pm-state__orb"><mat-icon aria-hidden="true">handshake</mat-icon></span>
            <h2 class="pm-state__title">No pacts yet</h2>
            <p class="pm-state__body">Start one to keep yourself — and your circle — honest.</p>
            @if (!showCreate()) {
              <button type="button" class="pm-state__cta" (click)="toggleCreate()">
                <mat-icon aria-hidden="true">add</mat-icon> New pact
              </button>
            }
          </div>

        } @else {
          <ul class="pm-list">
            @for (p of pacts(); track p.id; let i = $index) {
              <li class="pm-card pm-reveal" [class.is-archived]="p.archived" [style.--ri]="i">
                <div class="pm-card__head">
                  <span class="pm-card__icon" aria-hidden="true"><mat-icon>{{ iconFor(p.kind) }}</mat-icon></span>
                  <div class="pm-card__id">
                    <h3 class="pm-card__title">{{ p.title }}</h3>
                    <p class="pm-card__meta">
                      {{ labelFor(p.kind) }} · {{ p.targetIntValue }} {{ unitFor(p.kind) }} · {{ p.periodDays }}d
                      @if (!p.archived && daysLeft(p) > 0) { · {{ daysLeft(p) }}d left }
                      @if (p.archived) { · archived }
                    </p>
                  </div>
                  @if (p.mine && !p.archived) {
                    <button class="pm-card__archive" type="button" aria-label="Archive pact" (click)="archive(p)">
                      <mat-icon aria-hidden="true">inventory_2</mat-icon>
                    </button>
                  }
                </div>

                <div class="pm-card__members">
                  @for (m of activeMembers(p); track m.userId) {
                    <span class="pm-member">
                      <span class="pm-member__avatar" aria-hidden="true">{{ initials(m.name) }}</span>
                      <span class="pm-member__name">{{ m.name }}</span>
                    </span>
                  }
                  <span class="pm-card__mcount">{{ activeMembers(p).length }} in</span>
                </div>

                <div class="pm-card__actions">
                  @if (isInvitedTo(p)) {
                    <button type="button" class="pm-btn pm-btn--primary" (click)="join(p)">
                      <mat-icon aria-hidden="true">how_to_reg</mat-icon> Accept
                    </button>
                  } @else if (isActiveMember(p)) {
                    <button type="button" class="pm-btn" (click)="leave(p)">
                      <mat-icon aria-hidden="true">logout</mat-icon> Leave
                    </button>
                  }
                  <button type="button" class="pm-btn pm-card__expand" (click)="toggleExpand(p)"
                          [attr.aria-expanded]="expanded() === p.id">
                    <mat-icon aria-hidden="true">{{ expanded() === p.id ? 'expand_less' : 'leaderboard' }}</mat-icon>
                    {{ expanded() === p.id ? 'Hide' : 'Standings' }}
                  </button>
                </div>

                @if (expanded() === p.id) {
                  <div class="pm-standings">
                    @if (progress()[p.id]; as rows) {
                      @if (rows.length) {
                        @for (r of rows; track r.userId; let j = $index) {
                          <div class="pm-standing" [class.is-met]="r.metTarget">
                            <span class="pm-standing__rank" [attr.data-medal]="j < 3 ? j + 1 : null">{{ j + 1 }}</span>
                            <span class="pm-standing__avatar" aria-hidden="true">{{ initials(r.name) }}</span>
                            <span class="pm-standing__name">{{ r.name }}</span>
                            <span class="pm-standing__count">{{ r.count }}/{{ p.targetIntValue }}</span>
                            @if (r.metTarget) { <mat-icon class="pm-standing__check" aria-hidden="true">verified</mat-icon> }
                          </div>
                        }
                      } @else {
                        <p class="pm-standings__empty">No progress recorded yet.</p>
                      }
                    } @else {
                      <p class="pm-standings__empty">Loading…</p>
                    }
                  </div>
                }
              </li>
            }
          </ul>
        }
      </div>
    </app-bs-pull-refresh>
  `,
})
export class PactsMobilePage {
  private api = inject(Api);
  readonly auth = inject(AuthService);

  readonly kinds = KINDS;
  readonly skeletonRows = Array.from({ length: 4 }, (_, i) => i);

  readonly pacts = signal<PactDto[]>([]);
  readonly contacts = signal<ChatContactDto[]>([]);
  readonly loading = signal(true);
  readonly errored = signal(false);
  readonly refreshing = signal(false);

  readonly progress = signal<Record<number, PactProgressRowDto[]>>({});
  readonly expanded = signal<number | null>(null);

  readonly showCreate = signal(false);
  readonly draftTitle = signal('');
  draftKind: PactKind = 'workout.logged';
  draftTarget = 5;
  draftPeriod = 7;
  readonly draftInvitees = signal<Set<number>>(new Set());
  readonly creating = signal(false);
  readonly createError = signal<string | null>(null);

  readonly myId = computed(() => this.auth.session()?.userId ?? 0);
  readonly canCreate = computed(() => this.draftTitle().trim().length > 0 && !this.creating());

  constructor() {
    this.reload();
  }

  async reload(): Promise<void> {
    const wasLoaded = this.pacts().length > 0;
    if (wasLoaded) this.refreshing.set(true); else this.loading.set(true);
    this.errored.set(false);
    try {
      const { pacts, contacts } = await firstValueFrom(
        forkJoin({
          pacts: this.api.pacts().pipe(catchError(() => of<PactDto[] | null>(null))),
          contacts: this.api.myContacts().pipe(catchError(() => of<ChatContactDto[]>([]))),
        }),
      );
      if (pacts) this.pacts.set(pacts);
      else if (!wasLoaded) this.errored.set(true);
      this.contacts.set(contacts ?? []);
    } catch {
      if (!wasLoaded) this.errored.set(true);
    } finally {
      this.loading.set(false);
      this.refreshing.set(false);
    }
  }

  private refresh(): void {
    this.api.pacts().pipe(catchError(() => of<PactDto[] | null>(null))).subscribe((p) => {
      if (p) this.pacts.set(p);
    });
  }

  iconFor(kind: string): string { return this.kinds.find((k) => k.key === kind)?.icon ?? 'flag'; }
  labelFor(kind: string): string { return this.kinds.find((k) => k.key === kind)?.label ?? 'Activity'; }
  unitFor(kind: string): string { return this.kinds.find((k) => k.key === kind)?.unit ?? 'logs'; }

  activeMembers(p: PactDto): { userId: number; name: string }[] {
    return p.members.filter((m) => m.status !== 'Left');
  }

  toggleCreate(): void { this.showCreate.update((v) => !v); this.createError.set(null); }

  toggleInvitee(userId: number): void {
    this.draftInvitees.update((cur) => {
      const next = new Set(cur);
      if (next.has(userId)) next.delete(userId); else next.add(userId);
      return next;
    });
  }
  isInvited(userId: number): boolean { return this.draftInvitees().has(userId); }

  create(): void {
    if (!this.canCreate()) return;
    this.creating.set(true);
    this.createError.set(null);
    const body: CreatePactRequest = {
      title: this.draftTitle().trim(), kind: this.draftKind,
      targetIntValue: this.draftTarget, periodDays: this.draftPeriod,
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
    this.draftTitle.set('');
    this.draftKind = 'workout.logged';
    this.draftTarget = 5;
    this.draftPeriod = 7;
    this.draftInvitees.set(new Set());
  }

  toggleExpand(p: PactDto): void {
    const open = this.expanded() === p.id;
    this.expanded.set(open ? null : p.id);
    if (!open && !this.progress()[p.id]) {
      this.api.pactProgress(p.id).pipe(catchError(() => of<PactProgressRowDto[]>([])))
        .subscribe((rows) => this.progress.update((cur) => ({ ...cur, [p.id]: rows })));
    }
  }

  archive(p: PactDto): void { this.api.archivePact(p.id).pipe(catchError(() => of(null))).subscribe(() => this.refresh()); }
  join(p: PactDto): void { this.api.joinPact(p.id).pipe(catchError(() => of(null))).subscribe(() => this.refresh()); }
  leave(p: PactDto): void { this.api.leavePact(p.id).pipe(catchError(() => of(null))).subscribe(() => this.refresh()); }

  isInvitedTo(p: PactDto): boolean {
    const me = this.myId();
    return p.members.some((m) => m.userId === me && m.status === 'Invited');
  }
  isActiveMember(p: PactDto): boolean {
    const me = this.myId();
    return !p.mine && p.members.some((m) => m.userId === me && m.status === 'Active');
  }

  initials(name: string): string {
    const parts = (name || '').split(/\s+/).filter(Boolean);
    return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || 'U';
  }

  daysLeft(p: PactDto): number {
    const end = p.endUtc ? Date.parse(p.endUtc) : NaN;
    if (Number.isNaN(end)) return 0;
    return Math.max(0, Math.ceil((end - Date.now()) / 86_400_000));
  }
}
