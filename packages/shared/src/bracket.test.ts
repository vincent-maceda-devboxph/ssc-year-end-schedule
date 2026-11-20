import { describe, expect, it } from 'vitest';
import { buildBracket, groupName, qualifierSeeds, roundLabel, seedOrder, snakeGroups } from './bracket.js';

const ids = (n: number) => Array.from({ length: n }, (_, i) => `s${i + 1}`);

describe('seedOrder', () => {
  it('is the standard order', () => {
    expect(seedOrder(2)).toEqual([1, 2]);
    expect(seedOrder(4)).toEqual([1, 4, 2, 3]);
    expect(seedOrder(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6]);
    expect(seedOrder(16)).toEqual([1, 16, 8, 9, 4, 13, 5, 12, 2, 15, 7, 10, 3, 14, 6, 11]);
  });
  it('rejects bad sizes', () => {
    expect(() => seedOrder(3)).toThrow();
    expect(() => seedOrder(1)).toThrow();
  });
});

describe('roundLabel', () => {
  it('names the late rounds and counts the early ones', () => {
    expect([1, 2, 3, 4, 5].map((r) => roundLabel(r, 5))).toEqual(['Round of 32', 'Round of 16', 'Quarterfinal', 'Semifinal', 'Final']);
  });
});

describe('buildBracket', () => {
  it('two entries: just a final', () => {
    const b = buildBracket(ids(2));
    expect(b).toMatchObject({ size: 2, rounds: 1, byes: 0 });
    expect(b.matches).toHaveLength(1);
    expect(b.matches[0]).toMatchObject({ key: 'r1p0', roundLabel: 'Final', entryA: 's1', entryB: 's2' });
  });

  it('four entries: 2 semifinals + final (+ third place), 1 plays 4 and 2 plays 3', () => {
    const b = buildBracket(ids(4), { thirdPlace: true });
    expect(b.matches.map((m) => m.key)).toEqual(['r1p0', 'r1p1', 'r2p0', 'third']);
    expect(b.matches[0]).toMatchObject({ entryA: 's1', entryB: 's4', roundLabel: 'Semifinal' });
    expect(b.matches[1]).toMatchObject({ entryA: 's2', entryB: 's3' });
    expect(b.matches[2]).toMatchObject({ fromA: 'r1p0', fromB: 'r1p1', roundLabel: 'Final', entryA: null });
    expect(b.matches[3]).toMatchObject({ third: true, loserFromA: 'r1p0', loserFromB: 'r1p1', round: 2, roundLabel: 'Third place' });
    expect(buildBracket(ids(4)).matches).toHaveLength(3); // no third place unless asked
  });

  it('five entries: three byes go to the top seeds', () => {
    const b = buildBracket(ids(5));
    expect(b).toMatchObject({ size: 8, rounds: 3, byes: 3 });
    expect(b.matches.filter((m) => m.round === 1).map((m) => [m.entryA, m.entryB])).toEqual([['s4', 's5']]); // only 4 v 5 is played in round 1
    const second = b.matches.filter((m) => m.round === 2);
    expect(second[0]).toMatchObject({ entryA: 's1', fromB: 'r1p1' }); // seed 1 waits for the winner of 4 v 5
    expect(second[1]).toMatchObject({ entryA: 's2', entryB: 's3' }); // seeds 2 and 3 meet in round 2
  });

  it('six entries: seeds 1 and 2 have byes', () => {
    const b = buildBracket(ids(6));
    const r1 = b.matches.filter((m) => m.round === 1);
    // top to bottom of the draw: 4 v 5 (position 1), then 3 v 6 (position 3)
    expect(r1.map((m) => [m.entryA, m.entryB].sort())).toEqual([['s4', 's5'], ['s3', 's6']]);
    expect(b.byes).toBe(2);
  });

  it.each([2, 3, 4, 5, 6, 7, 8, 9, 11, 16, 17, 31, 32])('%i entries: n-1 matches, every entry once, every winner has one place to go', (n) => {
    const b = buildBracket(ids(n));
    expect(b.matches).toHaveLength(n - 1);
    expect(new Set(b.matches.map((m) => m.key)).size).toBe(b.matches.length);

    // Every entry is placed exactly once (in round 1, or as a bye in round 2).
    const placed = b.matches.flatMap((m) => [m.entryA, m.entryB]).filter(Boolean);
    expect([...placed].sort()).toEqual([...ids(n)].sort());

    // Every match except the final feeds exactly one later match, on exactly one side.
    const feeds = b.matches.flatMap((m) => [m.fromA, m.fromB]).filter(Boolean) as string[];
    expect(new Set(feeds).size).toBe(feeds.length);
    expect(feeds.sort()).toEqual(b.matches.filter((m) => m.round < b.rounds).map((m) => m.key).sort());
    expect(b.matches.filter((m) => m.round === b.rounds)).toHaveLength(1);
  });

  it('top seeds can only meet late (1 and 2 in the final, 1-4 in the semifinals)', () => {
    const b = buildBracket(ids(16));
    const halfOf = (key: string): number => {
      // walk down to round 1 and report which half of the draw it is in
      const m = b.matches.find((x) => x.key === key)!;
      if (m.round === 1) return m.pos < 4 ? 0 : 1;
      return halfOf(m.fromA ?? m.fromB!);
    };
    const seedHalf = (s: string) => halfOf(b.matches.find((m) => m.round === 1 && (m.entryA === s || m.entryB === s))!.key);
    expect(seedHalf('s1')).not.toBe(seedHalf('s2'));
    const quarter = (s: string) => Math.floor(b.matches.find((m) => m.round === 1 && (m.entryA === s || m.entryB === s))!.pos / 2);
    expect(new Set(['s1', 's2', 's3', 's4'].map(quarter)).size).toBe(4); // one top-4 seed per quarter
  });

  it('third place needs two real semifinals', () => {
    expect(buildBracket(ids(3), { thirdPlace: true }).matches.some((m) => m.third)).toBe(false);
    expect(buildBracket(ids(8), { thirdPlace: true }).matches.filter((m) => m.third)).toHaveLength(1);
    expect(buildBracket(ids(2), { thirdPlace: true }).matches.some((m) => m.third)).toBe(false);
  });

  it('rejects one entry and duplicates', () => {
    expect(() => buildBracket(ids(1))).toThrow(/at least 2/);
    expect(() => buildBracket(['a', 'b', 'a'])).toThrow(/twice/);
  });
});

