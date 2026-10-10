/**
 * Tests for the insights scoring pipeline.
 *
 * Run with `npm test` (node:test, no test framework dependency).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_PICK_LIMIT,
  EDGE_BOUND,
  UNIVERSE,
  buildPick,
  buildUniverseContext,
  computeIndicators,
  computeMACD,
  maDistancePct,
  prior52Range,
  orbCandlesSinceBreak,
  intradayPlan,
  entryWindow,
  INTRADAY_ROUND_TRIP_COST,
  generateInsights,
  generateIntradaySeries,
  normalisePinned,
  scoreStock,
  volatilityFit,
} from '../server/services/insightsEngine.js';

/** A neutral indicator set; override only the fields a test cares about. */
function ind(overrides = {}) {
  return {
    ltp: 1000, changePct: 0, momentum30m: 0, relVolume: 1.0,
    orbStatus: 'INSIDE', aboveVwap: true, gapPct: 0, rangePosition: 50,
    atr: 5, atrPct: 0.5, sma20: null, sma50: null,
    orderImbalance: null, spreadPct: null, circuitHeadroomPct: null,
    eventToday: null,
    ...overrides,
  };
}

/** A context whose market is flat and whose ATR band comfortably contains 0.5%. */
function context(overrides = {}) {
  return {
    marketChangePct: 0,
    medianAtrPct: 0.5,
    atrBand: { low: 0.25, high: 0.9 },
    relStrength: { mean: 0, sd: 1 },
    relVolume: { mean: 1.0, sd: 0.2 },
    ...overrides,
  };
}

// ---------- volatilityFit ----------

test('volatilityFit is 1 inside the band', () => {
  const band = { low: 0.25, high: 0.9 };
  assert.equal(volatilityFit(0.25, band), 1);
  assert.equal(volatilityFit(0.5, band), 1);
  assert.equal(volatilityFit(0.9, band), 1);
});

test('volatilityFit decays linearly outside the band', () => {
  // Band width 0.5; half a width below the low edge -> 0.5
  const band = { low: 1.0, high: 1.5 };
  assert.equal(volatilityFit(0.75, band), 0.5);
  assert.equal(volatilityFit(1.75, band), 0.5);
});

test('volatilityFit floors at zero beyond a full band width', () => {
  const band = { low: 1.0, high: 1.5 };
  assert.equal(volatilityFit(0.1, band), 0);
  assert.equal(volatilityFit(9.0, band), 0);
});

test('volatilityFit penalises both tails, not just the quiet one', () => {
  const band = { low: 1.0, high: 1.5 };
  assert.ok(volatilityFit(1.25, band) > volatilityFit(0.6, band));
  assert.ok(volatilityFit(1.25, band) > volatilityFit(1.9, band));
});

test('volatilityFit tolerates a degenerate band', () => {
  assert.equal(volatilityFit(1.0, { low: 1, high: 1 }), 1);
});

// ---------- buildUniverseContext ----------

test('marketChangePct is the universe mean', () => {
  const ctx = buildUniverseContext([
    ind({ changePct: 1.0 }), ind({ changePct: 2.0 }), ind({ changePct: 3.0 }),
  ]);
  assert.equal(ctx.marketChangePct, 2.0);
});

test('ATR band is anchored to the universe median, not fixed percentages', () => {
  // Median of [0.2, 0.4, 0.6] is 0.4 -> band [0.2, 0.72]
  const ctx = buildUniverseContext([
    ind({ atrPct: 0.2 }), ind({ atrPct: 0.4 }), ind({ atrPct: 0.6 }),
  ]);
  assert.equal(ctx.medianAtrPct, 0.4);
  assert.equal(ctx.atrBand.low, 0.2);
  assert.equal(ctx.atrBand.high, 0.72);
});

test('band scales with the universe rather than assuming a timeframe', () => {
  // Daily-scale ATR% (~2%) and 5-min-scale (~0.5%) must both produce a band
  // that contains their own median — the point of anchoring to the data.
  const daily = buildUniverseContext([ind({ atrPct: 1.5 }), ind({ atrPct: 2.5 })]);
  const fiveMin = buildUniverseContext([ind({ atrPct: 0.4 }), ind({ atrPct: 0.6 })]);
  assert.ok(daily.atrBand.low <= 2.0 && 2.0 <= daily.atrBand.high);
  assert.ok(fiveMin.atrBand.low <= 0.5 && 0.5 <= fiveMin.atrBand.high);
});

// ---------- relative strength: the core fix ----------

test('a stock lagging a strong market is not scored as strong', () => {
  // Market up 2%; this stock is up only 0.5%, so it is underperforming by 1.5%
  // despite a positive day change. The old absolute test scored this long.
  const laggard = ind({ changePct: 0.5, aboveVwap: true });
  const scored = scoreStock(laggard, context({ marketChangePct: 2.0 }));

  assert.equal(scored.relStrength, -1.5);
  assert.ok(
    !scored.reasons.some(r => r.includes('outperforming')),
    'must not credit a laggard with outperformance',
  );
});

