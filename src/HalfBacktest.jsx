import StrategyBacktest from './StrategyBacktest.jsx';
import { HALF_DEFAULTS, HALF_EXITS } from './strategies/halfEaten.js';
import { price } from './Ticker.jsx';

// Back Test → Big candle half eaten (short): a 14 %+ green daily candle, short when price falls
// back to the middle of its body on a later day. Rules: src/strategies/halfEaten.js.
const fmt = (v) => (v == null ? '—' : price.format(v));
const D = HALF_DEFAULTS;
const TIMES = ['12:00', '13:00', '14:00', '14:30', '15:00'].map((t) => [t, t]);

export const HALF_BACKTEST = {
  id: 'half-eaten',
  leverage: 5,
  firstOnly: false,
  csvOnly: true, // the stocks come from a Chartink daily scan
  intro:
    'Upload a Chartink backtest CSV of your daily scan (Date, Symbol …): each row is a big green day. The backtest watches the following days for the fall to the middle of that candle’s body and shorts there, no stop loss. Candles from Dhan.',
  params: [
    { key: 'bigPct', label: 'Big candle body ≥ %', type: 'number', step: 1, def: D.bigPct },
    { key: 'waitDays', label: 'Wait up to (trading days)', type: 'number', step: 1, def: D.waitDays },
    { key: 'lastEntry', label: 'No entry after', type: 'select', def: D.lastEntry, options: TIMES },
  ],
  exits: HALF_EXITS,
  statusOf(r) {
    if (r.status === 'entered') return ['rejected', 'Half eaten → short'];
    if (r.status === 'not-eaten') return ['watching', 'Not eaten yet'];
    if (r.status === 'late') return ['touched', 'Eaten after cutoff'];
    if (r.status === 'no-setup') return ['expired', 'Body below %'];
    if (r.status === 'error') return ['error', 'Error'];
    return ['waiting', 'No data'];
  },
  trade(r) {
    if (r.status !== 'entered') return null;
    return { entryAt: r.entryAt, fill: r.entry, exits: { hold: r.hold, t2: r.t2, t5: r.t5, next: r.next }, bestR: r.bestR };
  },
  columns: [
    { head: 'Big candle', num: true, cell: (r) => (r.bigOpen ? <>{fmt(r.bigOpen)} → {fmt(r.bigClose)}{r.bodyPct != null && <div className="pos ema-note">+{r.bodyPct}%</div>}</> : '—') },
    { head: 'Middle', num: true, cell: (r) => (r.mid ? fmt(r.mid) : '—') },
    { head: 'Eaten on', num: true, cell: (r) => (r.triggerDay ? <>{r.triggerDay.slice(8)}-{r.triggerDay.slice(5, 7)}<div className="muted-cell ema-note">day {r.daysAfter}{r.gapBelow ? ' · opened below' : ''}</div></> : '—') },
    { head: 'Short ↓', num: true, cell: (r) => (r.entry ? <><b>{fmt(r.entry)}</b><div className="muted-cell ema-note">at {r.entryAt}</div></> : '—') },
    { head: 'Worst against', num: true, cell: (r) => (r.worstPct != null ? <span className="neg">{r.worstPct}%</span> : '—') },
  ],
  csv: {
    head: ['Big open', 'Big close', 'Body %', 'Middle', 'Eaten on', 'Days after', 'Opened below middle', 'Short at', 'Worst against % (same day)', 'Worst against % (next day)'],
    row: (r) => [r.bigOpen ?? '', r.bigClose ?? '', r.bodyPct ?? '', r.mid ?? '', r.triggerDay || '', r.daysAfter ?? '', r.gapBelow ? 'yes' : '', r.entry ?? '', r.worstPct ?? '', r.nextWorstPct ?? ''],
  },
};

export default function HalfBacktest() {
  return <StrategyBacktest config={HALF_BACKTEST} />;
}
