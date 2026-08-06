/**
 * Chart studies — pure OHLCV transforms, no I/O.
 *
 * Kept separate from insightsEngine because these serve a different purpose:
 * the engine reduces a series to a handful of scalars for scoring, while these
 * produce a value per candle for plotting. Same inputs, different shape.
 *
 * Every function takes the normalised candle shape used by the candles route
 * ({ time, open, high, low, close, volume }) and returns one entry per input
 * candle, `null` where the study has not warmed up yet. Lightweight Charts
 * skips null points, so the line simply starts late rather than drawing a
 * misleading value from a partial window.
 */

function round2(n) { return Math.round(n * 100) / 100; }
function round4(n) { return Math.round(n * 10000) / 10000; }
// The COG oscillator's magnitude scales with *relative* dispersion inside its
// window, so a ₹12,000 stock on 1-minute candles produces values around 1e-3.
// Two extra digits keep the curve smooth instead of quantising it into a
// staircase; the pane auto-scales, so the small absolute numbers do not matter.
function round6(n) { return Math.round(n * 1e6) / 1e6; }

/** Median price (H+L)/2 — the input Ehlers specifies for COG. */
function medianPrice(c) { return (c.high + c.low) / 2; }

/**
 * Ehlers' Center of Gravity oscillator.
 *
 * The centre of gravity of the last `period` prices, in the mechanical sense:
 * each price is weighted by how far back it sits, and the weighted average
 * position is where the window would balance. When recent prices are heavy
 * (a rally) the balance point shifts and the oscillator turns.
 *
 * The `(period + 1) / 2` term recentres the raw balance point — which would
 * otherwise sit around the window midpoint — on zero, so crossings of zero and
 * of the signal line are readable without knowing the period.
 *
 * Its appeal over a moving average is the near-total lack of lag: it is a
 * weighted average of position, not of price, so it turns with the data rather
 * than trailing it. The cost is that it whipsaws in a flat market — the signal
 * line is what makes it tradeable, and crossovers are the usual read.
 */
export function ehlersCOG(candles, period = 10, signalPeriod = 3) {
  const out = candles.map((c, i) => {
    if (i < period - 1) return { time: c.time, cog: null, signal: null };

    let num = 0, den = 0;
    for (let k = 0; k < period; k++) {
      const price = medianPrice(candles[i - k]);
      num += (1 + k) * price;
      den += price;
    }
    // A zero denominator needs prices summing to zero, which cannot happen for
    // real quotes — but guard rather than emit NaN into the chart.
    const cog = den === 0 ? null : round6(-num / den + (period + 1) / 2);
    return { time: c.time, cog, signal: null };
  });

  // Signal line: a short SMA of the oscillator itself. Ehlers uses a 1-bar lag;
  // a 3-bar average cuts the whipsaw without meaningfully adding lag.
  for (let i = 0; i < out.length; i++) {
    if (i < period - 1 + signalPeriod - 1) continue;
    let sum = 0, n = 0;
    for (let k = 0; k < signalPeriod; k++) {
      const v = out[i - k].cog;
      if (v == null) { n = 0; break; }
      sum += v; n++;
    }
    if (n === signalPeriod) out[i].signal = round6(sum / n);
  }

  return out;
}

/**
 * Rolling linear-regression channel — the "COG channel" of trend-following
 * platforms.
 *
 * Least-squares line through the last `period` closes, with bands at
 * `mult` standard deviations of the residuals. The line is the trend; the
 * bands are how far price has historically strayed from it, so they widen in
 * choppy stretches and pinch in clean ones.
 *
 * Rolling rather than anchored to a fixed start: an anchored channel silently
 * changes meaning as the session extends, and re-fitting on every refresh would
 * make the bands jump under the user.
 */
