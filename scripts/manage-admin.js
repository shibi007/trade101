/**
 * Manage admin status for users.
 *
 *   node scripts/manage-admin.js <username> <true|false>
 *   node scripts/manage-admin.js shibi007 true   # Make user admin
 *   node scripts/manage-admin.js guest false      # Revoke admin
 */
// Same storage as the server: DATABASE_URL (from the environment or .env)
// selects the database, otherwise data/*.json.
import 'dotenv/config';
import { setAdmin } from '../server/services/authService.js';
import { initStore, closeStore } from '../server/services/store.js';

const [, , username, isAdminStr] = process.argv;

if (!username || !['true', 'false'].includes(isAdminStr)) {
  console.error('Usage: node scripts/manage-admin.js <username> <true|false>');
  process.exit(1);
}

try {
  await initStore();
  const isAdmin = isAdminStr === 'true';
  await setAdmin(username, isAdmin);
  console.log(`✅ User "${username}" is now ${isAdmin ? 'an admin' : 'not an admin'}`);
} catch (err) {
  console.error('❌ ' + err.message);
  process.exitCode = 1;
} finally {
  await closeStore();
}
