import { LIVE_STATUSES } from '@bt/shared';
import { Match } from '../../models/index.js';
import type { Broadcaster } from '../../sockets/index.js';
import { MATCH_POPULATE, matchDto } from '../dto.js';
import { busyPlayersMatch } from '../scoring/scoring.service.js';

/**
 * "Ready" = the next match on a court that is free: it is scheduled there, nothing is live, called or
 * already ready on that court, and none of its players is still in a live match (decisions D4).
 * Called when a match on the court finishes (result submitted, retirement, walkover, cancellation).
 */
export async function promoteNextOnCourt(courtId: string | null | undefined, broadcaster: Broadcaster): Promise<void> {
  if (!courtId) return;
  if (await Match.exists({ courtId, status: { $in: ['ready', 'called', ...LIVE_STATUSES] } })) return;
  const next = await Match.findOne({ courtId, status: 'scheduled', plannedStart: { $ne: null } }).sort({ plannedStart: 1, matchNumber: 1 }).lean();
  if (!next) return;
  if ((await busyPlayersMatch(next)) !== null) return;
  const updated = await Match.findOneAndUpdate({ _id: next._id, version: next.version, status: 'scheduled' }, { $set: { status: 'ready' }, $inc: { version: 1 } }, { new: true })
    .populate(MATCH_POPULATE)
    .lean();
  if (updated) broadcaster.match('match:changed', matchDto(updated));
}
