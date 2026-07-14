# Getting Started with Trade101

Welcome to **Trade101** - Your intraday trading application for Indian stock markets!

## ✅ What's Been Set Up

The Trade101 repository has been fully initialized and prepared for **intraday trading in India** with:

### ✨ Core Features
- ✅ Node.js/Express backend server
- ✅ React frontend structure  
- ✅ Indian market configuration (NSE/BSE)
- ✅ Trading hours: 9:15 AM - 3:30 PM IST
- ✅ Order management (place, modify, close)
- ✅ Risk management rules built-in
- ✅ WebSocket support for real-time data
- ✅ Market data APIs
- ✅ Comprehensive documentation

### 📁 Project Structure
```
trade101/
├── config/                      # Market configuration
│   └── marketConfig.js          # Indian market rules & hours
├── server/                      # Backend server
│   ├── index.js                 # Express server
│   ├── routes/                  # API endpoints
│   │   ├── health.js            # Health & market status
│   │   ├── market.js            # Market data
│   │   └── trade.js             # Trading orders
│   └── utils/                   # Market utilities
│       └── marketUtils.js       # Helper functions
├── client/                      # React frontend
│   └── package.json             # Frontend dependencies
├── Documentation files:
│   ├── README.md                # Project overview
│   ├── SETUP.md                 # Installation & setup guide
│   ├── INTRADAY_GUIDE.md        # Intraday trading guide
│   ├── QUICK_REFERENCE.md       # Quick lookup reference
│   └── GETTING_STARTED.md       # This file
├── .env.example                 # Environment template
└── package.json                 # Backend dependencies
```

## 🚀 Next Steps (5 Minutes)

### 1. **Install Dependencies**
```bash
cd C:\Users\schakrav\Documents\Personal\trade101
npm install
cd client && npm install && cd ..
```

### 2. **Create Configuration File**
```bash
cp .env.example .env
```

### 3. **Start the Server**
```bash
npm run dev
```

You should see:
```
🚀 Trade101 Server running on http://localhost:5000
📊 Market Configuration: India NSE/BSE Intraday Trading
⏰ Market Hours: 9:15 AM - 3:30 PM IST
```

### 4. **Test the API**
```bash
# In another terminal
curl http://localhost:5000/api/health
```

## 📚 Understanding the App

### For Quick Reference
👉 Open **[QUICK_REFERENCE.md](QUICK_REFERENCE.md)** for:
- Market hours and key rules
- Common strategies
- API quick reference
- Popular stocks
- Best trading times

### For Complete Setup
👉 Open **[SETUP.md](SETUP.md)** for:
- Detailed installation steps
- Broker integration setup
- Configuration options
- Troubleshooting guide
- Performance optimization

### For Learning Intraday Trading
👉 Open **[INTRADAY_GUIDE.md](INTRADAY_GUIDE.md)** for:
- What is intraday trading
- Indian market rules
- Position sizing
- Risk management
- Best practices
- FAQ

### For API Documentation
👉 Open **[README.md](README.md)** for:
- Feature overview
- API endpoints
- Example requests
- Roadmap

## 🎯 Key Points to Remember

### Market Hours
- **Trading**: 9:15 AM - 3:30 PM IST (Mon-Fri)
- **Auto Square-off**: 3:25 PM (must close by then)
- **Timezone**: IST (UTC+5:30)

### Intraday Rules
- **Margin**: 20% (5x leverage)
- **Must close**: Same day
- **Position limit**: 5% per stock
- **Max loss/trade**: 2%
- **Max loss/day**: 5%

### Stock Examples
- RELIANCE, TCS, INFY, HDFC, ICICIBANK
- NIFTY 50 components recommended
- High liquidity = better execution

## 🔧 Common Commands

```bash
# Start backend server
npm run dev

# Start frontend (in separate terminal)
npm run client

# Install everything
npm run install-all

# Check market status
curl http://localhost:5000/api/health/market-status

# Get available stocks
curl http://localhost:5000/api/market/stocks

# Place a test order
curl -X POST http://localhost:5000/api/trade/place-order \
  -H "Content-Type: application/json" \
  -d '{
    "symbol": "INFY",
    "quantity": 1,
    "orderType": "MARKET",
    "tradeType": "BUY"
  }'
```

## 🌟 What Makes This Special for India

✅ **Market Hours**: Configured for NSE (9:15 AM - 3:30 PM IST)  
✅ **Holidays**: Pre-loaded with all Indian stock market holidays  
✅ **Rules**: Automatic position sizing and loss limits  
✅ **Exchanges**: NSE and BSE support  
✅ **Margin**: 20% intraday margin as per Indian regulations  
✅ **Tax**: Structure ready for tracking short-term gains  
✅ **Brokers**: Ready to integrate with Indian brokers  

## 📊 Architecture Overview

```
User Interface (React)
        ↓
REST API + WebSocket (Express)
        ↓
Market Config & Rules
        ↓
Broker APIs (Zerodha, Angel, etc.)
        ↓
NSE/BSE Exchanges
```

## 🔐 Security Notes

