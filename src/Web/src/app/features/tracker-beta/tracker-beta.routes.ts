import { Routes } from '@angular/router';

import { permissionGuard } from '../../core/permission.guard';
import { PERM } from '../../core/models';
import { OptimisticTracker } from './state/optimistic-tracker';

/**
 * Tracker Beta — the new mobile-first "Strata" experience. Lazy `loadComponent` so neither the page nor
 * its echarts (code-split via @defer inside the weight card) land in the initial bundle. Guarded by the
 * dedicated `tracker.beta` permission (code-only; no migration). The {@link OptimisticTracker} perf
 * wrapper is provided HERE at the route level so every child sheet/card injects the same instance
 * (it itself injects the root {@link TrackerStore}).
 *
 * Wire-up (the app.routes.ts agent adds): a top-level route
 *   { path: 'tracker-beta', loadChildren: () => import('./features/tracker-beta/tracker-beta.routes').then(m => m.TRACKER_BETA_ROUTES) }
 * — or equivalently a single loadComponent route guarded by permissionGuard(PERM.trackerBeta).
 */
export const TRACKER_BETA_ROUTES: Routes = [
  {
    path: '',
    canActivate: [permissionGuard(PERM.trackerBeta)],
    providers: [OptimisticTracker],
    loadComponent: () => import('./tracker-beta.page').then(m => m.TrackerBetaPage),
    title: 'Usage IQ · Tracker Beta',
  },
];
