import { Router } from 'express';
import { teamLogoSchema, teamSchema, teamUpdateSchema } from '@bt/shared';
import { requireAdmin } from '../../middleware/auth.js';
import { Entry, Match, Player, Team, Tournament } from '../../models/index.js';
import { badRequest, conflict, notFound, parse } from '../../utils/errors.js';
import { actorOf, audit } from '../audit.js';
import { teamDto } from '../dto.js';

/** Colours similar to the reference schedule; assigned in order to new teams. */
export const TEAM_PALETTE = ['#c6efce', '#9bc2e6', '#ff9999', '#ffe699', '#d9b3ff', '#f8cbad', '#b4e5e5', '#d9d9d9'];

export async function nextTeamColor(tournamentId: unknown): Promise<string> {
  const n = await Team.countDocuments({ tournamentId });
  return TEAM_PALETTE[n % TEAM_PALETTE.length]!;
}

export function teamRoutes(): Router {
  const r = Router();

  // Public: team names and colours appear on scoreboards and standings.
  r.get('/', async (req, res) => {
    if (typeof req.query.tournamentId !== 'string') throw badRequest('tournamentId is required');
    const list = await Team.find({ tournamentId: req.query.tournamentId }).sort({ name: 1 }).lean();
    res.json(list.map(teamDto));
  });

  r.post('/', requireAdmin(), async (req, res) => {
    const body = parse(teamSchema, req.body);
    if (!(await Tournament.exists({ _id: body.tournamentId }))) throw notFound('Tournament');
    const t = await Team.create({ ...body, color: body.color ?? (await nextTeamColor(body.tournamentId)) });
    await audit({ actor: actorOf(req), action: 'create', entity: 'team', entityId: t._id, tournamentId: t.tournamentId, after: body });
    res.status(201).json(teamDto(t.toObject()));
  });

  r.put('/:id', requireAdmin(), async (req, res) => {
    const body = parse(teamUpdateSchema, req.body);
    const before = await Team.findById(req.params.id).lean();
    if (!before) throw notFound('Team');
    if (body.captainPlayerId && !(await Player.exists({ _id: body.captainPlayerId, teamId: before._id }))) {
      throw badRequest('The captain must be a player on this team');
    }
    const t = await Team.findByIdAndUpdate(req.params.id, { $set: body }, { new: true }).lean();
    await audit({ actor: actorOf(req), action: 'update', entity: 'team', entityId: before._id, tournamentId: before.tournamentId, before, after: body });
    res.json(teamDto(t!));
  });

  // Public: the image itself, cached by the browser (the address changes when the logo does).
  r.get('/:id/logo', async (req, res) => {
    const t = await Team.findById(req.params.id).select('+logo').lean();
    const m = /^data:(image\/[a-z]+);base64,(.+)$/.exec(t?.logo ?? '');
    if (!m) throw notFound('Logo');
    res.set('Content-Type', m[1]!).set('Cache-Control', 'public, max-age=31536000, immutable').send(Buffer.from(m[2]!, 'base64'));
  });

  r.put('/:id/logo', requireAdmin(), async (req, res) => {
    const body = parse(teamLogoSchema, req.body);
    const t = await Team.findByIdAndUpdate(req.params.id, { $set: { logo: body.dataUrl, logoAt: new Date() } }, { new: true }).lean();
    if (!t) throw notFound('Team');
    await audit({ actor: actorOf(req), action: 'update', entity: 'team', entityId: t._id, tournamentId: t.tournamentId, after: { logo: 'set' } });
    res.json(teamDto(t));
  });

  r.delete('/:id/logo', requireAdmin(), async (req, res) => {
    const t = await Team.findByIdAndUpdate(req.params.id, { $set: { logo: '', logoAt: null } }, { new: true }).lean();
    if (!t) throw notFound('Team');
    await audit({ actor: actorOf(req), action: 'update', entity: 'team', entityId: t._id, tournamentId: t.tournamentId, after: { logo: 'removed' } });
    res.json(teamDto(t));
  });

  r.delete('/:id', requireAdmin(), async (req, res) => {
    const t = await Team.findById(req.params.id).lean();
    if (!t) throw notFound('Team');
    if (await Match.exists({ $or: [{ teamAId: t._id }, { teamBId: t._id }] })) {
      throw conflict('Team has matches. Withdraw it instead.', 'in_use');
    }
    if (await Entry.exists({ teamId: t._id })) throw conflict('Team still has pairs. Remove them first.', 'in_use');
    await Player.updateMany({ teamId: t._id }, { $set: { teamId: null } });
    await Team.deleteOne({ _id: t._id });
    await audit({ actor: actorOf(req), action: 'delete', entity: 'team', entityId: t._id, tournamentId: t.tournamentId, before: t });
    res.status(204).end();
  });

  return r;
}
