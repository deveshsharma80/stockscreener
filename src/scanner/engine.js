// Scanners: your own stock scans, Chartink style. Pure code shared by the page (editor,
// descriptions) and the Vultr server (runs scans over the 1-minute history).
//
// A scan:
//   { id, name, tf: 5,                       the candle size the scan steps through (minutes)
//     at: 'first' | 'window',                 first = only the 09:15 candle; window = every candle from–to
//     from: '09:15', to: '15:15', firstOnly: true (window: one hit per stock per day),
//     conditions: [ { left: Side, cmp, right: Side, off?: true } ] }   all must pass
// Side = { a: Term, op?: '+'|'-'|'*'|'/', b?: Term }   e.g. Close / Open,  UpperBB(25,2) * 1.003
// Term = { t: 'num', v }                                a number
//      | { t: 'price', f: 'open'|'high'|'low'|'close'|'volume', tf, off }
//      | { t: 'ind', ind: 'ema'|'sma'|'bbu'|'bbm'|'bbl'|'rsi'|'vwap'|'hhv'|'llv'|'avgvol', n, k?, src?, tf, off }
//        hhv / llv = highest high / lowest low of the last n candles (including [off]);
//        avgvol = average volume of the last n candles. With [1] they cover the n candles
//        before the latest one, e.g. a range the latest candle breaks out of.
// tf = 1, 2, 3, 5 or 15 minutes · off = candles ago ([0] = latest closed, [1] = the one before)
// cmp = '>' '>=' '<' '<=' 'xa' (crossed above) 'xb' (crossed below)
//
// Candles are built from 1-minute candles, aligned to 09:15. Indicators run over the whole
// series, across days, like Chartink / TradingView (EMA seeded with an SMA, Bollinger with the
// population standard deviation, RSI with Wilder's smoothing). A candle "closes" at its end, so
// a 5-minute scan at 09:15 sees the 09:15–09:20 candle; a 15-minute term at that moment is the
// last 15-minute candle that had closed by 09:20 (yesterday's last one).

export const TIMEFRAMES = [1, 2, 3, 5, 15];
export const PRICE_FIELDS = [['open', 'Open'], ['high', 'High'], ['low', 'Low'], ['close', 'Close'], ['volume', 'Volume']];
export const INDICATORS = [
  ['ema', 'EMA', ['Length'], [9]],
  ['sma', 'SMA', ['Length'], [20]],
  ['bbu', 'Upper Bollinger band', ['Length', 'Std dev'], [20, 2]],
  ['bbm', 'Middle Bollinger band', ['Length', 'Std dev'], [20, 2]],
  ['bbl', 'Lower Bollinger band', ['Length', 'Std dev'], [20, 2]],
  ['rsi', 'RSI', ['Length'], [14]],
  ['vwap', 'VWAP (day)', [], []],
  ['hhv', 'Highest high', ['Candles'], [8]],
  ['llv', 'Lowest low', ['Candles'], [8]],
  ['avgvol', 'Average volume', ['Candles'], [8]],
];
export const COMPARE = [['>', 'Greater than'], ['>=', 'Greater or equal'], ['<', 'Less than'], ['<=', 'Less or equal'], ['xa', 'Crossed above'], ['xb', 'Crossed below']];
export const ARITH = ['+', '-', '*', '/'];

const IST = 330 * 60_000;
const OPEN_MIN = 9 * 60 + 15; // 09:15
const CLOSE_MIN = 15 * 60 + 30; // 15:30
export const istDay = (sec) => new Date(sec * 1000 + IST).toISOString().slice(0, 10);
export const istTime = (sec) => new Date(sec * 1000 + IST).toISOString().slice(11, 16);
const minuteOfDay = (sec) => {
  const d = new Date(sec * 1000 + IST);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};

// ------------------------------------------------------------------ text

const tfText = (tf) => `${tf} minute`;
export function termText(t) {
  if (!t) return '?';
  if (t.t === 'num') return `Number ${t.v}`;
  const pre = `[${t.off || 0}] ${tfText(t.tf)}`;
  if (t.t === 'price') return `${pre} ${PRICE_FIELDS.find((f) => f[0] === t.f)?.[1] || t.f}`;
  const ind = INDICATORS.find((i) => i[0] === t.ind);
  const args = t.ind === 'vwap' ? '' : t.ind.startsWith('bb') ? `(${t.n},${t.k})` : `(${t.n})`;
  return `${pre} ${ind?.[1] || t.ind}${args}`;
}
export const sideText = (s) => (s?.op && s.b ? `${termText(s.a)} ${s.op} ${termText(s.b)}` : termText(s?.a));
export const condText = (c) => `${sideText(c.left)} ${COMPARE.find((x) => x[0] === c.cmp)?.[1] || c.cmp} ${sideText(c.right)}`;

