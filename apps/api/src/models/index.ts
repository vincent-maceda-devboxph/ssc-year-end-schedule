import mongoose, { Schema, type InferSchemaType, type Types } from 'mongoose';
import { LIVE_STATUSES, MATCH_STATUSES, TOURNAMENT_STATUSES } from '@bt/shared';

const opts = { timestamps: true, versionKey: false } as const;
const ref = (name: string, required = true) => ({ type: Schema.Types.ObjectId, ref: name, required, index: true });

// ---------- settings (server secrets etc.) ----------
const settingSchema = new Schema({ _id: String, value: Schema.Types.Mixed }, { versionKey: false });
export const Setting = mongoose.model('Setting', settingSchema, 'settings');

// ---------- users (admins only; umpires use court codes, see decisions D2) ----------
const userSchema = new Schema(
  {
    username: { type: String, required: true, unique: true, trim: true, lowercase: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ['super_admin', 'tournament_admin'], required: true },
    active: { type: Boolean, default: true },
    /** Bumped on password reset / deactivation: tokens carry it, so old sessions stop working. */
    sessionVersion: { type: Number, default: 0 },
  },
  opts,
);
export const User = mongoose.model('User', userSchema, 'users');
export type UserDoc = InferSchemaType<typeof userSchema> & { _id: Types.ObjectId };

// ---------- tournaments ----------
const tournamentSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    date: { type: String, default: '' },
    venue: { type: String, default: '' },
    status: { type: String, enum: TOURNAMENT_STATUSES, default: 'draft', index: true },
    nextMatchNumber: { type: Number, default: 1 },
    /** ScheduleSettings (see @bt/shared); validated by zod on write, defaults filled on read. */
    schedule: { type: Schema.Types.Mixed, default: null },
    nextScheduleVersion: { type: Number, default: 1 },
  },
  opts,
);
export const Tournament = mongoose.model('Tournament', tournamentSchema, 'tournaments');

// ---------- categories ----------
const scoringSchema = new Schema(
  {
    gamesToWin: { type: Number, required: true },
    pointsToWin: { type: Number, required: true },
    winBy: { type: Number, required: true },
    cap: { type: Number, default: null },
    intervalAt: { type: Number, default: null },
    changeEndsInDecider: { type: Boolean, default: true },
  },
  { _id: false },
);

const categorySchema = new Schema(
  {
    tournamentId: ref('Tournament'),
    name: { type: String, required: true, trim: true },
    /** Short label code: "MD" for Men's Doubles. Empty = derived from the name. */
    code: { type: String, default: '' },
    discipline: { type: String, enum: ['doubles', 'singles'], default: 'doubles' },
    playersPerEntry: { type: Number, enum: [1, 2], required: true },
    scoring: { type: scoringSchema, required: true },
    /** How the match generator treats this category (docs/scheduling-plan.md §4). */
    format: { type: String, enum: ['team_round_robin', 'round_robin', 'knockout', 'manual'], default: 'round_robin' },
    /** Knockout: qualifiers come from this division (a group stage). */
    sourceCategoryId: { type: Schema.Types.ObjectId, ref: 'Category', default: null },
    thirdPlace: { type: Boolean, default: true },
    /** Lower = scheduled earlier. */
    priority: { type: Number, default: 100 },
    allowSameTeam: { type: Boolean, default: false },
  },
  opts,
);
categorySchema.index({ tournamentId: 1, name: 1 }, { unique: true });
export const Category = mongoose.model('Category', categorySchema, 'categories');

// ---------- teams ----------
const teamSchema = new Schema(
  {
    tournamentId: ref('Tournament'),
    name: { type: String, required: true, trim: true },
    color: { type: String, default: '#e0e0e0' },
    captainPlayerId: { type: Schema.Types.ObjectId, ref: 'Player', default: null },
    status: { type: String, enum: ['active', 'withdrawn'], default: 'active' },
    /** Small image as a data URL (resized in the browser). Not loaded with the team by default. */
    logo: { type: String, default: '', select: false },
    logoAt: { type: Date, default: null },
  },
  opts,
);
teamSchema.index({ tournamentId: 1, name: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });
export const Team = mongoose.model('Team', teamSchema, 'teams');

