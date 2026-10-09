import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    title: 'Frames of Me — Le tue foto ti ritrovano',
    loadComponent: () => import('./pages/landing/landing').then((m) => m.Landing),
  },
  {
    path: 'accedi',
    title: 'Accedi — Frames of Me',
    loadComponent: () => import('./pages/accedi/accedi').then((m) => m.Accedi),
  },
  {
    path: 'staff',
    title: 'Area staff — Frames of Me',
    loadComponent: () => import('./pages/staff/staff').then((m) => m.Staff),
  },
  {
    path: 'app',
    title: 'La tua galleria — Frames of Me',
    loadComponent: () => import('./pages/app-home/app-home').then((m) => m.AppHome),
  },
  {
    path: 'admin',
    title: 'Gestionale — Frames of Me',
    loadComponent: () => import('./pages/admin/admin').then((m) => m.Admin),
  },
  { path: '**', redirectTo: '' },
];