export function regressionChannel(candles, period = 60, mult = 2) {
  // x is centred on the window (…-2,-1,0,1,2…) so Σx = 0. That drops the
  // cross-term from the normal equations, leaving slope and intercept as two
  // independent sums instead of a 2x2 solve.
  const xs = Array.from({ length: period }, (_, k) => k - (period - 1) / 2);
  const sxx = xs.reduce((a, x) => a + x * x, 0);

  return candles.map((c, i) => {
    if (i < period - 1) return { time: c.time, mid: null, upper: null, lower: null };

    let sy = 0, sxy = 0;
    for (let k = 0; k < period; k++) {
      const y = candles[i - period + 1 + k].close;
      sy += y;
      sxy += xs[k] * y;
    }
    const slope = sxx === 0 ? 0 : sxy / sxx;
    const intercept = sy / period;

    let ssr = 0;
    for (let k = 0; k < period; k++) {
      const y = candles[i - period + 1 + k].close;
      const fitted = intercept + slope * xs[k];
      ssr += (y - fitted) ** 2;
    }
    const sd = Math.sqrt(ssr / period);

    // Evaluate at the newest bar, i.e. the right-hand end of the window.
    const mid = intercept + slope * xs[period - 1];
    return {
      time: c.time,
      mid: round2(mid),
      upper: round2(mid + mult * sd),
      lower: round2(mid - mult * sd),
      slope: round4(slope),
    };
  });
}

/**
 * Running volume-weighted centre of gravity — cumulative from the first candle,
 * so it is the session VWAP when handed a session's candles.
 *
 * This is the volume reading of "centre of gravity": the price level the
 * session's traded value balances around, rather than a momentum oscillator.
 */
export function volumeCOG(candles) {
  let pv = 0, vol = 0;
  return candles.map(c => {
    const typical = (c.high + c.low + c.close) / 3;
    const v = c.volume || 0;
    pv += typical * v;
    vol += v;
    return { time: c.time, value: vol === 0 ? null : round2(pv / vol) };
  });
}

/**
 * Volume profile: traded volume binned by price, and the point of control —
 * the single price level that saw the most volume.
 *
 * Volume is spread evenly across each candle's high-low range rather than
 * dumped at the close. A candle is an aggregate of trades across its whole
 * range, so assigning all of it to one price invents a concentration that the
 * tape does not support — visible as a spiky profile that moves with the bin
 * count instead of with the market.
 */
export function volumeProfile(candles, bins = 40) {
  const withVolume = candles.filter(c => (c.volume || 0) > 0);
  if (!withVolume.length) return { poc: null, bins: [] };

  const lo = Math.min(...withVolume.map(c => c.low));
  const hi = Math.max(...withVolume.map(c => c.high));
  if (!(hi > lo)) return { poc: round2(lo), bins: [] };

  const width = (hi - lo) / bins;
  const buckets = new Array(bins).fill(0);

  for (const c of withVolume) {
    const first = Math.min(bins - 1, Math.max(0, Math.floor((c.low - lo) / width)));
    const last = Math.min(bins - 1, Math.max(0, Math.floor((c.high - lo) / width)));
    const span = last - first + 1;
    const share = c.volume / span;
    for (let b = first; b <= last; b++) buckets[b] += share;
  }

  let pocIdx = 0;
  for (let b = 1; b < bins; b++) if (buckets[b] > buckets[pocIdx]) pocIdx = b;

  return {
    poc: round2(lo + (pocIdx + 0.5) * width),
    bins: buckets.map((v, b) => ({ price: round2(lo + (b + 0.5) * width), volume: Math.round(v) })),
  };
}

/**
 * Every study for one series, in the shape the chart consumes.
 * Guards the empty case so the route never has to.
 */
export function computeStudies(candles, opts = {}) {
  if (!Array.isArray(candles) || !candles.length) {
    return { cog: [], regression: [], volumeCog: [], volumeProfile: { poc: null, bins: [] } };
  }
  const cogPeriod = opts.cogPeriod ?? 10;
  // A regression window longer than the data yields nothing but nulls; fall
  // back to a third of the series so an early-session chart still draws.
  const regPeriod = Math.min(opts.regressionPeriod ?? 60, Math.max(5, Math.floor(candles.length / 3)));

  return {
    cog: ehlersCOG(candles, cogPeriod),
    cogPeriod,
    regression: regressionChannel(candles, regPeriod, opts.regressionMult ?? 2),
    regressionPeriod: regPeriod,
    volumeCog: volumeCOG(candles),
    volumeProfile: volumeProfile(candles),
  };
}
