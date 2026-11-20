import { z } from 'zod';
import { MATCH_COMMANDS } from './match-status.js';

const objectId = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id');
const name = z.string().trim().min(1).max(120);

export const scoringConfigSchema = z
  .object({
    gamesToWin: z.number().int().min(1).max(5),
    pointsToWin: z.number().int().min(1).max(99),
    winBy: z.number().int().min(1).max(10),
    cap: z.number().int().min(1).max(199).nullable(),
    intervalAt: z.number().int().min(1).max(98).nullable(),
    changeEndsInDecider: z.boolean(),
  })
  .refine((c) => c.cap === null || c.cap >= c.pointsToWin, { message: 'cap must be >= pointsToWin', path: ['cap'] })
  .refine((c) => c.intervalAt === null || c.intervalAt < c.pointsToWin, {
    message: 'intervalAt must be below pointsToWin',
    path: ['intervalAt'],
  });

export const loginSchema = z.object({
  username: z.string().trim().min(1).max(60),
  password: z.string().min(1).max(200),
});

export const umpireLoginSchema = z.object({
  /** Optional: the code alone identifies the court. */
  courtId: objectId.optional(),
  code: z.string().regex(/^\d{6}$/, 'Code must be 6 digits'),
  name: z.string().trim().min(2).max(60),
});

// ---- admin accounts ----
const username = z.string().trim().toLowerCase().min(3).max(40).regex(/^[a-z0-9._-]+$/, 'Use letters, digits, dot, dash or underscore');
const password = z.string().min(8, 'At least 8 characters').max(200);
export const userCreateSchema = z.object({ username, password, role: z.enum(['super_admin', 'tournament_admin']).default('tournament_admin') });
export const userUpdateSchema = z.object({
  role: z.enum(['super_admin', 'tournament_admin']).optional(),
  active: z.boolean().optional(),
  /** Reset the password (signs that person out everywhere). */
  password: password.optional(),
});
export const passwordChangeSchema = z.object({ current: z.string().min(1).max(200), next: password });

export const TOURNAMENT_STATUSES = ['draft', 'active', 'completed', 'archived'] as const;
export const tournamentSchema = z.object({
  name,
  date: z.string().trim().max(40).optional().default(''),
  venue: z.string().trim().max(120).optional().default(''),
  status: z.enum(TOURNAMENT_STATUSES).optional().default('draft'),
});
export const tournamentUpdateSchema = tournamentSchema.partial();

export const DISCIPLINES = ['doubles', 'singles'] as const;
export const CATEGORY_FORMATS = ['team_round_robin', 'round_robin', 'knockout', 'manual'] as const;
const categoryExtras = {
  format: z.enum(CATEGORY_FORMATS),
  /** Lower = scheduled earlier. */
  priority: z.number().int().min(0).max(999),
  allowSameTeam: z.boolean(),
};
export const categorySchema = z.object({
  tournamentId: objectId,
  name,
  discipline: z.enum(DISCIPLINES).optional().default('doubles'),
  scoring: scoringConfigSchema,
  format: categoryExtras.format.optional().default('round_robin'),
  priority: categoryExtras.priority.optional().default(100),
  allowSameTeam: categoryExtras.allowSameTeam.optional().default(false),
  /** Label code ("MD"); derived from the name when omitted. */
  code: z.string().trim().min(1).max(3).optional(),
  /** Knockout only: take the qualifiers from this division (a group stage). Empty = the knockout has its own entries. */
  sourceCategoryId: objectId.nullable().optional(),
  /** Knockout only: play a third-place match. */
  thirdPlace: z.boolean().optional(),
});
export const categoryUpdateSchema = z.object({
  name: name.optional(),
  scoring: scoringConfigSchema.optional(),
  format: categoryExtras.format.optional(),
  priority: categoryExtras.priority.optional(),
  allowSameTeam: categoryExtras.allowSameTeam.optional(),
  code: z.string().trim().min(1).max(3).optional(),
  thirdPlace: z.boolean().optional(),
});

