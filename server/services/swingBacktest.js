/**
 * Swing backtester — replays the live swing formula over history.
 *
 * It calls the same swingIndicators / scoreSwing / swingPlan the picks board
 * uses, so what it measures is the formula actually shipped, not a re-statement
 * of it that could drift. On each historical day it sees only candles up to and
 * including that day.
 *
 * Execution rules, chosen to be unflattering rather than optimistic:
 *  - A signal on day d's close is entered at day d+1's OPEN, not d's close —
 *    the close is not tradeable once you know it was a signal.
 *  - If d+1 gaps through the stop, the trade is skipped.
 *  - If one bar touches both the stop and the target, the stop is assumed to
 *    have hit first: daily bars do not record the order, so assume the worse.
 *  - A gap through the stop exits at the open, not at the stop price.
 *  - Once T1 is reached the stop moves to breakeven from the next session.
 *  - Exit at T2, at the stop, or at the close of session TIME_STOP_SESSIONS.
 *  - ROUND_TRIP_COST is charged on every trade.
 *  - One position per stock at a time.
 *
 * Results are in R (multiples of the risk taken), which is what a swing
 * formula controls; the equity curve then assumes a fixed 1% of equity risked
 * per trade, so it shows what those R-multiples compound to.
 *
 * What a backtest here cannot tell you: the universe is today's F&O list, so
 * stocks that fell out of F&O (often by falling) are missing — survivorship
 * bias that flatters longs. Eighteen large-caps over a few years is a small
 * sample. Past results are evidence, not a forecast.
 */
import {
  swingIndicators, buildSwingContext, scoreSwing, swingPlan,
  SWING_WARMUP, SWING_CUTOFF, TIME_STOP_SESSIONS, ROUND_TRIP_COST,
} from './swingEngine.js';
import { round2 } from './insightsEngine.js';

/** Risk per trade for the equity curve, as a fraction of equity. */
const RISK_PER_TRADE = 0.01;

/**
 * Formula variants measured side by side, so the choice between them rests on
 * results rather than preference. Each is a filter over the same signals.
 */
export const VARIANTS = {
  ALL: { label: 'All setups, both directions', keep: () => true },
  LONG_ONLY: { label: 'Long only', keep: s => s.direction === 'LONG' },
  BREAKOUTS: { label: '20-day breakouts and breakdowns only', keep: s => s.setup === 'BREAKOUT' || s.setup === 'BREAKDOWN' },
  BREAKOUTS_52W: { label: '52-week breakouts and breakdowns only', keep: s => s.setup === 'BREAKOUT_52W' || s.setup === 'BREAKDOWN_52W' },
  PULLBACKS: { label: 'Pullbacks and rallies only', keep: s => s.setup === 'PULLBACK' || s.setup === 'RALLY' },
  HIGH_SCORE: { label: 'Score 70 or more only', keep: s => s.score >= 70 },
};

const dayKey = c => (c.time != null ? String(c.time).slice(0, 10) : `t${c.t}`);

/**
 * Pass 1: every signal the formula would have produced, day by day.
 * Returns signals[] with the bar index of the signal day in its stock's series.
 */
export function collectSignals(candlesBySymbol) {
  const symbols = Object.keys(candlesBySymbol);
  const indexByDay = {};
  const days = new Set();
  for (const sym of symbols) {
    indexByDay[sym] = new Map(candlesBySymbol[sym].map((c, i) => [dayKey(c), i]));
    candlesBySymbol[sym].forEach(c => days.add(dayKey(c)));
  }
  const ordered = [...days].sort();
  const signals = [];

  for (const day of ordered) {
    const si = {};
    for (const sym of symbols) {
      const i = indexByDay[sym].get(day);
      // Needs a following bar to enter on.
      if (i == null || i < SWING_WARMUP - 1 || i >= candlesBySymbol[sym].length - 1) continue;
      si[sym] = swingIndicators(candlesBySymbol[sym].slice(0, i + 1));
    }
    const live = Object.keys(si).filter(s => si[s]);
    if (live.length === 0) continue;
    const ctx = buildSwingContext(si);
    for (const sym of live) {
      const scored = scoreSwing(si[sym], sym, ctx);
      if (scored.setup && scored.score >= SWING_CUTOFF) {
        signals.push({ symbol: sym, day, index: indexByDay[sym].get(day), si: si[sym], scored });
      }
    }
  }
  return signals;
}

