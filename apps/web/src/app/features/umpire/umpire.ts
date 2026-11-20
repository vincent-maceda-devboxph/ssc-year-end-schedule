import { Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatMenuModule } from '@angular/material/menu';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import {
  canRunCommand,
  formatGames,
  isFinal,
  STATUS_LABELS,
  type CommandResult,
  type CourtDto,
  type MatchCommand,
  type MatchDto,
  type ScoreNotice,
  type Side,
  type TournamentDto,
  type UmpireCurrentResponse,
} from '@bt/shared';
import { Api, apiError, errorMessage } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { Realtime } from '../../core/realtime.service';
import { ConnectionBadge } from '../../shared/components/connection-badge';
import { delay, uuid } from '../../shared/utilities/ids';
import { formatLocalTime } from '../../shared/utilities/time';

const ROUTE: Record<MatchCommand, string> = {
  start: 'start', point: 'points', undo: 'undo', pause: 'pause', resume: 'resume', submit: 'complete', retire: 'retire', servers: 'servers',
};
const NOTICE_TEXT: Record<ScoreNotice, string> = {
  interval: 'Interval – 60 seconds',
  interval_change_ends: 'Interval – change ends',
  game_won: 'Game over – change ends',
  match_won: 'Match point won',
};
const NAME_KEY = 'bt.umpireName';

@Component({
  selector: 'bt-umpire',
  imports: [
    FormsModule, MatButtonModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatIconModule,
    MatMenuModule, MatProgressBarModule, ConnectionBadge,
  ],
  templateUrl: './umpire.html',
  styleUrl: './umpire.scss',
})
export class Umpire implements OnInit {
  private readonly api = inject(Api);
  private readonly auth = inject(AuthService);
  private readonly rt = inject(Realtime);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  readonly labels = STATUS_LABELS;
  readonly formatGames = formatGames;
  readonly time = formatLocalTime;

  // ---- session ----
  readonly ready = signal(false);
  readonly session = this.auth.umpire;

  // ---- login form ----
  readonly tournaments = signal<TournamentDto[]>([]);
  readonly courts = signal<CourtDto[]>([]);
  tournamentId = '';
  courtId = '';
  code = '';
  name = '';
  readonly loginError = signal('');
  readonly loggingIn = signal(false);

  // ---- scoring ----
  readonly current = signal<UmpireCurrentResponse | null>(null);
  readonly match = computed(() => this.current()?.match ?? null);
  readonly busy = signal(false);
  readonly message = signal<{ text: string; kind: 'info' | 'error' } | null>(null);
  /** Swap which side is shown on top, to match where the umpire sits. Display only. */
  readonly flipped = signal(false);

  readonly inControl = computed(() => {
    const m = this.match();
    return !!m && (!m.umpireKey || m.umpireKey === this.current()?.myKey);
  });
  readonly canScore = computed(() => this.rt.connected() && !this.busy() && this.inControl());
  readonly game = computed(() => {
    const m = this.match();
    return m ? m.score.games[m.score.currentGame]! : null;
  });
  readonly previousGames = computed(() => {
    const m = this.match();
    return m ? m.score.games.slice(0, m.score.currentGame) : [];
  });
  readonly notice = computed(() => {
    const n = this.match()?.score.notice;
    return n && n !== 'match_won' && this.match()?.status === 'in_progress' ? NOTICE_TEXT[n] : null;
  });
  readonly sides = computed<Side[]>(() => (this.flipped() ? ['B', 'A'] : ['A', 'B']));
  readonly isFinal = isFinal;
  /** Scheduled, ready and called matches all show the start screen. */
  readonly phase = computed(() => {
    const s = this.match()?.status;
    return s === 'scheduled' || s === 'ready' || s === 'called' ? 'prestart' : s;
  });

  async ngOnInit() {
    const qp = this.route.snapshot.queryParamMap;
    this.courtId = qp.get('court') ?? '';
    this.name = safeGet(NAME_KEY);
    try {
      const me = await this.auth.load(true);
      if (me.umpire && (!this.courtId || me.umpire.courtId === this.courtId)) await this.enterScoring();
      else this.loginError.set('');
    } catch (e) {
      this.loginError.set(errorMessage(e));
    } finally {
      this.ready.set(true);
    }
  }

  // ---------------- login ----------------
  async login() {
    this.loginError.set('');
    if (!this.courtId || !/^\d{6}$/.test(this.code) || this.name.trim().length < 2) {
      this.loginError.set('Enter the 6-digit court code and your name.');
      return;
    }
    this.loggingIn.set(true);
    try {
      await this.auth.loginUmpire(this.courtId, this.code, this.name.trim());
      safeSet(NAME_KEY, this.name.trim());
      this.code = '';
      this.rt.restart(); // reconnect so the socket carries the umpire session
      await this.enterScoring();
    } catch (e) {
      this.loginError.set(errorMessage(e));
    } finally {
      this.loggingIn.set(false);
    }
  }

  async logout() {
    await this.auth.logoutUmpire().catch(() => undefined);
    this.current.set(null);
    this.rt.restart();
  }

  // ---------------- scoring ----------------
  private subscribed = false;

  private async enterScoring() {
    await this.reload();
    keepScreenOn();
    if (this.subscribed) return;
    this.subscribed = true;
    const courtId = this.session()!.courtId;
    this.rt.watch(`court:${courtId}`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe();
    this.rt.match$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(({ match }) => {
      const mine = this.match();
      if (mine && match.id === mine.id) this.apply(match);
      else if (match.courtId === courtId || mine?.id === match.id) void this.reload();
    });
    this.rt.reconnected$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => void this.reload());
    // A published schedule changes what is on this court: reload the current and upcoming matches.
    this.rt.tournamentEvent$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((e) => {
      if (e.event === 'schedule:updated') void this.reload();
    });
  }

