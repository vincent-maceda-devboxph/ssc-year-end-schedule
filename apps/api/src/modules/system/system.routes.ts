import fs from 'node:fs/promises';
import { Router } from 'express';
import QRCode from 'qrcode';
import { z } from 'zod';
import { config } from '../../config.js';
import { dbHealthy } from '../../db.js';
import { requireAdmin } from '../../middleware/auth.js';
import { AuditLog, Tournament } from '../../models/index.js';
import type { Broadcaster } from '../../sockets/index.js';
import { badRequest, notFound, parse } from '../../utils/errors.js';
import { lanUrls } from '../../utils/network.js';
import { actorOf, audit } from '../audit.js';
import { autoBackupNow, backupPath, backupStatus, createBackup, listBackups, restoreBackup } from './backup.service.js';
import { checkIntegrity } from './integrity.service.js';

const objectId = z.string().regex(/^[a-f0-9]{24}$/i);

/** /api/system: backups, restore, integrity check, status. */
export function systemRoutes(broadcaster: Broadcaster): Router {
  const r = Router();

  r.get('/status', requireAdmin(), async (_req, res) => {
    res.json({
      db: dbHealthy() ? 'up' : 'down',
      urls: lanUrls(config.port),
      version: process.env.npm_package_version ?? '0.1.0',
      backup: backupStatus(),
      https: !!config.httpsKey,
    });
  });

  r.get('/backups', requireAdmin(), async (_req, res) => {
    res.json(await listBackups());
  });

  r.post('/backups', requireAdmin(), async (req, res) => {
    const { label } = parse(z.object({ label: z.string().trim().max(40).optional().default('') }), req.body ?? {});
    const info = await createBackup('manual', label);
    await audit({ actor: actorOf(req), action: 'backup', entity: 'system', entityId: new (await import('mongoose')).default.Types.ObjectId(), after: { file: info.file, bytes: info.bytes } });
    res.status(201).json(info);
  });

  /** Run the automatic backup now (skipped when nothing changed since the last one). */
  r.post('/backups/auto', requireAdmin(), async (_req, res) => {
    res.json({ created: await autoBackupNow() });
  });

  // Downloading or restoring exposes/replaces everything (including password hashes): super admins only.
  r.get('/backups/:file/download', requireAdmin('super_admin'), async (req, res) => {
    const file = backupPath(String(req.params.file));
    await fs.stat(file).catch(() => {
      throw notFound('Backup file');
    });
    res.download(file);
  });

  r.post('/backups/:file/restore', requireAdmin('super_admin'), async (req, res) => {
    const body = parse(z.object({ confirm: z.literal('RESTORE', { error: 'Type RESTORE to confirm' }), force: z.boolean().optional().default(false) }), req.body);
    const result = await restoreBackup(String(req.params.file), { force: body.force });
    await audit({
      actor: actorOf(req),
      action: 'restore',
      entity: 'system',
      entityId: new (await import('mongoose')).default.Types.ObjectId(),
      after: { file: result.restoredFrom, safetyBackup: result.safetyBackup },
    });
    for (const id of result.tournamentIds) broadcaster.tournament(id, 'schedule:updated', { tournamentId: id });
    res.json(result);
  });

  r.get('/integrity', requireAdmin(), async (req, res) => {
    const tournamentId = typeof req.query.tournamentId === 'string' ? req.query.tournamentId : undefined;
    if (tournamentId && !objectId.safeParse(tournamentId).success) throw badRequest('Invalid tournamentId');
    const issues = await checkIntegrity(tournamentId);
    res.json({ ok: !issues.some((i) => i.severity === 'error'), checkedAt: new Date().toISOString(), tournaments: tournamentId ? 1 : await Tournament.countDocuments(), issues });
  });

  /** SVG QR code for an address (admin screens show it so phones can join). */
  r.get('/qr', requireAdmin(), async (req, res) => {
    const url = typeof req.query.url === 'string' ? req.query.url : '';
    if (!/^https?:\/\/[\w.-]+(:\d+)?(\/[\w\-./?=&%]*)?$/.test(url)) throw badRequest('Invalid address');
    res.type('image/svg+xml').send(await QRCode.toString(url, { type: 'svg', margin: 1 }));
  });

  return r;
}

/** GET /api/audit: who changed what, newest first. */
export function auditRoutes(): Router {
  const r = Router();
  r.get('/', requireAdmin(), async (req, res) => {
    const q = parse(
      z.object({
        tournamentId: objectId.optional(),
        entity: z.string().max(40).optional(),
        action: z.string().max(40).optional(),
        limit: z.coerce.number().int().min(1).max(500).optional().default(100),
        before: z.iso.datetime().optional(),
      }),
      req.query,
    );
    const filter: Record<string, unknown> = {};
    if (q.tournamentId) filter.tournamentId = q.tournamentId;
    if (q.entity) filter.entity = q.entity;
    if (q.action) filter.action = q.action;
    if (q.before) filter.createdAt = { $lt: new Date(q.before) };
    const list = await AuditLog.find(filter).sort({ createdAt: -1, _id: -1 }).limit(q.limit).lean();
    res.json(
      list.map((a) => ({
        id: String(a._id),
        at: (a as { createdAt?: Date }).createdAt?.toISOString() ?? null,
        actor: a.actor ? { kind: a.actor.kind, name: a.actor.name } : null,
        action: a.action,
        entity: a.entity,
        entityId: String(a.entityId),
        reason: a.reason ?? '',
        before: a.before ?? null,
        after: a.after ?? null,
      })),
    );
  });
  return r;
}
