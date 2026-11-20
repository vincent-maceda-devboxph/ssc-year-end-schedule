import type { Server as HttpServer } from 'node:http';
import type { Server as HttpsServer } from 'node:https';
import { parse as parseCookies } from 'cookie';
import { Server } from 'socket.io';
import type { MatchDto, MatchEvent, UmpirePresence } from '@bt/shared';
import type { AuthService } from '../modules/auth/auth.service.js';
import { logger } from '../utils/logger.js';

/** Rooms anyone (spectators included) may join. All writes go through REST, so rooms are read-only. */
const ROOM_PATTERN = /^(tournament|court|match):[a-f0-9]{24}$/i;
const MAX_ROOMS_PER_SOCKET = 50;

export interface Broadcaster {
  match(event: MatchEvent, match: MatchDto): void;
  tournament(tournamentId: string, event: string, payload: unknown): void;
}

export class Presence {
  /** courtId → (socketId → umpire name) */
  private readonly byCourt = new Map<string, Map<string, string>>();

  add(courtId: string, socketId: string, name: string): boolean {
    const m = this.byCourt.get(courtId) ?? new Map<string, string>();
    const wasEmpty = m.size === 0;
    m.set(socketId, name);
    this.byCourt.set(courtId, m);
    return wasEmpty;
  }

  remove(courtId: string, socketId: string): boolean {
    const m = this.byCourt.get(courtId);
    if (!m) return false;
    m.delete(socketId);
    return m.size === 0;
  }

  forCourt(courtId: string): UmpirePresence {
    const names = [...(this.byCourt.get(courtId)?.values() ?? [])];
    return { courtId, name: names.at(-1) ?? '', connected: names.length > 0 };
  }
}

export function createSocketServer(http: HttpServer | HttpsServer, auth: AuthService) {
  // Same origin as the Angular app, so no CORS configuration is needed (plan-review §6).
  const io = new Server(http, { serveClient: false, pingInterval: 10000, pingTimeout: 8000 });
  const presence = new Presence();

  io.on('connection', async (socket) => {
    // Register every listener synchronously, BEFORE any await: a client emits 'subscribe' right
    // after connecting, and an event that arrives before its listener exists is silently dropped.
    socket.on('subscribe', (rooms: unknown, ack?: (r: { ok: boolean; error?: string }) => void) => {
      const list = Array.isArray(rooms) ? rooms : [rooms];
      if (!list.every((r) => typeof r === 'string' && ROOM_PATTERN.test(r))) {
        return ack?.({ ok: false, error: 'invalid room' });
      }
      if (socket.rooms.size + list.length > MAX_ROOMS_PER_SOCKET) {
        return ack?.({ ok: false, error: 'too many rooms' });
      }
      socket.join(list as string[]);
      ack?.({ ok: true });
    });

    socket.on('unsubscribe', (rooms: unknown) => {
      const list = Array.isArray(rooms) ? rooms : [rooms];
      for (const r of list) if (typeof r === 'string') socket.leave(r);
    });

    let umpire: { courtId: string; tournamentId: string; name: string } | null = null;
    socket.on('disconnect', () => {
      if (umpire && presence.remove(umpire.courtId, socket.id)) {
        io.to(`tournament:${umpire.tournamentId}`).emit('umpire:disconnected', presence.forCourt(umpire.courtId));
      }
    });

    // Identify umpires for court presence (async; read-only rooms above do not depend on it).
    const cookies = parseCookies(socket.request.headers.cookie ?? '');
    const who = await auth.resolve(cookies).catch(() => ({ admin: null, umpire: null }));
    if (who.umpire && socket.connected) {
      umpire = who.umpire;
      socket.join(`court:${umpire.courtId}`);
      if (presence.add(umpire.courtId, socket.id, umpire.name)) {
        io.to(`tournament:${umpire.tournamentId}`).emit('umpire:connected', presence.forCourt(umpire.courtId));
      }
    }
  });

  const broadcaster: Broadcaster = {
    match(event, match) {
      const rooms = [`tournament:${match.tournamentId}`, `match:${match.id}`];
      if (match.courtId) rooms.push(`court:${match.courtId}`);
      // Socket.IO delivers once per socket even if it is in several of these rooms.
      io.to(rooms).emit(event, match);
    },
    tournament(tournamentId, event, payload) {
      io.to(`tournament:${tournamentId}`).emit(event, payload);
    },
  };

  logger.debug('Socket.IO ready');
  return { io, broadcaster, presence };
}
