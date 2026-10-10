/**
 * Insights Engine — generates intraday market insights and ranked stock picks.
 *
 * Data source strategy (per symbol, best available wins):
 *  1. Real Kite historical candles (5-min intraday + daily, for moving
 *     averages) when Kite is connected and the Historical Data add-on is
 *     enabled. This is the real technical picture.
 *  2. A deterministic simulator generates realistic intraday OHLCV series
 *     (seeded per symbol + date) when Kite/historical data is unavailable,
 *     so the UI still has something to show — but it's clearly flagged
 *     `real: false` per stock so it's never confused with live data.
 *
 * Events (board meetings / corporate announcements) and basic fundamentals
 * (P/E, 52-week range) come from NSE's public, unauthenticated endpoints
 * (see nseService.js) — best effort, never blocks the main pipeline.
 *
 * All output is algorithmic screening for educational purposes only — not
 * investment advice.
 */
import { getHistoricalCandles, getMargins, getFnoUnderlyings, getTickSize } from './kiteService.js';
import { getTodaysEvents, getFundamentals } from './nseService.js';
import { MARKET_CONFIG } from '../../config/marketConfig.js';

// NIFTY-50 style universe, restricted to F&O stocks.
//
// `ref` is ONLY a seed for the offline simulator — it is never used when Kite
// is connected, since live quotes overwrite ltp/open/close in generateInsights.
// Treat these as rough anchors, not prices: they go stale, and a stale ref
// silently produces plausible-looking simulated levels. Verify against your
// broker feed before acting on anything computed from a simulated series.
//
// `fno` is a static snapshot of F&O membership, used only when Kite's NFO
// instrument master is unavailable. When it is available, the master decides —
// stocks enter and leave F&O a few times a year, and the snapshot will lag.
//
// TATAMOTORS removed Oct 2026: the symbol ceased to exist on 14 Oct 2025 when
// the company demerged and was renamed Tata Motors Passenger Vehicles (TMPV);
// its F&O contracts were force-expired the day before. It had been falling back
// to simulated data ever since, presenting an untradeable stock as a setup.
// TMPV is not added here because its reference price is unverified.
export const UNIVERSE = [
  { symbol: 'RELIANCE',   name: 'Reliance Industries',  sector: 'Energy',     ref: 2850,  fno: true },
  { symbol: 'TCS',        name: 'Tata Consultancy',     sector: 'IT',         ref: 3520,  fno: true },
  { symbol: 'INFY',       name: 'Infosys',              sector: 'IT',         ref: 1680,  fno: true },
  { symbol: 'HDFCBANK',   name: 'HDFC Bank',            sector: 'Banking',    ref: 1620,  fno: true },
  { symbol: 'ICICIBANK',  name: 'ICICI Bank',           sector: 'Banking',    ref: 1025,  fno: true },
  { symbol: 'SBIN',       name: 'State Bank of India',  sector: 'Banking',    ref: 780,   fno: true },
  { symbol: 'BHARTIARTL', name: 'Bharti Airtel',        sector: 'Telecom',    ref: 1290,  fno: true },
  { symbol: 'ITC',        name: 'ITC',                  sector: 'FMCG',       ref: 435,   fno: true },
  { symbol: 'LT',         name: 'Larsen & Toubro',      sector: 'Infra',      ref: 3560,  fno: true },
  { symbol: 'TATASTEEL',  name: 'Tata Steel',           sector: 'Metals',     ref: 165,   fno: true },
  { symbol: 'HINDALCO',   name: 'Hindalco',             sector: 'Metals',     ref: 640,   fno: true },
  { symbol: 'AXISBANK',   name: 'Axis Bank',            sector: 'Banking',    ref: 1130,  fno: true },
  { symbol: 'MARUTI',     name: 'Maruti Suzuki',        sector: 'Auto',       ref: 12400, fno: true },
  { symbol: 'SUNPHARMA',  name: 'Sun Pharma',           sector: 'Pharma',     ref: 1520,  fno: true },
  { symbol: 'WIPRO',      name: 'Wipro',                sector: 'IT',         ref: 520,   fno: true },
  // Added Jul 2026 — active names missing from the original list. Refs sourced
  // from public quotes and cross-checked; unverified names deliberately left
  // out rather than seeded with a number that might be wrong.
  { symbol: 'BAJFINANCE', name: 'Bajaj Finance',        sector: 'Financials', ref: 1056,  fno: true },
  { symbol: 'M&M',        name: 'Mahindra & Mahindra',  sector: 'Auto',       ref: 3284,  fno: true },
  { symbol: 'BEL',        name: 'Bharat Electronics',   sector: 'Defence',    ref: 385,   fno: true },
];

/**
 * Restrict a universe to F&O stocks.
 *
 * `fnoMap` is Kite's NFO-derived Map<symbol, { lotSize, expiry }>, or null when
 * it could not be fetched. With it, membership and lot size come from the
 * exchange's own instrument list. Without it, the static `fno` flags apply and
 * lot size is unknown — a guessed lot size would be worse than none, because
 * it sizes real positions.
 *
 * Fails open to the static list, never closed to nothing: an empty or missing
 * NFO list is far likelier to be a download problem than a market with no
 * derivatives, and an empty board would hide that.
 */
export function filterToFno(universe, fnoMap) {
  const live = fnoMap instanceof Map && fnoMap.size > 0;
  const included = [];
  const excluded = [];
  for (const stock of universe) {
    const inFno = live ? fnoMap.has(stock.symbol) : stock.fno === true;
    if (inFno) {
      included.push({ ...stock, lotSize: live ? fnoMap.get(stock.symbol).lotSize : null });
    } else {
      excluded.push(stock.symbol);
    }
  }
  // A live list that matches none of these large-caps means the symbols do not
  // line up (a format change in the dump), not that all of them left F&O.
  if (live && included.length === 0) return filterToFno(universe, null);
  return { included, excluded, source: live ? 'KITE_NFO' : 'STATIC' };
}

// ---------- deterministic RNG (stable picks per symbol per day) ----------
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

// ---------- simulated intraday series (candles from 9:15) ----------
// `stepMinutes` defaults to 5, the cadence the scoring engine works on. The
// chart asks for 1-minute candles, so the session length is derived rather than
// hardcoded — per-candle drift and volatility scale with it, otherwise 1-minute
// candles would inherit five minutes' worth of range each.
export function generateIntradaySeries(symbol, refPrice, date = new Date(), stepMinutes = 5) {
  const dateKey = date.toISOString().slice(0, 10);
  const rand = mulberry32(hashSeed(symbol + dateKey));
  const SESSION_MINUTES = 375;                       // 9:15 → 15:30
  const totalCandles = Math.floor(SESSION_MINUTES / stepMinutes);
  const scale = Math.sqrt(stepMinutes / 5);          // volatility grows with √time

  const prevClose = refPrice * (1 + (rand() - 0.5) * 0.02);
  const gapPct = (rand() - 0.48) * 2.2;            // gap between roughly -1.1% and +1.1%
  const open = prevClose * (1 + gapPct / 100);
  const trendBias = (rand() - 0.5) * 0.003 * scale;  // per-candle drift
  const vol = (0.0018 + rand() * 0.0025) * scale;    // per-candle volatility

  const candles = [];
  let price = open;
  const baseVolume = Math.floor((50000 + rand() * 400000) * (stepMinutes / 5));

  // Full session cut to "now" for live feel
  const nowLocal = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const minsSinceOpen = (nowLocal.getHours() * 60 + nowLocal.getMinutes()) - (9 * 60 + 15);
  const candleCount = Math.max(3, Math.min(totalCandles, Math.floor(minsSinceOpen / stepMinutes)));

  for (let i = 0; i < candleCount; i++) {
    const drift = trendBias * price;
    const shock = (rand() - 0.5) * 2 * vol * price;
    const close = price + drift + shock;
    const high = Math.max(price, close) * (1 + rand() * vol);
    const low = Math.min(price, close) * (1 - rand() * vol);
    // U-shaped volume curve: heavy at open/close
    const sessionPos = i / totalCandles;
    const volumeMult = 1.6 - 2.2 * sessionPos + 2.0 * sessionPos * sessionPos + rand() * 0.4;
    candles.push({
      t: i,
      open: round2(price),
      high: round2(high),
      low: round2(low),
      close: round2(close),
      volume: Math.floor(baseVolume * Math.max(0.2, volumeMult)),
    });
    price = close;
  }

  return { symbol, prevClose: round2(prevClose), open: round2(open), candles };
}

