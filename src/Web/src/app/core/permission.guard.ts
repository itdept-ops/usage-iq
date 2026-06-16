import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from './auth';

/**
 * Guard factory: requires authentication + a specific permission. Unauthenticated visitors go to
 * login; authenticated-but-unauthorized users are sent to '/welcome' (NOT '/', which would loop for
 * a user lacking dashboard.view).
 */
export function permissionGuard(permission: string): CanActivateFn {
  return (_route, state) => {
    const auth = inject(AuthService);
    const router = inject(Router);
    if (!auth.isAuthenticated()) {
      return router.createUrlTree(['/login'], { queryParams: { returnUrl: state.url } });
    }
    return auth.hasPermission(permission) ? true : router.createUrlTree(['/welcome']);
  };
}

/**
 * Guard factory: requires authentication + ANY of the given permissions (logical OR). Used for
 * pages reachable by more than one capability — e.g. Reporter (self-service OR full management) or
 * Fleet (dashboard OR reporter viewers). Same redirect rules as {@link permissionGuard}.
 */
export function anyPermissionGuard(...permissions: string[]): CanActivateFn {
  return (_route, state) => {
    const auth = inject(AuthService);
    const router = inject(Router);
    if (!auth.isAuthenticated()) {
      return router.createUrlTree(['/login'], { queryParams: { returnUrl: state.url } });
    }
    return auth.hasAnyPermission(...permissions) ? true : router.createUrlTree(['/welcome']);
  };
}
