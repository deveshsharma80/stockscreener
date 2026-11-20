// Strategy: Big candle half eaten (intraday) — short at the middle (default), or buy there
// (side: 'long': bet that the middle holds as support; exits mirrored).
// Trigger level (level): 'mid' = the middle of the body (default) · 'base' = basePct % below
// the big candle's open (the whole candle eaten and then some).
//   Setup:  a green daily candle whose close is at least bigPct % above its open (Chartink
//           daily scan → the CSV's date is the big candle's day).
//   Trigger: on a later day (within waitDays trading days), price falls to the middle of that
//           candle's body ((open + close) ÷ 2) → sell short there (at the open if the day
//           opens below it). Not after lastEntry; once the middle is reached the setup is used,
//           whether it was traded or not.
//   Exits scored side by side, with no stop loss (your rule) unless stopPct is set — then every
//   exit also closes at the stop (checked minute by minute, before the target):
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
  side: 'short', // 'short' = sell at the middle · 'long' = buy at the middle
  bigPct: 14, // the big candle: close ≥ open × (1 + bigPct %) — rows below this are skipped
  level: 'mid', // 'mid' = middle of the body · 'base' = basePct % below the big candle's open
  basePct: 2,
  waitDays: 10, // trading days after the big day to wait for the level
  stopPct: 0, // stop loss, % from the entry (0 = no stop — your rule)
  lastEntry: '15:00',
  exitBy: '15:15',
};

export const HALF_EXITS = [
  ['hold', 'Exit at 15:15', 'entered at the middle, closed the same day at 15:15'],
  ['t2', 'Target 2%', '2 % in your favour, else closed at 15:15'],
  ['t5', 'Target 5%', '5 % in your favour, else closed at 15:15'],
  ['next', 'Hold to next day', 'kept overnight, closed at the next day’s 15:15 (a short needs stock futures; a long is a delivery buy)'],
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
  const atBase = P.level === 'base';
  const lvl = atBase ? open * (1 - (Number(P.basePct) || 0) / 100) : mid; // the price that triggers the entry
  const lvlName = atBase ? `${Number(P.basePct) || 0}% below the open` : 'the middle';
  const base = { bigOpen: r2(open), bigClose: r2(close), bodyPct: r2(bodyPct), mid: r2(mid), level: r2(lvl), levelKind: atBase ? 'base' : 'mid' };
  if (!(bodyPct >= P.bigPct)) return { ...base, status: 'no-setup', note: `body ${r2(bodyPct)}% on Dhan’s candles — below ${P.bigPct}%` };

  const after = [...byDay.keys()].filter((d) => d > day).sort();
  const days = after.slice(0, Math.max(1, Math.round(P.waitDays)));
  for (let k = 0; k < days.length; k++) {
    const d = days[k];
    const mins = byDay.get(d);
    const i = mins.findIndex((c) => c.low <= lvl);
    if (i < 0) continue;
    const c = mins[i];
    const t = istHHMM(c.time);
    const out = { ...base, daysAfter: k + 1, triggerDay: d, gapBelow: i === 0 && c.open <= lvl };
    if (t >= P.lastEntry) return { ...out, status: 'late', note: `${lvlName} (${r2(lvl)}) was reached at ${t} on ${d} — after ${P.lastEntry}` };
    const long = P.side === 'long';
    const dir = long ? 1 : -1; // profit = dir × (exit − entry)
    // the fall reaches the middle: a short sells there, a long buys there (at the open if it opened below)
    const entry = r2(c.open <= lvl ? c.open : lvl);
    const rest = mins.slice(i).filter((m) => istHHMM(m.time) < P.exitBy);
    const last = rest[rest.length - 1] || c;
    // worst move against the short (from the entry minute on, so the fill minute's high counts only after it)
    let worst = 0;
    let best = 0;
    for (let j = 0; j < rest.length; j++) {
      const m = rest[j];
      if (j > 0) worst = Math.max(worst, long ? entry - m.low : m.high - entry);
      best = Math.max(best, long ? m.high - entry : entry - m.low);
    }
    const pct = (px) => r2(((dir * (px - entry)) / entry) * 100);
    const res = { ...out, status: 'entered', side: long ? 'long' : 'short', entry, entryAt: t };
    const stopPct = Number(P.stopPct) > 0 ? Number(P.stopPct) : null;
    const sl = stopPct != null ? entry * (1 - (dir * stopPct) / 100) : null;
    if (sl != null) res.sl = r2(sl);
    // walk minutes: stop first (checked before the target in the same minute — the cautious
    // choice), then target; otherwise the last minute's close. In the fill minute a long's stop
    // counts (its low comes after the fall to the middle) but its target doesn't; a short the reverse.
    const walk = (mins, tgtPct, endHow) => {
      const tgt = tgtPct != null ? entry * (1 + (dir * tgtPct) / 100) : null;
      for (let j = 0; j < mins.length; j++) {
        const m = mins[j];
        const first = j === 0;
        if (sl != null && (long ? m.low <= sl : !first && m.high >= sl)) return { px: !first && dir * (sl - m.open) > 0 ? m.open : sl, at: m.day ? `${m.day} ${istHHMM(m.time)}` : istHHMM(m.time), how: 'stop' };
        if (tgt != null && (long ? !first && m.high >= tgt : m.low <= tgt)) return { px: !first && dir * (m.open - tgt) > 0 ? m.open : tgt, at: m.day ? `${m.day} ${istHHMM(m.time)}` : istHHMM(m.time), how: 'target' };
      }
      const l = mins[mins.length - 1];
      return { px: l.close, at: l.day ? `${l.day} 15:15` : istHHMM(l.time), how: endHow };
    };
    for (const [key, tgtPct] of [['hold', null], ['t2', 2], ['t5', 5]]) {
      const d0 = walk(rest.length ? rest : [c], tgtPct, 'time');
      res[key] = { ...d0, px: r2(d0.px), pct: pct(d0.px), r: pct(d0.px) };
    }
    const nd = after[after.indexOf(d) + 1];
    const nextMins = nd ? byDay.get(nd).filter((m) => istHHMM(m.time) < P.exitBy) : null;
    if (nextMins?.length) {
      // overnight: the stop keeps working on the next day (a gap through it fills at the open)
      const both = [...(rest.length ? rest : [c]), ...nextMins.map((m, j) => ({ ...m, day: nd.slice(5) }))];
      const d0 = walk(both, null, 'next day');
      res.next = { ...d0, px: r2(d0.px), pct: pct(d0.px), r: pct(d0.px) };
      const nextWorst = long ? entry - Math.min(...nextMins.map((m) => m.low)) : Math.max(...nextMins.map((m) => m.high)) - entry;
      res.nextWorstPct = r2((Math.max(nextWorst, 0) / entry) * 100);
    } else res.next = { ...res.hold, how: 'no next day yet' };
    res.worstPct = r2((worst / entry) * 100);
    res.bestR = r2((best / entry) * 100);
    res.bestPct = res.bestR;
    return res;
  }
  return { ...base, status: 'not-eaten', note: `didn’t fall to ${lvlName} (${r2(lvl)}) within ${days.length} trading days` };
}