- ✅ `.env` file is in `.gitignore` (never commit secrets)
- ✅ Store broker API keys in `.env` only
- ✅ Use HTTPS in production
- ✅ Validate all inputs on backend
- ✅ Use environment-based configuration

## 🎓 Learning Path

### Beginner (Week 1-2)
1. Read INTRADAY_GUIDE.md
2. Understand market hours and rules
3. Learn position sizing formula
4. Practice with paper trading

### Intermediate (Week 3-4)
1. Set up broker integration
2. Place simulated orders
3. Monitor your trades
4. Review daily performance

### Advanced (Week 5+)
1. Implement trading strategies
2. Add technical indicators
3. Automate order execution
4. Backtest your strategies

## 🚀 Quick Start Comparison

| Task | Command | Time |
|------|---------|------|
| Install | `npm install` | 2 min |
| Configure | Create `.env` | 1 min |
| Start Server | `npm run dev` | 1 min |
| Test API | `curl http://...` | 1 min |
| **Total** | | **5 min** |

## ❓ Common Questions

**Q: Do I need a broker account to start?**  
A: Not immediately. You can paper trade first. Eventually you'll need one.

**Q: Which broker should I use?**  
A: Popular in India: Zerodha, Angel Broking, 5Paisa. Check SETUP.md for integration.

**Q: What's the minimum capital?**  
A: Varies by broker. Typically ₹10,000-25,000 for intraday trading.

**Q: Can I automate my trades?**  
A: Yes! Backend is designed for it. Add order logic to your strategy.

**Q: Is it risky?**  
A: Yes. Intraday trading is high-risk. Use proper risk management.

## 📞 Getting Help

### Documentation
- 📖 [SETUP.md](SETUP.md) - Setup & troubleshooting
- 📈 [INTRADAY_GUIDE.md](INTRADAY_GUIDE.md) - Trading guide
- ⚡ [QUICK_REFERENCE.md](QUICK_REFERENCE.md) - Quick lookup

### Online Resources
- [NSE Official Site](https://www.nseindia.com/)
- [SEBI Rules](https://www.sebi.gov.in/)
- [Broker Documentation](https://kite.trade)
- [GitHub Issues](https://github.com/shibi007/trade101/issues)

## 📈 Your First Trade

### Step 1: Verify Market Status
```bash
curl http://localhost:5000/api/health/market-status
```

### Step 2: Check Available Stocks
```bash
curl http://localhost:5000/api/market/stocks
```

### Step 3: Place an Order
```bash
curl -X POST http://localhost:5000/api/trade/place-order \
  -H "Content-Type: application/json" \
  -d '{
    "symbol": "INFY",
    "quantity": 1,
    "price": 1680,
    "orderType": "LIMIT",
    "tradeType": "BUY"
  }'
```

### Step 4: Monitor Your Order
```bash
curl http://localhost:5000/api/trade/orders
```

### Step 5: Close Your Position
```bash
curl -X POST http://localhost:5000/api/trade/square-off/1
```

## 💡 Pro Tips

1. **Start small**: Trade 1 share first to understand the flow
2. **Use stop losses**: Always. Non-negotiable.
3. **Trade liquid stocks**: NIFTY 50 components are safest
4. **Log everything**: Review trades daily
5. **Test paper trading**: Before using real money
6. **Follow the rules**: Risk management saves capital
7. **Be patient**: Consistency beats speed

## 🎯 30-Day Plan

| Week | Goal |
|------|------|
| **Week 1** | Setup complete + read all docs |
| **Week 2** | Paper trade, learn platform |
| **Week 3** | Small real trades (1-2 shares) |
| **Week 4** | Evaluate results, refine strategy |

## ⚠️ Important Reminders

🚨 **Trading involves risk** of losing money  
🚨 **Start small** with capital you can afford to lose  
🚨 **Use stop losses** always  
🚨 **Follow the rules** - they exist for your protection  
🚨 **Consult a financial advisor** before trading  

## 🎉 You're Ready!

The application is fully set up and ready to go. You have:

- ✅ Complete project structure
- ✅ Backend server ready
- ✅ Market configuration for India
- ✅ Comprehensive documentation
- ✅ Example code and API templates
- ✅ Risk management built-in

**Next Action**: 
1. Follow the installation steps above
2. Read SETUP.md for detailed configuration
3. Read INTRADAY_GUIDE.md to understand trading
4. Start with paper trading to learn the platform
5. Begin your intraday trading journey!

---

## 📚 Quick Navigation

| Document | Purpose | Time to Read |
|----------|---------|------------|
| **QUICK_REFERENCE.md** | Quick lookup guide | 5 min |
| **INTRADAY_GUIDE.md** | Complete trading guide | 30 min |
| **SETUP.md** | Setup & troubleshooting | 20 min |
| **README.md** | Project features & APIs | 15 min |

---

**Welcome to Trade101!** 🚀

Remember: *"The goal of intraday trading is not to get rich quick, but to build consistent, disciplined trading habits."*

**Happy Trading!** 📈

---

**Version**: 1.0.0  
**Created**: July 2024  
**Status**: Ready for Development
