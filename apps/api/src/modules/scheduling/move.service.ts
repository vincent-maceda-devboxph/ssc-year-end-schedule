import {
  checkMove,
  courtStatus,
  gameNumber,
  slotOf,
  slotStart,
  type CourtDto,
  type MatchDto,
  type MoveIssue,
  type MoveMatchInput,
  type MoveMatchResult,
  type Placement,
  type ScheduleIssue,
} from '@bt/shared';
import { Court, Entry, Match, Schedule } from '../../models/index.js';
import type { Broadcaster } from '../../sockets/index.js';
import { AppError, conflict, notFound, unprocessable } from '../../utils/errors.js';
import { audit } from '../audit.js';
import { courtDto, MATCH_POPULATE, matchDto } from '../dto.js';
import { buildContext, dependencyMap, loadSettings, playerNames, SCHEDULABLE } from './schedule.service.js';

type Actor = { kind: string; id: string; name: string };
type MatchDoc = NonNullable<Awaited<ReturnType<typeof loadMatch>>>;
const loadMatch = (id: unknown) => Match.findById(id).lean();

async function dtoOf(id: unknown): Promise<MatchDto> {
  const m = await Match.findById(id).populate(MATCH_POPULATE).lean();
  return matchDto(m!);
}

/**
 * Manual move / swap / unschedule of one match (drag and drop). The server decides:
 * hard rules block the move (422 move_blocked), soft rules need confirmation (409 needs_confirmation).
 * Locked, called, live and finished matches cannot be moved.
 */
