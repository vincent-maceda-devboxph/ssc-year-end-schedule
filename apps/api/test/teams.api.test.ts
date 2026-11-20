import crypto from 'node:crypto';
import http from 'node:http';
import mongoose from 'mongoose';
import ExcelJS from 'exceljs';
import request from 'supertest';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GenerateMatchesResult, LineupImportResult, MatchDto, StandingsResponse } from '@bt/shared';
import { createApp } from '../src/app.js';
import { connectDb, ensureSuperAdmin, loadJwtSecret } from '../src/db.js';
import { AuthService } from '../src/modules/auth/auth.service.js';
import { createSocketServer } from '../src/sockets/index.js';

// Separate database: vitest runs test files in parallel.
const MONGO = process.env.TEST_MONGO_URI_TEAMS ?? 'mongodb://127.0.0.1:27017/badminton_test_teams';
const ADMIN_PASSWORD = 'test-admin-password';

let server: http.Server;
let admin: ReturnType<typeof request.agent>;
let tid: string;

const TEAMS = ['Hulk Smashers', 'Avengers Netters', 'Iron Shuttlers'];
/** Each team lists 10 men's pairs then 3 women's pairs; the ORDER of the rows is each pair's position. */
const DIVISIONS = [...Array.from({ length: 10 }, () => 'MD'), 'WD', 'WD', 'WD'];
const referenceRows = TEAMS.flatMap((team, t) =>
  DIVISIONS.map((category, c) => ({ team, category, player1: `P${t}-${c}-1`, player2: `P${t}-${c}-2 X.` })),
);
// A few real names from the reference image.
referenceRows[0] = { team: 'Hulk Smashers', category: 'MD-A', player1: 'Kennith', player2: 'Zeth' };
referenceRows[13] = { team: 'Avengers Netters', category: 'MD-A', player1: 'Ken', player2: 'JL' };
referenceRows[26] = { team: 'Iron Shuttlers', category: 'MD-A', player1: 'Baitan', player2: 'Paul' };

const generate = (body: object = {}) => admin.post(`/api/tournaments/${tid}/matches/generate`).send(body);

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
});

afterAll(async () => {
  server?.close();
  await mongoose.disconnect();
});

