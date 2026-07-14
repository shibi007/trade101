/**
 * Enable or disable TOTP two-factor auth for a user.
 *
 *   node scripts/manage-2fa.js enable <username>
 *   node scripts/manage-2fa.js disable <username>
 *
 * On enable, prints the base32 secret and otpauth:// URL — add it to
 * Google Authenticator / Authy / Microsoft Authenticator ("enter setup
 * key" and paste the secret). Store the secret safely: losing it locks
 * you out until you run "disable".
 */
import { enable2fa, disable2fa } from '../server/services/authService.js';

const [, , action, username] = process.argv;

if (!['enable', 'disable'].includes(action) || !username) {
  console.error('Usage: node scripts/manage-2fa.js <enable|disable> <username>');
  process.exit(1);
}

try {
  if (action === 'enable') {
    const { secret, otpauthUrl } = enable2fa(username);
    console.log(`✅ 2FA enabled for ${username}\n`);
    console.log(`Setup key (enter in your authenticator app): ${secret}`);
    console.log(`otpauth URL: ${otpauthUrl}\n`);
    console.log('⚠️  Test a login BEFORE closing this terminal — if the code fails,');
    console.log(`   run: node scripts/manage-2fa.js disable ${username}`);
  } else {
    disable2fa(username);
    console.log(`✅ 2FA disabled for ${username}`);
  }
} catch (err) {
  console.error('❌ ' + err.message);
  process.exit(1);
}
