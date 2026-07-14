import express from 'express';
import { MARKET_CONFIG } from '../../config/marketConfig.js';

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

// Get market configuration
router.get('/config', (req, res) => {
  res.json({
    marketConfig: MARKET_CONFIG,
  });
});

export default router;
