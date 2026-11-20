import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatSelectModule } from '@angular/material/select';
import { MatInputModule } from '@angular/material/input';
import { divisionCode, parsePairsText, rankLetter, type EntryDto, type LineupImportResult, type LineupRow, type ScheduleIssue } from '@bt/shared';
import { Api, errorMessage } from '../../core/api.service';
import { TeamLogo } from '../../shared/components/team-logo';
import { shrinkImage } from '../../shared/utilities/image';
import { TournamentContext } from '../tournaments/tournament-context';

/** Divisions offered in the quick picker even before they exist. */
const PRESET_DIVISIONS = ["Men's Doubles", "Women's Doubles", 'Mixed Doubles', "Men's Singles", "Women's Singles"];

/** Parse rows pasted from Excel (tab-separated) or CSV: Team, Division, Player 1, Player 2 (row order = each team's pair order). */
export function parseLineup(text: string): { rows: LineupRow[]; bad: number[] } {
  const rows: LineupRow[] = [];
  const bad: number[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    const cells = (line.includes('\t') ? line.split('\t') : line.split(',')).map((c) => c.trim());
    // Skip a header row.
    if (i === 0 && /^team$/i.test(cells[0] ?? '')) return;
    const [team, category, player1, player2] = cells;
    // Player 2 may be empty: singles divisions have one player per row.
    if (!team || !category || !player1) bad.push(i + 1);
    else rows.push({ team, category, player1, player2: player2 ?? '' });
  });
  return { rows, bad };
}

