import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import type { TournamentDto } from '@bt/shared';
import { Api, errorMessage } from '../../core/api.service';

@Component({
  selector: 'bt-tournament-list',
  imports: [FormsModule, RouterLink, MatButtonModule, MatCheckboxModule, MatFormFieldModule, MatInputModule],
  template: `
    <div class="page">
      <h1>Tournaments</h1>
      <form class="panel row" (ngSubmit)="create()">
        <mat-form-field appearance="outline" class="grow"><mat-label>Name</mat-label>
          <input matInput [(ngModel)]="form.name" name="name" required /></mat-form-field>
        <mat-form-field appearance="outline"><mat-label>Date</mat-label>
          <input matInput type="date" [(ngModel)]="form.date" name="date" /></mat-form-field>
        <mat-form-field appearance="outline"><mat-label>Venue</mat-label>
          <input matInput [(ngModel)]="form.venue" name="venue" /></mat-form-field>
        <button mat-flat-button type="submit">Create tournament</button>
      </form>
      @if (error()) { <p class="error-text">{{ error() }}</p> }
      <div class="list">
        @for (t of tournaments(); track t.id) {
          <div class="panel item">
            <a class="title" [routerLink]="['/admin/t', t.id]">
              <strong>{{ t.name }}</strong>
              <span class="muted small">{{ t.date }}{{ t.venue ? ' · ' + t.venue : '' }}</span>
            </a>
            <span class="chip" [class.live]="t.status === 'active'">{{ t.status }}</span>
            <button mat-button type="button" (click)="startCopy(t)" title="Start a new tournament with the same divisions, teams, courts and (optionally) players">Duplicate</button>
          </div>
          @if (copyFrom()?.id === t.id) {
            <form class="panel copy" (ngSubmit)="copy()">
              <mat-form-field appearance="outline" class="grow"><mat-label>Name of the copy</mat-label>
                <input matInput [(ngModel)]="copyName" name="copyName" required /></mat-form-field>
              <mat-checkbox [(ngModel)]="copyRoster" name="copyRoster">Include players and pairs</mat-checkbox>
              <button mat-flat-button type="submit" [disabled]="!copyName.trim()">Create copy</button>
              <button mat-button type="button" (click)="copyFrom.set(null)">Cancel</button>
              <span class="muted small full">Copies divisions, teams, courts and scoring rules. Matches, results, schedules and umpire codes are not copied.</span>
            </form>
          }
        } @empty { <p class="muted">No tournaments yet. Create one above.</p> }
      </div>
    </div>
  `,
  styles: `
    h1 { font-weight: 500; }
    .list { margin-top: 16px; display: grid; gap: 10px; }
    .item { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
    .title { flex: 1; display: flex; flex-direction: column; gap: 2px; text-decoration: none; color: inherit; min-width: 200px; }
    .copy { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin-top: -4px; background: #fafaf5; }
    .full { flex-basis: 100%; }
  `,
})
export class TournamentList {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  readonly tournaments = signal<TournamentDto[]>([]);
  readonly error = signal('');
  readonly copyFrom = signal<TournamentDto | null>(null);
  form = { name: '', date: '', venue: '' };
  copyName = '';
  copyRoster = true;

  constructor() {
    void this.load();
  }

  async load() {
    try {
      this.tournaments.set(await this.api.get<TournamentDto[]>('/tournaments'));
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }

  async create() {
    this.error.set('');
    try {
      const t = await this.api.post<TournamentDto>('/tournaments', this.form);
      await this.router.navigate(['/admin/t', t.id]);
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }

  startCopy(t: TournamentDto) {
    this.copyFrom.set(t);
    this.copyName = `${t.name} (copy)`;
    this.copyRoster = true;
  }

  async copy() {
    const src = this.copyFrom();
    if (!src) return;
    this.error.set('');
    try {
      const r = await this.api.post<{ tournament: TournamentDto }>(`/tournaments/${src.id}/duplicate`, { name: this.copyName, includeRoster: this.copyRoster });
      await this.router.navigate(['/admin/t', r.tournament.id]);
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }
}