describe('groups', () => {
  it('snake order gives every group a mix of seeds', () => {
    expect(snakeGroups(ids(8), 2)).toEqual([['s1', 's4', 's5', 's8'], ['s2', 's3', 's6', 's7']]);
    expect(snakeGroups(ids(7), 3)).toEqual([['s1', 's6', 's7'], ['s2', 's5'], ['s3', 's4']]);
    expect(groupName(0)).toBe('A');
    expect(groupName(2)).toBe('C');
  });

  it('qualifiers: winners first, then runners-up, in group order', () => {
    const groups = [
      { group: 'B', ranked: ['b1', 'b2', 'b3'] },
      { group: 'A', ranked: ['a1', 'a2', 'a3'] },
    ];
    expect(qualifierSeeds(groups, 2)).toEqual(['a1', 'b1', 'a2', 'b2']);
    expect(qualifierSeeds(groups, 1)).toEqual(['a1', 'b1']);
    expect(qualifierSeeds([{ group: 'A', ranked: ['a1'] }, { group: 'B', ranked: ['b1', 'b2'] }], 2)).toEqual(['a1', 'b1', 'b2']); // a small group gives what it has
  });

  it('with standard seeding two groups cross over (1A-2B, 1B-2A) and four groups keep group-mates apart', () => {
    const two = buildBracket(qualifierSeeds([{ group: 'A', ranked: ['a1', 'a2'] }, { group: 'B', ranked: ['b1', 'b2'] }], 2));
    expect(two.matches.filter((m) => m.round === 1).map((m) => [m.entryA, m.entryB])).toEqual([['a1', 'b2'], ['b1', 'a2']]);
    const g = ['A', 'B', 'C', 'D'].map((group) => ({ group, ranked: [`${group}1`, `${group}2`] }));
    const four = buildBracket(qualifierSeeds(g, 2));
    for (const m of four.matches.filter((x) => x.round === 1)) expect(m.entryA![0]).not.toBe(m.entryB![0]);
  });
});
