import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { catchError, of } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';

import { Api } from '../../core/api';
import { AuthService } from '../../core/auth';
import { FamilyToday, Household, HouseholdMember, PERM } from '../../core/models';
import { FamilyTimerWidget } from './timer';

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
  { key: 'notes', label: 'Notes', icon: 'sticky_note_2', blurb: 'Shared notes for the whole family', route: '/family/notes' },
  { key: 'lists', label: 'Lists', icon: 'checklist', blurb: 'Groceries, to-dos, and wish lists', route: '/family/lists' },
  { key: 'reminders', label: 'Reminders', icon: 'notifications_active', blurb: 'Nudges so nothing slips', route: '/family/reminders' },
  { key: 'timer', label: 'Timer', icon: 'timer', blurb: 'Shared timers and countdowns', route: '/family/timer' },
  { key: 'meals', label: 'Meal Planner', icon: 'restaurant', blurb: 'Plan the week around the table', route: null },
  { key: 'chores', label: 'Chores', icon: 'cleaning_services', blurb: 'Share the load, fairly', route: null },
  { key: 'finance', label: 'Finance', icon: 'savings', blurb: 'Budgets, bills, and balances', route: null, perm: PERM.familyFinance },
  { key: 'calendar', label: 'Calendar', icon: 'calendar_month', blurb: 'The family calendar in one place', route: null },
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
    RouterLink, MatIconModule, MatButtonModule, MatTooltipModule, MatProgressSpinnerModule,
    FamilyTimerWidget,
  ],
  templateUrl: './family-home.html',
  styleUrl: './family.scss',
})
export class FamilyHome {
  private api = inject(Api);
  readonly auth = inject(AuthService);

  readonly household = signal<Household | null>(null);
  readonly today = signal<FamilyToday | null>(null);
  readonly loading = signal(true);
  readonly error = signal(false);

  /** Feature tiles, filtered to the ones the caller may see (Finance hides without family.finance). */
  readonly tiles = computed<FeatureTile[]>(() => {
    this.auth.permissions(); // re-run on permission changes
    return TILES.filter(t => !t.perm || this.auth.hasPermission(t.perm));
  });

  /** The household's members in server order (owner first), or empty until loaded. */
  readonly members = computed<HouseholdMember[]>(() => this.household()?.members ?? []);

  /** The local date, parsed from the snapshot's ISO date for a friendly "Thursday, June 20" rendering. */
  readonly dateLabel = computed<string>(() => {
    const iso = this.today()?.dateLocal;
    if (!iso) return '';
    // dateLocal is a plain ISO date (no time); parse as local midnight to avoid a TZ shift.
    const d = new Date(`${iso}T00:00:00`);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  });

  constructor() {
    this.api.getHousehold()
      .pipe(catchError(() => { this.error.set(true); return of(null); }), takeUntilDestroyed())
      .subscribe(h => { if (h) this.household.set(h); this.loading.set(false); });

    // The Today snapshot is best-effort: a failure leaves the dashboard cards empty but the home still works.
    this.api.familyToday()
      .pipe(catchError(() => of<FamilyToday | null>(null)), takeUntilDestroyed())
      .subscribe(t => { if (t) this.today.set(t); });
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
