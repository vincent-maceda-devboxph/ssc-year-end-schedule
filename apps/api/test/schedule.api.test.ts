import crypto from 'node:crypto';
import http from 'node:http';
import mongoose from 'mongoose';
import request from 'supertest';
import { io as ioClient } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MatchDto, ScheduleView, SchedulePreview, ScheduleVersionDto } from '@bt/shared';
import { createApp } from '../src/app.js';
import { connectDb, ensureSuperAdmin, loadJwtSecret } from '../src/db.js';
import { AuthService } from '../src/modules/auth/auth.service.js';
import { createSocketServer } from '../src/sockets/index.js';

// Own database: vitest runs test files in parallel.
const MONGO = process.env.TEST_MONGO_URI_SCHED ?? 'mongodb://127.0.0.1:27017/badminton_test_sched';
const ADMIN_PASSWORD = 'test-admin-password';
const START = '2026-11-29T07:00:00.000Z'; // 3:00 PM in Manila

let server: http.Server;
let admin: ReturnType<typeof request.agent>;
let tid: string;

const TEAMS = ['Hulk Smashers', 'Avengers Netters', 'Iron Shuttlers'];
// 10 men's pairs then 3 women's pairs per team; row order = position.
const DIVISIONS = [...Array.from({ length: 10 }, () => 'MD'), 'WD', 'WD', 'WD'];
const rows = TEAMS.flatMap((team, t) => DIVISIONS.map((category, c) => ({ team, category, player1: `P${t}-${c}-1`, player2: `P${t}-${c}-2` })));

const base = () => `/api/tournaments/${tid}`;
const preview = (body: object = {}) => admin.post(`${base()}/schedules/preview`).send(body);
const matches = async (): Promise<MatchDto[]> => (await admin.get(`/api/matches?tournamentId=${tid}`)).body;
const settings = (patch: object) => admin.put(`${base()}/schedule/settings`).send(patch);

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
  tid = (await admin.post('/api/tournaments').send({ name: 'Team Cup', status: 'active' })).body.id;
  expect((await admin.post(`${base()}/lineup/import`).send({ rows })).status).toBe(200);
  for (let i = 1; i <= 4; i++) await admin.post('/api/courts').send({ tournamentId: tid, name: `Court ${i}` });
  expect((await admin.post(`${base()}/matches/generate`).send({})).body.created).toBe(39);
});

afterAll(async () => {
  server?.close();
  await mongoose.disconnect();
});

describe('settings and access', () => {
  it('needs a start time before anything can be scheduled', async () => {
    const r = await preview();
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('no_start_time');
  });

  it('validates settings', async () => {
    expect((await settings({ matchMinutes: 1 })).status).toBe(400);
    expect((await settings({ startAt: START, endAt: '2026-11-29T06:00:00.000Z' })).status).toBe(422);
    const ok = await settings({ startAt: START, endAt: null, matchMinutes: 30, minRestSlots: 1, seed: 1 });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ startAt: START, matchMinutes: 30, minRestSlots: 1, timezone: 'Asia/Manila' });
  });

  it('only admins can preview, save or publish', async () => {
    expect((await request(server).post(`${base()}/schedules/preview`).send({})).status).toBe(401);
    expect((await request(server).post(`${base()}/schedules`).send({})).status).toBe(401);
    expect((await request(server).post(`${base()}/schedules/publish`).send({ versionId: 'a'.repeat(24) })).status).toBe(401);
    expect((await request(server).put(`${base()}/schedule/settings`).send({ matchMinutes: 20 })).status).toBe(401);
  });
});

