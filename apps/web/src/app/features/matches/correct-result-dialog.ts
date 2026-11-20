import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import type { MatchDto } from '@bt/shared';
import { Api, apiError, errorMessage } from '../../core/api.service';

type Row = { a: number | null; b: number | null };

/** Admin correction of a finished result. The reason is required and goes to the audit log. */
@Component({
  selector: 'bt-correct-result-dialog',
  imports: [FormsModule, MatDialogModule, MatButtonModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatIconModule],
  template: `
    <h2 mat-dialog-title>Correct result</h2>
    <mat-dialog-content>
      <p class="muted small">{{ m.bracket }} · {{ m.entryA.name }} vs {{ m.entryB.name }}.
        The old result stays in the audit log together with your reason.</p>

      <mat-form-field appearance="outline" class="full">
        <mat-label>Result type</mat-label>
        <mat-select [value]="status()" (selectionChange)="status.set($event.value)">
          <mat-option value="completed">Played to the end</mat-option>
          <mat-option value="retired">Retired (a side stopped)</mat-option>
          <mat-option value="walkover">Walkover (did not play)</mat-option>
        </mat-select>
      </mat-form-field>

      @if (status() !== 'walkover') {
        <div class="games">
          <div class="head"><span></span><strong>{{ m.entryA.name }}</strong><strong>{{ m.entryB.name }}</strong><span></span></div>
          @for (g of games(); track $index; let i = $index) {
            <div class="grow">
              <span class="muted">Game {{ i + 1 }}</span>
              <input type="number" min="0" max="99" [ngModel]="g.a" (ngModelChange)="set(i, 'a', $event)" [attr.aria-label]="'Game ' + (i + 1) + ' score of ' + m.entryA.name" />
              <input type="number" min="0" max="99" [ngModel]="g.b" (ngModelChange)="set(i, 'b', $event)" [attr.aria-label]="'Game ' + (i + 1) + ' score of ' + m.entryB.name" />
              <button mat-icon-button type="button" (click)="remove(i)" [disabled]="games().length <= 1" aria-label="Remove game"><mat-icon>close</mat-icon></button>
            </div>
          }
          <button mat-button type="button" (click)="add()" [disabled]="games().length >= 5"><mat-icon>add</mat-icon> Add game</button>
        </div>
      }

      @if (status() !== 'completed') {
        <mat-form-field appearance="outline" class="full">
          <mat-label>{{ status() === 'walkover' ? 'Who won the walkover?' : 'Who won (the side that did not retire)?' }}</mat-label>
          <mat-select [value]="winner()" (selectionChange)="winner.set($event.value)">
            <mat-option value="A">{{ m.entryA.name }}</mat-option>
            <mat-option value="B">{{ m.entryB.name }}</mat-option>
          </mat-select>
        </mat-form-field>
      }

      <mat-form-field appearance="outline" class="full">
        <mat-label>Reason for the correction</mat-label>
        <textarea matInput rows="2" maxlength="300" [(ngModel)]="reason" placeholder="e.g. Scorer pressed the wrong side"></textarea>
      </mat-form-field>
      @if (error()) { <p class="error-text" role="alert">{{ error() }}</p> }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button type="button" (click)="ref.close()">Cancel</button>
      <button mat-flat-button type="button" (click)="save()" [disabled]="busy() || reason.trim().length < 3">Save correction</button>
    </mat-dialog-actions>
  `,
  styles: `
    .full { width: 100%; }
    .games { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
    .head, .grow { display: grid; grid-template-columns: 60px 1fr 1fr 40px; gap: 8px; align-items: center; font-size: 13px; }
    .head strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .grow input { height: 40px; font: inherit; font-size: 18px; text-align: center; border: 1px solid var(--bt-border); border-radius: 8px; width: 100%; box-sizing: border-box; }
  `,
})
export class CorrectResultDialog {
  private readonly api = inject(Api);
  readonly ref = inject<MatDialogRef<CorrectResultDialog, MatchDto | undefined>>(MatDialogRef);
  readonly m = inject<{ match: MatchDto }>(MAT_DIALOG_DATA).match;

  readonly status = signal<'completed' | 'walkover' | 'retired'>(this.m.status === 'walkover' ? 'walkover' : this.m.status === 'retired' ? 'retired' : 'completed');
  readonly winner = signal<'A' | 'B' | ''>(this.m.winner ?? '');
  readonly games = signal<Row[]>(
    this.m.score.games.filter((g) => g.a + g.b > 0 || g.winner).map((g) => ({ a: g.a, b: g.b })) || [],
  );
  reason = '';
  readonly busy = signal(false);
  readonly error = signal('');

  constructor() {
    if (!this.games().length) this.games.set([{ a: null, b: null }]);
  }

  set(i: number, side: 'a' | 'b', v: number | null) {
    this.games.update((gs) => gs.map((g, k) => (k === i ? { ...g, [side]: v === null || (v as unknown) === '' ? null : Number(v) } : g)));
  }
  add() {
    this.games.update((gs) => [...gs, { a: null, b: null }]);
  }
  remove(i: number) {
    this.games.update((gs) => gs.filter((_, k) => k !== i));
  }

  async save() {
    this.error.set('');
    const status = this.status();
    const games = this.games();
    if (status !== 'walkover' && games.some((g) => g.a === null || g.b === null)) {
      this.error.set('Fill in both scores of every game, or remove the empty game.');
      return;
    }
    if (status !== 'completed' && !this.winner()) {
      this.error.set('Choose who won.');
      return;
    }
    this.busy.set(true);
    try {
      const updated = await this.api.post<MatchDto>(`/matches/${this.m.id}/correct`, {
        expectedVersion: this.m.version,
        reason: this.reason.trim(),
        status,
        winner: status === 'completed' ? undefined : this.winner() || undefined,
        games: status === 'walkover' ? undefined : games.map((g) => ({ a: g.a!, b: g.b! })),
      });
      this.ref.close(updated);
    } catch (e) {
      const err = apiError(e);
      // Someone else changed it: hand back the fresh state so the list refreshes.
      if (err?.error.code === 'version_conflict' && err.match) this.ref.close(err.match);
      else this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
}
