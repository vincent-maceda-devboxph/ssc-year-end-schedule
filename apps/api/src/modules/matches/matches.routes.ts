import { Router, type Request } from 'express';
import { z } from 'zod';
import {
  commandSchema,
  emptyScore,
  FINAL_STATUSES,
  isFinal,
  isLive,
  LIVE_STATUSES,
  correctResultSchema,
  matchAdminActionSchema,
  moveMatchSchema,
  matchCreateSchema,
  matchUpdateSchema,
  MATCH_COMMANDS,
  type MatchStatus,
  type UmpireCurrentResponse,
} from '@bt/shared';
import { requireAdmin, requireOfficial } from '../../middleware/auth.js';
import { Category, Court, Entry, Match, Tournament } from '../../models/index.js';
import type { Broadcaster } from '../../sockets/index.js';
import { badRequest, conflict, notFound, parse, unauthorized, unprocessable } from '../../utils/errors.js';
import { actorOf, audit } from '../audit.js';
import { MATCH_POPULATE, matchDto, umpireKey } from '../dto.js';
import { moveMatch } from '../scheduling/move.service.js';
import { promoteNextOnCourt } from '../scheduling/ready.service.js';
import { advanceFromMatch } from '../brackets/advance.service.js';
import { correctResult } from './corrections.service.js';
import { busyPlayersMatch, loadMatchDto, ScoringService } from '../scoring/scoring.service.js';
import { reserveNumbers } from '../../utils/counters.js';

/** Route name → command type. `/complete` submits the final result (plan §14). */
const COMMAND_ROUTES: Record<string, (typeof MATCH_COMMANDS)[number]> = {
  start: 'start',
  points: 'point',
  undo: 'undo',
  pause: 'pause',
  resume: 'resume',
  complete: 'submit',
  retire: 'retire',
  servers: 'servers',
};

async function nextQueuePosition(courtId: unknown): Promise<number> {
  const last = await Match.findOne({ courtId }).sort({ queuePosition: -1 }).select('queuePosition').lean();
  return (last?.queuePosition ?? 0) + 1;
}

