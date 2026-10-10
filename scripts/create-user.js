/**
 * Create (or reset the password of) a Trade101 user.
 *
 *   node scripts/create-user.js <username> [password]
 *
 * If no password is given, a strong random one is generated and printed once.
 */
// Same storage as the server: DATABASE_URL (from the environment or .env)
// selects the database, otherwise data/*.json.
import 'dotenv/config';
import crypto from 'crypto';
import { createUser } from '../server/services/authService.js';
import { initStore, closeStore } from '../server/services/store.js';

const [, , username, passwordArg] = process.argv;

if (!username) {
  console.error('Usage: node scripts/create-user.js <username> [password]');
  process.exit(1);
}

const password = passwordArg || crypto.randomBytes(12).toString('base64url');

try {
  await initStore();
  const result = await createUser(username, password);
  console.log(result.created ? `✅ User created: ${result.username}` : `🔄 Password reset for: ${result.username}`);
  if (!passwordArg) {
    console.log(`🔑 Generated password (shown once, store it safely): ${password}`);
  }
} catch (err) {
  console.error('❌ ' + err.message);
  process.exitCode = 1;
} finally {
  await closeStore();
}
