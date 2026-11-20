import ExcelJS from 'exceljs';
import { formatGames } from '@bt/shared';
import { Match, Tournament } from '../../models/index.js';
import { notFound } from '../../utils/errors.js';
import { currentSchedule } from './schedule.service.js';

const BORDER: Partial<ExcelJS.Borders> = {
  top: { style: 'thin' },
  left: { style: 'thin' },
  bottom: { style: 'thin' },
  right: { style: 'thin' },
};

/** "#c6efce" → ExcelJS fill. Anything that is not a 6-digit hex colour gets no fill. */
const fill = (hex: string | null | undefined): ExcelJS.Fill | undefined =>
  hex && /^#[0-9a-f]{6}$/i.test(hex) ? { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${hex.slice(1).toUpperCase()}` } } : undefined;

function clock(iso: string | null, tz: string): string {
  if (!iso) return '';
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(iso)).replace(' ', '');
}

const COLS_PER_BLOCK = 7; // Time, Game #, Category/Bracket, Team 1, Pair 1, Team 2, Pair 2
const WIDTHS = [19, 7, 12, 19, 22, 19, 22];

/**
 * Court-by-court workbook like the reference sheet: one block per court, two blocks side by side,
 * each row = Time | Game # | Category/Bracket | Team 1 | Pair 1 | Team 2 | Pair 2, filled with the
 * team colours. A second sheet lists every match in one table (filterable).
 */
export async function buildScheduleWorkbook(tournamentId: string): Promise<{ buffer: Buffer; filename: string }> {
  const t = await Tournament.findById(tournamentId).select('name').lean();
  if (!t) throw notFound('Tournament');
  const view = await currentSchedule(tournamentId);
  const tz = view.settings.timezone;
  const scores = new Map(
    (await Match.find({ tournamentId }).select('score.games winner').lean()).map((m) => [String(m._id), (m.score as { games?: { a: number; b: number; winner: 'A' | 'B' | null }[] } | undefined)?.games ?? []]),
  );

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Badminton Tournament';
  wb.created = new Date();

  // ------------------------------------------------------------ sheet 1: court blocks
  const ws = wb.addWorksheet('Schedule', { pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 } });
  const gap = 1;
  const totalCols = COLS_PER_BLOCK * 2 + gap;
  for (let c = 1; c <= totalCols; c++) {
    const inBlock = c <= COLS_PER_BLOCK ? c - 1 : c - COLS_PER_BLOCK - gap - 1;
    ws.getColumn(c).width = c === COLS_PER_BLOCK + 1 ? 3 : WIDTHS[inBlock] ?? 12;
  }

  const byCourt = view.courts
    .map((c) => ({ court: c, matches: view.matches.filter((m) => m.courtId === c.id && m.start).sort((a, b) => a.start!.localeCompare(b.start!)) }))
    .filter((x) => x.court.active || x.matches.length);

  let row = 1;
  for (let i = 0; i < byCourt.length; i += 2) {
    const group = byCourt.slice(i, i + 2);
    const height = Math.max(...group.map((g) => g.matches.length));
    group.forEach((g, side) => {
      const c0 = side === 0 ? 1 : COLS_PER_BLOCK + gap + 1; // first column of this block
      // Title
      ws.mergeCells(row, c0, row, c0 + COLS_PER_BLOCK - 1);
      const title = ws.getCell(row, c0);
      title.value = g.court.name;
      title.font = { bold: true, size: 13 };
      title.alignment = { horizontal: 'center' };
      for (let k = 0; k < COLS_PER_BLOCK; k++) ws.getCell(row, c0 + k).border = BORDER;
      // Header
      const head = ['Time', 'Game #', 'Category/Bracket', 'Team 1', '', 'Team 2', ''];
      head.forEach((h, k) => {
        const cell = ws.getCell(row + 1, c0 + k);
        cell.value = h || null;
        cell.font = { bold: true };
        cell.alignment = { horizontal: 'center' };
        cell.border = BORDER;
      });
      ws.mergeCells(row + 1, c0 + 3, row + 1, c0 + 4);
      ws.mergeCells(row + 1, c0 + 5, row + 1, c0 + 6);
      // Matches
      g.matches.forEach((m, r) => {
        const values = [`${clock(m.start, tz)} - ${clock(m.end, tz)}`, m.gameNumber, m.categoryName, m.teamA?.name ?? '', m.pairA, m.teamB?.name ?? '', m.pairB];
        values.forEach((v, k) => {
          const cell = ws.getCell(row + 2 + r, c0 + k);
          cell.value = v;
          cell.border = BORDER;
          cell.alignment = { horizontal: k < 3 ? 'center' : 'left', vertical: 'middle' };
          if (k >= 3) {
            const team = k <= 4 ? m.teamA : m.teamB;
            const f = fill(team?.color);
            if (f) cell.fill = f;
          }
        });
      });
    });
    row += height + 3; // title + header + rows + one blank line
  }
  if (!byCourt.length) ws.getCell(1, 1).value = 'No courts yet.';

  // ------------------------------------------------------------ sheet 2: every match
  const all = wb.addWorksheet('All matches', { views: [{ state: 'frozen', ySplit: 1 }] });
  all.columns = [
    { header: 'Game #', key: 'game', width: 8 },
    { header: 'Court', key: 'court', width: 11 },
    { header: 'Start', key: 'start', width: 12 },
    { header: 'End', key: 'end', width: 12 },
    { header: 'Category/Bracket', key: 'bracket', width: 16 },
    { header: 'Team 1', key: 't1', width: 20 },
    { header: 'Pair 1', key: 'p1', width: 24 },
    { header: 'Team 2', key: 't2', width: 20 },
    { header: 'Pair 2', key: 'p2', width: 24 },
    { header: 'Status', key: 'status', width: 16 },
    { header: 'Score', key: 'score', width: 18 },
    { header: 'Winner', key: 'winner', width: 24 },
    { header: 'Locked', key: 'locked', width: 8 },
  ];
  all.getRow(1).font = { bold: true };
  const courtName = new Map(view.courts.map((c) => [c.id, c.name]));
  const sorted = [...view.matches].sort((a, b) => (a.gameNumber ?? 1e9) - (b.gameNumber ?? 1e9) || a.matchNumber - b.matchNumber);
  for (const m of sorted) {
    const added = all.addRow({
      game: m.gameNumber ?? '',
      court: m.courtId ? courtName.get(m.courtId) ?? '' : '',
      start: clock(m.start, tz),
      end: clock(m.end, tz),
      bracket: m.categoryName,
      t1: m.teamA?.name ?? '',
      p1: m.pairA,
      t2: m.teamB?.name ?? '',
      p2: m.pairB,
      status: m.status.replace(/_/g, ' '),
      score: m.status === 'walkover' ? 'W/O' : formatGames(scores.get(m.id) ?? []),
      winner: m.winner === 'A' ? m.pairA : m.winner === 'B' ? m.pairB : '',
      locked: m.isLocked ? 'yes' : '',
    });
    for (const [col, team] of [[6, m.teamA], [7, m.teamA], [8, m.teamB], [9, m.teamB]] as const) {
      const f = fill(team?.color);
      if (f) added.getCell(col).fill = f;
    }
  }
  all.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 13 } };

  const slug = t.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'tournament';
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  return { buffer, filename: `schedule-${slug}.xlsx` };
}
