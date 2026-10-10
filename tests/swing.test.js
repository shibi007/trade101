/**
 * Tests for the swing engine and its backtester.
 *
 * Reference values for RSI and ATR come from a separate Python implementation
 * of TradingView's ta.rsi / ta.atr (RMA seeded with an SMA), not from the code
 * under test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeRSI, computeATR, swingIndicators, buildSwingContext, scoreSwing, swingPlan,
  generateDailySeries, generateSwingInsights, SWING_WARMUP, TIME_STOP_SESSIONS,
} from '../server/services/swingEngine.js';
import { backtestSwing, collectSignals, summarise } from '../server/services/swingBacktest.js';

// ---------- fixtures ----------

/** Deterministic daily candles from a list of closes. */
function fromCloses(closes, { volume = 1e6, spread = 0.01, start = '2023-01-02' } = {}) {
  const d0 = Date.parse(start);
  return closes.map((c, i) => ({
    time: new Date(d0 + i * 86400000).toISOString().slice(0, 10),
    open: i ? closes[i - 1] : c, high: c * (1 + spread), low: c * (1 - spread), close: c,
    volume: typeof volume === 'function' ? volume(i) : volume,
  }));
}

/** Seeded random-walk universe; `drift(k)` gives each stock's daily drift. */
function walkUniverse(n, days, seed, drift = () => 0) {
  let s = seed;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const g = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const out = {};
  const d0 = Date.UTC(2021, 0, 4);
  for (let k = 0; k < n; k++) {
    let p = 100 + rnd() * 900;
    const c = [];
    for (let i = 0; i < days; i++) {
      const o = p * (1 + g() * 0.004);
      const cl = o * (1 + drift(k) + g() * 0.015);
      c.push({
        time: new Date(d0 + i * 86400000).toISOString().slice(0, 10),
        open: o, high: Math.max(o, cl) * (1 + Math.abs(g()) * 0.006),
        low: Math.min(o, cl) * (1 - Math.abs(g()) * 0.006), close: cl, volume: 1e6 * (0.5 + rnd()),
      });
      p = cl;
    }
    out['S' + k] = c;
  }
  return out;
}

// ---------- indicators ----------

const refCandles = Array.from({ length: 90 }, (_, i) => {
  const m = 100 + 6 * Math.sin(i / 5) + i * 0.1;
  return { open: m - 0.3, high: m + 1 + (i % 3) * 0.2, low: m - 1 - (i % 4) * 0.15, close: m + Math.cos(i) * 0.4 };
});

test('RSI matches an independent reference implementation', () => {
  assert.equal(Number(computeRSI(refCandles.map(c => c.close)).toFixed(4)), 38.997);
});

test('ATR matches an independent reference implementation', () => {
  assert.equal(Number(computeATR(refCandles).toFixed(4)), 2.4413);
});

test('RSI is 100 for a series that only rises and null without history', () => {
  assert.equal(computeRSI(Array.from({ length: 30 }, (_, i) => 100 + i)), 100);
  assert.equal(computeRSI([1, 2, 3]), null);
  assert.equal(computeRSI(Array(30).fill(100)), 50, 'a flat series has no direction');
});

test('swingIndicators needs a year of history', () => {
  assert.equal(swingIndicators(fromCloses(Array(SWING_WARMUP - 1).fill(100))), null);
  assert.notEqual(swingIndicators(fromCloses(Array(SWING_WARMUP).fill(100))), null);
});

test('swingIndicators reads trend, momentum and the 52-week range', () => {
  const rising = Array.from({ length: 300 }, (_, i) => 100 * 1.002 ** i);
  const si = swingIndicators(fromCloses(rising));
  assert.ok(si.close > si.sma50 && si.sma50 > si.sma200, 'stacked uptrend');
  assert.equal(si.sma200Rising, true);
  assert.ok(si.r12 > 0.6, `12-month return ${si.r12}`);
  assert.ok(si.pctFromHigh52 > -1.5, 'at the high, give or take the bar spread');
});

