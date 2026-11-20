import fs from 'node:fs';
import path from 'node:path';
import cookieParser from 'cookie-parser';
import express, { type Express } from 'express';
import type { SystemInfo } from '@bt/shared';
import { config } from './config.js';
import { dbHealthy } from './db.js';
import { loadAuth, requireAdmin } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import type { AuthService } from './modules/auth/auth.service.js';
import { categoryRoutes } from './modules/categories/categories.routes.js';
import { courtRoutes } from './modules/courts/courts.routes.js';
import { entryRoutes } from './modules/entries/entries.routes.js';
import { matchRoutes, umpireRoutes } from './modules/matches/matches.routes.js';
import { playerRoutes } from './modules/players/players.routes.js';
import { auditRoutes, systemRoutes } from './modules/system/system.routes.js';
import { userRoutes } from './modules/users/users.routes.js';
import { tournamentRoutes } from './modules/tournaments/tournaments.routes.js';
import { tournamentScopedRoutes } from './modules/tournaments/tournament-scoped.routes.js';
import { teamRoutes } from './modules/teams/teams.routes.js';
import type { Broadcaster, Presence } from './sockets/index.js';
import { lanUrls } from './utils/network.js';
import { publicGuard } from './middleware/public-guard.js';

export interface AppDeps {
  auth: AuthService;
  broadcaster: Broadcaster;
  presence: Presence;
  /** Serve the built Angular app (production). */
  serveWeb?: boolean;
}

export function createApp({ auth, broadcaster, presence, serveWeb = true }: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);

  app.use(publicGuard(config.publicReadonly));
  app.use(express.json({ limit: '200kb' }));
  app.use(cookieParser());
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });

  const api = express.Router();
  api.get('/health', (_req, res) => {
    const ok = dbHealthy();
    res.status(ok ? 200 : 503).json({ ok, db: ok ? 'up' : 'down' });
  });
  api.use(loadAuth(auth));
  api.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  api.use('/auth', authRoutes(auth));
  api.use('/tournaments', tournamentRoutes());
  api.use('/tournaments/:id', tournamentScopedRoutes(broadcaster));
  api.use('/teams', teamRoutes());
  api.use('/categories', categoryRoutes(broadcaster));
  api.use('/players', playerRoutes());
  api.use('/entries', entryRoutes(broadcaster));
  api.use('/pairs', entryRoutes(broadcaster)); // plan §14 name; same resource
  api.use('/courts', courtRoutes(presence, broadcaster));
  api.use('/matches', matchRoutes(broadcaster));
  api.use('/umpire', umpireRoutes());
  api.use('/audit', auditRoutes());
  api.use('/users', userRoutes());
  api.use('/system', systemRoutes(broadcaster));
  api.get('/system/info', requireAdmin(), (_req, res) => {
    const body: SystemInfo = { urls: lanUrls(config.port), version: process.env.npm_package_version ?? '0.1.0' };
    res.json(body);
  });
  api.use(notFoundHandler);
  app.use('/api', api);

  if (serveWeb && fs.existsSync(path.join(config.webDist, 'index.html'))) {
    app.use(express.static(config.webDist, { index: false, maxAge: '1h' }));
    // SPA fallback: /admin, /umpire, /live ... all load index.html.
    app.get('/{*splat}', (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(config.webDist, 'index.html'));
    });
  }

  app.use(errorHandler);
  return app;
}
