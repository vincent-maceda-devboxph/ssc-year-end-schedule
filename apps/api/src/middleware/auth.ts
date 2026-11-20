import type { NextFunction, Request, Response } from 'express';
import type { Role } from '@bt/shared';
import type { Auth, AuthService } from '../modules/auth/auth.service.js';
import { forbidden, unauthorized } from '../utils/errors.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth: Auth;
    }
  }
}

export function loadAuth(auth: AuthService) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    req.auth = await auth.resolve(req.cookies ?? {});
    next();
  };
}

export function requireAdmin(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const admin = req.auth.admin;
    if (!admin) return next(unauthorized());
    if (roles.length && !roles.includes(admin.role)) return next(forbidden());
    next();
  };
}

/** Admin or an umpire session (court-level checks happen in the service). */
export function requireOfficial(req: Request, _res: Response, next: NextFunction) {
  if (!req.auth.admin && !req.auth.umpire) return next(unauthorized());
  next();
}
