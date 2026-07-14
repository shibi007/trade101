/**
 * Insights Engine — generates intraday market insights and ranked stock picks.
 *
 * Data source strategy:
 *  - When Kite Connect is linked, real quotes are used (see kiteService).
 *  - Otherwise a deterministic simulator generates realistic intraday OHLCV
 *    series (seeded per symbol + date, so picks stay stable through the day).
 *
 * All output is algorithmic screening for educational purposes — not
 * investment advice.
 */

// NIFTY-50 style universe with reference prices and sectors
export const UNIVERSE = [
  { symbol: 'RELIANCE',   name: 'Reliance Industries',  sector: 'Energy',     ref: 2850 },
  { symbol: 'TCS',        name: 'Tata Consultancy',     sector: 'IT',         ref: 3520 },
  { symbol: 'INFY',       name: 'Infosys',              sector: 'IT',         ref: 1680 },
  { symbol: 'HDFCBANK',   name: 'HDFC Bank',            sector: 'Banking',    ref: 1620 },
  { symbol: 'ICICIBANK',  name: 'ICICI Bank',           sector: 'Banking',    ref: 1025 },
  { symbol: 'SBIN',       name: 'State Bank of India',  sector: 'Banking',    ref: 780 },
  { symbol: 'BHARTIARTL', name: 'Bharti Airtel',        sector: 'Telecom',    ref: 1290 },
  { symbol: 'ITC',        name: 'ITC',                  sector: 'FMCG',       ref: 435 },
  { symbol: 'LT',         name: 'Larsen & Toubro',      sector: 'Infra',      ref: 3560 },
  { symbol: 'TATAMOTORS', name: 'Tata Motors',          sector: 'Auto',       ref: 980 },
  { symbol: 'TATASTEEL',  name: 'Tata Steel',           sector: 'Metals',     ref: 165 },
  { symbol: 'HINDALCO',   name: 'Hindalco',             sector: 'Metals',     ref: 640 },
  { symbol: 'AXISBANK',   name: 'Axis Bank',            sector: 'Banking',    ref: 1130 },
  { symbol: 'MARUTI',     name: 'Maruti Suzuki',        sector: 'Auto',       ref: 12400 },
  { symbol: 'SUNPHARMA',  name: 'Sun Pharma',           sector: 'Pharma',     ref: 1520 },
  { symbol: 'WIPRO',      name: 'Wipro',                sector: 'IT',         ref: 520 },
];

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

