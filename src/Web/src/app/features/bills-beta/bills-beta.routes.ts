import { Routes } from '@angular/router';

import { permissionGuard } from '../../core/permission.guard';
import { PERM } from '../../core/models';

/**
 * Bills Beta — the mobile-first "Tally" split-the-check experience, rebuilt on the shared beta-ui kit.
 * Lazy `loadComponent` so the page (and the kit primitives it consumes) stay out of the initial bundle.
 * Guarded by BOTH `beta.access` (the Beta section) AND `bills.use` (the feature) — matching the live /bills
 * gate, so the beta twin is never less strict than the page it mirrors. This is purely additive — it reuses
 * the existing bills `Api` methods + DTOs and never touches the live /bills page.
 *
 * Wire-up (added to app.routes.ts): a top-level sibling route mirroring tracker-beta —
 *   { path: 'beta/bills', loadChildren: () => import('./features/bills-beta/bills-beta.routes').then(m => m.BILLS_BETA_ROUTES) }
 *
 * No route-level provider is needed: bills has no OptimisticTracker equivalent — the page owns its own
 * optimistic row patch/reconcile against `Api.bill(id)`.
 */
export const BILLS_BETA_ROUTES: Routes = [
  {
    path: '',
    canActivate: [permissionGuard(PERM.betaAccess), permissionGuard(PERM.billsUse)],
    loadComponent: () => import('./bills-beta.page').then(m => m.BillsBetaPage),
    title: 'Usage IQ · Bills Tally',
  },
];
