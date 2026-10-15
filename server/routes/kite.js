import express from 'express';
import { audit } from '../services/auditLog.js';
import {
  setCredentials, forgetCredentials, getStatus, getLoginUrl, completeSession,
  disconnect, getQuotes,
} from '../services/kiteService.js';
import { parseCookies, SESSION_COOKIE, getSession } from '../services/authService.js';

const router = express.Router();

function getToken(req) {
  return parseCookies(req)[SESSION_COOKIE];
}

/** The signed-in username for a session token, for the audit log. */
function sessionUser(token) {
  return getSession(token)?.username ?? null;
}

// Connection status (never exposes the secret)
router.get('/status', (req, res) => {
  const token = getToken(req);
  res.json(getStatus(token));
});

// Save API key + secret. Session-only unless `remember` is set, in which case
// they go to the persistent store under this username — the database when
// DATABASE_URL is set, otherwise data/kite.json.
router.post('/config', async (req, res) => {
  const token = getToken(req);
  const { apiKey, apiSecret, remember } = req.body;
  if (!apiKey || !apiSecret) {
    return res.status(400).json({ error: 'apiKey and apiSecret are required' });
  }
  try {
    await setCredentials(token, apiKey, apiSecret, Boolean(remember));
    const st = getStatus(token);
    audit({ category: 'kite', action: 'credentials.set', user: sessionUser(token),
      message: `Kite key ${st.apiKeyMasked} ${remember ? 'saved' : 'set for this login only'}`, details: { key: st.apiKeyMasked, remember: Boolean(remember) } });
    res.json({ success: true, status: st, loginUrl: getLoginUrl(token) });
  } catch (err) {
    audit({ level: 'warn', category: 'kite', action: 'credentials.rejected', user: sessionUser(token), message: `Kite key not saved: ${err.message}` });
    res.status(400).json({ error: err.message });
  }
});

// Forget saved credentials for this user.
router.delete('/config', async (req, res) => {
  try {
    const token = getToken(req);
    await forgetCredentials(token);
    audit({ category: 'kite', action: 'credentials.forgotten', user: sessionUser(token), message: 'Saved Kite key and secret removed' });
    res.json({ success: true, status: getStatus(token) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Kite login URL for the popup
router.get('/login-url', (req, res) => {
  const token = getToken(req);
  const url = getLoginUrl(token);
  if (!url) return res.status(400).json({ error: 'Configure your Kite API key first' });
  res.json({ loginUrl: url });
});

// OAuth-style callback — Zerodha redirects here with request_token.
// Set this as the Redirect URL in your Kite Connect app: http://localhost:8081/api/kite/callback
// For production: https://yourdomain.com/api/kite/callback
router.get('/callback', async (req, res) => {
  const token = getToken(req);
  const { request_token, status } = req.query;
  // Error text comes from Kite and names come from the account: escaped, since
  // this page is HTML.
  const esc = v => String(v ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const page = (title, body, ok) => `<!doctype html><html><head><title>${title}</title>
    <style>body{font-family:system-ui;background:#0d1117;color:#e6edf3;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
    .card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:32px 40px;text-align:center;max-width:420px}
    h2{color:${ok ? '#3fb950' : '#f85149'};margin-top:0}</style></head>
    <body><div class="card"><h2>${title}</h2><p>${body}</p><p style="color:#8b949e">This window will close automatically.</p></div>
    <script>
      try { window.opener && window.opener.postMessage({ type: 'kite-auth', ok: ${ok} }, '*'); } catch(e){}
      setTimeout(() => window.close(), 2500);
    </script></body></html>`;

  if (status === 'cancelled' || !request_token) {
    audit({ level: 'warn', category: 'kite', action: 'login.cancelled', user: sessionUser(token), message: 'Kite login was cancelled or returned no request token' });
    return res.send(page('Login cancelled', 'Kite login was not completed.', false));
  }

  try {
    const st = await completeSession(token, request_token);
    audit({ category: 'kite', action: 'login', user: sessionUser(token),
      message: `Connected to Kite as ${st.userName || st.userId} (${st.userId})`, details: { kiteUser: st.userId, key: st.apiKeyMasked, source: st.source } });
    res.send(page('Connected to Kite ✓', `Logged in as ${esc(st.userName || st.userId)}. Live NSE data is now active.`, true));
  } catch (err) {
    audit({ level: 'error', category: 'kite', action: 'login.failed', user: sessionUser(token), message: `Kite login failed: ${err.message}` });
    res.send(page('Connection failed', esc(err.message), false));
  }
});

// Disconnect the session
router.post('/disconnect', (req, res) => {
  const token = getToken(req);
  disconnect(token);
  audit({ category: 'kite', action: 'logout', user: sessionUser(token), message: 'Disconnected from Kite' });
  res.json({ success: true, status: getStatus(token) });
});

// Live quote passthrough, e.g. /api/kite/quotes?symbols=INFY,TCS
router.get('/quotes', async (req, res) => {
  const token = getToken(req);
  const symbols = (req.query.symbols || '').split(',').filter(Boolean);
  if (!symbols.length) return res.status(400).json({ error: 'symbols query param required' });
  try {
    const data = await getQuotes(token, symbols.map(s => `NSE:${s.trim().toUpperCase()}`));
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

export default router;
