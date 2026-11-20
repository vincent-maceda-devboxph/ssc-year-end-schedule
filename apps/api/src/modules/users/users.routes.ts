import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { userCreateSchema, userUpdateSchema, type AdminUserDto } from '@bt/shared';
import { requireAdmin } from '../../middleware/auth.js';
import { User } from '../../models/index.js';
import { conflict, forbidden, notFound, parse, unprocessable } from '../../utils/errors.js';
import { actorOf, audit } from '../audit.js';

const dto = (u: { _id: unknown; username: string; role: string; active: boolean; createdAt?: Date }): AdminUserDto => ({
  id: String(u._id),
  username: u.username,
  role: u.role as AdminUserDto['role'],
  active: u.active,
  createdAt: (u.createdAt ?? new Date()).toISOString(),
});

/** Number of active super admins other than `exceptId`: the program must always keep at least one. */
const otherSupers = (exceptId: unknown) => User.countDocuments({ role: 'super_admin', active: true, _id: { $ne: exceptId } });

/** /api/users: admin accounts. Super administrators only. Accounts are switched off, never deleted, so the audit log keeps its names. */
export function userRoutes(): Router {
  const r = Router();
  r.use(requireAdmin('super_admin'));

  r.get('/', async (_req, res) => {
    res.json((await User.find().sort({ username: 1 }).lean()).map(dto));
  });

  r.post('/', async (req, res) => {
    const body = parse(userCreateSchema, req.body);
    if (await User.exists({ username: body.username })) throw conflict('That username is taken', 'username_taken');
    const u = await User.create({ username: body.username, role: body.role, passwordHash: await bcrypt.hash(body.password, 12) });
    await audit({ actor: actorOf(req), action: 'create', entity: 'user', entityId: u._id, after: { username: u.username, role: u.role } });
    res.status(201).json(dto(u.toObject()));
  });

  r.put('/:id', async (req, res) => {
    const body = parse(userUpdateSchema, req.body);
    const u = await User.findById(req.params.id).lean();
    if (!u) throw notFound('User');
    const self = String(u._id) === req.auth.admin!.id;

    const losesSuper = u.role === 'super_admin' && u.active && ((body.role && body.role !== 'super_admin') || body.active === false);
    if (losesSuper && !(await otherSupers(u._id))) {
      throw unprocessable('There must always be at least one active Super Administrator.', 'last_super_admin');
    }
    if (self && body.active === false) throw forbidden('You cannot switch off your own account.', 'self_deactivate');

    const set: Record<string, unknown> = {};
    if (body.role) set.role = body.role;
    if (body.active !== undefined) set.active = body.active;
    let signOut = body.active === false || (body.role !== undefined && body.role !== u.role);
    if (body.password) {
      set.passwordHash = await bcrypt.hash(body.password, 12);
      signOut = true;
    }
    const update: Record<string, unknown> = { $set: set };
    if (signOut) update.$inc = { sessionVersion: 1 };
    const updated = await User.findByIdAndUpdate(u._id, update, { new: true }).lean();
    await audit({
      actor: actorOf(req),
      action: body.password ? 'reset_password' : 'update',
      entity: 'user',
      entityId: u._id,
      before: { role: u.role, active: u.active },
      after: { role: updated!.role, active: updated!.active },
    });
    res.json(dto(updated!));
  });

  return r;
}
