import http from 'node:http';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AdminUserDto } from '@bt/shared';
import { createApp } from '../src/app.js';
import { connectDb, ensureSuperAdmin, loadJwtSecret } from '../src/db.js';
import { AuditLog, User } from '../src/models/index.js';
import { AuthService, resetLimiters } from '../src/modules/auth/auth.service.js';
import { createSocketServer } from '../src/sockets/index.js';

// Own database: vitest runs test files in parallel.
const MONGO = process.env.TEST_MONGO_URI_USERS ?? 'mongodb://127.0.0.1:27017/badminton_test_users';
const ADMIN_PASSWORD = 'test-admin-password';

let server: http.Server;
let boss: ReturnType<typeof request.agent>;
const login = async (username: string, password: string) => {
  const a = request.agent(server);
  const r = await a.post('/api/auth/login').send({ username, password });
  return { agent: a, status: r.status };
};
const me = async (a: ReturnType<typeof request.agent>) => (await a.get('/api/auth/me')).body.admin as { username: string; role: string } | null;
const users = async () => (await boss.get('/api/users')).body as AdminUserDto[];

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
  boss = (await login('admin', ADMIN_PASSWORD)).agent;
});

afterAll(async () => {
  server?.close();
  await mongoose.disconnect();
});

describe('creating accounts', () => {
  it('only super administrators can see or manage accounts', async () => {
    expect((await request(server).get('/api/users')).status).toBe(401);
    expect((await boss.post('/api/users').send({ username: 'helper', password: 'helper-pass-1', role: 'tournament_admin' })).status).toBe(201);
    const helper = (await login('helper', 'helper-pass-1')).agent;
    expect((await helper.get('/api/users')).status).toBe(403);
    expect((await helper.post('/api/users').send({ username: 'sneaky', password: 'sneaky-pass-1' })).status).toBe(403);
  });

  it('validates the username and password, lowercases, and refuses duplicates', async () => {
    expect((await boss.post('/api/users').send({ username: 'ab', password: 'long-enough-1' })).status).toBe(400);
    expect((await boss.post('/api/users').send({ username: 'has space', password: 'long-enough-1' })).status).toBe(400);
    expect((await boss.post('/api/users').send({ username: 'okname', password: 'short' })).status).toBe(400);
    const ok = await boss.post('/api/users').send({ username: 'Maria.Cruz', password: 'maria-pass-1' });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ username: 'maria.cruz', role: 'tournament_admin', active: true });
    expect((await boss.post('/api/users').send({ username: 'MARIA.CRUZ', password: 'another-pass-1' })).status).toBe(409);
    expect(JSON.stringify(ok.body)).not.toMatch(/passwordHash|maria-pass/);
  });

  it('the new account can sign in, with a hashed password', async () => {
    expect((await login('maria.cruz', 'maria-pass-1')).status).toBe(200);
    expect((await login('maria.cruz', 'wrong-password')).status).toBe(401);
    resetLimiters();
    const stored = await User.findOne({ username: 'maria.cruz' }).lean();
    expect(stored!.passwordHash).toMatch(/^\$2[aby]\$/);
  });
});

describe('changing accounts', () => {
  it('a password reset signs that person out everywhere', async () => {
    const { agent } = await login('helper', 'helper-pass-1');
    expect((await me(agent))?.username).toBe('helper');
    const id = (await users()).find((u) => u.username === 'helper')!.id;
    expect((await boss.put(`/api/users/${id}`).send({ password: 'brand-new-pass-1' })).status).toBe(200);
    expect(await me(agent)).toBeNull(); // old session is dead
    expect((await login('helper', 'helper-pass-1')).status).toBe(401);
    expect((await login('helper', 'brand-new-pass-1')).status).toBe(200);
  });

  it('switching an account off ends its session; switching it back on works again', async () => {
    const { agent } = await login('maria.cruz', 'maria-pass-1');
    const id = (await users()).find((u) => u.username === 'maria.cruz')!.id;
    expect((await boss.put(`/api/users/${id}`).send({ active: false })).status).toBe(200);
    expect(await me(agent)).toBeNull();
    expect((await login('maria.cruz', 'maria-pass-1')).status).toBe(401);
    expect((await boss.put(`/api/users/${id}`).send({ active: true })).status).toBe(200);
    expect((await login('maria.cruz', 'maria-pass-1')).status).toBe(200);
  });

  it('a role change takes effect straight away', async () => {
    const { agent } = await login('maria.cruz', 'maria-pass-1');
    expect((await agent.get('/api/users')).status).toBe(403);
    const id = (await users()).find((u) => u.username === 'maria.cruz')!.id;
    await boss.put(`/api/users/${id}`).send({ role: 'super_admin' });
    const again = await login('maria.cruz', 'maria-pass-1'); // the role change ends old sessions
    expect((await again.agent.get('/api/users')).status).toBe(200);
  });

  it('there is always at least one super administrator, and you cannot switch yourself off', async () => {
    const list = await users();
    const admin = list.find((u) => u.username === 'admin')!;
    const maria = list.find((u) => u.username === 'maria.cruz')!;
    // maria is a second super admin now, so "admin" may be demoted... but not himself switched off.
    const self = await boss.put(`/api/users/${admin.id}`).send({ active: false });
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('self_deactivate');

    // Make maria the only super admin, then try to demote her.
    expect((await boss.put(`/api/users/${admin.id}`).send({ role: 'tournament_admin' })).status).toBe(200);
    const mariaAgent = (await login('maria.cruz', 'maria-pass-1')).agent;
    const last = await mariaAgent.put(`/api/users/${maria.id}`).send({ role: 'tournament_admin' });
    expect(last.status).toBe(422);
    expect(last.body.error.code).toBe('last_super_admin');
    const off = await mariaAgent.put(`/api/users/${maria.id}`).send({ active: false });
    expect([403, 422]).toContain(off.status);
    // restore admin
    expect((await mariaAgent.put(`/api/users/${admin.id}`).send({ role: 'super_admin' })).status).toBe(200);
  });
});

describe('changing your own password', () => {
  it('needs the current password, and keeps you signed in on this browser only', async () => {
    const a = (await login('helper', 'brand-new-pass-1')).agent;
    const other = (await login('helper', 'brand-new-pass-1')).agent;
    expect((await a.post('/api/auth/password').send({ current: 'wrong', next: 'newer-pass-123' })).status).toBe(401);
    expect((await a.post('/api/auth/password').send({ current: 'brand-new-pass-1', next: 'short' })).status).toBe(400);
    expect((await a.post('/api/auth/password').send({ current: 'brand-new-pass-1', next: 'newer-pass-123' })).status).toBe(204);
    expect((await me(a))?.username).toBe('helper'); // still signed in here
    expect(await me(other)).toBeNull(); // the other session ended
    expect((await login('helper', 'newer-pass-123')).status).toBe(200);
    expect((await request(server).post('/api/auth/password').send({ current: 'x', next: 'yyyyyyyyy' })).status).toBe(401);
  });
});

describe('audit trail', () => {
  it('records account changes without any password', async () => {
    const log = await AuditLog.find({ entity: 'user' }).lean();
    expect(log.map((l) => l.action)).toEqual(expect.arrayContaining(['create', 'reset_password', 'update']));
    expect(JSON.stringify(log)).not.toContain('passwordHash');
    expect(JSON.stringify(log)).not.toContain('$2');
  });
});
