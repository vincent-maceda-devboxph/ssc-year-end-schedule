import type { MatchStatus } from './match-status.js';
import type { CourtStatus } from './schedule-moves.js';
import type { ScheduleIssue } from './schedule-types.js';
import type { ScoreState, ScoringConfig, Side } from './scoring.js';
import type { PlayerIdx } from './serving.js';

/** Who serves and receives in a live doubles match, with the players' names. */
export interface MatchServing {
  side: Side;
  server: PlayerIdx;
  receiver: PlayerIdx;
  right: Record<Side, PlayerIdx>;
  confirmed: boolean;
  /** Each side's two players, in the order used by the indexes above. */
  players: Record<Side, [string, string]>;
  serverName: string;
  receiverName: string;
}

export type Role = 'super_admin' | 'tournament_admin';

export interface AdminUser {
  id: string;
  username: string;
  role: Role;
}

export interface UmpireSession {
  courtId: string;
  courtName: string;
  tournamentId: string;
  name: string;
}

export interface MeResponse {
  admin: AdminUser | null;
  umpire: UmpireSession | null;
}

export interface TournamentDto {
  id: string;
  name: string;
  date: string;
  venue: string;
  status: 'draft' | 'active' | 'completed' | 'archived';
}

export interface CategoryDto {
  id: string;
  tournamentId: string;
  name: string;
  discipline: 'doubles' | 'singles';
  playersPerEntry: number;
  scoring: ScoringConfig;
  format: 'team_round_robin' | 'round_robin' | 'knockout' | 'manual';
  priority: number;
  allowSameTeam: boolean;
  /** Short code used in labels: "MD" for Men's Doubles. */
  code: string;
  /** Knockout: the group-stage division its qualifiers come from. */
  sourceCategoryId: string | null;
  thirdPlace: boolean;
}

export interface TeamDto {
  id: string;
  tournamentId: string;
  name: string;
  color: string;
  captainPlayerId: string | null;
  status: 'active' | 'withdrawn';
  /** Address of the team's logo image, or null. */
  logoUrl: string | null;
}

export interface TeamRef {
  id: string;
  name: string;
  color: string;
  logoUrl: string | null;
}

export interface GenerateMatchesResult {
  created: number;
  /** Not-started generated matches removed because replace was set. */
  deleted: number;
  /** Matchups that already existed (kept, not duplicated). */
  skipped: number;
  problems: string[];
}

export interface LineupImportResult {
  dryRun: boolean;
  teamsCreated: string[];
  categoriesCreated: string[];
  playersCreated: number;
  pairsCreated: number;
  /** Rows that were already registered exactly the same way. */
  unchanged: number;
  /** Row-level problems; nothing is written when there are any. */
  errors: { row: number; message: string }[];
}

export interface StandingsResponse {
  teams: import('./standings.js').TeamStanding[];
  categories: { id: string; name: string; pairs: import('./standings.js').PairStanding[] }[];
}

export interface PlayerDto {
  id: string;
  tournamentId: string;
  firstName: string;
  lastName: string;
  gender?: 'M' | 'F' | 'X';
  club: string;
  teamId: string | null;
}

export interface EntryDto {
  id: string;
  tournamentId: string;
  categoryId: string;
  playerIds: string[];
  displayName: string;
  seed: number | null;
  status: 'active' | 'withdrawn';
  teamId: string | null;
  /** Position within the team's list for this division (1 = first). The level label MD-A is rank 1. */
  rank: number | null;
  /** Group in a group stage ("A"), or empty. */
  group: string;
}

export interface CourtDto {
  id: string;
  tournamentId: string;
  name: string;
  order: number;
  active: boolean;
  hasCode: boolean;
  /** Live status derived from the matches on the court. */
  status?: CourtStatus;
  /** Optional window in which the court may be used (ISO, UTC). */
  availableFrom: string | null;
  availableUntil: string | null;
}

export interface AdminUserDto {
  id: string;
  username: string;
  role: Role;
  active: boolean;
  createdAt: string;
}

export interface MoveMatchResult {
  ok: boolean;
  /** The match after the move (null for a dry run or when blocked). */
  match: MatchDto | null;
  /** The match it was swapped with, if any. */
  swapped: MatchDto | null;
  /** Hard-rule problems: the move was refused. */
  blocked: ScheduleIssue[];
  /** Soft-rule problems: allowed once the admin confirms. */
  warnings: ScheduleIssue[];
}

