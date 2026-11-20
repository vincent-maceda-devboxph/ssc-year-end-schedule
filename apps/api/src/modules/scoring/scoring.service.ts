import {
  canRunCommand,
  computeScore,
  computeServing,
  serveSetupsFromActions,
  effectivePoints,
  LIVE_STATUSES,
  ScoringError,
  type CommandInput,
  type CommandResult,
  type MatchEvent,
  type MatchStatus,
  type ScoringConfig,
  type Side,
} from '@bt/shared';
import type { Auth } from '../auth/auth.service.js';
import { Entry, Match } from '../../models/index.js';
import type { Broadcaster } from '../../sockets/index.js';
import { AppError, conflict, forbidden, notFound, unauthorized, unprocessable } from '../../utils/errors.js';
import { audit } from '../audit.js';
import { advanceFromMatch } from '../brackets/advance.service.js';
import { promoteNextOnCourt } from '../scheduling/ready.service.js';
import { requestBackupSoon } from '../system/backup.service.js';
import { MATCH_POPULATE, matchDto } from '../dto.js';

const MAX_ATTEMPTS = 5;

const EVENT_BY_COMMAND: Record<CommandInput['type'], MatchEvent> = {
  start: 'match:started',
  point: 'score:updated',
  undo: 'score:updated',
  pause: 'match:paused',
  resume: 'match:resumed',
  submit: 'match:completed',
  retire: 'match:completed',
  servers: 'score:updated',
};

type LeanMatch = Awaited<ReturnType<typeof loadLean>>;
const loadLean = (id: string) => Match.findById(id).lean();

export async function loadMatchDto(id: string) {
  const m = await Match.findById(id).populate(MATCH_POPULATE).lean();
  if (!m) throw notFound('Match');
  return matchDto(m);
}

const other = (s: Side): Side => (s === 'A' ? 'B' : 'A');

/**
 * Applies one umpire/admin command to a match (docs/decisions.md D5):
 *   1. actionId already applied     → return current state, duplicate: true
 *   2. expectedVersion is stale     → 409 + current state
 *   3. status/rules forbid command  → 422
 *   4. otherwise one conditional findOneAndUpdate on {_id, version, actionId not present}
 * The change is persisted before anything is broadcast.
 */
export class ScoringService {
  constructor(private readonly broadcaster: Broadcaster) {}

  async run(matchId: string, input: CommandInput, auth: Auth): Promise<CommandResult> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const m = await loadLean(matchId);
      if (!m) throw notFound('Match');

      // 1. Idempotency: a retry of an action we already applied.
      if (m.actions.some((a) => a.actionId === input.actionId)) {
        return { duplicate: true, match: await loadMatchDto(matchId) };
      }
      // 2. Optimistic concurrency.
      if (m.version !== input.expectedVersion) {
        throw conflict('The match changed on another device. Score refreshed.', 'version_conflict', {
          match: await loadMatchDto(matchId),
        });
      }
      // 3. Who and what.
      const actor = this.authorize(m, input.type, auth);
      if (!canRunCommand(m.status as MatchStatus, input.type)) {
        throw unprocessable(`Cannot ${input.type} a match that is ${m.status.replace('_', ' ')}`, 'invalid_status');
      }
      const set = await this.plan(m, input, auth);

      const now = new Date();
      if (auth.umpire && actor.kind === 'umpire') {
        set['umpire.lastSeenAt'] = now;
        if (!m.umpire?.sessionId) {
          set.umpire = { name: auth.umpire.name, sessionId: auth.umpire.sessionId, claimedAt: now, lastSeenAt: now };
          delete set['umpire.lastSeenAt'];
        }
      }

      // 4. Atomic conditional update.
      let updated;
      try {
        updated = await Match.findOneAndUpdate(
          { _id: m._id, version: m.version, 'actions.actionId': { $ne: input.actionId } },
          {
            $set: set,
            $push: {
              actions: {
                actionId: input.actionId,
                type: input.type,
                side: input.side,
                ...(input.type === 'servers' ? { server: input.server, receiver: input.receiver, game: (m.score as { currentGame?: number } | null)?.currentGame ?? 0 } : {}),
                by: actor,
                at: now,
              },
            },
            $inc: { version: 1 },
          },
          { new: true },
        )
          .populate(MATCH_POPULATE)
          .lean();
      } catch (err) {
        if ((err as { code?: number }).code === 11000) {
          throw conflict('Another match is already live on this court', 'court_busy');
        }
        throw err;
      }
      if (!updated) continue; // Lost a race; re-read and re-evaluate from step 1.

