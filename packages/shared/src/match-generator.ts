/**
 * Match generation (independent from scheduling, docs/scheduling-plan.md §4).
 *
 * Team divisions ("ranked"): every team lists its pairs in order, and that order is the pair's rank.
 * Team A plays Team B once per rank: A's pair #1 vs B's pair #1, #2 vs #2, and so on. There are no
 * per-level categories; "MD-A" is just the label of rank 1 in Men's Doubles.
 *
 * Open divisions: every pair plays every other pair once (round robin).
 */

export interface RoundPairing<T> {
  round: number; // 1-based
  home: T;
  away: T;
}

/** Circle method: n-1 rounds (n even) where nobody plays twice in a round. Odd counts get a bye. */
export function roundRobin<T>(items: readonly T[]): RoundPairing<T>[][] {
  if (items.length < 2) return [];
  const arr: (T | null)[] = [...items];
  if (arr.length % 2) arr.push(null);
  const n = arr.length;
  const rounds: RoundPairing<T>[][] = [];
  for (let r = 0; r < n - 1; r++) {
    const round: RoundPairing<T>[] = [];
    for (let i = 0; i < n / 2; i++) {
      const x = arr[i];
      const y = arr[n - 1 - i];
      if (x == null || y == null) continue;
      // Alternate sides for the fixed element so it is not always listed first.
      const flip = i === 0 && r % 2 === 1;
      round.push({ round: r + 1, home: flip ? y : x, away: flip ? x : y });
    }
    rounds.push(round);
    arr.splice(1, 0, arr.pop()!);
  }
  return rounds;
}

/** 1 → "A", 2 → "B", … 26 → "Z", 27 → "AA". */
export function rankLetter(rank: number): string {
  let n = Math.max(1, Math.floor(rank));
  let s = '';
  while (n > 0) {
    n--;
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s;
}

/** Short code of a division: "Men's Doubles" → "MD", "Women's Doubles" → "WD", "Mixed Doubles" → "XD", "MD" → "MD". */
export function divisionCode(name: string): string {
  const t = name.trim();
  if (/^[A-Za-z]{1,3}$/.test(t)) return t.toUpperCase();
  if (/^mix/i.test(t)) return 'XD';
  const initials = t
    .split(/[^A-Za-z']+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase())
    .join('');
  return (initials || t.slice(0, 2) || '?').slice(0, 3).toUpperCase();
}

/** "MD-A" for rank 1 of Men's Doubles; falls back to the plain name when there is no rank. */
export function bracketLabel(code: string, name: string, rank: number | null): string {
  return rank ? `${code || divisionCode(name)}-${rankLetter(rank)}` : name;
}

export interface GenPair {
  id: string;
  teamId: string | null;
  label: string;
  /** Position of the pair within its team's list (1 = first). Required for ranked divisions. */
  rank?: number | null;
}

export interface GenCategory {
  id: string;
  name: string;
  pairs: GenPair[];
  allowSameTeam: boolean;
  /** Team division: match pairs of the same rank across teams. */
  ranked?: boolean;
}

export interface PlannedMatch {
  categoryId: string;
  /** Round of the team round robin (which team meets which). */
  round: number;
  /** Pair position this match is for (ranked divisions); null in open divisions. */
  rank: number | null;
  entryAId: string;
  entryBId: string;
  teamAId: string | null;
  teamBId: string | null;
}

export interface GenerateOutput {
  matches: PlannedMatch[];
  /** Human-readable reasons a division produced fewer matches than expected. */
  problems: string[];
}

function generateRanked(cat: GenCategory): GenerateOutput {
  const problems: string[] = [];
  const byTeam = new Map<string, Map<number, GenPair>>();
  for (const p of [...cat.pairs].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!p.teamId) {
      problems.push(`${cat.name}: ${p.label} is not on a team (left out)`);
      continue;
    }
    if (!p.rank || p.rank < 1) {
      problems.push(`${cat.name}: ${p.label} has no position in its team's list (left out)`);
      continue;
    }
    const ranks = byTeam.get(p.teamId) ?? new Map<number, GenPair>();
    if (ranks.has(p.rank)) {
      problems.push(`${cat.name}: two pairs share position ${p.rank} in one team (${p.label} left out)`);
      continue;
    }
    ranks.set(p.rank, p);
    byTeam.set(p.teamId, ranks);
  }
  const teams = [...byTeam.keys()].sort();
  if (teams.length < 2) {
    problems.push(`${cat.name}: needs pairs from at least 2 teams`);
    return { matches: [], problems };
  }

  // Teams with fewer pairs than the largest team cannot field every position.
  const maxRank = Math.max(...teams.flatMap((t) => [...byTeam.get(t)!.keys()]));
  for (const t of teams) {
    const have = byTeam.get(t)!;
    const missing: number[] = [];
    for (let r = 1; r <= maxRank; r++) if (!have.has(r)) missing.push(r);
    if (missing.length) problems.push(`${cat.name}: a team has no pair at position ${missing.join(', ')} (those matches are skipped)`);
  }

  const matches: PlannedMatch[] = [];
  for (const round of roundRobin(teams)) {
    for (const tie of round) {
      const a = byTeam.get(tie.home)!;
      const b = byTeam.get(tie.away)!;
      for (let rank = 1; rank <= maxRank; rank++) {
        const pa = a.get(rank);
        const pb = b.get(rank);
        if (!pa || !pb) continue;
        matches.push({ categoryId: cat.id, round: tie.round, rank, entryAId: pa.id, entryBId: pb.id, teamAId: tie.home, teamBId: tie.away });
      }
    }
  }
  return { matches, problems: [...new Set(problems)] };
}

export function generateCategoryRoundRobin(cat: GenCategory): GenerateOutput {
  if (cat.ranked) return generateRanked(cat);

  const problems: string[] = [];
  // Stable order (team, then id) so the same input always gives the same matches.
  const pairs = [...cat.pairs].sort(
    (a, b) => (a.teamId ?? '').localeCompare(b.teamId ?? '') || a.id.localeCompare(b.id),
  );
  if (pairs.length < 2) {
    problems.push(`${cat.name}: needs at least 2 pairs (has ${pairs.length})`);
    return { matches: [], problems };
  }
  if (!cat.allowSameTeam && new Set(pairs.map((p) => p.teamId)).size < 2) {
    problems.push(`${cat.name}: all pairs are from the same team, so there is nobody to play`);
    return { matches: [], problems };
  }

  const matches: PlannedMatch[] = [];
  for (const round of roundRobin(pairs)) {
    for (const { home, away, round: r } of round) {
      if (!cat.allowSameTeam && home.teamId && home.teamId === away.teamId) continue;
      matches.push({
        categoryId: cat.id,
        round: r,
        rank: null,
        entryAId: home.id,
        entryBId: away.id,
        teamAId: home.teamId,
        teamBId: away.teamId,
      });
    }
  }
  return { matches, problems };
}

/** Generate for several divisions; matches come out division by division, round by round. */
export function generateRoundRobin(categories: readonly GenCategory[]): GenerateOutput {
  const out: GenerateOutput = { matches: [], problems: [] };
  for (const c of categories) {
    const r = generateCategoryRoundRobin(c);
    out.matches.push(...r.matches);
    out.problems.push(...r.problems);
  }
  return out;
}

/** Key that identifies a matchup regardless of side, for duplicate detection. */
export const matchupKey = (categoryId: string, a: string, b: string) => `${categoryId}:${[a, b].sort().join('|')}`;
