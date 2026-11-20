import crypto from 'node:crypto';
import http from 'node:http';
import ExcelJS from 'exceljs';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MatchDto, SchedulePreview, ScheduleVersionDto } from '@bt/shared';
import { createApp } from '../src/app.js';
import { connectDb, ensureSuperAdmin, loadJwtSecret } from '../src/db.js';
import { AuthService } from '../src/modules/auth/auth.service.js';
import { createSocketServer } from '../src/sockets/index.js';

// Own database: vitest runs test files in parallel.
const MONGO = process.env.TEST_MONGO_URI_RESCHED ?? 'mongodb://127.0.0.1:27017/badminton_test_resched';
const ADMIN_PASSWORD = 'test-admin-password';
const START = '2026-11-29T07:00:00.000Z'; // 3:00 PM in Manila
const slotTime = (slot: number) => new Date(Date.parse(START) + slot * 30 * 60_000).toISOString();
const slotOf = (iso: string) => (Date.parse(iso) - Date.parse(START)) / (30 * 60_000);

let server: http.Server;
let admin: ReturnType<typeof request.agent>;
let tid: string;

const TEAMS = ['Hulk Smashers', 'Avengers Netters', 'Iron Shuttlers'];
const DIVISIONS = [...Array.from({ length: 10 }, () => 'MD'), 'WD', 'WD', 'WD'];
const rows = TEAMS.flatMap((team, t) => DIVISIONS.map((category, c) => ({ team, category, player1: `P${t}-${c}-1`, player2: `P${t}-${c}-2` })));

const base = () => `/api/tournaments/${tid}`;
const preview = (body: object = {}) => admin.post(`${base()}/schedules/preview`).send(body);
const matches = async (): Promise<MatchDto[]> => (await admin.get(`/api/matches?tournamentId=${tid}`)).body;
const cmd = (m: { id: string; version: number }, route: string, extra: object = {}) =>
  admin.post(`/api/matches/${m.id}/${route}`).send({ actionId: crypto.randomUUID(), expectedVersion: m.version, ...extra });

const binary = (res: http.IncomingMessage, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

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
  tid = (await admin.post('/api/tournaments').send({ name: 'Team Cup 2026', status: 'active' })).body.id;
  expect((await admin.post(`${base()}/lineup/import`).send({ rows })).status).toBe(200);
  for (let i = 1; i <= 4; i++) await admin.post('/api/courts').send({ tournamentId: tid, name: `Court ${i}` });
  expect((await admin.post(`${base()}/matches/generate`).send({})).body.created).toBe(39);
  await admin.put(`${base()}/schedule/settings`).send({ startAt: START, matchMinutes: 30, minRestSlots: 1, seed: 1 });
  const draft = await admin.post(`${base()}/schedules`).send({ label: 'Plan A' });
  expect((await admin.post(`${base()}/schedules/publish`).send({ versionId: draft.body.id })).status).toBe(200);
});

afterAll(async () => {
  server?.close();
  await mongoose.disconnect();
});

