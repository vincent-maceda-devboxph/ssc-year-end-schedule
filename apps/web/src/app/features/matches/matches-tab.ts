import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatMenuModule } from '@angular/material/menu';
import { MatSelectModule } from '@angular/material/select';
import { formatGames, isFinal, isLive, STATUS_LABELS, type GenerateMatchesResult, type MatchDto } from '@bt/shared';
import { MatDialog } from '@angular/material/dialog';
import { Api, errorMessage } from '../../core/api.service';
import { CorrectResultDialog } from './correct-result-dialog';
import { TournamentContext } from '../tournaments/tournament-context';

type Filter = 'open' | 'live' | 'finished' | 'all';

@Component({
  selector: 'bt-matches-tab',
  imports: [FormsModule, MatButtonModule, MatButtonToggleModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatMenuModule, MatIconModule],
  template: `
    <section class="panel gen">
      <div class="row">
        <div class="grow">
          <h3>Generate matches</h3>
          <p class="muted small">
            Round robin inside each category. In team categories only pairs from different teams meet
            (with one pair per team that is team vs team). Already-generated matchups are skipped.
            New matches have no court or time yet.
          </p>
        </div>
        <label class="small"><input type="checkbox" [(ngModel)]="replace" name="replace" /> Replace matches that have not started</label>
        <button mat-flat-button (click)="generate()" [disabled]="busy()"><mat-icon>auto_awesome</mat-icon> Generate</button>
      </div>
      @if (genResult(); as g) {
        <div class="result" [class.bad]="g.problems.length && !g.created">
          Created {{ g.created }} · already existed {{ g.skipped }}{{ g.deleted ? ' · replaced ' + g.deleted : '' }}
          @if (g.problems.length) { <ul>@for (p of g.problems; track $index) { <li>{{ p }}</li> }</ul> }
        </div>
      }
    </section>

    <form class="panel" (ngSubmit)="create()">
      <div class="row">
        <mat-form-field appearance="outline"><mat-label>Category</mat-label>
          <mat-select [(ngModel)]="form.categoryId" name="cat" (selectionChange)="form.entryAId = ''; form.entryBId = ''" required>
            @for (c of ctx.categories(); track c.id) { <mat-option [value]="c.id">{{ c.name }}</mat-option> }
          </mat-select></mat-form-field>
        <mat-form-field appearance="outline" class="grow"><mat-label>Pair A</mat-label>
          <mat-select [(ngModel)]="form.entryAId" name="a" required>
            @for (e of pairsFor(form.categoryId); track e.id) { <mat-option [value]="e.id" [disabled]="e.id === form.entryBId">{{ e.displayName }}</mat-option> }
          </mat-select></mat-form-field>
        <mat-form-field appearance="outline" class="grow"><mat-label>Pair B</mat-label>
          <mat-select [(ngModel)]="form.entryBId" name="b" required>
            @for (e of pairsFor(form.categoryId); track e.id) { <mat-option [value]="e.id" [disabled]="e.id === form.entryAId">{{ e.displayName }}</mat-option> }
          </mat-select></mat-form-field>
        <mat-form-field appearance="outline"><mat-label>Court</mat-label>
          <mat-select [(ngModel)]="form.courtId" name="court">
            <mat-option [value]="null">Assign later</mat-option>
            @for (c of activeCourts(); track c.id) { <mat-option [value]="c.id">{{ c.name }}</mat-option> }
          </mat-select></mat-form-field>
        <mat-form-field appearance="outline" class="round"><mat-label>Round</mat-label>
          <input matInput [(ngModel)]="form.round" name="round" placeholder="Group A" /></mat-form-field>
        <button mat-flat-button type="submit">Create match</button>
      </div>
    </form>
    @if (error()) { <p class="error-text">{{ error() }}</p> }

    <mat-button-toggle-group class="filter" [value]="filter()" (change)="filter.set($event.value)" hideSingleSelectionIndicator>
      <mat-button-toggle value="open">To play</mat-button-toggle>
      <mat-button-toggle value="live">Live</mat-button-toggle>
      <mat-button-toggle value="finished">Finished</mat-button-toggle>
      <mat-button-toggle value="all">All</mat-button-toggle>
    </mat-button-toggle-group>
    <mat-select class="inline catfilter" [value]="categoryFilter()" (selectionChange)="categoryFilter.set($event.value)" aria-label="Filter by category">
      <mat-option value="">All categories</mat-option>
      @for (c of ctx.categories(); track c.id) { <mat-option [value]="c.id">{{ c.name }}</mat-option> }
    </mat-select>
    <span class="muted small"> {{ visible().length }} matches</span>

    <div class="panel table">
      <table class="simple">
        <thead><tr><th>#</th><th>Match</th><th>Court</th><th>Queue</th><th>Status</th><th>Score</th><th></th></tr></thead>
        <tbody>
          @for (m of visible(); track m.id) {
            <tr>
              <td>{{ m.matchNumber }}</td>
              <td>
                <div [class.win]="m.winner === 'A'">@if (m.teamA) { <span class="team" [style.background]="m.teamA.color">{{ m.teamA.name }}</span> }{{ m.entryA.name }}</div>
                <div [class.win]="m.winner === 'B'">@if (m.teamB) { <span class="team" [style.background]="m.teamB.color">{{ m.teamB.name }}</span> }{{ m.entryB.name }}</div>
                <div class="muted small">{{ m.bracket }}{{ m.round ? ' · ' + m.round : '' }}</div>
              </td>
              <td>
                @if (isLive(m.status) || isFinal(m.status)) { {{ m.courtName ?? '–' }} }
                @else {
                  <mat-select class="inline" [value]="m.courtId" (selectionChange)="assign(m, $event.value)" placeholder="Assign" aria-label="Court">
                    <mat-option [value]="null">Unassigned</mat-option>
                    @for (c of activeCourts(); track c.id) { <mat-option [value]="c.id">{{ c.name }}</mat-option> }
                  </mat-select>
                }
              </td>
              <td>
                @if (m.status === 'scheduled' || m.status === 'ready') {
                  <button mat-icon-button (click)="move(m, -1)" aria-label="Move up"><mat-icon>arrow_upward</mat-icon></button>
                  <button mat-icon-button (click)="move(m, 1)" aria-label="Move down"><mat-icon>arrow_downward</mat-icon></button>
                }
              </td>
              <td><span [class]="'chip ' + (m.status === 'in_progress' ? 'live' : m.status)">{{ labels[m.status] }}</span>
                @if (m.umpireName) { <div class="muted small">{{ m.umpireName }}</div> }
                @if (m.corrections) { <div class="small corrected">corrected{{ m.corrections > 1 ? ' ×' + m.corrections : '' }}</div> }</td>
              <td class="score">{{ m.status === 'walkover' ? 'W/O' : formatGames(m.score.games) }}</td>
              <td>
                @if (m.status === 'completed' || m.status === 'retired' || m.status === 'walkover') {
                  <button mat-icon-button [matMenuTriggerFor]="doneMenu" aria-label="Actions"><mat-icon>more_vert</mat-icon></button>
                  <mat-menu #doneMenu="matMenu">
                    <button mat-menu-item (click)="correctResult(m)"><mat-icon>edit</mat-icon>Correct result…</button>
                  </mat-menu>
                }
                @if (!isFinal(m.status)) {
                  <button mat-icon-button [matMenuTriggerFor]="menu" aria-label="Actions"><mat-icon>more_vert</mat-icon></button>
                  <mat-menu #menu="matMenu">
                    @if (m.status === 'scheduled' || m.status === 'ready') { <button mat-menu-item (click)="call(m, true)">Call to court</button> }
                    @if (m.status === 'called') { <button mat-menu-item (click)="call(m, false)">Cancel call</button> }
                    @if (!isLive(m.status)) {
                      <button mat-menu-item (click)="walkover(m, 'A')">Walkover – {{ m.entryA.name }} wins</button>
                      <button mat-menu-item (click)="walkover(m, 'B')">Walkover – {{ m.entryB.name }} wins</button>
                    }
                    @if (m.status !== 'awaiting_confirmation') { <button mat-menu-item (click)="cancel(m)">Cancel match</button> }
                    @if (!isLive(m.status)) { <button mat-menu-item (click)="remove(m)">Delete</button> }
                  </mat-menu>
                }
              </td>
            </tr>
          } @empty { <tr><td colspan="7" class="muted">No matches here.</td></tr> }
        </tbody>
      </table>
    </div>
  `,
  styles: `
    :host { display: block; padding-top: 16px; }
    .round { width: 130px; }
    .filter { margin: 16px 0 8px; }
    .table { overflow-x: auto; }
    .inline { min-width: 120px; border: 1px solid var(--bt-border); border-radius: 6px; padding: 4px 8px; }
    .win { font-weight: 700; }
    .corrected { color: #ef6c00; }
    .score { font-variant-numeric: tabular-nums; white-space: nowrap; }
    .team { display: inline-block; font-size: 11px; padding: 0 6px; border-radius: 4px; margin-right: 6px; border: 1px solid #0001; }
    .catfilter { display: inline-block; vertical-align: middle; margin-left: 12px; width: 180px; background: #fff; }
    .gen h3 { margin: 0 0 4px; font-weight: 500; }
    .gen label { display: flex; align-items: center; gap: 6px; }
    .result { margin-top: 10px; padding: 10px 12px; border-radius: 8px; background: #e8f5e9; font-size: 14px; }
    .result.bad { background: #ffebee; }
    .result ul { margin: 6px 0 0; padding-left: 20px; }
    .panel + .panel { margin-top: 12px; }
  `,
})
export class MatchesTab {
  readonly ctx = inject(TournamentContext);
  private readonly api = inject(Api);
  private readonly dialog = inject(MatDialog);
  readonly labels = STATUS_LABELS;
  readonly formatGames = formatGames;
  readonly isLive = isLive;
  readonly isFinal = isFinal;
  readonly error = signal('');
  readonly filter = signal<Filter>('open');
  readonly categoryFilter = signal('');
  readonly busy = signal(false);
  readonly genResult = signal<GenerateMatchesResult | null>(null);
  replace = false;
  form = { categoryId: '', entryAId: '', entryBId: '', courtId: null as string | null, round: '' };

