/** Match status flow (docs/decisions.md D4). */

export const MATCH_STATUSES = [
  'pending',
  'scheduled',
  'ready',
  /** Players and umpire have been summoned to the court; the umpire can now start the match. */
  'called',
  'in_progress',
  'paused',
  'awaiting_confirmation',
  'completed',
  'walkover',
  'retired',
  'cancelled',
] as const;
export type MatchStatus = (typeof MATCH_STATUSES)[number];

export const FINAL_STATUSES: readonly MatchStatus[] = ['completed', 'walkover', 'retired', 'cancelled'];
/** Statuses in which a match occupies its court and its players. */
export const LIVE_STATUSES: readonly MatchStatus[] = ['in_progress', 'paused', 'awaiting_confirmation'];
export const STARTABLE_STATUSES: readonly MatchStatus[] = ['scheduled', 'ready', 'called'];
/** Matches the scheduler or an admin may still move to another court or time. */
export const MOVABLE_STATUSES: readonly MatchStatus[] = ['pending', 'scheduled', 'ready'];

export const isFinal = (s: MatchStatus) => FINAL_STATUSES.includes(s);
export const isLive = (s: MatchStatus) => LIVE_STATUSES.includes(s);

/** Commands an umpire (or admin acting on a court) sends while running a match. */
export const MATCH_COMMANDS = ['start', 'point', 'undo', 'pause', 'resume', 'submit', 'retire', 'servers'] as const;
export type MatchCommand = (typeof MATCH_COMMANDS)[number];

/** Which commands are allowed in which status. Score-dependent rules (e.g. undo needs a point) are checked separately. */
export const COMMANDS_BY_STATUS: Record<MatchStatus, readonly MatchCommand[]> = {
  pending: [],
  scheduled: ['start'],
  ready: ['start'],
  called: ['start'],
  in_progress: ['point', 'undo', 'pause', 'retire', 'servers'],
  paused: ['resume', 'retire', 'servers'],
  awaiting_confirmation: ['undo', 'submit'],
  completed: [],
  walkover: [],
  retired: [],
  cancelled: [],
};

export function canRunCommand(status: MatchStatus, command: MatchCommand): boolean {
  return COMMANDS_BY_STATUS[status].includes(command);
}

export const STATUS_LABELS: Record<MatchStatus, string> = {
  pending: 'Pending',
  scheduled: 'Scheduled',
  ready: 'Ready',
  called: 'Called',
  in_progress: 'In progress',
  paused: 'Paused',
  awaiting_confirmation: 'Awaiting confirmation',
  completed: 'Completed',
  walkover: 'Walkover',
  retired: 'Retired',
  cancelled: 'Cancelled',
};
