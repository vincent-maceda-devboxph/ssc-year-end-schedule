import {
  bracketLabel,
  divisionCode,
  DEFAULT_SCHEDULE_SETTINGS,
  findConflicts,
  gameNumber,
  isFinal,
  isLive,
  scheduleMatches,
  scheduleSettingsSchema,
  slotOf,
  slotStart,
  type EngineCourt,
  type EngineMatch,
  type MatchStatus,
  type Placement,
  type ScheduleAssignment,
  type ScheduleIssue,
  type SchedulePreview,
  type ScheduleSettings,
  type ScheduleVersionDto,
  type ScheduleView,
  type SlotMath,
} from '@bt/shared';
import { Category, Court, Entry, Match, Player, Schedule, Team, Tournament } from '../../models/index.js';
import type { Broadcaster } from '../../sockets/index.js';
import { conflict, notFound, unprocessable } from '../../utils/errors.js';
import { audit } from '../audit.js';
import { MATCH_POPULATE } from '../dto.js';
import { requestBackupSoon } from '../system/backup.service.js';
import { reserveNumbers } from '../../utils/counters.js';

type Actor = { kind: string; id: string; name: string };
/** Statuses the scheduler may (re)place. Everything else keeps its cell. */
export const SCHEDULABLE: MatchStatus[] = ['pending', 'scheduled', 'ready'];

/**
 * Which matches must be played before each knockout match: the matches that feed it (winner or loser).
 * A feeder that is already finished no longer holds anything back.
 */
export function dependencyMap(docs: { _id: unknown; status: string; advancesToMatchId?: unknown; loserToMatchId?: unknown }[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const d of docs) {
    if (isFinal(d.status as MatchStatus)) continue;
    for (const dest of [d.advancesToMatchId, d.loserToMatchId]) {
      if (!dest) continue;
      const k = String(dest);
      out.set(k, [...(out.get(k) ?? []), String(d._id)]);
    }
  }
  return out;
}

const iso = (d: Date) => d.toISOString();

export async function loadSettings(tournamentId: string): Promise<ScheduleSettings> {
  const t = await Tournament.findById(tournamentId).select('schedule').lean();
  if (!t) throw notFound('Tournament');
  return { ...DEFAULT_SCHEDULE_SETTINGS, ...((t.schedule as Partial<ScheduleSettings> | null) ?? {}) };
}

export async function saveSettings(tournamentId: string, patch: Partial<ScheduleSettings>): Promise<ScheduleSettings> {
  const merged = scheduleSettingsSchema.safeParse({ ...(await loadSettings(tournamentId)), ...patch });
  if (!merged.success) throw unprocessable(merged.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), 'invalid_settings');
  const s = merged.data;
  if (s.endAt && s.startAt && Date.parse(s.endAt) <= Date.parse(s.startAt)) {
    throw unprocessable('The end time must be after the start time', 'invalid_settings');
  }
  await Tournament.updateOne({ _id: tournamentId }, { $set: { schedule: s } });
  return s;
}

/** Everything the engine needs, built from the database. */
/**
 * `earlier` lists levels to play first, as "categoryId:rank" (e.g. all MD-E matches). Their matches go ahead of
 * everything that can still move, and every movable match is re-planned around them (locked, called, live and
 * finished matches stay where they are).
 */
