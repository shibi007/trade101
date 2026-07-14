import express from 'express';
import { isMarketOpen, MARKET_CONFIG } from '../../config/marketConfig.js';

const router = express.Router();

// In-memory store for trades (replace with database)
const trades = [];
let tradeId = 1;

// Place an intraday trade order
router.post('/place-order', (req, res) => {
  const { symbol, quantity, price, orderType, tradeType } = req.body;

  // Validation
  if (!symbol || !quantity || !orderType || !tradeType) {
    return res.status(400).json({
      error: 'Missing required fields: symbol, quantity, orderType, tradeType',
    });
  }

  // Check if market is open for intraday trading
  if (!isMarketOpen()) {
    return res.status(400).json({
      error: 'Market is closed. Intraday trading is only available during market hours (9:15 AM - 3:30 PM IST)',
    });
  }

  // Validate intraday rules
  if (tradeType !== 'INTRADAY') {
    return res.status(400).json({
      error: 'This route is for intraday trades only. Use appropriate order type for delivery trades.',
    });
  }

  const order = {
    id: tradeId++,
    symbol: symbol.toUpperCase(),
    quantity: parseInt(quantity),
    price: parseFloat(price) || 0,
    orderType: orderType.toUpperCase(), // MARKET or LIMIT
    tradeType: 'INTRADAY',
    side: tradeType === 'BUY' ? 'BUY' : 'SELL',
    status: 'PENDING',
    createdAt: new Date(),
    expiryTime: new Date(Date.now() + 24 * 60 * 60 * 1000), // Expires next day
  };

  trades.push(order);

  res.json({
    success: true,
    orderId: order.id,
    message: 'Intraday order placed successfully',
    order: {
      id: order.id,
      symbol: order.symbol,
      quantity: order.quantity,
      price: order.price,
      orderType: order.orderType,
      tradeType: order.tradeType,
      status: order.status,
      createdAt: order.createdAt,
    },
  });
});

// Get all intraday trades
router.get('/orders', (req, res) => {
  const intradayTrades = trades.filter(t => t.tradeType === 'INTRADAY');

  res.json({
    totalOrders: intradayTrades.length,
    orders: intradayTrades.map(t => ({
      id: t.id,
      symbol: t.symbol,
      quantity: t.quantity,
      price: t.price,
      orderType: t.orderType,
      status: t.status,
      createdAt: t.createdAt,
    })),
  });
});

// Get specific trade details
router.get('/order/:id', (req, res) => {
  const { id } = req.params;
  const trade = trades.find(t => t.id === parseInt(id));

  if (!trade) {
    return res.status(404).json({ error: 'Trade not found' });
  }

  res.json({
    ...trade,
    profitLoss: trade.status === 'CLOSED' ? (Math.random() - 0.5) * 1000 : 0,
  });
});

// Square off an intraday position
router.post('/square-off/:id', (req, res) => {
  const { id } = req.params;
  const trade = trades.find(t => t.id === parseInt(id));

  if (!trade) {
    return res.status(404).json({ error: 'Trade not found' });
  }

  if (trade.tradeType !== 'INTRADAY') {
    return res.status(400).json({ error: 'Only intraday positions can be squared off' });
  }

  trade.status = 'CLOSED';
  trade.closedAt = new Date();

  res.json({
    success: true,
    message: 'Position squared off successfully',
    trade: {
      id: trade.id,
      symbol: trade.symbol,
      status: trade.status,
      closedAt: trade.closedAt,
    },
  });
});

// Get intraday risk management rules
router.get('/risk-rules', (req, res) => {
  res.json({
    intradayRules: MARKET_CONFIG.INTRADAY_RULES,
    description: {
      minLotSize: 'Minimum number of shares for intraday trade',
      holdingPeriod: 'Position must be squared off same day',
      intradayMargin: 'Margin requirement for intraday (lower than delivery)',
      maxPositionSize: 'Maximum position as % of portfolio value',
      maxLossPerTrade: 'Maximum loss allowed per individual trade',
      maxDailyLoss: 'Maximum total loss allowed per day',
      autoSquareOff: 'Positions are automatically squared off before market close',
    },
  });
});

export default router;
