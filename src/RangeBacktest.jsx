import StrategyBacktest from './StrategyBacktest.jsx';
import { RANGE_DEFAULTS, RANGE_EXITS } from './strategies/rangeBreakout.js';
import { price } from './Ticker.jsx';

// Back Test → Range breakout (tight range, then a breakout with volume; long or short).
// Rules: src/strategies/rangeBreakout.js.
const fmt = (v) => (v == null ? '—' : price.format(v));
const D = RANGE_DEFAULTS;
const TIMES = ['09:45', '10:00', '10:15', '10:30', '11:00', '11:30', '12:00', '13:00', '13:30', '14:00', '14:30', '15:00'].map((t) => [t, t]);

export const RANGE_BACKTEST = {
  id: 'range-breakout',
  leverage: 5,
  intro:
    'Best with “My scanner”: pick the Range breakout UP or DOWN scan — each hit is the breakout candle. With a Chartink CSV (Date, Symbol …) the first breakout of the day between the two times below is used. Entry at the breakout candle’s close; candles from Dhan.',
  params: [
    { key: 'bars', label: 'Range candles (5 min)', type: 'number', step: 1, def: D.bars },
    { key: 'rangePct', label: 'Range within %', type: 'number', step: 0.1, def: D.rangePct },
    { key: 'volMult', label: 'Volume × average', type: 'number', step: 0.5, def: D.volMult },
    { key: 'stop', label: 'Stop loss', type: 'select', def: D.stop, options: [['range', 'Other side of the range'], ['mid', 'Middle of the range'], ['candle', 'Breakout candle low / high']] },
    { key: 'from', label: 'Breakout from (CSV)', type: 'select', def: D.from, options: TIMES },
    { key: 'to', label: 'Breakout until (CSV)', type: 'select', def: D.to, options: TIMES },
  ],
  exits: RANGE_EXITS,
  statusOf(r) {
    if (r.status === 'entered') return r.side === 'short' ? ['rejected', 'Breakdown → short'] : ['long', 'Breakout → long'];
    if (r.status === 'no-breakout') return ['watching', 'No breakout'];
    if (r.status === 'no-entry') return ['touched', 'No entry'];
    if (r.status === 'invalid') return ['expired', 'Gapped past stop'];
    if (r.status === 'error') return ['error', 'Error'];
    return ['waiting', 'No data'];
  },
  trade(r) {
    if (r.status !== 'entered') return null;
    return { entryAt: r.entryAt, fill: r.entry, exits: { t1: r.t1, twoR: r.twoR, threeR: r.threeR, hold: r.hold }, bestR: r.bestR };
  },
  columns: [
    {
      head: 'Range',
      num: true,
      cell: (r) => (r.rangeHi ? <>{fmt(r.rangeLo)} – {fmt(r.rangeHi)}{r.rangePct != null && <div className="muted-cell ema-note">{r.rangePct}% tall</div>}</> : '—'),
    },
    { head: 'Breakout', num: true, cell: (r) => (r.breakAt ? <>{r.breakAt}{r.volX != null && <div className="muted-cell ema-note">{r.volX}× volume</div>}</> : '—') },
    { head: 'Entry', num: true, cell: (r) => (r.entry ? <><b>{fmt(r.entry)} {r.side === 'short' ? '↓' : '↑'}</b>{r.entryAt && <div className="muted-cell ema-note">at {r.entryAt}</div>}</> : '—') },
    { head: 'Stop', num: true, cell: (r) => (r.sl ? <><span className="neg">{fmt(r.sl)}</span>{r.riskPct != null && <div className="muted-cell ema-note">{r.riskPct}% risk</div>}</> : '—') },
  ],
  csv: {
    head: ['Side', 'Range low', 'Range high', 'Range %', 'Breakout candle', 'Volume ×', 'Entry', 'Stop', 'Risk %'],
    row: (r) => [r.side || '', r.rangeLo ?? '', r.rangeHi ?? '', r.rangePct ?? '', r.breakAt || '', r.volX ?? '', r.entry ?? '', r.sl ?? '', r.riskPct ?? ''],
  },
};

export default function RangeBacktest() {
  return <StrategyBacktest config={RANGE_BACKTEST} />;
}
