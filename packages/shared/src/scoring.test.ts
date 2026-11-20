import { describe, expect, it } from 'vitest';
import {
  computeScore,
  effectivePoints,
  formatGames,
  gameWinner,
  scoreFromGames,
  SCORING_PRESETS,
  ScoringError,
  type ScoringConfig,
  type Side,
} from './scoring.js';

const BO3 = SCORING_PRESETS.bestOf3To21;
const rep = (side: Side, n: number): Side[] => Array.from({ length: n }, () => side);
/** Alternate A,B n times each → n-n. */
const tie = (n: number): Side[] => Array.from({ length: n * 2 }, (_, i) => (i % 2 ? 'B' : 'A'));

describe('gameWinner', () => {
  it('needs pointsToWin with a 2-point lead', () => {
    expect(gameWinner(BO3, 21, 19)).toBe('A');
    expect(gameWinner(BO3, 21, 20)).toBeNull();
    expect(gameWinner(BO3, 20, 22)).toBe('B');
    expect(gameWinner(BO3, 20, 20)).toBeNull();
  });
  it('cap wins regardless of lead (30-29)', () => {
    expect(gameWinner(BO3, 29, 29)).toBeNull();
    expect(gameWinner(BO3, 30, 29)).toBe('A');
    expect(gameWinner(BO3, 29, 30)).toBe('B');
  });
  it('winBy 1 means first to target', () => {
    expect(gameWinner({ ...BO3, winBy: 1, cap: null }, 21, 20)).toBe('A');
  });
  it('no cap allows long deuce', () => {
    const cfg: ScoringConfig = { ...BO3, cap: null };
    expect(gameWinner(cfg, 35, 34)).toBeNull();
    expect(gameWinner(cfg, 36, 34)).toBe('A');
  });
});

describe('computeScore', () => {
  it('starts empty', () => {
    const s = computeScore(BO3, []);
    expect(s.games).toEqual([{ a: 0, b: 0, winner: null }]);
    expect(s.winner).toBeNull();
    expect(s.servingSide).toBeNull();
  });

  it('wins a game 21-0 and opens game 2', () => {
    const s = computeScore(BO3, rep('A', 21));
    expect(s.games[0]).toEqual({ a: 21, b: 0, winner: 'A' });
    expect(s.currentGame).toBe(1);
    expect(s.gamesWon).toEqual({ A: 1, B: 0 });
    expect(s.notice).toBe('game_won');
    expect(s.servingSide).toBe('A'); // game winner serves first in next game
  });

  it('wins a match 2-0', () => {
    const s = computeScore(BO3, [...rep('A', 21), ...rep('A', 21)]);
    expect(s.winner).toBe('A');
    expect(s.notice).toBe('match_won');
    expect(s.games).toHaveLength(2);
    expect(formatGames(s.games)).toBe('21-0, 21-0');
  });

  it('goes to a decider at 1-1 and flags change of ends at 11', () => {
    const pts = [...rep('A', 21), ...rep('B', 21)];
    let s = computeScore(BO3, pts);
    expect(s.isDecider).toBe(true);
    s = computeScore(BO3, [...pts, ...rep('A', 11)]);
    expect(s.notice).toBe('interval_change_ends');
  });

  it('flags a plain interval at 11 in non-deciding games', () => {
    expect(computeScore(BO3, rep('B', 11)).notice).toBe('interval');
    expect(computeScore(BO3, rep('B', 12)).notice).toBeNull();
  });

  it('interval only fires for the first side to reach 11', () => {
    const s = computeScore(BO3, [...rep('A', 11), ...rep('B', 11)]);
    expect(s.notice).toBeNull();
  });

  it('handles deuce up to the 30 cap', () => {
    const s = computeScore(BO3, [...tie(29), 'B']);
    expect(s.games[0]).toEqual({ a: 29, b: 30, winner: 'B' });
  });

  it('rejects points after the match is decided', () => {
    expect(() => computeScore(BO3, [...rep('A', 42), 'A'])).toThrow(ScoringError);
  });

  it('single game to 31 ends after one game', () => {
    const s = computeScore(SCORING_PRESETS.singleGameTo31, rep('B', 31));
    expect(s.winner).toBe('B');
    expect(s.games).toHaveLength(1);
  });

  it('rally winner serves', () => {
    expect(computeScore(BO3, ['A', 'A', 'B']).servingSide).toBe('B');
  });

  it('rejects invalid config', () => {
    expect(() => computeScore({ ...BO3, cap: 20 }, [])).toThrow(ScoringError);
    expect(() => computeScore({ ...BO3, intervalAt: 21 }, [])).toThrow(ScoringError);
    expect(() => computeScore({ ...BO3, gamesToWin: 0 }, [])).toThrow(ScoringError);
  });
});