// ---------- scoring ----------

/** A strong uptrend that has just broken out on heavy volume. */
function breakoutSeries() {
  const closes = Array.from({ length: 299 }, (_, i) => 100 * 1.0015 ** i + Math.sin(i / 3));
  closes.push(closes[closes.length - 1] * 1.04);
  return fromCloses(closes, { volume: i => (i === 299 ? 3e6 : 1e6) });
}

test('a high-volume breakout above the prior year\'s high is a 52-week breakout', () => {
  // The series rises all year, so the final jump clears every earlier high.
  const si = swingIndicators(breakoutSeries());
  const s = scoreSwing(si, 'X', buildSwingContext({ X: si }));
  assert.equal(s.direction, 'LONG');
  assert.equal(s.setup, 'BREAKOUT_52W');
  assert.ok(si.close > si.prior52High);
  assert.ok(s.reasons.some(r => /Stage 2/.test(r)));
  assert.ok(s.reasons.some(r => /new 52-week high/.test(r)));
});

/** A year-old peak at 160, a fall to 125, then a climb that breaks a 20-day high near 143. */
function twentyDaySeries() {
  const closes = [];
  for (let i = 0; i < 300; i++) {
    let c;
    if (i < 50) c = 100 + i * 0.2;
    else if (i < 110) c = 110 + (i - 50) * (50 / 60);
    else if (i < 150) c = 160 - (i - 110) * (35 / 40);
    else c = 125 + (i - 150) * (15 / 149);
    closes.push(c + Math.sin(i / 2) * 0.6);
  }
  closes[299] = closes[298] * 1.025;
  return fromCloses(closes, { volume: i => (i === 299 ? 3e6 : 1e6) });
}

test('a 20-day breakout still below the 52-week high stays an ordinary breakout', () => {
  const si = swingIndicators(twentyDaySeries());
  const s = scoreSwing(si, 'X', buildSwingContext({ X: si }));
  assert.ok(si.close > si.prior20High && si.close < si.prior52High, 'precondition');
  assert.equal(s.setup, 'BREAKOUT');
});

test('a 52-week breakout replaces the 20-day trigger instead of stacking on it', () => {
  // Both setups must carry exactly one trigger worth 20 — being at the high is
  // already rewarded by the proximity factor, so it must not count twice.
  for (const candles of [breakoutSeries(), twentyDaySeries()]) {
    const si = swingIndicators(candles);
    const s = scoreSwing(si, 'X', buildSwingContext({ X: si }));
    const triggers = s.breakdown.filter(b => /Breakout to a new/.test(b.label));
    assert.equal(triggers.length, 1, s.setup);
    assert.equal(triggers[0].points, 20);
  }
});

test('a 52-week breakout stop sits back below the old 52-week high', () => {
  const si = swingIndicators(breakoutSeries());
  const s = scoreSwing(si, 'X', buildSwingContext({ X: si }));
  const plan = swingPlan(si, s);
  const structural = si.prior52High - 0.5 * si.atr;
  const expected = Math.max(si.close - 3 * si.atr, Math.min(si.close - si.atr, structural));
  assert.ok(Math.abs(plan.stopLoss - expected) <= 0.01, `stop ${plan.stopLoss} vs ${expected}`);
});

test('a 52-week high on light volume is noted but is not a trigger', () => {
  const candles = breakoutSeries();
  candles[candles.length - 1].volume = 1e6;
  const si = swingIndicators(candles);
  const s = scoreSwing(si, 'X', buildSwingContext({ X: si }));
  assert.equal(s.setup, null);
  assert.ok(s.reasons.some(r => /New 52-week high but volume only/.test(r)));
});

test('the same breakout on ordinary volume is not a trigger', () => {
  const candles = twentyDaySeries();
  candles[candles.length - 1].volume = 1e6;
  const si = swingIndicators(candles);
  const s = scoreSwing(si, 'X', buildSwingContext({ X: si }));
  assert.equal(s.setup, null);
  assert.ok(s.reasons.some(r => /unconfirmed/.test(r)));
});

