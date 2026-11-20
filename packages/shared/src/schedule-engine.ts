/**
 * Court/time-slot scheduling engine (docs/scheduling-plan.md §5). Pure and deterministic:
 * the same input and seed always give the same schedule; a different seed gives a variation.
 *
 * Model: time is divided into equal slots (match length). Courts are columns. A match takes one
 * (slot, court) cell.
 *
 * HARD constraints (never violated):
 *   1. A player is in at most one match per slot (checked by player id).
 *   2. A court hosts at most one match per slot, and only while available.
 *   3. Fixed matches (locked / live / finished) keep their cell.
 *   4. Two matches of the same player are more than `minRestSlots` slots apart.
 * SOFT preferences (used to choose among valid cells):
 *   category priority, category–court affinity, keeping the published cell, team concurrency cap,
 *   placing the most constrained players first, round order, earliest finish.
 *
 * Method: slot-major greedy list scheduling (fill every free court of slot 0, then slot 1, ...),
 * then a one-level backtracking repair for leftovers when the day has a fixed end, then an
 * independent validation of the result.
 */

export interface EngineCourt {
  id: string;
  /** First slot the court can be used (inclusive). */
  availableFrom?: number | null;
  /** Slot from which the court is no longer available (exclusive). */
  availableUntil?: number | null;
}

export interface EngineMatch {
  id: string;
  categoryId: string;
  /** Lower = earlier. */
  priority: number;
  round: number;
  matchNumber: number;
  /** Pair position within its team (1 = top pair, A); null for matches without one. */
  rank?: number | null;
  playerIds: readonly string[];
  teamIds: readonly string[];
  /** Locked, live or finished matches: their cell must not change. Court is an index into courts. */
  fixed?: { slot: number; court: number } | null;
  /**
   * Matches that must be played first (the matches that feed this knockout match). It goes at least
   * minRestSlots + 1 slots after each of them, because the winner needs to rest too.
   */
  after?: readonly string[];
  /** This match may not go before this slot (e.g. "play MD-E earlier, but not at the very first slot"). */
  notBeforeSlot?: number;
  /** The last slot this match may start in ("finished by 4 PM"). A match that cannot fit is reported as not placed. */
  notAfterSlot?: number;
  /** Previously published cell; kept when still valid (minimises changes on regeneration). */
  preferred?: { slot: number; court: number } | null;
}

export interface EngineOptions {
  /** Number of slots before the end time; null = open-ended. */
  slotCount: number | null;
  /**
   * Earliest slot the scheduler may use for matches that are not fixed. Used to reschedule the rest
   * of the day after a delay ("nothing new before 5:30 PM"). Fixed matches keep their cells.
   */
  minSlot?: number;
  minRestSlots: number;
  seed: number;
  /** Soft cap on simultaneous matches per team; null = no cap. */
  maxTeamConcurrent?: number | null;
  /** Prefer keeping a category on the same court (as in the reference schedule). Default true. */
  categoryCourtAffinity?: boolean;
  /** 'low_first': lower pairs (higher rank numbers) start first, the top pair plays last. Default 'none'. */
  rankOrder?: 'low_first' | 'high_first' | 'none';
  /** Finish pairs that already started before starting new ones (short time at the venue). Default true. */
  fairWaiting?: boolean;
}

export interface Placement {
  matchId: string;
  slot: number;
  court: number;
}

export interface Conflict {
  type: 'player_overlap' | 'rest' | 'court_double' | 'court_unavailable' | 'out_of_range' | 'dependency';
  matchIds: string[];
  message: string;
  /** Player involved (player_overlap / rest). */
  playerId?: string;
}

export interface EngineResult {
  /** Cells for every non-fixed match that could be placed. */
  placements: Placement[];
  unscheduled: { matchId: string; reason: string; playerIds: string[] }[];
  /** Hard-rule violations in the final grid (only possible between fixed matches). */
  conflicts: Conflict[];
  /** Number of slots from 0 to the last used slot. */
  slotsUsed: number;
  stats: {
    scheduled: number;
    fixed: number;
    emptyCells: number;
    /** Smallest gap (in slots) between two matches of the same player; null if nobody plays twice. */
    minPlayerGap: number | null;
    avgPlayerGap: number | null;
    /** Placements that kept their preferred (previously published) cell. */
    kept: number;
  };
}

