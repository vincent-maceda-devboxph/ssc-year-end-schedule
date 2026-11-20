import {
  emptyScore,
  generateRoundRobin,
  matchupKey,
  type GenCategory,
  type GenerateMatchesResult,
} from '@bt/shared';
import { Category, Entry, Match, Team, Tournament } from '../../models/index.js';
import type { Broadcaster } from '../../sockets/index.js';
import { notFound } from '../../utils/errors.js';
import { audit } from '../audit.js';
import { reserveNumbers } from '../../utils/counters.js';

/** Statuses of generated matches that `replace` may delete: never started, nothing recorded. */
const REPLACEABLE = ['pending', 'scheduled', 'ready'];

/**
 * Creates every round-robin match for the selected categories (docs/scheduling-plan.md §4).
 * Independent from scheduling: new matches are `pending` with no court or time.
 * Re-running is safe: existing matchups are skipped, and a unique index blocks duplicates.
 */
export async function generateMatches(
  tournamentId: string,
  opts: { categoryIds?: string[]; replace: boolean },
  actor: { kind: string; id: string; name: string },
  broadcaster: Broadcaster,
): Promise<GenerateMatchesResult> {
  if (!(await Tournament.exists({ _id: tournamentId }))) throw notFound('Tournament');
  const result: GenerateMatchesResult = { created: 0, deleted: 0, skipped: 0, problems: [] };

  const categories = await Category.find({
    tournamentId,
    format: { $in: ['team_round_robin', 'round_robin'] },
    ...(opts.categoryIds?.length ? { _id: { $in: opts.categoryIds } } : {}),
  })
    .sort({ priority: 1, name: 1 })
    .lean();
  if (!categories.length) {
    result.problems.push('No round-robin categories selected. Set a category format to "Team round robin".');
    return result;
  }
  const catIds = categories.map((c) => c._id);

  if (opts.replace) {
    const del = await Match.deleteMany({
      tournamentId,
      categoryId: { $in: catIds },
      generatedBy: { $ne: null },
      status: { $in: REPLACEABLE },
      'actions.0': { $exists: false },
    });
    result.deleted = del.deletedCount;
  }

  const [entries, teams, existing] = await Promise.all([
    Entry.find({ tournamentId, categoryId: { $in: catIds }, status: 'active' }).lean(),
    Team.find({ tournamentId }).lean(),
    Match.find({ tournamentId, categoryId: { $in: catIds } }).select('categoryId entryAId entryBId').lean(),
  ]);
  const withdrawnTeams = new Set(teams.filter((t) => t.status === 'withdrawn').map((t) => String(t._id)));
  const existingKeys = new Set(existing.map((m) => matchupKey(String(m.categoryId), String(m.entryAId), String(m.entryBId))));

  const groupOf = new Map(entries.map((e) => [String(e._id), e.group || '']));
  const genCats: GenCategory[] = categories.flatMap((c) => {
    const isTeam = c.format === 'team_round_robin';
    const pairs = entries.filter((e) => String(e.categoryId) === String(c._id));
    const noTeam = isTeam ? pairs.filter((e) => !e.teamId) : [];
    if (noTeam.length) result.problems.push(`${c.name}: ${noTeam.map((e) => e.displayName).join(', ')} not on a team (left out)`);
    const make = (name: string, subset: typeof pairs): GenCategory => ({
      id: String(c._id),
      name,
      // Team divisions pair up by position in each team's list; open divisions are a plain round robin.
      ranked: isTeam,
      allowSameTeam: !isTeam || c.allowSameTeam,
      pairs: subset
        .filter((e) => !isTeam || (e.teamId && !withdrawnTeams.has(String(e.teamId))))
        .map((e) => ({ id: String(e._id), teamId: e.teamId ? String(e.teamId) : null, label: e.displayName, rank: e.rank ?? null })),
    });
    // A group stage: everyone plays only the others in their group.
    const groups = isTeam ? [''] : [...new Set(pairs.map((e) => e.group || ''))].sort();
    if (groups.length === 1 && groups[0] === '') return [make(c.name, pairs)];
    return groups.map((g) => make(g ? `${c.name} · Group ${g}` : c.name, pairs.filter((e) => (e.group || '') === g)));
  });

  const out = generateRoundRobin(genCats);
  result.problems.push(...out.problems);
  const fresh = out.matches.filter((m) => {
    const dup = existingKeys.has(matchupKey(m.categoryId, m.entryAId, m.entryBId));
    if (dup) result.skipped++;
    return !dup;
  });
  if (!fresh.length) return result;

  // Reserve a block of match numbers in one atomic step.
  let n = await reserveNumbers(tournamentId, 'nextMatchNumber', fresh.length);
  const catById = new Map(categories.map((c) => [String(c._id), c]));
  const docs = fresh.map((m) => ({
    tournamentId,
    categoryId: m.categoryId,
    matchNumber: n++,
    round: groupOf.get(m.entryAId) ? `Group ${groupOf.get(m.entryAId)} · Round ${m.round}` : `Round ${m.round}`,
    roundNumber: m.round,
    rank: m.rank,
    entryAId: m.entryAId,
    entryBId: m.entryBId,
    teamAId: m.teamAId,
    teamBId: m.teamBId,
    status: 'pending',
    scoring: catById.get(m.categoryId)!.scoring,
    score: emptyScore(),
    generatedBy: 'round_robin',
    matchupKey: matchupKey(m.categoryId, m.entryAId, m.entryBId),
  }));

  try {
    const inserted = await Match.insertMany(docs, { ordered: false });
    result.created = inserted.length;
  } catch (err) {
    // Another admin generated the same matchups at the same moment: keep theirs.
    // The driver reports per-document codes on writeErrors[i].err.code.
    const e = err as { insertedDocs?: unknown[]; writeErrors?: { code?: number; err?: { code?: number } }[] };
    const errs = e.writeErrors ?? [];
    const allDuplicates = errs.length > 0 && errs.every((w) => (w.code ?? w.err?.code) === 11000);
    if (!allDuplicates) throw err;
    result.created = e.insertedDocs?.length ?? docs.length - errs.length;
    result.skipped += errs.length;
  }

  await audit({
    actor,
    action: 'generate_matches',
    entity: 'tournament',
    entityId: tournamentId,
    tournamentId,
    after: { categories: categories.map((c) => c.name), ...result },
  });
  broadcaster.tournament(tournamentId, 'schedule:updated', { tournamentId });
  return result;
}
