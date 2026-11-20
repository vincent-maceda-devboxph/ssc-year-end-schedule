import QRCode from 'qrcode';

/**
 * Printed to the server console at start-up: the addresses phones should use, with a QR code that
 * opens the live scores. Plain text (not JSON logs) so it is readable at a glance on the laptop.
 */
export async function printBanner(urls: string[], opts: { https: boolean; backupDir: string; backupsOn: boolean }): Promise<void> {
  const line = '='.repeat(64);
  const out: string[] = ['', line, `  BADMINTON TOURNAMENT SERVER IS RUNNING${opts.https ? '  (HTTPS)' : ''}`, line];
  for (const u of urls) {
    out.push('', `  Address for this Wi-Fi:  ${u}`, `    Spectators  ${u}/live`, `    Umpires     ${u}/umpire`, `    Admin       ${u}/admin`);
  }
  const first = urls[0];
  if (first) {
    out.push('', '  Scan to open the live scores:', '');
    const qr = await QRCode.toString(`${first}/live`, { type: 'terminal', small: true });
    out.push(...qr.split('\n').map((l) => `  ${l}`));
  }
  out.push('', opts.backupsOn ? `  Backups: ${opts.backupDir}` : '  Backups: OFF (BACKUP_EVERY_MINUTES=0)', line, '');
  console.log(out.join('\n'));
}
