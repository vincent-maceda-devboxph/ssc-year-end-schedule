import { Component, OnInit, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import type { ReportDto } from '@bt/shared';
import { Api, errorMessage } from '../../core/api.service';
import { TournamentContext } from '../tournaments/tournament-context';

/** End-of-event (or mid-event) summary: totals, team standings, every result, pair records, umpires, corrections. */
@Component({
  selector: 'bt-reports-tab',
  imports: [MatButtonModule, MatIconModule],
  template: `
    <div class="row no-print bar">
      <span class="muted small">{{ report() ? 'Generated ' + fmt(report()!.generatedAt) : '' }}</span>
      <span class="grow"></span>
      <button mat-button (click)="load()" [disabled]="busy()"><mat-icon>refresh</mat-icon> Refresh</button>
      <a mat-stroked-button [href]="exportUrl()" download><mat-icon>download</mat-icon> Excel</a>
      <button mat-stroked-button (click)="print()"><mat-icon>print</mat-icon> Print</button>
    </div>
    @if (error()) { <p class="error-text">{{ error() }}</p> }

    @if (report(); as r) {
      <section class="panel">
        <h2>{{ r.tournament.name }}</h2>
        <p class="muted">{{ r.tournament.date }} {{ r.tournament.venue ? '· ' + r.tournament.venue : '' }} · {{ r.tournament.status }}</p>
        <div class="stats">
          @for (s of stats(r); track s.label) { <div class="stat"><span class="n">{{ s.value }}</span><span class="muted small">{{ s.label }}</span></div> }
        </div>
      </section>

      <section class="panel">
        <h3>Team standings</h3>
        <table class="simple">
          <thead><tr><th>#</th><th>Team</th><th class="n">Points</th><th class="n">Played</th><th class="n">Won</th><th class="n">Lost</th><th class="n">Games</th><th class="n">Rally +/-</th></tr></thead>
          <tbody>
            @for (t of r.teams; track t.teamId) {
              <tr><td>{{ t.rank }}</td><td><span class="swatch" [style.background]="t.color"></span><strong>{{ t.name }}</strong></td>
                <td class="n big">{{ t.points }}</td><td class="n">{{ t.played }}</td><td class="n">{{ t.won }}</td><td class="n">{{ t.lost }}</td>
                <td class="n">{{ t.gamesWon }}-{{ t.gamesLost }}</td><td class="n">{{ t.pointsFor - t.pointsAgainst }}</td></tr>
            }
          </tbody>
        </table>
      </section>

      @for (d of r.divisions; track d.id) {
        <section class="panel">
          <h3>{{ d.name }}: results</h3>
          <div class="scroll">
            <table class="simple">
              <thead><tr><th>Level</th><th>Match</th><th>Team 1</th><th>Pair 1</th><th>Team 2</th><th>Pair 2</th><th>Score</th><th>Winner</th><th>Umpire</th></tr></thead>
              <tbody>
                @for (m of d.rows; track m.matchNumber) {
                  <tr [class.muted]="m.status !== 'completed' && m.status !== 'walkover' && m.status !== 'retired'">
                    <td><strong>{{ m.bracket }}</strong></td><td>#{{ m.matchNumber }}{{ m.gameNumber ? ' · game ' + m.gameNumber : '' }}</td>
                    <td>{{ m.teamA }}</td><td>{{ m.pairA }}</td><td>{{ m.teamB }}</td><td>{{ m.pairB }}</td>
                    <td class="nowrap">{{ m.score || m.status }}{{ m.corrected ? ' ✎' : '' }}</td><td><strong>{{ m.winner }}</strong></td><td class="small">{{ m.umpire }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </section>
      }

      <section class="panel">
        <h3>Pairs</h3>
        <div class="scroll">
          <table class="simple">
            <thead><tr><th>Level</th><th>Pair</th><th>Team</th><th class="n">Played</th><th class="n">Won</th><th class="n">Lost</th><th class="n">Games</th><th class="n">Rally</th></tr></thead>
            <tbody>
              @for (p of r.pairs; track $index) {
                <tr><td>{{ p.bracket }}</td><td>{{ p.name }}</td><td class="small">{{ p.team }}</td><td class="n">{{ p.played }}</td><td class="n">{{ p.won }}</td><td class="n">{{ p.lost }}</td>
                  <td class="n">{{ p.gamesWon }}-{{ p.gamesLost }}</td><td class="n">{{ p.pointsFor }}-{{ p.pointsAgainst }}</td></tr>
              }
            </tbody>
          </table>
        </div>
      </section>

      <div class="two">
        <section class="panel">
          <h3>Umpires</h3>
          <table class="simple"><tbody>
            @for (u of r.umpires; track u.name) { <tr><td>{{ u.name }}</td><td class="n">{{ u.matches }} matches</td></tr> } @empty { <tr><td class="muted">No umpire has finished a match yet.</td></tr> }
          </tbody></table>
        </section>
        <section class="panel">
          <h3>Corrected results</h3>
          <table class="simple"><tbody>
            @for (c of r.corrections; track $index) { <tr><td class="small">{{ fmt(c.at) }}<br />#{{ c.matchNumber }} {{ c.bracket }}</td><td class="small"><strong>{{ c.by }}:</strong> {{ c.reason }}</td></tr> } @empty { <tr><td class="muted">None.</td></tr> }
          </tbody></table>
        </section>
      </div>
    }
  `,
  styles: `
    :host { display: block; padding-top: 16px; }
    .bar { margin-bottom: 8px; } h2 { margin: 0; font-weight: 500; } h3 { margin: 0 0 8px; font-weight: 500; }
    section { margin-bottom: 14px; }
    .stats { display: grid; gap: 10px; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); }
    .stat { background: #f5f7f3; border-radius: 10px; padding: 10px; display: flex; flex-direction: column; }
    .n { text-align: right !important; font-variant-numeric: tabular-nums; } .big { font-size: 17px; font-weight: 700; }
    .nowrap { white-space: nowrap; } .scroll { overflow-x: auto; }
    .stat .n { text-align: left !important; font-size: 22px; font-weight: 700; }
    .swatch { display: inline-block; width: 12px; height: 12px; border-radius: 3px; margin-right: 8px; border: 1px solid #0002; }
    .two { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); }
  `,
})
export class ReportsTab implements OnInit {
  private readonly api = inject(Api);
  private readonly ctx = inject(TournamentContext);
  readonly report = signal<ReportDto | null>(null);
  readonly error = signal('');
  readonly busy = signal(false);

  ngOnInit() {
    void this.load();
  }

  exportUrl = () => `/api/tournaments/${this.ctx.id()}/report/export`;
  fmt = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  print = () => window.print();

  stats(r: ReportDto) {
    const t = r.totals;
    return [
      { label: 'Matches', value: t.matches }, { label: 'Finished', value: t.finished }, { label: 'Not started', value: t.notStarted },
      { label: 'Walkovers', value: t.walkover }, { label: 'Retirements', value: t.retired }, { label: 'Corrected', value: t.corrected },
      { label: 'Games played', value: t.games }, { label: 'Rally points', value: t.rallyPoints },
      { label: 'Average match', value: t.avgMinutes === null ? '–' : `${t.avgMinutes} min` }, { label: 'Longest match', value: t.longestMinutes === null ? '–' : `${t.longestMinutes} min` },
    ];
  }

  async load() {
    this.busy.set(true);
    this.error.set('');
    try {
      this.report.set(await this.api.get<ReportDto>(`/tournaments/${this.ctx.id()}/report`));
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
}