/** Small fast seeded PRNG (mulberry32). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0 || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const courtOpen = (c: EngineCourt, slot: number) =>
  (c.availableFrom == null || slot >= c.availableFrom) && (c.availableUntil == null || slot < c.availableUntil);

class Grid {
  readonly cells = new Map<number, (string | null)[]>();
  readonly slotOf = new Map<string, Placement>();
  readonly playerSlots = new Map<string, number[]>();
  readonly teamSlotCount = new Map<string, number>(); // `${team}@${slot}` → count

  constructor(
    private readonly courts: readonly EngineCourt[],
    private readonly byId: Map<string, EngineMatch>,
  ) {}

  row(slot: number) {
    let r = this.cells.get(slot);
    if (!r) {
      r = Array(this.courts.length).fill(null);
      this.cells.set(slot, r);
    }
    return r;
  }

  free(slot: number, court: number) {
    return courtOpen(this.courts[court]!, slot) && this.row(slot)[court] === null;
  }

  /** Players of `m` are all free and rested at `slot` (ignoring match `ignore`). */
  playersOk(m: EngineMatch, slot: number, minRest: number, ignore?: string): boolean {
    for (const p of m.playerIds) {
      for (const s of this.playerSlots.get(p) ?? []) {
        if (Math.abs(s - slot) <= minRest) {
          if (ignore && this.slotOf.get(ignore)?.slot === s && this.byId.get(ignore)!.playerIds.includes(p)) continue;
          return false;
        }
      }
    }
    return true;
  }

  blockers(m: EngineMatch, slot: number, minRest: number): string[] {
    return m.playerIds.filter((p) => (this.playerSlots.get(p) ?? []).some((s) => Math.abs(s - slot) <= minRest));
  }

  place(m: EngineMatch, slot: number, court: number) {
    this.row(slot)[court] = m.id;
    this.slotOf.set(m.id, { matchId: m.id, slot, court });
    for (const p of m.playerIds) this.playerSlots.set(p, [...(this.playerSlots.get(p) ?? []), slot]);
    for (const t of new Set(m.teamIds)) this.teamSlotCount.set(`${t}@${slot}`, (this.teamSlotCount.get(`${t}@${slot}`) ?? 0) + 1);
  }

  remove(m: EngineMatch) {
    const p0 = this.slotOf.get(m.id);
    if (!p0) return;
    this.row(p0.slot)[p0.court] = null;
    this.slotOf.delete(m.id);
    for (const p of m.playerIds) {
      const list = this.playerSlots.get(p) ?? [];
      const i = list.indexOf(p0.slot);
      if (i >= 0) list.splice(i, 1);
    }
    for (const t of new Set(m.teamIds)) this.teamSlotCount.set(`${t}@${p0.slot}`, (this.teamSlotCount.get(`${t}@${p0.slot}`) ?? 1) - 1);
  }

  teamLoad(m: EngineMatch, slot: number) {
    return Math.max(0, ...[...new Set(m.teamIds)].map((t) => this.teamSlotCount.get(`${t}@${slot}`) ?? 0));
  }
}

/**
 * Plans every match. Two orderings are tried and the better plan is kept: the shortest day first, and among
 * equally short days the one where players spend the least time between their first and last match
 * (pairs finish what they started instead of waiting around between matches).
 */
export function scheduleMatches(courts: readonly EngineCourt[], matches: readonly EngineMatch[], opts: EngineOptions): EngineResult {
  const orders: ('low_first' | 'high_first' | 'none')[] = opts.rankOrder && opts.rankOrder !== 'none' ? [opts.rankOrder, 'none'] : ['none'];
  const fairs = opts.fairWaiting === false ? [false] : [true, false];
  // Preferred variants first: on a tie the earlier one wins.
  const candidates = orders.flatMap((rankOrder) => fairs.map((fairWaiting) => scheduleOnce(courts, matches, { ...opts, rankOrder, fairWaiting })));
  const slotOf = (r: EngineResult) => new Map(r.placements.map((p) => [p.matchId, p.slot]));
  const fixedSlot = new Map(matches.filter((m) => m.fixed).map((m) => [m.id, m.fixed!.slot]));
  const cost = (r: EngineResult): [number, number] => {
    const at = slotOf(r);
    const span = new Map<string, [number, number]>();
    for (const m of matches) {
      const slot = at.get(m.id) ?? fixedSlot.get(m.id);
      if (slot === undefined) continue;
      for (const p of m.playerIds) {
        const e = span.get(p);
        span.set(p, e ? [Math.min(e[0], slot), Math.max(e[1], slot)] : [slot, slot]);
      }
    }
    let total = 0;
    for (const [lo, hi] of span.values()) total += hi - lo;
    return [r.unscheduled.length * 1000 + r.slotsUsed, total];
  };
  let best = candidates[0]!;
  let bestCost = cost(best);
  for (const c of candidates.slice(1)) {
    const k = cost(c);
    if (k[0] < bestCost[0] || (k[0] === bestCost[0] && k[1] < bestCost[1])) {
      best = c;
      bestCost = k;
    }
  }
  return best;
}

