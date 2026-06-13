import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./features/dashboard/dashboard').then(m => m.Dashboard),
    title: 'ccusage · Dashboard',
  },
  {
    path: 'pricing',
    loadComponent: () => import('./features/pricing/pricing').then(m => m.Pricing),
    title: 'ccusage · Pricing',
  },
  {
    path: 'settings',
    loadComponent: () => import('./features/settings/settings').then(m => m.Settings),
    title: 'ccusage · Settings',
  },
  { path: '**', redirectTo: '' },
];
