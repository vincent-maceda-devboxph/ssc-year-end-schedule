import ExcelJS from 'exceljs';
import {
  bracketLabel,
  computePairStandings,
  computeTeamStandings,
  divisionCode,
  formatGames,
  type ReportDto,
  type ReportMatchRow,
  type ReportPairRow,
  type StandingMatch,
} from '@bt/shared';
import { AuditLog, Category, Court, Entry, Match, Team, Tournament } from '../../models/index.js';
import { notFound } from '../../utils/errors.js';

const FINISHED = ['completed', 'walkover', 'retired'];

type Games = { a: number; b: number; winner: 'A' | 'B' | null }[];

/** Everything an organiser wants after (or during) the event, computed from the saved matches. */
export async function buildReport(tournamentId: string): Promise<ReportDto> {
  const t = await Tournament.findById(tournamentId).lean();
  if (!t) throw notFound('Tournament');
  const [teams, categories, entries, courts, matches, corrections] = await Promise.all([
    Team.find({ tournamentId }).lean(),
    Category.find({ tournamentId }).sort({ priority: 1, name: 1 }).lean(),
    Entry.find({ tournamentId }).lean(),
    Court.find({ tournamentId }).select('name').lean(),
    Match.find({ tournamentId }).select('-actions').sort({ matchNumber: 1 }).lean(),
    AuditLog.find({ tournamentId, action: 'correct_result' }).sort({ createdAt: -1 }).limit(200).lean(),
  ]);
  const teamName = new Map(teams.map((x) => [String(x._id), x.name]));
  const catById = new Map(categories.map((c) => [String(c._id), c]));
  const entryById = new Map(entries.map((e) => [String(e._id), e]));
  const courtName = new Map(courts.map((c) => [String(c._id), c.name]));
  const label = (categoryId: unknown, rank: number | null | undefined) => {
    const c = catById.get(String(categoryId));
    return c ? bracketLabel(c.code || divisionCode(c.name), c.name, rank ?? null) : '';
  };

  const rowFor = (m: (typeof matches)[number]): ReportMatchRow => {
    const a = m.entryAId ? entryById.get(String(m.entryAId)) : undefined;
    const b = m.entryBId ? entryById.get(String(m.entryBId)) : undefined;
    const games = ((m.score as { games?: Games } | undefined)?.games ?? []) as Games;
    const minutes = m.status === 'completed' && m.startedAt && m.completedAt ? Math.max(0, Math.round((m.completedAt.getTime() - m.startedAt.getTime()) / 60000)) : null;
    return {
      matchNumber: m.matchNumber,
      gameNumber: m.gameNumber ?? null,
      bracket: label(m.categoryId, m.rank),
      courtName: m.courtId ? courtName.get(String(m.courtId)) ?? '' : '',
      start: m.plannedStart ? m.plannedStart.toISOString() : null,
      teamA: m.teamAId ? teamName.get(String(m.teamAId)) ?? '' : '',
      pairA: a?.displayName ?? (m.bracketRound != null ? 'TBD' : '?'),
      teamB: m.teamBId ? teamName.get(String(m.teamBId)) ?? '' : '',
      pairB: b?.displayName ?? (m.bracketRound != null ? 'TBD' : '?'),
      score: m.status === 'walkover' ? 'W/O' : formatGames(games) + (m.status === 'retired' ? ' ret.' : ''),
      winner: m.winner === 'A' ? a?.displayName ?? '' : m.winner === 'B' ? b?.displayName ?? '' : '',
      status: m.status.replace(/_/g, ' '),
      umpire: m.umpire?.name ?? '',
      minutes,
      corrected: (m.correctionCount ?? 0) > 0,
    };
  };

  const standingRows: StandingMatch[] = matches
    .filter((m) => FINISHED.includes(m.status) && m.winner)
    .map((m) => ({
      categoryId: String(m.categoryId),
      entryAId: String(m.entryAId),
      entryBId: String(m.entryBId),
      teamAId: m.teamAId ? String(m.teamAId) : null,
      teamBId: m.teamBId ? String(m.teamBId) : null,
      status: m.status,
      winner: (m.winner ?? null) as 'A' | 'B' | null,
      games: ((m.score as { games?: Games } | undefined)?.games ?? []) as Games,
    }));

  const pairs: ReportPairRow[] = [];
  for (const c of categories) {
    const inDivision = entries.filter((e) => String(e.categoryId) === String(c._id) && e.status === 'active');
    const stand = computePairStandings(
      inDivision.map((e) => ({ id: String(e._id), name: e.displayName, teamId: e.teamId ? String(e.teamId) : null })),
      standingRows.filter((r) => r.categoryId === String(c._id)),
    );
    for (const s of stand) {
      const e = entryById.get(s.entryId)!;
      pairs.push({
        name: s.name,
        team: e.teamId ? teamName.get(String(e.teamId)) ?? '' : '',
        bracket: label(c._id, e.rank),
        played: s.played, won: s.won, lost: s.lost, gamesWon: s.gamesWon, gamesLost: s.gamesLost, pointsFor: s.pointsFor, pointsAgainst: s.pointsAgainst,
      });
    }
  }
  pairs.sort((x, y) => x.bracket.localeCompare(y.bracket) || y.won - x.won || x.name.localeCompare(y.name));

  const finished = matches.filter((m) => FINISHED.includes(m.status));
  const durations = finished.map((m) => rowFor(m).minutes).filter((n): n is number => n !== null);
  const sum = (f: (m: (typeof matches)[number]) => number) => finished.reduce((n, m) => n + f(m), 0);
  const gamesOf = (m: (typeof matches)[number]) => ((m.score as { games?: Games } | undefined)?.games ?? []).filter((g) => g.a + g.b > 0);
  const status = (s: string) => matches.filter((m) => m.status === s).length;

  const umpireCount = new Map<string, number>();
  for (const m of finished) if (m.umpire?.name) umpireCount.set(m.umpire.name, (umpireCount.get(m.umpire.name) ?? 0) + 1);

  const matchById = new Map(matches.map((m) => [String(m._id), m]));
  return {
    tournament: { id: String(t._id), name: t.name, date: t.date ?? '', venue: t.venue ?? '', status: t.status },
    generatedAt: new Date().toISOString(),
    totals: {
      matches: matches.filter((m) => m.status !== 'cancelled').length,
      finished: finished.length,
      completed: status('completed'),
      walkover: status('walkover'),
      retired: status('retired'),
      cancelled: status('cancelled'),
      notStarted: matches.filter((m) => ['pending', 'scheduled', 'ready', 'called'].includes(m.status)).length,
      live: matches.filter((m) => ['in_progress', 'paused', 'awaiting_confirmation'].includes(m.status)).length,
      corrected: matches.filter((m) => (m.correctionCount ?? 0) > 0).length,
      games: sum((m) => gamesOf(m).length),
      rallyPoints: sum((m) => gamesOf(m).reduce((n, g) => n + g.a + g.b, 0)),
      avgMinutes: durations.length ? Math.round(durations.reduce((x, y) => x + y, 0) / durations.length) : null,
      longestMinutes: durations.length ? Math.max(...durations) : null,
    },
    teams: computeTeamStandings(
      teams.map((x) => ({ id: String(x._id), name: x.name, color: x.color ?? '#e0e0e0' })),
      standingRows,
    ),
    divisions: categories.map((c) => ({
      id: String(c._id),
      name: c.name,
      code: c.code || divisionCode(c.name),
      rows: matches.filter((m) => String(m.categoryId) === String(c._id) && m.status !== 'cancelled').map(rowFor).sort((x, y) => x.bracket.localeCompare(y.bracket) || x.matchNumber - y.matchNumber),
    })),
    pairs,
    umpires: [...umpireCount.entries()].map(([name, n]) => ({ name, matches: n })).sort((x, y) => y.matches - x.matches || x.name.localeCompare(y.name)),
    corrections: corrections.map((c) => {
      const m = matchById.get(String(c.entityId));
      return {
        matchNumber: m?.matchNumber ?? 0,
        bracket: m ? label(m.categoryId, m.rank) : '',
        at: ((c as { createdAt?: Date }).createdAt ?? new Date()).toISOString(),
        by: c.actor?.name ?? '',
        reason: c.reason ?? '',
        before: c.before ?? null,
        after: c.after ?? null,
      };
    }),
  };
}