/** Walk one trade forward from its entry bar. */
function simulateTrade(candles, signal) {
  const entryBar = signal.index + 1;
  const fill = candles[entryBar].open;
  const plan = swingPlan(signal.si, signal.scored, fill);
  if (!plan) return null;
  const long = signal.scored.direction === 'LONG';
  // Gapped straight through the stop: the setup failed before it could be taken.
  if (long ? fill <= plan.stopLoss : fill >= plan.stopLoss) return null;

  const risk = plan.riskPerShare;
  let stop = plan.stopLoss;
  let t1Hit = false;
  let exit = null, reason = null, exitBar = null;

  for (let j = entryBar; j < candles.length; j++) {
    const c = candles[j];
    const held = j - entryBar + 1;
    if (j > entryBar && (long ? c.open <= stop : c.open >= stop)) {
      exit = c.open; reason = t1Hit ? 'BREAKEVEN_GAP' : 'STOP_GAP'; exitBar = j; break;
    }
    if (long ? c.low <= stop : c.high >= stop) {
      exit = stop; reason = t1Hit ? 'BREAKEVEN' : 'STOP'; exitBar = j; break;
    }
    if (long ? c.high >= plan.target2 : c.low <= plan.target2) {
      exit = plan.target2; reason = 'TARGET2'; exitBar = j; break;
    }
    if (!t1Hit && (long ? c.high >= plan.target1 : c.low <= plan.target1)) {
      t1Hit = true;
      stop = fill; // breakeven, effective from the next session
    }
    if (held >= TIME_STOP_SESSIONS) {
      exit = c.close; reason = 'TIME'; exitBar = j; break;
    }
  }
  let open = false;
  if (exit == null) {
    exitBar = candles.length - 1; exit = candles[exitBar].close; reason = 'OPEN'; open = true;
  }

  const gross = (long ? exit - fill : fill - exit) / risk;
  const costR = (ROUND_TRIP_COST * fill) / risk;
  return {
    symbol: signal.symbol,
    direction: signal.scored.direction,
    setup: signal.scored.setup,
    score: signal.scored.score,
    signalDay: signal.day,
    entryDay: dayKey(candles[entryBar]),
    exitDay: dayKey(candles[exitBar]),
    entry: round2(fill), exit: round2(exit),
    stop: plan.stopLoss, target2: plan.target2,
    held: exitBar - entryBar + 1,
    reason, open,
    r: round2(gross - costR),
    returnPct: round2(((long ? exit / fill - 1 : 1 - exit / fill) - ROUND_TRIP_COST) * 100),
  };
}

/** Summary statistics for a list of closed trades. */
export function summarise(trades) {
  const closed = trades.filter(t => !t.open);
  const n = closed.length;
  if (n === 0) return { trades: 0 };
  const rs = closed.map(t => t.r);
  const wins = rs.filter(r => r > 0);
  const losses = rs.filter(r => r <= 0);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = -losses.reduce((a, b) => a + b, 0);

  // Equity curve: 1% of equity risked per trade, applied in exit order.
  let equity = 1, peak = 1, maxDd = 0;
  for (const t of [...closed].sort((a, b) => (a.exitDay < b.exitDay ? -1 : 1))) {
    equity *= 1 + RISK_PER_TRADE * t.r;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, 1 - equity / peak);
  }
  let streak = 0, worstStreak = 0;
  for (const r of rs) { streak = r <= 0 ? streak + 1 : 0; worstStreak = Math.max(worstStreak, streak); }

  const byReason = {};
  for (const t of closed) byReason[t.reason] = (byReason[t.reason] || 0) + 1;

  return {
    trades: n,
    winRatePct: round2((wins.length / n) * 100),
    avgR: round2(rs.reduce((a, b) => a + b, 0) / n),   // expectancy per trade
    avgWinR: wins.length ? round2(grossWin / wins.length) : 0,
    avgLossR: losses.length ? round2(-grossLoss / losses.length) : 0,
    profitFactor: grossLoss > 0 ? round2(grossWin / grossLoss) : null,
    totalR: round2(rs.reduce((a, b) => a + b, 0)),
    avgHoldSessions: round2(closed.reduce((a, t) => a + t.held, 0) / n),
    worstLosingStreak: worstStreak,
    equityMultiple: round2(equity),
    maxDrawdownPct: round2(maxDd * 100),
    exits: byReason,
  };
}

