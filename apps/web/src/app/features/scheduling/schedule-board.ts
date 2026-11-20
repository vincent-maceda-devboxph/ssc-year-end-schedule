import { TeamLogo } from '../../shared/components/team-logo';
import { CdkDrag, type CdkDragEnd, type CdkDragMove } from '@angular/cdk/drag-drop';
import { Component, computed, input, output, signal } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { COURT_STATUS_LABELS, isFinal, isLive, STATUS_LABELS, type CourtStatus, type MatchDto } from '@bt/shared';
import { downloadBlob, renderScheduleImage, type ImageEntry } from '../../shared/utilities/schedule-image';
import { formatRange } from '../../shared/utilities/time';

export interface BoardCell {
  matchId: string;
  courtId: string;
  slot: number;
  gameNumber: number;
  /** Locked, live, called or finished: will not move when the schedule is regenerated. */
  fixed?: boolean;
}

export interface BoardMove {
  matchId: string;
  /** null = take the match off the schedule. */
  courtId: string | null;
  slot?: number;
  /** The match already in the target cell (exchange places). */
  swapWith?: string | null;
}

type Target = { kind: 'cell'; slot: number; courtId: string } | { kind: 'tray' };

/**
 * Court × time grid like the reference sheet: one row per time slot, one column per court, cells
 * coloured by team. In edit mode a match can be dragged (Angular CDK) to another cell, onto another
 * match to swap, or onto the tray to take it off the schedule. The board only reports the wish;
 * the server decides and the board redraws from the result.
 */
