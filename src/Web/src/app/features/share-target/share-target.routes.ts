import { Routes } from '@angular/router';

/**
 * The `/share` route — the PWA Web Share TARGET landing (GET). Intentionally guard-free at the route level:
 * the {@link ShareTargetPage} does its OWN auth/permission checks on init and immediately redirects (it
 * renders nothing), so an unauthenticated/unprivileged share never stalls. Lazy so it stays out of the
 * initial bundle (it only loads when the OS share sheet routes into the installed app).
 */
export const SHARE_TARGET_ROUTES: Routes = [
  {
    path: '',
    loadComponent: () => import('./share-target.page').then((m) => m.ShareTargetPage),
    title: 'Usage IQ · Share',
  },
];