export async function buildContext(tournamentId: string, settings: ScheduleSettings, earlier: readonly string[] = [], earlierFrom: string | null = null, earlierUntil: string | null = null) {
  if (!settings.startAt) throw unprocessable('Set the start time first', 'no_start_time');
  const math: SlotMath = { startMs: Date.parse(settings.startAt), minutes: settings.matchMinutes };
  const unit = math.minutes * 60_000;

  const [courtDocs, matchDocs, entries, categories, teams] = await Promise.all([
    Court.find({ tournamentId, active: true }).sort({ order: 1, name: 1 }).lean(),
    Match.find({ tournamentId, status: { $ne: 'cancelled' } }).select('-actions').lean(),
    Entry.find({ tournamentId }).select('playerIds status teamId displayName').lean(),
    Category.find({ tournamentId }).select('name code priority').lean(),
    Team.find({ tournamentId }).select('status').lean(),
  ]);
  if (!courtDocs.length) throw unprocessable('Add at least one active court first', 'no_courts');

  const courtIndex = new Map(courtDocs.map((c, i) => [String(c._id), i]));
  const engineCourts: EngineCourt[] = courtDocs.map((c) => ({
    id: String(c._id),
    availableFrom: c.availableFrom ? Math.max(0, Math.ceil((c.availableFrom.getTime() - math.startMs) / unit)) : null,
    availableUntil: c.availableUntil ? Math.max(0, Math.ceil((c.availableUntil.getTime() - math.startMs) / unit)) : null,
  }));

  const entryById = new Map(entries.map((e) => [String(e._id), e]));
  const catById = new Map(categories.map((c) => [String(c._id), c]));
  const withdrawnTeams = new Set(teams.filter((t) => t.status === 'withdrawn').map((t) => String(t._id)));

  /** The cell a match currently occupies, if it can be read on this grid. */
  const cellOf = (m: (typeof matchDocs)[number]): { slot: number; court: number } | null => {
    if (!m.courtId || !m.plannedStart) return null;
    const court = courtIndex.get(String(m.courtId));
    const slot = slotOf(math, m.plannedStart);
    return court === undefined || slot === null || slot < 0 ? null : { slot, court };
  };

  const earlierSet = new Set(earlier);
  // "…but not before 1:20 PM": the earliest slot the chosen levels may use.
  // "…and finished by 4:00 PM": the last match of the chosen levels must end by then.
  const earlierLastSlot = earlierUntil ? Math.floor((Date.parse(earlierUntil) - math.startMs) / unit) - 1 : Infinity;
  const earlierFromSlot = earlierFrom ? Math.max(0, Math.ceil((Date.parse(earlierFrom) - math.startMs) / unit)) : 0;
  const deps = dependencyMap(matchDocs);
  const engine: EngineMatch[] = [];
  const excluded: { matchId: string; reason: string; players: string[] }[] = [];
  for (const m of matchDocs) {
    const status = m.status as MatchStatus;
    const a = entryById.get(String(m.entryAId));
    const b = entryById.get(String(m.entryBId));
    const cell = cellOf(m);
    const playerIds = [...(a?.playerIds ?? []), ...(b?.playerIds ?? [])].map(String);
    const base = {
      id: String(m._id),
      categoryId: `${String(m.categoryId)}:${m.rank ?? 0}`,
      priority: earlierSet.has(`${String(m.categoryId)}:${m.rank ?? 0}`) ? -1 : (catById.get(String(m.categoryId))?.priority ?? 100),
      rank: m.rank ?? null,
      notBeforeSlot: earlierSet.has(`${String(m.categoryId)}:${m.rank ?? 0}`) ? earlierFromSlot : 0,
      ...(earlierSet.has(`${String(m.categoryId)}:${m.rank ?? 0}`) && Number.isFinite(earlierLastSlot) ? { notAfterSlot: earlierLastSlot } : {}),
      round: m.roundNumber ?? 1,
      matchNumber: m.matchNumber,
      playerIds,
      teamIds: [m.teamAId, m.teamBId].filter(Boolean).map(String),
      after: deps.get(String(m._id)) ?? [],
    };
    // Live, finished, called (players are on their way) and locked matches keep their cell.
    const stays = isLive(status) || isFinal(status) || status === 'called' || (m.isLocked && SCHEDULABLE.includes(status));
    if (stays) {
      if (cell) engine.push({ ...base, fixed: cell });
      else if (!isLive(status) && !isFinal(status)) {
        // Its court or time is gone (court closed, time moved off the grid): say so instead of ignoring it.
        excluded.push({ matchId: base.id, reason: 'Locked or called, but its court or time is no longer available', players: [] });
      }
      continue;
    }
    if (!SCHEDULABLE.includes(status)) continue;
    if (a?.status === 'withdrawn' || b?.status === 'withdrawn' || withdrawnTeams.has(String(m.teamAId)) || withdrawnTeams.has(String(m.teamBId))) {
      excluded.push({ matchId: base.id, reason: 'A pair or team has withdrawn', players: [] });
      continue;
    }
    engine.push({ ...base, preferred: m.scheduleVersion != null && !earlierSet.size ? cell : null });
  }

  const slotCount = settings.endAt ? Math.floor((Date.parse(settings.endAt) - math.startMs) / unit) : null;
  return { math, courtDocs, engineCourts, engine, excluded, matchDocs, slotCount };
}

