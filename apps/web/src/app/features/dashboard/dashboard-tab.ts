import { Component, computed, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { COURT_STATUS_LABELS, formatGames, type MatchDto } from '@bt/shared';
import { Api, errorMessage } from '../../core/api.service';
import { MatchCard } from '../../shared/components/match-card';
import { TournamentContext } from '../tournaments/tournament-context';

@Component({
  selector: 'bt-dashboard-tab',
  imports: [MatchCard, MatIconModule, MatButtonModule],
  template: `
    <div class="stats">
      @for (s of stats(); track s.label) {
        <div class="panel stat"><span class="n">{{ s.value }}</span><span class="muted small">{{ s.label }}</span></div>
      }
    </div>

    @if (error()) { <p class="error-text">{{ error() }}</p> }
    <h3>Courts</h3>
    <div class="grid">
      @for (c of ctx.courts(); track c.id) {
        @let slot = ctx.matches.byCourt(c.id);
        <div class="court">
          <div class="row ch">
            <strong>{{ c.name }}</strong>
            <span class="chip" [class]="'chip ' + (ctx.courtStatusOf(c) === 'ongoing' ? 'live' : ctx.courtStatusOf(c) === 'unavailable' ? 'cancelled' : ctx.courtStatusOf(c) === 'called' ? 'called' : '')">{{ courtLabels[ctx.courtStatusOf(c)] }}</span>
            <span class="grow"></span>
            <span class="ump small" [class.on]="c.umpire?.connected">
              <mat-icon inline>{{ c.umpire?.connected ? 'phone_android' : 'phonelink_off' }}</mat-icon>
              {{ c.umpire?.connected ? c.umpire?.name : 'No umpire online' }}
            </span>
          </div>
          @if (slot.current) {
            <bt-match-card [match]="slot.current" [showCourt]="false" />
            @if (slot.current.status === 'scheduled' || slot.current.status === 'ready') {
              <button mat-stroked-button class="callbtn" (click)="call(slot.current.id, true)"><mat-icon>campaign</mat-icon> Call to court</button>
            } @else if (slot.current.status === 'called') {
              <button mat-stroked-button class="callbtn" (click)="call(slot.current.id, false)"><mat-icon>phone_disabled</mat-icon> Cancel call</button>
            }
          }
          @else { <div class="panel muted small">Free – assign a match in the Matches tab.</div> }
          <p class="muted small">{{ slot.next.length }} more queued</p>
        </div>
      } @empty { <p class="muted">Add courts in the Courts tab.</p> }
    </div>

    <h3>Recent results</h3>
    <div class="panel">
      <table class="simple">
        <tbody>
          @for (m of recent(); track m.id) {
            <tr>
              <td>#{{ m.matchNumber }}</td>
              <td>{{ m.bracket }}</td>
              <td>
                @if (m.winner) { <strong>{{ m.winner === 'A' ? m.entryA.name : m.entryB.name }}</strong> def. {{ m.winner === 'A' ? m.entryB.name : m.entryA.name }} }
                @else { {{ m.entryA.name }} vs {{ m.entryB.name }} }
              </td>
              <td>{{ m.status === 'walkover' ? 'W/O' : m.status === 'cancelled' ? 'Cancelled' : formatGames(m.score.games) }}</td>
              <td class="muted small">{{ m.umpireName }}</td>
            </tr>
          } @empty { <tr><td class="muted">No results yet.</td></tr> }
        </tbody>
      </table>
    </div>
  `,
  styles: `
    :host { display: block; padding-top: 16px; }
    .stats { display: grid; gap: 10px; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); }
    .stat { display: flex; flex-direction: column; padding: 14px 16px; border-left: 4px solid var(--bt-brand-2); }
    .stat:nth-child(2) { border-left-color: #8b5cf6; } .stat:nth-child(3) { border-left-color: #10b981; } .stat:nth-child(4) { border-left-color: #f59e0b; }
    .stat:nth-child(5) { border-left-color: #94a3b8; } .stat:nth-child(6) { border-left-color: #2563eb; } .stat:nth-child(7) { border-left-color: #14b8a6; }
    .n { font-size: 30px; font-weight: 800; line-height: 1.1; letter-spacing: -.02em; }
    h3 { font-weight: 700; font-size: 18px; margin: 24px 0 10px; }
    .ch { margin-bottom: 6px; }
    .callbtn { margin-top: 6px; }
    .ump { display: inline-flex; align-items: center; gap: 4px; color: var(--bt-muted); }
    .ump.on { color: var(--bt-ok); }
  `,
})
export class DashboardTab {
  readonly ctx = inject(TournamentContext);
  readonly formatGames = formatGames;
  readonly courtLabels = COURT_STATUS_LABELS;
  private readonly api = inject(Api);
  readonly error = signal('');

  async call(matchId: string, call: boolean) {
    this.error.set('');
    try {
      this.ctx.matches.upsert(await this.api.post<MatchDto>(`/matches/${matchId}/${call ? 'call' : 'uncall'}`, {}));
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }
  readonly recent = computed(() => this.ctx.matches.finished().slice(0, 10));
  readonly stats = computed(() => {
    const m = this.ctx.matches;
    return [
      { label: 'Players', value: this.ctx.players().length },
      { label: 'Pairs', value: this.ctx.entries().filter((e) => e.status === 'active').length },
      { label: 'Live now', value: m.live().length },
      { label: 'Queued', value: m.upcoming().length },
      { label: 'Unassigned', value: m.unassigned().length },
      { label: 'Finished', value: m.finished().length },
      { label: 'Courts free', value: this.ctx.courts().filter((c) => c.active && !m.live().some((x) => x.courtId === c.id)).length },
    ];
  });
}