describe('Excel export', () => {
  it('is for admins only', async () => {
    expect((await request(server).get(`${base()}/schedule/export`)).status).toBe(401);
  });

  it('produces a court-by-court workbook with team colours, plus a flat table of every match', async () => {
    const res = await admin.get(`${base()}/schedule/export`).buffer(true).parse(binary as never);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml.sheet');
    expect(res.headers['content-disposition']).toContain('schedule-team-cup-2026.xlsx');

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body as Buffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Schedule', 'All matches']);

    // Sheet 2: header + 39 matches, in game order.
    const all = wb.getWorksheet('All matches')!;
    expect(all.rowCount).toBe(40);
    expect((all.getRow(2).values as unknown[]).slice(1, 4)).toEqual([1, 'Court 1', '3:00PM']);
    const games = all.getColumn(1).values.slice(2) as number[];
    expect(games).toEqual([...games].sort((a, b) => a - b));
    expect(new Set(games).size).toBe(39);

    // Sheet 1: four court blocks, two per row.
    const sheet = wb.getWorksheet('Schedule')!;
    const found = new Map<string, { row: number; col: number }>();
    // A merged title reports its text in every column it spans: only the master (left-most) cell counts.
    sheet.eachRow((row, r) => row.eachCell((cell, c) => {
      if (cell.isMerged && cell.master !== cell) return;
      if (typeof cell.value === 'string' && /^Court \d$/.test(cell.value)) found.set(cell.value, { row: r, col: c });
    }));
    expect([...found.keys()].sort()).toEqual(['Court 1', 'Court 2', 'Court 3', 'Court 4']);
    expect(found.get('Court 1')!.row).toBe(found.get('Court 2')!.row); // side by side
    expect(found.get('Court 3')!.row).toBeGreaterThan(found.get('Court 1')!.row);
    expect(found.get('Court 2')!.col).toBeGreaterThan(found.get('Court 1')!.col);

    // Header row under "Court 1", then the first match: time range, game number, bracket, teams and pairs.
    const c1 = found.get('Court 1')!;
    expect(sheet.getRow(c1.row + 1).getCell(c1.col + 1).value).toBe('Game #');
    expect(sheet.getRow(c1.row + 2).getCell(c1.col).value).toBe('3:00PM - 3:30PM');
    expect(sheet.getRow(c1.row + 2).getCell(c1.col + 1).value).toBe(1);
    expect(String(sheet.getRow(c1.row + 2).getCell(c1.col + 2).value)).toMatch(/^[MW]D-[A-J]$/);

    // Team cells carry the team colour (6-digit ARGB), Hulk/Avengers/Iron all different.
    const fills = new Set<string>();
    sheet.eachRow((row) => row.eachCell((cell) => {
      const f = cell.fill as ExcelJS.FillPattern | undefined;
      if (f?.type === 'pattern' && f.fgColor?.argb) fills.add(f.fgColor.argb);
    }));
    expect(fills.size).toBe(3);

    // Every one of the 39 game numbers appears exactly once in the blocks.
    const gameCells: number[] = [];
    for (const { row, col } of found.values()) {
      for (let r = row + 2; r < row + 2 + 12; r++) {
        const v = sheet.getRow(r).getCell(col + 1).value;
        if (typeof v === 'number') gameCells.push(v);
      }
    }
    expect(gameCells.sort((a, b) => a - b)).toEqual(Array.from({ length: 39 }, (_, i) => i + 1).filter((g) => games.includes(g)));
  });
});

