import { Component, OnInit, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatSelectModule } from '@angular/material/select';
import { MatTabsModule } from '@angular/material/tabs';
import { TOURNAMENT_STATUSES, type TournamentDto } from '@bt/shared';
import { Api, errorMessage } from '../../core/api.service';
import { MatchStore } from '../../core/match-store';
import { BracketsTab } from '../brackets/brackets-tab';
import { CategoriesTab } from '../categories/categories-tab';
import { CourtsTab } from '../courts/courts-tab';
import { DashboardTab } from '../dashboard/dashboard-tab';
import { MatchesTab } from '../matches/matches-tab';
import { EntriesTab } from '../pairs/entries-tab';
import { ReportsTab } from '../reports/reports-tab';
import { ScheduleTab } from '../scheduling/schedule-tab';
import { StandingsView } from '../standings/standings-view';
import { TeamsTab } from '../teams/teams-tab';
import { TournamentContext } from './tournament-context';

@Component({
  selector: 'bt-tournament-detail',
  imports: [FormsModule, MatFormFieldModule, MatIconModule, MatInputModule, RouterLink, MatTabsModule, MatSelectModule, MatButtonModule, DashboardTab, MatchesTab, EntriesTab, CategoriesTab, BracketsTab, CourtsTab, TeamsTab, StandingsView, ScheduleTab, ReportsTab],
  providers: [MatchStore, TournamentContext],
  template: `
    <div class="page">
      <a routerLink="/admin" class="back no-print">← All tournaments</a>
      @if (ctx.tournament(); as t) {
        <div class="banner">
          <div class="grow">
            <h1>{{ t.name }}</h1>
            <p class="sub">
              @if (t.date) { <span>{{ t.date }}</span> }
              @if (t.venue) { <span>{{ t.venue }}</span> }
              <span class="st"><span class="dot" [class.on]="t.status === 'active'"></span> {{ t.status }}</span>
            </p>
          </div>
          <div class="row no-print">
            <button mat-stroked-button class="ghost" type="button" (click)="startEdit()"><mat-icon>edit</mat-icon> Edit details</button>
            <a mat-stroked-button class="ghost" [routerLink]="['/live', ctx.id()]" target="_blank">Spectator view</a>
            <a mat-stroked-button class="ghost" [routerLink]="['/board', ctx.id()]" target="_blank">TV scoreboard</a>
            <mat-select class="status" [value]="t.status" (selectionChange)="setStatus($event.value)" aria-label="Tournament status">
              @for (s of statuses; track s) { <mat-option [value]="s">{{ s }}</mat-option> }
            </mat-select>
          </div>
        </div>
        @if (editing()) {
          <form class="panel editbox no-print" (ngSubmit)="saveEdit()">
            <h3>Tournament details</h3>
            <div class="row">
              <mat-form-field appearance="outline" class="grow"><mat-label>Name</mat-label>
                <input matInput [(ngModel)]="draft.name" name="tname" required maxlength="120" /></mat-form-field>
              <mat-form-field appearance="outline"><mat-label>Date</mat-label>
                <input matInput type="date" [(ngModel)]="draft.date" name="tdate" /></mat-form-field>
              <mat-form-field appearance="outline" class="grow"><mat-label>Venue</mat-label>
                <input matInput [(ngModel)]="draft.venue" name="tvenue" maxlength="120" placeholder="Sports Hall A" /></mat-form-field>
            </div>
            <div class="row">
              <button mat-flat-button type="submit" [disabled]="!draft.name.trim()">Save details</button>
              <button mat-button type="button" (click)="editing.set(false)">Cancel</button>
            </div>
          </form>
        }
        @if (t.status !== 'active') {
          <p class="hint small no-print">Spectators and umpires only see <strong>active</strong> tournaments. Set the status to active on match day.</p>
        }
      }
      @if (error()) { <p class="error-text">{{ error() }}</p> }

      <mat-tab-group animationDuration="0ms" mat-stretch-tabs="false">
        <mat-tab label="Live"><ng-template matTabContent><bt-dashboard-tab /></ng-template></mat-tab>
        <mat-tab label="Matches"><ng-template matTabContent><bt-matches-tab /></ng-template></mat-tab>
        <mat-tab label="Schedule"><ng-template matTabContent><bt-schedule-tab /></ng-template></mat-tab>
        <mat-tab label="Standings"><ng-template matTabContent><div class="tabpad"><bt-standings [tournamentId]="ctx.id()" /></div></ng-template></mat-tab>
        <mat-tab label="Reports"><ng-template matTabContent><bt-reports-tab /></ng-template></mat-tab>
        <mat-tab label="Teams & lineup"><ng-template matTabContent><bt-teams-tab /></ng-template></mat-tab>
        <mat-tab label="Players & pairs"><ng-template matTabContent><bt-entries-tab /></ng-template></mat-tab>
        <mat-tab label="Divisions"><ng-template matTabContent><bt-categories-tab /></ng-template></mat-tab>
        <mat-tab label="Groups & knockout"><ng-template matTabContent><bt-brackets-tab /></ng-template></mat-tab>
        <mat-tab label="Courts"><ng-template matTabContent><bt-courts-tab /></ng-template></mat-tab>
      </mat-tab-group>
    </div>
  `,
  styles: `
    .back { color: var(--bt-muted); text-decoration: none; font-size: 14px; display: inline-block; margin-bottom: 8px; }
    .back:hover { color: var(--bt-brand); }
    .banner { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; padding: 22px 24px; margin-bottom: 16px; border-radius: 20px; color: #fff;
      background: linear-gradient(120deg, #0f766e, #0e7490 55%, #1d4ed8); box-shadow: var(--bt-shadow); }
    h1 { margin: 0; font-size: clamp(24px, 4vw, 32px); }
    .sub { margin: 4px 0 0; opacity: .9; font-size: 14px; display: flex; align-items: center; gap: 6px; text-transform: capitalize; }
    .st { display: inline-flex; align-items: center; gap: 6px; }
    .sub { flex-wrap: wrap; gap: 6px 14px !important; }
    .sub > span + span:not(.st)::before { content: ''; }
    .editbox { margin-bottom: 16px; }
    .editbox h3 { margin: 0 0 8px; }
    .dot { width: 9px; height: 9px; border-radius: 50%; background: #cbd5e1; display: inline-block; }
    .dot.on { background: #4ade80; box-shadow: 0 0 0 4px rgba(74, 222, 128, .3); }
    .ghost { color: #fff !important; border-color: rgba(255,255,255,.55) !important; }
    .status { width: 120px; background: rgba(255,255,255,.16); color: #fff; border-radius: 12px; padding: 8px 12px; text-transform: capitalize; --mat-select-enabled-trigger-text-color: #fff; --mat-select-enabled-arrow-color: #fff; }
    .tabpad { padding-top: 16px; }
    .hint { background: #fff8e1; border-radius: 8px; padding: 8px 12px; margin: 0 0 8px; }
  `,
})
export class TournamentDetail implements OnInit {
  readonly tournamentId = input.required<string>();
  readonly ctx = inject(TournamentContext);
  private readonly api = inject(Api);
  readonly statuses = TOURNAMENT_STATUSES;
  readonly error = signal('');

  ngOnInit() {
    this.ctx.init(this.tournamentId()).catch((e) => this.error.set(errorMessage(e)));
  }

  readonly editing = signal(false);
  draft = { name: '', date: '', venue: '' };

  startEdit() {
    const t = this.ctx.tournament();
    if (!t) return;
    this.draft = { name: t.name, date: /^\d{4}-\d{2}-\d{2}$/.test(t.date) ? t.date : '', venue: t.venue };
    this.editing.set(true);
  }

  async saveEdit() {
    this.error.set('');
    try {
      await this.api.put(`/tournaments/${this.ctx.id()}`, { name: this.draft.name.trim(), date: this.draft.date, venue: this.draft.venue.trim() });
      await this.ctx.loadTournament();
      this.editing.set(false);
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }

  async setStatus(status: TournamentDto['status']) {
    try {
      await this.api.put(`/tournaments/${this.ctx.id()}`, { status });
      await this.ctx.loadTournament();
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }
}
