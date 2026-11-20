/**
 * Standings computed from match results (never stored, so they cannot go stale).
 * Team points: 1 per match won. Walkover = win with no games or rally points. Cancelled = ignored.
 */
import type { Side } from './scoring.js';

export interface StandingMatch {
  categoryId: string;
  entryAId: string;
  entryBId: string;
  teamAId: string | null;
  teamBId: string | null;
  status: string;
  winner: Side | null;
  games: readonly { a: number; b: number; winner: Side | null }[];
}

interface Totals {
  played: number;
  won: number;
  lost: number;
  gamesWon: number;
  gamesLost: number;
  pointsFor: number;
  pointsAgainst: number;
}

export interface TeamStanding extends Totals {
  teamId: string;
  name: string;
  color: string;
  logoUrl: string | null;
  rank: number;
  /** Team points = matches won. */
  points: number;
  /** Matches won per category id. */
  byCategory: Record<string, number>;
}

export interface PairStanding extends Totals {
  entryId: string;
  name: string;
  teamId: string | null;
  rank: number;
}

const COUNTED = new Set(['completed', 'walkover', 'retired']);
const zero = (): Totals => ({ played: 0, won: 0, lost: 0, gamesWon: 0, gamesLost: 0, pointsFor: 0, pointsAgainst: 0 });

/** Applies one finished match to the two sides' totals. */
function apply(a: Totals, b: Totals, m: StandingMatch) {
  a.played++;
  b.played++;
  if (m.winner === 'A') { a.won++; b.lost++; } else { b.won++; a.lost++; }
  if (m.status === 'walkover') return;
  for (const g of m.games) {
    if (g.a + g.b === 0) continue;
    a.pointsFor += g.a;
    a.pointsAgainst += g.b;
    b.pointsFor += g.b;
    b.pointsAgainst += g.a;
    if (g.winner === 'A') { a.gamesWon++; b.gamesLost++; }
    else if (g.winner === 'B') { b.gamesWon++; a.gamesLost++; }
  }
}

const counted = (m: StandingMatch) => COUNTED.has(m.status) && !!m.winner;

/**
 * Ranking: wins first. Level on wins:
 *   - exactly two level: who won the match(es) between them (head-to-head), then game difference, then point difference;
 *   - three or more level: game difference, then point difference; any two still level then go by head-to-head.
 * Rows that no rule separates share a rank (the name only orders the display).
 */
function rank<T extends Totals & { name: string; rank: number }>(rows: T[], idOf: (r: T) => string, h2h: (a: string, b: string) => number): T[] {
  const gd = (r: Totals) => r.gamesWon - r.gamesLost;
  const pd = (r: Totals) => r.pointsFor - r.pointsAgainst;
  const overall = (a: T, b: T) => gd(b) - gd(a) || pd(b) - pd(a);
  const head = (a: T, b: T) => h2h(idOf(a), idOf(b)); // > 0: a beat b more often

  const orderGroup = (g: T[]): T[] => {
    if (g.length < 2) return g;
    if (g.length === 2) {
      const [a, b] = g as [T, T];
      const d = head(a, b);
      if (d) return d > 0 ? [a, b] : [b, a];
      return [...g].sort((x, y) => overall(x, y) || x.name.localeCompare(y.name));
    }
    const sorted = [...g].sort((x, y) => overall(x, y) || x.name.localeCompare(y.name));
    const out: T[] = [];
    for (let i = 0; i < sorted.length; ) {
      let j = i;
      while (j < sorted.length && overall(sorted[j]!, sorted[i]!) === 0) j++;
      const run = sorted.slice(i, j);
      if (run.length === 2 && head(run[0]!, run[1]!) < 0) out.push(run[1]!, run[0]!);
      else out.push(...run);
      i = j;
    }
    return out;
  };

  const byWins = [...rows].sort((x, y) => y.won - x.won || x.name.localeCompare(y.name));
  const ordered: T[] = [];
  for (let i = 0; i < byWins.length; ) {
    let j = i;
    while (j < byWins.length && byWins[j]!.won === byWins[i]!.won) j++;
    ordered.push(...orderGroup(byWins.slice(i, j)));
    i = j;
  }
  // Head-to-head only separates a run of exactly two level rows; a longer run (e.g. A beat B, B beat C, C beat A) stays level.
  const runSize = new Map<T, number>();
  for (let i = 0; i < ordered.length; ) {
    let j = i;
    while (j < ordered.length && ordered[j]!.won === ordered[i]!.won && overall(ordered[j]!, ordered[i]!) === 0) j++;
    for (let k = i; k < j; k++) runSize.set(ordered[k]!, j - i);
    i = j;
  }
  ordered.forEach((r, i) => {
    const prev = ordered[i - 1];
    const tied = prev && prev.won === r.won && overall(prev, r) === 0 && (runSize.get(r) !== 2 || head(prev, r) === 0);
    r.rank = tied ? prev.rank : i + 1;
  });
  return ordered;
}

/** Who beat whom: "winnerId>loserId" → number of matches. */
function winsMatrix(pairs: { winner: string; loser: string }[]) {
  const wins = new Map<string, number>();
  for (const { winner, loser } of pairs) wins.set(`${winner}>${loser}`, (wins.get(`${winner}>${loser}`) ?? 0) + 1);
  return (a: string, b: string) => (wins.get(`${a}>${b}`) ?? 0) - (wins.get(`${b}>${a}`) ?? 0);
}

export function computeTeamStandings(
  teams: readonly { id: string; name: string; color: string; logoUrl?: string | null }[],
  matches: readonly StandingMatch[],
): TeamStanding[] {
  const rows = new Map<string, TeamStanding>(
    teams.map((t) => [t.id, { ...zero(), teamId: t.id, name: t.name, color: t.color, logoUrl: t.logoUrl ?? null, rank: 0, points: 0, byCategory: {} }]),
  );
  for (const m of matches) {
    if (!counted(m) || !m.teamAId || !m.teamBId) continue;
    const A = rows.get(m.teamAId);
    const B = rows.get(m.teamBId);
    if (!A || !B || A === B) continue;
    apply(A, B, m);
    const w = m.winner === 'A' ? A : B;
    w.byCategory[m.categoryId] = (w.byCategory[m.categoryId] ?? 0) + 1;
  }
  for (const r of rows.values()) r.points = r.won;
  const h2h = winsMatrix(
    matches
      .filter((m) => counted(m) && m.teamAId && m.teamBId && m.teamAId !== m.teamBId)
      .map((m) => (m.winner === 'A' ? { winner: m.teamAId!, loser: m.teamBId! } : { winner: m.teamBId!, loser: m.teamAId! })),
  );
  return rank([...rows.values()], (r) => r.teamId, h2h);
}

export function computePairStandings(
  pairs: readonly { id: string; name: string; teamId: string | null }[],
  matches: readonly StandingMatch[],
): PairStanding[] {
  const rows = new Map<string, PairStanding>(pairs.map((p) => [p.id, { ...zero(), entryId: p.id, name: p.name, teamId: p.teamId, rank: 0 }]));
  for (const m of matches) {
    if (!counted(m)) continue;
    const A = rows.get(m.entryAId);
    const B = rows.get(m.entryBId);
    if (A && B) apply(A, B, m);
  }
  const h2h = winsMatrix(matches.filter((m) => counted(m)).map((m) => (m.winner === 'A' ? { winner: m.entryAId, loser: m.entryBId } : { winner: m.entryBId, loser: m.entryAId })));
  return rank([...rows.values()], (r) => r.entryId, h2h);
}
