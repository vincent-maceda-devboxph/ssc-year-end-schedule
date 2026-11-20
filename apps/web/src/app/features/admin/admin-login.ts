import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { errorMessage } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';

@Component({
  selector: 'bt-admin-login',
  imports: [FormsModule, MatButtonModule, MatFormFieldModule, MatInputModule],
  template: `
    <div class="page narrow">
      <h1>Admin sign in</h1>
      <form class="panel form" (ngSubmit)="submit()">
        <mat-form-field appearance="outline">
          <mat-label>Username</mat-label>
          <input matInput [(ngModel)]="username" name="username" autocomplete="username" required />
        </mat-form-field>
        <mat-form-field appearance="outline">
          <mat-label>Password</mat-label>
          <input matInput type="password" [(ngModel)]="password" name="password" autocomplete="current-password" required />
        </mat-form-field>
        @if (error()) { <p class="error-text">{{ error() }}</p> }
        <button mat-flat-button type="submit" [disabled]="busy()">Sign in</button>
      </form>
    </div>
  `,
  styles: `.narrow { max-width: 420px; } h1 { font-weight: 700; } .form { display: flex; flex-direction: column; gap: 4px; }`,
})
export class AdminLogin {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  username = '';
  password = '';
  readonly error = signal('');
  readonly busy = signal(false);

  async submit() {
    this.busy.set(true);
    this.error.set('');
    try {
      await this.auth.loginAdmin(this.username, this.password);
      const next = this.route.snapshot.queryParamMap.get('next');
      await this.router.navigateByUrl(next?.startsWith('/admin') ? next : '/admin');
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
}
