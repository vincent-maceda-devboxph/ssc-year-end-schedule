/**
 * Create an admin or reset a password.
 *   npm run create-admin -- <username> <password> [super_admin|tournament_admin]
 */
import bcrypt from 'bcryptjs';
import { config } from '../config.js';
import { connectDb, disconnectDb } from '../db.js';
import { User } from '../models/index.js';

const [username, password, role = 'tournament_admin'] = process.argv.slice(2);
if (!username || !password || !['super_admin', 'tournament_admin'].includes(role)) {
  console.error('Usage: npm run create-admin -- <username> <password> [super_admin|tournament_admin]');
  process.exit(1);
}
if (password.length < 8) {
  console.error('Password must be at least 8 characters.');
  process.exit(1);
}

await connectDb(config.mongoUri);
await User.updateOne(
  { username: username.toLowerCase() },
  { $set: { passwordHash: await bcrypt.hash(password, 12), role, active: true } },
  { upsert: true },
);
console.log(`Saved ${role} "${username.toLowerCase()}".`);
await disconnectDb();
