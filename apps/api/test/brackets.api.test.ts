import http from 'node:http';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MatchDto, SchedulePreview, StandingsResponse } from '@bt/shared';
import { createApp } from '../src/app.js';
import { connectDb, ensureSuperAdmin, loadJwtSecret } from '../src/db.js';
import { AuthService } from '../src/modules/auth/auth.service.js';
import { createSocketServer } from '../src/sockets/index.js';
import crypto from 'node:crypto';

// Own database: vitest runs test files in parallel.
const MONGO = process.env.TEST_MONGO_URI_BRACKETS ?? 'mongodb://127.0.0.1:27017/badminton_test_brackets';
const ADMIN_PASSWORD = 'test-admin-password';
const START = '2026-11-29T07:00:00.000Z';
const SCORING = { gamesToWin: 2, pointsToWin: 21, winBy: 2, cap: 30, intervalAt: 11, changeEndsInDecider: true };

let server: http.Server;
let admin: ReturnType<typeof request.agent>;

const api = (p: string) => `/api${p}`;
const matchesOf = async (tid: string, categoryId?: string): Promise<MatchDto[]> => {
  const all = (await admin.get(api(`/matches?tournamentId=${tid}`))).body as MatchDto[];
  return categoryId ? all.filter((m) => m.categoryId === categoryId) : all;
};
const byName = (all: MatchDto[], label: string) => all.find((m) => m.stage?.roundLabel === label)!;

async function newTournament(name: string) {
  return (await admin.post(api('/tournaments')).send({ name, status: 'active' })).body.id as string;
}
async function newCategory(tid: string, body: object) {
  const r = await admin.post(api('/categories')).send({ tournamentId: tid, scoring: SCORING, discipline: 'singles', ...body });
  expect(r.status).toBe(201);
  return r.body.id as string;
}
/** n singles entries named S1..Sn with seeds 1..n. */
async function entries(tid: string, categoryId: string, n: number, prefix = 'S') {
  const ids: string[] = [];
  for (let i = 1; i <= n; i++) {
    const p = await admin.post(api('/players')).send({ tournamentId: tid, firstName: `${prefix}${i}` });
    const e = await admin.post(api('/entries')).send({ categoryId, playerIds: [p.body.id], seed: i });
    expect(e.status).toBe(201);
    ids.push(e.body.id);
  }
  return ids;
}
const walkover = (id: string, winner: 'A' | 'B') => admin.post(api(`/matches/${id}/walkover`)).send({ winner });

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
  await admin.post(api('/auth/login')).send({ username: 'admin', password: ADMIN_PASSWORD });
});

afterAll(async () => {
  server?.close();
  await mongoose.disconnect();
});

