import { useEffect, useMemo, useState } from 'react';
import { lastPrices } from './binance.js';

// Tools → P/L Calculator → Crypto.
// Same maths as the offline sheet (matches Delta Exchange):
//   Qty        = (Amount × Leverage) ÷ Entry price, rounded down to the qty step
//   Brokerage  = Brokerage % × (entry value + exit value)
//   Net P/L    = Long: Qty × (Exit − Entry) − brokerage   Short: Qty × (Entry − Exit) − brokerage
//   P/L %      = Net P/L ÷ Amount

const STORE = 'stockhits.calc.crypto';
const DEFAULTS = { side: 'LONG', cur: '₹', amount: '500000', leverage: '1', brokerage: '1', step: '1', qty: '', entry: '1.09', exit: '1.98', coin: '' };
const LEVERAGES = [1, 2, 5, 10, 20, 25, 50, 100];
const STEPS = [
  ['1', 'Whole'],
  ['0.1', '0.1'],
  ['0.01', '0.01'],
  ['0.001', '0.001'],
  ['0', 'Exact'],
];
const TARGETS = [-50, -25, -10, 0, 10, 25, 50, 100];

const n = (v) => {
  const x = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(x) ? x : NaN;
};
const fmt2 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });
const fmtQty = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 6 });
const priceFmt = (p) => {
  if (!Number.isFinite(p)) return '—';
  const a = Math.abs(p);
  const d = a >= 1000 ? 2 : a >= 1 ? 4 : a >= 0.01 ? 6 : 8;
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: d }).format(p);
};
const floorStep = (q, step) => {
  if (!(step > 0)) return q;
  const k = Math.round(1 / step);
  return Math.floor(q * k + 1e-9) / k;
};
const tone = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');

function load() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORE) || '{}') };
  } catch {
    return DEFAULTS;
  }
}

/** Every figure for one set of inputs (null where an input is missing). */
export function calc({ side, amount, leverage, brokerage, step, qty, entry, exit }) {
  const A = n(amount), L = n(leverage) || 1, b = (n(brokerage) || 0) / 100, E = n(entry), X = n(exit);
  if (!(A > 0) || !(E > 0)) return null;
  const autoQty = floorStep((A * L) / E, n(step));
  const q = n(qty) > 0 ? n(qty) : autoQty;
  const long = side !== 'SHORT';
  const entryValue = q * E;
  const margin = entryValue / L;
  const out = { q, autoQty, entryValue, margin, L, b, E, long };
  // Price where net P/L = 0, and the exit needed for a given net P/L
  out.breakeven = long ? (E * (1 + b)) / (1 - b) : (E * (1 - b)) / (1 + b);
  out.exitFor = (target) => (long ? (target / q + E * (1 + b)) / (1 - b) : (E * (1 - b) - target / q) / (1 + b));
  out.liq = L > 1 ? (long ? E * (1 - 1 / L) : E * (1 + 1 / L)) : null;
  if (X > 0) {
    out.exitValue = q * X;
    out.gross = long ? q * (X - E) : q * (E - X);
    out.fees = b * (entryValue + out.exitValue);
    out.net = out.gross - out.fees;
    out.pct = (out.net / A) * 100;
    out.move = ((X - E) / E) * 100;
    out.pastLiq = out.liq !== null && (long ? X <= out.liq : X >= out.liq);
  }
  return out;
}

