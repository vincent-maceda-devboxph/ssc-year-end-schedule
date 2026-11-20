import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import mongoose from 'mongoose';
import { config } from '../../config.js';
import { AppError, badRequest, conflict, notFound, unprocessable } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { checkIntegrity, type IntegrityIssue } from './integrity.service.js';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const { EJSON } = mongoose.mongo.BSON;

const FORMAT = 'badminton-tournament-backup';
const VERSION = 1;
export type BackupKind = 'manual' | 'auto' | 'before-restore';

export interface BackupInfo {
  file: string;
  bytes: number;
  createdAt: string;
  kind: BackupKind;
  label: string;
}

const FILE_RE = /^backup-(\d{8}-\d{6})-(manual|auto|before-restore)(?:-([a-z0-9-]{1,40}))?\.json\.gz$/;

const stamp = (d: Date) =>
  `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}-${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}${String(d.getUTCSeconds()).padStart(2, '0')}`;
const fromStamp = (s: string) => new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`);

const models = () => Object.values(mongoose.models);

/** Cheap "has anything changed?" marker: document counts plus the newest timestamp per collection. */
export async function fingerprint(): Promise<string> {
  const parts: string[] = [];
  for (const m of models()) {
    const [r] = await m.collection.aggregate([{ $group: { _id: null, n: { $sum: 1 }, u: { $max: '$updatedAt' }, c: { $max: '$createdAt' } } }]).toArray();
    parts.push(`${m.collection.name}:${r?.n ?? 0}:${r?.u?.getTime?.() ?? 0}:${r?.c?.getTime?.() ?? 0}`);
  }
  return parts.sort().join('|');
}

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

function safeFile(name: string): string {
  if (!FILE_RE.test(name)) throw badRequest('Not a backup file name');
  return name;
}

/** Writes every collection to one compressed file (and a copy to the mirror folder, e.g. a USB stick). */
export async function createBackup(kind: BackupKind, label = ''): Promise<BackupInfo & { mirror: { ok: boolean; dir: string; error?: string } | null }> {
  const now = new Date();
  const cleanLabel = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  const file = `backup-${stamp(now)}-${kind}${cleanLabel ? `-${cleanLabel}` : ''}.json.gz`;

  const collections: Record<string, unknown[]> = {};
  const counts: Record<string, number> = {};
  for (const m of models()) {
    const docs = await m.collection.find({}).toArray();
    collections[m.collection.name] = docs;
    counts[m.collection.name] = docs.length;
  }
  // Header as plain JSON (so it can be checked without special parsing); documents in exact BSON form (ids, dates, number types).
  const payload = JSON.stringify({ format: FORMAT, version: VERSION, createdAt: now.toISOString(), kind, label: cleanLabel, counts, collections: EJSON.serialize(collections, { relaxed: false }) });
  const buffer = await gzip(Buffer.from(payload, 'utf8'));

  await ensureDir(config.backupDir);
  // Write to a temp name first so a crash never leaves a half-written file that looks like a backup.
  const target = path.join(config.backupDir, file);
  await fs.writeFile(`${target}.tmp`, buffer);
  await fs.rename(`${target}.tmp`, target);

  let mirror: { ok: boolean; dir: string; error?: string } | null = null;
  if (config.backupMirrorDir) {
    try {
      await ensureDir(config.backupMirrorDir);
      await fs.copyFile(target, path.join(config.backupMirrorDir, file));
      mirror = { ok: true, dir: config.backupMirrorDir };
    } catch (e) {
      mirror = { ok: false, dir: config.backupMirrorDir, error: (e as Error).message };
      logger.warn({ err: e }, 'Backup mirror copy failed');
    }
  }
  return { file, bytes: buffer.length, createdAt: now.toISOString(), kind, label: cleanLabel, mirror };
}

export async function listBackups(): Promise<BackupInfo[]> {
  let names: string[] = [];
  try {
    names = await fs.readdir(config.backupDir);
  } catch {
    return [];
  }
  const out: BackupInfo[] = [];
  for (const name of names) {
    const m = FILE_RE.exec(name);
    if (!m) continue;
    const st = await fs.stat(path.join(config.backupDir, name));
    out.push({ file: name, bytes: st.size, createdAt: fromStamp(m[1]!).toISOString(), kind: m[2] as BackupKind, label: m[3] ?? '' });
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.file.localeCompare(a.file));
}

export function backupPath(file: string): string {
  return path.join(config.backupDir, safeFile(file));
}

export async function readBackup(file: string): Promise<{ meta: { createdAt: string; kind: string; label: string; counts: Record<string, number> }; collections: Record<string, Record<string, unknown>[]> }> {
  let raw: Buffer;
  try {
    raw = await fs.readFile(backupPath(file));
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw notFound('Backup file');
  }
  let data: Record<string, unknown>;
  try {
    data = JSON.parse((await gunzip(raw)).toString('utf8')) as Record<string, unknown>;
  } catch {
    throw unprocessable('This file is damaged or is not a backup made by this program.', 'bad_backup');
  }
  if (data.format !== FORMAT || data.version !== VERSION || typeof data.collections !== 'object' || !data.collections) {
    throw unprocessable('This file is not a backup made by this program.', 'bad_backup');
  }
  return {
    meta: { createdAt: String(data.createdAt), kind: String(data.kind), label: String(data.label ?? ''), counts: (data.counts as Record<string, number>) ?? {} },
    collections: EJSON.deserialize(data.collections as Record<string, unknown>, { relaxed: false }) as Record<string, Record<string, unknown>[]>,
  };
}

let restoring = false;

export interface RestoreResult {
  restoredFrom: string;
  safetyBackup: string;
  counts: Record<string, number>;
  tournamentIds: string[];
  integrity: IntegrityIssue[];
}

/**
 * Replace the whole database with a backup. A safety backup of the current data is written first and
 * used to roll back automatically if anything fails half-way.
 */
export async function restoreBackup(file: string, opts: { force: boolean }): Promise<RestoreResult> {
  if (restoring) throw conflict('A restore is already running', 'restore_running');
  const backup = await readBackup(file); // validates the file before anything is touched

  const live = await mongoose.models.Match!.countDocuments({ status: { $in: ['in_progress', 'paused', 'awaiting_confirmation'] } });
  if (live && !opts.force) {
    throw conflict(`${live} match(es) are being played right now. Restoring would wipe their scores. Finish them first, or confirm that you want to restore anyway.`, 'matches_live');
  }

  restoring = true;
  const safety = await createBackup('before-restore', `before-${file.slice(7, 22)}`);
  try {
    await applyCollections(backup.collections);
  } catch (e) {
    logger.error({ err: e }, 'Restore failed; rolling back to the safety backup');
    try {
      await applyCollections((await readBackup(safety.file)).collections);
    } catch (e2) {
      logger.fatal({ err: e2 }, 'Rollback after a failed restore also failed. Use the files in the backups folder.');
    }
    throw new AppError(500, 'restore_failed', 'The restore failed, and the data was rolled back to how it was. Nothing was lost.');
  } finally {
    restoring = false;
  }

  const counts: Record<string, number> = {};
  for (const m of models()) counts[m.collection.name] = await m.collection.countDocuments();
  const tournamentIds = (await mongoose.models.Tournament!.find().select('_id').lean()).map((t) => String(t._id));
  return { restoredFrom: file, safetyBackup: safety.file, counts, tournamentIds, integrity: await checkIntegrity() };
}

async function applyCollections(collections: Record<string, Record<string, unknown>[]>) {
  for (const m of models()) {
    await m.collection.deleteMany({});
    const docs = collections[m.collection.name] ?? [];
    // Raw insert keeps ids and timestamps exactly as they were.
    for (let i = 0; i < docs.length; i += 500) await m.collection.insertMany(docs.slice(i, i + 500) as never, { ordered: true });
  }
  await Promise.all(models().map((m) => m.syncIndexes()));
}

// ------------------------------------------------------------------ automatic backups
let timer: NodeJS.Timeout | null = null;
let soon: NodeJS.Timeout | null = null;
let lastFingerprint = '';
let lastAuto: { at: string; file: string } | null = null;
let lastError: string | null = null;

export async function autoBackupNow(): Promise<BackupInfo | null> {
  try {
    const fp = await fingerprint();
    if (fp === lastFingerprint) return null; // nothing changed since the last backup
    const info = await createBackup('auto');
    lastFingerprint = fp;
    lastAuto = { at: info.createdAt, file: info.file };
    lastError = info.mirror && !info.mirror.ok ? `Copy to ${info.mirror.dir} failed: ${info.mirror.error}` : null;
    await pruneAuto();
    return info;
  } catch (e) {
    lastError = (e as Error).message;
    logger.error({ err: e }, 'Automatic backup failed');
    return null;
  }
}

async function pruneAuto() {
  const autos = (await listBackups()).filter((b) => b.kind === 'auto');
  for (const old of autos.slice(config.backupKeepAuto)) {
    await fs.rm(path.join(config.backupDir, old.file), { force: true });
    if (config.backupMirrorDir) await fs.rm(path.join(config.backupMirrorDir, old.file), { force: true });
  }
}

/** Start the periodic backup (also one shortly after start). Not started in tests. */
export function startAutoBackups() {
  if (config.backupEveryMinutes <= 0 || timer) return;
  setTimeout(() => void autoBackupNow(), 5_000).unref();
  timer = setInterval(() => void autoBackupNow(), config.backupEveryMinutes * 60_000);
  timer.unref();
}

export function stopAutoBackups() {
  if (timer) clearInterval(timer);
  if (soon) clearTimeout(soon);
  timer = null;
  soon = null;
}

/** Called after results are saved: a backup follows within seconds, not at the next interval. */
export function requestBackupSoon() {
  if (!timer || soon) return;
  soon = setTimeout(() => {
    soon = null;
    void autoBackupNow();
  }, 15_000);
  soon.unref();
}

export function backupStatus() {
  return {
    dir: config.backupDir,
    mirrorDir: config.backupMirrorDir || null,
    everyMinutes: config.backupEveryMinutes,
    keepAuto: config.backupKeepAuto,
    running: !!timer,
    lastAuto,
    lastError,
  };
}