describe('single elimination with byes (6 entries)', () => {
  let tid: string;
  let cat: string;

  beforeAll(async () => {
    tid = await newTournament('KO Cup');
    cat = await newCategory(tid, { name: "Men's Singles KO", format: 'knockout', thirdPlace: true });
    await entries(tid, cat, 6);
    for (const n of ['Court 1', 'Court 2']) await admin.post(api('/courts')).send({ tournamentId: tid, name: n });
    await admin.put(api(`/tournaments/${tid}/schedule/settings`)).send({ startAt: START, matchMinutes: 30, minRestSlots: 1, seed: 1 });
  });

  it('builds the bracket: top seeds get byes, a third-place match is added', async () => {
    const r = await admin.post(api(`/categories/${cat}/bracket/generate`)).send({});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ created: 6, rounds: 3, byes: 2, deleted: 0, seeds: ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'] });
    const all = await matchesOf(tid, cat);
    expect(all.map((m) => m.stage!.roundLabel)).toEqual(['Quarterfinal', 'Quarterfinal', 'Semifinal', 'Semifinal', 'Final', 'Third place']);
    const quarters = all.filter((m) => m.stage!.round === 1).map((m) => [m.entryA.name, m.entryB.name]);
    expect(quarters).toEqual([['S4', 'S5'], ['S3', 'S6']]);
    // Seeds 1 and 2 wait in the semifinals for the winners; the final and third place are completely open.
    expect(all.filter((m) => m.stage!.roundLabel === 'Semifinal').map((m) => [m.entryA.name, m.entryB.name])).toEqual([['S1', 'TBD'], ['S2', 'TBD']]);
    expect(byName(all, 'Final')).toMatchObject({ entryA: { name: 'TBD' }, entryB: { name: 'TBD' } });
    expect(all[0]!.bracket).toMatch(/Quarterfinal$/);
  });

  it('refuses a second bracket, and a bracket for a division that is not a knockout', async () => {
    const again = await admin.post(api(`/categories/${cat}/bracket/generate`)).send({});
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('already_generated');
    const rr = await newCategory(tid, { name: 'Open', format: 'round_robin' });
    expect((await admin.post(api(`/categories/${rr}/bracket/generate`)).send({})).body.error.code).toBe('not_knockout');
  });

  it('shows undecided sides as TBD in the report and keeps the data check clean', async () => {
    const report = (await admin.get(api(`/tournaments/${tid}/report`))).body;
    const rows = report.divisions.flatMap((d: { rows: { pairA: string; pairB: string }[] }) => d.rows);
    expect(rows.filter((r: { pairA: string; pairB: string }) => r.pairA === 'TBD' || r.pairB === 'TBD').length).toBeGreaterThanOrEqual(4);
    expect((await admin.get(api(`/system/integrity?tournamentId=${tid}`))).body).toMatchObject({ ok: true, issues: [] });
  });

  it('schedules each round after the one before it, with rest for the winners', async () => {
    const p = (await admin.post(api(`/tournaments/${tid}/schedules/preview`)).send({})).body as SchedulePreview;
    const all = await matchesOf(tid, cat);
    const slot = (m: MatchDto) => p.assignments.find((a) => a.matchId === m.id)!.slot;
    expect(p.stats.scheduled).toBe(6);
    expect(p.conflicts).toEqual([]);
    const quarters = all.filter((m) => m.stage!.round === 1);
    const semis = all.filter((m) => m.stage!.roundLabel === 'Semifinal');
    expect(quarters.map(slot)).toEqual([0, 0]);
    expect(semis.map(slot).every((s) => s >= 2)).toBe(true); // played at 0, one slot of rest, semifinal at 2 or later
    const lastSemi = Math.max(...semis.map(slot));
    expect(slot(byName(all, 'Final'))).toBeGreaterThanOrEqual(lastSemi + 2);
    expect(slot(byName(all, 'Third place'))).toBeGreaterThanOrEqual(lastSemi + 2);

    const draft = await admin.post(api(`/tournaments/${tid}/schedules`)).send({});
    expect((await admin.post(api(`/tournaments/${tid}/schedules/publish`)).send({ versionId: draft.body.id })).status).toBe(200);
  });

  it('a match that is waiting for opponents cannot be started, called or given a walkover', async () => {
    const all = await matchesOf(tid, cat);
    const semi = all.filter((m) => m.stage!.roundLabel === 'Semifinal')[0]!;
    const start = await admin.post(api(`/matches/${semi.id}/start`)).send({ actionId: crypto.randomUUID(), expectedVersion: semi.version });
    expect(start.status).toBe(422);
    expect(start.body.error.code).toBe('waiting_for_opponents');
    expect((await admin.post(api(`/matches/${semi.id}/call`)).send({})).status).toBe(422);
    expect((await walkover(semi.id, 'A')).status).toBe(422);
  });

  it('the schedule cannot put a match before the one that feeds it', async () => {
    const all = await matchesOf(tid, cat);
    const fin = byName(all, 'Final');
    const courts = (await admin.get(api(`/tournaments/${tid}/courts`))).body as { id: string }[];
    const early = await admin.patch(api(`/matches/${fin.id}/schedule`)).send({ courtId: courts[0]!.id, slot: 1 });
    expect(early.status).toBe(422);
    expect(early.body.error.code).toBe('move_blocked');
    expect(early.body.error.details[0].type).toBe('dependency');
  });

  it('winners move into the next round as results come in', async () => {
    let all = await matchesOf(tid, cat);
    const [q1, q2] = all.filter((m) => m.stage!.round === 1);
    expect((await walkover(q1!.id, 'A')).status).toBe(200); // S4 beats S5
    expect((await walkover(q2!.id, 'A')).status).toBe(200); // S3 beats S6
    all = await matchesOf(tid, cat);
    expect(all.filter((m) => m.stage!.roundLabel === 'Semifinal').map((m) => [m.entryA.name, m.entryB.name])).toEqual([['S1', 'S4'], ['S2', 'S3']]);
    // The semifinal that now has both opponents is no longer "waiting".
    expect(all.filter((m) => m.stage!.roundLabel === 'Semifinal').every((m) => m.entryA.id && m.entryB.id)).toBe(true);
  });

  it('winners go to the final and losers to the third-place match', async () => {
    let all = await matchesOf(tid, cat);
    const [s1, s2] = all.filter((m) => m.stage!.roundLabel === 'Semifinal');
    expect((await walkover(s1!.id, 'A')).status).toBe(200); // S1 beats S4
    expect((await walkover(s2!.id, 'B')).status).toBe(200); // S3 beats S2
    all = await matchesOf(tid, cat);
    expect([byName(all, 'Final').entryA.name, byName(all, 'Final').entryB.name]).toEqual(['S1', 'S3']);
    expect([byName(all, 'Third place').entryA.name, byName(all, 'Third place').entryB.name]).toEqual(['S4', 'S2']);
  });

  it('correcting a semifinal winner swaps who advances, as long as the final has not started', async () => {
    let all = await matchesOf(tid, cat);
    const s2 = all.filter((m) => m.stage!.roundLabel === 'Semifinal')[1]!;
    const fix = await admin.post(api(`/matches/${s2.id}/correct`)).send({ expectedVersion: s2.version, reason: 'Wrong winner recorded', status: 'walkover', winner: 'A' });
    expect(fix.status).toBe(200);
    all = await matchesOf(tid, cat);
    expect([byName(all, 'Final').entryA.name, byName(all, 'Final').entryB.name]).toEqual(['S1', 'S2']); // S2 now in the final
    expect([byName(all, 'Third place').entryA.name, byName(all, 'Third place').entryB.name]).toEqual(['S4', 'S3']); // S3 drops to third place
  });

  it('once the final has started the semifinal winner can no longer be changed', async () => {
    let all = await matchesOf(tid, cat);
    const fin = byName(all, 'Final');
    const started = await admin.post(api(`/matches/${fin.id}/start`)).send({ actionId: crypto.randomUUID(), expectedVersion: fin.version });
    expect(started.status).toBe(200);

    all = await matchesOf(tid, cat);
    const s2 = all.filter((m) => m.stage!.roundLabel === 'Semifinal')[1]!;
    const blocked = await admin.post(api(`/matches/${s2.id}/correct`)).send({ expectedVersion: s2.version, reason: 'Changed my mind', status: 'walkover', winner: 'B' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('downstream_started');
    expect(blocked.body.error.message).toMatch(/Final/);

    // Correcting the SCORE without changing the winner is still fine.
    const same = await admin.post(api(`/matches/${s2.id}/correct`)).send({ expectedVersion: s2.version, reason: 'Same winner, now played', status: 'completed', games: [{ a: 21, b: 10 }, { a: 21, b: 12 }] });
    expect(same.status).toBe(200);
  });

  it('a started bracket cannot be rebuilt', async () => {
    const r = await admin.post(api(`/categories/${cat}/bracket/generate`)).send({ replace: true });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('bracket_started');
  });
});

describe('rebuilding, tiny and power-of-two brackets', () => {
  it('an unplayed bracket can be rebuilt after the entries change', async () => {
    const tid = await newTournament('Rebuild Cup');
    const cat = await newCategory(tid, { name: 'KO', format: 'knockout', thirdPlace: false });
    await entries(tid, cat, 4);
    expect((await admin.post(api(`/categories/${cat}/bracket/generate`)).send({})).body.created).toBe(3); // no third place
    await entries(tid, cat, 4, 'T'); // four more (seeds 1-4 again, names T1-T4)
    const rebuilt = await admin.post(api(`/categories/${cat}/bracket/generate`)).send({ replace: true });
    expect(rebuilt.status).toBe(200);
    expect(rebuilt.body).toMatchObject({ created: 7, deleted: 3, rounds: 3, byes: 0 });
    const all = await matchesOf(tid, cat);
    expect(new Set(all.map((m) => m.matchNumber)).size).toBe(7);
  });

  it('needs at least two entries; two entries make just a final', async () => {
    const tid = await newTournament('Tiny Cup');
    const cat = await newCategory(tid, { name: 'KO', format: 'knockout' });
    await entries(tid, cat, 1);
    expect((await admin.post(api(`/categories/${cat}/bracket/generate`)).send({})).body.error.code).toBe('not_enough_entries');
    await entries(tid, cat, 1, 'U');
    const r = await admin.post(api(`/categories/${cat}/bracket/generate`)).send({});
    expect(r.body).toMatchObject({ created: 1, rounds: 1, byes: 0 });
    expect((await matchesOf(tid, cat))[0]).toMatchObject({ stage: { roundLabel: 'Final' } });
  });

  it('only a knockout division can take its entries from another division', async () => {
    const tid = await newTournament('Source Cup');
    const rr = await newCategory(tid, { name: 'Groups', format: 'round_robin' });
    const bad = await admin.post(api('/categories')).send({ tournamentId: tid, name: 'X', scoring: SCORING, format: 'round_robin', sourceCategoryId: rr });
    expect(bad.status).toBe(422);
    const ko = await admin.post(api('/categories')).send({ tournamentId: tid, name: 'KO', scoring: SCORING, format: 'knockout', sourceCategoryId: rr });
    expect(ko.status).toBe(201);
    expect(ko.body).toMatchObject({ format: 'knockout', sourceCategoryId: rr, thirdPlace: true });
    const other = await newTournament('Other Cup');
    const foreign = await admin.post(api('/categories')).send({ tournamentId: other, name: 'KO', scoring: SCORING, format: 'knockout', sourceCategoryId: rr });
    expect(foreign.status).toBe(404);
  });
});

describe('group stage followed by a knockout', () => {
  let tid: string;
  let groups: string;
  let ko: string;

  beforeAll(async () => {
    tid = await newTournament('Groups Cup');
    groups = await newCategory(tid, { name: 'Open Singles', format: 'round_robin' });
    await entries(tid, groups, 8);
    ko = await newCategory(tid, { name: 'Open Singles KO', format: 'knockout', thirdPlace: true, sourceCategoryId: groups });
  });

  it('splits the entries into groups in snake order by seed, and needs enough entries', async () => {
    expect((await admin.post(api(`/categories/${groups}/groups`)).send({ count: 5 })).status).toBe(422); // 5 groups would leave groups of one
    const r = await admin.post(api(`/categories/${groups}/groups`)).send({ count: 2 });
    expect(r.status).toBe(200);
    expect(r.body.map((g: { group: string; entries: { name: string }[] }) => [g.group, g.entries.map((e) => e.name)])).toEqual([
      ['A', ['S1', 'S4', 'S5', 'S8']],
      ['B', ['S2', 'S3', 'S6', 'S7']],
    ]);
    const pairs = (await admin.get(api(`/tournaments/${tid}/pairings`))).body as { displayName: string; group: string }[];
    expect(pairs.find((p) => p.displayName === 'S5')!.group).toBe('A');
  });

  it('a round robin is played inside each group only', async () => {
    const gen = await admin.post(api(`/tournaments/${tid}/matches/generate`)).send({});
    expect(gen.body).toMatchObject({ created: 12, problems: [] }); // 2 groups x 6 matches
    const all = await matchesOf(tid, groups);
    const pairs = (await admin.get(api(`/tournaments/${tid}/pairings`))).body as { id: string; group: string }[];
    const groupOf = new Map(pairs.map((p) => [p.id, p.group]));
    expect(all.every((m) => groupOf.get(m.entryA.id) === groupOf.get(m.entryB.id))).toBe(true);
    expect(all.filter((m) => m.round.startsWith('Group A')).length).toBe(6);
    expect(all.filter((m) => m.round.startsWith('Group B')).length).toBe(6);
    expect(all.some((m) => /^Group [AB] · Round [1-3]$/.test(m.round))).toBe(true);
  });

  it('groups cannot be changed once matches exist; standings show one table per group', async () => {
    expect((await admin.post(api(`/categories/${groups}/groups`)).send({ count: 2 })).body.error.code).toBe('has_matches');
    expect((await admin.delete(api(`/categories/${groups}/groups`))).status).toBe(409);
    const s = (await request(server).get(api(`/tournaments/${tid}/standings`))).body as StandingsResponse;
    expect(s.categories.map((c) => c.name)).toEqual(['Open Singles · Group A', 'Open Singles · Group B']); // the knockout has no entries of its own
    expect(s.categories.every((c) => c.pairs.length === 4)).toBe(true);
  });

  it('the bracket waits until the groups are finished (unless forced)', async () => {
    const r = await admin.post(api(`/categories/${ko}/bracket/generate`)).send({});
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('groups_unfinished');
    expect(r.body.error.message).toMatch(/12 match/);
  });

  it('group winners cross over with the other group\'s runners-up (1A-2B, 1B-2A)', async () => {
    for (const m of await matchesOf(tid, groups)) expect((await walkover(m.id, 'A')).status).toBe(200);
    const s = (await request(server).get(api(`/tournaments/${tid}/standings`))).body as StandingsResponse;
    const table = (g: string) => s.categories.find((c) => c.name.endsWith(`Group ${g}`))!.pairs.map((p) => p.name);
    const [a, b] = [table('A'), table('B')];

    const r = await admin.post(api(`/categories/${ko}/bracket/generate`)).send({});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ created: 4, rounds: 2, byes: 0 }); // two semifinals, final, third place
    expect(r.body.seeds).toEqual([a[0], b[0], a[1], b[1]]); // winners of A and B, then runners-up

    const semis = (await matchesOf(tid, ko)).filter((m) => m.stage!.roundLabel === 'Semifinal');
    expect(semis.map((m) => [m.entryA.name, m.entryB.name])).toEqual([[a[0], b[1]], [b[0], a[1]]]);
  });

  it('a knockout from groups can take only the group winners', async () => {
    const tid2 = await newTournament('Winners Cup');
    const g = await newCategory(tid2, { name: 'G', format: 'round_robin' });
    await entries(tid2, g, 8);
    await admin.post(api(`/categories/${g}/groups`)).send({ count: 4 });
    const k = await newCategory(tid2, { name: 'K', format: 'knockout', sourceCategoryId: g });
    const r = await admin.post(api(`/categories/${k}/bracket/generate`)).send({ advancePerGroup: 1, force: true });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ created: 4, rounds: 2 }); // 4 group winners
  });
});