/** Problems with a scan (empty = fine). */
export function checkScan(s) {
  const errs = [];
  if (!String(s?.name || '').trim()) errs.push('Give the scan a name');
  if (!TIMEFRAMES.includes(Number(s?.tf))) errs.push('Pick a timeframe');
  if (!Array.isArray(s?.conditions) || !s.conditions.some((c) => !c.off)) errs.push('Add at least one condition');
  const term = (t, where) => {
    if (!t) return errs.push(`${where}: missing`);
    if (t.t === 'num') return Number.isFinite(Number(t.v)) || errs.push(`${where}: number`);
    if (!TIMEFRAMES.includes(Number(t.tf))) errs.push(`${where}: timeframe`);
    if (!(Number(t.off) >= 0 && Number(t.off) <= 50)) errs.push(`${where}: candles ago must be 0–50`);
    if (t.t === 'ind' && t.ind !== 'vwap' && !(Number(t.n) >= 1 && Number(t.n) <= 500)) errs.push(`${where}: length 1–500`);
    if (t.t === 'ind' && t.ind?.startsWith('bb') && !(Number(t.k) > 0 && Number(t.k) <= 10)) errs.push(`${where}: std dev`);
  };
  (s?.conditions || []).forEach((c, i) => {
    term(c.left?.a, `Condition ${i + 1} left`);
    if (c.left?.op) term(c.left.b, `Condition ${i + 1} left`);
    term(c.right?.a, `Condition ${i + 1} right`);
    if (c.right?.op) term(c.right.b, `Condition ${i + 1} right`);
  });
  if (s?.at === 'window' && !(s.from < s.to)) errs.push('Time window: from must be before to');
  return errs;
}

// ------------------------------------------------------------------ candles

