// Strategy: Overextension short. A scan hit = a candle that closed far above its upper
// Bollinger band (e.g. close > UpperBB(30) × 1.03). Bet on a snap back to the 9 EMA.
// Entry (entryMode):
//   now          — short at once, at the next minute's open after the hit candle closes
//   nextRed      — only if the very next candle closes red; short right after it closes
//   nextRedBelow — the next candle closes red AND below the hit candle's close
//   firstRed     — wait up to `within` candles for the first red candle; short after it closes
//   breakLow     — wait up to `within` candles for price to fall below the hit candle's low;
//                  short there (at the open if a minute opens below it)
// Stop 'high' = the highest high from the hit candle up to the entry (the spike's top).
//   Exits scored side by side (each also takes the stop, if one is set; all covered by 15:15):
//     ema9   — cover when price touches the 9 EMA (of the candles, as of the last closed one)
//     t1     — 1 % fall
//     t2     — 2 % fall
//     hold   — covered at 15:15
//   Stop: none (default), the hit candle's high, or a fixed % above the entry. With no stop 1R = 1 %.
//   Also reported: the worst move against the short before 15:15, and the distance from the
//   entry to the 9 EMA at entry.
// The hit time must be the start of a tf-minute candle (09:15 + n × tf), as the scan reports it.
// Pure functions — used by Vercel's backtest and the page.
import { istDate, istHHMM } from '../emasetup.js';

export const OVEREXT_DEFAULTS = {
  tf: 5, // candle minutes (the scan's timeframe)
  from: '09:30', // first hit counted from …
  to: '14:30', // … until (hit candle start)
  entryMode: 'now', // 'now' · 'nextRed' · 'nextRedBelow' · 'firstRed' · 'breakLow'
  within: 6, // candles to wait ('firstRed', 'breakLow')
  stop: 'none', // 'none' · 'high' = spike's high (hit candle → entry) · 'pct' = stopPct % above the entry
  stopPct: 1,
  lastEntry: '15:00',
  exitBy: '15:15',
};

