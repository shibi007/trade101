/**
 * Zerodha Kite Connect integration — per-user, stored in auth session.
 *
 * Flow:
 *  1. User saves their API key + secret from the UI (kept in the auth session,
 *     never written to disk, secret never echoed back).
 *  2. UI opens the Kite login URL; after login Zerodha redirects to our
 *     callback with a request_token.
 *  3. We exchange request_token for an access_token using
 *     SHA-256(api_key + request_token + api_secret).
 *  4. Live quotes are then fetched from api.kite.trade.
 *
 * Docs: https://kite.trade/docs/connect/v3/
 */
import crypto from 'crypto';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getSession } from './authService.js';

const KITE_BASE = 'https://api.kite.trade';
const KITE_VERSION = '3';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CREDENTIALS_FILE = join(__dirname, '..', '..', 'data', 'kite.json');

function readCredentialsFile() {
  try {
    return JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'));
  } catch {
    return {};   // missing or malformed is fine — fall back to env/UI
  }
}

function writeCredentialsFile(data) {
  fs.mkdirSync(dirname(CREDENTIALS_FILE), { recursive: true });
  // 0600 so the file is not world-readable. Note this is a POSIX mode: on
  // Windows Node only maps it to the read-only flag, so it does NOT restrict
  // other accounts there. The gitignore on data/ is what keeps it out of the
  // repo; filesystem-level protection is the operator's job.
  fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
  try { fs.chmodSync(CREDENTIALS_FILE, 0o600); } catch { /* best effort */ }
}

/**
 * Credentials for a user, in precedence order: their own saved credentials,
 * then the legacy top-level pair in the file, then env vars.
 *
 * Per-user rather than global because the top-level pair is shared by every
 * account on this server — fine for a single operator, a credential leak
 * between accounts as soon as there are two. Saving through the UI always
 * writes to the per-user slot; the global pair is honoured for anyone who
 * hand-wrote the file before this existed.
 *
 * Read fresh each time so editing the file doesn't require a restart.
 */
function loadStoredCredentials(username = null) {
  const file = readCredentialsFile();
  const mine = username ? file.users?.[username] : null;

  const apiKey = mine?.apiKey?.trim() || file.apiKey?.trim() || process.env.KITE_API_KEY || null;
  const apiSecret = mine?.apiSecret?.trim() || file.apiSecret?.trim() || process.env.KITE_API_SECRET || null;

  return {
    apiKey: apiKey || null,
    apiSecret: apiSecret || null,
    // Whether these came from disk for *this* user, so the UI can show the
    // saved state and lock the fields rather than inviting a re-entry.
    persisted: Boolean(mine?.apiKey && mine?.apiSecret),
  };
}

/** Persist a user's credentials so they survive a restart. */
export function saveStoredCredentials(username, apiKey, apiSecret) {
  if (!username) throw new Error('Not signed in');
  const file = readCredentialsFile();
  file.users ||= {};
  file.users[username] = {
    apiKey: String(apiKey).trim(),
    apiSecret: String(apiSecret).trim(),
    savedAt: new Date().toISOString(),
  };
  writeCredentialsFile(file);
}

/** Forget a user's saved credentials. Leaves other users' entries alone. */
export function clearStoredCredentials(username) {
  const file = readCredentialsFile();
  if (file.users?.[username]) {
    delete file.users[username];
    writeCredentialsFile(file);
  }
}