test('a stock leading a weak market is credited', () => {
  // Market down 2%; this stock is only down 0.5%, i.e. relative strength +1.5%.
  const leader = ind({ changePct: -0.5, aboveVwap: true });
  const scored = scoreStock(leader, context({ marketChangePct: -2.0 }));

  assert.equal(scored.relStrength, 1.5);
  assert.ok(scored.reasons.some(r => r.includes('outperforming')));
});

test('the same day change scores differently in different markets', () => {
  const stock = ind({ changePct: 1.0, aboveVwap: true });
  const strongMarket = scoreStock(stock, context({ marketChangePct: 3.0 }));
  const weakMarket = scoreStock(stock, context({ marketChangePct: -3.0 }));

  assert.ok(
    weakMarket.score > strongMarket.score,
    'up 1% should be worth more when the market is down than when it is up 3%',
  );
});

test('volume surge confirms the relative move, not the absolute one', () => {
  // Up 1% but the market is up 3%: the surge is distribution, so it should
  // support the short side rather than the long.
  const stock = ind({ changePct: 1.0, relVolume: 2.0, aboveVwap: false });
  const scored = scoreStock(stock, context({ marketChangePct: 3.0 }));
  assert.equal(scored.direction, 'SHORT');
});

// ---------- rank score and tie-breaking ----------

test('rankScore breaks ties that score alone cannot', () => {
  const ctx = context({ relStrength: { mean: 0, sd: 2 } });
  const strong = scoreStock(ind({ changePct: 4.0, orbStatus: 'BREAKOUT_UP' }), ctx);
  const weak = scoreStock(ind({ changePct: 0.5, orbStatus: 'BREAKOUT_UP' }), ctx);

  assert.equal(strong.score, weak.score, 'precondition: identical discrete score');
  assert.ok(strong.rankScore > weak.rankScore, 'rankScore must separate them');
});

/** Seeded random stocks spanning every signal, for property tests. */
function randomUniverse(n, seed = 7) {
  let s = seed;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const pick = a => a[Math.floor(rnd() * a.length)];
  return Array.from({ length: n }, () => {
    const ltp = 100 + rnd() * 2000;
    const hasMA = rnd() > 0.3;
    const hasMACD = rnd() > 0.2;
    return ind({
      ltp, changePct: (rnd() - 0.5) * 8, momentum30m: (rnd() - 0.5) * 2,
      relVolume: 0.5 + rnd() * 2.5, orbStatus: pick(['INSIDE', 'BREAKOUT_UP', 'BREAKOUT_DOWN']),
      aboveVwap: rnd() > 0.5, gapPct: (rnd() - 0.5) * 3, rangePosition: rnd() * 100,
      atrPct: 0.1 + rnd() * 1.5,
      spreadPct: rnd() > 0.85 ? 0.3 : null,
      sma20: hasMA ? ltp * (0.9 + rnd() * 0.2) : null,
      sma50: hasMA ? ltp * (0.85 + rnd() * 0.3) : null,
      macd: hasMACD ? {
        histogram: (rnd() - 0.5) * 4, histogramPct: (rnd() - 0.5) * 0.3,
        expanding: rnd() > 0.5, crossedRecently: rnd() > 0.8,
      } : null,
      macdTimeframe: hasMACD ? pick(['5m', '1d']) : null,
      // Some stocks sit beyond their 52-week range so the breakout signal is
      // exercised by the rank-ordering property tests too.
      prior52High: rnd() > 0.5 ? ltp * (0.97 + rnd() * 0.06) : null,
      prior52Low: rnd() > 0.5 ? ltp * (0.94 + rnd() * 0.06) : null,
    });
  });
}

test('rankScore never ranks a higher score below a lower one', () => {
  // The edge exists to order ties, nothing more. An earlier ±7 bound broke
  // this: two stocks 10 apart swapped on opposite 7-point edges, and a random
  // universe produced hundreds of inverted pairs. Checked exhaustively over
  // every pair rather than one hand-picked case, which is how that bug passed.
  const stocks = randomUniverse(300);
  const ctx = buildUniverseContext(stocks);
  const scored = stocks.map(i => scoreStock(i, ctx));

  let inversions = 0;
  for (const a of scored) {
    for (const b of scored) {
      if (a.score > b.score && a.rankScore <= b.rankScore) inversions++;
    }
  }
  assert.equal(inversions, 0);
});

test('rankScore stays within EDGE_BOUND of the score, including at 0 and 100', () => {
  const stocks = randomUniverse(300, 11);
  const ctx = buildUniverseContext(stocks);
  for (const i of stocks) {
    const s = scoreStock(i, ctx);
    assert.ok(Math.abs(s.rankScore - s.score) <= EDGE_BOUND + 1e-9,
      `score ${s.score} rank ${s.rankScore}`);
  }
  assert.ok(EDGE_BOUND < 0.5, 'two opposite edges must shift a pair by under one point');
});

test('rankScore still breaks ties among stocks pinned at 0', () => {
  // A clamp to 0-100 would flatten every floored stock to exactly 0.
  const ctx = context({ relStrength: { mean: 0, sd: 1 } });
  const bad = { spreadPct: 5, circuitHeadroomPct: 0.1 };
  const a = scoreStock(ind({ ...bad, changePct: 3 }), ctx);
  const b = scoreStock(ind({ ...bad, changePct: -3 }), ctx);
  assert.equal(a.score, 0);
  assert.equal(b.score, 0);
  assert.notEqual(a.rankScore, b.rankScore);
});