export default function Calculator() {
  const [f, setF] = useState(load);
  const [live, setLive] = useState({ busy: false, msg: '' });
  useEffect(() => {
    try {
      localStorage.setItem(STORE, JSON.stringify(f));
    } catch {}
  }, [f]);
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e?.target ? e.target.value : e }));

  const r = useMemo(() => calc(f), [f]);
  const A = n(f.amount);
  const cur = f.cur;
  const money = (v) => (Number.isFinite(v) ? `${v < 0 ? '−' : ''}${cur}${fmt2.format(Math.abs(v))}` : '—');
  const signed = (v) => (Number.isFinite(v) ? `${v > 0 ? '+' : ''}${money(v)}` : '—');

  const fetchLive = async (field) => {
    const sym = f.coin.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!sym) return setLive({ busy: false, msg: 'Type a coin first, e.g. BTC or BTCUSDT.' });
    const full = sym.endsWith('USDT') ? sym : `${sym}USDT`;
    setLive({ busy: true, msg: '' });
    try {
      const p = (await lastPrices([full]))[full];
      if (!(p > 0)) throw new Error(`No Binance price for ${full}.`);
      setF((s) => ({ ...s, coin: full, [field]: String(p) }));
      setLive({ busy: false, msg: `${full} ${priceFmt(p)} (Binance, just now)` });
    } catch (e) {
      setLive({ busy: false, msg: e.message || 'Could not get the price.' });
    }
  };

  return (
    <div className="calc">
      <div className="calc-grid">
        <section className="card pad calc-in">
          <div className="calc-row">
            <div className="seg calc-side" role="group" aria-label="Side">
              <button className={f.side !== 'SHORT' ? 'on long' : ''} onClick={() => set('side')('LONG')}>Long (Buy)</button>
              <button className={f.side === 'SHORT' ? 'on short' : ''} onClick={() => set('side')('SHORT')}>Short (Sell)</button>
            </div>
            <div className="seg" role="group" aria-label="Currency">
              {['₹', '$'].map((c) => (
                <button key={c} className={cur === c ? 'on' : ''} onClick={() => set('cur')(c)}>{c}</button>
              ))}
            </div>
          </div>

          <label className="calc-field">
            <span>Amount (your money in the trade)</span>
            <div className="calc-input"><b>{cur}</b><input inputMode="decimal" value={f.amount} onChange={set('amount')} /></div>
          </label>

          <div className="calc-field">
            <span>Leverage</span>
            <div className="calc-lev">
              <div className="calc-input sm"><input inputMode="decimal" value={f.leverage} onChange={set('leverage')} aria-label="Leverage" /><b>×</b></div>
              <div className="calc-chips">
                {LEVERAGES.map((l) => (
                  <button key={l} className={n(f.leverage) === l ? 'on' : ''} onClick={() => set('leverage')(String(l))}>{l}×</button>
                ))}
              </div>
            </div>
          </div>

          <div className="calc-two">
            <label className="calc-field">
              <span>Brokerage % (each side)</span>
              <div className="calc-input"><input inputMode="decimal" value={f.brokerage} onChange={set('brokerage')} /><b>%</b></div>
            </label>
            <label className="calc-field">
              <span>Qty rounding</span>
              <select className="calc-select" value={f.step} onChange={set('step')}>
                {STEPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
          </div>

          <div className="calc-field">
            <span>Coin (optional, for live price)</span>
            <div className="calc-coin">
              <input className="calc-text" placeholder="e.g. BTC, EVAA" value={f.coin} onChange={set('coin')} onKeyDown={(e) => e.key === 'Enter' && fetchLive('entry')} />
              <button className="btn" disabled={live.busy} onClick={() => fetchLive('entry')}>Live → Entry</button>
              <button className="btn" disabled={live.busy} onClick={() => fetchLive('exit')}>Live → Exit</button>
            </div>
            {live.msg && <small className="calc-note">{live.msg}</small>}
          </div>

          <div className="calc-two">
            <label className="calc-field">
              <span>Entry price</span>
              <div className="calc-input"><input inputMode="decimal" value={f.entry} onChange={set('entry')} /></div>
            </label>
            <label className="calc-field">
              <span>Exit price</span>
              <div className="calc-input"><input inputMode="decimal" value={f.exit} onChange={set('exit')} /></div>
            </label>
          </div>

          <label className="calc-field">
            <span>Qty <small>(blank = from amount × leverage)</small></span>
            <div className="calc-input">
              <input inputMode="decimal" value={f.qty} placeholder={r ? fmtQty.format(r.autoQty) : ''} onChange={set('qty')} />
              {f.qty && <button className="calc-clear" onClick={() => set('qty')('')}>Auto</button>}
            </div>
          </label>

          <button className="btn calc-reset" onClick={() => (setF(DEFAULTS), setLive({ busy: false, msg: '' }))}>Reset to sheet example</button>
        </section>

        <section className="card pad calc-out">
          {!r ? (
            <p className="muted">Enter an amount and an entry price.</p>
          ) : (
            <>
              <div className="calc-hero">
                <span>Net P/L {r.net !== undefined && <small>after brokerage</small>}</span>
                <b className={tone(r.net)}>{r.net === undefined ? '—' : signed(r.net)}</b>
                {r.pct !== undefined && (
                  <i className={`calc-pct ${tone(r.pct)}`}>{r.pct > 0 ? '+' : ''}{r.pct.toFixed(2)}%</i>
                )}
                {r.move !== undefined && <small>Price move {r.move > 0 ? '+' : ''}{r.move.toFixed(2)}% · on {money(A)} amount</small>}
              </div>
              {r.pastLiq && (
                <div className="calc-warn">
                  ⚠ This exit is past the liquidation price ({priceFmt(r.liq)}). The exchange would close the trade there first, so you would lose about your whole margin ({money(r.margin)}) plus fees, not the figure above.
                </div>
              )}
              <dl className="calc-list">
                <Row k="Qty" v={fmtQty.format(r.q)} note={n(f.qty) > 0 ? 'typed' : `${money(A)} × ${r.L}× ÷ ${priceFmt(r.E)}`} />
                <Row k={r.long ? 'Buy value (entry)' : 'Sell value (entry)'} v={money(r.entryValue)} />
                <Row k={r.long ? 'Sell value (exit)' : 'Buy value (exit)'} v={money(r.exitValue)} />
                <Row k="Gross P/L" v={signed(r.gross)} cls={tone(r.gross)} />
                <Row k="Brokerage" v={Number.isFinite(r.fees) ? `−${money(r.fees)}` : '—'} note={`${f.brokerage || 0}% of entry + exit value`} />
                <Row k="Net P/L" v={signed(r.net)} cls={tone(r.net)} strong />
                <Row k="Margin used" v={money(r.margin)} note={r.L > 1 ? `position ÷ ${r.L}×` : 'no leverage'} />
                <Row k="Breakeven exit" v={priceFmt(r.breakeven)} note="price where net P/L is zero" />
                {r.liq && <Row k="Liquidation (approx.)" v={priceFmt(r.liq)} cls="neg" note="isolated margin, before fees; the exchange's is a little closer" />}
              </dl>
            </>
          )}
        </section>
      </div>

      {r && r.net !== undefined && (
        <div className="calc-sticky" aria-hidden="true">
          <span>Net P/L</span>
          <b className={tone(r.net)}>{signed(r.net)}</b>
          <i className={`calc-pct ${tone(r.pct)}`}>{r.pct > 0 ? '+' : ''}{r.pct.toFixed(2)}%</i>
        </div>
      )}

      {r && (
        <section className="card">
          <div className="card-head">
            <h2>Exit price for a target</h2>
            <small className="muted-inline">Tap a row to use it as the exit price</small>
          </div>
          <div className="table-wrap">
            <table className="calc-table">
              <thead>
                <tr><th>Net P/L %</th><th>Exit price</th><th>Price move</th><th>Net P/L</th></tr>
              </thead>
              <tbody>
                {TARGETS.map((t) => {
                  const pnl = (t / 100) * A;
                  const x = r.exitFor(pnl);
                  const bad = !(x > 0) || (r.liq && (r.long ? x <= r.liq : x >= r.liq));
                  return (
                    <tr key={t} className={t === 0 ? 'be' : ''} onClick={() => x > 0 && set('exit')(String(+x.toPrecision(8)))}>
                      <td><b className={tone(t)}>{t === 0 ? 'Breakeven' : `${t > 0 ? '+' : ''}${t}%`}</b></td>
                      <td>{x > 0 ? priceFmt(x) : '—'}{bad && x > 0 && <small className="neg"> past liquidation</small>}</td>
                      <td className={tone(r.long ? x - r.E : r.E - x)}>{x > 0 ? `${x > r.E ? '+' : ''}${(((x - r.E) / r.E) * 100).toFixed(2)}%` : '—'}</td>
                      <td className={tone(pnl)}>{signed(pnl)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

function Row({ k, v, note, cls = '', strong }) {
  return (
    <div className={strong ? 'strong' : ''}>
      <dt>{k}{note && <small>{note}</small>}</dt>
      <dd className={cls}>{v}</dd>
    </div>
  );
}
