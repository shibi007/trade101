/**
 * Intraday backtester — replays the live intraday formula over 5-minute history,
 * the way a trader who enters only until their cutoff (14:00 by default) would take it.
 *
 * It calls the board's own computeIndicators / buildUniverseContext / scoreStock
 * / intradayPlan, so it measures the formula actually shipped. At each 5-minute
 * close between 09:30 (opening range complete) and the trader's cutoff it sees
 * only that day's candles up to that moment, plus daily history up to the
 * previous session.
 *
 * Execution, chosen to be unflattering:
 *  - A signal at a candle's close is entered at the NEXT candle's open, which
 *    must start no later than the cutoff.
 *  - At most `maxTradesPerDay` trades, taken in rank order; one per stock.
 *  - If the entry already sits beyond the stop, the trade is skipped.
 *  - A candle touching both stop and target counts as a stop.
 *  - A gap through the stop exits at the open.
 *  - Anything still open exits at the close of the 15:10 candle (15:15),
 *    ahead of the broker's 15:20 auto square-off.
 *  - INTRADAY_ROUND_TRIP_COST is charged on every trade.
 *
 * Six variants share the same entries and differ only in stop and exit:
 * TIGHT (structural) vs STANDARD (1.5 ATR) stops, each with
 *   - STOP_ONLY: no target, hold to 15:15 — the only setup safe to leave
 *     unattended, since two live exit orders leave an orphan when one fills;
 *   - T1: target at 1R;  T2: target at 2R.
 *
 * What it cannot see: order-book depth, spread and circuit limits are live-only
 * signals with no history, so backtested scores run slightly lower than live
 * ones and those three filters are not tested.
 */
import {
  computeIndicators, buildUniverseContext, scoreStock, intradayPlan,
  computeMACD, prior52Range, sma, round2, INTRADAY_ROUND_TRIP_COST, DEFAULT_ENTRY_CUTOFF, entryWindow,
} from './insightsEngine.js';
import { summarise } from './swingBacktest.js';

const LAST_EXIT_CANDLE = '15:10';   // its close is 15:15
const PICK_CUTOFF_SCORE = 40;       // same bar as the live board

export const INTRADAY_VARIANTS = [
  { key: 'TIGHT_STOP_ONLY', stopMode: 'TIGHT', exit: 'STOP_ONLY', label: 'Tight stop · no target, hold to 15:15 (unattended-safe)' },
  { key: 'TIGHT_T1', stopMode: 'TIGHT', exit: 'T1', label: 'Tight stop · target 1R' },
  { key: 'TIGHT_T2', stopMode: 'TIGHT', exit: 'T2', label: 'Tight stop · target 2R' },
  { key: 'STD_STOP_ONLY', stopMode: 'STANDARD', exit: 'STOP_ONLY', label: '1.5 ATR stop · no target, hold to 15:15' },
  { key: 'STD_T1', stopMode: 'STANDARD', exit: 'T1', label: '1.5 ATR stop · target 1R' },
  { key: 'STD_T2', stopMode: 'STANDARD', exit: 'T2', label: '1.5 ATR stop · target 2R' },
];

const dateOf = c => String(c.time).slice(0, 10);
// Kite timestamps carry IST ("2026-10-09T09:15:00+0530"), so the wall-clock
// time is read straight from the string, never converted through UTC.
const clockOf = c => String(c.time).slice(11, 16);

/** Daily-history inputs for a session, from candles strictly before it. */
function dailyContext(dailyBefore) {
  const closes = dailyBefore.map(c => c.close);
  return {
    prevClose: closes.length ? closes[closes.length - 1] : null,
    sma20: sma(closes, 20), sma50: sma(closes, 50), sma200: sma(closes, 200),
    macdDaily: computeMACD(closes),
    ...prior52Range(dailyBefore),
  };
}

/**
 * Pass 1: the trades the formula would have taken, with the indicators known
 * at the signal. `fiveMinBySymbol` and `dailyBySymbol` map symbol -> candles,
 * oldest first.
 */
export function collectIntradaySignals({ fiveMinBySymbol, dailyBySymbol = {} },
  { entryCutoff = DEFAULT_ENTRY_CUTOFF, maxTradesPerDay = 2 } = {}) {
  const symbols = Object.keys(fiveMinBySymbol).filter(s => fiveMinBySymbol[s]?.length);
  const sessions = {};          // date -> symbol -> candles
  for (const sym of symbols) {
    for (const c of fiveMinBySymbol[sym]) (sessions[dateOf(c)] ||= {})[sym] ||= [];
    for (const c of fiveMinBySymbol[sym]) sessions[dateOf(c)][sym].push(c);
  }
  // Normalised exactly as the live board does: zero-padded, defaulted, and
  // clamped to 14:45, so "9:45" and "09:45" compare as the same time.
  const cutoff = entryWindow(entryCutoff).cutoff;
  const signals = [];

  for (const date of Object.keys(sessions).sort()) {
    const day = sessions[date];
    const daily = {};
    for (const sym of Object.keys(day)) {
      const before = (dailyBySymbol[sym] || []).filter(c => dateOf(c) < date);
      daily[sym] = dailyContext(before);
      // Without a daily close, yesterday's last 5-minute close is the reference.
      if (daily[sym].prevClose == null) {
        const prevDays = (fiveMinBySymbol[sym] || []).filter(c => dateOf(c) < date);
        daily[sym].prevClose = prevDays.length ? prevDays[prevDays.length - 1].close : null;
      }
    }

    // Evaluation times: each candle close from the opening range's end until the
    // last candle whose successor (the entry) still starts by the cutoff.
    const times = [...new Set(Object.values(day).flatMap(cs => cs.map(clockOf)))].sort();
    const taken = new Set();
    for (const t of times) {
      if (t < '09:25') continue;               // 09:25 candle closes at 09:30
      if (taken.size >= maxTradesPerDay) break;
      const inds = {};
      for (const [sym, cs] of Object.entries(day)) {
        if (taken.has(sym) || daily[sym].prevClose == null) continue;
        const k = cs.findIndex(c => clockOf(c) === t);
        if (k < 3 || k + 1 >= cs.length) continue;          // need the range, and a next bar
        if (clockOf(cs[k + 1]) > cutoff) continue;           // entry would be after the cutoff
        const ind = computeIndicators({ ...daily[sym], open: cs[0].open, candles: cs.slice(0, k + 1) });
        ind.real = true;
        inds[sym] = { ind, k };
      }
      const live = Object.keys(inds);
      if (!live.length) continue;
      const ctx = buildUniverseContext(live.map(s => inds[s].ind));
      const fresh = live
        .map(sym => ({ sym, scored: scoreStock(inds[sym].ind, ctx) }))
        .filter(x => x.scored.score >= PICK_CUTOFF_SCORE)
        .sort((a, b) => b.scored.rankScore - a.scored.rankScore);
      for (const { sym, scored } of fresh) {
        if (taken.size >= maxTradesPerDay) break;
        taken.add(sym);
        signals.push({ date, time: t, symbol: sym, k: inds[sym].k, ind: inds[sym].ind, scored, candles: day[sym] });
      }
    }
  }
  return signals;
}