// Native fetch ignores a plain `timeout` option — it must be enforced with
// AbortController, otherwise a hanging Kite response stalls the caller
// indefinitely (this matters a lot now that insights requests await it).
async function fetchWithTimeout(url, opts, ms = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function getKiteSession(token) {
  const session = getSession(token);
  if (!session) return null;
  if (!session.kite) {
    const stored = loadStoredCredentials(session.username);
    session.kite = {
      apiKey: stored.apiKey,
      apiSecret: stored.apiSecret,
      persisted: stored.persisted,
      accessToken: null, userId: null, userName: null, connectedAt: null, lastError: null,
    };
  }
  return session.kite;
}

/**
 * Set credentials for this session, optionally persisting them to disk.
 *
 * `persist` is opt-in per call rather than implicit: writing an API secret to
 * disk is a decision the operator should make deliberately, not a side effect
 * of filling in a form.
 */
export function setCredentials(token, apiKey, apiSecret, persist = false) {
  const session = getSession(token);
  if (!session) throw new Error('Session expired');
  const kite = getKiteSession(token);
  kite.apiKey = apiKey?.trim() || null;
  kite.apiSecret = apiSecret?.trim() || null;
  kite.accessToken = null;
  kite.lastError = null;

  if (persist && kite.apiKey && kite.apiSecret) {
    saveStoredCredentials(session.username, kite.apiKey, kite.apiSecret);
    kite.persisted = true;
  }
}

/** Forget saved credentials and drop them from the live session too. */
export function forgetCredentials(token) {
  const session = getSession(token);
  if (!session) throw new Error('Session expired');
  clearStoredCredentials(session.username);
  const kite = getKiteSession(token);
  kite.apiKey = null;
  kite.apiSecret = null;
  kite.accessToken = null;
  kite.persisted = false;
  kite.lastError = null;
}

export function getStatus(token) {
  const kite = getKiteSession(token);
  if (!kite) return null;
  return {
    configured: Boolean(kite.apiKey && kite.apiSecret),
    connected: Boolean(kite.accessToken),
    // Saved credentials are shown masked and locked, so the UI needs to know
    // they exist without ever receiving the secret back.
    persisted: Boolean(kite.persisted),
    apiKeyMasked: kite.apiKey ? kite.apiKey.slice(0, 4) + '••••' : null,
    userId: kite.userId,
    userName: kite.userName,
    connectedAt: kite.connectedAt,
    lastError: kite.lastError,
  };
}

export function getLoginUrl(token) {
  const kite = getKiteSession(token);
  if (!kite?.apiKey) return null;
  return `https://kite.zerodha.com/connect/login?v=${KITE_VERSION}&api_key=${encodeURIComponent(kite.apiKey)}`;
}

export async function completeSession(token, requestToken) {
  const kite = getKiteSession(token);
  if (!kite) throw new Error('Session expired');
  if (!kite.apiKey || !kite.apiSecret) {
    throw new Error('Kite API key/secret not configured');
  }

  const checksum = crypto
    .createHash('sha256')
    .update(kite.apiKey + requestToken + kite.apiSecret)
    .digest('hex');

  try {
    const body = new URLSearchParams({
      api_key: kite.apiKey,
      request_token: requestToken,
      checksum,
    });

    const res = await fetchWithTimeout(`${KITE_BASE}/session/token`, {
      method: 'POST',
      headers: {
        'X-Kite-Version': KITE_VERSION,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });

    const json = await res.json();
    if (!res.ok || json.status !== 'success') {
      const msg = json.message || `Kite session exchange failed (HTTP ${res.status})`;
      kite.lastError = msg;
      throw new Error(msg);
    }

    kite.accessToken = json.data.access_token;
    kite.userId = json.data.user_id;
    kite.userName = json.data.user_name;
    kite.connectedAt = new Date().toISOString();
    kite.lastError = null;
    return getStatus(token);
  } catch (err) {
    kite.lastError = err.message;
    throw err;
  }
}

export function disconnect(token) {
  const kite = getKiteSession(token);
  if (kite) {
    kite.accessToken = null;
    kite.userId = null;
    kite.userName = null;
    kite.connectedAt = null;
  }
}

async function kiteGet(token, path) {
  const kite = getKiteSession(token);
  if (!kite?.accessToken) throw new Error('Not connected to Kite');

  try {
    const res = await fetchWithTimeout(`${KITE_BASE}${path}`, {
      headers: {
        'X-Kite-Version': KITE_VERSION,
        Authorization: `token ${kite.apiKey}:${kite.accessToken}`,
      },
    });

    const json = await res.json();
    if (!res.ok || json.status !== 'success') {
      if (res.status === 403) disconnect(token);
      throw new Error(json.message || `Kite API error (HTTP ${res.status})`);
    }
    return json.data;
  } catch (err) {
    kite.lastError = err.message;
    throw err;
  }
}

/** Fetch full quotes for instruments like ["NSE:INFY", "NSE:TCS"] */
export async function getQuotes(token, instruments) {
  const qs = instruments.map(i => `i=${encodeURIComponent(i)}`).join('&');
  return kiteGet(token, `/quote?${qs}`);
}

/** Live quotes for the insights universe; null when not connected. */
export async function getUniverseQuotes(token, symbols) {
  const kite = getKiteSession(token);
  if (!kite?.accessToken) return null;
  try {
    return await getQuotes(token, symbols.map(s => `NSE:${s}`));
  } catch (err) {
    return null; // fail silently, fall back to simulated data
  }
}

/**
 * Equity account funds. Lets position sizing work off real capital instead of
 * a hardcoded notional. Returns null when disconnected or on any error —
 * callers treat funds as simply unknown rather than failing the request.
 */
export async function getMargins(token) {
  const kite = getKiteSession(token);
  if (!kite?.accessToken) return null;
  try {
    const d = await kiteGet(token, '/user/margins/equity');
    return {
      net: d?.net ?? null,                                  // tradable balance
      cash: d?.available?.cash ?? null,
      liveBalance: d?.available?.live_balance ?? null,
      collateral: d?.available?.collateral ?? null,
      utilisedDebits: d?.utilised?.debits ?? null,
      // Realised/unrealised on open positions — the running day P&L that the
      // daily-loss limit needs to be checked against.
      realised: d?.utilised?.m2m_realised ?? null,
      unrealised: d?.utilised?.m2m_unrealised ?? null,
    };
  } catch {
    return null;
  }
}

/** Open positions (day + net). Null when disconnected. */
export async function getPositions(token) {
  const kite = getKiteSession(token);
  if (!kite?.accessToken) return null;
  try {
    const d = await kiteGet(token, '/portfolio/positions');
    return { day: d?.day ?? [], net: d?.net ?? [] };
  } catch {
    return null;
  }
}

/**
 * Credentials needed to open a ticker connection. Null unless a Kite login has
 * completed — the ticker needs an access token, not just the API key.
 */
export function getTickerCredentials(token) {
  const kite = getKiteSession(token);
  if (!kite?.apiKey || !kite?.accessToken) return null;
  return { apiKey: kite.apiKey, accessToken: kite.accessToken };
}

export function isConnected(token) {
  const kite = getKiteSession(token);
  return Boolean(kite?.accessToken);
}

// ---------- rate limiter (Kite historical API: ~3 req/sec) ----------
let queue = Promise.resolve();
function throttled(fn) {
  const run = queue.then(() => fn());
  // Stagger regardless of success/failure so bursts don't exceed the limit.
  queue = run.then(() => sleep(340), () => sleep(340));
  return run;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------- instrument master (symbol -> instrument_token), cached ~24h ----------
let instrumentCache = { fetchedAt: 0, bySymbol: new Map() };
const INSTRUMENT_CACHE_TTL_MS = 20 * 60 * 60 * 1000;

async function refreshInstruments(token) {
  const kite = getKiteSession(token);
  if (!kite?.accessToken) throw new Error('Not connected to Kite');

  const res = await fetchWithTimeout(`${KITE_BASE}/instruments/NSE`, {
    headers: {
      'X-Kite-Version': KITE_VERSION,
      Authorization: `token ${kite.apiKey}:${kite.accessToken}`,
    },
  }, 15000);
  if (!res.ok) throw new Error(`Failed to fetch instrument list (HTTP ${res.status})`);
  const csv = await res.text();

  const bySymbol = new Map();
  const lines = csv.split('\n');
  const header = lines[0].split(',');
  const idx = {
    token: header.indexOf('instrument_token'),
    symbol: header.indexOf('tradingsymbol'),
    segment: header.indexOf('segment'),
    type: header.indexOf('instrument_type'),
  };
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const cols = line.split(',');
    if (cols[idx.segment] === 'NSE' && cols[idx.type] === 'EQ') {
      bySymbol.set(cols[idx.symbol], cols[idx.token]);
    }
  }
  instrumentCache = { fetchedAt: Date.now(), bySymbol };
}

/** Resolve an NSE equity trading symbol to its Kite instrument_token, refreshing the cached master list once a day. */
export async function getInstrumentToken(token, symbol) {
  if (Date.now() - instrumentCache.fetchedAt > INSTRUMENT_CACHE_TTL_MS || instrumentCache.bySymbol.size === 0) {
    await throttled(() => refreshInstruments(token));
  }
  return instrumentCache.bySymbol.get(symbol) || null;
}

// ---------- historical candles, cached per (symbol, interval) with a short TTL ----------
const historicalCache = new Map(); // key -> { fetchedAt, candles }
const HISTORICAL_CACHE_TTL_MS = { '5minute': 55_000, day: 6 * 60 * 60 * 1000 };

function formatKiteDate(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Fetch OHLCV candles for a symbol from Kite's historical data API.
 * Returns null (never throws) when unavailable — callers fall back to simulated data.
 */
export async function getHistoricalCandles(token, symbol, interval, fromDate, toDate) {
  const cacheKey = `${symbol}:${interval}:${fromDate.toISOString().slice(0, 10)}`;
  const cached = historicalCache.get(cacheKey);
  const ttl = HISTORICAL_CACHE_TTL_MS[interval] || 60_000;
  if (cached && Date.now() - cached.fetchedAt < ttl) return cached.candles;

  try {
    const instrumentToken = await getInstrumentToken(token, symbol);
    if (!instrumentToken) return null;

    const from = encodeURIComponent(formatKiteDate(fromDate));
    const to = encodeURIComponent(formatKiteDate(toDate));
    const path = `/instruments/historical/${instrumentToken}/${interval}?from=${from}&to=${to}`;
    const data = await throttled(() => kiteGet(token, path));

    const candles = (data.candles || []).map(([time, open, high, low, close, volume], i) => ({
      t: i, time, open, high, low, close, volume,
    }));
    historicalCache.set(cacheKey, { fetchedAt: Date.now(), candles });
    return candles;
  } catch (err) {
    return null; // historical add-on not enabled, rate-limited, or transient error
  }
}
