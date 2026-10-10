# Trade101 - Intraday Trading Application for Indian Markets

A comprehensive trading application designed specifically for **intraday trading in India** with support for NSE and BSE exchanges.

## 🎯 Features

### Core Trading Features
- **Intraday Trading**: Optimized for same-day trading with Indian market hours (9:15 AM - 3:30 PM IST)
- **Real-time Market Data**: Live price updates via WebSocket
- **Order Management**: Place, modify, and cancel intraday orders
- **Position Tracking**: Monitor active intraday positions
- **Auto Square-off**: Automatic position closing before market close

### Market Configuration
- **Indian Market Hours**: 9:15 AM - 3:30 PM IST (Monday - Friday)
- **NSE/BSE Support**: National Stock Exchange and Bombay Stock Exchange
- **Market Holidays**: Pre-configured with all Indian stock market holidays
- **Risk Management**: Built-in position sizing and loss limits specific to intraday trading

### Risk Management Features
- **Position Size Limits**: Max 5% of portfolio per stock
- **Per-Trade Loss Limit**: Max 2% loss per individual trade
- **Daily Loss Limit**: Max 5% daily loss threshold
- **Intraday Margin**: Lower margin requirements (20% vs 50% for delivery)
- **Circuit Breaker Rules**: Compliance with NSE circuit breaker limits

## 📐 How Stocks Are Picked

The picks board is produced by `server/services/insightsEngine.js`. It is algorithmic screening for
education, not advice.

### 1. Universe: F&O stocks only

Only stocks with exchange-traded futures and options are considered. F&O names are the most liquid on NSE,
so entries and exits fill near the quoted price.

- **Kite connected:** membership and lot size come from Kite's NFO instrument master, refreshed every
  ~20 hours. A stock counts as F&O if it has a stock future.
- **Kite not connected:** a static `fno` flag on each `UNIVERSE` entry. It will lag the exchange, which
  adds and removes stocks a few times a year. Lot size is left blank rather than guessed.
- If the NFO download fails or matches none of the universe, the engine falls back to the static list
  rather than showing an empty board.

The response's `universeFilter` field says which source was used and what was excluded.

### 2. Setup score (0–100)

Each signal adds points to the long or short side; the larger side becomes the direction and its total,
clamped to 0–100, is the score. Only setups scoring **40 or more** are shown.

| Signal | Long / short condition | Points |
|---|---|---|
| Opening range breakout | Price beyond the first 15 minutes' high / low | +25 |
| VWAP with relative strength | Above VWAP and outperforming the market / below and underperforming | +20 |
| 30-minute momentum | Move over the last 6 candles beyond ±0.3% | +15 |
| Volume surge | Above 1.3× session average, credited to the side of the relative move | +15 |
| Gap holding | Gap beyond ±0.4% that extended rather than filled | +15 |
| **MACD (12, 26, 9)** | Histogram above / below zero: fresh crossover (last 2 bars) · older and widening · older and fading | **+15 · +10 · +5** |
| **MA20 / MA50 trend** | Stacked (price > MA20 > MA50, or reverse) · price across MA20 only | **+12 · +6** |
| Range position | Near the day high (>80%) / low (<20%) | +10 |
| Order book imbalance | Resting orders >20% one way *(live only)* | +10 |
| Wide spread | Above 0.15% *(both sides)* | −15 |
| Near circuit limit | Under 2% headroom *(both sides)* | −20 |
| Unsuitable volatility | ATR% outside the universe band *(both sides)* | up to −15 |

**Relative strength** is the stock's day change minus the universe average, so "up 0.5%" on a day the
market is up 2% counts as weak. **The volatility band** is 0.5×–1.8× the universe's median ATR%,
anchored to the data rather than fixed percentages so it holds on any timeframe.

**When the trend signals are available:**

- **MA20 / MA50** are daily averages and need Kite's historical data. In simulated mode they never fire.
- **MACD** uses 5-minute candles once 34 exist (about 12:05 IST). Before that it uses daily MACD when Kite
  history is available, labelled as daily; otherwise it is absent. Values match TradingView's `ta.macd`.

A signal with no data scores nothing — absence never counts for or against a stock.

### 3. Ranking within a score

Integer scores tie often. Ties are broken by a continuous `rankScore`:

```
edge     = 0.35·RS + 0.20·RVOL + 0.20·MACD + 0.10·MA50dist + 0.15·volFit   (each a z-score
                                                                             across the universe)
rankScore = score + clamp(edge, −2, 2) / 2 × 0.49
```

RS, MACD histogram and MA50 distance are signed toward the trade direction. Because the edge is held under
±0.5 and scores are integers, **a higher score always ranks above a lower one**; the edge only orders
equal scores. MACD stats are kept separately for 5-minute and daily readings, since the two are not on
comparable scales.

### 4. Trade plan

Stop = 1.5 × ATR from entry; T1 = 1R, T2 = 2R. T2 is flagged when R1 / S1 sits in the way. No plan is
produced when ATR is unavailable.

## 📁 Project Structure

```
trade101/
├── config/
│   └── marketConfig.js          # Market configuration for India intraday trading
├── server/
│   ├── index.js                 # Main Express server
│   ├── routes/
│   │   ├── health.js            # Health check & market status
│   │   ├── market.js            # Market data endpoints
│   │   └── trade.js             # Trading order endpoints
│   └── models/                  # Database models (to be added)
├── client/
│   ├── public/
│   ├── src/
│   │   ├── components/          # React components
│   │   ├── pages/               # Page components
│   │   └── App.js
│   └── package.json
├── .env.example                 # Environment variables template
├── package.json                 # Node.js dependencies
└── README.md                    # This file
```

