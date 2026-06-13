import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./features/dashboard/dashboard').then(m => m.Dashboard),
    title: 'Usage IQ · Dashboard',
  },
  {
    path: 'pricing',
    loadComponent: () => import('./features/pricing/pricing').then(m => m.Pricing),
    title: 'Usage IQ · Pricing',
  },
  {
    path: 'settings',
    loadComponent: () => import('./features/settings/settings').then(m => m.Settings),
    title: 'Usage IQ · Settings',
  },
  { path: '**', redirectTo: '' },
];