test('long and short are scored by mirror-image rules', () => {
  // A price series and its reflection must score the same, on opposite sides.
  const up = breakoutSeries();
  const down = up.map(c => ({ ...c, open: 20000 / c.open, close: 20000 / c.close, high: 20000 / c.low, low: 20000 / c.high }));
  const su = swingIndicators(up), sd = swingIndicators(down);
  const a = scoreSwing(su, 'X', buildSwingContext({ X: su }));
  const b = scoreSwing(sd, 'X', buildSwingContext({ X: sd }));
  assert.equal(a.direction, 'LONG');
  assert.equal(b.direction, 'SHORT');
  assert.equal(a.setup, 'BREAKOUT_52W');
  assert.equal(b.setup, 'BREAKDOWN_52W');
  assert.equal(a.score, b.score);
});

test('relative strength rank is a percentile within the universe', () => {
  const mk = rate => swingIndicators(fromCloses(Array.from({ length: 260 }, (_, i) => 100 * rate ** i)));
  const ctx = buildSwingContext({ A: mk(1.003), B: mk(1.001), C: mk(0.999) });
  assert.equal(ctx.rsPercentile.A, 1);
  assert.equal(ctx.rsPercentile.B, 0.5);
  assert.equal(ctx.rsPercentile.C, 0);
});

test('an extended move is penalised as a late entry', () => {
  const closes = Array.from({ length: 290 }, (_, i) => 100 * 1.001 ** i);
  for (let i = 0; i < 10; i++) closes.push(closes[closes.length - 1] * 1.02); // +22% in 10 days
  const si = swingIndicators(fromCloses(closes));
  const s = scoreSwing(si, 'X', buildSwingContext({ X: si }));
  assert.ok(s.breakdown.some(b => /Extended/.test(b.label) && b.points === -15));
});

test('swing rankScore never ranks a higher score below a lower one', () => {
  const uni = walkUniverse(30, 300, 5, k => (k % 3 - 1) * 0.001);
  const si = Object.fromEntries(Object.entries(uni).map(([k, c]) => [k, swingIndicators(c)]));
  const ctx = buildSwingContext(si);
  const scored = Object.keys(si).map(k => scoreSwing(si[k], k, ctx));
  for (const a of scored) for (const b of scored) {
    if (a.score > b.score) assert.ok(a.rankScore > b.rankScore, `${a.score}/${a.rankScore} vs ${b.score}/${b.rankScore}`);
  }
});

// ---------- trade plan ----------

test('a breakout stop sits back below the breakout level, clamped to 1-3 ATR', () => {
  const si = swingIndicators(breakoutSeries());
  const s = scoreSwing(si, 'X', buildSwingContext({ X: si }));
  const plan = swingPlan(si, s);
  assert.ok(plan.stopLoss < plan.referenceEntry);
  assert.ok(plan.riskPerShare >= si.atr - 0.01 && plan.riskPerShare <= 3 * si.atr + 0.01);
  // Levels are rounded once at the end, so rebuilding them from the rounded
  // risk can differ by a paisa.
  assert.ok(Math.abs(plan.target1 - (plan.referenceEntry + 2 * plan.riskPerShare)) <= 0.02);
  assert.ok(Math.abs(plan.target2 - (plan.referenceEntry + 3 * plan.riskPerShare)) <= 0.02);
  assert.equal(plan.timeStopSessions, TIME_STOP_SESSIONS);
});

test('no plan without an entry trigger', () => {
  const si = swingIndicators(breakoutSeries());
  assert.equal(swingPlan(si, { setup: null, direction: 'LONG' }), null);
});

// ---------- backtester ----------

