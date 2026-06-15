import { Routes } from '@angular/router';
import { authGuard } from './core/auth.guard';
import { permissionGuard } from './core/permission.guard';
import { PERM } from './core/models';

export const routes: Routes = [
  {
    path: 'login',
    loadComponent: () => import('./features/login/login').then(m => m.Login),
    title: 'Usage IQ · Sign in',
  },
  {
    path: '',
    canActivate: [authGuard],
    loadComponent: () => import('./features/dashboard/dashboard').then(m => m.Dashboard),
    title: 'Usage IQ · Dashboard',
  },
  {
    path: 'calendar',
    canActivate: [authGuard],
    loadComponent: () => import('./features/calendar/calendar').then(m => m.Calendar),
    title: 'Usage IQ · Calendar',
  },
  {
    path: 'pricing',
    canActivate: [authGuard],
    loadComponent: () => import('./features/pricing/pricing').then(m => m.Pricing),
    title: 'Usage IQ · Pricing',
  },
  {
    path: 'settings',
    canActivate: [authGuard],
    loadComponent: () => import('./features/settings/settings').then(m => m.Settings),
    title: 'Usage IQ · Settings',
  },
  {
    path: 'reporter',
    canActivate: [permissionGuard(PERM.settingsManage)],
    loadComponent: () => import('./features/reporter/reporter').then(m => m.ReporterPage),
    title: 'Usage IQ · Reporter',
  },
  {
    path: 'users',
    canActivate: [permissionGuard(PERM.usersManage)],
    loadComponent: () => import('./features/users/users').then(m => m.Users),
    title: 'Usage IQ · Users',
  },
  {
    path: 'activity',
    canActivate: [permissionGuard(PERM.usersManage)],
    loadComponent: () => import('./features/logs/logs').then(m => m.Logs),
    title: 'Usage IQ · Activity',
  },
  {
    path: 'widget/:source',
    canActivate: [authGuard],
    loadComponent: () => import('./features/widget/widget').then(m => m.Widget),
    title: 'Usage IQ · Widget',
  },
  {
    // Public, unauthenticated, time-limited shared view — intentionally no guard.
    path: 'share/:token',
    loadComponent: () => import('./features/share/public-share').then(m => m.PublicShareView),
    title: 'Usage IQ · Shared view',
  },
  { path: '**', redirectTo: '' },
];
