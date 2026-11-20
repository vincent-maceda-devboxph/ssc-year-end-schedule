import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { SCORING_PRESETS, type CategoryDto, type ScoringConfig, type ScoringPresetKey } from '@bt/shared';
import { Api, errorMessage } from '../../core/api.service';
import { TournamentContext } from '../tournaments/tournament-context';

const PRESET_LABELS: Record<ScoringPresetKey, string> = {
  bestOf3To21: 'Best of 3 games to 21 (cap 30)',
  singleGameTo21: 'Single game to 21 (cap 30)',
  singleGameTo31: 'Single game to 31 (cap 40)',
};

/**
 * Divisions (Men's Doubles, Women's Doubles, ...). A division holds the scoring rules; there are no
 * per-level categories: a pair's level comes from its position in its team's list.
 */
@Component({
  selector: 'bt-categories-tab',
  imports: [FormsModule, MatButtonModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatCheckboxModule],
  template: `
    <p class="muted small intro">
      A division is a kind of event such as <strong>Men's Doubles</strong> or <strong>Women's Doubles</strong>.
      Each team lists its pairs in order for each division; the first pair of every team is <strong>A</strong> (MD-A),
      the second is <strong>B</strong>, and so on, and pairs in the same position play each other.
      Divisions are created automatically when you import a lineup; use this page to change their scoring rules.
    </p>
    <form class="panel" (ngSubmit)="create()">
      <div class="row">
        <mat-form-field appearance="outline" class="grow"><mat-label>Division name</mat-label>
          <input matInput [(ngModel)]="name" name="name" placeholder="Men's Doubles" required /></mat-form-field>
        <mat-form-field appearance="outline"><mat-label>Players per entry</mat-label>
          <mat-select [(ngModel)]="discipline" name="discipline"><mat-option value="doubles">Doubles (2)</mat-option><mat-option value="singles">Singles (1)</mat-option></mat-select></mat-form-field>
        <mat-form-field appearance="outline"><mat-label>Scoring preset</mat-label>
          <mat-select [(ngModel)]="preset" name="preset" (selectionChange)="applyPreset()">
            @for (p of presets; track p.key) { <mat-option [value]="p.key">{{ p.label }}</mat-option> }
          </mat-select></mat-form-field>
      </div>
      <div class="row">
        <mat-form-field appearance="outline" class="num"><mat-label>Games to win</mat-label>
          <input matInput type="number" min="1" max="5" [(ngModel)]="scoring.gamesToWin" name="g" /></mat-form-field>
        <mat-form-field appearance="outline" class="num"><mat-label>Points to win</mat-label>
          <input matInput type="number" min="1" [(ngModel)]="scoring.pointsToWin" name="p" /></mat-form-field>
        <mat-form-field appearance="outline" class="num"><mat-label>Win by</mat-label>
          <input matInput type="number" min="1" [(ngModel)]="scoring.winBy" name="w" /></mat-form-field>
        <mat-form-field appearance="outline" class="num"><mat-label>Cap (blank = none)</mat-label>
          <input matInput type="number" [(ngModel)]="scoring.cap" name="c" /></mat-form-field>
        <mat-form-field appearance="outline" class="num"><mat-label>Interval at</mat-label>
          <input matInput type="number" [(ngModel)]="scoring.intervalAt" name="i" /></mat-form-field>
        <mat-checkbox [(ngModel)]="scoring.changeEndsInDecider" name="ce">Change ends in decider</mat-checkbox>
      </div>
      @if (error()) { <p class="error-text">{{ error() }}</p> }
      <button mat-flat-button type="submit">Add division</button>
    </form>

    <div class="panel list">
      <table class="simple">
        <thead><tr><th>Division</th><th>Label</th><th>Scoring</th><th>Pairs</th><th title="Lower numbers are scheduled earlier">Priority</th><th></th></tr></thead>
        <tbody>
          @for (c of ctx.categories(); track c.id) {
            <tr>
              <td>{{ c.name }} @if (c.discipline === 'singles') { <span class="chip">singles</span> }</td>
              <td>{{ c.code }}-A, {{ c.code }}-B …</td>
              <td class="small">{{ describe(c.scoring) }}</td>
              <td>{{ pairCount(c.id) }}</td>
              <td><input class="prio" type="number" min="0" max="999" [value]="c.priority" (change)="setPriority(c.id, $any($event.target).value)" [attr.aria-label]="'Priority of ' + c.name" /></td>
              <td class="nowrap"><button mat-button (click)="edit(c)">{{ editing() === c.id ? 'Close' : 'Edit' }}</button><button mat-button (click)="remove(c.id)">Delete</button></td>
            </tr>
            @if (editing() === c.id) {
              <tr class="editrow"><td colspan="6">
                <form class="editform" (ngSubmit)="save(c)">
                  <div class="row">
                    <mat-form-field appearance="outline" class="grow"><mat-label>Division name</mat-label>
                      <input matInput [(ngModel)]="draft.name" name="en" required /></mat-form-field>
                    <mat-form-field appearance="outline" class="num"><mat-label>Label code</mat-label>
                      <input matInput [(ngModel)]="draft.code" name="ec" maxlength="3" /></mat-form-field>
                    <mat-form-field appearance="outline"><mat-label>Scoring preset</mat-label>
                      <mat-select [(ngModel)]="draft.preset" name="ep" (selectionChange)="draft.scoring = presetScoring(draft.preset)">
                        @for (p of presets; track p.key) { <mat-option [value]="p.key">{{ p.label }}</mat-option> }
                        <mat-option value="custom">Custom</mat-option>
                      </mat-select></mat-form-field>
                  </div>
                  <div class="row">
                    <mat-form-field appearance="outline" class="num"><mat-label>Games to win</mat-label>
                      <input matInput type="number" min="1" max="5" [(ngModel)]="draft.scoring.gamesToWin" name="eg" (ngModelChange)="draft.preset = 'custom'" /></mat-form-field>
                    <mat-form-field appearance="outline" class="num"><mat-label>Points to win</mat-label>
                      <input matInput type="number" min="1" [(ngModel)]="draft.scoring.pointsToWin" name="epw" (ngModelChange)="draft.preset = 'custom'" /></mat-form-field>
                    <mat-form-field appearance="outline" class="num"><mat-label>Win by</mat-label>
                      <input matInput type="number" min="1" [(ngModel)]="draft.scoring.winBy" name="ew" (ngModelChange)="draft.preset = 'custom'" /></mat-form-field>
                    <mat-form-field appearance="outline" class="num"><mat-label>Cap (blank = none)</mat-label>
                      <input matInput type="number" [(ngModel)]="draft.scoring.cap" name="ecap" (ngModelChange)="draft.preset = 'custom'" /></mat-form-field>
                    <mat-form-field appearance="outline" class="num"><mat-label>Interval at</mat-label>
                      <input matInput type="number" [(ngModel)]="draft.scoring.intervalAt" name="ei" (ngModelChange)="draft.preset = 'custom'" /></mat-form-field>
                    <mat-checkbox [(ngModel)]="draft.scoring.changeEndsInDecider" name="ece">Change ends in decider</mat-checkbox>
                  </div>
                  <div class="row">
                    @if (c.format === 'knockout') { <mat-checkbox [(ngModel)]="draft.thirdPlace" name="etp">Third-place match</mat-checkbox> }
                    <mat-checkbox [(ngModel)]="draft.allowSameTeam" name="eas">Allow pairs from the same team to meet</mat-checkbox>
                  </div>
                  @if (c.discipline === 'singles') { <p class="muted small">Singles / doubles cannot be changed after the division is created.</p> }
                  @if (hasMatches(c.id)) { <p class="muted small">This division already has matches. New scoring rules apply to matches that have not started; finished results are not changed.</p> }
                  <div class="row"><button mat-flat-button type="submit">Save changes</button><button mat-button type="button" (click)="editing.set('')">Cancel</button></div>
                </form>
              </td></tr>
            }
          } @empty { <tr><td colspan="6" class="muted">No divisions yet. Import a lineup or add one above.</td></tr> }
        </tbody>
      </table>
    </div>
    <p class="muted small">Priority: a division with a lower number is scheduled earlier. Matches already in the published plan keep their slot; the new priority applies when the schedule is rebuilt (Schedule tab → Reschedule).</p>
  `,
  styles: `.nowrap { white-space: nowrap; } .editrow td { background: #f8fafc; padding: 12px; } .editform { display: flex; flex-direction: column; gap: 4px; } :host { display: block; padding-top: 16px; } .prio { width: 70px; font: inherit; padding: 4px 6px; border: 1px solid var(--bt-border); border-radius: 6px; } .intro { margin: 0 0 12px; } .num { width: 150px; } .list { margin-top: 16px; }`,
})
export class CategoriesTab {
  readonly ctx = inject(TournamentContext);
  private readonly api = inject(Api);
  readonly presets = (Object.keys(SCORING_PRESETS) as ScoringPresetKey[]).map((key) => ({ key, label: PRESET_LABELS[key] }));
  readonly error = signal('');
  readonly editing = signal('');
  draft: { name: string; code: string; preset: ScoringPresetKey | 'custom'; scoring: ScoringConfig; thirdPlace: boolean; allowSameTeam: boolean } = {
    name: '', code: '', preset: 'bestOf3To21', scoring: { ...SCORING_PRESETS.bestOf3To21 }, thirdPlace: true, allowSameTeam: false,
  };

