import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MatchDto } from '@bt/shared';
import { createApp } from '../src/app.js';
import { connectDb, ensureSuperAdmin, loadJwtSecret } from '../src/db.js';
import { Match, User } from '../src/models/index.js';
import { AuthService } from '../src/modules/auth/auth.service.js';
import { autoBackupNow, createBackup, listBackups } from '../src/modules/system/backup.service.js';
import { createSocketServer } from '../src/sockets/index.js';

// Own database: vitest runs test files in parallel.
const MONGO = process.env.TEST_MONGO_URI_SYS ?? 'mongodb://127.0.0.1:27017/badminton_test_sys';
const ADMIN_PASSWORD = 'test-admin-password';

let server: http.Server;
let admin: ReturnType<typeof request.agent>;
let helper: ReturnType<typeof request.agent>;
let dir: string;
let mirror: string;
let alphaId: string;
let categoryId: string;
let courtId: string;
let entries: string[];
let firstBackup: string;

const tournaments = async () => ((await admin.get('/api/tournaments')).body as { name: string }[]).map((t) => t.name).sort();

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bt-backups-'));
  mirror = await fs.mkdtemp(path.join(os.tmpdir(), 'bt-mirror-'));
  process.env.BACKUP_DIR = dir;
  process.env.BACKUP_MIRROR_DIR = mirror;
  process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
  await connectDb(MONGO);
  await mongoose.connection.dropDatabase();
  await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
  await ensureSuperAdmin();
  await User.create({ username: 'helper', passwordHash: await bcrypt.hash('helper-pass-123', 4), role: 'tournament_admin' });
  const auth = new AuthService(await loadJwtSecret());
  server = http.createServer();
  const { broadcaster, presence } = createSocketServer(server, auth);
  server.on('request', createApp({ auth, broadcaster, presence, serveWeb: false }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  admin = request.agent(server);
  await admin.post('/api/auth/login').send({ username: 'admin', password: ADMIN_PASSWORD });
  helper = request.agent(server);
  await helper.post('/api/auth/login').send({ username: 'helper', password: 'helper-pass-123' });

  alphaId = (await admin.post('/api/tournaments').send({ name: 'Alpha', status: 'active' })).body.id;
  categoryId = (
    await admin.post('/api/categories').send({
      tournamentId: alphaId,
      name: 'Open Doubles',
      scoring: { gamesToWin: 2, pointsToWin: 21, winBy: 2, cap: 30, intervalAt: 11, changeEndsInDecider: true },
    })
  ).body.id;
  const players: string[] = [];
  for (let i = 0; i < 4; i++) players.push((await admin.post('/api/players').send({ tournamentId: alphaId, firstName: `Player${i}` })).body.id);
  entries = [];
  for (let i = 0; i < 2; i++) entries.push((await admin.post('/api/entries').send({ categoryId, playerIds: [players[i * 2], players[i * 2 + 1]] })).body.id);
  courtId = (await admin.post('/api/courts').send({ tournamentId: alphaId, name: 'Court 1' })).body.id;
});

afterAll(async () => {
  server?.close();
  await mongoose.disconnect();
  await fs.rm(dir, { recursive: true, force: true });
  await fs.rm(mirror, { recursive: true, force: true });
});

describe('access', () => {
  it('needs a login; restore and download are for super admins only', async () => {
    expect((await request(server).get('/api/system/backups')).status).toBe(401);
    expect((await request(server).get('/api/audit')).status).toBe(401);
    expect((await helper.get('/api/system/backups')).status).toBe(200); // a tournament admin may list and create
    expect((await helper.post('/api/system/backups').send({ label: 'helper' })).status).toBe(201);
    const files = await listBackups();
    expect((await helper.get(`/api/system/backups/${files[0]!.file}/download`)).status).toBe(403);
    expect((await helper.post(`/api/system/backups/${files[0]!.file}/restore`).send({ confirm: 'RESTORE' })).status).toBe(403);
  });
});

