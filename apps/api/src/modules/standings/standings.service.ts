import { computePairStandings, computeTeamStandings, type StandingsResponse } from '@bt/shared';
import { Category, Entry, Match, Team } from '../../models/index.js';
import { logoUrl } from '../dto.js';

/** Team standings (1 point per match won) plus pair standings per category. Computed on request. */
export async function getStandings(tournamentId: string): Promise<StandingsResponse> {
  const [teams, categories, entries, matches] = await Promise.all([
    Team.find({ tournamentId }).lean(),
    Category.find({ tournamentId }).sort({ priority: 1, name: 1 }).lean(),
    Entry.find({ tournamentId }).lean(),
    Match.find({ tournamentId, status: { $in: ['completed', 'walkover', 'retired'] } })
      .select('categoryId entryAId entryBId teamAId teamBId status winner score.games')
      .lean(),
  ]);

  const rows = matches.map((m) => ({
    categoryId: String(m.categoryId),
    entryAId: String(m.entryAId),
    entryBId: String(m.entryBId),
    teamAId: m.teamAId ? String(m.teamAId) : null,
    teamBId: m.teamBId ? String(m.teamBId) : null,
    status: m.status,
    winner: (m.winner ?? null) as 'A' | 'B' | null,
    games: ((m.score as { games?: { a: number; b: number; winner: 'A' | 'B' | null }[] })?.games ?? []),
  }));

  return {
    teams: computeTeamStandings(
      teams.map((t) => ({ id: String(t._id), name: t.name, color: t.color ?? '#e0e0e0', logoUrl: logoUrl(t) })),
      rows,
    ),
    categories: categories.flatMap((c) => {
      const inDivision = entries.filter((e) => String(e.categoryId) === String(c._id) && e.status === 'active');
      if (!inDivision.length) return []; // e.g. a knockout division: its entries live in the group stage
      // A division with groups gets one table per group (a group's table only counts matches inside the group).
      const groups = [...new Set(inDivision.map((e) => e.group || ''))].sort();
      return groups.map((g) => {
        const members = inDivision.filter((e) => (e.group || '') === g);
        const ids = new Set(members.map((e) => String(e._id)));
        const pairs = members.map((e) => ({ id: String(e._id), name: e.displayName, teamId: e.teamId ? String(e.teamId) : null }));
        return {
          id: g ? `${c._id}:${g}` : String(c._id),
          name: g ? `${c.name} · Group ${g}` : c.name,
          pairs: computePairStandings(pairs, rows.filter((r) => r.categoryId === String(c._id) && ids.has(r.entryAId) && ids.has(r.entryBId))),
        };
      });
    }),
  };
}
