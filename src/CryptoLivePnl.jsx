import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { SECRET_KEY, store } from './Ticker.jsx';
import { fmtPrice, lastPrices } from './binance.js';
import { triggerHit, useCryptoBook } from './cryptoBook.js';

// Running P&L pill on every Crypto page (like the NSE Market one). Clicking it
// opens a panel with each open crypto paper position, live P&L and an Exit
// button per row. Prices: Binance last price (perpetual, else spot) every 5 s
// while positions are open; if a liquidation / SL / TP level is reached the
// server is asked to check at once.

const POLL_MS = 5000;
const coin = (s) => s.replace(/USDT$/, '');
const tone = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
const qtyFmt = (q) => Math.abs(q).toLocaleString('en-US', { maximumSignificantDigits: 8 });

export default function CryptoLivePnl() {
  // The secret can arrive after this mounts (signing in on a page's gate)
  const [secret, setSecret] = useState(() => store.get(SECRET_KEY));
  useEffect(() => {
    const t = setInterval(() => setSecret((s) => (s === store.get(SECRET_KEY) ? s : store.get(SECRET_KEY))), 2000);
    return () => clearInterval(t);
  }, []);
  const cb = useCryptoBook(secret || '');
  const book = cb.book;
  const [prices, setPrices] = useState({});
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState(null);

  const positions = book?.positions || [];
  const keys = positions.map((p) => p.symbol).join(',');
  const asked = useRef(0);
  const posRef = useRef(positions);
  posRef.current = positions;

  useEffect(() => {
    if (!secret || !keys) return;
    let alive = true;
    let timer;
    const tick = async () => {
      if (!document.hidden) {
        const p = await lastPrices(keys.split(',')).catch(() => ({}));
        if (!alive) return;
        setPrices((x) => ({ ...x, ...p }));
        if (posRef.current.some((pos) => triggerHit(pos, p[pos.symbol])) && Date.now() - asked.current > 10_000) {
          asked.current = Date.now();
          cb.checkNow(p).catch(() => {});
        }
      }
      if (alive) timer = setTimeout(tick, POLL_MS);
    };
    tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [secret, keys]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    const on = (e) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [open]);

  if (!secret || !book) return null;
  const fx = book.fx || 85;
  const inr = (usdt, signed = false) => {
    if (usdt == null || !Number.isFinite(usdt)) return '—';
    const v = usdt * fx;
    const a = Math.abs(v);
    return `${v < 0 ? '−' : signed && v > 0 ? '+' : ''}₹${a.toLocaleString('en-IN', { maximumFractionDigits: a < 100 ? 2 : 0 })}`;
  };
  const rows = positions.map((p) => {
    const price = prices[p.symbol] ?? p.price ?? null;
    const pnl = price != null ? (price - p.avg) * p.qty : null;
    return { ...p, price, pnl, roe: pnl != null ? (pnl / p.margin) * 100 : null };
  });
  const priced = rows.every((r) => r.pnl != null);
  const running = rows.reduce((s, r) => s + (r.pnl || 0), 0);
  const margin = rows.reduce((s, r) => s + r.margin, 0);
  const runningPct = margin > 0 && priced ? (running / margin) * 100 : null;
  const booked = book.totals.realized - book.totals.fees;
  const none = rows.length === 0;

  const exit = async (p) => {
    setMsg(null);
    const j = await cb.post('cp-close', { symbol: p.symbol, price: p.price });
    setMsg({ kind: 'ok', text: `Closed ${coin(p.symbol)} ${p.side.toLowerCase()} at ${fmtPrice(j.fill.price)}: ${inr(j.fill.realized - j.fill.fee, true)} after fee.` });
  };

  return (
    <>
      <button
        className={`lp-pill ${none ? 'none' : tone(running)}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={none ? 'No open crypto paper positions' : 'Running P&L of open crypto positions — click for details'}
      >
        {none ? (
          <span className="lp-label">No open positions</span>
        ) : (
          <>
            <span className="lp-dot" aria-hidden="true" />
            <span className="lp-label">Running P&amp;L</span>
            <b className="lp-val">{priced ? inr(running, true) : '…'}</b>
            {runningPct != null && <span className="lp-pct">{runningPct > 0 ? '+' : ''}{runningPct.toFixed(2)}%</span>}
            <span className="lp-count">{rows.length} open</span>
          </>
        )}
      </button>

      {open &&
        createPortal(
          <div className="lp-scrim" onClick={() => setOpen(false)}>
            <div className="lp-panel" role="dialog" aria-label="Open crypto positions" onClick={(e) => e.stopPropagation()}>
              <div className="lp-head">
                <div>
                  <h2>Open crypto positions</h2>
                  <div className="lp-sub">
                    Running <b className={`mono ${tone(running)}`}>{priced ? inr(running, true) : '…'}</b>
                    {runningPct != null && <span className={tone(running)}> ({runningPct > 0 ? '+' : ''}{runningPct.toFixed(2)}% on {inr(margin)} margin)</span>}
                    <span className="lp-sep">·</span>
                    Booked this period <b className={`mono ${tone(booked)}`}>{inr(booked, true)}</b>
                  </div>
                </div>
                <button className="icon-btn" onClick={() => setOpen(false)} aria-label="Close">×</button>
              </div>
              {msg && <p className={`status ${msg.kind} lp-msg`}>{msg.text}</p>}
              {none ? (
                <div className="empty">No open crypto paper positions.</div>
              ) : (
                <div className="table-wrap">
                  <table className="ticker lp-table">
                    <thead>
                      <tr>
                        <th>Coin</th>
                        <th className="num">Size</th>
                        <th className="num">Entry</th>
                        <th className="num">Price</th>
                        <th className="num">P&amp;L</th>
                        <th className="num">ROE</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((p) => (
                        <tr key={p.symbol}>
                          <td className="tk-inst">
                            <div className="tk-name">
                              <a className="link" href={`#/crypto/chart?s=${p.symbol}`} onClick={() => setOpen(false)}>{coin(p.symbol)}</a>
                            </div>
                            <div className="tk-sub">
                              <span className={`cp-side ${p.side.toLowerCase()}`}>{p.side === 'LONG' ? 'Long' : 'Short'} {p.leverage}×</span>
                              {p.sl != null && <span className="cp-sltp"><span className="sl">SL {fmtPrice(p.sl)}</span></span>}
                              {p.tp != null && <span className="cp-sltp"><span className="tp">TP {fmtPrice(p.tp)}</span></span>}
                            </div>
                          </td>
                          <td className="num mono">
                            {qtyFmt(p.qty)}
                            <div className="muted-cell">{inr(p.notional)}</div>
                          </td>
                          <td className="num mono">{fmtPrice(p.avg)}</td>
                          <td className="num mono">{p.price != null ? fmtPrice(p.price) : '…'}</td>
                          <td className={`num mono ${tone(p.pnl)}`}>{p.pnl != null ? <b>{inr(p.pnl, true)}</b> : '…'}</td>
                          <td className="num">
                            {p.roe != null ? (
                              <span className={`tk-pnlpct ${p.roe > 0 ? 'up' : p.roe < 0 ? 'down' : 'flat'}`}>{p.roe > 0 ? '+' : ''}{p.roe.toFixed(2)}%</span>
                            ) : (
                              <span className="muted-dash">…</span>
                            )}
                          </td>
                          <td className="lp-act">
                            <ExitRow pos={p} onExit={() => exit(p)} onError={(text) => setMsg({ kind: 'err', text })} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="lp-foot">
                <span className="muted-cell">P&amp;L before fees · Exit closes the whole position at the live price (paper trade) · ₹{fx} per USDT</span>
                <a className="link" href="#/cpos/open" onClick={() => setOpen(false)}>All positions →</a>
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  );
}

/** Exit → "Confirm exit" (4 s) → done. */
function ExitRow({ pos, onExit, onError }) {
  const [stage, setStage] = useState('idle');
  useEffect(() => {
    if (stage !== 'confirm') return;
    const t = setTimeout(() => setStage('idle'), 4000);
    return () => clearTimeout(t);
  }, [stage]);
  const what = `${pos.qty > 0 ? 'Sell' : 'Buy back'} ${qtyFmt(pos.qty)} ${coin(pos.symbol)} at market`;
  if (stage === 'idle') {
    return (
      <button className="btn lp-exit" onClick={() => setStage('confirm')} title={what}>
        Exit
      </button>
    );
  }
  return (
    <button
      className="btn tk-exit-confirm lp-exit"
      disabled={stage === 'busy'}
      title={what}
      onClick={async () => {
        setStage('busy');
        try {
          await onExit();
        } catch (e) {
          onError(e.message);
          setStage('idle');
        }
      }}
    >
      {stage === 'busy' ? 'Exiting…' : 'Confirm exit'}
    </button>
  );
}
