import express from 'express';
import { generateInsights, UNIVERSE, filterToFno, entryWindow, nowIST, istAt } from '../services/insightsEngine.js';
import { backtestIntraday } from '../services/intradayBacktest.js';
import { generateSwingInsights, fetchDailyCandles, MARKET_INDEX } from '../services/swingEngine.js';
import { backtestSwing } from '../services/swingBacktest.js';
import { getUniverseQuotes, isConnected, getFnoUnderlyings, getHistoricalCandles } from '../services/kiteService.js';
import { parseCookies, SESSION_COOKIE } from '../services/authService.js';

const router = express.Router();

// Full insights snapshot: breadth, sectors, picks, scanners
router.get('/', async (req, res) => {
  // Timed in two halves because they fail and stall for different reasons:
  // quotes are one Kite call, while generateInsights fans out to historical
  // data for the whole universe. Without the split, a slow response says
  // nothing about which one to look at.
  const startedAt = Date.now();
  let quotesMs = 0;
  try {
    const token = parseCookies(req)[SESSION_COOKIE];
    const t0 = Date.now();
    const liveQuotes = await getUniverseQuotes(token, UNIVERSE.map(s => s.symbol));
    quotesMs = Date.now() - t0;

    // Pins live in the client's localStorage and ride along per request, so the
    // server stays stateless and pins survive without a user-data store.
    const insights = await generateInsights(token, liveQuotes, {
      pinned: req.query.pinned, limit: req.query.limit, entryCutoff: req.query.entryCutoff,
    });

    const totalMs = Date.now() - startedAt;
    if (totalMs > 10_000) {
      console.warn(`⚠ /api/insights took ${totalMs}ms (quotes ${quotesMs}ms, ${insights.realDataCoverage} real) — slow enough to stall the UI`);
    }
    res.json(insights);
  } catch (err) {
    console.error(`✖ /api/insights failed after ${Date.now() - startedAt}ms (quotes ${quotesMs}ms):`, err);
    res.status(500).json({ error: err.message });
  }
});

