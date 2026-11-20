import { Injectable, signal } from '@angular/core';
import { Observable, Subject } from 'rxjs';
import { io, type Socket } from 'socket.io-client';
import { MATCH_EVENTS, type MatchDto, type UmpirePresence } from '@bt/shared';

/**
 * One Socket.IO connection per browser tab. Rooms are reference-counted so views can
 * subscribe/unsubscribe independently, and are re-joined automatically after a reconnect.
 */
@Injectable({ providedIn: 'root' })
export class Realtime {
  readonly connected = signal(false);
  /** Fires after every reconnect (not the first connect): views must refetch authoritative state. */
  readonly reconnected$ = new Subject<void>();
  readonly match$ = new Subject<{ event: string; match: MatchDto }>();
  readonly matchDeleted$ = new Subject<{ id: string }>();
  readonly presence$ = new Subject<UmpirePresence>();
  /** Tournament-wide notices: the schedule or standings changed, refetch them. */
  readonly tournamentEvent$ = new Subject<{ event: 'schedule:updated' | 'standings:updated' | 'court:updated'; tournamentId: string }>();

  private socket: Socket | null = null;
  private readonly rooms = new Map<string, number>();
  private everConnected = false;

  private ensure(): Socket {
    if (this.socket) return this.socket;
    const s = io({ path: '/socket.io', transports: ['websocket', 'polling'], reconnectionDelayMax: 3000 });
    s.on('connect', () => {
      this.connected.set(true);
      // Re-join first, then tell views to refetch, so no update falls between the two.
      if (this.rooms.size) s.emit('subscribe', [...this.rooms.keys()], () => this.afterJoin());
      else this.afterJoin();
    });
    s.on('disconnect', () => this.connected.set(false));
    for (const ev of MATCH_EVENTS) s.on(ev, (match: MatchDto) => this.match$.next({ event: ev, match }));
    s.on('match:deleted', (p: { id: string }) => this.matchDeleted$.next(p));
    for (const ev of ['schedule:updated', 'standings:updated', 'court:updated'] as const) {
      s.on(ev, (p: { tournamentId: string }) => this.tournamentEvent$.next({ event: ev, tournamentId: p.tournamentId }));
    }
    s.on('umpire:connected', (p: UmpirePresence) => this.presence$.next(p));
    s.on('umpire:disconnected', (p: UmpirePresence) => this.presence$.next(p));
    this.socket = s;
    return s;
  }

  private afterJoin() {
    if (this.everConnected) this.reconnected$.next();
    this.everConnected = true;
  }

  /** Join rooms for the lifetime of the returned observable subscription. */
  watch(...rooms: string[]): Observable<never> {
    return new Observable<never>(() => {
      const s = this.ensure();
      const fresh = rooms.filter((r) => {
        const n = this.rooms.get(r) ?? 0;
        this.rooms.set(r, n + 1);
        return n === 0;
      });
      if (fresh.length && s.connected) s.emit('subscribe', fresh);
      return () => {
        const gone = rooms.filter((r) => {
          const n = (this.rooms.get(r) ?? 1) - 1;
          if (n <= 0) this.rooms.delete(r);
          else this.rooms.set(r, n);
          return n <= 0;
        });
        if (gone.length && s.connected) s.emit('unsubscribe', gone);
      };
    });
  }

  /** Reconnect so the server re-reads cookies (e.g. after umpire login). */
  restart() {
    this.socket?.disconnect();
    this.socket?.connect();
  }
}
