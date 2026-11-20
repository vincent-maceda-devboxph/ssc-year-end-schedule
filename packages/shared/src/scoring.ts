/**
 * Pure rally-scoring engine. Score state is always derived from the ordered
 * list of scoring actions, so undo (including across game boundaries) is just
 * "drop the last point and recompute".
 */

export type Side = 'A' | 'B';

export interface ScoringConfig {
  /** Games needed to win the match (1 = single game, 2 = best of 3). */
  gamesToWin: number;
  /** Points needed to win a game (21, 31, 15, ...). */
  pointsToWin: number;
  /** Required lead once pointsToWin is reached (2 = deuce rule, 1 = no deuce). */
  winBy: number;
  /** First side to reach this wins regardless of lead (30 for standard 21-point games). null = no cap. */
  cap: number | null;
  /** Leading score that triggers the mid-game interval (11). null = no interval. */
  intervalAt: number | null;
  /** Change ends at the interval of the deciding game. */
  changeEndsInDecider: boolean;
}

export const SCORING_PRESETS = {
  bestOf3To21: {
    gamesToWin: 2,
    pointsToWin: 21,
    winBy: 2,
    cap: 30,
    intervalAt: 11,
    changeEndsInDecider: true,
  },
  singleGameTo21: {
    gamesToWin: 1,
    pointsToWin: 21,
    winBy: 2,
    cap: 30,
    intervalAt: 11,
    changeEndsInDecider: true,
  },
  singleGameTo31: {
    gamesToWin: 1,
    pointsToWin: 31,
    winBy: 2,
    cap: 40,
    intervalAt: 16,
    changeEndsInDecider: true,
  },
} as const satisfies Record<string, ScoringConfig>;

export type ScoringPresetKey = keyof typeof SCORING_PRESETS;
export const DEFAULT_SCORING: ScoringConfig = { ...SCORING_PRESETS.bestOf3To21 };

export interface GameScore {
  a: number;
  b: number;
  winner: Side | null;
}

export type ScoreNotice = 'interval' | 'interval_change_ends' | 'game_won' | 'match_won';

export interface ScoreState {
  /** All games started so far; the last one is the current game. */
  games: GameScore[];
  /** Index of the current game in `games`. */
  currentGame: number;
  gamesWon: { A: number; B: number };
  winner: Side | null;
  /** Side that serves the next rally (rally winner serves). null before the first rally of the match. */
  servingSide: Side | null;
  /** True when the current game is the deciding game. */
  isDecider: boolean;
  /** Event caused by the most recent point, for the umpire UI to announce. */
  notice: ScoreNotice | null;
  pointsPlayed: number;
}

export class ScoringError extends Error {}

export function gameWinner(cfg: ScoringConfig, a: number, b: number): Side | null {
  if (cfg.cap !== null) {
    if (a >= cfg.cap) return 'A';
    if (b >= cfg.cap) return 'B';
  }
  if (a >= cfg.pointsToWin && a - b >= cfg.winBy) return 'A';
  if (b >= cfg.pointsToWin && b - a >= cfg.winBy) return 'B';
  return null;
}

export function emptyScore(): ScoreState {
  return {
    games: [{ a: 0, b: 0, winner: null }],
    currentGame: 0,
    gamesWon: { A: 0, B: 0 },
    winner: null,
    servingSide: null,
    isDecider: false,
    notice: null,
    pointsPlayed: 0,
  };
}

/** Compute match score from the ordered list of rally winners. Throws if points continue after the match is won. */
export function computeScore(cfg: ScoringConfig, points: readonly Side[]): ScoreState {
  validateScoringConfig(cfg);
  const s = emptyScore();
  s.isDecider = cfg.gamesToWin === 1;

  for (const side of points) {
    if (s.winner) throw new ScoringError('Match is already decided');
    const g = s.games[s.currentGame]!;
    if (side === 'A') g.a++;
    else g.b++;
    s.pointsPlayed++;
    s.servingSide = side;
    s.notice = null;

    const gw = gameWinner(cfg, g.a, g.b);
    if (gw) {
      g.winner = gw;
      s.gamesWon[gw]++;
      if (s.gamesWon[gw] >= cfg.gamesToWin) {
        s.winner = gw;
        s.notice = 'match_won';
      } else {
        s.notice = 'game_won';
        s.games.push({ a: 0, b: 0, winner: null });
        s.currentGame++;
        s.isDecider =
          s.gamesWon.A === cfg.gamesToWin - 1 && s.gamesWon.B === cfg.gamesToWin - 1;
      }
      continue;
    }

    if (cfg.intervalAt !== null) {
      const leader = side === 'A' ? g.a : g.b;
      const other = side === 'A' ? g.b : g.a;
      if (leader === cfg.intervalAt && other < cfg.intervalAt) {
        s.notice = s.isDecider && cfg.changeEndsInDecider ? 'interval_change_ends' : 'interval';
      }
    }
  }
  return s;
}

