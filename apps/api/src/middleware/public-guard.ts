import type { RequestHandler } from 'express';

/**
 * Keeps the organiser tools off the internet when the laptop is shared through a tunnel
 * (Cloudflare Tunnel, Tailscale Funnel, ngrok...).
 *
 * A request counts as "public" when it carries the headers a tunnel or reverse proxy adds, or (mode "on")
 * when it is not addressed to a local / private host. Public visitors may only open the spectator
 * pages (live scores, scoreboard, schedule) and read the data those pages need. The admin and umpire
 * screens, every write, and every other API call answer "not found".
 *
 * PUBLIC_READONLY: "auto" (default) = guard requests that came through a tunnel or proxy;
 *                  "on" = also guard any request to a non-private host name;
 *                  "off" = no guard (for a normal cloud deployment where you sign in over the internet).
 */
export type PublicMode = 'auto' | 'on' | 'off';

const PROXY_HEADERS = ['cf-connecting-ip', 'cf-ray', 'x-forwarded-for', 'x-forwarded-host', 'forwarded'];
const PRIVATE_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|::1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|[^.]+|.+\.local|.+\.lan)$/i;

const API_ALLOWED = [
  /^\/health$/,
  /^\/tournaments$/,
  /^\/tournaments\/[0-9a-f]{24}$/,
  /^\/tournaments\/[0-9a-f]{24}\/live-qr$/,
  /^\/courts$/,
  /^\/matches$/,
];
const PAGE_ALLOWED = [/^\/$/, /^\/live(\/|$)/, /^\/board\//, /^\/help$/];

export function isPublicRequest(headers: Record<string, unknown>, hostHeader: string | undefined, mode: PublicMode): boolean {
  if (mode === 'off') return false;
  if (PROXY_HEADERS.some((h) => headers[h] !== undefined)) return true;
  if (mode === 'on') {
    const host = (hostHeader ?? '').replace(/:\d+$/, '');
    return !PRIVATE_HOST.test(host);
  }
  return false;
}

export function publicGuard(mode: PublicMode): RequestHandler {
  return (req, res, next) => {
    if (!isPublicRequest(req.headers, req.get('host'), mode)) return next();

    // Socket.IO (live updates) has its own path and never writes.
    if (req.path.startsWith('/socket.io')) return next();

    if (req.path.startsWith('/api/') || req.path === '/api') {
      const path = req.path.slice(4) || '/';
      const read = req.method === 'GET' || req.method === 'HEAD';
      if (read && API_ALLOWED.some((re) => re.test(path))) return next();
      res.status(404).json({ error: { code: 'not_found', message: 'Not found' } });
      return;
    }

    // Web pages and assets: spectator pages and files (anything with an extension, e.g. .js, .css, .woff2).
    if (/\.[a-z0-9]{2,8}$/i.test(req.path) || PAGE_ALLOWED.some((re) => re.test(req.path))) return next();
    res.redirect(302, '/live');
  };
}
