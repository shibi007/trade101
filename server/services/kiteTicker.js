/**
 * Kite Ticker — live quotes over Zerodha's streaming WebSocket.
 *
 * Polling the quote REST endpoint cannot give live prices: it is rate limited,
 * every poll costs a round trip whether or not anything changed, and the
 * interval is a floor on how stale the screen can be. The ticker pushes instead
 * — a tick arrives when the price actually moves.
 *
 * Docs: https://kite.trade/docs/connect/v3/websocket/
 *
 * The binary parser is exported separately from the connection manager so it
 * can be tested against recorded frames without a live market or credentials.
 */
import WebSocket from 'ws';
import { getInstrumentToken } from './kiteService.js';

const TICKER_URL = 'wss://ws.kite.trade';

// Prices arrive as integers and must be divided by a segment-specific factor.
// Getting this wrong is silent and catastrophic — a currency pair would read
// 100000x its real price — so the segments are listed explicitly rather than
// defaulted blindly.
const SEGMENT_DIVISORS = {
  1: 100,        // NSE_CM  — equity
  2: 100,        // NFO_FUT
  3: 100,        // NFO_OPT
  4: 100,        // CDS_FUT (handled below via currency segments)
  5: 100,        // BSE_CM
  6: 100,        // BSE_FO
  7: 10000000,   // BCD — currency
  8: 100,        // MCX_FUT
  9: 100,        // MCX_OPT
  10: 100,       // Indices
};
const CURRENCY_SEGMENTS = new Set([7]);

function divisorFor(instrumentToken) {
  const segment = instrumentToken & 0xff;
  if (CURRENCY_SEGMENTS.has(segment)) return 10000000;
  return SEGMENT_DIVISORS[segment] ?? 100;
}

/**
 * Parse one binary frame into ticks.
 *
 * Frame layout: a 2-byte count, then for each packet a 2-byte length followed
 * by that many bytes. Packet size determines the mode — 8 bytes is LTP only,
 * 44 adds OHLC and volume, 184 adds market depth.
 *
 * Returns [] for heartbeats (single-byte frames) and for anything malformed:
 * a bad frame must not take down the stream.
 */
export function parseTickerFrame(buffer) {
  if (!buffer || buffer.length < 2) return [];   // heartbeat
  const ticks = [];
  let offset = 0;

  const count = buffer.readInt16BE(offset);
  offset += 2;
  if (count <= 0) return [];

  for (let i = 0; i < count; i++) {
    if (offset + 2 > buffer.length) break;
    const length = buffer.readInt16BE(offset);
    offset += 2;
    if (length <= 0 || offset + length > buffer.length) break;

    const packet = buffer.subarray(offset, offset + length);
    offset += length;

    const tick = parsePacket(packet);
    if (tick) ticks.push(tick);
  }
  return ticks;
}

function parsePacket(packet) {
  if (packet.length < 8) return null;

  const instrumentToken = packet.readInt32BE(0);
  const d = divisorFor(instrumentToken);
  const price = at => packet.readInt32BE(at) / d;

  const tick = {
    instrumentToken,
    lastPrice: price(4),
    mode: 'ltp',
  };

  // 28 and 32-byte packets are index ticks: they carry OHLC but no volume or
  // order book, so they must not be read with the equity offsets.
  if (packet.length === 28 || packet.length === 32) {
    tick.mode = 'index';
    tick.high = price(8);
    tick.low = price(12);
    tick.open = price(16);
    tick.close = price(20);
    return tick;
  }

  if (packet.length >= 44) {
    tick.mode = packet.length >= 184 ? 'full' : 'quote';
    tick.lastQuantity = packet.readInt32BE(8);
    tick.averagePrice = price(12);
    tick.volume = packet.readInt32BE(16);
    tick.totalBuyQuantity = packet.readInt32BE(20);
    tick.totalSellQuantity = packet.readInt32BE(24);
    tick.open = price(28);
    tick.high = price(32);
    tick.low = price(36);
    tick.close = price(40);

    // `close` is the previous session's close, which is what a day change is
    // measured against — not the current price.
    if (tick.close > 0) {
      tick.changePct = Math.round(((tick.lastPrice - tick.close) / tick.close) * 10000) / 100;
    }
  }

  if (packet.length >= 184) {
    tick.lastTradeTime = packet.readInt32BE(44);
    tick.oi = packet.readInt32BE(48);
    tick.exchangeTimestamp = packet.readInt32BE(60);

    // Depth: 10 entries of 12 bytes — 5 bid then 5 ask.
    const depth = { buy: [], sell: [] };
    for (let i = 0; i < 10; i++) {
      const base = 64 + i * 12;
      if (base + 12 > packet.length) break;
      const entry = {
        quantity: packet.readInt32BE(base),
        price: packet.readInt32BE(base + 4) / d,
        orders: packet.readInt16BE(base + 8),
      };
      (i < 5 ? depth.buy : depth.sell).push(entry);
    }
    tick.depth = depth;
  }

  return tick;
}