// Just the ranked picks for the day
router.get('/picks', async (req, res) => {
  try {
    const token = parseCookies(req)[SESSION_COOKIE];
    const liveQuotes = await getUniverseQuotes(token, UNIVERSE.map(s => s.symbol));
    const insights = await generateInsights(token, liveQuotes, {
      pinned: req.query.pinned, limit: req.query.limit, entryCutoff: req.query.entryCutoff,
    });
    res.json({
      generatedAt: insights.generatedAt,
      dataSource: insights.dataSource,
      disclaimer: insights.disclaimer,
      entryWindow: insights.entryWindow,
      picks: insights.picks,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Swing picks and watchlist (multi-day holds, daily candles)
router.get('/swing', async (req, res) => {
  try {
    const token = parseCookies(req)[SESSION_COOKIE];
    // Live quotes only check whether a plan from the last close is still valid;
    // signals come from completed daily candles either way.
    const liveQuotes = await getUniverseQuotes(token, UNIVERSE.map(s => s.symbol)).catch(() => null);
    res.json(await generateSwingInsights(token, liveQuotes, { limit: req.query.limit }));
  } catch (err) {
    console.error('✖ /api/insights/swing failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// Backtest results are deterministic for a given day's data, and the run is a
// few seconds of CPU plus a historical call per stock, so one result per
// (trading day, window) is reused rather than recomputed on every click.
const backtestCache = new Map();
const BACKTEST_CACHE_MS = 30 * 60 * 1000;

// Replay the swing formula over real Kite history
router.get('/swing/backtest', async (req, res) => {
  try {
    const token = parseCookies(req)[SESSION_COOKIE];
    // Simulated prices are random by construction, so any return measured on
    // them would be fiction presented as evidence. Refuse instead.
    if (!isConnected(token)) {
      return res.json({
        available: false,
        reason: 'The backtest runs on real NSE history from Kite. Connect Kite to run it — simulated prices are random, so returns measured on them would be meaningless.',
      });
    }
    // Kite serves at most 2000 days of daily candles per request.
    const days = Math.max(400, Math.min(1900, Number(req.query.days) || 1095));
    const key = `${new Date().toISOString().slice(0, 10)}:${days}`;
    const hit = backtestCache.get(key);
    if (hit && Date.now() - hit.at < BACKTEST_CACHE_MS) return res.json(hit.result);

    const fnoMap = await getFnoUnderlyings(token).catch(() => null);
    const { included } = filterToFno(UNIVERSE, fnoMap);
    const candlesBySymbol = {};
    const missing = [];
    for (const stock of included) {
      const c = await fetchDailyCandles(token, stock.symbol, days).catch(() => null);
      if (c && c.length) candlesBySymbol[stock.symbol] = c; else missing.push(stock.symbol);
    }
    if (Object.keys(candlesBySymbol).length === 0) {
      return res.json({ available: false, reason: 'No historical data came back from Kite. The Historical Data add-on may not be enabled on your Kite Connect app.' });
    }
    // Nifty history for the market-filter variant; the backtest runs without it.
    const indexCandles = await fetchDailyCandles(token, MARKET_INDEX, days).catch(() => null);
    const t0 = Date.now();
    const result = {
      ...backtestSwing(candlesBySymbol, { indexCandles }),
      days, missing, marketIndexAvailable: Boolean(indexCandles?.length), computeMs: Date.now() - t0,
    };
    backtestCache.set(key, { at: Date.now(), result });
    res.json(result);
  } catch (err) {
    console.error('✖ /api/insights/swing/backtest failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// Replay the intraday formula over real 5-minute Kite history, as a trader who
// enters between 09:30 and their cutoff would have taken it.
router.get('/intraday/backtest', async (req, res) => {
  try {
    const token = parseCookies(req)[SESSION_COOKIE];
    if (!isConnected(token)) {
      return res.json({
        available: false,
        reason: 'The backtest runs on real 5-minute NSE history from Kite. Connect Kite to run it — simulated prices are random, so returns measured on them would be meaningless.',
      });
    }
    // Kite serves at most 100 days of 5-minute candles per request.
    const days = Math.max(20, Math.min(100, Number(req.query.days) || 60));
    const entryCutoff = entryWindow(req.query.entryCutoff).cutoff;
    const maxTradesPerDay = Math.max(1, Math.min(5, Number(req.query.maxTrades) || 2));
    const key = `intraday:${new Date().toISOString().slice(0, 10)}:${days}:${entryCutoff}:${maxTradesPerDay}`;
    const hit = backtestCache.get(key);
    if (hit && Date.now() - hit.at < BACKTEST_CACHE_MS) return res.json(hit.result);

    const fnoMap = await getFnoUnderlyings(token).catch(() => null);
    const { included } = filterToFno(UNIVERSE, fnoMap);
    const now = nowIST();
    const from = new Date(now);
    from.setDate(from.getDate() - days);
    const to = istAt(now, 0, 0); // completed sessions only — today is still forming
    const fiveMinBySymbol = {};
    const dailyBySymbol = {};
    const missing = [];
    for (const stock of included) {
      const [five, daily] = await Promise.all([
        getHistoricalCandles(token, stock.symbol, '5minute', from, to).catch(() => null),
        // A year before the first session for the MAs and the 52-week range.
        fetchDailyCandles(token, stock.symbol, days + 400).catch(() => null),
      ]);
      if (five?.length) {
        fiveMinBySymbol[stock.symbol] = five;
        if (daily?.length) dailyBySymbol[stock.symbol] = daily;
      } else {
        missing.push(stock.symbol);
      }
    }
    if (Object.keys(fiveMinBySymbol).length === 0) {
      return res.json({ available: false, reason: 'No 5-minute history came back from Kite. The Historical Data add-on may not be enabled on your Kite Connect app.' });
    }
    const t0 = Date.now();
    const result = {
      ...backtestIntraday({ fiveMinBySymbol, dailyBySymbol }, { entryCutoff, maxTradesPerDay }),
      days, missing, computeMs: Date.now() - t0,
    };
    backtestCache.set(key, { at: Date.now(), result });
    res.json(result);
  } catch (err) {
    console.error('✖ /api/insights/intraday/backtest failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// Data source status
router.get('/source', (req, res) => {
  const token = parseCookies(req)[SESSION_COOKIE];
  res.json({ dataSource: isConnected(token) ? 'KITE_LIVE' : 'SIMULATED' });
});

export default router;
