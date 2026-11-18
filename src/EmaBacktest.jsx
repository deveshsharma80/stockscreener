import StrategyBacktest from './StrategyBacktest.jsx';
import { EMA_SCAN, PARAMS } from './emasetup.js';
import { price } from './Ticker.jsx';

// Back Test → EMA Rejection (short). Rules: src/emasetup.js (same as the live tab and Auto Trading).
const fmt = (v) => (v == null ? '—' : price.format(v));

export const EMA_BACKTEST = {
  id: 'ema-rejection',
  legacyKey: 'stockhits.emaBacktest', // results saved before Back Test moved here
  leverage: 5,
  intro: `Export the backtest of “${EMA_SCAN}” from Chartink (Date, Symbol …) and upload it here. Same rules as the live EMA Rejection tab and Auto Trading; candles from Dhan.`,
  exits: [
    ['target', 'Setup target', 'day’s low (or 1:2 when the day’s low is above the entry)'],
    ['twoR', 'Fixed 1:2', 'target = entry − 2 × risk'],
    ['hold', `Hold to ${PARAMS.exitBy}`, `stop only, covered at ${PARAMS.exitBy}`],
  ],
  statusOf(r) {
    if (r.status === 'rejected') {
      const o = r.outcome?.result;
      if (o === 'entered') return ['rejected', 'Rejected → short'];
      if (o === 'cancelled') return ['expired', 'Stop hit before entry'];
      if (o === 'no-entry') return ['expired', 'Entry never triggered'];
      return ['expired', 'Rejected, no trade'];
    }
    if (r.status === 'broke-out') return ['broke-out', 'Broke above 26 EMA'];
    if (r.status === 'error') return ['error', 'Error'];
    if (r.status === 'waiting') return ['waiting', 'No data'];
    return r.touchedAt ? ['touched', 'At EMA, no rejection'] : ['watching', 'Never reached 9 EMA'];
  },
  trade(r) {
    const o = r.outcome;
    if (r.status !== 'rejected' || o?.result !== 'entered') return null;
    return { entryAt: o.entryAt, fill: o.fill, exits: { target: o.target, twoR: o.twoR, hold: o.hold }, bestR: o.mfeR };
  },
  columns: [
    { head: 'Gap', num: true, cell: (r) => <span className={r.gapPct < 0 ? 'neg' : r.gapPct > 0 ? 'pos' : ''}>{r.gapPct == null ? '—' : `${r.gapPct > 0 ? '+' : ''}${r.gapPct.toFixed(2)}%`}</span> },
    {
      head: 'Times',
      cell: (r) => (
        <span className="muted-cell ema-times">
          {r.touchedAt && <div>EMA {r.touchedAt}</div>}
          {r.alertAt && <div><b className="neg">alert {r.alertAt}</b></div>}
          {r.outcome?.entryAt && <div>in {r.outcome.entryAt}</div>}
          {r.brokeAt && <div>✗ {r.brokeAt}</div>}
        </span>
      ),
    },
    { head: 'Entry ↓', num: true, cell: (r) => <b>{fmt(r.outcome?.fill ?? r.entry)}</b> },
    { head: 'Stop', num: true, cell: (r) => <span className="neg">{fmt(r.sl)}</span> },
    { head: 'Target', num: true, cell: (r) => <span className="pos">{fmt(r.target)}</span> },
  ],
  csv: {
    head: ['Gap %', 'EMA touch', 'Alert', 'Entry', 'Stop', 'Target'],
    row: (r) => [r.gapPct ?? '', r.touchedAt || '', r.alertAt || '', r.entry ?? '', r.sl ?? '', r.target ?? ''],
  },
};

export default function EmaBacktest() {
  return <StrategyBacktest config={EMA_BACKTEST} />;
}
