import express from 'express';
import { MARKET_CONFIG } from '../../config/marketConfig.js';
import { getHistoricalCandles } from '../services/kiteService.js';
import { UNIVERSE, generateIntradaySeries } from '../services/insightsEngine.js';
import { computeStudies } from '../services/studies.js';
import { parseCookies, SESSION_COOKIE } from '../services/authService.js';

const router = express.Router();

// Mock market data - Replace with real API calls
const mockStocks = {
  'RELIANCE': { symbol: 'RELIANCE', name: 'Reliance Industries', price: 2850.50, change: 1.25 },
  'TCS': { symbol: 'TCS', name: 'Tata Consultancy Services', price: 3520.75, change: 0.85 },
  'INFY': { symbol: 'INFY', name: 'Infosys', price: 1680.30, change: -0.45 },
  'HDFCBANK': { symbol: 'HDFCBANK', name: 'HDFC Bank', price: 1620.25, change: 1.50 },
  'ICICIBANK': { symbol: 'ICICIBANK', name: 'ICICI Bank', price: 1025.80, change: 0.65 },
};

// Get all available stocks for intraday trading
router.get('/stocks', (req, res) => {
  res.json({
    exchange: 'NSE',
    stocks: Object.values(mockStocks),
    count: Object.keys(mockStocks).length,
  });
});

// Get specific stock details
router.get('/stock/:symbol', (req, res) => {
  const { symbol } = req.params;
  const stock = mockStocks[symbol.toUpperCase()];

  if (!stock) {
    return res.status(404).json({ error: 'Stock not found' });
  }

  res.json({
    ...stock,
    intraday: {
      open: stock.price + (Math.random() - 0.5) * 100,
      high: stock.price + Math.random() * 200,
      low: stock.price - Math.random() * 200,
      close: stock.price,
      volume: Math.floor(Math.random() * 1000000),
    },
  });
});

// Get market indices
router.get('/indices', (req, res) => {
  res.json({
    indices: [
      { symbol: '^NSEI', name: 'NIFTY 50', value: 21500.50, change: 1.25 },
      { symbol: '^BSESN', name: 'BSE SENSEX', value: 70500.75, change: 0.95 },
      { symbol: '^NSMID', name: 'NIFTY MIDCAP 50', value: 9850.30, change: 0.75 },
      { symbol: '^NSMICAP', name: 'NIFTY SMALLCAP 50', value: 18250.15, change: 1.15 },
    ],
  });
});

// ---------- candles for the chart ----------

// Kite's supported historical intervals. Anything else is rejected rather than
// passed through, so a typo surfaces here instead of as an opaque Kite error.
const INTERVALS = {
  minute: 1, '3minute': 3, '5minute': 5, '10minute': 10,
  '15minute': 15, '30minute': 30, '60minute': 60,
};

// Lightweight Charts renders a numeric `time` as UTC with no way to set a
// display timezone, so IST candles would read 5h30m early. Shifting the
// timestamp by the offset makes the axis show IST. This value is therefore for
// display only — never feed it back to Kite or compare it to a real epoch.
const IST_OFFSET_SECONDS = 5.5 * 3600;

function toDisplayEpoch(t) {
  const ms = t instanceof Date ? t.getTime() : new Date(t).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) + IST_OFFSET_SECONDS : null;
}

/**
 * OHLCV + studies for one symbol.
 *
 * Real Kite historical candles when the connection and the Historical Data
 * add-on allow it; otherwise the same deterministic simulator the insights
 * engine falls back to. `real` says which, so the UI can label it — a chart is
 * far more convincing than a number, and unlabelled simulated candles are the
 * easiest way for this app to mislead someone.
 */
router.get('/candles/:symbol', async (req, res) => {
  try {
    const symbol = String(req.params.symbol || '').toUpperCase();
    const stock = UNIVERSE.find(s => s.symbol === symbol);
    if (!stock) return res.status(404).json({ error: `Unknown symbol: ${symbol}` });

    const interval = String(req.query.interval || 'minute');
    if (!INTERVALS[interval]) {
      return res.status(400).json({ error: `Unsupported interval: ${interval}` });
    }
    const stepMinutes = INTERVALS[interval];

    const token = parseCookies(req)[SESSION_COOKIE];
    const days = Math.max(1, Math.min(10, Number(req.query.days) || 1));
    const to = new Date();
    const from = new Date(to.getTime() - days * 24 * 3600 * 1000);

    let candles = null;
    let real = false;

    const kiteCandles = await getHistoricalCandles(token, symbol, interval, from, to);
    if (kiteCandles?.length) {
      candles = kiteCandles.map(c => ({
        time: toDisplayEpoch(c.time),
        open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
      })).filter(c => c.time != null);
      real = candles.length > 0;
    }

    if (!real) {
      // Simulated session: synthesise timestamps from the 9:15 IST open, since
      // the simulator indexes candles rather than dating them.
      const series = generateIntradaySeries(symbol, stock.ref, new Date(), stepMinutes);
      const openIST = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate(), 9, 15) / 1000;
      candles = series.candles.map(c => ({
        time: openIST + c.t * stepMinutes * 60,
        open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
      }));
    }

    res.json({
      symbol,
      name: stock.name,
      interval,
      real,
      candles,
      studies: computeStudies(candles),
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get market configuration
router.get('/config', (req, res) => {
  res.json({
    marketConfig: MARKET_CONFIG,
  });
});

export default router;
