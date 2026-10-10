/**
 * Swing Engine — multi-day setups on daily candles.
 *
 * A swing trade is held for days, not minutes, so almost nothing from the
 * intraday engine transfers: no opening range, no VWAP, no session volume
 * curve. What matters over a 3-15 session hold is which way the stock is
 * trending, how it ranks against its peers, and whether today is a sensible
 * place to get on.
 *
 * The formula is built from the factors with the strongest published support at
 * this horizon, rather than from indicators chosen for familiarity:
 *
 *  - Trend template. Price above a rising 50- and 200-day average ("Stage 2",
 *    in Weinstein's and Minervini's terms). Swing trades taken with the primary
 *    trend have the market's drift behind them; trades against it fight it.
 *  - Intermediate-term relative strength. 3-12 month momentum is among the most
 *    replicated effects in equities (Jegadeesh & Titman 1993, and since across
 *    markets including India). Weighted toward the recent quarter, as IBD's RS
 *    rating does.
 *  - Nearness to the 52-week high (George & Hwang 2004): stocks close to their
 *    high tend to keep going, partly because the high acts as an anchor traders
 *    under-react to.
 *  - An entry trigger. Trend and strength say *what* to trade; they do not say
 *    *when*. A setup needs either a breakout to a new 20-day high on expanded
 *    volume, or a pullback to the 20-day average in an intact trend. Without one
 *    a stock goes on the watchlist, not the picks board.
 *
 * Published evidence is not a promise of returns: these effects are averages
 * over decades and thousands of stocks, they weaken once widely traded, and
 * they can fail for years. That is why the backtester below exists — to measure
 * the formula on real NSE prices for this universe rather than assert it.
 *
 * Shorts: Indian cash-market shorts must be squared off the same day, so a
 * multi-day short can only be held through futures. The universe is F&O-only,
 * so every SELL here is takeable — but only as a futures position, and the
 * picks say so.
 */
import {
  UNIVERSE, filterToFno, computeMACD,
  round2, mean, median, stdev, zscore, clamp, sma, nowIST, istAt,
} from './insightsEngine.js';
import { getHistoricalCandles, getFnoUnderlyings } from './kiteService.js';
import { getTodaysEvents } from './nseService.js';

// ---------- parameters ----------

/** Days of history needed before a stock can be scored: 52 weeks plus slack. */
export const SWING_WARMUP = 252;
/** Minimum score for a stock with an entry trigger to make the picks board. */
export const SWING_CUTOFF = 50;
/** Exit if neither stop nor target is hit within this many sessions. */
export const TIME_STOP_SESSIONS = 10;
/**
 * Round-trip cost as a fraction of position value. Delivery equity pays STT of
 * 0.1% on each side; exchange, SEBI, stamp duty and GST add a few basis points;
 * slippage on a liquid large-cap a few more. 0.3% is a deliberately unflattering
 * estimate — a backtest that ignores costs flatters every strategy.
 */
export const ROUND_TRIP_COST = 0.003;

// ---------- indicators ----------

/**
 * Wilder's RSI, seeded with a simple average of the first `period` changes —
 * the same definition as TradingView's ta.rsi, so values match a chart.
 * Returns null without enough history.
 */
export function computeRSI(closes, period = 14) {
  if (!Array.isArray(closes) || closes.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  gain /= period; loss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (loss === 0) return gain === 0 ? 50 : 100;
  return 100 - 100 / (1 + gain / loss);
}

function trueRanges(candles) {
  return candles.map((c, i) => (i === 0
    ? c.high - c.low
    : Math.max(c.high - c.low, Math.abs(c.high - candles[i - 1].close), Math.abs(c.low - candles[i - 1].close))));
}

/** Wilder-smoothed ATR, SMA-seeded (TradingView's ta.atr). */
export function computeATR(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period + 1) return null;
  const tr = trueRanges(candles);
  let atr = mean(tr.slice(1, period + 1));
  for (let i = period + 1; i < tr.length; i++) atr = (atr * (period - 1) + tr[i]) / period;
  return atr;
}

