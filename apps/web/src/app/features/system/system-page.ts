import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import type { TournamentDto } from '@bt/shared';
import { Api, apiError, errorMessage } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';

interface Backup { file: string; bytes: number; createdAt: string; kind: 'manual' | 'auto' | 'before-restore'; label: string }
interface Status {
  db: string;
  urls: string[];
  version: string;
  https: boolean;
  backup: { dir: string; mirrorDir: string | null; everyMinutes: number; keepAuto: number; running: boolean; lastAuto: { at: string; file: string } | null; lastError: string | null };
}
interface Integrity { ok: boolean; checkedAt: string; issues: { severity: string; code: string; message: string }[] }
interface AuditRow { id: string; at: string | null; actor: { kind: string; name: string } | null; action: string; entity: string; reason: string; before: unknown; after: unknown }
interface RestoreResult { restoredFrom: string; safetyBackup: string; integrity: { message: string }[] }

@Component({
  selector: 'bt-system-page',
  imports: [FormsModule, RouterLink, MatButtonModule, MatCheckboxModule, MatFormFieldModule, MatIconModule, MatInputModule, MatSelectModule],
  template: `
    <div class="page">
      <a routerLink="/admin" class="muted small">← Tournaments</a>
      <h1>System</h1>
      @if (error()) { <p class="error-text" role="alert">{{ error() }}</p> }
      @if (notice()) { <p class="notice">{{ notice() }}</p> }

      <!-- ---------------------------------------------------------------- status -->
      <section class="panel">
        <h3>Server</h3>
        @if (status(); as s) {
          <div class="row stat">
            <span class="chip" [class.live]="s.db === 'up'">Database {{ s.db }}</span>
            <span class="chip">Version {{ s.version }}</span>
            <span class="chip" [class.live]="s.https">{{ s.https ? 'HTTPS on' : 'HTTP (no HTTPS)' }}</span>
          </div>
          <p class="muted small">Phones join through one of these addresses (same Wi-Fi). Scan to open the live scores.</p>
          <div class="urls">
            @for (u of s.urls; track u) {
              <div class="url">
                <img [src]="'/api/system/qr?url=' + encode(u + '/live')" [alt]="'QR code for ' + u + '/live'" width="120" height="120" />
                <div><strong>{{ u }}</strong>
                  <div class="small muted">Spectators: {{ u }}/live<br />Umpires: {{ u }}/umpire<br />Admin: {{ u }}/admin</div></div>
              </div>
            }
          </div>
        }
      </section>

      <!-- ---------------------------------------------------------------- backups -->
      <section class="panel">
        <h3>Backups</h3>
        @if (status(); as s) {
          <p class="muted small">
            Saved to <code>{{ s.backup.dir }}</code>{{ s.backup.mirrorDir ? ' and copied to ' + s.backup.mirrorDir : ' (no second copy set up: set BACKUP_MIRROR_DIR to a USB stick)' }}.
            @if (s.backup.running) { Automatic backup every {{ s.backup.everyMinutes }} min when something changed, and shortly after each result. Last: {{ s.backup.lastAuto ? fmt(s.backup.lastAuto.at) : 'none yet' }}. }
            @else { <strong>Automatic backups are off.</strong> }
          </p>
          @if (s.backup.lastError) { <p class="error-text small">Last backup problem: {{ s.backup.lastError }}</p> }
        }
        <div class="row">
          <mat-form-field appearance="outline"><mat-label>Name (optional)</mat-label>
            <input matInput [(ngModel)]="label" name="label" maxlength="40" placeholder="before the finals" /></mat-form-field>
          <button mat-flat-button (click)="backupNow()" [disabled]="busy()"><mat-icon>save</mat-icon> Back up now</button>
        </div>

        <table class="simple">
          <thead><tr><th>When</th><th>Type</th><th>Name</th><th>Size</th><th></th></tr></thead>
          <tbody>
            @for (b of backups(); track b.file) {
              <tr>
                <td>{{ fmt(b.createdAt) }}</td>
                <td><span class="chip">{{ b.kind === 'before-restore' ? 'safety' : b.kind }}</span></td>
                <td class="small">{{ b.label }}</td>
                <td class="small">{{ size(b.bytes) }}</td>
                <td class="acts">
                  @if (isSuper()) {
                    <a mat-button [href]="'/api/system/backups/' + b.file + '/download'" download>Download</a>
                    <button mat-button (click)="askRestore(b)">Restore…</button>
                  }
                </td>
              </tr>
            } @empty { <tr><td colspan="5" class="muted">No backups yet. Click "Back up now".</td></tr> }
          </tbody>
        </table>
        @if (!isSuper()) { <p class="muted small">Downloading and restoring are for the Super Administrator.</p> }

        @if (restoring(); as r) {
          <div class="restore" role="alertdialog">
            <strong>Restore the backup from {{ fmt(r.createdAt) }}?</strong>
            <p>Everything saved <em>after</em> that time is replaced: scores, schedule changes, people. A safety copy of the current data is made first, so this can be undone.</p>
            @if (liveBlocked()) {
              <p class="error-text">Matches are being played right now. Restoring would wipe their scores.</p>
              <mat-checkbox [(ngModel)]="force" name="force">Restore anyway</mat-checkbox>
            }
            <mat-form-field appearance="outline"><mat-label>Type RESTORE to confirm</mat-label>
              <input matInput [(ngModel)]="confirmText" name="confirm" autocomplete="off" /></mat-form-field>
            <div class="row">
              <button mat-button (click)="restoring.set(null)">Cancel</button>
              <button mat-flat-button class="danger" (click)="doRestore()" [disabled]="busy() || confirmText !== 'RESTORE' || (liveBlocked() && !force)">Restore</button>
            </div>
          </div>
        }
      </section>

      <!-- ---------------------------------------------------------------- integrity -->
      <section class="panel">
        <div class="row"><h3 class="grow">Data check</h3>
          <button mat-stroked-button (click)="check()" [disabled]="busy()"><mat-icon>fact_check</mat-icon> Check data</button></div>
        <p class="muted small">Looks for things that should never happen: matches pointing at missing pairs or courts, two matches on one court and time, a saved score that disagrees with its point log, results without a winner.</p>
        @if (integrity(); as i) {
          <p [class.error-text]="!i.ok"><strong>{{ i.ok ? 'All good.' : i.issues.length + ' problem(s) found.' }}</strong> <span class="muted small">Checked {{ fmt(i.checkedAt) }}</span></p>
          @if (i.issues.length) { <ul>@for (x of i.issues; track $index) { <li [class.warn]="x.severity === 'warning'">{{ x.message }}</li> }</ul> }
        }
      </section>

      <!-- ---------------------------------------------------------------- audit -->
      <section class="panel">
        <h3>Audit log</h3>
        <div class="row">
          <mat-form-field appearance="outline"><mat-label>Tournament</mat-label>
            <mat-select [value]="auditTournament()" (selectionChange)="auditTournament.set($event.value); loadAudit()">
              <mat-option value="">All</mat-option>
              @for (t of tournaments(); track t.id) { <mat-option [value]="t.id">{{ t.name }}</mat-option> }
            </mat-select></mat-form-field>
          <mat-form-field appearance="outline"><mat-label>Action</mat-label>
            <mat-select [value]="auditAction()" (selectionChange)="auditAction.set($event.value); loadAudit()">
              <mat-option value="">All</mat-option>
              @for (a of actions; track a) { <mat-option [value]="a">{{ a.replace('_', ' ') }}</mat-option> }
            </mat-select></mat-form-field>
        </div>
        <div class="scroll">
          <table class="simple">
            <thead><tr><th>When</th><th>Who</th><th>What</th><th>Details</th></tr></thead>
            <tbody>
              @for (a of audit(); track a.id) {
                <tr>
                  <td class="small nowrap">{{ a.at ? fmt(a.at) : '' }}</td>
                  <td class="small">{{ a.actor?.name }}<span class="muted"> {{ a.actor?.kind }}</span></td>
                  <td>{{ a.action.replace('_', ' ') }} <span class="muted small">{{ a.entity }}</span></td>
                  <td class="small">
                    @if (a.reason) { <div><strong>Reason:</strong> {{ a.reason }}</div> }
                    @if (a.before || a.after) { <div class="muted">{{ summary(a.before) }} → {{ summary(a.after) }}</div> }
                  </td>
                </tr>
              } @empty { <tr><td colspan="4" class="muted">Nothing recorded.</td></tr> }
            </tbody>
          </table>
        </div>
        @if (audit().length >= limit()) { <button mat-button (click)="more()">Show more</button> }
      </section>
    </div>
  `,
  styles: `
    h1 { font-weight: 500; } h3 { margin: 0 0 8px; font-weight: 500; }
    .page { display: flex; flex-direction: column; gap: 16px; }
    .notice { background: #e8f5e9; padding: 8px 12px; border-radius: 8px; margin: 0; }
    .urls { display: flex; flex-wrap: wrap; gap: 16px; }
    .url { display: flex; gap: 12px; align-items: center; }
    .stat { margin-bottom: 8px; }
    .acts { white-space: nowrap; text-align: right; }
    .nowrap { white-space: nowrap; }
    .scroll { overflow-x: auto; }
    .restore { margin-top: 12px; padding: 12px 16px; border: 2px solid #ef6c00; border-radius: 12px; background: #fff8e1; }
    .danger { background: #c62828; color: #fff; }
    li.warn { color: #ef6c00; }
  `,
})
export class SystemPage implements OnInit {
  private readonly api = inject(Api);
  private readonly auth = inject(AuthService);