/** Walk one trade from the candle after its signal. */
function simulate(signal, { stopMode, exit }) {
  const { candles, k, ind, scored } = signal;
  const fillBar = k + 1;
  const fill = candles[fillBar].open;
  const plan = intradayPlan(ind, scored.direction, fill, { stopMode });
  if (!plan) return null;
  const long = scored.direction === 'LONG';
  if (long ? fill <= plan.stopLoss : fill >= plan.stopLoss) return null;
  const target = exit === 'T1' ? plan.target1 : exit === 'T2' ? plan.target2 : null;

  let px = null, reason = null, exitBar = null;
  for (let j = fillBar; j < candles.length; j++) {
    const c = candles[j];
    if (clockOf(c) > LAST_EXIT_CANDLE) break;
    if (j > fillBar && (long ? c.open <= plan.stopLoss : c.open >= plan.stopLoss)) { px = c.open; reason = 'STOP_GAP'; exitBar = j; break; }
    if (long ? c.low <= plan.stopLoss : c.high >= plan.stopLoss) { px = plan.stopLoss; reason = 'STOP'; exitBar = j; break; }
    if (target != null && (long ? c.high >= target : c.low <= target)) { px = target; reason = 'TARGET'; exitBar = j; break; }
    exitBar = j;
  }
  if (px == null) { px = candles[exitBar].close; reason = 'CLOSE'; }

  const r = (long ? px - fill : fill - px) / plan.riskPerShare - plan.costR;
  return {
    symbol: signal.symbol, date: signal.date, signalTime: signal.time,
    entryTime: clockOf(candles[fillBar]), exitTime: clockOf(candles[exitBar]),
    direction: scored.direction, score: scored.score,
    entry: round2(fill), exit: round2(px), stop: plan.stopLoss, riskPct: plan.riskPct,
    reason, open: false,
    // summarise() orders by exit; date + time keeps that chronological.
    exitDay: `${signal.date} ${clockOf(candles[exitBar])}`,
    held: exitBar - fillBar + 1,
    r: round2(r),
    costR: plan.costR,
  };
}

/**
 * Backtest the intraday formula. Returns a summary per variant, plus the
 * latest `tradeLimit` trades of the unattended-safe variant (0 for all).
 */
export function backtestIntraday(data, { entryCutoff = DEFAULT_ENTRY_CUTOFF, maxTradesPerDay = 2, tradeLimit = 100 } = {}) {
  entryCutoff = entryWindow(entryCutoff).cutoff;
  const signals = collectIntradaySignals(data, { entryCutoff, maxTradesPerDay });
  const sessions = new Set(Object.values(data.fiveMinBySymbol || {}).flat().map(dateOf));
  if (sessions.size === 0) return { available: false, reason: 'No 5-minute history to test on.' };

  const variants = {};
  let reference = [];
  for (const v of INTRADAY_VARIANTS) {
    const trades = signals.map(s => simulate(s, v)).filter(Boolean);
    const sum = summarise(trades);
    variants[v.key] = {
      label: v.label, ...sum,
      avgCostR: trades.length ? round2(trades.reduce((a, t) => a + t.costR, 0) / trades.length) : null,
      avgStopPct: trades.length ? round2(trades.reduce((a, t) => a + t.riskPct, 0) / trades.length) : null,
    };
    if (v.key === 'TIGHT_STOP_ONLY') reference = trades;
  }

  const dates = [...sessions].sort();
  return {
    available: true,
    sessions: sessions.size,
    from: dates[0], to: dates[dates.length - 1],
    entryCutoff, maxTradesPerDay,
    signals: signals.length,
    costPctRoundTrip: round2(INTRADAY_ROUND_TRIP_COST * 100),
    variants,
    trades: tradeLimit > 0 ? reference.slice(-tradeLimit) : reference,
    caveats: [
      'Order-book imbalance, spread and circuit limits are live-only signals with no history, so they are not tested here and backtested scores run a little lower than live.',
      'Costs are an estimate (brokerage, STT, exchange charges, GST, stamp duty and a little slippage); your contract notes are the real figure.',
      'The universe is today\'s F&O list, so it carries survivorship bias, and a few months is a small sample.',
      'Past results are evidence about the formula, not a forecast.',
    ],
  };
}
