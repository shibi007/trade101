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

// Bootstrap the first user from env vars — needed on hosts with ephemeral
// filesystems (e.g. Render) where data/users.json doesn't survive deploys.
if (!hasUsers() && process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD) {
  createUser(process.env.ADMIN_USERNAME, process.env.ADMIN_PASSWORD, true); // first user is admin
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

// WebSocket connection handler
wss.on('connection', (ws) => {
  console.log('New WebSocket connection');

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      console.log('Received:', data);

      // Handle different message types
      if (data.type === 'SUBSCRIBE_PRICE') {
        ws.send(JSON.stringify({
          type: 'SUBSCRIPTION_CONFIRMED',
          symbol: data.symbol,
          timestamp: new Date().toISOString(),
        }));
      }
    } catch (error) {
      console.error('WebSocket error:', error);
    }
  });

  ws.on('close', () => {
    console.log('WebSocket connection closed');
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

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
  console.log(`🚀 Trade101 Server running on http://localhost:${PORT}`);
  console.log(`📊 Market Configuration: India NSE/BSE Intraday Trading`);
  console.log(`⏰ Market Hours: 9:15 AM - 3:30 PM IST`);
});

export { app, wss };