@Component({
  selector: 'bt-teams-tab',
  imports: [TeamLogo, FormsModule, MatButtonModule, MatFormFieldModule, MatInputModule, MatIconModule, MatSelectModule],
  template: `
    @if (error()) { <p class="error-text">{{ error() }}</p> }

    <section class="panel">
      <h3>Teams</h3>
      <form class="row" (ngSubmit)="addTeam()">
        <mat-form-field appearance="outline"><mat-label>Team name</mat-label>
          <input matInput [(ngModel)]="teamName" name="team" required /></mat-form-field>
        <button mat-flat-button type="submit">Add team</button>
      </form>
      <div class="teams">
        @for (t of ctx.teams(); track t.id) {
          <div class="team" [style.background]="t.color">
            <button type="button" class="logo-btn" (click)="logoFile.click()" [attr.aria-label]="'Change logo of ' + t.name" title="Click to choose a logo">
              <bt-team-logo [team]="t" [size]="40" />
            </button>
            <input #logoFile type="file" accept="image/png,image/jpeg,image/webp" hidden (change)="onLogo(t.id, $event)" />
            <input type="color" [value]="t.color" (change)="setColor(t.id, $any($event.target).value)" [attr.aria-label]="'Colour for ' + t.name" />
            <strong>{{ t.name }}</strong>
            <span class="small">{{ pairCount(t.id) }} pairs</span>
            @if (t.logoUrl) { <button type="button" class="rm" (click)="removeLogo(t.id)" aria-label="Remove logo" title="Remove logo"><mat-icon inline>hide_image</mat-icon></button> }
            <mat-select class="cap" [value]="t.captainPlayerId" (selectionChange)="setCaptain(t.id, $event.value)" placeholder="Captain" [attr.aria-label]="'Captain of ' + t.name">
              <mat-option [value]="null">No captain</mat-option>
              @for (p of playersOf(t.id); track p.id) { <mat-option [value]="p.id">{{ p.firstName }} {{ p.lastName }}</mat-option> }
            </mat-select>
            <button mat-icon-button (click)="removeTeam(t.id)" aria-label="Delete team"><mat-icon>close</mat-icon></button>
          </div>
        } @empty { <p class="muted">No teams yet. Add them here or import a lineup below.</p> }
      </div>
    </section>

    <section class="panel add">
      <h3>Add pairs to a team</h3>
      <p class="muted small">
        Pick a team and a division, then paste its pairs, <strong>one pair per line</strong>. The order is the rank:
        the first line is pair <strong>A</strong>, the next <strong>B</strong>, and so on. Names can be separated by
        <code>/</code>, <code>&amp;</code>, <code>and</code>, <code>-</code>, a comma or a tab; numbering such as "1." is ignored.
        New teams and divisions are created for you.
      </p>
      <div class="row">
        <mat-form-field appearance="outline"><mat-label>Team</mat-label>
          <mat-select [ngModel]="teamSel()" (ngModelChange)="teamSel.set($event); result.set(null)" name="teamSel">
            @for (t of ctx.teams(); track t.id) { <mat-option [value]="t.id">{{ t.name }}</mat-option> }
            <mat-option value="__new">+ New team…</mat-option>
          </mat-select></mat-form-field>
        @if (teamSel() === '__new') {
          <mat-form-field appearance="outline"><mat-label>New team name</mat-label>
            <input matInput [ngModel]="newTeam()" (ngModelChange)="newTeam.set($event)" name="newTeam" /></mat-form-field>
        }
        <mat-form-field appearance="outline"><mat-label>Division</mat-label>
          <mat-select [ngModel]="divSel()" (ngModelChange)="divSel.set($event); result.set(null)" name="divSel">
            @for (c of ctx.categories(); track c.id) { <mat-option [value]="c.id">{{ c.name }}</mat-option> }
            @for (n of missingPresets(); track n) { <mat-option [value]="'preset:' + n">{{ n }} (new)</mat-option> }
            <mat-option value="__other">+ Other division…</mat-option>
          </mat-select></mat-form-field>
        @if (divSel() === '__other') {
          <mat-form-field appearance="outline"><mat-label>Division name</mat-label>
            <input matInput [ngModel]="otherDiv()" (ngModelChange)="otherDiv.set($event)" name="otherDiv" placeholder="Mixed Doubles" /></mat-form-field>
        }
      </div>
      <mat-form-field appearance="outline" class="paste">
        <mat-label>Pairs, best pair first</mat-label>
        <textarea matInput rows="7" [ngModel]="pairText()" (ngModelChange)="pairText.set($event); result.set(null)" name="pairText"
          [placeholder]="singles() ? 'Ana Cruz\nBea Lim\nCy Tan' : 'Ana Cruz / Bea Lim\nCy Tan / Di Ong\nEli Sy / Fay Go'"></textarea>
      </mat-form-field>
      @if (pairParse().pairs.length) {
        <table class="simple preview">
          <thead><tr><th>Rank</th><th>{{ singles() ? 'Player' : 'Pair' }}</th></tr></thead>
          <tbody>
            @for (p of pairParse().pairs; track p.line; let i = $index) {
              <tr><td><strong>{{ divLabel() }}-{{ letter(startRank() + i) }}</strong></td><td>{{ p.player1 }}@if (p.player2) { <span class="muted"> / </span>{{ p.player2 }} }</td></tr>
            }
          </tbody>
        </table>
      }
      @if (pairParse().problems.length) {
        <ul class="error-text small">@for (b of pairParse().problems; track b.line) { <li>Line {{ b.line }}: {{ b.message }} ("{{ b.text.trim() }}")</li> }</ul>
      }
      <div class="row">
        <span class="muted small">{{ pairParse().pairs.length }} {{ singles() ? 'players' : 'pairs' }} read@if (startRank() > 1) {, added after the team's existing {{ startRank() - 1 }} }</span>
        <span class="grow"></span>
        <button mat-flat-button (click)="addPairs()" [disabled]="!canAddPairs() || busy()">Add {{ pairParse().pairs.length || '' }} {{ singles() ? 'players' : 'pairs' }}</button>
      </div>
      @if (result(); as p) {
        <div class="result" [class.bad]="p.errors.length">
          @if (p.errors.length) {
            <strong>Nothing was saved. Fix these first:</strong>
            <ul>@for (e of p.errors; track $index) { <li>Line {{ pairParse().pairs[e.row - 1]?.line ?? e.row }}: {{ e.message }}</li> }</ul>
          } @else {
            <span>Added {{ p.pairsCreated }} {{ singles() ? 'players' : 'pairs' }}@if (p.teamsCreated.length) {, team {{ p.teamsCreated.join(', ') }} created}@if (p.categoriesCreated.length) {, division {{ p.categoriesCreated.join(', ') }} created}@if (p.unchanged) {. {{ p.unchanged }} were already registered}. Pick another division to add the next list.</span>
          }
        </div>
      }
    </section>

    <section class="panel">
      <h3>Import a whole table or file</h3>
      <p class="muted small">
        Paste from Excel: one pair per row with columns <strong>Team, Division, Player 1, Player 2</strong>
        (e.g. <code>Hulk Smashers&nbsp;&nbsp;MD&nbsp;&nbsp;Kennith&nbsp;&nbsp;Zeth</code>; <em>MD</em> = Men's Doubles, <em>WD</em> = Women's Doubles).
        <strong>The order of the rows is the order of each team's pairs</strong>: a team's first MD row is its pair A (MD-A),
        the next is MD-B, and so on. Pairs in the same position play each other.
        Missing teams, divisions and players are created; existing ones are reused. A player can be in only one pair.
        If any row has a problem nothing is saved.
        <strong>Singles</strong> divisions (MS, WS, "Men's Singles"…) take one player per row: leave Player 2 empty.
      </p>
      <div class="row">
        <input #file type="file" accept=".csv,.tsv,.txt,.xlsx" hidden (change)="onFile($event)" />
        <button mat-stroked-button type="button" (click)="file.click()" [disabled]="busy()"><mat-icon>upload_file</mat-icon> Choose a CSV or Excel file…</button>
        <span class="muted small">{{ fileInfo() }}</span>
      </div>
      <mat-form-field appearance="outline" class="paste">
        <mat-label>Lineup rows</mat-label>
        <textarea matInput rows="8" [ngModel]="paste()" (ngModelChange)="paste.set($event); preview.set(null)" name="paste"></textarea>
      </mat-form-field>
      <div class="row">
        <span class="muted small">{{ parsed().rows.length }} rows read
          @if (parsed().bad.length) { · <span class="error-text">lines {{ parsed().bad.join(', ') }} need at least Team, Division and Player 1</span> }
        </span>
        <span class="grow"></span>
        <button mat-stroked-button (click)="runImport(true)" [disabled]="!parsed().rows.length || busy()">Check</button>
        <button mat-flat-button (click)="runImport(false)" [disabled]="!canImport() || busy()">Import</button>
      </div>
      @if (preview(); as p) {
        <div class="result" [class.bad]="p.errors.length">
          @if (p.errors.length) {
            <strong>Fix these rows first:</strong>
            <ul>@for (e of p.errors; track $index) { <li>Row {{ e.row }}: {{ e.message }}</li> }</ul>
          } @else {
            <span>{{ p.dryRun ? 'Ready to import' : 'Imported' }}:
              {{ p.pairsCreated }} pairs, {{ p.playersCreated }} new players
              @if (p.teamsCreated.length) {, teams {{ p.teamsCreated.join(', ') }} }
              @if (p.categoriesCreated.length) {, divisions {{ p.categoriesCreated.join(', ') }} }
              @if (p.unchanged) {. {{ p.unchanged }} rows already registered. }
            </span>
          }
        </div>
      }
    </section>

    <section class="panel">
      <h3>Lineup by position</h3>
      @if (notice()) { <p class="ok-text">{{ notice() }}</p> }
      @if (warnings().length) {
        <div class="result bad">
          <strong>The schedule was kept, but these now clash. Move the matches on the Schedule tab:</strong>
          <ul>@for (w of warnings(); track $index) { <li>{{ w }}</li> }</ul>
        </div>
      }
      @if (pairEdit(); as pe) {
        <form class="panel editpair" (ngSubmit)="savePairEdit()">
          <h4>Change players of {{ pe.displayName }}</h4>
          <p class="muted small">
            Pick a substitute from the team, or a new player. The pair keeps its position and every match with its court and time,
            so the published schedule does not change. Picking someone who is already in another pair swaps the two players.
          </p>
          <div class="row">
            @for (i of slots(pe); track i) {
              <div class="slot">
                <mat-form-field appearance="outline"><mat-label>Player {{ i + 1 }}</mat-label>
                  <mat-select [(ngModel)]="sel[i]" [name]="'sel' + i">
                    @for (p of teamPlayers(pe); track p.id) { <mat-option [value]="p.id">{{ p.firstName }} {{ p.lastName }}@if (pairOf(p.id, pe.id); as o) { <span class="muted small"> · in {{ o.displayName }}</span> }</mat-option> }
                    <mat-option value="__new">+ New player…</mat-option>
                  </mat-select></mat-form-field>
                @if (sel[i] === '__new') {
                  <mat-form-field appearance="outline"><mat-label>New player's name</mat-label>
                    <input matInput [(ngModel)]="newNames[i]" [name]="'nn' + i" /></mat-form-field>
                }
              </div>
            }
          </div>
          <div class="row">
            <button mat-flat-button type="submit" [disabled]="busy()">Save change</button>
            <button mat-button type="button" (click)="pairEdit.set(null)">Cancel</button>
          </div>
        </form>
      }
      @if (teamDivisions().length && ctx.teams().length) {
        <p class="muted small">
          Pairs in the same row play each other. Use the arrows to change a team's order, or the pencil to change a pair's players. Matches that have not
          started follow the change and keep their court and time, so the published schedule stays as it is.
        </p>
        @for (c of teamDivisions(); track c.id) {
          <h4>{{ c.name }}</h4>
          <div class="scroll">
            <table class="simple lineup">
              <thead>
                <tr><th>Level</th>@for (t of ctx.teams(); track t.id) { <th [style.background]="t.color">{{ t.name }}</th> }</tr>
              </thead>
              <tbody>
                @for (rank of levels(c.id); track rank) {
                  <tr>
                    <td><strong>{{ label(c.code, rank) }}</strong></td>
                    @for (t of ctx.teams(); track t.id) {
                      @let e = pairAt(t.id, c.id, rank);
                      <td [style.background]="t.color + '55'">
                        @if (e) {
                          <span class="pair">{{ e.displayName }}</span>
                          <button type="button" class="mv" (click)="startPairEdit(e)" aria-label="Edit pair" title="Change players"><mat-icon inline>edit</mat-icon></button>
                          <button type="button" class="mv" (click)="move(e.id, 'up')" [disabled]="rank === 1" aria-label="Move up"><mat-icon inline>arrow_upward</mat-icon></button>
                          <button type="button" class="mv" (click)="move(e.id, 'down')" [disabled]="!pairAt(t.id, c.id, rank + 1)" aria-label="Move down"><mat-icon inline>arrow_downward</mat-icon></button>
                        } @else { <span class="error-text small">missing</span> }
                      </td>
                    }
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      } @else { <p class="muted">Add teams and import a lineup to see each team's pairs by position.</p> }
    </section>
  `,
  styles: `
    :host { display: flex; flex-direction: column; gap: 16px; padding-top: 16px; }
    h3 { margin-top: 0; font-weight: 500; }
    .teams { display: flex; flex-wrap: wrap; gap: 10px; }
    .team { display: flex; align-items: center; gap: 8px; padding: 4px 4px 4px 10px; border-radius: 10px; border: 1px solid #0001; }
    .team input[type=color] { width: 28px; height: 28px; border: none; padding: 0; background: none; cursor: pointer; }
    .cap { width: 150px; background: #fff9; border-radius: 6px; padding: 2px 6px; font-size: 13px; }
    .logo-btn { border: 0; background: none; padding: 0; cursor: pointer; border-radius: 10px; display: inline-flex; }
    .logo-btn:hover { outline: 2px solid var(--bt-brand-2); }
    .rm { border: 0; background: none; cursor: pointer; color: #475569; padding: 0 2px; }
    .preview { margin: 4px 0 8px; max-width: 520px; }
    .add .row { align-items: flex-start; }
    .paste { width: 100%; }
    .editpair { background: #f8fafc; margin: 8px 0 16px; }
    .editpair h4 { margin: 0 0 4px; }
    .slot { display: flex; flex-direction: column; min-width: 220px; }
    .paste textarea { font-family: ui-monospace, monospace; font-size: 13px; }
    .result { margin-top: 10px; padding: 10px 12px; border-radius: 8px; background: #e8f5e9; }
    .result.bad { background: #ffebee; }
    .result ul { margin: 6px 0 0; padding-left: 20px; }
    .scroll { overflow-x: auto; }
    .lineup td, .lineup th { white-space: nowrap; }
    h4 { margin: 16px 0 6px; font-weight: 500; }
    .pair { margin-right: 6px; }
    .mv { border: 0; background: none; padding: 0 2px; cursor: pointer; color: #546e7a; vertical-align: middle; }
    .mv:disabled { opacity: .25; cursor: default; }
  `,
})
export class TeamsTab {
  readonly ctx = inject(TournamentContext);
  private readonly api = inject(Api);
  readonly error = signal('');
  readonly busy = signal(false);
  readonly paste = signal('');
  readonly preview = signal<LineupImportResult | null>(null);
  readonly fileInfo = signal('');
  teamName = '';

