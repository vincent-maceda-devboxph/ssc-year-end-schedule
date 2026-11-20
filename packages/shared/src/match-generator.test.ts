import { describe, expect, it } from 'vitest';
import {
  bracketLabel,
  divisionCode,
  generateCategoryRoundRobin,
  generateRoundRobin,
  matchupKey,
  rankLetter,
  roundRobin,
  type GenCategory,
} from './match-generator.js';
import { computePairStandings, computeTeamStandings, type StandingMatch } from './standings.js';

const TEAMS = ['hulk', 'avengers', 'iron'];

/** A team division: each team lists `n` pairs in order (rank = position). */
const division = (id: string, name: string, n: number, teams = TEAMS): GenCategory => ({
  id,
  name,
  ranked: true,
  allowSameTeam: false,
  pairs: teams.flatMap((t) => Array.from({ length: n }, (_, i) => ({ id: `${t}-${id}-${i + 1}`, teamId: t, label: `${t} ${i + 1}`, rank: i + 1 }))),
});

/** The reference event: 3 teams, 10 men's pairs + 3 women's pairs each → 13 ranks × 3 team pairings = 39. */
const reference = [division('md', "Men's Doubles", 10), division('wd', "Women's Doubles", 3)];

describe('labels', () => {
  it('rank letters', () => {
    expect([1, 2, 10, 26, 27, 28, 52, 53].map(rankLetter)).toEqual(['A', 'B', 'J', 'Z', 'AA', 'AB', 'AZ', 'BA']);
  });
  it('division codes and bracket labels', () => {
    expect(divisionCode("Men's Doubles")).toBe('MD');
    expect(divisionCode("Women's Doubles")).toBe('WD');
    expect(divisionCode('Mixed Doubles')).toBe('XD');
    expect(divisionCode('md')).toBe('MD');
    expect(bracketLabel('MD', "Men's Doubles", 1)).toBe('MD-A');
    expect(bracketLabel('WD', "Women's Doubles", 3)).toBe('WD-C');
    expect(bracketLabel('MD', "Men's Doubles", null)).toBe("Men's Doubles");
  });
});

describe('roundRobin', () => {
  it('4 items → 3 rounds × 2, every pairing once, nobody twice per round', () => {
    const rounds = roundRobin(['a', 'b', 'c', 'd']);
    expect(rounds).toHaveLength(3);
    for (const r of rounds) {
      const ids = r.flatMap((p) => [p.home, p.away]);
      expect(new Set(ids).size).toBe(ids.length);
    }
    expect(new Set(rounds.flat().map((p) => [p.home, p.away].sort().join(''))).size).toBe(6);
  });

  it('odd count: each item sits out exactly one round', () => {
    const rounds = roundRobin(['a', 'b', 'c', 'd', 'e']);
    expect(rounds.flat()).toHaveLength(10);
    for (const t of ['a', 'b', 'c', 'd', 'e']) {
      expect(rounds.filter((r) => r.some((p) => p.home === t || p.away === t))).toHaveLength(4);
    }
  });
});

describe('ranked team divisions', () => {
  it('reference event: 39 matches, pair at position k plays the other team\'s position k', () => {
    const { matches, problems } = generateRoundRobin(reference);
    expect(problems).toEqual([]);
    expect(matches).toHaveLength(39);
    for (const m of matches) {
      expect(m.teamAId).not.toBe(m.teamBId);
      const rankOf = (id: string) => Number(id.split('-').pop());
      expect(rankOf(m.entryAId)).toBe(m.rank);
      expect(rankOf(m.entryBId)).toBe(m.rank);
    }
    expect(new Set(matches.map((m) => matchupKey(m.categoryId, m.entryAId, m.entryBId))).size).toBe(39);
    // Every rank is met exactly once by each team pairing.
    expect(matches.filter((m) => m.categoryId === 'md' && m.rank === 1)).toHaveLength(3);
  });

  it('4 teams × (10 MD + 6 WD) = 6 ties × 16 = 96 matches', () => {
    const teams = ['a', 'b', 'c', 'd'];
    expect(generateRoundRobin([division('md', "Men's Doubles", 10, teams), division('wd', "Women's Doubles", 6, teams)]).matches).toHaveLength(96);
  });

  it('unequal team sizes: only positions both teams have are played, and the gap is reported', () => {
    const cat = division('md', "Men's Doubles", 3);
    cat.pairs = cat.pairs.filter((p) => !(p.teamId === 'iron' && p.rank === 3));
    const { matches, problems } = generateCategoryRoundRobin(cat);
    // hulk-avengers: 3, hulk-iron: 2, avengers-iron: 2
    expect(matches).toHaveLength(7);
    expect(problems).toEqual(["Men's Doubles: a team has no pair at position 3 (those matches are skipped)"]);
  });

  it('reports pairs without a team or position instead of guessing', () => {
    const cat = division('md', "Men's Doubles", 2);
    cat.pairs.push({ id: 'x', teamId: null, label: 'Loose pair', rank: 1 }, { id: 'y', teamId: 'hulk', label: 'No spot', rank: null });
    const { matches, problems } = generateCategoryRoundRobin(cat);
    expect(matches).toHaveLength(6);
    expect(problems).toEqual(expect.arrayContaining([expect.stringContaining('Loose pair'), expect.stringContaining('No spot')]));
  });

  it('needs at least two teams', () => {
    expect(generateCategoryRoundRobin(division('md', "Men's Doubles", 3, ['solo'])).problems).toEqual(["Men's Doubles: needs pairs from at least 2 teams"]);
  });

  it('is deterministic regardless of input order', () => {
    const shuffled = reference.map((c) => ({ ...c, pairs: [...c.pairs].reverse() }));
    expect(generateRoundRobin(shuffled)).toEqual(generateRoundRobin(reference));
  });
});