  async reload() {
    try {
      this.current.set(await this.api.get<UmpireCurrentResponse>('/umpire/current'));
    } catch (e) {
      const err = apiError(e);
      if (err?.status === 401) {
        // Code regenerated or session expired.
        await this.auth.load(true);
        this.current.set(null);
        this.loginError.set('Your court session ended. Please sign in again.');
      } else {
        this.flash(errorMessage(e), 'error');
      }
    }
  }

  /** Only move forward in versions; never let a late response roll the score back. */
  private apply(m: MatchDto) {
    const cur = this.current();
    if (!cur) return;
    if (cur.match && cur.match.id === m.id && cur.match.version > m.version) return;
    this.current.set({ ...cur, match: m });
  }

  point(side: Side) {
    navigator.vibrate?.(25);
    void this.send('point', side);
  }

  can(cmd: MatchCommand) {
    const m = this.match();
    return !!m && canRunCommand(m.status, cmd);
  }

  async confirmSend(cmd: MatchCommand, question: string, side?: Side) {
    if (confirm(question)) await this.send(cmd, side);
  }

  /**
   * Send one command. The actionId is generated once per tap and reused on every retry, so a
   * retry after a lost response can never add a second point (server returns duplicate: true).
   */
  async send(type: MatchCommand, side?: Side, extra: { server?: 0 | 1; receiver?: 0 | 1 } = {}) {
    const m = this.match();
    if (!m || this.busy()) return;
    if (!this.rt.connected()) {
      this.flash('Offline – scoring is paused until the connection is back.', 'error');
      return;
    }
    this.busy.set(true);
    const body = { actionId: uuid(), expectedVersion: m.version, side, ...extra };
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          const r = await this.api.post<CommandResult>(`/matches/${m.id}/${ROUTE[type]}`, body);
          this.apply(r.match);
          if (type === 'submit' || type === 'retire') this.flash('Result submitted. Thank you!', 'info');
          return;
        } catch (e) {
          const err = apiError(e);
          if (err) {
            if (err.match) this.apply(err.match);
            if (err.error.code === 'controlled_by_other' || err.error.code === 'wrong_court') await this.reload();
            this.flash(err.error.message, 'error');
            return;
          }
          // Network failure: retry the same actionId a few times.
          if (attempt >= 4) {
            this.flash('Server not reachable. That tap may not have counted – check the score once reconnected.', 'error');
            await this.reload();
            return;
          }
          await delay(600 * (attempt + 1));
        }
      }
    } finally {
      this.busy.set(false);
    }
  }

  async takeOver() {
    const m = this.match();
    if (!m || !confirm(`Take over scoring from ${m.umpireName}?`)) return;
    try {
      const r = await this.api.post<CommandResult>(`/matches/${m.id}/takeover`);
      this.apply(r.match);
      this.flash('You are now scoring this match.', 'info');
    } catch (e) {
      this.flash(errorMessage(e), 'error');
      await this.reload();
    }
  }

  // ---- doubles service: who serves and receives ----
  /** The choice being made in the "who serves first" card (null = not choosing). */
  readonly pick = signal<{ side: Side; server: 0 | 1; receiver: 0 | 1 } | null>(null);
  readonly serving = computed(() => this.match()?.serving ?? null);
  /** Ask for the first server at the start of every game, until the umpire has confirmed it. */
  readonly needsServer = computed(() => {
    const m = this.match();
    const sv = this.serving();
    const g = this.game();
    return !!m && !!sv && m.status === 'in_progress' && !sv.confirmed && !!g && g.a + g.b === 0;
  });
  readonly choice = computed(() => this.pick() ?? (this.serving() ? { side: this.serving()!.side, server: this.serving()!.server, receiver: this.serving()!.receiver } : null));

  openPicker() {
    const sv = this.serving();
    if (sv) this.pick.set({ side: sv.side, server: sv.server, receiver: sv.receiver });
  }
  choose(patch: Partial<{ side: Side; server: 0 | 1; receiver: 0 | 1 }>) {
    const c = this.choice();
    if (c) this.pick.set({ ...c, ...patch });
  }
  async confirmServers() {
    const c = this.choice();
    if (!c) return;
    await this.send('servers', c.side, { server: c.server, receiver: c.receiver });
    this.pick.set(null);
  }
  /** "Right" / "Left" court of a player on a side, for the umpire's reference. */
  courtOf(side: Side, idx: 0 | 1): string {
    const sv = this.serving();
    return sv ? (sv.right[side] === idx ? 'R' : 'L') : '';
  }
  other(side: Side): Side {
    return side === 'A' ? 'B' : 'A';
  }

  nameOf(side: Side) {
    const m = this.match();
    return side === 'A' ? m?.entryA.name : m?.entryB.name;
  }

  scoreOf(side: Side) {
    const g = this.game();
    return side === 'A' ? g?.a : g?.b;
  }

  gamesOf(side: Side) {
    return this.match()?.score.gamesWon[side] ?? 0;
  }

  private flashTimer: ReturnType<typeof setTimeout> | undefined;
  private flash(text: string, kind: 'info' | 'error') {
    this.message.set({ text, kind });
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => this.message.set(null), 5000);
  }
}

function safeGet(k: string): string {
  try {
    return localStorage.getItem(k) ?? '';
  } catch {
    return '';
  }
}
function safeSet(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* private mode */
  }
}

/** Screen Wake Lock needs HTTPS or localhost; on plain HTTP it silently does nothing. */
function keepScreenOn() {
  const wl = (navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<unknown> } }).wakeLock;
  if (!wl) return;
  const request = () => wl.request('screen').catch(() => undefined);
  void request();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void request();
  });
}
