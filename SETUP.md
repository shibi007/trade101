# Setup Guide - Trade101 Intraday Trading Application

Complete setup instructions for preparing Trade101 for intraday trading in India.

## 📋 Prerequisites

Before you begin, ensure you have:

- **Node.js** 16.x or higher (Download from [nodejs.org](https://nodejs.org))
- **npm** 8.x or higher (comes with Node.js)
- **Git** (Download from [git-scm.com](https://git-scm.com))
- **Code Editor** (VS Code recommended)
- **Broker Account** (Zerodha, Angel Broking, 5Paisa, etc.)

### System Requirements
- **OS**: Windows 10+, macOS 10.14+, or Linux
- **RAM**: Minimum 4GB (8GB recommended)
- **Disk Space**: 500MB for application

## 🚀 Installation Steps

### Step 1: Clone the Repository

```bash
git clone https://github.com/shibi007/trade101.git
cd trade101
```

### Step 2: Install Backend Dependencies

```bash
npm install
```

This installs the following packages:
- `express` - Web server framework
- `axios` - HTTP client for API calls
- `dotenv` - Environment variable management
- `node-schedule` - Job scheduling
- `ws` - WebSocket for real-time data

### Step 3: Install Frontend Dependencies

```bash
cd client
npm install
cd ..
```

### Step 4: Create Environment File

Copy the example environment file and configure it:

```bash
cp .env.example .env
```

Edit `.env` with your broker credentials:

```env
# Server Configuration
PORT=5000
NODE_ENV=development

# Market Configuration
MARKET_TYPE=NSE
TIMEZONE=Asia/Kolkata

# Broker Integration (Get from your broker)
BROKER_API_KEY=your_broker_api_key
BROKER_API_SECRET=your_broker_api_secret
BROKER_REDIRECT_URI=http://localhost:5000/auth/callback
```

### Step 5: Verify Installation

Test if everything is set up correctly:

```bash
npm run dev
```

You should see:
```
🚀 Trade101 Server running on http://localhost:5000
📊 Market Configuration: India NSE/BSE Intraday Trading
⏰ Market Hours: 9:15 AM - 3:30 PM IST
```

## ⚙️ Configuration

### Market Configuration

Edit `config/marketConfig.js` to customize:

**Market Hours**
```javascript
MARKET_HOURS: {
  OPEN_TIME: '09:15',      // Trading starts
  CLOSE_TIME: '15:30',     // Trading ends
  PRE_OPEN: '09:00',       // Pre-open session
}
```

**Trading Days**
```javascript
TRADING_DAYS: [1, 2, 3, 4, 5]  // Monday to Friday
```

**Market Holidays**
```javascript
MARKET_HOLIDAYS: [
  '2024-01-26', // Republic Day
  '2024-08-15', // Independence Day
  // Add more holidays as needed
]
```

**Intraday Rules**
```javascript
INTRADAY_RULES: {
  MIN_LOT_SIZE: 1,
  INTRADAY_MARGIN_PERCENT: 20,
  MAX_POSITION_SIZE_PERCENT: 5,
  MAX_LOSS_PER_TRADE_PERCENT: 2,
  MAX_DAILY_LOSS_PERCENT: 5,
  AUTO_SQUARE_OFF_TIME: '15:25',
}
```

### Broker Integration

#### Option 1: Zerodha (Kite Connect)

1. Sign up at [Zerodha](https://zerodha.com)
2. Get API credentials from [Kite Connect](https://kite.trade)
3. Add to `.env`:

```env
BROKER_API_KEY=your_zerodha_api_key
BROKER_API_SECRET=your_zerodha_api_secret
BROKER_TYPE=zerodha
```

#### Option 2: Angel Broking

1. Sign up at [Angel Broking](https://www.angelbroking.com)
2. Get SmartAPI credentials
3. Add to `.env`:

```env
BROKER_API_KEY=your_angel_api_key
BROKER_API_SECRET=your_angel_api_secret
BROKER_TYPE=angel
```

#### Option 3: 5Paisa

1. Sign up at [5Paisa](https://www.5paisa.com)
2. Get API credentials
3. Add to `.env`:

```env
BROKER_API_KEY=your_5paisa_api_key
BROKER_API_SECRET=your_5paisa_api_secret
BROKER_TYPE=fivepaisa
```

### Database Setup (Optional)

For production, set up MongoDB:

```bash
# Using Docker
docker run -d -p 27017:27017 --name mongodb mongo:latest

# Or install MongoDB locally from mongodb.com
```

Update `.env`:
```env
DB_URL=mongodb://localhost:27017/trade101
NODE_ENV=production
```

## 🏃 Running the Application

### Development Mode

**Terminal 1 - Start Backend Server:**
```bash
npm run dev
```

**Terminal 2 - Start Frontend (in another terminal):**
```bash
npm run client
```

Access at:
- Frontend: `http://localhost:3000`
- API Server: `http://localhost:5000`

### Production Mode

```bash
# Install all dependencies
npm run install-all

# Start the application
npm start
```

## ✅ Verify Setup

### Check API Health

```bash
curl http://localhost:5000/api/health
```

Expected response:
```json
{
  "status": "ok",
  "service": "Trade101 API",
  "market": {
    "open": true,
    "hours": {
      "OPEN_TIME": "09:15",
      "CLOSE_TIME": "15:30"
    }
  }
}
```

### Check Market Status

```bash
curl http://localhost:5000/api/health/market-status
```

### Get Market Configuration

```bash
curl http://localhost:5000/api/market/config
```

## 📊 Connect Your Broker

### Step 1: Authentication

Connect your broker account through OAuth:

```bash
curl -X POST http://localhost:5000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "brokerType": "zerodha",
    "redirectUri": "http://localhost:5000/auth/callback"
  }'
```

### Step 2: Place Test Order

```bash
curl -X POST http://localhost:5000/api/trade/place-order \
  -H "Content-Type: application/json" \
  -d '{
    "symbol": "INFY",
    "quantity": 1,
    "orderType": "MARKET",
    "tradeType": "BUY"
  }'
```

## 🔍 Troubleshooting

### Issue: Port Already in Use

**Error**: `listen EADDRINUSE :::5000`

**Solution**:
```bash
# Find process using port 5000
lsof -i :5000  # macOS/Linux
netstat -ano | findstr :5000  # Windows

# Kill the process
kill -9 <PID>  # macOS/Linux
taskkill /PID <PID> /F  # Windows

# Or use different port
PORT=5001 npm run dev
```

### Issue: npm Install Fails

**Error**: `npm ERR! code ERESOLVE`

**Solution**:
```bash
# Use legacy dependency resolution
npm install --legacy-peer-deps

# Or update npm
npm install -g npm@latest
```

### Issue: Market Time Mismatch

**Problem**: Market status shows wrong time

**Solution**:
1. Check system timezone is set to IST
2. Verify in `config/marketConfig.js` TIMEZONE is 'Asia/Kolkata'
3. Test with:
```bash
node -e "console.log(new Date().toLocaleString('en-US', {timeZone: 'Asia/Kolkata'}))"
```

### Issue: WebSocket Connection Failed

**Error**: `WebSocket connection failed`

**Solution**:
1. Ensure server is running on port 5000
2. Check firewall allows WebSocket connections
3. Test connectivity:
```bash
wscat -c ws://localhost:5000
```

## 📱 Mobile Setup (Optional)

For React Native mobile app:

```bash
# Install React Native CLI
npm install -g react-native-cli

# Create mobile app
react-native init Trade101Mobile

# Install dependencies
cd Trade101Mobile
npm install axios react-native-websocket

# Start on Android
react-native run-android

# Start on iOS
react-native run-ios
```

## 🔐 Security Setup

### Enable HTTPS for Production

1. Generate SSL certificate:
```bash
# Using Let's Encrypt (recommended)
certbot certonly --standalone -d yourdomain.com

# Or self-signed (development only)
openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 365
```

2. Update server to use HTTPS:
```javascript
import https from 'https';
import fs from 'fs';

const options = {
  key: fs.readFileSync('key.pem'),
  cert: fs.readFileSync('cert.pem')
};

https.createServer(options, app).listen(5000);
```

### Environment Variable Security

Never commit `.env` file! It's in `.gitignore`

For production deployment:
1. Set environment variables in deployment platform
2. Use secret management services (AWS Secrets Manager, GitHub Secrets)
3. Rotate API keys regularly

## 📈 Performance Optimization

### Enable Caching

```javascript
// Cache market data for 1 minute
const CACHE_TTL = 60000;
const cache = new Map();

function getCachedData(key) {
  const cached = cache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }
  return null;
}
```

### Connection Pooling

```javascript
// Reuse database connections
const pool = mongoose.createConnection(DB_URL, {
  maxPoolSize: 10,
  minPoolSize: 5,
});
```

### Load Balancing

For high traffic, use:
- **Nginx** for reverse proxy
- **PM2** for process management
- **Redis** for caching

```bash
# Install PM2
npm install -g pm2

# Start with PM2
pm2 start server/index.js -i max
```

## 📚 Next Steps

1. ✅ Complete setup using this guide
2. 📖 Read [INTRADAY_GUIDE.md](INTRADAY_GUIDE.md) for trading guidelines
3. 🧪 Test with paper trading first
4. 💰 Start with small real trades
5. 📊 Monitor and optimize your strategy

## 🆘 Support

If you encounter issues:

1. Check [Troubleshooting](#-troubleshooting) section
2. Review [Issues](https://github.com/shibi007/trade101/issues)
3. Check documentation in `INTRADAY_GUIDE.md`
4. Create a new [Issue](https://github.com/shibi007/trade101/issues/new)

## 📝 Useful Commands

```bash
# Start development server
npm run dev

# Start frontend
npm run client

# Run both simultaneously (requires npm-run-all)
npm install -D npm-run-all
npm run dev:all

# Test API endpoints
npm test

# Build for production
npm run build

# Check for security vulnerabilities
npm audit

# Fix vulnerabilities
npm audit fix
```

## 🎓 Learning Resources

- [NSE India Market Data](https://www.nseindia.com/)
- [Broker API Docs](https://kite.trade) (Zerodha example)
- [SEBI Trading Rules](https://www.sebi.gov.in/)
- [Stock Market Basics](https://www.investopedia.com/)

---

**Version**: 1.0.0  
**Last Updated**: July 2024  
**Status**: Ready for Development

**Good luck with your intraday trading! Remember: consistent discipline beats occasional big wins.** 📈
