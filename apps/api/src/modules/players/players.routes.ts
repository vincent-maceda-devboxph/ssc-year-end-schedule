import { Router } from 'express';
import { playerSchema, playerUpdateSchema } from '@bt/shared';
import { requireAdmin } from '../../middleware/auth.js';
import { Entry, Player, Tournament } from '../../models/index.js';
import { badRequest, conflict, notFound, parse } from '../../utils/errors.js';
import { actorOf, audit } from '../audit.js';
import { playerDto } from '../dto.js';
import { displayNameOf } from '../entries/lineup-edit.service.js';

export function playerRoutes(): Router {
  const r = Router();
  r.use(requireAdmin());

  r.get('/', async (req, res) => {
    if (typeof req.query.tournamentId !== 'string') throw badRequest('tournamentId is required');
    const filter: Record<string, unknown> = { tournamentId: req.query.tournamentId };
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (q) {
      const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ firstName: rx }, { lastName: rx }, { club: rx }];
    }
    const list = await Player.find(filter).sort({ lastName: 1, firstName: 1 }).lean();
    res.json(list.map(playerDto));
  });

  r.post('/', async (req, res) => {
    const body = parse(playerSchema, req.body);
    if (!(await Tournament.exists({ _id: body.tournamentId }))) throw notFound('Tournament');
    const p = await Player.create(body);
    await audit({ actor: actorOf(req), action: 'create', entity: 'player', entityId: p._id, tournamentId: p.tournamentId, after: body });
    res.status(201).json(playerDto(p.toObject()));
  });

  r.put('/:id', async (req, res) => {
    const body = parse(playerUpdateSchema, req.body);
    const before = await Player.findById(req.params.id).lean();
    if (!before) throw notFound('Player');
    const p = await Player.findByIdAndUpdate(req.params.id, { $set: body }, { new: true }).lean();
    if (p && (body.firstName !== undefined || body.lastName !== undefined)) {
      // Pairs named after their players follow the new spelling (custom pair names are left alone).
      const entries = await Entry.find({ playerIds: p._id }).lean();
      for (const e of entries) {
        const before_ = (await Player.find({ _id: { $in: e.playerIds } }).lean()).map((x) => (String(x._id) === String(p._id) ? before : x));
        const auto = e.playerIds.map((id) => before_.find((x) => String(x._id) === String(id))).filter(Boolean).map((x) => `${x!.firstName} ${x!.lastName ?? ''}`.trim()).join(' / ');
        if (e.displayName === auto) await Entry.updateOne({ _id: e._id }, { $set: { displayName: await displayNameOf(e.playerIds) } });
      }
    }
    await audit({ actor: actorOf(req), action: 'update', entity: 'player', entityId: before._id, tournamentId: before.tournamentId, before, after: body });
    res.json(playerDto(p!));
  });

  r.delete('/:id', async (req, res) => {
    const p = await Player.findById(req.params.id).lean();
    if (!p) throw notFound('Player');
    if (await Entry.exists({ playerIds: p._id })) throw conflict('Player is part of an entry. Remove the entry first.', 'in_use');
    await Player.deleteOne({ _id: p._id });
    await audit({ actor: actorOf(req), action: 'delete', entity: 'player', entityId: p._id, tournamentId: p.tournamentId, before: p });
    res.status(204).end();
  });

  return r;
}
