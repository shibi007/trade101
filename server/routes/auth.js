import express from 'express';
import {
  verifyUser, verifyTotp, getTotpSecret, changePassword,
  createSession, destroySession, destroyUserSessions, getSession, parseCookies,
  SESSION_COOKIE, checkRateLimit, clearRateLimit, requireAuth,
} from '../services/authService.js';
import { audit } from '../services/auditLog.js';

const router = express.Router();

const sleep = ms => new Promise(r => setTimeout(r, ms));
const FAIL_DELAY_MS = 400; // uniform delay on every failure — slows brute force, hides which field was wrong

function cookieFlags() {
  // Secure flag when served over HTTPS (set COOKIE_SECURE=true behind a TLS proxy)
  const secure = process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production';
  return `HttpOnly; SameSite=Strict; Path=/${secure ? '; Secure' : ''}`;
}

router.post('/login', async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const rl = checkRateLimit(ip);
  if (!rl.allowed) {
    audit({ level: 'warn', category: 'auth', action: 'login.ratelimited', user: req.body?.username || null,
      message: `Login blocked after repeated failures from ${ip}`, details: { ip, retryAfterMin: rl.retryAfterMin } });
    return res.status(429).json({ error: `Too many login attempts. Try again in ${rl.retryAfterMin} min.` });
  }

  const { username, password, otp } = req.body || {};
  if (!username || !password) {
    await sleep(FAIL_DELAY_MS);
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const user = verifyUser(username, password);
  if (!user) {
    // The reason stays here: the response is identical either way, so the
    // log cannot be used to learn which of username or password was wrong.
    audit({ level: 'warn', category: 'auth', action: 'login.failed', user: String(username).slice(0, 64),
      message: `Failed sign-in from ${ip}: wrong username or password`, details: { ip } });
    await sleep(FAIL_DELAY_MS);
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  // Second factor when enabled for this user
  if (user.has2fa) {
    if (!otp) {
      // Password OK — ask the client for the authenticator code (no session yet)
      return res.status(401).json({ requires2fa: true, error: 'Enter your 6-digit authenticator code' });
    }
    if (!verifyTotp(getTotpSecret(user.username), otp)) {
      audit({ level: 'warn', category: 'auth', action: 'login.2fa_failed', user: user.username,
        message: `Wrong authenticator code from ${ip} (password was correct)`, details: { ip } });
      await sleep(FAIL_DELAY_MS);
      return res.status(401).json({ requires2fa: true, error: 'Invalid authenticator code' });
    }
  }

  clearRateLimit(ip);
  const token = createSession(user.username);
  audit({ category: 'auth', action: 'login', user: user.username,
    message: `Signed in from ${ip}${user.has2fa ? ' with 2FA' : ''}`, details: { ip, has2fa: user.has2fa } });
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; ${cookieFlags()}; Max-Age=${12 * 60 * 60}`);
  res.json({ success: true, username: user.username });
});

router.post('/logout', (req, res) => {
  const who = getSession(parseCookies(req)[SESSION_COOKIE])?.username || null;
  destroySession(parseCookies(req)[SESSION_COOKIE]);
  if (who) audit({ category: 'auth', action: 'logout', user: who, message: 'Signed out' });
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; ${cookieFlags()}; Max-Age=0`);
  res.json({ success: true });
});

router.post('/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current and new password are required' });
  }
  try {
    await changePassword(req.user.username, currentPassword, newPassword);
  } catch (err) {
    audit({ level: 'warn', category: 'auth', action: 'password.change_failed', user: req.user.username, message: `Password change refused: ${err.message}` });
    await sleep(FAIL_DELAY_MS);
    return res.status(400).json({ error: err.message });
  }
  // Kill any other sessions for this user; the current one stays valid
  destroyUserSessions(req.user.username, parseCookies(req)[SESSION_COOKIE]);
  audit({ category: 'auth', action: 'password.changed', user: req.user.username, message: 'Password changed; other sessions signed out' });
  res.json({ success: true });
});

router.get('/me', (req, res) => {
  const token = parseCookies(req)[SESSION_COOKIE];
  const session = getSession(token);
  if (!session) return res.status(401).json({ error: 'Not logged in' });
  res.json({
    username: session.username,
    isAdmin: session.isAdmin || false,
    has2fa: session.has2fa || false,
  });
});

export default router;
