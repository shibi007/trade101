/**
 * Tests for the Kite ticker binary parser.
 *
 * The wire format is fixed-offset binary with no self-description: a wrong
 * offset yields a plausible number rather than an error, so these build frames
 * byte by byte and assert the decoded values.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseTickerFrame } from '../server/services/kiteTicker.js';

const NSE_CM = 1;                       // segment lives in the low byte
const token = (id, segment = NSE_CM) => (id << 8) | segment;

/** Build a frame from raw packet buffers, with the count/length headers. */
function frame(packets) {
  const parts = [Buffer.alloc(2)];
  parts[0].writeInt16BE(packets.length, 0);
  for (const p of packets) {
    const len = Buffer.alloc(2);
    len.writeInt16BE(p.length, 0);
    parts.push(len, p);
  }
  return Buffer.concat(parts);
}

function ltpPacket(instrumentToken, paise) {
  const b = Buffer.alloc(8);
  b.writeInt32BE(instrumentToken, 0);
  b.writeInt32BE(paise, 4);
  return b;
}

function quotePacket(instrumentToken, fields) {
  const b = Buffer.alloc(44);
  b.writeInt32BE(instrumentToken, 0);
  b.writeInt32BE(fields.lastPrice, 4);
  b.writeInt32BE(fields.lastQuantity ?? 0, 8);
  b.writeInt32BE(fields.averagePrice ?? 0, 12);
  b.writeInt32BE(fields.volume ?? 0, 16);
  b.writeInt32BE(fields.totalBuyQuantity ?? 0, 20);
  b.writeInt32BE(fields.totalSellQuantity ?? 0, 24);
  b.writeInt32BE(fields.open ?? 0, 28);
  b.writeInt32BE(fields.high ?? 0, 32);
  b.writeInt32BE(fields.low ?? 0, 36);
  b.writeInt32BE(fields.close ?? 0, 40);
  return b;
}

// ---------- framing ----------

test('parses a single LTP packet', () => {
  const ticks = parseTickerFrame(frame([ltpPacket(token(738561), 285050)]));
  assert.equal(ticks.length, 1);
  assert.equal(ticks[0].instrumentToken, token(738561));
  assert.equal(ticks[0].lastPrice, 2850.5, 'paise must be divided by 100');
  assert.equal(ticks[0].mode, 'ltp');
});

test('parses several packets in one frame', () => {
  const ticks = parseTickerFrame(frame([
    ltpPacket(token(1), 10000),
    ltpPacket(token(2), 20050),
    ltpPacket(token(3), 30099),
  ]));
  assert.equal(ticks.length, 3);
  assert.deepEqual(ticks.map(t => t.lastPrice), [100, 200.5, 300.99]);
});

test('a heartbeat yields no ticks', () => {
  assert.deepEqual(parseTickerFrame(Buffer.alloc(1)), []);
  assert.deepEqual(parseTickerFrame(Buffer.alloc(0)), []);
  assert.deepEqual(parseTickerFrame(null), []);
});

test('a zero-count frame yields no ticks', () => {
  const b = Buffer.alloc(2);
  b.writeInt16BE(0, 0);
  assert.deepEqual(parseTickerFrame(b), []);
});

// ---------- quote mode ----------

test('parses a full quote packet', () => {
  const ticks = parseTickerFrame(frame([quotePacket(token(408065), {
    lastPrice: 162025, lastQuantity: 10, averagePrice: 161500, volume: 1234567,
    totalBuyQuantity: 5000, totalSellQuantity: 4000,
    open: 160000, high: 163000, low: 159500, close: 160500,
  })]));

  const t = ticks[0];
  assert.equal(t.mode, 'quote');
  assert.equal(t.lastPrice, 1620.25);
  assert.equal(t.volume, 1234567);
  assert.equal(t.open, 1600);
  assert.equal(t.high, 1630);
  assert.equal(t.low, 1595);
  assert.equal(t.close, 1605);
  assert.equal(t.totalBuyQuantity, 5000);
  assert.equal(t.totalSellQuantity, 4000);
});

test('day change is measured against the previous close, not the open', () => {
  // Open 1600, close (previous session) 1605, now 1620.25 -> +0.95%
  const t = parseTickerFrame(frame([quotePacket(token(1), {
    lastPrice: 162025, open: 160000, high: 163000, low: 159500, close: 160500,
  })]))[0];
  assert.equal(t.changePct, 0.95);
});

test('a negative day change is reported', () => {
  const t = parseTickerFrame(frame([quotePacket(token(1), {
    lastPrice: 99000, open: 100000, high: 100500, low: 98000, close: 100000,
  })]))[0];
  assert.equal(t.changePct, -1);
});

test('a zero previous close does not produce Infinity', () => {
  const t = parseTickerFrame(frame([quotePacket(token(1), { lastPrice: 100, close: 0 })]))[0];
  assert.equal(t.changePct, undefined, 'no close means no meaningful day change');
});

// ---------- segment price scaling ----------

test('currency ticks use the currency divisor', () => {
  // Segment 7 (BCD) scales by 1e7, not 100 — decoding it as equity would
  // report a price 100000x too high.
  const ticks = parseTickerFrame(frame([ltpPacket(token(12345, 7), 831500000)]));
  assert.equal(ticks[0].lastPrice, 83.15);
});

test('equity and currency in one frame each scale correctly', () => {
  const ticks = parseTickerFrame(frame([
    ltpPacket(token(1, 1), 285050),        // equity -> 2850.50
    ltpPacket(token(2, 7), 831500000),     // currency -> 83.15
  ]));
  assert.deepEqual(ticks.map(t => t.lastPrice), [2850.5, 83.15]);
});

// ---------- index packets ----------

test('index packets are not read with equity offsets', () => {
  // A 28-byte index packet has OHLC where a quote packet has quantity fields.
  // Reading it as a quote would report a volume that is really a price.
  const b = Buffer.alloc(28);
  b.writeInt32BE(token(256265), 0);
  b.writeInt32BE(2150050, 4);    // last price
  b.writeInt32BE(2160000, 8);    // high
  b.writeInt32BE(2140000, 12);   // low
  b.writeInt32BE(2145000, 16);   // open
  b.writeInt32BE(2148000, 20);   // close

  const t = parseTickerFrame(frame([b]))[0];
  assert.equal(t.mode, 'index');
  assert.equal(t.lastPrice, 21500.5);
  assert.equal(t.high, 21600);
  assert.equal(t.low, 21400);
  assert.equal(t.volume, undefined, 'an index has no traded volume');
});

// ---------- robustness ----------

test('a truncated packet does not throw or emit garbage', () => {
  const good = ltpPacket(token(1), 10000);
  const raw = frame([good, good]);
  // Chop the last packet mid-body, as a partial network frame would.
  const truncated = raw.subarray(0, raw.length - 4);
  const ticks = parseTickerFrame(truncated);
  assert.equal(ticks.length, 1, 'the intact packet should still be delivered');
  assert.equal(ticks[0].lastPrice, 100);
});

test('a lying packet count does not over-read the buffer', () => {
  const b = Buffer.concat([Buffer.alloc(2), Buffer.alloc(2), ltpPacket(token(1), 10000)]);
  b.writeInt16BE(99, 0);    // claims 99 packets
  b.writeInt16BE(8, 2);
  const ticks = parseTickerFrame(b);
  assert.equal(ticks.length, 1, 'stops at the end of the buffer rather than reading past it');
});

test('a packet too short to hold a token is skipped', () => {
  const ticks = parseTickerFrame(frame([Buffer.alloc(4)]));
  assert.deepEqual(ticks, []);
});
