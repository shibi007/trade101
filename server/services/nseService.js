/**
 * Best-effort NSE public data — corporate announcements/board meetings (events)
 * and basic quote fundamentals (P/E, 52-week range).
 *
 * These are UNOFFICIAL, undocumented endpoints behind NSE's website (not a
 * published/licensed API). No login or credentials are involved — they are
 * publicly served to any browser — but NSE can rate-limit, change response
 * shapes, or block automated access without notice. Every call here is
 * wrapped so failures degrade gracefully (return null/empty) rather than
 * breaking the insights pipeline.
 */

const NSE_BASE = 'https://www.nseindia.com';
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://www.nseindia.com/',
};

let cookieJar = { cookie: '', fetchedAt: 0 };
const COOKIE_TTL_MS = 5 * 60 * 1000;

function extractCookies(res) {
  const list = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
  return list.map(c => c.split(';')[0]).join('; ');
}

// Native fetch ignores a plain `timeout` option — it must be enforced with
// AbortController, otherwise a hanging NSE response stalls the whole
// insights request indefinitely.
async function fetchWithTimeout(url, opts, ms = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function ensureSession() {
  if (cookieJar.cookie && Date.now() - cookieJar.fetchedAt < COOKIE_TTL_MS) return cookieJar.cookie;
  const res = await fetchWithTimeout(`${NSE_BASE}/get-quotes/equity?symbol=RELIANCE`, { headers: BROWSER_HEADERS });
  const cookie = extractCookies(res);
  if (!cookie) throw new Error('NSE session bootstrap failed');
  cookieJar = { cookie, fetchedAt: Date.now() };
  return cookie;
}

// Cap concurrent outbound NSE requests so a full 16-stock universe refresh
// doesn't fire dozens of simultaneous requests and get flagged/blocked.
let active = 0;
const waiters = [];
const MAX_CONCURRENT = 3;
async function acquire() {
  if (active < MAX_CONCURRENT) { active++; return; }
  await new Promise(r => waiters.push(r));
  active++;
}
function release() {
  active--;
  const next = waiters.shift();
  if (next) next();
}

async function nseGet(path) {
  await acquire();
  try {
    const cookie = await ensureSession();
    const res = await fetchWithTimeout(`${NSE_BASE}${path}`, { headers: { ...BROWSER_HEADERS, Cookie: cookie } });
    if (res.status === 401 || res.status === 403) {
      cookieJar = { cookie: '', fetchedAt: 0 }; // force re-bootstrap next call
    }
    if (!res.ok) throw new Error(`NSE HTTP ${res.status}`);
    return res.json();
  } finally {
    release();
  }
}

// ---------- caching wrapper ----------
const cache = new Map(); // key -> { fetchedAt, data }
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.fetchedAt < ttlMs) return hit.data;
  try {
    const data = await fn();
    cache.set(key, { fetchedAt: Date.now(), data });
    return data;
  } catch {
    return hit ? hit.data : null; // serve stale on failure rather than nothing
  }
}

/** True if the symbol has a board meeting or corporate announcement dated today (IST). */
export async function getTodaysEvents(symbol) {
  return cached(`events:${symbol}`, 15 * 60 * 1000, async () => {
    const todayIST = new Date().toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata' }).split('/').join('-'); // DD-MM-YYYY
    const [announcements, boardMeetings] = await Promise.all([
      nseGet(`/api/corporate-announcements?index=equities&symbol=${encodeURIComponent(symbol)}`).catch(() => []),
      nseGet(`/api/corporate-board-meetings?index=equities&symbol=${encodeURIComponent(symbol)}`).catch(() => []),
    ]);
    const todays = [];
    for (const a of Array.isArray(announcements) ? announcements : []) {
      const d = (a.an_dt || a.attchmntDt || '').slice(0, 10);
      if (d && matchesTodayIST(d, todayIST)) todays.push({ type: 'announcement', subject: a.subject || a.desc || 'Corporate announcement' });
    }
    for (const b of Array.isArray(boardMeetings) ? boardMeetings : []) {
      const d = (b.bm_date || '').slice(0, 10);
      if (d && matchesTodayIST(d, todayIST)) todays.push({ type: 'board_meeting', subject: b.bm_purpose || 'Board meeting' });
    }
    return todays;
  });
}

function matchesTodayIST(isoOrSlash, todayDDMMYYYY) {
  // NSE dates arrive as either "YYYY-MM-DD" or "DD-Mon-YYYY"; normalize loosely.
  const d = new Date(isoOrSlash);
  if (isNaN(d)) return false;
  const ddmmyyyy = d.toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata' }).split('/').join('-');
  return ddmmyyyy === todayDDMMYYYY;
}

/** Best-effort fundamentals: 52-week range and P/E when NSE exposes them. Returns null on failure. */
export async function getFundamentals(symbol) {
  return cached(`fundamentals:${symbol}`, 20 * 60 * 1000, async () => {
    const data = await nseGet(`/api/quote-equity?symbol=${encodeURIComponent(symbol)}`);
    const weekHighLo = data?.priceInfo?.weekHighLo;
    const pe = data?.metadata?.pdSymbolPe ?? null;
    const sectorPe = data?.metadata?.pdSectorPe ?? null;
    if (!weekHighLo && pe == null) return null;
    return {
      weekHigh: weekHighLo?.max ?? null,
      weekLow: weekHighLo?.min ?? null,
      pe: pe != null ? Number(pe) : null,
      sectorPe: sectorPe != null ? Number(sectorPe) : null,
    };
  });
}