export type ScoringAction = { type: 'point'; side: Side } | { type: 'undo' } | { type: string };

/** Replay point/undo actions into the effective list of rally winners. Other action types are ignored. */
export function effectivePoints(actions: readonly ScoringAction[]): Side[] {
  const points: Side[] = [];
  for (const a of actions) {
    if (a.type === 'point' && 'side' in a) points.push(a.side as Side);
    else if (a.type === 'undo') points.pop();
  }
  return points;
}

export function validateScoringConfig(cfg: ScoringConfig): void {
  const int = (n: number) => Number.isInteger(n);
  if (!int(cfg.gamesToWin) || cfg.gamesToWin < 1 || cfg.gamesToWin > 5)
    throw new ScoringError('gamesToWin must be 1-5');
  if (!int(cfg.pointsToWin) || cfg.pointsToWin < 1 || cfg.pointsToWin > 99)
    throw new ScoringError('pointsToWin must be 1-99');
  if (!int(cfg.winBy) || cfg.winBy < 1 || cfg.winBy > 10) throw new ScoringError('winBy must be 1-10');
  if (cfg.cap !== null && (!int(cfg.cap) || cfg.cap < cfg.pointsToWin))
    throw new ScoringError('cap must be >= pointsToWin');
  if (cfg.intervalAt !== null && (!int(cfg.intervalAt) || cfg.intervalAt < 1 || cfg.intervalAt >= cfg.pointsToWin))
    throw new ScoringError('intervalAt must be between 1 and pointsToWin - 1');
}

/** "21-15, 18-21, 21-19" from side A's perspective; skips the trailing empty game. */
export function formatGames(games: readonly GameScore[]): string {
  return games
    .filter((g) => g.a + g.b > 0 || g.winner)
    .map((g) => `${g.a}-${g.b}`)
    .join(', ');
}

export interface GameInput {
  a: number;
  b: number;
}

/**
 * Build a match score from final game scores (used for result corrections, where there is no rally
 * log). Every game before the last must be a finished game under the rules. For a full result the
 * match must be decided exactly when the last game ends. With `partial` (a retirement) the last game
 * may be unfinished and the match may be undecided.
 */
export function scoreFromGames(cfg: ScoringConfig, input: readonly GameInput[], opts: { partial?: boolean } = {}): ScoreState {
  validateScoringConfig(cfg);
  const partial = !!opts.partial;
  if (!partial && input.length === 0) throw new ScoringError('Enter at least one game');
  const s = emptyScore();
  s.games = [];
  let pointsPlayed = 0;

  input.forEach((g, i) => {
    const n = i + 1;
    if (!Number.isInteger(g.a) || !Number.isInteger(g.b) || g.a < 0 || g.b < 0) throw new ScoringError(`Game ${n}: scores must be whole numbers, 0 or more`);
    if (s.winner) throw new ScoringError(`Game ${n}: the match was already decided, so there cannot be another game`);
    const winner = gameWinner(cfg, g.a, g.b);
    const isLast = i === input.length - 1;
    if (!winner && !(partial && isLast)) {
      const need = cfg.cap !== null ? ` (${cfg.pointsToWin} with a ${cfg.winBy}-point lead, or ${cfg.cap})` : ` (${cfg.pointsToWin} with a ${cfg.winBy}-point lead)`;
      throw new ScoringError(`Game ${n}: ${g.a}-${g.b} is not a finished game${need}`);
    }
    if (winner) {
      // A game ends the moment a side reaches the target with the required lead (or hits the cap),
      // so the winner's score is fully determined by the loser's.
      const lo = Math.min(g.a, g.b);
      const hi = Math.max(g.a, g.b);
      const ends = Math.max(cfg.pointsToWin, lo + cfg.winBy);
      const expected = cfg.cap !== null ? Math.min(cfg.cap, ends) : ends;
      if (hi !== expected) throw new ScoringError(`Game ${n}: ${g.a}-${g.b} is not possible; with ${lo} the game ends at ${expected}`);
    }
    s.games.push({ a: g.a, b: g.b, winner });
    pointsPlayed += g.a + g.b;
    if (winner) {
      s.gamesWon[winner]++;
      if (s.gamesWon[winner] >= cfg.gamesToWin) s.winner = winner;
    }
  });

  if (!partial && !s.winner) throw new ScoringError(`The match is not finished: a side needs ${cfg.gamesToWin} game${cfg.gamesToWin > 1 ? 's' : ''}`);
  if (s.games.length === 0) s.games.push({ a: 0, b: 0, winner: null });
  s.currentGame = s.games.length - 1;
  s.pointsPlayed = pointsPlayed;
  s.isDecider = !s.winner && s.gamesWon.A === cfg.gamesToWin - 1 && s.gamesWon.B === cfg.gamesToWin - 1;
  return s;
}