describe('preview', () => {
  let p: SchedulePreview;

  it('schedules all 39 matches in the 10-slot minimum, with no conflicts', async () => {
    const r = await preview();
    expect(r.status).toBe(200);
    p = r.body;
    expect(p.stats).toMatchObject({ matches: 39, scheduled: 39, slots: 10, pastEndTime: false });
    expect(p.unscheduled).toEqual([]);
    expect(p.conflicts).toEqual([]);
    expect(p.assignments).toHaveLength(39);
    // 3:00 PM Manila start, 30 min slots → 8:00 PM end (12:00Z).
    expect(p.assignments[0]!.start).toBe(START);
    expect(p.stats.estimatedEnd).toBe('2026-11-29T12:00:00.000Z');
    expect(p.stats.minPlayerGapSlots).toBeGreaterThanOrEqual(2);
  });

  it('game numbers follow the sheet: slot × courts + court + 1', () => {
    const numbers = p.assignments.map((a) => a.gameNumber);
    expect(new Set(numbers).size).toBe(39);
    for (const a of p.assignments) {
      const court = p.courts.findIndex((c) => c.id === a.courtId);
      expect(a.gameNumber).toBe(a.slot * 4 + court + 1);
    }
    expect(p.assignments.filter((a) => a.slot === 0).map((a) => a.gameNumber).sort()).toEqual([1, 2, 3, 4]);
  });

  it('is deterministic for a seed and different for another seed', async () => {
    const same = (await preview()).body as SchedulePreview;
    expect(same.assignments).toEqual(p.assignments);
    const other = (await preview({ seed: 77 })).body as SchedulePreview;
    expect(other.assignments).not.toEqual(p.assignments);
    expect(other.conflicts).toEqual([]);
  });

  it('changes nothing in the database', async () => {
    const all = await matches();
    expect(all.every((m) => m.status === 'pending' && !m.courtId && !m.plannedStart)).toBe(true);
  });

  it('no player is in two matches within the rest window', async () => {
    const pairs = (await admin.get(`${base()}/pairings`)).body as { id: string; playerIds: string[] }[];
    const playersOf = new Map(pairs.map((x) => [x.id, x.playerIds]));
    const all = await matches();
    const byMatch = new Map(all.map((m) => [m.id, [...playersOf.get(m.entryA.id)!, ...playersOf.get(m.entryB.id)!]]));
    const slotsByPlayer = new Map<string, number[]>();
    for (const a of p.assignments) for (const pl of byMatch.get(a.matchId)!) slotsByPlayer.set(pl, [...(slotsByPlayer.get(pl) ?? []), a.slot]);
    for (const slots of slotsByPlayer.values()) {
      const s = [...slots].sort((x, y) => x - y);
      for (let i = 1; i < s.length; i++) expect(s[i]! - s[i - 1]!).toBeGreaterThanOrEqual(2);
    }
  });

  it('a short day reports what does not fit instead of breaking rules', async () => {
    const r = (await preview({ settings: { endAt: '2026-11-29T08:00:00.000Z' } })).body as SchedulePreview; // 2 slots
    expect(r.stats.scheduled).toBeLessThanOrEqual(8);
    expect(r.unscheduled.length).toBe(39 - r.stats.scheduled);
    expect(r.unscheduled[0]!.reason).toMatch(/before the end time/);
    expect(r.conflicts).toEqual([]);
    expect(r.assignments.every((a) => a.slot < 2)).toBe(true);
  });
});

