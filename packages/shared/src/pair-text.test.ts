import { describe, expect, it } from 'vitest';
import { parsePairsText } from './pair-text.js';

const names = (t: string, singles = false) => parsePairsText(t, { singles }).pairs.map((p) => [p.player1, p.player2]);

describe('parsePairsText', () => {
  it('reads common separators', () => {
    expect(names('Ana / Bea\nCy & Di\nEli + Fay\nGus and Hal\nIvy - Jo\nKai, Lu\nMia\tNoa\nOwen | Pam')).toEqual([
      ['Ana', 'Bea'], ['Cy', 'Di'], ['Eli', 'Fay'], ['Gus', 'Hal'], ['Ivy', 'Jo'], ['Kai', 'Lu'], ['Mia', 'Noa'], ['Owen', 'Pam'],
    ]);
  });

  it('keeps full names and strips numbering and labels, keeping line order', () => {
    expect(names('1. Juan Dela Cruz / Pedro Santos\n2) Mark Lee - Joe Tan\nMD-B: Ben Ong & Carl Uy\n#4 Al Ray / Bo Sy')).toEqual([
      ['Juan Dela Cruz', 'Pedro Santos'], ['Mark Lee', 'Joe Tan'], ['Ben Ong', 'Carl Uy'], ['Al Ray', 'Bo Sy'],
    ]);
  });

  it('prefers the strongest separator so hyphenated names survive', () => {
    expect(names('Jean-Luc Picard / Anne-Marie Roy')).toEqual([['Jean-Luc Picard', 'Anne-Marie Roy']]);
  });

  it('skips blank lines but reports bad ones with their line numbers', () => {
    const r = parsePairsText('Ana / Bea\n\nJustOne\nA / B / C', { singles: false });
    expect(r.pairs).toHaveLength(1);
    expect(r.problems.map((p) => p.line)).toEqual([3, 4]);
  });

  it('singles take one name per line', () => {
    expect(names('1. Ana\nBea\n\nCy', true)).toEqual([['Ana', ''], ['Bea', ''], ['Cy', '']]);
  });
});
