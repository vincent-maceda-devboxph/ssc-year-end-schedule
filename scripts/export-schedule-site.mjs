#!/usr/bin/env node
/**
 * Writes the data for the public schedule website (schedule-site/): one schedule.json plus the team logos.
 * Read-only: nothing in the database is changed.
 *
 *   node scripts/export-schedule-site.mjs                      # the newest tournament, its published schedule
 *   node scripts/export-schedule-site.mjs --tournament <id>
 *   node scripts/export-schedule-site.mjs --version 4          # a saved version instead of the published plan
 *   node scripts/export-schedule-site.mjs --mongo mongodb://127.0.0.1:27017/badminton
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const require = createRequire(path.join(root, 'apps/api/package.json'));
const mongoose = require('mongoose');

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, all) => (a.startsWith('--') ? [[a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']] : [])),
);
const MONGO = args.mongo ?? process.env.MONGO_URI ?? 'mongodb://127.0.0.1:27017/badminton';
const OUT = path.resolve(args.out ?? path.join(root, 'schedule-site'));

await mongoose.connect(MONGO);
const db = mongoose.connection.db;
const oid = (v) => new mongoose.Types.ObjectId(String(v));

const tournament = args.tournament
  ? await db.collection('tournaments').findOne({ _id: oid(args.tournament) })
  : (await db.collection('tournaments').find({}).sort({ createdAt: -1 }).limit(1).toArray())[0];
if (!tournament) throw new Error('No tournament found');
const tid = tournament._id;

const [teams, categories, courts, entries, matches] = await Promise.all([
  db.collection('teams').find({ tournamentId: tid }).toArray(),
  db.collection('categories').find({ tournamentId: tid }).toArray(),
  db.collection('courts').find({ tournamentId: tid }).toArray(),
  db.collection('entries').find({ tournamentId: tid }).toArray(),
  db.collection('matches').find({ tournamentId: tid, status: { $ne: 'cancelled' } }).toArray(),
]);
const by = (list) => new Map(list.map((x) => [String(x._id), x]));
const teamBy = by(teams), catBy = by(categories), courtBy = by(courts), entryBy = by(entries);

const tz = tournament.schedule?.timezone ?? 'Asia/Manila';
const settings = tournament.schedule ?? {};

// Which plan: a saved version, or what is on the matches now (the published plan).
let cells = new Map(); // matchId -> { start, end, courtId, game }
let source = 'published schedule';
if (args.version) {
  const v = await db.collection('schedules').findOne({ tournamentId: tid, version: Number(args.version) });
  if (!v) throw new Error(`Schedule version ${args.version} not found`);
  for (const a of v.assignments ?? []) cells.set(a.matchId, { start: a.start, end: a.end, courtId: a.courtId, game: a.gameNumber });
  source = `version ${v.version}`;
} else {
  for (const m of matches) if (m.plannedStart && m.courtId) cells.set(String(m._id), { start: m.plannedStart, end: m.plannedEnd, courtId: String(m.courtId), game: m.gameNumber });
}

const fmtTime = (d) => new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(d));
const fmtDay = (d) => new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(d));
const hour = (d) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(new Date(d)));
const letter = (rank) => (rank >= 1 && rank <= 26 ? String.fromCharCode(64 + rank) : String(rank));
const code = (name) => {
  const c = categories.find((x) => x.name === name)?.code;
  return c || name.split(/\s+/).map((w) => w[0]).join('').toUpperCase().slice(0, 3);
};

// ---- team logos as files next to the site ----
fs.mkdirSync(path.join(OUT, 'logos'), { recursive: true });
for (const f of fs.readdirSync(path.join(OUT, 'logos'))) fs.rmSync(path.join(OUT, 'logos', f));
const logoFile = new Map();
for (const t of teams) {
  const m = /^data:image\/(png|jpeg|webp);base64,(.+)$/.exec(t.logo ?? '');
  if (!m) continue;
  const file = `${String(t._id)}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
  fs.writeFileSync(path.join(OUT, 'logos', file), Buffer.from(m[2], 'base64'));
  logoFile.set(String(t._id), `logos/${file}`);
}

const side = (entryId, teamId) => {
  const e = entryId ? entryBy.get(String(entryId)) : null;
  const t = teamId ? teamBy.get(String(teamId)) : null;
  const players = e ? String(e.displayName ?? '').split(' / ').map((s) => s.trim()).filter(Boolean) : [];
  return { name: e ? e.displayName : 'To be decided', players, team: t ? String(t._id) : null };
};

const rows = [];
for (const m of matches) {
  const cell = cells.get(String(m._id));
  if (!cell?.start) continue;
  const cat = catBy.get(String(m.categoryId));
  const rank = m.rank ?? null;
  const catName = cat?.name ?? 'Division';
  rows.push({
    game: cell.game ?? null,
    start: new Date(cell.start).toISOString(),
    day: fmtDay(cell.start),
    time: fmtTime(cell.start),
    until: cell.end ? fmtTime(cell.end) : null,
    hour: hour(cell.start),
    court: courtBy.get(String(cell.courtId))?.name ?? '–',
    division: catName,
    level: rank ? `${cat?.code || code(catName)}-${letter(rank)}` : (cat?.code || code(catName)),
    round: m.bracketRound != null ? (m.isThirdPlace ? 'Third place' : m.round) : null,
    a: side(m.entryAId, m.teamAId),
    b: side(m.entryBId, m.teamBId),
  });
}
rows.sort((x, y) => x.start.localeCompare(y.start) || (x.game ?? 0) - (y.game ?? 0) || x.court.localeCompare(y.court, undefined, { numeric: true }));

const usedTeams = new Set(rows.flatMap((r) => [r.a.team, r.b.team]).filter(Boolean));
const out = {
  exportedAt: new Date().toISOString(),
  source,
  tournament: { name: tournament.name, date: tournament.date ?? '', venue: tournament.venue ?? '', timezone: tz, matchMinutes: settings.matchMinutes ?? null },
  teams: teams
    .filter((t) => usedTeams.has(String(t._id)))
    .map((t) => ({ id: String(t._id), name: t.name, color: t.color ?? '#e2e8f0', logo: logoFile.get(String(t._id)) ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name)),
  matches: rows,
};
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'schedule.json'), JSON.stringify(out, null, 1));
console.log(`Exported ${rows.length} matches of "${tournament.name}" (${source}), ${out.teams.length} teams, ${logoFile.size} logos -> ${path.join(OUT, 'schedule.json')}`);
await mongoose.disconnect();