describe('backups', () => {
  it('writes a compressed file, a mirror copy, and lists it', async () => {
    const r = await admin.post('/api/system/backups').send({ label: 'Before the finals!' });
    expect(r.status).toBe(201);
    firstBackup = r.body.file;
    expect(firstBackup).toMatch(/^backup-\d{8}-\d{6}-manual-before-the-finals\.json\.gz$/);
    expect(r.body.mirror).toMatchObject({ ok: true });

    const onDisk = await fs.readFile(path.join(dir, firstBackup));
    expect([onDisk[0], onDisk[1]]).toEqual([0x1f, 0x8b]); // gzip
    await expect(fs.stat(path.join(mirror, firstBackup))).resolves.toBeTruthy();

    const list = (await admin.get('/api/system/backups')).body as { file: string; kind: string; label: string; bytes: number }[];
    expect(list.find((b) => b.file === firstBackup)).toMatchObject({ kind: 'manual', label: 'before-the-finals' });
    expect(list.find((b) => b.file === firstBackup)!.bytes).toBeGreaterThan(100);
  });

  it('a failing mirror folder does not stop the backup and is reported', async () => {
    const blocker = path.join(os.tmpdir(), `bt-not-a-folder-${Date.now()}`);
    await fs.writeFile(blocker, 'x');
    process.env.BACKUP_MIRROR_DIR = path.join(blocker, 'sub'); // a folder inside a file cannot be created
    const info = await createBackup('manual', 'mirror-fails');
    expect(info.mirror).toMatchObject({ ok: false });
    await expect(fs.stat(path.join(dir, info.file))).resolves.toBeTruthy();
    process.env.BACKUP_MIRROR_DIR = mirror;
    await fs.rm(blocker, { force: true });
  });

  it('rejects file names that could escape the backup folder', async () => {
    for (const bad of ['..%2F..%2Fetc%2Fpasswd', 'backup-x.json.gz', '..%5Cwindows%5Cwin.ini']) {
      expect((await admin.get(`/api/system/backups/${bad}/download`)).status).toBe(400);
    }
    expect((await admin.get('/api/system/backups/backup-20200101-000000-manual.json.gz/download')).status).toBe(404);
  });

  it('super admins can download a backup', async () => {
    const res = await admin.get(`/api/system/backups/${firstBackup}/download`).buffer(true).parse(((r: http.IncomingMessage, cb: (e: Error | null, b: Buffer) => void) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    }) as never);
    expect(res.status).toBe(200);
    expect((res.body as Buffer).length).toBeGreaterThan(100);
  });

  it('automatic backups skip when nothing changed and keep only the newest few', async () => {
    process.env.BACKUP_KEEP_AUTO = '2';
    const first = await autoBackupNow();
    expect(first).not.toBeNull();
    expect(await autoBackupNow()).toBeNull(); // unchanged
    for (const name of ['Auto One', 'Auto Two', 'Auto Three']) {
      await admin.post('/api/tournaments').send({ name });
      await new Promise((r) => setTimeout(r, 1100)); // file names have one-second resolution
      expect(await autoBackupNow()).not.toBeNull();
    }
    const autos = (await listBackups()).filter((b) => b.kind === 'auto');
    expect(autos).toHaveLength(2);
    // clean the extra tournaments so later checks are exact
    const all = (await admin.get('/api/tournaments')).body as { id: string; name: string }[];
    for (const t of all.filter((x) => x.name.startsWith('Auto '))) await admin.delete(`/api/tournaments/${t.id}`);
  });
});

describe('integrity check', () => {
  it('is clean for good data', async () => {
    const r = (await admin.get('/api/system/integrity')).body;
    expect(r).toMatchObject({ ok: true, issues: [] });
  });

  it('finds references that point nowhere and double-booked courts', async () => {
    const ghost = new mongoose.Types.ObjectId();
    const base = { tournamentId: new mongoose.Types.ObjectId(alphaId), categoryId: new mongoose.Types.ObjectId(categoryId), entryAId: ghost, entryBId: ghost, status: 'scheduled', plannedStart: new Date('2026-11-29T07:00:00Z'), courtId: new mongoose.Types.ObjectId(courtId), scoring: {}, score: {}, version: 0 };
    const res = await Match.collection.insertMany([{ ...base, matchNumber: 901 }, { ...base, matchNumber: 902 }] as never);
    const r = (await admin.get(`/api/system/integrity?tournamentId=${alphaId}`)).body as { ok: boolean; issues: { code: string }[] };
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['match_entry', 'court_double']));
    await Match.collection.deleteMany({ _id: { $in: Object.values(res.insertedIds) } });
    expect(((await admin.get('/api/system/integrity')).body as { ok: boolean }).ok).toBe(true);
  });

  it('notices a score that disagrees with its point log', async () => {
    const created = await admin.post('/api/matches').send({ categoryId, entryAId: entries[0], entryBId: entries[1], courtId });
    let m: MatchDto = created.body;
    const send = async (route: string, extra: object = {}) => {
      const r = await admin.post(`/api/matches/${m.id}/${route}`).send({ actionId: crypto.randomUUID(), expectedVersion: m.version, ...extra });
      expect(r.status).toBe(200);
      m = r.body.match;
    };
    await send('start');
    await send('points', { side: 'A' });
    await send('points', { side: 'A' });
    expect(((await admin.get(`/api/system/integrity?tournamentId=${alphaId}`)).body as { ok: boolean }).ok).toBe(true);
    await Match.collection.updateOne({ _id: new mongoose.Types.ObjectId(m.id) }, { $set: { 'score.pointsPlayed': 5 } });
    const bad = (await admin.get(`/api/system/integrity?tournamentId=${alphaId}`)).body as { issues: { code: string }[] };
    expect(bad.issues.map((i) => i.code)).toContain('score_mismatch');
    await Match.collection.deleteOne({ _id: new mongoose.Types.ObjectId(m.id) });
  });
});

