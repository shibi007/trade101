/**
 * Tests for the chart studies.
 *
 * Run with `npm test` (node:test, no test framework dependency).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeStudies,
  ehlersCOG,
  regressionChannel,
  rsiSeries,
  rsiValues,
  volumeCOG,
  volumeProfile,
} from '../server/services/studies.js';

/** Candles from a list of closes; range and volume are flat unless overridden. */
function candles(closes, opts = {}) {
  return closes.map((close, i) => ({
    time: 1000 + i * 60,
    open: close, high: close + (opts.range ?? 1), low: close - (opts.range ?? 1),
    close, volume: opts.volumes ? opts.volumes[i] : 1000,
  }));
}

const ramp = n => Array.from({ length: n }, (_, i) => 100 + i);

// ---------- ehlersCOG ----------

test('COG is null until the window fills', () => {
  const out = ehlersCOG(candles(ramp(12)), 10);
  assert.equal(out.length, 12);
  for (let i = 0; i < 9; i++) assert.equal(out[i].cog, null, `bar ${i} should be null`);
  assert.ok(out[9].cog != null, 'bar 9 completes the first 10-bar window');
});

test('COG is zero on a flat series', () => {
  // Equal prices balance at the window centre, which the recentring maps to 0.
  const out = ehlersCOG(candles(new Array(15).fill(100)), 10);
  assert.equal(out[14].cog, 0);
});

test('COG is signed opposite for a rising vs falling series', () => {
  const up = ehlersCOG(candles(ramp(20)), 10)[19].cog;
  const down = ehlersCOG(candles([...ramp(20)].reverse()), 10)[19].cog;
  assert.ok(up !== 0, 'a trend must move the balance point off centre');
  assert.ok(Math.sign(up) === -Math.sign(down), `up ${up} and down ${down} must differ in sign`);
});

test('a mirrored window gives a mirrored COG', () => {
  // The window itself has to be the mirror, not just the series: COG divides by
  // the sum of prices, so it is not translation-invariant and two windows at
  // different price levels will not cancel.
  const window = ramp(10);
  const up = ehlersCOG(candles(window), 10)[9].cog;
  const down = ehlersCOG(candles([...window].reverse()), 10)[9].cog;
  assert.ok(Math.abs(up + down) < 1e-9, `${up} and ${down} should sum to zero`);
});

test('COG stays inside the window it is computed over', () => {
  // The balance point cannot fall outside the bar positions it averages, so the
  // recentred value is bounded by ±(period-1)/2 — the guard that keeps the
  // oscillator's scale meaningful without knowing the data.
  const period = 10, bound = (period - 1) / 2;
  const out = ehlersCOG(candles([100, 180, 101, 99, 250, 98, 102, 97, 300, 96, 101, 100]), period);
  for (const p of out) {
    if (p.cog != null) assert.ok(Math.abs(p.cog) <= bound + 1e-9, `${p.cog} exceeds ±${bound}`);
  }
});

test('COG signal line lags the oscillator and warms up later', () => {
  const out = ehlersCOG(candles(ramp(20)), 10, 3);
  assert.equal(out[9].signal, null, 'signal needs 3 COG values before it can average');
  assert.ok(out[11].signal != null);
  assert.ok(out[19].signal != null);
});

// ---------- rsiValues ----------

test('RSI is null until it has warmed up', () => {
  // 14 periods needs 15 closes; anything earlier is a partial figure that would
  // look authoritative without being one.
  const out = rsiValues(ramp(20), 14);
  for (let i = 0; i < 14; i++) assert.equal(out[i], null, `bar ${i}`);
  assert.ok(out[14] != null);
});

test('RSI is 100 when every move is up', () => {
  // No losses at all: the gain/loss ratio is undefined and RSI is defined as
  // 100 there. Dividing by zero would give Infinity and then NaN.
  const out = rsiValues(ramp(30), 14);
  assert.equal(out[29], 100);
});

test('RSI is 0 when every move is down', () => {
  const out = rsiValues([...ramp(30)].reverse(), 14);
  assert.equal(out[29], 0);
});

test('RSI is 50 on a perfectly flat series', () => {
  const out = rsiValues(new Array(30).fill(100), 14);
  assert.equal(out[29], 50, 'no gains and no losses is neutral, not 100');
});

test('RSI stays within 0-100 on noisy data', () => {
  const closes = [];
  let p = 100;
  for (let i = 0; i < 200; i++) { p += Math.sin(i * 1.7) * 3 + (i % 7 === 0 ? -6 : 1); closes.push(p); }
  for (const v of rsiValues(closes, 14)) {
    if (v != null) assert.ok(v >= 0 && v <= 100, `got ${v}`);
  }
});

test('RSI uses Wilder smoothing, not a simple average', () => {
  // Known series from Wilder's own worked example. A simple moving average
  // produces a similar-looking line with different turning points, so signals
  // would fire on different bars — a silent and common error.
  const closes = [
    44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42,
    45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.00,
  ];
  const out = rsiValues(closes, 14);
  assert.ok(Math.abs(out[14] - 70.53) < 0.5, `first RSI was ${out[14]}, expected ~70.5`);
  assert.ok(Math.abs(out[15] - 66.32) < 0.5, `second RSI was ${out[15]}, expected ~66.3`);
});