type Ctx = Awaited<ReturnType<typeof buildContext>>;

export async function playerNames(ids: string[]): Promise<Map<string, string>> {
  const uniq = [...new Set(ids)];
  if (!uniq.length) return new Map();
  const docs = await Player.find({ _id: { $in: uniq } }).select('firstName lastName').lean();
  return new Map(docs.map((p) => [String(p._id), `${p.firstName} ${p.lastName ?? ''}`.trim()]));
}

function toAssignment(ctx: Ctx, p: Placement, fixed: boolean): ScheduleAssignment {
  const start = slotStart(ctx.math, p.slot);
  return {
    matchId: p.matchId,
    courtId: ctx.engineCourts[p.court]!.id,
    slot: p.slot,
    start: iso(start),
    end: iso(new Date(start.getTime() + ctx.math.minutes * 60_000)),
    gameNumber: gameNumber(p.slot, p.court, ctx.engineCourts.length),
    ...(fixed ? { fixed: true } : {}),
  };
}

export async function preview(
  tournamentId: string,
  overrides: Partial<ScheduleSettings> = {},
  opts: { notBefore?: string | null; earlier?: readonly string[]; earlierFrom?: string | null; earlierUntil?: string | null } = {},
): Promise<SchedulePreview> {
  const settings = { ...(await loadSettings(tournamentId)), ...overrides };
  const ctx = await buildContext(tournamentId, settings, opts.earlier ?? [], opts.earlierFrom ?? null, opts.earlierUntil ?? null);
  // "Nothing new before 5:30 PM": round up to the next slot on the grid.
  const unit = ctx.math.minutes * 60_000;
  const minSlot = opts.notBefore ? Math.max(0, Math.ceil((Date.parse(opts.notBefore) - ctx.math.startMs) / unit)) : 0;
  const result = scheduleMatches(ctx.engineCourts, ctx.engine, {
    slotCount: ctx.slotCount,
    minSlot,
    minRestSlots: settings.minRestSlots,
    seed: settings.seed,
    maxTeamConcurrent: settings.maxTeamConcurrent,
    categoryCourtAffinity: settings.categoryCourtAffinity,
    rankOrder: settings.rankOrder,
  });

  const fixedAssignments = ctx.engine.filter((m) => m.fixed).map((m) => toAssignment(ctx, { matchId: m.id, ...m.fixed! }, true));
  const placed = result.placements.map((p) => toAssignment(ctx, p, false));
  const assignments = [...fixedAssignments, ...placed].sort((a, b) => a.slot - b.slot || a.gameNumber - b.gameNumber);

  const names = await playerNames([...result.unscheduled.flatMap((u) => u.playerIds), ...result.conflicts.map((c) => c.playerId ?? '').filter(Boolean)]);
  const issue = (c: (typeof result.conflicts)[number]): ScheduleIssue => ({
    type: c.type,
    message: c.message,
    matchIds: c.matchIds,
    players: c.playerId ? [names.get(c.playerId) ?? '?'] : undefined,
  });

  const byMatch = new Map(ctx.matchDocs.map((m) => [String(m._id), m]));
  const changes: SchedulePreview['changes'] = [];
  for (const a of placed) {
    const m = byMatch.get(a.matchId)!;
    const from = { courtId: m.courtId ? String(m.courtId) : null, start: m.plannedStart ? iso(m.plannedStart) : null };
    if (from.courtId !== a.courtId || from.start !== a.start) changes.push({ matchId: a.matchId, from, to: { courtId: a.courtId, start: a.start } });
  }

  const lastSlot = assignments.reduce((mx, a) => Math.max(mx, a.slot), -1);
  const estimatedEnd = lastSlot >= 0 ? iso(slotStart(ctx.math, lastSlot + 1)) : null;
  return {
    settings,
    notBefore: opts.notBefore ?? null,
    courts: ctx.courtDocs.map((c) => ({ id: String(c._id), name: c.name })),
    assignments,
    unscheduled: [
      ...result.unscheduled.map((u) => ({ matchId: u.matchId, reason: u.reason, players: u.playerIds.map((p) => names.get(p) ?? '?') })),
      ...ctx.excluded,
    ],
    conflicts: result.conflicts.map(issue),
    stats: {
      matches: ctx.engine.length + ctx.excluded.length,
      scheduled: result.stats.scheduled,
      fixed: result.stats.fixed,
      slots: result.slotsUsed,
      emptyCells: result.stats.emptyCells,
      minPlayerGapSlots: result.stats.minPlayerGap,
      avgPlayerGapSlots: result.stats.avgPlayerGap,
      estimatedEnd,
      pastEndTime: !!(settings.endAt && estimatedEnd && Date.parse(estimatedEnd) > Date.parse(settings.endAt)),
    },
    changes,
  };
}

