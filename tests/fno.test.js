/**
 * Tests for the F&O-only universe rule.
 *
 * Lot sizes and tokens in the fixture are invented test values in Kite's NFO
 * dump layout — not real contract specifications.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseFnoInstruments } from '../server/services/kiteService.js';
import { UNIVERSE, filterToFno, generateInsights } from '../server/services/insightsEngine.js';
import { scanMarket } from '../server/services/marketScanner.js';

const HEADER = 'instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,strike,tick_size,lot_size,instrument_type,segment,exchange';
const row = (sym, name, expiry, lot, type = 'FUT', segment = 'NFO-FUT', strike = 0) =>
  `1,1,${sym},"${name}",0,${expiry},${strike},0.05,${lot},${type},${segment},NFO`;

const CSV = [
  HEADER,
  // Two expiries for RELIANCE with different lots: the near month must win.
  row('RELIANCE26NOVFUT', 'RELIANCE', '2026-11-26', 600),
  row('RELIANCE26OCTFUT', 'RELIANCE', '2026-10-29', 500),
  // Ampersand symbol, as Kite writes it.
  row('M&M26OCTFUT', 'M&M', '2026-10-29', 200),
  // Options alone must not count — every F&O stock also lists futures.
  row('OPTONLY26OCT100CE', 'OPTONLY', '2026-10-29', 100, 'CE', 'NFO-OPT', 100),
  // An index future: harmless, it matches no equity symbol.
  row('NIFTY26OCTFUT', 'NIFTY', '2026-10-29', 75),
].join('\n');

// ---------- parsing the NFO master ----------

test('parses futures underlyings with their lot size', () => {
  const m = parseFnoInstruments(CSV);
  assert.equal(m.get('M&M').lotSize, 200);
  assert.ok(m.has('NIFTY'));
});

test('takes the lot size from the nearest expiry', () => {
  // Exchanges revise lots on a new expiry first; the near month is what trades.
  assert.deepEqual(parseFnoInstruments(CSV).get('RELIANCE'), { lotSize: 500, expiry: '2026-10-29' });
});

test('an options-only symbol is not counted as F&O', () => {
  assert.equal(parseFnoInstruments(CSV).has('OPTONLY'), false);
});

test('tolerates CRLF line endings and blank lines', () => {
  const crlf = CSV.split('\n').join('\r\n') + '\r\n\r\n';
  assert.equal(parseFnoInstruments(crlf).get('M&M').lotSize, 200);
});

test('a quoted name containing a comma does not shift the columns', () => {
  const csv = [HEADER, '1,1,ODD26OCTFUT,"ODD, LTD",0,2026-10-29,0,0.05,300,FUT,NFO-FUT,NFO'].join('\n');
  assert.equal(parseFnoInstruments(csv).get('ODD, LTD').lotSize, 300);
});

test('an unrecognised layout parses to nothing rather than garbage', () => {
  assert.equal(parseFnoInstruments('a,b,c\n1,2,3').size, 0);
  assert.equal(parseFnoInstruments('').size, 0);
  assert.equal(parseFnoInstruments(null).size, 0);
});

// ---------- applying the rule ----------

const uni = [
  { symbol: 'RELIANCE', fno: true },
  { symbol: 'M&M', fno: true },
  { symbol: 'CASHONLY', fno: false },
];

test('live NFO data decides membership and supplies lot sizes', () => {
  const r = filterToFno(uni, parseFnoInstruments(CSV));
  assert.equal(r.source, 'KITE_NFO');
  assert.deepEqual(r.included.map(s => s.symbol), ['RELIANCE', 'M&M']);
  assert.deepEqual(r.excluded, ['CASHONLY']);
  assert.equal(r.included[0].lotSize, 500);
});

test('live data overrides a stale static flag in both directions', () => {
  // Static says CASHONLY is out and RELIANCE in; the exchange list says the
  // opposite. The exchange wins.
  const live = new Map([['CASHONLY', { lotSize: 900, expiry: '2026-10-29' }]]);
  const r = filterToFno(uni, live);
  assert.deepEqual(r.included.map(s => s.symbol), ['CASHONLY']);
  assert.ok(r.excluded.includes('RELIANCE'));
});

test('without Kite, static flags apply and lot size is left unknown', () => {
  const r = filterToFno(uni, null);
  assert.equal(r.source, 'STATIC');
  assert.deepEqual(r.included.map(s => s.symbol), ['RELIANCE', 'M&M']);
  assert.equal(r.included[0].lotSize, null, 'a guessed lot would size real positions');
});

test('an empty live list fails open to the static flags', () => {
  const r = filterToFno(uni, new Map());
  assert.equal(r.source, 'STATIC');
  assert.equal(r.included.length, 2);
});

test('a live list matching none of the universe fails open too', () => {
  // A symbol-format change in the dump, not every large-cap leaving F&O.
  const r = filterToFno(uni, new Map([['SOMETHINGELSE', { lotSize: 1, expiry: '2026-10-29' }]]));
  assert.equal(r.source, 'STATIC');
  assert.equal(r.included.length, 2);
});

test('the shipped universe is entirely F&O and drops the dead TATAMOTORS symbol', () => {
  assert.ok(UNIVERSE.every(s => s.fno === true));
  assert.ok(!UNIVERSE.some(s => s.symbol === 'TATAMOTORS'));
});

test('insights report the rule, its source, and what was excluded', async () => {
  const r = await generateInsights(null, null);
  assert.equal(r.universeFilter.rule, 'FNO_ONLY');
  assert.equal(r.universeFilter.source, 'STATIC');
  assert.equal(r.universeFilter.included, r.universe.length);
  for (const p of r.picks) assert.ok('lotSize' in p);
});

// ---------- whole-market scanner ----------

const quote = price => ({
  last_price: price, volume: 5_000_000, average_price: price,
  ohlc: { open: price * 0.99, high: price * 1.02, low: price * 0.98, close: price * 0.99 },
  depth: { buy: [{ price: price - 0.05 }], sell: [{ price: price + 0.05 }] },
});
const quotes = { 'NSE:RELIANCE': quote(1400), 'NSE:CASHONLY': quote(500) };

test('scanMarket keeps only F&O stocks when given the list', () => {
  const r = scanMarket(quotes, { fnoSymbols: new Set(['RELIANCE']) });
  assert.deepEqual(r.all.map(s => s.symbol), ['RELIANCE']);
});

test('scanMarket treats an empty F&O list as unknown, not as nothing', () => {
  const r = scanMarket(quotes, { fnoSymbols: new Set() });
  assert.equal(r.all.length, 2);
});