export function round2(n) { return Math.round(n * 100) / 100; }

// ---------- IST time helpers ----------
export function nowIST() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
}
export function istAt(base, hours, minutes) {
  const d = new Date(base);
  d.setHours(hours, minutes, 0, 0);
  return d;
}

export function sma(closes, period) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  return round2(slice.reduce((a, b) => a + b, 0) / period);
}

/**
 * Exponential moving average as a full series, seeded with the simple average
 * of the first `period` values (the conventional seed, and the one charting
 * packages use, so values here match what a trader sees on TradingView).
 * Positions before the seed are null rather than a half-warmed value.
 */
export function emaSeries(values, period) {
  if (values.length < period) return null;
  const out = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export const MACD_PERIODS = { fast: 12, slow: 26, signal: 9 };

/**
 * MACD(12, 26, 9) on a series of closes.
 *
 * Returns null until there are enough closes for the signal line to exist —
 * `slow + signal - 1` bars. With fewer, an EMA seeded from almost nothing
 * produces a crossover out of arithmetic rather than price action, and a
 * scored crossover that is really an artefact of warm-up is worse than none.
 *
 * `histogramPct` is the histogram as a percentage of price. The raw histogram
 * is in rupees, so a ₹12,000 stock's reads fifty times a ₹240 stock's for the
 * same relative move; the percentage is what can be compared across a universe.
 */
export function computeMACD(closes, { fast, slow, signal } = MACD_PERIODS) {
  if (!Array.isArray(closes) || closes.length < slow + signal - 1) return null;

  const fastE = emaSeries(closes, fast);
  const slowE = emaSeries(closes, slow);
  // The MACD line exists from the slow EMA's seed onward.
  const macdLine = closes.slice(slow - 1).map((_, j) => fastE[j + slow - 1] - slowE[j + slow - 1]);
  const signalLine = emaSeries(macdLine, signal);
  if (!signalLine) return null;

  const hist = macdLine.map((m, i) => (signalLine[i] == null ? null : m - signalLine[i]));
  const n = hist.length;
  const histNow = hist[n - 1];
  const histPrev = hist[n - 2];
  const histPrev2 = hist[n - 3];

  // A crossover is the histogram changing sign. "Recent" means within the last
  // two bars: a cross that happened ten bars ago is an established trend whose
  // move has largely been made, not a fresh entry signal.
  const sign = v => (v == null ? 0 : Math.sign(v));
  const crossedRecently =
    (histPrev != null && sign(histNow) !== sign(histPrev) && sign(histNow) !== 0) ||
    (histPrev2 != null && sign(histPrev) !== sign(histPrev2) && sign(histNow) === sign(histPrev) && sign(histNow) !== 0);

  const price = closes[closes.length - 1];
  return {
    macd: Math.round(macdLine[n - 1] * 1e4) / 1e4,
    signal: Math.round(signalLine[n - 1] * 1e4) / 1e4,
    histogram: Math.round(histNow * 1e4) / 1e4,
    histogramPct: price ? Math.round((histNow / price) * 100 * 1e4) / 1e4 : 0,
    // Momentum behind the move: a positive histogram that is shrinking is a
    // bullish trend running out of steam, not one gathering it.
    expanding: histPrev != null && Math.abs(histNow) > Math.abs(histPrev),
    crossedRecently,
    bars: closes.length,
  };
}

// ---------- cross-sectional statistics ----------
export function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

export function median(xs) {
  if (!xs.length) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function stdev(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map(x => (x - m) ** 2)));
}

/**
 * Standardise a value against the universe (how many standard deviations from
 * the mean). Returns 0 when the universe carries no cross-sectional
 * information — a factor that cannot discriminate must not move the ranking.
 */
export function zscore(value, m, sd) {
  if (!Number.isFinite(sd) || sd === 0) return 0;
  return (value - m) / sd;
}

export function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

/**
 * Real intraday + daily series from Kite historical data. Returns null
 * (never throws) if the historical add-on isn't enabled, Kite isn't
 * connected, or the market hasn't opened yet today — callers fall back to
 * the simulator.
 */
async function fetchRealSeries(token, symbol) {
  if (!token) return null;
  const now = nowIST();
  const marketOpen = istAt(now, 9, 15);
  if (now < marketOpen) return null;

  const dayFrom = new Date(now);
  dayFrom.setDate(dayFrom.getDate() - 370);
  const dayTo = istAt(now, 0, 0);
  dayTo.setDate(dayTo.getDate() - 1); // exclude today's still-forming daily candle

  const [intraday, daily] = await Promise.all([
    getHistoricalCandles(token, symbol, '5minute', marketOpen, now),
    getHistoricalCandles(token, symbol, 'day', dayFrom, dayTo),
  ]);
  if (!intraday || intraday.length === 0) return null;

  const dailyCloses = (daily || []).map(c => c.close);
  const prevClose = dailyCloses.length ? dailyCloses[dailyCloses.length - 1] : intraday[0].open;

  return {
    symbol,
    prevClose: round2(prevClose),
    open: round2(intraday[0].open),
    candles: intraday.map(c => ({ t: c.t, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume })),
    sma20: sma(dailyCloses, 20),
    sma50: sma(dailyCloses, 50),
    sma200: sma(dailyCloses, 200),
    // The prior year's extremes. `daily` ends yesterday, so today is excluded
    // by construction — which is what lets a breakout be detected at all: a
    // 52-week high that included today's high would rise with the price and
    // could never be broken.
    ...prior52Range(daily),
    // Daily MACD is the fallback before the session has enough 5-minute bars
    // for its own; a year of daily closes is plenty to warm it up.
    macdDaily: computeMACD(dailyCloses),
  };
}

/**
 * How many candles ago the current opening-range breakout began, or null when
 * price is inside the range.
 *
 * "Current" matters: a stock that broke out at 9:35, fell back inside, and broke
 * out again at 10:10 has a fresh breakout at 10:10. The run is counted back from
 * the latest candle while closes stay beyond the range. 0 means the break is
 * happening on the latest candle — including a live price beyond the range
 * before any candle has closed there.
 */
export function orbCandlesSinceBreak(candles, orHigh, orLow, orbStatus) {
  if (orbStatus === 'INSIDE' || candles.length <= 3) return orbStatus === 'INSIDE' ? null : 0;
  const beyond = c => (orbStatus === 'BREAKOUT_UP' ? c.close > orHigh : c.close < orLow);
  let i = candles.length - 1;
  if (!beyond(candles[i])) return 0;
  while (i - 1 >= 3 && beyond(candles[i - 1])) i--;
  return candles.length - 1 - i;
}