// ---------- volatility gating ----------

test('a stock far outside the volatility band is penalised', () => {
  const ctx = context({ atrBand: { low: 0.4, high: 0.8 } });
  const normal = scoreStock(ind({ atrPct: 0.6, orbStatus: 'BREAKOUT_UP' }), ctx);
  const wild = scoreStock(ind({ atrPct: 1.4, orbStatus: 'BREAKOUT_UP' }), ctx);

  assert.ok(wild.score < normal.score);
  assert.ok(wild.reasons.some(r => r.includes('volatile')));
});

test('a stock too quiet to place a sane stop is penalised', () => {
  const ctx = context({ atrBand: { low: 0.4, high: 0.8 } });
  const tooQuiet = scoreStock(ind({ atrPct: 0.05, orbStatus: 'BREAKOUT_UP' }), ctx);
  assert.ok(tooQuiet.reasons.some(r => r.includes('quiet')));
});

test('a stock marginally outside the band is not flagged', () => {
  // Penalty rounds to zero here; warning text would be noise next to the name.
  const ctx = context({ atrBand: { low: 0.4, high: 0.8 } });
  const marginal = scoreStock(ind({ atrPct: 0.39, orbStatus: 'BREAKOUT_UP' }), ctx);
  assert.ok(!marginal.reasons.some(r => r.includes('quiet')));
});

// ---------- robustness ----------

test('a uniform universe does not produce NaN scores', () => {
  // Zero variance everywhere: z-scores must degrade to 0, not divide by zero.
  const inds = [ind(), ind(), ind()];
  const ctx = buildUniverseContext(inds);
  for (const i of inds) {
    const s = scoreStock(i, ctx);
    assert.ok(Number.isFinite(s.rankScore), 'rankScore must be finite');
    assert.ok(Number.isFinite(s.score));
  }
});

test('a single-stock universe is handled', () => {
  const ctx = buildUniverseContext([ind({ changePct: 1.0 })]);
  const s = scoreStock(ind({ changePct: 1.0 }), ctx);
  assert.ok(Number.isFinite(s.rankScore));
  assert.equal(s.relStrength, 0, 'a lone stock cannot outperform itself');
});

test('scoreStock still works without a context', () => {
  const s = scoreStock(ind({ changePct: 1.0, aboveVwap: true }));
  assert.ok(Number.isFinite(s.score));
  assert.equal(s.rankScore, s.score, 'no context means no cross-sectional edge');
});

// ---------- end to end ----------

test('generateInsights returns ranked, tie-free picks', async () => {
  const insights = await generateInsights(null, null);

  assert.ok(insights.picks.length <= DEFAULT_PICK_LIMIT);
  assert.ok(insights.context, 'baselines must be exposed');
  assert.equal(typeof insights.context.marketChangePct, 'number');

  const ranks = insights.picks.map(p => p.rankScore);
  assert.deepEqual([...ranks].sort((a, b) => b - a), ranks, 'picks must be sorted');
  assert.equal(new Set(ranks).size, ranks.length, 'picks must not tie');

  for (const p of insights.picks) {
    assert.ok(p.score >= 40, 'cutoff still applies to the displayed score');
  }
});

test('the whole universe is ranked without ties', () => {
  const inds = UNIVERSE.map(s => computeIndicators(generateIntradaySeries(s.symbol, s.ref)));
  const ctx = buildUniverseContext(inds);
  const ranks = inds.map(i => scoreStock(i, ctx).rankScore);

  assert.equal(
    new Set(ranks).size, ranks.length,
    'every stock should get a distinct rank; ties fall back to array order',
  );
});

// ---------- early session: too little data to measure volatility ----------

/** A series with `n` candles, as the first minutes after the open produce. */
function shortSeries(n, price = 1000) {
  return {
    symbol: 'TEST', prevClose: price, open: price,
    candles: Array.from({ length: n }, (_, i) => ({
      t: i, open: price, high: price + 2, low: price - 2, close: price, volume: 1000,
    })),
  };
}

test('a single candle yields a usable ATR, not NaN', () => {
  // Three minutes after the open there is one 5-minute candle. True range needs
  // a previous close, so the ATR loop could not run and divided 0 by 0.
  const ind = computeIndicators(shortSeries(1));
  assert.ok(ind.atr === null || Number.isFinite(ind.atr), `got ${ind.atr}`);
  assert.ok(!Number.isNaN(ind.atr), 'NaN serialises to null and blanks the whole trade plan');
  assert.equal(ind.atr, 4, "one candle's own range is the only range information available");
});

test('atrPct is null rather than NaN when ATR is unknown', () => {
  const ind = computeIndicators(shortSeries(0));
  assert.equal(ind.atr, null);
  assert.equal(ind.atrPct, null, 'a NaN here poisons the universe median and every z-score');
});

test('a zero-range candle is treated as no ATR, not a zero stop', () => {
  const flat = {
    symbol: 'TEST', prevClose: 100, open: 100,
    candles: [{ t: 0, open: 100, high: 100, low: 100, close: 100, volume: 0 }],
  };
  const ind = computeIndicators(flat);
  assert.equal(ind.atr, null, 'a zero range would put the stop exactly at entry');
});

