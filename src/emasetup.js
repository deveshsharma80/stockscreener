// Gap-down → pullback to the 9 / 26 EMA → rejection (short setup), on 5-minute candles.
//
// For stocks from the Chartink screener EMA_SCAN ("Futures April 2025": gap-down day,
// first 5-minute candle red). After the first candle, on each completed 5-minute candle:
//   1. Touch      — the bounce reaches the zone: candle high ≥ 9 EMA (within TOUCH_TOL).
//   2. Breakout   — any close above the 26 EMA (+ BREAK_TOL) → "broke out", skipped for
//                   the day (the case where the bounce turns into a trend).
//   3. Rejection  — after a touch, a red candle closes below the 9 EMA and below the low of
//                   the last candle that touched the zone, with the 26 EMA still falling
//                   → alert: short below this candle's low, stop above the bounce's high,
//                   first target the day's low so far.
//   4. Expired    — nothing by CUTOFF (13:30 IST).
// EMAs run continuously over the previous days' 5-minute candles (as on Chartink / the
// chart), seeded with a simple average like TradingView.
// Pure functions: used by the server (lib/emasetup.js) and the page.

export const EMA_SCAN = 'Futures April 2025';
export const isEmaScan = (name) => String(name || '').trim().toLowerCase() === EMA_SCAN.toLowerCase();

export const PARAMS = {
  fast: 9,
  slow: 26,
  touchTol: 0.001, // the high may stop 0.1 % short of the 9 EMA and still count as a touch
  breakTol: 0.0015, // a close more than 0.15 % above the 26 EMA = breakout
  slopeBars: 3, // 26 EMA lower than 3 candles ago = still falling
  cutoff: '13:30', // no new alerts from candles starting after this (IST)
  slPad: 0.0005, // stop 0.05 % above the bounce's high
  firstHitBy: '09:24', // only stocks the screener sent for the first 5-minute candle (09:15)
  fallbackR: 2, // target when the day's low is not below the entry: entry − 2 × risk
  exitBy: '15:15', // backtest: close what is still open at this time
};

/**
 * Was this Chartink hit for the first 5-minute candle (09:15)? Live alerts are stamped
 * with the time the scan ran (≈ 09:20 for the 09:15 candle, ≈ 09:25 for the next);
 * Chartink's backtest export uses the candle's start time (09:15).
 */
export const isFirstCandleHit = (ms, by = PARAMS.firstHitBy) => {
  const t = new Date(ms + 330 * 60_000).toISOString().slice(11, 16);
  return t >= '09:15' && t < by;
};

const IST_MS = 330 * 60_000;
const FIVE = 300;
export const istDate = (ms) => new Date(ms + IST_MS).toISOString().slice(0, 10);
export const istHHMM = (sec) => new Date(sec * 1000 + IST_MS).toISOString().slice(11, 16);
const r2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);

/**
 * 1-minute candles [{time (epoch s), open, high, low, close, volume}] → 5-minute candles
 * aligned to the 09:15 IST session (09:15, 09:20, …), only within 09:15–15:30.
 * The 5-minute candle still forming at `nowMs` is dropped.
 */
export function to5m(c1, nowMs = Date.now()) {
  const out = [];
  let cur = null;
  for (const c of c1) {
    const hhmm = istHHMM(c.time);
    if (hhmm < '09:15' || hhmm >= '15:30') continue;
    const t = Math.floor(c.time / FIVE) * FIVE; // 09:15 IST is on a 5-minute boundary
    if (!cur || cur.time !== t) {
      if (cur) out.push(cur);
      cur = { time: t, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0 };
    } else {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
      cur.volume += c.volume || 0;
    }
  }
  if (cur) out.push(cur);
  return out.filter((c) => (c.time + FIVE) * 1000 <= nowMs);
}

