import { MatMenuModule } from '@angular/material/menu';
import { Component, OnInit, computed, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import {
  isFinal,
  isLive,
  type MatchDto,
  type MoveMatchResult,
  type ScheduleIssue,
  type SchedulePreview,
  type ScheduleSettings,
  type ScheduleVersionDto,
} from '@bt/shared';
import { Api, apiError, errorMessage } from '../../core/api.service';
import { formatDateTime, formatTime, isoToZonedInput, zonedInputToIso } from '../../shared/utilities/time';
import { TournamentContext } from '../tournaments/tournament-context';
import { ScheduleBoard, type BoardCell, type BoardMove } from './schedule-board';

@Component({
  selector: 'bt-schedule-tab',
  imports: [MatMenuModule, FormsModule, MatButtonModule, MatButtonToggleModule, MatCheckboxModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatIconModule, ScheduleBoard],
  template: `
    <section class="panel no-print">
      <h3>Schedule settings</h3>
      <div class="row">
        <mat-form-field appearance="outline"><mat-label>Start (first match)</mat-label>
          <input matInput type="datetime-local" [(ngModel)]="form.start" name="start" /></mat-form-field>
        <mat-form-field appearance="outline"><mat-label>End of play (optional)</mat-label>
          <input matInput type="datetime-local" [(ngModel)]="form.end" name="end" /></mat-form-field>
        <mat-form-field appearance="outline" class="num"><mat-label>Match minutes</mat-label>
          <input matInput type="number" min="5" max="240" [(ngModel)]="form.matchMinutes" name="mm" /></mat-form-field>
        <mat-form-field appearance="outline" class="num"><mat-label>Rest (slots)</mat-label>
          <input matInput type="number" min="0" max="10" [(ngModel)]="form.minRestSlots" name="rest" />
          </mat-form-field>
        <mat-form-field appearance="outline" class="num"><mat-label>Variation (seed)</mat-label>
          <input matInput type="number" min="0" [(ngModel)]="form.seed" name="seed" /></mat-form-field>
      </div>
      <div class="row opts">
        <mat-checkbox [(ngModel)]="form.affinity" name="aff">Keep a category on the same court</mat-checkbox>
        <mat-form-field appearance="outline" class="earlier">
          <mat-label>Play these earlier</mat-label>
          <mat-select multiple [(ngModel)]="earlier" name="earlier">
            @for (l of levelOptions(); track l.key) { <mat-option [value]="l.key">{{ l.label }}</mat-option> }
          </mat-select>
          <mat-hint>Preview to see the new times, then save and publish</mat-hint>
        </mat-form-field>
        @if (earlier.length) {
          <mat-form-field appearance="outline" class="nb"><mat-label>…but not before</mat-label>
            <input matInput type="datetime-local" [(ngModel)]="earlierFrom" name="earlierFrom" />
            <mat-hint>e.g. the second slot, so the first stays as it is</mat-hint>
          </mat-form-field>
          <mat-form-field appearance="outline" class="nb"><mat-label>…and finished by</mat-label>
            <input matInput type="datetime-local" [(ngModel)]="earlierUntil" name="earlierUntil" />
            <mat-hint>e.g. 4:00 PM: the last of these matches ends by then</mat-hint>
          </mat-form-field>
        }
        <mat-form-field appearance="outline"><mat-label>Order of pairs</mat-label>
          <mat-select [(ngModel)]="form.rankOrder" name="rko">
            <mat-option value="low_first">Lowest pairs first, top pair (A) last</mat-option>
            <mat-option value="high_first">Top pair (A) first</mat-option>
            <mat-option value="none">No preference</mat-option>
          </mat-select></mat-form-field>
        <mat-form-field appearance="outline" class="num"><mat-label>Max matches per team at once</mat-label>
          <input matInput type="number" min="1" [(ngModel)]="form.maxTeam" name="maxteam" /></mat-form-field>
        <mat-form-field appearance="outline" class="tz"><mat-label>Timezone</mat-label>
          <input matInput [(ngModel)]="form.timezone" name="tz" /></mat-form-field>
        <mat-form-field appearance="outline" class="nb"><mat-label>Reschedule: nothing before</mat-label>
          <input matInput type="datetime-local" [(ngModel)]="notBefore" name="nb" />
          <mat-hint>After a delay: moves everything not started to this time or later</mat-hint></mat-form-field>
        <button mat-stroked-button (click)="setNow()" type="button">Now</button>
        <span class="grow"></span>
        <button mat-stroked-button (click)="shuffle()" [disabled]="busy()"><mat-icon>shuffle</mat-icon> Another variation</button>
        <button mat-flat-button (click)="runPreview()" [disabled]="busy()"><mat-icon>visibility</mat-icon> Preview schedule</button>
      </div>
      <p class="muted small">
        Courts: {{ activeCourts() }} active · {{ openMatches() }} matches to place.
        The same variation number always gives the same schedule. Preview changes nothing until you save and publish.
      </p>
      @if (openMatches() === 0) { <p class="error-text">There are no matches to schedule yet. Go to the <strong>Matches</strong> tab and click <strong>Generate</strong> first (teams, pairs and divisions must exist). Rest (slots): 1 means a player never plays two matches back to back.</p> }
      @if (error()) { <p class="error-text">{{ error() }}</p> }
      @if (notice()) { <p class="notice">{{ notice() }}</p> }
    </section>

    @if (preview(); as p) {
      <section class="panel result no-print">
        <div class="row">
          <h3 class="grow">
            @if (viewing(); as v) { Version {{ v.version }} <span class="chip" [class.live]="v.status === 'published'">{{ v.status }}</span>@if (v.label) { <span class="muted small"> · {{ v.label }}</span> } }
            @else { Preview }
          </h3>
          <button mat-button (click)="closeView()">{{ viewing() ? 'Close' : 'Discard' }}</button>
          @if (viewing(); as v) {
            @if (v.status === 'draft') { <button mat-flat-button (click)="publish(v)" [disabled]="busy()"><mat-icon>publish</mat-icon> Publish this version</button> }
          } @else {
            <button mat-flat-button (click)="save()" [disabled]="busy() || !!p.conflicts.length || !p.assignments.length"><mat-icon>save</mat-icon> Save as draft</button>
          }
        </div>
        <div class="chips">
          <span class="stat"><b>{{ p.stats.scheduled }}</b> of {{ p.stats.matches }} scheduled</span>
          <span class="stat"><b>{{ p.stats.slots }}</b> time slots</span>
          <span class="stat">Ends <b>{{ time(p.stats.estimatedEnd) }}</b></span>
          <span class="stat"><b>{{ p.stats.emptyCells }}</b> empty court slots</span>
          <span class="stat">Shortest rest <b>{{ p.stats.minPlayerGapSlots === null ? '–' : p.stats.minPlayerGapSlots - 1 }}</b> slots</span>
          @if (moved(p); as n) { <span class="stat warn"><b>{{ n }}</b> already-published matches change time or court</span> }
          @if (p.stats.fixed) { <span class="stat"><b>{{ p.stats.fixed }}</b> locked / started stay put</span> }
        </div>
        @if (p.stats.pastEndTime) { <p class="error-text">This schedule finishes after the end of play.</p> }
        @if (p.conflicts.length) {
          <div class="issues bad"><strong>Conflicts – fix before saving</strong>
            <ul>@for (c of p.conflicts; track $index) { <li>{{ describeIssue(c) }}</li> }</ul></div>
        }
        @if (p.unscheduled.length) {
          <div class="issues"><strong>{{ p.unscheduled.length }} matches could not be placed</strong>
            <ul>@for (u of p.unscheduled; track u.matchId) { <li>{{ matchLabel(u.matchId) }} – {{ u.reason }}{{ u.players.length ? ' (' + u.players.join(', ') + ')' : '' }}</li> }</ul></div>
        }
        @let d = diffRows(p);
        @if (d.length) {
          <details class="diff" open>
            <summary><strong>{{ d.length }} matches already in the published plan change</strong> <span class="muted small">(before → after)</span></summary>
            <table class="simple">
              <thead><tr><th>Match</th><th>Before</th><th>After</th></tr></thead>
              <tbody>@for (r of d; track r.matchId) { <tr><td>{{ r.label }}</td><td>{{ r.from }}</td><td><strong>{{ r.to }}</strong></td></tr> }</tbody>
            </table>
          </details>
        } @else if (p.changes.length === 0 && p.assignments.length) {
          <p class="muted small">Nothing in the published plan changes.</p>
        }
        @if (p.notBefore) { <p class="muted small">Nothing that can still move is placed before {{ time(p.notBefore) }}. Live, called, locked and finished matches stay where they are.</p> }
      </section>
    }

    <section class="panel">
      <div class="row no-print">
        <mat-button-toggle-group [value]="view()" (change)="view.set($event.value)" hideSingleSelectionIndicator>
          <mat-button-toggle value="published">Current plan</mat-button-toggle>
          <mat-button-toggle value="preview" [disabled]="!preview()">Preview</mat-button-toggle>
        </mat-button-toggle-group>
        <mat-button-toggle-group [value]="layout()" (change)="layout.set($event.value)" hideSingleSelectionIndicator aria-label="Layout">
          <mat-button-toggle value="grid">Court grid</mat-button-toggle>
          <mat-button-toggle value="list">List</mat-button-toggle>
        </mat-button-toggle-group>
        @if (layout() === 'list') {
          <mat-select class="flt" [value]="groupBy()" (selectionChange)="groupBy.set($event.value)" aria-label="Group list by">
            <mat-option value="time">By time</mat-option><mat-option value="division">By division</mat-option><mat-option value="team">By team</mat-option><mat-option value="player">By player</mat-option>
          </mat-select>
        }
        <span class="grow"></span>
        <button mat-stroked-button [matMenuTriggerFor]="imgMenu" [disabled]="!boardCells().length"><mat-icon>image</mat-icon> Image</button>
        <mat-menu #imgMenu="matMenu">
          <button mat-menu-item (click)="saveImage(null)"><mat-icon>grid_view</mat-icon> All courts (one image)</button>
          @for (c of boardCourts(); track c.id) { <button mat-menu-item (click)="saveImage(c.id)"><mat-icon>sports_tennis</mat-icon> {{ c.name }} only</button> }
        </mat-menu>
        <a mat-stroked-button [href]="exportUrl()" download><mat-icon>download</mat-icon> Excel</a>
        <button mat-stroked-button (click)="print()"><mat-icon>print</mat-icon> Print</button>
        <button mat-button (click)="loadConflicts()"><mat-icon>rule</mat-icon> Check conflicts</button>
      </div>
      <div class="row filters no-print">
        <mat-select class="flt" [value]="fDivision()" (selectionChange)="fDivision.set($event.value)" placeholder="Division" aria-label="Filter by division">
          <mat-option value="">All divisions</mat-option>
          @for (c of ctx.categories(); track c.id) { <mat-option [value]="c.id">{{ c.name }}</mat-option> }
        </mat-select>
        <mat-select class="flt" [value]="fTeam()" (selectionChange)="fTeam.set($event.value)" placeholder="Team" aria-label="Filter by team">
          <mat-option value="">All teams</mat-option>
          @for (t of ctx.teams(); track t.id) { <mat-option [value]="t.id">{{ t.name }}</mat-option> }
        </mat-select>
        <input class="flt txt" placeholder="Player, pair or level (e.g. MD-A)" [ngModel]="fPlayer()" (ngModelChange)="fPlayer.set($event)" name="fplayer" aria-label="Filter by player or pair" />
        @if (highlight(); as h) { <span class="muted small">{{ h.size }} matches highlighted</span><button mat-button (click)="clearFilters()">Clear filters</button> }
      </div>
      @if (conflicts(); as cs) {
        <div class="issues" [class.bad]="cs.length"><strong>{{ cs.length ? cs.length + ' conflicts in the current plan' : 'No conflicts in the current plan' }}</strong>
          @if (cs.length) { <ul>@for (c of cs; track $index) { <li>{{ describeIssue(c) }}</li> }</ul> }</div>
      }
      @if (moveIssues().length) {
        <div class="issues bad" role="alert">
          <div class="row"><strong>That change was not made</strong><span class="grow"></span><button mat-button (click)="moveIssues.set([])">Dismiss</button></div>
          <ul>@for (c of moveIssues(); track $index) { <li>{{ describeIssue(c) }}</li> }</ul>
        </div>
      }
      @if (view() === 'published' && boardSettings()) {
        <p class="muted small">Drag a match to another court or time, onto another match to swap, or to the tray to take it off the schedule. Lock a match (padlock) to keep it when you regenerate. Use the megaphone to call a match to its court.</p>
      }
      @if (layout() === 'list') {
        @for (g of listGroups(); track g.title) {
          <h4 class="grp">{{ g.title }}</h4>
          <table class="simple list">
            <thead><tr><th>Game</th><th>Time</th><th>Court</th><th>Division</th><th>Match</th><th>Status</th></tr></thead>
            <tbody>
              @for (m of g.rows; track m.id) {
                <tr><td>{{ m.gameNumber ?? '–' }}</td><td>{{ m.plannedStart ? hhmm(m.plannedStart) : '–' }}</td><td>{{ m.courtName ?? '–' }}</td>
                  <td>{{ m.bracket }}</td><td>{{ m.entryA.name }} <span class="muted">vs</span> {{ m.entryB.name }}</td><td>{{ m.status.replace('_', ' ') }}</td></tr>
              }
            </tbody>
          </table>
        } @empty { <p class="muted">No matches to list.</p> }
      } @else if (boardSettings(); as s) {
        @if (boardCells().length || (view() === 'published' && unscheduled().length)) {
          <bt-schedule-board #board class="board" [title]="ctx.tournament()?.name ?? 'Tournament'" [subtitle]="imageSubtitle()"
            [courts]="boardCourts()" [cells]="boardCells()" [matches]="matchMap()" [unscheduled]="view() === 'published' ? unscheduled() : []"
            [startAt]="s.startAt!" [matchMinutes]="s.matchMinutes" [timezone]="s.timezone"
            [editable]="view() === 'published'" [highlight]="highlight()"
            (lockToggle)="lock($event.matchId, $event.locked)" (callToggle)="call($event.matchId, $event.call)"
            (moveRequest)="onMove($event)" />
        } @else {
          <p class="muted">{{ view() === 'preview' ? 'Nothing to show.' : 'No published schedule yet. Set the times above, preview, save and publish.' }}</p>
        }
      } @else { <p class="muted">Set a start time to see the schedule.</p> }
    </section>

    <section class="panel no-print">
      <h3>Versions</h3>
      <table class="simple">
        <thead><tr><th>#</th><th>Status</th><th>Label</th><th>Matches</th><th>Ends</th><th>Saved by</th><th></th></tr></thead>
        <tbody>
          @for (v of versions(); track v.id) {
            <tr>
              <td>{{ v.version }}</td>
              <td><span class="chip" [class.live]="v.status === 'published'">{{ v.status }}</span></td>
              <td>{{ v.label }}</td>
              <td>{{ v.matchCount }}</td>
              <td>{{ time(v.estimatedEnd) }}</td>
              <td class="muted small">{{ v.createdBy }} · {{ dateTime(v.publishedAt ?? v.createdAt) }}</td>
              <td class="nowrap"><button mat-stroked-button (click)="viewVersion(v)" [disabled]="busy()"><mat-icon>visibility</mat-icon> View</button>@if (v.status === 'draft') { <button mat-flat-button (click)="publish(v)" [disabled]="busy()">Publish</button> }</td>
            </tr>
          } @empty { <tr><td colspan="7" class="muted">Nothing saved yet.</td></tr> }
        </tbody>
      </table>
      <p class="muted small">Publishing sets each match's court and time, and updates umpires' phones and spectators right away. Matches that are live or finished are never moved.</p>
    </section>
  `,
  styles: `
    :host { display: flex; flex-direction: column; gap: 16px; padding-top: 16px; }
    h3 { margin: 0 0 8px; font-weight: 500; }
    .nowrap { white-space: nowrap; }
    .num { width: 150px; } .tz { width: 170px; } .earlier { min-width: 220px; }
    .opts { margin-top: 4px; }
    .notice { background: #e8f5e9; padding: 8px 12px; border-radius: 8px; margin: 8px 0 0; }
    .chips { display: flex; flex-wrap: wrap; gap: 8px; margin: 4px 0 8px; }
    .stat { background: #f1f4ef; border-radius: 999px; padding: 4px 12px; font-size: 13px; }
    .stat.warn { background: #fff3e0; }
    .issues { background: #fff8e1; border-radius: 8px; padding: 8px 12px; margin: 8px 0; font-size: 14px; }
    .issues.bad { background: #ffebee; }
    .issues ul { margin: 4px 0 0; padding-left: 20px; }
    .board { display: block; margin-top: 12px; }
    .nb { width: 250px; }
    .filters { margin: 10px 0 0; }
    .flt { min-width: 170px; background: #fff; border: 1px solid var(--bt-border); border-radius: 8px; padding: 8px 10px; }
    .flt.txt { font: inherit; width: 260px; }
    .diff { margin-top: 8px; }
    .diff table { margin-top: 6px; }
  `,
})
export class ScheduleTab implements OnInit {
  readonly ctx = inject(TournamentContext);
  private readonly api = inject(Api);

  readonly error = signal('');
  readonly notice = signal('');
  readonly busy = signal(false);
  readonly preview = signal<SchedulePreview | null>(null);
  readonly view = signal<'published' | 'preview'>('published');
  readonly versions = signal<ScheduleVersionDto[]>([]);
  readonly conflicts = signal<ScheduleIssue[] | null>(null);
  readonly settings = signal<ScheduleSettings | null>(null);

  /** Reschedule after a delay: nothing that can still move is placed before this time (wall time in the tournament timezone). */
  notBefore = '';
  /** "Play these earlier" may not use a slot before this time (wall time in the tournament timezone). */
  earlierFrom = '';
  /** ...and every match of those levels must be finished by this time. */
  earlierUntil = '';
  private earlierUntilIso(): string | null {
    return this.earlier.length && this.earlierUntil ? zonedInputToIso(this.earlierUntil, this.form.timezone) : null;
  }
  private earlierFromIso(): string | null {
    return this.earlier.length && this.earlierFrom ? zonedInputToIso(this.earlierFrom, this.form.timezone) : null;
  }
  readonly fDivision = signal('');
  readonly fTeam = signal('');
  readonly fPlayer = signal('');
  readonly layout = signal<'grid' | 'list'>('grid');
  /** The saved version being looked at (null = a fresh preview or nothing). */
  readonly viewing = signal<ScheduleVersionDto | null>(null);

  /** Open a saved version on the board, with the list of what it changes compared with the published plan. */
  viewVersion(v: ScheduleVersionDto) {
    return this.run(async () => {
      this.notice.set('');
      this.preview.set(await this.api.get<SchedulePreview>(`${this.base()}/schedules/${v.id}`));
      this.viewing.set(v);
      this.view.set('preview');
      setTimeout(() => document.querySelector('.result')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
    });
  }
  closeView() {
    this.preview.set(null);
    this.viewing.set(null);
    this.view.set('published');
  }
  /** Levels ("categoryId:rank", e.g. MD-E) the organiser wants to play first. */
  earlier: string[] = [];
  /** Every level that has matches, for the "Play these earlier" picker. */
  readonly levelOptions = computed(() => {
    const seen = new Map<string, string>();
    for (const m of this.ctx.matches.all()) if (m.rank != null && !seen.has(`${m.categoryId}:${m.rank}`)) seen.set(`${m.categoryId}:${m.rank}`, m.bracket);
    return [...seen.entries()].map(([key, label]) => ({ key, label })).sort((a, b) => a.label.localeCompare(b.label));
  });
  readonly groupBy = signal<'time' | 'division' | 'team' | 'player'>('time');

  hhmm(iso: string) {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: this.settings()?.timezone || undefined });
  }

  /** The list view: filtered matches grouped by time, division, team or player (a match appears under each side). */
  readonly listGroups = computed(() => {
    const hl = this.highlight();
    const rows = this.ctx.matches.all().filter((m) => m.status !== 'cancelled' && (!hl || hl.has(m.id)));
    const sorted = (a: MatchDto, b: MatchDto) => (a.plannedStart ?? '9').localeCompare(b.plannedStart ?? '9') || (a.gameNumber ?? 0) - (b.gameNumber ?? 0) || a.matchNumber - b.matchNumber;
    const groups = new Map<string, MatchDto[]>();
    const add = (k: string, m: MatchDto) => groups.set(k, [...(groups.get(k) ?? []), m]);
    const by = this.groupBy();
    for (const m of rows) {
      if (by === 'time') add(m.plannedStart ? this.hhmm(m.plannedStart) : 'Not scheduled', m);
      else if (by === 'division') add(this.ctx.categories().find((c) => c.id === m.categoryId)?.name ?? 'Division', m);
      else if (by === 'team') for (const t of [m.teamA, m.teamB]) { if (t) add(t.name, m); }
      else for (const e of [m.entryA, m.entryB]) { if (e.id) add(e.name, m); }
    }
    return [...groups.entries()]
      .map(([title, list]) => ({ title, rows: list.sort(sorted) }))
      .sort((a, b) => (by === 'time' ? (a.rows[0]!.plannedStart ?? '9').localeCompare(b.rows[0]!.plannedStart ?? '9') : a.title.localeCompare(b.title)));
  });

  /** Matches that pass the filters (null = no filter, show everything normally). */
  readonly highlight = computed<Set<string> | null>(() => {
    const d = this.fDivision();
    const t = this.fTeam();
    const q = this.fPlayer().trim().toLowerCase();
    if (!d && !t && !q) return null;
    return new Set(
      this.ctx.matches
        .all()
        .filter(
          (m) =>
            (!d || m.categoryId === d) &&
            (!t || m.teamA?.id === t || m.teamB?.id === t) &&
            (!q || `${m.entryA.name} ${m.entryB.name} ${m.teamA?.name ?? ''} ${m.teamB?.name ?? ''} ${m.bracket}`.toLowerCase().includes(q)),
        )
        .map((m) => m.id),
    );
  });
  readonly board = viewChild<ScheduleBoard>('board');
  readonly imageSubtitle = computed(() => {
    const t = this.ctx.tournament();
    const s = this.boardSettings();
    const day = s?.startAt ? new Date(s.startAt).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : '';
    return [day, t?.venue?.trim()].filter(Boolean).join('   ·   ');
  });
  async saveImage(courtId: string | null) {
    try {
      await this.board()?.exportImage(courtId);
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }
  readonly exportUrl = computed(() => `/api/tournaments/${this.ctx.id()}/schedule/export`);

  form = { start: '', end: '', matchMinutes: 30, minRestSlots: 1, seed: 1, affinity: true, rankOrder: 'low_first' as 'low_first' | 'high_first' | 'none', maxTeam: null as number | null, timezone: 'Asia/Manila' };

  readonly activeCourts = computed(() => this.ctx.courts().filter((c) => c.active).length);
  readonly openMatches = computed(() => this.ctx.matches.all().filter((m) => !isFinal(m.status) || m.plannedStart).length);
  readonly moveIssues = signal<ScheduleIssue[]>([]);
  /** Matches without a court and time yet (shown in the tray). */
  readonly unscheduled = computed(() => this.ctx.matches.all().filter((m) => m.status === 'pending'));
  readonly matchMap = computed(() => new Map(this.ctx.matches.all().map((m) => [m.id, m])));

  /** Settings the board is drawn with (saved settings, or the preview's). */
  readonly boardSettings = computed(() => {
    const p = this.preview();
    const s = this.view() === 'preview' && p ? p.settings : this.settings();
    return s?.startAt ? s : null;
  });
  readonly boardCourts = computed(() => {
    const p = this.preview();
    if (this.view() === 'preview' && p) return p.courts;
    return this.ctx.courts().filter((c) => c.active).map((c) => ({ id: c.id, name: c.name, status: this.ctx.courtStatusOf(c) }));
  });
  readonly boardCells = computed<BoardCell[]>(() => {
    const s = this.boardSettings();
    if (!s) return [];
    const p = this.preview();
    if (this.view() === 'preview' && p) return p.assignments.map((a) => ({ matchId: a.matchId, courtId: a.courtId, slot: a.slot, gameNumber: a.gameNumber, fixed: a.fixed }));
    const start = Date.parse(s.startAt!);
    const unit = s.matchMinutes * 60_000;
    return this.ctx.matches
      .all()
      .filter((m) => m.plannedStart && m.courtId && m.gameNumber && m.status !== 'cancelled')
      .map((m) => ({
        matchId: m.id,
        courtId: m.courtId!,
        slot: Math.round((Date.parse(m.plannedStart!) - start) / unit),
        gameNumber: m.gameNumber!,
        fixed: m.isLocked || isLive(m.status) || isFinal(m.status) || m.status === 'called',
      }))
      .filter((c) => c.slot >= 0);
  });

  async ngOnInit() {
    await this.loadSettings();
    await this.loadVersions();
  }

  private base() {
    return `/tournaments/${this.ctx.id()}`;
  }

  private async run(fn: () => Promise<unknown>) {
    this.error.set('');
    this.busy.set(true);
    try {
      await fn();
    } catch (e) {
      const err = apiError(e);
      this.error.set(err?.error.code === 'no_start_time' ? 'Set the start time first.' : errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  async loadSettings() {
    try {
      const s = await this.api.get<ScheduleSettings>(`${this.base()}/schedule/settings`);
      this.settings.set(s);
      this.form = {
        start: isoToZonedInput(s.startAt, s.timezone), end: isoToZonedInput(s.endAt, s.timezone),
        matchMinutes: s.matchMinutes, minRestSlots: s.minRestSlots, seed: s.seed, affinity: s.categoryCourtAffinity, rankOrder: s.rankOrder ?? 'low_first',
        maxTeam: s.maxTeamConcurrent, timezone: s.timezone,
      };
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }

  async loadVersions() {
    try {
      this.versions.set(await this.api.get<ScheduleVersionDto[]>(`${this.base()}/schedules`));
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }

  private async saveSettings() {
    const f = this.form;
    const num = (v: unknown) => (v === null || v === '' || v === undefined ? null : Number(v));
    const s = await this.api.put<ScheduleSettings>(`${this.base()}/schedule/settings`, {
      startAt: f.start ? zonedInputToIso(f.start, f.timezone) : null,
      endAt: f.end ? zonedInputToIso(f.end, f.timezone) : null,
      timezone: f.timezone.trim() || 'Asia/Manila',
      matchMinutes: Number(f.matchMinutes),
      minRestSlots: Number(f.minRestSlots),
      seed: Number(f.seed) || 0,
      maxTeamConcurrent: num(f.maxTeam),
      categoryCourtAffinity: f.affinity,
      rankOrder: f.rankOrder,
    });
    this.settings.set(s);
  }

  runPreview() {
    return this.run(async () => {
      this.notice.set('');
      await this.saveSettings();
      this.viewing.set(null);
      this.preview.set(await this.api.post<SchedulePreview>(`${this.base()}/schedules/preview`, { notBefore: this.notBeforeIso(), earlier: this.earlier, earlierFrom: this.earlierFromIso(), earlierUntil: this.earlierUntilIso() }));
      this.view.set('preview');
    });
  }

  private notBeforeIso(): string | null {
    return this.notBefore ? zonedInputToIso(this.notBefore, this.form.timezone) : null;
  }

  setNow() {
    this.notBefore = isoToZonedInput(new Date().toISOString(), this.form.timezone);
  }

  clearFilters() {
    this.fDivision.set('');
    this.fTeam.set('');
    this.fPlayer.set('');
  }

  print() {
    window.print();
  }

  /** Before → after for matches that already have a published court and time. */
  diffRows(p: SchedulePreview) {
    const court = (id: string | null) => p.courts.find((c) => c.id === id)?.name ?? this.ctx.courts().find((c) => c.id === id)?.name ?? 'no court';
    return p.changes
      .filter((c) => c.from.start)
      .map((c) => ({
        matchId: c.matchId,
        label: this.matchLabel(c.matchId),
        from: `${court(c.from.courtId)} · ${this.time(c.from.start)}`,
        to: `${court(c.to.courtId)} · ${this.time(c.to.start)}`,
      }));
  }

  shuffle() {
    this.form.seed = Math.floor(Math.random() * 1_000_000);
    return this.runPreview();
  }

  save() {
    return this.run(async () => {
      const v = await this.api.post<ScheduleVersionDto>(`${this.base()}/schedules`, { label: this.preview()?.notBefore ? 'After a delay' : this.earlier.length ? 'Some levels earlier' : '', notBefore: this.preview()?.notBefore ?? null, earlier: this.earlier, earlierFrom: this.earlierFromIso(), earlierUntil: this.earlierUntilIso() });
      this.notice.set(`Saved as draft version ${v.version}. Publish it below when you are happy with it.`);
      this.preview.set(null);
      this.view.set('published');
      await this.loadVersions();
    });
  }

  publish(v: ScheduleVersionDto) {
    if (!confirm(`Publish version ${v.version}? Umpires and spectators will see the new courts and times right away.`)) return;
    return this.run(async () => {
      const r = await this.api.post<{ applied: number; skipped: number; cleared: number }>(`${this.base()}/schedules/publish`, { versionId: v.id });
      this.notice.set(`Published version ${v.version}: ${r.applied} matches scheduled${r.skipped ? `, ${r.skipped} skipped because they changed` : ''}.`);
      this.preview.set(null);
      this.viewing.set(null);
      this.view.set('published');
      await Promise.all([this.loadVersions(), this.ctx.matches.refresh()]);
    });
  }

  /** Drag and drop: ask the server; hard-rule problems are shown, soft-rule warnings need a confirmation. */
  async onMove(r: BoardMove) {
    this.error.set('');
    this.moveIssues.set([]);
    const body = (confirmWarnings: boolean) =>
      r.courtId === null ? { courtId: null } : { courtId: r.courtId, slot: r.slot, swapWith: r.swapWith ?? null, confirmWarnings };
    const send = (confirmWarnings: boolean) => this.api.patch<MoveMatchResult>(`/matches/${r.matchId}/schedule`, body(confirmWarnings));
    this.busy.set(true);
    try {
      let res: MoveMatchResult;
      try {
        res = await send(false);
      } catch (e) {
        const err = apiError(e);
        if (err?.error.code !== 'needs_confirmation') throw e;
        const warnings = (err.error.details as ScheduleIssue[]) ?? [];
        if (!confirm(`${warnings.map((w) => this.describeIssue(w)).join('\n')}\n\nMove it anyway?`)) return;
        res = await send(true);
      }
      if (res.match) this.ctx.matches.upsert(res.match);
      if (res.swapped) this.ctx.matches.upsert(res.swapped);
    } catch (e) {
      const err = apiError(e);
      if (err?.error.code === 'move_blocked') this.moveIssues.set(err.error.details as ScheduleIssue[]);
      else this.error.set(errorMessage(e));
      await this.ctx.matches.refresh(); // show what the server really has
    } finally {
      this.busy.set(false);
    }
  }

  call(matchId: string, call: boolean) {
    return this.run(async () => {
      this.ctx.matches.upsert(await this.api.post<MatchDto>(`/matches/${matchId}/${call ? 'call' : 'uncall'}`, {}));
    });
  }

  lock(matchId: string, locked: boolean) {
    return this.run(async () => {
      this.ctx.matches.upsert(await this.api.patch<MatchDto>(`/matches/${matchId}/lock`, { locked }));
    });
  }

  loadConflicts() {
    return this.run(async () => {
      this.conflicts.set(await this.api.get<ScheduleIssue[]>(`${this.base()}/schedules/conflicts`));
    });
  }

  /** Matches that already have a published time and would move (new placements do not count). */
  moved(p: SchedulePreview) {
    return p.changes.filter((c) => c.from.start).length;
  }

  time(iso: string | null) {
    return formatTime(iso, this.settings()?.timezone ?? 'Asia/Manila');
  }
  dateTime(iso: string | null) {
    return formatDateTime(iso, this.settings()?.timezone ?? 'Asia/Manila');
  }

  matchLabel(id: string) {
    const m = this.matchMap().get(id);
    return m ? `#${m.matchNumber} ${m.bracket}: ${m.entryA.name} vs ${m.entryB.name}` : id;
  }

  describeIssue(c: ScheduleIssue) {
    const who = c.players?.length ? ` (${c.players.join(', ')})` : '';
    return `${c.message}${who}: ${c.matchIds.map((id) => this.matchLabel(id)).join(' / ')}`;
  }
}
