/**
 * Tests for the insights scoring pipeline.
 *
 * Run with `npm test` (node:test, no test framework dependency).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  UNIVERSE,
  buildUniverseContext,
  computeIndicators,
  generateInsights,
  generateIntradaySeries,
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

  assert.ok(insights.picks.length <= 5);
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
