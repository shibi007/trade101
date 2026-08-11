/**
 * Broad market scan — screens every NSE equity, not a hand-typed shortlist.
 *
 * The deep pipeline in insightsEngine needs two throttled historical calls per
 * stock, which caps it at a few dozen names before the request times out. Bulk
 * quotes cost one call per 250 stocks, so the whole market is reachable in
 * under ten calls.
 *
 * That buys breadth at the cost of depth: a quote carries the day's OHLC,
 * volume, VWAP and order book, but no intraday candles — so there is no ATR,
 * no opening-range status, no moving averages. This module therefore does not
 * try to produce a trade plan. It ranks the market to decide which names are
 * worth spending historical calls on, and insightsEngine does the real work on
 * the survivors.
 *
 * Everything here is a pure function of a quotes object so it can be tested
 * without a live market.
 */

function round2(n) { return Math.round(n * 100) / 100; }

/**
 * Liquidity gates. Most of the ~2000 NSE equities cannot be traded intraday at
 * any size: they are illiquid, penny-priced, or carry spreads that eat the move
 * before it starts. Screening them in would fill the board with setups that
 * look good and cannot be executed.
 */
export const DEFAULT_FILTERS = {
  minTurnover: 5_00_00_000,   // ₹5 crore traded today — below this, size moves the price
  minPrice: 20,               // sub-₹20 names tick in percentages too coarse for a 1.5R stop
  maxSpreadPct: 0.5,          // wider than this and the round trip costs more than the edge
  minRangePct: 0.5,           // a stock that has not moved 0.5% all day has no intraday setup
};

/**
 * Indicators derivable from a single quote — no candles required.
 *
 * `ohlc.close` is the *previous* session's close in Kite's payload, which is
 * what a day change is measured against. Reading it as today's close would make
 * every change read as zero.
 */
export function indicatorsFromQuote(symbol, quote) {
  if (!quote || !quote.ohlc) return null;
  const { ohlc } = quote;
  const ltp = quote.last_price;
  const prevClose = ohlc.close;
  if (!(ltp > 0) || !(prevClose > 0)) return null;

  const high = ohlc.high, low = ohlc.low, open = ohlc.open;
  const volume = quote.volume ?? 0;
  const turnover = ltp * volume;

  // Best bid/ask from the top of the book, when depth is present.
  const bid = quote.depth?.buy?.[0]?.price ?? null;
  const ask = quote.depth?.sell?.[0]?.price ?? null;
  const spreadPct = (bid > 0 && ask > 0) ? round2(((ask - bid) / ltp) * 100) : null;

  const buyQty = quote.buy_quantity ?? 0;
  const sellQty = quote.sell_quantity ?? 0;
  const orderImbalance = (buyQty + sellQty) > 0
    ? round2((buyQty - sellQty) / (buyQty + sellQty)) : null;

  // Day range stands in for ATR at this tier. It is a cruder measure — one
  // session rather than an average — but it is the only volatility signal a
  // quote carries, and it is enough to rank candidates.
  const rangePct = (high > low) ? round2(((high - low) / ltp) * 100) : 0;

  let circuitHeadroomPct = null;
  if (quote.upper_circuit_limit > 0 && quote.lower_circuit_limit > 0) {
    circuitHeadroomPct = round2(
      Math.min(quote.upper_circuit_limit - ltp, ltp - quote.lower_circuit_limit) / ltp * 100);
  }

  return {
    symbol,
    ltp, prevClose, open, dayHigh: high, dayLow: low, volume, turnover,
    changePct: round2(((ltp - prevClose) / prevClose) * 100),
    gapPct: round2(((open - prevClose) / prevClose) * 100),
    rangePosition: high > low ? round2(((ltp - low) / (high - low)) * 100) : 50,
    rangePct,
    vwap: quote.average_price ?? null,
    aboveVwap: quote.average_price > 0 ? ltp > quote.average_price : null,
    bid, ask, spreadPct, orderImbalance, circuitHeadroomPct,
    lastTradeTime: quote.last_trade_time ?? null,
  };
}

/** Is this name actually tradeable intraday? */
export function passesLiquidity(ind, filters = DEFAULT_FILTERS) {
  if (!ind) return false;
  if (ind.turnover < filters.minTurnover) return false;
  if (ind.ltp < filters.minPrice) return false;
  if (ind.rangePct < filters.minRangePct) return false;
  // A null spread means depth was absent, not that the spread is fine — but
  // rejecting on missing data would drop everything when depth is not returned,
  // so this only rejects spreads it can actually measure.
  if (ind.spreadPct != null && ind.spreadPct > filters.maxSpreadPct) return false;
  return true;
}

