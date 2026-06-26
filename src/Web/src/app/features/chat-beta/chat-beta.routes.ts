import { Routes } from '@angular/router';

import { permissionGuard } from '../../core/permission.guard';
import { PERM } from '../../core/models';

/**
 * Chat Beta — "Messenger", a NEW mobile-first iMessage-feel chat experience rebuilt on the shared
 * beta-ui "Strata" kit. Lazy `loadComponent` so the page (and the kit primitives it consumes) stay
 * out of the initial bundle. Guarded by BOTH `beta.access` (the Beta section) AND `chat.read` (the
 * feature) — matching the live /chat gate, so the beta twin is never less strict than the page it
 * mirrors. Purely additive: it reuses the existing chat `Api` methods + DTOs + the {@link ChatRealtime}
 * realtime service and never touches the live /chat page.
 *
 * Wire-up (added to app.routes.ts by the Wire phase): a top-level sibling route mirroring bills-beta —
 *   { path: 'beta/chat', loadChildren: () => import('./features/chat-beta/chat-beta.routes').then(m => m.CHAT_BETA_ROUTES) }
 */
export const CHAT_BETA_ROUTES: Routes = [
  {
    path: '',
    canActivate: [permissionGuard(PERM.betaAccess), permissionGuard(PERM.chatRead)],
    loadComponent: () => import('./chat-beta.page').then(m => m.ChatBetaPage),
    title: 'Usage IQ · Messenger',
  },
];