describe('open (non-team) divisions', () => {
  const open: GenCategory = {
    id: 'o', name: 'Open', allowSameTeam: true,
    pairs: ['p1', 'p2', 'p3', 'p4', 'p5'].map((id) => ({ id, teamId: null, label: id })),
  };
  it('every pair plays every other pair once; odd counts work', () => {
    const { matches } = generateCategoryRoundRobin(open);
    expect(matches).toHaveLength(10);
    expect(matches.every((m) => m.rank === null)).toBe(true);
  });
  it('needs at least two pairs', () => {
    expect(generateCategoryRoundRobin({ ...open, pairs: open.pairs.slice(0, 1) }).problems).toEqual(['Open: needs at least 2 pairs (has 1)']);
  });
});

describe('standings', () => {
  const teams = [
    { id: 'hulk', name: 'Hulk Smashers', color: '#c6efce' },
    { id: 'iron', name: 'Iron Shuttlers', color: '#ff9999' },
  ];
  const win = (winner: 'A' | 'B', status = 'completed', cat = 'MD-A'): StandingMatch => ({
    categoryId: cat, entryAId: `hulk-${cat}`, entryBId: `iron-${cat}`, teamAId: 'hulk', teamBId: 'iron', status, winner,
    games: status === 'walkover' ? [] : [{ a: winner === 'A' ? 21 : 15, b: winner === 'A' ? 15 : 21, winner }],
  });

  it('1 team point per match won, per-division breakdown', () => {
    const s = computeTeamStandings(teams, [win('A'), win('A', 'completed', 'MD-B'), win('B', 'completed', 'WD-A')]);
    expect(s[0]).toMatchObject({ teamId: 'hulk', points: 2, won: 2, lost: 1, rank: 1, byCategory: { 'MD-A': 1, 'MD-B': 1 } });
    expect(s[1]).toMatchObject({ teamId: 'iron', points: 1, byCategory: { 'WD-A': 1 } });
  });

  it('walkover = point without games; open and cancelled matches ignored', () => {
    const s = computeTeamStandings(teams, [win('B', 'walkover'), { ...win('A'), status: 'in_progress', winner: null }, { ...win('A'), status: 'cancelled' }]);
    expect(s.find((r) => r.teamId === 'iron')!).toMatchObject({ points: 1, gamesWon: 0, played: 1 });
  });

  it('equal points → game difference → point difference, shared rank only when identical', () => {
    const s = computeTeamStandings(teams, [
      { ...win('A'), games: [{ a: 21, b: 19, winner: 'A' }] },
      { ...win('B'), categoryId: 'MD-B', games: [{ a: 5, b: 21, winner: 'B' }] },
    ]);
    expect(s.map((r) => [r.teamId, r.rank])).toEqual([['iron', 1], ['hulk', 2]]);
  });

  it('pair standings', () => {
    const pairs = [
      { id: 'hulk-MD-A', name: 'Kennith / Zeth', teamId: 'hulk' },
      { id: 'iron-MD-A', name: 'Baitan / Paul', teamId: 'iron' },
    ];
    expect(computePairStandings(pairs, [win('B')])[0]).toMatchObject({ name: 'Baitan / Paul', won: 1, rank: 1 });
  });
});