export function matchRoutes(broadcaster: Broadcaster): Router {
  const r = Router();
  const scoring = new ScoringService(broadcaster);

  // ---------- reads (public) ----------
  r.get('/', async (req, res) => {
    const { tournamentId, courtId, status } = req.query;
    if (typeof tournamentId !== 'string') throw badRequest('tournamentId is required');
    const filter: Record<string, unknown> = { tournamentId };
    if (typeof courtId === 'string') filter.courtId = courtId;
    if (typeof status === 'string') filter.status = { $in: status.split(',') };
    const list = await Match.find(filter)
      .select('-actions')
      .sort({ matchNumber: 1 })
      .populate(MATCH_POPULATE)
      .lean();
    res.json(list.map(matchDto));
  });

  r.get('/:id', async (req, res) => {
    res.json(await loadMatchDto(req.params.id));
  });

  // ---------- admin management ----------
  r.post('/', requireAdmin(), async (req, res) => {
    const body = parse(matchCreateSchema, req.body);
    const category = await Category.findById(body.categoryId).lean();
    if (!category) throw notFound('Category');
    const entries = await Entry.find({
      _id: { $in: [body.entryAId, body.entryBId] },
      categoryId: category._id,
      status: 'active',
    }).lean();
    if (entries.length !== 2) throw unprocessable('Both entries must be active in this category', 'invalid_entries');

    let courtId = null;
    if (body.courtId) {
      const court = await Court.findOne({ _id: body.courtId, tournamentId: category.tournamentId }).lean();
      if (!court) throw notFound('Court');
      courtId = court._id;
    }
    if (!(await Tournament.exists({ _id: category.tournamentId }))) throw notFound('Tournament');
    const matchNumber = await reserveNumbers(category.tournamentId, 'nextMatchNumber');

    const m = await Match.create({
      tournamentId: category.tournamentId,
      categoryId: category._id,
      matchNumber,
      round: body.round,
      entryAId: body.entryAId,
      entryBId: body.entryBId,
      courtId,
      queuePosition: courtId ? await nextQueuePosition(courtId) : 0,
      status: courtId ? 'scheduled' : 'pending',
      scoring: category.scoring,
      score: emptyScore(),
    });
    await audit({ actor: actorOf(req), action: 'create', entity: 'match', entityId: m._id, tournamentId: m.tournamentId, after: body });
    const dto = await loadMatchDto(String(m._id));
    broadcaster.match('match:changed', dto);
    res.status(201).json(dto);
  });

  /** Assign/move court, reorder queue, rename round. Not allowed once a match is live or finished. */
  r.put('/:id', requireAdmin(), async (req, res) => {
    const body = parse(matchUpdateSchema, req.body);
    const m = await Match.findById(req.params.id).lean();
    if (!m) throw notFound('Match');
    const status = m.status as MatchStatus;
    const set: Record<string, unknown> = {};

    if (body.round !== undefined) set.round = body.round;
    if (body.courtId !== undefined && String(body.courtId) !== String(m.courtId)) {
      if (isLive(status) || isFinal(status) || status === 'called') {
        throw unprocessable('A live or finished match cannot change court', 'invalid_status');
      }
      if (body.courtId) {
        const court = await Court.findOne({ _id: body.courtId, tournamentId: m.tournamentId }).lean();
        if (!court) throw notFound('Court');
        set.courtId = court._id;
        set.queuePosition = body.queuePosition ?? (await nextQueuePosition(court._id));
        set.status = 'scheduled';
      } else {
        set.courtId = null;
        set.queuePosition = 0;
        set.status = 'pending';
      }
    } else if (body.queuePosition !== undefined) {
      if (isFinal(status)) throw unprocessable('A finished match cannot be reordered', 'invalid_status');
      set.queuePosition = body.queuePosition;
    }

    const updated = await Match.findOneAndUpdate({ _id: m._id, version: m.version }, { $set: set, $inc: { version: 1 } }, { new: true })
      .populate(MATCH_POPULATE)
      .lean();
    if (!updated) throw conflict('Match changed meanwhile. Reload and try again.', 'version_conflict');
    await audit({ actor: actorOf(req), action: 'update', entity: 'match', entityId: m._id, tournamentId: m.tournamentId, before: { courtId: m.courtId, queuePosition: m.queuePosition, round: m.round }, after: set });
    const dto = matchDto(updated);
    broadcaster.match('match:changed', dto);
    res.json(dto);
  });

  /**
   * Move a match to another court/time, swap it with the match already there, or take it off the
   * schedule (drag and drop). Hard rules refuse the move; soft rules ask for confirmation.
   */
  r.patch('/:id/schedule', requireAdmin(), async (req, res) => {
    const body = parse(moveMatchSchema, req.body);
    res.json(await moveMatch(String(req.params.id), body, actorOf(req), broadcaster));
  });

  /** Correct a finished result (admin). Needs a reason; the old and new result are audited. */
  r.post('/:id/correct', requireAdmin(), async (req, res) => {
    const body = parse(correctResultSchema, req.body);
    res.json(await correctResult(String(req.params.id), body, actorOf(req), broadcaster));
  });

  /** Call the players and umpire to the court for a scheduled match (status "called"). */
  r.post('/:id/call', requireAdmin(), async (req, res) => {
    const m = await Match.findById(req.params.id).lean();
    if (!m) throw notFound('Match');
    if (!['scheduled', 'ready'].includes(m.status)) throw unprocessable('Only a scheduled match can be called', 'invalid_status');
    if (!m.courtId) throw unprocessable('Assign a court before calling the match', 'no_court');
    if (!m.entryAId || !m.entryBId) throw unprocessable('This match is waiting for the previous round to finish', 'waiting_for_opponents');
    const busy = await Match.findOne({ courtId: m.courtId, _id: { $ne: m._id }, status: { $in: ['called', ...LIVE_STATUSES] } }).select('matchNumber status').lean();
    if (busy) throw conflict(`Match #${busy.matchNumber} is already ${busy.status === 'called' ? 'called to' : 'playing on'} this court`, 'court_busy');
    const playing = await busyPlayersMatch(m);
    if (playing !== null) throw unprocessable(`A player is still on court in match #${playing}`, 'players_busy');
    const updated = await Match.findOneAndUpdate({ _id: m._id, version: m.version }, { $set: { status: 'called' }, $inc: { version: 1 } }, { new: true })
      .populate(MATCH_POPULATE)
      .lean();
    if (!updated) throw conflict('Match changed meanwhile. Reload and try again.', 'version_conflict');
    await audit({ actor: actorOf(req), action: 'call', entity: 'match', entityId: m._id, tournamentId: m.tournamentId });
    const dto = matchDto(updated);
    broadcaster.match('match:called', dto);
    res.json(dto);
  });

  /** Take back a call (players are not coming yet). */
  r.post('/:id/uncall', requireAdmin(), async (req, res) => {
    const m = await Match.findById(req.params.id).lean();
    if (!m) throw notFound('Match');
    if (m.status !== 'called') throw unprocessable('This match has not been called', 'invalid_status');
    const updated = await Match.findOneAndUpdate({ _id: m._id, version: m.version }, { $set: { status: 'scheduled' }, $inc: { version: 1 } }, { new: true })
      .populate(MATCH_POPULATE)
      .lean();
    if (!updated) throw conflict('Match changed meanwhile. Reload and try again.', 'version_conflict');
    await audit({ actor: actorOf(req), action: 'uncall', entity: 'match', entityId: m._id, tournamentId: m.tournamentId });
    const dto = matchDto(updated);
    broadcaster.match('match:changed', dto);
    res.json(dto);
  });

  /** Lock a scheduled match so schedule regeneration never moves it (and unlock it again). */
  r.patch('/:id/lock', requireAdmin(), async (req, res) => {
    const { locked } = parse(z.object({ locked: z.boolean() }), req.body);
    const m = await Match.findById(req.params.id).lean();
    if (!m) throw notFound('Match');
    if (!['pending', 'scheduled', 'ready'].includes(m.status)) throw unprocessable('Only matches that have not started can be locked', 'invalid_status');
    if (locked && !m.plannedStart) throw unprocessable('Schedule the match before locking it', 'not_scheduled');
    const updated = await Match.findOneAndUpdate({ _id: m._id, version: m.version }, { $set: { isLocked: locked }, $inc: { version: 1 } }, { new: true })
      .populate(MATCH_POPULATE)
      .lean();
    if (!updated) throw conflict('Match changed meanwhile. Reload and try again.', 'version_conflict');
    await audit({ actor: actorOf(req), action: locked ? 'lock' : 'unlock', entity: 'match', entityId: m._id, tournamentId: m.tournamentId });
    const dto = matchDto(updated);
    broadcaster.match('match:changed', dto);
    res.json(dto);
  });

  /** Walkover: one side did not show up. Body: { winner: 'A' | 'B', reason? } */
  r.post('/:id/walkover', requireAdmin(), async (req, res) => {
    const body = parse(matchAdminActionSchema, req.body);
    if (!body.winner) throw badRequest('winner is required');
    res.json(await adminFinish(req, broadcaster, { status: 'walkover', winner: body.winner, reason: body.reason }));
  });

  r.post('/:id/cancel', requireAdmin(), async (req, res) => {
    const body = parse(matchAdminActionSchema, req.body);
    res.json(await adminFinish(req, broadcaster, { status: 'cancelled', winner: null, reason: body.reason }));
  });

  r.delete('/:id', requireAdmin(), async (req, res) => {
    const m = await Match.findById(req.params.id).lean();
    if (!m) throw notFound('Match');
    if (m.actions.length || !['pending', 'scheduled', 'ready', 'cancelled'].includes(m.status)) {
      throw conflict('Only matches that never started can be deleted', 'has_results');
    }
    await Match.deleteOne({ _id: m._id });
    await audit({ actor: actorOf(req), action: 'delete', entity: 'match', entityId: m._id, tournamentId: m.tournamentId, before: m });
    broadcaster.tournament(String(m.tournamentId), 'match:deleted', { id: String(m._id) });
    res.status(204).end();
  });

  // ---------- scoring commands (umpire on this court, or admin) ----------
  for (const [route, type] of Object.entries(COMMAND_ROUTES)) {
    r.post(`/:id/${route}`, requireOfficial, async (req, res) => {
      const input = parse(commandSchema, { ...req.body, type });
      res.json(await scoring.run(String(req.params.id), input, req.auth));
    });
  }

  r.post('/:id/takeover', requireOfficial, async (req, res) => {
    res.json(await scoring.takeover(String(req.params.id), req.auth));
  });

  return r;
}

