import { Routes } from '@angular/router';
import { authGuard } from './core/auth.guard';
import { permissionGuard } from './core/permission.guard';
import { PERM } from './core/models';
import { PAGE_REGISTRY, toRoutes } from './core/page-registry';

/**
 * Public / bare routes (marketing + auth + share-target) — they render their OWN chrome (marketing nav, bare
 * shell) on every device, so they are NOT part of the platform-split page registry.
 */
const PUBLIC_ROUTES: Routes = [
  { path: 'login', loadComponent: () => import('./features/login/login').then(m => m.Login), title: 'Usage IQ · Sign in' },
  { path: 'features', loadComponent: () => import('./features/marketing/features-page').then(m => m.FeaturesPage), title: 'Usage IQ · Features' },
  { path: 'how-it-works', loadComponent: () => import('./features/marketing/how-it-works-page').then(m => m.HowItWorksPage), title: 'Usage IQ · How it works' },
  { path: 'technology', loadComponent: () => import('./features/marketing/technology-page').then(m => m.TechnologyPage), title: 'Usage IQ · Technology' },
  { path: 'ai', loadComponent: () => import('./features/marketing/ai-page').then(m => m.AiPage), title: 'Usage IQ · AI' },
  { path: 'signin', loadComponent: () => import('./features/signin/signin').then(m => m.SignIn), title: 'Usage IQ - Sign in' },
  { path: 'about', loadComponent: () => import('./features/about/about').then(m => m.About), title: 'Usage IQ - About' },
  { path: 'welcome', canActivate: [authGuard], loadComponent: () => import('./features/welcome/welcome').then(m => m.Welcome), title: 'Usage IQ · Welcome' },
];

/**
 * The Beta/mobile-preview tree (`/tracker-beta` + `/beta/*`) — these are the explicit "mobile preview on any
 * device" URLs and the source of the mobile twins. They carry NO `canMatch` (they resolve on any device) and
 * are gated by `platform.mobile` inside each lazy children file. The more-specific `beta/x` entries precede the
 * `beta` hub (Angular is first-match). Once a canonical page renders the same component per-device (Wave 1+),
 * these can become redirects to the canonical path.
 */
const BETA_ROUTES: Routes = [
  { path: 'tracker-beta', loadChildren: () => import('./features/tracker-beta/tracker-beta.routes').then(m => m.TRACKER_BETA_ROUTES) },
  { path: 'beta/bills', loadChildren: () => import('./features/bills-beta/bills-beta.routes').then(m => m.BILLS_BETA_ROUTES) },
  { path: 'beta/home', loadChildren: () => import('./features/beta/beta-home.routes').then(m => m.BETA_HOME_ROUTES) },
  { path: 'beta/dashboard', loadChildren: () => import('./features/dashboard-beta/dashboard-beta.routes').then(m => m.DASHBOARD_BETA_ROUTES) },
  { path: 'beta/family', loadChildren: () => import('./features/family-beta/family-beta.routes').then(m => m.FAMILY_BETA_ROUTES) },
  { path: 'beta/wrapped', loadChildren: () => import('./features/wrapped-beta/wrapped-beta.routes').then(m => m.WRAPPED_BETA_ROUTES) },
  { path: 'beta/settings', loadChildren: () => import('./features/beta-settings/beta-settings.routes').then(m => m.BETA_SETTINGS_ROUTES) },
  { path: 'beta/chat', loadChildren: () => import('./features/chat-beta/chat-beta.routes').then(m => m.CHAT_BETA_ROUTES) },
  { path: 'beta/ask', loadChildren: () => import('./features/ask-beta/ask-beta.routes').then(m => m.ASK_BETA_ROUTES) },
  { path: 'beta/meals', loadChildren: () => import('./features/meals-beta/meals-beta.routes').then(m => m.MEALS_BETA_ROUTES) },
  { path: 'beta/people', loadChildren: () => import('./features/people-beta/people-beta.routes').then(m => m.PEOPLE_BETA_ROUTES) },
  { path: 'beta/fleet', loadChildren: () => import('./features/fleet-beta/fleet-beta.routes').then(m => m.FLEET_BETA_ROUTES) },
  { path: 'beta/trophies', loadChildren: () => import('./features/trophies-beta/trophies-beta.routes').then(m => m.TROPHIES_BETA_ROUTES) },
  { path: 'beta/automations', loadChildren: () => import('./features/automations-beta/automations-beta.routes').then(m => m.AUTOMATIONS_BETA_ROUTES) },
  { path: 'beta', canActivate: [permissionGuard(PERM.platformMobile)], loadComponent: () => import('./features/beta/beta-hub.page').then(m => m.BetaHubPage), title: 'Usage IQ · Beta' },
];

/** Tail routes — the PWA widget + the public share-target / share / bill views (bare, mostly unauthenticated). */
const TAIL_ROUTES: Routes = [
  { path: 'widget/:source', canActivate: [authGuard], loadComponent: () => import('./features/widget/widget').then(m => m.Widget), title: 'Usage IQ · Widget' },
  { path: 'share', loadChildren: () => import('./features/share-target/share-target.routes').then(m => m.SHARE_TARGET_ROUTES) },
  { path: 'share/:token', loadComponent: () => import('./features/share/public-share').then(m => m.PublicShareView), title: 'Usage IQ · Shared view' },
  { path: 'bill/:token', loadComponent: () => import('./features/bills/public-bill').then(m => m.PublicBillView), title: 'Usage IQ · Bill' },
];

/**
 * The route table. The authenticated app pages come from the central {@link PAGE_REGISTRY} (via {@link toRoutes},
 * which emits a per-device mobile variant + a desktop fallback per page); the public/beta/tail routes stay
 * hand-written. The wildcard is LAST.
 */
export const routes: Routes = [
  ...PUBLIC_ROUTES,
  ...toRoutes(PAGE_REGISTRY),
  ...BETA_ROUTES,
  ...TAIL_ROUTES,
  { path: '**', redirectTo: '' },
];
