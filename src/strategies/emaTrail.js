// Strategy: Buy on the scan hit, ride it while price holds above the 9 EMA (long).
//   Entry:  at the close of the scan's hit candle (= the next minute's open) — the moment a
//           live scan would alert. The hit time comes from the CSV (Chartink "9:40 am" = the
//           09:40 candle) or from My scanner.
//   Exits scored side by side, on `tf`-minute candles (5 by default) and the 9 EMA:
//     close  — the first close below the 9 EMA
//     sharp  — the first close more than sharpPct % below the 9 EMA ("sharply below")
//     two    — two closes in a row below the 9 EMA
//     hold   — kept to 15:15
//   Exits on a close happen at that candle's close. Everything is sold by 15:15.
//   Planned exit: every exit also sells at +targetPct % (1.5 by default) if price gets there
//   first — a limit order, filled at the target (at the open if a candle opens above it).
//   Optional protective stop at the hit candle's low (stop: 'candle'); with no stop, 1R = 1 %.
// Pure functions — used by the history server, Vercel's backtest and the page.
import { istDate, istHHMM } from '../emasetup.js';

export const TRAIL_DEFAULTS = {
  tf: 5, // candle minutes for the 9 EMA and the hit candle
  ema: 9,
  sharpPct: 0.5, // "sharply below" = close more than this % under the EMA
  stop: 'none', // 'none' | 'candle' (hit candle's low)
  targetPct: 1.5, // planned exit: sell at +this % if it comes before the EMA exit (0 = no target)
  exitBy: '15:15',
};

export const TRAIL_EXITS = [
  ['close', 'Close below 9 EMA', 'first candle close below the 9 EMA'],
  ['sharp', 'Sharp close below', 'first close more than the set % below the 9 EMA'],
  ['two', '2 closes below', 'two candle closes in a row below the 9 EMA'],
  ['hold', 'Hold to 15:15', 'no EMA exit'],
];

const r2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
const OPEN_MIN = 9 * 60 + 15;
const minOf = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

/** 1-minute candles → tf-minute candles aligned to 09:15 (each candle's time = its start). */
export function toTf(c1, tf) {
  const out = [];
  let cur = null;
  let key = null;
  for (const c of c1) {
    const hhmm = istHHMM(c.time);
    if (hhmm < '09:15' || hhmm >= '15:30') continue;
    const m = minOf(hhmm);
    const bucket = Math.floor((m - OPEN_MIN) / tf);
    const k = `${istDate(c.time * 1000)}|${bucket}`;
    if (k !== key) {
      if (cur) out.push(cur);
      key = k;
      cur = { time: c.time - (m - OPEN_MIN - bucket * tf) * 60, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0 };
    } else {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
      cur.volume += c.volume || 0;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function emaOf(x, n) {
  const out = new Array(x.length).fill(null);
  if (x.length < n) return out;
  let e = 0;
  for (let i = 0; i < n; i++) e += x[i] / n;
  out[n - 1] = e;
  const k = 2 / (n + 1);
  for (let i = n; i < x.length; i++) out[i] = e = x[i] * k + e * (1 - k);
  return out;
}

/** c1: 1-minute candles of the last few days up to the end of `day`; at: the hit candle's start "HH:MM". */
export function runEmaTrail({ c1, day, params = {}, at = null }) {
  const P = { ...TRAIL_DEFAULTS, ...params };
  const tf = [1, 2, 3, 5, 10, 15].includes(Number(P.tf)) ? Number(P.tf) : 5;
  if (!at) return { status: 'waiting', note: 'no hit time — needs a CSV with times (e.g. 9:40 am) or My scanner' };
  const cs = toTf(c1, tf);
  const e = emaOf(cs.map((c) => c.close), Math.round(P.ema));
  // the tf candle that contains the hit time (a 5-min hit on a 2-min chart lands inside one)
  const atMin = minOf(at);
  const hi = cs.findIndex((c) => istDate(c.time * 1000) === day && minOf(istHHMM(c.time)) <= atMin && atMin < minOf(istHHMM(c.time)) + tf);
  if (hi < 0) return { status: 'waiting', note: `no ${at} candle that day (holiday or not traded?)` };
  const hit = cs[hi];
  // buy at the next minute's open after the scan candle closes (scan candles are 5 min unless the CSV says otherwise)
  const buyAfter = Date.parse(`${day}T${at}:00+05:30`) / 1000 + 5 * 60;
  const dayMins = c1.filter((c) => istDate(c.time * 1000) === day);
  const first = dayMins.find((c) => c.time >= buyAfter);
  if (!first || istHHMM(first.time) >= P.exitBy) return { status: 'no-entry', note: `hit after ${P.exitBy}` };
  const entry = r2(first.open);
  const sl = P.stop === 'candle' ? r2(hit.low) : null;
  const risk = sl != null && entry - sl > 0 ? entry - sl : entry * 0.01;
  const out = { status: 'entered', hitAt: at, entry, entryAt: istHHMM(first.time), sl, ema0: r2(e[hi]), above: e[hi] != null ? r2((entry / e[hi] - 1) * 100) : null, riskPct: r2((risk / entry) * 100) };

  // walk tf candles that close after the entry
  const done = {};
  let below = 0;
  let best = 0;
  let last = null;
  const sharp = 1 - P.sharpPct / 100;
  const tgt = Number(P.targetPct) > 0 ? entry * (1 + Number(P.targetPct) / 100) : null;
  out.target = r2(tgt);
  for (let i = hi; i < cs.length; i++) {
    const c = cs[i];
    if (istDate(c.time * 1000) !== day) break;
    const endT = c.time + tf * 60;
    if (endT <= first.time) continue; // closed before we bought
    const t = istHHMM(c.time);
    if (t >= P.exitBy || endT > Date.parse(`${day}T${P.exitBy}:00+05:30`) / 1000) break;
    last = c;
    const stop = sl != null && c.low <= sl;
    const isBelow = e[i] != null && c.close < e[i];
    below = isBelow ? below + 1 : 0;
    const closeT = istHHMM(endT);
    for (const k of ['close', 'sharp', 'two', 'hold']) {
      if (done[k]) continue;
      if (stop) done[k] = { px: c.open < sl && c.time > first.time ? c.open : sl, at: t, how: 'stop' };
      // the high comes before this candle's close, so a target touched in it beats a close-based exit
      else if (tgt != null && c.high >= tgt) done[k] = { px: c.open > tgt && c.time > first.time ? c.open : tgt, at: t, how: 'target' };
      else if ((k === 'close' && isBelow) || (k === 'sharp' && e[i] != null && c.close < e[i] * sharp) || (k === 'two' && below >= 2)) done[k] = { px: c.close, at: closeT, how: k === 'close' ? 'below 9 EMA' : k === 'sharp' ? 'sharp drop' : '2 closes below' };
    }
    if (!stop) best = Math.max(best, c.high - entry);
    if (Object.keys(done).length === 4) break;
  }
  // sold at 15:15: last full candle's close, or the last minute before 15:15
  const lastMin = [...dayMins].reverse().find((c) => istHHMM(c.time) < P.exitBy);
  const endPx = lastMin ? lastMin.close : last ? last.close : entry;
  for (const k of ['close', 'sharp', 'two', 'hold']) {
    const d = done[k] || { px: endPx, at: P.exitBy, how: 'time' };
    out[k] = { ...d, px: r2(d.px), r: r2((d.px - entry) / risk), pct: r2(((d.px - entry) / entry) * 100) };
  }
  out.bestR = r2(best / risk);
  out.bestPct = r2((best / entry) * 100);
  return out;
}
