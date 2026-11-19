// Strategy: Big candle half eaten (short, intraday).
//   Setup:  a green daily candle whose close is at least bigPct % above its open (Chartink
//           daily scan → the CSV's date is the big candle's day).
//   Trigger: on a later day (within waitDays trading days), price falls to the middle of that
//           candle's body ((open + close) ÷ 2) → sell short there (at the open if the day
//           opens below it). Not after lastEntry; once the middle is reached the setup is used,
//           whether it was traded or not.
//   Exits scored side by side (no stop loss — your rule):
//     hold   — covered at 15:15 the same day (cash intraday short)
//     t2     — 2 % target, else 15:15
//     t5     — 5 % target, else 15:15
//     next   — held to the next trading day's 15:15 (needs stock futures; for comparison)
//   Also: the worst move against the short before 15:15 (what a stop would have faced).
//   With no stop, 1R = 1 %.
// The big day's open / close come from Dhan's 1-minute candles (09:15 open, last close), so
// they can differ a little from the official close Chartink uses.
// Pure functions — used by Vercel's backtest and the page.
import { istDate, istHHMM } from '../emasetup.js';

export const HALF_DEFAULTS = {
  bigPct: 14, // the big candle: close ≥ open × (1 + bigPct %) — rows below this are skipped
  waitDays: 10, // trading days after the big day to wait for the middle
  lastEntry: '15:00',
  exitBy: '15:15',
};

export const HALF_EXITS = [
  ['hold', 'Cover at 15:15', 'short at the middle, covered the same day at 15:15'],
  ['t2', 'Target 2%', '2 % fall, else covered at 15:15'],
  ['t5', 'Target 5%', '5 % fall, else covered at 15:15'],
  ['next', 'Hold to next day', 'kept overnight, covered at the next day’s 15:15 (stock futures only)'],
];

const r2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);

/** c1: 1-minute candles from the big day to a few weeks after it. day: the big candle's day. */
export function runHalfEaten({ c1, day, params = {} }) {
  const P = { ...HALF_DEFAULTS, ...params };
  const byDay = new Map();
  for (const c of c1) {
    const t = istHHMM(c.time);
    if (t < '09:15' || t >= '15:30') continue;
    const d = istDate(c.time * 1000);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(c);
  }
  const big = byDay.get(day);
  if (!big?.length) return { status: 'waiting', note: 'no candles on the big day (holiday, or not traded?)' };
  const open = big[0].open;
  const close = big[big.length - 1].close;
  const bodyPct = (close / open - 1) * 100;
  const mid = (open + close) / 2;
  const base = { bigOpen: r2(open), bigClose: r2(close), bodyPct: r2(bodyPct), mid: r2(mid) };
  if (!(bodyPct >= P.bigPct)) return { ...base, status: 'no-setup', note: `body ${r2(bodyPct)}% on Dhan’s candles — below ${P.bigPct}%` };

  const after = [...byDay.keys()].filter((d) => d > day).sort();
  const days = after.slice(0, Math.max(1, Math.round(P.waitDays)));
  for (let k = 0; k < days.length; k++) {
    const d = days[k];
    const mins = byDay.get(d);
    const i = mins.findIndex((c) => c.low <= mid);
    if (i < 0) continue;
    const c = mins[i];
    const t = istHHMM(c.time);
    const out = { ...base, daysAfter: k + 1, triggerDay: d, gapBelow: i === 0 && c.open <= mid };
    if (t >= P.lastEntry) return { ...out, status: 'late', note: `the middle was reached at ${t} on ${d} — after ${P.lastEntry}` };
    const entry = r2(c.open <= mid ? c.open : mid);
    const rest = mins.slice(i).filter((m) => istHHMM(m.time) < P.exitBy);
    const last = rest[rest.length - 1] || c;
    // worst move against the short (from the entry minute on, so the fill minute's high counts only after it)
    let worst = 0;
    let best = 0;
    for (let j = 0; j < rest.length; j++) {
      const m = rest[j];
      if (j > 0) worst = Math.max(worst, m.high - entry);
      best = Math.max(best, entry - m.low);
    }
    const pct = (px) => r2(((entry - px) / entry) * 100);
    const res = { ...out, status: 'entered', entry, entryAt: t };
    for (const [key, tgtPct] of [['hold', null], ['t2', 2], ['t5', 5]]) {
      let d0 = null;
      if (tgtPct != null) {
        const tgt = entry * (1 - tgtPct / 100);
        for (let j = 0; j < rest.length; j++) {
          const m = rest[j];
          if (m.low <= tgt) {
            d0 = { px: j > 0 && m.open < tgt ? m.open : tgt, at: istHHMM(m.time), how: 'target' };
            break;
          }
        }
      }
      d0 ||= { px: last.close, at: istHHMM(last.time), how: 'time' };
      res[key] = { ...d0, px: r2(d0.px), pct: pct(d0.px), r: pct(d0.px) };
    }
    const nd = after[after.indexOf(d) + 1];
    const nextMins = nd ? byDay.get(nd).filter((m) => istHHMM(m.time) < P.exitBy) : null;
    if (nextMins?.length) {
      const px = nextMins[nextMins.length - 1].close;
      const nextWorst = Math.max(...nextMins.map((m) => m.high)) - entry;
      res.next = { px: r2(px), at: `${nd.slice(5)} 15:15`, how: 'next day', pct: pct(px), r: pct(px) };
      res.nextWorstPct = r2((Math.max(nextWorst, 0) / entry) * 100);
    } else res.next = { ...res.hold, how: 'no next day yet' };
    res.worstPct = r2((worst / entry) * 100);
    res.bestR = r2((best / entry) * 100);
    res.bestPct = res.bestR;
    return res;
  }
  return { ...base, status: 'not-eaten', note: `didn’t fall to the middle (${r2(mid)}) within ${days.length} trading days` };
}
