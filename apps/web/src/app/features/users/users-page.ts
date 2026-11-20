import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import type { AdminUserDto, Role } from '@bt/shared';
import { Api, errorMessage } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';

/** Admin accounts (Super Administrator) and the signed-in admin's own password. */
@Component({
  selector: 'bt-users-page',
  imports: [FormsModule, RouterLink, MatButtonModule, MatFormFieldModule, MatIconModule, MatInputModule, MatSelectModule],
  template: `
    <div class="page">
      <a routerLink="/admin" class="muted small">← Tournaments</a>
      <h1>Admin accounts</h1>
      @if (error()) { <p class="error-text" role="alert">{{ error() }}</p> }
      @if (notice()) { <p class="notice">{{ notice() }}</p> }

      <section class="panel">
        <h3>Accounts</h3>
        <p class="muted small">
          <strong>Super Administrator</strong> can do everything, including accounts, backups and restore.
          <strong>Tournament Administrator</strong> runs tournaments but cannot manage accounts, restore backups or delete a tournament.
          Accounts are switched off, never deleted, so the audit log keeps their names.
        </p>
        <table class="simple">
          <thead><tr><th>Username</th><th>Role</th><th>Status</th><th></th></tr></thead>
          <tbody>
            @for (u of users(); track u.id) {
              <tr [class.off]="!u.active">
                <td><strong>{{ u.username }}</strong>@if (u.id === auth.admin()?.id) { <span class="muted small"> (you)</span> }</td>
                <td>
                  <mat-select class="role" [value]="u.role" (selectionChange)="update(u, { role: $event.value })" [attr.aria-label]="'Role of ' + u.username">
                    <mat-option value="tournament_admin">Tournament Administrator</mat-option>
                    <mat-option value="super_admin">Super Administrator</mat-option>
                  </mat-select>
                </td>
                <td><span class="chip" [class.live]="u.active">{{ u.active ? 'active' : 'switched off' }}</span></td>
                <td class="acts">
                  <button mat-button (click)="resetFor.set(resetFor() === u.id ? '' : u.id); resetPassword = ''">Reset password</button>
                  <button mat-button (click)="update(u, { active: !u.active })" [disabled]="u.id === auth.admin()?.id">{{ u.active ? 'Switch off' : 'Switch on' }}</button>
                </td>
              </tr>
              @if (resetFor() === u.id) {
                <tr><td colspan="4" class="reset">
                  <mat-form-field appearance="outline"><mat-label>New password for {{ u.username }}</mat-label>
                    <input matInput type="password" [(ngModel)]="resetPassword" name="reset" autocomplete="new-password" /><mat-hint>At least 8 characters. They are signed out everywhere.</mat-hint></mat-form-field>
                  <button mat-flat-button (click)="update(u, { password: resetPassword })" [disabled]="resetPassword.length < 8">Set password</button>
                </td></tr>
              }
            }
          </tbody>
        </table>
      </section>

      <section class="panel">
        <h3>New account</h3>
        <form class="row" (ngSubmit)="create()">
          <mat-form-field appearance="outline"><mat-label>Username</mat-label>
            <input matInput [(ngModel)]="form.username" name="username" autocomplete="off" required /></mat-form-field>
          <mat-form-field appearance="outline"><mat-label>Password</mat-label>
            <input matInput type="password" [(ngModel)]="form.password" name="password" autocomplete="new-password" required /></mat-form-field>
          <mat-form-field appearance="outline"><mat-label>Role</mat-label>
            <mat-select [(ngModel)]="form.role" name="role">
              <mat-option value="tournament_admin">Tournament Administrator</mat-option>
              <mat-option value="super_admin">Super Administrator</mat-option>
            </mat-select></mat-form-field>
          <button mat-flat-button type="submit" [disabled]="busy()">Create account</button>
        </form>
      </section>

      <section class="panel">
        <h3>My password</h3>
        <form class="row" (ngSubmit)="changeMine()">
          <mat-form-field appearance="outline"><mat-label>Current password</mat-label>
            <input matInput type="password" [(ngModel)]="mine.current" name="current" autocomplete="current-password" required /></mat-form-field>
          <mat-form-field appearance="outline"><mat-label>New password</mat-label>
            <input matInput type="password" [(ngModel)]="mine.next" name="next" autocomplete="new-password" required /></mat-form-field>
          <button mat-flat-button type="submit" [disabled]="busy() || mine.next.length < 8">Change my password</button>
        </form>
      </section>
    </div>
  `,
  styles: `
    h1 { font-weight: 500; } h3 { margin: 0 0 8px; font-weight: 500; }
    .page { display: flex; flex-direction: column; gap: 16px; }
    .notice { background: #e8f5e9; padding: 8px 12px; border-radius: 8px; margin: 0; }
    .role { min-width: 220px; background: #fff; border: 1px solid var(--bt-border); border-radius: 8px; padding: 6px 10px; }
    .acts { white-space: nowrap; text-align: right; }
    tr.off td { opacity: .6; }
    .reset { background: #fafafa; }
    .reset mat-form-field { margin-right: 12px; }
  `,
})
export class UsersPage implements OnInit {
  private readonly api = inject(Api);
  readonly auth = inject(AuthService);
  readonly users = signal<AdminUserDto[]>([]);
  readonly error = signal('');
  readonly notice = signal('');
  readonly busy = signal(false);
  readonly resetFor = signal('');
  resetPassword = '';
  form: { username: string; password: string; role: Role } = { username: '', password: '', role: 'tournament_admin' };
  mine = { current: '', next: '' };

  ngOnInit() {
    void this.load();
  }

  private async run(fn: () => Promise<unknown>) {
    this.error.set('');
    this.notice.set('');
    this.busy.set(true);
    try {
      await fn();
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  async load() {
    await this.run(async () => this.users.set(await this.api.get<AdminUserDto[]>('/users')));
  }

  create() {
    return this.run(async () => {
      await this.api.post('/users', this.form);
      this.notice.set(`Account "${this.form.username.toLowerCase()}" created.`);
      this.form = { username: '', password: '', role: 'tournament_admin' };
      this.users.set(await this.api.get<AdminUserDto[]>('/users'));
    });
  }

  update(u: AdminUserDto, patch: { role?: Role; active?: boolean; password?: string }) {
    return this.run(async () => {
      await this.api.put(`/users/${u.id}`, patch);
      if (patch.password) {
        this.notice.set(`Password for ${u.username} changed. They are signed out everywhere.`);
        this.resetFor.set('');
        this.resetPassword = '';
      }
      this.users.set(await this.api.get<AdminUserDto[]>('/users'));
      await this.auth.load(true); // my own role may have changed
    });
  }

  changeMine() {
    return this.run(async () => {
      await this.api.post('/auth/password', this.mine);
      this.mine = { current: '', next: '' };
      this.notice.set('Your password was changed. Other devices signed in as you were signed out.');
    });
  }
}