test('RSI rises as gains accumulate and falls as losses do', () => {
  const up = rsiValues([...new Array(15).fill(100), 101, 102, 103, 104], 14);
  const down = rsiValues([...new Array(15).fill(100), 99, 98, 97, 96], 14);
  assert.ok(up[18] > up[14], 'gains should raise RSI');
  assert.ok(down[18] < down[14], 'losses should lower it');
});

test('rsiValues handles series shorter than the period', () => {
  assert.deepEqual(rsiValues([1, 2, 3], 14), [null, null, null]);
  assert.deepEqual(rsiValues([], 14), []);
});

test('rsiSeries attaches candle timestamps', () => {
  const c = candles(ramp(20));
  const s = rsiSeries(c, 14);
  assert.equal(s.length, 20);
  assert.equal(s[14].time, c[14].time);
  assert.ok(s[14].rsi != null);
});

// ---------- regressionChannel ----------

test('regression mid tracks a straight line exactly', () => {
  // Perfect linear data: the fit is the data, so the bands collapse onto it.
  const out = regressionChannel(candles(ramp(30)), 10, 2);
  const last = out[29];
  assert.equal(last.mid, 129);
  assert.equal(last.upper, 129);
  assert.equal(last.lower, 129);
  assert.equal(last.slope, 1);
});

test('regression bands widen with dispersion', () => {
  const calm = regressionChannel(candles(ramp(30)), 10, 2)[29];
  const noisy = regressionChannel(candles(ramp(30).map((c, i) => c + (i % 2 ? 6 : -6))), 10, 2)[29];
  assert.ok((noisy.upper - noisy.lower) > (calm.upper - calm.lower));
});

test('regression slope is negative on a downtrend', () => {
  const out = regressionChannel(candles([...ramp(30)].reverse()), 10, 2);
  assert.ok(out[29].slope < 0, `got ${out[29].slope}`);
});

test('regression is null until the window fills', () => {
  const out = regressionChannel(candles(ramp(20)), 10, 2);
  for (let i = 0; i < 9; i++) assert.equal(out[i].mid, null);
  assert.ok(out[9].mid != null);
});

// ---------- volumeCOG ----------

test('volume COG equals the price when price is constant', () => {
  const out = volumeCOG(candles(new Array(5).fill(100), { range: 0 }));
  assert.equal(out[4].value, 100);
});

test('volume COG is pulled toward the heavily traded price', () => {
  // Two prices, but nearly all volume at 100 — the balance sits close to 100.
  const out = volumeCOG(candles([100, 200], { range: 0, volumes: [10000, 100] }));
  assert.ok(out[1].value < 102, `expected close to 100, got ${out[1].value}`);
});

test('volume COG survives zero-volume candles', () => {
  const out = volumeCOG(candles([100, 101], { range: 0, volumes: [0, 0] }));
  assert.equal(out[0].value, null, 'no volume means no weighted average to report');
});

// ---------- volumeProfile ----------

test('POC lands on the most heavily traded price band', () => {
  // Volume concentrated at 150 while price also visits 100 and 200.
  const c = [
    { time: 1, open: 100, high: 101, low: 99, close: 100, volume: 100 },
    { time: 2, open: 150, high: 151, low: 149, close: 150, volume: 90000 },
    { time: 3, open: 200, high: 201, low: 199, close: 200, volume: 100 },
  ];
  const { poc } = volumeProfile(c, 40);
  assert.ok(Math.abs(poc - 150) < 5, `POC ${poc} should sit near 150`);
});

test('volume profile spreads a candle across its range, not at the close', () => {
  // One wide bar: no single bin should hold all of it, or the profile would be
  // reporting a concentration the candle does not actually evidence.
  const { bins } = volumeProfile([
    { time: 1, open: 100, high: 200, low: 100, close: 200, volume: 1000 },
  ], 10);
  const occupied = bins.filter(b => b.volume > 0);
  assert.ok(occupied.length > 1, `volume landed in ${occupied.length} bin(s)`);
});

test('volume profile handles an empty or volumeless series', () => {
  assert.deepEqual(volumeProfile([], 10), { poc: null, bins: [] });
  assert.deepEqual(volumeProfile(candles([100, 101], { volumes: [0, 0] }), 10), { poc: null, bins: [] });
});

// ---------- computeStudies ----------

test('computeStudies returns one entry per candle', () => {
  const c = candles(ramp(120));
  const s = computeStudies(c);
  assert.equal(s.cog.length, c.length);
  assert.equal(s.regression.length, c.length);
  assert.equal(s.volumeCog.length, c.length);
});

test('computeStudies shrinks the regression window on a short series', () => {
  // 20 candles with the default 60-bar window would be all nulls; the chart
  // should still draw something early in the session.
  const s = computeStudies(candles(ramp(20)));
  assert.ok(s.regressionPeriod < 60);
  assert.ok(s.regression.some(p => p.mid != null), 'short series must still produce a channel');
});

test('computeStudies tolerates an empty series', () => {
  const s = computeStudies([]);
  assert.deepEqual(s.cog, []);
  assert.deepEqual(s.regression, []);
  assert.equal(s.volumeProfile.poc, null);
});

test('no study emits NaN on a flat series', () => {
  const s = computeStudies(candles(new Array(80).fill(100), { range: 0 }));
  const values = [
    ...s.cog.flatMap(p => [p.cog, p.signal]),
    ...s.regression.flatMap(p => [p.mid, p.upper, p.lower]),
    ...s.volumeCog.map(p => p.value),
  ];
  for (const v of values) {
    assert.ok(v === null || Number.isFinite(v), `got ${v}`);
  }
});
