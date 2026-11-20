/** Time helpers: schedule times are stored in UTC and shown in the tournament's timezone. */

const parts = (utcMs: number, tz: string) => {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const o: Record<string, number> = {};
  for (const p of f.formatToParts(new Date(utcMs))) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return o as Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', number>;
};

/** Offset of `tz` from UTC at that instant, in ms (e.g. Asia/Manila = +8h). */
function offsetMs(utcMs: number, tz: string): number {
  const p = parts(utcMs, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(utcMs / 1000) * 1000;
}

/** "2026-11-29T15:00" typed in a datetime-local field, read as wall time in `tz` → UTC ISO string. */
export function zonedInputToIso(local: string, tz: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local);
  if (!m) return null;
  const wall = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!);
  let utc = wall - offsetMs(wall, tz);
  utc = wall - offsetMs(utc, tz); // second pass handles DST boundaries
  return new Date(utc).toISOString();
}

/** UTC ISO string → value for a datetime-local field showing wall time in `tz`. */
export function isoToZonedInput(iso: string | null, tz: string): string {
  if (!iso) return '';
  const p = parts(Date.parse(iso), tz);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

export function formatTime(iso: string | null, tz: string): string {
  if (!iso) return '';
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
}

export function formatRange(startIso: string | null, endIso: string | null, tz: string): string {
  return startIso && endIso ? `${formatTime(startIso, tz)} – ${formatTime(endIso, tz)}` : '';
}

export function formatDateTime(iso: string | null, tz: string): string {
  if (!iso) return '';
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
}

/** For views that do not know the venue timezone (match cards): the viewer's own clock. */
export function formatLocalTime(iso: string | null): string {
  return iso ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
}
