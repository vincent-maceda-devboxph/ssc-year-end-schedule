import crypto from 'node:crypto';
import {
  bracketLabel,
  divisionCode,
  type CategoryDto,
  type CourtDto,
  type EntryDto,
  type MatchDto,
  type MatchServing,
  type PlayerDto,
  type ServingState,
  type TeamDto,
  type TeamRef,
  type TournamentDto,
} from '@bt/shared';

/* Mappers from lean Mongo documents to API DTOs. Keep secrets (code hashes, session ids) out of here. */

type Id = { toString(): string };
type Doc = { _id: Id } & Record<string, any>;

export const tournamentDto = (t: Doc): TournamentDto => ({
  id: String(t._id),
  name: t.name,
  date: t.date ?? '',
  venue: t.venue ?? '',
  status: t.status,
});

export const categoryDto = (c: Doc): CategoryDto => ({
  id: String(c._id),
  tournamentId: String(c.tournamentId),
  name: c.name,
  discipline: c.discipline,
  playersPerEntry: c.playersPerEntry,
  scoring: {
    gamesToWin: c.scoring.gamesToWin,
    pointsToWin: c.scoring.pointsToWin,
    winBy: c.scoring.winBy,
    cap: c.scoring.cap ?? null,
    intervalAt: c.scoring.intervalAt ?? null,
    changeEndsInDecider: c.scoring.changeEndsInDecider,
  },
  format: c.format ?? 'round_robin',
  priority: c.priority ?? 100,
  allowSameTeam: c.allowSameTeam ?? false,
  code: c.code || divisionCode(c.name ?? ''),
  sourceCategoryId: c.sourceCategoryId ? String(c.sourceCategoryId) : null,
  thirdPlace: c.thirdPlace ?? true,
});

/** Cache-busted address of a team's logo (the version is the upload time). */
export const logoUrl = (t: any): string | null => (t?.logoAt ? `/api/teams/${String(t._id)}/logo?v=${new Date(t.logoAt).getTime()}` : null);

export const teamDto = (t: Doc): TeamDto => ({
  id: String(t._id),
  tournamentId: String(t.tournamentId),
  name: t.name,
  color: t.color ?? '#e0e0e0',
  captainPlayerId: t.captainPlayerId ? String(t.captainPlayerId) : null,
  status: t.status ?? 'active',
  logoUrl: logoUrl(t),
});

export const playerDto = (p: Doc): PlayerDto => ({
  id: String(p._id),
  tournamentId: String(p.tournamentId),
  firstName: p.firstName,
  lastName: p.lastName,
  gender: p.gender,
  club: p.club ?? '',
  teamId: p.teamId ? String(p.teamId) : null,
});

export const entryDto = (e: Doc): EntryDto => ({
  id: String(e._id),
  tournamentId: String(e.tournamentId),
  categoryId: String(e.categoryId),
  playerIds: (e.playerIds ?? []).map(String),
  displayName: e.displayName,
  seed: e.seed ?? null,
  status: e.status,
  teamId: e.teamId ? String(e.teamId) : null,
  rank: e.rank ?? null,
  group: e.group ?? '',
});

export const courtDto = (c: Doc): CourtDto => ({
  id: String(c._id),
  tournamentId: String(c.tournamentId),
  name: c.name,
  order: c.order ?? 0,
  active: c.active,
  hasCode: Boolean(c.codeHash),
  availableFrom: c.availableFrom ? new Date(c.availableFrom).toISOString() : null,
  availableUntil: c.availableUntil ? new Date(c.availableUntil).toISOString() : null,
});

export const umpireKey = (sessionId: string) =>
  crypto.createHash('sha256').update(sessionId).digest('base64url').slice(0, 12);

const teamRef = (t: any): TeamRef | null =>
  t && typeof t === 'object' && '_id' in t ? { id: String(t._id), name: t.name, color: t.color ?? '#e0e0e0', logoUrl: logoUrl(t) } : null;

