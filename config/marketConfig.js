// Market Configuration for Indian Intraday Trading

export const MARKET_CONFIG = {
  // Market Hours (IST - Indian Standard Time)
  MARKET_HOURS: {
    OPEN_TIME: '09:15', // Market opens at 9:15 AM IST
    CLOSE_TIME: '15:30', // Market closes at 3:30 PM IST
    PRE_OPEN: '09:00',   // Pre-open session
    LUNCH_START: '11:40', // Optional lunch break
    LUNCH_END: '12:05',
  },

  // Trading Days
  TRADING_DAYS: [1, 2, 3, 4, 5], // Monday to Friday (0 = Sunday, 6 = Saturday)

  // Market Holidays in 2024 (IST)
  MARKET_HOLIDAYS: [
    '2024-01-26', // Republic Day
    '2024-03-08', // Maha Shivaratri
    '2024-03-25', // Holi
    '2024-03-29', // Good Friday
    '2024-04-11', // Eid ul-Fitr
    '2024-04-17', // Ram Navami
    '2024-04-21', // Mahavir Jayanti
    '2024-05-23', // Buddha Purnima
    '2024-07-17', // Eid ul-Adha
    '2024-08-15', // Independence Day
    '2024-08-26', // Janmashtami
    '2024-09-16', // Milad-un-Nabi
    '2024-10-02', // Gandhi Jayanti
    '2024-10-12', // Dussehra
    '2024-10-31', // Diwali
    '2024-11-01', // Diwali (continued)
    '2024-11-15', // Guru Nanak Jayanti
    '2024-12-25', // Christmas
  ],

  // Intraday Trading Rules for India
  INTRADAY_RULES: {
    // Minimum lot size for intraday trading
    MIN_LOT_SIZE: 1,

    // Position holding period for intraday trades
    HOLDING_PERIOD: 'DAY', // Same day execution

    // Margin requirement for intraday trading (typically lower than delivery)
    INTRADAY_MARGIN_PERCENT: 20, // 20% margin for intraday vs ~50% for delivery

    // Maximum position size per stock
    MAX_POSITION_SIZE_PERCENT: 5, // 5% of total portfolio value

    // Risk management
    MAX_LOSS_PER_TRADE_PERCENT: 2, // 2% max loss per trade
    MAX_DAILY_LOSS_PERCENT: 5,     // 5% max daily loss

    // Position squaring off rules
    // In India, intraday positions must be squared off by market close
    AUTO_SQUARE_OFF_TIME: '15:25', // Auto square off 5 minutes before market close
  },

  // Supported Markets/Exchanges
  EXCHANGES: {
    NSE: {
      name: 'National Stock Exchange',
      segment: 'EQ', // Equity
      currency: 'INR',
    },
    BSE: {
      name: 'Bombay Stock Exchange',
      segment: 'EQ',
      currency: 'INR',
    },
    NIFTY: {
      name: 'NIFTY Indices',
      segment: 'INDEX',
      currency: 'INR',
    },
  },

  // Tick Size (Minimum price movement)
  TICK_SIZES: {
    default: 0.05, // 5 paise for stocks
    index: 0.05,
  },

  // Circuit breaker limits
  CIRCUIT_BREAKER: {
    LEVEL_1: 10, // 10% - trading halted for 45 minutes
    LEVEL_2: 15, // 15% - trading halted for 2 hours
    LEVEL_3: 20, // 20% - trading halted till end of day
  },

  // Timezone
  TIMEZONE: 'Asia/Kolkata',
};

// Utility function to check if market is open
export function isMarketOpen(date = new Date()) {
  const istDate = new Date(date.toLocaleString('en-US', { timeZone: MARKET_CONFIG.TIMEZONE }));
  const dayOfWeek = istDate.getDay();
  const timeStr = istDate.toTimeString().slice(0, 5);

  // Check if it's a trading day
  if (!MARKET_CONFIG.TRADING_DAYS.includes(dayOfWeek)) {
    return false;
  }

  // Check if it's a market holiday
  const dateStr = istDate.toISOString().slice(0, 10);
  if (MARKET_CONFIG.MARKET_HOLIDAYS.includes(dateStr)) {
    return false;
  }

  // Check market hours
  const openTime = MARKET_CONFIG.MARKET_HOURS.OPEN_TIME;
  const closeTime = MARKET_CONFIG.MARKET_HOURS.CLOSE_TIME;

  return timeStr >= openTime && timeStr < closeTime;
}

// Get next market open time
export function getNextMarketOpenTime(date = new Date()) {
  let nextDate = new Date(date);
  nextDate.setDate(nextDate.getDate() + 1);

  while (true) {
    const dayOfWeek = nextDate.getDay();
    const dateStr = nextDate.toISOString().slice(0, 10);

    if (
      MARKET_CONFIG.TRADING_DAYS.includes(dayOfWeek) &&
      !MARKET_CONFIG.MARKET_HOLIDAYS.includes(dateStr)
    ) {
      const [hours, minutes] = MARKET_CONFIG.MARKET_HOURS.OPEN_TIME.split(':');
      nextDate.setHours(parseInt(hours), parseInt(minutes), 0, 0);
      return nextDate;
    }

    nextDate.setDate(nextDate.getDate() + 1);
  }
}
