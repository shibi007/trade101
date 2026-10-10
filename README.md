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

## 📊 Swing Trading

The **Swing Picks** tab (`server/services/swingEngine.js`) finds multi-day setups, held for roughly 3–10
sessions, in the same F&O universe. It scores **completed daily candles**: today's bar counts only after
15:45 IST, so a breakout that fades in the afternoon never triggers.

### The formula

It is built from the factors with the strongest published evidence at the swing horizon. Shorts score the
mirror image of every rule.

| Factor | Condition (long) | Points |
|---|---|---|
| Trend template ("Stage 2") | Price > MA50 > MA200, MA200 rising over a month · partial: price and MA50 above MA200 | +25 · +12 |
| Relative strength rank | 3–12 month return vs the universe, latest quarter weighted 2×: top quarter · upper half | +20 · +10 |
| Near 52-week high | Within 5% · within 15% | +15 · +8 |
| **Entry trigger** | Close above the 20-day closing high on ≥1.5× 50-day volume, **or** pullback to within 3% of MA20 in an uptrend with RSI 40–55 | +20 |
| Daily MACD | Fresh crossover · momentum building | +10 · +5 |
| Range tightening | 10-day true range < 75% of the 50-day | +10 |
| Extended | More than 8% above MA20 | −15 |
| Overbought | RSI above 75 | −10 |
| Unsuitable daily range | ATR% outside 0.4×–2.2× the universe median | −10 |

A stock is a **pick** only with an entry trigger and a score of 50 or more. Strong stocks without a trigger go
on the **watchlist**. Ties are broken as on the intraday board, never reordering unequal scores.

Evidence behind the factors: 3–12 month momentum (Jegadeesh & Titman, 1993, replicated across markets
including India); nearness to the 52-week high (George & Hwang, 2004); the trend template follows Weinstein
and Minervini. **None of this guarantees returns.** These effects are averages over decades, weaken once widely
traded, and can fail for years. That is what the backtester is for.

### Trade plan

- **Stop** where the setup is proven wrong: back below the breakout level (minus 0.5 ATR), or below the last
  10 days' low (minus 0.25 ATR) for a pullback. It is then held between 1 and 3 daily ATRs.
- **Targets** at 2R and 3R. T2 is flagged when the 52-week high or low sits in the way.
- **Time stop:** exit after 10 sessions if neither is reached.
- Levels are fixed at the signal close. During market hours a live price marks a plan **STOPPED** or
  **MISSED** (past T1) and removes it from the board; otherwise sizing uses the live distance to the stop.
- **Sizing:** cash at 1×, since intraday MIS leverage does not apply overnight. **Shorts can only be held
  overnight through futures** (cash-market shorts must be squared off the same day), so SELL cards show what
  one futures lot risks.

### Backtester

`server/services/swingBacktest.js` replays the shipped formula, calling the same functions, over real Kite daily
history. Execution is deliberately unflattering:

- Entry at the **next day's open**; trades that gap through the stop are skipped.
- When one bar touches both the stop and the target, the **stop is assumed first**.
- A gap through the stop exits at the open. The stop moves to breakeven after T1.
- **0.3% round-trip cost** per trade (STT, charges and slippage on delivery).

It reports win rate, expectancy (avg R), profit factor, total R, equity multiple at 1% risk per trade, max
drawdown and holding time. These are shown for five variants (all setups, long only, breakouts only,
pullbacks only, score ≥ 70) next to equal-weight buy-and-hold, so the best entry style is chosen on
measured results. A variant needs 30+ trades to be called best.

**It is validated in both directions:** on driftless random walks it finds no edge (expectancy ≈ −costs), and
on series with real trends it finds one. A separate test checks that adding future candles never changes a
past signal (no look-ahead).

**It refuses to run without Kite.** Simulated prices are random, so any return measured on them would be
fiction. The universe is today's F&O list, so stocks that dropped out are missing (survivorship bias, which
flatters longs).

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
- `GET /api/market/candles/:symbol?interval=5minute` - OHLCV + chart studies. Intervals: `minute`, `3minute`,
  `5minute`, `10minute`, `15minute`, `30minute`, `60minute` (up to 10 days), `day` (up to 730 days, default 365)

### Insights (requires login)
- `GET /api/insights` - Full snapshot: picks, F&O universe, breadth, sectors, scanners
- `GET /api/insights/picks` - Picks only
- `GET /api/insights/swing` - Swing picks, watchlist and the full scored universe (daily candles)
- `GET /api/insights/swing/backtest?days=1095` - Replay the swing formula on Kite history (400–1900 days; requires Kite)
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