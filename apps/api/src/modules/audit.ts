import type { Request } from 'express';
import { AuditLog } from '../models/index.js';

export function actorOf(req: Request) {
  if (req.auth.admin) return { kind: 'admin', id: req.auth.admin.id, name: req.auth.admin.username };
  if (req.auth.umpire) return { kind: 'umpire', id: req.auth.umpire.sessionId, name: req.auth.umpire.name };
  return { kind: 'anonymous', id: '', name: '' };
}

export async function audit(params: {
  actor: { kind: string; id: string; name: string };
  action: string;
  entity: string;
  entityId: unknown;
  tournamentId?: unknown;
  before?: unknown;
  after?: unknown;
  reason?: string;
}) {
  await AuditLog.create(params);
}
