import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { AdminUser, UmpireSession } from '@bt/shared';
import { config } from '../../config.js';
import { Court, User } from '../../models/index.js';
import { FailureLimiter } from '../../utils/rate-limiter.js';
import { tooMany, unauthorized } from '../../utils/errors.js';

export const ADMIN_COOKIE = 'bt_admin';
export const UMPIRE_COOKIE = 'bt_umpire';

export interface UmpireAuth extends UmpireSession {
  sessionId: string;
}
export interface Auth {
  admin: AdminUser | null;
  umpire: UmpireAuth | null;
}

interface AdminClaims {
  k: 'admin';
  sub: string;
  sv?: number;
}
interface UmpireClaims {
  k: 'umpire';
  sid: string;
  courtId: string;
  name: string;
  cv: number;
}

const adminLimiter = new FailureLimiter(config.adminMaxAttempts, config.adminLockoutMs);
const umpireLimiter = new FailureLimiter(config.umpireMaxAttempts, config.umpireLockoutMs);

export function resetLimiters() {
  adminLimiter.clearAll();
  umpireLimiter.clearAll();
}

// Constant-ish time for unknown usernames.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

export class AuthService {
  constructor(private readonly secret: string) {}

  async loginAdmin(username: string, password: string, ip: string): Promise<{ token: string; user: AdminUser }> {
    const key = `admin:${ip}`;
    const wait = adminLimiter.retryAfter(key);
    if (wait) throw tooMany(`Too many attempts. Try again in ${Math.ceil(wait / 60000)} min.`);

    const user = await User.findOne({ username: username.toLowerCase(), active: true }).lean();
    const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok) {
      adminLimiter.fail(key);
      throw unauthorized('Wrong username or password');
    }
    adminLimiter.reset(key);
    const claims: AdminClaims = { k: 'admin', sub: String(user._id), sv: user.sessionVersion ?? 0 };
    const token = jwt.sign(claims, this.secret, { expiresIn: `${config.adminSessionHours}h` });
    return { token, user: { id: String(user._id), username: user.username, role: user.role } };
  }

  /**
   * The 6-digit code identifies the court, so the umpire never has to pick it. With `courtId` (an old QR link)
   * only that court is tried; otherwise every active court that has a code is.
   */
  async loginUmpire(courtId: string | undefined, code: string, name: string, ip: string): Promise<{ token: string; session: UmpireAuth }> {
    const key = `umpire:${ip}`;
    const wait = umpireLimiter.retryAfter(key);
    if (wait) throw tooMany(`Too many wrong codes. Try again in ${Math.ceil(wait / 60000)} min.`);

    const candidates = await Court.find({ ...(courtId ? { _id: courtId } : {}), active: true, codeHash: { $nin: [null, ''] } }).lean();
    let court: (typeof candidates)[number] | null = null;
    for (const c of candidates) {
      if (await bcrypt.compare(code, c.codeHash!)) {
        court = c;
        break;
      }
    }
    if (!candidates.length) await bcrypt.compare(code, DUMMY_HASH); // same timing when there is nothing to check
    if (!court) {
      umpireLimiter.fail(key);
      throw unauthorized('Wrong code');
    }
    umpireLimiter.reset(key);
    courtId = String(court._id);
    const sid = crypto.randomUUID();
    const claims: UmpireClaims = { k: 'umpire', sid, courtId, name, cv: court.codeVersion };
    const token = jwt.sign(claims, this.secret, { expiresIn: `${config.umpireSessionHours}h` });
    return {
      token,
      session: { sessionId: sid, courtId, courtName: court.name, tournamentId: String(court.tournamentId), name },
    };
  }

  /** Resolve both cookies. Invalid/expired/revoked tokens resolve to null rather than throwing. */
  async resolve(cookies: Record<string, string | undefined>): Promise<Auth> {
    const [admin, umpire] = await Promise.all([
      this.resolveAdmin(cookies[ADMIN_COOKIE]),
      this.resolveUmpire(cookies[UMPIRE_COOKIE]),
    ]);
    return { admin, umpire };
  }

  private verify<T>(token: string | undefined): T | null {
    if (!token) return null;
    try {
      return jwt.verify(token, this.secret) as T;
    } catch {
      return null;
    }
  }

  private async resolveAdmin(token?: string): Promise<AdminUser | null> {
    const c = this.verify<AdminClaims>(token);
    if (c?.k !== 'admin') return null;
    const user = await User.findById(c.sub).lean();
    if (!user?.active) return null;
    if ((user.sessionVersion ?? 0) !== (c.sv ?? 0)) return null;
    return { id: String(user._id), username: user.username, role: user.role };
  }

  private async resolveUmpire(token?: string): Promise<UmpireAuth | null> {
    const c = this.verify<UmpireClaims>(token);
    if (c?.k !== 'umpire') return null;
    const court = await Court.findById(c.courtId).lean();
    // Regenerating the court code bumps codeVersion and ends every session on that court.
    if (!court || !court.active || court.codeVersion !== c.cv) return null;
    return {
      sessionId: c.sid,
      courtId: c.courtId,
      courtName: court.name,
      tournamentId: String(court.tournamentId),
      name: c.name,
    };
  }
}

export function cookieOptions(hours: number) {
  return {
    httpOnly: true,
    sameSite: 'strict' as const,
    // Plain HTTP on the venue LAN (plan-review §6); set COOKIE_SECURE=1 when serving over HTTPS.
    secure: process.env.COOKIE_SECURE === '1' || !!config.httpsKey,
    maxAge: hours * 3600 * 1000,
    path: '/',
  };
}
