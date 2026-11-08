import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { PRODUCT_SHORT, SECRET_KEY, api, describe, fmtExpiry, kindOf, money, pnlPctOf, price, segLabel, signed, store } from './Ticker.jsx';
import { BOOK_EVENT, ORDERS_EVENT, QUOTES_EVENT, emitBook, emitOrders } from './Orders.jsx';

// Running P&L pill shown on every NSE Market page. Clicking it opens a panel
// with each open paper position, live P&L and an Exit button per row.
//
// Prices: on the Market pages the Ticker already polls Dhan, so we reuse its
// quotes (QUOTES_EVENT) and only poll ourselves when nobody else has lately.

const POLL_OPEN = 5_000;
const POLL_CLOSED = 30_000;
const tone = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');

export default function LivePnl() {
  // The secret can arrive after this mounts (signing in on a page's gate)
  const [secret, setSecret] = useState(() => store.get(SECRET_KEY));
  useEffect(() => {
    const t = setInterval(() => setSecret((s) => (s === store.get(SECRET_KEY) ? s : store.get(SECRET_KEY))), 2000);
    return () => clearInterval(t);
  }, []);
  const [book, setBook] = useState(null);
  const [quotes, setQuotes] = useState({});
  const [market, setMarket] = useState(null);
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState(null); // { kind, text }
  const lastShared = useRef(0); // when the Ticker last shared quotes

  const loadBook = useCallback(async () => {
    if (!secret) return;
    try {
      setBook(await api(secret, 'paper'));
    } catch {
      /* keep the last book */
    }
  }, [secret]);

  // Book: on start, when trades happen anywhere in the app, and every minute
  useEffect(() => {
    loadBook();
    const onBook = (e) => e.detail?.book && setBook(e.detail.book);
    const onOrders = (e) => e.detail?.events?.some((o) => o.status === 'FILLED') && loadBook();
    window.addEventListener(BOOK_EVENT, onBook);
    window.addEventListener(ORDERS_EVENT, onOrders);
    const t = setInterval(loadBook, 60_000);
    return () => {
      window.removeEventListener(BOOK_EVENT, onBook);
      window.removeEventListener(ORDERS_EVENT, onOrders);
      clearInterval(t);
    };
  }, [loadBook]);

  // Quotes shared by the Ticker page
  useEffect(() => {
    const on = (e) => {
      if (!e.detail?.quotes) return;
      lastShared.current = Date.now();
      setQuotes((x) => ({ ...x, ...e.detail.quotes }));
      if (e.detail.market) setMarket(e.detail.market);
    };
    window.addEventListener(QUOTES_EVENT, on);
    return () => window.removeEventListener(QUOTES_EVENT, on);
  }, []);

  const positions = useMemo(() => (book?.positions || []).filter((p) => p.qty !== 0), [book]);
  const keys = positions.map((p) => p.key).join(',');

  // Our own price poll, only while positions are open and no one else is polling
  useEffect(() => {
    if (!secret || !keys) return;
    let alive = true;
    let timer;
    const tick = async () => {
      const wait = market && !market.open ? POLL_CLOSED : POLL_OPEN;
      if (!document.hidden && Date.now() - lastShared.current > wait) {
        try {
          const j = await api(secret, 'quotes', { params: { keys } });
          if (!alive) return;
          setQuotes((x) => ({ ...x, ...j.quotes }));
          setMarket(j.market);
          if (j.orders?.events?.length) {
            emitOrders({ events: j.orders.events, pending: j.orders.pending });
            loadBook();
          }
        } catch {
          /* try again next time */
        }
      }
      if (alive) timer = setTimeout(tick, wait);
    };
    tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [secret, keys, market?.open, loadBook]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = positions.map((p) => {
    const ltp = quotes[p.key]?.ltp ?? null;
    const pnl = ltp != null ? (ltp - p.avg) * p.qty : null;
    return { ...p, ltp, pnl, pct: pnlPctOf(pnl, p) };
  });
  const priced = rows.every((r) => r.pnl != null);
  const running = rows.reduce((s, r) => s + (r.pnl || 0), 0);
  const deployed = rows.reduce((s, r) => s + (r.margin || 0), 0);
  const runningPct = deployed > 0 && priced ? (running / deployed) * 100 : null;
  const booked = (book?.totals?.realizedToday ?? 0) - (book?.totals?.chargesToday ?? 0);

  // Close the panel with Escape
  useEffect(() => {
    if (!open) return;
    const on = (e) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [open]);

  const exit = async (p) => {
    setMsg(null);
    const j = await api(secret, 'trade', { method: 'POST', body: { key: p.key, side: p.qty > 0 ? 'SELL' : 'BUY', qty: Math.abs(p.qty), product: p.product } });
    setBook(j);
    emitBook(j, 'livepnl'); // Ticker, Trades and P&L pages refresh
    const t = j.trade;
    setMsg({ kind: 'ok', text: `Exited ${describe(p)}: ${t.side === 'BUY' ? 'bought back' : 'sold'} ${t.qty.toLocaleString('en-IN')} @ ₹${price.format(t.price)}` });
    return t;
  };

  if (!secret || !book) return null;
  const none = rows.length === 0;

  return (
    <>
      <button
        className={`lp-pill ${none ? 'none' : tone(running)}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={none ? 'No open paper positions' : 'Running P&L of open positions — click for details'}
      >
        {none ? (
          <span className="lp-label">No open positions</span>
        ) : (
          <>
            <span className="lp-dot" aria-hidden="true" />
            <span className="lp-label">Running P&amp;L</span>
            <b className="lp-val">{priced ? money(running) : '…'}</b>
            {runningPct != null && <span className="lp-pct">{runningPct > 0 ? '+' : ''}{runningPct.toFixed(2)}%</span>}
            <span className="lp-count">{rows.length} open</span>
          </>
        )}
      </button>

      {open &&
        createPortal(
          <div className="lp-scrim" onClick={() => setOpen(false)}>
            <div className="lp-panel" role="dialog" aria-label="Open positions" onClick={(e) => e.stopPropagation()}>
              <div className="lp-head">
                <div>
                  <h2>Open positions</h2>
                  <div className="lp-sub">
                    Running <b className={`mono ${tone(running)}`}>{priced ? money(running) : '…'}</b>
                    {runningPct != null && <span className={tone(running)}> ({runningPct > 0 ? '+' : ''}{runningPct.toFixed(2)}% on ₹{price.format(deployed)} deployed)</span>}
                    <span className="lp-sep">·</span>
                    Booked today <b className={`mono ${tone(booked)}`}>{money(booked)}</b>
                    {market && <span className="lp-sep">· {market.open ? 'Market open' : 'Market closed'}</span>}
                  </div>
                </div>
                <button className="icon-btn" onClick={() => setOpen(false)} aria-label="Close">×</button>
              </div>
              {msg && <p className={`status ${msg.kind} lp-msg`}>{msg.text}</p>}
              {none ? (
                <div className="empty">No open paper positions.</div>
              ) : (
                <div className="table-wrap">
                  <table className="ticker lp-table">
                    <thead>
                      <tr>
                        <th>Instrument</th>
                        <th className="num">P&amp;L</th>
                        <th className="num">P&amp;L %</th>
                        <th className="num">Qty</th>
                        <th className="num">Avg</th>
                        <th className="num">LTP</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((p) => (
                        <tr key={p.key}>
                          <td className="tk-inst">
                            <div className="tk-name">{describe(p)}</div>
                            <div className="tk-sub">
                              <span className={`tk-seg ${kindOf(p.segment)}`}>{segLabel(p.segment)}</span>
                              {p.expiry && <span>{fmtExpiry(p.expiry)}</span>}
                              <span className={`tk-prod ${p.product}`}>{PRODUCT_SHORT[p.product] || p.product}</span>
                            </div>
                          </td>
                          <td className={`num mono ${tone(p.pnl)}`}>{p.pnl != null ? <b>{signed.format(p.pnl)}</b> : '…'}</td>
                          <td className="num">
                            {p.pct != null ? (
                              <span className={`tk-pnlpct ${p.pct > 0 ? 'up' : p.pct < 0 ? 'down' : 'flat'}`} title={`On ₹${price.format(p.margin)} of your money deployed`}>
                                {p.pct > 0 ? '+' : ''}{p.pct.toFixed(2)}%
                              </span>
                            ) : (
                              <span className="muted-dash">…</span>
                            )}
                          </td>
                          <td className="num mono">
                            <b className={p.qty > 0 ? 'long' : 'short'}>{p.qty > 0 ? `+${p.qty.toLocaleString('en-IN')}` : p.qty.toLocaleString('en-IN')}</b>
                          </td>
                          <td className="num mono">{price.format(p.avg)}</td>
                          <td className="num mono">{p.ltp != null ? price.format(p.ltp) : '…'}</td>
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
                <span className="muted-cell">P&amp;L is before brokerage (the Trades page shows it after). Exit closes the whole position at the live price (paper trade).</span>
                <a className="link" href="#/market/positions" onClick={() => setOpen(false)}>All positions →</a>
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
  const [stage, setStage] = useState('idle'); // idle | confirm | busy
  useEffect(() => {
    if (stage !== 'confirm') return;
    const t = setTimeout(() => setStage('idle'), 4000);
    return () => clearTimeout(t);
  }, [stage]);
  const what = `${pos.qty > 0 ? 'Sell' : 'Buy back'} ${Math.abs(pos.qty).toLocaleString('en-IN')} at market`;
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
