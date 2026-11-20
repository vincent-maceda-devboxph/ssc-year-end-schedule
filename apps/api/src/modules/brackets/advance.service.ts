import type { Side } from '@bt/shared';
import { Match } from '../../models/index.js';
import type { Broadcaster } from '../../sockets/index.js';
import { conflict } from '../../utils/errors.js';
import { MATCH_POPULATE, matchDto } from '../dto.js';

/** A knockout match that has not started can still take a different opponent. */
const OPEN = ['pending', 'scheduled', 'ready'];

type Lean = NonNullable<Awaited<ReturnType<typeof load>>>;
const load = (id: unknown) => Match.findById(id).lean();

/**
 * When a knockout match has a winner, the winner moves into the next round and (for a semifinal) the
 * loser into the third-place match. Safe to call again after a correction: it overwrites the same side.
 */
export async function advanceFromMatch(matchId: string, broadcaster: Broadcaster): Promise<void> {
  const m = await load(matchId);
  if (!m || (!m.advancesToMatchId && !m.loserToMatchId)) return;
  if (!['completed', 'walkover', 'retired'].includes(m.status) || !m.winner) return;

  const winnerEntry = m.winner === 'A' ? m.entryAId : m.entryBId;
  const loserEntry = m.winner === 'A' ? m.entryBId : m.entryAId;
  const moves = [
    { to: m.advancesToMatchId, slot: m.advancesToSlot, entry: winnerEntry },
    { to: m.loserToMatchId, slot: m.loserToSlot, entry: loserEntry },
  ];
  for (const mv of moves) {
    if (!mv.to || !mv.slot || !mv.entry) continue;
    const field = mv.slot === 'A' ? 'entryAId' : 'entryBId';
    const updated = await Match.findOneAndUpdate(
      { _id: mv.to, status: { $in: OPEN }, [field]: { $ne: mv.entry } },
      { $set: { [field]: mv.entry }, $inc: { version: 1 } },
      { new: true },
    )
      .populate(MATCH_POPULATE)
      .lean();
    if (updated) broadcaster.match('match:changed', matchDto(updated));
  }
}

/**
 * Decision D7: a correction that changes the winner of a knockout match is only allowed while the match
 * the winner advanced to (and the third-place match, for a semifinal) has not started.
 */
export async function assertWinnerChangeAllowed(m: Lean, newWinner: Side | null): Promise<void> {
  if (!m.advancesToMatchId && !m.loserToMatchId) return;
  if (newWinner === (m.winner ?? null)) return; // the same side advances: nothing moves
  for (const id of [m.advancesToMatchId, m.loserToMatchId]) {
    if (!id) continue;
    const next = await load(id);
    if (next && !OPEN.includes(next.status)) {
      throw conflict(
        `The winner already moved on and match #${next.matchNumber} (${next.round}) has ${next.status === 'called' ? 'been called' : 'started or finished'}. Change that match first, then correct this one.`,
        'downstream_started',
      );
    }
  }
}
