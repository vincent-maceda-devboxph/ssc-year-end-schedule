import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { createApp } from './app.js';
import { config } from './config.js';
import { connectDb, disconnectDb, ensureSuperAdmin, loadJwtSecret } from './db.js';
import { AuthService } from './modules/auth/auth.service.js';
import { startAutoBackups, stopAutoBackups } from './modules/system/backup.service.js';
import { createSocketServer } from './sockets/index.js';
import { printBanner } from './utils/banner.js';
import { logger } from './utils/logger.js';
import { lanUrls } from './utils/network.js';

/** Plain HTTP by default; HTTPS when HTTPS_KEY and HTTPS_CERT point to a certificate (docs/deployment.md). */
function createHttpServer(): http.Server | https.Server {
  if (config.httpsKey && config.httpsCert) {
    return https.createServer({ key: fs.readFileSync(config.httpsKey), cert: fs.readFileSync(config.httpsCert) });
  }
  if (config.httpsKey || config.httpsCert) throw new Error('Set both HTTPS_KEY and HTTPS_CERT, or neither.');
  return http.createServer();
}

async function main() {
  await connectDb(config.mongoUri);
  await ensureSuperAdmin();
  const auth = new AuthService(await loadJwtSecret());

  const server = createHttpServer();
  const useHttps = server instanceof https.Server;
  const { io, broadcaster, presence } = createSocketServer(server, auth);
  server.on('request', createApp({ auth, broadcaster, presence }));

  server.listen(config.port, config.host, () => {
    startAutoBackups();
    const scheme = useHttps ? 'https' : 'http';
    const urls = lanUrls(config.port).map((u) => u.replace(/^http:/, `${scheme}:`));
    logger.info({ port: config.port, https: useHttps }, 'Badminton server running');
    void printBanner(urls, { https: useHttps, backupDir: config.backupDir, backupsOn: config.backupEveryMinutes > 0 });
  });
  server.on('error', (err: NodeJS.ErrnoException) => {
    logger.fatal({ err }, err.code === 'EADDRINUSE' ? `Port ${config.port} is already in use. Is the server already running?` : 'Server error');
    process.exit(1);
  });

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    logger.info({ signal }, 'Shutting down');
    stopAutoBackups();
    io.close();
    server.close();
    await disconnectDb().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start. Is MongoDB running on 127.0.0.1:27017?');
  process.exit(1);
});
