import { describe, expect, it } from 'vitest';
import { computePairStandings, computeTeamStandings, type StandingMatch } from './standings.js';

const teams = ['X', 'Y', 'Z'].map((id) => ({ id, name: `Team ${id}`, color: '#cccccc' }));

/** Team match: `a` beat or lost to `b` with the given games (from a's point of view). */
let n = 0;
const tm = (a: string, b: string, winner: 'A' | 'B', games: [number, number][], category = 'c'): StandingMatch => ({
  categoryId: category, entryAId: `${a}-${++n}`, entryBId: `${b}-${n}`, teamAId: a, teamBId: b, status: 'completed', winner,
  games: games.map(([x, y]) => ({ a: x, b: y, winner: x > y ? ('A' as const) : ('B' as const) })),
});
const order = (s: { teamId: string; rank: number }[]) => s.map((r) => `${r.teamId}${r.rank}`).join(' ');

describe('head-to-head tiebreak', () => {
  it('two level teams: who beat whom comes before game and point difference', () => {
    const s = computeTeamStandings(teams, [
      tm('X', 'Y', 'A', [[21, 19], [21, 19]]), // X beats Y narrowly
      tm('X', 'Z', 'A', [[21, 19], [21, 19]]),
      tm('Y', 'Z', 'A', [[21, 0], [21, 0]]), // Y crushes Z, twice
      tm('Y', 'Z', 'A', [[21, 0], [21, 0]]),
    ]);
    // X and Y both have 2 wins; Y's game and point difference are far better, but X won the match between them.
    expect(order(s)).toBe('X1 Y2 Z3');
  });

  it('without a head-to-head result the game difference decides, then the point difference', () => {
    const s = computeTeamStandings(teams, [
      tm('X', 'Z', 'A', [[21, 5], [21, 5]]),
      tm('Y', 'Z', 'A', [[21, 19], [19, 21], [21, 19]]),
    ]);
    expect(order(s)).toBe('X1 Y2 Z3'); // X won 2-0, Y won 2-1
  });

  it('three level teams: game difference, then point difference; the head-to-head cycle does not split them', () => {
    const s = computeTeamStandings(teams, [
      tm('X', 'Y', 'A', [[21, 5], [21, 5]]),
      tm('Y', 'Z', 'A', [[21, 19], [21, 19]]),
      tm('Z', 'X', 'A', [[21, 19], [21, 19]]),
    ]);
    // all 1 win, game difference 0 for everyone; point difference: X +28, Z 0, Y -28
    expect(order(s)).toBe('X1 Z2 Y3');
  });

  it('a perfect cycle with identical numbers stays level', () => {
    const s = computeTeamStandings(teams, [
      tm('X', 'Y', 'A', [[21, 10], [21, 10]]),
      tm('Y', 'Z', 'A', [[21, 10], [21, 10]]),
      tm('Z', 'X', 'A', [[21, 10], [21, 10]]),
    ]);
    expect(s.map((r) => r.rank)).toEqual([1, 1, 1]);
  });

  it('teams that have not played share a rank, and wins still come first', () => {
    expect(computeTeamStandings(teams, []).map((r) => r.rank)).toEqual([1, 1, 1]);
    const s = computeTeamStandings(teams, [tm('Z', 'X', 'A', [[21, 0], [21, 0]])]);
    // Z won; X lost 0-2 to Z while Y has not played, so Y is ahead of X on game difference.
    expect(order(s)).toBe('Z1 Y2 X3');
  });

  it('two level teams that never met and are equal on everything share a rank', () => {
    const four = [...teams, { id: 'W', name: 'Team W', color: '#ccc' }];
    const s = computeTeamStandings(four, [tm('X', 'Z', 'A', [[21, 10], [21, 10]]), tm('Y', 'W', 'A', [[21, 10], [21, 10]])]);
    expect(s.filter((r) => r.won === 1).map((r) => r.rank)).toEqual([1, 1]);
  });

  it('works for pairs too', () => {
    const pairs = ['p1', 'p2', 'p3'].map((id) => ({ id, name: id, teamId: null }));
    const m = (a: string, b: string, games: [number, number][]): StandingMatch => ({
      categoryId: 'c', entryAId: a, entryBId: b, teamAId: null, teamBId: null, status: 'completed', winner: 'A',
      games: games.map(([x, y]) => ({ a: x, b: y, winner: 'A' as const })),
    });
    const s = computePairStandings(pairs, [m('p1', 'p2', [[21, 19], [21, 19]]), m('p1', 'p3', [[21, 19], [21, 19]]), m('p2', 'p3', [[21, 0], [21, 0]])]);
    expect(s.map((r) => `${r.entryId}${r.rank}`)).toEqual(['p11', 'p22', 'p33']);
  });
});
