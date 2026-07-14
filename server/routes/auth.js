import express from 'express';
import {
  verifyUser, verifyTotp, getTotpSecret,
  createSession, destroySession, getSession, parseCookies,
  SESSION_COOKIE, checkRateLimit, clearRateLimit,
} from '../services/authService.js';

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
    return res.status(429).json({ error: `Too many login attempts. Try again in ${rl.retryAfterMin} min.` });
  }

  const { username, password, otp } = req.body || {};
  if (!username || !password) {
    await sleep(FAIL_DELAY_MS);
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const user = verifyUser(username, password);
  if (!user) {
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
      await sleep(FAIL_DELAY_MS);
      return res.status(401).json({ requires2fa: true, error: 'Invalid authenticator code' });
    }
  }

  clearRateLimit(ip);
  const token = createSession(user.username);
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; ${cookieFlags()}; Max-Age=${12 * 60 * 60}`);
  res.json({ success: true, username: user.username });
});

router.post('/logout', (req, res) => {
  destroySession(parseCookies(req)[SESSION_COOKIE]);
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; ${cookieFlags()}; Max-Age=0`);
  res.json({ success: true });
});

router.get('/me', (req, res) => {
  const session = getSession(parseCookies(req)[SESSION_COOKIE]);
  if (!session) return res.status(401).json({ error: 'Not logged in' });
  res.json({ username: session.username });
});

export default router;
