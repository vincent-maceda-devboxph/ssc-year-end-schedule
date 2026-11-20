import type { MatchDto } from '@bt/shared';

/** One scheduled match, ready to draw. */
export interface ImageEntry {
  slot: number;
  /** "9:00 – 9:30 AM" */
  time: string;
  courtId: string;
  courtName: string;
  gameNumber: number;
  match: MatchDto;
}

export interface ScheduleImageInput {
  title: string;
  subtitle: string;
  courts: { id: string; name: string }[];
  /** Every slot row in order, with its time label. */
  rows: { slot: number; label: string }[];
  entries: ImageEntry[];
  /** Draw only this court as a list; null = every court as a grid. */
  courtId: string | null;
}

const FONT = 'Roboto, "Segoe UI", Arial, sans-serif';
const INK = '#0f172a';
const MUTED = '#64748b';
const LINE = '#e2e8f0';
const BRAND = '#0f766e';

function ellipsize(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + '…').width > maxWidth) t = t.slice(0, -1);
  return t + '…';
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const loadImage = (src: string) =>
  new Promise<HTMLImageElement | null>((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });

/** Team colour square, or the team's logo when it has one. */
function drawTeamMark(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, color: string, logo: HTMLImageElement | null | undefined) {
  if (logo) {
    ctx.save();
    roundRect(ctx, x, y, size, size, size * 0.22);
    ctx.clip();
    ctx.fillStyle = '#fff';
    ctx.fillRect(x, y, size, size);
    const s = Math.min(size / logo.width, size / logo.height);
    ctx.drawImage(logo, x + (size - logo.width * s) / 2, y + (size - logo.height * s) / 2, logo.width * s, logo.height * s);
    ctx.restore();
    ctx.strokeStyle = 'rgba(0,0,0,.12)';
    roundRect(ctx, x, y, size, size, size * 0.22);
    ctx.stroke();
  } else {
    ctx.fillStyle = color;
    roundRect(ctx, x, y, size, size, size * 0.22);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,.12)';
    ctx.stroke();
  }
}

