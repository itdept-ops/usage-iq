import { Routes } from '@angular/router';

import { permissionGuard } from '../../core/permission.guard';
import { PERM } from '../../core/models';

/**
 * ASK BETA — the new mobile-first "Ask my life" conversational AI surface. Lazy `loadComponent`
 * so the chat page stays out of the initial bundle. Guarded by BOTH `beta.access` (the beta gate,
 * same as every other beta surface) AND `tracker.ai` (the SAME permission the live `/ask` page +
 * its `POST /api/ai/ask` endpoint require) so a direct nav to `/beta/ask` is protected exactly like
 * the live page.
 *
 * Purely ADDITIVE: this surface re-uses the SAME `Api.askMyLife` endpoint + `AskResponse` DTO as the
 * live `/ask`, so it answers from the IDENTICAL grounded, caller-scoped snapshot. No new backend, no
 * live page imported or modified. State lives entirely in the page's own signals, so no route-level
 * provider is needed beyond the page-scoped ToastController declared on the component.
 */
export const ASK_BETA_ROUTES: Routes = [
  {
    path: '',
    canActivate: [permissionGuard(PERM.betaAccess), permissionGuard(PERM.trackerAi)],
    loadComponent: () => import('./ask-beta.page').then(m => m.AskBetaPage),
    title: 'Usage IQ · Ask my life',
  },
];
