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
import { getSession } from './authService.js';
import { readDoc, writeDoc, storeStatus } from './store.js';

const KITE_BASE = 'https://api.kite.trade';
const KITE_VERSION = '3';

// Saved credentials live in the persistent store's `kite` document — the
// database when DATABASE_URL is set, otherwise data/kite.json (0600, gitignored).
function readCredentialsFile() {
  const doc = readDoc('kite');
  return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : {};
}

function writeCredentialsFile(data) {
  return writeDoc('kite', data);
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

  // Where the pair came from, so the UI can say whether it survives a deploy:
  // 'saved' by this user, the legacy shared pair in the file, the host's
  // environment variables, or nothing.
  const source = mine?.apiKey && mine?.apiSecret ? 'saved'
    : file.apiKey && file.apiSecret ? 'shared'
      : process.env.KITE_API_KEY && process.env.KITE_API_SECRET ? 'env'
        : null;

  return {
    apiKey: apiKey || null,
    apiSecret: apiSecret || null,
    // Whether these are stored for *this* user, so the UI can show the saved
    // state and lock the fields rather than inviting a re-entry.
    persisted: source === 'saved',
    source,
  };
}

/** Persist a user's credentials. Resolves once they are durably saved. */
export async function saveStoredCredentials(username, apiKey, apiSecret) {
  if (!username) throw new Error('Not signed in');
  const file = readCredentialsFile();
  file.users ||= {};
  file.users[username] = {
    apiKey: String(apiKey).trim(),
    apiSecret: String(apiSecret).trim(),
    savedAt: new Date().toISOString(),
  };
  await writeCredentialsFile(file);
}

