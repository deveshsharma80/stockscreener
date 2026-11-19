import StrategyBacktest from './StrategyBacktest.jsx';
import { TRAIL_DEFAULTS, TRAIL_EXITS } from './strategies/emaTrail.js';
import { price } from './Ticker.jsx';

// Back Test → Buy & ride 9 EMA: buy at the scan hit, exit on a close below the 9 EMA.
// Rules: src/strategies/emaTrail.js.
const fmt = (v) => (v == null ? '—' : price.format(v));
const D = TRAIL_DEFAULTS;

export const TRAIL_BACKTEST = {
  id: 'ema9-trail',
  leverage: 5,
  firstOnly: false, // every hit time counts, not just 09:15
  intro:
    'Upload a Chartink backtest CSV with times (e.g. “20-08-2026 9:40 am”) — the first hit of each stock each day is bought at that candle’s close — or use My scanner. Candles from Dhan.',
  params: [
    { key: 'tf', label: 'EMA candles (min)', type: 'select', def: String(D.tf), options: [['2', '2 min'], ['3', '3 min'], ['5', '5 min'], ['15', '15 min']] },
    { key: 'ema', label: 'EMA length', type: 'number', step: 1, def: D.ema },
    { key: 'sharpPct', label: '“Sharp” = % below EMA', type: 'number', step: 0.1, def: D.sharpPct },
    { key: 'stop', label: 'Stop loss', type: 'select', def: D.stop, options: [['none', 'None (EMA exits only)'], ['candle', 'Hit candle low']] },
  ],
  exits: TRAIL_EXITS,
  statusOf(r) {
    if (r.status === 'entered') return ['long', 'Bought'];
    if (r.status === 'no-entry') return ['touched', 'Too late'];
    if (r.status === 'error') return ['error', 'Error'];
    return ['waiting', 'No data'];
  },
  trade(r) {
    if (r.status !== 'entered') return null;
    return { entryAt: r.entryAt, fill: r.entry, exits: { close: r.close, sharp: r.sharp, two: r.two, hold: r.hold }, bestR: r.bestR };
  },
  columns: [
    { head: 'Hit', num: true, cell: (r) => r.hitAt || '—' },
    { head: 'Buy', num: true, cell: (r) => (r.entry ? <><b>{fmt(r.entry)}</b><div className="muted-cell ema-note">at {r.entryAt}</div></> : '—') },
    { head: '9 EMA', num: true, cell: (r) => (r.ema0 ? <>{fmt(r.ema0)}{r.above != null && <div className="muted-cell ema-note">{r.above}% above</div>}</> : '—') },
    { head: 'Stop', num: true, cell: (r) => (r.sl ? <span className="neg">{fmt(r.sl)}</span> : <span className="muted-cell">none</span>) },
  ],
  csv: {
    head: ['Hit', 'Buy', '9 EMA at hit', '% above EMA', 'Stop'],
    row: (r) => [r.hitAt || '', r.entry ?? '', r.ema0 ?? '', r.above ?? '', r.sl ?? ''],
  },
};

export default function TrailBacktest() {
  return <StrategyBacktest config={TRAIL_BACKTEST} />;
}
