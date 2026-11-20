import crypto from 'node:crypto';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { Setting, User } from './models/index.js';
import { logger } from './utils/logger.js';

export async function connectDb(uri: string): Promise<void> {
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
  logger.info({ db: mongoose.connection.name }, 'MongoDB connected');
}

export async function disconnectDb(): Promise<void> {
  await mongoose.disconnect();
}

export function dbHealthy(): boolean {
  return mongoose.connection.readyState === 1;
}

/** JWT signing secret, generated once and stored in the database so restarts keep sessions valid. */
export async function loadJwtSecret(): Promise<string> {
  const existing = await Setting.findById('jwtSecret').lean();
  if (existing?.value) return existing.value as string;
  const secret = crypto.randomBytes(48).toString('base64url');
  await Setting.updateOne({ _id: 'jwtSecret' }, { $setOnInsert: { value: secret } }, { upsert: true });
  const saved = await Setting.findById('jwtSecret').lean();
  return saved!.value as string;
}

/** On a fresh database, create a super admin so the system is usable. */
export async function ensureSuperAdmin(): Promise<void> {
  if (await User.exists({})) return;
  const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
  await User.create({ username: 'admin', passwordHash: await bcrypt.hash(password, 12), role: 'super_admin' });
  // Printed once, to the server console only.
  logger.warn('Created first super admin. Username: admin  Password: %s  (change it with npm run create-admin)', password);
}