/** Highest high and lowest low over the last 252 sessions of completed daily candles. */
export function prior52Range(daily) {
  const year = (daily || []).slice(-252).filter(c => c && c.high > 0 && c.low > 0);
  // A few weeks of history is not a 52-week range; claiming one would turn a
  // recent listing's short history into a "yearly high" breakout.
  if (year.length < 200) return { prior52High: null, prior52Low: null };
  return {
    prior52High: round2(Math.max(...year.map(c => c.high))),
    prior52Low: round2(Math.min(...year.map(c => c.low))),
  };
}

// ---------- indicator computations ----------
export function computeIndicators(series) {
  const { candles, prevClose, open } = series;

  // An empty series threw on `candles[length-1].close`. Because generateInsights
  // maps over the universe without isolating failures, one symbol with no
  // candles — a fresh listing, a halted stock, or any symbol at 9:15:00 sharp —
  // took down the entire /api/insights response with a 500. The board showed
  // nothing rather than the other eighteen stocks that were fine.
  if (!Array.isArray(candles) || candles.length === 0) {
    const ref = prevClose ?? open ?? null;
    return {
      ltp: ref, prevClose: prevClose ?? null, open: open ?? null,
      dayHigh: null, dayLow: null,
      vwap: ref, aboveVwap: false,
      orHigh: null, orLow: null, orbStatus: 'INSIDE',
      momentum30m: 0, relVolume: 0, atr: null, atrPct: null,
      pivot: null, r1: null, s1: null,
      gapPct: 0, changePct: 0, rangePosition: 50,
      volume: 0,
      sma20: series.sma20 ?? null, sma50: series.sma50 ?? null, sma200: series.sma200 ?? null,
      prior52High: series.prior52High ?? null, prior52Low: series.prior52Low ?? null,
      macd: series.macdDaily ?? null, macdTimeframe: series.macdDaily ? '1d' : null,
      real: series.real ?? false,
      noData: true,
    };
  }

  const last = candles[candles.length - 1];
  const ltp = last.close;

  const dayHigh = Math.max(...candles.map(c => c.high));
  const dayLow = Math.min(...candles.map(c => c.low));

  // VWAP
  let cumPV = 0, cumV = 0;
  for (const c of candles) {
    const typical = (c.high + c.low + c.close) / 3;
    cumPV += typical * c.volume;
    cumV += c.volume;
  }
  const vwap = round2(cumPV / cumV);

  // Opening range (first 3 candles = 15 min)
  const orCandles = candles.slice(0, 3);
  const orHigh = Math.max(...orCandles.map(c => c.high));
  const orLow = Math.min(...orCandles.map(c => c.low));
  let orbStatus = 'INSIDE';
  if (ltp > orHigh) orbStatus = 'BREAKOUT_UP';
  else if (ltp < orLow) orbStatus = 'BREAKOUT_DOWN';
  const orbBreakAgo = orbCandlesSinceBreak(candles, orHigh, orLow, orbStatus);

  // Momentum: % change over last 6 candles (30 min)
  const back = candles[Math.max(0, candles.length - 7)];
  const momentum30m = round2(((ltp - back.close) / back.close) * 100);

  // Relative volume: last 3 candles vs session average
  const avgVol = cumV / candles.length;
  const recentVol = candles.slice(-3).reduce((s, c) => s + c.volume, 0) / 3;
  const relVolume = round2(recentVol / avgVol);

  // ATR (14) on 5-min candles.
  //
  // True range needs a previous close, so with a single candle the loop below
  // cannot run. It used to divide 0 by 0 and yield NaN, which JSON turns into
  // null — every derived level silently became blank and the position-size
  // formula divided by a floor of 0.01, sizing a ₹3 lakh account into hundreds
  // of thousands of shares. In the first minutes of a session that was the
  // normal path, not an edge case.
  //
  // With one candle its own high-low is the only range information that exists,
  // so use it. With none, ATR is genuinely unknown and must say so rather than
  // produce a number.
  let atr = null;
  if (candles.length === 1) {
    atr = round2(candles[0].high - candles[0].low);
  } else if (candles.length > 1) {
    let atrSum = 0, atrN = 0;
    for (let i = Math.max(1, candles.length - 14); i < candles.length; i++) {
      const c = candles[i], p = candles[i - 1];
      atrSum += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
      atrN++;
    }
    atr = atrN > 0 ? round2(atrSum / atrN) : null;
  }
  // A zero range (an untraded or frozen stock) is as unusable as no range at
  // all — it would put the stop exactly at entry.
  if (!(atr > 0)) atr = null;

  // Classic pivots from prior day (approximated)
  const pivot = round2((prevClose * 1.005 + prevClose * 0.995 + prevClose) / 3);
  const r1 = round2(2 * pivot - prevClose * 0.995);
  const s1 = round2(2 * pivot - prevClose * 1.005);

  const gapPct = round2(((open - prevClose) / prevClose) * 100);
  const changePct = round2(((ltp - prevClose) / prevClose) * 100);
  const rangePosition = round2(((ltp - dayLow) / Math.max(0.01, dayHigh - dayLow)) * 100);

  return {
    ltp, prevClose, open, dayHigh: round2(dayHigh), dayLow: round2(dayLow),
    vwap, aboveVwap: ltp > vwap,
    orHigh: round2(orHigh), orLow: round2(orLow), orbStatus, orbBreakAgo,
    momentum30m, relVolume, atr,
    // ATR as a share of price, so volatility is comparable across a ₹160 and a
    // ₹12,000 stock. Raw ATR is not: it scales with price, not with tradeability.
    // Null propagates rather than becoming NaN — a NaN here poisons the universe
    // median and every z-score computed from it.
    atrPct: atr == null ? null : round2((atr / ltp) * 100),
    pivot, r1, s1,
    gapPct, changePct, rangePosition,
    volume: cumV,
    sma20: series.sma20 ?? null,
    sma50: series.sma50 ?? null,
    sma200: series.sma200 ?? null,
    prior52High: series.prior52High ?? null,
    prior52Low: series.prior52Low ?? null,
    ...pickMACD(candles, series),
  };
}

/**
 * MACD on the trading timeframe when the session has warmed it up, otherwise
 * daily MACD as trend context, otherwise nothing.
 *
 * 5-minute MACD(12,26,9) needs 34 bars — about 12:05 IST — before it exists.
 * Rather than score nothing all morning, a stock with daily history falls back
 * to its daily MACD. The two answer different questions (timing versus trend),
 * so the timeframe travels with the value and is named wherever it is shown.
 */
function pickMACD(candles, series) {
  const intraday = computeMACD(candles.map(c => c.close));
  if (intraday) return { macd: intraday, macdTimeframe: '5m' };
  if (series.macdDaily) return { macd: series.macdDaily, macdTimeframe: '1d' };
  return { macd: null, macdTimeframe: null };
}

/**
 * How far price sits from its 50-day average, in percent. Signed, so it reads
 * as trend strength: +6 is well into an uptrend, -6 well into a downtrend.
 * Computed from `ind.ltp` at scoring time rather than stored, because a live
 * quote overwrites ltp after indicators are built.
 */
