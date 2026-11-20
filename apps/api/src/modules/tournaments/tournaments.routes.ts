import { Router } from 'express';
import { z } from 'zod';
import { tournamentSchema, tournamentUpdateSchema } from '@bt/shared';
import { requireAdmin } from '../../middleware/auth.js';
import { Category, Court, Entry, Match, Player, Team, Tournament } from '../../models/index.js';
import { conflict, notFound, parse } from '../../utils/errors.js';
import { actorOf, audit } from '../audit.js';
import { tournamentDto } from '../dto.js';

const PUBLIC_STATUSES = ['active', 'completed'];
const duplicateSchema = z.object({ name: z.string().trim().min(1).max(120), includeRoster: z.boolean().optional().default(true) });

export function tournamentRoutes(): Router {
  const r = Router();

  // Spectators see active/completed tournaments; admins see everything.
  r.get('/', async (req, res) => {
    const filter = req.auth.admin ? {} : { status: { $in: PUBLIC_STATUSES } };
    const list = await Tournament.find(filter).sort({ createdAt: -1 }).lean();
    res.json(list.map(tournamentDto));
  });

  r.get('/:id', async (req, res) => {
    const t = await Tournament.findById(req.params.id).lean();
    if (!t || (!req.auth.admin && !PUBLIC_STATUSES.includes(t.status))) throw notFound('Tournament');
    res.json(tournamentDto(t));
  });

  r.post('/', requireAdmin(), async (req, res) => {
    const body = parse(tournamentSchema, req.body);
    const t = await Tournament.create(body);
    await audit({ actor: actorOf(req), action: 'create', entity: 'tournament', entityId: t._id, tournamentId: t._id, after: body });
    res.status(201).json(tournamentDto(t.toObject()));
  });

  r.put('/:id', requireAdmin(), async (req, res) => {
    const body = parse(tournamentUpdateSchema, req.body);
    const before = await Tournament.findById(req.params.id).lean();
    if (!before) throw notFound('Tournament');
    const t = await Tournament.findByIdAndUpdate(req.params.id, { $set: body }, { new: true }).lean();
    await audit({ actor: actorOf(req), action: 'update', entity: 'tournament', entityId: before._id, tournamentId: before._id, before, after: body });
    res.json(tournamentDto(t!));
  });

  /**
   * Start a new tournament from an existing one: same venue, schedule settings, divisions, teams and courts
   * (without umpire codes), and optionally the players and pairs in their order. Matches and schedules are not copied.
   */
  r.post('/:id/duplicate', requireAdmin(), async (req, res) => {
    const body = parse(duplicateSchema, req.body);
    const src = await Tournament.findById(req.params.id).lean();
    if (!src) throw notFound('Tournament');
    const schedule = src.schedule ? { ...(src.schedule as object), startAt: null, endAt: null } : null;
    const copy = await Tournament.create({ name: body.name, venue: src.venue ?? '', date: '', status: 'draft', schedule });
    const newId = copy._id;

    const catMap = new Map<string, unknown>();
    for (const c of await Category.find({ tournamentId: src._id }).lean()) {
      const { _id, createdAt, updatedAt, tournamentId, ...rest } = c as Record<string, unknown>;
      void createdAt; void updatedAt; void tournamentId;
      catMap.set(String(_id), (await Category.create({ ...rest, tournamentId: newId }))._id);
    }
    const teamMap = new Map<string, unknown>();
    for (const t of await Team.find({ tournamentId: src._id }).lean()) {
      teamMap.set(String(t._id), (await Team.create({ tournamentId: newId, name: t.name, color: t.color, status: 'active' }))._id);
    }
    let courts = 0;
    for (const c of await Court.find({ tournamentId: src._id }).sort({ order: 1 }).lean()) {
      await Court.create({ tournamentId: newId, name: c.name, order: c.order, active: c.active });
      courts++;
    }
    let players = 0;
    let pairs = 0;
    if (body.includeRoster) {
      const playerMap = new Map<string, unknown>();
      for (const p of await Player.find({ tournamentId: src._id }).lean()) {
        playerMap.set(String(p._id), (await Player.create({ tournamentId: newId, teamId: p.teamId ? teamMap.get(String(p.teamId)) ?? null : null, firstName: p.firstName, lastName: p.lastName, gender: p.gender, club: p.club }))._id);
        players++;
      }
      for (const e of await Entry.find({ tournamentId: src._id, status: 'active' }).sort({ rank: 1 }).lean()) {
        await Entry.create({
          tournamentId: newId,
          categoryId: catMap.get(String(e.categoryId)),
          teamId: e.teamId ? teamMap.get(String(e.teamId)) ?? null : null,
          playerIds: e.playerIds.map((id) => playerMap.get(String(id))),
          displayName: e.displayName,
          seed: e.seed ?? null,
          rank: e.rank ?? null,
        });
        pairs++;
      }
      for (const t of await Team.find({ tournamentId: src._id, captainPlayerId: { $ne: null } }).lean()) {
        await Team.updateOne({ _id: teamMap.get(String(t._id)) }, { $set: { captainPlayerId: playerMap.get(String(t.captainPlayerId)) ?? null } });
      }
    }
    await audit({ actor: actorOf(req), action: 'duplicate', entity: 'tournament', entityId: newId, tournamentId: newId, after: { from: String(src._id), includeRoster: body.includeRoster } });
    res.status(201).json({ tournament: tournamentDto(copy.toObject()), copied: { divisions: catMap.size, teams: teamMap.size, courts, players, pairs } });
  });

  // Hard delete only while nothing has been played; otherwise archive (status: archived).
  r.delete('/:id', requireAdmin('super_admin'), async (req, res) => {
    const t = await Tournament.findById(req.params.id).lean();
    if (!t) throw notFound('Tournament');
    if (await Match.exists({ tournamentId: t._id, status: { $nin: ['pending', 'scheduled', 'ready', 'cancelled'] } })) {
      throw conflict('Matches have been played. Archive the tournament instead of deleting it.', 'has_results');
    }
    await Promise.all([
      Match.deleteMany({ tournamentId: t._id }),
      Entry.deleteMany({ tournamentId: t._id }),
      Player.deleteMany({ tournamentId: t._id }),
      Court.deleteMany({ tournamentId: t._id }),
      Category.deleteMany({ tournamentId: t._id }),
    ]);
    await Tournament.deleteOne({ _id: t._id });
    await audit({ actor: actorOf(req), action: 'delete', entity: 'tournament', entityId: t._id, before: t });
    res.status(204).end();
  });

  return r;
}