export const OVEREXT_EXITS = [
  ['ema9', 'Back to 9 EMA', 'cover when price touches the 9 EMA'],
  ['t1', 'Target 1%', '1 % fall'],
  ['t2', 'Target 2%', '2 % fall'],
  ['hold', 'Cover at 15:15', 'no target'],
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
export function runOverextShort({ c1, day, params = {}, at = null }) {
  const P = { ...OVEREXT_DEFAULTS, ...params };
  const tf = [1, 2, 3, 5, 10, 15].includes(Number(P.tf)) ? Number(P.tf) : 5;
  if (!at) return { status: 'waiting', note: 'no hit time — needs a CSV with times (e.g. 10:40 am)' };
  if (at < P.from || at > P.to) return { status: 'outside', hitAt: at, note: `hit at ${at} — outside ${P.from}–${P.to}` };
  if ((minOf(at) - OPEN_MIN) % tf !== 0) return { status: 'misaligned', hitAt: at, note: `${at} isn't the start of a ${tf}-minute candle — set the scan's timeframe to ${tf} minutes or pick the CSV's candle size` };
  const cs = toTf(c1, tf);
  const e9 = emaOf(cs.map((c) => c.close), 9);
  const hi = cs.findIndex((c) => istDate(c.time * 1000) === day && istHHMM(c.time) === at);
  if (hi < 0) return { status: 'waiting', note: `no ${at} candle that day (holiday or not traded?)` };
  const hit = cs[hi];
  const base = { hitAt: at, hitClose: r2(hit.close), hitHigh: r2(hit.high) };
  const exitBySec = Date.parse(`${day}T${P.exitBy}:00+05:30`) / 1000;
  const dayMins = (fromSec) => c1.filter((c) => c.time >= fromSec && c.time < exitBySec && istDate(c.time * 1000) === day);
  const sameDay = (i) => i < cs.length && istDate(cs[i].time * 1000) === day;
  const mode = P.entryMode || 'now';
  const n = Math.max(1, Math.round(Number(P.within) || 6));
  let mins;
  let entry;
  let topIdx = hi; // last candle whose high counts toward the 'high' stop
  let waitNote = null;
  if (mode === 'now') {
    mins = dayMins(hit.time + tf * 60);
  } else if (mode === 'nextRed' || mode === 'nextRedBelow') {
    const nx = cs[hi + 1];
    if (!sameDay(hi + 1)) return { ...base, status: 'no-entry', note: 'no next candle that day' };
    if (!(nx.close < nx.open)) return { ...base, status: 'skipped', note: `the ${istHHMM(nx.time)} candle was ${nx.close > nx.open ? 'green' : 'flat'} — still going up` };
    if (mode === 'nextRedBelow' && !(nx.close < hit.close)) return { ...base, status: 'skipped', note: `the ${istHHMM(nx.time)} candle was red but closed at ${r2(nx.close)}, not below ${r2(hit.close)}` };
    topIdx = hi + 1;
    waitNote = istHHMM(nx.time);
    mins = dayMins(nx.time + tf * 60);
  } else if (mode === 'firstRed') {
    let j = -1;
    for (let i = hi + 1; i <= hi + n && sameDay(i); i++) if (cs[i].close < cs[i].open) { j = i; break; }
    if (j < 0) return { ...base, status: 'skipped', note: `no red candle within ${n} candles — kept going up` };
    topIdx = j;
    waitNote = istHHMM(cs[j].time);
    mins = dayMins(cs[j].time + tf * 60);
  } else if (mode === 'breakLow') {
    const all = dayMins(hit.time + tf * 60);
    const until = hit.time + tf * 60 + n * tf * 60;
    const k = all.findIndex((c) => c.time < until && c.low < hit.low);
    if (k < 0) return { ...base, status: 'skipped', note: `didn’t fall below the ${at} low (${r2(hit.low)}) within ${n} candles` };
    mins = all.slice(k);
    entry = r2(Math.min(hit.low, mins[0].open));
    while (topIdx + 1 < cs.length && cs[topIdx + 1].time <= mins[0].time) topIdx++;
    waitNote = istHHMM(mins[0].time);
  }
  if (!mins.length || istHHMM(mins[0].time) >= P.lastEntry) return { ...base, status: 'no-entry', note: `entry after ${P.lastEntry}` };
  entry ??= r2(mins[0].open);
  let top = -Infinity;
  for (let i = hi; i <= topIdx; i++) top = Math.max(top, cs[i].high);
  if (mode === 'breakLow') top = Math.max(top, ...c1.filter((c) => c.time >= hit.time && c.time < mins[0].time).map((c) => c.high));
  const sl = P.stop === 'high' ? r2(top) : P.stop === 'pct' ? r2(entry * (1 + (Number(P.stopPct) || 1) / 100)) : null;
  if (sl != null && !(sl > entry)) return { ...base, entry, sl, status: 'invalid', note: 'entry at or above the stop' };
  const risk = sl != null ? sl - entry : entry * 0.01;
  // 9 EMA level during each minute = the EMA of the last tf candle closed before that minute
  const emaAt = (sec) => {
    let j = hi;
    while (j + 1 < cs.length && cs[j + 1].time + tf * 60 <= sec) j++;
    return e9[j];
  };
  const out = { ...base, status: 'entered', mode, signalAt: waitNote, entry, entryAt: istHHMM(mins[0].time), sl, ema0: r2(e9[hi]), toEmaPct: e9[hi] != null ? r2((entry / e9[hi] - 1) * 100) : null, riskPct: r2((risk / entry) * 100) };
  const done = {};
  let worst = 0;
  let best = 0;
  for (let j = 0; j < mins.length; j++) {
    const m = mins[j];
    const t = istHHMM(m.time);
    if (!(mode === 'breakLow' && j === 0)) worst = Math.max(worst, m.high - entry);
    const stop = sl != null && m.high >= sl && !(mode === 'breakLow' && j === 0);
    const lvl = emaAt(m.time);
    const tg = { ema9: lvl, t1: entry * 0.99, t2: entry * 0.98, hold: null };
    for (const key of Object.keys(tg)) {
      if (done[key]) continue;
      const tgt = tg[key];
      if (stop) done[key] = { px: j > 0 && m.open > sl ? m.open : sl, at: t, how: 'stop' };
      else if (tgt != null && tgt < entry && m.low <= tgt) done[key] = { px: j > 0 && m.open < tgt ? m.open : tgt, at: t, how: key === 'ema9' ? 'at 9 EMA' : 'target' };
    }
    if (!stop) best = Math.max(best, entry - m.low);
    if (Object.keys(done).length === 4) break;
  }
  const last = mins[mins.length - 1];
  for (const key of ['ema9', 't1', 't2', 'hold']) {
    const d = done[key] || { px: last.close, at: P.exitBy, how: 'time' };
    out[key] = { ...d, px: r2(d.px), r: r2((entry - d.px) / risk), pct: r2(((entry - d.px) / entry) * 100) };
  }
  out.worstPct = r2((worst / entry) * 100);
  out.bestR = r2(best / risk);
  out.bestPct = r2((best / entry) * 100);
  return out;
}
