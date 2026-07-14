import express from 'express';
import { generateInsights, UNIVERSE } from '../services/insightsEngine.js';
import { getUniverseQuotes, isConnected } from '../services/kiteService.js';
import { parseCookies, SESSION_COOKIE } from '../services/authService.js';

const router = express.Router();

// Full insights snapshot: breadth, sectors, picks, scanners
router.get('/', async (req, res) => {
  try {
    const token = parseCookies(req)[SESSION_COOKIE];
    const liveQuotes = await getUniverseQuotes(token, UNIVERSE.map(s => s.symbol));
    res.json(generateInsights(liveQuotes));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Just the ranked picks for the day
router.get('/picks', async (req, res) => {
  try {
    const token = parseCookies(req)[SESSION_COOKIE];
    const liveQuotes = await getUniverseQuotes(token, UNIVERSE.map(s => s.symbol));
    const insights = generateInsights(liveQuotes);
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
