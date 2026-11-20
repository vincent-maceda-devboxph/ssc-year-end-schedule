import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import type { SystemInfo } from '@bt/shared';
import { Api, errorMessage } from '../../core/api.service';
import { isoToZonedInput, zonedInputToIso } from '../../shared/utilities/time';
import { TournamentContext } from '../tournaments/tournament-context';

@Component({
  selector: 'bt-courts-tab',
  imports: [FormsModule, MatButtonModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatSlideToggleModule, MatIconModule],
  template: `
    <div class="panel row">
      <form class="row grow" (ngSubmit)="add()">
        <mat-form-field appearance="outline"><mat-label>Court name</mat-label>
          <input matInput [(ngModel)]="name" name="name" placeholder="Court 1" required /></mat-form-field>
        <button mat-flat-button type="submit">Add court</button>
      </form>
      <mat-form-field appearance="outline" class="url">
        <mat-label>Address phones use</mat-label>
        <mat-select [ngModel]="baseUrl()" (ngModelChange)="baseUrl.set($event)" name="base">
          @for (u of urls(); track u) { <mat-option [value]="u">{{ u }}</mat-option> }
        </mat-select>
        <mat-hint>Pick this laptop's Wi-Fi address</mat-hint>
      </mat-form-field>
    </div>
    @if (error()) { <p class="error-text">{{ error() }}</p> }

    <div class="grid courts">
      @for (c of ctx.courts(); track c.id) {
        <div class="panel court">
          <div class="row">
            <strong class="grow">{{ c.name }}</strong>
            <mat-slide-toggle [checked]="c.active" (change)="toggle(c.id, $event.checked)">Active</mat-slide-toggle>
          </div>
          <img [src]="qrUrl(c.id)" [alt]="'QR code for ' + c.name" class="qr" />
          <div class="small muted link">{{ baseUrl() }}/umpire?court={{ c.id }}</div>
          @if (codes()[c.id]; as code) {
            <div class="code" aria-live="polite">Code: <strong>{{ code }}</strong></div>
            <div class="muted small">Shown once. Write it down or tell the umpire.</div>
          } @else {
            <div class="muted small">{{ c.hasCode ? 'Code set (hidden).' : 'No code yet – umpires cannot sign in.' }}</div>
          }
          <div class="avail">
            <mat-form-field appearance="outline"><mat-label>Open from</mat-label>
              <input matInput type="datetime-local" [value]="local(c.availableFrom)" (change)="setWindow(c.id, 'availableFrom', $any($event.target).value)" /></mat-form-field>
            <mat-form-field appearance="outline"><mat-label>Open until</mat-label>
              <input matInput type="datetime-local" [value]="local(c.availableUntil)" (change)="setWindow(c.id, 'availableUntil', $any($event.target).value)" /></mat-form-field>
            <div class="muted small">The scheduler only uses this court inside these times. Empty = no limit.</div>
          </div>
          <div class="row actions">
            <button mat-stroked-button (click)="newCode(c.id, c.hasCode)"><mat-icon>key</mat-icon>{{ c.hasCode ? 'New code' : 'Generate code' }}</button>
            <button mat-button (click)="remove(c.id)">Delete</button>
          </div>
        </div>
      } @empty { <p class="muted">No courts yet.</p> }
    </div>
    <p class="muted small">Generating a new code signs out every umpire on that court.</p>
  `,
  styles: `
    :host { display: block; padding-top: 16px; }
    .url { min-width: 260px; }
    .courts { margin-top: 16px; }
    .court { display: flex; flex-direction: column; gap: 8px; }
    .qr { width: 180px; height: 180px; align-self: center; background: #fff; }
    .link { word-break: break-all; text-align: center; }
    .code { font-size: 22px; letter-spacing: 2px; text-align: center; background: #e8f5e9; border-radius: 8px; padding: 8px; }
    .actions { justify-content: space-between; }
    .avail { display: flex; flex-direction: column; }
  `,
})
export class CourtsTab implements OnInit {
  readonly ctx = inject(TournamentContext);
  private readonly api = inject(Api);
  readonly urls = signal<string[]>([]);
  readonly tz = signal('Asia/Manila');
  readonly codes = signal<Record<string, string>>({});
  readonly error = signal('');
  readonly baseUrl = signal(location.origin);
  name = '';

  async ngOnInit() {
    try {
      this.tz.set((await this.api.get<{ timezone: string }>(`/tournaments/${this.ctx.id()}/schedule/settings`)).timezone);
      const info = await this.api.get<SystemInfo>('/system/info');
      // Prefer the LAN address over localhost so the QR works on phones.
      const urls = [...new Set([...info.urls, location.origin])];
      this.urls.set(urls);
      this.baseUrl.set(location.hostname === 'localhost' || location.hostname === '127.0.0.1' ? info.urls[0] ?? location.origin : location.origin);
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }

  /** ISO (UTC) -> value for a datetime-local field in the tournament timezone. */
  local(iso: string | null) {
    return isoToZonedInput(iso, this.tz());
  }

  setWindow(id: string, field: 'availableFrom' | 'availableUntil', value: string) {
    return this.run(async () => {
      await this.api.put(`/courts/${id}`, { [field]: value ? zonedInputToIso(value, this.tz()) : null });
      await this.ctx.loadCourts();
    });
  }

  qrUrl(courtId: string) {
    return `/api/courts/${courtId}/qr?base=${encodeURIComponent(this.baseUrl())}`;
  }

  private async run(fn: () => Promise<unknown>) {
    this.error.set('');
    try {
      await fn();
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }

  add() {
    return this.run(async () => {
      await this.api.post('/courts', { tournamentId: this.ctx.id(), name: this.name });
      this.name = '';
      await this.ctx.loadCourts();
    });
  }

  toggle(id: string, active: boolean) {
    return this.run(async () => {
      await this.api.patch(`/courts/${id}/status`, { status: active ? 'available' : 'unavailable' });
      await this.ctx.loadCourts();
    });
  }

  newCode(id: string, hasCode: boolean) {
    if (hasCode && !confirm('Generate a new code? Umpires on this court will be signed out.')) return;
    return this.run(async () => {
      const r = await this.api.post<{ code: string }>(`/courts/${id}/code`);
      this.codes.update((c) => ({ ...c, [id]: r.code }));
      await this.ctx.loadCourts();
    });
  }

  remove(id: string) {
    if (!confirm('Delete this court?')) return;
    return this.run(async () => {
      await this.api.delete(`/courts/${id}`);
      await this.ctx.loadCourts();
    });
  }
}
