import StrategyBacktest from './StrategyBacktest.jsx';
import { HALF_DEFAULTS, HALF_EXITS } from './strategies/halfEaten.js';
import { price } from './Ticker.jsx';

// Back Test → Big candle half eaten: a 14 %+ green daily candle; on a later day, when price falls
// back to the middle of its body, short there (default) or buy there. Rules: src/strategies/halfEaten.js.
const fmt = (v) => (v == null ? '—' : price.format(v));
const D = HALF_DEFAULTS;
const TIMES = ['12:00', '13:00', '14:00', '14:30', '15:00'].map((t) => [t, t]);

export const HALF_BACKTEST = {
  id: 'half-eaten',
  leverage: 5,
  firstOnly: false,
  csvOnly: true, // the stocks come from a Chartink daily scan
  intro:
    'Upload a Chartink backtest CSV of your daily scan (Date, Symbol …): each row is a big green day. The backtest watches the following days for the fall to the trigger level — the middle of that candle’s body, or a set % below its open — and shorts there (or buys there with “Long”); no stop loss unless you set one. Candles from Dhan.',
  params: [
    { key: 'side', label: 'At the level', type: 'select', def: D.side, options: [['short', 'Short (sell)'], ['long', 'Long (buy)']] },
    { key: 'level', label: 'Trigger level', type: 'select', def: D.level, options: [['mid', 'Middle of the body (50%)'], ['base', 'Below the open (base)']] },
    { key: 'basePct', label: '% below the open (base)', type: 'number', step: 0.5, def: D.basePct },
    { key: 'bigPct', label: 'Big candle body ≥ %', type: 'number', step: 1, def: D.bigPct },
    { key: 'stopPct', label: 'Stop loss % (0 = none)', type: 'number', step: 0.5, def: D.stopPct },
    { key: 'waitDays', label: 'Wait up to (trading days)', type: 'number', step: 1, def: D.waitDays },
    { key: 'lastEntry', label: 'No entry after', type: 'select', def: D.lastEntry, options: TIMES },
  ],
  exits: HALF_EXITS,
  statusOf(r) {
    if (r.status === 'entered') {
      const what = r.levelKind === 'base' ? 'Below base' : 'Half eaten';
      return r.side === 'long' ? ['long', `${what} → buy`] : ['rejected', `${what} → short`];
    }
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
    { head: 'Trigger', num: true, cell: (r) => (r.level ? <>{fmt(r.level)}<div className="muted-cell ema-note">{r.levelKind === 'base' ? 'below open' : 'middle'}</div></> : '—') },
    { head: 'Eaten on', num: true, cell: (r) => (r.triggerDay ? <>{r.triggerDay.slice(8)}-{r.triggerDay.slice(5, 7)}<div className="muted-cell ema-note">day {r.daysAfter}{r.gapBelow ? ' · opened below' : ''}</div></> : '—') },
    { head: 'Entry', num: true, cell: (r) => (r.entry ? <><b>{fmt(r.entry)} {r.side === 'long' ? '↑' : '↓'}</b><div className="muted-cell ema-note">at {r.entryAt}</div></> : '—') },
    { head: 'Worst against', num: true, cell: (r) => (r.worstPct != null ? <span className="neg">{r.worstPct}%</span> : '—') },
  ],
  csv: {
    head: ['Side', 'Stop', 'Big open', 'Big close', 'Body %', 'Middle', 'Trigger', 'Trigger type', 'Reached on', 'Days after', 'Opened below trigger', 'Entry', 'Worst against % (same day)', 'Worst against % (next day)'],
    row: (r) => [r.side || '', r.sl ?? '', r.bigOpen ?? '', r.bigClose ?? '', r.bodyPct ?? '', r.mid ?? '', r.level ?? '', r.levelKind || '', r.triggerDay || '', r.daysAfter ?? '', r.gapBelow ? 'yes' : '', r.entry ?? '', r.worstPct ?? '', r.nextWorstPct ?? ''],
  },
};

export default function HalfBacktest() {
  return <StrategyBacktest config={HALF_BACKTEST} />;
}