describe('lineup import', () => {
  it('dry run reports what would be created and writes nothing', async () => {
    const res = await admin.post(`/api/tournaments/${tid}/lineup/import`).send({ rows: referenceRows, dryRun: true });
    expect(res.status).toBe(200);
    const r: LineupImportResult = res.body;
    expect(r).toMatchObject({ dryRun: true, playersCreated: 78, pairsCreated: 39, errors: [] });
    expect(r.teamsCreated).toEqual(TEAMS);
    expect(r.categoriesCreated).toEqual(["Men's Doubles", "Women's Doubles"]);
    expect((await admin.get(`/api/tournaments/${tid}/teams`)).body).toHaveLength(0);
  });

  it('rejects the whole paste when a player appears in two pairs', async () => {
    const rows = [...referenceRows, { team: 'Hulk Smashers', category: 'MD', player1: 'Kennith', player2: 'Someone' }];
    const res = await admin.post(`/api/tournaments/${tid}/lineup/import`).send({ rows });
    expect(res.status).toBe(422);
    expect(res.body.errors[0].message).toContain('Kennith');
    expect((await admin.get(`/api/tournaments/${tid}/teams`)).body).toHaveLength(0);
  });

  it('imports teams (with colours), categories, players and pairs', async () => {
    const res = await admin.post(`/api/tournaments/${tid}/lineup/import`).send({ rows: referenceRows });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ playersCreated: 78, pairsCreated: 39 });
    const teams = (await admin.get(`/api/tournaments/${tid}/teams`)).body;
    expect(teams.map((t: { name: string }) => t.name).sort()).toEqual([...TEAMS].sort());
    expect(new Set(teams.map((t: { color: string }) => t.color)).size).toBe(3);
    const pairs = (await admin.get(`/api/tournaments/${tid}/pairings`)).body;
    expect(pairs).toHaveLength(39);
    expect(pairs.find((p: { displayName: string }) => p.displayName === 'Kennith / Zeth').teamId).toBeTruthy();
  });

  it("the order of rows is each pair's position within its team and division", async () => {
    const api = `/api/tournaments/${tid}`;
    const [cats, teams, pairs] = await Promise.all([admin.get(`${api}/categories`), admin.get(`${api}/teams`), admin.get(`${api}/pairings`)]);
    expect(cats.body.map((c: { name: string; code: string }) => [c.name, c.code]).sort()).toEqual([["Men's Doubles", 'MD'], ["Women's Doubles", 'WD']]);
    const md = cats.body.find((c: { code: string }) => c.code === 'MD').id;
    const hulk = teams.body.find((t: { name: string }) => t.name === 'Hulk Smashers').id;
    const mine = (pairs.body as { categoryId: string; teamId: string; rank: number; displayName: string }[])
      .filter((p) => p.categoryId === md && p.teamId === hulk)
      .sort((a, b) => a.rank - b.rank);
    expect(mine.map((p) => p.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(mine[0]!.displayName).toBe('Kennith / Zeth');
  });

  it('old-style level labels (MD-C) are read as the division; position still comes from row order', async () => {
    const r = await admin.post(`/api/tournaments/${tid}/lineup/import`).send({
      dryRun: true,
      rows: [{ team: 'Hulk Smashers', category: 'MD-C', player1: 'Newbie', player2: 'Rookie' }],
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ pairsCreated: 1, categoriesCreated: [], teamsCreated: [] });
  });

  it('importing the same paste again changes nothing', async () => {
    const res = await admin.post(`/api/tournaments/${tid}/lineup/import`).send({ rows: referenceRows });
    expect(res.body).toMatchObject({ unchanged: 39, pairsCreated: 0, playersCreated: 0, teamsCreated: [], categoriesCreated: [] });
  });

  it('a pair can be moved up or down in its team list, and positions never collide', async () => {
    const list = async () => ((await admin.get(`/api/tournaments/${tid}/pairings`)).body as { id: string; displayName: string; rank: number; teamId: string; categoryId: string }[]);
    const first = (await list()).find((p) => p.displayName === 'Kennith / Zeth')!;
    const second = (await list()).find((p) => p.teamId === first.teamId && p.categoryId === first.categoryId && p.rank === 2)!;
    expect(first.rank).toBe(1);

    expect((await admin.post(`/api/entries/${first.id}/move`).send({ direction: 'up' })).status).toBe(422); // already first
    expect((await admin.post(`/api/entries/${first.id}/move`).send({ direction: 'down' })).status).toBe(200);
    let now = await list();
    expect(now.find((p) => p.id === first.id)!.rank).toBe(2);
    expect(now.find((p) => p.id === second.id)!.rank).toBe(1);

    await admin.post(`/api/entries/${first.id}/move`).send({ direction: 'up' });
    now = await list();
    expect(now.find((p) => p.id === first.id)!.rank).toBe(1);
    expect(now.find((p) => p.id === second.id)!.rank).toBe(2);
  });

  it('deleting a pair closes the gap in its team list', async () => {
    const created = await admin.post(`/api/tournaments/${tid}/lineup/import`).send({
      rows: [
        { team: 'Hulk Smashers', category: 'WD', player1: 'Temp1', player2: 'Temp2' },
        { team: 'Hulk Smashers', category: 'WD', player1: 'Temp3', player2: 'Temp4' },
      ],
    });
    expect(created.body.pairsCreated).toBe(2);
    const pairs = async () => ((await admin.get(`/api/tournaments/${tid}/pairings`)).body as { id: string; displayName: string; rank: number }[]);
    let all = await pairs();
    expect(all.find((p) => p.displayName === 'Temp1 / Temp2')!.rank).toBe(4); // after the 3 existing WD pairs
    expect(all.find((p) => p.displayName === 'Temp3 / Temp4')!.rank).toBe(5);

    expect((await admin.delete(`/api/entries/${all.find((p) => p.displayName === 'Temp1 / Temp2')!.id}`)).status).toBe(204);
    all = await pairs();
    expect(all.find((p) => p.displayName === 'Temp3 / Temp4')!.rank).toBe(4);
    await admin.delete(`/api/entries/${all.find((p) => p.displayName === 'Temp3 / Temp4')!.id}`);
    expect(await pairs()).toHaveLength(39);
  });
});