/** Forget a user's saved credentials. Leaves other users' entries alone. */
export async function clearStoredCredentials(username) {
  const file = readCredentialsFile();
  if (file.users?.[username]) {
    delete file.users[username];
    await writeCredentialsFile(file);
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
      source: stored.source,
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
export async function setCredentials(token, apiKey, apiSecret, persist = false) {
  const session = getSession(token);
  if (!session) throw new Error('Session expired');
  const kite = getKiteSession(token);
  kite.apiKey = apiKey?.trim() || null;
  kite.apiSecret = apiSecret?.trim() || null;
  kite.accessToken = null;
  kite.lastError = null;

  kite.source = 'session';
  kite.persisted = false;
  if (persist && kite.apiKey && kite.apiSecret) {
    await saveStoredCredentials(session.username, kite.apiKey, kite.apiSecret);
    kite.persisted = true;
    kite.source = 'saved';
  }
}

/** Forget saved credentials and drop them from the live session too. */
export async function forgetCredentials(token) {
  const session = getSession(token);
  if (!session) throw new Error('Session expired');
  await clearStoredCredentials(session.username);
  const kite = getKiteSession(token);
  // Fall back to whatever remains — environment variables, if set — rather
  // than to nothing, so "forget" does not hide a configured fallback.
  const remaining = loadStoredCredentials(session.username);
  kite.apiKey = remaining.apiKey;
  kite.apiSecret = remaining.apiSecret;
  kite.source = remaining.source;
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
    // 'saved' | 'shared' | 'env' | 'session' | null — with `storage`, enough
    // for the UI to say plainly whether the keys survive the next deploy.
    source: kite.source ?? null,
    storage: storeStatus(),
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
let instrumentCache = { fetchedAt: 0, bySymbol: new Map(), tickBySymbol: new Map(), indexBySymbol: new Map() };
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
  const tickBySymbol = new Map();
  // Kept apart from equities so whole-market equity scans never quote an index.
  const indexBySymbol = new Map();
  const lines = csv.split('\n');
  const header = splitCsvLine(lines[0]).map(h => h.trim());
  const idx = {
    token: header.indexOf('instrument_token'),
    symbol: header.indexOf('tradingsymbol'),
    segment: header.indexOf('segment'),
    type: header.indexOf('instrument_type'),
    tick: header.indexOf('tick_size'),
  };
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    if (!line) continue;
    // Quote-aware: index names such as "NIFTY 50" sit in the same dump.
    const cols = splitCsvLine(line);
    if (cols[idx.segment] === 'NSE' && cols[idx.type] === 'EQ') {
      bySymbol.set(cols[idx.symbol], cols[idx.token]);
      const tick = Number(cols[idx.tick]);
      if (tick > 0) tickBySymbol.set(cols[idx.symbol], tick);
    } else if (cols[idx.segment] === 'INDICES') {
      // Indices ("NIFTY 50"), for market-trend filters.
      indexBySymbol.set(cols[idx.symbol], cols[idx.token]);
    }
  }
  instrumentCache = { fetchedAt: Date.now(), bySymbol, tickBySymbol, indexBySymbol };
}

/**
 * Resolve an NSE equity trading symbol — or an index name such as "NIFTY 50" —
 * to its Kite instrument_token, refreshing the cached master list once a day.
 */
export async function getInstrumentToken(token, symbol) {
  if (Date.now() - instrumentCache.fetchedAt > INSTRUMENT_CACHE_TTL_MS || instrumentCache.bySymbol.size === 0) {
    await throttled(() => refreshInstruments(token));
  }
  return instrumentCache.bySymbol.get(symbol) || instrumentCache.indexBySymbol.get(symbol) || null;
}

// ---------- F&O underlyings (from the NFO instrument master), cached ~20h ----------

/**
 * Split one CSV line, honouring double-quoted fields. Kite quotes the `name`
 * column, and while the NFO names are plain symbols, splitting on bare commas
 * would silently misalign every column after a name that ever contained one.
 */
function splitCsvLine(line) {
  const out = [];
  let cur = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { cur += '"'; i++; } else quoted = !quoted;
    } else if (ch === ',' && !quoted) {
      out.push(cur); cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/**
 * Parse Kite's NFO instrument dump into the stocks that have derivatives.
 *
 * A stock is in F&O if it has a stock future: every F&O stock lists futures
 * alongside its options, so futures are the clean test. `name` on an NFO row is
 * the underlying's NSE symbol (RELIANCE, M&M), which is what the universe uses.
 *
 * Lot size is taken from the nearest expiry. Exchanges revise lots
 * periodically and the change lands on a new expiry first; the near month is
 * the contract actually being traded intraday.
 *
 * Returns Map<symbol, { lotSize, expiry }>. Pure, so it is testable offline.
 */
export function parseFnoInstruments(csv) {
  const lines = String(csv || '').split('\n');
  const header = splitCsvLine(lines[0] || '').map(h => h.trim());
  const col = name => header.indexOf(name);
  const idx = {
    name: col('name'), expiry: col('expiry'), lot: col('lot_size'),
    type: col('instrument_type'), segment: col('segment'),
  };
  if (Object.values(idx).some(i => i < 0)) return new Map();

  const out = new Map();
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cols = splitCsvLine(lines[i].replace(/\r$/, ''));
    if (cols[idx.type] !== 'FUT' || cols[idx.segment] !== 'NFO-FUT') continue;
    const symbol = cols[idx.name].trim();
    const expiry = cols[idx.expiry];
    const lotSize = Number(cols[idx.lot]);
    if (!symbol || !expiry || !(lotSize > 0)) continue;
    const prev = out.get(symbol);
    if (!prev || expiry < prev.expiry) out.set(symbol, { lotSize, expiry });
  }
  return out;
}

let fnoCache = { fetchedAt: 0, bySymbol: new Map() };
// After a failed download, wait before trying again. Without this, every
// insights poll during an NFO outage would block on a 20-second timeout.
let fnoFailedAt = 0;
const FNO_RETRY_BACKOFF_MS = 5 * 60 * 1000;

async function refreshFno(token) {
  const kite = getKiteSession(token);
  if (!kite?.accessToken) throw new Error('Not connected to Kite');
  const res = await fetchWithTimeout(`${KITE_BASE}/instruments/NFO`, {
    headers: {
      'X-Kite-Version': KITE_VERSION,
      Authorization: `token ${kite.apiKey}:${kite.accessToken}`,
    },
  }, 20000);
  if (!res.ok) throw new Error(`Failed to fetch NFO instrument list (HTTP ${res.status})`);
  const bySymbol = parseFnoInstruments(await res.text());
  // An empty parse means the format changed or the download was truncated, not
  // that F&O was abolished. Caching it would drop every stock from the board
  // for twenty hours; refuse it so callers fall back instead.
  if (bySymbol.size === 0) throw new Error('NFO instrument list parsed to zero underlyings');
  fnoCache = { fetchedAt: Date.now(), bySymbol };
}

/**
 * Stocks with exchange-traded futures and options, with their lot sizes.
 * Map<symbol, { lotSize, expiry }>, or null when Kite is unavailable — callers
 * must treat null as "unknown", never as "nothing is in F&O".
 */
export async function getFnoUnderlyings(token) {
  const stale = Date.now() - fnoCache.fetchedAt > INSTRUMENT_CACHE_TTL_MS || fnoCache.bySymbol.size === 0;
  const backingOff = Date.now() - fnoFailedAt < FNO_RETRY_BACKOFF_MS;
  if (stale && !backingOff) {
    try {
      await throttled(() => refreshFno(token));
    } catch {
      fnoFailedAt = Date.now();
    }
  }
  // A stale list beats none: F&O membership changes a few times a year.
  return fnoCache.bySymbol.size ? fnoCache.bySymbol : null;
}

/**
 * The exchange tick size for an NSE equity, from the cached instrument master:
 * Kite rejects an order whose price is not a whole number of ticks. Null when
 * the master has not been loaded (no Kite session) — callers fall back and say so.
 */
export function getTickSize(symbol) {
  return instrumentCache.tickBySymbol?.get(symbol) ?? null;
}

/**
 * Every NSE equity trading symbol Kite knows about (~2000).
 *
 * The master list is already downloaded for token resolution, so scanning the
 * whole market costs nothing extra here — the cost is in quoting them, which
 * getQuotesBatched handles.
 */
export async function getAllEquitySymbols(token) {
  if (Date.now() - instrumentCache.fetchedAt > INSTRUMENT_CACHE_TTL_MS || instrumentCache.bySymbol.size === 0) {
    await throttled(() => refreshInstruments(token));
  }
  return [...instrumentCache.bySymbol.keys()];
}

// Kite accepts up to 500 instruments per /quote call. Chunking at 250 leaves
// headroom for long symbol names in the query string, which is what actually
// bounds the request — a few thousand symbols still costs under ten calls.
const QUOTE_BATCH_SIZE = 250;

/**
 * Quote many instruments, in as few calls as the API allows.
 *
 * This is what makes scanning the whole market practical: one call covers 250
 * stocks, where historical candles cost two throttled calls *per stock*. A
 * failed batch is skipped rather than aborting the scan — losing 250 names is
 * much better than losing all of them.
 */
export async function getQuotesBatched(token, instruments) {
  const out = {};
  for (let i = 0; i < instruments.length; i += QUOTE_BATCH_SIZE) {
    const batch = instruments.slice(i, i + QUOTE_BATCH_SIZE);
    try {
      const data = await throttled(() => getQuotes(token, batch));
      Object.assign(out, data || {});
    } catch {
      // Skip this batch; the rest of the scan is still worth having.
    }
  }
  return out;
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
  // The end date is part of the key. Without it, two requests sharing a start
  // date but ending on different days — daily candles up to yesterday, and up
  // to today after the close — shared one entry for six hours, so the later one
  // could be served the earlier window or a half-formed intraday daily bar.
  const cacheKey = `${symbol}:${interval}:${fromDate.toISOString().slice(0, 10)}:${toDate.toISOString().slice(0, 10)}`;
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
