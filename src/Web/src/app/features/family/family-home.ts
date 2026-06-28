import {
  Component,
  DestroyRef,
  OnDestroy,
  computed,
  inject,
  signal,
  ChangeDetectionStrategy,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { catchError, of } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';

import { Api } from '../../core/api';
import { AuthService } from '../../core/auth';
import {
  FamilyBriefing,
  FamilyToday,
  FamilyTodayEvent,
  Household,
  HouseholdMember,
  PERM,
} from '../../core/models';
import { FamilyTimerWidget } from './timer';
import { FamilyAssistantPanel } from './family-assistant-panel';
import { FamilyLeaderboard } from './family-leaderboard';
import { BetaErrorState } from '../beta-ui';

/** One feature tile on the Family home grid. `route` is null for a not-yet-built ("Coming soon") tile. */
interface FeatureTile {
  key: string;
  label: string;
  icon: string;
  blurb: string;
  /** Route when live; null renders the tile as a gently-disabled "Coming soon" card. */
  route: string | null;
  /** When set, the tile is only shown to holders of this permission (e.g. Finance). */
  perm?: string;
}

/**
 * The tiles for everything the Family Hub will grow into. The live rooms link out; the rest render as warm
 * "Coming soon" cards so the home feels like a real family home with rooms still being furnished. Finance is
 * additionally gated on family.finance.
 */
const TILES: FeatureTile[] = [
  {
    key: 'notes',
    label: 'Notes',
    icon: 'sticky_note_2',
    blurb: 'Shared notes for the whole family',
    route: '/family/notes',
  },
  {
    key: 'lists',
    label: 'Lists',
    icon: 'checklist',
    blurb: 'To-dos and wish lists (groceries live in the Grocery tool)',
    route: '/family/lists',
  },
  {
    key: 'reminders',
    label: 'Reminders',
    icon: 'notifications_active',
    blurb: 'Nudges so nothing slips',
    route: '/family/reminders',
  },
  {
    key: 'timer',
    label: 'Timer',
    icon: 'timer',
    blurb: 'Shared timers and countdowns',
    route: '/family/timer',
  },
  {
    key: 'meals',
    label: 'Meal Planner',
    icon: 'restaurant',
    blurb: 'Plan the week around the table',
    route: '/family/meals',
  },
  {
    key: 'chores',
    label: 'Chores',
    icon: 'cleaning_services',
    blurb: 'Share the load, fairly',
    route: '/family/chores',
  },
  {
    key: 'allowance',
    label: 'Allowance',
    icon: 'savings',
    blurb: "Track each child's earned credits",
    route: '/family/allowance',
    perm: PERM.allowanceManage,
  },
  {
    key: 'finance',
    label: 'Finance',
    icon: 'account_balance_wallet',
    blurb: 'Budgets, bills, and balances',
    route: '/family/finance',
    perm: PERM.familyFinance,
  },
  {
    key: 'calendar',
    label: 'Calendar',
    icon: 'calendar_month',
    blurb: 'The family calendar in one place',
    route: '/family/calendar',
  },
  {
    key: 'polls',
    label: 'Polls',
    icon: 'how_to_vote',
    blurb: 'Pick a time or settle a plan together',
    route: '/family/polls',
  },
  {
    key: 'locations',
    label: "Where's everyone",
    icon: 'person_pin_circle',
    blurb: 'See where the family is on a map',
    route: '/family/locations',
  },
  {
    key: 'cycle',
    label: 'Cycle',
    icon: 'spa',
    blurb: 'Your private cycle calendar',
    route: '/family/cycle',
    perm: PERM.cycleTrack,
  },
  {
    key: 'identity',
    label: 'Identity Map',
    icon: 'donut_large',
    blurb: 'See where your time really goes',
    route: '/family/identity',
    perm: PERM.identityMap,
  },
];

/**
 * Family Hub home — a warm "Today" dashboard for the household. A time-of-day greeting + the local date
 * (both from GET /family/today), then glance cards: today's reminders (time + who), live timers (the F2
 * timer widget embedded), list peeks (open/done counts + the first few open items), pinned notes, and a
 * weather card (only when the server returns weather). Below sits the feature-tile grid for navigation, and
 * the household's members (avatar + name only; NEVER an email — email-privacy). Everything is mobile-friendly
 * and glanceable; the household + snapshot are auto-provisioned server-side, so the page is never empty.
 */
@Component({
  selector: 'app-family-home',
  imports: [
    RouterLink,
    MatIconModule,
    MatButtonModule,
    MatTooltipModule,
    MatProgressSpinnerModule,
    FamilyTimerWidget,
    FamilyAssistantPanel,
    FamilyLeaderboard,
    BetaErrorState,
  ],
  templateUrl: './family-home.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './family.scss',
})
export class FamilyHome implements OnDestroy {
  private api = inject(Api);
  private destroyRef = inject(DestroyRef);
  readonly auth = inject(AuthService);

  readonly household = signal<Household | null>(null);
  readonly today = signal<FamilyToday | null>(null);
  readonly loading = signal(true);
  readonly error = signal(false);

  /** The warm AI morning narrative (GET /family/today/briefing); null until loaded (best-effort). */
  readonly briefing = signal<FamilyBriefing | null>(null);
  /** Whether the structured Today cards are revealed below the narrative ("show plain list" toggle). */
  readonly showPlainList = signal(false);

  /** The local "YYYY-MM-DD" the briefing was last loaded for, so we can refresh when the day rolls over. */
  private briefingDay = '';

  /**
   * Whether the caller is a CHILD: they hold the child chore capability (chore.claim) but NOT a parent
   * capability (allowance.manage). A child gets a focused, kid-safe Family Hub — only the Chores room (which
   * itself renders their own chores + balance) — never finance/admin/other-member nav.
   */
  readonly isChild = computed<boolean>(() => {
    this.auth.permissions(); // re-run on permission changes
    return (
      this.auth.hasPermission(PERM.choreClaim) && !this.auth.hasPermission(PERM.allowanceManage)
    );
  });

  /**
   * Feature tiles, filtered to the ones the caller may see (perm-gated tiles hide without the grant). A child
   * sees ONLY the Chores room — every other room is hidden so the kid view stays focused and safe.
   */
  readonly tiles = computed<FeatureTile[]>(() => {
    this.auth.permissions(); // re-run on permission changes
    const visible = TILES.filter((t) => !t.perm || this.auth.hasPermission(t.perm));
    return this.isChild() ? visible.filter((t) => t.key === 'chores') : visible;
  });

  /** The household's members in server order (owner first), or empty until loaded. */
  readonly members = computed<HouseholdMember[]>(() => this.household()?.members ?? []);

  /** Today's calendar events from the snapshot (empty when no calendar is connected). */
  readonly events = computed<FamilyTodayEvent[]>(() => this.today()?.events ?? []);

  /** The caller's next upcoming event today (the soonest timed event still ahead, else the first all-day). */
  readonly nextEvent = computed<FamilyTodayEvent | null>(() => {
    const evs = this.events();
    if (!evs.length) return null;
    const now = Date.now();
    const upcoming = evs
      .filter((e) => !e.allDay && e.startUtc && Date.parse(e.startUtc) >= now)
      .sort((a, b) => (a.startUtc ?? '').localeCompare(b.startUtc ?? ''));
    if (upcoming.length) return upcoming[0];
    // No more timed events ahead — surface an all-day event (or the last item) so the card still feels live.
    return evs.find((e) => e.allDay) ?? null;
  });

  /** The local date, parsed from the snapshot's ISO date for a friendly "Thursday, June 20" rendering. */
  readonly dateLabel = computed<string>(() => {
    const iso = this.today()?.dateLocal;
    if (!iso) return '';
    // dateLocal is a plain ISO date (no time); parse as local midnight to avoid a TZ shift.
    const d = new Date(`${iso}T00:00:00`);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  });

  /** Re-fetch the briefing when the tab is revealed on a new local day so the narrative tracks the day. */
  private readonly onVisibility = (): void => {
    if (document.visibilityState !== 'visible') return;
    if (this.localDay() !== this.briefingDay) this.loadBriefing();
  };

  constructor() {
    this.api
      .getHousehold()
      .pipe(
        catchError(() => {
          this.error.set(true);
          return of(null);
        }),
        takeUntilDestroyed(),
      )
      .subscribe((h) => {
        if (h) this.household.set(h);
        this.loading.set(false);
      });

    // The Today snapshot is best-effort: a failure leaves the dashboard cards empty but the home still works.
    this.api
      .familyToday()
      .pipe(
        catchError(() => of<FamilyToday | null>(null)),
        takeUntilDestroyed(),
      )
      .subscribe((t) => {
        if (t) this.today.set(t);
      });

    this.loadBriefing();
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  ngOnDestroy(): void {
    document.removeEventListener('visibilitychange', this.onVisibility);
  }

  /**
   * Load the warm AI morning narrative for the top of Today. ALWAYS 200 server-side (it falls back to the
   * guaranteed deterministic briefing with `fellBackToPlain` = true), so a network blip is the only failure —
   * we just leave the narrative card hidden and the structured cards on show. Refreshed when the day rolls.
   */
  private loadBriefing(): void {
    this.briefingDay = this.localDay();
    this.api
      .familyBriefing()
      .pipe(
        catchError(() => of<FamilyBriefing | null>(null)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((b) => this.briefing.set(b));
  }

  /** Today's local "YYYY-MM-DD" (browser zone) used to detect a day rollover for the briefing refresh. */
  private localDay(): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  /** Reveal / hide the structured Today cards below the narrative (the additive "show plain list" toggle). */
  togglePlainList(): void {
    this.showPlainList.update((v) => !v);
  }

  /** Two-letter initials for the avatar fallback (from the display name; never an email). */
  initials(name: string): string {
    const parts = (name || '').split(/\s+/).filter(Boolean);
    return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
  }

  /** Round a Fahrenheit reading for display (the weather card). */
  roundTemp(f: number): number {
    return Math.round(f);
  }

  /** The OpenWeather icon URL for a 2x condition glyph. */
  weatherIconUrl(icon: string): string {
    return `https://openweathermap.org/img/wn/${icon}@2x.png`;
  }
}
