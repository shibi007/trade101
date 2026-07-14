import express from 'express';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
const server = createServer(app);
const wss = new WebSocketServer({ server });

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Import routes
import healthRoutes from './routes/health.js';
import marketRoutes from './routes/market.js';
import tradeRoutes from './routes/trade.js';

// Use routes
app.use('/api/health', healthRoutes);
app.use('/api/market', marketRoutes);
app.use('/api/trade', tradeRoutes);

// WebSocket connection handler
wss.on('connection', (ws) => {
  console.log('New WebSocket connection');

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      console.log('Received:', data);

      // Handle different message types
      if (data.type === 'SUBSCRIBE_PRICE') {
        ws.send(JSON.stringify({
          type: 'SUBSCRIPTION_CONFIRMED',
          symbol: data.symbol,
          timestamp: new Date().toISOString(),
        }));
      }
    } catch (error) {
      console.error('WebSocket error:', error);
    }
  });

  ws.on('close', () => {
    console.log('WebSocket connection closed');
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal Server Error',
    status: err.status || 500,
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`🚀 Trade101 Server running on http://localhost:${PORT}`);
  console.log(`📊 Market Configuration: India NSE/BSE Intraday Trading`);
  console.log(`⏰ Market Hours: 9:15 AM - 3:30 PM IST`);
});

export { app, wss };