  // ---- "Add pairs to a team" ----
  readonly teamSel = signal<string>('');
  readonly newTeam = signal('');
  readonly divSel = signal<string>('');
  readonly otherDiv = signal('');
  readonly pairText = signal('');
  readonly result = signal<LineupImportResult | null>(null);

  readonly divisionName = computed(() => {
    const d = this.divSel();
    if (d === '__other') return this.otherDiv().trim();
    if (d.startsWith('preset:')) return d.slice(7);
    return this.ctx.categories().find((c) => c.id === d)?.name ?? '';
  });
  readonly teamNameChosen = computed(() => {
    const t = this.teamSel();
    return t === '__new' ? this.newTeam().trim() : (this.ctx.teams().find((x) => x.id === t)?.name ?? '');
  });
  readonly singles = computed(() => {
    const c = this.ctx.categories().find((x) => x.id === this.divSel());
    return c ? c.discipline === 'singles' : /singles/i.test(this.divisionName());
  });
  readonly pairParse = computed(() => parsePairsText(this.pairText(), { singles: this.singles() }));
  readonly missingPresets = computed(() => {
    const have = new Set(this.ctx.categories().map((c) => c.name.toLowerCase()));
    return PRESET_DIVISIONS.filter((n) => !have.has(n.toLowerCase()));
  });
  readonly divLabel = computed(() => {
    const c = this.ctx.categories().find((x) => x.id === this.divSel());
    return c?.code || divisionCode(this.divisionName() || 'X');
  });
  /** Where the new list starts: after the team's pairs already in this division. */
  readonly startRank = computed(() => {
    const t = this.teamSel();
    const d = this.divSel();
    const max = this.ctx.entries().filter((e) => e.teamId === t && e.categoryId === d && e.status === 'active').reduce((m, e) => Math.max(m, e.rank ?? 0), 0);
    return max + 1;
  });
  readonly canAddPairs = computed(
    () => !!this.teamNameChosen() && !!this.divisionName() && this.pairParse().pairs.length > 0 && !this.pairParse().problems.length,
  );
  letter = rankLetter;

