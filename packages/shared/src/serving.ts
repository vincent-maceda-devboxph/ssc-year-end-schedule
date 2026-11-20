import { gameWinner, type ScoringConfig, type Side } from './scoring.js';

/** A player of a doubles pair: 0 = the first name of the pair, 1 = the second. */
export type PlayerIdx = 0 | 1;

/** Who serves and who receives at the start of a game (chosen by the umpire at the toss / after each game). */
export interface ServeSetup {
  side: Side;
  server: PlayerIdx;
  receiver: PlayerIdx;
}

export interface ServingState {
  /** Side that serves the next rally. */
  side: Side;
  /** Player of that side who serves the next rally. */
  server: PlayerIdx;
  /** Player of the other side who receives it. */
  receiver: PlayerIdx;
  /** Which player of each side stands in the right-hand service court. */
  right: Record<Side, PlayerIdx>;
  /** The umpire has set the first server of the current game (false = this is only a suggestion). */
  confirmed: boolean;
}

const other = (s: Side): Side => (s === 'A' ? 'B' : 'A');
const flip = (p: PlayerIdx): PlayerIdx => (p === 0 ? 1 : 0);

/**
 * Doubles service rules, replayed from the rally winners of a match (the same input as computeScore):
 *  - a game starts with the chosen server in the right court and the chosen receiver diagonally opposite;
 *  - the server serves from the right court when their side's score is even, from the left when odd;
 *  - when the serving side wins a rally the same player serves again, and that side's two players swap courts;
 *  - when the receiving side wins, it takes over the serve and nobody changes court.
 * `setups` holds the umpire's choice per game number (0-based). A game without a setup continues from the
 * previous game (the winners serve, starting with whoever would have served next).
 */
export function computeServing(cfg: ScoringConfig, points: readonly Side[], setups: Readonly<Record<number, ServeSetup>> = {}): ServingState {
  let game = 0;
  let score = { A: 0, B: 0 };
  let side: Side = 'A';
  let right: Record<Side, PlayerIdx> = { A: 0, B: 0 };
  let carry: ServeSetup | null = null; // what the next game would start with by default

  const begin = () => {
    const chosen = setups[game];
    const s = chosen ?? carry ?? { side: 'A' as Side, server: 0 as PlayerIdx, receiver: 0 as PlayerIdx };
    side = s.side;
    right = { A: 0, B: 0 };
    right[s.side] = s.server;
    right[other(s.side)] = s.receiver;
    return !!chosen;
  };
  const next = (): { server: PlayerIdx; receiver: PlayerIdx } => {
    const even = score[side] % 2 === 0;
    return { server: even ? right[side] : flip(right[side]), receiver: even ? right[other(side)] : flip(right[other(side)]) };
  };

  let confirmed = begin();
  for (const winner of points) {
    if (winner === side) right[side] = flip(right[side]);
    else side = winner;
    score[winner]++;
    if (gameWinner(cfg, score.A, score.B)) {
      const n = next();
      carry = { side, server: n.server, receiver: n.receiver };
      game++;
      score = { A: 0, B: 0 };
      confirmed = begin();
    }
  }
  const n = next();
  return { side, server: n.server, receiver: n.receiver, right: { ...right }, confirmed };
}

/** The umpire's server choices in an action log: the latest 'servers' action per game number. */
export function serveSetupsFromActions(
  actions: readonly { type: string; side?: Side; server?: number; receiver?: number; game?: number }[],
): Record<number, ServeSetup> {
  const out: Record<number, ServeSetup> = {};
  for (const x of actions) {
    if (x.type === 'servers' && x.side && (x.server === 0 || x.server === 1) && (x.receiver === 0 || x.receiver === 1)) {
      out[x.game ?? 0] = { side: x.side, server: x.server, receiver: x.receiver };
    }
  }
  return out;
}
