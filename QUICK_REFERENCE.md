# Trade101 - Quick Reference Guide

Fast reference for key information about intraday trading in India.

## ⏰ Market Hours (IST)

```
Pre-open:      09:00 - 09:15 (No trading, orders only)
Main Trading:  09:15 - 15:30 (Active trading)
Closing Auction: 15:30 - 15:40 (Close orders)
```

**Important**: IST is UTC+5:30

## 🛑 Key Rules

| Rule | Details |
|------|---------|
| **Holding Period** | Same day only - must square off by 3:30 PM |
| **Minimum Lot** | 1 share |
| **Margin** | 20% (5x leverage) |
| **Tick Size** | ₹0.05 (5 paise) |
| **Position Limit** | 5% of portfolio per stock |
| **Max Daily Loss** | 5% of portfolio |
| **Max Trade Loss** | 2% per trade |

## 📊 Supported Instruments

| Exchange | Segment | Stocks | Hours |
|----------|---------|--------|-------|
| NSE | Equity | 2000+ | 9:15 - 3:30 PM |
| BSE | Equity | 5000+ | 9:15 - 3:30 PM |
| Both | Indices | NIFTY, SENSEX | 9:15 - 3:30 PM |

## 💰 Risk Management Formula

```
Position Size = (Account Size × Risk %) / (Stop Loss Points)

Example:
Account: ₹100,000
Risk per trade: 2%
Stop Loss: ₹50 below entry
Max Qty = (100,000 × 0.02) / 50 = 40 shares
```

## 🎯 Order Types

### Market Order
- Immediate execution
- Price: Best available in market
- Cost: May slippage of ₹1-5 per share
- Use when: Speed matters more than price

### Limit Order
- Execution at specified price
- Price: Exact or better
- Cost: No slippage
- Use when: Price control matters

## 📈 Common Strategies

### Scalping
- Multiple trades per hour
- Profit: ₹5-50 per share
- Risk: High frequency = more mistakes

### Swing Trading
- Hold 1-4 hours
- Profit: ₹50-200 per share
- Risk: Overnight gap risk (but not for intraday)

### Breakout Trading
- Trade after price breaks key levels
- Profit: ₹100-500 per share
- Risk: False breakouts

## 🚨 Circuit Breaker Limits

| Level | Trigger | Halt Duration |
|-------|---------|---------------|
| 1 | ±10% | 45 minutes |
| 2 | ±15% | 2 hours |
| 3 | ±20% | Till end of day |

## 💵 Brokerage Charges (Typical)

| Service | Charge |
|---------|--------|
| Equity Intraday | ₹20-200 per order |
| Brokerage % | 0.01-0.05% |
| Exchange fees | ₹5-10 per order |
| Clearing | ₹5-10 per order |
| STT (tax) | 0.025% |
| Profit Tax | 15-45% (per slab) |

**Example Trade**:
```
Buy:  100 shares @ ₹500 = ₹50,000
Sell: 100 shares @ ₹505 = ₹50,500
Profit: ₹500
- Brokerage (₹100): ₹400
- STT (₹12.50): ₹387.50
- Exchange/Clearing (₹40): ₹347.50
- Tax (30% slab, ₹104): ₹243.50 net
```

## 📊 Popular Intraday Stocks

### High Liquidity (Recommended)
- RELIANCE (Nifty 50)
- TCS (Nifty 50)
- INFY (Nifty 50)
- HDFC (Nifty 50)
- ICICIBANK (Nifty 50)
- BAJAJ-AUTO (Nifty 50)

### High Volatility
- ADANIPOWER
- HINDALCO
- TATASTEEL
- SAILINDUST
- GAIL

## 🔧 API Quick Reference

### Health Check
```bash
curl http://localhost:5000/api/health
```

### Market Status
```bash
curl http://localhost:5000/api/health/market-status
```

### Get Stocks
```bash
curl http://localhost:5000/api/market/stocks
```

### Place Order
```bash
curl -X POST http://localhost:5000/api/trade/place-order \
  -H "Content-Type: application/json" \
  -d '{
    "symbol": "INFY",
    "quantity": 10,
    "price": 1680,
    "orderType": "LIMIT",
    "tradeType": "BUY"
  }'
```

