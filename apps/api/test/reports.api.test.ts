import crypto from 'node:crypto';
import http from 'node:http';
import ExcelJS from 'exceljs';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MatchDto, ReportDto } from '@bt/shared';
import { createApp } from '../src/app.js';
import { connectDb, ensureSuperAdmin, loadJwtSecret } from '../src/db.js';
import { AuthService } from '../src/modules/auth/auth.service.js';
import { createSocketServer } from '../src/sockets/index.js';

// Own database: vitest runs test files in parallel.
const MONGO = process.env.TEST_MONGO_URI_REPORTS ?? 'mongodb://127.0.0.1:27017/badminton_test_reports';
const ADMIN_PASSWORD = 'test-admin-password';

let server: http.Server;
let admin: ReturnType<typeof request.agent>;
let umpire: ReturnType<typeof request.agent>;
let tid: string;
let courtIds: string[];
let matches: MatchDto[];

const TEAMS = ['Hulk', 'Avengers', 'Iron'];
// Each team: 2 men's pairs and 1 women's pair (row order = position).
const rows = TEAMS.flatMap((team) => [
  { team, category: 'MD', player1: `${team}-m1a`, player2: `${team}-m1b` },
  { team, category: 'MD', player1: `${team}-m2a`, player2: `${team}-m2b` },
  { team, category: 'WD', player1: `${team}-w1a`, player2: `${team}-w1b` },
]);

const binary = (res: http.IncomingMessage, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

async function play(agent: ReturnType<typeof request.agent>, match: MatchDto, winner: 'A' | 'B') {
  let m = match;
  const send = async (route: string, extra: object = {}) => {
    const r = await agent.post(`/api/matches/${m.id}/${route}`).send({ actionId: crypto.randomUUID(), expectedVersion: m.version, ...extra });
    expect(r.status).toBe(200);
    m = r.body.match;
  };
  await send('start');
  for (let i = 0; i < 42; i++) await send('points', { side: winner });
  await send('complete');
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

  tid = (await admin.post('/api/tournaments').send({ name: 'Report Cup', venue: 'Main Hall', date: '2026-11-29', status: 'active' })).body.id;
  expect((await admin.post(`/api/tournaments/${tid}/lineup/import`).send({ rows })).status).toBe(200);
  courtIds = [];
  for (const n of ['Court 1', 'Court 2']) courtIds.push((await admin.post('/api/courts').send({ tournamentId: tid, name: n })).body.id);
  expect((await admin.post(`/api/tournaments/${tid}/matches/generate`).send({})).body.created).toBe(9);
  matches = (await admin.get(`/api/matches?tournamentId=${tid}`)).body;
  for (const m of matches) await admin.put(`/api/matches/${m.id}`).send({ courtId: courtIds[0] });
  // A team captain, so the duplicate can prove it carries over.
  const players = (await admin.get(`/api/players?tournamentId=${tid}`)).body as { id: string; teamId: string; firstName: string }[];
  const teams = (await admin.get(`/api/tournaments/${tid}/teams`)).body as { id: string; name: string }[];
  const hulk = teams.find((t) => t.name === 'Hulk')!;
  await admin.put(`/api/teams/${hulk.id}`).send({ captainPlayerId: players.find((p) => p.teamId === hulk.id)!.id });

  // Play: three full matches by an umpire on court 1, one walkover, one retirement (by admin), one correction.
  const code = (await admin.post(`/api/courts/${courtIds[0]}/code`)).body.code as string;
  umpire = request.agent(server);
  expect((await umpire.post('/api/auth/umpire/login').send({ courtId: courtIds[0], code, name: 'Maria Umpire' })).status).toBe(200);
  const fresh = async () => (await admin.get(`/api/matches?tournamentId=${tid}`)).body as MatchDto[];
  for (let i = 0; i < 3; i++) {
    const next = (await fresh()).find((m) => m.status === 'scheduled')!;
    await play(umpire, next, i === 1 ? 'B' : 'A');
  }
  const wo = (await fresh()).find((m) => m.status === 'scheduled')!;
  expect((await admin.post(`/api/matches/${wo.id}/walkover`).send({ winner: 'B' })).status).toBe(200);
  const ret = (await fresh()).find((m) => m.status === 'scheduled')!;
  let r = ret;
  const rs = async (route: string, extra: object = {}) => {
    const x = await admin.post(`/api/matches/${r.id}/${route}`).send({ actionId: crypto.randomUUID(), expectedVersion: r.version, ...extra });
    expect(x.status).toBe(200);
    r = x.body.match;
  };
  await rs('start');
  await rs('points', { side: 'A' });
  await rs('retire', { side: 'B' });
  const first = (await fresh()).find((m) => m.status === 'completed')!;
  expect((await admin.post(`/api/matches/${first.id}/correct`).send({ expectedVersion: first.version, reason: 'Wrong side was credited', games: [{ a: 15, b: 21 }, { a: 12, b: 21 }] })).status).toBe(200);
});

