/**
 * Fan-out between Kite's ticker and connected browsers.
 *
 * One upstream Kite connection per signed-in session, shared by every tab that
 * session has open. Opening a ticker per tab would multiply connections against
 * Kite's limit for no benefit — the tick stream is identical.
 *
 * Ticks are batched on a short timer rather than forwarded individually: a
 * liquid open can produce hundreds of ticks a second, and a WebSocket send per
 * tick spends more time in framing than the data is worth.
 */
import { KiteTicker, resolveInstrumentTokens } from './kiteTicker.js';
import { getTickerCredentials } from './kiteService.js';
import { getSession, parseCookies, SESSION_COOKIE } from './authService.js';
import { UNIVERSE } from './insightsEngine.js';

const FLUSH_MS = 250;
// Keep a ticker briefly after the last tab closes, so a page reload does not
// tear down and re-establish the upstream connection.
const IDLE_GRACE_MS = 30_000;

const hubs = new Map();   // sessionToken -> { ticker, clients:Set, pending:Map, timer, idleTimer, status }

function send(ws, payload) {
  if (ws.readyState === 1) {
    try { ws.send(JSON.stringify(payload)); } catch { /* client went away mid-send */ }
  }
}

function broadcast(hub, payload) {
  for (const ws of hub.clients) send(ws, payload);
}

function flush(hub) {
  hub.timer = null;
  if (!hub.pending.size) return;
  const ticks = [...hub.pending.values()];
  hub.pending.clear();
  broadcast(hub, { type: 'ticks', ticks });
}

async function ensureHub(sessionToken) {
  let hub = hubs.get(sessionToken);
  if (hub) return hub;

  const creds = getTickerCredentials(sessionToken);
  if (!creds) return null;   // not logged in to Kite — nothing to stream

  hub = { ticker: null, clients: new Set(), pending: new Map(), timer: null, idleTimer: null, status: { connected: false } };
  hubs.set(sessionToken, hub);

  hub.ticker = new KiteTicker({
    ...creds,
    onTick: ticks => {
      // Keyed by symbol so only the latest tick per symbol survives a batch
      // window; intermediate prices inside 250ms are not worth sending.
      for (const t of ticks) hub.pending.set(t.symbol, t);
      if (!hub.timer) hub.timer = setTimeout(() => flush(hub), FLUSH_MS);
    },
    onStatus: status => {
      hub.status = { ...hub.status, ...status };
      broadcast(hub, { type: 'ticker-status', ...hub.status });
    },
  });

  hub.ticker.connect();

  try {
    // Resolving symbols downloads Kite's full instrument dump on a cold cache,
    // which is slow and can fail. If it does, the hub must not be left in the
    // map half-built — every later connection would reuse a ticker that is
    // connected but subscribed to nothing, and report "live" while silent.
    const pairs = await resolveInstrumentTokens(sessionToken, UNIVERSE.map(s => s.symbol));
    if (!pairs.length) throw new Error('no instrument tokens resolved');
    hub.ticker.setUniverse(pairs);
    hub.status = { ...hub.status, subscribed: pairs.length };
    broadcast(hub, { type: 'ticker-status', ...hub.status });
  } catch (err) {
    hub.ticker.close();
    clearTimeout(hub.timer);
    hubs.delete(sessionToken);
    broadcast(hub, { type: 'ticker-status', connected: false, error: `subscribe failed: ${err.message}` });
    throw err;
  }

  return hub;
}

function releaseHub(sessionToken) {
  const hub = hubs.get(sessionToken);
  if (!hub || hub.clients.size) return;
  clearTimeout(hub.idleTimer);
  hub.idleTimer = setTimeout(() => {
    const current = hubs.get(sessionToken);
    if (!current || current.clients.size) return;   // someone reconnected
    current.ticker?.close();
    clearTimeout(current.timer);
    hubs.delete(sessionToken);
  }, IDLE_GRACE_MS);
}

export function attachTickerHub(wss) {
  wss.on('connection', async (ws, req) => {
    // The upgrade request carries the session cookie, so the socket is
    // authenticated the same way the REST routes are. An unauthenticated socket
    // would leak one user's live prices to anyone who opened /ws.
    const sessionToken = parseCookies(req)[SESSION_COOKIE];
    const session = getSession(sessionToken);
    if (!session) {
      send(ws, { type: 'error', error: 'Authentication required' });
      return ws.close();
    }

    let hub;
    try {
      hub = await ensureHub(sessionToken);
    } catch (err) {
      send(ws, { type: 'ticker-status', connected: false, error: err.message });
    }

    if (!hub) {
      // Not an error: the page works without live ticks, on the periodic
      // refresh. Say so plainly so the UI can show the right badge.
      send(ws, { type: 'ticker-status', connected: false, reason: 'kite-not-connected' });
      return;
    }

    clearTimeout(hub.idleTimer);
    hub.clients.add(ws);
    send(ws, { type: 'ticker-status', ...hub.status });

    ws.on('close', () => { hub.clients.delete(ws); releaseHub(sessionToken); });
    ws.on('error', () => { hub.clients.delete(ws); releaseHub(sessionToken); });
  });
}

/**
 * Drop a session's ticker — called when its Kite session ends, since the
 * access token the upstream connection authenticated with is now dead.
 */
export function stopTicker(sessionToken) {
  const hub = hubs.get(sessionToken);
  if (!hub) return;
  hub.ticker?.close();
  clearTimeout(hub.timer);
  clearTimeout(hub.idleTimer);
  broadcast(hub, { type: 'ticker-status', connected: false, reason: 'kite-disconnected' });
  hubs.delete(sessionToken);
}
