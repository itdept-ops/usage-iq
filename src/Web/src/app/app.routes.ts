import { Routes } from '@angular/router';
import { authGuard } from './core/auth.guard';
import { permissionGuard, anyPermissionGuard } from './core/permission.guard';
import { PERM } from './core/models';

export const routes: Routes = [
  {
    path: 'login',
    loadComponent: () => import('./features/login/login').then(m => m.Login),
    title: 'Usage IQ · Sign in',
  },
  {
    // Public marketing pages — no guard, render bare (own nav + footer).
    path: 'features',
    loadComponent: () => import('./features/marketing/features-page').then(m => m.FeaturesPage),
    title: 'Usage IQ · Features',
  },
  {
    path: 'how-it-works',
    loadComponent: () => import('./features/marketing/how-it-works-page').then(m => m.HowItWorksPage),
    title: 'Usage IQ · How it works',
  },
  {
    path: 'technology',
    loadComponent: () => import('./features/marketing/technology-page').then(m => m.TechnologyPage),
    title: 'Usage IQ · Technology',
  },
  {
    path: 'ai',
    loadComponent: () => import('./features/marketing/ai-page').then(m => m.AiPage),
    title: 'Usage IQ · AI',
  },
  {
    path: 'signin',
    loadComponent: () => import('./features/signin/signin').then(m => m.SignIn),
    title: 'Usage IQ - Sign in',
  },
  {
    path: 'about',
    loadComponent: () => import('./features/about/about').then(m => m.About),
    title: 'Usage IQ - About',
  },
  {
    // Authenticated landing for users awaiting access (no page-view permissions yet).
    path: 'welcome',
    canActivate: [authGuard],
    loadComponent: () => import('./features/welcome/welcome').then(m => m.Welcome),
    title: 'Usage IQ · Welcome',
  },
  {
    path: '',
    canActivate: [permissionGuard(PERM.dashboardView)],
    loadComponent: () => import('./features/dashboard/dashboard').then(m => m.Dashboard),
    title: 'Usage IQ · Dashboard',
  },
  {
    path: 'calendar',
    canActivate: [permissionGuard(PERM.calendarView)],
    loadComponent: () => import('./features/calendar/calendar').then(m => m.Calendar),
    title: 'Usage IQ · Calendar',
  },
  {
    path: 'pricing',
    canActivate: [permissionGuard(PERM.pricingView)],
    loadComponent: () => import('./features/pricing/pricing').then(m => m.Pricing),
    title: 'Usage IQ · Pricing',
  },
  {
    path: 'settings',
    canActivate: [permissionGuard(PERM.settingsView)],
    loadComponent: () => import('./features/settings/settings').then(m => m.Settings),
    title: 'Usage IQ · Settings',
  },
  {
    path: 'reporter',
    canActivate: [anyPermissionGuard(PERM.reporterView, PERM.reporterManage, PERM.reporterSelf)],
    loadComponent: () => import('./features/reporter/reporter').then(m => m.ReporterPage),
    title: 'Usage IQ · Reporter',
  },
  {
    path: 'fleet',
    canActivate: [anyPermissionGuard(PERM.fleetView, PERM.reporterManage)],
    loadComponent: () => import('./features/fleet/fleet').then(m => m.Fleet),
    title: 'Usage IQ · Fleet',
  },
  {
    path: 'chat',
    canActivate: [permissionGuard(PERM.chatRead)],
    loadComponent: () => import('./features/chat/chat').then(m => m.Chat),
    title: 'Usage IQ · Chat',
  },
  {
    path: 'tracker',
    canActivate: [permissionGuard(PERM.trackerSelf)],
    loadComponent: () => import('./features/tracker/tracker').then(m => m.Tracker),
    title: 'Usage IQ · Tracker',
  },
  {
    // Bill Splitter — its own permission-gated page. Owner-scoped CRUD + AI receipt breakdown + a public
    // anonymous claim link (the bare /bill/:token route below).
    path: 'bills',
    canActivate: [permissionGuard(PERM.billsUse)],
    loadComponent: () => import('./features/bills/bills').then(m => m.Bills),
    title: 'Usage IQ · Bill Splitter',
  },
  {
    // 75 Hard — a six-task daily challenge layered on the tracker. Gated by the SAME tracker permission
    // (tracker.self); a coach/admin read of someone else is enforced server-side via tracker.viewall.
    path: 'challenge',
    canActivate: [permissionGuard(PERM.trackerSelf)],
    loadComponent: () => import('./features/challenge/challenge').then(m => m.Challenge),
    title: 'Usage IQ · 75 Hard',
  },
  {
    // Family Hub — a warm, household-private section. The whole group is gated by family.use; the
    // owner-only controls inside (rename, add/remove member) are enforced server-side too.
    path: 'family',
    canActivate: [permissionGuard(PERM.familyUse)],
    children: [
      {
        path: '',
        loadComponent: () => import('./features/family/family-home').then(m => m.FamilyHome),
        title: 'Usage IQ · Family',
      },
      {
        path: 'household',
        loadComponent: () => import('./features/family/household').then(m => m.HouseholdSettings),
        title: 'Usage IQ · Household',
      },
      {
        path: 'settings',
        loadComponent: () => import('./features/family/family-settings').then(m => m.FamilySettingsPanel),
        title: 'Usage IQ · Family Settings',
      },
      {
        path: 'notes',
        loadComponent: () => import('./features/family/notes').then(m => m.FamilyNotes),
        title: 'Usage IQ · Family Notes',
      },
      {
        path: 'lists',
        loadComponent: () => import('./features/family/lists').then(m => m.FamilyLists),
        title: 'Usage IQ · Family Lists',
      },
      {
        path: 'reminders',
        loadComponent: () => import('./features/family/reminders').then(m => m.FamilyReminders),
        title: 'Usage IQ · Family Reminders',
      },
      {
        path: 'timer',
        loadComponent: () => import('./features/family/timer').then(m => m.FamilyTimerWidget),
        title: 'Usage IQ · Family Timer',
      },
      {
        path: 'meals',
        loadComponent: () => import('./features/family/meals').then(m => m.FamilyMeals),
        title: 'Usage IQ · Meal Planner',
      },
      {
        path: 'chores',
        loadComponent: () => import('./features/family/chores').then(m => m.FamilyChores),
        title: 'Usage IQ · Chores',
      },
      {
        // Allowance manager — PARENT-only: gated by allowance.manage ON TOP OF the group's family.use. Every
        // /api/family/allowance write is gated by allowance.manage server-side too; a child uses the kid-safe
        // chores view (with their own balance), never this page.
        path: 'allowance',
        canActivate: [permissionGuard(PERM.allowanceManage)],
        loadComponent: () => import('./features/family/allowance').then(m => m.FamilyAllowance),
        title: 'Usage IQ · Allowance',
      },
      {
        path: 'calendar',
        loadComponent: () => import('./features/family/calendar').then(m => m.FamilyCalendar),
        title: 'Usage IQ · Family Calendar',
      },
      {
        path: 'polls',
        loadComponent: () => import('./features/family/polls').then(m => m.FamilyPolls),
        title: 'Usage IQ · Family Polls',
      },
      {
        // "Where is everyone" — the family-finder map (opted-in members' pins). Inherits the group's
        // family.use guard; the server only ever resolves the caller's own household.
        path: 'locations',
        loadComponent: () => import('./features/family/family-locations').then(m => m.FamilyLocations),
        title: 'Usage IQ · Where is everyone',
      },
      {
        // Cycle — PRIVATE health data: gated by cycle.track ON TOP OF the group's family.use. Every
        // /api/family/cycle route is gated by cycle.track server-side; owner-scoped (you only ever see
        // your own entries). The family-calendar overlay is a separate opt-in (predicted phases only).
        path: 'cycle',
        canActivate: [permissionGuard(PERM.cycleTrack)],
        loadComponent: () => import('./features/family/cycle').then(m => m.FamilyCycle),
        title: 'Usage IQ · Cycle',
      },
      {
        // Identity Map — PRIVATE, owner-scoped: gated by identity.map ON TOP OF the group's family.use. Every
        // /api/family/identity route is gated by identity.map server-side too; you only ever see your OWN
        // roles/time/rules. Manual time logging always works; the calendar import is an optional enhancement.
        path: 'identity',
        canActivate: [permissionGuard(PERM.identityMap)],
        loadComponent: () => import('./features/family/identity-map').then(m => m.FamilyIdentityMap),
        title: 'Usage IQ · Identity Map',
      },
      {
        // Finance — extra-sensitive: gated by family.finance ON TOP OF the group's family.use. Every
        // /api/family/finance route is double-gated server-side too (family.use AND family.finance).
        path: 'finance',
        canActivate: [permissionGuard(PERM.familyFinance)],
        loadComponent: () => import('./features/family/finance').then(m => m.FamilyFinance),
        title: 'Usage IQ · Family Finances',
      },
    ],
  },
  {
    // My locations — the caller's OWN history map (PRIVATE to them). Capture is opt-in (Settings).
    path: 'locations',
    canActivate: [permissionGuard(PERM.locationSelf)],
    loadComponent: () => import('./features/location/my-locations').then(m => m.MyLocations),
    title: 'Usage IQ · My locations',
  },
  {
    path: 'users',
    canActivate: [permissionGuard(PERM.usersView)],
    loadComponent: () => import('./features/users/users').then(m => m.Users),
    title: 'Usage IQ · Users',
  },
  {
    // Admin Locations map — admin oversight of everyone's location (gated location.view-all). In the
    // Admin nav group; also linked from the user detail row (?user=<id> preselects that user's history).
    path: 'admin/locations',
    canActivate: [permissionGuard(PERM.locationViewAll)],
    loadComponent: () => import('./features/location/admin-locations').then(m => m.AdminLocations),
    title: 'Usage IQ · Locations',
  },
  {
    path: 'activity',
    canActivate: [permissionGuard(PERM.activityView)],
    loadComponent: () => import('./features/logs/logs').then(m => m.Logs),
    title: 'Usage IQ · Activity',
  },
  {
    path: 'ai-usage',
    canActivate: [permissionGuard(PERM.aiUsageView)],
    loadComponent: () => import('./features/ai-usage/ai-usage').then(m => m.AiUsage),
    title: 'Usage IQ · AI usage',
  },
  {
    path: 'widget/:source',
    canActivate: [authGuard],
    loadComponent: () => import('./features/widget/widget').then(m => m.Widget),
    title: 'Usage IQ · Widget',
  },
  {
    // Public, unauthenticated, time-limited shared view — intentionally no guard.
    path: 'share/:token',
    loadComponent: () => import('./features/share/public-share').then(m => m.PublicShareView),
    title: 'Usage IQ · Shared view',
  },
  {
    // Public, anonymous bill-claim view — intentionally no guard, bare shell (like /share/:token).
    path: 'bill/:token',
    loadComponent: () => import('./features/bills/public-bill').then(m => m.PublicBillView),
    title: 'Usage IQ · Bill',
  },
  { path: '**', redirectTo: '' },
];
