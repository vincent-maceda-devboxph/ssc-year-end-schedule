import { divisionCode, SCORING_PRESETS, type LineupImportResult, type LineupRow } from '@bt/shared';
import { Category, Entry, Player, Team } from '../../models/index.js';
import { fullName } from '../entries/entries.routes.js';
import { nextTeamColor } from './teams.routes.js';

const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

/** "Hannah J." → {firstName: "Hannah", lastName: "J."}; "Jiu" → {firstName: "Jiu", lastName: ""}. */
export function splitName(name: string) {
  const parts = name.trim().replace(/\s+/g, ' ').split(' ');
  return parts.length > 1 ? { firstName: parts.slice(0, -1).join(' '), lastName: parts.at(-1)! } : { firstName: parts[0]!, lastName: '' };
}

const KNOWN_CODES: Record<string, string> = {
  md: "Men's Doubles", wd: "Women's Doubles", xd: 'Mixed Doubles',
  ms: "Men's Singles", ws: "Women's Singles",
};

/** A new division is singles when its name says so ("Men's Singles", "MS"). Existing divisions keep their own setting. */
const looksLikeSingles = (division: string) => /singles/i.test(division);

/**
 * The division a pasted row belongs to. "MD" / "WD" / "XD" expand to their full names, and an
 * old-style level label such as "MD-C" is read as its division ("MD"): levels no longer exist, a
 * pair's position is simply the order of its row within its team.
 */
export function canonicalDivision(raw: string): string {
  const t = raw.trim().replace(/\s+/g, ' ');
  const level = /^([A-Za-z]{1,3})-[A-Za-z]{1,2}$/.exec(t);
  const base = level ? level[1]! : t;
  return KNOWN_CODES[base.toLowerCase()] ?? base;
}

/**
 * Import pairs pasted from a spreadsheet: Team | Division | Player 1 | Player 2.
 * The order of rows within a team and division is the pair's position (rank): a team's first
 * Men's Doubles row is its #1 pair (label MD-A), the next is #2 (MD-B), and so on. Pairs of the
 * same position meet each other.
 *
 * Reuses existing teams, divisions and players by name (no duplicates); creates the rest. Pairs that
 * are already registered keep their position; new rows continue after the last one. All-or-nothing:
 * if any row has an error, nothing is written.
 */
