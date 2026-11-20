import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { Api, errorMessage } from '../../core/api.service';
import { TournamentContext } from '../tournaments/tournament-context';

@Component({
  selector: 'bt-entries-tab',
  imports: [FormsModule, MatButtonModule, MatFormFieldModule, MatInputModule, MatSelectModule],
  template: `
    @if (error()) { <p class="error-text">{{ error() }}</p> }
    <div class="cols">
      <!-- Players -->
      <section class="panel">
        <h3>Players ({{ ctx.players().length }})</h3>
        <form class="row" (ngSubmit)="addPlayer()">
          <mat-form-field appearance="outline" class="f"><mat-label>First name</mat-label>
            <input matInput [(ngModel)]="player.firstName" name="fn" required /></mat-form-field>
          <mat-form-field appearance="outline" class="f"><mat-label>Last name</mat-label>
            <input matInput [(ngModel)]="player.lastName" name="ln" required /></mat-form-field>
          <mat-form-field appearance="outline" class="s"><mat-label>Gender</mat-label>
            <mat-select [(ngModel)]="player.gender" name="g">
              <mat-option [value]="undefined">–</mat-option><mat-option value="M">M</mat-option><mat-option value="F">F</mat-option>
            </mat-select></mat-form-field>
          <mat-form-field appearance="outline" class="f"><mat-label>Club</mat-label>
            <input matInput [(ngModel)]="player.club" name="club" /></mat-form-field>
          <button mat-flat-button type="submit">Add</button>
        </form>
        <mat-form-field appearance="outline" class="search"><mat-label>Search players</mat-label>
          <input matInput [ngModel]="q()" (ngModelChange)="q.set($event)" name="q" /></mat-form-field>
        <table class="simple">
          <tbody>
            @for (p of filteredPlayers(); track p.id) {
              <tr>
                <td>{{ p.firstName }} {{ p.lastName }}</td>
                <td class="muted small">{{ ctx.team(p.teamId)?.name }} {{ p.gender }} {{ p.club }}</td>
                <td class="muted small">{{ entered(p.id) }}</td>
                <td class="nowrap"><button mat-button (click)="renamePlayer(p)">Rename</button><button mat-button (click)="removePlayer(p.id)">Remove</button></td>
              </tr>
            } @empty { <tr><td class="muted">No players.</td></tr> }
          </tbody>
        </table>
      </section>

      <!-- Pairs -->
      <section class="panel">
        <h3>Pairs <span class="muted small">(added at the end of the team's list; reorder on the Teams tab)</span></h3>
        <form (ngSubmit)="addEntry()">
          <div class="row">
            <mat-form-field appearance="outline" class="grow"><mat-label>Category</mat-label>
              <mat-select [(ngModel)]="entry.categoryId" name="cat" required>
                @for (c of ctx.categories(); track c.id) { <mat-option [value]="c.id">{{ c.name }}</mat-option> }
              </mat-select></mat-form-field>
            <mat-form-field appearance="outline"><mat-label>Team</mat-label>
              <mat-select [(ngModel)]="entry.teamId" name="team">
                <mat-option [value]="null">From players / none</mat-option>
                @for (t of ctx.teams(); track t.id) { <mat-option [value]="t.id">{{ t.name }}</mat-option> }
              </mat-select></mat-form-field>
            <mat-form-field appearance="outline" class="s"><mat-label>Seed</mat-label>
              <input matInput type="number" min="1" [(ngModel)]="entry.seed" name="seed" /></mat-form-field>
          </div>
          <div class="row">
            @for (i of slots(); track i) {
              <mat-form-field appearance="outline" class="grow"><mat-label>Player {{ i + 1 }}</mat-label>
                <mat-select [(ngModel)]="entry.players[i]" [name]="'p' + i" required>
                  @for (p of availablePlayers(); track p.id) { <mat-option [value]="p.id">{{ p.firstName }} {{ p.lastName }}</mat-option> }
                </mat-select></mat-form-field>
            }
          </div>
          <button mat-flat-button type="submit" [disabled]="!ctx.categories().length">{{ slots().length === 1 ? 'Add entry' : 'Add pair' }}</button>
          @if (!ctx.categories().length) { <span class="muted small"> Create a category first.</span> }
        </form>
        @for (c of ctx.categories(); track c.id) {
          <h4>{{ c.name }}</h4>
          <table class="simple">
            <tbody>
              @for (e of entriesIn(c.id); track e.id) {
                <tr [class.muted]="e.status === 'withdrawn'">
                  <td>{{ e.seed ? '[' + e.seed + '] ' : '' }}
                    @if (e.rank) { <strong class="lvl">{{ ctx.levelLabel(e) }}</strong> }
                    @if (ctx.team(e.teamId); as t) { <span class="team" [style.background]="t.color">{{ t.name }}</span> }
                    <strong>{{ e.displayName }}</strong></td>
                  <td class="small muted">@for (pid of e.playerIds; track pid; let last = $last) { {{ ctx.playerName(pid) }}{{ last ? '' : ' &' }} }</td>
                  <td>
                    @if (e.status === 'active') { <button mat-button (click)="withdraw(e.id)">Withdraw</button> }
                    <button mat-button (click)="removeEntry(e.id)">Delete</button>
                  </td>
                </tr>
              } @empty { <tr><td class="muted">No pairs.</td></tr> }
            </tbody>
          </table>
        }
      </section>
    </div>
  `,
  styles: `
    :host { display: block; padding-top: 16px; }
    .cols { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); }
    @media (max-width: 500px) { .cols { grid-template-columns: 1fr; } }
    h3 { margin-top: 0; font-weight: 500; } h4 { margin: 16px 0 4px; font-weight: 500; }
    .f { width: 150px; } .s { width: 90px; } .search { width: 100%; }
    .lvl { display: inline-block; min-width: 38px; color: #455a64; }
    .team { display: inline-block; font-size: 11px; padding: 0 6px; border-radius: 4px; margin-right: 6px; border: 1px solid #0001; }
  `,
})
export class EntriesTab {
  readonly ctx = inject(TournamentContext);
  private readonly api = inject(Api);
  readonly error = signal('');
  readonly q = signal('');
  player: { firstName: string; lastName: string; gender?: 'M' | 'F'; club: string } = { firstName: '', lastName: '', club: '' };
  entry: { categoryId: string; players: string[]; seed: number | null; teamId: string | null } = { categoryId: '', players: [], seed: null, teamId: null };

