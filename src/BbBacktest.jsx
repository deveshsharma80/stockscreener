import StrategyBacktest from './StrategyBacktest.jsx';
import { BB_DEFAULTS, BB_EXITS } from './strategies/bbBreakout.js';
import { price } from './Ticker.jsx';

// Back Test → Bollinger breakout (long). Rules: src/strategies/bbBreakout.js.
const fmt = (v) => (v == null ? '—' : price.format(v));
const D = BB_DEFAULTS;

export const BB_BACKTEST = {
  id: 'bb-breakout',
  leverage: 5,
  intro: 'Upload the Chartink backtest export of your screener (Date, Symbol …). For each 09:15 stock: first 5-minute candle green and above the upper Bollinger Band → buy when a later candle breaks its high; stop at its low. Candles from Dhan.',
  params: [
    { key: 'bbPeriod', label: 'BB length', type: 'number', step: 1, def: D.bbPeriod },
    { key: 'bbStd', label: 'BB std dev', type: 'number', step: 0.1, def: D.bbStd },
    { key: 'above', label: 'Above the band', type: 'select', def: D.above, options: [['close', 'Close above'], ['low', 'Whole candle (low) above'], ['open', 'Open above']] },
    { key: 'entryBy', label: 'Breakout before', type: 'select', def: D.entryBy, options: [['09:25', '09:25 (2nd candle only)'], ['09:30', '09:30'], ['09:45', '09:45'], ['10:15', '10:15'], ['11:00', '11:00']] },
    { key: 'stop', label: 'Stop loss', type: 'select', def: D.stop, options: [['low', 'First candle low'], ['mid', 'First candle middle'], ['pct', 'Fixed % below entry']] },
    { key: 'stopPct', label: 'Stop %', type: 'number', step: 0.1, def: D.stopPct },
  ],
  exits: BB_EXITS,
  statusOf(r) {
    if (r.status === 'entered') return ['long', 'Breakout → long'];
    if (r.status === 'no-breakout') return ['touched', 'No breakout'];
    if (r.status === 'not-above') return ['watching', 'Not above BB'];
    if (r.status === 'not-green') return ['watching', 'Not green'];
    if (r.status === 'error') return ['error', 'Error'];
    return ['waiting', 'No data'];
  },
  trade(r) {
    if (r.status !== 'entered') return null;
    return { entryAt: r.entryAt, fill: r.entry, exits: { t1: r.t1, t12: r.t12, twoR: r.twoR, hold: r.hold }, bestR: r.bestR };
  },
  columns: [
    { head: 'Gap', num: true, cell: (r) => <span className={r.gapPct < 0 ? 'neg' : r.gapPct > 0 ? 'pos' : ''}>{r.gapPct == null ? '—' : `${r.gapPct > 0 ? '+' : ''}${r.gapPct.toFixed(2)}%`}</span> },
    {
      head: 'First candle',
      num: true,
      cell: (r) => (r.first ? <>{fmt(r.first.open)} → {fmt(r.first.close)}<div className={`ema-note ${r.firstPct > 0 ? 'pos' : 'neg'}`}>{r.firstPct > 0 ? '+' : ''}{r.firstPct}% · H {fmt(r.first.high)}</div></> : '—'),
    },
    { head: 'Upper BB', num: true, cell: (r) => fmt(r.upper) },
    { head: 'Entry ↑', num: true, cell: (r) => (r.entry ? <><b>{fmt(r.entry)}</b><div className="muted-cell ema-note">at {r.entryAt}</div></> : '—') },
    { head: 'Stop', num: true, cell: (r) => (r.sl ? <><span className="neg">{fmt(r.sl)}</span><div className="muted-cell ema-note">−{r.riskPct}%</div></> : '—') },
  ],
  csv: {
    head: ['Gap %', 'First open', 'First high', 'First low', 'First close', 'First %', 'Upper BB', 'Entry', 'Stop', 'Risk %'],
    row: (r) => [r.gapPct ?? '', r.first?.open ?? '', r.first?.high ?? '', r.first?.low ?? '', r.first?.close ?? '', r.firstPct ?? '', r.upper ?? '', r.entry ?? '', r.sl ?? '', r.riskPct ?? ''],
  },
};

export default function BbBacktest() {
  return <StrategyBacktest config={BB_BACKTEST} />;
}
