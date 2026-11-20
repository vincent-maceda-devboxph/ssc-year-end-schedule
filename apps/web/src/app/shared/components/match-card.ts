import { TeamLogo } from './team-logo';
import { Component, computed, input } from '@angular/core';
import { isLive, STATUS_LABELS, type MatchDto } from '@bt/shared';
import { formatLocalTime } from '../utilities/time';

/** Compact read-only score card used by the spectator view and admin dashboard. */
@Component({
  selector: 'bt-match-card',
  imports: [TeamLogo],
  template: `
    @let m = match();
    <div class="card" [class.live]="live()">
      <div class="head">
        @if (showCourt()) { <strong>{{ m.courtName ?? 'No court' }}</strong> · }
        @if (m.gameNumber) { <span>Game {{ m.gameNumber }}</span> } @else { <span>#{{ m.matchNumber }}</span> }
        @if (m.plannedStart) { <span class="muted"> · {{ time(m.plannedStart) }}</span> }
        <span class="muted"> · {{ m.bracket }}{{ m.round ? ' · ' + m.round : '' }}</span>
        <span class="grow"></span>
        <span class="chip" [class]="chipClass()">{{ label() }}</span>
      </div>
      @if (m.serving && live()) {
        <div class="srv">Serving: <strong>{{ m.serving.serverName }}</strong> → {{ m.serving.receiverName }}</div>
      }
      @for (side of sides; track side.key) {
        <div class="line" [class.winner]="m.winner === side.key">
          <span class="serve" [class.on]="live() && m.score.servingSide === side.key" aria-hidden="true"></span>
          @let team = side.key === 'A' ? m.teamA : m.teamB;
          <span class="name">
            @if (team) { <bt-team-logo class="tl" [team]="team" [size]="22" [title]="team.name" /> }
            {{ side.key === 'A' ? m.entryA.name : m.entryB.name }}
          </span>
          @for (g of m.score.games; track $index; let last = $last) {
            @if (!last || live() || g.a + g.b > 0) {
              <span class="g" [class.current]="last && live()">{{ side.key === 'A' ? g.a : g.b }}</span>
            }
          }
        </div>
      }
      @if (m.umpireName && live()) { <div class="muted small foot">Umpire: {{ m.umpireName }}</div> }
    </div>
  `,
  styles: `
    .card { background: var(--bt-surface); border: 1px solid var(--bt-border); border-radius: 14px; padding: 14px 16px; box-shadow: var(--bt-shadow); }
    .card.live { border-color: #34d399; box-shadow: 0 0 0 3px rgba(16,185,129,.18), var(--bt-shadow); }
    .head { display: flex; gap: 4px 6px; align-items: center; flex-wrap: wrap; font-size: 13px; margin-bottom: 10px; }
    .head span { white-space: nowrap; }
    .grow { flex: 1; }
    .line { display: flex; align-items: center; gap: 8px; padding: 4px 0; font-size: 16px; }
    .line.winner .name { font-weight: 700; }
    .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .g { width: 28px; text-align: center; color: var(--bt-muted); font-variant-numeric: tabular-nums; }
    .g.current { color: inherit; font-weight: 700; font-size: 20px; width: 34px; }
    .serve { width: 8px; height: 8px; border-radius: 50%; background: transparent; flex: none; }
    .serve.on { background: var(--bt-warn); }
    .foot { margin-top: 6px; }
    .srv { font-size: 12px; color: var(--bt-warn); margin-bottom: 4px; }
    .tl { margin-right: 8px; }
  `,
})
export class MatchCard {
  readonly match = input.required<MatchDto>();
  readonly showCourt = input(true);
  readonly sides = [{ key: 'A' as const }, { key: 'B' as const }];
  readonly time = formatLocalTime;
  readonly live = computed(() => isLive(this.match().status));
  readonly label = computed(() => STATUS_LABELS[this.match().status]);
  readonly chipClass = computed(() => 'chip ' + (this.match().status === 'in_progress' ? 'live' : this.match().status));
}
