/**
 * Single-elimination brackets (pure, no database). Seeds go in the standard order so that 1 and 2
 * can only meet in the final, 1-4 in the semifinals, and so on. When the number of entries is not a
 * power of two the top seeds get byes. Group winners and runners-up are seeded so that players
 * from the same group meet as late as possible.
 */

/** Seed numbers in bracket order: [1,2] -> [1,4,2,3] -> [1,8,4,5,2,7,3,6] ... (1 meets `size`, 2 meets `size-1`, ...). */
export function seedOrder(size: number): number[] {
  if (size < 2 || (size & (size - 1)) !== 0) throw new Error('Bracket size must be a power of two, at least 2');
  let order = [1];
  while (order.length < size) {
    const n = order.length * 2;
    order = order.flatMap((s) => [s, n + 1 - s]);
  }
  return order;
}

export const roundLabel = (round: number, rounds: number): string => {
  const left = rounds - round;
  if (left === 0) return 'Final';
  if (left === 1) return 'Semifinal';
  if (left === 2) return 'Quarterfinal';
  return `Round of ${2 ** (left + 1)}`;
};

export interface PlannedBracketMatch {
  /** Stable key: "r<round>p<position>", or "third". */
  key: string;
  /** 1 = first round; the last round is the final. */
  round: number;
  /** Position within the round, top to bottom. */
  pos: number;
  roundLabel: string;
  /** Entry already known for each side (first-round entries, or a top seed that got a bye). */
  entryA: string | null;
  entryB: string | null;
  /** Otherwise the winner of this match goes into the side. */
  fromA: string | null;
  fromB: string | null;
  /** Third-place match: the LOSERS of these two semifinals play it. */
  third: boolean;
  loserFromA: string | null;
  loserFromB: string | null;
}

export interface BracketPlan {
  size: number;
  rounds: number;
  byes: number;
  matches: PlannedBracketMatch[];
}

type Node = { entry: string } | { match: string };

export function buildBracket(entryIds: readonly string[], opts: { thirdPlace?: boolean } = {}): BracketPlan {
  const n = entryIds.length;
  if (n < 2) throw new Error('A knockout needs at least 2 entries');
  if (new Set(entryIds).size !== n) throw new Error('The same entry appears twice');
  let size = 2;
  while (size < n) size *= 2;
  const rounds = Math.log2(size);
  const order = seedOrder(size);
  const matches: PlannedBracketMatch[] = [];
  const blank = { entryA: null, entryB: null, fromA: null, fromB: null, third: false, loserFromA: null, loserFromB: null };

  // Round 1: seeds beyond n are byes; their opponent moves straight to round 2.
  let nodes: Node[] = [];
  for (let p = 0; p < size / 2; p++) {
    const a = entryIds[order[2 * p]! - 1] ?? null;
    const b = entryIds[order[2 * p + 1]! - 1] ?? null;
    if (a && b) {
      const key = `r1p${p}`;
      matches.push({ ...blank, key, round: 1, pos: p, roundLabel: roundLabel(1, rounds), entryA: a, entryB: b });
      nodes.push({ match: key });
    } else nodes.push({ entry: (a ?? b)! });
  }

  // Later rounds: every pair of earlier winners plays a match.
  for (let r = 2; r <= rounds; r++) {
    const next: Node[] = [];
    for (let p = 0; p < nodes.length / 2; p++) {
      const x = nodes[2 * p]!;
      const y = nodes[2 * p + 1]!;
      const key = `r${r}p${p}`;
      matches.push({
        ...blank,
        key,
        round: r,
        pos: p,
        roundLabel: roundLabel(r, rounds),
        entryA: 'entry' in x ? x.entry : null,
        fromA: 'match' in x ? x.match : null,
        entryB: 'entry' in y ? y.entry : null,
        fromB: 'match' in y ? y.match : null,
      });
      next.push({ match: key });
    }
    nodes = next;
  }

  // Third place: only when both semifinals are real matches.
  if (opts.thirdPlace && rounds >= 2) {
    const semis = matches.filter((m) => m.round === rounds - 1);
    if (semis.length === 2) {
      matches.push({ ...blank, key: 'third', round: rounds, pos: 1, roundLabel: 'Third place', third: true, loserFromA: semis[0]!.key, loserFromB: semis[1]!.key });
    }
  }
  return { size, rounds, byes: size - n, matches };
}

/**
 * Seeds for a knockout that follows a group stage: all group winners (in group order), then all
 * runners-up, then third places ... With the standard seeding this pairs 1A-2B and 1B-2A for two
 * groups, and keeps group-mates apart as long as possible for more.
 */
export function qualifierSeeds(groups: readonly { group: string; ranked: readonly string[] }[], perGroup: number): string[] {
  const ordered = [...groups].sort((a, b) => a.group.localeCompare(b.group, undefined, { numeric: true }));
  const out: string[] = [];
  for (let place = 0; place < perGroup; place++) {
    for (const g of ordered) {
      const id = g.ranked[place];
      if (id) out.push(id);
    }
  }
  return out;
}

/** Spread entries over `count` groups in a snake: 1,2,3,3,2,1,1,2,3... so every group gets a similar mix of seeds. */
export function snakeGroups<T>(items: readonly T[], count: number): T[][] {
  const groups: T[][] = Array.from({ length: count }, () => []);
  items.forEach((item, i) => {
    const lap = Math.floor(i / count);
    const idx = i % count;
    groups[lap % 2 === 0 ? idx : count - 1 - idx]!.push(item);
  });
  return groups;
}

export const groupName = (index: number): string => String.fromCharCode(65 + index);
