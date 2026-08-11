/**
 * Tests for the insights scoring pipeline.
 *
 * Run with `npm test` (node:test, no test framework dependency).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_PICK_LIMIT,
  UNIVERSE,
  buildPick,
  buildUniverseContext,
  computeIndicators,
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

test('rankScore cannot bridge a genuine one-signal gap', () => {
  // The smallest discrete signal is 10 points and the edge term is capped at
  // ±7, so a stock with an extra signal must always outrank one without it.
  // Both long with ORB + VWAP firing; only `extraSignal` is also near the day
  // high (+10). `bestCase` gets the strongest possible edge term instead.
  const ctx = context({ relStrength: { mean: 0, sd: 1 } });
  const extraSignal = scoreStock(
    ind({ changePct: 1.0, orbStatus: 'BREAKOUT_UP', rangePosition: 95 }), ctx);
  const bestCase = scoreStock(
    ind({ changePct: 5.0, orbStatus: 'BREAKOUT_UP', rangePosition: 50 }), ctx);

  assert.equal(extraSignal.score - bestCase.score, 10, 'precondition: exactly one more signal');
  assert.ok(
    extraSignal.rankScore > bestCase.rankScore,
    'a real signal advantage must survive the edge term',
  );
});

test('rankScore stays within 0-100', () => {
  const ctx = context({ relStrength: { mean: 0, sd: 0.5 } });
  const maxed = scoreStock(ind({
    changePct: 10, orbStatus: 'BREAKOUT_UP', aboveVwap: true, momentum30m: 5,
    relVolume: 3, gapPct: 2, rangePosition: 99, ltp: 1000, sma20: 900, sma50: 800,
  }), ctx);
  const floored = scoreStock(ind({
    changePct: -10, spreadPct: 5, circuitHeadroomPct: 0.1, atrPct: 99,
  }), ctx);

  assert.ok(maxed.rankScore <= 100, `got ${maxed.rankScore}`);
  assert.ok(floored.rankScore >= 0, `got ${floored.rankScore}`);
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