/** EMA of `values`, seeded with the simple average of the first n (like TradingView). */
export function ema(values, n) {
  const out = new Array(values.length).fill(null);
  if (values.length < n) return out;
  let s = 0;
  for (let i = 0; i < n; i++) s += values[i];
  let e = s / n;
  out[n - 1] = e;
  const k = 2 / (n + 1);
  for (let i = n; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}

/**
 * Evaluate one stock on its 5-minute candles (completed only, oldest first, several days).
 * Returns the setup's state for `day` (IST date).
 */
export function evaluate(c5, { day, params = PARAMS } = {}) {
  const P = { ...PARAMS, ...params };
  const e9 = ema(c5.map((c) => c.close), P.fast);
  const e26 = ema(c5.map((c) => c.close), P.slow);
  const idx = c5.map((c, i) => i).filter((i) => istDate(c5[i].time * 1000) === day);
  const base = { status: 'waiting', candles: idx.length };
  if (!idx.length) return { ...base, note: 'no 5-minute candles yet today' };

  const first = c5[idx[0]];
  const prev = idx[0] > 0 ? c5[idx[0] - 1] : null;
  const out = {
    ...base,
    status: 'watching',
    gapPct: prev ? r2((first.open / prev.close - 1) * 100) : null,
    prevClose: prev ? r2(prev.close) : null,
    first: { open: first.open, high: first.high, low: first.low, close: first.close, red: first.close < first.open },
  };
  if (e26[idx[0]] == null) return { ...out, status: 'waiting', note: 'not enough history for the 26 EMA' };

  let dayLow = first.low;
  let bounceHigh = null;
  let touchLow = null; // low of the latest candle that touched the zone
  for (const i of idx.slice(1)) {
    const c = c5[i];
    const f = e9[i];
    const s = e26[i];
    const at = istHHMM(c.time);
    out.lastCandle = at;
    out.ema9 = r2(f);
    out.ema26 = r2(s);
    out.close = c.close;
    if (at > P.cutoff) {
      if (out.status === 'watching' || out.status === 'touched') {
        out.status = 'expired';
        out.note = `no rejection by ${P.cutoff}`;
      }
      break;
    }
    // 2. a close above the 26 EMA: the bounce became a trend → skip the day
    if (c.close > s * (1 + P.breakTol)) {
      out.status = 'broke-out';
      out.brokeAt = at;
      out.note = `closed ${r2(c.close)} above the 26 EMA (${r2(s)}) at ${at}`;
      break;
    }
    // 3. rejection after a touch
    const falling = i >= P.slopeBars && e26[i - P.slopeBars] != null && s < e26[i - P.slopeBars];
    if (out.status === 'touched' && c.close < c.open && c.close < f && touchLow != null && c.close < touchLow && falling) {
      bounceHigh = Math.max(bounceHigh, c.high);
      const entry = c.low;
      const sl = bounceHigh * (1 + P.slPad);
      const risk = sl - entry;
      const target = dayLow < entry ? dayLow : entry - P.fallbackR * risk;
      Object.assign(out, {
        status: 'rejected',
        alertAt: at,
        alertTime: c.time,
        entry: r2(entry),
        sl: r2(sl),
        target: r2(target),
        risk: r2(sl - entry),
        reward: r2(entry - target),
        rr: sl > entry && entry > target ? Math.round(((entry - target) / (sl - entry)) * 10) / 10 : null,
        bounceHigh: r2(bounceHigh),
        targetKind: dayLow < entry ? 'day-low' : `${P.fallbackR}R`,
        note: `rejected at the ${bounceHigh >= s * (1 - P.touchTol) ? '26' : '9'} EMA`,
      });
      break;
    }
    // 1. the bounce reaches the zone (the 9 EMA, or anywhere up to the 26 EMA)
    if (c.high >= f * (1 - P.touchTol)) {
      if (out.status === 'watching') {
        out.status = 'touched';
        out.touchedAt = at;
      }
      bounceHigh = Math.max(bounceHigh ?? c.high, c.high);
      touchLow = c.low;
      out.bounceHigh = r2(bounceHigh);
    } else if (out.status === 'touched') {
      bounceHigh = Math.max(bounceHigh, c.high);
    }
    dayLow = Math.min(dayLow, c.low);
  }
  out.dayLow = r2(dayLow);
  return out;
}

/**
 * Backtest: what happened after a "rejected" alert, on that day's 1-minute candles.
 * Entry = sell-stop at the alert candle's low (fills when price trades below it after the
 * alert candle closes; at the open if it gaps through). If the stop is hit first the setup
 * is cancelled. Once short, three exits are scored:
 *   target — the setup's target (day's low, or 2R) · twoR — fixed 1:2 · hold — stop only,
 *   closed at exitBy. A minute that touches both stop and target counts as the stop.
 * Results in R (1R = entry → stop) and %.
 */
export function simulate(c1, setup, { params = PARAMS } = {}) {
  const P = { ...PARAMS, ...params };
  if (setup?.status !== 'rejected') return null;
  const { entry, sl } = setup;
  const risk = sl - entry;
  if (!(risk > 0)) return { result: 'invalid' };
  const day = istDate(setup.alertTime * 1000);
  const after = c1.filter((c) => c.time >= setup.alertTime + FIVE && istDate(c.time * 1000) === day && istHHMM(c.time) < P.exitBy);
  let i = 0;
  let fill = null;
  for (; i < after.length; i++) {
    const c = after[i];
    if (c.low <= entry) {
      fill = Math.min(entry, c.open);
      break;
    }
    if (c.high >= sl) return { result: 'cancelled', note: `stop ${istHHMM(c.time)} before entry` };
  }
  if (fill == null) return { result: 'no-entry' };
  const entryAt = istHHMM(after[i].time);
  const exits = {
    target: setup.target,
    twoR: entry - 2 * risk,
    hold: null,
  };
  const out = { result: 'entered', fill: r2(fill), entryAt, riskPct: r2((risk / entry) * 100) };
  let mfe = 0;
  const done = {};
  for (let j = i; j < after.length; j++) {
    const c = after[j];
    const stop = c.high >= sl;
    for (const [k, tgt] of Object.entries(exits)) {
      if (done[k]) continue;
      if (stop) done[k] = { px: j > i && c.open > sl ? c.open : sl, at: istHHMM(c.time), how: 'stop' };
      else if (tgt != null && c.low <= tgt) done[k] = { px: j > i ? Math.min(tgt, c.open) : tgt, at: istHHMM(c.time), how: 'target' };
    }
    if (!stop) mfe = Math.max(mfe, fill - c.low);
    if (Object.keys(done).length === 3) break;
  }
  const last = after[after.length - 1];
  for (const k of Object.keys(exits)) {
    const d = done[k] || { px: last.close, at: istHHMM(last.time), how: 'time' };
    out[k] = { ...d, px: r2(d.px), r: Math.round(((fill - d.px) / risk) * 100) / 100, pct: r2(((fill - d.px) / fill) * 100) };
  }
  out.mfeR = Math.round((mfe / risk) * 100) / 100;
  return out;
}

export const STATUS_LABEL = {
  waiting: 'Waiting for data',
  watching: 'Watching the bounce',
  touched: 'At the EMA',
  rejected: 'Rejected → short',
  'broke-out': 'Broke above 26 EMA',
  expired: 'No setup today',
  error: 'Error',
};
