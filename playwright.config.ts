import os from 'node:os';
import path from 'node:path';
import { defineConfig } from '@playwright/test';

// A fresh database and backup folder for every run; the real tournament data is never touched.
const run = (process.env.E2E_RUN ??= String(Date.now()));
const PORT = 3210;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    channel: 'msedge', // the Edge that ships with Windows, so no browser download is needed
  },
  webServer: {
    command: 'node apps/api/dist/server.js',
    url: `http://127.0.0.1:${PORT}/api/health`,
    timeout: 60_000,
    reuseExistingServer: false,
    env: {
      PORT: String(PORT),
      HOST: '127.0.0.1',
      MONGO_URI: `mongodb://127.0.0.1:27017/badminton_e2e_${run}`,
      ADMIN_PASSWORD: 'e2e-admin-password',
      BACKUP_DIR: path.join(os.tmpdir(), `bt-e2e-${run}`),
      BACKUP_EVERY_MINUTES: '0',
      LOG_LEVEL: 'warn',
    },
  },
});
