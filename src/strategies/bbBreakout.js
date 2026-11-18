// Strategy: Bollinger breakout (long).
//   1. The first 5-minute candle (09:15) is green and above the upper Bollinger Band.
//   2. A later candle breaks above that first candle's high → buy (buy-stop at the high).
//   3. Stop loss: the first candle's low (or its middle, or a fixed %).
//   4. Exits scored side by side: +1 %, +1.2 %, 1:2 and hold to 15:15.
// Pure functions — used by the server's backtest and the page.
import { istDate, istHHMM } from '../emasetup.js';

export const BB_DEFAULTS = {
  bbPeriod: 20,
  bbStd: 2,
  above: 'close', // 'close' = closes above the upper band · 'low' = whole candle above · 'open' = opens above
  entryBy: '09:25', // the breakout must happen before this time (09:25 = only the 2nd candle)
  stop: 'low', // 'low' = first candle's low · 'mid' = its middle · 'pct' = stopPct below the entry
  stopPct: 1,
  exitBy: '15:15',
};

export const BB_EXITS = [
  ['t1', 'Target +1%', 'sell at +1 % from the entry (+5 % at 5×)'],
  ['t12', 'Target +1.2%', 'sell at +1.2 % (+6 % at 5×)'],
  ['twoR', 'Fixed 1:2', 'target = entry + 2 × risk'],
  ['hold', 'Hold to 15:15', 'stop only, sold at 15:15'],
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
 * c1Day: that day's 1-minute candles (for the exact breakout minute and the exits).
 */
export function runBbBreakout({ c5, c1Day, day, params = {} }) {
  const P = { ...BB_DEFAULTS, ...params };
  const i = c5.findIndex((c) => istDate(c.time * 1000) === day && istHHMM(c.time) === '09:15');
  if (i < 0) return { status: 'waiting', note: 'no 09:15 candle (holiday or no data)' };
  const f = c5[i];
  const closes = c5.map((c) => c.close);
  const bb = bollinger(closes, i, P.bbPeriod, P.bbStd);
  const prev = c5[i - 1];
  const base = {
    first: { open: f.open, high: f.high, low: f.low, close: f.close },
    upper: r2(bb?.upper),
    gapPct: prev ? r2(((f.open - prev.close) / prev.close) * 100) : null,
    firstPct: r2(((f.close - f.open) / f.open) * 100),
  };
  if (!bb) return { ...base, status: 'waiting', note: `fewer than ${P.bbPeriod} candles before 09:15` };
  if (!(f.close > f.open)) return { ...base, status: 'not-green', note: 'first candle is not green' };
  const level = P.above === 'low' ? f.low : P.above === 'open' ? f.open : f.close;
  if (!(level > bb.upper)) return { ...base, status: 'not-above', note: `${P.above === 'low' ? 'low' : P.above === 'open' ? 'open' : 'close'} ${r2(level)} not above the upper band ${r2(bb.upper)}` };

  // breakout: first 1-minute candle after 09:20 whose high goes above the first candle's high
  const start = f.time + FIVE;
  const mins = c1Day.filter((c) => c.time >= start && istHHMM(c.time) < P.exitBy);
  const k = mins.findIndex((c) => istHHMM(c.time) < P.entryBy && c.high > f.high);
  if (k < 0) return { ...base, status: 'no-breakout', note: `high ${r2(f.high)} not crossed before ${P.entryBy}` };
  const entry = r2(Math.max(f.high, mins[k].open)); // gap above the high → filled at the open
  const sl = r2(P.stop === 'mid' ? (f.high + f.low) / 2 : P.stop === 'pct' ? entry * (1 - P.stopPct / 100) : f.low);
  const risk = entry - sl;
  if (!(risk > 0)) return { ...base, status: 'invalid', note: 'stop not below the entry' };
  const targets = { t1: entry * 1.01, t12: entry * 1.012, twoR: entry + 2 * risk, hold: null };
  const out = { ...base, status: 'entered', entry, sl, entryAt: istHHMM(mins[k].time), riskPct: r2((risk / entry) * 100) };
  const done = {};
  let best = 0;
  for (let j = k; j < mins.length; j++) {
    const c = mins[j];
    // the entry minute: only what happened after the breakout counts — be conservative,
    // a stop in that minute counts, a target only if the close is beyond it
    const stop = c.low <= sl;
    for (const [key, tgt] of Object.entries(targets)) {
      if (done[key]) continue;
      if (stop) done[key] = { px: j > k && c.open < sl ? c.open : sl, at: istHHMM(c.time), how: 'stop' };
      else if (tgt != null && (j > k ? c.high >= tgt : c.close >= tgt)) done[key] = { px: j > k && c.open > tgt ? c.open : tgt, at: istHHMM(c.time), how: 'target' };
    }
    if (!stop) best = Math.max(best, c.high - entry);
    if (Object.keys(done).length === 4) break;
  }
  const last = mins[mins.length - 1];
  for (const key of Object.keys(targets)) {
    const d = done[key] || { px: last.close, at: istHHMM(last.time), how: 'time' };
    out[key] = { ...d, px: r2(d.px), r: r2((d.px - entry) / risk), pct: r2(((d.px - entry) / entry) * 100) };
  }
  out.bestR = r2(best / risk);
  out.bestPct = r2((best / entry) * 100);
  return out;
}