/** Match as sent to every client (spectators included). No session ids or action log. */
export interface MatchDto {
  id: string;
  tournamentId: string;
  categoryId: string;
  categoryName: string;
  matchNumber: number;
  round: string;
  entryA: { id: string; name: string };
  entryB: { id: string; name: string };
  /** Teams of the two pairs (team events), with colours for display. */
  teamA: TeamRef | null;
  teamB: TeamRef | null;
  /** Round within the team round robin (generated matches). */
  roundNumber: number | null;
  /** Pair position this match is for (1 = first pair of each team); null for manual/open matches. */
  rank: number | null;
  /** Label for display: "MD-A" for rank 1 of Men's Doubles, "MSK Semifinal" in a knockout, else the division name. */
  bracket: string;
  /** Place in a knockout bracket; null for other matches. */
  stage: { round: number; pos: number; roundLabel: string; third: boolean } | null;
  courtId: string | null;
  courtName: string | null;
  queuePosition: number;
  status: MatchStatus;
  scoring: ScoringConfig;
  score: ScoreState;
  /** Doubles only, while the match is live: who serves and receives right now. null otherwise. */
  serving: MatchServing | null;
  winner: Side | null;
  umpireName: string | null;
  /** Short hash of the controlling umpire session, so an umpire's phone can tell whether it is in control. */
  umpireKey: string | null;
  startedAt: string | null;
  completedAt: string | null;
  version: number;
  updatedAt: string;
  /** Planned time from the published schedule (ISO, UTC); null when not scheduled. */
  plannedStart: string | null;
  plannedEnd: string | null;
  /** Game number printed on the schedule sheet. */
  gameNumber: number | null;
  isLocked: boolean;
  /** How many times an admin corrected the finished result. */
  corrections: number;
}

export interface CommandResult {
  /** true when this exact actionId had already been applied (duplicate retry). */
  duplicate: boolean;
  match: MatchDto;
}

export interface ApiError {
  error: { code: string; message: string; details?: unknown };
  /** Present on 409 version conflicts so the client can resync without another request. */
  match?: MatchDto;
}

export interface UmpireCurrentResponse {
  court: { id: string; name: string };
  /** The match the umpire should be looking at: live match on the court, else the next queued one. */
  match: MatchDto | null;
  /** Matches queued after it on this court. */
  upcoming: MatchDto[];
  /** This session's umpireKey; compare with match.umpireKey. */
  myKey: string;
}

export interface SystemInfo {
  urls: string[];
  version: string;
}

/** Socket.IO events (server → client). Every match event carries the full MatchDto. */
export const MATCH_EVENTS = [
  'score:updated',
  'match:started',
  'match:paused',
  'match:resumed',
  'match:completed',
  'match:corrected',
  'match:changed',
  'match:called',
] as const;
export type MatchEvent = (typeof MATCH_EVENTS)[number];

export interface UmpirePresence {
  courtId: string;
  name: string;
  connected: boolean;
}

// ---------------------------------------------------------------- reports
export interface ReportMatchRow {
  matchNumber: number;
  gameNumber: number | null;
  bracket: string;
  courtName: string;
  start: string | null;
  teamA: string;
  pairA: string;
  teamB: string;
  pairB: string;
  score: string;
  winner: string;
  status: string;
  umpire: string;
  minutes: number | null;
  corrected: boolean;
}

export interface ReportPairRow {
  name: string;
  team: string;
  bracket: string;
  played: number;
  won: number;
  lost: number;
  gamesWon: number;
  gamesLost: number;
  pointsFor: number;
  pointsAgainst: number;
}

export interface ReportDto {
  tournament: { id: string; name: string; date: string; venue: string; status: string };
  generatedAt: string;
  totals: {
    matches: number;
    finished: number;
    completed: number;
    walkover: number;
    retired: number;
    cancelled: number;
    notStarted: number;
    live: number;
    corrected: number;
    games: number;
    rallyPoints: number;
    avgMinutes: number | null;
    longestMinutes: number | null;
  };
  teams: import('./standings.js').TeamStanding[];
  divisions: { id: string; name: string; code: string; rows: ReportMatchRow[] }[];
  pairs: ReportPairRow[];
  umpires: { name: string; matches: number }[];
  corrections: { matchNumber: number; bracket: string; at: string; by: string; reason: string; before: unknown; after: unknown }[];
}
