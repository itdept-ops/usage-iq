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
    ],
  },
  {
    path: 'users',
    canActivate: [permissionGuard(PERM.usersView)],
    loadComponent: () => import('./features/users/users').then(m => m.Users),
    title: 'Usage IQ · Users',
  },
  {
    path: 'activity',
    canActivate: [permissionGuard(PERM.activityView)],
    loadComponent: () => import('./features/logs/logs').then(m => m.Logs),
    title: 'Usage IQ · Activity',
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
  { path: '**', redirectTo: '' },
];
