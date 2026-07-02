import { Route, Routes } from '@angular/router';

import { authGuard } from './auth.guard';
import { permissionGuard, anyPermissionGuard } from './permission.guard';
import { isMobileGated } from './platform.guard';
import { PERM } from './models';

/**
 * The CENTRAL registry of the authenticated app's pages — the single source of truth that drives (a) the route
 * table (desktop + mobile-per-device, via {@link toRoutes}) and (b) the nav (desktop dropdowns + the mobile
 * bottom-tab/More sheet). Before this, routes lived in `app.routes.ts` and the nav was hand-written TWICE in
 * `app.html` — they could (and did) drift. (The home-route picker is a separate list; see `core/home-options.ts`.)
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
}

/**
 * Build the desktop (+ optional mobile) route entries for a single Family child page. The mobile entry
 * (when a `mobile` loader is given) is emitted FIRST with `canMatch: [isMobileGated]` so a phone gets the
 * mobile twin and everything else falls through to the desktop entry at the same child path. The child's
 * extra permission guard (when present) is applied to BOTH variants; the parent's `family.use` guard +
 * providers are inherited from the parent route.
 */
function familyChild(c: {
  path: string;
  title: string;
  perm?: string;
  desktop: LoadComponent;
  mobile?: LoadComponent;
}): Route[] {
  const canActivate = c.perm ? [permissionGuard(c.perm)] : undefined;
  const desktop: Route = { path: c.path, title: c.title, canActivate, loadComponent: c.desktop };
  if (!c.mobile) return [desktop];
  const mobile: Route = { path: c.path, canMatch: [isMobileGated], canActivate, loadComponent: c.mobile };
  return [mobile, desktop];
}

