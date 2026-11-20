import { Router } from 'express';
import { assignGroupsSchema, categorySchema, categoryUpdateSchema, divisionCode, generateBracketSchema } from '@bt/shared';
import { requireAdmin } from '../../middleware/auth.js';
import { Category, Entry, Match, Tournament } from '../../models/index.js';
import { badRequest, conflict, notFound, parse, unprocessable } from '../../utils/errors.js';
import type { Broadcaster } from '../../sockets/index.js';
import { actorOf, audit } from '../audit.js';
import { assignGroups, clearGroups, generateBracketMatches } from '../brackets/bracket.service.js';
import { categoryDto } from '../dto.js';

export function categoryRoutes(broadcaster: Broadcaster): Router {
  const r = Router();

  r.get('/', async (req, res) => {
    if (typeof req.query.tournamentId !== 'string') throw badRequest('tournamentId is required');
    const list = await Category.find({ tournamentId: req.query.tournamentId }).sort({ name: 1 }).lean();
    res.json(list.map(categoryDto));
  });

  r.post('/', requireAdmin(), async (req, res) => {
    const body = parse(categorySchema, req.body);
    if (!(await Tournament.exists({ _id: body.tournamentId }))) throw notFound('Tournament');
    if (body.sourceCategoryId) {
      if (body.format !== 'knockout') throw unprocessable('Only a knockout division takes its entries from another division', 'bad_source');
      const src = await Category.findOne({ _id: body.sourceCategoryId, tournamentId: body.tournamentId }).lean();
      if (!src) throw notFound('Source division');
      if (src.format === 'knockout') throw unprocessable('A knockout cannot take its entries from another knockout', 'bad_source');
    }
    const c = await Category.create({ ...body, code: body.code ?? divisionCode(body.name), playersPerEntry: body.discipline === 'singles' ? 1 : 2 });
    await audit({ actor: actorOf(req), action: 'create', entity: 'category', entityId: c._id, tournamentId: c.tournamentId, after: body });
    res.status(201).json(categoryDto(c.toObject()));
  });

  // Scoring changes apply to matches created afterwards; existing matches keep their snapshot.
  r.put('/:id', requireAdmin(), async (req, res) => {
    const body = parse(categoryUpdateSchema, req.body);
    const before = await Category.findById(req.params.id).lean();
    if (!before) throw notFound('Category');
    const c = await Category.findByIdAndUpdate(req.params.id, { $set: body }, { new: true }).lean();
    await audit({ actor: actorOf(req), action: 'update', entity: 'category', entityId: before._id, tournamentId: before.tournamentId, before, after: body });
    res.json(categoryDto(c!));
  });

  /** Split a round-robin division into groups (snake order by seed). Before matches exist. */
  r.post('/:id/groups', requireAdmin(), async (req, res) => {
    const { count } = parse(assignGroupsSchema, req.body);
    res.json(await assignGroups(String(req.params.id), count, actorOf(req)));
  });
  r.delete('/:id/groups', requireAdmin(), async (req, res) => {
    await clearGroups(String(req.params.id), actorOf(req));
    res.status(204).end();
  });

  /** Build the knockout bracket (from the division's own entries, or from a group stage's qualifiers). */
  r.post('/:id/bracket/generate', requireAdmin(), async (req, res) => {
    const body = parse(generateBracketSchema, req.body ?? {});
    res.json(await generateBracketMatches(String(req.params.id), body, actorOf(req), broadcaster));
  });

  r.delete('/:id', requireAdmin(), async (req, res) => {
    const c = await Category.findById(req.params.id).lean();
    if (!c) throw notFound('Category');
    if (await Match.exists({ categoryId: c._id })) throw conflict('Category has matches', 'in_use');
    await Entry.deleteMany({ categoryId: c._id });
    await Category.deleteOne({ _id: c._id });
    await audit({ actor: actorOf(req), action: 'delete', entity: 'category', entityId: c._id, tournamentId: c.tournamentId, before: c });
    res.status(204).end();
  });

  return r;
}
