# Intraday Trading Guide for Indian Markets

A comprehensive guide for understanding and using the Trade101 application for intraday trading in India.

## 📚 Table of Contents

1. [What is Intraday Trading?](#what-is-intraday-trading)
2. [Indian Market Basics](#indian-market-basics)
3. [Intraday Trading Rules in India](#intraday-trading-rules)
4. [Platform Features](#platform-features)
5. [Getting Started](#getting-started)
6. [Risk Management](#risk-management)
7. [Best Practices](#best-practices)
8. [FAQ](#faq)

## What is Intraday Trading?

**Intraday trading** (also called day trading) means buying and selling securities on the same day. The key characteristic is that all positions must be closed before the market closes.

### Key Characteristics
- **Same-day settlement**: Buy and sell on the same day
- **Lower margin requirements**: Uses leverage (20% margin vs 50% for delivery)
- **No overnight risk**: Positions cannot be carried forward
- **Higher volatility trading**: Exploits short-term price movements
- **Automatic square-off**: Positions are closed at market close

## Indian Market Basics

### Market Hours (IST - Indian Standard Time)

```
Pre-open Session:  09:00 - 09:15 AM  (Order placement only)
Main Trading:      09:15 - 03:30 PM  (Active trading)
Closing auction:   03:30 - 03:40 PM  (Order for closing)
```

**Important**: 
- Markets are closed on weekends (Saturday, Sunday)
- Markets are closed on national holidays
- IST is UTC+5:30

### Trading Days

Monday to Friday (excluding national holidays)

### Exchanges

| Exchange | Name | Segment | Tier |
|----------|------|---------|------|
| NSE | National Stock Exchange | Equity | Primary |
| BSE | Bombay Stock Exchange | Equity | Secondary |

## Intraday Trading Rules in India

### SEBI & Stock Exchange Rules

**Mandatory Square-off by 3:30 PM**
- All intraday positions must be closed by market close
- The exchange automatically squares off remaining positions at market close
- Failing to square off may result in penalties and blocking of trades

**Minimum Lot Size**
- For most stocks: 1 share minimum
- Some stocks may have specific lot sizes (check NSE website)

**Tick Size** (Minimum price movement)
- For most stocks: 5 paise (₹0.05)
- Ensures fair pricing

**Circuit Breaker Rules**

When a stock moves by certain percentages, trading is halted:

| Level | Trigger | Duration | Purpose |
|-------|---------|----------|---------|
| Level 1 | 10% movement | 45 minutes | Cool-down period |
| Level 2 | 15% movement | 2 hours | Extended halt |
| Level 3 | 20% movement | Till end of day | Prevents panic trading |

### Margin Requirements

**Intraday Margin**: 20% (Lower leverage)
- Smaller capital requirement
- Higher risk due to leverage
- Must close position by day end

**Delivery Margin**: ~50% (Conservative)
- Higher capital required
- Can hold positions overnight
- More stable for long-term investing

### Tax Implications

**Short-term Capital Gains** (for intraday)
- Holding period: Less than 1 day
- Tax rate: As per individual tax slab (15-45%)
- Included in income for tax purposes
- Need to pay TDS if applicable

**Example**:
- Buy ₹10,000 worth of stock
- Sell for ₹11,000
- Profit: ₹1,000 (Short-term capital gain)
- Tax: Based on your income tax slab

## Platform Features

### 1. Order Placement

**Order Types**:

**Market Order**
- Executed immediately at current market price
- Guaranteed execution
- Price may vary from quoted price
- Best for quick entries/exits

```json
{
  "symbol": "RELIANCE",
  "quantity": 10,
  "orderType": "MARKET",
  "tradeType": "BUY"
}
```

**Limit Order**
- Executed at specified price or better
- Execution not guaranteed
- Can set buy price lower or sell price higher
- Good for control over entry/exit price

```json
{
  "symbol": "TCS",
  "quantity": 5,
  "price": 3500,
  "orderType": "LIMIT",
  "tradeType": "SELL"
}
```

### 2. Position Management

**Open Positions**
- View all active trades
- Real-time P&L (Profit/Loss)
- Current price and unrealized gains/losses

**Closing Positions**
- Manual square-off anytime before 3:25 PM
- Automatic square-off at 3:25 PM if not closed
- Realize gains or losses immediately

### 3. Risk Management

**Built-in Safeguards**:
- Per-trade loss limit: 2% of portfolio
- Daily loss limit: 5% of portfolio
- Position size limit: 5% per stock
- Prevents over-leveraging

### 4. Market Monitoring

**Real-time Updates**:
- Live stock prices via WebSocket
- Market indices (NIFTY 50, SENSEX, etc.)
- Market open/close status
- Holiday calendar

## Getting Started

### Step 1: Setup

1. Install Trade101 application
2. Configure your broker credentials
3. Set your portfolio size and risk limits

### Step 2: Learn the Platform

```
1. Check market status (GET /api/health/market-status)
2. Browse available stocks (GET /api/market/stocks)
3. Review market configuration (GET /api/market/config)
```

### Step 3: Paper Trading (Recommended)

Start with paper trading (simulated trades) before using real money:

```bash
# This creates simulated orders without real capital
curl -X POST http://localhost:5000/api/trade/place-order \
  -H "Content-Type: application/json" \
  -d '{
    "symbol": "RELIANCE",
    "quantity": 10,
    "orderType": "MARKET",
    "tradeType": "BUY"
  }'
```

### Step 4: Place Your First Trade

Once comfortable, place a real intraday order:

```bash
curl -X POST http://localhost:5000/api/trade/place-order \
  -H "Content-Type: application/json" \
  -d '{
    "symbol": "INFY",
    "quantity": 2,
    "price": 1680,
    "orderType": "LIMIT",
    "tradeType": "BUY"
  }'
```

### Step 5: Monitor & Close

- Monitor your position throughout the day
- Close before 3:25 PM
- Review your P&L

## Risk Management

### Position Sizing Formula

```
Position Size = (Account Size × Risk Percentage) / Loss per Share

Example:
Account Size: ₹100,000
Risk % per trade: 2%
Stop Loss: ₹50 per share
Max Quantity: (100,000 × 0.02) / 50 = 40 shares
```

### Stop Loss Strategy

**Always use stop losses**:

```
Entry Price: ₹100
Stop Loss: ₹95 (5% below entry)
Risk per share: ₹5
Position Size: ₹5,000 / ₹5 = 1,000 shares
```

### Profit Targets

**Set profit targets**:
- Small gains consistently > occasional large wins
- Aim for 1-2% daily return (reasonable target)
- Avoid greed-driven trades

### Daily Loss Limit

**Stop trading after 5% daily loss**:
- Prevents emotional decisions
- Protects capital
- Allows recovery next day

### Position Limits

**Trade101 enforces**:
- Max 5% of portfolio per stock
- Max 2% loss per trade
- Max 5% loss per day

## Best Practices

### ✅ Do's

1. **Plan before trading**
   - Identify entry, exit, and stop loss before placing order
   - Have a daily profit target and loss limit

2. **Use limit orders**
   - Gives you control over entry/exit price
   - Reduces slippage risk

3. **Trade liquid stocks**
   - Nifty 50 components
   - High volume stocks
   - Easy entry/exit

4. **Close before 3:25 PM**
   - Avoid automatic square-off at 3:30 PM
   - Prevents forced exit at bad prices

5. **Keep emotions in check**
   - Follow your trading plan
   - Don't revenge trade after losses
   - Stick to position sizing

6. **Review daily**
   - Analyze trades at end of day
   - Keep trading journal
   - Learn from mistakes

### ❌ Don'ts

1. **Don't trade all your capital**
   - Risk only 1-2% per trade
   - Keep reserves for opportunities

2. **Don't ignore stop losses**
   - Always set stop losses
   - Execute them without hesitation

3. **Don't trade illiquid stocks**
   - Hard to exit quickly
   - High bid-ask spread
   - Poor execution prices

4. **Don't hold beyond 3:25 PM**
   - Automatic square-off may give bad prices
   - Violates intraday trading rules

5. **Don't average down**
   - Increases loss potential
   - Violates position sizing rules

6. **Don't use margin recklessly**
   - 20x leverage is powerful but risky
   - Can wipe out capital quickly
   - One mistake = 100% loss

## FAQ

**Q: Can I hold intraday positions overnight?**
A: No. All intraday positions must be closed by market close (3:30 PM). Unclosed positions are automatically squared off.

**Q: What's the margin requirement for intraday trading?**
A: Typically 20%, which is 5x leverage. This means with ₹1,000, you can trade ₹5,000 worth of stock.

**Q: What happens if I don't close my position?**
A: The exchange automatically squares off at market close, potentially at unfavorable prices. This may also result in penalties.

**Q: What are market holidays?**
A: National holidays when exchanges are closed. These include Republic Day, Independence Day, Diwali, and other national festivals. Check NSE/BSE website for complete calendar.

**Q: How are intraday profits taxed?**
A: As short-term capital gains, taxed at your individual income tax slab rate (typically 15-45%).

**Q: What's the difference between NSE and BSE?**
A: NSE is primary exchange (more liquid), BSE is secondary. Most traders prefer NSE for better liquidity and tighter spreads.

**Q: Can I short sell in intraday trading?**
A: Yes, through short selling (MIS order type). You sell first, then buy to close. Profits from price drops.

**Q: What's the best time to trade?**
A: First 30 minutes (9:15-9:45 AM) and last hour (2:30-3:30 PM) are most volatile and liquid.

**Q: How much capital do I need to start?**
A: Minimum depends on your broker. Typically ₹10,000-25,000 for intraday trading.

**Q: Is intraday trading risky?**
A: Yes. High leverage, time pressure, and volatility make it risky. Requires discipline, strategy, and risk management.

---

**Remember**: *"The goal of intraday trading is not to make quick riches, but to build consistent, disciplined trading habits."*

**Disclaimer**: This guide is for educational purposes only. Trading carries substantial risk. Consult a financial advisor before trading with real money.