### Get Orders
```bash
curl http://localhost:5000/api/trade/orders
```

### Square Off Position
```bash
curl -X POST http://localhost:5000/api/trade/square-off/1
```

## 📱 Best Times to Trade

| Time | Volatility | Liquidity | Note |
|------|-----------|-----------|------|
| 9:15-9:45 | High | High | Opening chaos, trending starts |
| 10:00-11:30 | Medium | High | Stable trends forming |
| 11:30-1:00 | Medium | Medium | Post-lunch consolidation |
| 1:00-2:30 | Medium | Medium | Afternoon session |
| 2:30-3:30 | High | High | Closing rush, volatile |

**Pro Tip**: Avoid 11:40 AM - 12:05 PM (lunch break)

## ✅ Pre-Trade Checklist

- [ ] Market is open (9:15-3:30 PM IST)
- [ ] Have stop loss planned
- [ ] Position size calculated
- [ ] Have profit target
- [ ] Sufficient margin available
- [ ] Risk ≤ 2% per trade
- [ ] Total daily risk ≤ 5%
- [ ] Not holding past 3:25 PM

## ❌ Red Flags - Don't Trade If:

- [ ] Market holiday or closed
- [ ] Less than 30 minutes to close
- [ ] No liquidity in stock
- [ ] Stock is circuit breaker halted
- [ ] You're revenge trading
- [ ] You've hit daily loss limit
- [ ] You don't have a plan
- [ ] Brokerage fees > potential profit

## 📚 National Holidays 2024-25

| Date | Holiday |
|------|---------|
| Jan 26 | Republic Day |
| Mar 8 | Maha Shivaratri |
| Mar 29 | Good Friday |
| Apr 11 | Eid ul-Fitr |
| Apr 21 | Mahavir Jayanti |
| May 23 | Buddha Purnima |
| Jul 17 | Eid ul-Adha |
| Aug 15 | Independence Day |
| Aug 26 | Janmashtami |
| Sep 16 | Milad-un-Nabi |
| Oct 2 | Gandhi Jayanti |
| Oct 12 | Dussehra |
| Oct 31 | Diwali |
| Nov 15 | Guru Nanak Jayanti |
| Dec 25 | Christmas |

## 💡 Success Tips

1. **Plan first**: Plan entry, exit, stop loss BEFORE trading
2. **Size correctly**: Risk only 1-2% per trade
3. **Trade liquid stocks**: Nifty 50 components are best
4. **Close early**: Don't hold till last minute
5. **Keep log**: Record every trade for analysis
6. **Follow rules**: Stick to your strategy
7. **Manage emotions**: Don't revenge trade
8. **Consistent profits**: Small daily gains beat occasional big wins

## ⚠️ Common Mistakes

| Mistake | Impact | Solution |
|---------|--------|----------|
| No stop loss | Unlimited loss | Always set stop loss |
| Overleveraging | 100% loss | Risk only 2% max |
| Holding till close | Bad exit price | Close by 3:25 PM |
| No plan | Random trading | Plan before executing |
| Emotional trading | Bigger losses | Follow system |
| Ignoring costs | Profit eaten by fees | Track all costs |

## 🎓 Key Metrics

### Success Rate
- **Target**: 55-60% winning trades
- **Breakeven**: 50% (if profit > loss per trade)
- **Sustainable**: 60%+ with proper risk management

### Profit Factor
- **Formula**: Gross Profit / Gross Loss
- **Target**: > 1.5 (Win big, lose small)
- **Excellent**: > 2.0

### Sharpe Ratio
- **Measures**: Risk-adjusted returns
- **Target**: > 1.0
- **Excellent**: > 2.0

## 🌐 Useful Links

- **NSE**: https://www.nseindia.com/
- **BSE**: https://www.bseindia.com/
- **SEBI**: https://www.sebi.gov.in/
- **Zerodha**: https://zerodha.com
- **Angel Broking**: https://www.angelbroking.com
- **5Paisa**: https://www.5paisa.com

---

**Remember**: *"The best trade is no trade. Wait for the perfect setup."*

**Disclaimer**: For educational purposes only. Trading carries risk. Consult a financial advisor.

**Last Updated**: July 2024