/**
 * A live ticker connection for one Kite session.
 *
 * Reconnects with exponential backoff. A dropped ticker must not be fatal —
 * the UI keeps its last known prices and the periodic REST refresh still runs,
 * so a reconnect gap degrades freshness rather than breaking the page.
 */
export class KiteTicker {
  constructor({ apiKey, accessToken, onTick, onStatus }) {
    this.apiKey = apiKey;
    this.accessToken = accessToken;
    this.onTick = onTick || (() => {});
    this.onStatus = onStatus || (() => {});
    this.ws = null;
    this.tokens = [];
    this.tokenToSymbol = new Map();
    this.retries = 0;
    this.retryTimer = null;
    this.closedByUs = false;
  }

  connect() {
    this.closedByUs = false;
    const url = `${TICKER_URL}?api_key=${encodeURIComponent(this.apiKey)}&access_token=${encodeURIComponent(this.accessToken)}`;
    this.ws = new WebSocket(url);
    this.ws.binaryType = 'nodebuffer';

    this.ws.on('open', () => {
      this.retries = 0;
      this.onStatus({ connected: true });
      if (this.tokens.length) this.subscribe(this.tokens);
    });

    this.ws.on('message', data => {
      // Text frames are JSON control messages (errors, order updates); binary
      // frames are ticks.
      if (typeof data === 'string') return this.handleText(data);
      if (Buffer.isBuffer(data) && data.length <= 2) return;      // heartbeat
      try {
        const ticks = parseTickerFrame(data);
        if (ticks.length) {
          for (const t of ticks) t.symbol = this.tokenToSymbol.get(t.instrumentToken) || null;
          this.onTick(ticks.filter(t => t.symbol));
        }
      } catch (err) {
        this.onStatus({ error: `tick parse failed: ${err.message}` });
      }
    });

    this.ws.on('close', () => {
      this.onStatus({ connected: false });
      if (!this.closedByUs) this.scheduleReconnect();
    });

    this.ws.on('error', err => {
      this.onStatus({ connected: false, error: err.message });
      // 'close' always follows 'error', so reconnection is scheduled there.
    });
  }

  handleText(raw) {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'error') this.onStatus({ error: msg.data });
    } catch { /* non-JSON control frame — nothing to do */ }
  }

  scheduleReconnect() {
    clearTimeout(this.retryTimer);
    // Backoff caps at 30s: Kite rejects rapid reconnects, and hammering it
    // after a credential failure would just get the key throttled.
    const delay = Math.min(30000, 1000 * 2 ** this.retries);
    this.retries++;
    this.onStatus({ connected: false, reconnectingInMs: delay });
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  setUniverse(pairs) {
    this.tokenToSymbol = new Map(pairs.map(([token, symbol]) => [token, symbol]));
    this.tokens = pairs.map(([token]) => token);
    if (this.ws?.readyState === WebSocket.OPEN) this.subscribe(this.tokens);
  }

  subscribe(tokens) {
    if (!tokens.length || this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ a: 'subscribe', v: tokens }));
    // "quote" rather than "full": the extra 140 bytes per tick is market depth,
    // which the picks board does not draw. "ltp" would be smaller still but
    // omits volume and the previous close, so day change could not be computed.
    this.ws.send(JSON.stringify({ a: 'mode', v: ['quote', tokens] }));
  }

  close() {
    this.closedByUs = true;
    clearTimeout(this.retryTimer);
    this.ws?.close();
    this.ws = null;
  }
}

/** Resolve symbols to instrument tokens, dropping any Kite does not know. */
export async function resolveInstrumentTokens(sessionToken, symbols) {
  const pairs = [];
  for (const symbol of symbols) {
    const token = await getInstrumentToken(sessionToken, symbol).catch(() => null);
    if (token) pairs.push([token, symbol]);
  }
  return pairs;
}