export function maDistancePct(ind) {
  if (ind.sma50 == null || !(ind.sma50 > 0) || ind.ltp == null) return null;
  return round2(((ind.ltp - ind.sma50) / ind.sma50) * 100);
}

// ---------- scoring & pick generation ----------

/**
 * Universe-wide statistics, computed once per snapshot and passed to every
 * `scoreStock` call.
 *
 * Scoring a stock in isolation against fixed thresholds cannot tell a strong
 * stock from a strong market: on a day the whole market is up 2%, a stock up
 * 0.5% trips every "positive change" test while actually lagging badly. The
 * context supplies what an absolute threshold cannot — where this stock sits
 * relative to the others available to trade today.
 */
export function buildUniverseContext(indicators) {
  const changes = indicators.map(i => i.changePct);
  const marketChangePct = round2(mean(changes));

  // Relative strength is measured against the universe mean, so these stats are
  // taken on the already-relative values.
  const relStrengths = changes.map(c => c - marketChangePct);
  const relVolumes = indicators.map(i => i.relVolume);
  // Stocks whose ATR could not be computed carry no volatility information —
  // including them would drag the median toward whatever null sorts as.
  const atrPcts = indicators.map(i => i.atrPct).filter(v => v != null && Number.isFinite(v));

  // The tradeable volatility band is expressed as a multiple of the universe
  // median rather than as fixed percentages. Absolute bands quoted for daily
  // ATR (commonly 1.5-3% of price) do not transfer to the 5-minute candles used
  // here, where the same stocks sit nearer 0.3-0.7%; anchoring to the median
  // keeps the band meaningful across timeframes, regimes, and both data sources.
  const medianAtrPct = median(atrPcts);

  // MACD and MA distance are only defined for some stocks (MACD needs warm-up;
  // the MAs need Kite daily history), so their stats are taken over the stocks
  // that have them. Null when nobody does.
  const statsOf = xs => (xs.length ? { mean: mean(xs), sd: stdev(xs) } : null);

  // Kept per timeframe: a 5-minute and a daily histogram measure momentum over
  // windows fifty-fold apart, so pooling them would rank one stock's intraday
  // wiggle against another's multi-week trend.
  const macdByTf = {};
  for (const tf of ['5m', '1d']) {
    macdByTf[tf] = statsOf(indicators
      .filter(i => i.macd && i.macdTimeframe === tf && Number.isFinite(i.macd.histogramPct))
      .map(i => i.macd.histogramPct));
  }
  const maDistances = indicators.map(maDistancePct).filter(v => v != null && Number.isFinite(v));

  return {
    marketChangePct,
    medianAtrPct: round2(medianAtrPct),
    atrBand: { low: round2(medianAtrPct * 0.5), high: round2(medianAtrPct * 1.8) },
    relStrength: { mean: mean(relStrengths), sd: stdev(relStrengths) },
    relVolume: { mean: mean(relVolumes), sd: stdev(relVolumes) },
    macd: macdByTf,
    maDistance: statsOf(maDistances),
  };
}

/**
 * How well a stock's volatility suits an intraday trade, from 0 to 1.
 *
 * Volatility is the one factor where more is not better, so it cannot be
 * ranked monotonically. Too little range and the ATR-derived stop sits inside
 * the noise and gets taken out by spread alone; too much and a 2R target is
 * not reachable within the session. Scores 1.0 inside the band and decays to 0
 * one band-width outside it.
 */
export function volatilityFit(atrPct, band) {
  const width = band.high - band.low;
  if (!(width > 0)) return 1;
  const distance = Math.max(band.low - atrPct, atrPct - band.high, 0);
  return clamp(1 - distance / width, 0, 1);
}

/**
 * Largest magnitude the tie-breaking edge may add to or subtract from a score.
 * Must stay below 0.5: two edges at opposite extremes then shift a pair by
 * under one point, and integer scores differ by at least one. See rankScore.
 */
export const EDGE_BOUND = 0.49;

/** An opening-range break this many 5-minute candles old or newer counts as fresh. */
export const ORB_FRESH_CANDLES = 3;

/**
 * Estimated intraday (MIS) round-trip cost as a fraction of position value:
 * brokerage at ₹20 an order, STT of 0.025% on the sell side, exchange and SEBI
 * charges, GST and stamp duty, plus a little slippage. An estimate, deliberately
 * not optimistic. Against a stop of ~0.5% of price it is a quarter of the risk
 * on every trade — the reason a stop cannot usefully be made arbitrarily tight.
 */
export const INTRADAY_ROUND_TRIP_COST = 0.0012;

