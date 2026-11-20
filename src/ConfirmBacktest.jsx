import StrategyBacktest from './StrategyBacktest.jsx';
import { CONFIRM_DEFAULTS, CONFIRM_EXITS } from './strategies/momentumConfirm.js';
import { price } from './Ticker.jsx';

// Back Test → Momentum confirmation: the scan's first hit, then a green next candle closing
// above the hit candle's close → buy. Rules: src/strategies/momentumConfirm.js.
const fmt = (v) => (v == null ? '—' : price.format(v));
const D = CONFIRM_DEFAULTS;
const TIMES = ['09:15', '09:30', '09:45', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '14:00', '15:00'].map((t) => [t, t]);

export const CONFIRM_BACKTEST = {
  id: 'momentum-confirm',
  leverage: 5,
  firstOnly: false, // every hit time counts, not just 09:15
  csvOnly: true,
  hitWindow: true, // each stock-day's first hit between “First hit from” and “until”
  intro:
    'Upload a Chartink backtest CSV of your bullish scan with times (e.g. “20-11-2026 10:40 am”). For each stock’s first hit of the day between the two times below: if the next candle is green and closes above the hit candle’s close, buy right after it closes. Candles from Dhan.',
  params: [
    { key: 'from', label: 'First hit from', type: 'select', def: D.from, options: TIMES },
    { key: 'to', label: 'First hit until', type: 'select', def: D.to, options: TIMES },
    { key: 'tf', label: 'Candle (min)', type: 'select', def: String(D.tf), options: [['2', '2 min'], ['3', '3 min'], ['5', '5 min'], ['15', '15 min']] },
    { key: 'stop', label: 'Stop loss', type: 'select', def: D.stop, options: [['confirm', 'Confirmation candle low'], ['hit', 'Hit candle low'], ['pct', 'Fixed % below entry']] },
    { key: 'stopPct', label: 'Fixed stop %', type: 'number', step: 0.25, def: D.stopPct },
  ],
  exits: CONFIRM_EXITS,
  statusOf(r) {
    if (r.status === 'entered') return ['long', 'Confirmed → buy'];
    if (r.status === 'no-confirm') return ['watching', 'Not confirmed'];
    if (r.status === 'outside') return ['expired', 'Outside time window'];
    if (r.status === 'no-entry') return ['touched', 'Too late'];
    if (r.status === 'invalid') return ['expired', 'Opened below stop'];
    if (r.status === 'error') return ['error', 'Error'];
    return ['waiting', 'No data'];
  },
  trade(r) {
    if (r.status !== 'entered') return null;
    return { entryAt: r.entryAt, fill: r.entry, exits: { t1: r.t1, r2: r.r2, ema9: r.ema9, hold: r.hold }, bestR: r.bestR };
  },
  columns: [
    { head: 'Hit', num: true, cell: (r) => (r.hitAt ? <>{r.hitAt}<div className="muted-cell ema-note">close {fmt(r.hitClose)}</div></> : '—') },
    { head: 'Next candle', num: true, cell: (r) => (r.confAt ? <>{r.confAt}<div className={`ema-note ${r.confClose > r.confOpen ? 'pos' : 'neg'}`}>{fmt(r.confOpen)} → {fmt(r.confClose)}</div></> : '—') },
    { head: 'Buy ↑', num: true, cell: (r) => (r.entry ? <><b>{fmt(r.entry)}</b><div className="muted-cell ema-note">at {r.entryAt}</div></> : '—') },
    { head: 'Stop', num: true, cell: (r) => (r.sl ? <><span className="neg">{fmt(r.sl)}</span>{r.riskPct != null && <div className="muted-cell ema-note">{r.riskPct}% risk</div>}</> : '—') },
  ],
  csv: {
    head: ['Hit', 'Hit close', 'Next candle', 'Next open', 'Next close', 'Buy', 'Stop', 'Risk %'],
    row: (r) => [r.hitAt || '', r.hitClose ?? '', r.confAt || '', r.confOpen ?? '', r.confClose ?? '', r.entry ?? '', r.sl ?? '', r.riskPct ?? ''],
  },
};

export default function ConfirmBacktest() {
  return <StrategyBacktest config={CONFIRM_BACKTEST} />;
}