@Component({
  selector: 'bt-schedule-board',
  imports: [TeamLogo, MatIconModule, CdkDrag],
  template: `
    @if (editable()) {
      <div class="tray no-print" data-drop="tray" [class.hover]="hover() === 'tray'">
        <div class="traytitle">
          <strong>Not yet scheduled ({{ unscheduled().length }})</strong>
          <span class="muted small"> · drag a match onto a court and time; drag a scheduled match back here to take it off</span>
        </div>
        <div class="chips">
          @for (m of unscheduled(); track m.id) {
            <div class="mchip" cdkDrag [cdkDragData]="m.id" [cdkDragStartDelay]="delay"
                 (cdkDragMoved)="onMoved($event)" (cdkDragEnded)="onEnded($event, m.id)">
              <span class="dots"><span [style.background]="m.teamA?.color ?? '#ccc'"></span><span [style.background]="m.teamB?.color ?? '#ccc'"></span></span>
              <strong>{{ m.bracket }}</strong> {{ m.entryA.name }} vs {{ m.entryB.name }}
            </div>
          } @empty { <span class="muted small">Everything is scheduled.</span> }
        </div>
      </div>
    }

    @if (!courts().length) { <p class="muted">No courts.</p> }
    @else {
      <div class="scroll">
        <div class="grid" [style.grid-template-columns]="'104px repeat(' + courts().length + ', minmax(240px, 1fr))'">
          <div class="corner"></div>
          @for (c of courts(); track c.id) {
            <div class="chead">{{ c.name }}
              @if (c.status) { <span class="cs" [class]="'cs ' + c.status">{{ courtLabels[c.status] }}</span> }
            </div>
          }

          @for (row of rows(); track row.slot) {
            <div class="time">{{ row.label }}</div>
            @for (c of courts(); track c.id) {
              @let cell = cellAt(row.slot, c.id);
              @let m = cell ? matches().get(cell.matchId) : undefined;
              <div class="slot" data-drop="cell" [attr.data-slot]="row.slot" [attr.data-court]="c.id" [class.hover]="hover() === row.slot + ':' + c.id">
                @if (cell && m) {
                  <div class="cell" [class.fixed]="cell.fixed" [class.live]="isLive(m.status)" [class.done]="isFinal(m.status)" [class.called]="m.status === 'called'"
                       [class.dim]="highlight() && !highlight()!.has(m.id)"
                       cdkDrag [cdkDragData]="m.id" [cdkDragDisabled]="!canDrag(cell, m)" [cdkDragStartDelay]="delay"
                       (cdkDragMoved)="onMoved($event)" (cdkDragEnded)="onEnded($event, m.id)">
                    <div class="cmeta">
                      <strong class="gno">{{ cell.gameNumber }}</strong>
                      <span class="div">{{ m.bracket }}</span>
                      <span class="grow"></span>
                      @if (isFinal(m.status) || isLive(m.status) || m.status === 'called') { <span class="status">{{ labels[m.status] }}</span> }
                      @if (editable() && (m.status === 'scheduled' || m.status === 'ready')) {
                        <button type="button" class="act" (mousedown)="$event.stopPropagation()" (touchstart)="$event.stopPropagation()"
                                (click)="callToggle.emit({ matchId: m.id, call: true })" aria-label="Call match to court" title="Call to court"><mat-icon inline>campaign</mat-icon></button>
                      }
                      @if (editable() && m.status === 'called') {
                        <button type="button" class="act on" (mousedown)="$event.stopPropagation()" (touchstart)="$event.stopPropagation()"
                                (click)="callToggle.emit({ matchId: m.id, call: false })" aria-label="Cancel call" title="Cancel call"><mat-icon inline>phone_disabled</mat-icon></button>
                      }
                      @if (m.isLocked && editable()) {
                        <button type="button" class="act on" (mousedown)="$event.stopPropagation()" (touchstart)="$event.stopPropagation()"
                                (click)="lockToggle.emit({ matchId: m.id, locked: false })" aria-label="Unlock match" title="Unlock"><mat-icon inline>lock</mat-icon></button>
                      } @else if (m.isLocked) { <mat-icon inline class="lockicon">lock</mat-icon> }
                      @else if (editable() && !isLive(m.status) && !isFinal(m.status) && m.status !== 'called') {
                        <button type="button" class="act" (mousedown)="$event.stopPropagation()" (touchstart)="$event.stopPropagation()"
                                (click)="lockToggle.emit({ matchId: m.id, locked: true })" aria-label="Lock match" title="Lock"><mat-icon inline>lock_open</mat-icon></button>
                      }
                    </div>
                    <div class="side" [class.win]="m.winner === 'A'">
                      <span class="bar" [style.background]="m.teamA?.color ?? '#cbd5e1'"></span>
                      @if (m.teamA) { <bt-team-logo [team]="m.teamA" [size]="24" /> }
                      <span class="who"><span class="p">{{ m.entryA.name }}</span><span class="t">{{ m.teamA?.name }}</span></span>
                    </div>
                    <div class="side" [class.win]="m.winner === 'B'">
                      <span class="bar" [style.background]="m.teamB?.color ?? '#cbd5e1'"></span>
                      @if (m.teamB) { <bt-team-logo [team]="m.teamB" [size]="24" /> }
                      <span class="who"><span class="p">{{ m.entryB.name }}</span><span class="t">{{ m.teamB?.name }}</span></span>
                    </div>
                  </div>
                } @else { <div class="cell empty"></div> }
              </div>
            }
          }
        </div>
      </div>
    }
  `,
  styles: `
    .scroll { overflow: auto; max-height: 78vh; border-radius: 16px; }
    .grid { display: grid; gap: 8px; align-items: stretch; min-width: max-content; padding: 2px; }
    .corner { position: sticky; top: 0; left: 0; z-index: 3; background: var(--bt-bg); }
    .chead { position: sticky; top: 0; z-index: 2; text-align: center; font-weight: 800; font-size: 15px; padding: 10px 6px; color: #fff; background: var(--bt-brand);
      border-radius: 12px; display: flex; flex-direction: column; align-items: center; gap: 4px; box-shadow: var(--bt-shadow); }
    .cs { font-size: 11px; font-weight: 700; padding: 1px 10px; border-radius: 999px; background: rgba(255,255,255,.2); color: #fff; }
    .cs.ongoing { background: #bbf7d0; color: #166534; }
    .cs.called { background: #ddd6fe; color: #5b21b6; }
    .cs.unavailable { background: #fecaca; color: #991b1b; }
    .time { position: sticky; left: 0; z-index: 1; font-size: 13px; font-weight: 700; color: var(--bt-ink); display: flex; align-items: center; justify-content: flex-start; text-align: left; padding: 0 8px; background: var(--bt-bg); line-height: 1.3; }
    .slot { display: flex; flex-direction: column; border-radius: 14px; }
    .slot.hover { outline: 2px dashed var(--bt-brand); outline-offset: 2px; background: #ccfbf1; }
    .cell { flex: 1; background: #fff; border: 1px solid var(--bt-border); border-radius: 14px; overflow: hidden; font-size: 13px; box-shadow: 0 1px 2px rgba(15,23,42,.05); }
    .cell:not(.fixed):not(.empty) { cursor: grab; }
    .cell.empty { border: 2px dashed var(--bt-border); background: transparent; min-height: 96px; box-shadow: none; }
    .cell.fixed { border-color: #94a3b8; }
    .cell.called { border-color: #8b5cf6; box-shadow: 0 0 0 2px rgba(139,92,246,.25); }
    .cell.live { border-color: #10b981; box-shadow: 0 0 0 3px rgba(16,185,129,.22); }
    .cell.done { opacity: .7; }
    .cell.dim { opacity: .18; }
    .cmeta { display: flex; align-items: center; gap: 8px; padding: 6px 10px; background: #f8fafc; border-bottom: 1px solid var(--bt-border); font-size: 12px; }
    .gno { background: var(--bt-brand); color: #fff; border-radius: 8px; padding: 1px 8px; font-size: 13px; }
    .div { color: #475569; font-weight: 600; }
    .grow { flex: 1; }
    .status { font-size: 11px; color: #047857; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; }
    .side { display: flex; align-items: center; gap: 8px; padding: 7px 10px 7px 0; }
    .side + .side { border-top: 1px solid #f1f5f9; }
    .bar { width: 6px; align-self: stretch; border-radius: 0 6px 6px 0; flex: none; }
    .who { display: flex; flex-direction: column; min-width: 0; line-height: 1.25; }
    .side.win .p { font-weight: 800; }
    .t { font-size: 11px; color: var(--bt-muted); }
    .p { font-size: 14px; font-weight: 600; color: var(--bt-ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .act { border: 0; background: none; padding: 2px; cursor: pointer; color: #94a3b8; display: inline-flex; border-radius: 6px; }
    .act.on, .lockicon { color: #334155; }
    .act:hover { color: var(--bt-brand); background: #f1f5f9; }

    .tray { border: 2px dashed var(--bt-border); border-radius: 12px; padding: 10px 12px; margin-bottom: 14px; background: #fcfcfa; }
    .tray.hover { border-color: var(--bt-ok); background: #e8f5e9; }
    .traytitle { margin-bottom: 6px; }
    .chips { display: flex; flex-wrap: wrap; gap: 6px; max-height: 150px; overflow: auto; }
    .mchip { display: inline-flex; align-items: center; gap: 6px; background: #fff; border: 1px solid var(--bt-border); border-radius: 999px; padding: 3px 10px 3px 8px; font-size: 12px; cursor: grab; }
    .dots { display: inline-flex; gap: 2px; }
    .dots span { width: 9px; height: 9px; border-radius: 50%; border: 1px solid #0002; }
    :host ::ng-deep .cdk-drag-preview { box-shadow: 0 6px 18px #0004; border-radius: 8px; background: #fff; opacity: .95; }
    :host ::ng-deep .cdk-drag-placeholder { opacity: .3; }
  `,
})
export class ScheduleBoard {
  readonly courts = input.required<{ id: string; name: string; status?: CourtStatus }[]>();
  readonly cells = input.required<BoardCell[]>();
  readonly matches = input.required<Map<string, MatchDto>>();
  readonly unscheduled = input<MatchDto[]>([]);
  /** Matches that pass the filters; every other match is dimmed. null = no filter. */
  readonly highlight = input<Set<string> | null>(null);
  readonly startAt = input.required<string>();
  readonly matchMinutes = input.required<number>();
  readonly timezone = input.required<string>();
  /** Allow drag and drop, lock and call. */
  readonly editable = input(false);
  /** Used in exported images. */
  readonly title = input('Schedule');
  readonly subtitle = input('');
  readonly lockToggle = output<{ matchId: string; locked: boolean }>();
  readonly callToggle = output<{ matchId: string; call: boolean }>();
  readonly moveRequest = output<BoardMove>();