afterAll(async () => {
  server?.close();
  await mongoose.disconnect();
});

describe('report', () => {
  let report: ReportDto;

  it('is for admins only', async () => {
    expect((await request(server).get(`/api/tournaments/${tid}/report`)).status).toBe(401);
    expect((await request(server).get(`/api/tournaments/${tid}/report/export`)).status).toBe(401);
  });

  it('counts matches, outcomes, games, rally points and corrections', async () => {
    report = (await admin.get(`/api/tournaments/${tid}/report`)).body;
    expect(report.tournament).toMatchObject({ name: 'Report Cup', venue: 'Main Hall', status: 'active' });
    expect(report.totals).toMatchObject({ matches: 9, finished: 5, completed: 3, walkover: 1, retired: 1, notStarted: 4, live: 0, corrected: 1 });
    // 3 played matches x 2 games (21-0 each, one corrected to 15-21, 12-21) + the retired match's 1 point.
    expect(report.totals.games).toBe(6 + 1);
    expect(report.totals.rallyPoints).toBe(2 * 21 + 2 * 21 + 2 * 21 - (21 + 21) + (15 + 21 + 12 + 21) + 1);
    expect(report.totals.avgMinutes).not.toBeNull();
  });

  it('every finished match is one point for a team', () => {
    expect(report.teams.reduce((n, t) => n + t.points, 0)).toBe(5);
    expect(report.teams.map((t) => t.rank).sort()).toEqual(expect.any(Array));
  });

  it('lists every match by division and level, in order, with scores and winners', () => {
    expect(report.divisions.map((d) => [d.name, d.code, d.rows.length])).toEqual([["Men's Doubles", 'MD', 6], ["Women's Doubles", 'WD', 3]]);
    const md = report.divisions[0]!.rows;
    expect(md.map((r) => r.bracket)).toEqual([...md.map((r) => r.bracket)].sort());
    const corrected = md.concat(report.divisions[1]!.rows).find((r) => r.corrected)!;
    expect(corrected).toMatchObject({ score: '15-21, 12-21', status: 'completed', umpire: 'Maria Umpire' });
    const all = report.divisions.flatMap((d) => d.rows);
    expect(all.find((r) => r.status === 'walkover')).toMatchObject({ score: 'W/O' });
    expect(all.find((r) => r.status === 'retired')!.score).toMatch(/ ret\.$/);
  });

  it('gives each pair a record, the umpire a count, and keeps the correction with its reason', () => {
    expect(report.pairs).toHaveLength(9);
    expect(report.pairs.reduce((n, p) => n + p.won, 0)).toBe(5);
    expect(report.pairs.reduce((n, p) => n + p.played, 0)).toBe(10); // 5 finished matches x 2 pairs
    expect(report.umpires).toEqual([{ name: 'Maria Umpire', matches: 3 }]);
    expect(report.corrections).toHaveLength(1);
    expect(report.corrections[0]).toMatchObject({ by: 'admin', reason: 'Wrong side was credited' });
  });

  it('exports the same numbers as an Excel workbook', async () => {
    const res = await admin.get(`/api/tournaments/${tid}/report/export`).buffer(true).parse(binary as never);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('report-report-cup.xlsx');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body as Buffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Summary', 'Results', 'Pairs', 'Umpires', 'Corrections']);
    expect(wb.getWorksheet('Results')!.rowCount).toBe(10); // header + 9 matches
    expect(wb.getWorksheet('Pairs')!.rowCount).toBe(10);
    expect(wb.getWorksheet('Corrections')!.getRow(2).getCell(5).value).toBe('Wrong side was credited');
    expect(wb.getWorksheet('Umpires')!.getRow(2).values).toEqual([undefined, 'Maria Umpire', 3]);
    expect(String(wb.getWorksheet('Summary')!.getRow(1).getCell(1).value)).toBe('Report Cup');
  });
});