describe('rescheduling the rest of the day', () => {
  it('rejects a bad "not before" time', async () => {
    expect((await preview({ notBefore: 'soon' })).status).toBe(400);
  });

  it('after a delay nothing movable is placed before the cutoff, and everything moves later', async () => {
    const p = (await preview({ notBefore: slotTime(14) })).body as SchedulePreview;
    expect(p.notBefore).toBe(slotTime(14));
    expect(p.stats).toMatchObject({ scheduled: 39, fixed: 0 });
    expect(p.assignments.every((a) => a.slot >= 14)).toBe(true);
    expect(p.conflicts).toEqual([]);
    expect(p.changes).toHaveLength(39);
    expect(p.changes.every((c) => c.from.start !== null && c.to.start >= slotTime(14))).toBe(true);
    expect(p.stats.estimatedEnd).toBe(slotTime(24)); // 14 + 10 slots
  });

  it('a cutoff off the grid rounds up to the next slot', async () => {
    const p = (await preview({ notBefore: '2026-11-29T09:10:00.000Z' })).body as SchedulePreview; // 11:10 → slot 5 (11:30 starts at slot 5)
    expect(Math.min(...p.assignments.map((a) => a.slot))).toBe(5);
  });

  it('a cutoff in the past changes nothing', async () => {
    const p = (await preview({ notBefore: '2026-01-01T00:00:00.000Z' })).body as SchedulePreview;
    expect(p.changes).toEqual([]);
  });

  describe('with a match live and one finished', () => {
    let live: MatchDto;
    let done: MatchDto;
    let draft: ScheduleVersionDto;

    it('live and finished matches keep their cells; the rest start after the cutoff', async () => {
      let all = await matches();
      done = all.find((m) => m.gameNumber === 1)!;
      await cmd(done, 'start');
      all = await matches();
      done = all.find((m) => m.gameNumber === 1)!;
      expect((await cmd(done, 'retire', { side: 'A' })).status).toBe(200);
      live = (await matches()).find((m) => m.gameNumber === 2)!;
      expect((await cmd(live, 'start')).status).toBe(200);

      // The court that just finished its match offers the next one as "ready"; the court with a live match does not.
      const after1 = await matches();
      const nextOnCourt1 = after1.filter((m) => m.courtId === done.courtId && m.id !== done.id).sort((x, y) => x.plannedStart!.localeCompare(y.plannedStart!));
      expect(nextOnCourt1[0]).toMatchObject({ status: 'ready' });
      expect(nextOnCourt1.filter((m) => m.status === 'ready')).toHaveLength(1);
      expect(after1.filter((m) => m.courtId === live.courtId && m.status === 'ready')).toHaveLength(0);

      const p = (await preview({ notBefore: slotTime(6), seed: 5 })).body as SchedulePreview;
      expect(p.stats.fixed).toBe(2);
      expect(p.assignments.filter((a) => a.fixed).map((a) => a.gameNumber).sort()).toEqual([1, 2]);
      expect(p.assignments.filter((a) => !a.fixed).every((a) => a.slot >= 6)).toBe(true);
      expect(p.changes.some((c) => c.matchId === done.id || c.matchId === live.id)).toBe(false);
      expect(p.conflicts).toEqual([]);
      expect(p.stats.scheduled).toBe(37);
    });

    it('saving and publishing applies it, leaves the results alone, and supersedes the old plan', async () => {
      const saved = await admin.post(`${base()}/schedules`).send({ label: 'After the delay', notBefore: slotTime(6), seed: 5 });
      expect(saved.status).toBe(201);
      draft = saved.body;
      const pub = await admin.post(`${base()}/schedules/publish`).send({ versionId: draft.id });
      expect(pub.status).toBe(200);
      expect(pub.body.version).toMatchObject({ version: 2, status: 'published' });

      const after = await matches();
      const keptDone = after.find((m) => m.id === done.id)!;
      expect(keptDone).toMatchObject({ status: 'retired', gameNumber: 1, plannedStart: START });
      expect(after.find((m) => m.id === live.id)).toMatchObject({ status: 'in_progress', gameNumber: 2 });
      const movable = after.filter((m) => m.status === 'scheduled');
      expect(movable).toHaveLength(37);
      expect(movable.every((m) => slotOf(m.plannedStart!) >= 6)).toBe(true);

      const versions = (await admin.get(`${base()}/schedules`)).body as ScheduleVersionDto[];
      expect(versions.map((v) => v.status)).toEqual(['published', 'superseded']);
      expect((await admin.get(`${base()}/schedules/conflicts`)).body).toEqual([]);
    });
  });

  describe('when a pair withdraws', () => {
    it('their matches are reported and taken off the schedule on publish', async () => {
      const all = await matches();
      const target = all.find((m) => m.status === 'scheduled' && m.bracket === 'MD-D')!;
      const withdrawing = target.entryA.id;
      const theirs = all.filter((m) => m.entryA.id === withdrawing || m.entryB.id === withdrawing);
      expect(theirs.length).toBeGreaterThanOrEqual(2);
      expect((await admin.put(`/api/entries/${withdrawing}`).send({ status: 'withdrawn' })).status).toBe(200);

      const p = (await preview({})).body as SchedulePreview;
      const dropped = p.unscheduled.filter((u) => theirs.some((m) => m.id === u.matchId));
      expect(dropped).toHaveLength(theirs.length);
      expect(dropped.every((u) => u.reason === 'A pair or team has withdrawn')).toBe(true);
      expect(p.conflicts).toEqual([]);

      const saved = await admin.post(`${base()}/schedules`).send({ label: 'Pair withdrew' });
      expect((await admin.post(`${base()}/schedules/publish`).send({ versionId: saved.body.id })).status).toBe(200);
      const after = await matches();
      for (const m of theirs) {
        const now = after.find((x) => x.id === m.id)!;
        expect(now).toMatchObject({ status: 'pending', courtId: null, plannedStart: null, gameNumber: null });
      }
    });
  });

  describe('when a court closes', () => {
    it('regenerating moves its matches to the other courts', async () => {
      const courts = (await admin.get(`${base()}/courts`)).body as { id: string; name: string }[];
      const court4 = courts.find((c) => c.name === 'Court 4')!;
      const onCourt4 = (await matches()).filter((m) => m.courtId === court4.id && m.status === 'scheduled');
      expect(onCourt4.length).toBeGreaterThan(0);

      expect((await admin.patch(`/api/courts/${court4.id}/status`).send({ status: 'unavailable' })).status).toBe(200);
      const p = (await preview({})).body as SchedulePreview;
      expect(p.courts.map((c) => c.id)).not.toContain(court4.id);
      expect(p.assignments.every((a) => a.courtId !== court4.id)).toBe(true);
      expect(onCourt4.every((m) => p.changes.some((c) => c.matchId === m.id))).toBe(true);
      expect(p.conflicts).toEqual([]);
      await admin.patch(`/api/courts/${court4.id}/status`).send({ status: 'available' });
    });
  });
});

