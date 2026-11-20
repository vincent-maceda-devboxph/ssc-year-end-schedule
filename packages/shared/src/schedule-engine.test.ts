import { describe, expect, it } from 'vitest';
import { generateRoundRobin, type GenCategory } from './match-generator.js';
import { findConflicts, scheduleMatches, type EngineCourt, type EngineMatch } from './schedule-engine.js';

const courts = (n: number): EngineCourt[] => Array.from({ length: n }, (_, i) => ({ id: `c${i + 1}` }));

/** Build engine matches for T teams × K categories, one pair per team per category. */
function event(teams: string[], codes: string[]): EngineMatch[] {
  const cats: GenCategory[] = codes.map((code) => ({
    id: code,
    name: code,
    allowSameTeam: false,
    pairs: teams.map((t) => ({ id: `${t}-${code}`, teamId: t, label: '' })),
  }));
  return generateRoundRobin(cats).matches.map((m, i) => ({
    id: `m${i + 1}`,
    categoryId: m.categoryId,
    priority: 100,
    round: m.round,
    matchNumber: i + 1,
    // Each pair has two players: "<pair>/1" and "<pair>/2".
    playerIds: [`${m.entryAId}/1`, `${m.entryAId}/2`, `${m.entryBId}/1`, `${m.entryBId}/2`],
    teamIds: [m.teamAId!, m.teamBId!],
  }));
}

const REF_TEAMS = ['hulk', 'avengers', 'iron'];
const REF_CODES = ['MD-A', 'MD-B', 'MD-C', 'MD-D', 'MD-E', 'MD-F', 'MD-G', 'MD-H', 'MD-I', 'MD-J', 'WD-A', 'WD-B', 'WD-C'];
const reference = event(REF_TEAMS, REF_CODES);

function assertValid(c: EngineCourt[], ms: EngineMatch[], r: ReturnType<typeof scheduleMatches>, rest: number) {
  const all = [...ms.filter((m) => m.fixed).map((m) => ({ matchId: m.id, ...m.fixed! })), ...r.placements];
  expect(findConflicts(c, ms, all, rest)).toEqual([]);
  expect(r.conflicts).toEqual([]);
}

describe('scheduleMatches – reference event (3 teams, 13 categories, 4 courts)', () => {
  const r = scheduleMatches(courts(4), reference, { slotCount: null, minRestSlots: 1, seed: 1 });

  it('schedules all 39 matches with no hard-rule violations', () => {
    expect(reference).toHaveLength(39);
    expect(r.placements).toHaveLength(39);
    expect(r.unscheduled).toEqual([]);
    assertValid(courts(4), reference, r, 1);
  });

  it('is as short as possible: 39 matches / 4 courts = 10 slots, whatever the seed', () => {
    for (const seed of [1, 2, 3, 10, 99]) {
      const x = scheduleMatches(courts(4), reference, { slotCount: null, minRestSlots: 1, seed });
      expect(x.slotsUsed).toBe(10);
    }
    expect(r.slotsUsed).toBe(10);
    expect(r.stats.minPlayerGap).toBeGreaterThanOrEqual(2); // 1 slot of rest = next match 2 slots later
  });

  it('keeps most of a category on one court (soft affinity)', () => {
    let onHome = 0;
    for (const code of REF_CODES) {
      const cs = r.placements.filter((p) => reference.find((m) => m.id === p.matchId)!.categoryId === code).map((p) => p.court);
      const counts = cs.reduce<Record<number, number>>((a, c) => ((a[c] = (a[c] ?? 0) + 1), a), {});
      onHome += Math.max(...Object.values(counts));
    }
    expect(onHome / 39).toBeGreaterThanOrEqual(0.9);
  });

  it('is deterministic for a seed and varies with another seed', () => {
    const again = scheduleMatches(courts(4), reference, { slotCount: null, minRestSlots: 1, seed: 1 });
    expect(again.placements).toEqual(r.placements);
    const other = scheduleMatches(courts(4), reference, { slotCount: null, minRestSlots: 1, seed: 99 });
    expect(other.placements).not.toEqual(r.placements);
    assertValid(courts(4), reference, other, 1);
  });
});

