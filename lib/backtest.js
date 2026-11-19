// Back Test: run a strategy's rules on past days for one stock, with real Dhan candles.
// One Dhan request per stock covers all its days (+ 8 days before, so indicators that
// carry across days — EMAs, Bollinger Bands — start the same way TradingView shows them).
import { findEquityBySymbol, getIntradayCandles } from './dhan.js';
import { HttpError } from './http.js';
import { backtestSymbol as emaBacktest } from './emasetup.js';
import { istDate, to5m } from '../src/emasetup.js';
import { BB_DEFAULTS, runBbBreakout } from '../src/strategies/bbBreakout.js';
import { RANGE_DEFAULTS, runRangeBreakout } from '../src/strategies/rangeBreakout.js';
import { MOMENTUM_DEFAULTS, runMomentumPullback } from '../src/strategies/momentumPullback.js';
import { TRAIL_DEFAULTS, runEmaTrail } from '../src/strategies/emaTrail.js';

const STRATEGIES = {
  'bb-breakout': { run: runBbBreakout, defaults: BB_DEFAULTS },
  'range-breakout': { run: runRangeBreakout, defaults: RANGE_DEFAULTS },
  'momentum-pullback': { run: runMomentumPullback, defaults: MOMENTUM_DEFAULTS },
  'ema9-trail': { run: runEmaTrail, defaults: TRAIL_DEFAULTS },
};

const cleanParams = (defaults, params = {}) => {
  const out = {};
  for (const [k, v] of Object.entries(defaults)) {
    const p = params?.[k];
    if (p == null || p === '') continue;
    if (typeof v === 'number') {
      const n = Number(p);
      if (Number.isFinite(n) && n > 0 && n < 1000) out[k] = n;
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
  const from = istDate(Date.parse(`${list[0]}T12:00:00+05:30`) - 8 * 86_400_000);
  const c1 = await getIntradayCandles(inst, { from, to: list[list.length - 1] });
  const P = cleanParams(s.defaults, params);
  return list.map((day) => {
    const end = Date.parse(`${day}T15:30:00+05:30`);
    const upto = c1.filter((c) => c.time * 1000 < end);
    const c1Day = upto.filter((c) => istDate(c.time * 1000) === day);
    if (!c1Day.length) return { day, symbol, status: 'waiting', note: 'no candles that day (holiday?)' };
    return { day, symbol, key: `${inst.segment}:${inst.securityId}`, ...s.run({ c5: to5m(upto, end), c1Day, c1: upto, day, params: P, at: times[day] || null }) };
  });
}