  readonly labels = STATUS_LABELS;
  readonly courtLabels = COURT_STATUS_LABELS;
  readonly isLive = isLive;
  readonly isFinal = isFinal;
  /** Touch: press and hold briefly so scrolling the board still works. */
  readonly delay = { touch: 200, mouse: 0 };
  readonly hover = signal<string | null>(null);

  private readonly index = computed(() => new Map(this.cells().map((c) => [`${c.slot}:${c.courtId}`, c])));
  readonly rows = computed(() => {
    const max = this.cells().reduce((mx, c) => Math.max(mx, c.slot), -1);
    // In edit mode keep a few empty rows below so a match can be placed later in the day.
    const count = Math.max(max + 1 + (this.editable() ? 3 : 0), this.editable() ? 6 : 0);
    const start = Date.parse(this.startAt());
    const unit = this.matchMinutes() * 60_000;
    return Array.from({ length: count }, (_, slot) => ({
      slot,
      label: formatRange(new Date(start + slot * unit).toISOString(), new Date(start + (slot + 1) * unit).toISOString(), this.timezone()),
    }));
  });

  /** Draw the schedule as a PNG and download it: every court as a grid, or one court as a list. */
  async exportImage(courtId: string | null): Promise<void> {
    const matches = this.matches();
    const entries: ImageEntry[] = [];
    for (const cell of this.cells()) {
      const m = matches.get(cell.matchId);
      const court = this.courts().find((c) => c.id === cell.courtId);
      const row = this.rows().find((r) => r.slot === cell.slot);
      if (m && court && row) entries.push({ slot: cell.slot, time: row.label, courtId: court.id, courtName: court.name, gameNumber: cell.gameNumber, match: m });
    }
    const used = new Set(entries.map((e) => e.slot));
    const blob = await renderScheduleImage({
      title: this.title(),
      subtitle: this.subtitle(),
      courts: this.courts(),
      rows: this.rows().filter((r) => used.has(r.slot)),
      entries,
      courtId,
    });
    const name = courtId ? this.courts().find((c) => c.id === courtId)?.name ?? 'court' : 'all-courts';
    downloadBlob(blob, `schedule-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.png`);
  }