/**
 * Everything the scorer needs from one stock's completed daily candles.
 * Pure: the backtester calls it on every historical prefix, so it must use
 * nothing beyond the candles it is given — no lookahead, no clock.
 */
export function swingIndicators(candles) {
  if (!Array.isArray(candles) || candles.length < SWING_WARMUP) return null;
  const n = candles.length;
  const closes = candles.map(c => c.close);
  const last = candles[n - 1];
  const close = last.close;

  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const sma200 = sma(closes, 200);
  // "Rising" over a month, not day to day: a 200-day average wobbles a little
  // even in a clean trend, and one down day should not flip the classification.
  const sma200Prev = sma(closes.slice(0, n - 21), 200);

  const year = candles.slice(-252);
  const high52 = Math.max(...year.map(c => c.high));
  const low52 = Math.min(...year.map(c => c.low));

  // Momentum over the last 3, 6, 9 and 12 months (63 trading days a quarter).
  const ret = k => (n - 1 - k >= 0 ? close / closes[n - 1 - k] - 1 : null);
  const r3 = ret(63), r6 = ret(126), r9 = ret(189), r12 = ret(251);
  // IBD-style weighting: the latest quarter counts double.
  const rsReturn = 0.4 * r3 + 0.2 * r6 + 0.2 * r9 + 0.2 * r12;

  // Prior 20 sessions, excluding today — a breakout is today clearing them.
  const prior20 = candles.slice(-21, -1);
  const prior20High = Math.max(...prior20.map(c => c.close));
  const prior20Low = Math.min(...prior20.map(c => c.close));
  // The prior year's extremes, excluding today, on intraday highs and lows —
  // the same basis as the 52-week range shown on the card, so "a new 52-week
  // high" here and there mean the same price.
  const priorYear = candles.slice(-252, -1);
  const prior52High = Math.max(...priorYear.map(c => c.high));
  const prior52Low = Math.min(...priorYear.map(c => c.low));

  const volAvg50 = mean(candles.slice(-51, -1).map(c => c.volume));
  const volRatio = volAvg50 > 0 ? last.volume / volAvg50 : null;

  const atr = computeATR(candles, 14);
  // Volatility contraction: recent true range against the longer-run average.
  // A stock coiling in a tightening range before a breakout (Minervini's VCP)
  // has a defined risk point and tends to move cleanly when it does break.
  const tr = trueRanges(candles);
  const contraction = mean(tr.slice(-10)) / mean(tr.slice(-50));

  const swingLow10 = Math.min(...candles.slice(-10).map(c => c.low));
  const swingHigh10 = Math.max(...candles.slice(-10).map(c => c.high));

  return {
    close, date: last.time ?? null,
    sma20, sma50, sma200,
    sma200Rising: sma200Prev != null && sma200 > sma200Prev,
    sma200Falling: sma200Prev != null && sma200 < sma200Prev,
    high52, low52,
    pctFromHigh52: round2((close / high52 - 1) * 100),
    pctFromLow52: round2((close / low52 - 1) * 100),
    r3, r6, r9, r12, rsReturn,
    prior20High, prior20Low,
    prior52High, prior52Low,
    volRatio: volRatio == null ? null : round2(volRatio),
    atr, atrPct: atr ? round2((atr / close) * 100) : null,
    contraction: Number.isFinite(contraction) ? round2(contraction) : null,
    rsi: computeRSI(closes, 14),
    macd: computeMACD(closes),
    distMA20Pct: sma20 ? round2((close / sma20 - 1) * 100) : null,
    swingLow10, swingHigh10,
  };
}

// ---------- cross-sectional context ----------

/**
 * Where each stock's momentum ranks within the universe, plus the stats the
 * tie-break needs. Percentile rank rather than raw return so the RS points mean
 * the same thing in a bull year, when everything is up 30%, and a bear year.
 */