const versionDto = (s: {
  _id: unknown; version: number; status: string; createdAt?: Date; createdBy?: { name?: string | null } | null;
  publishedAt?: Date | null; label?: string | null; settings: unknown; assignments: unknown[]; estimatedEnd?: Date | null;
}): ScheduleVersionDto => ({
  id: String(s._id),
  version: s.version,
  status: s.status as ScheduleVersionDto['status'],
  createdAt: (s.createdAt ?? new Date()).toISOString(),
  createdBy: s.createdBy?.name ?? '',
  publishedAt: s.publishedAt ? s.publishedAt.toISOString() : null,
  label: s.label ?? '',
  settings: s.settings as ScheduleSettings,
  matchCount: s.assignments.length,
  estimatedEnd: s.estimatedEnd ? s.estimatedEnd.toISOString() : null,
});

export async function listVersions(tournamentId: string): Promise<ScheduleVersionDto[]> {
  const list = await Schedule.find({ tournamentId }).select('-assignments').sort({ version: -1 }).lean();
  // assignments were left out for the list; matchCount comes from stats.
  return list.map((s) => versionDto({ ...s, assignments: Array((s.stats as { scheduled?: number })?.scheduled ?? 0) }));
}

/** A saved version laid out like a preview, so the organiser can look at it (and compare it with what is published) before publishing. */
export async function getVersion(tournamentId: string, versionId: string): Promise<SchedulePreview> {
  const doc = await Schedule.findOne({ _id: versionId, tournamentId }).lean();
  if (!doc) throw notFound('Schedule version');
  const [courtDocs, matches] = await Promise.all([
    Court.find({ tournamentId }).sort({ order: 1, name: 1 }).lean(),
    Match.find({ tournamentId }).select('courtId plannedStart').lean(),
  ]);
  const assignments = (doc.assignments ?? []) as unknown as ScheduleAssignment[];
  const used = new Set(assignments.map((a) => a.courtId));
  const courts = courtDocs.filter((c) => c.active || used.has(String(c._id))).map((c) => ({ id: String(c._id), name: c.name }));
  const current = new Map(matches.map((m) => [String(m._id), m]));
  const changes: SchedulePreview['changes'] = [];
  for (const a of assignments) {
    const m = current.get(a.matchId);
    if (!m) continue;
    const from = { courtId: m.courtId ? String(m.courtId) : null, start: m.plannedStart ? iso(m.plannedStart) : null };
    if (from.courtId !== a.courtId || from.start !== a.start) changes.push({ matchId: a.matchId, from, to: { courtId: a.courtId, start: a.start } });
  }
  const st = (doc.stats ?? {}) as Record<string, number | null | undefined> & { notBefore?: string | null };
  return {
    settings: doc.settings as unknown as ScheduleSettings,
    notBefore: st.notBefore ?? null,
    courts,
    assignments,
    unscheduled: [],
    conflicts: [],
    stats: {
      matches: st.matches ?? assignments.length,
      scheduled: st.scheduled ?? assignments.length,
      fixed: st.fixed ?? 0,
      slots: st.slots ?? 0,
      emptyCells: st.emptyCells ?? 0,
      minPlayerGapSlots: st.minPlayerGapSlots ?? null,
      avgPlayerGapSlots: st.avgPlayerGapSlots ?? null,
      estimatedEnd: doc.estimatedEnd ? iso(doc.estimatedEnd) : null,
      pastEndTime: false,
    },
    changes,
  };
}