  readonly error = signal('');
  readonly notice = signal('');
  readonly busy = signal(false);
  readonly status = signal<Status | null>(null);
  readonly backups = signal<Backup[]>([]);
  readonly integrity = signal<Integrity | null>(null);
  readonly tournaments = signal<TournamentDto[]>([]);
  readonly audit = signal<AuditRow[]>([]);
  readonly limit = signal(50);
  readonly auditTournament = signal('');
  readonly auditAction = signal('');
  readonly restoring = signal<Backup | null>(null);
  readonly liveBlocked = signal(false);
  readonly isSuper = computed(() => this.auth.admin()?.role === 'super_admin');
  readonly actions = ['create', 'update', 'delete', 'correct_result', 'generate_matches', 'import_lineup', 'save_schedule', 'publish_schedule', 'move_match', 'swap_matches', 'unschedule_match', 'call', 'lock', 'backup', 'restore'];
  label = '';
  confirmText = '';
  force = false;

  async ngOnInit() {
    await Promise.all([this.loadStatus(), this.loadBackups(), this.loadAudit(), this.api.get<TournamentDto[]>('/tournaments').then((t) => this.tournaments.set(t))]).catch((e) => this.error.set(errorMessage(e)));
  }

  encode = encodeURIComponent;
  fmt = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  size = (b: number) => (b > 1_048_576 ? `${(b / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
  summary(v: unknown): string {
    if (v === null || v === undefined) return '–';
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s.length > 140 ? s.slice(0, 140) + '…' : s;
  }

  private async run(fn: () => Promise<unknown>) {
    this.error.set('');
    this.busy.set(true);
    try {
      await fn();
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  async loadStatus() {
    this.status.set(await this.api.get<Status>('/system/status'));
  }
  async loadBackups() {
    this.backups.set(await this.api.get<Backup[]>('/system/backups'));
  }
  async loadAudit() {
    this.audit.set(await this.api.get<AuditRow[]>('/audit', { limit: String(this.limit()), tournamentId: this.auditTournament() || undefined, action: this.auditAction() || undefined }));
  }
  more() {
    this.limit.update((n) => n + 100);
    return this.run(() => this.loadAudit());
  }

  backupNow() {
    return this.run(async () => {
      const r = await this.api.post<{ file: string; mirror: { ok: boolean; error?: string } | null }>('/system/backups', { label: this.label });
      this.label = '';
      this.notice.set(r.mirror && !r.mirror.ok ? `Backup saved, but the second copy failed: ${r.mirror.error}` : 'Backup saved.');
      await Promise.all([this.loadBackups(), this.loadStatus()]);
    });
  }

  check() {
    return this.run(async () => this.integrity.set(await this.api.get<Integrity>('/system/integrity')));
  }

  askRestore(b: Backup) {
    this.restoring.set(b);
    this.confirmText = '';
    this.force = false;
    this.liveBlocked.set(false);
    this.error.set('');
  }

  doRestore() {
    const b = this.restoring();
    if (!b) return;
    return this.run(async () => {
      try {
        const r = await this.api.post<RestoreResult>(`/system/backups/${b.file}/restore`, { confirm: 'RESTORE', force: this.force });
        this.restoring.set(null);
        this.notice.set(`Restored from ${this.fmt(b.createdAt)}. Safety copy: ${r.safetyBackup}.${r.integrity.length ? ` The data check found ${r.integrity.length} problem(s).` : ' The data check is clean.'}`);
        await Promise.all([this.loadBackups(), this.loadAudit(), this.loadStatus()]);
      } catch (e) {
        if (apiError(e)?.error.code === 'matches_live') this.liveBlocked.set(true);
        throw e;
      }
    });
  }
}
