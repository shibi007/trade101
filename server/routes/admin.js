import express from 'express';
import {
  createUser, isAdmin, getTotpSecret, enable2fa, disable2fa, verifyTotp, verifyUser,
  loadUsers, deleteUser, parseCookies, getSession, SESSION_COOKIE,
} from '../services/authService.js';
import { audit } from '../services/auditLog.js';

const router = express.Router();

function getUsername(req) {
  const session = getSession(parseCookies(req)[SESSION_COOKIE]);
  return session?.username;
}

function requireAdmin(req, res, next) {
  const username = getUsername(req);
  if (!username || !isAdmin(username)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// Create new user (admin only)
router.post('/users', requireAdmin, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  try {
    const result = await createUser(username, password, false);
    audit({ category: 'admin', action: result.created ? 'user.created' : 'user.password_reset', user: getUsername(req),
      message: `${result.created ? 'Created user' : 'Reset password for'} ${result.username}`, details: { target: result.username } });
    res.json({ success: true, user: result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// List all users (admin only)
router.get('/users', requireAdmin, (req, res) => {
  try {
    const userList = loadUsers().map(u => ({
      username: u.username,
      createdAt: u.createdAt,
      isAdmin: u.isAdmin,
      has2fa: Boolean(u.totpSecret),
    }));
    res.json({ users: userList, count: userList.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load users' });
  }
});

// Delete user (admin only)
router.post('/users/:username/delete', requireAdmin, async (req, res) => {
  const { username } = req.params;
  const admin = getUsername(req);
  if (username === admin) {
    return res.status(400).json({ error: 'Cannot delete your own admin account' });
  }
  try {
    if (!(await deleteUser(username))) return res.status(404).json({ error: `User not found: ${username}` });
    audit({ level: 'warn', category: 'admin', action: 'user.deleted', user: admin, message: `Deleted user ${username}`, details: { target: username } });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Enable 2FA for current user (returns QR code URL)
router.post('/2fa/enable', async (req, res) => {
  const username = getUsername(req);
  try {
    const result = await enable2fa(username);
    audit({ category: 'auth', action: '2fa.enabled', user: username, message: 'Two-factor authentication set up' });
    res.json({
      success: true,
      secret: result.secret,
      otpauthUrl: result.otpauthUrl,
      qrCodeUrl: `https://chart.googleapis.com/chart?chs=300x300&chld=M|0&cht=qr&chl=${encodeURIComponent(result.otpauthUrl)}`,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Verify 2FA code before actually enabling
router.post('/2fa/verify', (req, res) => {
  const username = getUsername(req);
  const { code } = req.body;
  if (!code) {
    return res.status(400).json({ error: 'Authenticator code required' });
  }
  try {
    const secret = getTotpSecret(username);
    if (!secret) {
      return res.status(400).json({ error: '2FA not setup yet' });
    }
    if (!verifyTotp(secret, code)) {
      return res.status(400).json({ error: 'Invalid authenticator code' });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Disable 2FA for current user
router.post('/2fa/disable', async (req, res) => {
  const username = getUsername(req);
  const { currentPassword } = req.body;
  if (!currentPassword) {
    return res.status(400).json({ error: 'Current password required' });
  }
  try {
    // Verified here, not trusted from the client: a stolen session cookie must
    // not be enough to strip a second factor off the account.
    if (!username || !verifyUser(username, currentPassword)) {
      audit({ level: 'warn', category: 'auth', action: '2fa.disable_refused', user: username, message: 'Attempt to turn off 2FA with a wrong password' });
      return res.status(403).json({ error: 'Current password is incorrect' });
    }
    await disable2fa(username);
    audit({ level: 'warn', category: 'auth', action: '2fa.disabled', user: username, message: 'Two-factor authentication turned off' });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Get 2FA status for current user
router.get('/2fa/status', (req, res) => {
  const username = getUsername(req);
  const has2fa = Boolean(getTotpSecret(username));
  res.json({ enabled: has2fa });
});

export default router;
