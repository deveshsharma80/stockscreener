// Strategy: Bollinger first candle.
//   Setup: the first 5-minute candle (09:15) is green and above the upper Bollinger Band.
//   Short (default): a later candle eats half of that first candle (trades down to its
//     middle) → short there; stop loss at the first candle's high.
//   Long (option): a later candle breaks above its high → buy; stop at its low.
//   Exits scored side by side: 1 %, 1.2 %, 1:2 and hold to 15:15.
// Pure functions — used by the server's backtest and the page.
import { istDate, istHHMM } from '../emasetup.js';

export const BB_DEFAULTS = {
  bbPeriod: 20,
  bbStd: 2,
  above: 'close', // 'close' = closes above the upper band · 'low' = whole candle above · 'open' = opens above
  trade: 'short-half', // 'short-half' = short when a later candle eats half the first candle · 'long-break' = buy above its high
  half: 'range', // short level: 'range' = middle of high–low · 'body' = middle of open–close
  entryBy: '11:00', // the entry must happen before this time
  stop: 'candle', // 'candle' = first candle's high (short) / low (long) · 'pct' = stopPct from the entry
  stopPct: 1,
  exitBy: '15:15',
};

export const BB_EXITS = [
  ['t1', 'Target 1%', '1 % move in your favour (5 % at 5×)'],
  ['t12', 'Target 1.2%', '1.2 % move in your favour (6 % at 5×)'],
  ['twoR', 'Fixed 1:2', 'target = 2 × risk'],
  ['hold', 'Hold to 15:15', 'stop only, closed at 15:15'],
];

const r2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
const FIVE = 300;

/** Bollinger Band at index i of closes (SMA ± k × population st. dev., like TradingView). */
export function bollinger(closes, i, n, k) {
  if (i + 1 < n) return null;
  let s = 0;
  for (let j = i - n + 1; j <= i; j++) s += closes[j];
  const mid = s / n;
  let v = 0;
  for (let j = i - n + 1; j <= i; j++) v += (closes[j] - mid) ** 2;
  const sd = Math.sqrt(v / n);
  return { mid, upper: mid + k * sd, lower: mid - k * sd };
}

/**
 * c5: 5-minute candles over several days up to the end of `day` (BB carries across days).
 * c1Day: that day's 1-minute candles (for the exact entry minute and the exits).
 */
export function runBbBreakout({ c5, c1Day, day, params = {} }) {
  const P = { ...BB_DEFAULTS, ...params };
  const short = P.trade !== 'long-break';
  const i = c5.findIndex((c) => istDate(c.time * 1000) === day && istHHMM(c.time) === '09:15');
  if (i < 0) return { status: 'waiting', note: 'no 09:15 candle (holiday or no data)' };
  const f = c5[i];
  const closes = c5.map((c) => c.close);
  const bb = bollinger(closes, i, P.bbPeriod, P.bbStd);
  const prev = c5[i - 1];
  const base = {
    side: short ? 'short' : 'long',
    first: { open: f.open, high: f.high, low: f.low, close: f.close },
    upper: r2(bb?.upper),
    gapPct: prev ? r2(((f.open - prev.close) / prev.close) * 100) : null,
    firstPct: r2(((f.close - f.open) / f.open) * 100),
  };
  // skipSetup: a scanner already picked this stock (Back Test → Scanner source)
  if (!P.skipSetup && !bb) return { ...base, status: 'waiting', note: `fewer than ${P.bbPeriod} candles before 09:15` };
  if (!P.skipSetup && !(f.close > f.open)) return { ...base, status: 'not-green', note: 'first candle is not green' };
  const level = P.above === 'low' ? f.low : P.above === 'open' ? f.open : f.close;
  if (!P.skipSetup && !(level > bb.upper)) return { ...base, status: 'not-above', note: `${P.above === 'low' ? 'low' : P.above === 'open' ? 'open' : 'close'} ${r2(level)} not above the upper band ${r2(bb.upper)}` };

  // entry: first 1-minute candle after the first 5 minutes that reaches the level
  const mins = c1Day.filter((c) => c.time >= f.time + FIVE && istHHMM(c.time) < P.exitBy);
  const trigger = short ? (P.half === 'body' ? (f.open + f.close) / 2 : (f.high + f.low) / 2) : f.high;
  const k = mins.findIndex((c) => istHHMM(c.time) < P.entryBy && (short ? c.low <= trigger : c.high > trigger));
  if (k < 0) return { ...base, trigger: r2(trigger), status: 'no-entry', note: short ? `half (${r2(trigger)}) not eaten before ${P.entryBy}` : `high ${r2(f.high)} not crossed before ${P.entryBy}` };
  const entry = r2(short ? Math.min(trigger, mins[k].open) : Math.max(trigger, mins[k].open)); // gap through → the open
  const dir = short ? -1 : 1; // profit = dir × (exit − entry)
  const sl = r2(P.stop === 'pct' ? entry * (1 - (dir * P.stopPct) / 100) : short ? f.high : f.low);
  const risk = dir * (entry - sl);
  if (!(risk > 0)) return { ...base, trigger: r2(trigger), status: 'invalid', note: 'stop is on the wrong side of the entry' };
  const targets = { t1: entry * (1 + dir * 0.01), t12: entry * (1 + dir * 0.012), twoR: entry + dir * 2 * risk, hold: null };
  const out = { ...base, trigger: r2(trigger), status: 'entered', entry, sl, entryAt: istHHMM(mins[k].time), riskPct: r2((risk / entry) * 100) };
  const done = {};
  let best = 0;
  const hitStop = (c) => (short ? c.high >= sl : c.low <= sl);
  const reached = (c, t, closeOnly) => (short ? (closeOnly ? c.close : c.low) <= t : (closeOnly ? c.close : c.high) >= t);
  for (let j = k; j < mins.length; j++) {
    const c = mins[j];
    // in the entry minute a stop counts, a target only if the close is beyond it (conservative)
    const stop = hitStop(c);
    for (const [key, tgt] of Object.entries(targets)) {
      if (done[key]) continue;
      if (stop) done[key] = { px: j > k && dir * (sl - c.open) > 0 ? c.open : sl, at: istHHMM(c.time), how: 'stop' };
      else if (tgt != null && reached(c, tgt, j === k)) done[key] = { px: j > k && dir * (c.open - tgt) > 0 ? c.open : tgt, at: istHHMM(c.time), how: 'target' };
    }
    if (!stop) best = Math.max(best, short ? entry - c.low : c.high - entry);
    if (Object.keys(done).length === 4) break;
  }
  const last = mins[mins.length - 1];
  for (const key of Object.keys(targets)) {
    const d = done[key] || { px: last.close, at: istHHMM(last.time), how: 'time' };
    out[key] = { ...d, px: r2(d.px), r: r2((dir * (d.px - entry)) / risk), pct: r2(((dir * (d.px - entry)) / entry) * 100) };
  }
  out.bestR = r2(best / risk);
  out.bestPct = r2((best / entry) * 100);
  return out;
}
