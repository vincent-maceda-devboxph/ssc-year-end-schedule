import { Component, inject } from '@angular/core';
import { Router, RouterLink, RouterOutlet } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatToolbarModule } from '@angular/material/toolbar';
import { AuthService } from '../../core/auth.service';
import { ConnectionBadge } from '../../shared/components/connection-badge';

@Component({
  selector: 'bt-admin-shell',
  imports: [RouterOutlet, RouterLink, MatToolbarModule, MatButtonModule, MatIconModule, ConnectionBadge],
  template: `
    <mat-toolbar class="tb">
      <a routerLink="/admin" class="brand"><mat-icon>sports_tennis</mat-icon> Tournament Admin</a>
      <span class="grow"></span>
      <bt-connection />
      @if (auth.admin()?.role === 'super_admin') {
        <a routerLink="/admin/users" class="sys" title="Admin accounts"><mat-icon>group</mat-icon> Users</a>
      }
      <a routerLink="/admin/system" class="sys" title="Backups, data check, audit log"><mat-icon>settings</mat-icon> System</a>
      <a routerLink="/help" class="sys" title="How to use"><mat-icon>help_outline</mat-icon> Help</a>
      <span class="user small">{{ auth.admin()?.username }}</span>
      <button mat-icon-button (click)="logout()" aria-label="Sign out"><mat-icon>logout</mat-icon></button>
    </mat-toolbar>
    <router-outlet />
  `,
  styles: `
    .tb { background: linear-gradient(90deg, #0f766e, #0e7490 60%, #1d4ed8); color: #fff; position: sticky; top: 0; z-index: 10; gap: 14px; box-shadow: 0 2px 12px rgba(15,23,42,.18); }
    .brand { color: inherit; text-decoration: none; display: flex; align-items: center; gap: 8px; font-size: 18px; font-weight: 700; letter-spacing: -.01em; }
    .grow { flex: 1; }
    .user { opacity: .85; }
    .sys:hover { background: rgba(255,255,255,.16); }
    .sys { padding: 6px 10px; border-radius: 10px; color: inherit; text-decoration: none; display: inline-flex; align-items: center; gap: 4px; font-size: 14px; }
    bt-connection { --bt-ok: #c8e6c9; }
    @media (max-width: 600px) { .user { display: none; } }
  `,
})
export class AdminShell {
  readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  async logout() {
    await this.auth.logoutAdmin().catch(() => undefined);
    await this.router.navigateByUrl('/admin/login');
  }
}