describe('scheduleMatches – constraints', () => {
  it('4 teams × 16 categories (96 matches) on 4 courts, valid', () => {
    const ms = event(['a', 'b', 'c', 'd'], Array.from({ length: 16 }, (_, i) => `K${i}`));
    const r = scheduleMatches(courts(4), ms, { slotCount: null, minRestSlots: 1, seed: 7 });
    expect(r.placements).toHaveLength(96);
    assertValid(courts(4), ms, r, 1);
    expect(r.slotsUsed).toBeLessThanOrEqual(27);
  });

  it('different court counts all produce valid schedules', () => {
    for (const n of [1, 2, 3, 6, 8]) {
      const r = scheduleMatches(courts(n), reference, { slotCount: null, minRestSlots: 1, seed: 3 });
      expect(r.placements).toHaveLength(39);
      assertValid(courts(n), reference, r, 1);
    }
  });

  it('rest 0 allows back-to-back, rest 2 forces bigger gaps', () => {
    const r0 = scheduleMatches(courts(4), reference, { slotCount: null, minRestSlots: 0, seed: 1 });
    assertValid(courts(4), reference, r0, 0);
    const r2 = scheduleMatches(courts(4), reference, { slotCount: null, minRestSlots: 2, seed: 1 });
    assertValid(courts(4), reference, r2, 2);
    expect(r2.stats.minPlayerGap).toBeGreaterThanOrEqual(3);
  });

  it('fixed (locked/live/finished) matches stay put and others respect them', () => {
    const ms = reference.map((m, i) => (i === 5 ? { ...m, fixed: { slot: 0, court: 0 } } : i === 6 ? { ...m, fixed: { slot: 3, court: 2 } } : m));
    const r = scheduleMatches(courts(4), ms, { slotCount: null, minRestSlots: 1, seed: 1 });
    expect(r.placements.find((p) => p.matchId === ms[5]!.id)).toBeUndefined(); // not re-placed
    expect(r.placements.some((p) => p.slot === 0 && p.court === 0)).toBe(false);
    expect(r.placements.some((p) => p.slot === 3 && p.court === 2)).toBe(false);
    expect(r.placements).toHaveLength(37);
    assertValid(courts(4), ms, r, 1);
  });

  it('keeps previously published cells when still valid', () => {
    const first = scheduleMatches(courts(4), reference, { slotCount: null, minRestSlots: 1, seed: 1 });
    const withPref = reference.map((m) => {
      const p = first.placements.find((x) => x.matchId === m.id)!;
      return { ...m, preferred: { slot: p.slot, court: p.court } };
    });
    const r = scheduleMatches(courts(4), withPref, { slotCount: null, minRestSlots: 1, seed: 42 });
    expect(r.stats.kept).toBe(39);
  });

  it('respects court availability windows', () => {
    const c: EngineCourt[] = [{ id: 'c1' }, { id: 'c2' }, { id: 'c3', availableFrom: 4 }, { id: 'c4', availableUntil: 2 }];
    const r = scheduleMatches(c, reference, { slotCount: null, minRestSlots: 1, seed: 1 });
    expect(r.placements.filter((p) => p.court === 2 && p.slot < 4)).toEqual([]);
    expect(r.placements.filter((p) => p.court === 3 && p.slot >= 2)).toEqual([]);
    expect(r.placements).toHaveLength(39);
    assertValid(c, reference, r, 1);
  });

  it('never double-books a player who is in two categories', () => {
    const ms = reference.map((m) => (m.categoryId === 'MD-B' ? { ...m, playerIds: m.playerIds.map((p) => p.replace('MD-B', 'MD-A')) } : m));
    const r = scheduleMatches(courts(4), ms, { slotCount: null, minRestSlots: 1, seed: 1 });
    expect(r.placements).toHaveLength(39);
    assertValid(courts(4), ms, r, 1);
  });

  it('reports what does not fit in a short day, without breaking rules', () => {
    const r = scheduleMatches(courts(4), reference, { slotCount: 3, minRestSlots: 1, seed: 1 });
    expect(r.placements.length).toBeLessThanOrEqual(12);
    expect(r.placements.every((p) => p.slot < 3)).toBe(true);
    expect(r.unscheduled.length).toBe(39 - r.placements.length);
    expect(r.unscheduled[0]!.reason).toMatch(/before the end time/);
    assertValid(courts(4), reference, r, 1);
  });

  it('flags conflicts between fixed matches instead of hiding them', () => {
    const [a, b] = reference.filter((m) => m.categoryId === 'MD-A'); // share a pair
    const ms = [{ ...a!, fixed: { slot: 0, court: 0 } }, { ...b!, fixed: { slot: 0, court: 1 } }];
    const r = scheduleMatches(courts(4), ms, { slotCount: null, minRestSlots: 1, seed: 1 });
    expect(r.conflicts.map((c) => c.type)).toContain('player_overlap');
  });

  it('soft team cap spreads a team across slots when possible', () => {
    const r = scheduleMatches(courts(4), reference, { slotCount: null, minRestSlots: 1, seed: 1, maxTeamConcurrent: 3 });
    assertValid(courts(4), reference, r, 1);
    expect(r.placements).toHaveLength(39);
  });
});

