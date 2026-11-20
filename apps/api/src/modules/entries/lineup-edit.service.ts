import { Entry, Match, Player } from '../../models/index.js';
import type { Broadcaster } from '../../sockets/index.js';
import { conflict } from '../../utils/errors.js';
import { MATCH_POPULATE, matchDto } from '../dto.js';

/** Matches in these states are being played right now: their pairs must not change under the umpire. */
const LIVE = ['in_progress', 'paused', 'awaiting_confirmation'];
const OVER = ['completed', 'walkover', 'retired', 'cancelled'];

export const nameOf = (p: { firstName: string; lastName?: string | null }) => `${p.firstName} ${p.lastName ?? ''}`.trim();

/** A pair cannot be changed while one of its matches is on court. */
export async function assertNotLive(entryIds: unknown[]): Promise<void> {
  const live = await Match.findOne({ status: { $in: LIVE }, $or: [{ entryAId: { $in: entryIds } }, { entryBId: { $in: entryIds } }] }).select('matchNumber').lean();
  if (live) throw conflict(`Match #${live.matchNumber} is being played. Change the pair after it finishes.`, 'match_live');
}

/** Pair name from its players, in order ("Ana Cruz / Bea Lim"). */
export async function displayNameOf(playerIds: unknown[]): Promise<string> {
  const players = await Player.find({ _id: { $in: playerIds } }).lean();
  return playerIds.map((id) => players.find((p) => String(p._id) === String(id))).filter(Boolean).map((p) => nameOf(p!)).join(' / ');
}

/** Tell watching screens that these matches changed (new names / new pair). */
export async function broadcastMatches(broadcaster: Broadcaster, filter: Record<string, unknown>): Promise<void> {
  const list = await Match.find(filter).populate(MATCH_POPULATE).lean();
  for (const m of list) broadcaster.match('match:changed', matchDto(m));
  if (list.length) broadcaster.tournament(String(list[0]!.tournamentId), 'schedule:updated', { tournamentId: String(list[0]!.tournamentId) });
}

/**
 * After a team's list changed (two pairs swapped places), point the matches that have not started at the
 * pair now standing in their position. The matches keep their court and time: the published schedule
 * does not move. Finished and live matches keep the pairs that actually played.
 */
export async function resyncTeamMatches(categoryId: unknown, teamId: unknown, broadcaster: Broadcaster): Promise<number> {
  const pending = await Match.find({
    categoryId,
    rank: { $type: 'number' },
    status: { $nin: [...LIVE, ...OVER] },
    $or: [{ teamAId: teamId }, { teamBId: teamId }],
  })
    .select('rank teamAId entryAId entryBId')
    .lean();
  const entries = await Entry.find({ categoryId, teamId, status: 'active', rank: { $type: 'number' } }).select('rank').lean();
  const byRank = new Map(entries.map((e) => [e.rank!, e._id]));
  const changed: unknown[] = [];
  for (const m of pending) {
    const entryId = byRank.get(m.rank!);
    if (!entryId) continue;
    const side = String(m.teamAId) === String(teamId) ? 'entryAId' : 'entryBId';
    if (String(m[side]) === String(entryId)) continue;
    await Match.updateOne({ _id: m._id }, { $set: { [side]: entryId }, $inc: { version: 1 } });
    changed.push(m._id);
  }
  if (changed.length) await broadcastMatches(broadcaster, { _id: { $in: changed } });
  return changed.length;
}