export function scoreStock(ind, context = null) {
  let long = 0, short = 0;
  const reasons = [];

  // Per-signal contributions, recorded alongside the prose so the UI can show
  // *why* a score is what it is rather than asserting a number. `side` is which
  // total the points landed on: BOTH for disqualifiers that hit long and short
  // equally, INFO for notes that are deliberately not scored.
  const breakdown = [];
  const note = (text, points, side) => {
    reasons.push(text);
    breakdown.push({ label: text, points, side });
  };

  // Strength relative to the rest of the universe. Without context this falls
  // back to the raw day change, which is the same thing when the market is flat.
  const relStrength = context ? round2(ind.changePct - context.marketChangePct) : ind.changePct;

  // Opening-range breakout, weighted by freshness. By afternoon nearly every
  // stock has left its first fifteen minutes' range (94% of simulated sessions),
  // so a flat +25 for "outside the range" stopped meaning anything. A break in
  // the last few candles is an entry; an old one is a move already made.
  if (ind.orbStatus !== 'INSIDE') {
    const up = ind.orbStatus === 'BREAKOUT_UP';
    const ago = ind.orbBreakAgo;
    const fresh = ago == null || ago <= ORB_FRESH_CANDLES;
    const pts = fresh ? 25 : 10;
    const label = fresh
      ? `Broke ${up ? 'above' : 'below'} 15-min opening range${ago ? ` ${ago * 5} min ago` : ' just now'}`
      : `Broke ${up ? 'above' : 'below'} opening range ${ago * 5} min ago — late, much of the move is made`;
    if (up) long += pts; else short += pts;
    note(label, pts, up ? 'LONG' : 'SHORT');
  }

  if (ind.aboveVwap && relStrength > 0) { long += 20; note(`Above VWAP and outperforming the market (+${relStrength}% relative)`, 20, 'LONG'); }
  if (!ind.aboveVwap && relStrength < 0) { short += 20; note(`Below VWAP and underperforming the market (${relStrength}% relative)`, 20, 'SHORT'); }

  if (ind.momentum30m > 0.3) { long += 15; note(`Strong 30-min momentum (+${ind.momentum30m}%)`, 15, 'LONG'); }
  if (ind.momentum30m < -0.3) { short += 15; note(`Weak 30-min momentum (${ind.momentum30m}%)`, 15, 'SHORT'); }

  // Volume confirms whichever way the stock is moving relative to its peers —
  // a surge on a stock lagging the market is distribution, not accumulation.
  if (ind.relVolume > 1.3) {
    if (relStrength >= 0) long += 15; else short += 15;
    note(`Volume surge (${ind.relVolume}x session average)`, 15, relStrength >= 0 ? 'LONG' : 'SHORT');
  }

  if (ind.gapPct > 0.4 && ind.changePct > ind.gapPct) { long += 15; note(`Gap-up (+${ind.gapPct}%) holding and extending`, 15, 'LONG'); }
  if (ind.gapPct < -0.4 && ind.changePct < ind.gapPct) { short += 15; note(`Gap-down (${ind.gapPct}%) with continued selling`, 15, 'SHORT'); }

  if (ind.rangePosition > 80) { long += 10; note('Price near day high (strength)', 10, 'LONG'); }
  if (ind.rangePosition < 20) { short += 10; note('Price near day low (weakness)', 10, 'SHORT'); }

  // ---- moving-average structure (20/50-day, needs Kite daily history) ----
  //
  // Graded rather than all-or-nothing. Fully stacked (price > MA20 > MA50) is
  // an established trend. Price on the far side of MA20 while the averages
  // still point the other way is an early turn or a pullback — real, but
  // unconfirmed, so it is worth half. The fast average decides the side
  // because it is the one that responds within a few sessions.
  if (ind.sma20 != null && ind.sma50 != null && ind.ltp != null) {
    const above20 = ind.ltp > ind.sma20;
    const below20 = ind.ltp < ind.sma20;
    if (above20 && ind.sma20 > ind.sma50) {
      long += 12; note(`Uptrend: price above MA20 (${ind.sma20}) above MA50 (${ind.sma50})`, 12, 'LONG');
    } else if (below20 && ind.sma20 < ind.sma50) {
      short += 12; note(`Downtrend: price below MA20 (${ind.sma20}) below MA50 (${ind.sma50})`, 12, 'SHORT');
    } else if (above20) {
      long += 6; note(`Reclaimed MA20 (${ind.sma20}) but MA20 still under MA50 (${ind.sma50}) — early turn, unconfirmed`, 6, 'LONG');
    } else if (below20) {
      short += 6; note(`Lost MA20 (${ind.sma20}) though MA20 still over MA50 (${ind.sma50}) — pullback, unconfirmed`, 6, 'SHORT');
    }
  }

  // ---- 52-week breakout (needs Kite daily history) ----
  //
  // Price through the prior year's high or low, measured against `ind.ltp` so a
  // live quote counts. The yearly high is a level the whole market can see:
  // above it, everyone who bought in the last twelve months is in profit and
  // there is no overhead supply waiting to sell into the move.
  //
  // Worth 10, not more. A stock clearing its 52-week high intraday is nearly
  // always above its opening range and near its day high as well, so a larger
  // weight would mostly re-count "the price went up". It earns a place because
  // a yearly high is a different and well-documented level (George & Hwang,
  // 2004) from a fifteen-minute range.
  if (ind.ltp != null) {
    if (ind.prior52High != null && ind.ltp > ind.prior52High) {
      long += 10; note(`Broke above the 52-week high (₹${ind.prior52High})`, 10, 'LONG');
    } else if (ind.prior52Low != null && ind.ltp < ind.prior52Low) {
      short += 10; note(`Broke below the 52-week low (₹${ind.prior52Low})`, 10, 'SHORT');
    }
  }

  // ---- MACD(12,26,9) ----
  //
  // Scored on the histogram, which is MACD minus its signal line: positive
  // means bullish momentum, negative bearish. Freshness and direction of change
  // set the weight. A crossover in the last two bars is a new signal; an older
  // one whose histogram is still widening is a trend with momentum behind it; an
  // older one whose histogram is shrinking is a move running out of steam, and
  // is worth least. Zero histogram means no reading.
  if (ind.macd && ind.macd.histogram !== 0) {
    const m = ind.macd;
    const bullish = m.histogram > 0;
    const tf = ind.macdTimeframe === '1d' ? 'daily' : '5-min';
    let points, label;
    if (m.crossedRecently) {
      points = 15; label = `Fresh ${tf} MACD ${bullish ? 'bullish' : 'bearish'} crossover`;
    } else if (m.expanding) {
      points = 10; label = `${tf} MACD ${bullish ? 'above' : 'below'} signal, momentum building`;
    } else {
      points = 5; label = `${tf} MACD ${bullish ? 'above' : 'below'} signal but histogram fading`;
    }
    if (bullish) long += points; else short += points;
    note(label, points, bullish ? 'LONG' : 'SHORT');
  }

  // ---- live-only microstructure signals (null unless Kite is connected) ----

  // Order book leaning meaningfully one way, confirming the price move.
  if (ind.orderImbalance != null && Math.abs(ind.orderImbalance) > 0.2) {
    const buyers = ind.orderImbalance > 0;
    if (buyers) long += 10; else short += 10;
    note(`Order book ${buyers ? 'bid-heavy' : 'offer-heavy'} (${(ind.orderImbalance * 100).toFixed(0)}% imbalance)`, 10, buyers ? 'LONG' : 'SHORT');
  }

  // Liquidity and halt risk are disqualifiers, not directional signals — they
  // subtract from whichever side the setup is on rather than favouring one.
  if (ind.spreadPct != null && ind.spreadPct > 0.15) {
    long -= 15; short -= 15;
    note(`⚠ Wide spread (${ind.spreadPct}%) — slippage will eat the edge`, -15, 'BOTH');
  }

  if (ind.circuitHeadroomPct != null && ind.circuitHeadroomPct < 2) {
    long -= 20; short -= 20;
    note(`⚠ Within ${ind.circuitHeadroomPct}% of circuit limit — halt risk`, -20, 'BOTH');
  }

  if (ind.eventToday) {
    note(`⚠ ${ind.eventToday}`, 0, 'INFO'); // informational only — deliberately not scored, event-day moves are unpredictable
  }

  // Volatility that does not suit an intraday hold is a disqualifier on either
  // side, like spread and circuit risk — the setup may be real but the trade
  // is not takeable at a sane stop distance.
  // No ATR means no volatility judgement to make. Scoring it as 1 (a perfect
  // fit) matches the no-context case: absence of information must not read as
  // evidence either for or against the setup.
  const volFit = (context && ind.atrPct != null) ? volatilityFit(ind.atrPct, context.atrBand) : 1;
  const volPenalty = Math.round((1 - volFit) * 15);
  // Only flag it when it actually costs the stock something — a name a hair
  // outside the band does not deserve a warning next to its name.
  if (volPenalty > 0) {
    const penalty = volPenalty;
    long -= penalty; short -= penalty;
    const tooQuiet = ind.atrPct < context.atrBand.low;
    note(tooQuiet
      ? `⚠ Unusually quiet (ATR ${ind.atrPct}% vs ${context.medianAtrPct}% median) — stop sits inside the noise`
      : `⚠ Unusually volatile (ATR ${ind.atrPct}% vs ${context.medianAtrPct}% median) — 2R target is a stretch`,
      -penalty, 'BOTH');
  }

  const direction = long >= short ? 'LONG' : 'SHORT';
  // Clamp low as well as high — the liquidity/circuit penalties can drive the
  // raw total negative, and a negative score would sort oddly downstream.
  const score = Math.max(0, Math.min(100, Math.max(long, short)));

  // The discrete signals land scores on coarse steps, so a 19-stock universe
  // ties heavily — six stocks sharing 85 was routine. Ties then resolved by
  // array order, silently biasing picks toward whichever names are listed first.
  //
  // `rankScore` adds a continuous cross-sectional term that orders those ties
  // by how far each stock stands out from its peers — and does nothing else.
  // `score` is always an integer, so an edge held strictly inside ±0.5 can
  // reorder equal scores but never unequal ones: a 1-point gap (the smallest
  // possible, since penalties are any whole number) survives the widest
  // possible swing of 0.98. An earlier ±7 bound claimed this property and did
  // not have it: two stocks 10 apart could swap on opposite 7-point edges.
  let edge = 0;
  if (context) {
    const sign = direction === 'LONG' ? 1 : -1;
    const rsZ = zscore(relStrength, context.relStrength.mean, context.relStrength.sd);
    const rvZ = zscore(ind.relVolume, context.relVolume.mean, context.relVolume.sd);
    // Absent MACD or MA data scores 0 — the universe mean — rather than
    // counting for or against the stock.
    const macdStats = ind.macd && context.macd ? context.macd[ind.macdTimeframe] : null;
    const macdZ = macdStats
      ? zscore(ind.macd.histogramPct, macdStats.mean, macdStats.sd) : 0;
    const maDist = maDistancePct(ind);
    const maZ = maDist != null && context.maDistance
      ? zscore(maDist, context.maDistance.mean, context.maDistance.sd) : 0;

    // Relative strength, MACD and MA distance are signed: reward them in the
    // direction being traded. Volume and volatility fit are unsigned.
    const composite =
      0.35 * sign * rsZ +
      0.20 * rvZ +
      0.20 * sign * macdZ +
      0.10 * sign * maZ +
      0.15 * (volFit * 2 - 1);
    edge = clamp(composite, -2, 2) / 2 * EDGE_BOUND;
  }

  return {
    direction,
    score,
    // Sort on this, display `score`. Keeping them separate leaves the integer
    // score the UI and the >= 40 cutoff already depend on untouched.
    // Not clamped to 0-100: clamping would collapse the tie-break for every
    // stock pinned at 0 or 100, which is exactly where ties are most common.
    // Four places, not two: edges are fractions of a point, and rounding them
    // to cents would merge near-ties back into the array-order ties this exists
    // to break.
    rankScore: Math.round((score + edge) * 1e4) / 1e4,
    relStrength,
    reasons,
    // Only the winning side's signals actually built the score, so the UI can
    // filter on `direction`. `rawTotal` is pre-clamp: when penalties push it
    // below 0 or signals above 100, the arithmetic in the tooltip would not add
    // up to the displayed score without it.
    breakdown,
    rawTotal: Math.max(long, short),
    edge: round2(edge),
  };
}