/** The page registry, in nav/declaration order. */
export const PAGE_REGISTRY: readonly PageDef[] = [
  // ---- Usage ----
  {
    id: 'dashboard', path: '', title: 'Usage IQ · Dashboard', perm: PERM.dashboardView,
    desktop: () => import('../features/dashboard/dashboard').then(m => m.Dashboard),
    mobile: () => import('../features/dashboard-beta/dashboard-beta.page').then(m => m.DashboardBetaPage),
    nav: { group: 'Usage', label: 'Dashboard', icon: 'space_dashboard', tab: true },
  },
  {
    id: 'calendar', path: 'calendar', title: 'Usage IQ · Calendar', perm: PERM.calendarView,
    desktop: () => import('../features/calendar/calendar').then(m => m.Calendar),
    mobile: () => import('../features/calendar-mobile/calendar-mobile.page').then(m => m.CalendarMobilePage),
    nav: { group: 'Usage', label: 'Calendar', icon: 'calendar_month' },
  },
  {
    id: 'pricing', path: 'pricing', title: 'Usage IQ · Pricing', perm: PERM.pricingView,
    desktop: () => import('../features/pricing/pricing').then(m => m.Pricing),
    mobile: () => import('../features/pricing-mobile/pricing-mobile.page').then(m => m.PricingMobilePage),
    nav: { group: 'Usage', label: 'Pricing', icon: 'sell' },
  },
  {
    id: 'reporter', path: 'reporter', title: 'Usage IQ · Reporter',
    anyPerm: [PERM.reporterView, PERM.reporterManage, PERM.reporterSelf],
    desktop: () => import('../features/reporter/reporter').then(m => m.ReporterPage),
    mobile: () => import('../features/reporter-mobile/reporter-mobile.page').then(m => m.ReporterMobilePage),
    nav: { group: 'Usage', label: 'Reporter', icon: 'cloud_upload' },
  },
  {
    id: 'fleet', path: 'fleet', title: 'Usage IQ · Fleet',
    anyPerm: [PERM.fleetView, PERM.reporterManage],
    desktop: () => import('../features/fleet/fleet').then(m => m.Fleet),
    mobile: () => import('../features/fleet-beta/fleet-beta.page').then(m => m.FleetBetaPage),
    nav: { group: 'Usage', label: 'Fleet', icon: 'dns' },
  },

  // ---- Fitness ----
  {
    id: 'tracker', path: 'tracker', title: 'Usage IQ · Tracker', perm: PERM.trackerSelf,
    desktop: () => import('../features/tracker/tracker').then(m => m.Tracker),
    mobile: () => import('../features/tracker-beta/tracker-beta.page').then(m => m.TrackerBetaPage),
    nav: { group: 'Fitness', label: 'Tracker', icon: 'fitness_center', tab: true },
  },
  {
    id: 'tracker-profile', path: 'tracker/profile', title: 'Usage IQ · My Profile & Goal', perm: PERM.trackerSelf,
    desktop: () => import('../features/tracker/profile-page').then(m => m.ProfilePage),
    mobile: () => import('../features/tracker-profile-mobile/tracker-profile-mobile.page').then(m => m.TrackerProfileMobilePage),
  },
  {
    id: 'settings-health', path: 'settings/health', title: 'Usage IQ · Wearable sync', perm: PERM.healthSync,
    desktop: () => import('../features/settings-health/settings-health').then(m => m.SettingsHealth),
    mobile: () => import('../features/settings-health-mobile/settings-health-mobile.page').then(m => m.SettingsHealthMobilePage),
    nav: { group: 'Fitness', label: 'Wearable sync', icon: 'watch' },
  },
  {
    id: 'meds', path: 'meds', title: 'Usage IQ · Meds & Vitals', perm: PERM.trackerSelf,
    desktop: () => import('../features/meds/meds.page').then(m => m.MedsPage),
    mobile: () => import('../features/meds-mobile/meds-mobile.page').then(m => m.MedsMobilePage),
    nav: { group: 'Fitness', label: 'Meds & Vitals', icon: 'medication' },
  },
  {
    id: 'challenge', path: 'challenge', title: 'Usage IQ · 75 Hard', perm: PERM.trackerSelf,
    desktop: () => import('../features/challenge/challenge').then(m => m.Challenge),
    mobile: () => import('../features/challenge-mobile/challenge-mobile.page').then(m => m.ChallengeMobilePage),
    nav: { group: 'Fitness', label: '75 Hard', icon: 'local_fire_department' },
  },
  {
    id: 'habits', path: 'habits', title: 'Usage IQ · Habits', perm: PERM.trackerSelf,
    desktop: () => import('../features/habits/habits').then(m => m.Habits),
    mobile: () => import('../features/habits-mobile/habits-mobile.page').then(m => m.HabitsMobilePage),
    nav: { group: 'Fitness', label: 'Habits', icon: 'checklist' },
  },
  {
    id: 'journal', path: 'journal', title: 'Usage IQ · Journal', perm: PERM.trackerSelf,
    desktop: () => import('../features/journal/journal').then(m => m.Journal),
    mobile: () => import('../features/journal-mobile/journal-mobile.page').then(m => m.JournalMobilePage),
    nav: { group: 'Fitness', label: 'Journal', icon: 'menu_book' },
  },
  {
    id: 'trophies', path: 'trophies', title: 'Usage IQ · Trophies', perm: PERM.trackerSelf,
    desktop: () => import('../features/trophies/trophies').then(m => m.Trophies),
    mobile: () => import('../features/trophies-beta/trophies-beta.page').then(m => m.TrophiesBetaPage),
    nav: { group: 'Fitness', label: 'Trophies', icon: 'emoji_events' },
  },
  {
    id: 'feed', path: 'feed', title: 'Usage IQ · Activity feed', perm: PERM.trackerSelf,
    desktop: () => import('../features/feed/feed').then(m => m.Feed),
    mobile: () => import('../features/feed-mobile/feed-mobile.page').then(m => m.FeedMobilePage),
    nav: { group: 'Fitness', label: 'Activity', icon: 'dynamic_feed' },
  },
  {
    id: 'pacts', path: 'pacts', title: 'Usage IQ · Habit pacts', perm: PERM.trackerSelf,
    desktop: () => import('../features/pacts/pacts').then(m => m.Pacts),
    mobile: () => import('../features/pacts-mobile/pacts-mobile.page').then(m => m.PactsMobilePage),
    nav: { group: 'Fitness', label: 'Pacts', icon: 'handshake' },
  },

  // ---- Tools ----
  {
    id: 'ask', path: 'ask', title: 'Usage IQ · Ask my life', perm: PERM.trackerAi,
    desktop: () => import('../features/ask/ask').then(m => m.Ask),
    mobile: () => import('../features/ask-beta/ask-beta.page').then(m => m.AskBetaPage),
    nav: { group: 'Tools', label: 'Ask', icon: 'auto_awesome' },
  },
  {
    id: 'automations', path: 'automations', title: 'Usage IQ · Automations', perm: PERM.automationsUse,
    desktop: () => import('../features/automations/automations').then(m => m.Automations),
    mobile: () => import('../features/automations-beta/automations-beta.page').then(m => m.AutomationsBetaPage),
    nav: { group: 'Tools', label: 'Automations', icon: 'bolt' },
  },
  {
    id: 'agents', path: 'agents', title: 'Usage IQ · Agents', perm: PERM.agentsUse,
    desktop: () => import('../features/agents/agents').then(m => m.Agents),
    mobile: () => import('../features/agents-mobile/agents-mobile.page').then(m => m.AgentsMobilePage),
    nav: { group: 'Tools', label: 'Agents', icon: 'smart_toy' },
  },
  {
    id: 'inbox', path: 'inbox', title: 'Usage IQ · Agent Inbox', perm: PERM.agentsUse,
    desktop: () => import('../features/inbox/inbox').then(m => m.Inbox),
    mobile: () => import('../features/inbox-mobile/inbox-mobile.page').then(m => m.InboxMobilePage),
    nav: { group: 'Tools', label: 'Agent Inbox', icon: 'inbox' },
  },
  {
    id: 'bills', path: 'bills', title: 'Usage IQ · Bill Splitter', perm: PERM.billsUse,
    desktop: () => import('../features/bills/bills').then(m => m.Bills),
    mobile: () => import('../features/bills-beta/bills-beta.page').then(m => m.BillsBetaPage),
    nav: { group: 'Tools', label: 'Bills', icon: 'receipt_long' },
  },
  {
    id: 'grocery', path: 'grocery', title: 'Usage IQ · Grocery list', perm: PERM.groceryUse,
    desktop: () => import('../features/grocery/grocery').then(m => m.Grocery),
    mobile: () => import('../features/grocery-mobile/grocery-mobile.page').then(m => m.GroceryMobilePage),
    nav: { group: 'Tools', label: 'Grocery', icon: 'shopping_cart' },
  },
  {
    id: 'recipes', path: 'recipes', title: 'Usage IQ · My Recipes', perm: PERM.recipesUse,
    desktop: () => import('../features/recipes/recipes').then(m => m.Recipes),
    mobile: () => import('../features/recipes-mobile/recipes-mobile.page').then(m => m.RecipesMobilePage),
    nav: { group: 'Tools', label: 'My Recipes', icon: 'menu_book' },
  },
  {
    id: 'meal-planner', path: 'meal-planner', title: 'Usage IQ · Meal Planner', perm: PERM.mealsUse,
    desktop: () => import('../features/meal-planner/meal-planner').then(m => m.MealPlanner),
    mobile: () => import('../features/meals-beta/meals-beta.page').then(m => m.MealsBetaPage),
    nav: { group: 'Tools', label: 'Meal Planner', icon: 'restaurant_menu' },
  },
  {
    id: 'resume', path: 'resume', title: 'Usage IQ · Resume Builder', perm: PERM.resumeUse,
    desktop: () => import('../features/resume/resume').then(m => m.Resume),
    mobile: () => import('../features/resume-mobile/resume-mobile.page').then(m => m.ResumeMobilePage),
    nav: { group: 'Tools', label: 'Resume Builder', icon: 'description' },
  },
  {
    id: 'today', path: 'today', title: 'Usage IQ · Your Day', perm: PERM.trackerSelf,
    desktop: () => import('../features/today/today.page').then(m => m.TodayPage),
    mobile: () => import('../features/today-mobile/today-mobile.page').then(m => m.TodayMobilePage),
    nav: { group: 'Tools', label: 'Your Day', icon: 'wb_twilight' },
  },
  {
    id: 'wrapped', path: 'wrapped', title: 'Usage IQ · Wrapped', perm: PERM.trackerSelf,
    desktop: () => import('../features/wrapped/wrapped.page').then(m => m.WrappedPage),
    mobile: () => import('../features/wrapped-beta/wrapped-beta.page').then(m => m.WrappedBetaPage),
    nav: { group: 'Tools', label: 'Wrapped', icon: 'auto_awesome' },
  },
  {
    id: 'insights', path: 'insights', title: 'Usage IQ · Insights', perm: PERM.trackerSelf,
    desktop: () => import('../features/insights/insights.page').then(m => m.InsightsPage),
    mobile: () => import('../features/insights-mobile/insights.page').then(m => m.InsightsMobilePage),
    nav: { group: 'Tools', label: 'Insights', icon: 'insights' },
  },
  {
    id: 'search', path: 'search', title: 'Usage IQ · Search', perm: PERM.searchUse,
    desktop: () => import('../features/search/search').then(m => m.Search),
    mobile: () => import('../features/search-mobile/search-mobile.page').then(m => m.SearchMobilePage),
    nav: { group: 'Tools', label: 'Search', icon: 'search' },
  },

  // ---- Social ----
  {
    id: 'chat', path: 'chat', title: 'Usage IQ · Chat', perm: PERM.chatRead,
    desktop: () => import('../features/chat/chat').then(m => m.Chat),
    mobile: () => import('../features/chat-beta/chat-beta.page').then(m => m.ChatBetaPage),
    nav: { group: 'Social', label: 'Chat', icon: 'chat_bubble', tab: true },
  },
  {
    id: 'people', path: 'people', title: 'Usage IQ · People',
    anyPerm: [PERM.chatRead, PERM.familyUse],
    desktop: () => import('../features/people/people').then(m => m.People),
    mobile: () => import('../features/people-beta/people-beta.page').then(m => m.PeopleBetaPage),
    nav: { group: 'Social', label: 'People', icon: 'groups' },
  },

  // ---- Family (a hub with children; the whole group is gated by family.use) ----
  {
    id: 'family', path: 'family', perm: PERM.familyUse,
    mobile: () => import('../features/family-beta/family-beta.page').then(m => m.FamilyBetaPage),
    nav: { group: 'Family', label: 'Family', icon: 'cottage', tab: true },
    children: [
      // family-home index — desktop-only (the parent PageDef's top-level `mobile`=FamilyBetaPage is the /family glance).
      { path: '', title: 'Usage IQ · Family', loadComponent: () => import('../features/family/family-home').then(m => m.FamilyHome) },
      ...familyChild({
        path: 'household', title: 'Usage IQ · Household',
        desktop: () => import('../features/family/household').then(m => m.HouseholdSettings),
        mobile: () => import('../features/household-mobile/household-mobile.page').then(m => m.HouseholdMobilePage),
      }),
      ...familyChild({
        path: 'settings', title: 'Usage IQ · Family Settings',
        desktop: () => import('../features/family/family-settings').then(m => m.FamilySettingsPanel),
        mobile: () => import('../features/family-settings-mobile/family-settings-mobile.page').then(m => m.FamilySettingsMobilePage),
      }),
      ...familyChild({
        path: 'notes', title: 'Usage IQ · Family Notes',
        desktop: () => import('../features/family/notes').then(m => m.FamilyNotes),
        mobile: () => import('../features/family-notes-mobile/family-notes-mobile.page').then(m => m.FamilyNotesMobilePage),
      }),
      ...familyChild({
        path: 'lists', title: 'Usage IQ · Family Lists',
        desktop: () => import('../features/family/lists').then(m => m.FamilyLists),
        mobile: () => import('../features/family-lists-mobile/family-lists-mobile.page').then(m => m.FamilyListsMobilePage),
      }),
      ...familyChild({
        path: 'reminders', title: 'Usage IQ · Family Reminders',
        desktop: () => import('../features/family/reminders').then(m => m.FamilyReminders),
        mobile: () => import('../features/family-reminders-mobile/family-reminders-mobile.page').then(m => m.FamilyRemindersMobilePage),
      }),
      ...familyChild({
        path: 'timer', title: 'Usage IQ · Family Timer',
        desktop: () => import('../features/family/timer').then(m => m.FamilyTimerWidget),
        mobile: () => import('../features/family-timer-mobile/family-timer-mobile.page').then(m => m.FamilyTimerMobilePage),
      }),
      ...familyChild({
        path: 'meals', title: 'Usage IQ · Meal Planner',
        desktop: () => import('../features/family/meals').then(m => m.FamilyMeals),
        mobile: () => import('../features/family-meals-mobile/family-meals-mobile.page').then(m => m.FamilyMealsMobilePage),
      }),
      ...familyChild({
        path: 'chores', title: 'Usage IQ · Chores',
        desktop: () => import('../features/family/chores').then(m => m.FamilyChores),
        mobile: () => import('../features/family-chores-mobile/family-chores-mobile.page').then(m => m.FamilyChoresMobilePage),
      }),
      ...familyChild({
        path: 'allowance', title: 'Usage IQ · Allowance', perm: PERM.allowanceManage,
        desktop: () => import('../features/family/allowance').then(m => m.FamilyAllowance),
        mobile: () => import('../features/family-allowance-mobile/family-allowance-mobile.page').then(m => m.FamilyAllowanceMobilePage),
      }),
      ...familyChild({
        path: 'calendar', title: 'Usage IQ · Family Calendar',
        desktop: () => import('../features/family/calendar').then(m => m.FamilyCalendar),
        mobile: () => import('../features/family-calendar-mobile/family-calendar-mobile.page').then(m => m.FamilyCalendarMobilePage),
      }),
      ...familyChild({
        path: 'polls', title: 'Usage IQ · Family Polls',
        desktop: () => import('../features/family/polls').then(m => m.FamilyPolls),
        mobile: () => import('../features/family-polls-mobile/family-polls-mobile.page').then(m => m.FamilyPollsMobilePage),
      }),
      ...familyChild({
        path: 'locations', title: 'Usage IQ · Where is everyone',
        desktop: () => import('../features/family/family-locations').then(m => m.FamilyLocations),
        mobile: () => import('../features/family-locations-mobile/family-locations-mobile.page').then(m => m.FamilyLocationsMobilePage),
      }),
      ...familyChild({
        path: 'cycle', title: 'Usage IQ · Cycle', perm: PERM.cycleTrack,
        desktop: () => import('../features/family/cycle').then(m => m.FamilyCycle),
        mobile: () => import('../features/cycle-mobile/cycle-mobile.page').then(m => m.CycleMobilePage),
      }),
      ...familyChild({
        path: 'identity', title: 'Usage IQ · Identity Map', perm: PERM.identityMap,
        desktop: () => import('../features/family/identity-map').then(m => m.FamilyIdentityMap),
        mobile: () => import('../features/identity-mobile/identity-mobile.page').then(m => m.IdentityMobilePage),
      }),
      ...familyChild({
        path: 'finance', title: 'Usage IQ · Family Finances', perm: PERM.familyFinance,
        desktop: () => import('../features/family/finance').then(m => m.FamilyFinance),
        mobile: () => import('../features/family-finance-mobile/family-finance-mobile.page').then(m => m.FamilyFinanceMobilePage),
      }),
    ].flat(),
  },

  // ---- Admin ----
  {
    id: 'settings', path: 'settings', title: 'Usage IQ · Settings', perm: PERM.settingsView,
    desktop: () => import('../features/settings/settings').then(m => m.Settings),
    mobile: () => import('../features/beta-settings/beta-settings.page').then(m => m.BetaSettingsPage),
    nav: { group: 'Admin', label: 'Settings', icon: 'settings' },
  },
  {
    id: 'users', path: 'users', title: 'Usage IQ · Users', perm: PERM.usersView,
    desktop: () => import('../features/users/users').then(m => m.Users),
    mobile: () => import('../features/users-mobile/users-mobile.page').then(m => m.UsersMobilePage),
    nav: { group: 'Admin', label: 'Users', icon: 'group' },
  },
  {
    id: 'admin-locations', path: 'admin/locations', title: 'Usage IQ · Locations', perm: PERM.locationViewAll,
    desktop: () => import('../features/location/admin-locations').then(m => m.AdminLocations),
    mobile: () => import('../features/admin-locations-mobile/admin-locations-mobile.page').then(m => m.AdminLocationsMobilePage),
    nav: { group: 'Admin', label: 'Locations', icon: 'location_on' },
  },
  {
    id: 'activity', path: 'activity', title: 'Usage IQ · Activity', perm: PERM.activityView,
    desktop: () => import('../features/logs/logs').then(m => m.Logs),
    mobile: () => import('../features/activity-mobile/activity-mobile.page').then(m => m.ActivityMobilePage),
    nav: { group: 'Admin', label: 'Activity', icon: 'receipt_long' },
  },
  {
    id: 'ai-usage', path: 'ai-usage', title: 'Usage IQ · AI usage', perm: PERM.aiUsageView,
    desktop: () => import('../features/ai-usage/ai-usage').then(m => m.AiUsage),
    mobile: () => import('../features/ai-usage-mobile/ai-usage-mobile.page').then(m => m.AiUsageMobilePage),
    nav: { group: 'Admin', label: 'AI usage', icon: 'smart_toy' },
  },

  // ---- No nav entry (account menu / deep pages), but real routes + home options ----
  {
    id: 'preferences', path: 'preferences', title: 'Usage IQ · Settings', authOnly: true,
    desktop: () => import('../features/preferences/preferences').then(m => m.Preferences),
    mobile: () => import('../features/preferences-mobile/preferences-mobile.page').then(m => m.PreferencesMobilePage),
  },
  {
    id: 'profile', path: 'profile', title: 'Usage IQ · Profile', authOnly: true,
    desktop: () => import('../features/profile/profile').then(m => m.Profile),
    mobile: () => import('../features/profile-mobile/profile-mobile.page').then(m => m.ProfileMobilePage),
  },
  {
    id: 'locations', path: 'locations', title: 'Usage IQ · My locations', perm: PERM.locationSelf,
    desktop: () => import('../features/location/my-locations').then(m => m.MyLocations),
    mobile: () => import('../features/locations-mobile/locations-mobile.page').then(m => m.LocationsMobilePage),
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
