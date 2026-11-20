#!/usr/bin/env node
/**
 * Pre-flight check for the event laptop:  npm run doctor
 * Looks at everything that has to be true before umpires walk in: Node, the build, MongoDB, the
 * port, the Wi-Fi address, the Windows firewall, the backup folders and the disk. Read-only.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const PORT = Number(process.env.PORT ?? 3000);
const MONGO = process.env.MONGO_URI ?? 'mongodb://127.0.0.1:27017/badminton';
const BACKUP_DIR = process.env.BACKUP_DIR ?? path.join(root, 'backups');
const MIRROR = process.env.BACKUP_MIRROR_DIR ?? '';

let failures = 0;
let warnings = 0;
const show = (level, title, detail = '', fix = '') => {
  const tag = { ok: '  OK  ', warn: ' WARN ', fail: ' FAIL ' }[level];
  console.log(`[${tag}] ${title}${detail ? ` - ${detail}` : ''}`);
  if (fix && level !== 'ok') console.log(`         -> ${fix}`);
  if (level === 'fail') failures++;
  if (level === 'warn') warnings++;
};

console.log(`\nBadminton tournament: laptop check (port ${PORT})\n`);

// 1. Node
const major = Number(process.versions.node.split('.')[0]);
major >= 22 ? show('ok', 'Node.js', `v${process.versions.node}`) : show('fail', 'Node.js too old', `v${process.versions.node}`, 'Install Node.js 22 or newer from nodejs.org');

// 2. Build
const built = [
  ['apps/api/dist/server.js', 'server'],
  ['apps/web/dist/web/browser/index.html', 'web app'],
];
for (const [rel, what] of built) {
  fs.existsSync(path.join(root, rel)) ? show('ok', `Built ${what}`) : show('fail', `The ${what} is not built`, rel, 'Run:  npm run build');
}

// 3. MongoDB
try {
  const mongoose = require('mongoose');
  const conn = await mongoose.createConnection(MONGO, { serverSelectionTimeoutMS: 3000 }).asPromise();
  await conn.db.admin().ping();
  show('ok', 'MongoDB reachable', MONGO.replace(/\/\/.*@/, '//***@'));
  await conn.close();
  if (!/127\.0\.0\.1|localhost/.test(MONGO)) show('warn', 'MongoDB is not on this laptop', MONGO, 'Keep the database on 127.0.0.1 so phones can never reach it');
} catch (e) {
  show('fail', 'MongoDB is not reachable', e.message.split('\n')[0], 'Start the "MongoDB" service (Services app) or install MongoDB Community Server');
}

// 4. Port
const portState = await new Promise((resolve) => {
  const s = net.createServer();
  s.once('error', (err) => resolve(err.code === 'EADDRINUSE' ? 'busy' : `error ${err.code}`));
  s.once('listening', () => s.close(() => resolve('free')));
  s.listen(PORT, '0.0.0.0');
});
if (portState === 'free') show('ok', `Port ${PORT} is free`, 'the server is not running yet');
else if (portState === 'busy') {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(2500) });
    const body = await res.json();
    show(body.ok ? 'ok' : 'warn', `The tournament server is already running on port ${PORT}`, `database ${body.db}`);
  } catch {
    show('fail', `Port ${PORT} is used by another program`, '', 'Close it, or set another port:  set PORT=3001');
  }
} else show('warn', `Could not test port ${PORT}`, portState);

// 5. LAN address
const lan = Object.entries(os.networkInterfaces()).flatMap(([name, list]) => (list ?? []).filter((n) => n.family === 'IPv4' && !n.internal).map((n) => ({ name, address: n.address })));
if (!lan.length) show('fail', 'No network address found', '', 'Connect the laptop to the router (Ethernet is best)');
else for (const n of lan) {
  if (n.address.startsWith('169.254.')) show('warn', `${n.name}: ${n.address}`, 'no real address from the router', 'Check the cable or Wi-Fi');
  else show('ok', `Phones can use  http://${n.address}:${PORT}`, n.name);
}

// 6. Windows firewall + network profile (read-only)
if (process.platform === 'win32') {
  try {
    const out = execFileSync('netsh', ['advfirewall', 'firewall', 'show', 'rule', 'name=all', 'dir=in'], { encoding: 'utf8', timeout: 15000 });
    const blocks = out.split(/\r?\n\r?\n/);
    const hit = blocks.find((b) => /Enabled:\s+Yes/i.test(b) && /Action:\s+Allow/i.test(b) && new RegExp(`LocalPort:\\s+.*\\b${PORT}\\b`).test(b));
    hit
      ? show('ok', `Windows Firewall allows port ${PORT}`)
      : show('warn', `No firewall rule found for port ${PORT}`, 'phones may not be able to connect', 'Run as Administrator:  scripts\\windows\\open-firewall.ps1');
  } catch {
    show('warn', 'Could not read the Windows Firewall rules', '', 'Run this check from an Administrator terminal, or test from a phone');
  }
  try {
    const prof = execFileSync('powershell', ['-NoProfile', '-Command', 'Get-NetConnectionProfile | ForEach-Object { $_.InterfaceAlias + "|" + $_.NetworkCategory }'], { encoding: 'utf8', timeout: 15000 });
    for (const line of prof.split(/\r?\n/).filter(Boolean)) {
      const [alias, cat] = line.split('|');
      cat === 'Public' ? show('warn', `Network "${alias}" is set to Public`, 'Windows may block phones', 'Run as Administrator:  scripts\\windows\\make-network-private.ps1') : show('ok', `Network "${alias}" is ${cat}`);
    }
  } catch { /* optional */ }
}

// 7. Backups
function writable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `.write-test-${process.pid}`);
    fs.writeFileSync(f, 'x');
    fs.rmSync(f);
    return true;
  } catch {
    return false;
  }
}
writable(BACKUP_DIR) ? show('ok', 'Backup folder is writable', BACKUP_DIR) : show('fail', 'Cannot write to the backup folder', BACKUP_DIR, 'Pick another folder:  set BACKUP_DIR=D:\\badminton-backups');
if (MIRROR) writable(MIRROR) ? show('ok', 'Second backup copy (USB) is writable', MIRROR) : show('warn', 'The second backup folder is not available', MIRROR, 'Plug in the USB stick, or fix BACKUP_MIRROR_DIR');
else show('warn', 'No second backup copy', 'a laptop failure would take the backups with it', 'Plug in a USB stick and set  BACKUP_MIRROR_DIR=E:\\badminton-backups');

// 8. Disk
try {
  const st = fs.statfsSync(BACKUP_DIR);
  const gb = (st.bavail * st.bsize) / 1024 ** 3;
  gb >= 1 ? show('ok', 'Free disk space', `${gb.toFixed(1)} GB`) : show('warn', 'Low disk space', `${gb.toFixed(2)} GB`, 'Free some space before the event');
} catch { /* not supported */ }

// 9. HTTPS settings
const key = process.env.HTTPS_KEY;
const cert = process.env.HTTPS_CERT;
if (key || cert) {
  key && cert && fs.existsSync(key) && fs.existsSync(cert) ? show('ok', 'HTTPS certificate files found') : show('fail', 'HTTPS_KEY / HTTPS_CERT must both point to existing files', `${key ?? ''} ${cert ?? ''}`);
} else show('ok', 'HTTPS is off', 'plain HTTP on the venue Wi-Fi (see docs/deployment.md for the trade-off)');

console.log(`\n${failures ? `${failures} problem(s) to fix` : 'No blocking problems'}${warnings ? `, ${warnings} warning(s)` : ''}.\n`);
process.exit(failures ? 1 : 0);