test('buildPick refuses to invent levels without ATR', () => {
  const ind = { ...computeIndicators(shortSeries(0)), ltp: 1000 };
  const scored = scoreStock(ind);
  const pick = buildPick({ symbol: 'TEST', name: 'Test', sector: 'IT' }, ind, scored);

  assert.equal(pick.levelsAvailable, false);
  assert.ok(pick.levelsUnavailableReason, 'must say why, not just blank the fields');
  for (const k of ['stopLoss', 'target1', 'target2', 'riskPerShare']) {
    assert.equal(pick.levels[k], null, `${k} must be explicitly null`);
  }
});

test('a pick with ATR still carries a full plan', () => {
  const ind = { ...computeIndicators(shortSeries(20)), ltp: 1000 };
  const scored = scoreStock(ind);
  const pick = buildPick({ symbol: 'TEST', name: 'Test', sector: 'IT' }, ind, scored);

  assert.equal(pick.levelsAvailable, true);
  assert.ok(pick.levels.stopLoss > 0);
  assert.ok(pick.levels.riskPerShare > 0, 'a zero risk would divide the position size by ~zero');
});

test('no pick ever reports a zero or null risk per share', () => {
  // The position-size formula divides by this. The old floor of 0.01 turned an
  // unknown risk into a six-figure share count on a small account.
  for (const n of [0, 1, 2, 5, 20]) {
    const ind = { ...computeIndicators(shortSeries(n)), ltp: 1000 };
    const pick = buildPick({ symbol: 'T', name: 'T', sector: 'IT' }, ind, scoreStock(ind));
    const r = pick.levels.riskPerShare;
    assert.ok(r === null || r > 0, `${n} candles gave riskPerShare ${r}`);
    if (r === null) assert.equal(pick.levelsAvailable, false, 'null risk must be flagged, not silent');
  }
});

test('a universe with unmeasurable stocks still produces finite scores', () => {
  const inds = [
    computeIndicators(shortSeries(0)),
    computeIndicators(shortSeries(1)),
    computeIndicators(shortSeries(20)),
  ];
  const ctx = buildUniverseContext(inds);
  assert.ok(Number.isFinite(ctx.medianAtrPct), `median was ${ctx.medianAtrPct}`);
  for (const ind of inds) {
    const s = scoreStock(ind, ctx);
    assert.ok(Number.isFinite(s.score), `score ${s.score}`);
    assert.ok(Number.isFinite(s.rankScore), 'a NaN rankScore breaks the sort silently');
  }
});

// ---------- pick limit ----------

test('more than five picks are returned by default', async () => {
  const r = await generateInsights(null, null);
  assert.ok(r.picks.length > 5, `only ${r.picks.length} picks — the old cap of 5 is still in force`);
});

test('the pick limit is configurable and bounded', async () => {
  const three = await generateInsights(null, null, { limit: 3 });
  assert.equal(three.picks.length, 3);

  // Absurd or malformed limits must not return the whole universe or crash.
  const huge = await generateInsights(null, null, { limit: 9999 });
  assert.ok(huge.picks.length <= 50);
  const junk = await generateInsights(null, null, { limit: 'abc' });
  assert.ok(junk.picks.length > 0, 'a bad limit should fall back to the default');
});

test('the score cutoff still governs quality, not the limit', async () => {
  // Raising the limit must never admit a setup that failed the screen.
  const r = await generateInsights(null, null, { limit: 50 });
  for (const p of r.picks) {
    if (!p.pinned) assert.ok(p.score >= 40, `${p.symbol} scored ${p.score}`);
  }
});

// ---------- pinned stocks ----------

test('normalisePinned accepts a comma string or an array', () => {
  assert.deepEqual(normalisePinned('RELIANCE,TCS'), ['RELIANCE', 'TCS']);
  assert.deepEqual(normalisePinned(['RELIANCE', 'TCS']), ['RELIANCE', 'TCS']);
});

test('normalisePinned is case- and whitespace-insensitive', () => {
  assert.deepEqual(normalisePinned(' reliance , TcS '), ['RELIANCE', 'TCS']);
});

test('normalisePinned drops unknown symbols instead of erroring', () => {
  // A stale pin in someone's browser must not break the insights response.
  assert.deepEqual(normalisePinned('RELIANCE,NOTAREALSTOCK'), ['RELIANCE']);
  assert.deepEqual(normalisePinned(''), []);
  assert.deepEqual(normalisePinned(null), []);
  assert.deepEqual(normalisePinned(undefined), []);
});

test('normalisePinned de-duplicates', () => {
  assert.deepEqual(normalisePinned('TCS,TCS,tcs'), ['TCS']);
});

test('a pinned stock appears even when it would not make the cut', async () => {
  const base = await generateInsights(null, null);
  const shown = new Set(base.picks.map(p => p.symbol));
  // Pick a stock the screener left out, so the pin is doing the work.
  const missing = UNIVERSE.map(s => s.symbol).find(s => !shown.has(s));
  assert.ok(missing, 'precondition: some stock is not already picked');

  const pinnedRun = await generateInsights(null, null, { pinned: [missing] });
  const pin = pinnedRun.picks.find(p => p.symbol === missing);

  assert.ok(pin, `${missing} should be on the board once pinned`);
  assert.equal(pin.pinned, true);
  assert.ok(pin.belowCutoff || pin.outsideTop,
    'a pinned stock that was not already shown must be flagged as such');
});

