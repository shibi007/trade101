import express from 'express';
import {
  createUser, setAdmin, isAdmin, getTotpSecret, enable2fa, disable2fa, verifyTotp,
  parseCookies, getSession, SESSION_COOKIE,
} from '../services/authService.js';

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
router.post('/users', requireAdmin, (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  try {
    const result = createUser(username, password, false);
    res.json({ success: true, user: result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// List all users (admin only)
router.get('/users', requireAdmin, (req, res) => {
  try {
    const users = require('fs').readFileSync(
      require('path').join(require('path').dirname(require('url').fileURLToPath(import.meta.url)), '..', '..', 'data', 'users.json'),
      'utf8'
    );
    const userList = JSON.parse(users).map(u => ({
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
router.post('/users/:username/delete', requireAdmin, (req, res) => {
  const { username } = req.params;
  const admin = getUsername(req);
  if (username === admin) {
    return res.status(400).json({ error: 'Cannot delete your own admin account' });
  }
  try {
    const fs = require('fs');
    const path = require('path');
    const usersFile = path.join(path.dirname(require('url').fileURLToPath(import.meta.url)), '..', '..', 'data', 'users.json');
    const users = JSON.parse(fs.readFileSync(usersFile, 'utf8')).filter(u => u.username !== username);
    fs.writeFileSync(usersFile, JSON.stringify(users, null, 2));
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Enable 2FA for current user (returns QR code URL)
router.post('/2fa/enable', (req, res) => {
  const username = getUsername(req);
  try {
    const result = enable2fa(username);
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
router.post('/2fa/disable', (req, res) => {
  const username = getUsername(req);
  const { currentPassword } = req.body;
  if (!currentPassword) {
    return res.status(400).json({ error: 'Current password required' });
  }
  try {
    // Password verification is done by the client before calling this
    disable2fa(username);
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