  readonly filteredPlayers = computed(() => {
    const q = this.q().toLowerCase().trim();
    return this.ctx.players().filter((p) => !q || `${p.firstName} ${p.lastName} ${p.club}`.toLowerCase().includes(q));
  });
  /** Players not already in an active pair of the selected category. */
  /** One player select for a singles division, two otherwise. */
  slots(): number[] {
    return this.ctx.categories().find((c) => c.id === this.entry.categoryId)?.playersPerEntry === 1 ? [0] : [0, 1];
  }

  availablePlayers() {
    // A player can be in only one active pair per tournament; also limit to the chosen team.
    const taken = new Set(this.ctx.entries().filter((e) => e.status === 'active').flatMap((e) => e.playerIds));
    return this.ctx.players().filter((p) => !taken.has(p.id) && (!this.entry.teamId || !p.teamId || p.teamId === this.entry.teamId));
  }

  entriesIn(categoryId: string) {
    return this.ctx.entries().filter((e) => e.categoryId === categoryId);
  }

  entered(playerId: string) {
    return this.ctx
      .entries()
      .filter((e) => e.status === 'active' && e.playerIds.includes(playerId))
      .map((e) => this.ctx.categoryName(e.categoryId))
      .join(', ');
  }

  private async run(fn: () => Promise<unknown>) {
    this.error.set('');
    try {
      await fn();
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }

  addPlayer() {
    return this.run(async () => {
      await this.api.post('/players', { tournamentId: this.ctx.id(), ...this.player });
      this.player = { firstName: '', lastName: '', club: this.player.club, gender: this.player.gender };
      await this.ctx.loadPlayers();
    });
  }

  renamePlayer(p: { id: string; firstName: string; lastName?: string | null }) {
    const now = `${p.firstName} ${p.lastName ?? ''}`.trim();
    const input = prompt('Player name', now);
    const full = input?.trim().replace(/\s+/g, ' ');
    if (!full || full === now) return;
    const parts = full.split(' ');
    return this.run(async () => {
      await this.api.put(`/players/${p.id}`, { firstName: parts.length > 1 ? parts.slice(0, -1).join(' ') : parts[0], lastName: parts.length > 1 ? parts.at(-1) : '' });
      await Promise.all([this.ctx.loadPlayers(), this.ctx.loadEntries()]);
    });
  }

  removePlayer(id: string) {
    return this.run(async () => {
      await this.api.delete(`/players/${id}`);
      await this.ctx.loadPlayers();
    });
  }

  addEntry() {
    return this.run(async () => {
      await this.api.post('/entries', {
        categoryId: this.entry.categoryId,
        playerIds: this.entry.players.filter(Boolean).slice(0, this.slots().length),
        seed: this.entry.seed ? Number(this.entry.seed) : null,
        teamId: this.entry.teamId,
      });
      this.entry = { categoryId: this.entry.categoryId, players: [], seed: null, teamId: this.entry.teamId };
      await this.ctx.loadEntries();
    });
  }

  withdraw(id: string) {
    return this.run(async () => {
      await this.api.put(`/entries/${id}`, { status: 'withdrawn' });
      await this.ctx.loadEntries();
    });
  }

  removeEntry(id: string) {
    if (!confirm('Delete this pair?')) return;
    return this.run(async () => {
      await this.api.delete(`/entries/${id}`);
      await this.ctx.loadEntries();
    });
  }
}