// ---------- players ----------
const playerSchema = new Schema(
  {
    tournamentId: ref('Tournament'),
    teamId: { ...ref('Team', false), default: null },
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, default: '', trim: true },
    gender: { type: String, enum: ['M', 'F', 'X'] },
    club: { type: String, default: '', trim: true },
  },
  opts,
);
// Same name is allowed on different teams (they are different people).
playerSchema.index(
  { tournamentId: 1, teamId: 1, firstName: 1, lastName: 1, club: 1 },
  { unique: true, collation: { locale: 'en', strength: 2 } },
);
export const Player = mongoose.model('Player', playerSchema, 'players');

// ---------- entries (a pair, or a single player; decisions D1) ----------
const entrySchema = new Schema(
  {
    tournamentId: ref('Tournament'),
    categoryId: ref('Category'),
    teamId: { ...ref('Team', false), default: null },
    playerIds: [{ type: Schema.Types.ObjectId, ref: 'Player', required: true }],
    displayName: { type: String, required: true, trim: true },
    seed: { type: Number, default: null },
    /** Position in the team's list for this division (1 = first). The level label MD-A is rank 1. */
    rank: { type: Number, default: null },
    /** Group in a group stage ("A", "B"); empty when the division has no groups. */
    group: { type: String, default: '' },
    status: { type: String, enum: ['active', 'withdrawn'], default: 'active' },
  },
  opts,
);
entrySchema.index({ categoryId: 1, playerIds: 1 });
// Two active pairs of one team can never hold the same position.
entrySchema.index(
  { categoryId: 1, teamId: 1, rank: 1 },
  { unique: true, name: 'unique_rank_per_team', partialFilterExpression: { status: 'active', rank: { $type: 'number' } } },
);
export const Entry = mongoose.model('Entry', entrySchema, 'entries');

// ---------- courts ----------
const courtSchema = new Schema(
  {
    tournamentId: ref('Tournament'),
    name: { type: String, required: true, trim: true },
    order: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
    /** bcrypt hash of the 6-digit umpire code. Plaintext is shown once on generation. */
    codeHash: { type: String, default: null },
    /** Bumped on every code regeneration; umpire tokens carry it, so old sessions die. */
    codeVersion: { type: Number, default: 0 },
    /** Optional availability window (closures, late opening); null = always available. */
    availableFrom: { type: Date, default: null },
    availableUntil: { type: Date, default: null },
  },
  opts,
);
courtSchema.index({ tournamentId: 1, name: 1 }, { unique: true });
export const Court = mongoose.model('Court', courtSchema, 'courts');

// ---------- matches ----------
const actionSchema = new Schema(
  {
    actionId: { type: String, required: true },
    type: { type: String, required: true },
    side: { type: String, enum: ['A', 'B'] },
    /** servers command: first server / receiver (0 or 1) of the game with this number. */
    server: { type: Number, enum: [0, 1] },
    receiver: { type: Number, enum: [0, 1] },
    game: Number,
    by: { kind: String, name: String },
    at: { type: Date, required: true },
  },
  { _id: false },
);

