import { MARKET_CONFIG } from '../../config/marketConfig.js';

/**
 * Utility functions for market-related operations
 */

// Convert time string to minutes since midnight
export function timeToMinutes(timeStr) {
  const [hours, minutes] = timeStr.split(':').map(Number);
  return hours * 60 + minutes;
}

// Get current time in IST
export function getCurrentISTTime() {
  return new Date().toLocaleString('en-US', { timeZone: MARKET_CONFIG.TIMEZONE });
}

// Get current time in IST as Date object
export function getCurrentISTDate() {
  const istTime = new Date().toLocaleString('en-US', { timeZone: MARKET_CONFIG.TIMEZONE });
  return new Date(istTime);
}

// Check if market is currently open
export function isMarketCurrentlyOpen() {
  const istDate = getCurrentISTDate();
  const dayOfWeek = istDate.getDay();
  const hours = istDate.getHours();
  const minutes = istDate.getMinutes();
  const currentTime = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;

  // Check trading day
  if (!MARKET_CONFIG.TRADING_DAYS.includes(dayOfWeek)) {
    return false;
  }

  // Check holidays
  const dateStr = istDate.toISOString().slice(0, 10);
  if (MARKET_CONFIG.MARKET_HOLIDAYS.includes(dateStr)) {
    return false;
  }

  // Check market hours
  const openTime = MARKET_CONFIG.MARKET_HOURS.OPEN_TIME;
  const closeTime = MARKET_CONFIG.MARKET_HOURS.CLOSE_TIME;

  return currentTime >= openTime && currentTime < closeTime;
}

// Get minutes until market close
export function getMinutesUntilMarketClose() {
  const istDate = getCurrentISTDate();
  const [closeHours, closeMinutes] = MARKET_CONFIG.MARKET_HOURS.CLOSE_TIME.split(':').map(Number);

  const closeTime = new Date(istDate);
  closeTime.setHours(closeHours, closeMinutes, 0, 0);

  const minutesLeft = Math.floor((closeTime - istDate) / 60000);
  return Math.max(0, minutesLeft);
}

// Check if it's near market close (within last hour)
export function isNearMarketClose() {
  return getMinutesUntilMarketClose() <= 60;
}

// Check if it's time for auto square-off
export function isAutoSquareOffTime() {
  const minutesUntilClose = getMinutesUntilMarketClose();
  return minutesUntilClose <= 5 && minutesUntilClose >= 0; // Last 5 minutes
}

// Format price with rupee symbol
export function formatPrice(price) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(price);
}

// Calculate position size based on risk
export function calculatePositionSize(accountSize, riskPercent, stopLossPoints) {
  const riskAmount = (accountSize * riskPercent) / 100;
  return Math.floor(riskAmount / stopLossPoints);
}

// Calculate P&L
export function calculatePnL(entryPrice, exitPrice, quantity) {
  const priceChange = exitPrice - entryPrice;
  return Math.round(priceChange * quantity * 100) / 100;
}

// Calculate P&L percentage
export function calculatePnLPercent(entryPrice, exitPrice) {
  const change = ((exitPrice - entryPrice) / entryPrice) * 100;
  return Math.round(change * 100) / 100;
}

// Get next market open time
export function getNextMarketOpenTime(fromDate = new Date()) {
  let nextDate = new Date(
    fromDate.toLocaleString('en-US', { timeZone: MARKET_CONFIG.TIMEZONE })
  );
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

// Get next market close time
export function getNextMarketCloseTime(fromDate = new Date()) {
  const istDate = new Date(
    fromDate.toLocaleString('en-US', { timeZone: MARKET_CONFIG.TIMEZONE })
  );
  const [hours, minutes] = MARKET_CONFIG.MARKET_HOURS.CLOSE_TIME.split(':');
  const closeTime = new Date(istDate);
  closeTime.setHours(parseInt(hours), parseInt(minutes), 0, 0);

  // If close time has passed, return close time for tomorrow
  if (closeTime <= istDate) {
    return getNextMarketCloseTime(new Date(istDate.getTime() + 24 * 60 * 60 * 1000));
  }

  return closeTime;
}

// Validate intraday trade rules
export function validateIntradayTrade(trade, portfolio) {
  const errors = [];
  const warnings = [];

  // Check minimum lot size
  if (trade.quantity < MARKET_CONFIG.INTRADAY_RULES.MIN_LOT_SIZE) {
    errors.push(
      `Minimum lot size is ${MARKET_CONFIG.INTRADAY_RULES.MIN_LOT_SIZE} shares`
    );
  }

  // Check market is open
  if (!isMarketCurrentlyOpen()) {
    errors.push('Market is not open. Intraday trading is only during market hours (9:15 AM - 3:30 PM IST)');
  }

  // Check position size
  const positionValue = (trade.price || 0) * trade.quantity;
  const maxPositionValue = (portfolio.totalValue * MARKET_CONFIG.INTRADAY_RULES.MAX_POSITION_SIZE_PERCENT) / 100;
  if (positionValue > maxPositionValue) {
    errors.push(
      `Position exceeds max size of ${MARKET_CONFIG.INTRADAY_RULES.MAX_POSITION_SIZE_PERCENT}% portfolio value`
    );
  }

  // Check available margin
  const requiredMargin = positionValue * (MARKET_CONFIG.INTRADAY_RULES.INTRADAY_MARGIN_PERCENT / 100);
  if (portfolio.availableMargin < requiredMargin) {
    errors.push(`Insufficient margin. Required: ${formatPrice(requiredMargin)}, Available: ${formatPrice(portfolio.availableMargin)}`);
  }

  // Warn if near market close
  if (isNearMarketClose()) {
    warnings.push('Market is closing soon. Ensure you have time to exit your position.');
  }

  return { valid: errors.length === 0, errors, warnings };
}

export default {
  timeToMinutes,
  getCurrentISTTime,
  getCurrentISTDate,
  isMarketCurrentlyOpen,
  getMinutesUntilMarketClose,
  isNearMarketClose,
  isAutoSquareOffTime,
  formatPrice,
  calculatePositionSize,
  calculatePnL,
  calculatePnLPercent,
  getNextMarketOpenTime,
  getNextMarketCloseTime,
  validateIntradayTrade,
};