describe('findConflicts', () => {
  it('detects court double-booking, rest and unavailable courts', () => {
    const ms = [
      { id: 'x', playerIds: ['p1', 'p2'] },
      { id: 'y', playerIds: ['p1', 'p3'] },
      { id: 'z', playerIds: ['p4'] },
    ];
    const c: EngineCourt[] = [{ id: 'c1' }, { id: 'c2', availableFrom: 5 }];
    const out = findConflicts(c, ms, [
      { matchId: 'x', slot: 0, court: 0 },
      { matchId: 'y', slot: 1, court: 0 },
      { matchId: 'z', slot: 1, court: 0 },
      { matchId: 'z', slot: 0, court: 1 },
    ], 1, 1);
    const types = out.map((o) => o.type).sort();
    expect(types).toEqual(['court_double', 'court_unavailable', 'out_of_range', 'out_of_range', 'rest'].sort());
    expect(out.find((o) => o.type === 'rest')!.playerId).toBe('p1');
  });
});

describe('scheduleMatches – reschedule after a delay (minSlot)', () => {
  it('places nothing before the earliest slot, and still finishes as fast as possible', () => {
    const r = scheduleMatches(courts(4), reference, { slotCount: null, minRestSlots: 1, seed: 1, minSlot: 4 });
    expect(r.placements).toHaveLength(39);
    expect(Math.min(...r.placements.map((p) => p.slot))).toBe(4);
    expect(r.slotsUsed).toBe(14); // 4 empty slots, then the usual 10
    assertValid(courts(4), reference, r, 1);
  });

  it('fixed matches before the cutoff stay; the rest start at the cutoff', () => {
    // Matches 0, 3, 6, 9 are from four different brackets, so they share no players.
    const fixedAt = new Map([[0, { slot: 0, court: 0 }], [3, { slot: 1, court: 1 }], [6, { slot: 0, court: 2 }], [9, { slot: 1, court: 3 }]]);
    const ms = reference.map((m, i) => (fixedAt.has(i) ? { ...m, fixed: fixedAt.get(i)! } : m));
    const r = scheduleMatches(courts(4), ms, { slotCount: null, minRestSlots: 1, seed: 1, minSlot: 6 });
    expect(r.placements).toHaveLength(35);
    expect(Math.min(...r.placements.map((p) => p.slot))).toBeGreaterThanOrEqual(6);
    assertValid(courts(4), ms, r, 1);
  });

  it('a previously published cell before the cutoff is not kept', () => {
    const withPref = reference.map((m, i) => ({ ...m, preferred: { slot: Math.floor(i / 4), court: i % 4 } }));
    const r = scheduleMatches(courts(4), withPref, { slotCount: null, minRestSlots: 1, seed: 1, minSlot: 3 });
    expect(r.placements.every((p) => p.slot >= 3)).toBe(true);
    expect(r.stats.kept).toBeGreaterThan(0); // cells at or after the cutoff that still fit are kept
  });

  it('a delay that pushes the day past its end reports what no longer fits', () => {
    const r = scheduleMatches(courts(4), reference, { slotCount: 12, minRestSlots: 1, seed: 1, minSlot: 6 });
    expect(r.placements.every((p) => p.slot >= 6 && p.slot < 12)).toBe(true);
    expect(r.unscheduled.length).toBe(39 - r.placements.length);
    expect(r.unscheduled.length).toBeGreaterThan(0);
    expect(r.unscheduled[0]!.reason).toMatch(/before the end time/);
    assertValid(courts(4), reference, r, 1);
  });
});