/**
 * Stop, targets and costs for an intraday trade. Pure, so the backtester uses
 * the same plan the board shows.
 *
 * TIGHT (the default) puts the stop just beyond the nearest level that proves
 * the setup wrong — back inside the opening range for a breakout, back across
 * VWAP — instead of a fixed distance. It is never wider than STANDARD's 1.5 ATR,
 * and never tighter than 1 ATR: inside that, an ordinary five-minute wiggle
 * takes the stop out, so a tighter stop only loses more often. With no
 * structural level on the right side of the entry, it falls back to 1.5 ATR.
 *
 * A tight stop does not by itself keep losses small — position size does. What
 * the stop distance sets is how many shares a fixed rupee risk buys.
 */
export function intradayPlan(ind, direction, entry, { stopMode = 'TIGHT' } = {}) {
  if (!(ind.atr > 0) || !(entry > 0)) return null;
  const long = direction === 'LONG';
  const atr = ind.atr;
  let risk = 1.5 * atr;
  let stopBasis = '1.5 ATR';

  if (stopMode === 'TIGHT') {
    // Levels whose loss would invalidate the setup, on the stop side of entry.
    const levels = [];
    if (ind.orbStatus === (long ? 'BREAKOUT_UP' : 'BREAKOUT_DOWN')) {
      levels.push({ price: long ? ind.orHigh : ind.orLow, name: 'opening range' });
    }
    if (ind.vwap != null) levels.push({ price: ind.vwap, name: 'VWAP' });
    const valid = levels.filter(l => l.price != null && (long ? l.price < entry : l.price > entry));
    if (valid.length) {
      // The nearest one: the first sign the trade is wrong is the cheapest exit.
      const nearest = valid.reduce((a, b) => (long ? (b.price > a.price ? b : a) : (b.price < a.price ? b : a)));
      const raw = long ? entry - (nearest.price - 0.25 * atr) : (nearest.price + 0.25 * atr) - entry;
      risk = clamp(raw, atr, 1.5 * atr);
      stopBasis = raw < atr ? `beyond ${nearest.name}, widened to 1 ATR`
        : raw > 1.5 * atr ? `capped at 1.5 ATR` : `just beyond ${nearest.name}`;
    }
  }

  const stopLoss = long ? entry - risk : entry + risk;
  const target1 = long ? entry + risk : entry - risk;
  const target2 = long ? entry + 2 * risk : entry - 2 * risk;
  return {
    stopLoss: round2(stopLoss),
    target1: round2(target1),
    target2: round2(target2),
    riskPerShare: round2(risk),
    riskPct: round2((risk / entry) * 100),
    stopBasis,
    // What costs alone take from every trade, in units of the risk.
    costR: round2((INTRADAY_ROUND_TRIP_COST * entry) / risk),
  };
}

export function buildPick(stock, ind, scored) {
  const { direction } = scored;
  const entry = ind.ltp;
  const isLong = direction === 'LONG';

  // Without ATR there is no defensible stop distance, so no plan can be quoted.
  // Returning nulls with a flag is the only honest option: computing levels
  // from a missing ATR produced NaN, which serialised to null and then drove a
  // position-size formula that floored the divisor at 0.01 — turning "unknown
  // risk" into "buy 644,865 shares". A blank field someone might squint past is
  // dangerous; the UI uses this flag to refuse to size the trade at all.
  const levelsAvailable = ind.atr != null && ind.atr > 0;
  if (!levelsAvailable) {
    return {
      symbol: stock.symbol,
      name: stock.name,
      sector: stock.sector,
      lotSize: stock.lotSize ?? null,
      tickSize: getTickSize(stock.symbol),
      direction,
      score: scored.score,
      rankScore: scored.rankScore,
      reasons: scored.reasons,
      breakdown: scored.breakdown,
      rawTotal: scored.rawTotal,
      edge: scored.edge,
      ltp: ind.ltp,
      changePct: ind.changePct,
      relStrength: scored.relStrength,
      levelsAvailable: false,
      levelsUnavailableReason:
        'Not enough price history yet this session to measure volatility (ATR), so no stop or targets can be calculated.',
      levels: {
        referenceEntry: entry,
        stopLoss: null, target: null, target1: null, target2: null,
        riskPerShare: null, target2Blocked: false,
        vwap: ind.vwap, pivot: ind.pivot, support1: ind.s1, resistance1: ind.r1,
      },
      indicators: { ...ind },
      fundamentals: ind.fundamentals ?? null,
      real: ind.real,
      eventToday: ind.eventToday,
    };
  }

  const plan = intradayPlan(ind, direction, entry);
  const slDistance = plan.riskPerShare;
  const { stopLoss, target1, target2 } = plan;
  // `target` is kept as an alias for T2 so existing callers don't break.
  const target = target2;

  // Is T2 actually reachable, or is a known level sitting in the way? A 2R
  // target beyond R1 (long) / S1 (short) is optimistic — flag it rather than
  // quietly presenting 2.0 as if the path were clear.
  const barrier = isLong ? ind.r1 : ind.s1;
  const target2Blocked = barrier != null &&
    (isLong ? barrier < target2 && barrier > entry : barrier > target2 && barrier < entry);

  return {
    symbol: stock.symbol,
    name: stock.name,
    sector: stock.sector,
    // F&O contract lot from Kite's NFO master; null offline rather than a guess.
    lotSize: stock.lotSize ?? null,
    // Exchange tick from Kite's instrument master: order prices must be a whole
    // number of ticks or Kite rejects them. Null offline; the UI then says so.
    tickSize: getTickSize(stock.symbol),
    direction,
    score: scored.score,
    rankScore: scored.rankScore,
    reasons: scored.reasons,
    breakdown: scored.breakdown,
    rawTotal: scored.rawTotal,
    edge: scored.edge,
    ltp: ind.ltp,
    changePct: ind.changePct,
    relStrength: scored.relStrength,
    levelsAvailable: true,
    levels: {
      referenceEntry: entry,
      stopLoss,
      target,
      target1,
      target2,
      target2Blocked,
      riskPerShare: slDistance,
      riskPct: plan.riskPct,
      stopBasis: plan.stopBasis,
      costR: plan.costR,
      riskRewardRatio: 2.0,
      vwap: ind.vwap,
      pivot: ind.pivot,
      resistance1: ind.r1,
      support1: ind.s1,
    },
    indicators: {
      gapPct: ind.gapPct,
      momentum30m: ind.momentum30m,
      relVolume: ind.relVolume,
      orbStatus: ind.orbStatus,
      aboveVwap: ind.aboveVwap,
      rangePosition: ind.rangePosition,
      atr: ind.atr,
      sma20: ind.sma20,
      sma50: ind.sma50,
      sma200: ind.sma200,
      maDistancePct: maDistancePct(ind),
      prior52High: ind.prior52High ?? null,
      prior52Low: ind.prior52Low ?? null,
      macd: ind.macd ?? null,
      macdTimeframe: ind.macdTimeframe ?? null,
      // Live-only (null on simulated series)
      bid: ind.bid ?? null,
      ask: ind.ask ?? null,
      spreadPct: ind.spreadPct ?? null,
      orderImbalance: ind.orderImbalance ?? null,
      circuitHeadroomPct: ind.circuitHeadroomPct ?? null,
    },
    real: Boolean(ind.real),
    eventToday: ind.eventToday || null,
    fundamentals: ind.fundamentals || null,
  };
}