describe('court opening hours and division priority', () => {
  it('a court is not used before it opens or after it closes', async () => {
    const courts = (await admin.get(`${base()}/courts`)).body as { id: string; name: string }[];
    const court3 = courts.find((c) => c.name === 'Court 3')!;

    const opened = await admin.put(`/api/courts/${court3.id}`).send({ availableFrom: slotTime(6) });
    expect(opened.status).toBe(200);
    expect(opened.body.availableFrom).toBe(slotTime(6));
    let p = (await preview({ seed: 9 })).body as SchedulePreview;
    expect(p.assignments.filter((a) => !a.fixed && a.courtId === court3.id).every((a) => a.slot >= 6)).toBe(true);
    expect(p.conflicts).toEqual([]);

    await admin.put(`/api/courts/${court3.id}`).send({ availableFrom: null, availableUntil: slotTime(3) });
    p = (await preview({ seed: 9 })).body as SchedulePreview;
    expect(p.assignments.filter((a) => !a.fixed && a.courtId === court3.id).every((a) => a.slot < 3)).toBe(true);

    expect((await admin.put(`/api/courts/${court3.id}`).send({ availableFrom: 'tomorrow' })).status).toBe(400);
    const cleared = await admin.put(`/api/courts/${court3.id}`).send({ availableFrom: null, availableUntil: null });
    expect(cleared.body).toMatchObject({ availableFrom: null, availableUntil: null });
  });

  it('a division with a lower priority number is scheduled earlier when the plan is rebuilt', async () => {
    // Matches already in the published plan keep their slot unless they must move, so rebuild from a later time.
    const rebuild = { seed: 3, notBefore: slotTime(40) };
    const cats = (await admin.get(`${base()}/categories`)).body as { id: string; code: string; priority: number }[];
    const wd = cats.find((c) => c.code === 'WD')!;
    const all = await matches();
    const isWd = new Set(all.filter((m) => m.bracket.startsWith('WD')).map((m) => m.id));
    const meanSlot = (p: SchedulePreview, wanted: boolean) => {
      const slots = p.assignments.filter((a) => !a.fixed && isWd.has(a.matchId) === wanted).map((a) => a.slot);
      return slots.reduce((x, y) => x + y, 0) / slots.length;
    };

    const flat = (await preview(rebuild)).body as SchedulePreview;
    expect((await admin.put(`/api/categories/${wd.id}`).send({ priority: 1 })).status).toBe(200);
    const urgent = (await preview(rebuild)).body as SchedulePreview;
    expect(meanSlot(urgent, true)).toBeLessThan(meanSlot(urgent, false));
    expect(meanSlot(urgent, true)).toBeLessThan(meanSlot(flat, true)); // moved earlier than with equal priority
    expect(urgent.conflicts).toEqual([]);
    await admin.put(`/api/categories/${wd.id}`).send({ priority: 100 });
  });
});