/** Split a round-robin division into groups (snake order by seed), or generate / regenerate a knockout bracket. */
export const assignGroupsSchema = z.object({ count: z.number().int().min(2).max(8) });
export const generateBracketSchema = z.object({
  /** From a group stage: how many of each group go through (default 2). */
  advancePerGroup: z.number().int().min(1).max(8).optional(),
  /** Delete the bracket (if nothing has been played) and build it again. */
  replace: z.boolean().optional().default(false),
  /** Build the bracket from the current group standings even though some group matches are unfinished. */
  force: z.boolean().optional().default(false),
});

const hexColor = z.string().trim().regex(/^#[0-9a-f]{6}$/i, 'Use a colour like #a1c4ff');
export const teamSchema = z.object({
  tournamentId: objectId,
  name: z.string().trim().min(1).max(60),
  color: hexColor.optional(),
  captainPlayerId: objectId.nullable().optional(),
});
/** A small PNG, JPEG or WebP as a data URL (the browser shrinks it first). */
export const teamLogoSchema = z.object({
  dataUrl: z
    .string()
    .max(150_000, 'The logo is too large')
    .regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/, 'The logo must be a PNG, JPEG or WebP image'),
});
export const teamUpdateSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  color: hexColor.optional(),
  captainPlayerId: objectId.nullable().optional(),
  status: z.enum(['active', 'withdrawn']).optional(),
});

/** Paste-in lineup: one row per pair. Missing teams, categories and players are created. */
export const lineupImportSchema = z.object({
  rows: z
    .array(
      z.object({
        team: z.string().trim().min(1).max(60),
        category: z.string().trim().min(1).max(120),
        player1: z.string().trim().min(1).max(120),
        /** Empty for singles divisions (one player per row). */
        player2: z.string().trim().max(120).optional().default(''),
      }),
    )
    .min(1)
    .max(2000),
  /** Only validate and report; write nothing. */
  dryRun: z.boolean().optional().default(false),
});

export const generateMatchesSchema = z.object({
  /** Defaults to every team_round_robin / round_robin category. */
  categoryIds: z.array(objectId).optional(),
  /** Remove previously generated matches that never started, then generate again. */
  replace: z.boolean().optional().default(false),
});

export const playerSchema = z.object({
  tournamentId: objectId,
  firstName: z.string().trim().min(1).max(60),
  /** Optional: many players are listed by nickname only ("Jiu", "Cean"). */
  lastName: z.string().trim().max(60).optional().default(''),
  gender: z.enum(['M', 'F', 'X']).optional(),
  club: z.string().trim().max(80).optional().default(''),
  teamId: objectId.nullable().optional(),
});
export const playerUpdateSchema = playerSchema.omit({ tournamentId: true }).partial();

export const entrySchema = z.object({
  categoryId: objectId,
  playerIds: z.array(objectId).min(1).max(2),
  displayName: z.string().trim().max(120).optional(),
  seed: z.number().int().min(1).max(999).nullable().optional(),
  /** Required for team divisions; defaults to the players' team. */
  teamId: objectId.nullable().optional(),
  /** Position in the team's list; the next free position when omitted. */
  rank: z.number().int().min(1).max(200).optional(),
});
export const entryUpdateSchema = z.object({
  displayName: z.string().trim().max(120).optional(),
  /** Replace the pair's players (same number as before), e.g. a substitute. The matches and their times stay. */
  playerIds: z.array(objectId).min(1).max(2).optional(),
  /** Group label ("A", "B") for a group stage; empty = no group. */
  group: z.string().trim().max(8).optional(),
  seed: z.number().int().min(1).max(999).nullable().optional(),
  status: z.enum(['active', 'withdrawn']).optional(),
});
/** Exchange one player between two pairs (a lineup change). */
export const swapPlayersSchema = z.object({ entryAId: objectId, playerAId: objectId, entryBId: objectId, playerBId: objectId });
/** Move a pair up or down in its team's list (swaps positions with its neighbour). */
export const entryMoveSchema = z.object({ direction: z.enum(['up', 'down']) });

