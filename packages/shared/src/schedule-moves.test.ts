import { describe, expect, it } from 'vitest';
import { checkMove, courtStatus } from './schedule-moves.js';
import type { EngineCourt, Placement } from './schedule-engine.js';

const courts: EngineCourt[] = [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }];
// A and B share player p1; C and D are unrelated.
const matches = [
  { id: 'A', playerIds: ['p1', 'p2'] },
  { id: 'B', playerIds: ['p1', 'p3'] },
  { id: 'C', playerIds: ['p4', 'p5'] },
  { id: 'D', playerIds: ['p6', 'p7'] },
];
const grid: Placement[] = [
  { matchId: 'A', slot: 0, court: 0 },
  { matchId: 'B', slot: 2, court: 0 }, // 1 slot of rest after A
  { matchId: 'C', slot: 0, court: 1 },
  { matchId: 'D', slot: 1, court: 1 },
];
const move = (matchId: string, slot: number, court: number, swapWith?: string) => checkMove(courts, matches, grid, { matchId, slot, court, swapWith }, 1, null);

describe('checkMove', () => {
  it('allows a clean move to an empty cell', () => {
    const r = move('C', 4, 2);
    expect(r.blocked).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.placements.find((p) => p.matchId === 'C')).toMatchObject({ slot: 4, court: 2 });
  });

  it('blocks putting a player in two matches at the same time', () => {
    const r = move('B', 0, 2); // B shares p1 with A (slot 0)
    expect(r.blocked.map((i) => i.type)).toEqual(['player_overlap']);
    expect(r.blocked[0]!.playerId).toBe('p1');
  });

  it('warns (but allows) when rest is shorter than the minimum', () => {
    const r = move('B', 1, 2); // right after A with rest 1 → gap 1
    expect(r.blocked).toEqual([]);
    expect(r.warnings.map((i) => i.type)).toEqual(['rest']);
  });

  it('blocks an occupied cell unless swapping', () => {
    expect(move('C', 0, 0).blocked.map((i) => i.type)).toEqual(['cell_occupied']);
    const swap = move('C', 0, 0, 'A');
    expect(swap.blocked.map((i) => i.type)).toEqual([]);
    expect(swap.placements.find((p) => p.matchId === 'A')).toMatchObject({ slot: 0, court: 1 });
    expect(swap.placements.find((p) => p.matchId === 'C')).toMatchObject({ slot: 0, court: 0 });
  });

  it('a swap that would double-book a player is blocked', () => {
    // C <-> D swap is fine, but swapping B into A's slot puts p1 twice only if both stay; B<->A is fine too.
    // Swap A (slot 0) with D (slot 1, court 1): A goes to court 1 slot 1, D to court 0 slot 0. A and B still 2 apart.
    expect(move('A', 1, 1, 'D').blocked).toEqual([]);
    // Swap B with C: B to (0,1) at slot 0 overlaps A (p1, slot 0).
    expect(move('B', 0, 1, 'C').blocked.map((i) => i.type)).toEqual(['player_overlap']);
  });

  it('rejects a stale swap partner and bad targets', () => {
    expect(move('C', 4, 2, 'A').blocked.map((i) => i.type)).toEqual(['swap_mismatch']);
    expect(move('C', -1, 0).blocked.map((i) => i.type)).toEqual(['bad_target']);
    expect(move('C', 0, 9).blocked.map((i) => i.type)).toEqual(['bad_target']);
  });

  it('respects the end of play and court availability', () => {
    expect(checkMove(courts, matches, grid, { matchId: 'C', slot: 5, court: 2 }, 1, 5).blocked.map((i) => i.type)).toEqual(['out_of_range']);
    const closed: EngineCourt[] = [{ id: 'c1' }, { id: 'c2' }, { id: 'c3', availableFrom: 3 }];
    expect(checkMove(closed, matches, grid, { matchId: 'C', slot: 1, court: 2 }, 1, null).blocked.map((i) => i.type)).toEqual(['court_unavailable']);
  });

  it('ignores old problems that do not involve the moved match', () => {
    const bad: Placement[] = [...grid.filter((p) => p.matchId !== 'B'), { matchId: 'B', slot: 1, court: 0 }]; // A-B rest problem already exists
    const r = checkMove(courts, matches, bad, { matchId: 'D', slot: 3, court: 2 }, 1, null);
    expect(r.blocked).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('can place a match that had no time yet', () => {
    const r = checkMove(courts, matches, grid.filter((p) => p.matchId !== 'D'), { matchId: 'D', slot: 3, court: 2 }, 1, null);
    expect(r.blocked).toEqual([]);
    expect(r.placements).toHaveLength(4);
  });
});

describe('courtStatus', () => {
  it('derives the live status of a court', () => {
    expect(courtStatus(false, ['in_progress'])).toBe('unavailable');
    expect(courtStatus(true, ['completed', 'in_progress', 'scheduled'])).toBe('ongoing');
    expect(courtStatus(true, ['paused'])).toBe('ongoing');
    expect(courtStatus(true, ['completed', 'called', 'scheduled'])).toBe('called');
    expect(courtStatus(true, ['completed', 'scheduled'])).toBe('scheduled');
    expect(courtStatus(true, ['completed', 'walkover'])).toBe('completed');
    expect(courtStatus(true, [])).toBe('available');
  });
});

describe('checkMove – knockout dependencies', () => {
  const ms = [
    { id: 'q', playerIds: ['a', 'b'] },
    { id: 's', playerIds: [], after: ['q'] },
  ];
  const cells: Placement[] = [{ matchId: 'q', slot: 0, court: 0 }, { matchId: 's', slot: 2, court: 0 }];
  const c = [{ id: 'c1' }, { id: 'c2' }];

  it('moving a semifinal before its quarterfinal is blocked', () => {
    const r = checkMove(c, ms, cells, { matchId: 's', slot: 1, court: 1 }, 1, null);
    expect(r.blocked.map((i) => i.type)).toEqual(['dependency']);
  });

  it('moving a quarterfinal after its semifinal is blocked', () => {
    const r = checkMove(c, ms, cells, { matchId: 'q', slot: 3, court: 1 }, 1, null);
    expect(r.blocked.map((i) => i.type)).toEqual(['dependency']);
  });

  it('moves that keep the order (and the rest gap) are fine', () => {
    expect(checkMove(c, ms, cells, { matchId: 's', slot: 5, court: 1 }, 1, null).blocked).toEqual([]);
    expect(checkMove(c, ms, cells, { matchId: 'q', slot: 0, court: 1 }, 1, null).blocked).toEqual([]);
  });
});
