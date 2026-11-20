import path from 'node:path';
import { Readable } from 'node:stream';
import ExcelJS from 'exceljs';
import type { LineupRow } from '@bt/shared';
import { AppError, badRequest } from '../../utils/errors.js';

export interface ParsedLineupFile {
  rows: LineupRow[];
  /** 1-based sheet row numbers that were ignored because they had fewer than Team, Division and Player 1. */
  skipped: number[];
  /** Name of the worksheet that was read (Excel) or "CSV". */
  source: string;
}

const MAX_ROWS = 2000;

/** Pick the separator a text file uses: comma, semicolon or tab (European Excel saves semicolons). */
function detectDelimiter(text: string): string {
  const first = text.split(/\r?\n/).find((l) => l.trim()) ?? '';
  const counts: [string, number][] = [',', ';', '\t'].map((d) => [d, first.split(d).length - 1]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0]![1] > 0 ? counts[0]![0] : ',';
}

/**
 * Read a .xlsx or .csv file with the columns Team, Division, Player 1, Player 2 (Player 2 empty for
 * singles). A header row is skipped. Only reads; the rows still go through "Check" and "Import".
 */
export async function parseLineupFile(buffer: Buffer, filename: string): Promise<ParsedLineupFile> {
  const ext = path.extname(filename).toLowerCase();
  const wb = new ExcelJS.Workbook();
  let ws: ExcelJS.Worksheet | undefined;
  let source = 'CSV';
  try {
    if (ext === '.xlsx') {
      await wb.xlsx.load(buffer as unknown as ArrayBuffer);
      ws = wb.worksheets.find((s) => s.actualRowCount > 0);
      source = ws?.name ?? 'Excel';
    } else if (ext === '.csv' || ext === '.txt' || ext === '.tsv') {
      const text = buffer.toString('utf8').replace(/^﻿/, '');
      ws = await wb.csv.read(Readable.from([Buffer.from(text, 'utf8')]), { parserOptions: { delimiter: detectDelimiter(text) } });
    } else {
      throw new AppError(415, 'unsupported_file', 'Use an Excel (.xlsx) or CSV (.csv) file. Older .xls files: save as .xlsx first.');
    }
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw badRequest('That file could not be read. Is it a real .xlsx or .csv file?');
  }
  if (!ws) throw badRequest('The file has no data.');

  const rows: LineupRow[] = [];
  const skipped: number[] = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const cells = [1, 2, 3, 4].map((c) => row.getCell(c).text.trim());
    if (cells.every((c) => !c)) return;
    if (rowNumber === 1 && /^team$/i.test(cells[0]!)) return; // header
    const [team, category, player1, player2] = cells as [string, string, string, string];
    if (!team || !category || !player1) {
      skipped.push(rowNumber);
      return;
    }
    rows.push({ team, category, player1, player2 });
  });
  if (rows.length > MAX_ROWS) throw badRequest(`Too many rows (${rows.length}). The most that can be imported at once is ${MAX_ROWS}.`);
  return { rows, skipped, source };
}
