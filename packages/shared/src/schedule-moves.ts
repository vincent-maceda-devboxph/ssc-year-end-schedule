/**
 * Manual schedule edits (drag and drop). Pure, so the server decides and the UI can reuse the wording.
 *
 * BLOCKED (never allowed): a player in two matches at once, a court double-booked, a court that is
 * unavailable, a time after the end of play, an occupied cell without a swap.
 * WARNING (allowed after the admin confirms): less than the minimum rest between a player's matches.
 */
import { findConflicts, type Conflict, type EngineCourt, type EngineMatch, type Placement } from './schedule-engine.js';

export interface MoveRequest {
  matchId: string;
  slot: number;
  /** Index into the courts array. */
  court: number;
  /** Match currently in the target cell to exchange places with. */
  swapWith?: string | null;
}

export interface MoveIssue {
  type: Conflict['type'] | 'cell_occupied' | 'bad_target' | 'swap_mismatch';
  message: string;
  matchIds: string[];
  playerId?: string;
}

export interface MoveCheck {
  blocked: MoveIssue[];
  warnings: MoveIssue[];
  /** The grid as it would be after the move (only meaningful when nothing is blocked). */
  placements: Placement[];
}

const HARD = new Set<MoveIssue['type']>(['player_overlap', 'court_double', 'court_unavailable', 'out_of_range', 'dependency']);

export function checkMove(
  courts: readonly EngineCourt[],
  matches: readonly Pick<EngineMatch, 'id' | 'playerIds' | 'after'>[],
  placements: readonly Placement[],
  move: MoveRequest,
  minRestSlots: number,
  slotCount: number | null,
): MoveCheck {
  const stay = (blocked: MoveIssue[]): MoveCheck => ({ blocked, warnings: [], placements: [...placements] });

  if (!Number.isInteger(move.slot) || move.slot < 0 || move.court < 0 || move.court >= courts.length) {
    return stay([{ type: 'bad_target', message: 'That is not a valid court or time', matchIds: [move.matchId] }]);
  }
  const from = placements.find((p) => p.matchId === move.matchId) ?? null;
  const occupant = placements.find((p) => p.matchId !== move.matchId && p.slot === move.slot && p.court === move.court) ?? null;

  if (occupant && !move.swapWith) {
    return stay([{ type: 'cell_occupied', message: 'That slot already has a match', matchIds: [move.matchId, occupant.matchId] }]);
  }
  if (move.swapWith && (!occupant || occupant.matchId !== move.swapWith)) {
    return stay([{ type: 'swap_mismatch', message: 'The match to swap with is no longer in that slot', matchIds: [move.matchId, move.swapWith] }]);
  }
  if (move.swapWith && !from) {
    return stay([{ type: 'swap_mismatch', message: 'Only a match that already has a time can be swapped', matchIds: [move.matchId] }]);
  }

  const touched = new Set([move.matchId, ...(occupant && move.swapWith ? [occupant.matchId] : [])]);
  const next: Placement[] = placements.filter((p) => !touched.has(p.matchId));
  next.push({ matchId: move.matchId, slot: move.slot, court: move.court });
  if (occupant && move.swapWith && from) next.push({ matchId: occupant.matchId, slot: from.slot, court: from.court });

  // Only problems that involve the moved matches count; unrelated old problems must not block an edit.
  const found = findConflicts(courts, matches, next, minRestSlots, slotCount).filter((c) => c.matchIds.some((id) => touched.has(id)));
  const issues: MoveIssue[] = found.map((c) => ({ type: c.type, message: c.message, matchIds: c.matchIds, playerId: c.playerId }));
  return {
    blocked: issues.filter((i) => HARD.has(i.type)),
    warnings: issues.filter((i) => !HARD.has(i.type)),
    placements: next,
  };
}

export type CourtStatus = 'available' | 'scheduled' | 'called' | 'ongoing' | 'completed' | 'unavailable';

/** Live status of a court from the matches on it (cancelled matches should be left out by the caller). */
export function courtStatus(active: boolean, matchStatuses: readonly string[]): CourtStatus {
  if (!active) return 'unavailable';
  if (matchStatuses.some((s) => s === 'in_progress' || s === 'paused' || s === 'awaiting_confirmation')) return 'ongoing';
  if (matchStatuses.includes('called')) return 'called';
  if (matchStatuses.some((s) => s === 'pending' || s === 'scheduled' || s === 'ready')) return 'scheduled';
  if (matchStatuses.some((s) => s === 'completed' || s === 'walkover' || s === 'retired')) return 'completed';
  return 'available';
}

export const COURT_STATUS_LABELS: Record<CourtStatus, string> = {
  available: 'Available',
  scheduled: 'Scheduled',
  called: 'Called',
  ongoing: 'Ongoing',
  completed: 'Completed',
  unavailable: 'Unavailable',
};
