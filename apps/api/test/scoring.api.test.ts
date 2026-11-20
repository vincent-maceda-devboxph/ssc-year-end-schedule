import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import mongoose from 'mongoose';
import request from 'supertest';
import { io as ioClient, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MatchDto } from '@bt/shared';
import { createApp } from '../src/app.js';
import { connectDb, ensureSuperAdmin, loadJwtSecret } from '../src/db.js';
import { AuthService, resetLimiters } from '../src/modules/auth/auth.service.js';
import { createSocketServer } from '../src/sockets/index.js';

const MONGO = process.env.TEST_MONGO_URI ?? 'mongodb://127.0.0.1:27017/badminton_test';
const ADMIN_PASSWORD = 'test-admin-password';

let server: http.Server;
let baseUrl: string;
let admin: ReturnType<typeof request.agent>;
let tournamentId: string;
let categoryId: string;
const courts: { id: string; code: string }[] = [];
const entries: string[] = [];

const uuid = () => crypto.randomUUID();

async function umpireAgent(courtIdx: number, name: string) {
  const agent = request.agent(server);
  const res = await agent
    .post('/api/auth/umpire/login')
    .send({ courtId: courts[courtIdx]!.id, code: courts[courtIdx]!.code, name });
  expect(res.status).toBe(200);
  return agent;
}

async function createMatch(a: number, b: number, courtIdx: number | null): Promise<MatchDto> {
  const res = await admin.post('/api/matches').send({
    categoryId,
    entryAId: entries[a],
    entryBId: entries[b],
    courtId: courtIdx === null ? null : courts[courtIdx]!.id,
  });
  expect(res.status).toBe(201);
  return res.body;
}

async function cmd(agent: ReturnType<typeof request.agent>, m: { id: string; version: number }, route: string, extra: object = {}) {
  return agent.post(`/api/matches/${m.id}/${route}`).send({ actionId: uuid(), expectedVersion: m.version, ...extra });
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
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  admin = request.agent(server);
  expect((await admin.post('/api/auth/login').send({ username: 'admin', password: ADMIN_PASSWORD })).status).toBe(200);

  tournamentId = (await admin.post('/api/tournaments').send({ name: 'Club Open', status: 'active' })).body.id;
  categoryId = (
    await admin.post('/api/categories').send({
      tournamentId,
      name: "Men's Doubles",
      scoring: { gamesToWin: 2, pointsToWin: 21, winBy: 2, cap: 30, intervalAt: 11, changeEndsInDecider: true },
    })
  ).body.id;

  const players: string[] = [];
  for (let i = 0; i < 20; i++) {
    const res = await admin.post('/api/players').send({ tournamentId, firstName: `P${i}`, lastName: `Player${i}` });
    expect(res.status).toBe(201);
    players.push(res.body.id);
  }
  for (let i = 0; i < 10; i++) {
    const res = await admin.post('/api/entries').send({ categoryId, playerIds: [players[i * 2], players[i * 2 + 1]] });
    expect(res.status).toBe(201);
    entries.push(res.body.id);
  }
  for (let i = 1; i <= 5; i++) {
    const c = await admin.post('/api/courts').send({ tournamentId, name: `Court ${i}` });
    const code = await admin.post(`/api/courts/${c.body.id}/code`);
    courts.push({ id: c.body.id, code: code.body.code });
  }
});

afterAll(async () => {
  server?.close();
  await mongoose.disconnect();
});

describe('registration rules', () => {
  it('rejects a player entered twice in the same category', async () => {
    const e = await request(server).get(`/api/entries?categoryId=${categoryId}`);
    const res = await admin.post('/api/entries').send({ categoryId, playerIds: e.body[0].playerIds });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('already_entered');
  });

  it('rejects a doubles entry with one player', async () => {
    const e = await request(server).get(`/api/entries?categoryId=${categoryId}`);
    const res = await admin.post('/api/entries').send({ categoryId, playerIds: [e.body[0].playerIds[0]] });
    expect(res.status).toBe(422);
  });
});