  cellAt(slot: number, courtId: string) {
    return this.index().get(`${slot}:${courtId}`);
  }

  canDrag(cell: BoardCell, m: MatchDto): boolean {
    return this.editable() && !cell.fixed && !m.isLocked && (m.status === 'pending' || m.status === 'scheduled' || m.status === 'ready');
  }

  // ---- drag and drop: the board reports where the match was dropped, the server decides ----
  private point(ev: MouseEvent | TouchEvent): { x: number; y: number } {
    if ('changedTouches' in ev && ev.changedTouches.length) return { x: ev.changedTouches[0]!.clientX, y: ev.changedTouches[0]!.clientY };
    const m = ev as MouseEvent;
    return { x: m.clientX, y: m.clientY };
  }

  /**
   * The drop zone under the pointer. When a drag ends, the dragged card has just been put back
   * under the pointer, so it (and its own slot) must be skipped: look through it to what is below.
   */
  private targetAt(ev: MouseEvent | TouchEvent, dragged?: HTMLElement): Target | null {
    const { x, y } = this.point(ev);
    const hit = document.elementsFromPoint(x, y).find((n) => !dragged?.contains(n) && n.closest('[data-drop]'));
    const el = hit?.closest<HTMLElement>('[data-drop]');
    if (!el) return null;
    if (el.dataset['drop'] === 'tray') return { kind: 'tray' };
    const slot = Number(el.dataset['slot']);
    return Number.isInteger(slot) && el.dataset['court'] ? { kind: 'cell', slot, courtId: el.dataset['court'] } : null;
  }

  onMoved(e: CdkDragMove) {
    const t = this.targetAt(e.event);
    this.hover.set(!t ? null : t.kind === 'tray' ? 'tray' : `${t.slot}:${t.courtId}`);
  }

  onEnded(e: CdkDragEnd, matchId: string) {
    const t = this.targetAt(e.event, e.source.element.nativeElement);
    e.source.reset(); // the board redraws from the server's answer, so the dragged card snaps back first
    this.hover.set(null);
    if (!t) return;
    if (t.kind === 'tray') {
      if (this.cells().some((c) => c.matchId === matchId)) this.moveRequest.emit({ matchId, courtId: null });
      return;
    }
    const occupant = this.cellAt(t.slot, t.courtId);
    if (occupant?.matchId === matchId) return; // dropped back where it was
    this.moveRequest.emit({ matchId, courtId: t.courtId, slot: t.slot, swapWith: occupant?.matchId ?? null });
  }
}