export async function importLineup(tournamentId: string, rows: LineupRow[], dryRun: boolean): Promise<LineupImportResult> {
  const result: LineupImportResult = {
    dryRun, teamsCreated: [], categoriesCreated: [], playersCreated: 0, pairsCreated: 0, unchanged: 0, errors: [],
  };

  const [teams, categories, players, entries] = await Promise.all([
    Team.find({ tournamentId }).lean(),
    Category.find({ tournamentId }).lean(),
    Player.find({ tournamentId }).lean(),
    Entry.find({ tournamentId, status: 'active' }).lean(),
  ]);
  const teamByName = new Map(teams.map((t) => [norm(t.name), String(t._id)]));
  const catByName = new Map<string, string>();
  for (const c of categories) {
    catByName.set(norm(c.name), String(c._id));
    catByName.set(norm(c.code || divisionCode(c.name)), String(c._id));
  }
  const playerKey = (teamKey: string, name: string) => `${teamKey}::${norm(name)}`;
  // Existing players, keyed by team id (or "new:<team>" for a team about to be created) + full name.
  const playerByKey = new Map(players.map((p) => [playerKey(p.teamId ? String(p.teamId) : '', fullName(p)), p]));
  const entryOfPlayer = new Map<string, (typeof entries)[number]>();
  for (const e of entries) for (const pid of e.playerIds) entryOfPlayer.set(String(pid), e);

  // ---- validate every row before writing anything ----
  const seenInPaste = new Map<string, number>(); // player key → row number
  type Planned = { row: number; teamName: string; teamKey: string; division: string; names: string[]; singles: boolean; skip?: boolean; rank?: number };
  const planned: Planned[] = [];

  rows.forEach((r, i) => {
    const row = i + 1;
    const teamKey = teamByName.get(norm(r.team)) ?? `new:${norm(r.team)}`;
    const division = canonicalDivision(r.category);
    const existingCat = categories.find((c) => String(c._id) === catByName.get(norm(division)));
    const singles = existingCat ? existingCat.discipline === 'singles' : looksLikeSingles(division);
    if (singles && r.player2) {
      result.errors.push({ row, message: `${division} is a singles division: one player per row (this row has two)` });
      return;
    }
    if (!singles && !r.player2) {
      result.errors.push({ row, message: `${division} is a doubles division: this row needs two players` });
      return;
    }
    if (!singles && norm(r.player1) === norm(r.player2)) {
      result.errors.push({ row, message: `${r.player1} cannot partner themselves` });
      return;
    }
    const rowNames = singles ? [r.player1] : [r.player1, r.player2];
    for (const name of rowNames) {
      const k = playerKey(teamKey, name);
      const prev = seenInPaste.get(k);
      if (prev) result.errors.push({ row, message: `${name} (${r.team}) is already in row ${prev}. A player can be in only one pair.` });
      else seenInPaste.set(k, row);
      // The same name on another team is treated as a different person.
    }
    planned.push({ row, teamName: r.team.trim(), teamKey, division, singles, names: rowNames.map((n) => n.trim()) });
  });

  // Existing pairs: same two players in the same division = unchanged; otherwise a player already paired = error.
  for (const p of planned) {
    const existing = p.names.map((n) => playerByKey.get(playerKey(p.teamKey, n)));
    const existingEntries = existing.map((pl) => (pl ? entryOfPlayer.get(String(pl._id)) : undefined));
    const catId = catByName.get(norm(p.division));
    const same =
      existingEntries[0] && (p.singles || existingEntries[0] === existingEntries[1]) && catId && String(existingEntries[0].categoryId) === catId;
    if (same) {
      result.unchanged++;
      p.skip = true;
      continue;
    }
    existingEntries.forEach((e, i) => {
      if (e) result.errors.push({ row: p.row, message: `${p.names[i]} is already paired (${e.displayName}). A player can be in only one pair.` });
    });
  }

  result.errors.sort((a, b) => a.row - b.row);
  if (result.errors.length) return { ...result, unchanged: 0 };

  // ---- positions: continue after what each team already has in the division ----
  const lastRank = new Map<string, number>(); // `${teamKey}|${division}` → last used position
  for (const e of entries) {
    const key = `${e.teamId ? String(e.teamId) : ''}|${String(e.categoryId)}`;
    lastRank.set(key, Math.max(lastRank.get(key) ?? 0, e.rank ?? 0));
  }
  const rankKey = (p: Planned) => `${p.teamKey}|${catByName.get(norm(p.division)) ?? `new:${norm(p.division)}`}`;
  for (const p of planned) {
    if (p.skip) continue;
    const k = rankKey(p);
    p.rank = (lastRank.get(k) ?? 0) + 1;
    lastRank.set(k, p.rank);
  }

  // ---- dry run: report what would be created ----
  const newTeams = [...new Set(planned.filter((p) => p.teamKey.startsWith('new:')).map((p) => p.teamName))];
  const newDivisions = [...new Set(planned.filter((p) => !catByName.has(norm(p.division))).map((p) => p.division))];
  result.teamsCreated = dedupeCase(newTeams);
  result.categoriesCreated = dedupeCase(newDivisions);
  const toCreate = planned.filter((p) => !p.skip);
  result.pairsCreated = toCreate.length;
  result.playersCreated = toCreate.flatMap((p) => p.names.filter((n) => !playerByKey.has(playerKey(p.teamKey, n)))).length;
  if (dryRun) return result;

  // ---- write ----
  for (const name of result.teamsCreated) {
    const t = await Team.create({ tournamentId, name, color: await nextTeamColor(tournamentId) });
    teamByName.set(norm(name), String(t._id));
  }
  for (const name of result.categoriesCreated) {
    const singles = looksLikeSingles(name);
    const c = await Category.create({
      tournamentId, name, code: divisionCode(name), discipline: singles ? 'singles' : 'doubles', playersPerEntry: singles ? 1 : 2,
      scoring: SCORING_PRESETS.bestOf3To21, format: 'team_round_robin', priority: 100, allowSameTeam: false,
    });
    catByName.set(norm(name), String(c._id));
    catByName.set(norm(c.code), String(c._id));
  }
  for (const p of toCreate) {
    const teamId = teamByName.get(norm(p.teamName))!;
    const ids = [];
    for (const name of p.names) {
      const key = playerKey(teamId, name);
      const found = playerByKey.get(key) ?? playerByKey.get(playerKey(p.teamKey, name));
      if (found) {
        ids.push(found._id);
        continue;
      }
      const created = await Player.create({ tournamentId, teamId, ...splitName(name) });
      playerByKey.set(key, created.toObject() as unknown as (typeof players)[number]);
      ids.push(created._id);
    }
    await Entry.create({
      tournamentId,
      categoryId: catByName.get(norm(p.division)),
      teamId,
      playerIds: ids,
      displayName: p.names.join(' / '),
      rank: p.rank,
    });
  }
  return result;
}

function dedupeCase(list: string[]) {
  const seen = new Set<string>();
  return list.filter((s) => (seen.has(norm(s)) ? false : (seen.add(norm(s)), true)));
}