describe('access control', () => {
  it('spectators can read but not write', async () => {
    const m = await createMatch(0, 1, null);
    expect((await request(server).get(`/api/matches/${m.id}`)).status).toBe(200);
    expect((await request(server).post(`/api/matches/${m.id}/start`).send({ actionId: uuid(), expectedVersion: 0 })).status).toBe(401);
    expect((await request(server).post('/api/tournaments').send({ name: 'x' })).status).toBe(401);
  });

  it('locks out an IP after 5 wrong court codes', async () => {
    const court = courts[4]!.id;
    for (let i = 0; i < 5; i++) {
      const r = await request(server).post('/api/auth/umpire/login').send({ courtId: court, code: '000000', name: 'Guess' });
      expect(r.status).toBe(401);
    }
    const blocked = await request(server)
      .post('/api/auth/umpire/login')
      .send({ courtId: court, code: courts[4]!.code, name: 'Guess' });
    expect(blocked.status).toBe(429);
    resetLimiters();
  });

  it('an umpire cannot score a match on another court', async () => {
    const m = await createMatch(2, 3, 1);
    const u = await umpireAgent(0, 'Wrong Court');
    const res = await cmd(u, m, 'start');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('wrong_court');
    await admin.post(`/api/matches/${m.id}/cancel`).send({});
  });

  it('regenerating a court code ends existing umpire sessions', async () => {
    const u = await umpireAgent(3, 'Soon Gone');
    expect((await u.get('/api/umpire/current')).status).toBe(200);
    const code = await admin.post(`/api/courts/${courts[3]!.id}/code`);
    courts[3]!.code = code.body.code;
    expect((await u.get('/api/umpire/current')).status).toBe(401);
  });
});

