import { z } from 'zod';

/** Schedule settings stored on the tournament (docs/scheduling-plan.md §5). Times are UTC; the timezone is for display. */
export const scheduleSettingsSchema = z.object({
  /** ISO instant of the first slot, e.g. "2026-11-29T07:00:00.000Z" (3:00 PM in Manila). */
  startAt: z.iso.datetime().nullable(),
  /** Optional end of play; slots at or after it are not used. */
  endAt: z.iso.datetime().nullable(),
  timezone: z.string().trim().min(1).max(60),
  /** Minutes per match slot. */
  matchMinutes: z.number().int().min(5).max(240),
  /** Slots of rest required between a player's matches (1 = not back-to-back). */
  minRestSlots: z.number().int().min(0).max(10),
  seed: z.number().int().min(0).max(2_147_483_647),
  /** Soft cap of simultaneous matches per team; null = no cap. */
  maxTeamConcurrent: z.number().int().min(1).max(20).nullable(),
  categoryCourtAffinity: z.boolean(),
  /** Which pair ranks go first: 'low_first' = the lowest pairs (MD-F...) start and the top pair (MD-A) plays last; 'high_first' = the reverse; 'none' = ignore rank. */
  rankOrder: z.enum(['low_first', 'high_first', 'none']).default('low_first'),
});
export type ScheduleSettings = z.infer<typeof scheduleSettingsSchema>;

export const DEFAULT_SCHEDULE_SETTINGS: ScheduleSettings = {
  startAt: null,
  endAt: null,
  timezone: 'Asia/Manila',
  matchMinutes: 30,
  minRestSlots: 1,
  seed: 1,
  maxTeamConcurrent: null,
  categoryCourtAffinity: true,
  rankOrder: 'low_first',
};

export const scheduleSettingsUpdateSchema = scheduleSettingsSchema.partial();

/** One planned cell. `slot` is derived: (plannedStart - startAt) / matchMinutes. */
export interface ScheduleAssignment {
  matchId: string;
  courtId: string;
  slot: number;
  /** ISO UTC instants. */
  start: string;
  end: string;
  /** Game number as printed on the sheet: slot × courts + court position + 1. */
  gameNumber: number;
  /** Locked, live or finished: kept exactly where it is. */
  fixed?: boolean;
}

export interface ScheduleIssue {
  type: string;
  message: string;
  matchIds: string[];
  /** Resolved player names for display. */
  players?: string[];
}

export interface SchedulePreview {
  settings: ScheduleSettings;
  /** Matches that are not live, called, finished or locked were not placed before this time (rescheduling after a delay). */
  notBefore: string | null;
  courts: { id: string; name: string }[];
  assignments: ScheduleAssignment[];
  unscheduled: { matchId: string; reason: string; players: string[] }[];
  conflicts: ScheduleIssue[];
  stats: {
    matches: number;
    scheduled: number;
    fixed: number;
    slots: number;
    emptyCells: number;
    minPlayerGapSlots: number | null;
    avgPlayerGapSlots: number | null;
    /** ISO instant the last match is expected to end; null if nothing scheduled. */
    estimatedEnd: string | null;
    pastEndTime: boolean;
  };
  /** Differences from what is currently on the matches (published/saved plan). */
  changes: { matchId: string; from: { courtId: string | null; start: string | null }; to: { courtId: string; start: string } }[];
}

export interface ScheduleVersionDto {
  id: string;
  version: number;
  status: 'draft' | 'published' | 'superseded';
  createdAt: string;
  createdBy: string;
  publishedAt: string | null;
  label: string;
  settings: ScheduleSettings;
  matchCount: number;
  estimatedEnd: string | null;
}

/** A match with its planned cell, for the schedule board. */
export interface ScheduleMatchDto {
  id: string;
  matchNumber: number;
  gameNumber: number | null;
  categoryId: string;
  categoryName: string;
  courtId: string | null;
  start: string | null;
  end: string | null;
  slot: number | null;
  status: string;
  isLocked: boolean;
  teamA: { id: string; name: string; color: string } | null;
  teamB: { id: string; name: string; color: string } | null;
  pairA: string;
  pairB: string;
  winner: 'A' | 'B' | null;
}

export interface ScheduleView {
  settings: ScheduleSettings;
  courts: { id: string; name: string; active: boolean }[];
  matches: ScheduleMatchDto[];
  publishedVersion: number | null;
  /** True when the published cells have unsaved/unpublished edits (manual moves are applied live; see plan). */
  slotCount: number;
}

export type SlotMath = { startMs: number; minutes: number };

/** Instant of a slot. */
export const slotStart = (m: SlotMath, slot: number) => new Date(m.startMs + slot * m.minutes * 60_000);
/** Slot index of an instant, or null if it is not aligned to the grid. */
export function slotOf(m: SlotMath, instant: Date | string): number | null {
  const diff = new Date(instant).getTime() - m.startMs;
  const unit = m.minutes * 60_000;
  return diff % unit === 0 ? diff / unit : null;
}

/** Game number as in the reference sheet: slot-major across courts, 1-based. */
export const gameNumber = (slot: number, courtIndex: number, courtCount: number) => slot * courtCount + courtIndex + 1;