export function buildSwingContext(indicatorsBySymbol) {
  const entries = Object.entries(indicatorsBySymbol).filter(([, si]) => si && Number.isFinite(si.rsReturn));
  const sorted = entries.map(([, si]) => si.rsReturn).sort((a, b) => a - b);
  const rsPercentile = {};
  for (const [sym, si] of entries) {
    // Fraction of the universe this stock beats; ties share the lower rank.
    const below = sorted.findIndex(v => v >= si.rsReturn);
    rsPercentile[sym] = sorted.length > 1 ? below / (sorted.length - 1) : 0.5;
  }
  const atrPcts = entries.map(([, si]) => si.atrPct).filter(Number.isFinite);
  const rs = entries.map(([, si]) => si.rsReturn);
  const vr = entries.map(([, si]) => si.volRatio).filter(Number.isFinite);
  const medianAtrPct = median(atrPcts);
  return {
    rsPercentile,
    medianAtrPct: round2(medianAtrPct),
    // Wider than intraday's band: daily ranges vary more between a utility and
    // a metals stock, and a swing stop is sized to the daily range anyway.
    atrBand: { low: round2(medianAtrPct * 0.4), high: round2(medianAtrPct * 2.2) },
    rsReturn: { mean: mean(rs), sd: stdev(rs) },
    volRatio: { mean: mean(vr), sd: stdev(vr) },
  };
}

// ---------- scoring ----------

/** Below 0.5 so the tie-break can never reorder unequal integer scores. */
const EDGE_BOUND = 0.49;

/**
 * Score one side. `dir` is +1 for long, -1 for short; every condition is the
 * mirror image, so the two sides are scored by literally the same rules.
 */
