import express from 'express';
import {
  verifyUser, createSession, destroySession, getSession, parseCookies,
  SESSION_COOKIE, checkRateLimit, clearRateLimit,
} from '../services/authService.js';

const router = express.Router();

router.post('/login', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const rl = checkRateLimit(ip);
  if (!rl.allowed) {
    return res.status(429).json({ error: `Too many login attempts. Try again in ${rl.retryAfterMin} min.` });
  }

  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const user = verifyUser(username, password);
  if (!user) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  clearRateLimit(ip);
  const token = createSession(user.username);
  res.setHeader('Set-Cookie',
    `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${12 * 60 * 60}`);
  res.json({ success: true, username: user.username });
});

router.post('/logout', (req, res) => {
  destroySession(parseCookies(req)[SESSION_COOKIE]);
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  res.json({ success: true });
});

router.get('/me', (req, res) => {
  const session = getSession(parseCookies(req)[SESSION_COOKIE]);
  if (!session) return res.status(401).json({ error: 'Not logged in' });
  res.json({ username: session.username });
});

export default router;
