// Strategy: Momentum pullback (long), on 2-minute candles.
//   Setup:   a green 2-minute candle of more than bigPct % (close ÷ open), e.g. +4 %.
//   Support: price later pulls back to the 2-minute 9 EMA (a candle's low within touchTol %
//            of it). Cancelled if a candle closes below the big candle's middle first.
//   Entry:   after that touch, the first candle that trades above the day's high so far →
//            buy at the day's high (at the open if it gaps over). Not after entryBy.
//   Stop:    the lowest low of the pullback (from the touch to the candle before entry).
//   Exits scored side by side (each also has the stop and closes at 15:15 at the latest):
//     either — your rule: a 2-minute close below the 9 EMA, or the 5 EMA crossing below the 9
//     ema9   — only the close below the 9 EMA
//     cross  — only the 5 / 9 EMA cross
//     hold   — stop only, sold at 15:15
//   Exits on a close happen at that candle's close.
// With `at` (Back Test → My scanner: the scan's hit time, a 2-minute candle) that candle is
// the big candle; without it (Chartink CSV) the first big candle between `from` and `to`.
// EMAs run over the 2-minute closes of the last few days, like a chart.
// Pure functions — used by the history server, Vercel's backtest and the page.
import { istDate, istHHMM } from '../emasetup.js';

export const MOMENTUM_DEFAULTS = {
  bigPct: 4, // big candle: close ÷ open − 1 above this %
  fast: 5,
  slow: 9,
  touchTol: 0.2, // a low within this % above the 9 EMA counts as a touch
  entryBy: '14:30', // no entries after this
  from: '09:15', // big candle from (CSV source only)
  to: '13:00', // big candle until (CSV source only)
  exitBy: '15:15',
};

export const MOMENTUM_EXITS = [
  ['either', '9 EMA or 5/9 cross', 'your rule: first 2-min close below the 9 EMA or 5 EMA crossing below the 9 EMA'],
  ['ema9', 'Close below 9 EMA', 'only a 2-min close below the 9 EMA'],
  ['cross', '5/9 cross', 'only the 5 EMA crossing below the 9 EMA'],
  ['hold', 'Hold to 15:15', 'stop only, sold at 15:15'],
];

const r2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
const OPEN_MIN = 9 * 60 + 15;