/** 1-minute candles {t,o,h,l,c,v} → tf-minute candles aligned to 09:15 (start time t). */
export function aggregate(c1, tf) {
  if (tf === 1) return c1;
  const out = [];
  let cur = null;
  let key = null;
  for (const c of c1) {
    const m = minuteOfDay(c.t);
    if (m < OPEN_MIN || m >= CLOSE_MIN) continue;
    const bucket = Math.floor((m - OPEN_MIN) / tf);
    const k = `${istDay(c.t)}|${bucket}`;
    if (k !== key) {
      if (cur) out.push(cur);
      key = k;
      cur = { t: c.t - (m - OPEN_MIN - bucket * tf) * 60, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v };
    } else {
      if (c.h > cur.h) cur.h = c.h;
      if (c.l < cur.l) cur.l = c.l;
      cur.c = c.c;
      cur.v += c.v;
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
function smaOf(x, n) {
  const out = new Array(x.length).fill(null);
  let s = 0;
  for (let i = 0; i < x.length; i++) {
    s += x[i];
    if (i >= n) s -= x[i - n];
    if (i >= n - 1) out[i] = s / n;
  }
  return out;
}
function bbOf(x, n, k, which) {
  const mid = smaOf(x, n);
  return mid.map((m, i) => {
    if (m == null) return null;
    if (which === 'bbm') return m;
    let v = 0;
    for (let j = i - n + 1; j <= i; j++) v += (x[j] - m) ** 2;
    const sd = Math.sqrt(v / n);
    return which === 'bbu' ? m + k * sd : m - k * sd;
  });
}
function rsiOf(x, n) {
  const out = new Array(x.length).fill(null);
  if (x.length <= n) return out;
  let g = 0;
  let l = 0;
  for (let i = 1; i <= n; i++) {
    const d = x[i] - x[i - 1];
    if (d > 0) g += d;
    else l -= d;
  }
  g /= n;
  l /= n;
  out[n] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = n + 1; i < x.length; i++) {
    const d = x[i] - x[i - 1];
    g = (g * (n - 1) + Math.max(d, 0)) / n;
    l = (l * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}
function extremeOf(x, n, hi) {
  const out = new Array(x.length).fill(null);
  for (let i = n - 1; i < x.length; i++) {
    let m = x[i];
    for (let j = i - n + 1; j < i; j++) if (hi ? x[j] > m : x[j] < m) m = x[j];
    out[i] = m;
  }
  return out;
}
function vwapOf(cs) {
  const out = [];
  let day = null;
  let pv = 0;
  let vv = 0;
  for (const c of cs) {
    const d = istDay(c.t);
    if (d !== day) (day = d), (pv = 0), (vv = 0);
    pv += ((c.h + c.l + c.c) / 3) * c.v;
    vv += c.v;
    out.push(vv ? pv / vv : c.c);
  }
  return out;
}

/** One stock's candles at every timeframe + cached series. */
export function makeSeries(c1) {
  const byTf = new Map();
  const cache = new Map();
  const candles = (tf) => {
    if (!byTf.has(tf)) byTf.set(tf, aggregate(c1, tf));
    return byTf.get(tf);
  };
  const series = (term) => {
    const cs = candles(term.tf);
    const key = term.t === 'price' ? `${term.tf}|${term.f}` : `${term.tf}|${term.ind}|${term.n}|${term.k}`;
    if (cache.has(key)) return cache.get(key);
    let s;
    if (term.t === 'price') {
      const f = { open: 'o', high: 'h', low: 'l', close: 'c', volume: 'v' }[term.f];
      s = cs.map((c) => c[f]);
    } else {
      const close = cs.map((c) => c.c);
      const n = Number(term.n);
      s = term.ind === 'hhv' ? extremeOf(cs.map((c) => c.h), n, true) : term.ind === 'llv' ? extremeOf(cs.map((c) => c.l), n, false) : term.ind === 'avgvol' ? smaOf(cs.map((c) => c.v), n) : term.ind === 'ema' ? emaOf(close, n) : term.ind === 'sma' ? smaOf(close, n) : term.ind === 'rsi' ? rsiOf(close, n) : term.ind === 'vwap' ? vwapOf(cs) : bbOf(close, n, Number(term.k), term.ind);
    }
    cache.set(key, s);
    return s;
  };
  return { candles, series };
}

// ------------------------------------------------------------------ evaluate

/**
 * Run a scan over one stock. c1: its 1-minute candles (oldest first, can include days before
 * `from` so indicators are warmed up). Returns hits: [{ day, time, t, close, values }].
 */
export function runScan(scan, c1, { from = '0000-00-00', to = '9999-99-99' } = {}) {
  const S = makeSeries(c1);
  const tf = Number(scan.tf);
  const base = S.candles(tf);
  const conds = scan.conditions.filter((c) => !c.off);
  // index of the latest closed candle of `ttf` when the scan candle ending at `end` closes
  const ends = new Map();
  const lastClosed = (ttf, end) => {
    const cs = S.candles(ttf);
    let p = ends.get(ttf) ?? 0;
    while (p < cs.length && cs[p].t + ttf * 60 <= end) p++;
    ends.set(ttf, p);
    return p - 1;
  };
  const val = (term, end, back = 0) => {
    if (term.t === 'num') return Number(term.v);
    const j = lastClosed(Number(term.tf), end) - Number(term.off || 0) - back;
    if (j < 0) return null;
    const v = S.series(term)[j];
    return v == null || !Number.isFinite(v) ? null : v;
  };
  const side = (s, end, back) => {
    const a = val(s.a, end, back);
    if (a == null || !s.op) return a;
    const b = val(s.b, end, back);
    if (b == null) return null;
    return s.op === '+' ? a + b : s.op === '-' ? a - b : s.op === '*' ? a * b : b === 0 ? null : a / b;
  };
  const hits = [];
  const seenDay = new Set();
  for (const c of base) {
    const day = istDay(c.t);
    if (day < from || day > to) {
      continue;
    }
    const time = istTime(c.t);
    if (scan.at === 'first' ? time !== '09:15' : time < (scan.from || '09:15') || time > (scan.to || '15:15')) continue;
    if (scan.at !== 'first' && scan.firstOnly !== false && seenDay.has(day)) continue;
    const end = c.t + tf * 60;
    let ok = true;
    const values = [];
    for (const k of conds) {
      const L = side(k.left, end, 0);
      const R = side(k.right, end, 0);
      if (L == null || R == null) {
        ok = false;
        break;
      }
      let pass;
      if (k.cmp === 'xa' || k.cmp === 'xb') {
        const L1 = side(k.left, end, 1);
        const R1 = side(k.right, end, 1);
        pass = L1 != null && R1 != null && (k.cmp === 'xa' ? L1 <= R1 && L > R : L1 >= R1 && L < R);
      } else pass = k.cmp === '>' ? L > R : k.cmp === '>=' ? L >= R : k.cmp === '<' ? L < R : L <= R;
      values.push([Math.round(L * 100) / 100, Math.round(R * 100) / 100]);
      if (!pass) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    seenDay.add(day);
    hits.push({ day, time, t: c.t, close: c.c, values });
  }
  return hits;
}

/** How many 1-minute candles before `from` a scan needs so its indicators are warmed up. */
export function warmupDays(scan) {
  let bars = 0;
  for (const c of scan.conditions || []) {
    for (const t of [c.left?.a, c.left?.b, c.right?.a, c.right?.b]) {
      if (!t || t.t === 'num') continue;
      const need = (t.t === 'ind' ? Number(t.n || 1) * (t.ind === 'ema' || t.ind === 'rsi' ? 3 : 1) : 1) + Number(t.off || 0) + 2;
      bars = Math.max(bars, need * Number(t.tf));
    }
  }
  return Math.min(60, Math.ceil(bars / 375) + 2); // trading days
}

// ------------------------------------------------------------------ templates

const P = (f, tf = 5, off = 0) => ({ t: 'price', f, tf, off });
const N = (v) => ({ t: 'num', v });
export const TEMPLATES = [
  {
    name: 'Bollinger first candle (5 min)',
    tf: 5,
    at: 'first',
    conditions: [
      { left: { a: P('close') }, cmp: '>', right: { a: N(400) } },
      { left: { a: P('close'), op: '/', b: P('open') }, cmp: '>', right: { a: N(1.01) } },
      { left: { a: P('low') }, cmp: '>', right: { a: { t: 'ind', ind: 'bbu', n: 25, k: 2, tf: 5, off: 0 }, op: '*', b: N(1.003) } },
      { left: { a: P('volume') }, cmp: '>', right: { a: N(200000) } },
    ],
  },
  {
    // the Chartink screener "Futures April 2025" (feeds EMA Rejection); greyed-out conditions are off
    name: 'Futures April 2025 (EMA Rejection)',
    tf: 5,
    at: 'first',
    conditions: [
      { left: { a: P('open') }, cmp: '<', right: { a: { t: 'ind', ind: 'bbl', n: 30, k: 2, tf: 5, off: 0 }, op: '*', b: N(1.005) } },
      { left: { a: P('close') }, cmp: '>', right: { a: N(300) } },
      { left: { a: P('volume') }, cmp: '>', right: { a: N(200000) } },
      { left: { a: P('close', 2) }, cmp: '>', right: { a: { t: 'ind', ind: 'bbu', n: 20, k: 2, tf: 2, off: 0 } }, off: true },
      { left: { a: P('close', 2), op: '/', b: P('open', 2) }, cmp: '<', right: { a: N(1.002) }, off: true },
      { left: { a: P('close', 2), op: '/', b: P('open', 2) }, cmp: '>', right: { a: N(1.0001) }, off: true },
      { left: { a: P('close') }, cmp: '>', right: { a: { t: 'ind', ind: 'ema', n: 20, tf: 5, off: 0 } }, off: true },
      { left: { a: { t: 'ind', ind: 'rsi', n: 14, tf: 5, off: 0 } }, cmp: '<', right: { a: N(40) } },
      { left: { a: P('close') }, cmp: '<', right: { a: N(999) } },
    ],
  },
  {
    // the Chartink bullish momentum screener (feeds Back Test → Momentum confirmation)
    name: 'Bullish momentum (RSI > 70)',
    tf: 5,
    at: 'window',
    from: '09:45',
    to: '14:00',
    firstOnly: true,
    conditions: [
      { left: { a: P('close') }, cmp: '>', right: { a: N(400) } },
      { left: { a: P('close'), op: '/', b: P('open') }, cmp: '>', right: { a: N(1.005) } },
      { left: { a: P('open') }, cmp: '>', right: { a: { t: 'ind', ind: 'ema', n: 5, tf: 5, off: 0 }, op: '*', b: N(1) } },
      { left: { a: P('volume') }, cmp: '>', right: { a: N(100000) } },
      { left: { a: { t: 'ind', ind: 'rsi', n: 14, tf: 5, off: 0 } }, cmp: '>', right: { a: N(70) } },
    ],
  },
];
