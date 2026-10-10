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

Only stocks with exchange-traded futures and options are considered — as a **quality filter**, not a product.
The exchange admits only large, liquid, stable stocks to F&O, so entries and exits fill near the quoted price.
Every trade the app suggests is in **shares**: intraday (MIS) or delivery (CNC). No futures or options.

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
| Opening range breakout | Price beyond the first 15 minutes' high / low: fresh (last 3 candles) · older | +25 · +10 |
| VWAP with relative strength | Above VWAP and outperforming the market / below and underperforming | +20 |
| 30-minute momentum | Move over the last 6 candles beyond ±0.3% | +15 |
| Volume surge | Above 1.3× session average, credited to the side of the relative move | +15 |
| Gap holding | Gap beyond ±0.4% that extended rather than filled | +15 |
| **52-week breakout** | Price above the prior year's high / below its low *(needs Kite daily history)* | **+10** |
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
- **52-week breakout** compares the live price with the highest high / lowest low of the prior 252 sessions,
  from the same Kite daily history, which ends yesterday. Excluding today is what makes a breakout detectable:
  a 52-week high that included today's high would rise with the price. It needs 200+ sessions of history,
  and is weighted +10 because a stock at a yearly high usually trips the opening-range and range-position
  signals too.
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

- **Stop (tight by default):** just beyond the nearest level that proves the setup wrong, i.e. back inside the
  opening range for a breakout, or back across VWAP, minus 0.25 ATR. It is held between **1 and 1.5 ATR**:
  never wider than the old fixed 1.5 ATR, and never tighter than 1 ATR, where ordinary 5-minute noise would
  take it out. With no structural level on the stop side, it is 1.5 ATR.
- **Targets:** T1 = 1R, T2 = 2R. T2 is flagged when R1 / S1 sits in the way.
- **Costs:** each pick shows estimated round-trip costs in R (`costR`). That is 0.12% of the position
  (brokerage, STT, exchange charges, GST, stamp duty and a little slippage) as a share of the stop distance.
  It's usually 0.15–0.3R, which is why a tighter stop stops helping.
- No plan is produced when ATR is unavailable.

### 5. Entry window

New intraday trades are offered from **09:30** (once the opening range has formed) until the trader's cutoff,
**10:30 by default** and capped at 14:45. The cutoff is set per browser and passed as `entryCutoff`. Outside
the window, or on a weekend or configured holiday, the board still shows setups but greys them out and gives
no order ticket.

> The holiday list in `config/marketConfig.js` currently covers 2024 only. Until it is updated from NSE's
> circular, holidays after 2024 are treated as trading days.

### 6. Keeping losses small

The loss on a trade is shares × stop distance, so **position size, not stop distance, caps it**. Every ticket
sizes the quantity so that hitting the stop costs exactly the trader's **risk per trade** (0.5% of capital by
default; 0.25–2% selectable). With **max trades per day** (2 by default), that fixes the worst normal day:
2 × 0.5% = −1%. Both show on the board. A gap or circuit halt can still exit below a stop; no order type
removes that.

### 7. Order tickets

Every pick shows exactly what to enter in Kite, with prices rounded to the stock's tick size from Kite's
instrument master (₹0.05 offline, with a note):

- **Intraday:** an `Intraday (MIS)` `Limit` entry, then the moment it fills an `SL-M` stop (or `SL` with a
  limit just past the trigger). GTT does not support MIS, and bracket orders were discontinued in 2020.
  Leaving a target order working beside the stop is **not** recommended when unattended: the two aren't linked,
  so when one fills the other can open a new position. Unexited positions are squared off by the broker at
  3:20 PM (Zerodha: ₹50 + GST per order).
- **Swing:** a `Delivery (CNC)` buy, then a **GTT OCO** with the stop leg (limit 0.5% past the trigger)
  and the T2 target. A GTT can't move the stop to breakeven at T1 or exit after 10 sessions; the card gives
  the price and the date.

