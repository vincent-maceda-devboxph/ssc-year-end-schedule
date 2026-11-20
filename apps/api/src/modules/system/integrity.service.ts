import { computeScore, effectivePoints, isFinal, isLive, type ScoringConfig, type Side } from '@bt/shared';
import { Category, Court, Entry, Match, Player, Team, Tournament } from '../../models/index.js';

export interface IntegrityIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  entity?: string;
  id?: string;
}

/**
 * Read-only consistency check of everything the program stores: references that point nowhere,
 * double-booked courts and players, scores that disagree with their rally log, results without a winner.
 */
export async function checkIntegrity(tournamentId?: string): Promise<IntegrityIssue[]> {
  const issues: IntegrityIssue[] = [];
  const add = (severity: IntegrityIssue['severity'], code: string, message: string, entity?: string, id?: unknown) =>
    issues.push({ severity, code, message, entity, id: id ? String(id) : undefined });

  const scope = tournamentId ? { tournamentId } : {};
  const [tournaments, categories, teams, players, entries, courts, matches] = await Promise.all([
    Tournament.find(tournamentId ? { _id: tournamentId } : {}).select('_id').lean(),
    Category.find(scope).lean(),
    Team.find(scope).select('_id').lean(),
    Player.find(scope).select('_id tournamentId').lean(),
    Entry.find(scope).lean(),
    Court.find(scope).select('_id tournamentId').lean(),
    Match.find(scope).lean(),
  ]);
  const ids = (list: { _id: unknown }[]) => new Set(list.map((x) => String(x._id)));
  const tSet = ids(tournaments), cSet = ids(categories), teamSet = ids(teams), pSet = ids(players), eSet = ids(entries), courtSet = ids(courts);
  const entryById = new Map(entries.map((e) => [String(e._id), e]));
  const catById = new Map(categories.map((c) => [String(c._id), c]));

  // ---- entries ----
  const rankSeen = new Map<string, string>();
  for (const e of entries) {
    if (!tSet.has(String(e.tournamentId))) add('error', 'entry_tournament', `Pair "${e.displayName}" belongs to a tournament that does not exist`, 'entry', e._id);
    if (!cSet.has(String(e.categoryId))) add('error', 'entry_category', `Pair "${e.displayName}" belongs to a division that does not exist`, 'entry', e._id);
    if (e.teamId && !teamSet.has(String(e.teamId))) add('error', 'entry_team', `Pair "${e.displayName}" is on a team that does not exist`, 'entry', e._id);
    for (const p of e.playerIds) if (!pSet.has(String(p))) add('error', 'entry_player', `Pair "${e.displayName}" has a player that does not exist`, 'entry', e._id);
    if (e.status === 'active' && e.rank != null && e.teamId) {
      const k = `${e.categoryId}|${e.teamId}|${e.rank}`;
      if (rankSeen.has(k)) add('error', 'rank_duplicate', `Two pairs of one team share position ${e.rank} ("${e.displayName}" and "${rankSeen.get(k)}")`, 'entry', e._id);
      else rankSeen.set(k, e.displayName);
    }
  }

  // ---- matches ----
  const cells = new Map<string, string>();
  const playerSlots = new Map<string, string>();
  for (const m of matches) {
    const label = `#${m.matchNumber}`;
    if (!tSet.has(String(m.tournamentId))) add('error', 'match_tournament', `Match ${label} belongs to a tournament that does not exist`, 'match', m._id);
    if (!cSet.has(String(m.categoryId))) add('error', 'match_category', `Match ${label} belongs to a division that does not exist`, 'match', m._id);
    const a = m.entryAId ? entryById.get(String(m.entryAId)) : undefined;
    const b = m.entryBId ? entryById.get(String(m.entryBId)) : undefined;
    // A knockout side stays empty until its feeder match is decided; anywhere else, a missing pair is a problem.
    const waiting = m.bracketRound != null;
    if ((m.entryAId && !a) || (m.entryBId && !b) || (!waiting && (!a || !b))) add('error', 'match_entry', `Match ${label} refers to a pair that does not exist`, 'match', m._id);
    if (m.courtId && !courtSet.has(String(m.courtId))) add('error', 'match_court', `Match ${label} is on a court that does not exist`, 'match', m._id);
    for (const t of [m.teamAId, m.teamBId]) if (t && !teamSet.has(String(t))) add('error', 'match_team', `Match ${label} refers to a team that does not exist`, 'match', m._id);
    if (a && b && m.teamAId && a.teamId && String(a.teamId) !== String(m.teamAId)) add('warning', 'match_team_mismatch', `Match ${label}: the first pair is no longer on the match's team`, 'match', m._id);

    if (['completed', 'walkover', 'retired'].includes(m.status) && !m.winner) add('error', 'no_winner', `Match ${label} is finished but has no winner`, 'match', m._id);

    // The cached score must agree with the rally log (corrected results are replaced by hand, so skipped).
    if ((isLive(m.status as never) || isFinal(m.status as never)) && m.status !== 'cancelled' && m.status !== 'walkover' && !m.correctionCount && m.actions?.some((x) => x.type === 'point')) {
      try {
        const pts = effectivePoints(m.actions as never) as Side[];
        const calc = computeScore(m.scoring as unknown as ScoringConfig, pts);
        const cached = m.score as unknown as { gamesWon: { A: number; B: number }; pointsPlayed: number } | undefined;
        if (!cached || cached.pointsPlayed !== calc.pointsPlayed || cached.gamesWon.A !== calc.gamesWon.A || cached.gamesWon.B !== calc.gamesWon.B) {
          add('error', 'score_mismatch', `Match ${label}: the saved score does not match its point-by-point log`, 'match', m._id);
        }
      } catch {
        add('error', 'score_invalid', `Match ${label}: its point-by-point log is not valid`, 'match', m._id);
      }
    }

    // Double-booking: one court and time, one player and time (cancelled matches do not count).
    if (m.status !== 'cancelled' && m.plannedStart) {
      const when = m.plannedStart.getTime();
      if (m.courtId) {
        const k = `${m.courtId}@${when}`;
        if (cells.has(k)) add('error', 'court_double', `Matches ${cells.get(k)} and ${label} are on the same court at the same time`, 'match', m._id);
        else cells.set(k, label);
      }
      for (const p of [...(a?.playerIds ?? []), ...(b?.playerIds ?? [])]) {
        const k = `${p}@${when}`;
        if (playerSlots.has(k) && playerSlots.get(k) !== label) add('error', 'player_double', `A player is in matches ${playerSlots.get(k)} and ${label} at the same time`, 'match', m._id);
        else playerSlots.set(k, label);
      }
    }
  }

  // Live matches per court are also enforced by a database index; report if the data says otherwise.
  const liveByCourt = new Map<string, string>();
  for (const m of matches.filter((x) => isLive(x.status as never) && x.courtId)) {
    const k = String(m.courtId);
    if (liveByCourt.has(k)) add('error', 'court_two_live', `Two live matches on one court (#${liveByCourt.get(k)} and #${m.matchNumber})`, 'match', m._id);
    else liveByCourt.set(k, String(m.matchNumber));
  }

  return issues;
}