function scoreSide(si, rsPct, dir, ctx) {
  const long = dir === 1;
  let pts = 0;
  const breakdown = [];
  const add = (label, p) => { pts += p; breakdown.push({ label, points: p, side: long ? 'LONG' : 'SHORT' }); };
  const above = (a, b) => (long ? a > b : a < b);

  // 1. Trend template.
  const trendFull = above(si.close, si.sma50) && above(si.sma50, si.sma200) &&
    (long ? si.sma200Rising : si.sma200Falling);
  const trendPartial = !trendFull && above(si.close, si.sma200) && above(si.sma50, si.sma200);
  if (trendFull) {
    add(long ? 'Stage 2 uptrend: price > MA50 > MA200, MA200 rising'
             : 'Stage 4 downtrend: price < MA50 < MA200, MA200 falling', 25);
  } else if (trendPartial) {
    add(long ? 'Above MA200 with MA50 > MA200, trend not yet confirmed'
             : 'Below MA200 with MA50 < MA200, trend not yet confirmed', 12);
  }

  // 2. Relative strength rank within the universe.
  const strength = long ? rsPct : 1 - rsPct;
  if (strength >= 0.75) add(`${long ? 'Top' : 'Bottom'} quarter for 3-12 month relative strength`, 20);
  else if (strength >= 0.5) add(`${long ? 'Upper' : 'Lower'} half for 3-12 month relative strength`, 10);

  // 3. Proximity to the 52-week extreme.
  const nearExtreme = long ? -si.pctFromHigh52 : si.pctFromLow52;
  if (nearExtreme <= 5) add(`Within ${round2(Math.abs(nearExtreme))}% of the 52-week ${long ? 'high' : 'low'}`, 15);
  else if (nearExtreme <= 15) add(`Within 15% of the 52-week ${long ? 'high' : 'low'}`, 8);

  // 4. Entry trigger — the best one counts, they are alternatives.
  const brokeOut = long ? si.close > si.prior20High : si.close < si.prior20Low;
  // A close beyond the whole prior year's range. Every such close is also a
  // new 20-day extreme, so this replaces the 20-day trigger rather than adding
  // to it, at the same weight: being at the high is already rewarded by the
  // 52-week proximity factor, and scoring it twice would count one fact twice.
  // It is kept as its own setup so the backtester can show whether it earns
  // more than an ordinary 20-day breakout, rather than assuming it does.
  const broke52 = long ? si.close > si.prior52High : si.close < si.prior52Low;
  const volumeConfirmed = si.volRatio != null && si.volRatio >= 1.5;
  const inTrend = above(si.close, si.sma50);
  const rsiZone = si.rsi != null && (long ? si.rsi >= 40 && si.rsi <= 55 : si.rsi >= 45 && si.rsi <= 60);
  const nearMA20 = si.distMA20Pct != null && Math.abs(si.distMA20Pct) <= 3;
  let setup = null;
  if (broke52 && volumeConfirmed) {
    setup = long ? 'BREAKOUT_52W' : 'BREAKDOWN_52W';
    add(long
      ? `Breakout to a new 52-week high (above ₹${round2(si.prior52High)}) on ${si.volRatio}× average volume`
      : `Breakdown to a new 52-week low (below ₹${round2(si.prior52Low)}) on ${si.volRatio}× average volume`, 20);
  } else if (brokeOut && volumeConfirmed) {
    setup = long ? 'BREAKOUT' : 'BREAKDOWN';
    add(`${long ? 'Breakout to a new 20-day high' : 'Breakdown to a new 20-day low'} on ${si.volRatio}× average volume`, 20);
  } else if (inTrend && rsiZone && nearMA20) {
    setup = long ? 'PULLBACK' : 'RALLY';
    add(long ? `Pullback to MA20 in an uptrend (RSI ${round2(si.rsi)})`
             : `Rally to MA20 in a downtrend (RSI ${round2(si.rsi)})`, 20);
  } else if (brokeOut) {
    // A breakout nobody traded is often a false one; worth noting, not acting on.
    const span = broke52 ? '52-week' : '20-day';
    add(`New ${span} ${long ? 'high' : 'low'} but volume only ${si.volRatio}× — unconfirmed`, 8);
  }

  // 5. Daily MACD, kept small: it overlaps the relative-strength factor.
  if (si.macd && si.macd.histogram !== 0 && (si.macd.histogram > 0) === long) {
    if (si.macd.crossedRecently) add(`Fresh daily MACD ${long ? 'bullish' : 'bearish'} crossover`, 10);
    else if (si.macd.expanding) add(`Daily MACD momentum building`, 5);
  }

  // 6. Volatility contraction ahead of the move.
  if (si.contraction != null && si.contraction < 0.75) {
    add(`Range tightening: 10-day range ${Math.round(si.contraction * 100)}% of 50-day`, 10);
  }

  // Penalties: chasing an extended move is how good trends become bad trades.
  if (si.distMA20Pct != null && (long ? si.distMA20Pct > 8 : si.distMA20Pct < -8)) {
    add(`⚠ Extended ${Math.abs(si.distMA20Pct)}% from MA20 — late entry, poor risk/reward`, -15);
  }
  if (si.rsi != null && (long ? si.rsi > 75 : si.rsi < 25)) {
    add(`⚠ RSI ${round2(si.rsi)} — ${long ? 'overbought' : 'oversold'}, prone to snap back`, -10);
  }
  if (ctx && si.atrPct != null) {
    const { low, high } = ctx.atrBand;
    if (si.atrPct > high) add(`⚠ Daily range ${si.atrPct}% vs ${ctx.medianAtrPct}% median — stops must be wide`, -10);
    else if (si.atrPct < low) add(`⚠ Daily range ${si.atrPct}% vs ${ctx.medianAtrPct}% median — too slow to reach targets in time`, -10);
  }

  return { points: pts, breakdown, setup };
}

/**
 * Score a stock for a swing trade. Scores both sides and keeps the stronger.
 * `setup` is null when no entry trigger fired: such a stock may be trending
 * beautifully, but there is no defined place to get on, so it is a watchlist
 * candidate rather than a pick.
 */