  presetScoring(key: ScoringPresetKey | 'custom'): ScoringConfig {
    return key === 'custom' ? { ...this.draft.scoring } : { ...SCORING_PRESETS[key] };
  }
  hasMatches(categoryId: string) {
    return this.ctx.matches.all().some((m) => m.categoryId === categoryId);
  }

  edit(c: CategoryDto) {
    if (this.editing() === c.id) {
      this.editing.set('');
      return;
    }
    const match = (Object.keys(SCORING_PRESETS) as ScoringPresetKey[]).find((k) => JSON.stringify(SCORING_PRESETS[k]) === JSON.stringify(c.scoring));
    this.draft = { name: c.name, code: c.code, preset: match ?? 'custom', scoring: { ...c.scoring }, thirdPlace: c.thirdPlace, allowSameTeam: c.allowSameTeam };
    this.error.set('');
    this.editing.set(c.id);
  }

  async save(c: CategoryDto) {
    this.error.set('');
    const num = (v: unknown) => (v === null || v === '' || v === undefined ? null : Number(v));
    const sc = this.draft.scoring;
    try {
      await this.api.put(`/categories/${c.id}`, {
        name: this.draft.name.trim(),
        code: this.draft.code.trim() || undefined,
        allowSameTeam: this.draft.allowSameTeam,
        ...(c.format === 'knockout' ? { thirdPlace: this.draft.thirdPlace } : {}),
        scoring: { ...sc, gamesToWin: Number(sc.gamesToWin), pointsToWin: Number(sc.pointsToWin), winBy: Number(sc.winBy), cap: num(sc.cap), intervalAt: num(sc.intervalAt) },
      });
      this.editing.set('');
      await Promise.all([this.ctx.loadCategories(), this.ctx.loadEntries()]);
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }
  name = '';
  discipline: 'doubles' | 'singles' = 'doubles';
  preset: ScoringPresetKey = 'bestOf3To21';
  scoring: ScoringConfig = { ...SCORING_PRESETS.bestOf3To21 };

  applyPreset() {
    this.scoring = { ...SCORING_PRESETS[this.preset] };
  }

  describe(s: ScoringConfig) {
    const games = s.gamesToWin === 1 ? 'Single game' : `Best of ${s.gamesToWin * 2 - 1}`;
    return `${games} to ${s.pointsToWin}, win by ${s.winBy}${s.cap ? `, cap ${s.cap}` : ''}`;
  }

  async setPriority(id: string, value: string) {
    this.error.set('');
    try {
      await this.api.put(`/categories/${id}`, { priority: Math.max(0, Math.min(999, Math.round(Number(value) || 0))) });
      await this.ctx.loadCategories();
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }

  pairCount(categoryId: string) {
    return this.ctx.entries().filter((e) => e.categoryId === categoryId && e.status === 'active').length;
  }

  async create() {
    this.error.set('');
    const num = (v: unknown) => (v === null || v === '' || v === undefined ? null : Number(v));
    try {
      await this.api.post('/categories', {
        tournamentId: this.ctx.id(),
        name: this.name,
        discipline: this.discipline,
        format: 'team_round_robin',
        scoring: {
          ...this.scoring,
          gamesToWin: Number(this.scoring.gamesToWin),
          pointsToWin: Number(this.scoring.pointsToWin),
          winBy: Number(this.scoring.winBy),
          cap: num(this.scoring.cap),
          intervalAt: num(this.scoring.intervalAt),
        },
      });
      this.name = '';
      await this.ctx.loadCategories();
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }

  async remove(id: string) {
    if (!confirm('Delete this division and its pairs?')) return;
    try {
      await this.api.delete(`/categories/${id}`);
      await Promise.all([this.ctx.loadCategories(), this.ctx.loadEntries()]);
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }
}
