import { Component, computed, input } from '@angular/core';
import { STATUS_LABELS, type MatchDto } from '@bt/shared';

/** Read-only knockout tree: one column per round, the third-place match underneath. Undecided sides show "TBD". */
@Component({
  selector: 'bt-bracket-view',
  template: `
    <div class="tree">
      @for (col of rounds(); track col.round) {
        <div class="col">
          <h4>{{ col.label }}</h4>
          @for (m of col.matches; track m.id) { <ng-container *ngTemplateOutlet="cell; context: { $implicit: m }" /> }
        </div>
      }
    </div>
    @if (third(); as t) {
      <h4 class="third">Third place</h4>
      <div class="tree"><div class="col"><ng-container *ngTemplateOutlet="cell; context: { $implicit: t }" /></div></div>
    }
    <ng-template #cell let-m>
      <div class="cell" [class.live]="m.status === 'in_progress'">
        @for (side of sides; track side) {
          @let e = side === 'A' ? m.entryA : m.entryB;
          <div class="line" [class.win]="m.winner === side" [class.tbd]="!e.id">
            <span class="nm">{{ e.name }}</span>
            <span class="sc">{{ score(m, side) }}</span>
          </div>
        }
        <div class="foot muted small">#{{ m.matchNumber }} · {{ status(m) }}@if (m.courtName) { · {{ m.courtName }} }</div>
      </div>
    </ng-template>
  `,
  styles: `
    .tree { display: flex; gap: 20px; overflow-x: auto; padding-bottom: 8px; align-items: stretch; }
    .col { display: flex; flex-direction: column; justify-content: space-around; gap: 12px; min-width: 210px; }
    h4 { margin: 0 0 4px; font-size: 13px; color: var(--bt-muted, #666); text-transform: uppercase; letter-spacing: .04em; }
    .third { margin-top: 16px; }
    .cell { border: 1px solid var(--bt-border, #ccc); border-radius: 8px; padding: 6px 8px; background: var(--bt-surface, #fff); }
    .cell.live { border-color: #2e7d32; box-shadow: 0 0 0 2px rgba(46,125,50,.2); }
    .line { display: flex; justify-content: space-between; gap: 8px; padding: 2px 0; }
    .line.win .nm { font-weight: 700; }
    .line.tbd .nm { color: var(--bt-muted, #888); font-style: italic; }
    .sc { font-variant-numeric: tabular-nums; }
    .foot { margin-top: 2px; }
  `,
  imports: [NgTemplateOutletDirective],
})
export class BracketView {
  readonly matches = input.required<MatchDto[]>();
  readonly sides = ['A', 'B'] as const;

  readonly rounds = computed(() => {
    const byRound = new Map<number, MatchDto[]>();
    for (const m of this.matches()) {
      if (!m.stage || m.stage.third) continue;
      byRound.set(m.stage.round, [...(byRound.get(m.stage.round) ?? []), m]);
    }
    return [...byRound.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([round, list]) => ({ round, label: list[0]!.stage!.roundLabel, matches: list.sort((a, b) => a.stage!.pos - b.stage!.pos) }));
  });
  readonly third = computed(() => this.matches().find((m) => m.stage?.third) ?? null);

  status(m: MatchDto) {
    return STATUS_LABELS[m.status] ?? m.status;
  }
  score(m: MatchDto, side: 'A' | 'B') {
    return m.score.games.map((g) => (side === 'A' ? g.a : g.b)).join(' ');
  }
}

import { NgTemplateOutlet as NgTemplateOutletDirective } from '@angular/common';
