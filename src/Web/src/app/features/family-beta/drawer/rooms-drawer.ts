import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';

import { AuthService } from '../../../core/auth';
import { PERM } from '../../../core/models';

/** One navigable family room. COPIED (subset) from family-home.ts TILES — do NOT import FamilyHome. */
interface Room {
  key: string;
  label: string;
  icon: string;
  route: string;
  /** When set, only shown to holders of this permission. */
  perm?: string;
}

/**
 * The family rooms, navigation-only, COPIED as a subset from family-home.ts TILES (NOT imported). Finance
 * and Allowance MAY appear here as perm-gated nav links (money is kept OUT of the glance data cards above,
 * per the sensitive-data rule), but Cycle and Identity Map are DELIBERATELY OMITTED entirely — they are
 * private health / private-time overlays the live family-home landing already excludes, and so must this
 * mirror.
 */
const ROOMS: Room[] = [
  { key: 'calendar', label: 'Calendar', icon: 'calendar_month', route: '/family/calendar' },
  { key: 'lists', label: 'Lists', icon: 'checklist', route: '/family/lists' },
  { key: 'chores', label: 'Chores', icon: 'cleaning_services', route: '/family/chores' },
  { key: 'reminders', label: 'Reminders', icon: 'notifications_active', route: '/family/reminders' },
  { key: 'notes', label: 'Notes', icon: 'sticky_note_2', route: '/family/notes' },
  { key: 'timer', label: 'Timer', icon: 'timer', route: '/family/timer' },
  { key: 'meals', label: 'Meals', icon: 'restaurant', route: '/family/meals' },
  { key: 'polls', label: 'Polls', icon: 'how_to_vote', route: '/family/polls' },
  { key: 'locations', label: "Where's everyone", icon: 'person_pin_circle', route: '/family/locations' },
  { key: 'allowance', label: 'Allowance', icon: 'savings', route: '/family/allowance', perm: PERM.allowanceManage },
  { key: 'finance', label: 'Finance', icon: 'account_balance_wallet', route: '/family/finance', perm: PERM.familyFinance },
  // Household management + family settings — the desktop family-home reaches these via a header "Household"
  // doorway (and Settings from inside Household). No extra client perm: both pages gate/authorize server-side.
  { key: 'household', label: 'Household', icon: 'diversity_3', route: '/family/household' },
  { key: 'settings', label: 'Family settings', icon: 'settings', route: '/family/settings' },
];

/**
 * Collapsed-by-default "Rooms" drawer — the family navigation, demoted below the glance per the
 * "glanceable today first, navigation last" inversion, rebuilt on the shared beta-ui token contract. A
 * 44px+ toggle expands a perm-filtered grid of room tiles. A CHILD (holds chore.claim but not
 * allowance.manage — logic COPIED from family-home.ts:92, not imported) sees ONLY the Chores room,
 * kid-safe. Expansion respects reduced-motion (the page-host killswitch collapses the animation).
 */
@Component({
  selector: 'fb-rooms-drawer',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, MatIconModule],
  template: `
    <section class="drawer">
      <button type="button" class="drawer__toggle" (click)="toggle()"
              [attr.aria-expanded]="open()" aria-controls="fb-rooms-grid">
        <span class="drawer__ic" aria-hidden="true"><mat-icon>grid_view</mat-icon></span>
        <span>Rooms</span>
        <span class="drawer__hint">{{ open() ? 'Hide' : 'All family tools' }}</span>
        <mat-icon class="drawer__chev" aria-hidden="true">{{ open() ? 'expand_less' : 'expand_more' }}</mat-icon>
      </button>

      @if (open()) {
        <div id="fb-rooms-grid" class="grid">
          @for (r of rooms(); track r.key) {
            <a class="tile" [routerLink]="r.route">
              <mat-icon class="tile__icon" aria-hidden="true">{{ r.icon }}</mat-icon>
              <span class="tile__label">{{ r.label }}</span>
            </a>
          }
        </div>
      }
    </section>
  `,
  styles: [`
    .drawer { display: flex; flex-direction: column; gap: 12px; }
    .drawer__toggle {
      display: flex; align-items: center; gap: 12px; width: 100%;
      min-height: 56px; padding: 0 14px; border-radius: var(--r-card);
      background: var(--bg-rise); box-shadow: var(--lift-1); border: 1px solid var(--hairline); color: var(--ink);
      font: inherit; font-size: 15px; font-weight: 700; cursor: pointer;
      transition: transform 120ms var(--ease-out), box-shadow 120ms var(--ease-out), background 120ms var(--ease-out);
    }
    @media (hover: hover) {
      .drawer__toggle:hover {
        background: color-mix(in srgb, var(--accent-a) 6%, var(--bg-rise));
        box-shadow: var(--lift-2);
      }
    }
    .drawer__toggle:active { transform: scale(.99); }
    .drawer__toggle:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
    .drawer__ic {
      flex: 0 0 auto; display: grid; place-items: center; width: 32px; height: 32px; border-radius: 10px;
      background: linear-gradient(135deg, color-mix(in srgb, var(--accent-a) 24%, transparent), color-mix(in srgb, var(--accent-b) 24%, transparent));
    }
    .drawer__ic mat-icon { font-size: 19px; width: 19px; height: 19px; color: color-mix(in srgb, var(--accent-a) 80%, var(--ink)); }
    .drawer__hint { margin-left: auto; font-size: 12px; font-weight: 600; color: var(--ink-dim); }
    .drawer__chev { flex: 0 0 auto; color: var(--ink-dim); transition: transform 200ms var(--ease-spring); }

    .grid {
      display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 10px;
      animation: fb-drawer-in 240ms var(--ease-spring-up) both;
    }
    @keyframes fb-drawer-in { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: none; } }

    .tile {
      display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 7px;
      min-height: 82px; padding: 12px 8px; border-radius: var(--r-tile);
      background: var(--bg-rise); box-shadow: var(--lift-1); border: 1px solid var(--hairline);
      color: var(--ink); text-decoration: none; text-align: center;
      transition: transform 120ms var(--ease-spring), box-shadow 120ms var(--ease-out), background 120ms var(--ease-out);
    }
    @media (hover: hover) {
      .tile:hover {
        transform: translateY(-2px);
        box-shadow: var(--lift-2);
        background: color-mix(in srgb, var(--accent-a) 8%, var(--bg-rise));
      }
    }
    .tile:active { transform: scale(.95); box-shadow: var(--lift-1); }
    .tile:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
    .tile__icon { color: color-mix(in srgb, var(--accent-a) 75%, var(--ink)); font-size: 24px; width: 24px; height: 24px; }
    .tile__label { font-size: 12px; font-weight: 600; line-height: 1.2; }

    @media (prefers-reduced-motion: reduce) {
      .grid { animation: none; }
    }
  `],
})
export class RoomsDrawer {
  private readonly auth = inject(AuthService);

  readonly open = signal(false);

  /** A CHILD: holds chore.claim but NOT allowance.manage. COPIED from family-home.ts:92 (not imported). */
  private readonly isChild = computed<boolean>(() => {
    this.auth.permissions();
    return this.auth.hasPermission(PERM.choreClaim) && !this.auth.hasPermission(PERM.allowanceManage);
  });

  /** Perm-filtered rooms; a child sees ONLY Chores (kid-safe focus). */
  readonly rooms = computed<Room[]>(() => {
    this.auth.permissions();
    const visible = ROOMS.filter(r => !r.perm || this.auth.hasPermission(r.perm));
    return this.isChild() ? visible.filter(r => r.key === 'chores') : visible;
  });

  toggle(): void {
    this.open.update(v => !v);
  }
}
