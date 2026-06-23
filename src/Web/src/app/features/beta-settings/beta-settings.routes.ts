import { Routes } from '@angular/router';

import { permissionGuard } from '../../core/permission.guard';
import { PERM } from '../../core/models';

/**
 * Settings (beta) — a mobile-first likeness of the live Settings hub's quick toggles over the SAME
 * per-user Api methods. Lazy `loadComponent` so it never lands in the initial bundle; guarded by the
 * `beta.access` permission (the Beta-section gate). ISOLATED: the page imports no live page.
 *
 * Wired from app.routes.ts as a `beta/settings` loadChildren route placed BEFORE the `/beta` hub route.
 */
export const BETA_SETTINGS_ROUTES: Routes = [
  {
    path: '',
    canActivate: [permissionGuard(PERM.betaAccess)],
    loadComponent: () => import('./beta-settings.page').then(m => m.BetaSettingsPage),
    title: 'Usage IQ · Settings (beta)',
  },
];