/**
 * Main entry: full insights snapshot.
 *
 * `token` is the caller's session token, used to fetch their Kite historical
 * data (if connected) and doubles as a cache key for NSE lookups. `liveQuotes`
 * (from Kite's live quote API) overrides LTP/change with real-time data when
 * available.
 */
// Shown by default. Wider than the original 5: with a 19-name universe five was
// most of what qualified, but the cutoff is what decides quality — the limit
// only decides how much of the qualifying set is displayed.
export const DEFAULT_PICK_LIMIT = 20;

/**
 * Accepts pinned symbols as an array or a comma-separated string, and keeps
 * only names that actually exist in the universe. Unknown symbols are dropped
 * rather than erroring: a stale pin in someone's browser should not break the
 * whole insights response.
 */
export function normalisePinned(pinned) {
  const raw = Array.isArray(pinned) ? pinned : String(pinned || '').split(',');
  const known = new Set(UNIVERSE.map(s => s.symbol));
  const out = [];
  for (const item of raw) {
    const sym = String(item || '').trim().toUpperCase();
    if (known.has(sym) && !out.includes(sym)) out.push(sym);
  }
  return out.slice(0, UNIVERSE.length);
}

export const DEFAULT_ENTRY_CUTOFF = '10:30';
const ENTRY_OPENS = '09:30';     // the 15-minute opening range is complete
const LATEST_CUTOFF = '14:45';   // well clear of the 15:20 MIS auto square-off

const toMinutes = hhmm => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const fromMinutes = mins => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

/**
 * When new intraday trades may be taken. Opens once the opening range has
 * formed and closes at the trader's cutoff — 10:30 by default, for someone who
 * sets trades up in the morning and leaves them. Anything unparseable falls
 * back to the default; anything later than 14:45 is clamped, because a trade
 * entered after that has too little session left before the forced exit.
 */
export function entryWindow(cutoff, now = nowIST()) {
  const open = toMinutes(ENTRY_OPENS);
  let close = toMinutes(cutoff);
  if (close == null || close <= open) close = toMinutes(DEFAULT_ENTRY_CUTOFF);
  close = Math.min(close, toMinutes(LATEST_CUTOFF));
  const mins = now.getHours() * 60 + now.getMinutes();
  // A weekday clock is not a trading session: on a weekend or a configured
  // holiday there is no window at all, whatever the time says. The date is read
  // from the IST wall-clock fields, not toISOString(), which would shift it.
  const ymd = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const tradingDay = MARKET_CONFIG.TRADING_DAYS.includes(now.getDay()) && !MARKET_CONFIG.MARKET_HOLIDAYS.includes(ymd);
  return {
    opensAt: ENTRY_OPENS,
    cutoff: fromMinutes(close),
    state: !tradingDay ? 'MARKET_CLOSED' : mins < open ? 'BEFORE' : mins >= close ? 'CLOSED' : 'OPEN',
  };
}

