/**
 * Tests for the broad market scan.
 *
 * Everything here is a pure function of a quotes object, so the whole tier is
 * testable without a Kite connection or an open market.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_FILTERS,
  indicatorsFromQuote,
  passesLiquidity,
  quoteScore,
  scanMarket,
} from '../server/services/marketScanner.js';

/** A Kite-shaped quote. `ohlc.close` is the PREVIOUS session's close. */
function quote(o = {}) {
  const last = o.last_price ?? 100;
  return {
    last_price: last,
    average_price: o.average_price ?? last,
    volume: o.volume ?? 10_000_000,
    buy_quantity: o.buy_quantity ?? 1000,
    sell_quantity: o.sell_quantity ?? 1000,
    ohlc: { open: o.open ?? 100, high: o.high ?? 102, low: o.low ?? 98, close: o.close ?? 100 },
    upper_circuit_limit: o.upper_circuit_limit ?? last * 1.2,
    lower_circuit_limit: o.lower_circuit_limit ?? last * 0.8,
    depth: o.depth ?? { buy: [{ price: last - 0.05 }], sell: [{ price: last + 0.05 }] },
    ...o.extra,
  };
}

// ---------- indicatorsFromQuote ----------

test('day change is measured against the previous close', () => {
  // Kite puts the previous close in ohlc.close; reading it as today's close
  // would make every change read as zero.
  const ind = indicatorsFromQuote('TEST', quote({ last_price: 110, close: 100 }));
  assert.equal(ind.changePct, 10);
});

test('gap is the open against the previous close', () => {
  const ind = indicatorsFromQuote('TEST', quote({ last_price: 105, open: 102, close: 100 }));
  assert.equal(ind.gapPct, 2);
});

test('range position places price between the day low and high', () => {
  const ind = indicatorsFromQuote('TEST', quote({ last_price: 110, high: 110, low: 100, close: 100 }));
  assert.equal(ind.rangePosition, 100);
  const mid = indicatorsFromQuote('TEST', quote({ last_price: 105, high: 110, low: 100, close: 100 }));
  assert.equal(mid.rangePosition, 50);
});

test('turnover is price times volume, not volume alone', () => {
  // A million shares of a ₹20 stock is not the same market as a million of a
  // ₹3000 one; the liquidity gate depends on this.
  const ind = indicatorsFromQuote('TEST', quote({ last_price: 500, volume: 100000 }));
  assert.equal(ind.turnover, 5_00_00_000);
});

test('spread comes from the top of the book', () => {
  const ind = indicatorsFromQuote('TEST', quote({
    last_price: 100, depth: { buy: [{ price: 99.5 }], sell: [{ price: 100.5 }] },
  }));
  assert.equal(ind.spreadPct, 1);
});

test('order imbalance is signed toward the heavier side', () => {
  const bid = indicatorsFromQuote('TEST', quote({ buy_quantity: 3000, sell_quantity: 1000 }));
  assert.equal(bid.orderImbalance, 0.5);
  const offer = indicatorsFromQuote('TEST', quote({ buy_quantity: 1000, sell_quantity: 3000 }));
  assert.equal(offer.orderImbalance, -0.5);
});

test('a quote with no usable prices is rejected', () => {
  assert.equal(indicatorsFromQuote('T', null), null);
  assert.equal(indicatorsFromQuote('T', { last_price: 100 }), null, 'no ohlc');
  assert.equal(indicatorsFromQuote('T', quote({ last_price: 0 })), null);
  assert.equal(indicatorsFromQuote('T', quote({ close: 0 })), null, 'zero prev close would divide by zero');
});

test('a flat stock does not produce a divide-by-zero range position', () => {
  const ind = indicatorsFromQuote('TEST', quote({ last_price: 100, high: 100, low: 100 }));
  assert.equal(ind.rangePosition, 50, 'no range means no meaningful position in it');
  assert.equal(ind.rangePct, 0);
});

// ---------- liquidity gate ----------

test('illiquid names are screened out', () => {
  const thin = indicatorsFromQuote('THIN', quote({ last_price: 100, volume: 1000 }));
  assert.equal(passesLiquidity(thin), false, 'a ₹1 lakh turnover cannot absorb a position');
});

test('penny stocks are screened out', () => {
  const penny = indicatorsFromQuote('PENNY', quote({ last_price: 5, volume: 100_000_000, high: 5.5, low: 4.5, close: 5 }));
  assert.equal(passesLiquidity(penny), false);
});

test('wide spreads are screened out', () => {
  const wide = indicatorsFromQuote('WIDE', quote({
    last_price: 100, volume: 10_000_000,
    depth: { buy: [{ price: 99 }], sell: [{ price: 101 }] },   // 2% spread
  }));
  assert.equal(passesLiquidity(wide), false);
});

test('a stock that has barely moved is screened out', () => {
  const still = indicatorsFromQuote('STILL', quote({
    last_price: 100, volume: 10_000_000, high: 100.1, low: 99.95, close: 100,
  }));
  assert.equal(passesLiquidity(still), false, 'no range means no intraday setup');
});

test('missing depth does not disqualify a liquid stock', () => {
  // Rejecting on absent data would drop everything when depth is not returned.
  const noDepth = indicatorsFromQuote('OK', quote({
    last_price: 500, volume: 1_000_000, high: 510, low: 495, close: 500, extra: { depth: undefined },
  }));
  noDepth.spreadPct = null;
  assert.equal(passesLiquidity(noDepth), true);
});

