// Back Test: run a strategy's rules on past days for one stock, with real Dhan candles.
// One Dhan request per stock covers all its days (+ 8 days before, so indicators that
// carry across days — EMAs, Bollinger Bands — start the same way TradingView shows them).
import { findEquityBySymbol, getIntradayCandles } from './dhan.js';
import { HttpError } from './http.js';
import { backtestSymbol as emaBacktest } from './emasetup.js';
import { istDate, to5m } from '../src/emasetup.js';
import { HALF_DEFAULTS, runHalfEaten } from '../src/strategies/halfEaten.js';
import { OVEREXT_DEFAULTS, runOverextShort } from '../src/strategies/overextShort.js';

// EMA Rejection has its own path below. Others plug in here as
// 'id': { run({ c5, c1Day, c1, day, params, at }), defaults, after?(P) = calendar days needed after each day }.
const STRATEGIES = {
  'half-eaten': { run: runHalfEaten, defaults: HALF_DEFAULTS, after: (P) => Math.ceil(P.waitDays * 1.5) + 6, wholeRange: true },
  'overext-short': { run: runOverextShort, defaults: OVEREXT_DEFAULTS },
};

// Dhan gives at most 90 days of 1-minute candles per request → fetch longer ranges in pieces
async function candlesBetween(inst, from, to) {
  const out = [];
  let a = Date.parse(`${from}T12:00:00+05:30`);
  const end = Date.parse(`${to}T12:00:00+05:30`);
  while (a <= end) {
    const b = Math.min(end, a + 84 * 86_400_000);
    const part = await getIntradayCandles(inst, { from: istDate(a), to: istDate(b) });
    for (const c of part) if (!out.length || c.time > out[out.length - 1].time) out.push(c);
    a = b + 86_400_000;
  }
  return out;
}

const cleanParams = (defaults, params = {}) => {
  const out = {};
  for (const [k, v] of Object.entries(defaults)) {
    const p = params?.[k];
    if (p == null || p === '') continue;
    if (typeof v === 'number') {
      const n = Number(p);
      if (Number.isFinite(n) && (n > 0 || (n === 0 && /(Pct|Tol)$/.test(k))) && n < 1000) out[k] = n; // 0 allowed for % settings (e.g. target off)
    } else if (typeof p === 'string' && p.length < 20) out[k] = p;
  }
  return out;
};

export async function backtestStrategy(strategy, symbol, days, params, times = {}) {
  if (strategy === 'ema-rejection') return emaBacktest(symbol, days);
  const s = STRATEGIES[strategy];
  if (!s) throw new HttpError(400, `Unknown strategy ${strategy}`);
  const list = [...new Set(days.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)))].sort();
  if (!list.length) throw new HttpError(400, 'No valid days');
  const inst = await findEquityBySymbol(symbol);
  if (!inst) return list.map((day) => ({ day, symbol, status: 'error', note: `${symbol} not found in Dhan's instrument list` }));
  const P = cleanParams(s.defaults, params);
  const from = istDate(Date.parse(`${list[0]}T12:00:00+05:30`) - 8 * 86_400_000);
  const lastNeeded = Math.min(Date.now(), Date.parse(`${list[list.length - 1]}T12:00:00+05:30`) + (s.after ? s.after(P) : 0) * 86_400_000);
  const c1 = await candlesBetween(inst, from, istDate(lastNeeded));
  return list.map((day) => {
    const end = Date.parse(`${day}T15:30:00+05:30`);
    const upto = c1.filter((c) => c.time * 1000 < end);
    const c1Day = upto.filter((c) => istDate(c.time * 1000) === day);
    if (!c1Day.length) return { day, symbol, status: 'waiting', note: 'no candles that day (holiday?)' };
    return { day, symbol, key: `${inst.segment}:${inst.securityId}`, ...s.run({ c5: to5m(upto, end), c1Day, c1: s.wholeRange ? c1 : upto, day, params: P, at: times[day] || null }) };
  });
}