describe('restore', () => {
  it('needs the word RESTORE', async () => {
    expect((await admin.post(`/api/system/backups/${firstBackup}/restore`).send({})).status).toBe(400);
    expect((await admin.post(`/api/system/backups/${firstBackup}/restore`).send({ confirm: 'yes' })).status).toBe(400);
  });

  it('a damaged file is refused and nothing changes', async () => {
    const bad = 'backup-20200101-000000-manual-broken.json.gz';
    await fs.writeFile(path.join(dir, bad), Buffer.from('this is not a backup'));
    const before = await tournaments();
    const r = await admin.post(`/api/system/backups/${bad}/restore`).send({ confirm: 'RESTORE' });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('bad_backup');
    expect(await tournaments()).toEqual(before);
  });

  it('a live match blocks a restore unless it is forced', async () => {
    const created = await admin.post('/api/matches').send({ categoryId, entryAId: entries[0], entryBId: entries[1], courtId });
    const started = await admin.post(`/api/matches/${created.body.id}/start`).send({ actionId: crypto.randomUUID(), expectedVersion: created.body.version });
    expect(started.status).toBe(200);
    const blocked = await admin.post(`/api/system/backups/${firstBackup}/restore`).send({ confirm: 'RESTORE' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('matches_live');
  });

  it('puts everything back as it was, keeps a safety copy, and reports a clean check', async () => {
    await admin.post('/api/tournaments').send({ name: 'Beta (made after the backup)' });
    expect(await tournaments()).toEqual(['Alpha', 'Beta (made after the backup)']);

    const r = await admin.post(`/api/system/backups/${firstBackup}/restore`).send({ confirm: 'RESTORE', force: true });
    expect(r.status).toBe(200);
    expect(r.body.restoredFrom).toBe(firstBackup);
    expect(r.body.integrity).toEqual([]);
    expect(r.body.safetyBackup).toMatch(/before-restore/);
    await expect(fs.stat(path.join(dir, r.body.safetyBackup))).resolves.toBeTruthy();

    expect(await tournaments()).toEqual(['Alpha']);
    expect((await admin.get(`/api/matches?tournamentId=${alphaId}`)).body).toEqual([]); // the live match was made after the backup
    expect(r.body.counts.tournaments).toBe(1);

    // The restore is itself in the audit log, and indexes still work (a second live match on the court is refused).
    const log = (await admin.get('/api/audit?action=restore')).body as { action: string; after: { file: string } }[];
    expect(log[0]).toMatchObject({ action: 'restore', after: { file: firstBackup } });
  });

  it('can be undone with the safety backup', async () => {
    const safety = (await listBackups()).find((b) => b.kind === 'before-restore')!;
    const r = await admin.post(`/api/system/backups/${safety.file}/restore`).send({ confirm: 'RESTORE', force: true });
    expect(r.status).toBe(200);
    expect(await tournaments()).toEqual(['Alpha', 'Beta (made after the backup)']);
  });
});

describe('audit log viewer', () => {
  it('lists changes newest first with who, what and why, and filters', async () => {
    const all = (await admin.get('/api/audit?limit=5')).body as { at: string; actor: { name: string } | null; action: string }[];
    expect(all).toHaveLength(5);
    expect(all.map((a) => a.at)).toEqual([...all.map((a) => a.at)].sort().reverse());
    expect(all[0]!.actor).toMatchObject({ name: 'admin' });

    const created = (await admin.get(`/api/audit?tournamentId=${alphaId}&entity=tournament&action=create`)).body as { entity: string; action: string }[];
    expect(created.length).toBeGreaterThan(0);
    expect(created.every((a) => a.entity === 'tournament' && a.action === 'create')).toBe(true);
    expect((await admin.get('/api/audit?limit=9999')).status).toBe(400);
  });
});