test('pinned stocks sort ahead of unpinned ones', async () => {
  const base = await generateInsights(null, null);
  const shown = new Set(base.picks.map(p => p.symbol));
  const missing = UNIVERSE.map(s => s.symbol).find(s => !shown.has(s));

  const pinnedRun = await generateInsights(null, null, { pinned: [missing] });
  const firstUnpinned = pinnedRun.picks.findIndex(p => !p.pinned);
  const lastPinned = pinnedRun.picks.map(p => p.pinned).lastIndexOf(true);
  assert.ok(lastPinned < firstUnpinned, 'all pinned cards must precede unpinned ones');
});

test('pinning does not evict the ranked picks', async () => {
  const base = await generateInsights(null, null);
  const shown = base.picks.map(p => p.symbol);
  const missing = UNIVERSE.map(s => s.symbol).find(s => !shown.includes(s));

  const pinnedRun = await generateInsights(null, null, { pinned: [missing] });
  const after = pinnedRun.picks.map(p => p.symbol);
  for (const sym of shown) {
    assert.ok(after.includes(sym), `${sym} should still be shown after pinning ${missing}`);
  }
  assert.equal(after.length, shown.length + 1);
});

test('pinning a stock already in the picks does not duplicate it', async () => {
  const base = await generateInsights(null, null);
  assert.ok(base.picks.length, 'precondition: there are picks to pin');
  const existing = base.picks[0].symbol;

  const pinnedRun = await generateInsights(null, null, { pinned: [existing] });
  const hits = pinnedRun.picks.filter(p => p.symbol === existing);
  assert.equal(hits.length, 1, 'pinned stock must appear exactly once');
  assert.equal(hits[0].pinned, true);
  assert.equal(pinnedRun.picks.length, base.picks.length);
});

test('an unpinned run is unchanged by the pinning code path', async () => {
  const a = await generateInsights(null, null);
  const b = await generateInsights(null, null, { pinned: [] });
  assert.deepEqual(a.picks.map(p => p.symbol), b.picks.map(p => p.symbol));
  assert.ok(a.picks.every(p => p.pinned === false));
});

test('stop distance stays proportional to the stock', () => {
  // Regression guard on buildPick's ATR-derived stop: a stop wider than a few
  // percent of price is not an intraday stop.
  const insights = generateInsights(null, null);
  return insights.then(r => {
    for (const p of r.picks) {
      const stopPct = Math.abs(p.levels.referenceEntry - p.levels.stopLoss) / p.ltp * 100;
      assert.ok(stopPct < 5, `${p.symbol} stop is ${stopPct.toFixed(2)}% of price`);
    }
  });
});

// ---------- MACD ----------

/** Wavy, gently rising series: long enough for several crossovers. */
const wave = n => Array.from({ length: n }, (_, i) => 100 + 5 * Math.sin(i / 6) + i * 0.05);

test('MACD matches an independent reference implementation', () => {
  // Expected values from a separate Python implementation of TradingView's
  // ta.ema / ta.macd (SMA-seeded EMA), so a seeding or alignment error here
  // cannot hide by agreeing with itself.
  const m = computeMACD(wave(80));
  assert.equal(m.macd, 0.8842);
  assert.equal(m.signal, -0.0075);
  assert.equal(m.histogram, 0.8917);
});

test('MACD is null until the signal line has warmed up', () => {
  // slow (26) + signal (9) - 1 = 34 closes for the first signal value.
  assert.equal(computeMACD(wave(33)), null);
  assert.notEqual(computeMACD(wave(34)), null);
  assert.equal(computeMACD([]), null);
  assert.equal(computeMACD(null), null);
});

test('histogramPct makes MACD comparable across price levels', () => {
  // The same shape at 10x the price has 10x the rupee histogram but the same
  // percentage one — which is what ranking a universe needs.
  const cheap = computeMACD(wave(80));
  const dear = computeMACD(wave(80).map(c => c * 10));
  assert.ok(Math.abs(dear.histogram / cheap.histogram - 10) < 0.01);
  assert.equal(dear.histogramPct, cheap.histogramPct);
});

test('crossedRecently flags a crossover only while it is fresh', () => {
  const closes = wave(120);
  // Find a bar where the histogram changes sign, using the function itself on
  // successive prefixes, then check freshness on either side of it.
  let crossAt = null;
  for (let n = 40; n < closes.length; n++) {
    const prev = computeMACD(closes.slice(0, n - 1));
    const cur = computeMACD(closes.slice(0, n));
    if (Math.sign(prev.histogram) !== Math.sign(cur.histogram)) { crossAt = n; break; }
  }
  assert.ok(crossAt, 'precondition: the series crosses');
  assert.equal(computeMACD(closes.slice(0, crossAt)).crossedRecently, true, 'on the crossing bar');
  assert.equal(computeMACD(closes.slice(0, crossAt + 1)).crossedRecently, true, 'one bar later');
  assert.equal(computeMACD(closes.slice(0, crossAt + 5)).crossedRecently, false, 'five bars later');
});