  // ---- change a pair's players (the schedule is kept) ----
  readonly pairEdit = signal<EntryDto | null>(null);
  readonly notice = signal('');
  readonly warnings = signal<string[]>([]);
  sel: string[] = ['', ''];
  newNames: string[] = ['', ''];

  slots(e: EntryDto) {
    return e.playerIds.map((_, i) => i);
  }
  teamPlayers(e: EntryDto) {
    return this.ctx.players().filter((p) => p.teamId === e.teamId || !p.teamId);
  }
  /** The other pair a player is in, if any. */
  pairOf(playerId: string, exceptEntryId: string) {
    return this.ctx.entries().find((x) => x.id !== exceptEntryId && x.status === 'active' && x.playerIds.includes(playerId));
  }
  startPairEdit(e: EntryDto) {
    this.pairEdit.set(e);
    this.sel = [...e.playerIds, '', ''].slice(0, 2);
    this.newNames = ['', ''];
    this.notice.set('');
    this.warnings.set([]);
  }

  async savePairEdit() {
    const e = this.pairEdit();
    if (!e) return;
    if (this.sel[0] && this.sel[0] === this.sel[1]) {
      this.error.set('A pair needs two different players.');
      return;
    }
    this.busy.set(true);
    this.error.set('');
    this.notice.set('');
    try {
      let current = e;
      for (const i of this.slots(e)) {
        let incoming = this.sel[i] ?? '';
        const outgoing = e.playerIds[i]!;
        if (!incoming || incoming === outgoing) continue;
        if (incoming === '__new') {
          const full = (this.newNames[i] ?? '').trim().replace(/\s+/g, ' ');
          if (!full) throw new Error('Type the new player\'s name.');
          const parts = full.split(' ');
          const created = await this.api.post<{ id: string }>('/players', {
            tournamentId: this.ctx.id(),
            firstName: parts.length > 1 ? parts.slice(0, -1).join(' ') : parts[0],
            lastName: parts.length > 1 ? parts.at(-1) : '',
            teamId: e.teamId,
          });
          incoming = created.id;
        }
        const other = this.pairOf(incoming, e.id);
        if (other) {
          const who = this.ctx.players().find((p) => p.id === incoming);
          if (!confirm(`${who?.firstName ?? 'That player'} is in ${other.displayName}. Swap the two players between the pairs?`)) return;
          await this.api.post('/entries/swap-players', { entryAId: current.id, playerAId: outgoing, entryBId: other.id, playerBId: incoming });
        } else {
          const ids = current.playerIds.map((id) => (id === outgoing ? incoming : id));
          current = await this.api.put<EntryDto>(`/entries/${current.id}`, { playerIds: ids });
        }
        await this.ctx.reloadRoster();
        current = this.ctx.entries().find((x) => x.id === e.id) ?? current;
      }
      await this.ctx.reloadRoster();
      this.pairEdit.set(null);
      this.notice.set('Saved. The published schedule was not changed.');
      await this.checkClashes();
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.busy.set(false);
    }
  }