const matchSchema = new Schema(
  {
    tournamentId: ref('Tournament'),
    categoryId: ref('Category'),
    matchNumber: { type: Number, required: true },
    round: { type: String, default: '' },
    // Knockout matches wait for their opponents: a side stays empty (null) until the feeder match is decided.
    entryAId: { ...ref('Entry', false), default: null },
    entryBId: { ...ref('Entry', false), default: null },
    /** Knockout bracket position (null for other matches). */
    bracketRound: { type: Number, default: null },
    bracketPos: { type: Number, default: null },
    isThirdPlace: { type: Boolean, default: false },
    /** Where the WINNER goes: the next match and which side of it. */
    advancesToMatchId: { type: Schema.Types.ObjectId, ref: 'Match', default: null },
    advancesToSlot: { type: String, enum: ['A', 'B', null], default: null },
    /** Where the LOSER goes (semifinals feed the third-place match). */
    loserToMatchId: { type: Schema.Types.ObjectId, ref: 'Match', default: null },
    loserToSlot: { type: String, enum: ['A', 'B', null], default: null },
    teamAId: { ...ref('Team', false), default: null },
    teamBId: { ...ref('Team', false), default: null },
    roundNumber: { type: Number, default: null },
    /** Which pair position the match is for (1 = first pair of each team). */
    rank: { type: Number, default: null },
    /** Set by the match generator; manual matches stay null. */
    generatedBy: { type: String, default: null },
    /** Side-independent "category:pairX|pairY" key for generated matches (duplicate guard). */
    matchupKey: { type: String, default: null },
    courtId: { ...ref('Court', false), default: null },
    /** Planned cell from the published schedule (UTC). */
    plannedStart: { type: Date, default: null },
    plannedEnd: { type: Date, default: null },
    gameNumber: { type: Number, default: null },
    /** Locked matches keep their cell when the schedule is regenerated. */
    isLocked: { type: Boolean, default: false },
    scheduleVersion: { type: Number, default: null },
    queuePosition: { type: Number, default: 0 },
    status: { type: String, enum: MATCH_STATUSES, default: 'pending', index: true },
    /** Snapshot of the category's scoring rules when the match was created. */
    scoring: { type: scoringSchema, required: true },
    /** Append-only command log; doubles as the scoring audit trail and idempotency record. */
    actions: { type: [actionSchema], default: [] },
    /** Cached result of computeScore(scoring, effectivePoints(actions)). */
    score: { type: Schema.Types.Mixed, required: true },
    /** Doubles service state (computeServing), kept up to date by every scoring command so lists need not load the log. */
    servingState: { type: Schema.Types.Mixed, default: null },
    winner: { type: String, enum: ['A', 'B', null], default: null },
    umpire: {
      type: new Schema(
        { name: String, sessionId: String, claimedAt: Date, lastSeenAt: Date },
        { _id: false },
      ),
      default: null,
    },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    /** Number of admin corrections applied to the finished result (each one is also in auditLogs). */
    correctionCount: { type: Number, default: 0 },
    /** Optimistic concurrency counter, incremented on every change. */
    version: { type: Number, default: 0 },
  },
  { ...opts, minimize: false },
);
matchSchema.index({ tournamentId: 1, matchNumber: 1 }, { unique: true });
matchSchema.index({ courtId: 1, status: 1, queuePosition: 1 });
// The generator can never create the same matchup twice, even with two admins clicking at once.
matchSchema.index(
  { tournamentId: 1, matchupKey: 1 },
  { unique: true, name: 'unique_generated_matchup', partialFilterExpression: { matchupKey: { $type: 'string' } } },
);
// A court cannot host two live matches: enforced by the database, not just app code.
matchSchema.index(
  { courtId: 1 },
  { unique: true, name: 'one_live_match_per_court', partialFilterExpression: { status: { $in: [...LIVE_STATUSES] } } },
);
export const Match = mongoose.model('Match', matchSchema, 'matches');

// ---------- schedules (saved / published versions) ----------
const scheduleSchema = new Schema(
  {
    tournamentId: ref('Tournament'),
    version: { type: Number, required: true },
    status: { type: String, enum: ['draft', 'published', 'superseded'], default: 'draft', index: true },
    label: { type: String, default: '' },
    createdBy: { kind: String, id: String, name: String },
    publishedAt: { type: Date, default: null },
    settings: { type: Schema.Types.Mixed, required: true },
    assignments: { type: [Schema.Types.Mixed], default: [] },
    stats: { type: Schema.Types.Mixed, default: {} },
    estimatedEnd: { type: Date, default: null },
  },
  opts,
);
scheduleSchema.index({ tournamentId: 1, version: 1 }, { unique: true });
export const Schedule = mongoose.model('Schedule', scheduleSchema, 'schedules');

// ---------- audit log ----------
const auditSchema = new Schema(
  {
    actor: { kind: String, id: String, name: String },
    action: { type: String, required: true },
    entity: { type: String, required: true },
    entityId: { type: Schema.Types.ObjectId, required: true, index: true },
    tournamentId: { type: Schema.Types.ObjectId, index: true },
    before: Schema.Types.Mixed,
    after: Schema.Types.Mixed,
    reason: { type: String, default: '' },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);
export const AuditLog = mongoose.model('AuditLog', auditSchema, 'auditLogs');