/** Recomputes the schedule server-side (never trusts the client) and stores it as a draft version. */
export async function saveDraft(
  tournamentId: string,
  label: string,
  overrides: Partial<ScheduleSettings>,
  actor: Actor,
  notBefore: string | null = null,
  earlier: readonly string[] = [],
  earlierFrom: string | null = null,
  earlierUntil: string | null = null,
): Promise<ScheduleVersionDto> {
  const p = await preview(tournamentId, overrides, { notBefore, earlier, earlierFrom, earlierUntil });
  if (p.conflicts.length) throw unprocessable('The schedule has conflicts. Resolve them before saving.', 'has_conflicts');
  if (!p.assignments.length) throw unprocessable('There are no matches to schedule. Generate matches first.', 'nothing_to_schedule');
  const version = await reserveNumbers(tournamentId, 'nextScheduleVersion');
  const doc = await Schedule.create({
    tournamentId,
    version,
    status: 'draft',
    label,
    createdBy: actor,
    settings: p.settings,
    assignments: p.assignments,
    stats: { ...p.stats, unscheduled: p.unscheduled.length, notBefore },
    estimatedEnd: p.stats.estimatedEnd ? new Date(p.stats.estimatedEnd) : null,
  });
  await audit({ actor, action: 'save_schedule', entity: 'schedule', entityId: doc._id, tournamentId, after: { version: doc.version, ...p.stats } });
  return versionDto({ ...doc.toObject(), assignments: doc.assignments });
}

/**
 * Applies a draft to the matches. Re-validates against the CURRENT state first, since matches may
 * have started or changed since the draft was saved. The draft is claimed atomically, so two admins
 * cannot publish the same version twice.
 */
