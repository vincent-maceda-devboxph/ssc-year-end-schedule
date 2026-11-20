import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { loginSchema, passwordChangeSchema, umpireLoginSchema, type MeResponse } from '@bt/shared';
import { config } from '../../config.js';
import { User } from '../../models/index.js';
import { parse, unauthorized } from '../../utils/errors.js';
import { ADMIN_COOKIE, AuthService, UMPIRE_COOKIE, cookieOptions } from './auth.service.js';

export function authRoutes(auth: AuthService): Router {
  const r = Router();

  r.post('/login', async (req, res) => {
    const body = parse(loginSchema, req.body);
    const { token, user } = await auth.loginAdmin(body.username, body.password, req.ip ?? '');
    res.cookie(ADMIN_COOKIE, token, cookieOptions(config.adminSessionHours));
    res.json({ admin: user });
  });

  r.post('/password', async (req, res) => {
    if (!req.auth.admin) throw unauthorized();
    const body = parse(passwordChangeSchema, req.body);
    const user = await User.findById(req.auth.admin.id);
    if (!user || !(await bcrypt.compare(body.current, user.passwordHash))) throw unauthorized('The current password is wrong');
    user.passwordHash = await bcrypt.hash(body.next, 12);
    user.sessionVersion = (user.sessionVersion ?? 0) + 1;
    await user.save();
    // Keep this browser signed in: issue a fresh session for the new version.
    const { token } = await auth.loginAdmin(user.username, body.next, req.ip ?? '');
    res.cookie(ADMIN_COOKIE, token, cookieOptions(config.adminSessionHours));
    res.status(204).end();
  });

  r.post('/logout', (_req, res) => {
    res.clearCookie(ADMIN_COOKIE, { path: '/' });
    res.status(204).end();
  });

  r.post('/umpire/login', async (req, res) => {
    const body = parse(umpireLoginSchema, req.body);
    const { token, session } = await auth.loginUmpire(body.courtId, body.code, body.name, req.ip ?? '');
    res.cookie(UMPIRE_COOKIE, token, cookieOptions(config.umpireSessionHours));
    const { sessionId: _sid, ...umpire } = session;
    res.json({ umpire });
  });

  r.post('/umpire/logout', (_req, res) => {
    res.clearCookie(UMPIRE_COOKIE, { path: '/' });
    res.status(204).end();
  });

  r.get('/me', (req, res) => {
    const u = req.auth.umpire;
    const body: MeResponse = {
      admin: req.auth.admin,
      umpire: u ? { courtId: u.courtId, courtName: u.courtName, tournamentId: u.tournamentId, name: u.name } : null,
    };
    res.json(body);
  });

  return r;
}