function scheduleOnce(
  courts: readonly EngineCourt[],
  matches: readonly EngineMatch[],
  opts: EngineOptions,
): EngineResult {
  const minRest = Math.max(0, Math.floor(opts.minRestSlots));
  const affinity = opts.categoryCourtAffinity !== false;
  const byId = new Map(matches.map((m) => [m.id, m]));
  const grid = new Grid(courts, byId);
  const rand = seededRandom(opts.seed);
  const tie = new Map(matches.map((m) => [m.id, rand()]));

  // 1. Fixed matches first, exactly where they are.
  const fixed = matches.filter((m) => m.fixed);
  for (const m of fixed) grid.place(m, m.fixed!.slot, m.fixed!.court);

  // Pair rank as a sort key: 0 when ranks are ignored or unknown.
  const rankKey = (m: EngineMatch): number => {
    const r = m.rank ?? 0;
    return opts.rankOrder === 'low_first' ? -r : opts.rankOrder === 'high_first' ? r : 0;
  };

  const pending = matches
    .filter((m) => !m.fixed)
    .sort((a, b) => a.priority - b.priority || rankKey(a) - rankKey(b) || a.round - b.round || a.matchNumber - b.matchNumber);
  const remaining = new Map<string, number>(); // player → unplaced matches
  for (const m of pending) for (const p of m.playerIds) remaining.set(p, (remaining.get(p) ?? 0) + 1);

  const homeCourt = new Map<string, number>(); // category → court it mostly uses
  for (const m of fixed) if (!homeCourt.has(m.categoryId)) homeCourt.set(m.categoryId, m.fixed!.court);

  const minSlot = Math.max(0, Math.floor(opts.minSlot ?? 0));
  const fixedMax = fixed.reduce((mx, m) => Math.max(mx, m.fixed!.slot), -1);
  const horizon =
    opts.slotCount ?? Math.max(fixedMax + 1, minSlot) + pending.length * (minRest + 1) + 1; // open-ended: always enough
  const placed: Placement[] = [];
  const unplaced = new Set(pending.map((m) => m.id));

  // Short time at the venue: a pair that has started its matches should finish them before new pairs start,
  // so nobody hangs around for hours between their first and last match. lastPlayed tracks who has started.
  const lastPlayed = new Map<string, number>();
  for (const m of fixed) for (const p of m.playerIds) lastPlayed.set(p, Math.max(lastPlayed.get(p) ?? -1, m.fixed!.slot));
  const startedCount = (m: EngineMatch) => m.playerIds.reduce((n, p) => n + (lastPlayed.has(p) ? 1 : 0), 0);
  const maxIdle = (m: EngineMatch, slot: number) => m.playerIds.reduce((w, p) => Math.max(w, lastPlayed.has(p) ? slot - lastPlayed.get(p)! - 1 : 0), 0);

  const commit = (m: EngineMatch, slot: number, court: number) => {
    grid.place(m, slot, court);
    for (const p of m.playerIds) lastPlayed.set(p, Math.max(lastPlayed.get(p) ?? -1, slot));
    unplaced.delete(m.id);
    for (const p of m.playerIds) remaining.set(p, (remaining.get(p) ?? 1) - 1);
    if (!homeCourt.has(m.categoryId)) homeCourt.set(m.categoryId, court);
  };

  // A match that depends on others may only go once they are all placed, far enough ahead of it.
  const dependents = new Set(matches.flatMap((m) => m.after ?? []));
  const depsOk = (m: EngineMatch, slot: number) =>
    (m.after ?? []).every((id) => {
      const at = grid.slotOf.get(id);
      return at !== undefined && at.slot + minRest + 1 <= slot;
    });

  // 2. Keep previously published cells that are still valid (regeneration with minimal changes).
  for (const m of pending) {
    const pref = m.preferred;
    if (!pref || pref.slot < minSlot || pref.slot < (m.notBeforeSlot ?? 0) || pref.slot >= horizon || pref.court >= courts.length) continue;
    if (grid.free(pref.slot, pref.court) && depsOk(m, pref.slot) && grid.playersOk(m, pref.slot, minRest)) commit(m, pref.slot, pref.court);
  }

  // 3. Slot-major greedy.
  const key = (m: EngineMatch, slot: number, court: number): number[] => {
    const home = homeCourt.get(m.categoryId);
    const affinityCost = !affinity ? 0 : home === court ? 0 : home === undefined ? 1 : 2;
    const overCap = opts.maxTeamConcurrent != null && grid.teamLoad(m, slot) >= opts.maxTeamConcurrent ? 1 : 0;
    const pressure = m.playerIds.reduce((s, p) => s + (remaining.get(p) ?? 0), 0);
    // Affinity only breaks ties: it must never make the day longer than necessary.
    const fair = opts.fairWaiting !== false;
    return [m.priority, fair ? -startedCount(m) : 0, fair ? -maxIdle(m, slot) : 0, rankKey(m), overCap, -pressure, affinityCost, m.round, tie.get(m.id)!];
  };
  const less = (a: number[], b: number[]) => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! < b[i]!;
    return false;
  };

  for (let slot = minSlot; slot < horizon && unplaced.size; slot++) {
    for (let court = 0; court < courts.length && unplaced.size; court++) {
      if (!grid.free(slot, court)) continue;
      let best: EngineMatch | null = null;
      let bestKey: number[] = [];
      for (const id of unplaced) {
        const m = byId.get(id)!;
        if (slot < (m.notBeforeSlot ?? 0) || slot > (m.notAfterSlot ?? Infinity) || !depsOk(m, slot) || !grid.playersOk(m, slot, minRest)) continue;
        const k = key(m, slot, court);
        if (!best || less(k, bestKey)) {
          best = m;
          bestKey = k;
        }
      }
      if (best) commit(best, slot, court);
    }
  }

  // 4. Repair (bounded day): move one blocking match to make room for a leftover.
  if (opts.slotCount != null) {
    for (const id of [...unplaced]) {
      const m = byId.get(id)!;
      let done = false;
      for (let slot = minSlot; slot < horizon && !done; slot++) {
        for (let court = 0; court < courts.length && !done; court++) {
          if (!courtOpen(courts[court]!, slot)) continue;
          const occupant = grid.row(slot)[court];
          if (occupant === null) continue; // empty cells were already tried by the greedy pass
          const x = byId.get(occupant)!;
          if (x.fixed || x.after?.length || dependents.has(x.id)) continue; // chains of dependent matches are not shuffled
          const xAt = grid.slotOf.get(x.id)!;
          grid.remove(x);
          if (depsOk(m, slot) && grid.playersOk(m, slot, minRest)) {
            grid.place(m, slot, court);
            // Find any other cell for x.
            outer: for (let s2 = minSlot; s2 < horizon; s2++) {
              for (let c2 = 0; c2 < courts.length; c2++) {
                if (grid.free(s2, c2) && grid.playersOk(x, s2, minRest)) {
                  grid.place(x, s2, c2);
                  done = true;
                  break outer;
                }
              }
            }
            if (!done) grid.remove(m);
          }
          if (done) {
            unplaced.delete(m.id);
            for (const p of m.playerIds) remaining.set(p, (remaining.get(p) ?? 1) - 1);
          } else {
            grid.place(x, xAt.slot, xAt.court);
          }
        }
      }
    }
  }

  for (const m of pending) {
    const p = grid.slotOf.get(m.id);
    if (p) placed.push(p);
  }

  // 5. Explain anything left over.
  const unscheduled = [...unplaced].map((id) => ({ matchId: id, ...explain(byId.get(id)!, grid, courts, horizon, minRest, opts.slotCount != null, minSlot) }));

  // 6. Independent validation of the whole grid.
  const all = [...fixed.map((m) => ({ matchId: m.id, ...m.fixed! })), ...placed];
  const conflicts = findConflicts(courts, matches, all, minRest, opts.slotCount);

  const slotsUsed = all.reduce((mx, p) => Math.max(mx, p.slot + 1), 0);
  let emptyCells = 0;
  for (let s = 0; s < slotsUsed; s++) for (let c = 0; c < courts.length; c++) if (courtOpen(courts[c]!, s) && grid.row(s)[c] === null) emptyCells++;

  const gaps: number[] = [];
  for (const slots of grid.playerSlots.values()) {
    const sorted = [...slots].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) gaps.push(sorted[i]! - sorted[i - 1]!);
  }
  const kept = placed.filter((p) => {
    const pref = byId.get(p.matchId)!.preferred;
    return pref && pref.slot === p.slot && pref.court === p.court;
  }).length;

  return {
    placements: placed,
    unscheduled,
    conflicts,
    slotsUsed,
    stats: {
      scheduled: placed.length,
      fixed: fixed.length,
      emptyCells,
      minPlayerGap: gaps.length ? Math.min(...gaps) : null,
      avgPlayerGap: gaps.length ? Math.round((gaps.reduce((a, b) => a + b, 0) / gaps.length) * 10) / 10 : null,
      kept,
    },
  };
}