describe('scoring commands', () => {
  let m: MatchDto;
  let u: ReturnType<typeof request.agent>;

  it('umpire starts the match on their court', async () => {
    m = await createMatch(4, 5, 0);
    u = await umpireAgent(0, 'Ana Umpire');
    const current = await u.get('/api/umpire/current');
    expect(current.body.match.id).toBe(m.id);
    const res = await cmd(u, m, 'start');
    expect(res.status).toBe(200);
    m = res.body.match;
    expect(m.status).toBe('in_progress');
    expect(m.umpireName).toBe('Ana Umpire');
    expect(m.umpireKey).toBe(current.body.myKey);
  });

  it('a duplicate actionId does not add a second point', async () => {
    const actionId = uuid();
    const body = { actionId, expectedVersion: m.version, side: 'A' };
    const first = await u.post(`/api/matches/${m.id}/points`).send(body);
    const retry = await u.post(`/api/matches/${m.id}/points`).send(body);
    expect(first.status).toBe(200);
    expect(first.body.duplicate).toBe(false);
    expect(retry.status).toBe(200);
    expect(retry.body.duplicate).toBe(true);
    expect(retry.body.match.score.games[0]).toMatchObject({ a: 1, b: 0 });
    expect(retry.body.match.version).toBe(first.body.match.version);
    m = retry.body.match;
  });

  it('a stale expectedVersion is rejected with the current state', async () => {
    const res = await u.post(`/api/matches/${m.id}/points`).send({ actionId: uuid(), expectedVersion: m.version - 1, side: 'B' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('version_conflict');
    expect(res.body.match.version).toBe(m.version);
    expect(res.body.match.score.games[0]).toMatchObject({ a: 1, b: 0 });
  });

  it('another live match cannot start on the same court', async () => {
    const other = await createMatch(6, 7, 0);
    const res = await cmd(admin, other, 'start');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('court_busy');
    await admin.post(`/api/matches/${other.id}/cancel`).send({});
  });

  it('a second umpire must take over before scoring', async () => {
    const u2 = await umpireAgent(0, 'Ben Backup');
    const denied = await cmd(u2, m, 'points', { side: 'B' });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('controlled_by_other');

    const take = await u2.post(`/api/matches/${m.id}/takeover`).send({});
    expect(take.status).toBe(200);
    m = take.body.match;
    expect(m.umpireName).toBe('Ben Backup');

    const old = await cmd(u, m, 'points', { side: 'B' });
    expect(old.status).toBe(403);
    u = u2;
  });

  it('plays to match point, blocks extra points, undo reopens, submit completes', async () => {
    // 1-0 already; A needs 20 more for game 1 and 21 for game 2.
    for (let i = 0; i < 41; i++) {
      const res = await cmd(u, m, 'points', { side: 'A' });
      expect(res.status).toBe(200);
      m = res.body.match;
    }
    expect(m.status).toBe('awaiting_confirmation');
    expect(m.score.winner).toBe('A');

    expect((await cmd(u, m, 'points', { side: 'A' })).status).toBe(422);

    let res = await cmd(u, m, 'undo');
    m = res.body.match;
    expect(m.status).toBe('in_progress');
    expect(m.score.games[1]).toMatchObject({ a: 20, b: 0, winner: null });

    res = await cmd(u, m, 'points', { side: 'A' });
    m = res.body.match;
    res = await cmd(u, m, 'complete');
    expect(res.status).toBe(200);
    m = res.body.match;
    expect(m.status).toBe('completed');
    expect(m.winner).toBe('A');

    expect((await cmd(u, m, 'undo')).status).toBe(422);
  });
});

describe('four courts at once', () => {
  it('scores 4 matches concurrently with duplicate retries and broadcasts every change', async () => {
    const spectator: Socket = ioClient(baseUrl, { transports: ['websocket'], forceNew: true });
    await new Promise<void>((resolve, reject) => {
      spectator.on('connect', () => spectator.emit('subscribe', [`tournament:${tournamentId}`], () => resolve()));
      spectator.on('connect_error', reject);
    });
    const lastVersion = new Map<string, number>();
    let outOfOrder = 0;
    spectator.on('score:updated', (dto: MatchDto) => {
      if ((lastVersion.get(dto.id) ?? -1) >= dto.version) outOfOrder++;
      lastVersion.set(dto.id, dto.version);
    });

    // Courts 0-3; entries 0..7 are free now (earlier matches are final).
    const pairs: [number, number][] = [[0, 1], [2, 3], [6, 7], [8, 9]];
    const results = await Promise.all(
      pairs.map(async ([a, b], court) => {
        let m = await createMatch(a, b, court);
        const u = await umpireAgent(court, `Umpire ${court + 1}`);
        m = (await cmd(u, m, 'start')).body.match;
        // 21 rallies alternating sides, each sent twice at the same time (simulated network retry).
        for (let i = 0; i < 21; i++) {
          const body = { actionId: uuid(), expectedVersion: m.version, side: i % 3 === 0 ? 'B' : 'A' };
          const [r1, r2] = await Promise.all([
            u.post(`/api/matches/${m.id}/points`).send(body),
            u.post(`/api/matches/${m.id}/points`).send(body),
          ]);
          expect([r1.status, r2.status]).toEqual([200, 200]);
          expect([r1.body.duplicate, r2.body.duplicate].filter(Boolean)).toHaveLength(1);
          m = r1.body.match.version > r2.body.match.version ? r1.body.match : r2.body.match;
        }
        return m;
      }),
    );

    for (const m of results) {
      const g = m.score.games[0];
      expect(g.a + g.b).toBe(21); // never a double-counted point
      expect(g).toMatchObject({ a: 14, b: 7 });
      expect(m.score.pointsPlayed).toBe(21);
    }
    await new Promise((r) => setTimeout(r, 200));
    for (const m of results) expect(lastVersion.get(m.id)).toBe(m.version);
    expect(outOfOrder).toBe(0);
    spectator.close();
  });
});