async function adminFinish(
  req: Request,
  broadcaster: Broadcaster,
  p: { status: 'walkover' | 'cancelled'; winner: 'A' | 'B' | null; reason: string },
) {
  const m = await Match.findById(req.params.id).lean();
  if (!m) throw notFound('Match');
  if (p.status === 'walkover' && (!m.entryAId || !m.entryBId)) throw unprocessable('This match is still waiting for its opponents.', 'waiting_for_opponents');
  const allowedFrom: MatchStatus[] =
    p.status === 'walkover' ? ['pending', 'scheduled', 'ready', 'called'] : ['pending', 'scheduled', 'ready', 'called', 'in_progress', 'paused'];
  if (!allowedFrom.includes(m.status as MatchStatus)) {
    throw unprocessable(`Cannot set a ${m.status.replace('_', ' ')} match to ${p.status}`, 'invalid_status');
  }
  const updated = await Match.findOneAndUpdate(
    { _id: m._id, version: m.version },
    { $set: { status: p.status, winner: p.winner, completedAt: new Date() }, $inc: { version: 1 } },
    { new: true },
  )
    .populate(MATCH_POPULATE)
    .lean();
  if (!updated) throw conflict('Match changed meanwhile. Reload and try again.', 'version_conflict');
  await audit({ actor: actorOf(req), action: p.status, entity: 'match', entityId: m._id, tournamentId: m.tournamentId, before: { status: m.status }, after: { status: p.status, winner: p.winner }, reason: p.reason });
  const dto = matchDto(updated);
  broadcaster.match('match:completed', dto);
  broadcaster.tournament(dto.tournamentId, 'standings:updated', { tournamentId: dto.tournamentId });
  await promoteNextOnCourt(dto.courtId, broadcaster);
  await advanceFromMatch(dto.id, broadcaster);
  return dto;
}

/** GET /api/umpire/current: what the umpire's phone should show for its court. */
export function umpireRoutes(): Router {
  const r = Router();
  r.get('/current', async (req, res) => {
    const u = req.auth.umpire;
    if (!u) throw unauthorized('Umpire session required');
    const list = await Match.find({ courtId: u.courtId, status: { $nin: [...FINAL_STATUSES] } })
      .select('-actions')
      .sort({ queuePosition: 1, matchNumber: 1 })
      .populate(MATCH_POPULATE)
      .lean();
    const live = list.find((m) => LIVE_STATUSES.includes(m.status as MatchStatus));
    const called = list.find((m) => m.status === 'called');
    const queued = list.filter((m) => m !== live && m.status !== 'pending');
    // The match being played, else the one the players were just called for, else the next queued.
    const current = live ?? called ?? queued.find((m) => m !== called) ?? null;
    const at = current ? queued.indexOf(current) : -1;
    if (at >= 0) queued.splice(at, 1);
    const body: UmpireCurrentResponse = {
      court: { id: u.courtId, name: u.courtName },
      match: current ? matchDto(current) : null,
      upcoming: queued.map(matchDto),
      myKey: umpireKey(u.sessionId),
    };
    res.json(body);
  });
  return r;
}
