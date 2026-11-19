// Strategy: Range breakout (consolidation → breakout with volume), long or short.
//   Range:    the `bars` 5-minute candles before the breakout candle; highest high ÷ lowest
//             low below 1 + rangePct %  (8 candles = 40 min within 1 %).
//   Breakout: a 5-minute candle closes above the range high (long) or below the range low
//             (short) on more than volMult × the range's average volume.
//   Entry:    at the breakout candle's close (the next minute's open) — the moment a live
//             scan would see it.
//   Stop:     the other side of the range (default), the range's middle, or the breakout
//             candle's low / high.
//   Exits scored side by side: 1 %, 1:2, 1:3 and hold to 15:15.
// With `at` (Back Test → My scanner: the scan's hit time) that candle is the breakout
// candle; without it (Chartink CSV) the first breakout between `from` and `to` is used.
// Pure functions — used by the history server, Vercel's backtest and the page.
import { istDate, istHHMM } from '../emasetup.js';

export const RANGE_DEFAULTS = {
  bars: 8, // candles in the range (6 = 30 min … 12 = 1 hour)
  rangePct: 1, // range height limit, % of the low
  volMult: 2, // breakout volume > volMult × the range's average volume
  from: '10:00', // first breakout candle (CSV source only)
  to: '14:30', // last breakout candle (CSV source only)
  stop: 'range', // 'range' = other side of the range · 'mid' = middle of the range · 'candle' = breakout candle low / high
  exitBy: '15:15',
};

export const RANGE_EXITS = [
  ['t1', 'Target 1%', '1 % move in your favour (5 % at 5×)'],
  ['twoR', 'Fixed 1:2', 'target = 2 × risk'],
  ['threeR', 'Fixed 1:3', 'target = 3 × risk'],
  ['hold', 'Hold to 15:15', 'stop only, closed at 15:15'],
];

const r2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
const FIVE = 300;

function rangeAt(c5, i, bars) {
  if (i < bars) return null;
  let hi = -Infinity;
  let lo = Infinity;
  let vol = 0;
  for (let j = i - bars; j < i; j++) {
    hi = Math.max(hi, c5[j].high);
    lo = Math.min(lo, c5[j].low);
    vol += c5[j].volume;
  }
  return { hi, lo, avgVol: vol / bars };
}

/** c5: 5-minute candles up to the end of `day` (a few days, so a 10:00 range is complete). c1Day: that day's 1-minute candles. */
export function runRangeBreakout({ c5, c1Day, day, params = {}, at = null }) {
  const P = { ...RANGE_DEFAULTS, ...params };
  const bars = Math.max(2, Math.round(Number(P.bars) || 8));
  const today = c5.map((c, i) => [c, i]).filter(([c]) => istDate(c.time * 1000) === day);
  if (!today.length) return { status: 'waiting', note: 'no candles that day (holiday?)' };

  let i = -1;
  let rg = null;
  let side = null;
  const check = (k) => {
    const r = rangeAt(c5, k, bars);
    if (!r || !(r.hi / r.lo < 1 + P.rangePct / 100)) return null;
    const c = c5[k];
    if (!(c.volume > P.volMult * r.avgVol)) return null;
    if (c.close > r.hi) return [r, 'long'];
    if (c.close < r.lo) return [r, 'short'];
    return null;
  };
  if (at) {
    const hit = today.find(([c]) => istHHMM(c.time) === at);
    if (!hit) return { status: 'waiting', note: `no ${at} candle` };
    i = hit[1];
    rg = rangeAt(c5, i, bars);
    if (!rg) return { status: 'waiting', note: 'not enough candles before it' };
    side = c5[i].close > rg.hi ? 'long' : c5[i].close < rg.lo ? 'short' : null;
    if (!side) return { status: 'no-breakout', breakAt: at, rangeHi: r2(rg.hi), rangeLo: r2(rg.lo), note: `closed inside the ${bars}-candle range — the scan's range length differs from this setting` };
  } else {
    for (const [c, k] of today) {
      const t = istHHMM(c.time);
      if (t < P.from || t > P.to) continue;
      const got = check(k);
      if (got) {
        [rg, side] = got;
        i = k;
        break;
      }
    }
    if (i < 0) return { status: 'no-breakout', note: `no ${bars}-candle range within ${P.rangePct}% broken on ${P.volMult}× volume between ${P.from} and ${P.to}` };
  }

  const b = c5[i];
  const short = side === 'short';
  const dir = short ? -1 : 1; // profit = dir × (exit − entry)
  const base = {
    side,
    breakAt: istHHMM(b.time),
    rangeHi: r2(rg.hi),
    rangeLo: r2(rg.lo),
    rangePct: r2((rg.hi / rg.lo - 1) * 100),
    volX: r2(b.volume / rg.avgVol),
    breakClose: r2(b.close),
  };
  const mins = c1Day.filter((c) => c.time >= b.time + FIVE && istHHMM(c.time) < P.exitBy);
  if (!mins.length) return { ...base, status: 'no-entry', note: `breakout after ${P.exitBy}` };
  const entry = r2(mins[0].open);
  const sl = r2(P.stop === 'mid' ? (rg.hi + rg.lo) / 2 : P.stop === 'candle' ? (short ? b.high : b.low) : short ? rg.hi : rg.lo);
  const risk = dir * (entry - sl);
  if (!(risk > 0)) return { ...base, entry, sl, status: 'invalid', note: 'the next minute opened beyond the stop' };

  const targets = { t1: entry * (1 + dir * 0.01), twoR: entry + dir * 2 * risk, threeR: entry + dir * 3 * risk, hold: null };
  const out = { ...base, status: 'entered', entry, sl, entryAt: istHHMM(mins[0].time), riskPct: r2((risk / entry) * 100) };
  const done = {};
  let best = 0;
  const hitStop = (c) => (short ? c.high >= sl : c.low <= sl);
  const reached = (c, t) => (short ? c.low <= t : c.high >= t);
  for (let j = 0; j < mins.length; j++) {
    const c = mins[j];
    const stop = hitStop(c); // stop first when both happen in the same minute (conservative)
    for (const [key, tgt] of Object.entries(targets)) {
      if (done[key]) continue;
      if (stop) done[key] = { px: dir * (sl - c.open) > 0 ? c.open : sl, at: istHHMM(c.time), how: 'stop' };
      else if (tgt != null && reached(c, tgt)) done[key] = { px: dir * (c.open - tgt) > 0 ? c.open : tgt, at: istHHMM(c.time), how: 'target' };
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
