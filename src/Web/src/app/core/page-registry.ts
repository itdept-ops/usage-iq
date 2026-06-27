import { Route, Routes } from '@angular/router';

import { authGuard } from './auth.guard';
import { permissionGuard, anyPermissionGuard } from './permission.guard';
import { isMobileGated } from './platform.guard';
import { PERM } from './models';

/**
 * The CENTRAL registry of the authenticated app's pages — the single source of truth that drives (a) the route
 * table (desktop + mobile-per-device, via {@link toRoutes}), (b) the nav (desktop dropdowns + the mobile
 * bottom-tab/More sheet), and (c) the home-route picker. Before this, routes lived in `app.routes.ts`, the nav
 * was hand-written TWICE in `app.html`, and the home options were a third list — they could (and did) drift.
 *
 * DESKTOP/MOBILE SPLIT: each page can carry a `mobile` (or `mobileChildren`) loader. {@link toRoutes} expands a
 * page that has one into a MOBILE route entry (`canMatch: [isMobileGated]`) ordered BEFORE the desktop entry at
 * the same path — so a phone (with the `platform.mobile` grant) gets the mobile variant, and everything else
 * (desktop, no grant, or no twin defined yet) falls through to the desktop entry. Per-variant lazy-loading is
 * preserved; a session only downloads the variant it renders. In Wave 0 NO page has a `mobile` twin yet, so the
 * emitted routing is byte-for-byte the current desktop behavior.
 */

/** The desktop nav groups (the dropdown headers / mobile section headers). NOT the same as permission catalog
 *  groups — these are purely the navigation taxonomy. */
export type NavGroup = 'Usage' | 'Fitness' | 'Tools' | 'Social' | 'Family' | 'Admin';

/** Nav placement for a page. Absence means the page has no nav entry (it's a deep/account-menu page). */
interface NavMeta {
  readonly group: NavGroup;
  readonly label: string;
  readonly icon: string;          // Material Symbols name
  /** True ⇒ a primary bottom-tab on mobile (the 4 fixed tabs; everything else lives under "More"). */
  readonly tab?: boolean;
}

/** A lazy component loader (the `() => import(...).then(m => m.X)` thunk). */
type LoadComponent = Route['loadComponent'];
type LoadChildren = Route['loadChildren'];

/** One authenticated app page. Exactly one of {desktop, children} describes the desktop route. */
export interface PageDef {
  readonly id: string;
  readonly path: string;                  // '' for home; 'family' (with children); 'admin/locations'; …
  readonly title?: string;
  // gate — at most one of these
  readonly perm?: string;
  readonly anyPerm?: readonly string[];
  readonly authOnly?: boolean;
  // desktop variant — either a leaf component or a children array (the Family hub)
  readonly desktop?: LoadComponent;
  readonly children?: Route[];
  // mobile variant (Wave 1+) — undefined ⇒ fall back to the responsive desktop page
  readonly mobile?: LoadComponent;
  readonly mobileChildren?: LoadChildren;
  readonly providers?: Route['providers'];
  readonly nav?: NavMeta;
  /** Shown in the home-route picker when the caller can reach it. Label defaults to the nav label. */
  readonly home?: { readonly label: string; readonly icon?: string };
}