describe('scheduleMatches – knockout dependencies (after)', () => {
  /** An 8-player knockout: 4 quarterfinals -> 2 semifinals -> final. Players are only known for the quarters. */
  const ko = (): EngineMatch[] => {
    const q = (i: number): EngineMatch => ({ id: `q${i}`, categoryId: 'ko', priority: 100, round: 1, matchNumber: i, playerIds: [`p${i * 2}`, `p${i * 2 + 1}`], teamIds: [] });
    return [
      q(0), q(1), q(2), q(3),
      { id: 's0', categoryId: 'ko', priority: 100, round: 2, matchNumber: 5, playerIds: [], teamIds: [], after: ['q0', 'q1'] },
      { id: 's1', categoryId: 'ko', priority: 100, round: 2, matchNumber: 6, playerIds: [], teamIds: [], after: ['q2', 'q3'] },
      { id: 'f', categoryId: 'ko', priority: 100, round: 3, matchNumber: 7, playerIds: [], teamIds: [], after: ['s0', 's1'] },
    ];
  };
  const at = (r: ReturnType<typeof scheduleMatches>, id: string) => r.placements.find((p) => p.matchId === id)!.slot;

  it('each round starts after the previous one has been played, with the winner\'s rest in between', () => {
    const r = scheduleMatches(courts(4), ko(), { slotCount: null, minRestSlots: 1, seed: 1 });
    expect(r.placements).toHaveLength(7);
    expect(r.conflicts).toEqual([]);
    for (const q of ['q0', 'q1', 'q2', 'q3']) expect(at(r, q)).toBe(0); // all four quarters at once on 4 courts
    expect(at(r, 's0')).toBe(2); // quarter at 0, one slot of rest, semifinal at 2
    expect(at(r, 's1')).toBe(2);
    expect(at(r, 'f')).toBe(4);
  });

  it('with no rest required the next round can follow immediately', () => {
    const r = scheduleMatches(courts(4), ko(), { slotCount: null, minRestSlots: 0, seed: 1 });
    expect([at(r, 's0'), at(r, 's1'), at(r, 'f')]).toEqual([1, 1, 2]);
  });

  it('on one court the order is quarters, then semis, then the final', () => {
    const r = scheduleMatches(courts(1), ko(), { slotCount: null, minRestSlots: 1, seed: 1 });
    expect(r.conflicts).toEqual([]);
    const slots = (ids: string[]) => ids.map((id) => at(r, id));
    expect(Math.max(...slots(['q0', 'q1']))).toBeLessThan(at(r, 's0') - 1);
    expect(Math.max(...slots(['q2', 'q3']))).toBeLessThan(at(r, 's1') - 1);
    expect(Math.max(at(r, 's0'), at(r, 's1'))).toBeLessThan(at(r, 'f') - 1);
  });

  it('a prerequisite that is already finished (not in the list) no longer holds the match back', () => {
    const m = ko().filter((x) => !['q0', 'q1'].includes(x.id)).map((x) => (x.id === 's0' ? { ...x, after: [] } : x));
    expect(at(scheduleMatches(courts(4), m, { slotCount: null, minRestSlots: 1, seed: 1 }), 's0')).toBe(0);
  });

  it('a fixed (live or locked) prerequisite pushes its dependents later', () => {
    const ms = ko().map((x) => (x.id === 'q0' ? { ...x, fixed: { slot: 3, court: 0 } } : x));
    const r = scheduleMatches(courts(4), ms, { slotCount: null, minRestSlots: 1, seed: 1 });
    expect(at(r, 's0')).toBeGreaterThanOrEqual(5);
    expect(r.conflicts).toEqual([]);
  });

  it('a match whose prerequisite cannot be placed is reported, not placed too early', () => {
    const r = scheduleMatches(courts(4), ko().filter((x) => x.id !== 'q0'), { slotCount: null, minRestSlots: 1, seed: 1 });
    const stuck = r.unscheduled.map((u) => u.matchId).sort();
    expect(stuck).toEqual(['f', 's0']); // s0 waits for the missing q0; the final waits for s0
    expect(r.unscheduled[0]!.reason).toMatch(/Waiting for a match it depends on/);
    expect(r.placements.map((p) => p.matchId)).toContain('s1');
  });

  it('a short day places what fits and reports the rest', () => {
    const r = scheduleMatches(courts(4), ko(), { slotCount: 4, minRestSlots: 1, seed: 1 });
    expect(r.placements.map((p) => p.matchId).sort()).toEqual(['q0', 'q1', 'q2', 'q3', 's0', 's1']);
    expect(r.unscheduled.map((u) => u.matchId)).toEqual(['f']);
  });

  it('the conflict check flags a dependent placed too early', () => {
    const out = findConflicts(courts(4), ko(), [
      { matchId: 'q0', slot: 2, court: 0 },
      { matchId: 's0', slot: 3, court: 1 }, // needs slot >= 4 with rest 1
    ], 1);
    expect(out.map((c) => c.type)).toEqual(['dependency']);
    expect(findConflicts(courts(4), ko(), [{ matchId: 'q0', slot: 2, court: 0 }, { matchId: 's0', slot: 4, court: 1 }], 1)).toEqual([]);
  });
});
