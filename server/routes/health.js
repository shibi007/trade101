import express from 'express';
import { isMarketOpen, MARKET_CONFIG } from '../../config/marketConfig.js';

const router = express.Router();

// Health check endpoint
router.get('/', (req, res) => {
  const marketOpen = isMarketOpen();
  const istTime = new Date().toLocaleString('en-US', { timeZone: MARKET_CONFIG.TIMEZONE });

  res.json({
    status: 'ok',
    service: 'Trade101 API',
    timestamp: new Date().toISOString(),
    istTime: istTime,
    market: {
      open: marketOpen,
      hours: MARKET_CONFIG.MARKET_HOURS,
      timezone: MARKET_CONFIG.TIMEZONE,
    },
  });
});

// Market status endpoint
router.get('/market-status', (req, res) => {
  const marketOpen = isMarketOpen();
  const istTime = new Date().toLocaleString('en-US', { timeZone: MARKET_CONFIG.TIMEZONE });

  res.json({
    marketOpen,
    istTime,
    hours: MARKET_CONFIG.MARKET_HOURS,
    tradingDays: MARKET_CONFIG.TRADING_DAYS,
    nextHolidays: MARKET_CONFIG.MARKET_HOLIDAYS.slice(0, 5),
  });
});

export default router;
