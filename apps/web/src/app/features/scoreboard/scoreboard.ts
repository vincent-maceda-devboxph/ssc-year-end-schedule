import { Component, DestroyRef, OnInit, inject, input, signal } from '@angular/core';
import { isLive, STATUS_LABELS, type CourtDto, type MatchDto, type Side, type TournamentDto } from '@bt/shared';
import { Api } from '../../core/api.service';
import { MatchStore } from '../../core/match-store';
import { ConnectionBadge } from '../../shared/components/connection-badge';
import { TeamLogo } from '../../shared/components/team-logo';
import { formatLocalTime } from '../../shared/utilities/time';

/** Big-screen scoreboard for a TV or projector: one tile per court, a QR code for the live scores, what is up next. */
@Component({
  selector: 'bt-scoreboard',
  imports: [TeamLogo, ConnectionBadge],
  providers: [MatchStore],
  template: `
    <div class="board">
      <header>
        <div class="title">
          <h1>{{ tournament()?.name }}</h1>
          @if (tournament()?.venue) { <span class="venue">{{ tournament()?.venue }}</span> }
        </div>
        <div class="right">
          <span class="clock">{{ clock() }}</span>
          <span class="conn"><bt-connection /></span>
        </div>
      </header>

      <div class="layout">
        <section class="courts">
          @for (c of courts(); track c.id) {
            @let slot = store.byCourt(c.id);
            @let m = slot.current;
            <article class="court" [class.live]="m && isLive(m.status)" [class.idle]="!m">
              <div class="chead">
                <span class="cname">{{ c.name }}</span>
                @if (m && isLive(m.status)) { <span class="state live"><i></i> LIVE</span> }
                @else if (m) { <span class="state">{{ labels[m.status] }}</span> }
                @else { <span class="state">Free</span> }
              </div>
              @if (m) {
                <div class="meta">{{ m.bracket }}@if (m.gameNumber) { · Game {{ m.gameNumber }} }@if (m.plannedStart && !isLive(m.status)) { · {{ time(m.plannedStart) }} }</div>
                @for (side of sides; track side) {
                  @let tm = side === 'A' ? m.teamA : m.teamB;
                  @let g = m.score.games[m.score.currentGame];
                  <div class="team" [class.win]="m.winner === side" [class.lose]="m.winner && m.winner !== side">
                    <span class="logo">@if (tm) { <bt-team-logo [team]="tm" [size]="52" /> }</span>
                    <span class="names">
                      <span class="tname">{{ side === 'A' ? m.entryA.name : m.entryB.name }}</span>
                      @if (m.serving && isLive(m.status) && m.serving.side === side) { <span class="srv">● serving: {{ m.serving.serverName }}</span> }
                      @else if (tm) { <span class="tm">{{ tm.name }}</span> }
                    </span>
                    <span class="prev">
                      @for (pg of m.score.games; track $index; let last = $last) {
                        @if (!last || m.winner) { <span [class.took]="pg.winner === side">{{ side === 'A' ? pg.a : pg.b }}</span> }
                      }
                    </span>
                    @if (isLive(m.status) || !m.winner) { <span class="pts">{{ isLive(m.status) || m.score.pointsPlayed ? (side === 'A' ? g?.a : g?.b) : '' }}</span> }
                  </div>
                }
              } @else if (slot.next[0]; as n) {
                <div class="empty"><span>Next up</span><strong>{{ n.entryA.name }}</strong><em>vs</em><strong>{{ n.entryB.name }}</strong></div>
              } @else {
                <div class="empty"><span>No match on this court</span></div>
              }
            </article>
          } @empty { <p class="none">No courts set up yet.</p> }
        </section>

        <aside class="side">
          @if (qr(); as q) {
            <div class="qr-card">
              <img [src]="q.png" alt="QR code for the live scores" />
              <strong>Scan for live scores</strong>
              <span class="url">{{ q.url }}</span>
            </div>
          }
          <div class="next">
            <h2>Up next</h2>
            @for (n of store.upcoming().slice(0, 5); track n.id) {
              <div class="nx">
                <span class="when">{{ n.plannedStart ? time(n.plannedStart) : '–' }}</span>
                <span class="who"><strong>{{ n.entryA.name }}</strong><em>vs</em><strong>{{ n.entryB.name }}</strong></span>
                <span class="where">{{ n.courtName ?? '' }}</span>
              </div>
            } @empty { <p class="muted">Nothing scheduled.</p> }
          </div>
        </aside>
      </div>
    </div>
  `,
  styles: `
    :host { display: block; min-height: 100vh; color: #f1f5f9; font-family: Roboto, system-ui, sans-serif;
      background: radial-gradient(1200px 600px at 85% -10%, rgba(14,165,233,.22), transparent 60%), radial-gradient(900px 500px at 0% 100%, rgba(16,185,129,.16), transparent 60%), #0b1220; }
    .board { padding: clamp(12px, 1.6vw, 32px); display: flex; flex-direction: column; gap: clamp(10px, 1.4vw, 24px); box-sizing: border-box; min-height: 100vh; }
    header { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
    h1 { margin: 0; font-size: clamp(22px, 2.8vw, 54px); font-weight: 800; letter-spacing: -.02em; }
    .venue { color: #94a3b8; font-size: clamp(13px, 1.3vw, 24px); }
    .right { display: flex; align-items: center; gap: 16px; }
    .clock { font-size: clamp(20px, 2.6vw, 48px); font-weight: 700; font-variant-numeric: tabular-nums; color: #5eead4; }
    .conn { background: rgba(255,255,255,.92); border-radius: 999px; padding: 4px 12px; }

    .layout { display: grid; gap: clamp(10px, 1.4vw, 24px); grid-template-columns: minmax(0, 1fr) clamp(220px, 20vw, 380px); flex: 1; align-items: start; }
    .courts { display: grid; gap: clamp(10px, 1.2vw, 20px); grid-template-columns: repeat(auto-fit, minmax(min(100%, 30rem), 1fr)); }

    .court { background: linear-gradient(180deg, rgba(30,41,59,.92), rgba(15,23,42,.92)); border: 1px solid #1e3a5f; border-radius: 22px; padding: clamp(12px, 1.4vw, 26px); box-shadow: 0 10px 30px rgba(0,0,0,.35); }
    .court.live { border-color: #10b981; box-shadow: 0 0 0 1px #10b981, 0 0 36px rgba(16,185,129,.25); }
    .court.idle { opacity: .75; }
    .chead { display: flex; justify-content: space-between; align-items: center; }
    .cname { font-size: clamp(16px, 1.7vw, 32px); font-weight: 800; color: #5eead4; letter-spacing: .06em; text-transform: uppercase; }
    .state { font-size: clamp(11px, 1vw, 18px); font-weight: 700; color: #94a3b8; letter-spacing: .08em; text-transform: uppercase; display: inline-flex; align-items: center; gap: 6px; }
    .state.live { color: #34d399; }
    .state i { width: .7em; height: .7em; border-radius: 50%; background: #34d399; animation: pulse 1.4s ease-in-out infinite; }
    @keyframes pulse { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: .35; transform: scale(.7); } }
    .meta { color: #94a3b8; font-size: clamp(11px, 1.05vw, 19px); margin: 6px 0 clamp(8px, 1vw, 16px); letter-spacing: .02em; }

    .team { display: flex; align-items: center; gap: clamp(8px, 1vw, 18px); padding: clamp(6px, .7vw, 12px) 0; }
    .team + .team { border-top: 1px solid rgba(148,163,184,.2); }
    .logo { flex: none; display: inline-flex; justify-content: center; }
    .names { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
    .tname { font-size: clamp(16px, 1.9vw, 36px); font-weight: 700; line-height: 1.15; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tm { color: #94a3b8; font-size: clamp(11px, 1vw, 18px); }
    .srv { color: #fbbf24; font-size: clamp(11px, 1vw, 18px); font-weight: 700; }
    .team.win .tname { color: #fcd34d; }
    .team.lose { opacity: .6; }
    .prev { display: flex; gap: clamp(6px, .8vw, 14px); color: #64748b; font-size: clamp(14px, 1.6vw, 30px); font-variant-numeric: tabular-nums; }
    .prev .took { color: #cbd5e1; font-weight: 700; }
    .pts { min-width: 2.4ch; text-align: right; font-size: clamp(34px, 4.6vw, 88px); font-weight: 800; font-variant-numeric: tabular-nums; line-height: 1; color: #fff; }
    .empty { display: flex; flex-direction: column; gap: 6px; padding: clamp(10px, 1.4vw, 28px) 0; color: #94a3b8; font-size: clamp(14px, 1.5vw, 28px); }
    .empty strong { color: #e2e8f0; font-size: clamp(16px, 1.8vw, 34px); }
    .empty em { font-style: normal; font-size: .8em; }
    .none { color: #94a3b8; }

    .side { display: flex; flex-direction: column; gap: clamp(10px, 1.2vw, 20px); }
    .qr-card { background: #fff; color: #0f172a; border-radius: 22px; padding: clamp(12px, 1.2vw, 22px); display: flex; flex-direction: column; align-items: center; gap: 8px; text-align: center; box-shadow: 0 10px 30px rgba(0,0,0,.35); }
    .qr-card img { width: 100%; max-width: 20rem; height: auto; image-rendering: pixelated; }
    .qr-card strong { font-size: clamp(14px, 1.4vw, 26px); }
    .url { color: #475569; font-size: clamp(10px, .9vw, 16px); word-break: break-all; }
    .next { background: rgba(30,41,59,.7); border: 1px solid #1e3a5f; border-radius: 22px; padding: clamp(12px, 1.2vw, 22px); }
    .next h2 { margin: 0 0 8px; font-size: clamp(13px, 1.2vw, 22px); color: #5eead4; text-transform: uppercase; letter-spacing: .08em; }
    .nx { display: grid; grid-template-columns: auto 1fr; gap: 3px 14px; padding: 10px 0; align-items: start; border-top: 1px solid rgba(148,163,184,.18); font-size: clamp(12px, 1.05vw, 19px); }
    .nx:first-of-type { border-top: 0; }
    .when { color: #fbbf24; font-weight: 700; font-variant-numeric: tabular-nums; }
    .who { display: flex; flex-direction: column; gap: 1px; line-height: 1.25; }
    .who em { font-style: normal; color: #64748b; font-size: .8em; margin: 0; }
    .who strong { font-weight: 700; }
    .where { grid-column: 2; color: #94a3b8; font-size: .85em; }
    .muted { color: #94a3b8; }

    @media (max-width: 1000px) { .layout { grid-template-columns: 1fr; } .courts { grid-template-columns: 1fr; } .qr-card img { max-width: 14rem; } }
  `,
})
export class Scoreboard implements OnInit {
  readonly tournamentId = input.required<string>();
  readonly store = inject(MatchStore);
  private readonly api = inject(Api);
  private readonly destroyRef = inject(DestroyRef);
  readonly tournament = signal<TournamentDto | null>(null);
  readonly courts = signal<CourtDto[]>([]);
  readonly qr = signal<{ url: string; png: string } | null>(null);
  readonly clock = signal('');
  readonly labels = STATUS_LABELS;
  readonly isLive = isLive;
  readonly sides: Side[] = ['A', 'B'];

  time(iso: string) {
    return formatLocalTime(iso);
  }

  ngOnInit() {
    const id = this.tournamentId();
    void this.api.get<TournamentDto>(`/tournaments/${id}`).then((t) => this.tournament.set(t));
    void this.api.get<CourtDto[]>('/courts', { tournamentId: id }).then((c) => this.courts.set(c));
    void this.api.get<{ url: string; png: string }>(`/tournaments/${id}/live-qr`).then((q) => this.qr.set(q)).catch(() => undefined);
    void this.store.connect(id);
    const tick = () => this.clock.set(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    tick();
    const timer = setInterval(tick, 15_000);
    this.destroyRef.onDestroy(() => clearInterval(timer));
  }
}

export type { MatchDto };
