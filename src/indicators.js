// Technical indicators on candle arrays [{ time, open, high, low, close }].
// Each returns an array the same length as the candles, with null where
// there isn't enough history yet. Conventions match TradingView's defaults.
import { ema, crossovers } from './candles.js';

export { ema, crossovers };

/**
 * RSI with Wilder's smoothing (TradingView `ta.rsi`): the first average gain /
 * loss is the simple average of the first `period` changes, then
 * avg = (prev × (period − 1) + current) / period.
 */
export function rsi(candles, period = 14) {
  const out = new Array(candles.length).fill(null);
  if (period < 1 || candles.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = candles[i].close - candles[i - 1].close;
    if (d > 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  const val = () => (loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss));
  out[period] = val();
  for (let i = period + 1; i < candles.length; i++) {
    const d = candles[i].close - candles[i - 1].close;
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = val();
  }
  return out;
}

/**
 * Bollinger Bands (TradingView defaults): middle = SMA(period) of closes,
 * upper / lower = middle ± mult × population standard deviation.
 * Returns { upper, middle, lower, pctB } arrays; %B = (close − lower) / (upper − lower).
 */
export function bollinger(candles, period = 20, mult = 2) {
  const n = candles.length;
  const upper = new Array(n).fill(null);
  const middle = new Array(n).fill(null);
  const lower = new Array(n).fill(null);
  const pctB = new Array(n).fill(null);
  if (period < 2 || n < period) return { upper, middle, lower, pctB };
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const c = candles[i].close;
    sum += c;
    sumSq += c * c;
    if (i >= period) {
      const old = candles[i - period].close;
      sum -= old;
      sumSq -= old * old;
    }
    if (i >= period - 1) {
      const mean = sum / period;
      const sd = Math.sqrt(Math.max(0, sumSq / period - mean * mean));
      middle[i] = mean;
      upper[i] = mean + mult * sd;
      lower[i] = mean - mult * sd;
      pctB[i] = upper[i] === lower[i] ? 0.5 : (c - lower[i]) / (upper[i] - lower[i]);
    }
  }
  return { upper, middle, lower, pctB };
}

/** Plain-language reading of the latest values, for the watchlist. */
export function readings(candles, cfg) {
  const n = candles.length - 1;
  if (n < 1) return null;
  const r = rsi(candles, cfg.rsi);
  const f = ema(candles, cfg.emaFast);
  const s = ema(candles, cfg.emaSlow);
  const bb = bollinger(candles, cfg.bbPeriod, cfg.bbMult);
  const xs = crossovers(candles, f, s);
  const lastX = xs[xs.length - 1] || null;
  return {
    rsi: r[n],
    emaFast: f[n],
    emaSlow: s[n],
    trend: f[n] == null || s[n] == null ? null : f[n] > s[n] ? 'bull' : f[n] < s[n] ? 'bear' : null,
    lastCross: lastX ? { type: lastX.type, barsAgo: n - lastX.index, time: lastX.time } : null,
    bb: { upper: bb.upper[n], middle: bb.middle[n], lower: bb.lower[n], pctB: bb.pctB[n] },
  };
}
