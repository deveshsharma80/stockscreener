import StrategyBacktest from './StrategyBacktest.jsx';
import { OVEREXT_DEFAULTS, OVEREXT_EXITS } from './strategies/overextShort.js';
import { price } from './Ticker.jsx';

// Back Test → Overextension short: the scan's hit (a close far above the upper Bollinger band)
// → short at once, cover back at the 9 EMA. Rules: src/strategies/overextShort.js.
const fmt = (v) => (v == null ? '—' : price.format(v));
const D = OVEREXT_DEFAULTS;
const TIMES = ['09:15', '09:20', '09:30', '09:45', '10:00', '10:30', '11:00', '12:00', '13:00', '13:30', '14:00', '14:30', '15:00'].map((t) => [t, t]);

export const OVEREXT_BACKTEST = {
  id: 'overext-short',
  leverage: 5,
  firstOnly: false,
  csvOnly: true,
  hitWindow: true, // each stock-day's first hit between “First hit from” and “until”
  intro:
    'Upload a scan CSV with times (Chartink, or Scanners → Test on history → Download) — e.g. “close more than 3% above the upper Bollinger band (30)”. For each stock’s first hit of the day: short right after that candle closes, cover at the 9 EMA (or the other exits). Candles from Dhan.',
  params: [
    { key: 'from', label: 'First hit from', type: 'select', def: D.from, options: TIMES },
    { key: 'to', label: 'First hit until', type: 'select', def: D.to, options: TIMES },
    { key: 'tf', label: 'Candle (min)', type: 'select', def: String(D.tf), options: [['2', '2 min'], ['3', '3 min'], ['5', '5 min'], ['15', '15 min']] },
    { key: 'entryMode', label: 'Entry', type: 'select', def: D.entryMode, options: [['now', 'Right after the hit'], ['nextRed', 'Next candle red'], ['nextRedBelow', 'Next candle red & below hit close'], ['firstRed', 'First red candle (wait)'], ['breakLow', 'Break below hit candle low (wait)']] },
    { key: 'within', label: 'Wait up to (candles)', type: 'number', step: 1, def: D.within },
    { key: 'stop', label: 'Stop loss', type: 'select', def: D.stop, options: [['none', 'None'], ['high', 'Spike high'], ['pct', 'Fixed % above entry']] },
    { key: 'stopPct', label: 'Fixed stop %', type: 'number', step: 0.25, def: D.stopPct },
  ],
  exits: OVEREXT_EXITS,
  statusOf(r) {
    if (r.status === 'entered') return ['rejected', 'Shorted'];
    if (r.status === 'skipped') return ['watching', 'Skipped — no weakness'];
    if (r.status === 'outside') return ['expired', 'Outside time window'];
    if (r.status === 'misaligned') return ['error', 'Time doesn’t fit'];
    if (r.status === 'no-entry') return ['touched', 'Too late'];
    if (r.status === 'invalid') return ['expired', 'Opened above stop'];
    if (r.status === 'error') return ['error', 'Error'];
    return ['waiting', 'No data'];
  },
  trade(r) {
    if (r.status !== 'entered') return null;
    return { entryAt: r.entryAt, fill: r.entry, exits: { ema9: r.ema9, t1: r.t1, t2: r.t2, hold: r.hold }, bestR: r.bestR };
  },
  columns: [
    { head: 'Hit', num: true, cell: (r) => (r.hitAt ? <>{r.hitAt}<div className="muted-cell ema-note">close {fmt(r.hitClose)}</div></> : '—') },
    { head: 'Short ↓', num: true, cell: (r) => (r.entry ? <><b>{fmt(r.entry)}</b><div className="muted-cell ema-note">at {r.entryAt}{r.signalAt ? ` · signal ${r.signalAt}` : ''}</div></> : '—') },
    { head: '9 EMA', num: true, cell: (r) => (r.ema0 ? <>{fmt(r.ema0)}{r.toEmaPct != null && <div className="muted-cell ema-note">{r.toEmaPct}% above</div>}</> : '—') },
    { head: 'Stop', num: true, cell: (r) => (r.sl ? <span className="neg">{fmt(r.sl)}</span> : <span className="muted-cell">none</span>) },
    { head: 'Worst against', num: true, cell: (r) => (r.worstPct != null ? <span className="neg">{r.worstPct}%</span> : '—') },
  ],
  csv: {
    head: ['Hit', 'Hit close', 'Hit high', 'Entry rule', 'Signal candle', 'Short at', '9 EMA at hit', '% above 9 EMA', 'Stop', 'Worst against %'],
    row: (r) => [r.hitAt || '', r.hitClose ?? '', r.hitHigh ?? '', r.mode || '', r.signalAt || '', r.entry ?? '', r.ema0 ?? '', r.toEmaPct ?? '', r.sl ?? '', r.worstPct ?? ''],
  },
};

export default function OverextBacktest() {
  return <StrategyBacktest config={OVEREXT_BACKTEST} />;
}