/** 1-minute candles {time, open, high, low, close, volume} → 2-minute candles aligned to 09:15. */
export function to2m(c1) {
  const out = [];
  let cur = null;
  let key = null;
  for (const c of c1) {
    const hhmm = istHHMM(c.time);
    if (hhmm < '09:15' || hhmm >= '15:30') continue;
    const m = Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
    const bucket = Math.floor((m - OPEN_MIN) / 2);
    const k = `${istDate(c.time * 1000)}|${bucket}`;
    if (k !== key) {
      if (cur) out.push(cur);
      key = k;
      cur = { time: c.time - (m - OPEN_MIN - bucket * 2) * 60, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0 };
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
  let s = 0;
  for (let i = 0; i < n; i++) s += x[i];
  let e = s / n;
  out[n - 1] = e;
  const k = 2 / (n + 1);
  for (let i = n; i < x.length; i++) out[i] = e = x[i] * k + e * (1 - k);
  return out;
}

/** c1: 1-minute candles of the last few days up to the end of `day`. */
export function runMomentumPullback({ c1, day, params = {}, at = null }) {
  const P = { ...MOMENTUM_DEFAULTS, ...params };
  const c2 = to2m(c1);
  const closes = c2.map((c) => c.close);
  const eF = emaOf(closes, Math.round(P.fast));
  const eS = emaOf(closes, Math.round(P.slow));
  const first = c2.findIndex((c) => istDate(c.time * 1000) === day);
  if (first < 0) return { status: 'waiting', note: 'no candles that day (holiday?)' };
  let last = first;
  while (last + 1 < c2.length && istDate(c2[last + 1].time * 1000) === day) last++;
  const pct = (c) => (c.close / c.open - 1) * 100;

  // 1. the big candle
  let b = -1;
  if (at) {
    for (let i = first; i <= last; i++) if (istHHMM(c2[i].time) === at) b = i;
    if (b < 0) return { status: 'waiting', note: `no ${at} 2-minute candle` };
    if (!(pct(c2[b]) > P.bigPct)) return { status: 'no-setup', bigAt: at, bigPct: r2(pct(c2[b])), note: `the ${at} 2-minute candle is ${r2(pct(c2[b]))}%, not above ${P.bigPct}% — is the scan on 2-minute candles?` };
  } else {
    for (let i = first; i <= last; i++) {
      const t = istHHMM(c2[i].time);
      if (t >= P.from && t <= P.to && pct(c2[i]) > P.bigPct) {
        b = i;
        break;
      }
    }
    if (b < 0) return { status: 'no-setup', note: `no 2-minute candle above ${P.bigPct}% between ${P.from} and ${P.to}` };
  }
  const big = c2[b];
  const mid = (big.open + big.close) / 2;
  let dayHigh = -Infinity;
  for (let i = first; i <= b; i++) dayHigh = Math.max(dayHigh, c2[i].high);
  const base = { bigAt: istHHMM(big.time), bigPct: r2(pct(big)), bigOpen: r2(big.open), bigClose: r2(big.close) };

  // 2. pullback to the 9 EMA, 3. break of the day's high
  let touch = -1;
  let pullLow = Infinity;
  let entryI = -1;
  let entry = null;
  for (let i = b + 1; i <= last; i++) {
    const c = c2[i];
    const t = istHHMM(c.time);
    if (t >= P.exitBy) break;
    if (touch < 0) {
      if (eS[i] != null && c.low <= eS[i] * (1 + P.touchTol / 100)) {
        touch = i;
        pullLow = c.low;
      } else if (c.close < mid) return { ...base, status: 'failed', note: `closed below the big candle's middle (${r2(mid)}) at ${t} before reaching the 9 EMA` };
      dayHigh = Math.max(dayHigh, c.high);
      continue;
    }
    if (c.high > dayHigh && t < P.entryBy) {
      entryI = i;
      entry = Math.max(dayHigh, c.open);
      break;
    }
    if (t >= P.entryBy) break;
    pullLow = Math.min(pullLow, c.low);
    dayHigh = Math.max(dayHigh, c.high);
  }
  if (touch < 0) return { ...base, status: 'no-touch', note: `never pulled back to the 2-minute ${P.slow} EMA` };
  base.touchAt = istHHMM(c2[touch].time);
  base.dayHigh = r2(dayHigh);
  if (entryI < 0) return { ...base, status: 'no-entry', note: `day high ${r2(dayHigh)} not crossed after the pullback before ${P.entryBy}` };
  entry = r2(entry);
  const sl = r2(pullLow);
  const risk = entry - sl;
  if (!(risk > 0)) return { ...base, status: 'invalid', note: 'stop at or above the entry' };
  const out = { ...base, status: 'entered', entry, sl, entryAt: istHHMM(c2[entryI].time), riskPct: r2((risk / entry) * 100) };

  // 4. exits, candle by candle from the entry candle
  const done = {};
  let best = 0;
  let lastI = entryI;
  for (let i = entryI; i <= last; i++) {
    const c = c2[i];
    const t = istHHMM(c.time);
    if (t >= P.exitBy) break;
    lastI = i;
    const stop = c.low <= sl;
    const below9 = i > entryI && eS[i] != null && c.close < eS[i];
    const crossed = i > entryI && eF[i] != null && eS[i] != null && eF[i - 1] != null && eS[i - 1] != null && eF[i] < eS[i] && eF[i - 1] >= eS[i - 1];
    for (const k of ['either', 'ema9', 'cross', 'hold']) {
      if (done[k]) continue;
      if (stop) done[k] = { px: i > entryI && c.open < sl ? c.open : sl, at: t, how: 'stop' };
      else if ((k === 'either' && (below9 || crossed)) || (k === 'ema9' && below9) || (k === 'cross' && crossed)) done[k] = { px: c.close, at: t, how: k === 'either' ? (below9 ? 'below 9 EMA' : '5/9 cross') : k === 'ema9' ? 'below 9 EMA' : '5/9 cross' };
    }
    if (!stop) best = Math.max(best, c.high - entry);
    if (Object.keys(done).length === 4) break;
  }
  const end = c2[lastI];
  for (const k of ['either', 'ema9', 'cross', 'hold']) {
    const d = done[k] || { px: end.close, at: istHHMM(end.time), how: 'time' };
    out[k] = { ...d, px: r2(d.px), r: r2((d.px - entry) / risk), pct: r2(((d.px - entry) / entry) * 100) };
  }
  out.bestR = r2(best / risk);
  out.bestPct = r2((best / entry) * 100);
  return out;
}