/**
 * Rank a stock on what a quote can support.
 *
 * Deliberately coarse and deliberately *not* the setup score: this decides who
 * gets a historical call, nothing more. Presenting it as a setup score would
 * imply signals (opening range, moving averages, ATR-based levels) that were
 * never evaluated at this tier.
 */
export function quoteScore(ind, marketChangePct = 0) {
  const relStrength = round2(ind.changePct - marketChangePct);
  let score = 0;
  const reasons = [];

  const absRel = Math.abs(relStrength);
  if (absRel > 2) { score += 30; reasons.push(`Moving ${relStrength > 0 ? 'up' : 'down'} hard vs the market (${relStrength > 0 ? '+' : ''}${relStrength}%)`); }
  else if (absRel > 1) { score += 20; reasons.push(`Outpacing the market (${relStrength > 0 ? '+' : ''}${relStrength}%)`); }
  else if (absRel > 0.5) { score += 10; }

  // Extension in the direction of the move: near the day's high on strength,
  // near its low on weakness. Near the high while falling is not a long signal.
  const long = relStrength >= 0;
  if (long && ind.rangePosition > 80) { score += 20; reasons.push('Near the day high'); }
  if (!long && ind.rangePosition < 20) { score += 20; reasons.push('Near the day low'); }

  if (ind.aboveVwap === long) { score += 15; reasons.push(`${long ? 'Above' : 'Below'} VWAP, with the move`); }

  if (Math.abs(ind.gapPct) > 1 && Math.sign(ind.gapPct) === Math.sign(ind.changePct)) {
    score += 15; reasons.push(`Gap ${ind.gapPct > 0 ? 'up' : 'down'} (${ind.gapPct}%) still holding`);
  }

  if (ind.orderImbalance != null && Math.abs(ind.orderImbalance) > 0.2
      && (ind.orderImbalance > 0) === long) {
    score += 10; reasons.push(`Order book leaning ${long ? 'bid' : 'offer'}-heavy`);
  }

  // Liquidity is a real edge intraday, so reward genuinely heavy turnover.
  if (ind.turnover > 50_00_00_000) { score += 10; reasons.push('Heavy turnover'); }

  if (ind.circuitHeadroomPct != null && ind.circuitHeadroomPct < 2) {
    score -= 25; reasons.push(`⚠ Within ${ind.circuitHeadroomPct}% of circuit — halt risk`);
  }

  return {
    score: Math.max(0, Math.min(100, score)),
    direction: long ? 'LONG' : 'SHORT',
    relStrength,
    reasons,
  };
}

/**
 * Screen a whole market's worth of quotes.
 *
 * `marketChangePct` is the median change across everything that passed the
 * liquidity gate — median rather than mean because a handful of circuit-locked
 * movers would drag a mean and quietly shift every relative-strength figure.
 */
export function scanMarket(quotes, { filters = DEFAULT_FILTERS, limit = 40 } = {}) {
  const all = [];
  for (const [key, quote] of Object.entries(quotes || {})) {
    const symbol = key.startsWith('NSE:') ? key.slice(4) : key;
    const ind = indicatorsFromQuote(symbol, quote);
    if (ind) all.push(ind);
  }

  const liquid = all.filter(ind => passesLiquidity(ind, filters));

  const changes = liquid.map(i => i.changePct).sort((a, b) => a - b);
  const marketChangePct = changes.length
    ? round2(changes.length % 2
      ? changes[(changes.length - 1) / 2]
      : (changes[changes.length / 2 - 1] + changes[changes.length / 2]) / 2)
    : 0;

  const scored = liquid.map(ind => ({ ...ind, ...quoteScore(ind, marketChangePct) }))
    .sort((a, b) => b.score - a.score || b.turnover - a.turnover);

  const advances = liquid.filter(i => i.changePct > 0).length;
  const declines = liquid.filter(i => i.changePct < 0).length;

  return {
    scanned: all.length,
    liquid: liquid.length,
    marketChangePct,
    breadth: { advances, declines, unchanged: liquid.length - advances - declines },
    candidates: scored.slice(0, limit),
    all: scored,
  };
}
