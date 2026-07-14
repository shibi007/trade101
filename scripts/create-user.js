/**
 * Create (or reset the password of) a Trade101 user.
 *
 *   node scripts/create-user.js <username> [password]
 *
 * If no password is given, a strong random one is generated and printed once.
 */
import crypto from 'crypto';
import { createUser } from '../server/services/authService.js';

const [, , username, passwordArg] = process.argv;

if (!username) {
  console.error('Usage: node scripts/create-user.js <username> [password]');
  process.exit(1);
}

const password = passwordArg || crypto.randomBytes(12).toString('base64url');

try {
  const result = createUser(username, password);
  console.log(result.created ? `✅ User created: ${result.username}` : `🔄 Password reset for: ${result.username}`);
  if (!passwordArg) {
    console.log(`🔑 Generated password (shown once, store it safely): ${password}`);
  }
} catch (err) {
  console.error('❌ ' + err.message);
  process.exit(1);
}
