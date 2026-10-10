/**
 * Tests for the intraday backtester.
 *
 * Fixtures are synthetic NSE-like sessions (75 five-minute candles, 09:15-15:25
 * IST, timestamps in Kite's "+0530" format) with a year of daily candles before
 * them. They test the machinery, not the formula's real performance.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { backtestIntraday, collectIntradaySignals } from '../server/services/intradayBacktest.js';

function synth(seed, { stocks = 12, days = 40, drift = () => 0 } = {}) {
  let s = seed; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const g = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const pad = n => String(n).padStart(2, '0');
  const fiveMinBySymbol = {}, dailyBySymbol = {};
  for (let k = 0; k < stocks; k++) {
    let p = 200 + rnd() * 1800; const daily = [];
    const d0 = Date.UTC(2025, 0, 1);
    for (let i = 0; i < 300; i++) {
      const o = p, c = o * (1 + g() * 0.015);
      daily.push({ time: new Date(d0 + i * 864e5).toISOString().slice(0, 10) + 'T00:00:00+0530', open: o, high: Math.max(o, c) * 1.005, low: Math.min(o, c) * 0.995, close: c, volume: 1e6 });
      p = c;
    }
    const five = [];
    for (let d = 0; d < days; d++) {
      const date = new Date(d0 + (300 + d) * 864e5).toISOString().slice(0, 10);
      const dayDrift = drift(k, d);
      p = p * (1 + g() * 0.006);
      for (let i = 0; i < 75; i++) {
        const mins = 9 * 60 + 15 + i * 5;
        const o = p, c = o * (1 + dayDrift + g() * 0.0025);
        const u = i / 75, vol = 1e5 * (1.6 - 2.2 * u + 2 * u * u) * (0.6 + rnd() * 0.8);
        five.push({ time: `${date}T${pad(Math.floor(mins / 60))}:${pad(mins % 60)}:00+0530`, open: o, high: Math.max(o, c) * (1 + Math.abs(g()) * 0.0012), low: Math.min(o, c) * (1 - Math.abs(g()) * 0.0012), close: c, volume: vol });
        p = c;
      }
      daily.push({ time: `${date}T00:00:00+0530`, open: five[five.length - 75].open, high: Math.max(...five.slice(-75).map(x => x.high)), low: Math.min(...five.slice(-75).map(x => x.low)), close: p, volume: 1e7 });
    }
    fiveMinBySymbol['S' + k] = five; dailyBySymbol['S' + k] = daily;
  }
  return { fiveMinBySymbol, dailyBySymbol };
}

const clock = t => t.slice(11, 16);

test('no lookahead: changing later candles never changes an earlier signal', () => {
  const data = synth(17, { stocks: 8, days: 12 });
  const base = collectIntradaySignals(data, { maxTradesPerDay: 5 });
  // Scramble everything after 10:00 on every day.
  const scrambled = structuredClone(data);
  for (const cs of Object.values(scrambled.fiveMinBySymbol)) {
    for (const c of cs) if (clock(c.time) > '10:00') { c.close *= 1.03; c.high *= 1.04; c.low *= 0.97; c.volume *= 3; }
  }
  const key = s => `${s.date} ${s.time} ${s.symbol} ${s.scored.direction} ${s.scored.score}`;
  const early = sigs => sigs.filter(s => s.time < '10:00').map(key).sort();
  assert.deepEqual(early(collectIntradaySignals(scrambled, { maxTradesPerDay: 5 })), early(base));
  assert.ok(early(base).length > 0, 'precondition: some early signals');
});

test('no lookahead across days: later sessions never change an earlier day', () => {
  const data = synth(23, { stocks: 8, days: 12 });
  const all = collectIntradaySignals(data);
  const lastDay = [...new Set(all.map(s => s.date))].sort().pop();
  const cut = structuredClone(data);
  for (const k of Object.keys(cut.fiveMinBySymbol)) cut.fiveMinBySymbol[k] = cut.fiveMinBySymbol[k].filter(c => c.time.slice(0, 10) < lastDay);
  const key = s => `${s.date} ${s.time} ${s.symbol} ${s.scored.score}`;
  assert.deepEqual(collectIntradaySignals(cut).map(key), all.filter(s => s.date < lastDay).map(key));
});

test('entries respect the cutoff and the daily trade limit', () => {
  const data = synth(5, { stocks: 10, days: 15 });
  for (const [cutoff, max] of [['10:30', 2], ['09:45', 1], ['11:15', 3]]) {
    const r = backtestIntraday(data, { entryCutoff: cutoff, maxTradesPerDay: max, tradeLimit: 0 });
    assert.ok(r.trades.length > 0, `precondition: trades at ${cutoff}`);
    for (const t of r.trades) {
      assert.ok(t.entryTime <= cutoff, `entry ${t.entryTime} after cutoff ${cutoff}`);
      assert.ok(t.signalTime >= '09:25', 'no signal before the opening range is complete');
    }
    const perDay = {};
    for (const t of r.trades) perDay[t.date] = (perDay[t.date] || 0) + 1;
    assert.ok(Object.values(perDay).every(n => n <= max), `more than ${max} trades in a day`);
  }
});

test('unattended trades exit at 15:15 at the latest', () => {
  const r = backtestIntraday(synth(9, { stocks: 8, days: 10 }), { tradeLimit: 0 });
  for (const t of r.trades) assert.ok(t.exitTime <= '15:10', `exit candle ${t.exitTime}`);
  assert.ok(r.trades.some(t => t.reason === 'CLOSE'), 'some trades held to the close');
});

test('no edge on random prices once targets cap the outcome', () => {
  // Gross R on the target variants must sit near zero; a clearly positive
  // value would mean the replay is seeing prices it should not.
  let n = 0, gross = 0;
  for (const seed of [11, 12, 13, 14, 15, 16]) {
    const r = backtestIntraday(synth(seed * 7919, { stocks: 12, days: 30 }), { tradeLimit: 0, maxTradesPerDay: 4 });
    for (const k of ['TIGHT_T1', 'TIGHT_T2', 'STD_T1', 'STD_T2']) {
      const v = r.variants[k];
      n += v.trades;
      gross += v.totalR + v.avgCostR * v.trades;
    }
  }
  assert.ok(n > 1500, `precondition: enough trades (${n})`);
  assert.ok(Math.abs(gross / n) < 0.08, `gross ${(gross / n).toFixed(3)}R on random prices`);
});

test('every variant is reported with costs and stop size', () => {
  const r = backtestIntraday(synth(3, { stocks: 8, days: 10 }));
  assert.equal(Object.keys(r.variants).length, 6);
  for (const v of Object.values(r.variants)) {
    if (!v.trades) continue;
    assert.ok(v.avgCostR > 0);
    assert.ok(v.avgStopPct > 0);
  }
  assert.ok(r.variants.TIGHT_STOP_ONLY.avgStopPct <= r.variants.STD_STOP_ONLY.avgStopPct, 'tight stops are not wider');
});

test('the backtest reports nothing to test without data', () => {
  assert.equal(backtestIntraday({ fiveMinBySymbol: {} }).available, false);
});