describe('effectivePoints (undo)', () => {
  it('undo removes the last point', () => {
    expect(
      effectivePoints([
        { type: 'point', side: 'A' },
        { type: 'point', side: 'B' },
        { type: 'undo' },
      ]),
    ).toEqual(['A']);
  });

  it('ignores non-scoring actions and undo on empty', () => {
    expect(effectivePoints([{ type: 'undo' }, { type: 'start' }, { type: 'point', side: 'B' }])).toEqual(['B']);
  });

  it('undo across a game boundary reopens the game', () => {
    const actions = [...rep('A', 21).map((side) => ({ type: 'point', side }) as const), { type: 'undo' } as const];
    const s = computeScore(BO3, effectivePoints(actions));
    expect(s.games).toEqual([{ a: 20, b: 0, winner: null }]);
    expect(s.currentGame).toBe(0);
    expect(s.gamesWon).toEqual({ A: 0, B: 0 });
  });

  it('undo of the match-winning point clears the winner', () => {
    const actions = [...rep('A', 42).map((side) => ({ type: 'point', side }) as const), { type: 'undo' } as const];
    const s = computeScore(BO3, effectivePoints(actions));
    expect(s.winner).toBeNull();
    expect(s.games[1]).toEqual({ a: 20, b: 0, winner: null });
  });
});

describe('scoreFromGames (result corrections)', () => {
  it('builds a finished 2-1 match', () => {
    const s = scoreFromGames(BO3, [{ a: 21, b: 15 }, { a: 18, b: 21 }, { a: 21, b: 19 }]);
    expect(s.winner).toBe('A');
    expect(s.gamesWon).toEqual({ A: 2, B: 1 });
    expect(s.pointsPlayed).toBe(115);
    expect(formatGames(s.games)).toBe('21-15, 18-21, 21-19');
  });

  it('accepts deuce games and the cap', () => {
    expect(scoreFromGames(BO3, [{ a: 22, b: 20 }, { a: 30, b: 29 }]).winner).toBe('A');
  });

  it('rejects an unfinished game, a bad deuce score and an extra game', () => {
    expect(() => scoreFromGames(BO3, [{ a: 21, b: 20 }, { a: 21, b: 5 }])).toThrow(/Game 1: 21-20 is not a finished game/);
    expect(() => scoreFromGames(BO3, [{ a: 25, b: 21 }, { a: 21, b: 5 }])).toThrow(/Game 1: 25-21 is not possible; with 21 the game ends at 23/);
    expect(() => scoreFromGames(BO3, [{ a: 31, b: 29 }, { a: 21, b: 5 }])).toThrow(/with 29 the game ends at 30/);
    expect(() => scoreFromGames(BO3, [{ a: 21, b: 5 }, { a: 21, b: 5 }, { a: 21, b: 5 }])).toThrow(/already decided/);
  });

  it('a full result must decide the match', () => {
    expect(() => scoreFromGames(BO3, [{ a: 21, b: 5 }])).toThrow(/not finished: a side needs 2 games/);
    expect(() => scoreFromGames(BO3, [])).toThrow(/at least one game/);
    expect(() => scoreFromGames(BO3, [{ a: -1, b: 21 }])).toThrow(/whole numbers/);
  });

  it('a retirement may end mid-game or undecided', () => {
    const s = scoreFromGames(BO3, [{ a: 21, b: 15 }, { a: 5, b: 3 }], { partial: true });
    expect(s.winner).toBeNull();
    expect(s.gamesWon).toEqual({ A: 1, B: 0 });
    expect(s.currentGame).toBe(1);
    expect(scoreFromGames(BO3, [], { partial: true }).games).toEqual([{ a: 0, b: 0, winner: null }]);
    // but earlier games must still be finished
    expect(() => scoreFromGames(BO3, [{ a: 10, b: 3 }, { a: 5, b: 3 }], { partial: true })).toThrow(/Game 1/);
  });

  it('single game to 31', () => {
    expect(scoreFromGames(SCORING_PRESETS.singleGameTo31, [{ a: 31, b: 25 }]).winner).toBe('A');
    expect(() => scoreFromGames(SCORING_PRESETS.singleGameTo31, [{ a: 21, b: 5 }])).toThrow(/not a finished game/);
  });
});