test('backtest has no lookahead: future candles never change past signals', () => {
  // Cut the history at day D. Every signal dated before D must be identical in
  // the cut and the full run; any difference means a signal used data it
  // could not have had.
  const full = walkUniverse(6, 420, 11, k => (k % 2 ? 0.001 : -0.001));
  const cutDay = full.S0[380].time;
  const cut = Object.fromEntries(Object.entries(full).map(([k, c]) => [k, c.filter(x => x.time <= cutDay)]));
  const key = s => `${s.symbol}:${s.day}:${s.scored.direction}:${s.scored.setup}:${s.scored.score}`;
  // The last bar of the cut set cannot signal (no next bar to enter on).
  const before = sigs => sigs.filter(s => s.day < cutDay).map(key).sort();
  assert.deepEqual(before(collectSignals(cut)), before(collectSignals(full)));
  assert.ok(before(collectSignals(full)).length > 0, 'precondition: some signals');
});

test('backtest finds no edge in a driftless random walk', () => {
  // With no edge in the data, a positive result means the code is cheating.
  // Pooled over several seeds, expectancy must sit near zero, minus costs.
  const rs = [];
  for (const seed of [1, 2, 3, 4]) {
    const r = backtestSwing(walkUniverse(12, 700, seed * 7919), { tradeLimit: 0 });
    rs.push(...r.trades.filter(t => !t.open).map(t => t.r));
  }
  const avg = rs.reduce((a, b) => a + b, 0) / rs.length;
  assert.ok(rs.length > 500, `precondition: enough trades (${rs.length})`);
  assert.ok(avg < 0.08, `random-walk expectancy ${avg.toFixed(3)}R should not be meaningfully positive`);
});

test('backtest detects a real edge when one exists', () => {
  // Persistent trends are exactly what the formula is built to catch.
  const rs = [];
  for (const seed of [1, 2, 3]) {
    const r = backtestSwing(walkUniverse(12, 700, seed * 104729, k => (k % 2 ? 1 : -1) * 0.0015), { tradeLimit: 0 });
    rs.push(...r.trades.filter(t => !t.open).map(t => t.r));
  }
  const avg = rs.reduce((a, b) => a + b, 0) / rs.length;
  assert.ok(avg > 0.08, `trend expectancy ${avg.toFixed(3)}R should be clearly positive`);
});

test('a gap through the stop exits at the open, not at the stop price', () => {
  // Flat year, a volume breakout, then a collapse that opens far below the stop.
  const closes = [...Array(270).fill(100).map((v, i) => v + Math.sin(i) * 0.5), 106];
  const candles = fromCloses(closes, { volume: i => (i === 270 ? 4e6 : 1e6), spread: 0.004 });
  candles.push({ time: '2023-12-01', open: 106.2, high: 106.5, low: 105.8, close: 106 }); // entry bar
  candles.push({ time: '2023-12-02', open: 80, high: 81, low: 79, close: 80 });        // gap down
  const r = backtestSwing({ X: candles }, { tradeLimit: 0 });
  const t = r.trades.find(x => x.entryDay === '2023-12-01');
  if (t) {
    assert.equal(t.reason, 'STOP_GAP');
    assert.equal(t.exit, 80);
    assert.ok(t.r < -1, 'a gap costs more than 1R — the stop could not protect it');
  }
});

test('summary statistics are computed correctly', () => {
  const t = (r, d) => ({ r, held: 3, exitDay: d, open: false, reason: r > 0 ? 'TARGET2' : 'STOP' });
  const s = summarise([t(3, '2024-01-01'), t(-1, '2024-01-02'), t(-1, '2024-01-03'), t(2, '2024-01-04')]);
  assert.equal(s.trades, 4);
  assert.equal(s.winRatePct, 50);
  assert.equal(s.avgR, 0.75);
  assert.equal(s.profitFactor, 2.5);
  assert.equal(s.worstLosingStreak, 2);
  assert.equal(s.equityMultiple, Math.round(1.03 * 0.99 * 0.99 * 1.02 * 100) / 100);
});