  /** After a lineup change, list any player who now has overlapping or back-to-back matches. */
  private async checkClashes() {
    try {
      const issues = await this.api.get<ScheduleIssue[]>(`/tournaments/${this.ctx.id()}/schedules/conflicts`);
      this.warnings.set(issues.map((i) => i.message));
    } catch {
      this.warnings.set([]);
    }
  }

  /** Checks first (nothing is written if any line is wrong), then adds the pairs. */
  async addPairs() {
    if (!this.canAddPairs()) return;
    this.busy.set(true);
    this.error.set('');
    const rows: LineupRow[] = this.pairParse().pairs.map((p) => ({ team: this.teamNameChosen(), category: this.divisionName(), player1: p.player1, player2: p.player2 }));
    const url = `/tournaments/${this.ctx.id()}/lineup/import`;
    try {
      const check = await this.api.post<LineupImportResult>(url, { rows, dryRun: true });
      if (check.errors.length) {
        this.result.set(check);
        return;
      }
      const done = await this.api.post<LineupImportResult>(url, { rows, dryRun: false });
      await this.ctx.reloadRoster();
      this.result.set(done);
      this.pairText.set('');
      // Keep working on the same team: it now exists, so select it.
      const made = this.ctx.teams().find((t) => t.name.toLowerCase() === rows[0]!.team.toLowerCase());
      if (made) this.teamSel.set(made.id);
      const cat = this.ctx.categories().find((c) => c.name.toLowerCase() === rows[0]!.category.toLowerCase());
      if (cat) this.divSel.set(cat.id);
    } catch (e) {
      const body = (e as { error?: Partial<LineupImportResult> }).error;
      if (Array.isArray(body?.errors)) this.result.set(body as LineupImportResult);
      else this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  async onLogo(teamId: string, ev: Event) {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    await this.run(async () => {
      await this.api.put(`/teams/${teamId}/logo`, { dataUrl: await shrinkImage(file) });
      await this.ctx.loadTeams();
    });
  }

  removeLogo(teamId: string) {
    return this.run(async () => {
      await this.api.delete(`/teams/${teamId}/logo`);
      await this.ctx.loadTeams();
    });
  }

  readonly parsed = computed(() => parseLineup(this.paste()));
  readonly canImport = computed(() => {
    const p = this.preview();
    return !!p && p.dryRun && !p.errors.length && this.parsed().rows.length > 0;
  });
  readonly teamDivisions = computed(() => this.ctx.categories().filter((c) => c.format === 'team_round_robin'));

  /** Positions 1..N, where N is the longest team list in the division. */
  levels(categoryId: string): number[] {
    const max = this.ctx.entries().filter((e) => e.categoryId === categoryId && e.status === 'active').reduce((m, e) => Math.max(m, e.rank ?? 0), 0);
    return Array.from({ length: max }, (_, i) => i + 1);
  }
  label(code: string, rank: number) {
    return `${code}-${rankLetter(rank)}`;
  }
  pairAt(teamId: string, categoryId: string, rank: number) {
    return this.ctx.entries().find((e) => e.teamId === teamId && e.categoryId === categoryId && e.rank === rank && e.status === 'active');
  }
  move(id: string, direction: 'up' | 'down') {
    return this.run(async () => {
      this.notice.set('');
      await this.api.post(`/entries/${id}/move`, { direction });
      await this.ctx.loadEntries();
      this.notice.set('Order changed. Matches that have not started follow the new order and keep their court and time.');
      await this.checkClashes();
    });
  }

  playersOf(teamId: string) {
    return this.ctx.players().filter((p) => p.teamId === teamId);
  }

  setCaptain(teamId: string, captainPlayerId: string | null) {
    return this.run(async () => {
      await this.api.put(`/teams/${teamId}`, { captainPlayerId });
      await this.ctx.loadTeams();
    });
  }

  pairCount(teamId: string) {
    return this.ctx.entries().filter((e) => e.teamId === teamId && e.status === 'active').length;
  }
  pairsOf(teamId: string, categoryId: string) {
    return this.ctx.entries().filter((e) => e.teamId === teamId && e.categoryId === categoryId && e.status === 'active');
  }

  private async run(fn: () => Promise<unknown>) {
    this.error.set('');
    try {
      await fn();
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }

  addTeam() {
    return this.run(async () => {
      await this.api.post('/teams', { tournamentId: this.ctx.id(), name: this.teamName });
      this.teamName = '';
      await this.ctx.loadTeams();
    });
  }

  setColor(id: string, color: string) {
    return this.run(async () => {
      await this.api.put(`/teams/${id}`, { color });
      await this.ctx.loadTeams();
    });
  }

  removeTeam(id: string) {
    if (!confirm('Delete this team?')) return;
    return this.run(async () => {
      await this.api.delete(`/teams/${id}`);
      await this.ctx.reloadRoster();
    });
  }

  /** Read a CSV or Excel file on the server and put its rows in the box, ready to Check and Import. */
  async onFile(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    this.busy.set(true);
    this.error.set('');
    try {
      const r = await this.api.upload<{ rows: LineupRow[]; skipped: number[]; source: string }>(`/tournaments/${this.ctx.id()}/lineup/parse-file`, file);
      this.paste.set(r.rows.map((x) => [x.team, x.category, x.player1, x.player2].join('\t')).join('\n'));
      this.preview.set(null);
      this.fileInfo.set(`${r.rows.length} rows read from ${file.name}${r.skipped.length ? `; skipped rows ${r.skipped.join(', ')} (too few columns)` : ''}. Now click Check.`);
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  /** "Check" runs a dry run; "Import" is only enabled after a clean check of the same text. */
  async runImport(dryRun: boolean) {
    this.busy.set(true);
    this.error.set('');
    try {
      const r = await this.api.post<LineupImportResult>(`/tournaments/${this.ctx.id()}/lineup/import`, { rows: this.parsed().rows, dryRun });
      this.preview.set(r);
      if (!dryRun) await this.ctx.reloadRoster();
    } catch (e) {
      // A 422 response carries the row-level errors in the body.
      const body = (e as { error?: Partial<LineupImportResult> }).error;
      if (Array.isArray(body?.errors)) this.preview.set(body as LineupImportResult);
      else this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
}