function explain(
  m: EngineMatch,
  grid: Grid,
  courts: readonly EngineCourt[],
  horizon: number,
  minRest: number,
  bounded: boolean,
  minSlot: number,
): { reason: string; playerIds: string[] } {
  if ((m.after ?? []).some((id) => !grid.slotOf.has(id))) {
    return { reason: 'Waiting for a match it depends on that could not be placed', playerIds: [] };
  }
  let playerFreeSlots = 0;
  const blockCount = new Map<string, number>();
  for (let s = minSlot; s < horizon; s++) {
    const who = grid.blockers(m, s, minRest);
    if (who.length) for (const p of who) blockCount.set(p, (blockCount.get(p) ?? 0) + 1);
    else playerFreeSlots++;
  }
  const until = bounded ? ' before the end time' : '';
  if (playerFreeSlots === 0) {
    const top = [...blockCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([p]) => p);
    return { reason: `Its players are playing or resting in every slot${until}`, playerIds: top };
  }
  const anyCourt = Array.from({ length: horizon }, (_, s) => s).some((s) => courts.some((_, c) => grid.free(s, c)));
  return {
    reason: anyCourt ? `Its players are free only when every court is taken${until}` : `No free court${until}`,
    playerIds: [],
  };
}

/**
 * Checks hard rules on a complete grid. Used after generation, for the conflicts view, and to
 * validate manual moves. `slotCount` (if given) flags cells after the end time.
 */