const BORDER: Partial<ExcelJS.Borders> = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };

/** The same report as a workbook: Summary, Results, Pairs, Umpires, Corrections. */
export async function buildReportWorkbook(tournamentId: string): Promise<{ buffer: Buffer; filename: string }> {
  const r = await buildReport(tournamentId);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Badminton Tournament';
  const header = (ws: ExcelJS.Worksheet) => {
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    ws.getRow(1).eachCell((c) => (c.border = BORDER));
  };

  const sum = wb.addWorksheet('Summary');
  sum.columns = [{ width: 28 }, { width: 14 }, { width: 10 }, { width: 10 }, { width: 10 }, { width: 12 }, { width: 14 }];
  sum.addRow([r.tournament.name]).font = { bold: true, size: 15 };
  sum.addRow([[r.tournament.date, r.tournament.venue].filter(Boolean).join(' · ')]);
  sum.addRow([]);
  const t = r.totals;
  for (const [k, v] of [
    ['Matches', t.matches], ['Finished', t.finished], ['  played to the end', t.completed], ['  walkovers', t.walkover], ['  retirements', t.retired],
    ['Not started', t.notStarted], ['Being played', t.live], ['Corrected results', t.corrected], ['Games played', t.games], ['Rally points', t.rallyPoints],
    ['Average match (min)', t.avgMinutes ?? ''], ['Longest match (min)', t.longestMinutes ?? ''],
  ] as const) sum.addRow([k, v]);
  sum.addRow([]);
  const head = sum.addRow(['Team standings', 'Points', 'Won', 'Lost', 'Games', 'Rally +/-']);
  head.font = { bold: true };
  for (const x of r.teams) {
    const row = sum.addRow([`${x.rank}. ${x.name}`, x.points, x.won, x.lost, `${x.gamesWon}-${x.gamesLost}`, x.pointsFor - x.pointsAgainst]);
    if (/^#[0-9a-f]{6}$/i.test(x.color)) row.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${x.color.slice(1).toUpperCase()}` } };
  }

  const res = wb.addWorksheet('Results');
  res.columns = [
    { header: 'Division', width: 20 }, { header: 'Level', width: 9 }, { header: 'Match #', width: 9 }, { header: 'Game #', width: 8 }, { header: 'Court', width: 10 },
    { header: 'Team 1', width: 18 }, { header: 'Pair 1', width: 22 }, { header: 'Team 2', width: 18 }, { header: 'Pair 2', width: 22 },
    { header: 'Score', width: 22 }, { header: 'Winner', width: 22 }, { header: 'Status', width: 14 }, { header: 'Umpire', width: 16 }, { header: 'Minutes', width: 9 }, { header: 'Corrected', width: 10 },
  ];
  header(res);
  for (const d of r.divisions) {
    for (const m of d.rows) res.addRow([d.name, m.bracket, m.matchNumber, m.gameNumber ?? '', m.courtName, m.teamA, m.pairA, m.teamB, m.pairB, m.score, m.winner, m.status, m.umpire, m.minutes ?? '', m.corrected ? 'yes' : '']);
  }
  res.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 15 } };

  const pr = wb.addWorksheet('Pairs');
  pr.columns = [{ header: 'Level', width: 9 }, { header: 'Pair', width: 26 }, { header: 'Team', width: 20 }, { header: 'Played', width: 8 }, { header: 'Won', width: 7 }, { header: 'Lost', width: 7 }, { header: 'Games won', width: 11 }, { header: 'Games lost', width: 11 }, { header: 'Rally for', width: 10 }, { header: 'Rally against', width: 12 }];
  header(pr);
  for (const p of r.pairs) pr.addRow([p.bracket, p.name, p.team, p.played, p.won, p.lost, p.gamesWon, p.gamesLost, p.pointsFor, p.pointsAgainst]);
  pr.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 10 } };

  const um = wb.addWorksheet('Umpires');
  um.columns = [{ header: 'Umpire', width: 24 }, { header: 'Matches', width: 10 }];
  header(um);
  for (const u of r.umpires) um.addRow([u.name, u.matches]);

  const co = wb.addWorksheet('Corrections');
  co.columns = [{ header: 'When', width: 20 }, { header: 'Match #', width: 9 }, { header: 'Level', width: 9 }, { header: 'By', width: 14 }, { header: 'Reason', width: 40 }, { header: 'Before', width: 36 }, { header: 'After', width: 36 }];
  header(co);
  for (const c of r.corrections) co.addRow([c.at, c.matchNumber, c.bracket, c.by, c.reason, JSON.stringify(c.before ?? ''), JSON.stringify(c.after ?? '')]);

  const slug = r.tournament.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'tournament';
  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), filename: `report-${slug}.xlsx` };
}
