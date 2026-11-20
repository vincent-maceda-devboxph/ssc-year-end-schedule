import crypto from 'node:crypto';
import http from 'node:http';
import mongoose from 'mongoose';
import request from 'supertest';
import { io as ioClient } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MatchDto, StandingsResponse } from '@bt/shared';
import { createApp } from '../src/app.js';
import { connectDb, ensureSuperAdmin, loadJwtSecret } from '../src/db.js';
import { AuditLog } from '../src/models/index.js';
import { AuthService } from '../src/modules/auth/auth.service.js';
import { createSocketServer } from '../src/sockets/index.js';

// Own database: vitest runs test files in parallel.
const MONGO = process.env.TEST_MONGO_URI_CORR ?? 'mongodb://127.0.0.1:27017/badminton_test_corr';
const ADMIN_PASSWORD = 'test-admin-password';

let server: http.Server;
let admin: ReturnType<typeof request.agent>;
let tid: string;
let courtId: string;
let entries: string[];
let categoryId: string;

const correct = (id: string, body: object) => admin.post(`/api/matches/${id}/correct`).send(body);
const get = async (id: string): Promise<MatchDto> => (await admin.get(`/api/matches/${id}`)).body;

async function playFinishedMatch(winnerSide: 'A' | 'B' = 'A'): Promise<MatchDto> {
  const created = await admin.post('/api/matches').send({ categoryId, entryAId: entries[0], entryBId: entries[1], courtId });
  expect(created.status).toBe(201);
  let m: MatchDto = created.body;
  const send = async (route: string, extra: object = {}) => {
    const r = await admin.post(`/api/matches/${m.id}/${route}`).send({ actionId: crypto.randomUUID(), expectedVersion: m.version, ...extra });
    expect(r.status).toBe(200);
    m = r.body.match;
  };
  await send('start');
  for (let i = 0; i < 42; i++) await send('points', { side: winnerSide });
  await send('complete');
  expect(m).toMatchObject({ status: 'completed', winner: winnerSide });
  return m;
}