// ---------- simulated intraday series (5-min candles from 9:15) ----------
export function generateIntradaySeries(symbol, refPrice, date = new Date()) {
  const dateKey = date.toISOString().slice(0, 10);
  const rand = mulberry32(hashSeed(symbol + dateKey));

  const prevClose = refPrice * (1 + (rand() - 0.5) * 0.02);
  const gapPct = (rand() - 0.48) * 2.2;            // gap between roughly -1.1% and +1.1%
  const open = prevClose * (1 + gapPct / 100);
  const trendBias = (rand() - 0.5) * 0.003;         // per-candle drift
  const vol = 0.0018 + rand() * 0.0025;             // per-candle volatility

  const candles = [];
  let price = open;
  const baseVolume = Math.floor(50000 + rand() * 400000);

  // 75 candles = full session 9:15 → 15:30; cut to "now" for live feel
  const nowIST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const minsSinceOpen = (nowIST.getHours() * 60 + nowIST.getMinutes()) - (9 * 60 + 15);
  const candleCount = Math.max(3, Math.min(75, Math.floor(minsSinceOpen / 5)));

  for (let i = 0; i < candleCount; i++) {
    const drift = trendBias * price;
    const shock = (rand() - 0.5) * 2 * vol * price;
    const close = price + drift + shock;
    const high = Math.max(price, close) * (1 + rand() * vol);
    const low = Math.min(price, close) * (1 - rand() * vol);
    // U-shaped volume curve: heavy at open/close
    const sessionPos = i / 75;
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

function round2(n) { return Math.round(n * 100) / 100; }

// ---------- indicator computations ----------
export function computeIndicators(series) {
  const { candles, prevClose, open } = series;
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

  // Momentum: % change over last 6 candles (30 min)
  const back = candles[Math.max(0, candles.length - 7)];
  const momentum30m = round2(((ltp - back.close) / back.close) * 100);

  // Relative volume: last 3 candles vs session average
  const avgVol = cumV / candles.length;
  const recentVol = candles.slice(-3).reduce((s, c) => s + c.volume, 0) / 3;
  const relVolume = round2(recentVol / avgVol);

  // ATR (14) on 5-min candles
  let atrSum = 0, atrN = 0;
  for (let i = Math.max(1, candles.length - 14); i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    atrSum += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    atrN++;
  }
  const atr = round2(atrSum / atrN);

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
    orHigh: round2(orHigh), orLow: round2(orLow), orbStatus,
    momentum30m, relVolume, atr,
    pivot, r1, s1,
    gapPct, changePct, rangePosition,
    volume: cumV,
  };
}

// ---------- scoring & pick generation ----------
export function scoreStock(ind) {
  let long = 0, short = 0;
  const reasons = [];

  if (ind.orbStatus === 'BREAKOUT_UP') { long += 25; reasons.push('Broke above 15-min opening range'); }
  if (ind.orbStatus === 'BREAKOUT_DOWN') { short += 25; reasons.push('Broke below 15-min opening range'); }

  if (ind.aboveVwap && ind.changePct > 0) { long += 20; reasons.push('Trading above VWAP with positive day change'); }
  if (!ind.aboveVwap && ind.changePct < 0) { short += 20; reasons.push('Trading below VWAP with negative day change'); }

  if (ind.momentum30m > 0.3) { long += 15; reasons.push(`Strong 30-min momentum (+${ind.momentum30m}%)`); }
  if (ind.momentum30m < -0.3) { short += 15; reasons.push(`Weak 30-min momentum (${ind.momentum30m}%)`); }

  if (ind.relVolume > 1.3) {
    const side = ind.changePct >= 0 ? 'long' : 'short';
    if (side === 'long') long += 15; else short += 15;
    reasons.push(`Volume surge (${ind.relVolume}x session average)`);
  }

  if (ind.gapPct > 0.4 && ind.changePct > ind.gapPct) { long += 15; reasons.push(`Gap-up (+${ind.gapPct}%) holding and extending`); }
  if (ind.gapPct < -0.4 && ind.changePct < ind.gapPct) { short += 15; reasons.push(`Gap-down (${ind.gapPct}%) with continued selling`); }

  if (ind.rangePosition > 80) { long += 10; reasons.push('Price near day high (strength)'); }
  if (ind.rangePosition < 20) { short += 10; reasons.push('Price near day low (weakness)'); }

  const direction = long >= short ? 'LONG' : 'SHORT';
  const score = Math.min(100, Math.max(long, short));
  return { direction, score, reasons };
}

export function buildPick(stock, ind, scored) {
  const { direction } = scored;
  const slDistance = round2(ind.atr * 1.5);
  const entry = ind.ltp;
  const stopLoss = direction === 'LONG' ? round2(entry - slDistance) : round2(entry + slDistance);
  const target = direction === 'LONG' ? round2(entry + slDistance * 2) : round2(entry - slDistance * 2);

  return {
    symbol: stock.symbol,
    name: stock.name,
    sector: stock.sector,
    direction,
    score: scored.score,
    reasons: scored.reasons,
    ltp: ind.ltp,
    changePct: ind.changePct,
    levels: {
      referenceEntry: entry,
      stopLoss,
      target,
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
    },
  };
}

/**
 * Main entry: full insights snapshot.
 * If liveQuotes (from Kite) is provided, LTP/change are overridden with real data.
 */
export function generateInsights(liveQuotes = null) {
  const snapshots = UNIVERSE.map(stock => {
    const series = generateIntradaySeries(stock.symbol, stock.ref);
    const ind = computeIndicators(series);

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
    }

    const scored = scoreStock(ind);
    return { stock, ind, scored };
  });

  // Ranked picks: top 5 by score, minimum score 40
  const picks = snapshots
    .filter(s => s.scored.score >= 40)
    .sort((a, b) => b.scored.score - a.scored.score)
    .slice(0, 5)
    .map(s => buildPick(s.stock, s.ind, s.scored));

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
    symbol: s.stock.symbol, name: s.stock.name, sector: s.stock.sector,
    ltp: s.ind.ltp, changePct: s.ind.changePct, gapPct: s.ind.gapPct,
    relVolume: s.ind.relVolume, orbStatus: s.ind.orbStatus,
    aboveVwap: s.ind.aboveVwap, momentum30m: s.ind.momentum30m,
    score: s.scored.score, direction: s.scored.direction,
  }));

  const gainers = [...bySymbol].sort((a, b) => b.changePct - a.changePct).slice(0, 5);
  const losers = [...bySymbol].sort((a, b) => a.changePct - b.changePct).slice(0, 5);
  const volumeSpikes = bySymbol.filter(s => s.relVolume > 1.2).sort((a, b) => b.relVolume - a.relVolume).slice(0, 5);
  const orbBreakouts = bySymbol.filter(s => s.orbStatus !== 'INSIDE');

  const sentiment = avgChange > 0.3 ? 'BULLISH' : avgChange < -0.3 ? 'BEARISH' : 'NEUTRAL';

  return {
    generatedAt: new Date().toISOString(),
    dataSource: liveQuotes ? 'KITE_LIVE' : 'SIMULATED',
    disclaimer: 'Algorithmic screening for educational purposes only. Not investment advice. Consult a SEBI-registered advisor before trading.',
    breadth: { advances, declines, unchanged: snapshots.length - advances - declines, avgChangePct: avgChange, sentiment },
    sectors,
    picks,
    scanners: { gainers, losers, volumeSpikes, orbBreakouts },
    universe: bySymbol,
  };
}