### 8. Intraday backtester

`server/services/intradayBacktest.js` replays the formula on real Kite **5-minute** history (20–100 days; Kite
serves at most 100 days per request), the way a morning-only trader would take it:

- At each candle close from 09:30 to the cutoff it sees only that day's candles so far plus daily history up
  to the previous session.
- It takes at most the daily trade limit, in rank order, and enters at the next candle's open.
- Exits are at the stop, the target, or the 15:15 close. A candle touching both stop and target counts as a
  stop, and a gap through the stop exits at the open.
- Costs are charged on every trade.

It compares six combinations: tight vs 1.5 ATR stops, each with **no target (hold to 15:15, the only
unattended-safe setup)**, a 1R target, or a 2R target. On random data, gross results for the target variants
sit at about 0R over 4,000 trades, which confirms there's no look-ahead. Order-book, spread and circuit signals
have no history, so they aren't tested. Like the swing backtester, it refuses to run without Kite.

## 📊 Swing Trading

The **Swing Picks** tab (`server/services/swingEngine.js`) finds multi-day setups, held for roughly 3–10
sessions, in the same F&O universe. Swing is **buy-only, in shares (CNC delivery)**: a share short
cannot be held overnight in India, and futures and options are out of scope. It scores **completed daily candles**: today's bar counts only after
15:45 IST, so a breakout that fades in the afternoon never triggers.

### The formula

It is built from the factors with the strongest published evidence at the swing horizon.

| Factor | Condition | Points |
|---|---|---|
| Trend template ("Stage 2") | Price > MA50 > MA200, MA200 rising over a month · partial: price and MA50 above MA200 | +25 · +12 |
| Relative strength rank | 3–12 month return vs the universe, latest quarter weighted 2×: top quarter · upper half | +20 · +10 |
| Near 52-week high | Within 5% · within 15% | +15 · +8 |
| **Entry trigger** | One of: **52-week breakout** (close above the prior year's high on ≥1.5× 50-day volume) · 20-day breakout (close above the 20-day closing high on ≥1.5× volume) · pullback to within 3% of MA20 in an uptrend with RSI 40–55 | +20 |
| Daily MACD | Fresh crossover · momentum building | +10 · +5 |
| Range tightening | 10-day true range < 75% of the 50-day | +10 |
| Extended | More than 8% above MA20 | −15 |
| Overbought | RSI above 75 | −10 |
| Unsuitable daily range | ATR% outside 0.4×–2.2× the universe median | −10 |

A 52-week breakout is always also a 20-day one, so it *replaces* that trigger at the same weight rather than
stacking on it — being at the high is already rewarded by the proximity factor. It is labelled separately so the
backtester can show whether it outperforms.

The swing board also shows the **market trend**: Nifty 50 against its 200-day average, from Kite's index history.
A pick trading against it is flagged "against the market" but not penalised. Whether filtering on it helps is
measured by the backtest's market-filter variant.

A stock is a **pick** only with an entry trigger and a score of 50 or more. Strong stocks without a trigger go
on the **watchlist**. Ties are broken as on the intraday board, never reordering unequal scores.

Evidence behind the factors: 3–12 month momentum (Jegadeesh & Titman, 1993, replicated across markets
including India); nearness to the 52-week high (George & Hwang, 2004); the trend template follows Weinstein
and Minervini. **None of this guarantees returns.** These effects are averages over decades, weaken once widely
traded, and can fail for years. That is what the backtester is for.

### Trade plan

- **Stop** where the setup is proven wrong: back below the breakout level (the old 52-week high or the 20-day
  high, minus 0.5 ATR), or below the last 10 days' low (minus 0.25 ATR) for a pullback. It is then held between 1 and 3 daily ATRs.
- **Targets** at 2R and 3R. T2 is flagged when the 52-week high sits in the way.
- **Time stop:** exit after 10 sessions if neither is reached.
- Levels are fixed at the signal close. During market hours a live price marks a plan **STOPPED** or
  **MISSED** (past T1) and removes it from the board; otherwise sizing uses the live distance to the stop.
- **Sizing:** delivery at 1×, since intraday MIS leverage does not apply overnight.

### Backtester

`server/services/swingBacktest.js` replays the shipped formula, calling the same functions, over real Kite daily
history. Execution is deliberately unflattering:

- Entry at the **next day's open**; trades that gap through the stop are skipped.
- When one bar touches both the stop and the target, the **stop is assumed first**.
- A gap through the stop exits at the open. The stop moves to breakeven after T1.
- **0.3% round-trip cost** per trade (STT, charges and slippage on delivery).

It reports win rate, expectancy (avg R), profit factor, total R, equity multiple at 1% risk per trade, max
drawdown and holding time. These are shown for six variants (all setups, 52-week breakouts only,
20-day breakouts only, pullbacks only, score ≥ 70, and **with the market only**: buys only while Nifty is above
its 200-day average) next to equal-weight buy-and-hold, so the best entry style is chosen on
measured results. A variant needs 30+ trades to be called best.

**It is validated in both directions:** on driftless random walks it finds no edge (expectancy ≈ −costs), and
on series with real trends it finds one. A separate test checks that adding future candles never changes a
past signal (no look-ahead).

**It refuses to run without Kite.** Simulated prices are random, so any return measured on them would be
fiction. The universe is today's F&O list, so stocks that dropped out are missing (survivorship bias, which
flatters longs).