export async function publish(tournamentId: string, versionId: string, actor: Actor, broadcaster: Broadcaster): Promise<{ version: ScheduleVersionDto; applied: number; skipped: number; cleared: number }> {
  const draft = await Schedule.findOne({ _id: versionId, tournamentId }).lean();
  if (!draft) throw notFound('Schedule version');
  if (draft.status !== 'draft') throw conflict(`Version ${draft.version} is already ${draft.status}`, 'not_a_draft');

  const settings = draft.settings as ScheduleSettings;
  const ctx = await buildContext(tournamentId, settings);
  const courtIdx = new Map(ctx.engineCourts.map((c, i) => [c.id, i]));
  const engineById = new Map(ctx.engine.map((m) => [m.id, m]));

  // Which draft cells are still applicable? Fixed (live / finished / locked) matches keep their own cell.
  const apply: ScheduleAssignment[] = [];
  let skipped = 0;
  for (const a of draft.assignments as ScheduleAssignment[]) {
    const m = engineById.get(a.matchId);
    if (!m || m.fixed) {
      if (!a.fixed) skipped++; // the match started, finished, was locked or removed since the draft
      continue;
    }
    apply.push(a);
  }

  const grid: Placement[] = [
    ...ctx.engine.filter((m) => m.fixed).map((m) => ({ matchId: m.id, ...m.fixed! })),
    ...apply.map((a) => ({ matchId: a.matchId, slot: a.slot, court: courtIdx.get(a.courtId) ?? -1 })),
  ];
  const bad = findConflicts(ctx.engineCourts, ctx.engine, grid, settings.minRestSlots, ctx.slotCount);
  if (bad.length) {
    throw conflict('Matches changed since this draft was saved and it no longer fits. Preview and save a new version.', 'stale_draft', {
      conflicts: bad.map((b) => ({ type: b.type, message: b.message, matchIds: b.matchIds })),
    });
  }

  // Claim the draft (only one publisher wins).
  const claimed = await Schedule.findOneAndUpdate({ _id: versionId, status: 'draft' }, { $set: { status: 'published', publishedAt: new Date() } }, { new: true }).lean();
  if (!claimed) throw conflict('This version was just published by someone else', 'not_a_draft');
  await Schedule.updateMany({ tournamentId, status: 'published', _id: { $ne: draft._id } }, { $set: { status: 'superseded' } });

  const ids = new Set(apply.map((a) => a.matchId));
  const ops: Parameters<typeof Match.bulkWrite>[0] = apply.map((a) => ({
    updateOne: {
      filter: { _id: a.matchId, status: { $in: SCHEDULABLE }, isLocked: { $ne: true } },
      update: {
        $set: {
          courtId: a.courtId, plannedStart: new Date(a.start), plannedEnd: new Date(a.end), gameNumber: a.gameNumber,
          queuePosition: a.slot + 1, status: 'scheduled', scheduleVersion: draft.version,
        },
        $inc: { version: 1 },
      },
    },
  }));
  // Matches the new plan leaves out lose their old planned cell.
  const staleFilter = {
    tournamentId, plannedStart: { $ne: null }, status: { $in: SCHEDULABLE }, isLocked: { $ne: true },
    _id: { $nin: [...ids] },
  };
  const stale = await Match.countDocuments(staleFilter);
  ops.push({
    updateMany: {
      filter: staleFilter,
      update: {
        $set: { courtId: null, plannedStart: null, plannedEnd: null, gameNumber: null, queuePosition: 0, status: 'pending', scheduleVersion: null },
        $inc: { version: 1 },
      },
    },
  });
  await Match.bulkWrite(ops, { ordered: true });

  await audit({ actor, action: 'publish_schedule', entity: 'schedule', entityId: draft._id, tournamentId, after: { version: draft.version, applied: apply.length, skipped, cleared: stale } });
  broadcaster.tournament(tournamentId, 'schedule:published', { tournamentId, version: draft.version });
  requestBackupSoon();
  broadcaster.tournament(tournamentId, 'schedule:updated', { tournamentId });
  return { version: versionDto({ ...claimed, assignments: claimed.assignments }), applied: apply.length, skipped, cleared: stale };
}

