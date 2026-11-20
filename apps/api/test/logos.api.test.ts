import http from 'node:http';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MatchDto, TeamDto } from '@bt/shared';
import { createApp } from '../src/app.js';
import { connectDb, ensureSuperAdmin, loadJwtSecret } from '../src/db.js';
import { AuthService } from '../src/modules/auth/auth.service.js';
import { createSocketServer } from '../src/sockets/index.js';

const MONGO = process.env.TEST_MONGO_URI_LOGOS ?? 'mongodb://127.0.0.1:27017/badminton_test_logos';
const ADMIN_PASSWORD = 'test-admin-password';
// 1x1 transparent PNG.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

let server: http.Server;
let admin: ReturnType<typeof request.agent>;
const api = (p: string) => `/api${p}`;

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

describe('team logos', () => {
  let tid: string;
  let team: TeamDto;

  beforeAll(async () => {
    tid = (await admin.post(api('/tournaments')).send({ name: 'Logo Cup', status: 'active' })).body.id;
    team = (await admin.post(api('/teams')).send({ tournamentId: tid, name: 'Red' })).body;
  });

  it('a team starts without a logo', async () => {
    expect(team.logoUrl).toBeNull();
    expect((await request(server).get(api(`/teams/${team.id}/logo`))).status).toBe(404);
  });

  it('an admin uploads a logo; anyone can fetch the image, and the team and its matches point at it', async () => {
    const up = await admin.put(api(`/teams/${team.id}/logo`)).send({ dataUrl: PNG });
    expect(up.status).toBe(200);
    expect(up.body.logoUrl).toMatch(new RegExp(`^/api/teams/${team.id}/logo\\?v=\\d+$`));

    const img = await request(server).get(up.body.logoUrl.replace('/api', '/api'));
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(img.headers['cache-control']).toMatch(/immutable/);
    expect(Buffer.from(img.body).length).toBeGreaterThan(20);

    // The logo travels with team lists and standings, but never as a data blob.
    const list = (await request(server).get(api(`/teams?tournamentId=${tid}`))).body as TeamDto[];
    expect(list[0]!.logoUrl).toBe(up.body.logoUrl);
    expect(JSON.stringify(list)).not.toContain('base64');
    const standings = (await request(server).get(api(`/tournaments/${tid}/standings`))).body;
    expect(standings.teams[0].logoUrl).toBe(up.body.logoUrl);
  });

  it('shows the logo on a match between two teams', async () => {
    const blue = (await admin.post(api('/teams')).send({ tournamentId: tid, name: 'Blue' })).body as TeamDto;
    await admin.post(api('/courts')).send({ tournamentId: tid, name: 'C1' });
    await admin.post(api('/tournaments/' + tid + '/lineup/import')).send({
      rows: [
        { team: 'Red', category: "Men's Doubles", player1: 'A1', player2: 'A2' },
        { team: 'Blue', category: "Men's Doubles", player1: 'B1', player2: 'B2' },
      ],
    });
    await admin.post(api(`/tournaments/${tid}/matches/generate`)).send({});
    const ms = (await admin.get(api(`/matches?tournamentId=${tid}`))).body as MatchDto[];
    const refs = [ms[0]!.teamA, ms[0]!.teamB];
    expect(refs.find((t) => t!.name === 'Red')!.logoUrl).toMatch(/^\/api\/teams\//);
    expect(refs.find((t) => t!.name === blue.name)!.logoUrl).toBeNull();
  });

  it('rejects anything that is not a small image, and non-admins', async () => {
    expect((await admin.put(api(`/teams/${team.id}/logo`)).send({ dataUrl: "data:text/html;base64,PGI+" })).status).toBe(400);
    expect((await admin.put(api(`/teams/${team.id}/logo`)).send({ dataUrl: "javascript:alert(1)" })).status).toBe(400);
    expect((await admin.put(api(`/teams/${team.id}/logo`)).send({ dataUrl: 'data:image/png;base64,' + 'A'.repeat(160_000) })).status).toBeGreaterThanOrEqual(400);
    expect((await request(server).put(api(`/teams/${team.id}/logo`)).send({ dataUrl: PNG })).status).toBe(401);
  });

  it('removing the logo clears it', async () => {
    const r = await admin.delete(api(`/teams/${team.id}/logo`));
    expect(r.status).toBe(200);
    expect(r.body.logoUrl).toBeNull();
    expect((await request(server).get(api(`/teams/${team.id}/logo`))).status).toBe(404);
  });
});
