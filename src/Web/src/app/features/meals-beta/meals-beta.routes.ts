import { Routes } from '@angular/router';

import { permissionGuard } from '../../core/permission.guard';
import { PERM } from '../../core/models';

/**
 * Meals "Forage" beta route — the NEW mobile-first meal-planning + grocery surface that inverts the live
 * `/meal-planner`'s warm 7-day grid into a native-app "one day at a time, swipe the week" experience for
 * 390px. Lazy `loadComponent` keeps the page + its subcomponents out of the initial bundle.
 *
 * Guarded by BOTH `beta.access` (the Beta section) AND `meals.use` (the feature) — both guards run and
 * either failing blocks, so a direct nav to `/beta/meals` is never less strict than the live `/meal-planner`
 * page it mirrors. This is the "stack both, like /beta/family" pattern.
 *
 * HARD ISOLATION: purely additive. It reuses the household-scoped FamilyMeals endpoints + the grocery
 * (FamilyList) endpoints READ + the existing fast-action writes (create/patch/delete meal, meals-to-grocery,
 * toggle list item) and the AI plan/what-to-eat endpoints — it never modifies any live page and defines its
 * OWN Forage-green signature accent on `:host` (never the global `--tech-*` tokens). State lives entirely in
 * the page's own signals, so no route-level provider is needed beyond the page's own ToastController.
 */
export const MEALS_BETA_ROUTES: Routes = [
  {
    path: '',
    canActivate: [permissionGuard(PERM.betaAccess), permissionGuard(PERM.mealsUse)],
    loadComponent: () => import('./meals-beta.page').then(m => m.MealsBetaPage),
    title: 'Usage IQ · Meals Forage',
  },
];
