import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { SCORING_PRESETS, type CategoryDto, type MatchDto } from '@bt/shared';
import { Api, errorMessage } from '../../core/api.service';
import { BracketView } from '../../shared/components/bracket-view';
import { TournamentContext } from '../tournaments/tournament-context';

interface GroupRow {
  group: string;
  entries: { name: string }[];
}

/** Groups for round-robin divisions and knockout brackets (optionally fed by the group results). */
@Component({
  selector: 'bt-brackets-tab',
  imports: [FormsModule, MatButtonModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatCheckboxModule, BracketView],
  template: `
    <p class="muted small intro">
      <strong>Groups:</strong> split a round-robin division into groups (snake order by seed), play the round robin inside each group, then create a
      <strong>knockout</strong> division fed by the group results. A knockout can also stand alone with its own entries (seeded by their seed number; the best seeds get byes).
    </p>
    @if (error()) { <p class="error-text">{{ error() }}</p> }
    @if (info()) { <p class="ok-text">{{ info() }}</p> }

    <section class="panel">
      <h3>New knockout division</h3>
      <div class="row">
        <mat-form-field appearance="outline" class="grow"><mat-label>Name</mat-label>
          <input matInput [(ngModel)]="koName" name="koName" placeholder="Men's Singles Knockout" /></mat-form-field>
        <mat-form-field appearance="outline"><mat-label>Entries come from</mat-label>
          <mat-select [(ngModel)]="koSource" name="koSource">
            <mat-option value="">Its own entries</mat-option>
            @for (c of roundRobins(); track c.id) { <mat-option [value]="c.id">{{ c.name }} (group results)</mat-option> }
          </mat-select></mat-form-field>
        <mat-checkbox [(ngModel)]="koThird" name="koThird">Third-place match</mat-checkbox>
        <button mat-flat-button (click)="createKnockout()" [disabled]="!koName.trim()">Add knockout</button>
      </div>
    </section>

    @for (c of roundRobins(); track c.id) {
      <section class="panel">
        <h3>{{ c.name }} <span class="chip">round robin</span></h3>
        <div class="row">
          <mat-form-field appearance="outline" class="num"><mat-label>Groups</mat-label>
            <input matInput type="number" min="1" max="16" [(ngModel)]="groupCount[c.id]" [name]="'gc' + c.id" /></mat-form-field>
          <button mat-stroked-button (click)="assign(c)">Split into groups</button>
          <button mat-button (click)="clear(c)">Remove groups</button>
        </div>
        @for (g of groups()[c.id] ?? []; track g.group) {
          <p class="small"><strong>Group {{ g.group }}:</strong> {{ names(g) }}</p>
        }
      </section>
    }

    @for (c of knockouts(); track c.id) {
      <section class="panel">
        <h3>{{ c.name }} <span class="chip">knockout</span></h3>
        <div class="row">
          @if (c.sourceCategoryId) {
            <mat-form-field appearance="outline" class="num"><mat-label>Advance per group</mat-label>
              <input matInput type="number" min="1" max="8" [(ngModel)]="advance[c.id]" [name]="'ad' + c.id" /></mat-form-field>
            <mat-checkbox [(ngModel)]="force[c.id]" [name]="'fo' + c.id">Build even if groups are unfinished</mat-checkbox>
          }
          <button mat-flat-button (click)="generate(c, false)">Generate bracket</button>
          <button mat-stroked-button (click)="generate(c, true)">Rebuild (unplayed only)</button>
        </div>
        @if (brackets()[c.id]?.length) { <bt-bracket-view [matches]="brackets()[c.id]!" /> } @else { <p class="muted small">No bracket yet.</p> }
      </section>
    }
  `,
  styles: `:host { display: block; padding-top: 16px; } .panel { margin-bottom: 16px; } .intro { margin: 0 0 12px; } .num { width: 150px; } h3 { margin: 0 0 8px; } .ok-text { color: #2e7d32; }`,
})
export class BracketsTab {
  readonly ctx = inject(TournamentContext);
  private readonly api = inject(Api);
  readonly error = signal('');
  readonly info = signal('');
  groupCount: Record<string, number> = {};
  advance: Record<string, number> = {};
  force: Record<string, boolean> = {};
  koName = '';
  koSource = '';
  koThird = true;

  readonly brackets = computed(() => {
    const trees: Record<string, MatchDto[]> = {};
    for (const m of this.ctx.matches.all()) if (m.stage) (trees[m.categoryId] ??= []).push(m);
    return trees;
  });
  readonly groups = computed(() => {
    const g: Record<string, GroupRow[]> = {};
    for (const c of this.roundRobins()) {
      const members = this.ctx.entries().filter((e) => e.categoryId === c.id && e.status === 'active' && e.group);
      const letters = [...new Set(members.map((e) => e.group))].sort();
      g[c.id] = letters.map((l) => ({ group: l, entries: members.filter((e) => e.group === l).map((e) => ({ name: e.displayName })) }));
    }
    return g;
  });

  roundRobins = () => this.ctx.categories().filter((c) => c.format === 'round_robin');
  knockouts = () => this.ctx.categories().filter((c) => c.format === 'knockout');
  names(g: GroupRow) {
    return g.entries.map((e) => e.name).join(', ');
  }

  private async run(fn: () => Promise<string>) {
    this.error.set('');
    this.info.set('');
    try {
      this.info.set(await fn());
      await Promise.all([this.ctx.loadCategories(), this.ctx.loadEntries()]);
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }

  assign(c: CategoryDto) {
    return this.run(async () => {
      await this.api.post(`/categories/${c.id}/groups`, { count: Number(this.groupCount[c.id] ?? 2) });
      return `Groups created for ${c.name}. Generate matches to play the round robin inside each group.`;
    });
  }
  clear(c: CategoryDto) {
    return this.run(async () => {
      await this.api.delete(`/categories/${c.id}/groups`);
      return `Groups removed from ${c.name}.`;
    });
  }
  createKnockout() {
    return this.run(async () => {
      await this.api.post('/categories', {
        tournamentId: this.ctx.id(),
        name: this.koName.trim(),
        discipline: 'singles',
        format: 'knockout',
        thirdPlace: this.koThird,
        sourceCategoryId: this.koSource || undefined,
        scoring: { ...SCORING_PRESETS.bestOf3To21 },
      });
      this.koName = '';
      return 'Knockout division added.';
    });
  }
  generate(c: CategoryDto, replace: boolean) {
    return this.run(async () => {
      const r = await this.api.post<{ created: number; rounds: number; byes: number }>(`/categories/${c.id}/bracket/generate`, {
        replace,
        force: !!this.force[c.id],
        ...(c.sourceCategoryId ? { advancePerGroup: Number(this.advance[c.id] ?? 2) } : {}),
      });
      return `Bracket ready: ${r.created} matches, ${r.rounds} rounds${r.byes ? `, ${r.byes} byes` : ''}. Rebuild the schedule to place them.`;
    });
  }
}