/** The page registry, in nav/declaration order. */
export const PAGE_REGISTRY: readonly PageDef[] = [
  // ---- Usage ----
  {
    id: 'dashboard', path: '', title: 'Usage IQ · Dashboard', perm: PERM.dashboardView,
    desktop: () => import('../features/dashboard/dashboard').then(m => m.Dashboard),
    nav: { group: 'Usage', label: 'Dashboard', icon: 'space_dashboard', tab: true },
    home: { label: 'Dashboard', icon: 'space_dashboard' },
  },
  {
    id: 'calendar', path: 'calendar', title: 'Usage IQ · Calendar', perm: PERM.calendarView,
    desktop: () => import('../features/calendar/calendar').then(m => m.Calendar),
    nav: { group: 'Usage', label: 'Calendar', icon: 'calendar_month' },
    home: { label: 'Calendar', icon: 'calendar_month' },
  },
  {
    id: 'pricing', path: 'pricing', title: 'Usage IQ · Pricing', perm: PERM.pricingView,
    desktop: () => import('../features/pricing/pricing').then(m => m.Pricing),
    nav: { group: 'Usage', label: 'Pricing', icon: 'sell' },
    home: { label: 'Pricing', icon: 'sell' },
  },
  {
    id: 'reporter', path: 'reporter', title: 'Usage IQ · Reporter',
    anyPerm: [PERM.reporterView, PERM.reporterManage, PERM.reporterSelf],
    desktop: () => import('../features/reporter/reporter').then(m => m.ReporterPage),
    nav: { group: 'Usage', label: 'Reporter', icon: 'cloud_upload' },
    home: { label: 'Reporter', icon: 'cloud_upload' },
  },
  {
    id: 'fleet', path: 'fleet', title: 'Usage IQ · Fleet',
    anyPerm: [PERM.fleetView, PERM.reporterManage],
    desktop: () => import('../features/fleet/fleet').then(m => m.Fleet),
    nav: { group: 'Usage', label: 'Fleet', icon: 'dns' },
    home: { label: 'Fleet', icon: 'dns' },
  },

  // ---- Fitness ----
  {
    id: 'tracker', path: 'tracker', title: 'Usage IQ · Tracker', perm: PERM.trackerSelf,
    desktop: () => import('../features/tracker/tracker').then(m => m.Tracker),
    nav: { group: 'Fitness', label: 'Tracker', icon: 'fitness_center', tab: true },
    home: { label: 'Tracker', icon: 'fitness_center' },
  },
  {
    id: 'tracker-profile', path: 'tracker/profile', title: 'Usage IQ · My Profile & Goal', perm: PERM.trackerSelf,
    desktop: () => import('../features/tracker/profile-page').then(m => m.ProfilePage),
    home: { label: 'My Profile & Goal', icon: 'assignment_ind' },
  },
  {
    id: 'challenge', path: 'challenge', title: 'Usage IQ · 75 Hard', perm: PERM.trackerSelf,
    desktop: () => import('../features/challenge/challenge').then(m => m.Challenge),
    nav: { group: 'Fitness', label: '75 Hard', icon: 'local_fire_department' },
    home: { label: '75 Hard', icon: 'local_fire_department' },
  },
  {
    id: 'trophies', path: 'trophies', title: 'Usage IQ · Trophies', perm: PERM.trackerSelf,
    desktop: () => import('../features/trophies/trophies').then(m => m.Trophies),
    nav: { group: 'Fitness', label: 'Trophies', icon: 'emoji_events' },
    home: { label: 'Trophies', icon: 'emoji_events' },
  },
  {
    id: 'feed', path: 'feed', title: 'Usage IQ · Activity feed', perm: PERM.trackerSelf,
    desktop: () => import('../features/feed/feed').then(m => m.Feed),
    nav: { group: 'Fitness', label: 'Activity', icon: 'dynamic_feed' },
    home: { label: 'Activity feed', icon: 'dynamic_feed' },
  },

  // ---- Tools ----
  {
    id: 'ask', path: 'ask', title: 'Usage IQ · Ask my life', perm: PERM.trackerAi,
    desktop: () => import('../features/ask/ask').then(m => m.Ask),
    nav: { group: 'Tools', label: 'Ask', icon: 'auto_awesome' },
    home: { label: 'Ask my life', icon: 'auto_awesome' },
  },
  {
    id: 'automations', path: 'automations', title: 'Usage IQ · Automations', perm: PERM.automationsUse,
    desktop: () => import('../features/automations/automations').then(m => m.Automations),
    nav: { group: 'Tools', label: 'Automations', icon: 'bolt' },
    home: { label: 'Automations', icon: 'bolt' },
  },
  {
    id: 'bills', path: 'bills', title: 'Usage IQ · Bill Splitter', perm: PERM.billsUse,
    desktop: () => import('../features/bills/bills').then(m => m.Bills),
    nav: { group: 'Tools', label: 'Bills', icon: 'receipt_long' },
    home: { label: 'Bill Splitter', icon: 'receipt_long' },
  },
  {
    id: 'grocery', path: 'grocery', title: 'Usage IQ · Grocery list', perm: PERM.groceryUse,
    desktop: () => import('../features/grocery/grocery').then(m => m.Grocery),
    nav: { group: 'Tools', label: 'Grocery', icon: 'shopping_cart' },
    home: { label: 'Grocery list', icon: 'shopping_cart' },
  },
  {
    id: 'recipes', path: 'recipes', title: 'Usage IQ · My Recipes', perm: PERM.recipesUse,
    desktop: () => import('../features/recipes/recipes').then(m => m.Recipes),
    nav: { group: 'Tools', label: 'My Recipes', icon: 'menu_book' },
    home: { label: 'My Recipes', icon: 'menu_book' },
  },
  {
    id: 'meal-planner', path: 'meal-planner', title: 'Usage IQ · Meal Planner', perm: PERM.mealsUse,
    desktop: () => import('../features/meal-planner/meal-planner').then(m => m.MealPlanner),
    nav: { group: 'Tools', label: 'Meal Planner', icon: 'restaurant_menu' },
    home: { label: 'Meal Planner', icon: 'restaurant_menu' },
  },
  {
    id: 'resume', path: 'resume', title: 'Usage IQ · Resume Builder', perm: PERM.resumeUse,
    desktop: () => import('../features/resume/resume').then(m => m.Resume),
    nav: { group: 'Tools', label: 'Resume Builder', icon: 'description' },
    home: { label: 'Resume Builder', icon: 'description' },
  },

  // ---- Social ----
  {
    id: 'chat', path: 'chat', title: 'Usage IQ · Chat', perm: PERM.chatRead,
    desktop: () => import('../features/chat/chat').then(m => m.Chat),
    nav: { group: 'Social', label: 'Chat', icon: 'chat_bubble', tab: true },
    home: { label: 'Chat', icon: 'chat_bubble' },
  },
  {
    id: 'people', path: 'people', title: 'Usage IQ · People',
    anyPerm: [PERM.chatRead, PERM.familyUse],
    desktop: () => import('../features/people/people').then(m => m.People),
    nav: { group: 'Social', label: 'People', icon: 'groups' },
    home: { label: 'People', icon: 'groups' },
  },

  // ---- Family (a hub with children; the whole group is gated by family.use) ----
  {
    id: 'family', path: 'family', perm: PERM.familyUse,
    nav: { group: 'Family', label: 'Family', icon: 'cottage', tab: true },
    home: { label: 'Family', icon: 'cottage' },
    children: [
      { path: '', title: 'Usage IQ · Family', loadComponent: () => import('../features/family/family-home').then(m => m.FamilyHome) },
      { path: 'household', title: 'Usage IQ · Household', loadComponent: () => import('../features/family/household').then(m => m.HouseholdSettings) },
      { path: 'settings', title: 'Usage IQ · Family Settings', loadComponent: () => import('../features/family/family-settings').then(m => m.FamilySettingsPanel) },
      { path: 'notes', title: 'Usage IQ · Family Notes', loadComponent: () => import('../features/family/notes').then(m => m.FamilyNotes) },
      { path: 'lists', title: 'Usage IQ · Family Lists', loadComponent: () => import('../features/family/lists').then(m => m.FamilyLists) },
      { path: 'reminders', title: 'Usage IQ · Family Reminders', loadComponent: () => import('../features/family/reminders').then(m => m.FamilyReminders) },
      { path: 'timer', title: 'Usage IQ · Family Timer', loadComponent: () => import('../features/family/timer').then(m => m.FamilyTimerWidget) },
      { path: 'meals', title: 'Usage IQ · Meal Planner', loadComponent: () => import('../features/family/meals').then(m => m.FamilyMeals) },
      { path: 'chores', title: 'Usage IQ · Chores', loadComponent: () => import('../features/family/chores').then(m => m.FamilyChores) },
      { path: 'allowance', title: 'Usage IQ · Allowance', canActivate: [permissionGuard(PERM.allowanceManage)], loadComponent: () => import('../features/family/allowance').then(m => m.FamilyAllowance) },
      { path: 'calendar', title: 'Usage IQ · Family Calendar', loadComponent: () => import('../features/family/calendar').then(m => m.FamilyCalendar) },
      { path: 'polls', title: 'Usage IQ · Family Polls', loadComponent: () => import('../features/family/polls').then(m => m.FamilyPolls) },
      { path: 'locations', title: 'Usage IQ · Where is everyone', loadComponent: () => import('../features/family/family-locations').then(m => m.FamilyLocations) },
      { path: 'cycle', title: 'Usage IQ · Cycle', canActivate: [permissionGuard(PERM.cycleTrack)], loadComponent: () => import('../features/family/cycle').then(m => m.FamilyCycle) },
      { path: 'identity', title: 'Usage IQ · Identity Map', canActivate: [permissionGuard(PERM.identityMap)], loadComponent: () => import('../features/family/identity-map').then(m => m.FamilyIdentityMap) },
      { path: 'finance', title: 'Usage IQ · Family Finances', canActivate: [permissionGuard(PERM.familyFinance)], loadComponent: () => import('../features/family/finance').then(m => m.FamilyFinance) },
    ],
  },

  // ---- Admin ----
  {
    id: 'settings', path: 'settings', title: 'Usage IQ · Settings', perm: PERM.settingsView,
    desktop: () => import('../features/settings/settings').then(m => m.Settings),
    nav: { group: 'Admin', label: 'Settings', icon: 'settings' },
    home: { label: 'Settings', icon: 'settings' },
  },
  {
    id: 'users', path: 'users', title: 'Usage IQ · Users', perm: PERM.usersView,
    desktop: () => import('../features/users/users').then(m => m.Users),
    nav: { group: 'Admin', label: 'Users', icon: 'group' },
    home: { label: 'Users', icon: 'group' },
  },
  {
    id: 'admin-locations', path: 'admin/locations', title: 'Usage IQ · Locations', perm: PERM.locationViewAll,
    desktop: () => import('../features/location/admin-locations').then(m => m.AdminLocations),
    nav: { group: 'Admin', label: 'Locations', icon: 'location_on' },
  },
  {
    id: 'activity', path: 'activity', title: 'Usage IQ · Activity', perm: PERM.activityView,
    desktop: () => import('../features/logs/logs').then(m => m.Logs),
    nav: { group: 'Admin', label: 'Activity', icon: 'receipt_long' },
    home: { label: 'Activity', icon: 'receipt_long' },
  },
  {
    id: 'ai-usage', path: 'ai-usage', title: 'Usage IQ · AI usage', perm: PERM.aiUsageView,
    desktop: () => import('../features/ai-usage/ai-usage').then(m => m.AiUsage),
    nav: { group: 'Admin', label: 'AI usage', icon: 'smart_toy' },
  },

  // ---- No nav entry (account menu / deep pages), but real routes + home options ----
  {
    id: 'preferences', path: 'preferences', title: 'Usage IQ · Settings', authOnly: true,
    desktop: () => import('../features/preferences/preferences').then(m => m.Preferences),
  },
  {
    id: 'profile', path: 'profile', title: 'Usage IQ · Profile', authOnly: true,
    desktop: () => import('../features/profile/profile').then(m => m.Profile),
  },
  {
    id: 'locations', path: 'locations', title: 'Usage IQ · My locations', perm: PERM.locationSelf,
    desktop: () => import('../features/location/my-locations').then(m => m.MyLocations),
    home: { label: 'My locations', icon: 'my_location' },
  },
];