describe('save and publish', () => {
  let draft: ScheduleVersionDto;

  it('saving stores a draft and leaves the matches untouched', async () => {
    const r = await admin.post(`${base()}/schedules`).send({ label: 'First plan' });
    expect(r.status).toBe(201);
    draft = r.body;
    expect(draft).toMatchObject({ version: 1, status: 'draft', label: 'First plan', matchCount: 39 });
    expect((await matches()).every((m) => m.status === 'pending')).toBe(true);
    expect(((await admin.get(`${base()}/schedules`)).body as ScheduleVersionDto[]).map((v) => v.status)).toEqual(['draft']);
  });

  it('two admins publishing the same draft at once: exactly one wins', async () => {
    const [a, b] = await Promise.all([
      admin.post(`${base()}/schedules/publish`).send({ versionId: draft.id }),
      admin.post(`${base()}/schedules/publish`).send({ versionId: draft.id }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const ok = a.status === 200 ? a : b;
    expect(ok.body).toMatchObject({ applied: 39, skipped: 0 });
    expect(ok.body.version.status).toBe('published');
  });

  it('matches now carry court, time, game number and the scheduled status', async () => {
    const all = await matches();
    expect(all.every((m) => m.status === 'scheduled' && m.courtId && m.plannedStart && m.plannedEnd && m.gameNumber)).toBe(true);
    const first = all.find((m) => m.gameNumber === 1)!;
    expect(first.plannedStart).toBe(START);
    expect(first.plannedEnd).toBe('2026-11-29T07:30:00.000Z');
  });

  it('publishing the same version again is refused', async () => {
    const r = await admin.post(`${base()}/schedules/publish`).send({ versionId: draft.id });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('not_a_draft');
  });

  it('spectators can read the published schedule', async () => {
    const r = await request(server).get(`${base()}/schedule`);
    expect(r.status).toBe(200);
    const v: ScheduleView = r.body;
    expect(v.publishedVersion).toBe(1);
    expect(v.matches).toHaveLength(39);
    expect(v.matches[0]).toMatchObject({ teamA: { name: expect.any(String), color: expect.stringMatching(/^#/) } });
    expect(v.courts).toHaveLength(4);
  });

  it('the published cells have no conflicts', async () => {
    expect((await admin.get(`${base()}/schedules/conflicts`)).body).toEqual([]);
  });

  it('a stricter rest rule reveals conflicts in the existing cells', async () => {
    await settings({ minRestSlots: 3 });
    const c = (await admin.get(`${base()}/schedules/conflicts`)).body as { type: string; players?: string[] }[];
    expect(c.length).toBeGreaterThan(0);
    expect(c.every((x) => x.type === 'rest' && x.players?.[0])).toBe(true);
    await settings({ minRestSlots: 1 });
    expect((await admin.get(`${base()}/schedules/conflicts`)).body).toEqual([]);
  });
});

describe('regeneration keeps what matters', () => {
  it('regenerating with a new seed changes nothing that is still valid', async () => {
    const r = (await admin.post(`${base()}/schedules/regenerate`).send({ seed: 12345 })).body as SchedulePreview;
    expect(r.stats.scheduled).toBe(39);
    expect(r.changes).toEqual([]);
  });

  it('locked matches keep their cell; moved rest-rule changes leave them alone', async () => {
    const all = await matches();
    const target = all.find((m) => m.gameNumber === 7)!;
    const lock = await admin.patch(`/api/matches/${target.id}/lock`).send({ locked: true });
    expect(lock.status).toBe(200);
    expect(lock.body.isLocked).toBe(true);

    // Rest of 2 slots forces many cells to move, but not the locked one.
    const r = (await preview({ settings: { minRestSlots: 2 } })).body as SchedulePreview;
    expect(r.changes.length).toBeGreaterThan(0);
    expect(r.changes.some((c) => c.matchId === target.id)).toBe(false);
    const cell = r.assignments.find((a) => a.matchId === target.id)!;
    expect(cell).toMatchObject({ fixed: true, start: target.plannedStart, courtId: target.courtId, gameNumber: 7 });
    expect(r.stats.fixed).toBe(1);
    expect(r.conflicts).toEqual([]);

    expect((await admin.patch(`/api/matches/${target.id}/lock`).send({ locked: false })).body.isLocked).toBe(false);
  });

  it('a match in progress is never moved and its players are not double-booked', async () => {
    const all = await matches();
    const live = all.find((m) => m.gameNumber === 1)!;
    const started = await admin
      .post(`/api/matches/${live.id}/start`)
      .send({ actionId: crypto.randomUUID(), expectedVersion: live.version });
    expect(started.status).toBe(200);

    const r = (await preview({ settings: { minRestSlots: 2 }, seed: 5 })).body as SchedulePreview;
    expect(r.stats.fixed).toBe(1);
    expect(r.assignments.find((a) => a.matchId === live.id)).toMatchObject({ fixed: true, gameNumber: 1 });
    expect(r.changes.some((c) => c.matchId === live.id)).toBe(false);
    expect(r.conflicts).toEqual([]);
    expect(r.stats.scheduled).toBe(38);
  });

  it('a finished match keeps its result when the schedule is re-published', async () => {
    const all = await matches();
    const liveMatch = all.find((m) => m.status === 'in_progress')!;
    // Finish it as a retirement so a result exists.
    const done = await admin
      .post(`/api/matches/${liveMatch.id}/retire`)
      .send({ actionId: crypto.randomUUID(), expectedVersion: liveMatch.version, side: 'A' });
    expect(done.status).toBe(200);

    const saved = await admin.post(`${base()}/schedules`).send({ settings: { minRestSlots: 2 }, label: 'Stricter rest' });
    expect(saved.status).toBe(201);
    const pub = await admin.post(`${base()}/schedules/publish`).send({ versionId: saved.body.id });
    expect(pub.status).toBe(200);
    expect(pub.body.version.version).toBe(2);

    const after = await matches();
    const kept = after.find((m) => m.id === liveMatch.id)!;
    expect(kept).toMatchObject({ status: 'retired', winner: 'B', gameNumber: 1, plannedStart: START });
    expect(after.filter((m) => m.status === 'scheduled')).toHaveLength(38);
    const versions = (await admin.get(`${base()}/schedules`)).body as ScheduleVersionDto[];
    expect(versions.map((v) => v.status)).toEqual(['published', 'superseded']);
    expect((await admin.get(`${base()}/schedules/conflicts`)).body).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Slice C: manual moves (drag and drop), calling matches, court status
// ---------------------------------------------------------------------------------------------
const slotTime = (slot: number) => new Date(Date.parse(START) + slot * 30 * 60_000).toISOString();

describe('manual moves (drag and drop)', () => {
  const move = (id: string, body: object) => admin.patch(`/api/matches/${id}/schedule`).send(body);
  let courtIds: string[];
  let X: MatchDto; // X and Y are in the same bracket, so they share a pair
  let Y: MatchDto;
  let movable: MatchDto[];

  beforeAll(async () => {
    const all = await matches();
    courtIds = ((await admin.get(`${base()}/courts`)).body as { id: string }[]).map((c) => c.id);
    movable = all.filter((m) => m.status === 'scheduled' && !m.isLocked);
    const byBracket = new Map<string, MatchDto[]>();
    for (const m of movable) byBracket.set(m.bracket, [...(byBracket.get(m.bracket) ?? []), m]);
    const siblings = [...byBracket.values()].find((l) => l.length >= 2)!;
    [X, Y] = siblings as [MatchDto, MatchDto];
  });

  const get = async (id: string) => (await matches()).find((m) => m.id === id)!;

  it('a dry run checks the move and changes nothing', async () => {
    const r = await move(X.id, { courtId: courtIds[0], slot: 20, dryRun: true });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, match: null, blocked: [], warnings: [] });
    expect((await get(X.id)).plannedStart).toBe(X.plannedStart);
  });

  it('moves a match to an empty slot and renumbers it', async () => {
    const r = await move(Y.id, { courtId: courtIds[0], slot: 22 });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.match).toMatchObject({ courtId: courtIds[0], plannedStart: slotTime(22), plannedEnd: slotTime(23), gameNumber: 22 * 4 + 0 + 1, status: 'scheduled' });
    expect(r.body.match.version).toBe(Y.version + 1);
  });

  it('blocks putting a player in two matches at the same time', async () => {
    const r = await move(X.id, { courtId: courtIds[1], slot: 22 }); // X shares a pair with Y, who is at slot 22
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('move_blocked');
    expect(r.body.error.details[0]).toMatchObject({ type: 'player_overlap' });
    expect(r.body.error.details[0].players[0]).toMatch(/^P\d/);
    expect((await get(X.id)).plannedStart).toBe(X.plannedStart); // unchanged
  });

  it('asks for confirmation when rest is shorter than the minimum, then allows it', async () => {
    const ask = await move(X.id, { courtId: courtIds[0], slot: 23 }); // right after Y
    expect(ask.status).toBe(409);
    expect(ask.body.error.code).toBe('needs_confirmation');
    expect(ask.body.error.details[0].type).toBe('rest');
    expect((await get(X.id)).plannedStart).toBe(X.plannedStart);

    const ok = await move(X.id, { courtId: courtIds[0], slot: 23, confirmWarnings: true });
    expect(ok.status).toBe(200);
    expect(ok.body.warnings).toHaveLength(1);
    expect(ok.body.match).toMatchObject({ gameNumber: 23 * 4 + 0 + 1, plannedStart: slotTime(23) });
  });

  it('refuses an occupied slot unless swapping, accepts a start time instead of a slot number', async () => {
    const W = movable.find((m) => m.id !== X.id && m.id !== Y.id && m.bracket !== X.bracket)!;
    const r = await move(X.id, { courtId: W.courtId, start: W.plannedStart });
    expect(r.status).toBe(422);
    expect(r.body.error.details[0].type).toBe('cell_occupied');
  });

  it('swaps two matches', async () => {
    const xNow = await get(X.id);
    let found: MatchDto | null = null;
    for (const w of movable) {
      if (w.id === X.id || w.id === Y.id) continue;
      const wNow = await get(w.id);
      const dry = await move(X.id, { courtId: wNow.courtId, start: wNow.plannedStart, swapWith: w.id, dryRun: true });
      if (dry.body.ok && !dry.body.warnings.length) {
        found = wNow;
        break;
      }
    }
    expect(found, 'a clean swap partner exists').not.toBeNull();
    const r = await move(X.id, { courtId: found!.courtId, start: found!.plannedStart, swapWith: found!.id });
    expect(r.status).toBe(200);
    expect(r.body.match).toMatchObject({ courtId: found!.courtId, plannedStart: found!.plannedStart, gameNumber: found!.gameNumber });
    expect(r.body.swapped).toMatchObject({ courtId: xNow.courtId, plannedStart: xNow.plannedStart, gameNumber: xNow.gameNumber });
    const after = await matches();
    const cells = after.filter((m) => m.plannedStart).map((m) => `${m.courtId}@${m.plannedStart}`);
    expect(new Set(cells).size).toBe(cells.length); // no two matches share a cell
  });

  it('a stale swap partner is rejected', async () => {
    const xNow = await get(X.id);
    const r = await move(Y.id, { courtId: xNow.courtId, start: xNow.plannedStart, swapWith: movable.find((m) => m.id !== X.id && m.id !== Y.id)!.id });
    expect(r.status).toBe(422);
    expect(r.body.error.details[0].type).toBe('swap_mismatch');
  });

  it('locked, finished and non-admin moves are refused', async () => {
    const lockMe = await get(movable.find((m) => m.id !== X.id && m.id !== Y.id)!.id);
    await admin.patch(`/api/matches/${lockMe.id}/lock`).send({ locked: true });
    const locked = await move(lockMe.id, { courtId: courtIds[2], slot: 40 });
    expect(locked.status).toBe(422);
    expect(locked.body.error.code).toBe('locked');
    await admin.patch(`/api/matches/${lockMe.id}/lock`).send({ locked: false });

    const retired = (await matches()).find((m) => m.status === 'retired')!;
    const done = await move(retired.id, { courtId: courtIds[2], slot: 40 });
    expect(done.status).toBe(422);
    expect(done.body.error.code).toBe('not_movable');

    expect((await request(server).patch(`/api/matches/${Y.id}/schedule`).send({ courtId: courtIds[0], slot: 40 })).status).toBe(401);
  });

  it('rejects a court that is not part of the schedule and times off the grid', async () => {
    expect((await move(Y.id, { courtId: 'f'.repeat(24), slot: 40 })).body.error.code).toBe('bad_court');
    expect((await move(Y.id, { courtId: courtIds[0], start: '2026-11-29T07:10:00.000Z' })).body.error.code).toBe('bad_time');
    expect((await move(Y.id, { courtId: courtIds[0] })).status).toBe(400); // slot or start required
  });

  it('a match can be taken off the schedule and placed again', async () => {
    const off = await move(Y.id, { courtId: null });
    expect(off.status).toBe(200);
    expect(off.body.match).toMatchObject({ status: 'pending', courtId: null, plannedStart: null, gameNumber: null });
    const on = await move(Y.id, { courtId: courtIds[3], slot: 30 });
    expect(on.body.match).toMatchObject({ status: 'scheduled', gameNumber: 30 * 4 + 3 + 1 });
  });

  it('two admins moving different matches into the same empty slot: at most one gets it', async () => {
    const [a, b] = movable.filter((m) => m.id !== X.id && m.id !== Y.id && m.bracket !== X.bracket && m.bracket !== Y.bracket).slice(0, 2);
    const results = await Promise.all([move(a!.id, { courtId: courtIds[2], slot: 50 }), move(b!.id, { courtId: courtIds[2], slot: 50 })]);
    expect(results.every((r) => [200, 409, 422].includes(r.status))).toBe(true);
    const holders = (await matches()).filter((m) => m.plannedStart === slotTime(50) && m.courtId === courtIds[2]);
    expect(holders.length).toBeLessThanOrEqual(1);
    expect(results.filter((r) => r.status === 200).length).toBe(holders.length);
  });

  it('the conflicts check reads the real cells: the short rest was resolved by the later swap', async () => {
    const c = (await admin.get(`${base()}/schedules/conflicts`)).body as { type: string }[];
    expect(c).toEqual([]);
  });

  it('a confirmed short rest shows up in the conflicts check until it is fixed', async () => {
    // Y (same pair as X) is at slot 30. Put X right after it, accepting the warning.
    const y = await get(Y.id);
    const ySlot = Math.round((Date.parse(y.plannedStart!) - Date.parse(START)) / (30 * 60_000));
    const r = await move(X.id, { courtId: courtIds[0], slot: ySlot + 1, confirmWarnings: true });
    expect(r.status).toBe(200);
    const c = (await admin.get(`${base()}/schedules/conflicts`)).body as { type: string; players?: string[] }[];
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ type: 'rest' });
    expect(c[0]!.players?.[0]).toMatch(/^P\d/);
    // Move it back out of the way.
    expect((await move(X.id, { courtId: courtIds[0], slot: ySlot + 10 })).status).toBe(200);
    expect((await admin.get(`${base()}/schedules/conflicts`)).body).toEqual([]);
  });
});

describe('calling matches and court status', () => {
  let courts: { id: string; name: string; status: string }[];
  let M1: MatchDto;
  const call = (id: string) => admin.post(`/api/matches/${id}/call`).send({});

  beforeAll(async () => {
    courts = (await admin.get(`${base()}/courts`)).body;
    const all = await matches();
    // A scheduled match on the first 10-slot block, so the court has nothing live or called.
    M1 = all.filter((m) => m.status === 'scheduled' && !m.isLocked && m.plannedStart! < slotTime(10)).sort((a, b) => a.plannedStart!.localeCompare(b.plannedStart!))[0]!;
  });

  it('only admins can call a match', async () => {
    expect((await request(server).post(`/api/matches/${M1.id}/call`).send({})).status).toBe(401);
  });

  it('calls a scheduled match (status "called") and broadcasts match:called', async () => {
    const { port } = server.address() as { port: number };
    const sock = ioClient(`http://127.0.0.1:${port}`, { transports: ['websocket'], forceNew: true });
    const got = new Promise<MatchDto>((resolve) => sock.on('match:called', resolve));
    await new Promise<void>((resolve) => sock.on('connect', () => sock.emit('subscribe', [`tournament:${tid}`], () => resolve())));

    const r = await call(M1.id);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('called');
    const evt = await Promise.race([got, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('no event')), 2000))]);
    expect(evt).toMatchObject({ id: M1.id, status: 'called' });
    sock.close();
  });

  it('a second match cannot be called to the same court', async () => {
    const other = (await matches()).find((m) => m.status === 'scheduled' && m.courtId === M1.courtId && m.id !== M1.id)!;
    const r = await call(other.id);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('court_busy');
  });

  it('a called match cannot be moved, but the scheduler keeps it where it is', async () => {
    const mv = await admin.patch(`/api/matches/${M1.id}/schedule`).send({ courtId: M1.courtId, slot: 60 });
    expect(mv.status).toBe(422);
    expect(mv.body.error.code).toBe('not_movable');
    const p = (await preview({ seed: 3 })).body as SchedulePreview;
    expect(p.assignments.find((a) => a.matchId === M1.id)).toMatchObject({ fixed: true, start: M1.plannedStart });
    expect(p.changes.some((c) => c.matchId === M1.id)).toBe(false);
  });

  it('the umpire on that court sees the called match first and can start it', async () => {
    const code = (await admin.post(`/api/courts/${M1.courtId}/code`)).body.code as string;
    const u = request.agent(server);
    expect((await u.post('/api/auth/umpire/login').send({ courtId: M1.courtId, code, name: 'Court Umpire' })).status).toBe(200);
    const cur = await u.get('/api/umpire/current');
    expect(cur.body.match).toMatchObject({ id: M1.id, status: 'called' });
    expect(cur.body.upcoming.every((m: MatchDto) => m.id !== M1.id)).toBe(true);

    const started = await u.post(`/api/matches/${M1.id}/start`).send({ actionId: crypto.randomUUID(), expectedVersion: cur.body.match.version });
    expect(started.status).toBe(200);
    expect(started.body.match.status).toBe('in_progress');
  });

  it('court status follows the matches: ongoing / scheduled / unavailable', async () => {
    const list = (await admin.get(`${base()}/courts`)).body as { id: string; status: string }[];
    expect(list.find((c) => c.id === M1.courtId)!.status).toBe('ongoing');
    expect(list.filter((c) => c.id !== M1.courtId).every((c) => c.status === 'scheduled')).toBe(true);

    const busy = await admin.patch(`/api/courts/${M1.courtId}/status`).send({ status: 'unavailable' });
    expect(busy.status).toBe(409);

    const free = courts.find((c) => c.id !== M1.courtId)!;
    const closed = await admin.patch(`/api/courts/${free.id}/status`).send({ status: 'unavailable' });
    expect(closed.status).toBe(200);
    expect(closed.body.status).toBe('unavailable');
    // Spectators only see open courts.
    expect(((await request(server).get(`${base()}/courts`)).body as { id: string }[]).some((c) => c.id === free.id)).toBe(false);
  });

  it('a closed court is left out of the next schedule preview', async () => {
    const closedId = (await admin.get(`${base()}/courts`)).body.find((c: { status: string }) => c.status === 'unavailable').id as string;
    const p = (await preview({ seed: 4 })).body as SchedulePreview;
    expect(p.courts.map((c) => c.id)).not.toContain(closedId);
    expect(p.assignments.filter((a) => !a.fixed).every((a) => a.courtId !== closedId)).toBe(true);
    await admin.patch(`/api/courts/${closedId}/status`).send({ status: 'available' });
    expect(((await admin.get(`${base()}/courts`)).body as { status: string }[]).every((c) => c.status !== 'unavailable')).toBe(true);
  });

  it('a call can be taken back', async () => {
    const m = (await matches()).find((x) => x.status === 'scheduled' && x.courtId !== M1.courtId && x.plannedStart! < slotTime(10))!;
    expect((await call(m.id)).body.status).toBe('called');
    const back = await admin.post(`/api/matches/${m.id}/uncall`).send({});
    expect(back.status).toBe(200);
    expect(back.body.status).toBe('scheduled');
    expect((await admin.post(`/api/matches/${m.id}/uncall`).send({})).status).toBe(422);
  });
});