export async function moveMatch(matchId: string, input: MoveMatchInput, actor: Actor, broadcaster: Broadcaster): Promise<MoveMatchResult> {
  const m = await loadMatch(matchId);
  if (!m) throw notFound('Match');
  const tournamentId = String(m.tournamentId);
  const movable = (x: { status: string; isLocked?: boolean | null }, label: string) => {
    if (x.isLocked) throw unprocessable(`${label} is locked. Unlock it first.`, 'locked');
    if (!SCHEDULABLE.includes(x.status as never)) throw unprocessable(`${label} is ${x.status.replace('_', ' ')} and cannot be moved.`, 'not_movable');
  };
  movable(m, 'This match');

  // ---- take it off the schedule ----
  if (input.courtId === null) {
    if (input.dryRun) return { ok: true, match: null, swapped: null, blocked: [], warnings: [] };
    const upd = await Match.findOneAndUpdate(
      { _id: m._id, version: m.version, status: { $in: SCHEDULABLE }, isLocked: { $ne: true } },
      {
        $set: { courtId: null, plannedStart: null, plannedEnd: null, gameNumber: null, queuePosition: 0, status: 'pending', scheduleVersion: null },
        $inc: { version: 1 },
      },
      { new: true },
    ).lean();
    if (!upd) throw conflict('The match changed meanwhile. Reload and try again.', 'version_conflict');
    await audit({ actor, action: 'unschedule_match', entity: 'match', entityId: m._id, tournamentId, before: { courtId: m.courtId, plannedStart: m.plannedStart } });
    const dto = await dtoOf(m._id);
    broadcaster.match('match:changed', dto);
    broadcaster.tournament(tournamentId, 'schedule:updated', { tournamentId });
    return { ok: true, match: dto, swapped: null, blocked: [], warnings: [] };
  }

  const settings = await loadSettings(tournamentId);
  const ctx = await buildContext(tournamentId, settings);
  const slot = input.slot ?? slotOf(ctx.math, input.start!);
  if (slot === null || slot === undefined || !Number.isInteger(slot) || slot < 0) {
    throw unprocessable('That time is not on the schedule grid', 'bad_time');
  }
  const court = ctx.engineCourts.findIndex((c) => c.id === input.courtId);
  if (court < 0) throw unprocessable('That court is not available', 'bad_court');

  let partner: MatchDoc | null = null;
  if (input.swapWith) {
    partner = await loadMatch(input.swapWith);
    if (!partner || String(partner.tournamentId) !== tournamentId) throw notFound('The match to swap with');
    movable(partner, 'The other match');
  }

  // Everything that currently holds a cell (finished matches too: their players already played then).
  const courtIdx = new Map(ctx.engineCourts.map((c, i) => [c.id, i]));
  const placements: Placement[] = [];
  for (const x of ctx.matchDocs) {
    const c = x.courtId ? courtIdx.get(String(x.courtId)) : undefined;
    const s = x.plannedStart ? slotOf(ctx.math, x.plannedStart) : null;
    if (c !== undefined && s !== null && s >= 0) placements.push({ matchId: String(x._id), slot: s, court: c });
  }
  const entries = await Entry.find({ tournamentId }).select('playerIds').lean();
  const playersOf = new Map(entries.map((e) => [String(e._id), e.playerIds.map(String)]));
  const deps = dependencyMap(ctx.matchDocs);
  const engineMatches = ctx.matchDocs.map((x) => ({
    id: String(x._id),
    after: deps.get(String(x._id)) ?? [],
    playerIds: [...(playersOf.get(String(x.entryAId)) ?? []), ...(playersOf.get(String(x.entryBId)) ?? [])],
  }));

  const check = checkMove(
    ctx.engineCourts,
    engineMatches,
    placements,
    { matchId: String(m._id), slot, court, swapWith: input.swapWith ?? null },
    settings.minRestSlots,
    ctx.slotCount,
  );
  const names = await playerNames([...check.blocked, ...check.warnings].map((i) => i.playerId ?? '').filter(Boolean));
  const issue = (i: MoveIssue): ScheduleIssue => ({
    type: i.type,
    message: i.message,
    matchIds: i.matchIds,
    players: i.playerId ? [names.get(i.playerId) ?? '?'] : undefined,
  });
  const blocked = check.blocked.map(issue);
  const warnings = check.warnings.map(issue);

  if (input.dryRun) return { ok: blocked.length === 0, match: null, swapped: null, blocked, warnings };
  if (blocked.length) throw new AppError(422, 'move_blocked', blocked[0]!.message, blocked);
  if (warnings.length && !input.confirmWarnings) throw new AppError(409, 'needs_confirmation', warnings[0]!.message, warnings);

  // ---- apply ----
  const published = await Schedule.findOne({ tournamentId, status: 'published' }).select('version').lean();
  const unit = ctx.math.minutes * 60_000;
  const cellFields = (p: Placement) => {
    const start = slotStart(ctx.math, p.slot);
    return {
      courtId: ctx.engineCourts[p.court]!.id,
      plannedStart: start,
      plannedEnd: new Date(start.getTime() + unit),
      gameNumber: gameNumber(p.slot, p.court, ctx.engineCourts.length),
      queuePosition: p.slot + 1,
      scheduleVersion: published?.version ?? 0,
    };
  };
  const cleared = { courtId: null, plannedStart: null, plannedEnd: null, gameNumber: null, queuePosition: 0 };
  const guard = (x: { _id: unknown; version: number }) => ({ _id: x._id, version: x.version, status: { $in: SCHEDULABLE }, isLocked: { $ne: true } });
  const write = (x: { _id: unknown; version: number; status: string }, fields: Record<string, unknown>) =>
    Match.updateOne(guard(x), { $set: { ...fields, status: x.status === 'pending' ? 'scheduled' : x.status }, $inc: { version: 1 } });

  const next = new Map(check.placements.map((p) => [p.matchId, p]));
  const restore = async (x: MatchDoc) => {
    await Match.updateOne(
      { _id: x._id },
      { $set: { courtId: x.courtId, plannedStart: x.plannedStart, plannedEnd: x.plannedEnd, gameNumber: x.gameNumber, queuePosition: x.queuePosition, scheduleVersion: x.scheduleVersion, status: x.status } },
    );
  };

  const touched: MatchDoc[] = [];
  const fail = async (why: string, code: string): Promise<never> => {
    for (const x of touched.reverse()) await restore(x);
    throw conflict(why, code);
  };

  if (partner) {
    // Park the dragged match first so the two never share a cell, even briefly.
    touched.push(m);
    if ((await write(m, cleared)).modifiedCount !== 1) {
      touched.pop();
      await fail('The match changed meanwhile. Reload and try again.', 'version_conflict');
    }
    touched.push(partner);
    if ((await write(partner, cellFields(next.get(String(partner._id))!))).modifiedCount !== 1) {
      touched.pop();
      await fail('The other match changed meanwhile. Reload and try again.', 'version_conflict');
    }
    const fresh = (await loadMatch(m._id))!;
    if ((await write(fresh, cellFields(next.get(String(m._id))!))).modifiedCount !== 1) {
      await fail('The match changed meanwhile. Reload and try again.', 'version_conflict');
    }
  } else {
    touched.push(m);
    if ((await write(m, cellFields(next.get(String(m._id))!))).modifiedCount !== 1) {
      touched.pop();
      await fail('The match changed meanwhile. Reload and try again.', 'version_conflict');
    }
  }

  // Race guard: if another admin put a different match in this very cell meanwhile, undo and report.
  const target = cellFields(next.get(String(m._id))!);
  const holders = await Match.countDocuments({ tournamentId, courtId: target.courtId, plannedStart: target.plannedStart, status: { $ne: 'cancelled' } });
  if (holders > 1) await fail('Someone else just put a match in that slot. Nothing was changed.', 'cell_taken');

  await audit({
    actor,
    action: partner ? 'swap_matches' : 'move_match',
    entity: 'match',
    entityId: m._id,
    tournamentId,
    before: { courtId: m.courtId, plannedStart: m.plannedStart, gameNumber: m.gameNumber },
    after: {
      courtId: target.courtId,
      plannedStart: target.plannedStart,
      gameNumber: target.gameNumber,
      swappedWith: partner ? String(partner._id) : null,
      warnings: warnings.map((w) => w.message),
    },
  });
  const dto = await dtoOf(m._id);
  const swapped = partner ? await dtoOf(partner._id) : null;
  broadcaster.match('match:changed', dto);
  if (swapped) broadcaster.match('match:changed', swapped);
  broadcaster.tournament(tournamentId, 'schedule:updated', { tournamentId });
  return { ok: true, match: dto, swapped, blocked: [], warnings };
}

/** Courts of a tournament with their live status (available / scheduled / called / ongoing / completed / unavailable). */
export async function courtsWithStatus(tournamentId: string, onlyActive: boolean): Promise<CourtDto[]> {
  const [courts, matches] = await Promise.all([
    Court.find({ tournamentId, ...(onlyActive ? { active: true } : {}) }).sort({ order: 1, name: 1 }).lean(),
    Match.find({ tournamentId, courtId: { $ne: null }, status: { $ne: 'cancelled' } }).select('courtId status').lean(),
  ]);
  return courts.map((c) => ({
    ...courtDto(c),
    status: courtStatus(c.active, matches.filter((m) => String(m.courtId) === String(c._id)).map((m) => m.status)),
  }));
}