const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : d ? String(d) : null);
const refId = (v: any) => (v && typeof v === 'object' && '_id' in v ? String(v._id) : v ? String(v) : null);

/** Doubles only, while live: replay the match log into who serves and receives. */
function servingOf(m: Doc): MatchServing | null {
  if (!['in_progress', 'paused', 'awaiting_confirmation'].includes(m.status)) return null;
  const names = (e: any): [string, string] | null => {
    const parts = String(e?.displayName ?? '').split(' / ').map((s) => s.trim());
    return parts.length === 2 && parts[0] && parts[1] ? [parts[0], parts[1]] : null;
  };
  const a = names(m.entryAId);
  const b = names(m.entryBId);
  if (!a || !b) return null; // singles (or names that are not two players)
  // Kept up to date by every scoring command; lists do not load the action log.
  const s = m.servingState as ServingState | null | undefined;
  if (!s) return null;
  const players = { A: a, B: b };
  return { ...s, players, serverName: players[s.side][s.server], receiverName: players[s.side === 'A' ? 'B' : 'A'][s.receiver] };
}

/** Expects entryAId, entryBId, courtId and categoryId populated (see MATCH_POPULATE). */
export const matchDto = (m: Doc): MatchDto => ({
  id: String(m._id),
  tournamentId: String(m.tournamentId),
  categoryId: refId(m.categoryId)!,
  categoryName: m.categoryId?.name ?? '',
  rank: m.rank ?? null,
  bracket:
    m.bracketRound != null
      ? `${m.categoryId?.code || divisionCode(m.categoryId?.name ?? '')} ${m.isThirdPlace ? 'Third place' : m.round}`
      : bracketLabel(m.categoryId?.code || divisionCode(m.categoryId?.name ?? ''), m.categoryId?.name ?? '', m.rank ?? null),
  stage: m.bracketRound != null ? { round: m.bracketRound, pos: m.bracketPos ?? 0, roundLabel: m.isThirdPlace ? 'Third place' : m.round, third: !!m.isThirdPlace } : null,
  matchNumber: m.matchNumber,
  round: m.round ?? '',
  // A knockout side that is not decided yet shows as "TBD".
  entryA: { id: refId(m.entryAId) ?? '', name: m.entryAId?.displayName ?? (m.bracketRound != null ? 'TBD' : '?') },
  entryB: { id: refId(m.entryBId) ?? '', name: m.entryBId?.displayName ?? (m.bracketRound != null ? 'TBD' : '?') },
  teamA: teamRef(m.teamAId),
  teamB: teamRef(m.teamBId),
  roundNumber: m.roundNumber ?? null,
  courtId: refId(m.courtId),
  courtName: m.courtId?.name ?? null,
  queuePosition: m.queuePosition ?? 0,
  status: m.status,
  scoring: categoryDto({ _id: '', scoring: m.scoring } as Doc).scoring,
  score: m.score,
  serving: servingOf(m),
  winner: m.winner ?? null,
  umpireName: m.umpire?.name ?? null,
  umpireKey: m.umpire?.sessionId ? umpireKey(m.umpire.sessionId) : null,
  startedAt: iso(m.startedAt),
  completedAt: iso(m.completedAt),
  version: m.version,
  updatedAt: iso(m.updatedAt) ?? new Date().toISOString(),
  plannedStart: iso(m.plannedStart),
  plannedEnd: iso(m.plannedEnd),
  gameNumber: m.gameNumber ?? null,
  isLocked: m.isLocked ?? false,
  corrections: m.correctionCount ?? 0,
});

export const MATCH_POPULATE = [
  { path: 'entryAId', select: 'displayName' },
  { path: 'entryBId', select: 'displayName' },
  { path: 'courtId', select: 'name' },
  { path: 'categoryId', select: 'name code' },
  { path: 'teamAId', select: 'name color logoAt' },
  { path: 'teamBId', select: 'name color logoAt' },
];