test('expanding tracks whether the histogram is widening', () => {
  // A steadily accelerating rise widens a positive histogram.
  const accel = Array.from({ length: 60 }, (_, i) => 100 + 0.002 * i * i * i);
  assert.equal(computeMACD(accel).expanding, true);
});

test('MACD scoring weights a fresh cross over a building trend over a fading one', () => {
  const base = { histogram: 1, histogramPct: 0.05 };
  const score = macd => scoreStock(ind({ macd: { ...base, ...macd }, macdTimeframe: '5m' }));
  const fresh = score({ crossedRecently: true, expanding: true });
  const building = score({ crossedRecently: false, expanding: true });
  const fading = score({ crossedRecently: false, expanding: false });

  const pts = s => s.breakdown.find(b => b.label.includes('MACD')).points;
  assert.equal(pts(fresh), 15);
  assert.equal(pts(building), 10);
  assert.equal(pts(fading), 5);
  for (const s of [fresh, building, fading]) assert.equal(s.direction, 'LONG');
});

test('a bearish MACD supports the short side', () => {
  const s = scoreStock(ind({
    aboveVwap: false,
    macd: { histogram: -1, histogramPct: -0.05, crossedRecently: true, expanding: true },
    macdTimeframe: '5m',
  }));
  const macd = s.breakdown.find(b => b.label.includes('MACD'));
  assert.equal(macd.side, 'SHORT');
  assert.match(macd.label, /bearish/);
});

test('MACD reason names its timeframe', () => {
  const m = { histogram: 1, histogramPct: 0.05, crossedRecently: true, expanding: true };
  const daily = scoreStock(ind({ macd: m, macdTimeframe: '1d' }));
  const intraday = scoreStock(ind({ macd: m, macdTimeframe: '5m' }));
  assert.ok(daily.reasons.some(r => r.includes('daily MACD')));
  assert.ok(intraday.reasons.some(r => r.includes('5-min MACD')));
});

test('missing MACD scores nothing rather than counting against the stock', () => {
  const without = scoreStock(ind({ macd: null }));
  assert.ok(!without.reasons.some(r => r.includes('MACD')));
});

test('indicators use 5-minute MACD once warmed up, daily before that', () => {
  const candlesFrom = closes => closes.map((c, t) => ({ t, open: c, high: c + 0.5, low: c - 0.5, close: c, volume: 1000 }));
  const daily = computeMACD(wave(200));

  const early = computeIndicators({ prevClose: 100, open: 100, candles: candlesFrom(wave(10)), macdDaily: daily });
  assert.equal(early.macdTimeframe, '1d');
  assert.equal(early.macd, daily);

  const late = computeIndicators({ prevClose: 100, open: 100, candles: candlesFrom(wave(40)), macdDaily: daily });
  assert.equal(late.macdTimeframe, '5m');

  const none = computeIndicators({ prevClose: 100, open: 100, candles: candlesFrom(wave(10)) });
  assert.equal(none.macd, null);
  assert.equal(none.macdTimeframe, null);
});

test('universe MACD stats are kept per timeframe', () => {
  const tf = (h, t) => ind({ macd: { histogramPct: h }, macdTimeframe: t });
  const ctx = buildUniverseContext([tf(0.01, '5m'), tf(0.03, '5m'), tf(2, '1d'), tf(4, '1d')]);
  assert.equal(ctx.macd['5m'].mean, 0.02);
  assert.equal(ctx.macd['1d'].mean, 3);
});

// ---------- moving averages ----------

test('maDistancePct is signed distance from the 50-day average', () => {
  assert.equal(maDistancePct(ind({ ltp: 110, sma50: 100 })), 10);
  assert.equal(maDistancePct(ind({ ltp: 95, sma50: 100 })), -5);
  assert.equal(maDistancePct(ind({ ltp: 110, sma50: null })), null);
  assert.equal(maDistancePct(ind({ ltp: 110, sma50: 0 })), null);
});

test('MA structure is graded: a full stack outweighs a lone MA20 cross', () => {
  const ma = (ltp, sma20, sma50) => {
    const s = scoreStock(ind({ ltp, sma20, sma50 }));
    return s.breakdown.find(b => /MA20/.test(b.label));
  };
  const up = ma(110, 105, 100);       // price > MA20 > MA50
  const down = ma(90, 95, 100);       // price < MA20 < MA50
  const turning = ma(100, 98, 102);   // above MA20, MA20 still under MA50
  const pullback = ma(100, 102, 98);  // below MA20, MA20 still over MA50

  assert.deepEqual([up.points, up.side], [12, 'LONG']);
  assert.deepEqual([down.points, down.side], [12, 'SHORT']);
  assert.deepEqual([turning.points, turning.side], [6, 'LONG']);
  assert.deepEqual([pullback.points, pullback.side], [6, 'SHORT']);
});

test('MA scoring needs both averages', () => {
  const s = scoreStock(ind({ ltp: 110, sma20: 105, sma50: null }));
  assert.ok(!s.reasons.some(r => /MA20|MA50/.test(r)));
});

