import { PERM } from './models';

/**
 * THE single source of truth for the "set your home page" picker — the routes a user may choose to land on,
 * each with the any-of permission(s) that grant access.
 *
 * Consumed by ALL three places that previously hand-maintained their own (drifting) copies:
 *   1. the profile-dropdown home picker (app.ts),
 *   2. the beta Settings home picker (beta-settings.page.ts),
 *   3. {@link AuthService.canAccessHome} — which decides whether a SAVED home is actually HONORED on
 *      navigation (the brand link + post-login redirect). If a route was missing here, a saved home for it
 *      silently fell back to a different page — the "I set it but it doesn't work" bug.
 *
 * Mirrors the backend allowlist `HomeRoutes.cs`: a route must appear in BOTH (here + there) to be both
 * selectable in the UI AND persistable by `PATCH /api/auth/home`. Keeping ONE list here is what stops the
 * pickers + the access check from drifting apart. `icon` is a text glyph (the mobile picker renders it; the
 * desktop dropdown ignores it). For routes that ALSO need a feature perm beyond the section gate (e.g. the
 * /beta surfaces need platform.mobile here + the feature perm at the route guard), the guard re-checks on nav.
 */
export interface HomeOption {
  readonly route: string;
  readonly label: string;
  readonly icon: string;
  readonly perms: readonly string[];
}

export const HOME_OPTIONS: readonly HomeOption[] = [
  // ── Live pages ────────────────────────────────────────────────────────────
  { route: '/', label: 'Dashboard', icon: '◧', perms: [PERM.dashboardView] },
  { route: '/calendar', label: 'Calendar', icon: '▦', perms: [PERM.calendarView] },
  { route: '/pricing', label: 'Pricing', icon: '$', perms: [PERM.pricingView] },
  { route: '/reporter', label: 'Reporter', icon: '◉', perms: [PERM.reporterView, PERM.reporterManage, PERM.reporterSelf] },
  { route: '/fleet', label: 'Fleet', icon: '☷', perms: [PERM.fleetView, PERM.reporterManage] },
  { route: '/tracker', label: 'Tracker', icon: '◓', perms: [PERM.trackerSelf] },
  { route: '/ask', label: 'Ask my life', icon: '✶', perms: [PERM.trackerAi] },
  { route: '/challenge', label: '75 Hard', icon: '◆', perms: [PERM.trackerSelf] },
  { route: '/trophies', label: 'Trophies', icon: '♛', perms: [PERM.trackerSelf] },
  { route: '/feed', label: 'Activity feed', icon: '≋', perms: [PERM.trackerSelf] },
  { route: '/automations', label: 'Automations', icon: '⚡', perms: [PERM.automationsUse] },
  { route: '/agents', label: 'Agents', icon: '🤖', perms: [PERM.agentsUse] },
  { route: '/bills', label: 'Bill Splitter', icon: '⊟', perms: [PERM.billsUse] },
  { route: '/grocery', label: 'Grocery list', icon: '☑', perms: [PERM.groceryUse] },
  { route: '/recipes', label: 'My Recipes', icon: '✎', perms: [PERM.recipesUse] },
  { route: '/meal-planner', label: 'Meal Planner', icon: '◔', perms: [PERM.mealsUse] },
  { route: '/family', label: 'Family', icon: '⌂', perms: [PERM.familyUse] },
  { route: '/chat', label: 'Chat', icon: '◌', perms: [PERM.chatRead] },
  { route: '/people', label: 'People', icon: '☺', perms: [PERM.chatRead, PERM.familyUse] },
  { route: '/locations', label: 'My locations', icon: '⊙', perms: [PERM.locationSelf] },
  { route: '/users', label: 'Users', icon: '☰', perms: [PERM.usersView] },
  { route: '/activity', label: 'Activity', icon: '✦', perms: [PERM.activityView] },
  { route: '/settings', label: 'Settings', icon: '⚙', perms: [PERM.settingsView] },
  // ── Beta surfaces (mobile-first redesigns; section gate = platform.mobile) ─────
  { route: '/tracker-beta', label: 'Tracker Beta', icon: '◆', perms: [PERM.platformMobile] },
  { route: '/beta', label: 'Beta', icon: '✦', perms: [PERM.platformMobile] },
  { route: '/beta/home', label: 'Beta · Home', icon: '⌂', perms: [PERM.platformMobile] },
  { route: '/beta/dashboard', label: 'Beta · Dashboard', icon: '◧', perms: [PERM.platformMobile] },
  { route: '/beta/family', label: 'Beta · Family', icon: '⌂', perms: [PERM.platformMobile] },
  { route: '/beta/bills', label: 'Beta · Bills', icon: '⊟', perms: [PERM.platformMobile] },
  { route: '/beta/wrapped', label: 'Beta · Wrapped', icon: '✷', perms: [PERM.platformMobile] },
  { route: '/beta/settings', label: 'Beta · Settings', icon: '⚙', perms: [PERM.platformMobile] },
  { route: '/beta/chat', label: 'Beta · Chat', icon: '◌', perms: [PERM.platformMobile] },
  { route: '/beta/ask', label: 'Beta · Ask', icon: '✶', perms: [PERM.platformMobile] },
  { route: '/beta/meals', label: 'Beta · Meals', icon: '◔', perms: [PERM.platformMobile] },
  { route: '/beta/people', label: 'Beta · People', icon: '☺', perms: [PERM.platformMobile] },
  { route: '/beta/fleet', label: 'Beta · Fleet', icon: '☷', perms: [PERM.platformMobile] },
  { route: '/beta/trophies', label: 'Beta · Trophies', icon: '♛', perms: [PERM.platformMobile] },
  { route: '/beta/automations', label: 'Beta · Automations', icon: '⚡', perms: [PERM.platformMobile] },
];

/**
 * route → any-of permission(s), for {@link AuthService.canAccessHome}. Derived from {@link HOME_OPTIONS}
 * so it can NEVER drift from the picker — adding a row above wires up the picker AND the access check at once.
 */
export const HOME_PERMS: Readonly<Record<string, readonly string[]>> =
  Object.fromEntries(HOME_OPTIONS.map((o) => [o.route, o.perms]));
