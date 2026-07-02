import { Routes } from '@angular/router';
import { authGuard } from './core/auth.guard';
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
  { path: 'inside', loadComponent: () => import('./features/marketing/inside-page').then(m => m.InsidePage), title: 'Usage IQ · Inside the OS' },
  { path: 'signin', loadComponent: () => import('./features/signin/signin').then(m => m.SignIn), title: 'Usage IQ · Sign in' },
  { path: 'intro', loadComponent: () => import('./features/intro/intro.page').then(m => m.IntroPage), title: 'Usage IQ · Welcome' },
  { path: 'about', loadComponent: () => import('./features/about/about').then(m => m.About), title: 'Usage IQ · About' },
  { path: 'help', loadComponent: () => import('./features/help/help.page').then(m => m.HelpPage), title: 'Usage IQ · Help' },
  { path: 'welcome', canActivate: [authGuard], loadComponent: () => import('./features/welcome/welcome').then(m => m.Welcome), title: 'Usage IQ · Welcome' },
];

/**
 * The Beta/mobile-preview tree (`/tracker-beta` + `/beta/*`) — the legacy "mobile preview on any device" URLs
 * that were the original source of the mobile twins. Every one of these components has since graduated to a
 * first-class registry page that renders it per-device (the `mobile` twin in {@link PAGE_REGISTRY}), so these
 * paths are now REDIRECT-ONLY to their canonical page — collapsing the former dual-mount. This keeps the
 * bottom-tab nav-highlight, the back-stack, and shared/bookmarked links on the single canonical path, and
 * removes the hand-sync burden of re-declaring the `platform.mobile` gate here (the canonical mobile twin
 * carries its own `canMatch`+gate). The redirect targets mirror `HOME_ALIASES` in `nav-model.ts`. The
 * more-specific `beta/x` entries precede the `beta` hub (Angular is first-match).
 */
const BETA_ROUTES: Routes = [
  { path: 'tracker-beta', redirectTo: 'tracker', pathMatch: 'full' },
  { path: 'beta/bills', redirectTo: 'bills', pathMatch: 'full' },
  { path: 'beta/home', redirectTo: '', pathMatch: 'full' },
  { path: 'beta/dashboard', redirectTo: '', pathMatch: 'full' },
  { path: 'beta/family', redirectTo: 'family', pathMatch: 'full' },
  { path: 'beta/wrapped', redirectTo: 'wrapped', pathMatch: 'full' },
  { path: 'beta/settings', redirectTo: 'settings', pathMatch: 'full' },
  { path: 'beta/chat', redirectTo: 'chat', pathMatch: 'full' },
  { path: 'beta/ask', redirectTo: 'ask', pathMatch: 'full' },
  { path: 'beta/meals', redirectTo: 'meal-planner', pathMatch: 'full' },
  { path: 'beta/people', redirectTo: 'people', pathMatch: 'full' },
  { path: 'beta/fleet', redirectTo: 'fleet', pathMatch: 'full' },
  { path: 'beta/trophies', redirectTo: 'trophies', pathMatch: 'full' },
  { path: 'beta/automations', redirectTo: 'automations', pathMatch: 'full' },
  { path: 'beta', redirectTo: '', pathMatch: 'full' },
];

/** Tail routes — the PWA widget + the public share-target / share / bill views (bare, mostly unauthenticated). */
const TAIL_ROUTES: Routes = [
  { path: 'widget/:source', canActivate: [authGuard], loadComponent: () => import('./features/widget/widget').then(m => m.Widget), title: 'Usage IQ · Widget' },
  { path: 'share', loadChildren: () => import('./features/share-target/share-target.routes').then(m => m.SHARE_TARGET_ROUTES) },
  { path: 'share/:token', loadComponent: () => import('./features/share/public-share').then(m => m.PublicShareView), title: 'Usage IQ · Shared view' },
  { path: 'w/:token', loadComponent: () => import('./features/wrapped/public-wrapped.page').then(m => m.PublicWrappedView), title: 'Usage IQ · Wrapped' },
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
