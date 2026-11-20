import { Routes } from '@angular/router';
import { adminGuard } from './core/guards';

export const routes: Routes = [
  { path: '', loadComponent: () => import('./features/home/home').then((m) => m.Home), title: 'Badminton Tournament' },

  { path: 'help', loadComponent: () => import('./features/help/help').then((m) => m.Help), title: 'How to use' },

  // Spectators (read-only)
  { path: 'live', loadComponent: () => import('./features/live/live-list').then((m) => m.LiveList), title: 'Live' },
  { path: 'live/:tournamentId', loadComponent: () => import('./features/live/live-view').then((m) => m.LiveView), title: 'Live scores' },
  { path: 'board/:tournamentId', loadComponent: () => import('./features/scoreboard/scoreboard').then((m) => m.Scoreboard), title: 'Scoreboard' },

  // Umpires
  { path: 'umpire', loadComponent: () => import('./features/umpire/umpire').then((m) => m.Umpire), title: 'Umpire' },

  // Admin
  { path: 'admin/login', loadComponent: () => import('./features/admin/admin-login').then((m) => m.AdminLogin), title: 'Admin sign in' },
  {
    path: 'admin',
    canActivate: [adminGuard],
    loadComponent: () => import('./features/admin/admin-shell').then((m) => m.AdminShell),
    children: [
      { path: '', loadComponent: () => import('./features/tournaments/tournament-list').then((m) => m.TournamentList), title: 'Tournaments' },
      { path: 'users', loadComponent: () => import('./features/users/users-page').then((m) => m.UsersPage), title: 'Admin accounts' },
      { path: 'system', loadComponent: () => import('./features/system/system-page').then((m) => m.SystemPage), title: 'System' },
      { path: 't/:tournamentId', loadComponent: () => import('./features/tournaments/tournament-detail').then((m) => m.TournamentDetail), title: 'Tournament' },
    ],
  },
  { path: '**', redirectTo: '' },
];