/** The route guards for a page (mirrors the original per-route `canActivate`). */
function gate(p: PageDef): Route['canActivate'] {
  if (p.perm) return [permissionGuard(p.perm)];
  if (p.anyPerm) return [anyPermissionGuard(...p.anyPerm)];
  if (p.authOnly) return [authGuard];
  return undefined;
}

/**
 * Expand the registry into router entries. A page with a mobile twin emits `[mobileEntry, desktopEntry]` at the
 * same path (mobile first, `canMatch: [isMobileGated]`); a page without one emits just the desktop entry. The
 * desktop entry is ALWAYS last for its path, so it is the universal fallback.
 */
export function toRoutes(reg: readonly PageDef[] = PAGE_REGISTRY): Routes {
  return reg.flatMap((p): Routes => {
    const canActivate = gate(p);
    const desktop: Route = p.children
      ? { path: p.path, title: p.title, canActivate, providers: p.providers, children: p.children }
      : { path: p.path, title: p.title, canActivate, providers: p.providers, loadComponent: p.desktop };

    if (!p.mobile && !p.mobileChildren) return [desktop];

    const mobile: Route = p.mobileChildren
      ? { path: p.path, canMatch: [isMobileGated], canActivate, providers: p.providers, loadChildren: p.mobileChildren }
      : { path: p.path, title: p.title, canMatch: [isMobileGated], canActivate, providers: p.providers, loadComponent: p.mobile };

    return [mobile, desktop];
  });
}