/** The current (published) plan as the board needs it. Public: contains no secrets. */
export async function currentSchedule(tournamentId: string): Promise<ScheduleView> {
  const settings = await loadSettings(tournamentId);
  const [courts, matches, published] = await Promise.all([
    Court.find({ tournamentId }).sort({ order: 1, name: 1 }).lean(),
    Match.find({ tournamentId, status: { $ne: 'cancelled' } }).select('-actions').sort({ matchNumber: 1 }).populate(MATCH_POPULATE).lean(),
    Schedule.findOne({ tournamentId, status: 'published' }).select('version').lean(),
  ]);
  const activeIdx = new Map(courts.filter((c) => c.active).map((c, i) => [String(c._id), i]));
  const math: SlotMath | null = settings.startAt ? { startMs: Date.parse(settings.startAt), minutes: settings.matchMinutes } : null;
  const slotCount = settings.endAt && math ? Math.floor((Date.parse(settings.endAt) - math.startMs) / (math.minutes * 60_000)) : 0;

  const refId = (v: unknown) => (v && typeof v === 'object' && '_id' in v ? String((v as { _id: unknown })._id) : v ? String(v) : null);
  const team = (t: unknown) => {
    if (!t || typeof t !== 'object' || !('_id' in t)) return null;
    const d = t as { _id: unknown; name?: string; color?: string };
    return { id: String(d._id), name: d.name ?? '', color: d.color ?? '#e0e0e0' };
  };
  return {
    settings,
    courts: courts.map((c) => ({ id: String(c._id), name: c.name, active: c.active })),
    publishedVersion: published?.version ?? null,
    slotCount,
    matches: matches.map((m) => {
      const courtId = refId(m.courtId);
      const slot = m.plannedStart && math ? slotOf(math, m.plannedStart) : null;
      return {
        id: String(m._id),
        matchNumber: m.matchNumber,
        gameNumber: m.gameNumber ?? (slot !== null && courtId && activeIdx.has(courtId) ? gameNumber(slot, activeIdx.get(courtId)!, activeIdx.size) : null),
        categoryId: refId(m.categoryId)!,
        categoryName: bracketLabel(
          (m.categoryId as unknown as { code?: string; name?: string })?.code || divisionCode((m.categoryId as unknown as { name?: string })?.name ?? ''),
          (m.categoryId as unknown as { name?: string })?.name ?? '',
          m.rank ?? null,
        ),
        courtId,
        start: m.plannedStart ? m.plannedStart.toISOString() : null,
        end: m.plannedEnd ? m.plannedEnd.toISOString() : null,
        slot,
        status: m.status,
        isLocked: m.isLocked ?? false,
        teamA: team(m.teamAId),
        teamB: team(m.teamBId),
        pairA: (m.entryAId as unknown as { displayName?: string })?.displayName ?? (m.bracketRound != null ? 'TBD' : '?'),
        pairB: (m.entryBId as unknown as { displayName?: string })?.displayName ?? (m.bracketRound != null ? 'TBD' : '?'),
        winner: (m.winner ?? null) as 'A' | 'B' | null,
      };
    }),
  };
}

/** Hard-rule violations in the CURRENT cells (e.g. after manual edits or a changed rest setting). */
export async function currentConflicts(tournamentId: string): Promise<ScheduleIssue[]> {
  const settings = await loadSettings(tournamentId);
  if (!settings.startAt) return [];
  const ctx = await buildContext(tournamentId, settings);
  const courtIdx = new Map(ctx.engineCourts.map((c, i) => [c.id, i]));
  const placements: Placement[] = [];
  const deps = dependencyMap(ctx.matchDocs);
  const engine: Pick<EngineMatch, 'id' | 'playerIds' | 'after'>[] = [];
  for (const m of ctx.matchDocs) {
    const c = m.courtId ? courtIdx.get(String(m.courtId)) : undefined;
    const slot = m.plannedStart ? slotOf(ctx.math, m.plannedStart) : null;
    if (c === undefined || slot === null || ['completed', 'walkover', 'retired', 'cancelled'].includes(m.status)) continue;
    placements.push({ matchId: String(m._id), slot, court: c });
  }
  const full = await Match.find({ _id: { $in: placements.map((p) => p.matchId) } }).select('entryAId entryBId').lean();
  const entries = await Entry.find({ tournamentId }).select('playerIds').lean();
  const players = new Map(entries.map((e) => [String(e._id), e.playerIds.map(String)]));
  for (const m of full) engine.push({ id: String(m._id), playerIds: [...(players.get(String(m.entryAId)) ?? []), ...(players.get(String(m.entryBId)) ?? [])], after: deps.get(String(m._id)) ?? [] });
  const found = findConflicts(ctx.engineCourts, engine, placements, settings.minRestSlots, ctx.slotCount);
  const names = await playerNames(found.map((f) => f.playerId ?? '').filter(Boolean));
  return found.map((f) => ({ type: f.type, message: f.message, matchIds: f.matchIds, players: f.playerId ? [names.get(f.playerId) ?? '?'] : undefined }));
}