## 🚀 Quick Start

### Prerequisites
- Node.js 16+ installed
- npm or yarn package manager

### Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/shibi007/trade101.git
   cd trade101
   ```

2. **Install backend dependencies**
   ```bash
   npm install
   ```

3. **Install frontend dependencies**
   ```bash
   cd client
   npm install
   cd ..
   ```

4. **Create .env file**
   ```bash
   cp .env.example .env
   ```

5. **Start the application**
   
   **Option 1: Development Mode**
   ```bash
   # Terminal 1 - Start backend
   npm run dev

   # Terminal 2 - Start frontend
   npm run client
   ```

   **Option 2: Production Mode**
   ```bash
   npm run install-all
   npm start
   ```

The application will be available at `http://localhost:3000` (frontend) and `http://localhost:5000` (API).

### Running the tests
```bash
npm test
```

## 📊 API Endpoints

### Health Check
- `GET /api/health` - Server health status
- `GET /api/health/market-status` - Current market status

### Market Data
- `GET /api/market/stocks` - List all available stocks
- `GET /api/market/stock/:symbol` - Get specific stock details
- `GET /api/market/indices` - Get market indices (NIFTY 50, SENSEX, etc.)
- `GET /api/market/config` - Get market configuration

### Insights (requires login)
- `GET /api/insights` - Full snapshot: picks, F&O universe, breadth, sectors, scanners
- `GET /api/insights/picks` - Picks only
- `GET /api/insights/source` - Whether data is live from Kite or simulated
- Query: `limit` (max picks, 1–50), `pinned` (comma-separated symbols kept on the board regardless of score)

### Trading
- `POST /api/trade/place-order` - Place intraday order
- `GET /api/trade/orders` - Get all intraday orders
- `GET /api/trade/order/:id` - Get specific order details
- `POST /api/trade/square-off/:id` - Square off position
- `GET /api/trade/risk-rules` - Get risk management rules

## 📝 Example API Requests

### Place an Intraday Order
```bash
curl -X POST http://localhost:5000/api/trade/place-order \
  -H "Content-Type: application/json" \
  -d '{
    "symbol": "RELIANCE",
    "quantity": 10,
    "price": 2850.50,
    "orderType": "LIMIT",
    "tradeType": "BUY"
  }'
```

### Get Market Status
```bash
curl http://localhost:5000/api/health/market-status
```

### Get All Intraday Orders
```bash
curl http://localhost:5000/api/trade/orders
```

## 🌍 Indian Market Configuration

### Trading Hours
- **Pre-open**: 9:00 AM - 9:15 AM IST
- **Main Trading**: 9:15 AM - 3:30 PM IST
- **Trading Days**: Monday to Friday
- **Timezone**: IST (UTC+5:30)

### Intraday Rules
- **Min Lot Size**: 1 share
- **Position Holding**: Same day (must square off by close)
- **Margin**: 20% (lower than delivery margin of ~50%)
- **Max Position Size**: 5% of portfolio per stock
- **Max Loss per Trade**: 2% of portfolio
- **Max Daily Loss**: 5% of portfolio
- **Auto Square-off**: 3:25 PM (5 minutes before close)

### Supported Exchanges
- **NSE** (National Stock Exchange) - Primary exchange
- **BSE** (Bombay Stock Exchange) - Secondary exchange

## 🔐 Environment Variables

```env
# Server
PORT=5000
NODE_ENV=development

# Market
MARKET_TYPE=NSE
TIMEZONE=Asia/Kolkata

# API
API_BASE_URL=http://localhost:5000

# Database (optional)
DB_URL=mongodb://localhost:27017/trade101

# Broker Integration
BROKER_API_KEY=your_key
BROKER_API_SECRET=your_secret
BROKER_REDIRECT_URI=http://localhost:5000/auth/callback

# Logging
LOG_LEVEL=info
```

## 📈 Roadmap

- [ ] Real broker API integration (Zerodha, Angel Broking, etc.)
- [ ] Advanced charting with TradingView Lightweight Charts
- [ ] Machine learning-based trade recommendations
- [ ] Portfolio backtesting engine
- [ ] Mobile app (React Native)
- [ ] WebSocket live price streaming
- [ ] Advanced order types (OCO, Bracket orders)
- [ ] Tax reporting and P&L analysis
- [ ] Account statement integration

## 🛡️ Risk Disclaimer

This is an educational trading application for learning purposes. 

⚠️ **Important**:
- Trading in stock markets carries significant risk
- Past performance does not guarantee future results
- Always follow your broker's margin requirements
- Use proper risk management strategies
- Consult a financial advisor before trading

## 📚 Learning Resources

- [NSE India Official Website](https://www.nseindia.com/)
- [BSE India Official Website](https://www.bseindia.com/)
- [Stock Market Basics](https://www.investopedia.com/terms/i/intraday.asp)
- [Indian Tax on Trading](https://cleartax.in/s/stock-trading-income-tax)

## 🤝 Contributing

Contributions are welcome! Please follow these steps:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 👤 Author

**Trade101** - Building smarter trading tools for Indian markets

## 📞 Support

For issues, questions, or suggestions:
- Open an [Issue](https://github.com/shibi007/trade101/issues)
- Check [Discussions](https://github.com/shibi007/trade101/discussions)

---

**Last Updated**: July 2024
**Version**: 1.0.0
**Status**: Active Development