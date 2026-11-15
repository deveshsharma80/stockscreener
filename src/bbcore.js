// 4-hour Bollinger Band + RSI scan, shared by the browser (Big Movers → 4h BB + RSI,
// "Run now") and the server (lib/bbscan.js, run automatically every 4 hours).
// Pure functions only — no browser or Node APIs.
import { bollinger, rsi } from './indicators.js';

export const H4 = 4 * 3600;
export const CANDLES = 300; // warm-up for RSI (Wilder) + BB 30 + 7 days of look-back
export const LOOKBACK_MAX = 42; // 7 days of 4-hour candles
export const DEFAULT_CFG = { bbLen: 30, bbMult: 2, rsiLen: 14, rsiMin: 70, lookback: LOOKBACK_MAX, includeForming: false };

/** Candles from Binance kline arrays. */
export const toCandles = (rows) =>
  rows.map((k) => ({ time: Math.floor(k[0] / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5], quoteVolume: +k[7] }));

/** Every candle in the look-back window where low > upper band and RSI > level. */
export function bbHits(symbol, cs, { bbLen, bbMult, rsiLen, rsiMin, lookback, includeForming, nowSec }) {
  if (cs.length < Math.max(bbLen, rsiLen + 1) + 1) return [];
  const bb = bollinger(cs, bbLen, bbMult);
  const r = rsi(cs, rsiLen);
  // The last candle is still forming if it hasn't closed yet.
  let last = cs.length - 1;
  const forming = cs[last].time + H4 > nowSec;
  if (forming && !includeForming) last -= 1;
  const out = [];
  const nowPrice = cs[cs.length - 1].close;
  for (let i = Math.max(0, last - lookback + 1); i <= last; i++) {
    const c = cs[i];
    const up = bb.upper[i];
    if (up == null || r[i] == null) continue;
    if (!(c.low > up && r[i] > rsiMin)) continue;
    const after = cs.slice(i + 1, i + 7); // up to 6 candles (24h) after, including one still forming
    out.push({
      symbol,
      time: c.time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      upper: up,
      rsi: r[i],
      gap: (c.low / up - 1) * 100,
      chg: (c.close / c.open - 1) * 100,
      quoteVolume: c.quoteVolume,
      next1: cs[i + 1] && cs[i + 1].time + H4 <= nowSec ? (cs[i + 1].close / c.close - 1) * 100 : null,
      max6: after.length ? (Math.max(...after.map((x) => x.high)) / c.close - 1) * 100 : null,
      min6: after.length ? (Math.min(...after.map((x) => x.low)) / c.close - 1) * 100 : null,
      now: i < cs.length - 1 ? (nowPrice / c.close - 1) * 100 : null,
      forming: i === cs.length - 1 && forming,
    });
  }
  return out;
}