export function findConflicts(
  courts: readonly EngineCourt[],
  matches: readonly Pick<EngineMatch, 'id' | 'playerIds' | 'after'>[],
  placements: readonly Placement[],
  minRestSlots: number,
  slotCount?: number | null,
): Conflict[] {
  const out: Conflict[] = [];
  const byId = new Map(matches.map((m) => [m.id, m]));
  const cell = new Map<string, string>();
  for (const p of placements) {
    const k = `${p.slot}:${p.court}`;
    const other = cell.get(k);
    if (other) out.push({ type: 'court_double', matchIds: [other, p.matchId], message: `Two matches on the same court at the same time` });
    else cell.set(k, p.matchId);
    const c = courts[p.court];
    if (!c || !courtOpen(c, p.slot)) out.push({ type: 'court_unavailable', matchIds: [p.matchId], message: 'Court is not available at that time' });
    if (slotCount != null && p.slot >= slotCount) out.push({ type: 'out_of_range', matchIds: [p.matchId], message: 'Scheduled after the end time' });
  }
  const byPlayer = new Map<string, Placement[]>();
  for (const p of placements) {
    for (const pl of byId.get(p.matchId)?.playerIds ?? []) byPlayer.set(pl, [...(byPlayer.get(pl) ?? []), p]);
  }
  const seen = new Set<string>();
  for (const [player, list] of byPlayer) {
    const sorted = [...list].sort((a, b) => a.slot - b.slot);
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const gap = sorted[j]!.slot - sorted[i]!.slot;
        if (gap > minRestSlots) break;
        if (sorted[i]!.matchId === sorted[j]!.matchId) continue;
        const ids = [sorted[i]!.matchId, sorted[j]!.matchId];
        const k = `${ids.sort().join('|')}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(
          gap === 0
            ? { type: 'player_overlap', matchIds: ids, playerId: player, message: 'A player is in two matches at the same time' }
            : { type: 'rest', matchIds: ids, playerId: player, message: 'A player has less than the minimum rest between matches' },
        );
      }
    }
  }
  // A match must come after the matches that feed it (and leave the winner time to rest).
  const slotOfMatch = new Map(placements.map((p) => [p.matchId, p.slot]));
  for (const p of placements) {
    for (const pre of byId.get(p.matchId)?.after ?? []) {
      const s = slotOfMatch.get(pre);
      if (s !== undefined && s + minRestSlots + 1 > p.slot) {
        out.push({ type: 'dependency', matchIds: [pre, p.matchId], message: 'A match is scheduled before the match it depends on can be finished (the winner also needs rest time)' });
      }
    }
  }
  return out;
}
