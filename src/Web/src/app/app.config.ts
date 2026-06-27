import { ApplicationConfig, isDevMode, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withRouterConfig } from '@angular/router';
import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import { provideAnimations } from '@angular/platform-browser/animations';
import { provideServiceWorker } from '@angular/service-worker';

import { routes } from './app.routes';
import { authInterceptor } from './core/auth.interceptor';
import { offlineInterceptor } from './core/offline.interceptor';
import { OFFLINE_DISABLED_KEY } from './core/sw-update';

/**
 * Whether the installable/offline service worker should register. ON in prod builds, OFF in dev (so the
 * SW never interferes with HMR / live reload). Also honours the user's explicit opt-out: the /preferences
 * "Disable offline mode" toggle sets {@link OFFLINE_DISABLED_KEY}, and we skip registration while it's set
 * so a support-disabled client stays disabled across reloads (until they turn it back on).
 */
function swEnabled(): boolean {
  if (isDevMode()) return false;
  try {
    return localStorage.getItem(OFFLINE_DISABLED_KEY) !== 'true';
  } catch {
    return true; // localStorage unavailable (private mode etc.) — default to enabled in prod.
  }
}

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // `onSameUrlNavigation: 'reload'` lets the desktop/mobile override re-render the CURRENT url (the platform
    // `canMatch` re-evaluates and swaps in the other variant). Scroll restoration is deliberately left at the
    // default so desktop navigation behavior is unchanged.
    provideRouter(routes, withRouterConfig({ onSameUrlNavigation: 'reload' })),
    provideHttpClient(withFetch(), withInterceptors([authInterceptor, offlineInterceptor])),
    provideAnimations(),
    // Register our custom worker (it importScripts ngsw-worker.js) so push notifications render from the
    // backend's flat { title, body, url } payload. Prod-only; honours the user's offline opt-out.
    provideServiceWorker('sw-custom.js', {
      enabled: swEnabled(),
      registrationStrategy: 'registerWhenStable:30000',
    }),
  ],
};
