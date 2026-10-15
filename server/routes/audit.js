import express from 'express';
import { parseCookies, SESSION_COOKIE, getSession, isAdmin } from '../services/authService.js';
import { queryAudit, LEVELS } from '../services/auditLog.js';

const router = express.Router();

export const CATEGORIES = ['system', 'auth', 'admin', 'kite', 'data', 'backtest', 'storage'];

/**
 * GET /api/audit?category=kite&level=warn&before=<iso>&limit=100
 *
 * Admins see every event. Anyone else sees their own events and the server's
 * (which carry no user) — never another user's sign-ins or keys.
 */
router.get('/', async (req, res) => {
  const session = getSession(parseCookies(req)[SESSION_COOKIE]);
  if (!session) return res.status(401).json({ error: 'Not signed in' });
  const admin = isAdmin(session.username);
  const category = CATEGORIES.includes(req.query.category) ? req.query.category : null;
  const minLevel = LEVELS.includes(req.query.level) ? req.query.level : 'info';
  const before = req.query.before && !Number.isNaN(Date.parse(req.query.before)) ? new Date(req.query.before).toISOString() : null;
  try {
    const out = await queryAudit({ user: admin ? null : session.username, category, minLevel, before, limit: req.query.limit });
    res.json({ ...out, scope: admin ? 'all' : 'own', categories: CATEGORIES, levels: LEVELS });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