export function scoreSwing(si, symbol, ctx) {
  const rsPct = ctx?.rsPercentile?.[symbol] ?? 0.5;
  const longSide = scoreSide(si, rsPct, 1, ctx);
  const shortSide = scoreSide(si, rsPct, -1, ctx);
  const chosen = longSide.points >= shortSide.points ? longSide : shortSide;
  const direction = chosen === longSide ? 'LONG' : 'SHORT';
  const score = Math.max(0, Math.min(100, chosen.points));

  // Tie-break among equal scores only (see EDGE_BOUND).
  let edge = 0;
  if (ctx) {
    const sign = direction === 'LONG' ? 1 : -1;
    const rsZ = zscore(si.rsReturn, ctx.rsReturn.mean, ctx.rsReturn.sd);
    const vZ = si.volRatio != null ? zscore(si.volRatio, ctx.volRatio.mean, ctx.volRatio.sd) : 0;
    const extreme = direction === 'LONG' ? si.pctFromHigh52 / 25 : -si.pctFromLow52 / 25;
    edge = clamp(0.5 * sign * rsZ + 0.3 * vZ + 0.2 * clamp(extreme + 1, -2, 2), -2, 2) / 2 * EDGE_BOUND;
  }

  return {
    direction, score, setup: chosen.setup,
    rankScore: Math.round((score + edge) * 1e4) / 1e4,
    reasons: chosen.breakdown.map(b => b.label),
    breakdown: chosen.breakdown,
    rawTotal: chosen.points,
    rsPercentile: round2(rsPct * 100),
  };
}

// ---------- trade plan ----------

/**
 * Entry, stop and targets for a triggered setup.
 *
 * The stop goes where the setup is proven wrong, not at an arbitrary distance:
 * back below the breakout level for a breakout, below the recent swing low for a
 * pullback. That structural distance is then held between 1 and 3 ATR — tighter
 * gets stopped by ordinary daily noise, wider makes the position too small to
 * matter and the target too far to reach within the time stop.
 *
 * Targets at 2R and 3R: a swing trade's win rate is typically below half, so it
 * needs winners well over twice its losers to come out ahead.
 */
export function swingPlan(si, scored, entryPrice = si.close) {
  if (!scored.setup || !(si.atr > 0)) return null;
  const long = scored.direction === 'LONG';
  const entry = entryPrice;
  let structuralStop;
  // A breakout is proven wrong by a close back inside the range it broke out of.
  if (scored.setup === 'BREAKOUT_52W') structuralStop = si.prior52High - 0.5 * si.atr;
  else if (scored.setup === 'BREAKDOWN_52W') structuralStop = si.prior52Low + 0.5 * si.atr;
  else if (scored.setup === 'BREAKOUT') structuralStop = si.prior20High - 0.5 * si.atr;
  else if (scored.setup === 'BREAKDOWN') structuralStop = si.prior20Low + 0.5 * si.atr;
  else if (scored.setup === 'PULLBACK') structuralStop = si.swingLow10 - 0.25 * si.atr;
  else structuralStop = si.swingHigh10 + 0.25 * si.atr; // RALLY

  const rawRisk = long ? entry - structuralStop : structuralStop - entry;
  const risk = clamp(rawRisk, si.atr, 3 * si.atr);
  const stop = long ? entry - risk : entry + risk;
  const t1 = long ? entry + 2 * risk : entry - 2 * risk;
  const t2 = long ? entry + 3 * risk : entry - 3 * risk;
  // The 52-week extreme is the obvious level where sellers (or buyers) wait.
  const barrier = long ? si.high52 : si.low52;
  const target2Blocked = long ? barrier > entry && barrier < t2 : barrier < entry && barrier > t2;

  return {
    referenceEntry: round2(entry),
    stopLoss: round2(stop),
    target1: round2(t1),
    target2: round2(t2),
    riskPerShare: round2(risk),
    riskPct: round2((risk / entry) * 100),
    stopBasis: rawRisk < si.atr ? 'widened to 1 ATR' : rawRisk > 3 * si.atr ? 'capped at 3 ATR' : 'structural',
    target2Blocked,
    barrier: round2(barrier),
    timeStopSessions: TIME_STOP_SESSIONS,
  };
}

// ---------- data ----------

/**
 * Completed daily candles for one stock.
 *
 * Today's candle is included only once the session has closed: before then it
 * is a partial bar, and scoring it would trigger on a breakout that might not
 * survive the afternoon. 15:45 rather than 15:30 leaves time for the closing
 * price to be finalised.
 */
