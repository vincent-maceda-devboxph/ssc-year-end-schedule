import mongoose from 'mongoose';
import {
  buildBracket,
  computePairStandings,
  emptyScore,
  groupName,
  qualifierSeeds,
  snakeGroups,
  type PairStanding,
  type StandingMatch,
} from '@bt/shared';
import { Category, Entry, Match, Tournament } from '../../models/index.js';
import type { Broadcaster } from '../../sockets/index.js';
import { conflict, notFound, unprocessable } from '../../utils/errors.js';
import { audit } from '../audit.js';
import { reserveNumbers } from '../../utils/counters.js';

type Actor = { kind: string; id: string; name: string };
const FINISHED = ['completed', 'walkover', 'retired'];
const OPEN = ['pending', 'scheduled', 'ready'];
type Games = { a: number; b: number; winner: 'A' | 'B' | null }[];

const bySeed = (a: { seed?: number | null; displayName: string }, b: { seed?: number | null; displayName: string }) =>
  (a.seed ?? 1e9) - (b.seed ?? 1e9) || a.displayName.localeCompare(b.displayName);

// ------------------------------------------------------------------ groups

/** Each group's table, ranked (wins, then head-to-head / game and point difference). A division without groups is one group named "". */
export async function groupRankings(categoryId: string): Promise<{ group: string; ranked: string[]; table: PairStanding[] }[]> {
  const [entries, matches] = await Promise.all([
    Entry.find({ categoryId, status: 'active' }).lean(),
    Match.find({ categoryId, status: { $in: FINISHED } }).select('entryAId entryBId status winner score.games').lean(),
  ]);
  const names = [...new Set(entries.map((e) => e.group || ''))].sort();
  return names.map((g) => {
    const members = entries.filter((e) => (e.group || '') === g);
    const ids = new Set(members.map((e) => String(e._id)));
    const rows: StandingMatch[] = matches
      .filter((m) => ids.has(String(m.entryAId)) && ids.has(String(m.entryBId)))
      .map((m) => ({
        categoryId,
        entryAId: String(m.entryAId),
        entryBId: String(m.entryBId),
        teamAId: null,
        teamBId: null,
        status: m.status,
        winner: (m.winner ?? null) as 'A' | 'B' | null,
        games: ((m.score as { games?: Games } | undefined)?.games ?? []) as Games,
      }));
    const table = computePairStandings(members.map((e) => ({ id: String(e._id), name: e.displayName, teamId: e.teamId ? String(e.teamId) : null })), rows);
    return { group: g, ranked: table.map((t) => t.entryId), table };
  });
}

/** Split a round-robin division into `count` groups, in snake order by seed (before any matches exist). */
export async function assignGroups(categoryId: string, count: number, actor: Actor) {
  const cat = await Category.findById(categoryId).lean();
  if (!cat) throw notFound('Division');
  if (cat.format !== 'round_robin') throw unprocessable('Groups are for round-robin divisions. Set the division format to "Round robin" first.', 'not_round_robin');
  if (await Match.exists({ categoryId })) throw conflict('This division already has matches. Delete them before changing the groups.', 'has_matches');
  const entries = (await Entry.find({ categoryId, status: 'active' }).lean()).sort(bySeed);
  if (entries.length < count * 2) throw unprocessable(`${entries.length} entries are too few for ${count} groups (at least 2 per group).`, 'too_few_entries');

  const groups = snakeGroups(entries, count);
  await Entry.bulkWrite(groups.flatMap((g, i) => g.map((e) => ({ updateOne: { filter: { _id: e._id }, update: { $set: { group: groupName(i) } } } }))));
  await audit({ actor, action: 'assign_groups', entity: 'category', entityId: cat._id, tournamentId: cat.tournamentId, after: { groups: count, entries: entries.length } });
  return groups.map((g, i) => ({ group: groupName(i), entries: g.map((e) => ({ id: String(e._id), name: e.displayName })) }));
}

export async function clearGroups(categoryId: string, actor: Actor) {
  const cat = await Category.findById(categoryId).lean();
  if (!cat) throw notFound('Division');
  if (await Match.exists({ categoryId })) throw conflict('This division already has matches. Delete them before changing the groups.', 'has_matches');
  await Entry.updateMany({ categoryId }, { $set: { group: '' } });
  await audit({ actor, action: 'clear_groups', entity: 'category', entityId: cat._id, tournamentId: cat.tournamentId });
}

// ------------------------------------------------------------------ bracket

export interface BracketResult {
  created: number;
  rounds: number;
  byes: number;
  /** Seed order used, as pair names. */
  seeds: string[];
  deleted: number;
}

/**
 * Build the knockout matches for a knockout division: from its own entries (by seed), or from the
 * qualifiers of a group stage. Later-round sides stay empty ("TBD") until the feeder match is decided.
 */