test('a genuinely liquid mover passes', () => {
  const good = indicatorsFromQuote('GOOD', quote({
    last_price: 500, volume: 5_000_000, high: 510, low: 495, close: 500,
  }));
  assert.equal(passesLiquidity(good), true);
});

// ---------- quoteScore ----------

test('relative strength is measured against the market, not zero', () => {
  const ind = indicatorsFromQuote('LAG', quote({ last_price: 100.5, close: 100 }));
  const scored = quoteScore(ind, 2.0);
  assert.equal(scored.relStrength, -1.5, 'up 0.5% in a market up 2% is lagging');
  assert.equal(scored.direction, 'SHORT');
});

test('near the day high only helps when the stock is strong', () => {
  const strongHigh = quoteScore(indicatorsFromQuote('A', quote({ last_price: 110, high: 110, low: 100, close: 100 })), 0);
  // Same position in range, but the stock is weak relative to a strong market.
  const weakHigh = quoteScore(indicatorsFromQuote('B', quote({ last_price: 110, high: 110, low: 100, close: 100 })), 20);
  assert.ok(strongHigh.score > weakHigh.score, 'near the high while lagging is not a long signal');
});

test('circuit proximity is penalised', () => {
  const normal = quoteScore(indicatorsFromQuote('N', quote({ last_price: 100, close: 95, high: 101, low: 94 })), 0);
  const nearCircuit = quoteScore(indicatorsFromQuote('C', quote({
    last_price: 100, close: 95, high: 101, low: 94,
    upper_circuit_limit: 100.5, lower_circuit_limit: 80,
  })), 0);
  assert.ok(nearCircuit.score < normal.score);
  assert.ok(nearCircuit.reasons.some(r => r.includes('circuit')));
});

test('scores stay within 0-100', () => {
  const maxed = quoteScore(indicatorsFromQuote('M', quote({
    last_price: 120, close: 100, open: 115, high: 120, low: 100,
    average_price: 110, volume: 100_000_000, buy_quantity: 9000, sell_quantity: 100,
  })), 0);
  assert.ok(maxed.score >= 0 && maxed.score <= 100, `got ${maxed.score}`);
});

// ---------- scanMarket ----------

test('scanMarket separates scanned from liquid', () => {
  const quotes = {
    'NSE:GOOD': quote({ last_price: 500, volume: 5_000_000, high: 510, low: 495, close: 500 }),
    'NSE:THIN': quote({ last_price: 100, volume: 500 }),
    'NSE:PENNY': quote({ last_price: 3, volume: 100_000_000, high: 3.3, low: 2.8, close: 3 }),
  };
  const r = scanMarket(quotes);
  assert.equal(r.scanned, 3);
  assert.equal(r.liquid, 1, 'only the liquid mover survives the gate');
  assert.equal(r.candidates[0].symbol, 'GOOD');
});

test('the NSE: prefix is stripped from symbols', () => {
  const r = scanMarket({ 'NSE:RELIANCE': quote({ last_price: 2850, volume: 5_000_000, high: 2900, low: 2800, close: 2850 }) });
  assert.equal(r.candidates[0].symbol, 'RELIANCE');
});

test('market change is the median, not the mean', () => {
  // One circuit-locked +20% mover must not drag the benchmark every other
  // stock's relative strength is measured against.
  const mk = (sym, last, close) => [`NSE:${sym}`, quote({
    last_price: last, close, volume: 5_000_000, high: last * 1.02, low: last * 0.98,
  })];
  const quotes = Object.fromEntries([
    mk('A', 100, 100), mk('B', 101, 100), mk('C', 102, 100), mk('D', 120, 100),
  ]);
  const r = scanMarket(quotes);
  assert.equal(r.marketChangePct, 1.5, 'median of [0,1,2,20] is 1.5; the mean would be 5.75');
});

test('candidates are capped and ranked', () => {
  const quotes = {};
  for (let i = 0; i < 60; i++) {
    quotes[`NSE:S${i}`] = quote({
      last_price: 500, close: 500 - i, volume: 5_000_000, high: 510, low: 495,
    });
  }
  const r = scanMarket(quotes, { limit: 10 });
  assert.equal(r.candidates.length, 10);
  const scores = r.candidates.map(c => c.score);
  assert.deepEqual([...scores].sort((a, b) => b - a), scores, 'must be ranked');
});

test('an empty or malformed market does not throw', () => {
  assert.equal(scanMarket({}).liquid, 0);
  assert.equal(scanMarket(null).scanned, 0);
  assert.equal(scanMarket({ 'NSE:X': null }).scanned, 0);
});

test('breadth counts only the tradeable names', () => {
  const mk = (sym, last, close, volume) => [`NSE:${sym}`, quote({
    last_price: last, close, volume, high: last * 1.02, low: last * 0.98,
  })];
  const r = scanMarket(Object.fromEntries([
    mk('UP', 110, 100, 5_000_000),
    mk('DOWN', 90, 100, 5_000_000),
    mk('ILLIQUID', 150, 100, 100),   // huge move, untradeable
  ]));
  assert.equal(r.breadth.advances, 1);
  assert.equal(r.breadth.declines, 1);
  assert.equal(r.liquid, 2, 'the illiquid mover must not count toward breadth');
});