export async function generateInsights(token, liveQuotes = null, options = {}) {
  // Only stocks with futures and options are considered. Filtering before the
  // per-stock fetches also saves two throttled historical calls per excluded
  // name. No token means no Kite, so skip straight to the static list.
  const fnoMap = token ? await getFnoUnderlyings(token).catch(() => null) : null;
  const fno = filterToFno(UNIVERSE, fnoMap);

  const snapshots = await Promise.all(fno.included.map(async stock => {
    const [real, events, fundamentals] = await Promise.all([
      fetchRealSeries(token, stock.symbol).catch(() => null),
      getTodaysEvents(stock.symbol).catch(() => []),
      getFundamentals(stock.symbol).catch(() => null),
    ]);
    const series = real || generateIntradaySeries(stock.symbol, stock.ref);
    const ind = computeIndicators(series);
    ind.real = Boolean(real);
    ind.eventToday = events && events.length ? events[0].subject : null;
    ind.fundamentals = fundamentals;

    // Override with real Kite quote when available
    const lq = liveQuotes && liveQuotes[`NSE:${stock.symbol}`];
    if (lq) {
      ind.ltp = lq.last_price;
      ind.prevClose = lq.ohlc?.close ?? ind.prevClose;
      ind.open = lq.ohlc?.open ?? ind.open;
      ind.dayHigh = lq.ohlc?.high ?? ind.dayHigh;
      ind.dayLow = lq.ohlc?.low ?? ind.dayLow;
      ind.volume = lq.volume ?? ind.volume;
      ind.changePct = round2(((ind.ltp - ind.prevClose) / ind.prevClose) * 100);
      ind.gapPct = round2(((ind.open - ind.prevClose) / ind.prevClose) * 100);
      ind.rangePosition = round2(((ind.ltp - ind.dayLow) / Math.max(0.01, ind.dayHigh - ind.dayLow)) * 100);

      // The /quote payload carries far more than price. These fields were
      // being fetched and discarded on every poll.

      // Exchange-published VWAP beats our candle-derived approximation.
      if (lq.average_price) ind.vwap = round2(lq.average_price);
      ind.aboveVwap = ind.ltp > ind.vwap;

      // Top-of-book spread. A wide spread is a hidden cost on every intraday
      // round trip and is the single best liquidity filter available here.
      const bid = lq.depth?.buy?.[0]?.price ?? null;
      const ask = lq.depth?.sell?.[0]?.price ?? null;
      if (bid && ask && ask > bid) {
        ind.bid = bid;
        ind.ask = ask;
        ind.spreadPct = round2(((ask - bid) / ind.ltp) * 100);
      }

      // Total pending buy vs sell quantity across the book — a crude but real
      // read on which side is leaning. Range -1 (all sellers) to +1 (all buyers).
      const bq = lq.buy_quantity ?? 0;
      const sq = lq.sell_quantity ?? 0;
      if (bq + sq > 0) ind.orderImbalance = round2((bq - sq) / (bq + sq));

      // Distance to circuit. A stock approaching its band can halt mid-trade,
      // stranding a position with no exit.
      if (lq.upper_circuit_limit && lq.lower_circuit_limit) {
        ind.upperCircuit = lq.upper_circuit_limit;
        ind.lowerCircuit = lq.lower_circuit_limit;
        ind.circuitHeadroomPct = round2(
          Math.min(lq.upper_circuit_limit - ind.ltp, ind.ltp - lq.lower_circuit_limit) / ind.ltp * 100
        );
      }

      ind.lastTradeTime = lq.last_trade_time ?? null;
    }

    return { stock, ind };
  }));

  // Scoring is a second pass: relative strength and the volatility band are
  // defined against the universe, so every stock's indicators must exist before
  // any stock can be scored.
  const context = buildUniverseContext(snapshots.map(s => s.ind));
  for (const s of snapshots) {
    s.scored = scoreStock(s.ind, context);
    s.ind.relStrength = s.scored.relStrength;
  }

  // Real account funds, so the UI can size against actual capital rather than
  // a notional. Null when disconnected — never blocks the response.
  const funds = await getMargins(token).catch(() => null);

  // Ranked picks by rank score, minimum displayed score 40. The cutoff
  // stays on the integer `score` so it keeps its plain meaning ("enough signals
  // fired"); only the ordering uses the continuous rank.
  // How many setups to show. Bounded rather than free: the cutoff still applies,
  // so asking for more than qualify simply returns fewer.
  const limit = Math.max(1, Math.min(50, Number(options.limit) || DEFAULT_PICK_LIMIT));
  const ranked = snapshots
    .filter(s => s.scored.score >= 40)
    .sort((a, b) => b.scored.rankScore - a.scored.rankScore)
    .slice(0, limit);

  // Pinned stocks stay on the board whatever they score. The list re-ranks
  // every minute, so a stock being watched can vanish mid-observation — which
  // is precisely when you most want to keep seeing it. Pins are per-request
  // (the client owns them) so this stays stateless.
  const pinned = normalisePinned(options.pinned);
  const pinnedSet = new Set(pinned);
  const rankedSymbols = new Set(ranked.map(s => s.stock.symbol));
  const pinnedExtra = pinned
    .filter(sym => !rankedSymbols.has(sym))
    .map(sym => snapshots.find(s => s.stock.symbol === sym))
    .filter(Boolean);

  const picks = [...ranked, ...pinnedExtra]
    .map(s => ({
      ...buildPick(s.stock, s.ind, s.scored),
      pinned: pinnedSet.has(s.stock.symbol),
      // A pinned stock held on screen despite failing the screen must say so.
      // Without this the card looks identical to one that earned its place,
      // which would misrepresent a 20-score stock as a setup worth taking.
      belowCutoff: s.scored.score < 40,
      outsideTop: !rankedSymbols.has(s.stock.symbol) && s.scored.score >= 40,
    }))
    // Pinned first so watched names hold a stable position instead of moving
    // under the cursor; rank orders within each group.
    .sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || (b.rankScore - a.rankScore));

  // Market breadth
  const advances = snapshots.filter(s => s.ind.changePct > 0).length;
  const declines = snapshots.filter(s => s.ind.changePct < 0).length;
  const avgChange = round2(snapshots.reduce((sum, s) => sum + s.ind.changePct, 0) / snapshots.length);

  // Sector performance
  const sectorMap = {};
  for (const s of snapshots) {
    (sectorMap[s.stock.sector] ||= []).push(s.ind.changePct);
  }
  const sectors = Object.entries(sectorMap)
    .map(([sector, chs]) => ({ sector, avgChangePct: round2(chs.reduce((a, b) => a + b, 0) / chs.length), count: chs.length }))
    .sort((a, b) => b.avgChangePct - a.avgChangePct);

  // Movers & scanners
  const bySymbol = snapshots.map(s => ({
    symbol: s.stock.symbol, name: s.stock.name, sector: s.stock.sector, lotSize: s.stock.lotSize ?? null,
    ltp: s.ind.ltp, changePct: s.ind.changePct, gapPct: s.ind.gapPct,
    relVolume: s.ind.relVolume, orbStatus: s.ind.orbStatus,
    aboveVwap: s.ind.aboveVwap, momentum30m: s.ind.momentum30m,
    atrPct: s.ind.atrPct, relStrength: s.ind.relStrength,
    score: s.scored.score, rankScore: s.scored.rankScore, direction: s.scored.direction,
    real: s.ind.real, eventToday: s.ind.eventToday,
    sma20: s.ind.sma20, sma50: s.ind.sma50, sma200: s.ind.sma200,
    maDistancePct: maDistancePct(s.ind),
    prior52High: s.ind.prior52High ?? null, prior52Low: s.ind.prior52Low ?? null,
    macdHistogram: s.ind.macd?.histogram ?? null, macdTimeframe: s.ind.macdTimeframe ?? null,
  }));

  const gainers = [...bySymbol].sort((a, b) => b.changePct - a.changePct).slice(0, 5);
  const losers = [...bySymbol].sort((a, b) => a.changePct - b.changePct).slice(0, 5);
  const volumeSpikes = bySymbol.filter(s => s.relVolume > 1.2).sort((a, b) => b.relVolume - a.relVolume).slice(0, 5);
  const orbBreakouts = bySymbol.filter(s => s.orbStatus !== 'INSIDE');

  const sentiment = avgChange > 0.3 ? 'BULLISH' : avgChange < -0.3 ? 'BEARISH' : 'NEUTRAL';
  const realCount = bySymbol.filter(s => s.real).length;

  return {
    generatedAt: new Date().toISOString(),
    dataSource: liveQuotes ? 'KITE_LIVE' : 'SIMULATED',
    realDataCoverage: `${realCount}/${bySymbol.length}`,
    disclaimer: 'Algorithmic screening for educational purposes only. Not investment advice. Consult a SEBI-registered advisor before trading.',
    breadth: { advances, declines, unchanged: snapshots.length - advances - declines, avgChangePct: avgChange, sentiment },
    // Whether new trades may be taken now. Picks are still returned after the
    // cutoff — they explain the session — but the UI marks them not to act on.
    entryWindow: entryWindow(options.entryCutoff),
    // Which stocks were eligible and on whose authority. `source` is KITE_NFO
    // when membership came from the exchange's instrument list, STATIC when it
    // fell back to the hand-maintained flags.
    universeFilter: {
      rule: 'FNO_ONLY',
      source: fno.source,
      included: fno.included.length,
      excluded: fno.excluded,
    },
    // The baselines every relative figure above is measured against, so a
    // reader can tell "up 0.5%" on a market up 2% apart from genuine strength.
    context: {
      marketChangePct: context.marketChangePct,
      medianAtrPct: context.medianAtrPct,
      tradeableAtrBand: context.atrBand,
    },
    funds,
    sectors,
    picks,
    scanners: { gainers, losers, volumeSpikes, orbBreakouts },
    universe: bySymbol,
  };
}