export async function fetchDailyCandles(token, symbol, days = 400) {
  if (!token) return null;
  const now = nowIST();
  const sessionDone = now >= istAt(now, 15, 45);
  const from = new Date(now);
  from.setDate(from.getDate() - days);
  const to = sessionDone ? now : istAt(now, 0, 0);
  if (!sessionDone) to.setDate(to.getDate() - 1);
  const candles = await getHistoricalCandles(token, symbol, 'day', from, to);
  return candles && candles.length ? candles : null;
}

// Deterministic RNG, same construction as the intraday simulator.
function hashSeed(str) {
  let h = 1779033703;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Simulated daily history for offline mode, ending near `ref`.
 *
 * Regime-switching drift so the board shows the full range of states — trends,
 * ranges, reversals — rather than uniform noise. It exists so the tab has
 * something to render; it carries no information about any real stock, and
 * every pick built from it is flagged `real: false`.
 */
export function generateDailySeries(symbol, ref, sessions = 320, date = new Date()) {
  const rand = mulberry32(hashSeed(`${symbol}:daily:${date.toISOString().slice(0, 10)}`));
  const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
  const raw = [];
  let p = 100, drift = (rand() - 0.5) * 0.002;
  for (let i = 0; i < sessions; i++) {
    if (rand() < 0.02) drift = (rand() - 0.5) * 0.003; // occasional regime change
    const vol = 0.012 + rand() * 0.008;
    const open = p * (1 + gauss() * vol * 0.3);
    const close = open * (1 + drift + gauss() * vol);
    const high = Math.max(open, close) * (1 + Math.abs(gauss()) * vol * 0.5);
    const low = Math.min(open, close) * (1 - Math.abs(gauss()) * vol * 0.5);
    const volume = Math.floor(1e6 * (0.6 + rand()) * (1 + Math.abs(close / open - 1) * 20));
    raw.push({ open, high, low, close, volume });
    p = close;
  }
  const scale = ref / raw[raw.length - 1].close;
  return raw.map((c, t) => ({
    t, open: round2(c.open * scale), high: round2(c.high * scale),
    low: round2(c.low * scale), close: round2(c.close * scale), volume: c.volume,
  }));
}

// ---------- main entry ----------

const DEFAULT_SWING_LIMIT = 5;

/**
 * Swing picks and watchlist for the F&O universe.
 *
 * `liveQuotes` (optional) supplies today's price as the reference entry during
 * market hours. Signals still come from completed daily candles; a live price
 * only checks whether the plan is still valid — a stop already breached or a
 * first target already reached means the moment has passed.
 */
export async function generateSwingInsights(token, liveQuotes = null, options = {}) {
  const fnoMap = token ? await getFnoUnderlyings(token).catch(() => null) : null;
  const fno = filterToFno(UNIVERSE, fnoMap);

  const rows = await Promise.all(fno.included.map(async stock => {
    const [real, events] = await Promise.all([
      fetchDailyCandles(token, stock.symbol).catch(() => null),
      getTodaysEvents(stock.symbol).catch(() => []),
    ]);
    const candles = real && real.length >= SWING_WARMUP ? real : generateDailySeries(stock.symbol, stock.ref);
    return {
      stock,
      si: swingIndicators(candles),
      real: Boolean(real && real.length >= SWING_WARMUP),
      eventToday: events && events.length ? events[0].subject : null,
    };
  }));

  const usable = rows.filter(r => r.si);
  const ctx = buildSwingContext(Object.fromEntries(usable.map(r => [r.stock.symbol, r.si])));

  const scoredRows = usable.map(r => {
    const scored = scoreSwing(r.si, r.stock.symbol, ctx);
    const lq = liveQuotes && liveQuotes[`NSE:${r.stock.symbol}`];
    const ltp = lq?.last_price ?? r.si.close;
    // The plan is anchored to the signal — the close that triggered it — and
    // the live price is tested against it. Building the plan from the live
    // price instead moved the stop along with the price, so a stock falling
    // through yesterday's stop just got a new, lower one and stayed "valid".
    const plan = swingPlan(r.si, scored, r.si.close);

    let planStatus = plan ? 'VALID' : null;
    if (plan && lq) {
      const long = scored.direction === 'LONG';
      const pastStop = long ? ltp <= plan.stopLoss : ltp >= plan.stopLoss;
      const pastT1 = long ? ltp >= plan.target1 : ltp <= plan.target1;
      if (pastStop) planStatus = 'STOPPED';
      else if (pastT1) planStatus = 'MISSED';
      // Entering now rather than at the signal close changes the risk: size on
      // what it actually is at this price.
      plan.liveEntry = round2(ltp);
      plan.liveRiskPerShare = round2(Math.abs(ltp - plan.stopLoss));
    }
    return { ...r, scored, ltp, plan, planStatus };
  });

  const card = r => ({
    symbol: r.stock.symbol,
    name: r.stock.name,
    sector: r.stock.sector,
    lotSize: r.stock.lotSize ?? null,
    direction: r.scored.direction,
    // A multi-day short is only possible in futures in India.
    instrument: r.scored.direction === 'SHORT' ? 'FUTURES' : 'CASH_OR_FUTURES',
    setup: r.scored.setup ?? 'WATCH',
    score: r.scored.score,
    rankScore: r.scored.rankScore,
    reasons: r.scored.reasons,
    breakdown: r.scored.breakdown,
    rawTotal: r.scored.rawTotal,
    ltp: round2(r.ltp),
    lastClose: round2(r.si.close),
    levels: r.plan,
    planStatus: r.planStatus,
    indicators: {
      sma20: round2(r.si.sma20), sma50: round2(r.si.sma50), sma200: round2(r.si.sma200),
      rsi: r.si.rsi != null ? round2(r.si.rsi) : null,
      atr: r.si.atr != null ? round2(r.si.atr) : null, atrPct: r.si.atrPct,
      high52: round2(r.si.high52), low52: round2(r.si.low52),
      pctFromHigh52: r.si.pctFromHigh52, pctFromLow52: r.si.pctFromLow52,
      return3m: r.si.r3 != null ? round2(r.si.r3 * 100) : null,
      return12m: r.si.r12 != null ? round2(r.si.r12 * 100) : null,
      rsPercentile: r.scored.rsPercentile,
      volRatio: r.si.volRatio, contraction: r.si.contraction,
      macdHistogram: r.si.macd?.histogram ?? null,
    },
    real: r.real,
    eventToday: r.eventToday,
  });

  const limit = Math.max(1, Math.min(50, Number(options.limit) || DEFAULT_SWING_LIMIT));
  const byRank = (a, b) => b.scored.rankScore - a.scored.rankScore;
  // Picks need a trigger and a live plan. A stopped-out or missed setup stays
  // visible in the full table but does not take a slot on the board.
  const picks = scoredRows
    .filter(r => r.scored.setup && r.scored.score >= SWING_CUTOFF && r.planStatus === 'VALID')
    .sort(byRank).slice(0, limit).map(card);
  // Strong trend, no entry yet: the stocks to check again tomorrow.
  const watchlist = scoredRows
    .filter(r => !r.scored.setup && r.scored.score >= 45)
    .sort(byRank).slice(0, limit).map(card);

  const realCount = scoredRows.filter(r => r.real).length;
  return {
    generatedAt: new Date().toISOString(),
    dataSource: realCount > 0 ? 'KITE_LIVE' : 'SIMULATED',
    realDataCoverage: `${realCount}/${scoredRows.length}`,
    basis: 'Completed daily candles; today is included only after 15:45 IST.',
    disclaimer: 'Algorithmic screening for educational purposes only. Not investment advice. Swing trades are held overnight and carry gap risk that a stop cannot prevent. Consult a SEBI-registered advisor before trading.',
    universeFilter: { rule: 'FNO_ONLY', source: fno.source, included: fno.included.length, excluded: fno.excluded },
    context: { medianAtrPct: ctx.medianAtrPct, atrBand: ctx.atrBand },
    picks,
    watchlist,
    universe: scoredRows.sort(byRank).map(card),
  };
}