/**
 * Equal-weight buy-and-hold over the same window — the bar a strategy has to
 * clear to be worth the effort and the costs.
 */
function benchmark(candlesBySymbol, fromDay) {
  const rets = [];
  for (const candles of Object.values(candlesBySymbol)) {
    const start = candles.find(c => dayKey(c) >= fromDay);
    const end = candles[candles.length - 1];
    if (start && end && start.close > 0) rets.push(end.close / start.close - 1);
  }
  return rets.length ? round2((rets.reduce((a, b) => a + b, 0) / rets.length) * 100) : null;
}

/**
 * Backtest the swing formula. `candlesBySymbol` maps symbol -> daily candles,
 * oldest first. Returns per-variant summaries plus the trades of the full set
 * (the latest `tradeLimit` of them; 0 for all).
 */
export function backtestSwing(candlesBySymbol, { tradeLimit = 200 } = {}) {
  const eligible = Object.fromEntries(Object.entries(candlesBySymbol)
    .filter(([, c]) => Array.isArray(c) && c.length > SWING_WARMUP + 1));
  const symbols = Object.keys(eligible);
  if (symbols.length === 0) return { available: false, reason: `Needs more than ${SWING_WARMUP + 1} daily candles per stock.` };

  const signals = collectSignals(eligible);

  const variants = {};
  let allTrades = [];
  for (const [key, v] of Object.entries(VARIANTS)) {
    const busyUntil = {};
    const trades = [];
    for (const s of signals.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))) {
      if (!v.keep(s.scored)) continue;
      // One position per stock: ignore signals while one is still open.
      if (busyUntil[s.symbol] != null && s.index <= busyUntil[s.symbol]) continue;
      const t = simulateTrade(eligible[s.symbol], s);
      if (!t) continue;
      trades.push(t);
      busyUntil[s.symbol] = s.index + t.held;
    }
    variants[key] = { label: v.label, ...summarise(trades) };
    if (key === 'ALL') allTrades = trades;
  }

  const firstTestable = signals.length ? signals.reduce((m, s) => (s.day < m ? s.day : m), signals[0].day) : null;
  const lastDay = symbols.map(s => dayKey(eligible[s][eligible[s].length - 1])).sort().pop();
  return {
    available: true,
    stocks: symbols.length,
    from: firstTestable,
    to: lastDay,
    costPctRoundTrip: ROUND_TRIP_COST * 100,
    riskPerTradePct: RISK_PER_TRADE * 100,
    benchmarkBuyHoldPct: firstTestable ? benchmark(eligible, firstTestable) : null,
    variants,
    // Most recent first-to-last, capped: the full list can run to thousands.
    trades: tradeLimit > 0 ? allTrades.slice(-tradeLimit) : allTrades,
    caveats: [
      'The universe is today\'s F&O list, so stocks that dropped out — often after falling — are missing. This survivorship bias flatters long results.',
      'A small universe over a few years is a small sample; one strong year can dominate.',
      'Entries are at the next open and costs are included, but real fills, slippage on gaps and taxes will differ.',
      'Past results are evidence about the formula, not a forecast of returns.',
    ],
  };
}