  readonly activeCourts = computed(() => this.ctx.courts().filter((c) => c.active));
  readonly visible = computed(() => {
    const cat = this.categoryFilter();
    const all = this.ctx.matches.all().filter((m) => !cat || m.categoryId === cat);
    switch (this.filter()) {
      case 'open':
        return all
          .filter((m) => !isFinal(m.status) && !isLive(m.status))
          .sort((a, b) => (a.courtName ?? '~').localeCompare(b.courtName ?? '~', undefined, { numeric: true }) || a.queuePosition - b.queuePosition);
      case 'live':
        return all.filter((m) => isLive(m.status));
      case 'finished':
        return this.ctx.matches.finished();
      default:
        return all;
    }
  });

  async generate() {
    if (this.replace && !confirm('Replace every generated match that has not started? Matches with results are kept.')) return;
    this.busy.set(true);
    this.error.set('');
    try {
      this.genResult.set(await this.api.post<GenerateMatchesResult>(`/tournaments/${this.ctx.id()}/matches/generate`, { replace: this.replace }));
      await this.ctx.matches.refresh();
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  pairsFor(categoryId: string) {
    return this.ctx.entries().filter((e) => e.categoryId === categoryId && e.status === 'active');
  }

  private async run(fn: () => Promise<unknown>) {
    this.error.set('');
    try {
      await fn();
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }

  // Each change is broadcast over Socket.IO, but we also apply the HTTP response right away.
  private applied = (m: MatchDto) => this.ctx.matches.upsert(m);

  create() {
    return this.run(async () => {
      this.applied(await this.api.post<MatchDto>('/matches', this.form));
      this.form = { ...this.form, entryAId: '', entryBId: '' };
    });
  }

  assign(m: MatchDto, courtId: string | null) {
    return this.run(async () => this.applied(await this.api.put<MatchDto>(`/matches/${m.id}`, { courtId })));
  }

  /** Swap queue position with the neighbouring queued match on the same court. */
  move(m: MatchDto, dir: -1 | 1) {
    const queue = this.ctx.matches
      .all()
      .filter((x) => x.courtId === m.courtId && (x.status === 'scheduled' || x.status === 'ready'))
      .sort((a, b) => a.queuePosition - b.queuePosition);
    const i = queue.findIndex((x) => x.id === m.id);
    const other = queue[i + dir];
    if (!other) return;
    return this.run(async () => {
      const [a, b] = await Promise.all([
        this.api.put<MatchDto>(`/matches/${m.id}`, { queuePosition: other.queuePosition }),
        this.api.put<MatchDto>(`/matches/${other.id}`, { queuePosition: m.queuePosition }),
      ]);
      this.applied(a);
      this.applied(b);
    });
  }

  correctResult(m: MatchDto) {
    this.dialog
      .open<CorrectResultDialog, { match: MatchDto }, MatchDto | undefined>(CorrectResultDialog, { data: { match: m }, width: '520px', maxWidth: '95vw' })
      .afterClosed()
      .subscribe((updated) => {
        if (updated) this.applied(updated);
      });
  }

  call(m: MatchDto, call: boolean) {
    return this.run(async () => this.applied(await this.api.post<MatchDto>(`/matches/${m.id}/${call ? 'call' : 'uncall'}`, {})));
  }

  walkover(m: MatchDto, winner: 'A' | 'B') {
    const name = winner === 'A' ? m.entryA.name : m.entryB.name;
    if (!confirm(`Record a walkover? ${name} wins without playing.`)) return;
    return this.run(async () => this.applied(await this.api.post<MatchDto>(`/matches/${m.id}/walkover`, { winner })));
  }

  cancel(m: MatchDto) {
    if (!confirm(`Cancel match #${m.matchNumber}?`)) return;
    return this.run(async () => this.applied(await this.api.post<MatchDto>(`/matches/${m.id}/cancel`, {})));
  }

  remove(m: MatchDto) {
    if (!confirm(`Delete match #${m.matchNumber}?`)) return;
    return this.run(async () => {
      await this.api.delete(`/matches/${m.id}`);
      await this.ctx.matches.refresh();
    });
  }
}