export const courtSchema = z.object({
  tournamentId: objectId,
  name: z.string().trim().min(1).max(40),
  order: z.number().int().min(0).max(999).optional(),
});
export const courtUpdateSchema = z.object({
  name: z.string().trim().min(1).max(40).optional(),
  order: z.number().int().min(0).max(999).optional(),
  active: z.boolean().optional(),
  /** The court can only be used from / until these times (ISO, UTC); null = no limit. */
  availableFrom: z.iso.datetime().nullable().optional(),
  availableUntil: z.iso.datetime().nullable().optional(),
});

export const matchCreateSchema = z
  .object({
    categoryId: objectId,
    entryAId: objectId,
    entryBId: objectId,
    courtId: objectId.nullable().optional(),
    round: z.string().trim().max(40).optional().default(''),
  })
  .refine((m) => m.entryAId !== m.entryBId, { message: 'An entry cannot play itself', path: ['entryBId'] });

export const matchUpdateSchema = z.object({
  courtId: objectId.nullable().optional(),
  queuePosition: z.number().int().min(0).optional(),
  round: z.string().trim().max(40).optional(),
});

/** Move a match to a court and time (drag and drop), swap it with the match already there, or take it off the schedule. */
export const moveMatchSchema = z
  .object({
    /** null takes the match off the schedule. */
    courtId: objectId.nullable(),
    /** Time slot index, or the slot's start time (ISO). One of them is required unless courtId is null. */
    slot: z.number().int().min(0).max(5000).optional(),
    start: z.iso.datetime().optional(),
    /** The match currently in the target cell, to exchange places with. */
    swapWith: objectId.nullable().optional(),
    /** Accept soft-rule warnings (e.g. less rest than the minimum). */
    confirmWarnings: z.boolean().optional().default(false),
    /** Only check the move; change nothing. */
    dryRun: z.boolean().optional().default(false),
  })
  .refine((m) => m.courtId === null || m.slot !== undefined || m.start !== undefined, { message: 'slot or start is required', path: ['slot'] });
export type MoveMatchInput = z.infer<typeof moveMatchSchema>;

export const courtStatusUpdateSchema = z.object({ status: z.enum(['available', 'unavailable']) });

/**
 * Correct a finished match (admin). The reason is mandatory and goes to the audit log.
 * completed: games must form a valid finished match. retired: winner = the side that did not retire,
 * games may stop mid-game. walkover: winner only.
 */
export const correctResultSchema = z.object({
  expectedVersion: z.number().int().min(0),
  reason: z.string().trim().min(3, 'Give a reason for the correction').max(300),
  status: z.enum(['completed', 'walkover', 'retired']).optional(),
  winner: z.enum(['A', 'B']).optional(),
  games: z.array(z.object({ a: z.number().int().min(0).max(99), b: z.number().int().min(0).max(99) })).max(9).optional(),
});
export type CorrectResultInput = z.infer<typeof correctResultSchema>;

export const matchAdminActionSchema = z.object({
  winner: z.enum(['A', 'B']).optional(),
  reason: z.string().trim().max(300).optional().default(''),
});

export const commandSchema = z.object({
  actionId: z.uuid(),
  expectedVersion: z.number().int().min(0),
  type: z.enum(MATCH_COMMANDS),
  side: z.enum(['A', 'B']).optional(),
  /** servers: who serves first in the current game (doubles). side = serving side. */
  server: z.union([z.literal(0), z.literal(1)]).optional(),
  receiver: z.union([z.literal(0), z.literal(1)]).optional(),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type UmpireLoginInput = z.infer<typeof umpireLoginSchema>;
export type TournamentInput = z.input<typeof tournamentSchema>;
export type CategoryInput = z.input<typeof categorySchema>;
export type PlayerInput = z.input<typeof playerSchema>;
export type EntryInput = z.input<typeof entrySchema>;
export type CourtInput = z.input<typeof courtSchema>;
export type MatchCreateInput = z.input<typeof matchCreateSchema>;
export type CommandInput = z.infer<typeof commandSchema>;
export type TeamInput = z.input<typeof teamSchema>;
export type LineupRow = z.infer<typeof lineupImportSchema>['rows'][number];
export type CategoryFormat = (typeof CATEGORY_FORMATS)[number];
