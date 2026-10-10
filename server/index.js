import express from 'express';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Behind Render/other TLS proxies: trust X-Forwarded-* so req.ip is the
// real client IP (login rate limiting) and secure cookies work.
app.set('trust proxy', 1);
const server = createServer(app);
const wss = new WebSocketServer({ server });

// Middleware — body parsing with size limits
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

// Security headers (same-origin only; no CORS wildcard)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'"
  );
  next();
});

// Import routes
import healthRoutes from './routes/health.js';
import marketRoutes from './routes/market.js';
import tradeRoutes from './routes/trade.js';
import insightsRoutes from './routes/insights.js';
import kiteRoutes from './routes/kite.js';
import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import { requireAuth, getSession, parseCookies, SESSION_COOKIE, hasUsers, createUser } from './services/authService.js';
import { attachTickerHub } from './services/tickerHub.js';
import { initStore, closeStore } from './services/store.js';
import { getVersion } from './services/version.js';

// Restore persistent state and run migrations before anything is served. On a
// host that wipes its disk, this is what brings users and saved Kite keys back
// after every deploy and every restart. If stored data cannot be loaded the
// boot fails rather than starting empty: the first save would then overwrite
// everything that was stored.
try {
  const storage = await initStore();
  console.log(`💾 Storage: ${storage.backend}${storage.encrypted ? ' (encrypted)' : ''}${storage.durable ? '' : ' — NOT durable on this host'}`);
  for (const m of storage.migrations) console.log(`🔁 Migration ${m.id}: ${m.touched.join(', ') || 'no changes'}`);
  if (!storage.durable) {
    console.warn('⚠ This host erases its disk on every deploy and restart (Render free plan), so saved logins, 2FA and Kite keys will not survive. Set DATABASE_URL to keep them — see README, "Keeping data across deploys".');
  }
} catch (err) {
  console.error(`✖ Could not load stored data: ${err.message}`);
  process.exit(1);
}

// Bootstrap the first user from env vars. With a database this runs once, on
// the very first boot; on a wiped disk it runs on every boot.
if (!hasUsers() && process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD) {
  await createUser(process.env.ADMIN_USERNAME, process.env.ADMIN_PASSWORD, true); // first user is admin
  console.log(`👤 Bootstrapped admin user "${process.env.ADMIN_USERNAME}" from environment`);
}

// Public routes: login/logout + Kite OAuth callback (Zerodha redirects here)
app.use('/api/auth', authRoutes);
app.use('/api/health', healthRoutes);

// Everything else under /api requires a session
app.use('/api/market', requireAuth, marketRoutes);
app.use('/api/trade', requireAuth, tradeRoutes);
app.use('/api/insights', requireAuth, insightsRoutes);
app.use('/api/admin', requireAuth, adminRoutes);
// Kite: the OAuth callback must stay public (Zerodha redirects the browser
// there); every other Kite endpoint needs a session.
app.use('/api/kite', (req, res, next) => {
  if (req.method === 'GET' && req.path === '/callback') return next();
  return requireAuth(req, res, next);
}, kiteRoutes);

// Dashboard UI — gate the app page behind login
app.use((req, res, next) => {
  const publicPaths = ['/login.html', '/favicon.ico'];
  if (publicPaths.includes(req.path)) return next();
  if (req.path === '/' || req.path === '/index.html') {
    const session = getSession(parseCookies(req)[SESSION_COOKIE]);
    if (!session) return res.redirect('/login.html');
  }
  next();
});
app.use(express.static(join(__dirname, '..', 'public')));

// Live quotes: authenticates the socket against the session cookie, then
// streams Kite ticks to the browser. Replaces the previous echo handler, which
// confirmed subscriptions it never fulfilled.
attachTickerHub(wss);

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal Server Error',
    status: err.status || 500,
  });
});

// Start server
server.listen(PORT, () => {
  const v = getVersion();
  console.log(`🚀 Trade101 v${v.version}${v.commit ? ` (${v.commit})` : ''} running on http://localhost:${PORT}`);
  console.log(`📊 Market Configuration: India NSE/BSE Intraday Trading`);
  console.log(`⏰ Market Hours: 9:15 AM - 3:30 PM IST`);
});

// Render sends SIGTERM before replacing an instance on deploy. Every write is
// already committed when it returns, so this only releases connections.
process.on('SIGTERM', () => {
  server.close(() => closeStore().finally(() => process.exit(0)));
  setTimeout(() => process.exit(0), 10_000).unref();
});

export { app, wss };
