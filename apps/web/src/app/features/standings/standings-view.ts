import { TeamLogo } from '../../shared/components/team-logo';
import { Component, DestroyRef, OnInit, inject, input, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { merge } from 'rxjs';
import { filter } from 'rxjs/operators';
import type { StandingsResponse, TeamDto } from '@bt/shared';
import { Api, errorMessage } from '../../core/api.service';
import { Realtime } from '../../core/realtime.service';

/** Team standings (1 point per match won) + pair tables per category. Read-only; used by admin and spectators. */
@Component({
  selector: 'bt-standings',
  imports: [TeamLogo],
  template: `
    @if (error()) { <p class="error-text">{{ error() }}</p> }
    @if (data(); as d) {
      <div class="panel">
        <h3>Team standings</h3>
        <div class="scroll">
          <table class="simple">
            <thead>
              <tr><th>#</th><th>Team</th><th class="n">Points</th><th class="n">Played</th><th class="n">W</th><th class="n">L</th>
                <th class="n">Games</th><th class="n">Pts +/-</th>
                @if (showCategories()) { @for (c of d.categories; track c.id) { <th class="n cat">{{ c.name }}</th> } }
              </tr>
            </thead>
            <tbody>
              @for (t of d.teams; track t.teamId) {
                <tr>
                  <td>{{ t.rank }}</td>
                  <td><span class="tn"><bt-team-logo [team]="t" [size]="28" /><strong>{{ t.name }}</strong></span></td>
                  <td class="n big">{{ t.points }}</td>
                  <td class="n">{{ t.played }}</td><td class="n">{{ t.won }}</td><td class="n">{{ t.lost }}</td>
                  <td class="n">{{ t.gamesWon }}-{{ t.gamesLost }}</td>
                  <td class="n">{{ signed(t.pointsFor - t.pointsAgainst) }}</td>
                  @if (showCategories()) { @for (c of d.categories; track c.id) { <td class="n">{{ t.byCategory[c.id] ?? 0 }}</td> } }
                </tr>
              } @empty { <tr><td colspan="8" class="muted">No teams.</td></tr> }
            </tbody>
          </table>
        </div>
        <p class="muted small">1 point per match won. Ties broken by game difference, then point difference.</p>
      </div>

      <div class="cats">
        @for (c of d.categories; track c.id) {
          @if (c.pairs.length) {
            <div class="panel">
              <h4>{{ c.name }}</h4>
              <table class="simple">
                <thead><tr><th>#</th><th>Pair</th><th class="n">W</th><th class="n">L</th><th class="n">Games</th></tr></thead>
                <tbody>
                  @for (p of c.pairs; track p.entryId) {
                    <tr>
                      <td>{{ p.rank }}</td>
                      <td><span class="swatch" [style.background]="colorOf(p.teamId)"></span>{{ p.name }}</td>
                      <td class="n">{{ p.won }}</td><td class="n">{{ p.lost }}</td>
                      <td class="n">{{ p.gamesWon }}-{{ p.gamesLost }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        }
      </div>
    }
  `,
  styles: `
    .tn { display: inline-flex; align-items: center; gap: 10px; }
    :host { display: block; }
    h3, h4 { margin: 0 0 8px; font-weight: 500; }
    .scroll { overflow-x: auto; }
    .n { text-align: right !important; font-variant-numeric: tabular-nums; }
    .big { font-size: 18px; font-weight: 700; }
    .cat { font-size: 11px !important; }
    .swatch { display: inline-block; width: 12px; height: 12px; border-radius: 3px; margin-right: 8px; vertical-align: -1px; border: 1px solid #0002; }
    .cats { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); margin-top: 12px; }
  `,
})
export class StandingsView implements OnInit {
  readonly tournamentId = input.required<string>();
  readonly showCategories = input(true);
  private readonly api = inject(Api);
  private readonly rt = inject(Realtime);
  private readonly destroyRef = inject(DestroyRef);
  readonly data = signal<StandingsResponse | null>(null);
  readonly teams = signal<TeamDto[]>([]);
  readonly error = signal('');

  ngOnInit() {
    const id = this.tournamentId();
    this.rt.watch(`tournament:${id}`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe();
    merge(
      this.rt.tournamentEvent$.pipe(filter((e) => e.tournamentId === id)),
      this.rt.reconnected$,
    )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => void this.load());
    void this.load();
  }

  async load() {
    try {
      const id = this.tournamentId();
      const [d, teams] = await Promise.all([
        this.api.get<StandingsResponse>(`/tournaments/${id}/standings`),
        this.api.get<TeamDto[]>(`/tournaments/${id}/teams`),
      ]);
      this.data.set(d);
      this.teams.set(teams);
      this.error.set('');
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }

  colorOf(teamId: string | null) {
    return this.teams().find((t) => t.id === teamId)?.color ?? 'transparent';
  }

  signed(n: number) {
    return n > 0 ? `+${n}` : String(n);
  }
}