describe('match generation', () => {
  let matches: MatchDto[];

  it('creates 39 team-vs-team matches (3 per category), unscheduled', async () => {
    const res = await generate();
    const r: GenerateMatchesResult = res.body;
    expect(res.status).toBe(200);
    expect(r).toMatchObject({ created: 39, skipped: 0, deleted: 0, problems: [] });
    matches = (await admin.get(`/api/matches?tournamentId=${tid}`)).body;
    expect(matches).toHaveLength(39);
    for (const m of matches) {
      expect(m.teamA!.id).not.toBe(m.teamB!.id);
      expect(m.status).toBe('pending');
      expect(m.courtId).toBeNull();
    }
    const mdA = matches.filter((m) => m.bracket === 'MD-A').map((m) => [m.entryA.name, m.entryB.name].sort().join(' vs '));
    expect(mdA.sort()).toEqual(['Baitan / Paul vs Ken / JL', 'Baitan / Paul vs Kennith / Zeth', 'Ken / JL vs Kennith / Zeth']);
  });

  it('every match is between the same position of two different teams', async () => {
    const pairs = (await admin.get(`/api/tournaments/${tid}/pairings`)).body as { id: string; rank: number }[];
    const rankOf = new Map(pairs.map((p) => [p.id, p.rank]));
    for (const m of matches) {
      expect(rankOf.get(m.entryA.id)).toBe(m.rank);
      expect(rankOf.get(m.entryB.id)).toBe(m.rank);
    }
    const perBracket = new Map<string, number>();
    for (const m of matches) perBracket.set(m.bracket, (perBracket.get(m.bracket) ?? 0) + 1);
    expect([...perBracket.keys()].sort()).toEqual(['MD-A', 'MD-B', 'MD-C', 'MD-D', 'MD-E', 'MD-F', 'MD-G', 'MD-H', 'MD-I', 'MD-J', 'WD-A', 'WD-B', 'WD-C']);
    expect([...perBracket.values()].every((n) => n === 3)).toBe(true);
  });

  it('running it again does not duplicate anything', async () => {
    expect((await generate()).body).toMatchObject({ created: 0, skipped: 39 });
  });

  it('two admins generating at the same moment still produce one set', async () => {
    const [a, b] = await Promise.all([generate({ replace: true }), generate({ replace: true })]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect((await admin.get(`/api/matches?tournamentId=${tid}`)).body).toHaveLength(39);
  });

  it('replace keeps matches that already have results', async () => {
    matches = (await admin.get(`/api/matches?tournamentId=${tid}`)).body;
    const first = matches[0]!;
    await admin.post(`/api/matches/${first.id}/walkover`).send({ winner: 'A' });
    const r = (await generate({ replace: true })).body;
    expect(r).toMatchObject({ deleted: 38, created: 38, skipped: 1 });
    const after: MatchDto[] = (await admin.get(`/api/matches?tournamentId=${tid}`)).body;
    expect(after).toHaveLength(39);
    expect(after.find((m) => m.id === first.id)?.status).toBe('walkover');
  });
});

describe('realtime for signed-in clients', () => {
  it('an admin socket that subscribes immediately on connect receives standings updates', async () => {
    // Regression: the server used to register 'subscribe' after an async auth lookup, so a
    // signed-in client's immediate subscribe was dropped and its dashboard never updated.
    const login = await request(server).post('/api/auth/login').send({ username: 'admin', password: ADMIN_PASSWORD });
    const cookie = (login.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
    const { port } = server.address() as { port: number };
    const sock: ClientSocket = ioClient(`http://127.0.0.1:${port}`, { transports: ['websocket'], extraHeaders: { cookie }, forceNew: true });
    const got = new Promise<string>((resolve) => sock.on('standings:updated', (p: { tournamentId: string }) => resolve(p.tournamentId)));
    await new Promise<void>((resolve) => sock.on('connect', () => sock.emit('subscribe', [`tournament:${tid}`], () => resolve())));

    const m: MatchDto = (await admin.get(`/api/matches?tournamentId=${tid}&status=pending`)).body[0];
    await admin.post(`/api/matches/${m.id}/walkover`).send({ winner: 'B' });
    await expect(Promise.race([got, new Promise((_, rej) => setTimeout(() => rej(new Error('no event')), 2000))])).resolves.toBe(tid);
    sock.close();
  });
});

describe('standings', () => {
  it('1 team point per match won; pair standings per category', async () => {
    const all: MatchDto[] = (await admin.get(`/api/matches?tournamentId=${tid}`)).body;
    const done = all.find((m) => m.status === 'walkover')!;
    const winnerTeam = done.teamA!.id;

    // Play one more match for real: B wins 21-0, 21-0 via admin scoring.
    const m = all.find((x) => x.status === 'pending' && x.categoryId !== done.categoryId)!;
    const courtId = (await admin.post('/api/courts').send({ tournamentId: tid, name: 'Court 1' })).body.id;
    let cur: MatchDto = (await admin.put(`/api/matches/${m.id}`).send({ courtId })).body;
    const cmd = async (route: string, extra: object = {}) => {
      const r = await admin.post(`/api/matches/${cur.id}/${route}`).send({ actionId: crypto.randomUUID(), expectedVersion: cur.version, ...extra });
      expect(r.status).toBe(200);
      cur = r.body.match;
    };
    await cmd('start');
    for (let i = 0; i < 42; i++) await cmd('points', { side: 'B' });
    await cmd('complete');

    const s: StandingsResponse = (await request(server).get(`/api/tournaments/${tid}/standings`)).body;
    const pts = Object.fromEntries(s.teams.map((t) => [t.teamId, t.points]));
    expect(pts[winnerTeam]).toBeGreaterThanOrEqual(1);
    expect(pts[cur.teamB!.id]).toBeGreaterThanOrEqual(1);
    // Two walkovers (generation + realtime tests) and one played match.
    expect(s.teams.reduce((n, t) => n + t.points, 0)).toBe(3);
    const bTeam = s.teams.find((t) => t.teamId === cur.teamB!.id)!;
    expect(bTeam.byCategory[cur.categoryId]).toBe(1);
    const cat = s.categories.find((c) => c.id === cur.categoryId)!;
    expect(cat.pairs[0]).toMatchObject({ name: cur.entryB.name, won: 1, gamesWon: 2 });
  });
});

describe('singles divisions', () => {
  let sid: string;
  const lineup = (rows: object[], dryRun = false) => admin.post(`/api/tournaments/${sid}/lineup/import`).send({ rows, dryRun });

  beforeAll(async () => {
    sid = (await admin.post('/api/tournaments').send({ name: 'Singles Cup', status: 'active' })).body.id;
  });

  it('a singles division takes one player per row; a doubles row still needs two', async () => {
    const two = await lineup([{ team: 'Red', category: 'MS', player1: 'Ana', player2: 'Bea' }]);
    expect(two.status).toBe(422);
    expect(two.body.errors[0].message).toMatch(/singles division: one player per row/);
    const one = await lineup([{ team: 'Red', category: 'MD', player1: 'Ana' }]);
    expect(one.status).toBe(422);
    expect(one.body.errors[0].message).toMatch(/doubles division: this row needs two players/);
  });

  it('imports one player per entry and creates the singles division', async () => {
    const rows = ['Ana', 'Ben', 'Carl'].map((p) => ({ team: 'Red', category: 'MS', player1: p }))
      .concat(['Dan', 'Eli', 'Fay'].map((p) => ({ team: 'Blue', category: 'MS', player1: p })));
    const r = await lineup(rows);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ pairsCreated: 6, playersCreated: 6, categoriesCreated: ["Men's Singles"] });

    const cats = (await admin.get(`/api/tournaments/${sid}/categories`)).body;
    expect(cats[0]).toMatchObject({ name: "Men's Singles", code: 'MS', discipline: 'singles', playersPerEntry: 1 });
    const pairs = (await admin.get(`/api/tournaments/${sid}/pairings`)).body as { displayName: string; playerIds: string[]; rank: number }[];
    expect(pairs.every((p) => p.playerIds.length === 1)).toBe(true);
    expect(pairs.find((p) => p.displayName === 'Ben')).toMatchObject({ rank: 2 });
    expect((await lineup(rows)).body).toMatchObject({ unchanged: 6, pairsCreated: 0 }); // same paste again changes nothing
  });

  it('generates, labels and schedules singles matches like any other', async () => {
    const gen = await admin.post(`/api/tournaments/${sid}/matches/generate`).send({});
    expect(gen.body).toMatchObject({ created: 3, problems: [] });
    const all = (await admin.get(`/api/matches?tournamentId=${sid}`)).body as MatchDto[];
    expect(all.map((m) => m.bracket).sort()).toEqual(['MS-A', 'MS-B', 'MS-C']);
    expect(all.map((m) => [m.entryA.name, m.entryB.name].sort().join(' v ')).sort()).toEqual(['Ana v Dan', 'Ben v Eli', 'Carl v Fay']);

    for (const n of ['Court 1', 'Court 2']) await admin.post('/api/courts').send({ tournamentId: sid, name: n });
    await admin.put(`/api/tournaments/${sid}/schedule/settings`).send({ startAt: '2026-11-29T07:00:00.000Z', matchMinutes: 20, minRestSlots: 1, seed: 1 });
    const p = (await admin.post(`/api/tournaments/${sid}/schedules/preview`).send({})).body;
    expect(p.stats).toMatchObject({ scheduled: 3, slots: 2 });
    expect(p.conflicts).toEqual([]);
  });

  it('adding a singles entry by hand needs exactly one player', async () => {
    const cats = (await admin.get(`/api/tournaments/${sid}/categories`)).body as { id: string }[];
    const pl = (await admin.get(`/api/players?tournamentId=${sid}`)).body as { id: string }[];
    const r = await admin.post('/api/entries').send({ categoryId: cats[0]!.id, playerIds: [pl[0]!.id, pl[1]!.id] });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('wrong_player_count');
  });
});