describe('duplicating a tournament', () => {
  it('needs an admin and a name', async () => {
    expect((await request(server).post(`/api/tournaments/${tid}/duplicate`).send({ name: 'x' })).status).toBe(401);
    expect((await admin.post(`/api/tournaments/${tid}/duplicate`).send({ name: '   ' })).status).toBe(400);
    expect((await admin.post(`/api/tournaments/${'a'.repeat(24)}/duplicate`).send({ name: 'x' })).status).toBe(404);
  });

  it('copies divisions, teams, courts, players and pairs in order, but no matches, schedule times or umpire codes', async () => {
    const r = await admin.post(`/api/tournaments/${tid}/duplicate`).send({ name: 'Report Cup II' });
    expect(r.status).toBe(201);
    expect(r.body.copied).toEqual({ divisions: 2, teams: 3, courts: 2, players: 18, pairs: 9 });
    expect(r.body.tournament).toMatchObject({ name: 'Report Cup II', status: 'draft', venue: 'Main Hall' });
    const nid = r.body.tournament.id as string;

    expect((await admin.get(`/api/matches?tournamentId=${nid}`)).body).toEqual([]);
    const courts = (await admin.get(`/api/tournaments/${nid}/courts`)).body as { name: string; hasCode: boolean }[];
    expect(courts.map((c) => c.name)).toEqual(['Court 1', 'Court 2']);
    expect(courts.every((c) => !c.hasCode)).toBe(true);

    const [oldPairs, newPairs] = await Promise.all([admin.get(`/api/tournaments/${tid}/pairings`), admin.get(`/api/tournaments/${nid}/pairings`)]);
    const key = (p: { displayName: string; rank: number; teamId: string }) => `${p.displayName}#${p.rank}`;
    expect((newPairs.body as { displayName: string; rank: number; teamId: string }[]).map(key).sort()).toEqual((oldPairs.body as { displayName: string; rank: number; teamId: string }[]).map(key).sort());
    // New ids, not the originals.
    expect((newPairs.body as { id: string }[]).some((p) => (oldPairs.body as { id: string }[]).some((o) => o.id === p.id))).toBe(false);

    const teams = (await admin.get(`/api/tournaments/${nid}/teams`)).body as { name: string; captainPlayerId: string | null }[];
    expect(teams.find((t) => t.name === 'Hulk')!.captainPlayerId).toBeTruthy();
    expect(teams.find((t) => t.name === 'Iron')!.captainPlayerId).toBeNull();

    // The copy is consistent and can be used straight away.
    const check = (await admin.get(`/api/system/integrity?tournamentId=${nid}`)).body;
    expect(check).toMatchObject({ ok: true, issues: [] });
    expect((await admin.post(`/api/tournaments/${nid}/matches/generate`).send({})).body.created).toBe(9);
  });

  it('can copy just the structure', async () => {
    const r = await admin.post(`/api/tournaments/${tid}/duplicate`).send({ name: 'Empty Cup', includeRoster: false });
    expect(r.body.copied).toEqual({ divisions: 2, teams: 3, courts: 2, players: 0, pairs: 0 });
    expect((await admin.get(`/api/tournaments/${r.body.tournament.id}/pairings`)).body).toEqual([]);
  });

  it('leaves the original untouched', async () => {
    expect((await admin.get(`/api/matches?tournamentId=${tid}`)).body).toHaveLength(9);
    expect((await admin.get(`/api/tournaments/${tid}/pairings`)).body).toHaveLength(9);
  });
});
