import { Router } from 'express';
import type { Types } from 'mongoose';
import { entryMoveSchema, entrySchema, entryUpdateSchema, swapPlayersSchema } from '@bt/shared';
import type { Broadcaster } from '../../sockets/index.js';
import { assertNotLive, broadcastMatches, displayNameOf, resyncTeamMatches } from './lineup-edit.service.js';
import { requireAdmin } from '../../middleware/auth.js';
import { Category, Entry, Match, Player, Team } from '../../models/index.js';
import { badRequest, conflict, notFound, parse, unprocessable } from '../../utils/errors.js';
import { actorOf, audit } from '../audit.js';
import { entryDto } from '../dto.js';

export const fullName = (p: { firstName: string; lastName?: string | null }) => `${p.firstName} ${p.lastName ?? ''}`.trim();

/**
 * The pair's team: the given one, else the players' shared team. Players already on a team
 * must be on the same team as the pair. Team divisions require a team.
 */
async function resolveEntryTeam(
  players: { teamId?: unknown; firstName: string; lastName?: string | null }[],
  requested: string | null,
  required: boolean,
): Promise<Types.ObjectId | null> {
  const playerTeams = [...new Set(players.map((p) => (p.teamId ? String(p.teamId) : '')).filter(Boolean))];
  if (playerTeams.length > 1) throw unprocessable('The two players are on different teams', 'team_mismatch');
  const teamId = requested ?? playerTeams[0] ?? null;
  if (requested && playerTeams[0] && playerTeams[0] !== requested) {
    throw unprocessable(`${players.map(fullName).join(' / ')} belong to another team`, 'team_mismatch');
  }
  if (!teamId) {
    if (required) throw unprocessable('Pick the team this pair plays for', 'team_required');
    return null;
  }
  const team = await Team.findById(teamId).lean();
  if (!team) throw notFound('Team');
  return team._id;
}

/** Next free position in a team's list for a division. */
export async function nextRank(categoryId: unknown, teamId: unknown): Promise<number> {
  const last = await Entry.findOne({ categoryId, teamId, status: 'active', rank: { $type: 'number' } }).sort({ rank: -1 }).select('rank').lean();
  return (last?.rank ?? 0) + 1;
}

/** Close the gap left by a removed pair: everyone below moves up one, in order (unique index friendly). */
async function closeGap(categoryId: unknown, teamId: unknown, removedRank: number) {
  const below = await Entry.find({ categoryId, teamId, status: 'active', rank: { $gt: removedRank } }).sort({ rank: 1 }).select('rank').lean();
  for (const e of below) await Entry.updateOne({ _id: e._id }, { $set: { rank: e.rank! - 1 } });
}

