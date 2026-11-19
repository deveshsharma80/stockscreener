import StrategyBacktest from './StrategyBacktest.jsx';
import { MOMENTUM_DEFAULTS, MOMENTUM_EXITS } from './strategies/momentumPullback.js';
import { price } from './Ticker.jsx';

// Back Test → Momentum pullback (long): a big green 2-minute candle, a pullback to the 9 EMA,
// then a break of the day's high. Rules: src/strategies/momentumPullback.js.
const fmt = (v) => (v == null ? '—' : price.format(v));
const D = MOMENTUM_DEFAULTS;
const TIMES = ['09:15', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '13:30', '14:00', '14:30', '15:00'].map((t) => [t, t]);

export const MOMENTUM_BACKTEST = {
  id: 'momentum-pullback',
  leverage: 5,
  intro:
    'Best with “My scanner”: pick the “2-min candle above 4%” scan — each hit is the big candle. With a Chartink CSV (Date, Symbol …) the first big 2-minute candle between the two times below is used. Candles from Dhan.',
  params: [
    { key: 'bigPct', label: 'Big candle above %', type: 'number', step: 0.5, def: D.bigPct },
    { key: 'touchTol', label: '9 EMA touch within %', type: 'number', step: 0.1, def: D.touchTol },
    { key: 'entryBy', label: 'Entry before', type: 'select', def: D.entryBy, options: TIMES },
    { key: 'from', label: 'Big candle from (CSV)', type: 'select', def: D.from, options: TIMES },
    { key: 'to', label: 'Big candle until (CSV)', type: 'select', def: D.to, options: TIMES },
  ],
  exits: MOMENTUM_EXITS,
  statusOf(r) {
    if (r.status === 'entered') return ['long', 'Day high broken → long'];
    if (r.status === 'no-entry') return ['touched', 'At 9 EMA, no breakout'];
    if (r.status === 'no-touch') return ['watching', 'Never reached 9 EMA'];
    if (r.status === 'failed') return ['expired', 'Fell below half'];
    if (r.status === 'no-setup') return ['watching', 'No big candle'];
    if (r.status === 'invalid') return ['expired', 'Invalid stop'];
    if (r.status === 'error') return ['error', 'Error'];
    return ['waiting', 'No data'];
  },
  trade(r) {
    if (r.status !== 'entered') return null;
    return { entryAt: r.entryAt, fill: r.entry, exits: { either: r.either, ema9: r.ema9, cross: r.cross, hold: r.hold }, bestR: r.bestR };
  },
  columns: [
    { head: 'Big candle', num: true, cell: (r) => (r.bigAt ? <>{r.bigAt}{r.bigPct != null && <div className="pos ema-note">+{r.bigPct}%</div>}</> : '—') },
    { head: '9 EMA', num: true, cell: (r) => (r.touchAt ? <span className="muted-cell">{r.touchAt}</span> : '—') },
    { head: 'Entry ↑', num: true, cell: (r) => (r.entry ? <><b>{fmt(r.entry)}</b><div className="muted-cell ema-note">at {r.entryAt}</div></> : r.dayHigh ? <span className="muted-cell">{fmt(r.dayHigh)}</span> : '—') },
    { head: 'Stop', num: true, cell: (r) => (r.sl ? <><span className="neg">{fmt(r.sl)}</span><div className="muted-cell ema-note">{r.riskPct}% risk</div></> : '—') },
  ],
  csv: {
    head: ['Big candle', 'Big %', '9 EMA touch', 'Day high', 'Entry', 'Stop', 'Risk %'],
    row: (r) => [r.bigAt || '', r.bigPct ?? '', r.touchAt || '', r.dayHigh ?? '', r.entry ?? '', r.sl ?? '', r.riskPct ?? ''],
  },
};

export default function MomentumBacktest() {
  return <StrategyBacktest config={MOMENTUM_BACKTEST} />;
}