test('a stretched uptrend outranks a marginal one on an otherwise tied score', () => {
  const ctx = buildUniverseContext([
    ind({ ltp: 120, sma20: 110, sma50: 100 }),
    ind({ ltp: 101, sma20: 100.5, sma50: 100 }),
    ind({ ltp: 100, sma50: 100 }),
  ]);
  const strong = scoreStock(ind({ ltp: 120, sma20: 110, sma50: 100 }), ctx);
  const marginal = scoreStock(ind({ ltp: 101, sma20: 100.5, sma50: 100 }), ctx);
  assert.equal(strong.score, marginal.score, 'precondition: same discrete score');
  assert.ok(strong.rankScore > marginal.rankScore);
});

// ---------- 52-week breakout ----------

const dailyBars = (n, f) => Array.from({ length: n }, (_, i) => ({ high: f(i) + 1, low: f(i) - 1, close: f(i) }));

test('prior52Range is the highest high and lowest low of the last 252 sessions', () => {
  // 300 bars; the all-time extreme at bar 10 is outside the last 252 and must not count.
  const bars = dailyBars(300, i => (i === 10 ? 999 : 100 + (i % 7)));
  assert.deepEqual(prior52Range(bars), { prior52High: 107, prior52Low: 99 });
});

test('prior52Range refuses to call a short history a 52-week range', () => {
  assert.deepEqual(prior52Range(dailyBars(150, () => 100)), { prior52High: null, prior52Low: null });
  assert.deepEqual(prior52Range(null), { prior52High: null, prior52Low: null });
});

test('price above the prior 52-week high scores a long breakout', () => {
  const s = scoreStock(ind({ ltp: 1010, prior52High: 1000, prior52Low: 700 }));
  const b = s.breakdown.find(x => /52-week high/.test(x.label));
  assert.deepEqual([b.points, b.side], [10, 'LONG']);
});

test('price below the prior 52-week low scores a short breakdown', () => {
  const s = scoreStock(ind({ ltp: 690, prior52High: 1000, prior52Low: 700, aboveVwap: false }));
  const b = s.breakdown.find(x => /52-week low/.test(x.label));
  assert.deepEqual([b.points, b.side], [10, 'SHORT']);
});

test('price inside the 52-week range scores nothing for it', () => {
  const s = scoreStock(ind({ ltp: 999, prior52High: 1000, prior52Low: 700 }));
  assert.ok(!s.reasons.some(r => /52-week/.test(r)));
});

test('touching the 52-week high exactly is not a breakout', () => {
  const s = scoreStock(ind({ ltp: 1000, prior52High: 1000, prior52Low: 700 }));
  assert.ok(!s.reasons.some(r => /52-week/.test(r)));
});

test('no daily history means no 52-week signal, not a guess', () => {
  const s = scoreStock(ind({ ltp: 5000, prior52High: null, prior52Low: null }));
  assert.ok(!s.reasons.some(r => /52-week/.test(r)));
});

test('the breakout is judged on the live price, not the candle close', () => {
  // generateInsights overwrites ind.ltp with the live quote before scoring, so
  // the same indicators must flip as the price crosses the level.
  const below = scoreStock(ind({ ltp: 995, prior52High: 1000 }));
  const above = scoreStock(ind({ ltp: 1005, prior52High: 1000 }));
  assert.ok(!below.reasons.some(r => /52-week/.test(r)));
  assert.ok(above.reasons.some(r => /52-week/.test(r)));
});

test('52-week levels are carried through to indicators and the pick', () => {
  const candles = Array.from({ length: 5 }, (_, t) => ({ t, open: 100, high: 101, low: 99, close: 100, volume: 1000 }));
  const i = computeIndicators({ prevClose: 100, open: 100, candles, prior52High: 120, prior52Low: 80 });
  assert.equal(i.prior52High, 120);
  assert.equal(i.prior52Low, 80);
  const empty = computeIndicators({ prevClose: 100, open: 100, candles: [], prior52High: 120, prior52Low: 80 });
  assert.equal(empty.prior52High, 120, 'kept on the no-candles path too');
  const pick = buildPick({ symbol: 'X', name: 'X', sector: 'Y' }, { ...i, atr: 1 }, scoreStock(i));
  assert.equal(pick.indicators.prior52High, 120);
});

// ---------- opening-range freshness ----------

const bars = closes => closes.map((c, t) => ({ t, open: c, high: c + 0.2, low: c - 0.2, close: c, volume: 1000 }));

test('orbCandlesSinceBreak counts the current breakout run, not the first one', () => {
  // Range 100-101; out at bar 3, back in at bar 5, out again at bars 7-8.
  const c = bars([100, 101, 100.5, 102, 102, 100.5, 100.8, 102, 103]);
  assert.equal(orbCandlesSinceBreak(c, 101.2, 99.8, 'BREAKOUT_UP'), 1);
  assert.equal(orbCandlesSinceBreak(c, 101.2, 99.8, 'INSIDE'), null);
});

test('a live price beyond the range before any candle closed there counts as just now', () => {
  const c = bars([100, 101, 100.5, 100.8]);
  assert.equal(orbCandlesSinceBreak(c, 101.2, 99.8, 'BREAKOUT_UP'), 0);
});

