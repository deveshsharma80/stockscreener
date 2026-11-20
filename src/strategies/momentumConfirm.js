// Strategy: Momentum confirmation (long).
//   Hit:      the scan's first hit of the day for the stock between `from` and `to` (09:45–12:00
//             by default; Chartink "10:40 am" = the 10:40 candle, 5 minutes by default).
//   Confirm:  the very next candle is green (close > open) and closes above the hit candle's
//             close → buy at once: at the next minute's open after that candle closes.
//             Otherwise no trade for that stock that day.
//   Stop:     the confirmation candle's low (default), the hit candle's low, or a fixed %.
//   Exits scored side by side (each also has the stop; everything sold by 15:15):
//     t1     — 1 % target
//     r2     — 1:2 (target = 2 × risk)
//     ema9   — first candle close below the 9 EMA (ride the move)
//     hold   — stop only, sold at 15:15
//   Stop is checked before a target in the same minute (the cautious choice).
// Pure functions — used by Vercel's backtest and the page.
import { istDate, istHHMM } from '../emasetup.js';

export const CONFIRM_DEFAULTS = {
  tf: 5, // candle minutes (the scan's timeframe)
  from: '09:45', // first hit counted from …
  to: '12:00', // … until (hit candle start)
  stop: 'confirm', // 'confirm' = confirmation candle low · 'hit' = hit candle low · 'pct' = stopPct % below the entry
  stopPct: 1,
  lastEntry: '15:00',
  exitBy: '15:15',
};

export const CONFIRM_EXITS = [
  ['t1', 'Target 1%', '1 % above the entry'],
  ['r2', 'Fixed 1:2', 'target = 2 × risk'],
  ['ema9', 'Close below 9 EMA', 'first candle close below the 9 EMA'],
  ['hold', 'Hold to 15:15', 'stop only, sold at 15:15'],
];

const r2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
const OPEN_MIN = 9 * 60 + 15;
const minOf = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

function toTf(c1, tf) {
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
      cur = { time: c.time - (m - OPEN_MIN - bucket * tf) * 60, open: c.open, high: c.high, low: c.low, close: c.close };
    } else {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
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
export function runMomentumConfirm({ c1, day, params = {}, at = null }) {
  const P = { ...CONFIRM_DEFAULTS, ...params };
  const tf = [1, 2, 3, 5, 10, 15].includes(Number(P.tf)) ? Number(P.tf) : 5;
  if (!at) return { status: 'waiting', note: 'no hit time — needs a CSV with times (e.g. 10:40 am)' };
  if (at < P.from || at > P.to) return { status: 'outside', hitAt: at, note: `hit at ${at} — outside ${P.from}–${P.to}` };
  const cs = toTf(c1, tf);
  const e9 = emaOf(cs.map((c) => c.close), 9);
  const atMin = minOf(at);
  const hi = cs.findIndex((c) => istDate(c.time * 1000) === day && minOf(istHHMM(c.time)) <= atMin && atMin < minOf(istHHMM(c.time)) + tf);
  if (hi < 0) return { status: 'waiting', note: `no ${at} candle that day (holiday or not traded?)` };
  const hit = cs[hi];
  const conf = cs[hi + 1];
  const base = { hitAt: istHHMM(hit.time), hitClose: r2(hit.close) };
  if (!conf || istDate(conf.time * 1000) !== day) return { ...base, status: 'no-confirm', note: 'no next candle that day' };
  const confAt = istHHMM(conf.time);
  Object.assign(base, { confAt, confOpen: r2(conf.open), confClose: r2(conf.close), confLow: r2(conf.low) });
  if (!(conf.close > conf.open)) return { ...base, status: 'no-confirm', note: `the ${confAt} candle was red` };
  if (!(conf.close > hit.close)) return { ...base, status: 'no-confirm', note: `the ${confAt} candle closed at ${r2(conf.close)}, not above ${r2(hit.close)}` };

  const buyAfter = conf.time + tf * 60;
  const exitBySec = Date.parse(`${day}T${P.exitBy}:00+05:30`) / 1000;
  const mins = c1.filter((c) => c.time >= buyAfter && c.time < exitBySec && istDate(c.time * 1000) === day);
  if (!mins.length || istHHMM(mins[0].time) >= P.lastEntry) return { ...base, status: 'no-entry', note: `confirmed after ${P.lastEntry}` };
  const entry = r2(mins[0].open);
  const sl = r2(P.stop === 'hit' ? hit.low : P.stop === 'pct' ? entry * (1 - (Number(P.stopPct) || 1) / 100) : conf.low);
  const risk = entry - sl;
  if (!(risk > 0)) return { ...base, entry, sl, status: 'invalid', note: 'opened at or below the stop' };
  const out = { ...base, status: 'entered', entry, entryAt: istHHMM(mins[0].time), sl, riskPct: r2((risk / entry) * 100) };

  const targets = { t1: entry * 1.01, r2: entry + 2 * risk, ema9: null, hold: null };
  const done = {};
  let best = 0;
  // 9 EMA exit: on each candle close after the entry
  const closeBelow = new Map(); // minute time of the candle's last minute → close price
  for (let i = hi + 2; i < cs.length && istDate(cs[i].time * 1000) === day; i++) {
    if (e9[i] != null && cs[i].close < e9[i]) closeBelow.set(cs[i].time + (tf - 1) * 60, cs[i].close);
  }
  for (let j = 0; j < mins.length; j++) {
    const m = mins[j];
    const t = istHHMM(m.time);
    const stop = m.low <= sl;
    for (const key of Object.keys(targets)) {
      if (done[key]) continue;
      const tgt = targets[key];
      if (stop) done[key] = { px: j > 0 && m.open < sl ? m.open : sl, at: t, how: 'stop' };
      else if (tgt != null && m.high >= tgt) done[key] = { px: j > 0 && m.open > tgt ? m.open : tgt, at: t, how: 'target' };
      else if (key === 'ema9' && closeBelow.has(m.time)) done[key] = { px: m.close, at: istHHMM(m.time + 60), how: 'below 9 EMA' };
    }
    if (!stop) best = Math.max(best, m.high - entry);
    if (Object.keys(done).length === 4) break;
  }
  const last = mins[mins.length - 1];
  for (const key of Object.keys(targets)) {
    const d = done[key] || { px: last.close, at: P.exitBy, how: 'time' };
    out[key] = { ...d, px: r2(d.px), r: r2((d.px - entry) / risk), pct: r2(((d.px - entry) / entry) * 100) };
  }
  out.bestR = r2(best / risk);
  out.bestPct = r2((best / entry) * 100);
  return out;
}