beforeAll(async () => {
  process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
  await connectDb(MONGO);
  await mongoose.connection.dropDatabase();
  await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
  await ensureSuperAdmin();
  const auth = new AuthService(await loadJwtSecret());
  server = http.createServer();
  const { broadcaster, presence } = createSocketServer(server, auth);
  server.on('request', createApp({ auth, broadcaster, presence, serveWeb: false }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  admin = request.agent(server);
  await admin.post('/api/auth/login').send({ username: 'admin', password: ADMIN_PASSWORD });
  tid = (await admin.post('/api/tournaments').send({ name: 'Corrections Cup', status: 'active' })).body.id;
  categoryId = (
    await admin.post('/api/categories').send({
      tournamentId: tid,
      name: 'Open Doubles',
      scoring: { gamesToWin: 2, pointsToWin: 21, winBy: 2, cap: 30, intervalAt: 11, changeEndsInDecider: true },
    })
  ).body.id;
  const players: string[] = [];
  for (let i = 0; i < 4; i++) players.push((await admin.post('/api/players').send({ tournamentId: tid, firstName: `Player${i}` })).body.id);
  entries = [];
  for (let i = 0; i < 2; i++) entries.push((await admin.post('/api/entries').send({ categoryId, playerIds: [players[i * 2], players[i * 2 + 1]] })).body.id);
  courtId = (await admin.post('/api/courts').send({ tournamentId: tid, name: 'Court 1' })).body.id;
});

afterAll(async () => {
  server?.close();
  await mongoose.disconnect();
});

describe('correcting a finished result', () => {
  let m: MatchDto;

  it('needs an admin and a reason', async () => {
    m = await playFinishedMatch('A');
    expect((await request(server).post(`/api/matches/${m.id}/correct`).send({ expectedVersion: m.version, reason: 'typo', games: [] })).status).toBe(401);
    const noReason = await correct(m.id, { expectedVersion: m.version, games: [{ a: 21, b: 10 }, { a: 21, b: 10 }] });
    expect(noReason.status).toBe(400);
    expect((await correct(m.id, { expectedVersion: m.version, reason: 'x', games: [] })).status).toBe(400); // reason too short
  });

  it('a live match cannot be corrected', async () => {
    const created = await admin.post('/api/matches').send({ categoryId, entryAId: entries[0], entryBId: entries[1], courtId });
    const r = await correct(created.body.id, { expectedVersion: created.body.version, reason: 'too early', games: [{ a: 21, b: 5 }, { a: 21, b: 5 }] });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('not_final');
    await admin.post(`/api/matches/${created.body.id}/cancel`).send({});
  });

  it('refuses scores that are not possible or do not finish the match', async () => {
    const base = { expectedVersion: m.version, reason: 'check scores' };
    for (const games of [
      [{ a: 21, b: 20 }, { a: 21, b: 5 }], // 21-20 is not a finished game
      [{ a: 25, b: 21 }, { a: 21, b: 5 }], // would have ended at 23-21
      [{ a: 21, b: 5 }], // match not decided
      [{ a: 21, b: 5 }, { a: 21, b: 5 }, { a: 21, b: 5 }], // extra game
    ]) {
      const r = await correct(m.id, { ...base, games });
      expect(r.status).toBe(422);
      expect(r.body.error.code).toBe('scoring_rule');
    }
    expect((await get(m.id)).version).toBe(m.version); // nothing changed
  });

  it('a stale version is refused with the current state', async () => {
    const r = await correct(m.id, { expectedVersion: m.version - 1, reason: 'stale', games: [{ a: 21, b: 10 }, { a: 21, b: 10 }] });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('version_conflict');
    expect(r.body.match.version).toBe(m.version);
  });

  it('the same result is refused as "no change"', async () => {
    const r = await correct(m.id, { expectedVersion: m.version, reason: 'same', games: [{ a: 21, b: 0 }, { a: 21, b: 0 }] });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('no_change');
  });

  it('flips the winner: score, status, standings, audit trail and live update', async () => {
    const { port } = server.address() as { port: number };
    const sock = ioClient(`http://127.0.0.1:${port}`, { transports: ['websocket'], forceNew: true });
    const events: string[] = [];
    sock.on('match:corrected', (d: MatchDto) => events.push(`${d.id}:${d.winner}`));
    sock.on('standings:updated', () => events.push('standings'));
    await new Promise<void>((resolve) => sock.on('connect', () => sock.emit('subscribe', [`tournament:${tid}`], () => resolve())));

    const before = (await request(server).get(`/api/tournaments/${tid}/standings`)).body as StandingsResponse;
    expect(before.categories[0]!.pairs.find((p) => p.entryId === entries[0])).toMatchObject({ won: 1 });

    const r = await correct(m.id, { expectedVersion: m.version, reason: 'Scorer pressed the wrong side', games: [{ a: 18, b: 21 }, { a: 21, b: 19 }, { a: 19, b: 21 }] });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'completed', winner: 'B', corrections: 1, version: m.version + 1 });
    expect(r.body.score.games).toMatchObject([{ a: 18, b: 21, winner: 'B' }, { a: 21, b: 19, winner: 'A' }, { a: 19, b: 21, winner: 'B' }]);
    expect(r.body.score.gamesWon).toEqual({ A: 1, B: 2 });

    const after = (await request(server).get(`/api/tournaments/${tid}/standings`)).body as StandingsResponse;
    const pairs = after.categories[0]!.pairs;
    expect(pairs.find((p) => p.entryId === entries[1])).toMatchObject({ won: 1, lost: 0, gamesWon: 2, gamesLost: 1 });
    expect(pairs.find((p) => p.entryId === entries[0])).toMatchObject({ won: 0, lost: 1 });

    const log = await AuditLog.findOne({ entityId: m.id, action: 'correct_result' }).lean();
    expect(log).toMatchObject({ reason: 'Scorer pressed the wrong side', actor: { kind: 'admin', name: 'admin' } });
    expect(log!.before).toMatchObject({ status: 'completed', winner: 'A', games: '21-0, 21-0' });
    expect(log!.after).toMatchObject({ status: 'completed', winner: 'B', games: '18-21, 21-19, 19-21' });

    await new Promise((res) => setTimeout(res, 300));
    expect(events).toContain(`${m.id}:B`);
    expect(events).toContain('standings');
    sock.close();
    m = r.body;
  });

  it('can be corrected again; the log keeps every step', async () => {
    const r = await correct(m.id, { expectedVersion: m.version, reason: 'Second look at the sheet', games: [{ a: 21, b: 17 }, { a: 21, b: 19 }] });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ winner: 'A', corrections: 2 });
    expect(await AuditLog.countDocuments({ entityId: m.id, action: 'correct_result' })).toBe(2);
    m = r.body;
  });

  it('can be changed to a walkover or a retirement', async () => {
    const wo = await correct(m.id, { expectedVersion: m.version, reason: 'Pair did not show', status: 'walkover', winner: 'B' });
    expect(wo.status).toBe(200);
    expect(wo.body).toMatchObject({ status: 'walkover', winner: 'B' });
    expect(wo.body.score.games).toEqual([{ a: 0, b: 0, winner: null }]);
    expect((await correct(m.id, { expectedVersion: wo.body.version, reason: 'no winner given', status: 'retired', games: [] })).status).toBe(200); // keeps the walkover's winner

    const cur = await get(m.id);
    const ret = await correct(m.id, { expectedVersion: cur.version, reason: 'Player A injured', status: 'retired', winner: 'B', games: [{ a: 21, b: 15 }, { a: 5, b: 11 }] });
    expect(ret.status).toBe(200);
    expect(ret.body).toMatchObject({ status: 'retired', winner: 'B' });
    expect(ret.body.score.gamesWon).toEqual({ A: 1, B: 0 });
    m = ret.body;
  });

  it('a walkover needs a winner, and a full result cannot contradict the games', async () => {
    const fresh = await playFinishedMatch('A');
    const noWinner = await admin.post(`/api/matches/${fresh.id}/correct`).send({ expectedVersion: fresh.version, reason: 'bad data', status: 'walkover', winner: undefined });
    // The match was won by A, so a walkover without an explicit winner keeps A.
    expect(noWinner.status).toBe(200);
    const cur = await get(fresh.id);
    const contradict = await correct(fresh.id, { expectedVersion: cur.version, reason: 'bad data', status: 'completed', winner: 'A', games: [{ a: 10, b: 21 }, { a: 12, b: 21 }] });
    expect(contradict.status).toBe(422);
    expect(contradict.body.error.message).toMatch(/give the win to side B/);
  });
});
