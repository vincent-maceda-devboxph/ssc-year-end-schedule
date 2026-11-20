import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Router } from 'express';
import QRCode from 'qrcode';
import { courtSchema, courtStatusUpdateSchema, courtUpdateSchema, LIVE_STATUSES } from '@bt/shared';
import { requireAdmin } from '../../middleware/auth.js';
import { Court, Match, Tournament } from '../../models/index.js';
import type { Broadcaster, Presence } from '../../sockets/index.js';
import { courtsWithStatus } from '../scheduling/move.service.js';
import { badRequest, conflict, notFound, parse } from '../../utils/errors.js';
import { actorOf, audit } from '../audit.js';
import { courtDto } from '../dto.js';

export function courtRoutes(presence: Presence, broadcaster: Broadcaster): Router {
  const r = Router();

  r.get('/', async (req, res) => {
    if (typeof req.query.tournamentId !== 'string') throw badRequest('tournamentId is required');
    const list = await courtsWithStatus(req.query.tournamentId, !req.auth.admin);
    res.json(
      list.map((c) => ({
        ...c,
        // Only admins see who is umpiring where.
        ...(req.auth.admin ? { umpire: presence.forCourt(c.id) } : {}),
      })),
    );
  });

  r.post('/', requireAdmin(), async (req, res) => {
    const body = parse(courtSchema, req.body);
    if (!(await Tournament.exists({ _id: body.tournamentId }))) throw notFound('Tournament');
    const order = body.order ?? (await Court.countDocuments({ tournamentId: body.tournamentId })) + 1;
    const c = await Court.create({ ...body, order });
    await audit({ actor: actorOf(req), action: 'create', entity: 'court', entityId: c._id, tournamentId: c.tournamentId, after: body });
    res.status(201).json(courtDto(c.toObject()));
  });

  r.put('/:id', requireAdmin(), async (req, res) => {
    const body = parse(courtUpdateSchema, req.body);
    const before = await Court.findById(req.params.id).lean();
    if (!before) throw notFound('Court');
    const c = await Court.findByIdAndUpdate(req.params.id, { $set: body }, { new: true }).lean();
    await audit({ actor: actorOf(req), action: 'update', entity: 'court', entityId: before._id, tournamentId: before.tournamentId, before: courtDto(before), after: body });
    res.json(courtDto(c!));
  });

  /** Open or close a court (PATCH /api/courts/:id/status). A court with a called or live match cannot be closed. */
  r.patch('/:id/status', requireAdmin(), async (req, res) => {
    const { status } = parse(courtStatusUpdateSchema, req.body);
    const c = await Court.findById(req.params.id).lean();
    if (!c) throw notFound('Court');
    const active = status === 'available';
    if (!active && (await Match.exists({ courtId: c._id, status: { $in: ['called', ...LIVE_STATUSES] } }))) {
      throw conflict('A match is on this court right now', 'court_busy');
    }
    await Court.updateOne({ _id: c._id }, { $set: { active } });
    await audit({ actor: actorOf(req), action: active ? 'open_court' : 'close_court', entity: 'court', entityId: c._id, tournamentId: c.tournamentId });
    broadcaster.tournament(String(c.tournamentId), 'court:updated', { tournamentId: String(c.tournamentId), courtId: String(c._id) });
    const all = await courtsWithStatus(String(c.tournamentId), false);
    res.json(all.find((x) => x.id === String(c._id)));
  });

  r.delete('/:id', requireAdmin(), async (req, res) => {
    const c = await Court.findById(req.params.id).lean();
    if (!c) throw notFound('Court');
    if (await Match.exists({ courtId: c._id })) throw conflict('Court has matches assigned. Deactivate it instead.', 'in_use');
    await Court.deleteOne({ _id: c._id });
    await audit({ actor: actorOf(req), action: 'delete', entity: 'court', entityId: c._id, tournamentId: c.tournamentId, before: courtDto(c) });
    res.status(204).end();
  });

  /**
   * Generate a new 6-digit umpire code. The plaintext is returned once and never stored.
   * Regenerating ends every existing umpire session on this court (decisions D2).
   */
  r.post('/:id/code', requireAdmin(), async (req, res) => {
    // The code alone identifies the court at sign-in, so it must not match any other court's code.
    const others = await Court.find({ _id: { $ne: req.params.id }, active: true, codeHash: { $nin: [null, ''] } }).select('codeHash').lean();
    let code = '';
    for (let i = 0; i < 10; i++) {
      code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
      let clash = false;
      for (const o of others) if (await bcrypt.compare(code, o.codeHash!)) clash = true;
      if (!clash) break;
    }
    const c = await Court.findByIdAndUpdate(
      req.params.id,
      { $set: { codeHash: await bcrypt.hash(code, 10) }, $inc: { codeVersion: 1 } },
      { new: true },
    ).lean();
    if (!c) throw notFound('Court');
    await audit({ actor: actorOf(req), action: 'regenerate_code', entity: 'court', entityId: c._id, tournamentId: c.tournamentId });
    res.json({ code, court: courtDto(c) });
  });

  /** QR code (SVG) linking to the umpire page for this court. `base` = server URL the phones should use. */
  r.get('/:id/qr', requireAdmin(), async (req, res) => {
    const c = await Court.findById(req.params.id).lean();
    if (!c) throw notFound('Court');
    const base = typeof req.query.base === 'string' ? req.query.base : `${req.protocol}://${req.get('host')}`;
    if (!/^https?:\/\/[\w.-]+(:\d+)?$/.test(base)) throw badRequest('Invalid base URL');
    const svg = await QRCode.toString(`${base}/umpire?court=${c._id}`, { type: 'svg', margin: 1 });
    res.type('image/svg+xml').send(svg);
  });

  return r;
}
