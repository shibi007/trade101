import express from 'express';
import { generateInsights, UNIVERSE } from '../services/insightsEngine.js';
import { getUniverseQuotes, isConnected } from '../services/kiteService.js';
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
    const insights = await generateInsights(token, liveQuotes, { pinned: req.query.pinned, limit: req.query.limit });

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
    const insights = await generateInsights(token, liveQuotes, { pinned: req.query.pinned, limit: req.query.limit });
    res.json({
      generatedAt: insights.generatedAt,
      dataSource: insights.dataSource,
      disclaimer: insights.disclaimer,
      picks: insights.picks,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Data source status
router.get('/source', (req, res) => {
  const token = parseCookies(req)[SESSION_COOKIE];
  res.json({ dataSource: isConnected(token) ? 'KITE_LIVE' : 'SIMULATED' });
});

export default router;
