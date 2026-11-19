import { useState } from 'react';
import EmaBacktest from './EmaBacktest.jsx';

// Auto Trading → Back Test: one place for every strategy's backtest. Add a strategy by
// adding a row here: [id, name, one-line description, component].
const STRATEGIES = [
  ['ema-rejection', 'EMA Rejection', 'Gap-down stocks (“Futures April 2025”) whose bounce is rejected at the 9 / 26 EMA on 5-minute candles — short.', EmaBacktest],
];
const KEY = 'stockhits.backtestStrategy';

export default function BackTest() {
  const [id, setId] = useState(() => {
    try {
      const v = localStorage.getItem(KEY);
      return STRATEGIES.some((s) => s[0] === v) ? v : STRATEGIES[0][0];
    } catch {
      return STRATEGIES[0][0];
    }
  });
  const pick = (v) => {
    setId(v);
    try {
      localStorage.setItem(KEY, v);
    } catch {
      /* fine */
    }
  };
  const [, name, about, View] = STRATEGIES.find((s) => s[0] === id);
  return (
    <>
      <div className="filters bt-strategies">
        <span className="muted-cell">Strategy</span>
        <div className="seg" role="group" aria-label="Strategy">
          {STRATEGIES.map(([sid, label]) => (
            <button key={sid} className={sid === id ? 'on' : ''} onClick={() => pick(sid)}>{label}</button>
          ))}
        </div>
        <span className="muted-cell bt-about"><b>{name}:</b> {about}</span>
      </div>
      <View key={id} />
    </>
  );
}
