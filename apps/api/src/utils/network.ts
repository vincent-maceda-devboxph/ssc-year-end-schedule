import os from 'node:os';

/** LAN URLs other devices can use to reach this server (IPv4, non-internal). */
export function lanUrls(port: number): string[] {
  const urls: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const nic of list ?? []) {
      if (nic.family === 'IPv4' && !nic.internal) urls.push(`http://${nic.address}:${port}`);
    }
  }
  return urls.length ? urls : [`http://localhost:${port}`];
}
