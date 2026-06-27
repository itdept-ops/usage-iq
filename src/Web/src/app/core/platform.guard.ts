import { inject } from '@angular/core';
import { CanMatchFn } from '@angular/router';

import { AuthService } from './auth';
import { PERM } from './models';
import { PlatformService } from './platform';

/**
 * The `canMatch` guard that selects a page's MOBILE route variant. Placed on the mobile route entry (ordered
 * BEFORE the desktop entry sharing the same path): when it returns false the router skips that entry and falls
 * through to the desktop one — which is exactly the "no mobile twin / not on mobile / no grant → responsive
 * desktop" fallback, for free.
 *
 * ROLLOUT gate ({@link isMobileGated}): mobile AND holds `platform.mobile`. During the build the mobile app is
 * opt-in (off by default), so a phone without the grant transparently gets the responsive desktop page.
 *
 * GRADUATION gate ({@link isMobilePlatform}): mobile only — swap the registry to this to open the mobile app to
 * every mobile user (dropping the `platform.mobile` requirement), per-page or globally.
 */
export const isMobileGated: CanMatchFn = () =>
  inject(PlatformService).isMobile() && inject(AuthService).hasPermission(PERM.platformMobile);

/** Graduation gate: matches on mobile regardless of the `platform.mobile` grant. Not wired yet (see above). */
export const isMobilePlatform: CanMatchFn = () => inject(PlatformService).isMobile();