export async function generateBracketMatches(
  categoryId: string,
  opts: { advancePerGroup?: number; replace: boolean; force: boolean },
  actor: Actor,
  broadcaster: Broadcaster,
): Promise<BracketResult> {
  const cat = await Category.findById(categoryId).lean();
  if (!cat) throw notFound('Division');
  if (cat.format !== 'knockout') throw unprocessable('This division is not a knockout. Set its format to "Knockout".', 'not_knockout');

  // ---- who plays, in seed order ----
  let seedIds: string[];
  if (cat.sourceCategoryId) {
    const src = await Category.findById(cat.sourceCategoryId).lean();
    if (!src) throw notFound('Source division');
    const unfinished = await Match.countDocuments({ categoryId: src._id, status: { $nin: [...FINISHED, 'cancelled'] } });
    if (unfinished && !opts.force) {
      throw conflict(`${unfinished} match(es) of ${src.name} are not finished yet. Finish them first, or build the bracket from the current table anyway.`, 'groups_unfinished');
    }
    const tables = await groupRankings(String(src._id));
    const single = tables.length === 1 && tables[0]!.group === '';
    seedIds = qualifierSeeds(tables, opts.advancePerGroup ?? (single ? tables[0]!.ranked.length : 2));
  } else {
    seedIds = (await Entry.find({ categoryId, status: 'active' }).lean()).sort(bySeed).map((e) => String(e._id));
  }
  if (seedIds.length < 2) throw unprocessable('A knockout needs at least 2 entries.', 'not_enough_entries');

  // ---- an existing bracket ----
  const existing = await Match.find({ categoryId, bracketRound: { $ne: null } }).select('status actions').lean();
  let deleted = 0;
  if (existing.length) {
    if (!opts.replace) throw conflict('This knockout already has a bracket. Use "Rebuild" to replace it.', 'already_generated');
    if (existing.some((m) => !OPEN.includes(m.status) || m.actions.length)) {
      throw conflict('Some knockout matches have already been played or started, so the bracket cannot be rebuilt.', 'bracket_started');
    }
    deleted = (await Match.deleteMany({ _id: { $in: existing.map((m) => m._id) } })).deletedCount;
  }

  // ---- plan and save ----
  const plan = buildBracket(seedIds, { thirdPlace: cat.thirdPlace });
  let number = await reserveNumbers(cat.tournamentId, 'nextMatchNumber', plan.matches.length);
  const id = new Map(plan.matches.map((m) => [m.key, new mongoose.Types.ObjectId()]));
  const winnerTo = new Map<string, { to: mongoose.Types.ObjectId; slot: 'A' | 'B' }>();
  const loserTo = new Map<string, { to: mongoose.Types.ObjectId; slot: 'A' | 'B' }>();
  for (const m of plan.matches) {
    const to = id.get(m.key)!;
    if (m.fromA) winnerTo.set(m.fromA, { to, slot: 'A' });
    if (m.fromB) winnerTo.set(m.fromB, { to, slot: 'B' });
    if (m.loserFromA) loserTo.set(m.loserFromA, { to, slot: 'A' });
    if (m.loserFromB) loserTo.set(m.loserFromB, { to, slot: 'B' });
  }
  const docs = plan.matches.map((m) => ({
    _id: id.get(m.key),
    tournamentId: cat.tournamentId,
    categoryId: cat._id,
    matchNumber: number++,
    round: m.roundLabel,
    roundNumber: m.round,
    bracketRound: m.round,
    bracketPos: m.pos,
    isThirdPlace: m.third,
    entryAId: m.entryA,
    entryBId: m.entryB,
    advancesToMatchId: winnerTo.get(m.key)?.to ?? null,
    advancesToSlot: winnerTo.get(m.key)?.slot ?? null,
    loserToMatchId: loserTo.get(m.key)?.to ?? null,
    loserToSlot: loserTo.get(m.key)?.slot ?? null,
    status: 'pending',
    scoring: cat.scoring,
    score: emptyScore(),
    generatedBy: 'knockout',
    matchupKey: `bracket:${String(cat._id)}:${m.key}`,
  }));
  try {
    await Match.insertMany(docs, { ordered: true });
  } catch (e) {
    const code = (e as { code?: number; writeErrors?: { code?: number; err?: { code?: number } }[] });
    if (code.code === 11000 || code.writeErrors?.some((w) => (w.code ?? w.err?.code) === 11000)) {
      throw conflict('Someone else just built this bracket.', 'already_generated');
    }
    throw e;
  }

  const entryNames = new Map((await Entry.find({ _id: { $in: seedIds } }).select('displayName').lean()).map((e) => [String(e._id), e.displayName]));
  const result: BracketResult = { created: docs.length, rounds: plan.rounds, byes: plan.byes, seeds: seedIds.map((s) => entryNames.get(s) ?? '?'), deleted };
  await audit({ actor, action: 'generate_bracket', entity: 'category', entityId: cat._id, tournamentId: cat.tournamentId, after: { ...result, advancePerGroup: opts.advancePerGroup ?? null } });
  broadcaster.tournament(String(cat.tournamentId), 'schedule:updated', { tournamentId: String(cat.tournamentId) });
  return result;
}
