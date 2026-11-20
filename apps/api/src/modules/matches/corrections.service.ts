import crypto from 'node:crypto';
import {
  emptyScore,
  formatGames,
  scoreFromGames,
  ScoringError,
  type CorrectResultInput,
  type MatchDto,
  type MatchStatus,
  type ScoreState,
  type ScoringConfig,
  type Side,
} from '@bt/shared';
import { Match } from '../../models/index.js';
import type { Broadcaster } from '../../sockets/index.js';
import { conflict, notFound, unprocessable } from '../../utils/errors.js';
import { audit } from '../audit.js';
import { MATCH_POPULATE, matchDto } from '../dto.js';
import { advanceFromMatch, assertWinnerChangeAllowed } from '../brackets/advance.service.js';
import { requestBackupSoon } from '../system/backup.service.js';

type Actor = { kind: string; id: string; name: string };
const CORRECTABLE: MatchStatus[] = ['completed', 'walkover', 'retired'];

/** Hooks other modules (brackets, backups) can attach to; set once at startup. */
export const correctionHooks: {
  /** Called inside a correction before it is written; throw to refuse (e.g. the winner already played the next round). */
  before?: (match: NonNullable<Awaited<ReturnType<typeof loadMatch>>>, next: { winner: Side | null; status: MatchStatus }) => Promise<void>;
  /** Called after a correction was written. */
  after?: (matchId: string) => Promise<void>;
} = {};

const loadMatch = (id: string) => Match.findById(id).lean();

/**
 * Admin correction of a finished result (decisions D7). The old and new values go to the audit log with
 * the reason, the version check stops two admins overwriting each other, and standings recalculate.
 */
export async function correctResult(matchId: string, input: CorrectResultInput, actor: Actor, broadcaster: Broadcaster): Promise<MatchDto> {
  const m = await loadMatch(matchId);
  if (!m) throw notFound('Match');
  if (!CORRECTABLE.includes(m.status as MatchStatus)) {
    throw unprocessable('Only finished matches can be corrected. While a match is live, use undo on the scoring screen.', 'not_final');
  }
  if (m.version !== input.expectedVersion) {
    const dto = matchDto((await Match.findById(matchId).populate(MATCH_POPULATE).lean())!);
    throw conflict('The match changed on another device. Reload and try again.', 'version_conflict', { match: dto });
  }

  const cfg = m.scoring as unknown as ScoringConfig;
  const oldScore = m.score as unknown as ScoreState;
  const status = (input.status ?? m.status) as MatchStatus;
  const currentGames = oldScore.games.filter((g) => g.a + g.b > 0 || g.winner).map((g) => ({ a: g.a, b: g.b }));
  const games = input.games ?? currentGames;
  const side = (input.winner ?? m.winner ?? null) as Side | null;

  let score: ScoreState;
  let winner: Side | null;
  try {
    if (status === 'walkover') {
      if (!side) throw new ScoringError('Choose who won the walkover');
      score = emptyScore();
      winner = side;
    } else if (status === 'retired') {
      if (!side) throw new ScoringError('Choose who won (the side that did not retire)');
      score = scoreFromGames(cfg, games, { partial: true });
      winner = side;
    } else {
      score = scoreFromGames(cfg, games);
      winner = score.winner;
      if (input.winner && input.winner !== winner) throw new ScoringError(`The games give the win to side ${winner}, not ${input.winner}`);
    }
  } catch (e) {
    if (e instanceof ScoringError) throw unprocessable(e.message, 'scoring_rule');
    throw e;
  }

  const sameGames = JSON.stringify(score.games.map((g) => [g.a, g.b])) === JSON.stringify(oldScore.games.map((g) => [g.a, g.b]));
  if (status === m.status && winner === m.winner && sameGames) throw unprocessable('That is the same result as now. Nothing to correct.', 'no_change');

  await assertWinnerChangeAllowed(m, winner);

  const now = new Date();
  const updated = await Match.findOneAndUpdate(
    { _id: m._id, version: m.version, status: { $in: CORRECTABLE } },
    {
      $set: { status, winner, score },
      $push: { actions: { actionId: crypto.randomUUID(), type: 'correct', by: { kind: actor.kind, name: actor.name }, at: now } },
      $inc: { version: 1, correctionCount: 1 },
    },
    { new: true },
  )
    .populate(MATCH_POPULATE)
    .lean();
  if (!updated) throw conflict('The match changed meanwhile. Reload and try again.', 'version_conflict');

  await audit({
    actor,
    action: 'correct_result',
    entity: 'match',
    entityId: m._id,
    tournamentId: m.tournamentId,
    before: { status: m.status, winner: m.winner ?? null, games: formatGames(oldScore.games) || '–' },
    after: { status, winner, games: status === 'walkover' ? 'W/O' : formatGames(score.games) || '–' },
    reason: input.reason,
  });

  const dto = matchDto(updated);
  broadcaster.match('match:corrected', dto);
  broadcaster.tournament(dto.tournamentId, 'standings:updated', { tournamentId: dto.tournamentId });
  requestBackupSoon();
  await advanceFromMatch(matchId, broadcaster);
  return dto;
}