/** Draw a clean, printable schedule and return it as a PNG. */
export async function renderScheduleImage(input: ScheduleImageInput): Promise<Blob> {
  const logos = new Map<string, HTMLImageElement | null>();
  for (const e of input.entries) {
    for (const t of [e.match.teamA, e.match.teamB]) {
      if (t?.logoUrl && !logos.has(t.logoUrl)) logos.set(t.logoUrl, await loadImage(t.logoUrl));
    }
  }
  const logoOf = (t: MatchDto['teamA']) => (t?.logoUrl ? logos.get(t.logoUrl) : null);

  const scale = 2;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser cannot draw images');

  const single = input.courtId ? input.courts.find((c) => c.id === input.courtId) : null;
  const entries = input.entries.filter((e) => !single || e.courtId === single.id).sort((a, b) => a.slot - b.slot || a.gameNumber - b.gameNumber);

  // ---------- layout ----------
  const pad = 28;
  const titleH = 92;
  let width: number;
  let height: number;
  const timeW = 150;
  const colW = 330;
  const gap = 10;
  const courtHeadH = 46;
  const rowH = 112;
  const listRowH = 84;

  if (single) {
    width = 760;
    height = titleH + courtHeadH + entries.length * listRowH + pad * 2;
  } else {
    const cols = input.courts.length;
    width = pad * 2 + timeW + cols * (colW + gap);
    height = titleH + courtHeadH + input.rows.length * (rowH + gap) + pad * 2;
  }
  canvas.width = width * scale;
  canvas.height = Math.max(height, 200) * scale;
  ctx.scale(scale, scale);

  // ---------- background and title ----------
  ctx.fillStyle = '#f4f7fb';
  ctx.fillRect(0, 0, width, height);
  const grad = ctx.createLinearGradient(0, 0, width, 0);
  grad.addColorStop(0, '#0f766e');
  grad.addColorStop(0.55, '#0e7490');
  grad.addColorStop(1, '#1d4ed8');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, titleH);
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'alphabetic';
  ctx.font = `800 30px ${FONT}`;
  ctx.fillText(ellipsize(ctx, input.title, width - pad * 2), pad, 44);
  ctx.font = `600 16px ${FONT}`;
  ctx.globalAlpha = 0.92;
  const sub = [single ? `${single.name} schedule` : 'Schedule · all courts', input.subtitle].filter(Boolean).join('   ·   ');
  ctx.fillText(ellipsize(ctx, sub, width - pad * 2), pad, 72);
  ctx.globalAlpha = 1;

  /** A small "vs" between the two pairs, centred under the first pair's colour square. */
  const drawVs = (cx: number, baseline: number) => {
    ctx.fillStyle = MUTED;
    ctx.font = `700 10px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText('VS', cx, baseline);
    ctx.textAlign = 'left';
  };

  const drawSide = (m: MatchDto, side: 'A' | 'B', x: number, y: number, w: number, h: number) => {
    const team = side === 'A' ? m.teamA : m.teamB;
    const entry = side === 'A' ? m.entryA : m.entryB;
    const mark = 26;
    drawTeamMark(ctx, x, y + (h - mark) / 2, mark, team?.color ?? '#e2e8f0', logoOf(team));
    ctx.fillStyle = INK;
    ctx.font = `${m.winner === side ? 800 : 600} 17px ${FONT}`;
    ctx.fillText(ellipsize(ctx, entry.name, w - mark - 12), x + mark + 10, team ? y + h / 2 - 1 : y + h / 2 + 6);
    if (team) {
      ctx.fillStyle = MUTED;
      ctx.font = `500 12px ${FONT}`;
      ctx.fillText(ellipsize(ctx, team.name, w - mark - 12), x + mark + 10, y + h / 2 + 14);
    }
  };

  if (single) {
    // ---------- one court: a readable list ----------
    let y = titleH + 14;
    ctx.fillStyle = MUTED;
    ctx.font = `700 12px ${FONT}`;
    ctx.fillText('TIME', pad, y + 18);
    ctx.fillText('PAIRS', pad + 170, y + 18);
    y += courtHeadH - 14;
    for (const e of entries) {
      roundRect(ctx, pad, y + 4, width - pad * 2, listRowH - 8, 14);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.strokeStyle = LINE;
      ctx.stroke();
      ctx.fillStyle = BRAND;
      ctx.font = `800 20px ${FONT}`;
      ctx.fillText(e.time.split(' – ')[0] ?? e.time, pad + 16, y + 38);
      ctx.fillStyle = MUTED;
      ctx.font = `600 13px ${FONT}`;
      ctx.fillText(`Game ${e.gameNumber}`, pad + 16, y + 58);
      ctx.fillText(e.match.bracket, pad + 16, y + 74);
      // The two pairs stacked, so a short name is never stranded far from its opponent.
      const px = pad + 170;
      const pw = width - px - pad - 16;
      drawSide(e.match, 'A', px, y + 6, pw, 36);
      drawSide(e.match, 'B', px, y + 44, pw, 36);
      ctx.strokeStyle = LINE;
      ctx.beginPath();
      ctx.moveTo(px + 40, y + 42);
      ctx.lineTo(px + pw, y + 42);
      ctx.stroke();
      drawVs(px + 13, y + 46);
      y += listRowH;
    }
    if (!entries.length) {
      ctx.fillStyle = MUTED;
      ctx.font = `500 16px ${FONT}`;
      ctx.fillText('No matches scheduled on this court.', pad, y + 30);
    }
  } else {
    // ---------- all courts: time rows × court columns ----------
    const top = titleH + 14;
    ctx.font = `800 18px ${FONT}`;
    input.courts.forEach((c, i) => {
      const x = pad + timeW + i * (colW + gap);
      roundRect(ctx, x, top, colW, courtHeadH - 8, 12);
      ctx.fillStyle = BRAND;
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.fillText(c.name, x + colW / 2, top + 24);
      ctx.textAlign = 'left';
    });
    const byCell = new Map(entries.map((e) => [`${e.slot}:${e.courtId}`, e]));
    input.rows.forEach((row, ri) => {
      const y = top + courtHeadH + ri * (rowH + gap);
      ctx.fillStyle = INK;
      ctx.font = `800 17px ${FONT}`;
      const [from, to] = row.label.split(' – ');
      ctx.fillText(from ?? row.label, pad, y + 40);
      if (to) {
        ctx.fillStyle = MUTED;
        ctx.font = `500 13px ${FONT}`;
        ctx.fillText(`to ${to}`, pad, y + 60);
      }
      input.courts.forEach((c, i) => {
        const x = pad + timeW + i * (colW + gap);
        const e = byCell.get(`${row.slot}:${c.id}`);
        roundRect(ctx, x, y, colW, rowH, 14);
        if (!e) {
          ctx.setLineDash([6, 5]);
          ctx.strokeStyle = LINE;
          ctx.stroke();
          ctx.setLineDash([]);
          return;
        }
        ctx.fillStyle = '#fff';
        ctx.fill();
        ctx.strokeStyle = LINE;
        ctx.stroke();
        ctx.fillStyle = BRAND;
        ctx.font = `800 14px ${FONT}`;
        ctx.fillText(`#${e.gameNumber}`, x + 14, y + 22);
        ctx.fillStyle = MUTED;
        ctx.font = `600 13px ${FONT}`;
        ctx.fillText(ellipsize(ctx, e.match.bracket, colW - 90), x + 14 + ctx.measureText(`#${e.gameNumber}`).width + 14, y + 22);
        ctx.strokeStyle = LINE;
        ctx.beginPath();
        ctx.moveTo(x + 10, y + 32);
        ctx.lineTo(x + colW - 10, y + 32);
        ctx.stroke();
        drawSide(e.match, 'A', x + 14, y + 34, colW - 28, 36);
        drawSide(e.match, 'B', x + 14, y + 70, colW - 28, 36);
        drawVs(x + 14 + 13, y + 73);
      });
    });
  }

  // footer stamp
  ctx.fillStyle = MUTED;
  ctx.font = `500 11px ${FONT}`;
  ctx.textAlign = 'right';
  ctx.fillText(`Made ${new Date().toLocaleString()}`, width - pad, height - 10);
  ctx.textAlign = 'left';

  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not create the image'))), 'image/png'));
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