      const dto = matchDto(updated);
      this.broadcaster.match(EVENT_BY_COMMAND[input.type], dto);
      if (input.type === 'submit' || input.type === 'retire') {
        requestBackupSoon();
        await promoteNextOnCourt(dto.courtId, this.broadcaster);
        await advanceFromMatch(dto.id, this.broadcaster); // knockout: winner moves into the next round
      }
      if (input.type === 'submit' || input.type === 'retire') {
        this.broadcaster.tournament(dto.tournamentId, 'standings:updated', { tournamentId: dto.tournamentId });
      }
      return { duplicate: false, match: dto };
    }
    throw new AppError(503, 'busy', 'Match is being updated too quickly. Try again.');
  }

  /** Umpire on the same court takes control of a live match from another session (decisions D6). */
  async takeover(matchId: string, auth: Auth): Promise<CommandResult> {
    const u = auth.umpire;
    if (!u) throw unauthorized('Umpire session required');
    const m = await loadLean(matchId);
    if (!m) throw notFound('Match');
    if (String(m.courtId) !== u.courtId) throw forbidden('This match is not on your court', 'wrong_court');
    if (m.umpire?.sessionId === u.sessionId) return { duplicate: true, match: await loadMatchDto(matchId) };

    const now = new Date();
    const updated = await Match.findOneAndUpdate(
      { _id: m._id, version: m.version },
      {
        $set: { umpire: { name: u.name, sessionId: u.sessionId, claimedAt: now, lastSeenAt: now } },
        $inc: { version: 1 },
      },
      { new: true },
    )
      .populate(MATCH_POPULATE)
      .lean();
    if (!updated) throw conflict('The match changed. Try again.', 'version_conflict', { match: await loadMatchDto(matchId) });

    await audit({
      actor: { kind: 'umpire', id: u.sessionId, name: u.name },
      action: 'umpire_takeover',
      entity: 'match',
      entityId: m._id,
      tournamentId: m.tournamentId,
      before: { umpire: m.umpire?.name ?? null },
      after: { umpire: u.name },
    });
    const dto = matchDto(updated);
    this.broadcaster.match('match:changed', dto);
    return { duplicate: false, match: dto };
  }

  private authorize(m: NonNullable<LeanMatch>, type: CommandInput['type'], auth: Auth) {
    if (auth.admin) return { kind: 'admin', name: auth.admin.username };
    const u = auth.umpire;
    if (!u) throw unauthorized('Umpire session required');
    if (!m.courtId || String(m.courtId) !== u.courtId) throw forbidden('This match is not on your court', 'wrong_court');
    if (m.umpire?.sessionId && m.umpire.sessionId !== u.sessionId && type !== 'start') {
      throw forbidden(`${m.umpire.name} is controlling this match`, 'controlled_by_other');
    }
    return { kind: 'umpire', name: u.name };
  }

  /** Compute the $set for a command. Throws 422 when badminton rules forbid it. */
  private async plan(m: NonNullable<LeanMatch>, input: CommandInput, _auth: Auth): Promise<Record<string, unknown>> {
    const cfg = m.scoring as unknown as ScoringConfig;
    const points = effectivePoints(m.actions as { type: string; side?: Side }[] as never);
    const now = new Date();

    switch (input.type) {
      case 'start': {
        if (!m.entryAId || !m.entryBId) throw unprocessable('This match is waiting for the previous round to finish.', 'waiting_for_opponents');
        if (!m.courtId) throw unprocessable('Assign a court before starting', 'no_court');
        const busyNo = await busyPlayersMatch(m);
        if (busyNo !== null) throw unprocessable(`A player is still on court in match #${busyNo}`, 'players_busy');
        return { status: 'in_progress', startedAt: m.startedAt ?? now, servingState: serving(cfg, m, points) };
      }
      case 'point': {
        if (!input.side) throw unprocessable('side is required', 'side_required');
        const score = safeScore(cfg, [...points, input.side]);
        return { score, status: score.winner ? 'awaiting_confirmation' : 'in_progress', servingState: serving(cfg, m, [...points, input.side]) };
      }
      case 'undo': {
        if (!points.length) throw unprocessable('Nothing to undo', 'nothing_to_undo');
        const score = safeScore(cfg, points.slice(0, -1));
        return { score, status: 'in_progress', servingState: serving(cfg, m, points.slice(0, -1)) };
      }
      case 'servers': {
        if (!input.side || input.server === undefined || input.receiver === undefined) throw unprocessable('side, server and receiver are required', 'servers_required');
        // Nothing to change on the match itself: the choice is recorded in the action log and replayed.
        const game = (m.score as { currentGame?: number } | null)?.currentGame ?? 0;
        return { status: m.status, servingState: serving(cfg, m, points, { type: 'servers', side: input.side, server: input.server, receiver: input.receiver, game }) };
      }
      case 'pause':
        return { status: 'paused' };
      case 'resume':
        return { status: 'in_progress' };
      case 'submit': {
        const score = safeScore(cfg, points);
        if (!score.winner) throw unprocessable('Match has no winner yet', 'no_winner');
        return { status: 'completed', winner: score.winner, completedAt: now };
      }
      case 'retire': {
        // `side` is the side that retires; the other side wins. Games played still count.
        if (!input.side) throw unprocessable('side (the retiring side) is required', 'side_required');
        return { status: 'retired', winner: other(input.side), completedAt: now };
      }
    }
  }
}

/** Doubles service state after a command; the new command (if it is a 'servers' one) is included. */
function serving(cfg: ScoringConfig, m: NonNullable<LeanMatch>, points: Side[], extra?: { type: string; side?: Side; server?: number; receiver?: number; game?: number }) {
  const actions = [...(m.actions as { type: string; side?: Side; server?: number; receiver?: number; game?: number }[]), ...(extra ? [extra] : [])];
  try {
    return computeServing(cfg, points, serveSetupsFromActions(actions));
  } catch {
    return null;
  }
}

function safeScore(cfg: ScoringConfig, points: Side[]) {
  try {
    return computeScore(cfg, points);
  } catch (e) {
    if (e instanceof ScoringError) throw unprocessable(e.message, 'scoring_rule');
    throw e;
  }
}

/** Match number of another live match involving any player of this match, or null. */
export async function busyPlayersMatch(m: NonNullable<LeanMatch>): Promise<number | null> {
  const entries = await Entry.find({ _id: { $in: [m.entryAId, m.entryBId] } }).select('playerIds').lean();
  const playerIds = entries.flatMap((e) => e.playerIds);
  const related = await Entry.find({ playerIds: { $in: playerIds } }).select('_id').lean();
  const ids = related.map((e) => e._id);
  const busy = await Match.findOne({
    _id: { $ne: m._id },
    status: { $in: [...LIVE_STATUSES] },
    $or: [{ entryAId: { $in: ids } }, { entryBId: { $in: ids } }],
  })
    .select('matchNumber')
    .lean();
  return busy ? busy.matchNumber : null;
}
