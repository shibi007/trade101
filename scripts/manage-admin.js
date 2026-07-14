/**
 * Manage admin status for users.
 *
 *   node scripts/manage-admin.js <username> <true|false>
 *   node scripts/manage-admin.js shibi007 true   # Make user admin
 *   node scripts/manage-admin.js guest false      # Revoke admin
 */
import { setAdmin } from '../server/services/authService.js';

const [, , username, isAdminStr] = process.argv;

if (!username || !['true', 'false'].includes(isAdminStr)) {
  console.error('Usage: node scripts/manage-admin.js <username> <true|false>');
  process.exit(1);
}

try {
  const isAdmin = isAdminStr === 'true';
  setAdmin(username, isAdmin);
  console.log(`✅ User "${username}" is now ${isAdmin ? 'an admin' : 'not an admin'}`);
} catch (err) {
  console.error('❌ ' + err.message);
  process.exit(1);
}