## 💾 Keeping data across deploys

Logins, password changes, 2FA and saved Kite keys are kept by `server/services/store.js`. Where they live
depends on the host:

- **A host with a persistent disk** (your own machine, a VPS, a paid Render instance with a disk): they're saved
  in `data/*.json` and nothing needs setting up.
- **Render's free plan** has no persistent disk. It **erases the disk on every deploy, every restart, and every
  wake from sleep**, so anything saved there is lost. The app warns about this at startup and in the Kite
  Connect form.

**Option 1 — a free database (keeps everything).** [Neon](https://neon.tech) has a free Postgres tier that does
not expire. Render's own free Postgres is deleted after 30 days, so don't use that one.

1. Sign up at neon.tech → create a project → copy the **connection string** (it starts `postgresql://` and ends
   `?sslmode=require`).
2. In Render → your service → **Environment**, add `DATABASE_URL` = that string.
3. Add `DATA_ENCRYPTION_KEY` = any long random string, unless your service was created from `render.yaml`, which
   generates one. **Keep it**: stored data cannot be read without it.
4. Save. Render redeploys. The log shows `💾 Storage: postgres (encrypted)`.

On every boot the app loads the stored data and runs pending migrations **before** it serves requests. The
first time a database is used, it copies in any existing `data/*.json`. If the database can't be reached (it is
retried for a few seconds, since free tiers sleep), or the encryption key is wrong, the boot **fails rather than
starting empty**, because the first save would otherwise overwrite everything stored.

**Option 2 — environment variables (Kite keys only).** Put the key and secret in `KITE_API_KEY` and
`KITE_API_SECRET` in Render → Environment. They survive every deploy, but logins added or changed in the app,
and 2FA, still won't.

The admin scripts (`scripts/create-user.js`, `manage-2fa.js`, `manage-admin.js`) read `.env` and use the same
storage, so with `DATABASE_URL` set they change the database, not a local file.

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
- `GET /api/insights/intraday/backtest?days=60&entryCutoff=10:30&maxTrades=2` - Replay the intraday formula on
  Kite 5-minute history (20–100 days; requires Kite)
- `GET /api/insights?entryCutoff=10:30` - the intraday snapshot carries `entryWindow` (`BEFORE` / `OPEN` /
  `CLOSED` / `MARKET_CLOSED`)
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