import { Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { formatGames, isLive, STATUS_LABELS, type CourtDto, type MatchDto, type Side, type TournamentDto } from '@bt/shared';
import { Api, errorMessage } from '../../core/api.service';
import { MatchStore } from '../../core/match-store';
import { BracketView } from '../../shared/components/bracket-view';
import { ConnectionBadge } from '../../shared/components/connection-badge';
import { TeamLogo } from '../../shared/components/team-logo';
import { formatLocalTime } from '../../shared/utilities/time';

type Tab = 'courts' | 'schedule' | 'upcoming' | 'results' | 'bracket';

/** Spectator view: read-only scores, upcoming matches, results and brackets. Standings are for organisers only. */
@Component({
  selector: 'bt-live-view',
  imports: [ConnectionBadge, RouterLink, FormsModule, BracketView, TeamLogo],
  providers: [MatchStore],
  template: `
    <header class="hero">
      <div class="page hero-in">
        <div class="top">
          <a routerLink="/live" class="back">← All tournaments</a>
          <span class="conn"><bt-connection /></span>
        </div>
        <h1>{{ tournament()?.name ?? '…' }}</h1>
        <p class="sub">
          @if (tournament()?.venue) { <span>{{ tournament()?.venue }}</span> }
          <span class="pill" [class.on]="store.live().length"><i></i> {{ store.live().length }} live now</span>
        </p>
      </div>
    </header>

    <nav class="tabs-wrap">
      <div class="page tabs" role="tablist">
        <button role="tab" [class.on]="tab() === 'courts'" (click)="tab.set('courts')">Courts</button>
        <button role="tab" [class.on]="tab() === 'schedule'" (click)="tab.set('schedule')">Schedule</button>
        <button role="tab" [class.on]="tab() === 'upcoming'" (click)="tab.set('upcoming')">Up next <span class="n">{{ store.upcoming().length }}</span></button>
        <button role="tab" [class.on]="tab() === 'results'" (click)="tab.set('results')">Results <span class="n">{{ store.finished().length }}</span></button>
        @if (brackets().length) { <button role="tab" [class.on]="tab() === 'bracket'" (click)="tab.set('bracket')">Brackets</button> }
      </div>
    </nav>

    <div class="page body">
      @if (error()) { <p class="error-text">{{ error() }}</p> }

      @switch (tab()) {
        @case ('courts') {
          <div class="courts">
            @for (c of courts(); track c.id) {
              @let slot = store.byCourt(c.id);
              @let m = slot.current;
              <article class="court" [class.live]="m && live(m)">
                <div class="chead">
                  <h3>{{ c.name }}</h3>
                  @if (m && live(m)) { <span class="badge live"><i></i> LIVE</span> }
                  @else if (m) { <span class="badge">{{ labels[m.status] }}</span> }
                  @else { <span class="badge idle">Free</span> }
                </div>
                @if (m) {
                  <div class="meta">{{ m.bracket }}@if (m.gameNumber) { · Game {{ m.gameNumber }} }@if (m.plannedStart && !live(m)) { · {{ time(m.plannedStart) }} }</div>
                  @for (side of sides; track side) {
                    @let tm = side === 'A' ? m.teamA : m.teamB;
                    @let g = m.score.games[m.score.currentGame];
                    <div class="team" [class.win]="m.winner === side" [class.lose]="m.winner && m.winner !== side">
                      <span class="logo">@if (tm) { <bt-team-logo [team]="tm" [size]="34" /> }</span>
                      <span class="names">
                        <span class="tname">{{ side === 'A' ? m.entryA.name : m.entryB.name }}</span>
                        @if (m.serving && live(m) && m.serving.side === side) { <span class="srv">● serving: {{ m.serving.serverName }}</span> }
                        @else if (tm) { <span class="tm">{{ tm.name }}</span> }
                      </span>
                      <span class="prev">
                        @for (pg of m.score.games; track $index; let last = $last) {
                          @if (!last || m.winner) { <span [class.took]="pg.winner === side">{{ side === 'A' ? pg.a : pg.b }}</span> }
                        }
                      </span>
                      @if (live(m) || m.score.pointsPlayed) { <span class="pts">{{ side === 'A' ? g?.a : g?.b }}</span> }
                    </div>
                  }
                } @else {
                  <p class="free">No match on this court right now.</p>
                }
                @if (slot.next[0]; as n) {
                  <div class="next">Next: <strong>{{ n.entryA.name }}</strong> vs <strong>{{ n.entryB.name }}</strong>@if (n.plannedStart) { <span class="muted"> · {{ time(n.plannedStart) }}</span> }</div>
                }
              </article>
            } @empty { <p class="muted">No courts yet.</p> }
          </div>
        }
        @case ('schedule') {
          <div class="filters">
            <input class="search" type="search" placeholder="Find a player, pair or team" [ngModel]="query()" (ngModelChange)="query.set($event)" name="q" aria-label="Find a player, pair or team" />
            <div class="chips">
              <button type="button" class="chip-btn" [class.on]="!courtFilter()" (click)="courtFilter.set('')">All courts</button>
              @for (c of courts(); track c.id) { <button type="button" class="chip-btn" [class.on]="courtFilter() === c.id" (click)="courtFilter.set(c.id)">{{ c.name }}</button> }
            </div>
          </div>
          @for (g of schedule(); track g.key) {
            <h4 class="slot">{{ g.label }}</h4>
            <div class="list">
              @for (m of g.matches; track m.id) {
                <div class="row-card" [class.dim]="m.status === 'completed' || m.status === 'walkover'">
                  <div class="court-pill">{{ m.courtName ?? '–' }}</div>
                  <div class="what">
                    <span class="vs"><strong>{{ m.entryA.name }}</strong><em>vs</em><strong>{{ m.entryB.name }}</strong></span>
                    <span class="muted small">{{ m.bracket }}@if (m.gameNumber) { · Game {{ m.gameNumber }} }</span>
                  </div>
                  <div class="score">
                    @if (live(m)) { <span class="badge live"><i></i> LIVE</span> }
                    @else if (m.status === 'completed' || m.status === 'retired') { {{ formatGames(m.score.games) }} }
                    @else if (m.status === 'walkover') { W/O }
                    @else if (m.status === 'called') { <span class="called">Called</span> }
                  </div>
                </div>
              }
            </div>
          } @empty { <p class="muted">{{ query() || courtFilter() ? 'No matches found.' : 'The schedule has not been published yet.' }}</p> }
        }
        @case ('upcoming') {
          <div class="list">
            @for (m of store.upcoming(); track m.id) {
              <div class="row-card">
                <div class="when">{{ m.plannedStart ? time(m.plannedStart) : '–' }}</div>
                <div class="what">
                  <span class="vs"><strong>{{ m.entryA.name }}</strong><em>vs</em><strong>{{ m.entryB.name }}</strong></span>
                  <span class="muted small">{{ m.bracket }}@if (m.courtName) { · {{ m.courtName }} }@if (m.status === 'called') { · <b class="called">Called to court</b> }</span>
                </div>
              </div>
            } @empty { <p class="muted">Nothing scheduled.</p> }
          </div>
        }
        @case ('results') {
          <div class="list">
            @for (m of store.finished(); track m.id) {
              <div class="row-card">
                <div class="what">
                  @if (m.status === 'cancelled') { <span class="muted">Cancelled · {{ m.entryA.name }} vs {{ m.entryB.name }}</span> }
                  @else {
                    <span class="vs"><strong>{{ m.winner === 'A' ? m.entryA.name : m.entryB.name }}</strong> <span class="muted">def.</span> {{ m.winner === 'A' ? m.entryB.name : m.entryA.name }}</span>
                    <span class="muted small">{{ m.bracket }}@if (m.courtName) { · {{ m.courtName }} }</span>
                  }
                </div>
                <div class="score">{{ m.status === 'walkover' ? 'W/O' : formatGames(m.score.games) }}{{ m.status === 'retired' ? ' ret.' : '' }}</div>
              </div>
            } @empty { <p class="muted">No results yet.</p> }
          </div>
        }
        @case ('bracket') {
          @for (b of brackets(); track b.id) { <div class="panel bracket"><h3>{{ b.name }}</h3><bt-bracket-view [matches]="b.matches" /></div> }
        }
      }
    </div>
  `,
  styles: `
    :host { display: block; padding-bottom: 32px; }
    .hero { background: linear-gradient(135deg, #0f766e 0%, #0e7490 55%, #1d4ed8 100%); color: #fff; padding: 18px 0 44px; }
    .hero-in { padding-bottom: 0; }
    .top { display: flex; justify-content: space-between; align-items: center; }
    .back { color: rgba(255,255,255,.85); text-decoration: none; font-size: 13px; }
    .conn { background: rgba(255,255,255,.92); border-radius: 999px; padding: 4px 12px; }
    h1 { margin: 12px 0 6px; font-size: clamp(26px, 6vw, 40px); }
    .sub { margin: 0; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; opacity: .95; font-size: 14px; }
    .pill { display: inline-flex; align-items: center; gap: 6px; background: rgba(255,255,255,.18); padding: 3px 12px; border-radius: 999px; font-weight: 600; }
    .pill i { width: 8px; height: 8px; border-radius: 50%; background: #cbd5e1; }
    .pill.on i { background: #4ade80; animation: pulse 1.4s ease-in-out infinite; }

    .tabs-wrap { position: sticky; top: 0; z-index: 5; margin-top: -26px; }
    .tabs { display: flex; gap: 6px; padding-top: 0; padding-bottom: 0; }
    .tabs button { flex: 1; border: 0; background: #fff; color: var(--bt-ink); font: inherit; font-weight: 700; padding: 12px 10px; border-radius: 14px; cursor: pointer;
      box-shadow: var(--bt-shadow); display: inline-flex; align-items: center; justify-content: center; gap: 6px; white-space: nowrap; }
    .tabs button.on { background: var(--bt-brand); color: #fff; }
    .n { background: rgba(15,23,42,.08); border-radius: 999px; padding: 0 8px; font-size: 12px; }
    .tabs button.on .n { background: rgba(255,255,255,.25); }
    .body { padding-top: 18px; }

    .courts { display: grid; gap: 14px; grid-template-columns: repeat(auto-fill, minmax(min(100%, 340px), 1fr)); }
    .court { background: #fff; border: 1px solid var(--bt-border); border-radius: 20px; padding: 16px; box-shadow: var(--bt-shadow); }
    .court.live { border-color: #34d399; box-shadow: 0 0 0 3px rgba(16,185,129,.16), var(--bt-shadow); }
    .chead { display: flex; justify-content: space-between; align-items: center; }
    h3 { margin: 0; font-size: 18px; font-weight: 800; }
    .badge { font-size: 11px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; padding: 4px 10px; border-radius: 999px; background: #eef2f7; color: #475569; display: inline-flex; align-items: center; gap: 6px; }
    .badge.live { background: #d1fae5; color: #047857; }
    .badge.live i { width: 7px; height: 7px; border-radius: 50%; background: #10b981; animation: pulse 1.4s ease-in-out infinite; }
    .badge.idle { background: #f1f5f9; color: #94a3b8; }
    @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
    .meta { color: var(--bt-muted); font-size: 13px; margin: 6px 0 10px; }
    .team { display: flex; align-items: center; gap: 10px; padding: 8px 0; }
    .team + .team { border-top: 1px dashed var(--bt-border); }
    .logo { width: 34px; flex: none; display: inline-flex; justify-content: center; }
    .names { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .tname { font-size: 16px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tm { font-size: 12px; color: var(--bt-muted); }
    .srv { font-size: 12px; color: #d97706; font-weight: 700; }
    .team.win .tname { color: #047857; }
    .team.lose { opacity: .6; }
    .prev { display: flex; gap: 8px; color: #94a3b8; font-variant-numeric: tabular-nums; font-size: 15px; }
    .prev .took { color: var(--bt-ink); font-weight: 700; }
    .pts { min-width: 2ch; text-align: right; font-size: 34px; font-weight: 800; line-height: 1; font-variant-numeric: tabular-nums; }
    .free { color: var(--bt-muted); margin: 14px 0; }
    .next { margin-top: 12px; padding-top: 12px; line-height: 1.5; border-top: 1px solid var(--bt-border); font-size: 13px; color: #334155; }
    .muted { color: var(--bt-muted); }

    .list { display: grid; gap: 10px; }
    .row-card { display: flex; gap: 14px; align-items: center; justify-content: space-between; background: #fff; border: 1px solid var(--bt-border); border-radius: 16px; padding: 12px 16px; box-shadow: var(--bt-shadow); }
    .when { font-weight: 800; color: var(--bt-brand); min-width: 64px; font-variant-numeric: tabular-nums; }
    .what { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .vs { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 8px; }
    .vs em { font-style: normal; color: var(--bt-muted); font-size: .85em; }
    .score { font-weight: 700; font-variant-numeric: tabular-nums; text-align: right; }
    .called { color: #6d28d9; }
    .bracket { margin-bottom: 14px; }
    .filters { display: grid; gap: 10px; margin-bottom: 8px; }
    .search { font: inherit; padding: 12px 14px; border: 1px solid var(--bt-border); border-radius: 14px; background: #fff; box-shadow: var(--bt-shadow); width: 100%; box-sizing: border-box; }
    .chips { display: flex; gap: 6px; overflow-x: auto; padding-bottom: 2px; }
    .chip-btn { border: 1px solid var(--bt-border); background: #fff; font: inherit; font-weight: 600; font-size: 13px; padding: 6px 14px; border-radius: 999px; cursor: pointer; white-space: nowrap; }
    .chip-btn.on { background: #ccfbf1; border-color: #5eead4; color: #115e59; }
    .slot { margin: 18px 0 8px; font-size: 14px; font-weight: 800; color: var(--bt-brand); letter-spacing: .02em; }
    .court-pill { min-width: 64px; text-align: center; background: #eef2ff; color: #3730a3; font-weight: 700; font-size: 12px; padding: 6px 10px; border-radius: 10px; }
    .row-card.dim { opacity: .65; }
  `,
})
export class LiveView implements OnInit {
  readonly tournamentId = input.required<string>();
  readonly store = inject(MatchStore);
  private readonly api = inject(Api);
  readonly tournament = signal<TournamentDto | null>(null);
  readonly courts = signal<CourtDto[]>([]);
  readonly labels = STATUS_LABELS;
  readonly sides: Side[] = ['A', 'B'];
  readonly brackets = computed(() => {
    const out = new Map<string, { id: string; name: string; matches: MatchDto[] }>();
    for (const m of this.store.all()) {
      if (!m.stage) continue;
      const e = out.get(m.categoryId) ?? { id: m.categoryId, name: m.bracket.replace(/ · .*$/, '').replace(/ (Quarterfinal|Semifinal|Final|Third place|Round of \d+)$/, ''), matches: [] };
      e.matches.push(m);
      out.set(m.categoryId, e);
    }
    return [...out.values()];
  });
  readonly tab = signal<Tab>('courts');
  readonly query = signal('');
  readonly courtFilter = signal('');
  /** The published plan: matches grouped by start time, filtered by court or a name search. */
  readonly schedule = computed(() => {
    const q = this.query().trim().toLowerCase();
    const court = this.courtFilter();
    const rows = this.store
      .all()
      .filter((m) => m.plannedStart && m.status !== 'cancelled' && (!court || m.courtId === court))
      .filter((m) => !q || `${m.entryA.name} ${m.entryB.name} ${m.teamA?.name ?? ''} ${m.teamB?.name ?? ''} ${m.bracket}`.toLowerCase().includes(q))
      .sort((a, b) => a.plannedStart!.localeCompare(b.plannedStart!) || (a.gameNumber ?? 0) - (b.gameNumber ?? 0));
    const groups: { key: string; label: string; matches: MatchDto[] }[] = [];
    for (const m of rows) {
      const g = groups.at(-1);
      if (g && g.key === m.plannedStart) g.matches.push(m);
      else groups.push({ key: m.plannedStart!, label: formatLocalTime(m.plannedStart!), matches: [m] });
    }
    return groups;
  });
  readonly error = signal('');
  readonly formatGames = formatGames;
  readonly live = (m: MatchDto) => isLive(m.status);

  time(iso: string) {
    return formatLocalTime(iso);
  }

  ngOnInit() {
    const id = this.tournamentId();
    Promise.all([
      this.api.get<TournamentDto>(`/tournaments/${id}`).then((t) => this.tournament.set(t)),
      this.api.get<CourtDto[]>('/courts', { tournamentId: id }).then((c) => this.courts.set(c)),
      this.store.connect(id),
    ]).catch((e) => this.error.set(errorMessage(e)));
  }
}