test('the backtest reports 52-week and 20-day breakouts as separate variants', () => {
  const r = backtestSwing(walkUniverse(6, 420, 3, k => (k % 2 ? 0.001 : -0.001)));
  assert.ok(r.variants.BREAKOUTS_52W, '52-week variant present');
  assert.ok(r.variants.BREAKOUTS, '20-day variant present');
  const sigs = collectSignals(walkUniverse(6, 420, 3, k => (k % 2 ? 0.001 : -0.001)));
  const setups = new Set(sigs.map(x => x.scored.setup));
  for (const s of setups) assert.ok(['BREAKOUT', 'BREAKDOWN', 'BREAKOUT_52W', 'BREAKDOWN_52W', 'PULLBACK', 'RALLY'].includes(s), s);
});

test('the backtest needs enough history to say anything', () => {
  const r = backtestSwing({ X: fromCloses(Array(100).fill(100)) });
  assert.equal(r.available, false);
});

// ---------- pipeline ----------

test('offline swing insights are labelled simulated and every pick has a plan', async () => {
  const r = await generateSwingInsights(null, null);
  assert.equal(r.dataSource, 'SIMULATED');
  assert.equal(r.universeFilter.rule, 'FNO_ONLY');
  for (const p of r.picks) {
    assert.notEqual(p.setup, 'WATCH');
    assert.ok(p.levels && p.levels.stopLoss > 0);
    assert.equal(p.real, false);
    if (p.direction === 'SHORT') assert.equal(p.instrument, 'FUTURES', 'overnight shorts need futures');
  }
  for (const w of r.watchlist) assert.equal(w.setup, 'WATCH');
});

test('a live price past the stop marks the plan stopped and drops it from picks', async () => {
  const base = await generateSwingInsights(null, null);
  const pick = base.universe.find(u => u.levels);
  if (!pick) return; // no triggered setup in today's simulated data
  const pastStop = pick.direction === 'LONG' ? pick.levels.stopLoss * 0.98 : pick.levels.stopLoss * 1.02;
  const r = await generateSwingInsights(null, { [`NSE:${pick.symbol}`]: { last_price: pastStop } });
  const row = r.universe.find(u => u.symbol === pick.symbol);
  assert.equal(row.planStatus, 'STOPPED');
  assert.equal(row.levels.stopLoss, pick.levels.stopLoss, 'the stop must not follow the price down');
  assert.ok(!r.picks.some(p => p.symbol === pick.symbol));
});

test('a live price past the first target marks the plan missed', async () => {
  const base = await generateSwingInsights(null, null);
  const pick = base.universe.find(u => u.levels);
  if (!pick) return;
  const pastT1 = pick.direction === 'LONG' ? pick.levels.target1 * 1.01 : pick.levels.target1 * 0.99;
  const r = await generateSwingInsights(null, { [`NSE:${pick.symbol}`]: { last_price: pastT1 } });
  assert.equal(r.universe.find(u => u.symbol === pick.symbol).planStatus, 'MISSED');
});

test('sizing risk reflects the live price, not the signal close', async () => {
  const base = await generateSwingInsights(null, null);
  const pick = base.universe.find(u => u.levels);
  if (!pick) return;
  const long = pick.direction === 'LONG';
  // Halfway between entry and T1: still valid, but further from the stop.
  const live = (pick.levels.referenceEntry + pick.levels.target1) / 2;
  const r = await generateSwingInsights(null, { [`NSE:${pick.symbol}`]: { last_price: live } });
  const row = r.universe.find(u => u.symbol === pick.symbol);
  assert.equal(row.planStatus, 'VALID');
  assert.ok(Math.abs(row.levels.liveRiskPerShare - Math.abs(live - row.levels.stopLoss)) <= 0.01);
  assert.ok(row.levels.liveRiskPerShare > row.levels.riskPerShare, long ? 'higher entry, more risk' : 'lower entry, more risk');
});

test('the daily simulator ends at the reference price and is deterministic', () => {
  const a = generateDailySeries('RELIANCE', 2850, 300, new Date('2026-10-10'));
  const b = generateDailySeries('RELIANCE', 2850, 300, new Date('2026-10-10'));
  assert.equal(a.length, 300);
  assert.equal(a[a.length - 1].close, 2850);
  assert.deepEqual(a, b);
});
