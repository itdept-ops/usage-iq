import { Routes } from '@angular/router';

import { permissionGuard } from '../../core/permission.guard';
import { PERM } from '../../core/models';
import { OptimisticFamily } from './state/optimistic-family';

/**
 * Family "Hearth" beta route — the NEW mobile-first glance surface that inverts the live family-home's
 * "13-tile nav grid first" into "glanceable today first, navigation last" for 390px. Lazy `loadComponent`
 * keeps the page and its cards out of the initial bundle.
 *
 * Guarded by BOTH `beta.access` (the Beta section) AND `family.use` (the feature) — both guards run and
 * either failing blocks, so a direct nav to `/beta/family` is never less strict than the live `/family`
 * page it mirrors. This is the "stack both, like /beta/bills" pattern.
 *
 * {@link OptimisticFamily} is provided HERE (route level, not root) so every card injects the SAME
 * instance for optimistic chore/list ticks. It injects only the root {@link Api} + MatSnackBar and copies
 * the bump-then-reconcile shape from tracker-beta's OptimisticTracker — it imports NO live-page internals.
 *
 * HARD ISOLATION: purely additive. It reuses the family `Api` methods + DTOs READ-mostly (today glance)
 * and the existing fast-action write endpoints (add list item / chore / quick-add); it never modifies any
 * live family page and defines its OWN `--*` Hearth-ember tokens on `:host` (never the global `--tech-*`).
 */
export const FAMILY_BETA_ROUTES: Routes = [
  {
    path: '',
    canActivate: [permissionGuard(PERM.betaAccess), permissionGuard(PERM.familyUse)],
    providers: [OptimisticFamily],
    loadComponent: () => import('./family-beta.page').then(m => m.FamilyBetaPage),
    title: 'Usage IQ · Family Hearth',
  },
];