test('a fresh opening-range break scores 25, a stale one 10', () => {
  const pts = ago => scoreStock(ind({ orbStatus: 'BREAKOUT_UP', orbBreakAgo: ago }))
    .breakdown.find(b => /opening range/.test(b.label)).points;
  assert.equal(pts(0), 25);
  assert.equal(pts(3), 25);
  assert.equal(pts(4), 10);
  assert.equal(pts(20), 10);
});

// ---------- tight stop ----------

const planInd = o => ({ atr: 2, orbStatus: 'BREAKOUT_UP', orHigh: 99, orLow: 95, vwap: 97, ...o });

test('the tight stop sits just beyond the nearest invalidation level', () => {
  // Entry 100; OR high 99 is the nearest level, so the raw stop is 99 - 0.25*2 =
  // 98.5 — a risk of 1.5, only 0.75 ATR. That is inside the noise, so it is
  // widened to the 1 ATR floor: stop 98.
  const p = intradayPlan(planInd(), 'LONG', 100);
  assert.equal(p.stopLoss, 98);
  assert.equal(p.riskPerShare, 2);
  assert.match(p.stopBasis, /opening range, widened to 1 ATR/);
});

test('the tight stop is used as-is when it is between 1 and 1.5 ATR', () => {
  // OR high 97.8 -> stop 97.3, risk 2.7 = 1.35 ATR.
  const p = intradayPlan(planInd({ orHigh: 97.8, vwap: 96 }), 'LONG', 100);
  assert.equal(p.riskPerShare, 2.7);
  assert.equal(p.stopBasis, 'just beyond opening range');
});

test('the tight stop is never wider than the standard 1.5 ATR', () => {
  const far = intradayPlan(planInd({ orHigh: 90, vwap: 88 }), 'LONG', 100);
  const std = intradayPlan(planInd({ orHigh: 90, vwap: 88 }), 'LONG', 100, { stopMode: 'STANDARD' });
  assert.equal(far.riskPerShare, 3);
  assert.equal(std.riskPerShare, 3);
  assert.equal(far.stopBasis, 'capped at 1.5 ATR');
});

test('with no level on the stop side, the tight stop falls back to 1.5 ATR', () => {
  const p = intradayPlan(planInd({ orbStatus: 'INSIDE', vwap: 101 }), 'LONG', 100);
  assert.equal(p.riskPerShare, 3);
  assert.equal(p.stopBasis, '1.5 ATR');
});

test('the tight stop mirrors for shorts', () => {
  const p = intradayPlan({ atr: 2, orbStatus: 'BREAKOUT_DOWN', orHigh: 105, orLow: 102.2, vwap: 104 }, 'SHORT', 100);
  assert.equal(p.stopLoss, 102.7);   // OR low 102.2 + 0.5
  assert.equal(p.target1, 97.3);
  assert.equal(p.target2, 94.6);
});

test('costs are reported in units of the risk', () => {
  const p = intradayPlan(planInd({ orHigh: 97.8 }), 'LONG', 100);
  assert.equal(p.costR, Math.round((INTRADAY_ROUND_TRIP_COST * 100 / 2.7) * 100) / 100);
});

test('no plan without ATR', () => {
  assert.equal(intradayPlan({ atr: null }, 'LONG', 100), null);
});

// ---------- entry window ----------

const at = (h, m) => new Date(2026, 9, 12, h, m); // Monday 12 Oct 2026

test('the entry window opens at 09:30 and closes at the cutoff', () => {
  assert.equal(entryWindow('10:30', at(9, 20)).state, 'BEFORE');
  assert.equal(entryWindow('10:30', at(9, 30)).state, 'OPEN');
  assert.equal(entryWindow('10:30', at(10, 29)).state, 'OPEN');
  assert.equal(entryWindow('10:30', at(10, 30)).state, 'CLOSED');
});

test('the entry cutoff defaults to 10:30 and is capped at 14:45', () => {
  assert.equal(entryWindow(undefined, at(10, 0)).cutoff, '10:30');
  assert.equal(entryWindow('nonsense', at(10, 0)).cutoff, '10:30');
  assert.equal(entryWindow('09:00', at(10, 0)).cutoff, '10:30', 'before the range forms is no window at all');
  assert.equal(entryWindow('15:15', at(10, 0)).cutoff, '14:45');
  assert.equal(entryWindow('9:45', at(10, 0)).cutoff, '09:45', 'unpadded hours are accepted');
});

test('insights carry the entry window and each pick its stop basis and costs', async () => {
  const r = await generateInsights(null, null, { entryCutoff: '11:00' });
  assert.equal(r.entryWindow.cutoff, '11:00');
  for (const p of r.picks.filter(x => x.levelsAvailable)) {
    assert.ok(p.levels.stopBasis);
    assert.ok(p.levels.costR > 0);
    assert.ok(p.levels.riskPerShare <= 1.5 * p.indicators.atr + 0.011, 'never wider than the old stop');
  }
});

test('there is no entry window on a weekend, whatever the clock says', () => {
  assert.equal(entryWindow('10:30', new Date(2026, 9, 10, 10, 0)).state, 'MARKET_CLOSED'); // Saturday
  assert.equal(entryWindow('10:30', new Date(2026, 9, 11, 10, 0)).state, 'MARKET_CLOSED'); // Sunday
});
