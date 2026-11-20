export interface ParsedPairLine {
  /** 1-based line number in the pasted text (blank lines count). */
  line: number;
  player1: string;
  /** Empty for singles. */
  player2: string;
}

export interface ParsedPairs {
  pairs: ParsedPairLine[];
  /** Lines that could not be read (line number + why). */
  problems: { line: number; text: string; message: string }[];
}

/** "1.", "1)", "#1", "A:", "MD-A:", "MD1 -" at the start of a line are labels, not names. */
const LEADING_LABEL = /^\s*(?:#?\d{1,3}\s*[.):\-–]\s+|#?\d{1,3}\s+(?=\D)|(?:[A-Za-z]{1,3}\s*-\s*[A-Za-z]|[A-Za-z]{1,3}\s*\d{1,2})\s*[:)]\s*|[A-Ha-h]\s*[:)]\s+)/;

/** Separators between the two partners, strongest first. Tabs and pipes come from spreadsheets. */
const SPLITTERS: RegExp[] = [/\t+/, /\s*\|\s*/, /\s*\/\s*/, /\s*&\s*/, /\s*\+\s*/, /\s+and\s+/i, /\s+[-–—]\s+/, /\s*,\s*/, /\s*;\s*/];

const clean = (s: string) => s.replace(/\s+/g, ' ').replace(/^[\s"'(\[]+|[\s"')\]]+$/g, '').trim();

/**
 * Read pairs pasted from a chat, a document or a spreadsheet: one pair per line, the line order is
 * the rank (first line = pair A). Accepts "Ana / Bea", "Ana & Bea", "Ana + Bea", "Ana and Bea",
 * "Ana - Bea", "Ana, Bea", "Ana<TAB>Bea" and numbered or labelled lines ("1. Ana / Bea", "MD-A: Ana / Bea").
 * Singles take one name per line.
 */
export function parsePairsText(text: string, opts: { singles: boolean }): ParsedPairs {
  const out: ParsedPairs = { pairs: [], problems: [] };
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1;
    let s = raw.trim();
    if (!s) return;
    s = s.replace(LEADING_LABEL, '');
    if (!s.trim()) return;

    if (opts.singles) {
      const name = clean(s.split(/\t|\s*\|\s*/)[0]!);
      if (name) out.pairs.push({ line, player1: name, player2: '' });
      else out.problems.push({ line, text: raw, message: 'No name found' });
      return;
    }

    for (const sp of SPLITTERS) {
      const parts = s.split(sp).map(clean).filter(Boolean);
      if (parts.length === 2) {
        out.pairs.push({ line, player1: parts[0]!, player2: parts[1]! });
        return;
      }
      if (parts.length > 2) {
        out.problems.push({ line, text: raw, message: `Found ${parts.length} names; a pair has exactly two` });
        return;
      }
    }
    out.problems.push({ line, text: raw, message: 'Could not find two names (separate them with "/", "&", "and", "-" or a comma)' });
  });
  return out;
}
