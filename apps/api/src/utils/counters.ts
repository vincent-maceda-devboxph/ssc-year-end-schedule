import { Tournament } from '../models/index.js';

type Counter = 'nextMatchNumber' | 'nextScheduleVersion';

/**
 * Reserve `count` numbers from a tournament's counter and return the first one. Tournaments created
 * before a counter existed have no such field, so it is filled in with 1 first; otherwise the first
 * number would come back undefined.
 */
export async function reserveNumbers(tournamentId: unknown, field: Counter, count = 1): Promise<number> {
  await Tournament.updateOne({ _id: tournamentId, [field]: { $not: { $type: 'number' } } }, { $set: { [field]: 1 } });
  const t = await Tournament.findByIdAndUpdate(tournamentId, { $inc: { [field]: count } }).select(field).lean();
  return (t as Record<string, number> | null)?.[field] ?? 1;
}
