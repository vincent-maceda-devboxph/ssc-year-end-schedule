import express, { Router } from 'express';
import { z } from 'zod';
import { generateMatchesSchema, lineupImportSchema, scheduleSettingsUpdateSchema } from '@bt/shared';
import os from 'node:os';
import QRCode from 'qrcode';
import { requireAdmin } from '../../middleware/auth.js';
import { Category, Entry, Player, Team, Tournament } from '../../models/index.js';
import type { Broadcaster } from '../../sockets/index.js';
import { badRequest, notFound, parse } from '../../utils/errors.js';
import { actorOf, audit } from '../audit.js';
import { categoryDto, entryDto, playerDto, teamDto } from '../dto.js';
import { generateMatches } from '../scheduling/match-generator.service.js';
import { buildReport, buildReportWorkbook } from '../reports/report.service.js';
import { buildScheduleWorkbook } from '../scheduling/export.service.js';
import { courtsWithStatus } from '../scheduling/move.service.js';
import * as schedule from '../scheduling/schedule.service.js';
import { getStandings } from '../standings/standings.service.js';
import { importLineup } from '../teams/lineup-import.js';
import { parseLineupFile } from '../teams/lineup-file.js';

/** Routes under /api/tournaments/:id/... (names from the scheduling spec §10). */
export function tournamentScopedRoutes(broadcaster: Broadcaster): Router {
  const r = Router({ mergeParams: true });
  const tid = (p: Record<string, unknown>) => String(p.id);

  r.use(async (req, _res, next) => {
    if (!(await Tournament.exists({ _id: tid(req.params) }))) return next(notFound('Tournament'));
    next();
  });

  // Read models used by the scheduler UI.
  r.get('/teams', async (req, res) => {
    res.json((await Team.find({ tournamentId: tid(req.params) }).sort({ name: 1 }).lean()).map(teamDto));
  });
  r.get('/categories', async (req, res) => {
    res.json((await Category.find({ tournamentId: tid(req.params) }).sort({ priority: 1, name: 1 }).lean()).map(categoryDto));
  });
  r.get('/courts', async (req, res) => {
    res.json(await courtsWithStatus(tid(req.params), !req.auth.admin));
  });
  r.get('/pairings', async (req, res) => {
    res.json((await Entry.find({ tournamentId: tid(req.params) }).sort({ displayName: 1 }).lean()).map(entryDto));
  });
  r.get('/players', requireAdmin(), async (req, res) => {
    res.json((await Player.find({ tournamentId: tid(req.params) }).sort({ firstName: 1 }).lean()).map(playerDto));
  });

  /** Read a CSV or Excel file into lineup rows (body = the raw file, X-Filename = its name). Writes nothing. */
  r.post('/lineup/parse-file', requireAdmin(), express.raw({ type: () => true, limit: '5mb' }), async (req, res) => {
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || !body.length) throw badRequest('No file received');
    const name = decodeURIComponent(String(req.get('x-filename') ?? ''));
    res.json(await parseLineupFile(body, name));
  });

  r.post('/lineup/import', requireAdmin(), async (req, res) => {
    const body = parse(lineupImportSchema, req.body);
    const result = await importLineup(tid(req.params), body.rows, body.dryRun);
    if (!result.dryRun && !result.errors.length) {
      await audit({ actor: actorOf(req), action: 'import_lineup', entity: 'tournament', entityId: tid(req.params), tournamentId: tid(req.params), after: result });
    }
    res.status(result.errors.length ? 422 : 200).json(result);
  });

  r.post('/matches/generate', requireAdmin(), async (req, res) => {
    const body = parse(generateMatchesSchema, req.body);
    res.json(await generateMatches(tid(req.params), body, actorOf(req), broadcaster));
  });

  // ---------- schedule (docs/scheduling-plan.md §5, §10) ----------
  const previewBody = z.object({
    settings: scheduleSettingsUpdateSchema.optional(),
    seed: z.number().int().min(0).max(2_147_483_647).optional(),
    /** Reschedule the rest of the day: nothing that can still move is placed before this time. */
    notBefore: z.iso.datetime().nullable().optional(),
    /** Levels to play first, as "categoryId:rank" (e.g. MD-E). */
    earlier: z.array(z.string().regex(/^[0-9a-f]{24}:\d{1,3}$/i)).max(60).optional(),
    /** The chosen levels may not start before this time. */
    earlierFrom: z.iso.datetime().nullable().optional(),
    /** The chosen levels must be finished by this time. */
    earlierUntil: z.iso.datetime().nullable().optional(),
  });

  r.get('/schedule', async (req, res) => {
    res.json(await schedule.currentSchedule(tid(req.params)));
  });
  /** Court-by-court Excel file of the current plan (admin only). */
  r.get('/schedule/export', requireAdmin(), async (req, res) => {
    const { buffer, filename } = await buildScheduleWorkbook(tid(req.params));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  });
  r.get('/schedule/settings', requireAdmin(), async (req, res) => {
    res.json(await schedule.loadSettings(tid(req.params)));
  });
  r.put('/schedule/settings', requireAdmin(), async (req, res) => {
    const patch = parse(scheduleSettingsUpdateSchema, req.body);
    const s = await schedule.saveSettings(tid(req.params), patch);
    await audit({ actor: actorOf(req), action: 'update_schedule_settings', entity: 'tournament', entityId: tid(req.params), tournamentId: tid(req.params), after: patch });
    res.json(s);
  });

  /** Compute a schedule without saving anything. "regenerate" is the same call: it keeps published cells where still valid. */
  const previewHandler = async (req: import('express').Request, res: import('express').Response) => {
    const body = parse(previewBody, req.body ?? {});
    res.json(await schedule.preview(tid(req.params), { ...(body.settings ?? {}), ...(body.seed !== undefined ? { seed: body.seed } : {}) }, { notBefore: body.notBefore ?? null, earlier: body.earlier ?? [], earlierFrom: body.earlierFrom ?? null, earlierUntil: body.earlierUntil ?? null }));
  };
  r.post('/schedules/preview', requireAdmin(), previewHandler);
  r.post('/schedules/regenerate', requireAdmin(), previewHandler);

  r.get('/schedules/conflicts', requireAdmin(), async (req, res) => {
    res.json(await schedule.currentConflicts(tid(req.params)));
  });
  r.get('/schedules', requireAdmin(), async (req, res) => {
    res.json(await schedule.listVersions(tid(req.params)));
  });
  r.post('/schedules', requireAdmin(), async (req, res) => {
    const body = parse(previewBody.extend({ label: z.string().trim().max(80).optional().default('') }), req.body ?? {});
    const overrides = { ...(body.settings ?? {}), ...(body.seed !== undefined ? { seed: body.seed } : {}) };
    res.status(201).json(await schedule.saveDraft(tid(req.params), body.label, overrides, actorOf(req), body.notBefore ?? null, body.earlier ?? [], body.earlierFrom ?? null, body.earlierUntil ?? null));
  });
  r.get('/schedules/:versionId', requireAdmin(), async (req, res) => {
    res.json(await schedule.getVersion(tid(req.params), String(req.params.versionId)));
  });
  r.post('/schedules/publish', requireAdmin(), async (req, res) => {
    const body = parse(z.object({ versionId: z.string().regex(/^[a-f0-9]{24}$/i) }), req.body);
    res.json(await schedule.publish(tid(req.params), body.versionId, actorOf(req), broadcaster));
  });

  /** Summary of the event: totals, standings, every result, pair records, umpires, corrections. */
  r.get('/report', requireAdmin(), async (req, res) => {
    res.json(await buildReport(tid(req.params)));
  });
  r.get('/report/export', requireAdmin(), async (req, res) => {
    const { buffer, filename } = await buildReportWorkbook(tid(req.params));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  });

  // Standings are for the organisers only; spectators see scores and results.
  r.get('/standings', requireAdmin(), async (req, res) => {
    res.json(await getStandings(tid(req.params)));
  });

  /**
   * Public QR code (PNG data URL) that opens this tournament's live scores. The address uses the host the
   * request came in on; when that is "localhost" (the TV is the laptop itself) the laptop's Wi-Fi address is
   * used instead, because a phone cannot reach "localhost".
   */
  r.get('/live-qr', async (req, res) => {
    const id = tid(req.params);
    let host = req.get('x-forwarded-host') ?? req.get('host') ?? '';
    const [name, port] = host.split(':');
    if (!name || /^(localhost|127\.0\.0\.1|\[::1\])$/.test(name)) {
      const lan = Object.values(os.networkInterfaces())
        .flat()
        .find((i) => i && i.family === 'IPv4' && !i.internal);
      if (lan) host = `${lan.address}${port ? ':' + port : ''}`;
    }
    const proto = (req.get('x-forwarded-proto') ?? req.protocol).split(',')[0]!.trim();
    const url = `${proto}://${host}/live/${id}`;
    res.json({ url, png: await QRCode.toDataURL(url, { margin: 1, width: 480, errorCorrectionLevel: 'M' }) });
  });

  return r;
}
