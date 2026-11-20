import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const config = {
  port: Number(process.env.PORT ?? 3000),
  /** 0.0.0.0 so phones on the venue Wi-Fi can reach the server. */
  host: process.env.HOST ?? '0.0.0.0',
  /** MongoDB must stay bound to localhost (see docs/plan-review.md §7). */
  mongoUri: process.env.MONGO_URI ?? 'mongodb://127.0.0.1:27017/badminton',
  /** Built Angular app, served from the same origin as the API and Socket.IO. */
  webDist: process.env.WEB_DIST ?? path.resolve(here, '../../web/dist/web/browser'),
  adminSessionHours: 12,
  umpireSessionHours: 16,
  /** Umpire code lockout: this many failures per IP+court ... */
  umpireMaxAttempts: 5,
  /** ... blocks that IP for this court for this long. */
  umpireLockoutMs: 5 * 60 * 1000,
  adminMaxAttempts: 10,
  adminLockoutMs: 5 * 60 * 1000,
  logLevel: process.env.LOG_LEVEL ?? 'info',
  // Backups (read lazily so tests and deployments can set the environment late).
  /** auto | on | off: keep admin/umpire tools off the internet when shared through a tunnel (see middleware/public-guard.ts). */
  get publicReadonly(): 'auto' | 'on' | 'off' {
    const v = (process.env.PUBLIC_READONLY ?? 'auto').toLowerCase();
    return v === 'on' || v === 'off' ? v : 'auto';
  },
  get backupDir() { return process.env.BACKUP_DIR ?? path.resolve(here, '../../../backups'); },
  /** Second copy of every backup, e.g. a USB stick: BACKUP_MIRROR_DIR=E:\\badminton-backups */
  get backupMirrorDir() { return process.env.BACKUP_MIRROR_DIR ?? ''; },
  get backupEveryMinutes() { return Number(process.env.BACKUP_EVERY_MINUTES ?? 10); },
  get backupKeepAuto() { return Number(process.env.BACKUP_KEEP_AUTO ?? 48); },
  /** Optional HTTPS: paths to a certificate and key (see docs/deployment.md). */
  get httpsKey() { return process.env.HTTPS_KEY ?? ''; },
  get httpsCert() { return process.env.HTTPS_CERT ?? ''; },
};