export function entryRoutes(broadcaster?: Broadcaster): Router {
  const r = Router();

  // Public: entry names appear on scoreboards anyway.
  r.get('/', async (req, res) => {
    const { tournamentId, categoryId } = req.query;
    if (typeof tournamentId !== 'string' && typeof categoryId !== 'string') {
      throw badRequest('tournamentId or categoryId is required');
    }
    const filter: Record<string, unknown> = {};
    if (typeof tournamentId === 'string') filter.tournamentId = tournamentId;
    if (typeof categoryId === 'string') filter.categoryId = categoryId;
    if (typeof req.query.teamId === 'string') filter.teamId = req.query.teamId;
    const list = await Entry.find(filter).sort({ categoryId: 1, rank: 1, seed: 1, displayName: 1 }).lean();
    res.json(list.map(entryDto));
  });

  r.post('/', requireAdmin(), async (req, res) => {
    const body = parse(entrySchema, req.body);
    const category = await Category.findById(body.categoryId).lean();
    if (!category) throw notFound('Category');

    const ids = [...new Set(body.playerIds)];
    if (ids.length !== category.playersPerEntry) {
      throw unprocessable(`${category.name} needs ${category.playersPerEntry} different player(s) per entry`, 'wrong_player_count');
    }
    const players = await Player.find({ _id: { $in: ids }, tournamentId: category.tournamentId }).lean();
    if (players.length !== ids.length) throw unprocessable('All players must be registered in this tournament', 'unknown_player');

    // A player may be in only one active pair per tournament (decided 2026-11-15).
    const clash = await Entry.findOne({ tournamentId: category.tournamentId, status: 'active', playerIds: { $in: ids } }).lean();
    if (clash) throw conflict(`A player is already in a pair (${clash.displayName})`, 'already_entered');

    const isTeamDivision = category.format === 'team_round_robin';
    const teamId = await resolveEntryTeam(players, body.teamId ?? null, isTeamDivision);

    // Team divisions: the pair takes the next position in its team's list (or the one asked for).
    let rank: number | null = null;
    if (isTeamDivision && teamId) {
      rank = body.rank ?? (await nextRank(category._id, teamId));
      const taken = await Entry.findOne({ categoryId: category._id, teamId, status: 'active', rank }).select('displayName').lean();
      if (taken) throw conflict(`Position ${rank} is already used by ${taken.displayName}`, 'rank_taken');
    }

    // Keep the order the admin picked players in.
    const ordered = ids.map((id) => players.find((p) => String(p._id) === id)!);
    const displayName = body.displayName?.trim() || ordered.map(fullName).join(' / ');

    const e = await Entry.create({
      tournamentId: category.tournamentId,
      categoryId: category._id,
      teamId,
      playerIds: ids,
      displayName,
      seed: body.seed ?? null,
      rank,
    });
    await audit({ actor: actorOf(req), action: 'create', entity: 'entry', entityId: e._id, tournamentId: e.tournamentId, after: { ...body, rank } });
    res.status(201).json(entryDto(e.toObject()));
  });

  r.put('/:id', requireAdmin(), async (req, res) => {
    const body = parse(entryUpdateSchema, req.body);
    const before = await Entry.findById(req.params.id).lean();
    if (!before) throw notFound('Entry');

    // Substituting players keeps the pair (and so its matches, courts and times).
    if (body.playerIds) {
      const ids = [...new Set(body.playerIds)];
      if (ids.length !== before.playerIds.length) throw unprocessable(`This pair needs ${before.playerIds.length} different player(s)`, 'wrong_player_count');
      const players = await Player.find({ _id: { $in: ids }, tournamentId: before.tournamentId }).lean();
      if (players.length !== ids.length) throw unprocessable('All players must be registered in this tournament', 'unknown_player');
      const clash = await Entry.findOne({ _id: { $ne: before._id }, tournamentId: before.tournamentId, status: 'active', playerIds: { $in: ids } }).lean();
      if (clash) throw conflict(`${players.find((p) => clash.playerIds.some((x) => String(x) === String(p._id)))?.firstName ?? 'A player'} is already in a pair (${clash.displayName})`, 'already_entered');
      if (before.teamId && players.some((p) => p.teamId && String(p.teamId) !== String(before.teamId))) throw unprocessable('A player belongs to another team', 'team_mismatch');
      await assertNotLive([before._id]);
      if (before.teamId) await Player.updateMany({ _id: { $in: ids }, teamId: null }, { $set: { teamId: before.teamId } });
      if (!body.displayName) body.displayName = await displayNameOf(ids);
      body.playerIds = ids;
    }
    const e = await Entry.findByIdAndUpdate(req.params.id, { $set: body }, { new: true }).lean();
    if (body.playerIds && broadcaster) await broadcastMatches(broadcaster, { $or: [{ entryAId: before._id }, { entryBId: before._id }] });
    await audit({ actor: actorOf(req), action: 'update', entity: 'entry', entityId: before._id, tournamentId: before.tournamentId, before, after: body });
    res.json(entryDto(e!));
  });

  /** Exchange one player between two pairs. Both pairs keep their matches, courts and times. */
  r.post('/swap-players', requireAdmin(), async (req, res) => {
    const b = parse(swapPlayersSchema, req.body);
    const [ea, eb] = await Promise.all([Entry.findById(b.entryAId).lean(), Entry.findById(b.entryBId).lean()]);
    if (!ea || !eb) throw notFound('Entry');
    if (String(ea.tournamentId) !== String(eb.tournamentId) || ea._id.equals(eb._id)) throw unprocessable('Pick two different pairs of this tournament', 'bad_swap');
    const has = (e: typeof ea, id: string) => e.playerIds.some((p) => String(p) === id);
    if (!has(ea, b.playerAId) || !has(eb, b.playerBId)) throw unprocessable('Those players are not in those pairs', 'bad_swap');
    await assertNotLive([ea._id, eb._id]);
    const swap = (e: typeof ea, out: string, inn: string) => e.playerIds.map((p) => (String(p) === out ? inn : String(p)));
    const idsA = swap(ea, b.playerAId, b.playerBId);
    const idsB = swap(eb, b.playerBId, b.playerAId);
    const [nameA, nameB] = await Promise.all([displayNameOf(idsA), displayNameOf(idsB)]);
    // Players move teams with the swap, so both pairs stay consistent.
    if (ea.teamId && !(eb.teamId && String(ea.teamId) === String(eb.teamId))) {
      await Player.updateOne({ _id: b.playerBId }, { $set: { teamId: ea.teamId } });
      if (eb.teamId) await Player.updateOne({ _id: b.playerAId }, { $set: { teamId: eb.teamId } });
    }
    await Entry.updateOne({ _id: ea._id }, { $set: { playerIds: idsA, displayName: nameA } });
    await Entry.updateOne({ _id: eb._id }, { $set: { playerIds: idsB, displayName: nameB } });
    await audit({ actor: actorOf(req), action: 'swap_players', entity: 'entry', entityId: ea._id, tournamentId: ea.tournamentId, before: { a: ea.displayName, b: eb.displayName }, after: { a: nameA, b: nameB } });
    if (broadcaster) await broadcastMatches(broadcaster, { $or: [{ entryAId: { $in: [ea._id, eb._id] } }, { entryBId: { $in: [ea._id, eb._id] } }] });
    const list = await Entry.find({ _id: { $in: [ea._id, eb._id] } }).lean();
    res.json(list.map(entryDto));
  });

  /**
   * Move a pair up or down in its team's list. Matches that were already generated keep the pairs
   * they were created for; regenerate (replace) to rebuild the not-yet-started ones.
   */
  r.post('/:id/move', requireAdmin(), async (req, res) => {
    const { direction } = parse(entryMoveSchema, req.body);
    const e = await Entry.findById(req.params.id).lean();
    if (!e) throw notFound('Entry');
    if (e.rank == null || !e.teamId || e.status !== 'active') throw unprocessable('Only active pairs in a team list can be moved', 'not_ranked');
    const target = e.rank + (direction === 'up' ? -1 : 1);
    const other = await Entry.findOne({ categoryId: e.categoryId, teamId: e.teamId, status: 'active', rank: target }).lean();
    if (!other) throw unprocessable(direction === 'up' ? 'Already first' : 'Already last', 'cannot_move');
    // Swap through a temporary position so the unique index is never violated.
    await Entry.bulkWrite(
      [
        { updateOne: { filter: { _id: e._id }, update: { $set: { rank: -1 } } } },
        { updateOne: { filter: { _id: other._id }, update: { $set: { rank: e.rank } } } },
        { updateOne: { filter: { _id: e._id }, update: { $set: { rank: target } } } },
      ],
      { ordered: true },
    );
    await audit({ actor: actorOf(req), action: 'reorder', entity: 'entry', entityId: e._id, tournamentId: e.tournamentId, before: { rank: e.rank }, after: { rank: target, swappedWith: String(other._id) } });
    // Matches not yet played follow the new order but keep their court and time (the schedule is kept).
    if (broadcaster) await resyncTeamMatches(e.categoryId, e.teamId, broadcaster);
    const list = await Entry.find({ categoryId: e.categoryId, teamId: e.teamId }).sort({ rank: 1 }).lean();
    res.json(list.map(entryDto));
  });

  r.delete('/:id', requireAdmin(), async (req, res) => {
    const e = await Entry.findById(req.params.id).lean();
    if (!e) throw notFound('Entry');
    if (await Match.exists({ $or: [{ entryAId: e._id }, { entryBId: e._id }] })) {
      throw conflict('Entry has matches. Withdraw it instead.', 'in_use');
    }
    await Entry.deleteOne({ _id: e._id });
    if (e.rank != null && e.teamId && e.status === 'active') await closeGap(e.categoryId, e.teamId, e.rank);
    await audit({ actor: actorOf(req), action: 'delete', entity: 'entry', entityId: e._id, tournamentId: e.tournamentId, before: e });
    res.status(204).end();
  });

  return r;
}