describe('importing a CSV or Excel file', () => {
  let fid: string;
  const upload = (file: Buffer | string, name: string) =>
    admin.post(`/api/tournaments/${fid}/lineup/parse-file`).set('Content-Type', 'application/octet-stream').set('X-Filename', encodeURIComponent(name)).send(file as never);

  beforeAll(async () => {
    fid = (await admin.post('/api/tournaments').send({ name: 'File Cup', status: 'active' })).body.id;
  });

  it('reads an Excel file: header skipped, blank and short rows reported, nicknames and accents kept', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Lineup');
    ws.addRow(['Team', 'Division', 'Player 1', 'Player 2']);
    ws.addRow(['Hulk Smashers', 'MD', 'Kennith', 'Zeth']);
    ws.addRow([]);
    ws.addRow(['Hulk Smashers', 'WD', 'Cjane', 'Margaux']);
    ws.addRow(['Hulk Smashers', 'MD']); // too short
    ws.addRow(['Iron Shuttlers', 'MS', 'Baitan']); // singles row
    ws.addRow(['Iron Shuttlers', 'MD', 'Hannah J.', 'Niña']);
    const r = await upload(Buffer.from(await wb.xlsx.writeBuffer()), 'lineup.xlsx');
    expect(r.status).toBe(200);
    expect(r.body.source).toBe('Lineup');
    expect(r.body.rows).toEqual([
      { team: 'Hulk Smashers', category: 'MD', player1: 'Kennith', player2: 'Zeth' },
      { team: 'Hulk Smashers', category: 'WD', player1: 'Cjane', player2: 'Margaux' },
      { team: 'Iron Shuttlers', category: 'MS', player1: 'Baitan', player2: '' },
      { team: 'Iron Shuttlers', category: 'MD', player1: 'Hannah J.', player2: 'Niña' },
    ]);
    expect(r.body.skipped).toEqual([5]);
  });

  it('the parsed rows go straight into the normal check and import', async () => {
    const parsed = (await upload('Team,Division,Player 1,Player 2\nRed,MD,A1,A2\nBlue,MD,B1,B2\n', 'x.csv')).body.rows;
    const check = await admin.post(`/api/tournaments/${fid}/lineup/import`).send({ rows: parsed, dryRun: true });
    expect(check.body).toMatchObject({ pairsCreated: 2, errors: [] });
  });

  it('reads CSV with quoted commas, a byte-order mark and Windows line endings', async () => {
    const csv = '﻿Team,Division,Player 1,Player 2\r\n"Team A, the first",MD,"Smith, J.",Jones\r\nTeam B,MD,Lee,Kim\r\n';
    const r = await upload(csv, 'lineup.csv');
    expect(r.body.rows).toEqual([
      { team: 'Team A, the first', category: 'MD', player1: 'Smith, J.', player2: 'Jones' },
      { team: 'Team B', category: 'MD', player1: 'Lee', player2: 'Kim' },
    ]);
  });

  it('reads semicolon-separated and tab-separated files', async () => {
    expect((await upload('Team;Division;Player 1;Player 2\nRed;MD;A;B\n', 'semi.csv')).body.rows).toHaveLength(1);
    expect((await upload('Red\tMD\tA\tB\nBlue\tMD\tC\tD\n', 'tabs.tsv')).body.rows).toHaveLength(2);
  });

  it('refuses old .xls, damaged and empty files, and needs an admin', async () => {
    expect((await upload('whatever', 'old.xls')).status).toBe(415);
    expect((await upload('this is not a zip', 'broken.xlsx')).status).toBe(400);
    expect((await upload('', 'empty.csv')).status).toBe(400);
    expect((await upload('Team,Division,Player 1\n', 'headeronly.csv')).body.rows).toEqual([]);
    const anon = await request(server).post(`/api/tournaments/${fid}/lineup/parse-file`).set('X-Filename', 'a.csv').send('x');
    expect(anon.status).toBe(401);
  });
});
